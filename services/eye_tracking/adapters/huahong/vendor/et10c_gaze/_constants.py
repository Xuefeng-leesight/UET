"""常量表：屏幕物理参数、校准点索引、分辨率与背景图缩放。

数值来自 `demoInterfaceOrgSDK.cpp`（TestInterface::gaze_initTracker /
configCalibPoinxIndex / TestGBcallback），保证 Python 与 C++ demo 行为一致。
"""

from __future__ import annotations

from ._ctypes_defs import GazeTrackerPoint, GazeTrackerScreenPhysicalInfo

__all__ = [
    "SCREEN_PROFILES",
    "CALIB_POINT_INDEX",
    "RESOLUTIONS",
    "GRID_HOR",
    "GRID_VER",
    "TOTAL_POINTS",
    "screen_physical_info",
    "calib_point_index",
    "base_screen_points",
    "bg_resize_ratio",
    "smooth_level_for_fps",
    "RESOLUTIONS_BY_DEVICE",
    "DEFAULT_RES_TYPES",
    "resolutions_for",
    "default_res_type",
]

#: 屏幕型号 -> (夹角°, 距离mm, 宽mm, 高mm, 底边高mm)
SCREEN_PROFILES: dict[str, tuple[int, int, int, int, int]] = {
    "SCREEN_LIGHTPAD": (15, 10, 90, 45, 55),
    "SCREEN_LIGHTPAD2": (20, 10, 120, 120, 5),
    "SCREEN_133": (20, 25, 293, 165, 5),
    "SCREEN_160": (20, 25, 354, 200, 60),
    "SCREEN_170": (10, 10, 420, 236, 60),
    "SCREEN_190": (10, 10, 420, 236, 60),
    "SCREEN_215": (20, 10, 480, 268, 60),
    "SCREEN_240": (20, 10, 532, 299, 60),
    "SCREEN_270": (20, 10, 618, 371, 60),
}

#: 校准点数 -> 在该点集中使用的 5x5 基础点索引
CALIB_POINT_INDEX: dict[int, tuple[int, ...]] = {
    25: tuple(range(25)),
    9: (0, 2, 4, 10, 12, 14, 20, 22, 24),
    6: (1, 3, 10, 14, 20, 24),
    5: (0, 4, 12, 20, 24),
    4: (0, 4, 20, 24),
    3: (0, 12, 24),
    2: (0, 8),
}

#: 支持的分辨率类型（ET10 / ET12 不同）
RESOLUTIONS: tuple[str, ...] = (
    "256x296x60",
    "640x368x30",
    "3280x1232x30",
    "1640x1232x60",
    "1920x1080x30",
    "1280x720x60",
    "1024x600x300",
    "1920x600x300",
)

#: 各机型支持的 res_type（头文件 gzEt10c_interface.hpp：ET10 / ET12 不通用）
RESOLUTIONS_BY_DEVICE: dict[str, tuple[str, ...]] = {
    "et10": ("256x296x60", "640x368x30", "3280x1232x30", "1640x1232x60"),
    "et12": ("1920x1080x30", "1024x600x300"),
}

#: 未显式指定 res_type 时各机型的默认值
DEFAULT_RES_TYPES: dict[str, str] = {
    "et10": "1640x1232x60",
    "et12": "1920x1080x30",
}

#: 机型名无法识别时的兜底值（与 C++ demo 的 main() 一致）
FALLBACK_RES_TYPE = "1640x1232x60"


def resolutions_for(device_name: str) -> tuple[str, ...]:
    """返回机型支持的 res_type；机型名不认识时返回空元组。"""

    return RESOLUTIONS_BY_DEVICE.get((device_name or "").strip().lower(), ())


def default_res_type(device_name: str) -> str:
    """按机型给出默认 res_type（调用方未显式指定时使用）。"""

    return DEFAULT_RES_TYPES.get((device_name or "").strip().lower(), FALLBACK_RES_TYPE)


GRID_HOR = 5
GRID_VER = 5
TOTAL_POINTS = GRID_HOR * GRID_VER

#: 背景预览图缩放比（大分辨率下降低 imshow 压力）
_BG_RESIZE_RATIO: dict[str, int] = {
    "3280x1232x30": 8,
    "1920x1080x30": 8,
    "1640x1232x60": 8,
    "1280x720x60": 4,
    "1024x600x300": 4,
    "1920x600x300": 4,
}


def screen_physical_info(screen_type: str) -> GazeTrackerScreenPhysicalInfo:
    """把屏幕型号转换成 ``ET10C_GazeTrackerScreenPhysicalInfo``。

    :raises KeyError: 未知屏幕型号（可用键见 :data:`SCREEN_PROFILES`）
    """

    try:
        angle, distance, width, height, bottom = SCREEN_PROFILES[screen_type]
    except KeyError as exc:  # pragma: no cover - 错误路径
        raise KeyError(
            f"unknown screen type {screen_type!r}; "
            f"available: {', '.join(sorted(SCREEN_PROFILES))}"
        ) from exc
    return GazeTrackerScreenPhysicalInfo(
        nAngleScreenCamera=angle,
        nDisScreenCamera=distance,
        nScreenWidthMM=width,
        nScreenHeightMM=height,
        nBottomHeightMM=bottom,
    )


def calib_point_index(calib_points: int) -> tuple[int, ...]:
    """返回指定校准点数对应的基础点索引序列。"""

    try:
        return CALIB_POINT_INDEX[calib_points]
    except KeyError as exc:  # pragma: no cover - 错误路径
        raise KeyError(
            f"unsupported calib_points={calib_points}; "
            f"available: {sorted(CALIB_POINT_INDEX)}"
        ) from exc


def base_screen_points(hor: int = GRID_HOR, ver: int = GRID_VER) -> list[GazeTrackerPoint]:
    """生成 5x5 归一化基础点（每个网格中心，坐标 0~1）。

    与 C++ demo 中 ``m_aBaseScreenPoint`` 的生成方式一致：
    ``x = j / hor + (1 / hor) / 2``，``y = i / ver + (1 / ver) / 2``。
    """

    interval_x = 1.0 / hor
    interval_y = 1.0 / ver
    points: list[GazeTrackerPoint] = []
    for i in range(ver):
        for j in range(hor):
            points.append(
                GazeTrackerPoint.from_xy(
                    j * interval_x + interval_x / 2,
                    i * interval_y + interval_y / 2,
                )
            )
    return points


def bg_resize_ratio(res_type: str) -> int:
    """背景预览图缩放比（对应 C++ demo 里的 ``resizeRatio``）。"""

    return _BG_RESIZE_RATIO.get(res_type, 1)


def smooth_level_for_fps(fps: float) -> int:
    """按流帧率推导平滑系数（对应 C++ demo 的 gaze_startTrakcer）。

    注意：C++ demo 里该值随后被硬编码为 0（不平滑），Python 侧默认同样传 0，
    这里保留函数供需要开平滑的场景使用。
    """

    level = 6
    if fps > 120:
        level = 30
    elif fps > 60:
        level *= 2
    return level