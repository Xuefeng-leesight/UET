import base64
from .paths import SDKPathsMixin, _windows_short_path, _vendor_path_bytes
from .ctypes_types import SDKTypesMixin
import importlib.util
import os
import queue
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from ctypes import (
    CDLL,
    POINTER,
    byref,
    c_char_p,
    c_double,
    c_float,
    c_int,
    c_ubyte,
    c_uint,
    c_void_p,
    cast,
    pointer,
    py_object,
    string_at,
)

try:
    from ctypes import WinDLL  # type: ignore
except Exception:
    WinDLL = CDLL


def _safe_int(value, default):
    try:
        return int(str(value).strip())
    except Exception:
        return int(default)




class BaseSDKDriver(SDKPathsMixin, SDKTypesMixin):
    requires_softdog_password = True
    model_name = "base"
    runtime_suffix = Path(".")
    types_suffix = Path(".")
    types_filenames = ("_7i_types.py",)

    def __init__(self, script_path: Path, log):
        self.script_path = script_path
        self.log = log
        self.sdk = None
        self.types = None
        self.sdk_root = None
        self.config_dir = None
        self.config_ini = None
        self.types_dir = None
        self.py_status_cb = None
        self.py_image_cb = None
        self.py_gaze_cb = None
        self.py_point_process_cb = None
        self.py_point_finish_cb = None
        self.dll_directory_handles = []
        self.last_calibration_point_start_results = (None, None)
        self.last_calibration_point_cancel_results = (None, None)
        self.last_calibration_compute_results = (None, None)
        self.last_calibration_complete_result = None
        self.last_calibration_score_result = None
        self.last_calibration_data_results = (None, None)
        self.last_calibration_activation_results = (None, None)




    def _bind_common_signatures(self):
        T = self.types
        try:
            self.sdk._7i_device_connect.argtypes = [c_char_p, POINTER(T.py_7i_ukey_info_t)]
            self.sdk._7i_device_connect.restype = c_int
        except Exception:
            pass
        try:
            self.sdk._7i_device_disconnect.argtypes = []
            self.sdk._7i_device_disconnect.restype = c_int
        except Exception:
            pass
        try:
            if hasattr(self.sdk, "_7i_set_camera_state_callback") and hasattr(T, "fn_7i_camera_state_callback_t"):
                self.sdk._7i_set_camera_state_callback.argtypes = [T.fn_7i_camera_state_callback_t, py_object]
                self.sdk._7i_set_camera_state_callback.restype = c_int
        except Exception:
            pass
        try:
            self.sdk._7i_set_image_callback.argtypes = [T.fn_7i_image_callback_t, py_object]
            self.sdk._7i_set_image_callback.restype = c_int
        except Exception:
            pass
        try:
            self.sdk._7i_set_gaze_callback.argtypes = [T.fn_7i_gaze_callback_t, py_object]
            self.sdk._7i_set_gaze_callback.restype = c_int
        except Exception:
            pass
        try:
            if hasattr(self.sdk, "_7i_set_screen_size"):
                self.sdk._7i_set_screen_size.argtypes = [c_double, c_double]
                self.sdk._7i_set_screen_size.restype = c_int
        except Exception:
            pass
        try:
            if hasattr(self.sdk, "_7i_set_smooth"):
                self.sdk._7i_set_smooth.argtypes = [c_int]
                self.sdk._7i_set_smooth.restype = c_int
        except Exception:
            pass

    def load(self, status_cb, image_cb, gaze_cb, point_process_cb, point_finish_cb):
        self.find_paths()
        if self.sdk_root is None:
            raise RuntimeError("sdk_root_not_found")
        if self.types_dir is None:
            raise RuntimeError("types_dir_not_found")

        self._prepare_dll_search_path()
        dll_path = self.sdk_root / "aSeeX.dll"
        self.log("loading dll", str(dll_path))
        self.sdk = WinDLL(str(dll_path))

        types_path = self._find_types_file(self.types_dir)
        if types_path is None:
            raise RuntimeError("types_file_not_found")
        self.log("using types_file", str(types_path))
        spec = importlib.util.spec_from_file_location(f"_sdk_types_{self.model_name.lower()}", str(types_path))
        if spec is None or spec.loader is None:
            raise RuntimeError("types_spec_not_found")
        T = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(T)
        self._normalize_types_symbols(T)
        self.types = T

        self._bind_common_signatures()
        self._bind_model_signatures()

        if hasattr(T, "fn_7i_camera_state_callback_t"):
            self.py_status_cb = T.fn_7i_camera_state_callback_t(status_cb)
        else:
            self.py_status_cb = None
        self.py_image_cb = T.fn_7i_image_callback_t(image_cb)
        self.py_gaze_cb = T.fn_7i_gaze_callback_t(gaze_cb)
        self.py_point_process_cb = T.fn_7i_point_process_callback_t(point_process_cb)
        self.py_point_finish_cb = T.fn_7i_point_finish_callback_t(point_finish_cb)
        self.log("driver callbacks bound", self.model_name)

    def _bind_model_signatures(self):
        raise NotImplementedError

    def _prepare_runtime_environment(self):
        if self.sdk_root is None:
            return
        self._prepare_dll_search_path()
        # Some vendor DLLs load extra resources by relative path (e.g. ./config/*.dat).
        # Keep process cwd aligned with active SDK runtime root before start().
        try:
            os.chdir(str(self.sdk_root))
            self.log("runtime cwd set", str(self.sdk_root))
        except Exception as e:
            self.log("runtime cwd set failed", str(e))

    def _prepare_dll_search_path(self):
        if self.sdk_root is None:
            return
        sdk_root = str(self.sdk_root)
        try:
            current_path = os.environ.get("PATH", "")
            parts = [p for p in current_path.split(os.pathsep) if p]
            if sdk_root not in parts:
                os.environ["PATH"] = sdk_root + (os.pathsep + current_path if current_path else "")
                self.log("runtime PATH prepended", sdk_root)
        except Exception as e:
            self.log("runtime PATH prepend failed", str(e))
        if os.name == "nt" and hasattr(os, "add_dll_directory"):
            try:
                handle = os.add_dll_directory(sdk_root)
                self.dll_directory_handles.append(handle)
                self.log("dll directory added", sdk_root)
            except Exception as e:
                self.log("dll directory add failed", str(e))

    def preprocess_image_payload(self, eye, image_ptr, size, width, height, emit_frame=True, allow_cached_fallback=True):
        if not emit_frame:
            return b"", 0
        return string_at(image_ptr, size), int(size)

    def cleanup(self):
        # 释放 SDK DLL 句柄，强制下次 start 时重新加载 DLL。
        # 若不释放，stop_device 后 self.sdk 仍指向旧句柄，ensure_loaded 会因
        # self.sdk 非 None 而跳过 load()，复用旧 DLL 句柄 + _7i_stop 残留状态。
        # A8 的 gazepre 标定（Configs.dat）依赖「全新加载后首次设置」，复用旧
        # 句柄会导致标定无法正确重新生效，gaze 映射越界、校准失败（关闭设备后
        # 重开必现；台式机用 Pro 不依赖 gazepre 故不受影响）。
        self.sdk = None
        return

    def reset_video_decoder(self):
        return

    def set_screen_size(self, width, height):
        if self.sdk is None or not hasattr(self.sdk, "_7i_set_screen_size"):
            return 0
        return self.sdk._7i_set_screen_size(float(width), float(height))

    def set_smooth(self, smooth):
        if self.sdk is None or not hasattr(self.sdk, "_7i_set_smooth"):
            return 0
        s = max(1, min(10, int(smooth)))
        return self.sdk._7i_set_smooth(s)

    def stop_tracking(self):
        if self.sdk is None or not hasattr(self.sdk, "_7i_stop_tracking"):
            return 0
        try:
            return self.sdk._7i_stop_tracking()
        except Exception:
            return 0

    def stop_sdk(self):
        if self.sdk is None or not hasattr(self.sdk, "_7i_stop"):
            return 0
        return self.sdk._7i_stop()

    def disconnect(self):
        if self.sdk is None or not hasattr(self.sdk, "_7i_device_disconnect"):
            return 0
        return self.sdk._7i_device_disconnect()

    def start_device(self, password):
        raise NotImplementedError

    def start_calibration(self, points):
        raise NotImplementedError

    def start_calibration_point(self, pt_index, x, y, attempt=None):
        raise NotImplementedError

    def cancel_calibration(self):
        raise NotImplementedError

    def end_calibration(self):
        if self.sdk is None or not hasattr(self.sdk, "_7i_complete_calibration"):
            self.last_calibration_complete_result = 0
            return 0
        try:
            ret = self.sdk._7i_complete_calibration()
        except Exception:
            ret = -1
        self.last_calibration_complete_result = ret
        self.log("complete_calibration result", ret)
        return ret

    def complete_calibration(self):
        raise NotImplementedError

    def start_tracking(self, coe_str):
        raise NotImplementedError


class ProDriver(BaseSDKDriver):
    model_name = "Pro"
    runtime_suffix = Path("bin/windows/x64/Pro200_Release")
    types_suffix = Path("samples/Pro200/python3")
    types_filenames = ("_7i_types.py",)

    def _bind_model_signatures(self):
        T = self.types
        try:
            self.sdk._7i_start.argtypes = [c_char_p]
            self.sdk._7i_start.restype = c_int
        except Exception:
            pass
        try:
            self.sdk._7i_start_tracking.argtypes = [POINTER(T.py_7i_coefficient_t)]
            self.sdk._7i_start_tracking.restype = c_int
        except Exception:
            pass
        try:
            self.sdk._7i_start_calibration.argtypes = [c_int]
            self.sdk._7i_start_calibration.restype = c_int
        except Exception:
            pass
        try:
            self.sdk._7i_start_calibration_point.argtypes = [
                c_int,
                POINTER(T.py_7i_point_2d_t),
                T.fn_7i_point_process_callback_t,
                c_void_p,
                T.fn_7i_point_finish_callback_t,
                c_void_p,
            ]
            self.sdk._7i_start_calibration_point.restype = c_int
        except Exception:
            pass
        try:
            self.sdk._7i_cancel_calibration.argtypes = []
            self.sdk._7i_cancel_calibration.restype = c_int
        except Exception:
            pass
        try:
            self.sdk._7i_compute_calibration.argtypes = [POINTER(T.py_7i_coefficient_t)]
            self.sdk._7i_compute_calibration.restype = c_int
        except Exception:
            pass
        try:
            self.sdk._7i_complete_calibration.argtypes = []
            self.sdk._7i_complete_calibration.restype = c_int
        except Exception:
            pass
        try:
            self.sdk._7i_get_calibration_score.argtypes = [POINTER(c_float), POINTER(c_float)]
            self.sdk._7i_get_calibration_score.restype = c_int
        except Exception:
            pass

    def start_device(self, password):
        self._prepare_runtime_environment()
        if self.requires_softdog_password:
            ukey_info = self.types.py_7i_ukey_info_t()
            ret = self.sdk._7i_device_connect(password, pointer(ukey_info))
            if ret != 0:
                return ret
        ret_cam_cb = None
        if self.py_status_cb is not None and hasattr(self.sdk, "_7i_set_camera_state_callback"):
            ret_cam_cb = self.sdk._7i_set_camera_state_callback(self.py_status_cb, py_object(self))
        ret_img_cb = self.sdk._7i_set_image_callback(self.py_image_cb, py_object(self))
        ret_gaze_cb = self.sdk._7i_set_gaze_callback(self.py_gaze_cb, py_object(self))
        self.log("set callbacks", "camera", ret_cam_cb, "image", ret_img_cb, "gaze", ret_gaze_cb, "model", self.model_name)
        cfg_dir = self.config_dir if self.config_dir and self.config_dir.exists() else (self.sdk_root / "config")
        config_path = _vendor_path_bytes(cfg_dir)
        self.log("start with config path", cfg_dir, "vendor_path", _windows_short_path(cfg_dir))
        return self.sdk._7i_start(config_path)

    def start_calibration(self, points):
        return self.sdk._7i_start_calibration(points)

    def start_calibration_point(self, pt_index, x, y, attempt=None):
        pt = self.types.py_7i_point_2d_t()
        pt.x = float(x)
        pt.y = float(y)
        ret = self.sdk._7i_start_calibration_point(pt_index, pointer(pt), self.py_point_process_cb, None, self.py_point_finish_cb, None)
        self.last_calibration_point_start_results = (ret, None)
        self.log("start_calibration_point results", "index", pt_index, "attempt", attempt, "left", ret, "right", None)
        return ret

    def cancel_calibration(self):
        ret = 0
        try:
            ret = self.sdk._7i_cancel_calibration()
        except Exception:
            ret = -1
        self.last_calibration_point_cancel_results = (ret, None)
        self.log("cancel_calibration_point results", "left", ret, "right", None)
        return ret

    def complete_calibration(self):
        coeff = self.types.py_7i_coefficient_t()
        success = self.sdk._7i_compute_calibration(pointer(coeff))
        self.last_calibration_compute_results = (success, None)
        self.log("compute_calibration results", "left", success, "right", None)
        self.end_calibration()
        left = c_float()
        right = c_float()
        try:
            self.last_calibration_score_result = self.sdk._7i_get_calibration_score(byref(left), byref(right))
        except Exception:
            self.last_calibration_score_result = -1
        self.log(
            "get_calibration_score result",
            self.last_calibration_score_result,
            "left",
            left.value,
            "right",
            right.value,
        )
        coe_str = base64.b64encode(bytes(coeff.buf)).decode("ascii")
        return success, coe_str, left.value, right.value

    def start_tracking(self, coe_str):
        try:
            data = base64.b64decode(coe_str)
            coeff = self.types.py_7i_coefficient_t()
            coeff_len = len(coeff.buf)
            for i in range(min(len(data), coeff_len)):
                coeff.buf[i] = data[i]
            return self.sdk._7i_start_tracking(pointer(coeff))
        except Exception:
            return -1


class A8Driver(ProDriver):
    model_name = "A8"
    # The vendor A8 demo starts directly without softdog authentication.
    requires_softdog_password = False
    runtime_suffix = Path("bin/windows/x64/A8_Release")
    types_suffix = Path("samples/A8/python3")
    types_filenames = ("_7i_types.py",)

    def _bind_model_signatures(self):
        super()._bind_model_signatures()
        # A8 桌面式设备的屏幕物理尺寸必须通过 _7i_set_gazepre_flash_data
        # 配合 SDK 自带的 Configs.dat 标定数据一起设置（官方 demo 同款做法）。
        # _7i_set_screen_size 仅适用于 A3/A6 设备，对 A8 会返回 -1。
        try:
            if hasattr(self.sdk, "_7i_set_gazepre_flash_data"):
                self.sdk._7i_set_gazepre_flash_data.argtypes = [POINTER(c_ubyte), c_int, c_double, c_double]
                self.sdk._7i_set_gazepre_flash_data.restype = c_int
        except Exception:
            pass

    def _gazepre_flash_data_path(self):
        candidates = []
        if self.config_dir is not None:
            candidates.append(self.config_dir / "Configs.dat")
        if self.sdk_root is not None:
            candidates.append(self.sdk_root / "config" / "Configs.dat")
        for p in candidates:
            try:
                if p.exists():
                    return p
            except Exception:
                continue
        return None

    def set_screen_size(self, width, height):
        # A8 用 gazepre flash data 设置屏幕尺寸，而非 _7i_set_screen_size。
        # Configs.dat 缺失时明确返回 -1（调用方据此上抛告警），不再静默。
        if self.sdk is None or not hasattr(self.sdk, "_7i_set_gazepre_flash_data"):
            self.log("A8 set_screen_size unavailable", "has_sdk", self.sdk is not None)
            return -1
        flash_path = self._gazepre_flash_data_path()
        if flash_path is None:
            self.log("A8 gazepre flash data not found", "config_dir", str(self.config_dir))
            return -1
        try:
            data = flash_path.read_bytes()
        except Exception as e:
            self.log("A8 gazepre flash data read failed", str(e))
            return -1
        if not data:
            self.log("A8 gazepre flash data empty", str(flash_path))
            return -1
        try:
            buf = (c_ubyte * len(data)).from_buffer_copy(data)
            ret = self.sdk._7i_set_gazepre_flash_data(buf, len(data), float(width), float(height))
            # A8 的 gazepre 标定写入设备 flash 存在竞态：重开设备时偶发
            # 「ret 0 但标定未真正生效」，导致 gaze 映射越界、校准失败（间歇性）。
            # 加短暂延迟让 flash 写入完成，并重试一次提高标定生效的可靠性。
            time.sleep(0.3)
            ret2 = self.sdk._7i_set_gazepre_flash_data(buf, len(data), float(width), float(height))
            if ret2 == 0:
                ret = ret2
        except Exception as e:
            self.log("A8 gazepre flash data set exception", str(e))
            return -1
        self.log("A8 set_screen_size via gazepre_flash_data", "size", len(data), "w_mm", width, "h_mm", height, "ret", ret, "ret2", ret2)
        return ret


class FFmpegH265HardwareDecoder:
    """H.265 hardware decoder backed by an ffmpeg subprocess.

    Feeds Annex-B HEVC packets into ffmpeg's stdin and reads decoded BGR frames
    from its stdout. On Windows this uses d3d11va, which talks to the GPU driver
    directly and does not depend on the Microsoft HEVC Media Foundation extension
    (the path that hangs the renderer when it is missing).
    """

    def __init__(self, ffmpeg_path, width, height, on_frame, log, hwaccel="d3d11va", output_fps=10):
        self.log = log
        self.width = max(1, int(width))
        self.height = max(1, int(height))
        self.frame_size = self.width * self.height * 3
        self._on_frame = on_frame
        self._failed = False
        self._stop = threading.Event()
        self._proc = None
        self._writer = None
        self._reader = None
        # Short input queue so a slow writer never stalls the SDK callback. On
        # overload we drop packets; the reference chain breaks but ffmpeg resyncs
        # at the next keyframe instead of stalling the whole pipeline.
        self._in_queue = queue.Queue(maxsize=16)
        self._start(ffmpeg_path, hwaccel, output_fps)

    def _start(self, ffmpeg_path, hwaccel, output_fps):
        try:
            cmd = [
                ffmpeg_path,
                "-hide_banner",
                "-loglevel",
                "error",
                "-hwaccel",
                hwaccel,
                "-f",
                "hevc",
                "-i",
                "pipe:0",
                "-an",
                "-r",
                str(max(1, int(output_fps))),
                "-f",
                "rawvideo",
                "-pix_fmt",
                "bgr24",
                "pipe:1",
            ]
            self._proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except Exception as e:
            self._failed = True
            self.log("ffmpeg hwdec start failed", str(e))
            return
        self._writer = threading.Thread(target=self._write_loop, name="mrt-ffmpeg-hwdec-writer", daemon=True)
        self._reader = threading.Thread(target=self._read_loop, name="mrt-ffmpeg-hwdec-reader", daemon=True)
        self._writer.start()
        self._reader.start()

    def feed(self, packet):
        if self._failed or self._proc is None or self._proc.poll() is not None:
            self._failed = True
            return
        try:
            self._in_queue.put_nowait(packet)
        except queue.Full:
            try:
                self._in_queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self._in_queue.put_nowait(packet)
            except queue.Full:
                pass

    def _write_loop(self):
        try:
            while not self._stop.is_set():
                try:
                    packet = self._in_queue.get(timeout=0.1)
                except queue.Empty:
                    continue
                if self._proc is None or self._proc.stdin is None:
                    break
                self._proc.stdin.write(packet)
                self._proc.stdin.flush()
        except Exception:
            pass
        self._failed = True

    def _read_loop(self):
        try:
            while not self._stop.is_set():
                if self._proc is None or self._proc.stdout is None:
                    break
                data = self._proc.stdout.read(self.frame_size)
                if not data:
                    break
                if len(data) != self.frame_size:
                    continue
                if self._on_frame is not None:
                    self._on_frame(data)
        except Exception:
            pass
        self._failed = True

    def is_failed(self):
        if self._failed:
            return True
        if self._proc is not None and self._proc.poll() is not None:
            return True
        return False

    def close(self):
        self._stop.set()
        try:
            if self._proc is not None and self._proc.stdin is not None:
                self._proc.stdin.close()
        except Exception:
            pass
        try:
            if self._proc is not None:
                self._proc.wait(timeout=3.0)
        except Exception:
            try:
                if self._proc is not None:
                    self._proc.kill()
            except Exception:
                pass
        self._proc = None


class ASeeGlassesPlusDriver(BaseSDKDriver):
    model_name = "aSeeGlassesPlus"
    runtime_suffix = Path("bin")
    types_suffix = Path("samples/python3")
    types_filenames = ("sdk_types.py", "_7i_types.py")

    def __init__(self, script_path: Path, log):
        super().__init__(script_path, log)
        self.h265 = None
        self.avutil = None
        self.h265_lock = threading.Lock()
        self.h265_inited = False
        self.h265_size = (0, 0)
        self.h265_scene_buf = None
        self.h265_scene_buf_len = 0
        self.h265_has_frame = False
        self.h265_last_good_frame = None
        self.h265_decode_err_count = 0
        self.h265_last_err_log_ts = 0.0
        self.h265_decode_packet_count = 0
        self.h265_decode_frame_count = 0
        self.h265_emit_frame_count = 0
        self.h265_fallback_frame_count = 0
        self.h265_invalid_frame_count = 0
        self.h265_last_status_log_ts = 0.0
        self.h265_decode_total_ms = 0.0
        self.h265_decode_max_ms = 0.0
        self.h265_decode_sample_count = 0
        self.h265_decode_last_log_ts = 0.0
        self.h265_async_enabled = str(os.getenv("MRT_H265_ASYNC", "1")).strip().lower() not in {"0", "false", "no", "off"}
        self.h265_async_stop = threading.Event()
        self.h265_async_emit_requested = threading.Event()
        self.h265_async_wait_for_keyframe = threading.Event()
        self.h265_async_thread = None
        # A deep queue makes the packaged software-decoder fallback consume old
        # frames for seconds while competing with facial inference. Keep only a
        # short live-video buffer and recover from overload at the next keyframe.
        self.h265_async_queue = queue.Queue(maxsize=max(1, _safe_int(os.getenv("MRT_H265_ASYNC_QUEUE", "12"), 12)))
        self.h265_async_drop_count = 0
        self.h265_async_last_log_ts = 0.0
        # ffmpeg hardware decode backend (d3d11va on Windows). DISABLED by default:
        # on HEVC-capable GPUs (e.g. RTX 4090) both WebCodecs (Media Foundation ->
        # NVDEC) and ffmpeg d3d11va initialize NVDEC sessions, and running both at
        # once can hang the GPU driver and freeze the renderer. WebCodecs is the
        # primary preview path; ffmpeg stays off unless MRT_H265_FFMPEG_HWDEC=1 is
        # set explicitly.
        self.h265_ffmpeg = None
        self.h265_decode_backend = "sdk"
        self.h265_ffmpeg_enabled = str(os.getenv("MRT_H265_FFMPEG_HWDEC", "0")).strip().lower() not in {"0", "false", "no", "off"}
        self.left_coeff_bytes = None
        self.right_coeff_bytes = None
        self.left_coeff_len = 1024
        self.right_coeff_len = 1024
        self.calibration_callback_contexts = []

    def _resolve_config_ini(self, root: Path) -> Path:
        return root / "config" / "config.ini"

    def _resolve_config_dir(self, root: Path) -> Path:
        return root / "config"

    def _bind_model_signatures(self):
        T = self.types
        try:
            self.sdk._7i_start.argtypes = [c_char_p, c_int, c_int, c_int]
            self.sdk._7i_start.restype = c_int
        except Exception:
            pass
        try:
            self.sdk._7i_start_tracking.argtypes = [c_int, POINTER(T.py_7i_coefficient_t)]
            self.sdk._7i_start_tracking.restype = c_int
        except Exception:
            pass
        try:
            self.sdk._7i_start_calibration.argtypes = [c_int]
            self.sdk._7i_start_calibration.restype = c_int
        except Exception:
            pass
        try:
            self.sdk._7i_start_calibration_point.argtypes = [
                c_int,
                c_int,
                POINTER(T.py_7i_point_2d_t),
                T.fn_7i_point_process_callback_t,
                py_object,
                T.fn_7i_point_finish_callback_t,
                py_object,
            ]
            self.sdk._7i_start_calibration_point.restype = c_int
        except Exception:
            pass
        try:
            self.sdk._7i_cancel_calibration.argtypes = [c_int]
            self.sdk._7i_cancel_calibration.restype = c_int
        except Exception:
            pass
        try:
            self.sdk._7i_compute_calibration.argtypes = [c_int, POINTER(T.py_7i_coefficient_t)]
            self.sdk._7i_compute_calibration.restype = c_int
        except Exception:
            pass
        try:
            self.sdk._7i_complete_calibration.argtypes = []
            self.sdk._7i_complete_calibration.restype = c_int
        except Exception:
            pass
        try:
            if hasattr(self.sdk, "_7i_set_data"):
                self.sdk._7i_set_data.argtypes = [c_char_p, c_int, POINTER(c_ubyte), c_int]
                self.sdk._7i_set_data.restype = c_int
        except Exception:
            pass
        try:
            if hasattr(self.sdk, "_7i_get_data"):
                self.sdk._7i_get_data.argtypes = [c_char_p, c_int, c_void_p, POINTER(c_int)]
                self.sdk._7i_get_data.restype = c_int
        except Exception:
            pass

    def load(self, status_cb, image_cb, gaze_cb, point_process_cb, point_finish_cb):
        super().load(status_cb, image_cb, gaze_cb, point_process_cb, point_finish_cb)
        T = self.types
        # Match the vendor sample: keep distinct callback function pointers for
        # left and right eyes instead of sharing one pointer with two contexts.
        self.py_left_point_process_cb = T.fn_7i_point_process_callback_t(point_process_cb)
        self.py_right_point_process_cb = T.fn_7i_point_process_callback_t(point_process_cb)
        self.py_left_point_finish_cb = T.fn_7i_point_finish_callback_t(point_finish_cb)
        self.py_right_point_finish_cb = T.fn_7i_point_finish_callback_t(point_finish_cb)
        self._load_h265_decoder()

    def _load_h265_decoder(self):
        if self.sdk_root is None:
            return
        # 优先 ffmpeg 硬件解码（d3d11va），失败回退 SDK 软件解码。
        if self._try_start_ffmpeg_hwdecoder():
            return
        if self._load_sdk_softdecoder():
            self._start_h265_async_worker()

    def _find_ffmpeg_binary(self):
        binary = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
        if self.sdk_root is not None:
            candidates = [
                self.sdk_root / "Tool" / "ffmpeg" / "bin" / binary,
                self.sdk_root / "tool" / "ffmpeg" / "bin" / binary,
                self.sdk_root / "ffmpeg" / "bin" / binary,
                self.sdk_root.parent / "Tool" / "ffmpeg" / "bin" / binary,
            ]
            for c in candidates:
                try:
                    if c.exists() and c.is_file():
                        return str(c)
                except Exception:
                    continue
        try:
            return shutil.which("ffmpeg")
        except Exception:
            return None

    def _on_ffmpeg_frame(self, frame_bytes):
        try:
            with self.h265_lock:
                self.h265_has_frame = True
                self.h265_last_good_frame = frame_bytes
                self.h265_emit_frame_count += 1
        except Exception:
            pass

    def _try_start_ffmpeg_hwdecoder(self):
        if not self.h265_ffmpeg_enabled:
            self.log("ffmpeg hwdec disabled by env")
            return False
        ffmpeg = self._find_ffmpeg_binary()
        if not ffmpeg:
            self.log("ffmpeg hwdec skipped: ffmpeg not found")
            return False
        try:
            # Glasses scene stream is fixed at 1280x720.
            self.h265_ffmpeg = FFmpegH265HardwareDecoder(ffmpeg, 1280, 720, self._on_ffmpeg_frame, self.log)
            if self.h265_ffmpeg.is_failed():
                self.log("ffmpeg hwdec unavailable, fallback to sdk software decode")
                self.h265_ffmpeg.close()
                self.h265_ffmpeg = None
                return False
            self.h265_decode_backend = "ffmpeg"
            self.h265_size = (1280, 720)
            self.log("h265 decoder loaded (ffmpeg hardware)", ffmpeg)
            self._start_h265_async_worker()
            return True
        except Exception as e:
            self.log("ffmpeg hwdec start failed", str(e))
            if self.h265_ffmpeg is not None:
                self.h265_ffmpeg.close()
                self.h265_ffmpeg = None
            return False

    def _load_sdk_softdecoder(self):
        if self.sdk_root is None:
            return False
        decoder = self.sdk_root / "H265Decode.dll"
        if not decoder.exists():
            return False
        try:
            self._quiet_ffmpeg_logs()
            self.h265 = WinDLL(str(decoder))
            self.h265._7i_h265_init.argtypes = [c_uint, c_uint]
            self.h265._7i_h265_init.restype = c_int
            self.h265._7i_h265_decode.argtypes = [c_int, c_void_p, c_void_p, c_int]
            self.h265._7i_h265_decode.restype = c_int
            self.h265._7i_h265_release.argtypes = []
            self.h265._7i_h265_release.restype = c_int
            self.h265_decode_backend = "sdk"
            self.log("h265 decoder loaded (sdk software)", str(decoder))
            return True
        except Exception as e:
            self.log("h265 sdk decoder load failed", str(e))
            self.h265 = None
            return False

    def _fallback_to_sdk_softdecode(self):
        try:
            if self.h265_ffmpeg is not None:
                self.h265_ffmpeg.close()
                self.h265_ffmpeg = None
            self.log("ffmpeg hwdec failed at runtime, falling back to sdk software decode")
            if self._load_sdk_softdecoder():
                with self.h265_lock:
                    self.h265_has_frame = False
                    self.h265_last_good_frame = None
                self.h265_async_wait_for_keyframe.set()
        except Exception as e:
            self.log("h265 fallback to sdk failed", str(e))

    def _start_h265_async_worker(self):
        if not self.h265_async_enabled or (self.h265 is None and self.h265_ffmpeg is None):
            self.log("h265 mode", "sync")
            return
        if self.h265_async_thread is not None and self.h265_async_thread.is_alive():
            return
        try:
            self.h265_async_stop.clear()
            self.h265_async_thread = threading.Thread(target=self._h265_async_decode_loop, name="mrt-h265-decode", daemon=True)
            self.h265_async_thread.start()
            self.log("h265 mode", "async", "backend", self.h265_decode_backend, "queue", self.h265_async_queue.maxsize)
        except Exception as e:
            self.h265_async_thread = None
            self.h265_async_enabled = False
            self.log("h265 async start failed, fallback sync", str(e))

    def _stop_h265_async_worker(self):
        thread = self.h265_async_thread
        if thread is None:
            self._drain_h265_async_queue()
            return
        try:
            self.h265_async_stop.set()
            try:
                self.h265_async_queue.put_nowait(None)
            except Exception:
                pass
            if thread.is_alive():
                thread.join(timeout=1.0)
        except Exception as e:
            self.log("h265 async stop failed", str(e))
        self.h265_async_thread = None
        self._drain_h265_async_queue()

    def _drain_h265_async_queue(self):
        drained = 0
        try:
            while True:
                self.h265_async_queue.get_nowait()
                drained += 1
        except queue.Empty:
            pass
        except Exception:
            pass
        return drained

    @staticmethod
    def _h265_packet_has_keyframe(packet):
        """Return whether an Annex-B packet contains an HEVC IRAP NAL unit."""
        try:
            data = bytes(packet or b"")
            size = len(data)
            index = 0
            while index + 4 <= size:
                start = -1
                prefix_len = 0
                if data[index:index + 3] == b"\x00\x00\x01":
                    start = index
                    prefix_len = 3
                elif data[index:index + 4] == b"\x00\x00\x00\x01":
                    start = index
                    prefix_len = 4
                if start >= 0:
                    header = start + prefix_len
                    if header < size:
                        nal_type = (data[header] >> 1) & 0x3F
                        if 16 <= nal_type <= 21:
                            return True
                    index = header + 1
                    continue
                index += 1
        except Exception:
            pass
        return False

    def _offer_h265_async_packet(self, eye_id, image_ptr, payload_len, width, height, emit_frame=False):
        if payload_len <= 0 or not image_ptr:
            return
        if emit_frame:
            # The decoder must consume every retained compressed packet, but a
            # 1280x720 BGR buffer only needs to be copied/validated when the UI
            # preview or recorder is actually due for a fresh frame.
            self.h265_async_emit_requested.set()
        try:
            packet = string_at(image_ptr, payload_len)
            if self.h265_async_wait_for_keyframe.is_set():
                is_keyframe = self._h265_packet_has_keyframe(packet)
                if not is_keyframe:
                    self.h265_async_drop_count += 1
                    return
                self.h265_async_wait_for_keyframe.clear()
                self.log("h265 async resumed at keyframe", "drops", self.h265_async_drop_count)
            item = (eye_id, packet, int(width) if width else 0, int(height) if height else 0)
            try:
                self.h265_async_queue.put_nowait(item)
            except queue.Full:
                is_keyframe = self._h265_packet_has_keyframe(packet)
                dropped = self._drain_h265_async_queue()
                self.h265_async_drop_count += max(1, dropped)
                # Dropping arbitrary inter frames breaks the reference chain.
                # Discard incoming deltas until an independently decodable
                # keyframe arrives instead of burning CPU on a stale backlog.
                if is_keyframe:
                    self.h265_async_wait_for_keyframe.clear()
                    self.h265_async_queue.put_nowait(item)
                else:
                    self.h265_async_wait_for_keyframe.set()
                now = time.time()
                if self.h265_async_drop_count <= 5 or (now - self.h265_async_last_log_ts) >= 2.0:
                    self.h265_async_last_log_ts = now
                    self.log(
                        "h265 async overload, backlog cleared",
                        "drops", self.h265_async_drop_count,
                        "queue", self.h265_async_queue.maxsize,
                        "keyframe", is_keyframe,
                    )
        except Exception as e:
            now = time.time()
            if now - self.h265_async_last_log_ts >= 2.0:
                self.h265_async_last_log_ts = now
                self.log("h265 async packet offer failed", str(e))

    def _h265_async_decode_loop(self):
        while not self.h265_async_stop.is_set():
            try:
                item = self.h265_async_queue.get(timeout=0.05)
            except queue.Empty:
                continue
            except Exception:
                continue
            if item is None:
                continue
            try:
                eye_id, packet, width, height = item
                payload_len = len(packet)
                if payload_len <= 0:
                    continue
                if self.h265_decode_backend == "ffmpeg" and self.h265_ffmpeg is not None:
                    # ffmpeg 硬解：只需喂包，解码帧由读帧线程回调更新 h265_last_good_frame。
                    if self.h265_ffmpeg.is_failed():
                        self._fallback_to_sdk_softdecode()
                        continue
                    self.h265_ffmpeg.feed(packet)
                    continue
                packet_buf = (c_ubyte * payload_len).from_buffer_copy(packet)
                emit_frame = self.h265_async_emit_requested.is_set()
                if emit_frame:
                    # Clear before decoding so a newer request that arrives
                    # during this call remains set for the following frame.
                    self.h265_async_emit_requested.clear()
                with self.h265_lock:
                    frame_bytes, _ = self._preprocess_h265_scene_payload(
                        eye_id,
                        cast(packet_buf, c_void_p),
                        payload_len,
                        width,
                        height,
                        emit_frame=emit_frame,
                        allow_cached_fallback=False,
                    )
                if emit_frame and not frame_bytes:
                    self.h265_async_emit_requested.set()
            except Exception as e:
                now = time.time()
                if now - self.h265_async_last_log_ts >= 2.0:
                    self.h265_async_last_log_ts = now
                    self.log("h265 async decode failed", str(e))

    def _quiet_ffmpeg_logs(self):
        if self.sdk_root is None:
            return
        avutil_path = self.sdk_root / "avutil-56.dll"
        if not avutil_path.exists():
            return
        try:
            self.avutil = CDLL(str(avutil_path))
            self.avutil.av_log_set_level.argtypes = [c_int]
            self.avutil.av_log_set_level.restype = None
            self.avutil.av_log_set_level(-8)
            self.log("ffmpeg decoder logs silenced", str(avutil_path))
        except Exception as e:
            self.log("ffmpeg log silence failed", str(e))

    def preprocess_image_payload(self, eye, image_ptr, size, width, height, emit_frame=True, allow_cached_fallback=True):
        try:
            eye_id = int(eye)
        except Exception:
            eye_id = -1
        payload_len = int(size) if size else 0
        # Some aSeeGlassesPlus SDK builds may use different non-1/2 values for scene stream.
        # Keep left/right eye untouched, and try scene decode for all other eye ids.
        if eye_id in (1, 2):
            if emit_frame:
                return string_at(image_ptr, payload_len), payload_len
            return b"", 0
        if self.h265 is None and self.h265_ffmpeg is None:
            if emit_frame:
                return string_at(image_ptr, payload_len), payload_len
            return b"", 0
        if self.h265_async_enabled and self.h265_async_thread is not None and self.h265_async_thread.is_alive():
            self._offer_h265_async_packet(
                eye_id,
                image_ptr,
                payload_len,
                width,
                height,
                emit_frame=emit_frame,
            )
            if not emit_frame:
                return b"", 0
            try:
                w = int(width)
                h = int(height)
                if w <= 0 or h <= 0:
                    w, h = self.h265_size if self.h265_size else (0, 0)
                out_len = w * h * 3 if w > 0 and h > 0 else len(self.h265_last_good_frame or b"")
                with self.h265_lock:
                    if self.h265_last_good_frame is not None:
                        return self.h265_last_good_frame, out_len
                    if allow_cached_fallback and self.h265_has_frame and self.h265_last_good_frame is not None:
                        return self.h265_last_good_frame, out_len
                return b"", 0
            except Exception:
                return b"", 0
        with self.h265_lock:
            return self._preprocess_h265_scene_payload(
                eye_id,
                image_ptr,
                payload_len,
                width,
                height,
                emit_frame=emit_frame,
                allow_cached_fallback=allow_cached_fallback,
            )

    def _preprocess_h265_scene_payload(self, eye_id, image_ptr, payload_len, width, height, emit_frame=True, allow_cached_fallback=True):
        try:
            w = int(width)
            h = int(height)
            if w <= 0 or h <= 0:
                # Some builds may report 0 on early frames; keep previous initialized size.
                if self.h265_size and self.h265_size[0] > 0 and self.h265_size[1] > 0:
                    w, h = self.h265_size
                else:
                    # Fallback to common sample default to give decoder a chance.
                    w, h = 1280, 720
            # Keep a persistent decode buffer like vendor sample code.
            # Some decoder builds may not return success for every packet,
            # but still update the internal output frame.
            required_len = max(w * h * 3, 1920 * 1080 * 3)
            if self.h265_scene_buf is None or self.h265_scene_buf_len < required_len:
                self.h265_scene_buf = (c_ubyte * required_len)()
                self.h265_scene_buf_len = required_len

            if (not self.h265_inited) or self.h265_size != (w, h):
                t_init_begin = time.perf_counter()
                init_ret = self.h265._7i_h265_init(w, h)
                init_ms = (time.perf_counter() - t_init_begin) * 1000.0
                self.log("glasses-startup:h265-init", "ret=", init_ret, "init_ms=", round(init_ms, 1), "w=", w, "h=", h)
                if init_ret != 0:
                    if emit_frame:
                        return string_at(image_ptr, payload_len), payload_len
                    return b"", 0
                self.h265_inited = True
                self.h265_size = (w, h)

            out_len = w * h * 3
            # Empty payload packets can appear frequently in glasses mode.
            # Never decode them, otherwise stale/uninitialized buffer may leak as noisy first frames.
            if payload_len <= 0 or not image_ptr:
                if emit_frame and allow_cached_fallback and self.h265_last_good_frame is not None:
                    self.h265_fallback_frame_count += 1
                    return self.h265_last_good_frame, out_len
                return b"", 0
            frame_ptr = cast(image_ptr, c_void_p)
            self.h265_decode_packet_count += 1
            t_decode_begin = time.perf_counter()
            ret = self.h265._7i_h265_decode(
                payload_len,
                frame_ptr,
                cast(self.h265_scene_buf, c_void_p),
                int(self.h265_scene_buf_len),
            )
            decode_ms = (time.perf_counter() - t_decode_begin) * 1000.0
            self.h265_decode_sample_count += 1
            self.h265_decode_total_ms += decode_ms
            self.h265_decode_max_ms = max(self.h265_decode_max_ms, decode_ms)
            if self.h265_decode_sample_count >= 300 or (time.time() - self.h265_decode_last_log_ts) >= 5.0:
                avg_ms = self.h265_decode_total_ms / max(1, self.h265_decode_sample_count)
                self.log(
                    "glasses-startup:h265-decode-metrics",
                    "avg_ms=", round(avg_ms, 2),
                    "max_ms=", round(self.h265_decode_max_ms, 2),
                    "samples=", self.h265_decode_sample_count,
                    "backend=", self.h265_decode_backend,
                )
                self.h265_decode_total_ms = 0.0
                self.h265_decode_max_ms = 0.0
                self.h265_decode_sample_count = 0
                self.h265_decode_last_log_ts = time.time()
            # _7i_h265_decode only yields a fresh image when the return value is
            # positive. A zero result can leave the output buffer unchanged or
            # partially updated, so do not publish it as a frame.
            if ret <= 0:
                if emit_frame and allow_cached_fallback and self.h265_last_good_frame is not None:
                    self.h265_fallback_frame_count += 1
                    self._log_h265_decoder_status("fallback_ret", eye_id, payload_len, w, h, ret, emit_frame)
                    return self.h265_last_good_frame, out_len

                if not emit_frame:
                    self._log_h265_decoder_status("feed_ret", eye_id, payload_len, w, h, ret, emit_frame)
                    return b"", 0

                try:
                    now = time.time()
                    self.h265_decode_err_count += 1
                    if self.h265_decode_err_count <= 3 or (now - self.h265_last_err_log_ts) >= 2.0:
                        self.h265_last_err_log_ts = now
                        self.log("h265 decode ret", ret, "size", payload_len, "w", w, "h", h, "eye", eye_id)
                except Exception:
                    pass
                return b"", 0
            self.h265_decode_frame_count += 1
            if not emit_frame:
                self._log_h265_decoder_status("feed_frame", eye_id, payload_len, w, h, ret, emit_frame)
                return b"", 0
            frame_bytes = bytes(self.h265_scene_buf[:out_len])
            valid = self._validate_h265_frame(frame_bytes, w, h)
            if not valid:
                self.h265_invalid_frame_count += 1
                self._log_h265_decoder_status("invalid_frame", eye_id, payload_len, w, h, ret, emit_frame)
                if emit_frame and allow_cached_fallback and self.h265_last_good_frame is not None:
                    self.h265_fallback_frame_count += 1
                    return self.h265_last_good_frame, out_len
                return b"", 0
            self.h265_has_frame = True
            self.h265_last_good_frame = frame_bytes
            self.h265_emit_frame_count += 1
            self._log_h265_decoder_status("emit_frame", eye_id, payload_len, w, h, ret, emit_frame)
            return frame_bytes, out_len
        except Exception:
            if emit_frame:
                return string_at(image_ptr, payload_len), payload_len
            return b"", 0

    def reset_video_decoder(self):
        self._drain_h265_async_queue()
        self.h265_async_emit_requested.clear()
        self.h265_async_wait_for_keyframe.set()
        with self.h265_lock:
            # Do not release/re-init the H265 decoder while the glasses SDK stream
            # is running. The scene stream is inter-frame encoded; resetting
            # mid-stream makes the decoder miss VPS/SPS/PPS/reference frames and
            # produces persistent noisy output until the next keyframe. Clear only
            # our cached publishable frame so recording waits for fresh output.
            self.h265_has_frame = False
            self.h265_last_good_frame = None
            self.h265_decode_err_count = 0
            self.h265_last_err_log_ts = 0.0
            self.h265_fallback_frame_count = 0
            self.h265_invalid_frame_count = 0

    def cleanup(self):
        self._stop_h265_async_worker()
        if self.h265_ffmpeg is not None:
            try:
                self.h265_ffmpeg.close()
            except Exception:
                pass
            self.h265_ffmpeg = None
            self.h265_decode_backend = "sdk"
        with self.h265_lock:
            if self.h265 is not None and self.h265_inited:
                try:
                    self.h265._7i_h265_release()
                except Exception:
                    pass
                self.h265_inited = False
            self.h265_scene_buf = None
            self.h265_scene_buf_len = 0
            self.h265_has_frame = False
            self.h265_last_good_frame = None
            self.h265_decode_err_count = 0
            self.h265_last_err_log_ts = 0.0
            self.h265_decode_packet_count = 0
            self.h265_decode_frame_count = 0
            self.h265_emit_frame_count = 0
            self.h265_fallback_frame_count = 0
            self.h265_invalid_frame_count = 0
            self.h265_last_status_log_ts = 0.0
            self.h265_decode_total_ms = 0.0
            self.h265_decode_max_ms = 0.0
            self.h265_decode_sample_count = 0
            self.h265_decode_last_log_ts = 0.0
            self.h265_async_drop_count = 0
            self.h265_async_emit_requested.clear()
            self.h265_async_wait_for_keyframe.clear()

    def _log_h265_decoder_status(self, stage, eye_id, payload_len, w, h, ret, emit_frame):
        try:
            now = time.time()
            if self.h265_decode_packet_count <= 5 or (now - self.h265_last_status_log_ts) >= 2.0:
                self.h265_last_status_log_ts = now
                self.log(
                    "h265 decoder status",
                    "stage=", stage,
                    "packets=", self.h265_decode_packet_count,
                    "frames=", self.h265_decode_frame_count,
                    "emits=", self.h265_emit_frame_count,
                    "fallbacks=", self.h265_fallback_frame_count,
                    "invalid=", self.h265_invalid_frame_count,
                    "ret=", ret,
                    "emit=", emit_frame,
                    "eye=", eye_id,
                    "size=", payload_len,
                    "w=", w,
                    "h=", h,
                )
        except Exception:
            pass

    def _validate_h265_frame(self, frame_bytes, w, h):
        try:
            arr = frame_bytes
            total = len(arr)
            if total < w * h * 3:
                return False
            sample_size = 800
            stride = max(1, total // sample_size)
            sample = arr[::stride]
            n = len(sample)
            if n < 32:
                return False
            first = sample[0]
            all_same = True
            for b in sample:
                if b != first:
                    all_same = False
                    break
            if all_same:
                return first not in (0, 255)
            s = 0
            for b in sample:
                s += b
            mean_val = s / n
            if mean_val <= 0.5 or mean_val >= 252.0:
                return False
            ssq = 0.0
            for b in sample:
                d = b - mean_val
                ssq += d * d
            var = ssq / n
            if var < 0.25:
                return False
            white_count = 0
            black_count = 0
            for b in sample:
                if b >= 248:
                    white_count += 1
                elif b <= 6:
                    black_count += 1
            nw = white_count / n
            nb = black_count / n
            if nw > 0.72:
                return False
            if nw > 0.55 and nb > 0.08:
                return False
            return True
        except Exception:
            return True

    def start_device(self, password):
        t_begin = time.perf_counter()
        self._prepare_runtime_environment()
        prepare_ms = (time.perf_counter() - t_begin) * 1000.0
        ukey_info = self.types.py_7i_ukey_info_t()
        t_connect_begin = time.perf_counter()
        ret = self.sdk._7i_device_connect(password, pointer(ukey_info))
        connect_ms = (time.perf_counter() - t_connect_begin) * 1000.0
        if ret != 0:
            self.log("glasses-startup:start-device-timing", "ret=", ret, "prepare_ms=", round(prepare_ms, 1), "connect_ms=", round(connect_ms, 1), "start_ms=", 0.0)
            return ret
        ret_cam_cb = None
        if self.py_status_cb is not None and hasattr(self.sdk, "_7i_set_camera_state_callback"):
            ret_cam_cb = self.sdk._7i_set_camera_state_callback(self.py_status_cb, py_object(self))
        ret_img_cb = self.sdk._7i_set_image_callback(self.py_image_cb, py_object(self))
        ret_gaze_cb = self.sdk._7i_set_gaze_callback(self.py_gaze_cb, py_object(self))
        self.log("set callbacks", "camera", ret_cam_cb, "image", ret_img_cb, "gaze", ret_gaze_cb, "model", self.model_name)

        env = _safe_int(os.getenv("MRT_SDK_ENVIRONMENT", "301"), 301)
        # aSeeGlassesPlus sample defaults to 1280x720 (202). Keep this as default.
        res = _safe_int(os.getenv("MRT_SDK_RESOLUTION", "202"), 202)
        gyro = _safe_int(os.getenv("MRT_SDK_GYROSCOPE", "0"), 0)
        cfg_dir = self.config_dir if self.config_dir and self.config_dir.exists() else (self.sdk_root / "config")
        config_path = _vendor_path_bytes(cfg_dir)
        self.log("start with config path", cfg_dir, "vendor_path", _windows_short_path(cfg_dir), "env", env, "res", res, "gyro", gyro)
        self._start_h265_async_worker()
        t_start_begin = time.perf_counter()
        ret = self.sdk._7i_start(config_path, env, res, gyro)
        start_ms = (time.perf_counter() - t_start_begin) * 1000.0
        self.log("glasses-startup:start-device-timing", "ret=", ret, "prepare_ms=", round(prepare_ms, 1), "connect_ms=", round(connect_ms, 1), "start_ms=", round(start_ms, 1))
        return ret

    def start_calibration(self, points):
        return self.sdk._7i_start_calibration(points)

    def start_calibration_point(self, pt_index, x, y, attempt=None):
        pt = self.types.py_7i_point_2d_t()
        pt.x = float(x)
        pt.y = float(y)
        ctx_left = py_object({"driver": self, "eye": "left", "attempt": attempt})
        ctx_right = py_object({"driver": self, "eye": "right", "attempt": attempt})
        # The vendor SDK owns these callback pointers asynchronously. Retain the
        # Python objects for the driver lifetime so delayed callbacks stay valid.
        self.calibration_callback_contexts.extend((ctx_left, ctx_right))
        ret_left = self.sdk._7i_start_calibration_point(1, pt_index, pointer(pt), self.py_left_point_process_cb, ctx_left, self.py_left_point_finish_cb, ctx_left)
        ret_right = self.sdk._7i_start_calibration_point(2, pt_index, pointer(pt), self.py_right_point_process_cb, ctx_right, self.py_right_point_finish_cb, ctx_right)
        self.last_calibration_point_start_results = (ret_left, ret_right)
        self.log("start_calibration_point results", "index", pt_index, "attempt", attempt, "left", ret_left, "right", ret_right)
        return ret_left if ret_left != 0 else ret_right

    def cancel_calibration(self):
        ret_left = 0
        ret_right = 0
        try:
            ret_left = self.sdk._7i_cancel_calibration(1)
        except Exception:
            ret_left = -1
        try:
            ret_right = self.sdk._7i_cancel_calibration(2)
        except Exception:
            ret_right = -1
        self.last_calibration_point_cancel_results = (ret_left, ret_right)
        self.log("cancel_calibration_point results", "left", ret_left, "right", ret_right)
        return ret_left if ret_left != 0 else ret_right

    def _parse_scores(self):
        try:
            if not hasattr(self.sdk, "_7i_get_data"):
                return 0.0, 0.0
            buf = (c_ubyte * 128)()
            out_len = c_int(128)
            flag = b"get_score"
            ret = self.sdk._7i_get_data(flag, len(flag), cast(buf, c_void_p), byref(out_len))
            if ret != 0:
                return 0.0, 0.0
            n = max(0, min(int(out_len.value), 128))
            text = bytes(buf[:n]).decode("utf-8", errors="ignore")
            nums = re.findall(r"-?\d+(?:\.\d+)?", text)
            if len(nums) >= 2:
                return float(nums[0]), float(nums[1])
            if len(nums) == 1:
                v = float(nums[0])
                return v, v
        except Exception:
            return 0.0, 0.0
        return 0.0, 0.0

    def complete_calibration(self):
        left_coeff = self.types.py_7i_coefficient_t()
        right_coeff = self.types.py_7i_coefficient_t()
        ret_left = self.sdk._7i_compute_calibration(1, pointer(left_coeff))
        ret_right = self.sdk._7i_compute_calibration(2, pointer(right_coeff))
        self.last_calibration_compute_results = (ret_left, ret_right)
        self.log("compute_calibration results", "left", ret_left, "right", ret_right)
        success = ret_left if ret_left != 0 else ret_right
        compute_succeeded = success == 0
        ret_get_left = None
        ret_get_right = None
        ret_set_left = None
        ret_set_right = None
        left_len = c_int(1024)
        right_len = c_int(1024)
        if success == 0:
            if hasattr(self.sdk, "_7i_get_data"):
                flag_left = b"biLeft"
                flag_right = b"biRight"
                # Keep the exact sample data flow: get_data writes back into the
                # same coefficient buffers produced by compute_calibration.
                ret_get_left = self.sdk._7i_get_data(flag_left, len(flag_left), cast(left_coeff.buf, c_void_p), byref(left_len))
                ret_get_right = self.sdk._7i_get_data(flag_right, len(flag_right), cast(right_coeff.buf, c_void_p), byref(right_len))
                self.log(
                    "complete_calibration get_data",
                    "left",
                    ret_get_left,
                    "left_len",
                    int(left_len.value),
                    "right",
                    ret_get_right,
                    "right_len",
                    int(right_len.value),
                )
            else:
                ret_get_left = -1
                ret_get_right = -1
            self.last_calibration_data_results = (ret_get_left, ret_get_right)
            if ret_get_left == 0 and ret_get_right == 0:
                self.left_coeff_bytes = bytes(left_coeff.buf)
                self.right_coeff_bytes = bytes(right_coeff.buf)
                self.left_coeff_len = 1024
                self.right_coeff_len = 1024
            else:
                success = ret_get_left if ret_get_left not in (0, None) else ret_get_right
        left_score, right_score = self._parse_scores() if compute_succeeded else (0.0, 0.0)
        # The sample always ends the calibration after compute/get_data/get_score.
        self.end_calibration()
        if success == 0:
            flag_left = b"biLeft"
            flag_right = b"biRight"
            ret_set_left = self.sdk._7i_set_data(flag_left, len(flag_left), left_coeff.buf, 1024)
            ret_set_right = self.sdk._7i_set_data(flag_right, len(flag_right), right_coeff.buf, 1024)
            self.last_calibration_activation_results = (ret_set_left, ret_set_right)
            self.log("complete_calibration set_data", "left", ret_set_left, "right", ret_set_right)
            coe_str = base64.b64encode(self.left_coeff_bytes + self.right_coeff_bytes).decode("ascii")
        else:
            self.last_calibration_activation_results = (None, None)
            coe_str = ""
        return success, coe_str, left_score, right_score

    def _coeff_from_bytes(self, data):
        coeff = self.types.py_7i_coefficient_t()
        for i in range(min(len(data), 1024)):
            coeff.buf[i] = data[i]
        return coeff

    def _try_start_tracking_direct(self, left_coeff, right_coeff):
        if self.sdk is None or not hasattr(self.sdk, "_7i_start_tracking"):
            return False, -1, -1
        try:
            ret_l = self.sdk._7i_start_tracking(1, pointer(left_coeff))
            ret_r = self.sdk._7i_start_tracking(2, pointer(right_coeff))
            ok = (ret_l == 0 and ret_r == 0)
            self.log("start_tracking direct", "left", ret_l, "right", ret_r, "ok", ok)
            return ok, ret_l, ret_r
        except Exception as e:
            self.log("start_tracking direct failed", str(e))
            return False, -1, -1

    def _try_set_tracking_data(self, left_coeff, right_coeff):
        if self.sdk is None or not hasattr(self.sdk, "_7i_set_data"):
            return False, -1, -1
        try:
            flag_left = b"biLeft"
            flag_right = b"biRight"
            left_len = max(1, min(int(self.left_coeff_len or 1024), 1024))
            right_len = max(1, min(int(self.right_coeff_len or 1024), 1024))
            ret_l = self.sdk._7i_set_data(flag_left, len(flag_left), left_coeff.buf, left_len)
            ret_r = self.sdk._7i_set_data(flag_right, len(flag_right), right_coeff.buf, right_len)
            ok = (ret_l == 0 and ret_r == 0)
            self.log("start_tracking set_data fallback", "left", ret_l, "left_len", left_len, "right", ret_r, "right_len", right_len, "ok", ok)
            return ok, ret_l, ret_r
        except Exception as e:
            self.log("start_tracking set_data fallback failed", str(e))
            return False, -1, -1

    def start_tracking(self, coe_str):
        left = None
        right = None
        decode_len = 0
        try:
            if coe_str:
                data = base64.b64decode(coe_str)
                decode_len = len(data)
                if len(data) >= 2048:
                    left = data[:1024]
                    right = data[1024:2048]
                elif len(data) >= 1024:
                    left = data[:1024]
                    right = data[:1024]
        except Exception:
            left = None
            right = None

        if left is not None and right is not None:
            self.left_coeff_bytes = bytes(left)
            self.right_coeff_bytes = bytes(right)
            self.left_coeff_len = min(len(left), 1024)
            self.right_coeff_len = min(len(right), 1024)
            try:
                mode = "split-2048" if decode_len >= 2048 else "duplicate-1024"
                self.log("start_tracking coeff decoded", "len", decode_len, "mode", mode)
            except Exception:
                pass

        if not self.left_coeff_bytes or not self.right_coeff_bytes:
            try:
                self.log("start_tracking coeff missing", "decoded_len", decode_len)
            except Exception:
                pass
            return -1

        left_coeff = self._coeff_from_bytes(self.left_coeff_bytes)
        right_coeff = self._coeff_from_bytes(self.right_coeff_bytes)

        direct_ok, direct_left, direct_right = self._try_start_tracking_direct(left_coeff, right_coeff)
        if direct_ok:
            self.log("start_tracking glasses mode", "direct")
            return 0
        if direct_left == 0 or direct_right == 0:
            try:
                stop_ret = self.stop_tracking()
                self.log("start_tracking direct partial stopped before fallback", stop_ret)
            except Exception as e:
                self.log("start_tracking direct partial stop failed", str(e))

        set_data_ok, set_left, set_right = self._try_set_tracking_data(left_coeff, right_coeff)
        if set_data_ok:
            self.log("start_tracking glasses mode", "set_data_fallback", "direct_left", direct_left, "direct_right", direct_right)
            return 0

        self.log(
            "start_tracking glasses failed",
            "direct_left",
            direct_left,
            "direct_right",
            direct_right,
            "set_left",
            set_left,
            "set_right",
            set_right,
        )
        return direct_left if direct_left != 0 else (direct_right if direct_right != 0 else -1)

    # aSeeGlassesPlus sample does not use desktop-only runtime tuning calls.
    # Keep these as explicit no-op to avoid cross-model invocation ambiguity.
    def set_screen_size(self, width, height):
        return 0

    def set_smooth(self, smooth):
        return 0


def create_sdk_driver(model_name: str, script_path: Path, log):
    normalized = str(model_name or "").strip().lower()
    if normalized in {"aseeglassesplus", "asee_glasses_plus", "asee-glasses-plus", "glassesplus"}:
        return ASeeGlassesPlusDriver(script_path, log)
    if normalized in {"a8", "asee_a8", "asee-a8"}:
        return A8Driver(script_path, log)
    return ProDriver(script_path, log)
