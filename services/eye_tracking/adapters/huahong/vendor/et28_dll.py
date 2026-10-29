# -*- coding: utf-8 -*-
"""ET28 眼动追踪 SDK —— ctypes 绑定层。

本模块是 et28_interface.h 的逐字段翻译：结构体布局、枚举取值、函数原型与回调
签名都必须与 C 头文件保持一致。它刻意不依赖 numpy / cv2，以便在只有解释器的
环境里单独做「DLL 能否加载、结构体尺寸是否对齐」的自检。

对应关系：
    et28_interface.hpp (C)          ->  本模块
    struct et28_CameraPara          ->  et28_CameraPara
    enum et28_EyeType               ->  EyeType
    typedef void(*CameraCallback)   ->  CameraCallback
    DLL_EXPORT int32_t et28_xxx()   ->  lib.et28_xxx
"""

from __future__ import annotations

import ctypes
import os
import sys

# --------------------------------------------------------------------------
# 结构体定义（字段顺序与 et28_interface.hpp 严格一致，不得调换）
# --------------------------------------------------------------------------


class et28_GzTrackerPoint2d(ctypes.Structure):
    """二维坐标。"""

    _fields_ = [
        ("x", ctypes.c_float),
        ("y", ctypes.c_float),
    ]

    def __repr__(self) -> str:
        return "Point2d(%.4f, %.4f)" % (self.x, self.y)


class et28_GzTrackerVec3(ctypes.Structure):
    """三维坐标。"""

    _fields_ = [
        ("x", ctypes.c_float),
        ("y", ctypes.c_float),
        ("z", ctypes.c_float),
    ]

    def __repr__(self) -> str:
        return "Vec3(%.4f, %.4f, %.4f)" % (self.x, self.y, self.z)


class et28_GzTrackerLine3d(ctypes.Structure):
    """三维直线：角膜中心 + 方向。"""

    _fields_ = [
        ("corneaCenter", et28_GzTrackerVec3),
        ("direction", et28_GzTrackerVec3),
    ]


class et28_GzTrackerEyeInfo(ctypes.Structure):
    """单眼瞳孔信息。"""

    _fields_ = [
        ("pupilCenter", et28_GzTrackerPoint2d),
        ("pupilWidth", ctypes.c_float),
        ("pupilHeight", ctypes.c_float),
        ("pupilAngle", ctypes.c_float),
    ]


class et28_GzTrackerPredictOutput(ctypes.Structure):
    """追踪结果输出。

    注意：该结构在 C 侧是追踪线程的栈上局部变量，回调返回后即失效，
    Python 侧必须在回调内部立即把字段读出来（见 et28_interface 的拷贝逻辑）。
    """

    _fields_ = [
        ("haveEyeInfoLeft", ctypes.c_bool),
        ("eyeInfoLeft", et28_GzTrackerEyeInfo),
        ("haveGazeInfoLeft", ctypes.c_bool),
        ("sightLineLeft", et28_GzTrackerLine3d),
        ("worldPointLeft", et28_GzTrackerPoint2d),
        ("haveEyeInfoRight", ctypes.c_bool),
        ("eyeInfoRight", et28_GzTrackerEyeInfo),
        ("haveGazeInfoRight", ctypes.c_bool),
        ("sightLineRight", et28_GzTrackerLine3d),
        ("worldPointRight", et28_GzTrackerPoint2d),
    ]


class et28_RoiRect(ctypes.Structure):
    """感兴趣区域。"""

    _fields_ = [
        ("left", ctypes.c_int),
        ("top", ctypes.c_int),
        ("width", ctypes.c_int),
        ("height", ctypes.c_int),
    ]


class et28_CameraPara(ctypes.Structure):
    """相机分辨率/帧率参数。

    末尾的 m_worldCameraCropType 在 C 侧是裸 enum，按 int32 处理。
    """

    _fields_ = [
        ("m_worldWidth", ctypes.c_int32),
        ("m_worldHeight", ctypes.c_int32),
        ("m_worldFPS", ctypes.c_int32),
        ("m_worldDFoV", ctypes.c_int32),
        ("m_worldHFoV", ctypes.c_int32),
        ("m_worldVFoV", ctypes.c_int32),
        ("m_irWidth", ctypes.c_int32),
        ("m_irHeight", ctypes.c_int32),
        ("m_irOneEyeWidth", ctypes.c_int32),
        ("m_irOneEyeHeight", ctypes.c_int32),
        ("m_irFPS", ctypes.c_int32),
        ("m_irFoV", ctypes.c_int32),
        ("m_worldCameraCropType", ctypes.c_int32),
    ]


MAX_CALIB_POINTS = 25


class et28_GazeTrackerCalibBias(ctypes.Structure):
    """校准偏差，数组长度固定为 25（对齐 C 侧的 [25]）。"""

    _fields_ = [
        ("numOfCalibrate", ctypes.c_uint32),
        ("Bias", et28_GzTrackerPoint2d * MAX_CALIB_POINTS),
        ("cablicStatus", ctypes.c_int * MAX_CALIB_POINTS),
        ("Score", ctypes.c_uint32 * MAX_CALIB_POINTS),
    ]


# --------------------------------------------------------------------------
# 枚举取值
# --------------------------------------------------------------------------


class WorldCameraCropType:
    Normal = 0
    CENTERCROP = 1
    LOWERCROP = 2
    UNKNOWN = 3


class GazeCablicStatus:
    GazeCablicPerfect = 0
    GazeCablicCommon = 1
    GazeCablicBad = 2


class EyeType:
    ET28_TWOEYE = 0
    ET28_LEFTEYE = 1
    ET28_RIGHTEYE = 2


class Angle:
    angle_0 = 0
    angle_90 = 90
    angle_180 = 180
    angle_270 = 270


class ReqCode:
    """注意取值顺序：GET_CURR=0, GET_MAX=1, GET_MIN=2。"""

    GET_CURR = 0
    GET_MAX = 1
    GET_MIN = 2


class CameraType:
    IR_LEFT = 0
    IR_RIGHT = 1
    WORLD = 2


# --------------------------------------------------------------------------
# 回调类型
# --------------------------------------------------------------------------

CameraCallbackProto = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32)
TrackInfoCbProto = ctypes.CFUNCTYPE(
    None, ctypes.c_void_p, ctypes.POINTER(et28_GzTrackerPredictOutput)
)
DeviceStatusCallbackProto = ctypes.CFUNCTYPE(None, ctypes.c_void_p)

# 供上层沿用的别名，避免调用方再去关心具体签名
CameraCallback = CameraCallbackProto
TrackInfoCb = TrackInfoCbProto
DeviceStatusCallback = DeviceStatusCallbackProto


# --------------------------------------------------------------------------
# DLL 加载
# --------------------------------------------------------------------------

DLL_NAME = "et28_interface.dll"

#: 加载成功后记录实际使用的 dll 路径，便于排查「装错版本」这类问题
LOADED_FROM: str | None = None

_lib: ctypes.CDLL | None = None
_dll_dir_handles: list = []


def _candidate_dirs() -> list[str]:
    """按优先级给出搜索目录：环境变量 -> 包内 bin -> 脚本目录 -> SDK 发布包。"""
    here = os.path.dirname(os.path.abspath(__file__))
    dirs: list[str] = []

    env_dir = os.environ.get("ET28_DLL_DIR")
    if env_dir:
        dirs.append(env_dir)

    dirs.append(os.path.join(here, "bin"))
    dirs.append(here)

    # 开发机上的 SDK 发布包位置，仅作兜底
    for rel in (
        r"D:\x86\ET28H\et28h_release_20260820_v1.1.3\bin_win64",
        r"..\et28h_release_20260820_v1.1.3\bin_win64",
    ):
        dirs.append(rel if os.path.isabs(rel) else os.path.normpath(os.path.join(here, rel)))

    return dirs


def _register_dll_dir(path: str) -> None:
    """把目录注册进 DLL 搜索路径。

    Python 3.8+ 在 Windows 上不再用 PATH 解析扩展模块的依赖，必须显式
    add_dll_directory，否则 ncnn.dll / uniformLibUvc.dll 这类传递依赖
    会因为找不到而让 LoadLibrary 直接失败。
    """
    if not os.path.isdir(path):
        return
    if hasattr(os, "add_dll_directory"):
        try:
            _dll_dir_handles.append(os.add_dll_directory(path))
        except OSError:
            pass
    # 老式兜底：同时塞进 PATH，覆盖部分第三方库自带的 LoadLibrary 调用
    os.environ["PATH"] = path + os.pathsep + os.environ.get("PATH", "")


def _bind_functions(lib: ctypes.CDLL) -> None:
    """显式声明每个导出的参数与返回类型。

    这一步不能省：ctypes 默认把参数当 c_int、返回值当 int，uint32 指针、
    float 指针、结构体指针都会因此传错。
    """

    def proto(name: str, restype, argtypes) -> None:
        fn = getattr(lib, name, None)
        if fn is None:
            # 允许头文件与 DLL 版本存在轻微差异，但要让使用者看得见
            print("[et28_dll] 警告：DLL 中缺少导出 %s" % name, file=sys.stderr)
            return
        fn.restype = restype
        fn.argtypes = argtypes

    C = ctypes
    i32, u32, u8, i16, u16 = C.c_int32, C.c_uint32, C.c_uint8, C.c_int16, C.c_uint16
    vp, cstr = C.c_void_p, C.c_char_p

    # --- 设备生命周期 ---
    proto("et28_device_init", i32, [])
    proto("et28_device_deinit", i32, [])
    proto("et28_device_connect", i32, [])
    proto("et28_device_disconnect", i32, [])
    proto("et28_setAndroid_file", None, [C.c_int, C.c_int, C.c_int])
    proto(
        "et28_registerDeviceStatusCallback",
        None,
        [DeviceStatusCallbackProto, DeviceStatusCallbackProto, vp],
    )

    # --- 版本 ---
    proto("et28_getGzSdkVersion", cstr, [])
    proto("et28_getGzAlgVersion", cstr, [])
    proto("et28_getFirmWareVersion", cstr, [])

    # --- 相机参数与开关 ---
    proto("et28_getCamera_para", i32, [C.POINTER(et28_CameraPara), u32, C.POINTER(u32)])
    proto("et28_setCamera_para", i32, [C.POINTER(et28_CameraPara)])
    proto("et28_startCamera", i32, [])
    proto("et28_stopCamera", None, [])

    # --- 取帧（不使用回调时的替代路径）---
    proto("et28_GetWorldCameraFrame", i32, [vp])
    proto("et28_GetEyeCameraFrame", i32, [vp])
    proto("et28_trackerOutput", i32, [C.POINTER(et28_GzTrackerPredictOutput)])

    # --- 校准 ---
    proto("et28_InitCalibration", i32, [u32, C.c_int])
    proto("et28_DeinitCalibration", None, [])
    proto("et28_reConfigCalibration", i32, [u32, u32])
    proto("et28_performOnePointCalibration", i32, [C.POINTER(et28_GzTrackerPoint2d), u32])
    proto("et28_MergeLRCalibration", i32, [])
    proto("et28_CalibrationStop", None, [])
    proto("et28_getCalibBias", i32, [C.POINTER(et28_GazeTrackerCalibBias)] * 2)
    proto("et28_SaveCalibrationData", i32, [cstr])
    proto("et28_LoadCalibrationData", i32, [cstr])
    proto("et28_SaveCalibrationDataBin", i32, [C.POINTER(u8), C.POINTER(u32)])
    proto("et28_LoadCalibrationDataBin", i32, [C.POINTER(u8), u32])
    proto("et28_getFeatureLen", None, [C.POINTER(u32)])

    # --- 追踪 ---
    proto("et28_initTracker", i32, [u32])
    proto("et28_deinitTracker", None, [])
    proto("et28_startTracker", i32, [u32])
    proto("et28_stopTracker", i32, [])

    # --- 回调注册与图像旋转 ---
    proto("et28_registerWorldCameraCb", None, [CameraCallbackProto, vp])
    proto("et28_registerEyeCameraCb", None, [CameraCallbackProto, vp])
    proto("et28_registerTrackerOutputCb", None, [TrackInfoCbProto, vp])
    proto("et28_rotateAngle", None, [C.c_int, C.c_int])

    # --- 亮度/对比度/红外灯 ---
    proto("et28_getCameraBright", i32, [C.c_int, C.POINTER(i16), C.c_int])
    proto("et28_setCameraBright", i32, [C.c_int, i16])
    proto("et28_getCameraContrast", i32, [C.c_int, C.POINTER(u16), C.c_int])
    proto("et28_setCameraContrast", i32, [C.c_int, u16])
    proto("et28_setIrLedBrightness", i32, [u8])


def load_library(dll_dir: str | None = None, *, quiet: bool = False) -> ctypes.CDLL:
    """加载 et28_interface.dll 并绑定全部原型（幂等）。

    dll_dir 显式给出时只在该目录下查找，便于切换不同版本的 SDK。
    """
    global _lib, LOADED_FROM

    if _lib is not None and dll_dir is None:
        return _lib

    search_dirs = [dll_dir] if dll_dir else _candidate_dirs()
    for directory in search_dirs:
        _register_dll_dir(os.path.abspath(directory))

    errors: list[str] = []
    for directory in search_dirs:
        candidate = os.path.join(os.path.abspath(directory), DLL_NAME)
        if not os.path.isfile(candidate):
            errors.append("未找到文件: %s" % candidate)
            continue
        try:
            lib = ctypes.CDLL(candidate)
        except OSError as exc:
            errors.append("加载失败 %s: %s" % (candidate, exc))
            continue
        _bind_functions(lib)
        _lib = lib
        LOADED_FROM = candidate
        if not quiet:
            print("[et28_dll] 已加载 %s" % candidate)
        return lib

    # 最后再试一次按名字加载（依赖系统 PATH）
    try:
        lib = ctypes.CDLL(DLL_NAME)
        _bind_functions(lib)
        _lib = lib
        LOADED_FROM = DLL_NAME
        if not quiet:
            print("[et28_dll] 已从系统搜索路径加载 %s" % DLL_NAME)
        return lib
    except OSError as exc:
        errors.append("按名称加载失败: %s" % exc)

    raise OSError(
        "无法加载 %s。请确认：\n"
        "  1) Python 为 64 位（本 DLL 是 x64）；\n"
        "  2) bin/ 目录下包含 et28_interface.dll 及其全部依赖；\n"
        "  3) 或设置环境变量 ET28_DLL_DIR 指向 SDK 的 bin_win64。\n"
        "尝试记录：\n  - %s" % (DLL_NAME, "\n  - ".join(errors))
    )


def library() -> ctypes.CDLL:
    """取已加载的库；未加载时自动加载。"""
    return load_library()


# --------------------------------------------------------------------------
# 转换辅助
# --------------------------------------------------------------------------

_PARA_FIELDS = (
    "m_worldWidth",
    "m_worldHeight",
    "m_worldFPS",
    "m_worldDFoV",
    "m_worldHFoV",
    "m_worldVFoV",
    "m_irWidth",
    "m_irHeight",
    "m_irOneEyeWidth",
    "m_irOneEyeHeight",
    "m_irFPS",
    "m_irFoV",
    "m_worldCameraCropType",
)


def camera_para_to_dict(para: et28_CameraPara) -> dict:
    """et28_CameraPara -> dict（字段名保持 C 风格，便于与日志/头文件对照）。"""
    return {name: getattr(para, name) for name in _PARA_FIELDS}


def dict_to_camera_para(data: dict) -> et28_CameraPara:
    """dict -> et28_CameraPara。缺失字段沿用 C 结构体的默认 0。"""
    para = et28_CameraPara()
    for name in _PARA_FIELDS:
        if name in data:
            setattr(para, name, int(data[name]))
    return para


def clone_camera_para(para: et28_CameraPara) -> et28_CameraPara:
    """深拷贝一份参数，避免上层持有的对象被 SDK 后续调用改写。"""
    return dict_to_camera_para(camera_para_to_dict(para))


def predict_output_to_dict(output: et28_GzTrackerPredictOutput) -> dict:
    """把 C 结构体展开成纯 Python dict。

    必须在回调内部、C 栈帧仍然有效时调用。
    """
    return {
        "haveEyeInfoLeft": bool(output.haveEyeInfoLeft),
        "eyeInfoLeft": {
            "pupilCenter": {"x": output.eyeInfoLeft.pupilCenter.x,
                            "y": output.eyeInfoLeft.pupilCenter.y},
            "pupilWidth": output.eyeInfoLeft.pupilWidth,
            "pupilHeight": output.eyeInfoLeft.pupilHeight,
            "pupilAngle": output.eyeInfoLeft.pupilAngle,
        },
        "haveGazeInfoLeft": bool(output.haveGazeInfoLeft),
        "sightLineLeft": {
            "corneaCenter": {"x": output.sightLineLeft.corneaCenter.x,
                             "y": output.sightLineLeft.corneaCenter.y,
                             "z": output.sightLineLeft.corneaCenter.z},
            "direction": {"x": output.sightLineLeft.direction.x,
                          "y": output.sightLineLeft.direction.y,
                          "z": output.sightLineLeft.direction.z},
        },
        "worldPointLeft": {"x": output.worldPointLeft.x, "y": output.worldPointLeft.y},
        "haveEyeInfoRight": bool(output.haveEyeInfoRight),
        "eyeInfoRight": {
            "pupilCenter": {"x": output.eyeInfoRight.pupilCenter.x,
                            "y": output.eyeInfoRight.pupilCenter.y},
            "pupilWidth": output.eyeInfoRight.pupilWidth,
            "pupilHeight": output.eyeInfoRight.pupilHeight,
            "pupilAngle": output.eyeInfoRight.pupilAngle,
        },
        "haveGazeInfoRight": bool(output.haveGazeInfoRight),
        "sightLineRight": {
            "corneaCenter": {"x": output.sightLineRight.corneaCenter.x,
                             "y": output.sightLineRight.corneaCenter.y,
                             "z": output.sightLineRight.corneaCenter.z},
            "direction": {"x": output.sightLineRight.direction.x,
                          "y": output.sightLineRight.direction.y,
                          "z": output.sightLineRight.direction.z},
        },
        "worldPointRight": {"x": output.worldPointRight.x, "y": output.worldPointRight.y},
    }


def calib_bias_to_dict(bias: et28_GazeTrackerCalibBias) -> dict:
    """校准偏差 -> dict，数组按 numOfCalibrate 截断。"""
    count = min(int(bias.numOfCalibrate), MAX_CALIB_POINTS)
    status_name = {
        GazeCablicStatus.GazeCablicPerfect: "Perfect",
        GazeCablicStatus.GazeCablicCommon: "Common",
        GazeCablicStatus.GazeCablicBad: "Bad",
    }
    points = []
    for i in range(count):
        points.append({
            "index": i,
            "bias": {"x": bias.Bias[i].x, "y": bias.Bias[i].y},
            "status": int(bias.cablicStatus[i]),
            "statusName": status_name.get(int(bias.cablicStatus[i]), "Unknown"),
            "score": int(bias.Score[i]),
        })
    return {"numOfCalibrate": count, "points": points}


def structure_sizes() -> dict:
    """返回关键结构体尺寸，用于与 C++ 侧 sizeof 交叉验证。"""
    return {
        "et28_GzTrackerPoint2d": ctypes.sizeof(et28_GzTrackerPoint2d),
        "et28_GzTrackerVec3": ctypes.sizeof(et28_GzTrackerVec3),
        "et28_GzTrackerLine3d": ctypes.sizeof(et28_GzTrackerLine3d),
        "et28_GzTrackerEyeInfo": ctypes.sizeof(et28_GzTrackerEyeInfo),
        "et28_GzTrackerPredictOutput": ctypes.sizeof(et28_GzTrackerPredictOutput),
        "et28_RoiRect": ctypes.sizeof(et28_RoiRect),
        "et28_CameraPara": ctypes.sizeof(et28_CameraPara),
        "et28_GazeTrackerCalibBias": ctypes.sizeof(et28_GazeTrackerCalibBias),
    }


def field_offsets() -> dict:
    """关键字段偏移，用于捕捉「尺寸对但内部错位」这类隐蔽问题。"""
    return {
        "PredictOutput.sightLineLeft": et28_GzTrackerPredictOutput.sightLineLeft.offset,
        "PredictOutput.worldPointRight": et28_GzTrackerPredictOutput.worldPointRight.offset,
        "CameraPara.m_worldCameraCropType": et28_CameraPara.m_worldCameraCropType.offset,
    }


#: 期望值来自 size_probe.cpp 在 MSVC 2022 x64 下的实测输出，而非手工推算。
#: 实测命令见 build_size_probe.bat / probe_build.py。
EXPECTED_SIZES = {
    "et28_GzTrackerPoint2d": 8,
    "et28_GzTrackerVec3": 12,
    "et28_GzTrackerLine3d": 24,
    "et28_GzTrackerEyeInfo": 20,
    "et28_GzTrackerPredictOutput": 120,
    "et28_RoiRect": 16,
    "et28_CameraPara": 52,
    "et28_GazeTrackerCalibBias": 404,
}

EXPECTED_OFFSETS = {
    "PredictOutput.sightLineLeft": 28,
    "PredictOutput.worldPointRight": 112,
    "CameraPara.m_worldCameraCropType": 48,
}


if __name__ == "__main__":
    # 独立自检：只验证绑定层，不触碰设备
    print("=== ET28 ctypes 绑定自检 ===")
    sizes = structure_sizes()
    ok = True
    for name, actual in sizes.items():
        expected = EXPECTED_SIZES[name]
        flag = "OK " if actual == expected else "不匹配"
        if actual != expected:
            ok = False
        print("  %-28s sizeof=%4d  期望=%4d  %s" % (name, actual, expected, flag))

    print("  --- 字段偏移 ---")
    for name, actual in field_offsets().items():
        expected = EXPECTED_OFFSETS[name]
        flag = "OK " if actual == expected else "不匹配"
        if actual != expected:
            ok = False
        print("  %-28s offset=%4d  期望=%4d  %s" % (name, actual, expected, flag))

    try:
        lib = load_library()
    except OSError as exc:
        print("\nDLL 加载失败：\n%s" % exc)
        raise SystemExit(2)

    for fn_name, label in (
        ("et28_getGzSdkVersion", "SDK 版本"),
        ("et28_getGzAlgVersion", "算法版本"),
        ("et28_getFirmWareVersion", "固件版本"),
    ):
        fn = getattr(lib, fn_name, None)
        if fn is None:
            continue
        try:
            raw = fn()
            print("  %s: %s" % (label, raw.decode("utf-8", "replace") if raw else "(空)"))
        except Exception as exc:  # 未初始化时返回空指针是预期行为
            print("  %s: 读取失败 %s" % (label, exc))

    print("\n结构体自检：%s" % ("通过" if ok else "存在不匹配，须核对头文件"))
