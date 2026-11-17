"""aiotGlass native device lifecycle for the ET28."""

import ctypes as C
from ctypes import wintypes as W
import logging
import re
import time

from ...domain.contracts import EyeTrackingError
from .vendor import aiot_dll as b


def _check(code, operation):
    if code != 0:
        raise EyeTrackingError(f'{operation}: vendor error {code}')


# Windows needs a few seconds after the glasses are plugged in before their
# cameras are listed; opening the device waits this long before reporting.
CAMERA_WAIT_S = 5
CAMERA_POLL_S = .5


def missing_et28_cameras():
    """Names of the ET28 cameras Windows does not list as present (empty when all are)."""
    # This vendor build can fault in native enumeration with no device attached.
    cfg = C.WinDLL('cfgmgr32.dll', winmode=0x800)
    size = cfg.CM_Get_Device_ID_List_SizeW
    size.argtypes = [C.POINTER(W.ULONG), W.LPCWSTR, W.ULONG]
    read = cfg.CM_Get_Device_ID_ListW
    read.argtypes = [W.LPCWSTR, W.LPWSTR, W.ULONG, W.ULONG]
    present = 0x100  # CM_GETIDLIST_FILTER_PRESENT
    for _ in range(3):
        length = W.ULONG()
        if size(C.byref(length), None, present) != 0 or not 0 < length.value <= 1024 * 1024:
            break
        ids = C.create_unicode_buffer(length.value)
        result = read(None, ids, length.value, present)
        if result == 0:
            devices = set(re.findall(r'(?i)(?:^|\x00)USB\\(VID_[0-9A-F]{4}&PID_[0-9A-F]{4})(?=[&\\])', ids[:].upper()))
            pids = {int(device[-4:], 16) for device in devices}
            missing = [name for name, found in (
                ('场景', f'VID_{b.VID_ET28_WORLD:04X}&PID_{b.PID_ET28_WORLD:04X}' in devices),
                ('左眼', b.PID_ET28_LEFT in pids), ('右眼', b.PID_ET28_RIGHT in pids)) if not found]
            return missing
        if result != 0x1A:  # CR_BUFFER_SMALL: device list changed between calls.
            break
    raise EyeTrackingError('无法读取 Windows 的 USB 设备列表')


def present_et28_cameras():
    return not missing_et28_cameras()


def wait_for_et28_cameras(timeout_s=CAMERA_WAIT_S, poll_s=CAMERA_POLL_S):
    """Wait until all three cameras are listed; native enumeration must not run before."""
    deadline = time.monotonic() + timeout_s
    started = time.monotonic()
    while True:
        if present_et28_cameras():
            if time.monotonic() - started > poll_s:
                logging.info('huahong.et28 cameras_ready waited_s=%.1f', time.monotonic() - started)
            return
        if time.monotonic() >= deadline:
            missing = missing_et28_cameras() or ['场景、左眼、右眼']
            logging.warning('huahong.et28 cameras_missing missing=%s waited_s=%.1f', missing, timeout_s)
            raise EyeTrackingError(f"ET28 未找到{'、'.join(missing)}摄像头（已等待 {timeout_s} 秒）；"
                                   "需要场景、左眼、右眼三个摄像头都已连接")
        time.sleep(poll_s)


class AiotET28:
    def __init__(self, dll_dir):
        self.lib = b.load_library(str(dll_dir), quiet=True)
        self.handle = None
        self.callbacks = ()
        self.algorithm_open = False
        self.camera_started = False

    def open(self, on_disconnect):
        wait_for_et28_cameras()
        devices, count = (b.GlassDevInfoDisc * 16)(), C.c_uint32()
        try:
            result = self.lib.getAiotGlassDevicesList(devices, len(devices), C.byref(count))
        except OSError as exc:
            raise EyeTrackingError(f'aiotGlass failed while enumerating ET28 cameras: {exc}') from exc
        _check(result, 'getAiotGlassDevicesList')
        if count.value > len(devices):
            raise EyeTrackingError('Invalid aiotGlass device count')
        matches = [device for device in devices[:count.value] if (
            device.m_pid_leftEye, device.m_pid_rightEye, device.m_vid_world, device.m_pid_world
        ) == (b.PID_ET28_LEFT, b.PID_ET28_RIGHT, b.VID_ET28_WORLD, b.PID_ET28_WORLD)]
        if len(matches) != 1:
            raise EyeTrackingError(f'Expected one ET28 with all three USB cameras; found {len(matches)}')
        device = matches[0]
        info = b.GlassDevInfoDisc()
        for field in ('m_vid_leftEye', 'm_pid_leftEye', 'm_vid_rightEye', 'm_pid_rightEye', 'm_vid_world', 'm_pid_world'):
            setattr(info, field, getattr(device, field))
        info.androidFileDiscLeftEye = info.androidFileDiscRightEye = info.androidFileDiscWorld = -1
        self.handle = self.lib.createAiotGlassDevice(C.byref(info))
        if not self.handle:
            raise EyeTrackingError('Could not create the ET28 device handle')
        _check(self.lib.aiotGlass_device_init(self.handle), 'device_init')
        self.callbacks = (b.DeviceStatusCallback(lambda _: None), b.DeviceStatusCallback(on_disconnect))
        self.lib.aiotGlass_SetDeviceStatus_Callback(*self.callbacks, None)
        logging.info('huahong.et28 runtime=aiot pids=%04x/%04x/%04x',
                     info.m_pid_leftEye, info.m_pid_rightEye, info.m_pid_world)

    def versions(self, include_algorithm=False):
        queries = {'sdk': self.lib.aiotGlass_getSdkVersion}
        if include_algorithm:
            queries.update(algorithm=self.lib.aiotGlass_getGzAlgVersion, firmware=self.lib.aiotGlass_getFirmWareVersion)
        return {name: (query(self.handle) or b'').decode('utf-8', errors='replace') for name, query in queries.items()}

    def configure_camera(self, profile):
        params, count = (b.AiotCameraPara * 16)(), C.c_uint32()
        _check(self.lib.aiotGlass_getCamera_para(self.handle, params, len(params), C.byref(count)), 'getCamera_para')
        if not 0 < count.value <= len(params):
            raise EyeTrackingError('Invalid aiotGlass camera parameter count')
        candidates = params[:count.value]
        logging.info('huahong.et28 camera_candidates=%s', [b.camera_para_to_dict(p) for p in candidates])
        match = next((p for p in candidates
                      if (p.m_worldWidth, p.m_worldHeight, p.m_worldCameraCropType) == profile), None)
        if match is None:
            raise EyeTrackingError('ET28 requires 1920x1080 with center crop (crop_type=1); device does not offer this profile')
        _check(self.lib.aiotGlass_setCamera_para(self.handle, C.byref(match)), 'setCamera_para')
        logging.info('huahong.et28 camera_parameters=%s', b.camera_para_to_dict(match))
        brightness = self.lib.aiotGlass_setIrLedBrightness(self.handle, 7)
        logging.info('huahong.et28 ir_led brightness=7 result=%s', brightness)
        _check(brightness, 'setIrLedBrightness')
        return match

    def start_camera(self, world, left_eye, right_eye, gaze):
        callbacks = (b.CameraCallback(world), b.CameraCallback(left_eye), b.CameraCallback(right_eye), b.TrackInfoCb(gaze))
        self.callbacks += callbacks
        registers = (self.lib.aiotGlass_registerWorldCameraCb, self.lib.aiotGlass_registerLeftEyeCameraCb,
                     self.lib.aiotGlass_registerRightEyeCameraCb, self.lib.aiotGlass_registerTrackerOutputCb)
        for register, callback in zip(registers, callbacks):
            register(self.handle, callback, None)
        # The new DLL requires an open algorithm before the cameras can stream.
        self.init_tracker(5)
        self.camera_started = True
        _check(self.lib.aiotGlass_startCamera(self.handle), 'startCamera')

    def start_calibration(self, points):
        _check(self.lib.aiotGlass_InitCalibration(self.handle, points, b.EyeType.TWOEYE), 'InitCalibration')

    def calibration_point(self, x, y, timeout):
        point = b.AiotGzTrackerPoint2d(x, y)
        _check(self.lib.aiotGlass_startCalibration(self.handle, C.byref(point), timeout), 'calibration_point')

    def stop_calibration(self):
        self.lib.aiotGlass_stopCalibration(self.handle)

    def calibration_bias(self):
        left, right = b.AiotGazeTrackerCalibBias(), b.AiotGazeTrackerCalibBias()
        _check(self.lib.aiotGlass_getCalibBias(self.handle, C.byref(left), C.byref(right)), 'getCalibBias')
        return left, right

    def feature(self):
        length = C.c_uint32()
        self.lib.aiotGlass_getFeatureLen(self.handle, C.byref(length))
        if not 0 < length.value <= 1024 * 1024:
            raise EyeTrackingError('Invalid calibration feature length')
        data, written = (C.c_uint8 * length.value)(), C.c_uint32(length.value)
        _check(self.lib.aiotGlass_SaveCalibrationDataBin(self.handle, data, C.byref(written)), 'SaveCalibrationDataBin')
        if not 0 < written.value <= length.value:
            raise EyeTrackingError('Invalid calibration bytes written')
        return bytes(data[:written.value])

    def init_tracker(self, points):
        self.algorithm_open = True
        _check(self.lib.aiotGlass_initTracker(self.handle, points), 'initTracker')

    def load_feature(self, feature):
        data = (C.c_uint8 * len(feature)).from_buffer_copy(feature)
        _check(self.lib.aiotGlass_LoadCalibrationDataBin(self.handle, data, len(data)), 'LoadCalibrationDataBin')

    def start_tracking(self, smooth):
        _check(self.lib.aiotGlass_startTracker(self.handle, smooth), 'startTracker')

    def stop_tracking(self):
        self.lib.aiotGlass_stopTracker(self.handle)

    def close(self):
        if not self.handle:
            return
        if self.algorithm_open:
            self.stop_calibration()
        if self.camera_started:
            self.lib.aiotGlass_stopCamera(self.handle)
        if self.algorithm_open:
            self.lib.aiotGlass_deinitTracker(self.handle)
        _check(self.lib.aiotGlass_device_deinit(self.handle), 'device_deinit')
        self.handle = None
