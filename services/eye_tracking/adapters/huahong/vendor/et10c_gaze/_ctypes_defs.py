"""ET10C 眼动 SDK 的 ctypes 类型定义。

与 SDK 头文件一一对应：

* ``gzEt10c_interface.hpp`` —— 眼动 / 相机 / 校准接口
* ``deviceEnumerates.hpp``  —— 设备枚举与实例创建

对应 SDK：ET10C Win SDK V2.3.0（``et10c_interface.dll``）。
按需求只封装眼动（gaze）接口，虹膜（Iris）接口不在此列。
"""

from __future__ import annotations

from ctypes import (
    CFUNCTYPE,
    POINTER,
    Structure,
    c_bool,
    c_char,
    c_char_p,
    c_float,
    c_int,
    c_int16,
    c_int32,
    c_int64,
    c_uint8,
    c_uint16,
    c_uint32,
    c_void_p,
)
from enum import IntEnum

__all__ = [
    "Rtn",
    "LogLevel",
    "EyeType",
    "LightType",
    "CalibStatus",
    "GazeTrackerBbox",
    "GazeTrackerFrame",
    "GazeTrackerPoint",
    "GazeTrackerVec3",
    "GazeTrackerLine",
    "GazeTrackerEyeInfo",
    "GazeTrackerAdditionalInfo",
    "GazeTrackerScreenPhysicalInfo",
    "TimeRange",
    "GazeTrackerOutput",
    "GazeTrackerInput",
    "GazeTrackerCalibBias",
    "StreamInfos",
    "SystemDevInfoDisc",
    "CameraCallback",
    "FinishCalibrationOnePointCallback",
    "TrackInfoCb",
    "DeviceStatusCallback",
    "EyeDetectCallback",
    "PROTOTYPES",
    "bind",
]


# --------------------------------------------------------------------------- #
# 枚举（ET10C_RTN / ET10C_LOG_LEVEL / 眼部选择 / 光源 / 校准质量）
# --------------------------------------------------------------------------- #
class Rtn(IntEnum):
    """ET10C_RTN。"""

    SUCCESS = 0
    UNSUPPORT_RESTYPE = -1
    ALG_INIT_FAILED = -2
    CALIB_POINT_SET_FAILED = -4
    GET_CALIB_BIAS_FAILED = -5
    CALIB_FAILED = -6
    CALIB_IMG_PATH_FAILED = -7
    CALIB_TIMEOUT = -8

    @classmethod
    def describe(cls, code: int) -> str:
        try:
            return cls(code).name
        except ValueError:
            return f"UNKNOWN({code})"


class LogLevel(IntEnum):
    """ET10C_LOG_LEVEL。"""

    PANIC = 0
    ERROR = 1
    WARN = 2
    INFO = 3
    DEBUG = 4


class EyeType(IntEnum):
    """ET10C_init 的 eyeType 参数。"""

    BOTH = 0
    LEFT = 1
    RIGHT = 2


class LightType(IntEnum):
    """ET10C_setIRLight 的 mode 参数。"""

    AUTO = 0
    MANUAL = 1


class CalibStatus(IntEnum):
    """ET10C_GazeCablicStatus，单个校准点的质量。"""

    PERFECT = 0
    COMMON = 1
    BAD = 2


# --------------------------------------------------------------------------- #
# 基础结构体
# --------------------------------------------------------------------------- #
class GazeTrackerBbox(Structure):
    """ET10C_GazeTrackerBbox：原图坐标系下的矩形框。"""

    _fields_ = (
        ("n32Left", c_int),
        ("n32Top", c_int),
        ("n32Width", c_int),
        ("n32Height", c_int),
    )

    @property
    def center(self) -> tuple[float, float]:
        return (
            (self.n32Left * 2 + self.n32Width) / 2.0,
            (self.n32Top * 2 + self.n32Height) / 2.0,
        )

    def as_tuple(self) -> tuple[int, int, int, int]:
        return (self.n32Left, self.n32Top, self.n32Width, self.n32Height)

    def __repr__(self) -> str:  # pragma: no cover - 调试辅助
        return (
            f"GazeTrackerBbox(left={self.n32Left}, top={self.n32Top}, "
            f"width={self.n32Width}, height={self.n32Height})"
        )


class GazeTrackerFrame(Structure):
    """ET10C_GazeTrackerFrame：灰度帧（供 ET10C_GazeTrackerInput 使用）。"""

    _fields_ = (
        ("n32Width", c_int),
        ("n32Height", c_int),
        ("pData", c_void_p),
    )


class GazeTrackerPoint(Structure):
    """ET10C_GazeTrackerPoint：归一化屏幕坐标（0~1）。"""

    _fields_ = (("f32X", c_float), ("f32Y", c_float))

    @classmethod
    def from_xy(cls, x: float, y: float) -> "GazeTrackerPoint":
        return cls(f32X=float(x), f32Y=float(y))

    def as_tuple(self) -> tuple[float, float]:
        return (self.f32X, self.f32Y)

    def __repr__(self) -> str:  # pragma: no cover - 调试辅助
        return f"GazeTrackerPoint({self.f32X:.4f}, {self.f32Y:.4f})"


class GazeTrackerVec3(Structure):
    """ET10C_GazeTrackerVec3：相机坐标系下的三维点 / 向量。"""

    _fields_ = (("f32X", c_float), ("f32Y", c_float), ("f32Z", c_float))

    def as_tuple(self) -> tuple[float, float, float]:
        return (self.f32X, self.f32Y, self.f32Z)

    def __repr__(self) -> str:  # pragma: no cover - 调试辅助
        return f"GazeTrackerVec3({self.f32X:.4f}, {self.f32Y:.4f}, {self.f32Z:.4f})"


class GazeTrackerLine(Structure):
    """ET10C_GazeTrackerLine：视线（角膜中心 + 方向）。"""

    _fields_ = (
        ("tCorneaCenter", GazeTrackerVec3),
        ("tDirection", GazeTrackerVec3),
    )


class GazeTrackerEyeInfo(Structure):
    """ET10C_GazeTrackerEyeInfo：单眼信息。"""

    _fields_ = (
        ("tBbox", GazeTrackerBbox),
        ("tPupilCenter", GazeTrackerPoint),
        ("f32PupilWidth", c_float),
        ("f32PupilHeight", c_float),
        ("f32PupilAngle", c_float),
        ("aPurkinje", GazeTrackerPoint * 2),
    )


class GazeTrackerAdditionalInfo(Structure):
    """ET10C_GazeTrackerAdditionalInfo。"""

    _fields_ = (
        ("nOffsetEyeInfo", c_int),
        ("nEyeImgWidth", c_int),
        ("nEyeImgHeight", c_int),
    )


class GazeTrackerScreenPhysicalInfo(Structure):
    """ET10C_GazeTrackerScreenPhysicalInfo：屏幕与摄像机的物理关系。

    该结构在 ``ET10C_init`` / ``ET10C_reConfig`` 中是**按值**传递的。

    字段单位：

    * ``nAngleScreenCamera`` 屏幕平面与摄像机平面夹角（度）
    * ``nDisScreenCamera``   摄像机中心到屏幕平面的距离（mm）
    * ``nScreenWidthMM``     屏幕可视宽度（mm）
    * ``nScreenHeightMM``    屏幕可视高度（mm）
    * ``nBottomHeightMM``    底边框高度（mm）
    """

    _fields_ = (
        ("nAngleScreenCamera", c_int),
        ("nDisScreenCamera", c_int),
        ("nScreenWidthMM", c_int),
        ("nScreenHeightMM", c_int),
        ("nBottomHeightMM", c_int),
    )

    def as_tuple(self) -> tuple[int, int, int, int, int]:
        return (
            self.nAngleScreenCamera,
            self.nDisScreenCamera,
            self.nScreenWidthMM,
            self.nScreenHeightMM,
            self.nBottomHeightMM,
        )

    def __repr__(self) -> str:  # pragma: no cover - 调试辅助
        return (
            "GazeTrackerScreenPhysicalInfo(angle={}, distance={}, "
            "width_mm={}, height_mm={}, bottom_mm={})".format(*self.as_tuple())
        )


class TimeRange(Structure):
    """ET10C_TimeRange：眨眼时间段（int64，微秒级时间戳）。"""

    _fields_ = (
        ("startTimeStamp", c_int64),
        ("endTimeStamp", c_int64),
    )


class GazeTrackerOutput(Structure):
    """ET10C_GazeTrackerOutput：一帧眼动追踪结果。"""

    _fields_ = (
        ("haveLeftEyeInfo", c_int),
        ("haveRightEyeInfo", c_int),
        ("haveMergeScreenPoint", c_int),
        ("haveLeftScreenPoint", c_int),
        ("haveRightScreenPoint", c_int),
        ("haveLeftEyeblink", c_int),
        ("haveRightEyeblink", c_int),
        ("leftEyeBlinkTime", TimeRange),
        ("rightEyeBlinkTime", TimeRange),
        ("currTimePts", c_int64),
        ("tLeftEyeInfo", GazeTrackerEyeInfo),
        ("tRightEyeInfo", GazeTrackerEyeInfo),
        ("mergeScreenPoint", GazeTrackerPoint),
        ("tLeftScreenPoint", GazeTrackerPoint),
        ("tRightScreenPoint", GazeTrackerPoint),
        ("tLeftSightLine", GazeTrackerLine),
        ("tRightSightLine", GazeTrackerLine),
    )


class GazeTrackerInput(Structure):
    """ET10C_GazeTrackerInput：自定义帧输入（离线算法调用用）。"""

    _fields_ = (
        ("tFrame", GazeTrackerFrame),
        ("tRoiEye", GazeTrackerBbox),
        ("tAdditionalInfo", GazeTrackerAdditionalInfo),
        ("u32LightType", c_uint32),
        ("u32Distance", c_uint32),
        ("u32SmoothLevel", c_uint32),
    )


class GazeTrackerCalibBias(Structure):
    """ET10C_GazeTrackerCalibBias：校准偏差与质量分数。"""

    _fields_ = (
        ("numOfCalibrate", c_uint32),
        ("scores", c_uint32 * 25),
        ("leftBias", GazeTrackerPoint * 25),
        ("rightBias", GazeTrackerPoint * 25),
        ("cablicStatus", c_int * 25),
    )

    def iter_points(self):
        """按已校准点数逐点产出 ``(index, left_bias, right_bias, status, score)``。"""

        for i in range(min(int(self.numOfCalibrate), 25)):
            yield (
                i,
                self.leftBias[i].as_tuple(),
                self.rightBias[i].as_tuple(),
                CalibStatus(self.cablicStatus[i]),
                int(self.scores[i]),
            )


class StreamInfos(Structure):
    """ET10C_StreamInfos：当前视频流信息。"""

    _fields_ = (
        ("width", c_uint32),
        ("height", c_uint32),
        ("fps", c_uint32),
    )

    def as_tuple(self) -> tuple[int, int, int]:
        return (int(self.width), int(self.height), int(self.fps))

    def __repr__(self) -> str:  # pragma: no cover - 调试辅助
        return f"StreamInfos(width={self.width}, height={self.height}, fps={self.fps})"


class SystemDevInfoDisc(Structure):
    """SystemDevInfoDisc：设备枚举条目（deviceEnumerates.hpp）。"""

    _fields_ = (
        ("devName", c_char * 128),
        ("vid", c_uint16),
        ("pid", c_uint16),
        ("uid", c_char * 128),
    )


# --------------------------------------------------------------------------- #
# 回调原型
# --------------------------------------------------------------------------- #
#: 眼动背景图回调 (usr_ptr, data, width, height, len)，data 为 width*height 灰度图
CameraCallback = CFUNCTYPE(None, c_void_p, c_void_p, c_uint32, c_uint32, c_uint32)

#: 单点校准完成回调 (usr_ptr, finished_count)，finished_count 从 1 开始
FinishCalibrationOnePointCallback = CFUNCTYPE(None, c_void_p, c_uint32)

#: 追踪结果回调 (usr_ptr, output)
TrackInfoCb = CFUNCTYPE(None, c_void_p, POINTER(GazeTrackerOutput))

#: 设备连接 / 断开回调 (usr_ptr)
DeviceStatusCallback = CFUNCTYPE(None, c_void_p)

#: 眼睛检测回调 (usr_ptr, left_eye_bbox, right_eye_bbox)
EyeDetectCallback = CFUNCTYPE(None, c_void_p, POINTER(GazeTrackerBbox), POINTER(GazeTrackerBbox))


# --------------------------------------------------------------------------- #
# 函数原型表：name -> (argtypes, restype)
# --------------------------------------------------------------------------- #
PROTOTYPES: dict[str, tuple[tuple, object]] = {
    # ---- 设备枚举 / 实例（deviceEnumerates.hpp）----
    "getSystemDevicesList": ((POINTER(SystemDevInfoDisc), c_uint32, POINTER(c_uint32)), c_int),
    "createDevice": ((POINTER(SystemDevInfoDisc),), c_void_p),
    # ---- 生命周期 ----
    "ET10C_init": (
        (
            c_void_p,
            c_int,
            c_char_p,
            c_int,
            GazeTrackerScreenPhysicalInfo,
            c_char_p,
            c_int,
        ),
        c_int32,
    ),
    "ET10C_reConfig": (
        (c_void_p, c_int, c_int, c_int, GazeTrackerScreenPhysicalInfo),
        c_int32,
    ),
    "ET10C_Deinit": ((c_void_p,), None),
    "ET10C_checkEyeBlinkLincense": ((c_void_p, c_char_p), c_int32),
    # ---- 回调注册 ----
    "ET10C_registerEyeCameraCb": ((c_void_p, CameraCallback, c_void_p), None),
    "ET10C_registerEyeDetectCb": ((c_void_p, EyeDetectCallback, c_void_p), None),
    "ET10C_registerTrackerOutputCb": ((c_void_p, TrackInfoCb, c_void_p), None),
    "ET10C_registerCalibrationOnePointFinishCb": (
        (c_void_p, FinishCalibrationOnePointCallback, c_void_p),
        None,
    ),
    # 注意：设备状态回调是全局注册，没有 handle 参数
    "ET10C_registerDeviceStatusCallback": (
        (DeviceStatusCallback, DeviceStatusCallback, c_void_p),
        None,
    ),
    # ---- 相机 ----
    "ET10C_startCamera": ((c_void_p,), c_int32),
    "ET10C_stopCamera": ((c_void_p,), None),
    "ET10C_getCurrStreamInfos": ((c_void_p, POINTER(StreamInfos)), None),
    "ET10C_setIRLight": ((c_void_p, c_bool, c_int, c_int), None),
    "ET10C_setVcmCode": ((c_void_p, c_int32), c_int32),
    "ET10C_getDistance": ((c_void_p, POINTER(c_int16)), None),
    "ET10C_getDeviceVersion": ((c_void_p,), c_char_p),
    # ---- 眼睛检测 ----
    "ET10C_startEyeDetect": ((c_void_p,), c_int32),
    "ET10C_stopEyeDetect": ((c_void_p,), c_int32),
    # ---- 校准 ----
    "ET10C_performOnePointCalibration": (
        (c_void_p, POINTER(GazeTrackerPoint), c_uint32, c_int, c_char_p),
        c_int32,
    ),
    "ET10C_CalibrationStop": ((c_void_p,), None),
    "ET10C_checkCalibrationFinished": ((c_void_p,), c_int32),
    "ET10C_getCalibBias": ((c_void_p, POINTER(GazeTrackerCalibBias)), c_int32),
    # ---- 追踪 ----
    "ET10C_startTracker": ((c_void_p, c_uint32), c_int32),
    "ET10C_stopTracker": ((c_void_p,), c_int32),
    "ET10C_trackerOutput": ((c_void_p, POINTER(GazeTrackerOutput)), c_int32),
    # ---- 特征（校准数据）存取 ----
    "ET10C_getCalibFeatureLen": ((c_void_p, POINTER(c_uint32)), c_int32),
    "ET10C_SaveCalibrationData": ((c_void_p, c_char_p), c_int32),
    "ET10C_SaveCalibrationDataBin": ((c_void_p, POINTER(c_uint8), POINTER(c_uint32)), c_int32),
    "ET10C_LoadCalibrationData": ((c_void_p, c_char_p), c_int32),
    "ET10C_LoadCalibrationDataBin": ((c_void_p, POINTER(c_uint8), c_uint32), c_int32),
    # ---- 工具 / 版本 ----
    "ET10C_TrackerFromScreenToCamera": (
        (c_void_p, POINTER(GazeTrackerPoint), POINTER(GazeTrackerVec3)),
        None,
    ),
    "ET10C_getGzSdkVersion": ((), c_char_p),
    "ET10C_getGzAlgVersion": ((), c_char_p),
}


def bind(lib) -> None:
    """把 :data:`PROTOTYPES` 应用到已加载的 CDLL/WinDLL 实例上。"""

    for name, (argtypes, restype) in PROTOTYPES.items():
        fn = getattr(lib, name)
        fn.argtypes = list(argtypes)
        fn.restype = restype
