"""aiotGlass 眼动追踪 SDK —— ctypes 绑定层

对应 Windows 版 ``AiotGlassEyeTrackerInterface.dll``（接口库）+
``AiotGlassEyeTracker.dll``（算法库）。结构体与函数原型严格按
``glassTrackerInterface/*.hpp`` 定义，布局已用 MSVC x64 探针实测对齐。

本模块只做三件事：
  1. 定义 C 结构体 / 枚举常量 / 回调签名；
  2. 定位并加载 DLL（含依赖目录处理）；
  3. 把结构体转成 Python dict，方便上层使用。
"""

from __future__ import annotations

import ctypes
import os
import sys
from ctypes import (
    CFUNCTYPE,
    POINTER,
    Structure,
    c_bool,
    c_char,
    c_char_p,
    c_double,
    c_float,
    c_int,
    c_int16,
    c_int32,
    c_uint8,
    c_uint16,
    c_uint32,
    c_uint64,
    c_void_p,
)

MAX_CALIB_POINTS = 25

# 设备 PID：左右眼 + world。枚举时按这些值识别设备型号。
PID_AIOTGLASS_LEFT, PID_AIOTGLASS_RIGHT, PID_AIOTGLASS_WORLD = 0x0240, 0x0241, 0x0242
PID_ET28_LEFT, PID_ET28_RIGHT = 0x0094, 0x0093
VID_ET28_WORLD, PID_ET28_WORLD = 0x1BCF, 0x2CED


# ---------------------------------------------------------------------------
# 结构体（顺序/类型与头文件一一对应）
# ---------------------------------------------------------------------------

class AiotGzTrackerPoint2d(Structure):
    _fields_ = [("x", c_float), ("y", c_float)]

    def __repr__(self) -> str:
        return f"({self.x:.4f}, {self.y:.4f})"


class AiotGzTrackerVec3(Structure):
    _fields_ = [("x", c_float), ("y", c_float), ("z", c_float)]

    def __repr__(self) -> str:
        return f"({self.x:.3f}, {self.y:.3f}, {self.z:.3f})"


class AiotGazeTrackerPupil2d(Structure):
    """二维瞳孔拟合椭圆，坐标单位是眼图像素。"""
    _fields_ = [
        ("valid", c_bool),
        ("center", AiotGzTrackerPoint2d),
        ("width", c_float),
        ("height", c_float),
        ("angle", c_float),
    ]


class AiotGazeTrackerPupil3d(Structure):
    """三维瞳孔中心与直径，单位 mm。"""
    _fields_ = [
        ("valid", c_bool),
        ("center", AiotGzTrackerVec3),
        ("diameter", c_float),
    ]


class AiotGazeTrackerPupil(Structure):
    _fields_ = [("pupil2d", AiotGazeTrackerPupil2d), ("pupil3d", AiotGazeTrackerPupil3d)]


class AiotGazeTrackerEyelid(Structure):
    """眼睑轮廓，24 个关键点。"""
    _fields_ = [("valid", c_bool), ("contour", AiotGzTrackerPoint2d * 24)]


class AiotGazeTrackerGaze(Structure):
    _fields_ = [
        ("valid", c_bool),
        ("worldPoint", AiotGzTrackerPoint2d),   # 归一化注视点 0~1
        ("corneaCenter", AiotGzTrackerVec3),
        ("gazeDirection", AiotGzTrackerVec3),
    ]


class AiotGazeTrackerTimeRange(Structure):
    _fields_ = [("startTimeStamp", c_uint64), ("endTimeStamp", c_uint64)]


class AiotGazeTrackerblink(Structure):
    _fields_ = [
        ("blinkDetected", c_bool),
        ("blinkTimeRange", AiotGazeTrackerTimeRange),
        ("eyelidOpenDegree", c_int),           # 0~100，-1 表示无效
    ]


class AiotGazeTrackerStampedPoint(Structure):
    """带时间戳的注视点，对应 native 侧 AiotGazeTrackerStampedPoint。"""
    _fields_ = [
        ("valid", c_bool),
        ("point", AiotGzTrackerPoint2d),
        ("timeStamp", c_uint64),
    ]


class AiotGazeTrackerFixationEvent(Structure):
    """一次注视事件，对应 native 侧 AiotGazeTrackerFixationEvent。"""
    _fields_ = [
        ("valid", c_bool),
        ("start", AiotGazeTrackerStampedPoint),
        ("end", AiotGazeTrackerStampedPoint),
        ("centroid", AiotGzTrackerPoint2d),
        ("dispersion", c_double),
    ]


class AiotGazeTrackerSaccadeEvent(Structure):
    """一次扫视事件；amplitude / velocity 同时提供像素域与角度域。"""
    _fields_ = [
        ("valid", c_bool),
        ("start", AiotGazeTrackerStampedPoint),
        ("end", AiotGazeTrackerStampedPoint),
        ("amplitude", c_double),
        ("peakVelocity", c_double),
        ("meanVelocity", c_double),
        ("amplitudeDeg", c_double),
        ("peakVelocityDeg", c_double),
        ("meanVelocityDeg", c_double),
    ]


class AiotGazeTrackerInvalidEvent(Structure):
    """一次无效段（瞳孔丢失 / 跟踪丢失等）。"""
    _fields_ = [
        ("valid", c_bool),
        ("start_end", AiotGazeTrackerTimeRange),
    ]


class AiotGazeTrackerGazeEvent(Structure):
    """注视 / 扫视 / 无效段聚合事件，对应 native 侧 AoitGazeTrackerGazeEvent。"""
    _fields_ = [
        ("fixation", AiotGazeTrackerFixationEvent),
        ("saccade", AiotGazeTrackerSaccadeEvent),
        ("invalid", AiotGazeTrackerInvalidEvent),
    ]


class AiotGazeTrackerPredictOutputOneEye(Structure):
    _fields_ = [
        ("timeStamp", c_uint64),
        ("Pupil", AiotGazeTrackerPupil),
        ("Eyelid", AiotGazeTrackerEyelid),
        ("Gaze", AiotGazeTrackerGaze),
        ("Blink", AiotGazeTrackerblink),
    ]


class AiotGazeTrackerPredictOutput(Structure):
    _fields_ = [
        ("leftPreDict", AiotGazeTrackerPredictOutputOneEye),
        ("rightPreDict", AiotGazeTrackerPredictOutputOneEye),
        ("mergeGaze", AiotGazeTrackerGaze),
        ("gazeEvent", AiotGazeTrackerGazeEvent),
    ]


class AiotRoiRect(Structure):
    _fields_ = [
        ("left", c_uint32),
        ("top", c_uint32),
        ("width", c_uint32),
        ("height", c_uint32),
    ]


class AiotGazeTrackerCalibBias(Structure):
    _fields_ = [
        ("numOfCalibrate", c_uint32),
        ("Bias", AiotGzTrackerPoint2d * MAX_CALIB_POINTS),
        ("cablicStatus", c_int * MAX_CALIB_POINTS),
        ("Score", c_uint32 * MAX_CALIB_POINTS),
    ]


class GlassDevInfoDisc(Structure):
    _fields_ = [
        ("devName", c_char * 128),
        ("m_vid_leftEye", c_uint16),
        ("m_pid_leftEye", c_uint16),
        ("m_vid_rightEye", c_uint16),
        ("m_pid_rightEye", c_uint16),
        ("m_vid_world", c_uint16),
        ("m_pid_world", c_uint16),
        ("androidFileDiscLeftEye", c_int32),
        ("androidFileDiscRightEye", c_int32),
        ("androidFileDiscWorld", c_int32),
    ]


class AiotCameraPara(Structure):
    _fields_ = [
        ("m_worldWidth", c_int32),
        ("m_worldHeight", c_int32),
        ("m_worldFPS", c_int32),
        ("m_worldDFoV", c_int32),
        ("m_worldHFoV", c_int32),
        ("m_worldVFoV", c_int32),
        ("m_irOneEyeWidth", c_int32),
        ("m_irOneEyeHeight", c_int32),
        ("m_irFPS", c_int32),
        ("m_irFoV", c_int32),
        ("m_worldCameraCropType", c_int),
    ]


# ---------------------------------------------------------------------------
# 枚举（C 侧是普通 enum，按 int 传）
# ---------------------------------------------------------------------------

class WorldCameraCropType:
    Normal = 0
    CENTERCROP = 1
    LOWERCROP = 2
    UNKNOWN = 3

    NAMES = {0: "Normal", 1: "CENTERCROP", 2: "LOWERCROP", 3: "UNKNOWN"}


class Angle:
    A0 = 0
    A90 = 90
    A180 = 180
    A270 = 270


class ReqCode:
    GET_CURR = 0
    GET_MAX = 1
    GET_MIN = 2


class CameraType:
    IR_LEFT = 0
    IR_RIGHT = 1
    WORLD = 2


class EyeType:
    TWOEYE = 0
    LEFTEYE = 1
    RIGHTEYE = 2


class CablicStatus:
    Perfect = 0
    Common = 1
    Bad = 2

    NAMES = {0: "Perfect", 1: "Common", 2: "Bad"}


class ReturnCode:
    SUCCESS = 0
    NULL_HANDLE = -1
    UVCMODULE_INIT_FALED = -2
    DEV_FOULD_FALED = -3
    AlgInitFailed = -4
    CalibrateParseParams = -5
    CalibrateReConfigPointsNumFailed = -6
    CalibrateConfigAlgFailed = -7
    CalibrateTimeOut = -8
    CalibrateStartPointFailed = -9
    CalibrateSaveParamsFailed = -10
    CalibrateParamsInputLenghtFailed = -11
    CalibrateLoadParamsFailed = -12
    SetCameraParaFailed = -13
    StartCameraFailed = -14
    LISTGETFAIED = -15

    NAMES = {
        0: "SUCCESS", -1: "NULL_HANDLE", -2: "UVCMODULE_INIT_FALED", -3: "DEV_FOULD_FALED",
        -4: "AlgInitFailed", -5: "CalibrateParseParams", -6: "CalibrateReConfigPointsNumFailed",
        -7: "CalibrateConfigAlgFailed", -8: "CalibrateTimeOut", -9: "CalibrateStartPointFailed",
        -10: "CalibrateSaveParamsFailed", -11: "CalibrateParamsInputLenghtFailed",
        -12: "CalibrateLoadParamsFailed", -13: "SetCameraParaFailed", -14: "StartCameraFailed",
        -15: "LISTGETFAIED",
    }


def rc_name(code: int) -> str:
    return ReturnCode.NAMES.get(int(code), f"UNKNOWN({code})")


# ---------------------------------------------------------------------------
# 回调签名
# ---------------------------------------------------------------------------

CameraCallback = CFUNCTYPE(None, c_void_p, c_void_p, c_uint32)
TrackInfoCb = CFUNCTYPE(None, c_void_p, POINTER(AiotGazeTrackerPredictOutput))
DeviceStatusCallback = CFUNCTYPE(None, c_void_p)


# ---------------------------------------------------------------------------
# DLL 加载
# ---------------------------------------------------------------------------

DLL_NAME = "AiotGlassEyeTrackerInterface.dll"
ALG_DLL_NAME = "AiotGlassEyeTracker.dll"

_lib: ctypes.CDLL | None = None
_dll_dirs: list[str] = []


def _here() -> str:
    return os.path.dirname(os.path.abspath(__file__))


def _candidate_dirs() -> list[str]:
    """按优先级列出可能的 DLL 目录（去重、只保留存在的）。"""
    here = _here()
    raw = [
        os.environ.get("AIOTGLASS_SDK_DIR", ""),
        os.path.join(here, "bin"),
        here,
        os.path.join(here, "..", "bin"),
    ]
    out: list[str] = []
    for p in raw:
        if not p:
            continue
        p = os.path.abspath(p)
        if p not in out and os.path.isdir(p):
            out.append(p)
    return out


def find_dll_dir(dll_dir: str | None = None) -> str:
    if dll_dir:
        p = os.path.abspath(dll_dir)
        if os.path.isfile(os.path.join(p, DLL_NAME)):
            return p
        raise FileNotFoundError(f"{DLL_NAME} 不在 {p}")
    for d in _candidate_dirs():
        if os.path.isfile(os.path.join(d, DLL_NAME)):
            return d
    raise FileNotFoundError(
        f"找不到 {DLL_NAME}。请把发布包 bin 放到 {os.path.join(_here(), 'bin')}，"
        "或设置环境变量 AIOTGLASS_SDK_DIR 指向 DLL 所在目录。"
    )


def _bind_functions(lib: ctypes.CDLL) -> None:
    def proto(name: str, restype, argtypes) -> None:
        fn = getattr(lib, name)
        fn.restype = restype
        fn.argtypes = argtypes

    P = c_void_p
    proto("getAiotGlassDevicesList", c_int, [POINTER(GlassDevInfoDisc), c_uint32, POINTER(c_uint32)])
    proto("createAiotGlassDevice", P, [POINTER(GlassDevInfoDisc)])

    proto("aiotGlass_device_init", c_int, [P])
    proto("aiotGlass_device_deinit", c_int, [P])
    proto("aiotGlass_SetDeviceStatus_Callback", None, [DeviceStatusCallback, DeviceStatusCallback, P])

    proto("aiotGlass_getCamera_para", c_int, [P, POINTER(AiotCameraPara), c_uint32, POINTER(c_uint32)])
    proto("aiotGlass_setCamera_para", c_int, [P, POINTER(AiotCameraPara)])
    proto("aiotGlass_startCamera", c_int, [P])
    proto("aiotGlass_stopCamera", None, [P])
    proto("aiotGlass_setRotateAngle", None, [P, c_int, c_int])

    proto("aiotGlass_getCameraBright", c_int, [P, c_int, POINTER(c_int16), c_int])
    proto("aiotGlass_setCameraBright", c_int, [P, c_int, c_int16])
    proto("aiotGlass_getCameraContrast", c_int, [P, c_int, POINTER(c_uint16), c_int])
    proto("aiotGlass_setCameraContrast", c_int, [P, c_int, c_uint16])
    proto("aiotGlass_setIrLedBrightness", c_int, [P, c_uint8])

    proto("aiotGlass_GetWorldCameraFrame", c_int, [P, P])
    proto("aiotGlass_GetEyeCameraFrame", c_int, [P, P])

    proto("aiotGlass_InitCalibration", c_int, [P, c_uint32, c_int])
    proto("aiotGlass_DeinitCalibration", None, [P])
    proto("aiotGlass_reConfigCalibration", c_int, [P, c_uint32, c_uint32])
    proto("aiotGlass_startCalibration", c_int, [P, POINTER(AiotGzTrackerPoint2d), c_uint32])
    proto("aiotGlass_stopCalibration", None, [P])
    proto("aiotGlass_MergeLRCalibration", c_int, [P])
    proto("aiotGlass_getCalibBias", c_int, [P, POINTER(AiotGazeTrackerCalibBias), POINTER(AiotGazeTrackerCalibBias)])

    proto("aiotGlass_SaveCalibrationData", c_int, [P, c_char_p])
    proto("aiotGlass_LoadCalibrationData", c_int, [P, c_char_p])
    proto("aiotGlass_SaveCalibrationDataBin", c_int, [P, POINTER(c_uint8), POINTER(c_uint32)])
    proto("aiotGlass_LoadCalibrationDataBin", c_int, [P, POINTER(c_uint8), c_uint32])
    proto("aiotGlass_getFeatureLen", None, [P, POINTER(c_uint32)])

    proto("aiotGlass_initTracker", c_int, [P, c_uint32])
    proto("aiotGlass_deinitTracker", None, [P])
    proto("aiotGlass_startTracker", c_int, [P, c_uint32])
    proto("aiotGlass_stopTracker", None, [P])
    proto("aiotGlass_getTrackerOutput", c_int, [P, POINTER(AiotGazeTrackerPredictOutput)])

    proto("aiotGlass_registerWorldCameraCb", None, [P, CameraCallback, P])
    proto("aiotGlass_registerLeftEyeCameraCb", None, [P, CameraCallback, P])
    proto("aiotGlass_registerRightEyeCameraCb", None, [P, CameraCallback, P])
    proto("aiotGlass_registerTrackerOutputCb", None, [P, TrackInfoCb, P])

    proto("aiotGlass_setCnnBackend", c_int32, [P, c_int32])
    proto("aiotGlass_getCnnBackend", c_int32, [P])

    proto("aiotGlass_getSdkVersion", c_char_p, [P])
    proto("aiotGlass_getGzAlgVersion", c_char_p, [P])
    proto("aiotGlass_getFirmWareVersion", c_char_p, [P])


def load_library(dll_dir: str | None = None, *, quiet: bool = False) -> ctypes.CDLL:
    """加载接口库，返回 ctypes.CDLL。同目录依赖会被预先解析。"""
    global _lib
    if _lib is not None:
        return _lib

    d = find_dll_dir(dll_dir)
    if os.name == "nt":
        # 让 Windows 优先在 DLL 所在目录找依赖（AiotGlassEyeTracker.dll 等）
        try:
            _dll_dirs.append(os.add_dll_directory(d))  # type: ignore[attr-defined]
        except (AttributeError, OSError):
            pass
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")

    # 算法库先显式加载，避免接口库按搜索路径找不到它
    alg = os.path.join(d, ALG_DLL_NAME)
    if os.path.isfile(alg):
        try:
            ctypes.CDLL(alg)
        except OSError as exc:
            if not quiet:
                print(f"[aiot_dll] 预加载 {ALG_DLL_NAME} 失败: {exc}")

    lib = ctypes.CDLL(os.path.join(d, DLL_NAME))
    _bind_functions(lib)
    if not quiet:
        print(f"[aiot_dll] loaded {DLL_NAME} from {d}")
    _lib = lib
    return lib


def library() -> ctypes.CDLL:
    return load_library(quiet=True)


# ---------------------------------------------------------------------------
# 结构体 <-> dict
# ---------------------------------------------------------------------------

_PARA_FIELDS = (
    "m_worldWidth", "m_worldHeight", "m_worldFPS", "m_worldDFoV", "m_worldHFoV",
    "m_worldVFoV", "m_irOneEyeWidth", "m_irOneEyeHeight", "m_irFPS", "m_irFoV",
    "m_worldCameraCropType",
)


def camera_para_to_dict(para: AiotCameraPara) -> dict:
    d = {name: int(getattr(para, name)) for name in _PARA_FIELDS}
    d["cropName"] = WorldCameraCropType.NAMES.get(d["m_worldCameraCropType"], "?")
    return d


def dict_to_camera_para(data: dict) -> AiotCameraPara:
    para = AiotCameraPara()
    for name in _PARA_FIELDS:
        if name in data:
            setattr(para, name, int(data[name]))
    return para


def clone_camera_para(para: AiotCameraPara) -> AiotCameraPara:
    return dict_to_camera_para(camera_para_to_dict(para))


def dev_info_to_dict(info: GlassDevInfoDisc) -> dict:
    name = bytes(info.devName).split(b"\x00", 1)[0].decode("utf-8", "replace")
    return {
        "devName": name,
        "vid_leftEye": info.m_vid_leftEye,
        "pid_leftEye": info.m_pid_leftEye,
        "vid_rightEye": info.m_vid_rightEye,
        "pid_rightEye": info.m_pid_rightEye,
        "vid_world": info.m_vid_world,
        "pid_world": info.m_pid_world,
        "disk_leftEye": info.androidFileDiscLeftEye,
        "disk_rightEye": info.androidFileDiscRightEye,
        "disk_world": info.androidFileDiscWorld,
    }


def device_kind(info: GlassDevInfoDisc) -> str | None:
    """按 PID 判断设备型号。枚举回来的 devName 在 C 实现里写错位，这里不用它。"""
    if info.m_pid_leftEye == PID_AIOTGLASS_LEFT or info.m_pid_rightEye == PID_AIOTGLASS_RIGHT:
        return "aiotGlass"
    if info.m_pid_leftEye == PID_ET28_LEFT or info.m_pid_rightEye == PID_ET28_RIGHT:
        return "et28"
    return None


def _gaze_to_dict(g: AiotGazeTrackerGaze) -> dict:
    return {
        "valid": bool(g.valid),
        "worldPoint": (g.worldPoint.x, g.worldPoint.y),
        "corneaCenter": (g.corneaCenter.x, g.corneaCenter.y, g.corneaCenter.z),
        "gazeDirection": (g.gazeDirection.x, g.gazeDirection.y, g.gazeDirection.z),
    }


def _pupil_to_dict(p: AiotGazeTrackerPupil) -> dict:
    return {
        "valid2d": bool(p.pupil2d.valid),
        "center2d": (p.pupil2d.center.x, p.pupil2d.center.y),
        "width": p.pupil2d.width,
        "height": p.pupil2d.height,
        "angle": p.pupil2d.angle,
        "valid3d": bool(p.pupil3d.valid),
        "center3d": (p.pupil3d.center.x, p.pupil3d.center.y, p.pupil3d.center.z),
        "diameter": p.pupil3d.diameter,
    }


def _eyelid_to_dict(e: AiotGazeTrackerEyelid) -> dict:
    return {
        "valid": bool(e.valid),
        "contour": [(e.contour[i].x, e.contour[i].y) for i in range(24)],
    }


def _blink_to_dict(b: AiotGazeTrackerblink) -> dict:
    return {
        "blinkDetected": bool(b.blinkDetected),
        "startTimeStamp": b.blinkTimeRange.startTimeStamp,
        "endTimeStamp": b.blinkTimeRange.endTimeStamp,
        "eyelidOpenDegree": int(b.eyelidOpenDegree),
    }


def _stamped_point_to_dict(p: AiotGazeTrackerStampedPoint) -> dict:
    return {
        "valid": bool(p.valid),
        "point": (p.point.x, p.point.y),
        "timeStamp": int(p.timeStamp),
    }


def _gaze_event_to_dict(e: AiotGazeTrackerGazeEvent) -> dict:
    return {
        "fixation": {
            "valid": bool(e.fixation.valid),
            "start": _stamped_point_to_dict(e.fixation.start),
            "end": _stamped_point_to_dict(e.fixation.end),
            "centroid": (e.fixation.centroid.x, e.fixation.centroid.y),
            "dispersion": e.fixation.dispersion,
        },
        "saccade": {
            "valid": bool(e.saccade.valid),
            "start": _stamped_point_to_dict(e.saccade.start),
            "end": _stamped_point_to_dict(e.saccade.end),
            "amplitude": e.saccade.amplitude,
            "peakVelocity": e.saccade.peakVelocity,
            "meanVelocity": e.saccade.meanVelocity,
            "amplitudeDeg": e.saccade.amplitudeDeg,
            "peakVelocityDeg": e.saccade.peakVelocityDeg,
            "meanVelocityDeg": e.saccade.meanVelocityDeg,
        },
        "invalid": {
            "valid": bool(e.invalid.valid),
            "startTimeStamp": int(e.invalid.start_end.startTimeStamp),
            "endTimeStamp": int(e.invalid.start_end.endTimeStamp),
        },
    }


def _one_eye_to_dict(o: AiotGazeTrackerPredictOutputOneEye) -> dict:
    return {
        "timeStamp": int(o.timeStamp),
        "pupil": _pupil_to_dict(o.Pupil),
        "eyelid": _eyelid_to_dict(o.Eyelid),
        "gaze": _gaze_to_dict(o.Gaze),
        "blink": _blink_to_dict(o.Blink),
    }


def predict_output_to_dict(output: AiotGazeTrackerPredictOutput) -> dict:
    d = {
        "left": _one_eye_to_dict(output.leftPreDict),
        "right": _one_eye_to_dict(output.rightPreDict),
        "merge": _gaze_to_dict(output.mergeGaze),
        "gazeEvent": _gaze_event_to_dict(output.gazeEvent),
    }
    d["timeStamp"] = d["left"]["timeStamp"]
    return d


def calib_bias_to_dict(bias: AiotGazeTrackerCalibBias) -> dict:
    """展开校准偏差。

    算法层 ``GazeTracker3dEt28::GetCalibrateBias`` 返回 **world 图像素** 偏差；
    质量分级（Perfect/Common/Bad）与 ``Score`` 完全由 C 侧
    ``aiotGlass_getCalibBias`` 计算（含 1600 宽基准折算与 0~100 钳位）。
    Python 只做结构展开，不再自行分级或重算分数，保证输出与 C 完全一致。
    """
    n = min(int(bias.numOfCalibrate), MAX_CALIB_POINTS)
    points = []
    for i in range(n):
        x, y = float(bias.Bias[i].x), float(bias.Bias[i].y)
        status = int(bias.cablicStatus[i])
        points.append({
            "bias": (x, y),
            "biasAbs": (abs(x), abs(y)),
            "status": status,                                  # C 侧分级
            "statusName": CablicStatus.NAMES.get(status, "?"),
            "score": int(bias.Score[i]),                       # C 侧分数（0~100）
        })
    return {"numOfCalibrate": n, "points": points}


# ---------------------------------------------------------------------------
# 布局校验（MSVC 2022 x64 实测值）
# ---------------------------------------------------------------------------

EXPECTED_SIZES = {
    "AiotGzTrackerPoint2d": 8,
    "AiotGzTrackerVec3": 12,
    "AiotGazeTrackerPupil2d": 24,
    "AiotGazeTrackerPupil3d": 20,
    "AiotGazeTrackerPupil": 44,
    "AiotGazeTrackerEyelid": 196,
    "AiotGazeTrackerGaze": 36,
    "AiotGazeTrackerTimeRange": 16,
    "AiotGazeTrackerblink": 32,
    "AiotGazeTrackerPredictOutputOneEye": 320,
    "AiotGazeTrackerStampedPoint": 24,
    "AiotGazeTrackerFixationEvent": 72,
    "AiotGazeTrackerSaccadeEvent": 104,
    "AiotGazeTrackerInvalidEvent": 24,
    "AiotGazeTrackerGazeEvent": 200,
    "AiotGazeTrackerPredictOutput": 880,
    "AiotRoiRect": 16,
    "AiotGazeTrackerCalibBias": 404,
    "GlassDevInfoDisc": 152,
    "AiotCameraPara": 44,
}

EXPECTED_OFFSETS = {
    ("GlassDevInfoDisc", "devName"): 0,
    ("GlassDevInfoDisc", "m_vid_leftEye"): 128,
    ("GlassDevInfoDisc", "m_pid_leftEye"): 130,
    ("GlassDevInfoDisc", "androidFileDiscLeftEye"): 140,
    ("AiotCameraPara", "m_irOneEyeWidth"): 24,
    ("AiotCameraPara", "m_worldCameraCropType"): 40,
    ("AiotGazeTrackerPredictOutputOneEye", "Pupil"): 8,
    ("AiotGazeTrackerPredictOutputOneEye", "Eyelid"): 52,
    ("AiotGazeTrackerPredictOutputOneEye", "Gaze"): 248,
    ("AiotGazeTrackerPredictOutputOneEye", "Blink"): 288,
    ("AiotGazeTrackerPredictOutput", "mergeGaze"): 640,
    ("AiotGazeTrackerPredictOutput", "gazeEvent"): 680,
    ("AiotGazeTrackerStampedPoint", "point"): 4,
    ("AiotGazeTrackerStampedPoint", "timeStamp"): 16,
    ("AiotGazeTrackerFixationEvent", "start"): 8,
    ("AiotGazeTrackerFixationEvent", "end"): 32,
    ("AiotGazeTrackerFixationEvent", "centroid"): 56,
    ("AiotGazeTrackerFixationEvent", "dispersion"): 64,
    ("AiotGazeTrackerSaccadeEvent", "start"): 8,
    ("AiotGazeTrackerSaccadeEvent", "end"): 32,
    ("AiotGazeTrackerSaccadeEvent", "amplitude"): 56,
    ("AiotGazeTrackerSaccadeEvent", "meanVelocityDeg"): 96,
    ("AiotGazeTrackerInvalidEvent", "start_end"): 8,
    ("AiotGazeTrackerGazeEvent", "fixation"): 0,
    ("AiotGazeTrackerGazeEvent", "saccade"): 72,
    ("AiotGazeTrackerGazeEvent", "invalid"): 176,
    ("AiotGazeTrackerCalibBias", "Bias"): 4,
    ("AiotGazeTrackerCalibBias", "cablicStatus"): 204,
    ("AiotGazeTrackerCalibBias", "Score"): 304,
}


def structure_sizes() -> dict:
    g = globals()
    return {name: ctypes.sizeof(g[name]) for name in EXPECTED_SIZES}


def field_offsets() -> dict:
    g = globals()
    return {(tn, fn): getattr(g[tn], fn).offset for tn, fn in EXPECTED_OFFSETS}


def check_layout() -> list[str]:
    """返回布局偏差列表；空列表表示与 C 侧完全一致。"""
    problems: list[str] = []
    for name, expect in EXPECTED_SIZES.items():
        got = ctypes.sizeof(globals()[name])
        if got != expect:
            problems.append(f"sizeof({name}) = {got}, 期望 {expect}")
    for (tn, fn), expect in EXPECTED_OFFSETS.items():
        got = getattr(globals()[tn], fn).offset
        if got != expect:
            problems.append(f"offsetof({tn},{fn}) = {got}, 期望 {expect}")
    return problems


if __name__ == "__main__":
    sizes = structure_sizes()
    for k, v in sizes.items():
        print(f"sizeof {k:38s} {v:4d}")
    print("offsets:")
    for (tn, fn), v in field_offsets().items():
        print(f"  {tn}.{fn:28s} {v:4d}")
    bad = check_layout()
    print("LAYOUT OK" if not bad else "LAYOUT MISMATCH:\n  " + "\n  ".join(bad))
