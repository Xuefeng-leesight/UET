"""GazeTracker：ET10C 眼动 SDK 的面向对象封装。

对应 C++ 侧 `demoInterfaceOrgSDK.cpp` 中 ``class TestInterface``：
设备枚举 -> init -> 回调注册 -> 开相机 -> 眼睛检测 -> 校准 -> 追踪。

与 C++ demo 的差别：

* ``ET10C_startEyeDetect`` 是阻塞调用，这里用后台线程承载（与 demo 一致）
* 追踪结果同时提供**回调**与**轮询**（``ET10C_trackerOutput``）两种获取方式，
  后者专门供 Python 这类语言使用
"""

from __future__ import annotations

import ctypes
import threading
import time
from collections import deque
from ctypes import POINTER, byref, c_int16, c_uint8, c_uint32, c_void_p
from typing import Callable, Iterable, Optional

from . import _constants
from ._ctypes_defs import (
    CalibStatus,
    CameraCallback,
    DeviceStatusCallback,
    EyeDetectCallback,
    EyeType,
    FinishCalibrationOnePointCallback,
    GazeTrackerBbox,
    GazeTrackerCalibBias,
    GazeTrackerOutput,
    GazeTrackerPoint,
    GazeTrackerVec3,
    LightType,
    LogLevel,
    StreamInfos,
    TrackInfoCb,
)
from ._loader import load_sdk
from ._progress import CalibrationProgress
from .device import DeviceInfo, create_device, list_devices
from .errors import Et10cError, Et10cNotFoundError

__all__ = ["GazeTracker", "output_to_dict", "list_system_devices"]

#: 追踪结果环形缓存大小（轮询模式下使用）
OUTPUT_QUEUE_SIZE = 64
#: 默认红外亮度（与 C++ demo 的 LIGHT_BRIGHTNESS 一致）
DEFAULT_IR_BRIGHTNESS = 80
#: ``ET10C_init`` 的 logFile 参数不接受 NULL：实测传 NULL 会让
#: ``et10c_interface.dll`` 直接 native crash。不写日志时改传 Windows
#: 空设备名，SDK 照常 fopen，但不产生文件。
NULL_LOG_FILE_PLACEHOLDER = b"NUL"


def _encode_path(path) -> bytes:
    """SDK 内部使用窄字符 fopen，中文路径按 GBK（Windows ANSI 代码页）编码。"""

    text = str(path)
    try:
        return text.encode("gbk")
    except UnicodeEncodeError:
        return text.encode("utf-8")


def _decode_cstr(value) -> Optional[str]:
    if not value:
        return None
    if isinstance(value, bytes):
        for encoding in ("utf-8", "gbk"):
            try:
                return value.decode(encoding)
            except UnicodeDecodeError:
                continue
        return value.decode("latin-1")
    return str(value)


def _as_point(value) -> GazeTrackerPoint:
    """接受 ``GazeTrackerPoint`` 或 ``(x, y)`` 并归一化为结构体。"""

    if isinstance(value, GazeTrackerPoint):
        return value
    x, y = value
    return GazeTrackerPoint.from_xy(float(x), float(y))


def list_system_devices(dll_dir=None) -> list[DeviceInfo]:
    """便捷函数：不创建实例，仅枚举设备。"""

    return list_devices(load_sdk(dll_dir))


def output_to_dict(output: GazeTrackerOutput) -> dict:
    """把追踪结果转成普通 dict（便于日志 / 序列化）。"""

    return {
        "timestamp": int(output.currTimePts),
        "have_left_eye": bool(output.haveLeftEyeInfo),
        "have_right_eye": bool(output.haveRightEyeInfo),
        "have_merge_point": bool(output.haveMergeScreenPoint),
        "have_left_point": bool(output.haveLeftScreenPoint),
        "have_right_point": bool(output.haveRightScreenPoint),
        "left_blink": bool(output.haveLeftEyeblink),
        "right_blink": bool(output.haveRightEyeblink),
        "left_blink_range": (
            int(output.leftEyeBlinkTime.startTimeStamp),
            int(output.leftEyeBlinkTime.endTimeStamp),
        ),
        "right_blink_range": (
            int(output.rightEyeBlinkTime.startTimeStamp),
            int(output.rightEyeBlinkTime.endTimeStamp),
        ),
        "merge_point": output.mergeScreenPoint.as_tuple(),
        "left_point": output.tLeftScreenPoint.as_tuple(),
        "right_point": output.tRightScreenPoint.as_tuple(),
        "left_pupil": output.tLeftEyeInfo.tPupilCenter.as_tuple(),
        "right_pupil": output.tRightEyeInfo.tPupilCenter.as_tuple(),
        "left_bbox": output.tLeftEyeInfo.tBbox.as_tuple(),
        "right_bbox": output.tRightEyeInfo.tBbox.as_tuple(),
    }


class GazeTracker:
    """ET10C 眼动追踪器。

    最小用法（已有校准特征）::

        with GazeTracker(screen_type="SCREEN_133") as tracker:
            print(tracker.start_camera())
            tracker.start_eye_detect()
            tracker.load_calibration("cablic.dat")
            tracker.start_tracker()
            while True:
                sample = tracker.wait_output(0.5)
                if sample is not None and sample.haveMergeScreenPoint:
                    print(sample.mergeScreenPoint.as_tuple())

    :param device: ``DeviceInfo`` / 设备索引 / None（取第一个设备）
    :param res_type: 分辨率类型；None 表示按机型自动选择
        （ET10 → ``1640x1232x60``，ET12 → ``1920x1080x30``，两者不通用）
    :param screen_type: 屏幕型号，如 ``"SCREEN_133"``
    :param calib_points: 校准点数（2/3/4/5/6/9/25）
    :param eye_type: ``EyeType.BOTH`` / ``LEFT`` / ``RIGHT``
    :param log_file: SDK 日志文件，None 表示不写文件
    :param log_level: SDK 日志等级
    :param license_file: 眨眼功能授权文件，None 表示不检查
    :param dll_dir: ``et10c_interface.dll`` 所在目录，None 自动搜索
    """

    def __init__(
        self,
        *,
        device: DeviceInfo | int | None = None,
        res_type: str | None = None,
        screen_type: str = "SCREEN_133",
        calib_points: int = 5,
        eye_type: EyeType | int = EyeType.BOTH,
        log_file: str | None = "hhlog.txt",
        log_level: LogLevel | int = LogLevel.DEBUG,
        license_file: str | None = None,
        dll_dir=None,
        screen_info=None,
    ) -> None:
        self._lib = load_sdk(dll_dir)
        self._lock = threading.RLock()
        self._closed = False
        self.worker_error = ""

        # res_type 为 None 时按机型自动选择，等设备确定后再解析
        self.res_type = str(res_type) if res_type else ""
        self.stream_info: StreamInfos | None = None
        self.screen_type = str(screen_type)
        self.calib_points = int(calib_points)
        self.eye_type = EyeType(int(eye_type))

        self.screen_info = screen_info if screen_info is not None else _constants.screen_physical_info(screen_type)
        self.calib_indices: tuple[int, ...] = _constants.calib_point_index(self.calib_points)
        self.base_points: list[GazeTrackerPoint] = _constants.base_screen_points()

        # ---- 回调数据缓存 ----
        self._output_queue: deque[GazeTrackerOutput] = deque(maxlen=OUTPUT_QUEUE_SIZE)
        self._bg_frame: tuple[bytes, int, int] | None = None
        self._left_bbox: GazeTrackerBbox | None = None
        self._right_bbox: GazeTrackerBbox | None = None
        #: SDK 完成回调上报的计数值原始记录；其语义（全局累计 / reConfig 后重数）
        #: 尚未确定，不参与判定，见 :attr:`calibration_count_history`
        self._finished_count = 0
        #: 单点校准进度：按回调次数判定，不解释计数值
        self.progress = CalibrationProgress()
        #: 眨眼授权检查结果：None=未检查，True=有效，False=无效
        self.blink_licensed: bool | None = None
        self._eye_detect_thread: threading.Thread | None = None
        #: ``ET10C_startTracker`` 同样是阻塞调用，交给后台线程
        self._tracker_thread: threading.Thread | None = None

        # ---- 用户回调 ----
        self._user_output_cb: Callable[[GazeTrackerOutput], None] | None = None
        self._user_camera_cb: Callable[[bytes, int, int], None] | None = None
        self._user_detect_cb: Callable[[GazeTrackerBbox | None, GazeTrackerBbox | None], None] | None = None
        self._user_point_cb: Callable[[int], None] | None = None

        # ---- 句柄与初始化 ----
        self.device_info: DeviceInfo | None = None
        self.handle = None
        self._devices = list_devices(self._lib)
        if device is None:
            if not self._devices:
                raise Et10cNotFoundError("no ET10C device found")
            device = self._devices[0]
        self.handle = create_device(self._lib, device)
        if isinstance(device, DeviceInfo):
            self.device_info = device
        else:
            self.device_info = self._devices[int(device)]

        try:
            # res_type 未指定时按机型自动选择；校验放在 init 之前，
            # 且处于 try 内，抛错时会一并释放 createDevice 得到的句柄。
            if not self.res_type:
                self.res_type = _constants.default_res_type(self.device_info.name)
            allowed = _constants.resolutions_for(self.device_info.name)
            if allowed and self.res_type not in allowed:
                raise ValueError(
                    f"device {self.device_info.name} does not support res_type="
                    f"{self.res_type!r}; supported: {', '.join(allowed)}"
                )

            ret = self._lib.ET10C_init(
                self.handle,
                int(self.eye_type),
                self.res_type.encode(),
                self.calib_points,
                self.screen_info,
                _encode_path(log_file) if log_file else NULL_LOG_FILE_PLACEHOLDER,
                int(log_level),
            )
            if ret != 0:
                raise Et10cError(
                    "ET10C_init",
                    ret,
                    f"res_type={self.res_type}, screen_type={self.screen_type}, "
                    f"calib_points={self.calib_points}",
                )

            self._install_callbacks()
            self.set_ir_light(mode=LightType.AUTO, left=DEFAULT_IR_BRIGHTNESS, right=DEFAULT_IR_BRIGHTNESS)

            if license_file:
                self.blink_licensed = self.check_blink_license(license_file)
        except Exception:
            # init 之后失败：算法尚未就绪，只释放设备资源，不走 stop_tracker 流程
            if self.handle:
                try:
                    self._lib.ET10C_Deinit(self.handle)
                except Exception:  # pragma: no cover
                    pass
                self.handle = None
            self._closed = True
            raise

    # ------------------------------------------------------------------ #
    # 生命周期
    # ------------------------------------------------------------------ #
    def close(self) -> None:
        """Never deinitialize while a native worker still owns the handle."""
        with self._lock:
            if self._closed:
                return
            if self.handle:
                self.stop_tracker()
                self.stop_eye_detect()
                self.stop_camera()
                self._lib.ET10C_Deinit(self.handle)
                self.handle = None
            self._closed = True

    def __enter__(self) -> "GazeTracker":
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()

    def __del__(self):  # pragma: no cover - 兜底
        try:
            self.close()
        except Exception:
            pass

    def _require_handle(self):
        if self.handle is None:
            raise Et10cError("GazeTracker", -1, "tracker already closed")
        return self.handle

    # ------------------------------------------------------------------ #
    # 回调注册
    # ------------------------------------------------------------------ #
    def _install_callbacks(self) -> None:
        handle = self._require_handle()
        self._cb_calibration = FinishCalibrationOnePointCallback(self._on_calibration_point)
        self._cb_tracker = TrackInfoCb(self._on_tracker_output)
        self._cb_camera = CameraCallback(self._on_eye_camera)
        self._cb_detect = EyeDetectCallback(self._on_eye_detect)

        self._lib.ET10C_registerCalibrationOnePointFinishCb(handle, self._cb_calibration, None)
        self._lib.ET10C_registerTrackerOutputCb(handle, self._cb_tracker, None)
        self._lib.ET10C_registerEyeCameraCb(handle, self._cb_camera, None)
        self._lib.ET10C_registerEyeDetectCb(handle, self._cb_detect, None)

    def set_device_status_callback(
        self,
        on_connect: Callable[[], None] | None = None,
        on_disconnect: Callable[[], None] | None = None,
    ) -> None:
        """注册设备连接 / 断开回调。

        注意：该回调是**全局**的，SDK 接口不接受 handle 参数。
        """

        self._cb_connect = DeviceStatusCallback(on_connect) if on_connect else None
        self._cb_disconnect = DeviceStatusCallback(on_disconnect) if on_disconnect else None
        self._lib.ET10C_registerDeviceStatusCallback(
            self._cb_connect, self._cb_disconnect, None
        )

    def set_output_callback(self, callback: Callable[[GazeTrackerOutput], None] | None) -> None:
        """设置追踪结果回调（与 :meth:`poll_output` / :meth:`wait_output` 不冲突）。"""

        self._user_output_cb = callback

    def set_camera_callback(self, callback: Callable[[bytes, int, int], None] | None) -> None:
        """设置眼动背景图回调，回调参数为 ``(gray_bytes, width, height)``。"""

        self._user_camera_cb = callback

    def set_eye_detect_callback(
        self, callback: Callable[[GazeTrackerBbox | None, GazeTrackerBbox | None], None] | None
    ) -> None:
        self._user_detect_cb = callback

    def set_calibration_point_callback(self, callback: Callable[[int], None] | None) -> None:
        """设置单点校准完成回调，参数为已完成点数（从 1 开始）。"""

        self._user_point_cb = callback

    # ---- SDK 线程 -> Python ----
    def _on_eye_camera(self, usr_ptr, data, width, height, length) -> None:
        if not data:
            return
        total = int(length) or int(width) * int(height)
        if not (0 < width <= 8192 and 0 < height <= 8192 and total == width * height and total <= 32 * 1024 * 1024):
            self.worker_error = 'Invalid ET10C native frame length/dimensions'
            return
        try:
            raw = ctypes.string_at(data, total)
        except Exception:  # pragma: no cover - 防御
            return
        self._bg_frame = (raw, int(width), int(height))
        callback = self._user_camera_cb
        if callback is not None:
            try:
                callback(raw, int(width), int(height))
            except Exception:  # pragma: no cover - 用户回调异常不能影响 SDK 线程
                pass

    def _on_tracker_output(self, usr_ptr, output_ptr) -> None:
        if not output_ptr:
            self.worker_error = 'Null ET10C gaze pointer'
            return
        output = GazeTrackerOutput.from_buffer_copy(output_ptr.contents)
        self._output_queue.append(output)
        callback = self._user_output_cb
        if callback is not None:
            try:
                callback(output)
            except Exception:  # pragma: no cover
                pass

    def _on_eye_detect(self, usr_ptr, left_ptr, right_ptr) -> None:
        self._left_bbox = (
            GazeTrackerBbox.from_buffer_copy(left_ptr.contents) if left_ptr else None
        )
        self._right_bbox = (
            GazeTrackerBbox.from_buffer_copy(right_ptr.contents) if right_ptr else None
        )
        callback = self._user_detect_cb
        if callback is not None:
            try:
                callback(self._left_bbox, self._right_bbox)
            except Exception:  # pragma: no cover
                pass

    def _on_calibration_point(self, usr_ptr, finished_num) -> None:
        self._finished_count = int(finished_num)
        self.progress.on_callback(int(finished_num))
        callback = self._user_point_cb
        if callback is not None:
            try:
                callback(int(finished_num))
            except Exception:  # pragma: no cover
                pass

    # ------------------------------------------------------------------ #
    # 相机 / 眼检
    # ------------------------------------------------------------------ #
    def start_camera(self) -> StreamInfos:
        """开启眼动相机，返回当前流信息。"""

        handle = self._require_handle()
        ret = self._lib.ET10C_startCamera(handle)
        if ret != 0:
            raise Et10cError("ET10C_startCamera", ret)
        info = StreamInfos()
        self._lib.ET10C_getCurrStreamInfos(handle, byref(info))
        self.stream_info = info
        return info

    def stop_camera(self) -> None:
        if self.handle:
            self._lib.ET10C_stopCamera(self.handle)

    def set_ir_light(self, mode: LightType | int = LightType.AUTO,
                     left: int = DEFAULT_IR_BRIGHTNESS,
                     right: int = DEFAULT_IR_BRIGHTNESS) -> None:
        """设置红外补光。

        :param mode: ``LightType.AUTO``（0，自动，忽略亮度值）或
            ``LightType.MANUAL``（1，手动，使用 ``left`` / ``right``）
        """

        handle = self._require_handle()
        self._lib.ET10C_setIRLight(handle, 1 if int(mode) else 0, int(left), int(right))

    def set_vcm_code(self, vcm: int) -> int:
        """定焦模式下设置 VCM 值。"""

        ret = self._lib.ET10C_setVcmCode(self._require_handle(), int(vcm))
        if ret != 0:
            raise Et10cError("ET10C_setVcmCode", ret)
        return ret

    def start_eye_detect(self, wait: bool = False, timeout: float | None = None) -> None:
        """开始眼睛检测。

        ``ET10C_startEyeDetect`` 会阻塞到检测结束，因此默认放到后台守护线程执行，
        与 C++ demo 的 ``std::thread(...).detach()`` 一致。

        :param wait: True 时在当前线程同步阻塞
        """

        handle = self._require_handle()
        if wait:
            ret = self._lib.ET10C_startEyeDetect(handle)
            if ret != 0:
                raise Et10cError("ET10C_startEyeDetect", ret)
            return
        if self._eye_detect_thread is not None and self._eye_detect_thread.is_alive():
            return
        self._eye_detect_thread = threading.Thread(
            target=self._eye_detect_worker, name="et10c-eye-detect", daemon=True
        )
        self._eye_detect_thread.start()

    def _eye_detect_worker(self) -> None:  # pragma: no cover - 线程体
        handle = self.handle
        if handle is None:
            return
        try:
            ret = self._lib.ET10C_startEyeDetect(handle)
            if ret != 0:
                self.worker_error = f"startEyeDetect: vendor error {ret}"
        except Exception as exc:
            self.worker_error = str(exc)

    def stop_eye_detect(self) -> None:
        if self.handle:
            self._lib.ET10C_stopEyeDetect(self.handle)
        thread = self._eye_detect_thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=5.0)
            if thread.is_alive():
                raise RuntimeError("Native ET10C worker did not stop; deinit prohibited")

    # ------------------------------------------------------------------ #
    # 数据获取
    # ------------------------------------------------------------------ #
    def get_distance(self) -> int | None:
        """当前用户与设备距离（mm）。ET12 机型不支持，返回 None。"""

        handle = self._require_handle()
        if self.device_info is not None and self.device_info.is_et12:
            return None
        value = c_int16(0)
        self._lib.ET10C_getDistance(handle, byref(value))
        return int(value.value)

    @property
    def device_version(self) -> Optional[str]:
        return _decode_cstr(self._lib.ET10C_getDeviceVersion(self._require_handle()))

    @property
    def alg_version(self) -> Optional[str]:
        return _decode_cstr(self._lib.ET10C_getGzAlgVersion())

    @property
    def sdk_version(self) -> Optional[str]:
        return _decode_cstr(self._lib.ET10C_getGzSdkVersion())

    def get_background_frame(self) -> tuple[bytes, int, int] | None:
        """最近一帧背景图 ``(gray_bytes, width, height)``，无数据时返回 None。"""

        return self._bg_frame

    def get_eye_bboxes(self) -> tuple[GazeTrackerBbox | None, GazeTrackerBbox | None]:
        return (self._left_bbox, self._right_bbox)

    def poll_output(self) -> GazeTrackerOutput | None:
        """主动拉取一帧追踪结果（``ET10C_trackerOutput``）。

        适合不使用回调的场景（头文件注明该接口就是为 Python 这类语言准备的）。
        无新数据时返回 None。
        """

        output = GazeTrackerOutput()
        ret = self._lib.ET10C_trackerOutput(self._require_handle(), byref(output))
        if ret != 0:
            return None
        return output

    def wait_output(self, timeout: float = 1.0) -> GazeTrackerOutput | None:
        """等一帧回调推送的结果，超时返回 None。"""

        deadline = time.monotonic() + timeout
        while True:
            if self._output_queue:
                return self._output_queue.popleft()
            if time.monotonic() >= deadline:
                return None
            time.sleep(0.002)

    def drain_outputs(self) -> list[GazeTrackerOutput]:
        """取出缓存中全部结果。"""

        items = list(self._output_queue)
        self._output_queue.clear()
        return items

    def screen_to_camera(self, point) -> tuple[float, float, float]:
        """归一化屏幕点 -> 相机三维坐标。"""

        p = _as_point(point)
        vec = GazeTrackerVec3()
        self._lib.ET10C_TrackerFromScreenToCamera(self._require_handle(), byref(p), byref(vec))
        return vec.as_tuple()

    # ------------------------------------------------------------------ #
    # 校准
    # ------------------------------------------------------------------ #
    def reconfigure(
        self,
        to_calib_points: int | None = None,
        screen_type: str | None = None,
        eye_type: EyeType | int | None = None,
    ) -> None:
        """重新配置算法参数（对应 ``ET10C_reConfig``）。

        :param to_calib_points: 本次要重新校准的点数，None 表示不改变
        :param screen_type: 更换屏幕型号，None 表示沿用当前
        """

        handle = self._require_handle()
        # 新一轮校准的基线：按回调次数计，不受 SDK 计数值语义影响
        self.progress.rebase()
        if screen_type is not None:
            self.screen_type = str(screen_type)
            self.screen_info = _constants.screen_physical_info(self.screen_type)
        if eye_type is not None:
            self.eye_type = EyeType(int(eye_type))
        points = self.calib_points if to_calib_points is None else int(to_calib_points)
        ret = self._lib.ET10C_reConfig(
            handle, int(self.eye_type), self.calib_points, points, self.screen_info
        )
        if ret != 0:
            raise Et10cError("ET10C_reConfig", ret, f"to_calib_points={points}")

    def reset_calibration_counter(self) -> None:
        """清空校准进度记录（回调计数、原始计数值历史与单点返回码）。"""

        self._finished_count = 0
        self.progress.reset()

    @property
    def finished_calibration_points(self) -> int:
        """SDK 最近一次回调上报的计数值（原始值，语义不保证）。"""

        return self._finished_count

    def perform_one_point_calibration(
        self,
        point,
        timeout: int = 5,
        save_img: bool = False,
        img_path: str = "./",
        *,
        raise_on_error: bool = False,
    ) -> int:
        """校准单个点，返回 SDK 原始返回码（0 成功）。

        ``point`` 为归一化坐标 ``(x, y)`` 或 ``GazeTrackerPoint``。
        该调用会阻塞至 SDK 内部超时（对应 C++ demo 中放进线程一次只调一个点的行为），
        超时返回 ``Rtn.CALIB_TIMEOUT``。默认不抛异常，便于上层重试；
        ``raise_on_error=True`` 时非 0 抛 :class:`Et10cError`。
        """

        p = _as_point(point)
        ret = self._lib.ET10C_performOnePointCalibration(
            self._require_handle(),
            byref(p),
            int(timeout),
            1 if save_img else 0,
            _encode_path(img_path),
        )
        self.progress.record_return(p.as_tuple(), int(ret))
        if ret != 0 and raise_on_error:
            raise Et10cError(
                "ET10C_performOnePointCalibration", ret, f"point={p.as_tuple()}"
            )
        return int(ret)

    def calibration_stop(self) -> None:
        if self.handle:
            self._lib.ET10C_CalibrationStop(self.handle)

    def wait_calibration_point(self, target: int, timeout: float = 10.0) -> bool:
        """等待本轮第 ``target`` 个点完成（``target`` 从 1 开始）。

        判定只看 :attr:`progress` 记录到的**回调次数**，不解释 ``nFinishedNum``
        的数值。两个原因：

        * 该计数是否随 ``ET10C_reConfig`` 重置，头文件没写。实测 ET12 上是
          **重数**（每轮 1..5，见 DEVELOPMENT 5.12），但判定不应依赖这一点。
        * 只看数值会出错：旧写法里的 ``self._finished_count >= target`` 那一支，
          在第二轮开场时旧计数已经 >= target，本轮第一个点会在校准尚未开始时就
          判定完成，整轮静默秒过。

        语义可用 :attr:`calibration_count_semantics` 随时复核。
        """

        return self.progress.wait(target, timeout)

    @property
    def calibration_returns(self) -> list[tuple[tuple[float, float], int]]:
        """已执行的单点校准 ``(归一化坐标, SDK 返回码)`` 列表。

        ``0`` 为成功；``Rtn.CALIB_TIMEOUT``（-8）表示该点超时 —— SDK 在
        ``timeout`` 秒内没采到足够数据，不代表整个校准失败，但通常意味着
        该点的数据质量存疑。
        """

        return self.progress.returns

    @property
    def calibration_count_history(self) -> list[int]:
        """SDK 完成回调上报的原始 ``nFinishedNum`` 序列。"""

        return self.progress.raw_counts

    @property
    def calibration_count_semantics(self) -> str:
        """``"reset"``（reConfig 后重数）/ ``"cumulative"`` / ``"unknown"``。"""

        return self.progress.count_semantics

    def check_calibration_finished(self) -> bool:
        """全部点校准完成且质量合格时返回 True（SDK 返回 0）。"""

        return self._lib.ET10C_checkCalibrationFinished(self._require_handle()) == 0

    def get_calibration_bias(self) -> GazeTrackerCalibBias:
        """获取逐点校准偏差与质量分数。"""

        bias = GazeTrackerCalibBias()
        ret = self._lib.ET10C_getCalibBias(self._require_handle(), byref(bias))
        if ret != 0:
            raise Et10cError("ET10C_getCalibBias", ret)
        return bias

    def save_calibration(self, path: str = "cablic.dat") -> None:
        """把校准特征存到文件。"""

        ret = self._lib.ET10C_SaveCalibrationData(self._require_handle(), _encode_path(path))
        if ret != 0:
            raise Et10cError("ET10C_SaveCalibrationData", ret, str(path))

    def load_calibration(self, path: str = "cablic.dat") -> None:
        """从文件加载校准特征。"""

        ret = self._lib.ET10C_LoadCalibrationData(self._require_handle(), _encode_path(path))
        if ret != 0:
            raise Et10cError("ET10C_LoadCalibrationData", ret, str(path))

    def get_calibration_feature(self) -> bytes:
        """把校准特征序列化成字节串（对应 demo 的 gaze_saveBingzfeature）。"""

        handle = self._require_handle()
        size = c_uint32(0)
        ret = self._lib.ET10C_getCalibFeatureLen(handle, byref(size))
        if ret != 0:
            raise Et10cError("ET10C_getCalibFeatureLen", ret)
        buffer = (c_uint8 * int(size.value))()
        written = c_uint32(int(size.value))
        ret = self._lib.ET10C_SaveCalibrationDataBin(handle, buffer, byref(written))
        if ret != 0:
            raise Et10cError("ET10C_SaveCalibrationDataBin", ret)
        return bytes(bytearray(buffer[: int(written.value)]))

    def load_calibration_feature(self, data: bytes) -> None:
        """从字节串恢复校准特征（对应 demo 的 gaze_loadBingzfeature）。"""

        payload = bytes(data)
        if not payload:
            raise ValueError("empty calibration feature")
        buffer = (c_uint8 * len(payload)).from_buffer_copy(payload)
        ret = self._lib.ET10C_LoadCalibrationDataBin(
            self._require_handle(), buffer, len(payload)
        )
        if ret != 0:
            raise Et10cError("ET10C_LoadCalibrationDataBin", ret, f"len={len(payload)}")

    def save_calibration_feature(self, path: str) -> None:
        """把校准特征以二进制形式写入文件。"""

        with open(path, "wb") as stream:
            stream.write(self.get_calibration_feature())

    def load_calibration_feature_file(self, path: str) -> None:
        with open(path, "rb") as stream:
            self.load_calibration_feature(stream.read())

    def check_blink_license(self, license_file: str) -> bool:
        """检查眨眼功能授权。返回 False 表示授权失败（功能不可用）。"""

        ret = self._lib.ET10C_checkEyeBlinkLincense(
            self._require_handle(), _encode_path(license_file)
        )
        return ret == 0

    # ------------------------------------------------------------------ #
    # 追踪
    # ------------------------------------------------------------------ #
    def start_tracker(self, smooth_level: int = 15, wait: bool = False) -> int | None:
        """开始追踪。

        ``ET10C_startTracker`` 是阻塞调用 —— C++ demo 也把它放进 ``std::thread``
        （``demoInterfaceOrgSDK.cpp`` 第 599 行），主线程随后继续跑预览循环。
        这里默认同样丢到后台守护线程并**立即返回**；``wait=True`` 时同步阻塞。

        :param smooth_level: 平滑系数（默认 15；C++ demo 里硬编码为 0）
        :param wait: True 时在当前线程阻塞到追踪结束
        :returns: ``wait=True`` 时返回 SDK 原始返回码；异步模式下返回 None
        """

        handle = self._require_handle()
        self._output_queue.clear()

        if wait:
            ret = self._lib.ET10C_startTracker(handle, int(smooth_level))
            if ret != 0:
                raise Et10cError("ET10C_startTracker", ret, f"smooth_level={smooth_level}")
            return ret

        if self._tracker_thread is not None and self._tracker_thread.is_alive():
            return None
        self._tracker_thread = threading.Thread(
            target=self._tracker_worker,
            args=(int(smooth_level),),
            name="et10c-tracker",
            daemon=True,
        )
        self._tracker_thread.start()
        return None

    def _tracker_worker(self, smooth_level: int) -> None:  # pragma: no cover - 线程体
        handle = self.handle
        if handle is None:
            return
        try:
            ret = self._lib.ET10C_startTracker(handle, smooth_level)
            if ret != 0:
                self.worker_error = f"startTracker: vendor error {ret}"
        except Exception as exc:
            self.worker_error = str(exc)

    def stop_tracker(self) -> int:
        if not self.handle:
            return 0
        ret = int(self._lib.ET10C_stopTracker(self.handle))
        thread = self._tracker_thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=5.0)
            if thread.is_alive():
                raise RuntimeError("Native ET10C worker did not stop; deinit prohibited")
        return ret