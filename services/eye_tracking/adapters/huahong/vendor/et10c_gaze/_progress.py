"""单点校准的进度跟踪。

SDK 通过 ``ET10C_registerCalibrationOnePointFinishCb`` 回传一个 ``nFinishedNum``，
但头文件没有说明它是**全局累计**还是在 ``ET10C_reConfig`` 之后**从 1 重新计数**：

* ``gzEt10c_interface.hpp`` 里该参数只有一个名字，没有起点说明；
* C++ demo（``demoInterfaceOrgSDK.cpp``）第 903 行的判据是
  ``m_curr_nFinishedNum == curr_calib_idx + 1``，而 ``curr_calib_idx`` 在每轮
  ``while(BiasBigPoints.size() > 0)`` 内部重新置 0（第 822 行）—— 该判据只有在
  「``reConfig`` 后重数」成立时才正确。

因此本模块**不使用 ``nFinishedNum`` 的数值**做任何判定，只统计回调触发的次数：
无论 SDK 是累计还是重数，「本轮第 N 个点完成」都等价于「本轮收到第 N 次回调」。
原始值另存于 :attr:`CalibrationProgress.raw_counts`，可用
:attr:`CalibrationProgress.count_semantics` 判定实际语义。

实测结论（ET12，2026-09-29，连跑三轮 5 点校准）：

```
count history: [1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2, 3, 4, 5]
→ semantics: reset
```

每轮都从 1 重新计数，即 **``ET10C_reConfig`` 之后重数**。判定逻辑不依赖这个
结论（换机型或 SDK 版本时未必相同），需要时用
``scripts/verify_calibration_semantics.py`` 复核。
"""

from __future__ import annotations

import threading
import time

__all__ = ["CalibrationProgress"]


class CalibrationProgress:
    """单点校准进度（线程安全）。

    SDK 回调线程调 :meth:`on_callback` / :meth:`record_return`，主线程用
    :meth:`wait` 阻塞等待，两者通过条件变量同步。
    """

    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._callbacks = 0
        self._base = 0
        self._round_starts: list[int] = []
        self._raw_counts: list[int] = []
        self._returns: list[tuple[tuple[float, float], int]] = []

    # ------------------------------------------------------------------ #
    # SDK 回调线程
    # ------------------------------------------------------------------ #
    def on_callback(self, finished_num: int) -> None:
        """记录一次「单点完成」回调。"""

        with self._cond:
            self._callbacks += 1
            self._raw_counts.append(int(finished_num))
            self._cond.notify_all()

    def record_return(self, point: tuple[float, float], code: int) -> None:
        """记录一次 ``ET10C_performOnePointCalibration`` 的返回码。"""

        with self._cond:
            self._returns.append((point, int(code)))

    # ------------------------------------------------------------------ #
    # 主线程
    # ------------------------------------------------------------------ #
    def rebase(self) -> None:
        """把当前回调次数记作新一轮的基线（每次 ``reConfig`` 时调用）。"""

        with self._cond:
            self._base = self._callbacks
            self._round_starts.append(len(self._raw_counts))

    def reset(self) -> None:
        """清空全部记录。"""

        with self._cond:
            self._callbacks = 0
            self._base = 0
            self._round_starts.clear()
            self._raw_counts.clear()
            self._returns.clear()

    def wait(self, target: int, timeout: float = 10.0) -> bool:
        """等待本轮第 ``target`` 个点完成（``target`` 从 1 开始）。

        只看「本轮回调次数是否达到 ``target``」，与 ``nFinishedNum`` 的取值无关。
        """

        target = int(target)
        deadline = time.monotonic() + float(timeout)
        with self._cond:
            while True:
                if self._callbacks - self._base >= target:
                    return True
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._cond.wait(remaining)

    # ------------------------------------------------------------------ #
    # 只读视图
    # ------------------------------------------------------------------ #
    @property
    def callbacks(self) -> int:
        """回调累计次数（本对象生命周期内）。"""

        with self._cond:
            return self._callbacks

    @property
    def callbacks_this_round(self) -> int:
        """本轮（自上次 :meth:`rebase` 起）的回调次数。"""

        with self._cond:
            return self._callbacks - self._base

    @property
    def raw_counts(self) -> list[int]:
        """SDK 回调上报的原始 ``nFinishedNum`` 序列（副本）。"""

        with self._cond:
            return list(self._raw_counts)

    @property
    def returns(self) -> list[tuple[tuple[float, float], int]]:
        """每点的 ``(归一化坐标, SDK 返回码)``（副本）。``0`` 成功，``-8`` 超时。"""

        with self._cond:
            return list(self._returns)

    @property
    def count_semantics(self) -> str:
        """从已记录的序列推断计数语义。

        :returns: ``"reset"``（``reConfig`` 后从 1 重数）/ ``"cumulative"``
            （全局累计）/ ``"unknown"``（样本不足，通常因为只跑了一轮）
        """

        with self._cond:
            starts = list(self._round_starts)
            counts = list(self._raw_counts)
        if len(starts) < 2:
            return "unknown"
        after_first_round = counts[starts[1] :]
        if not after_first_round:
            return "unknown"
        return "reset" if after_first_round[0] == 1 else "cumulative"
