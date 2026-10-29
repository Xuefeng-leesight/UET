"""异常类型。"""

from __future__ import annotations

from ._ctypes_defs import Rtn

__all__ = ["Et10cError", "Et10cNotFoundError", "Et10cTimeoutError"]


class Et10cError(RuntimeError):
    """SDK 调用返回非 0 错误码。

    :param function: 出错的 SDK 函数名，例如 ``ET10C_init``
    :param code: SDK 返回的原始错误码
    :param context: 可选上下文（如分辨率、屏幕型号）
    """

    def __init__(self, function: str, code: int, context: str = "") -> None:
        self.function = function
        self.code = int(code)
        self.context = context
        message = f"{function} failed: code={self.code} ({Rtn.describe(self.code)})"
        if context:
            message = f"{message} [{context}]"
        super().__init__(message)


class Et10cNotFoundError(FileNotFoundError):
    """找不到设备、DLL 或校准文件。"""


class Et10cTimeoutError(TimeoutError):
    """校准 / 等待设备超时。"""
