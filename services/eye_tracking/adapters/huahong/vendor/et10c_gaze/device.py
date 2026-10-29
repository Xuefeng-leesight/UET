"""设备枚举与实例创建（对应 deviceEnumerates.hpp）。"""

from __future__ import annotations

from ctypes import byref, c_uint32, c_void_p
from dataclasses import dataclass

from ._ctypes_defs import SystemDevInfoDisc
from .errors import Et10cError, Et10cNotFoundError

__all__ = ["DeviceInfo", "list_devices", "create_device"]

MAX_DEVICES = 8


@dataclass(frozen=True)
class DeviceInfo:
    """一个可用于 ``createDevice`` 的设备条目。"""

    index: int
    name: str
    vid: int
    pid: int
    uid: str

    @property
    def is_et12(self) -> bool:
        """ET12 机型不支持 ``ET10C_getDistance``（与 C++ demo 的 ``m_devName != "et12"`` 对应）。"""

        return self.name.strip().lower() == "et12"

    def __str__(self) -> str:  # pragma: no cover - 展示用
        return (
            f"[{self.index}] {self.name} (vid=0x{self.vid:04x}, "
            f"pid=0x{self.pid:04x}, uid={self.uid})"
        )


def _decode_c_char_array(raw: bytes) -> str:
    raw = raw.split(b"\0", 1)[0]
    for encoding in ("utf-8", "gbk"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1")


def _to_device_info(index: int, entry: SystemDevInfoDisc) -> DeviceInfo:
    return DeviceInfo(
        index=index,
        name=_decode_c_char_array(bytes(entry.devName)).strip(),
        vid=int(entry.vid),
        pid=int(entry.pid),
        uid=_decode_c_char_array(bytes(entry.uid)).strip(),
    )


def list_devices(lib, max_devices: int = MAX_DEVICES) -> list[DeviceInfo]:
    """枚举当前可用设备。

    :param lib: :func:`et10c_gaze.load_sdk` 返回的库对象
    :param max_devices: 最多查询的设备数量
    :returns: :class:`DeviceInfo` 列表（可能为空）
    """

    buffer = (SystemDevInfoDisc * max_devices)()
    valid = c_uint32(0)
    ret = lib.getSystemDevicesList(buffer, max_devices, byref(valid))
    count = min(int(valid.value), max_devices)
    if count == 0:
        # 实测无可用设备时 SDK 返回非 0（-1）；接口结果以 validArrayCounts 为准，
        # 与 C++ demo（只检查 validNums）保持一致。
        return []
    if ret != 0:
        raise Et10cError("getSystemDevicesList", ret, f"validArrayCounts={count}")
    return [_to_device_info(i, buffer[i]) for i in range(count)]


def create_device(lib, device: DeviceInfo | int = 0) -> c_void_p:
    """创建设备实例，返回句柄（``c_void_p``）。

    :param lib: 库对象
    :param device: :class:`DeviceInfo` 或设备索引
    :raises Et10cNotFoundError: 设备不存在或创建失败
    """

    devices = list_devices(lib)
    if not devices:
        raise Et10cNotFoundError("no ET10C device found (getSystemDevicesList returned 0)")

    if isinstance(device, DeviceInfo):
        index = device.index
    else:
        index = int(device)
    if not 0 <= index < len(devices):
        raise Et10cNotFoundError(
            f"device index {index} out of range, {len(devices)} device(s) available"
        )

    entry = SystemDevInfoDisc()
    entry.devName = devices[index].name.encode("gbk", errors="replace")
    entry.vid = devices[index].vid
    entry.pid = devices[index].pid
    entry.uid = devices[index].uid.encode("gbk", errors="replace")

    handle = lib.createDevice(entry)
    if not handle:
        raise Et10cNotFoundError(f"createDevice failed for {devices[index]}")
    return handle
