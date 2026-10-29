import asyncio
import base64
import json
import io
import threading
import math
from pathlib import Path
from ctypes import *
from configparser import ConfigParser
import numpy as np
import cv2
import csv
import time
from datetime import datetime
import os
import sys
import mss
import mss.tools
import subprocess
import shutil
import hashlib
import struct
import queue
from adapters.invensun_7.sdk_driver import create_sdk_driver
from adapters.invensun_7.data_normalizer import pick_gaze_xy
from analysis.eye_event_postprocess import postprocess_eye_event_csv
from application.sdk_policies import normalize_device_type, normalize_model_name, model_from_device_type, record_source_from_device_type, resolve_capture_monitor, safe_subject_name
from application.screen_capture import ScreenCapture, recording_frame_size, write_all

types_loaded = False

if os.name == "nt":
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

DEBUG_TESTING_ENABLED = str(os.getenv("MRT_DEBUG_TESTING", "0")).strip().lower() in ("1", "true", "yes", "on")

def log(*args):
    if DEBUG_TESTING_ENABLED:
        # flush 确保日志实时写入 stdout，避免子进程 stdout 走管道时被块缓冲
        # 滞留（否则短会话的后端日志会一直滞留在缓冲里，主进程采集不到）。
        print("[ws_service]", *args, flush=True)


def get_physical_screen_size_mm():
    """读取显示器真实物理尺寸（毫米），与 Windows 缩放比例无关。

    通过 Win32 GDI 的 GetDeviceCaps(HORZSIZE/VERTSIZE) 直接读取显示器 EDID
    里的物理尺寸，等价于 A8 官方 demo 的 win32print.GetDeviceCaps 做法。
    前端 window.screen 只能依据 DPI 缩放推算，此处改为后端从系统拿权威值。

    返回 (width_mm, height_mm)；非 Windows 或读取失败返回 None。
    """
    if os.name != "nt":
        return None
    try:
        import ctypes
        user32 = ctypes.windll.user32
        gdi32 = ctypes.windll.gdi32
        user32.GetDC.restype = ctypes.c_void_p
        user32.GetDC.argtypes = [ctypes.c_void_p]
        user32.ReleaseDC.restype = ctypes.c_int
        user32.ReleaseDC.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        gdi32.GetDeviceCaps.restype = ctypes.c_int
        gdi32.GetDeviceCaps.argtypes = [ctypes.c_void_p, ctypes.c_int]
        hdc = user32.GetDC(0)
        if not hdc:
            return None
        try:
            width_mm = gdi32.GetDeviceCaps(hdc, 4)   # HORZSIZE
            height_mm = gdi32.GetDeviceCaps(hdc, 6)  # VERTSIZE
        finally:
            user32.ReleaseDC(0, hdc)
        if width_mm > 0 and height_mm > 0:
            return float(width_mm), float(height_mm)
        return None
    except Exception:
        return None


def safe_int(value, default):
    try:
        return int(str(value).strip())
    except Exception:
        return int(default)


DEFAULT_SDK_MODEL = os.getenv("MRT_SDK_MODEL", "Pro").strip() or "Pro"
DEFAULT_DEVICE_TYPE = "桌面式"
VIDEO_RECORD_FPS_OPTIONS = (15.0, 30.0, 60.0)
# aSeeGlasses Plus 场景摄像头（1280x720）硬件固定输出 60fps 的 HEVC 编码流。
# 编码流录制走裸 HEVC 封装（无时间戳），ffmpeg 必须用真实帧率生成 PTS，
# 不能用 video_sampling_rate_hz（凝视采样率/桌面屏幕录制帧率的语义，默认 30）。
GLASSES_SCENE_FPS = 60.0
SERVER_BIND_RETRY_MAX = safe_int(os.getenv("MRT_SERVER_BIND_RETRY_MAX", "8"), 8)
SERVER_BIND_RETRY_DELAY_SEC = 1.5
DESKTOP_SDK_MODELS = {"Pro", "A8"}
DEVICE_TYPE_TO_MODEL = {
    "桌面式": "Pro",
    "眼镜式": "aSeeGlassesPlus",
}
MODEL_TO_DEVICE_TYPE = {
    "Pro": "桌面式",
    "A8": "桌面式",
    "aSeeGlassesPlus": "眼镜式",
}
SCRIPT_PATH = Path(__file__).resolve()


class FfmpegRawVideoWriter:
    """Small VideoWriter-compatible adapter for one-pass H.264 encoding.

    Windows OpenCV wheels usually fall back to mp4v, which forces a second
    full-video transcode at stop time. Feeding raw BGR frames to the bundled
    ffmpeg keeps capture and final output in one pipeline.
    """

    def __init__(self, ffmpeg_path, output_path, width, height, fps):
        self.process = None
        self.opened = False
        self.last_error = ""
        cmd = [
            ffmpeg_path,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgr24",
            "-video_size",
            f"{int(width)}x{int(height)}",
            "-framerate",
            f"{float(fps):g}",
            "-i",
            "pipe:0",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-crf",
            "21",
            "-vf",
            "pad=ceil(iw/2)*2:ceil(ih/2)*2",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            output_path,
        ]
        run_kwargs = {
            "stdin": subprocess.PIPE,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "bufsize": 0,
        }
        if os.name == "nt":
            try:
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startupinfo.wShowWindow = 0
                run_kwargs["startupinfo"] = startupinfo
                run_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            except Exception:
                pass
        try:
            self.process = subprocess.Popen(cmd, **run_kwargs)
            self.opened = self.process.poll() is None and self.process.stdin is not None
        except Exception as error:
            self.last_error = str(error)
            self.process = None

    def isOpened(self):
        return bool(self.opened and self.process and self.process.poll() is None and self.process.stdin)

    def write(self, frame):
        if not self.isOpened():
            raise RuntimeError(self.last_error or "ffmpeg H.264 encoder is not running")
        try:
            contiguous = np.ascontiguousarray(frame, dtype=np.uint8)
            write_all(self.process.stdin, contiguous)
        except Exception as error:
            self.opened = False
            self.last_error = str(error)
            raise RuntimeError(f"ffmpeg H.264 frame write failed: {error}") from error

    def release(self):
        process = self.process
        self.opened = False
        if not process:
            return
        try:
            if process.stdin:
                process.stdin.close()
        except Exception:
            pass
        try:
            process.wait(timeout=15.0)
        except subprocess.TimeoutExpired:
            try:
                process.kill()
            except Exception:
                pass
            try:
                process.wait(timeout=2.0)
            except Exception:
                pass
            self.last_error = "ffmpeg H.264 encoder finalize timeout"
        except Exception as error:
            self.last_error = str(error)
        if process.returncode not in (0, None) and not self.last_error:
            self.last_error = f"ffmpeg H.264 encoder exited with code {process.returncode}"


class SDKService:
    def __init__(self):
        self.sdk = None
        self.loop = None
        self.image_queue = asyncio.Queue(maxsize=4)
        self.encoded_video_queue = asyncio.Queue(maxsize=16)
        # Keep only latest eye packet to avoid backlog-induced lag on UI.
        self.eye_queue = asyncio.Queue(maxsize=1)
        self.notify_queue = asyncio.Queue()
        self.py_status_cb = None
        self.py_image_cb = None
        self.py_gaze_cb = None
        self.py_point_process_cb = None
        self.py_point_finish_cb = None
        self.finish_event = threading.Event()
        self.image_frame_count = 0
        self.last_image_log_time = 0.0
        self.image_clients = 0
        self.encoded_video_clients = 0
        self.encoded_video_frame_count = 0
        self.last_encoded_video_log_time = 0.0
        self.encoded_video_seq = 0
        self.encoded_video_reset_seq = 0
        self.encoded_video_wait_for_keyframe = False
        self.last_encoded_wait_keyframe_log_time = 0.0
        self.stream_decode_wait_for_keyframe = False
        self.last_stream_decode_wait_keyframe_log_time = 0.0
        self.image_decode_error_count = 0
        self.last_image_error_log_time = 0.0
        self.image_callback_called_count = 0
        self.last_image_callback_log_time = 0.0
        self.last_image_enqueue_time = 0.0
        self.last_image_enqueue_time_by_role = {}
        self.last_stream_record_frame_time_by_role = {}
        self.last_gaze_log_time = 0.0
        self.last_eye_broadcast_time = 0.0
        self.exit_calibration = False
        self.calibration_active = False
        self.last_calibration_stop_tracking_result = None
        self.types = None
        self.started = False
        self.sdk_root = None
        self.config_dir = None
        self.types_dir = None
        self.pwd_source = "unknown"
        self.tracking_active = False
        self.device_type = DEFAULT_DEVICE_TYPE
        self.sdk_model = self._normalize_model_name(os.getenv("MRT_SDK_MODEL", DEFAULT_SDK_MODEL))
        self.preferred_desktop_sdk_model = self.sdk_model if self.sdk_model in DESKTOP_SDK_MODELS else "Pro"
        self.driver = None
        self._set_driver(self.sdk_model, self.device_type)

        # Recording state
        self.record_lock = threading.Lock()
        self.record_finalize_lock = threading.Lock()
        self.is_recording = False
        self.recording_finalizing = False
        self.record_finalize_thread = None
        self.record_finalize_last_result = None
        self.video_writer = None
        self.csv_file = None
        self.csv_writer = None
        self.video_path = ""
        self.video_actual_path = ""
        self.csv_path = ""
        self.record_dir = ""
        self.last_recording_error = ""
        self.record_start_time = 0
        self.record_start_perf = 0.0
        self.record_timeline_ready = False
        self.record_first_sample_elapsed_ms = None
        self.record_thread = None
        self.record_start_ready = threading.Event()
        self.record_start_success = False
        self.current_stimulus = ""
        self.current_subject_name = ""
        self.current_record_name = ""
        self.chosen_codec = None
        self.record_source = "screen"
        self.record_capture_display = None
        self.record_split_screen = False
        self.record_target_fps = 30.0
        self.record_written_frames = 0
        self.record_captured_frames = 0
        self.encoded_record_lock = threading.Lock()
        self.encoded_record_queue = None
        self.encoded_record_process = None
        self.encoded_record_active = False
        self.encoded_record_started = False
        self.encoded_record_failed = False
        self.encoded_record_stop_event = threading.Event()
        self.encoded_record_packet_count = 0
        self.encoded_record_written_bytes = 0
        self.encoded_record_dropped_packets = 0
        self.encoded_record_keyframe_count = 0
        self.encoded_record_width = 0
        self.encoded_record_height = 0
        self.encoded_record_last_log_time = 0.0
        self.encoded_record_last_wait_log_time = 0.0
        self.encoded_record_ffmpeg = ""
        self.h265_parameter_sets = {}
        self.stream_frame_lock = threading.Lock()
        self.latest_stream_frame = None
        self.latest_stream_frame_seq = 0
        self.stream_video_reset_seq = 0
        self.scene_frame_width = 1280
        self.scene_frame_height = 720
        self.device_started_at = 0.0
        self.glasses_scene_eye_id = None
        self.glasses_fallback_eye_id = None
        self.glasses_scene_locked = False
        self.glasses_dropped_non_scene_count = 0
        self.last_glasses_drop_log_time = 0.0
        self.glasses_rejected_scene_frame_count = 0
        self.last_glasses_reject_log_time = 0.0
        self.glasses_published_scene_frame_count = 0
        self.last_glasses_publish_log_time = 0.0
        # 眼镜启动卡顿诊断：场景帧到达统计（反映眼镜场景摄像头出流速率）。
        self.glasses_scene_arrival_count = 0
        self.glasses_scene_first_frame_at = 0.0
        self.glasses_scene_last_frame_at = 0.0
        self.glasses_scene_max_gap_ms = 0.0
        self.glasses_scene_metric_start_at = 0.0
        self.glasses_scene_metric_count = 0
        self.glasses_scene_metric_max_gap_ms = 0.0
        self.glasses_last_good_scene_frame = None
        self.glasses_last_good_scene_preview = None
        self.glasses_last_good_scene_mime = "image/jpeg"
        self.glasses_last_good_scene_size = (0, 0)
        self.glasses_fixation_candidate = None
        self.glasses_fixation_sequence = 0
        self.glasses_fixation_radius_px = max(1.0, self._env_float("MRT_GLASSES_FIXATION_RADIUS_PX", 35.0))
        self.glasses_fixation_min_duration_us = int(max(1.0, self._env_float("MRT_GLASSES_FIXATION_MIN_DURATION_MS", 100.0)) * 1000.0)
        self.glasses_fixation_min_samples = max(2, int(self._env_float("MRT_GLASSES_FIXATION_MIN_SAMPLES", 6.0)))

        # Recording markers (for custom markers and triggers)
        self.recording_markers = []  # List of {type, name/triggerValue, timestamp, videoTime}
        self.recording_markers_emitted = set()  # Indices of already-emitted markers (avoids mutating marker dicts)
        self.recording_markers_lock = threading.Lock()  # Protects recording_markers and recording_markers_emitted
        self.csv_flush_counter = 0  # Periodic CSV flush counter
        self.csv_flush_interval = 60  # Flush CSV every N rows
        
        # Trigger hardware integration (placeholder for future implementation)
        # Note: The current eye-tracking SDK does not provide built-in trigger signal reception.
        # To integrate external trigger hardware, implement one of the following approaches:
        #
        # 1. Parallel Port (LPT) Integration:
        #    - Use pyparallel or inpout32 library to read TTL signals
        #    - Monitor port status in a separate thread
        #    - Call self.on_trigger_received(trigger_value) when signal detected
        #
        # 2. Serial Port (COM) Integration:
        #    - Use pyserial library to read from serial trigger device
        #    - Parse incoming trigger commands
        #    - Call self.on_trigger_received(trigger_value) with parsed value
        #
        # 3. USB Trigger Device Integration:
        #    - Use device-specific Python library (e.g., pyusb)
        #    - Implement device communication protocol
        #    - Call self.on_trigger_received(trigger_value) on trigger events
        #
        # 4. Network Trigger Integration:
        #    - Listen on a UDP/TCP port for trigger signals from stimulus software
        #    - Parse network packets for trigger values
        #    - Call self.on_trigger_received(trigger_value) when received
        #
        # 5. Future SDK Trigger Callback:
        #    - If SDK adds trigger support, register callback similar to gaze_callback
        #    - Callback should invoke self.on_trigger_received(trigger_value)
        #
        # Example implementation structure (commented out):
        # self.trigger_enabled = False
        # self.trigger_thread = None
        # self.trigger_port = None  # For serial/parallel port
        self.trigger_enabled = False  # Set to True when trigger hardware is configured

    def _env_float(self, name, default):
        try:
            return float(os.getenv(name, str(default)))
        except Exception:
            return float(default)

    def _normalize_model_name(self, model_name):
        return normalize_model_name(model_name)

    def _normalize_device_type(self, device_type):
        return normalize_device_type(device_type)

    def _model_from_device_type(self, device_type):
        return model_from_device_type(device_type, getattr(self, "preferred_desktop_sdk_model", "Pro"))

    def _record_source_from_device_type(self, device_type):
        return record_source_from_device_type(device_type)

    def _is_glasses_mode(self):
        return self._normalize_device_type(self.device_type) == "眼镜式"

    def _reset_stream_video_decoder(self, reason="", encoded_stream_discontinuity=True):
        try:
            if self.driver is not None and hasattr(self.driver, "reset_video_decoder"):
                self.driver.reset_video_decoder()
        except Exception as e:
            log("stream video frame cache reset failed", reason, str(e))
        with self.stream_frame_lock:
            self.latest_stream_frame = None
            self.latest_stream_frame_seq = 0
            self.stream_video_reset_seq += 1
            self.stream_decode_wait_for_keyframe = True
            if encoded_stream_discontinuity:
                self.encoded_video_reset_seq += 1
                self.encoded_video_wait_for_keyframe = True
        self.last_stream_record_frame_time_by_role = {}
        try:
            log("stream video frame cache reset", reason, "seq", self.stream_video_reset_seq)
        except Exception:
            pass

    def _is_usable_glasses_scene_frame(self, frame_obj, strict=False):
        try:
            if frame_obj is None or getattr(frame_obj, "size", 0) <= 0:
                return False
            if len(frame_obj.shape) == 3:
                gray = cv2.cvtColor(frame_obj, cv2.COLOR_BGR2GRAY)
            else:
                gray = frame_obj
            if gray.size <= 0 or np.count_nonzero(gray) == 0:
                return False

            mean_val = float(np.mean(gray))
            std_val = float(np.std(gray))
            if mean_val <= 0.5 or mean_val >= 254.5 or std_val < 0.25:
                return False
            if strict and 96.0 <= mean_val <= 160.0 and std_val < 3.5:
                return False

            near_white_ratio = float(np.mean(gray >= 248))
            near_black_ratio = float(np.mean(gray <= 6))
            if near_white_ratio > 0.72:
                return False
            if near_white_ratio > 0.55 and near_black_ratio > 0.08:
                return False

            small = cv2.resize(gray, (160, 90), interpolation=cv2.INTER_AREA)
            small_i16 = small.astype(np.int16)
            if small_i16.shape[1] > 1 and small_i16.shape[0] > 1:
                h_noise = float(np.mean(np.abs(small_i16[:, 1:] - small_i16[:, :-1])))
                v_noise = float(np.mean(np.abs(small_i16[1:, :] - small_i16[:-1, :])))
                hf_noise = (h_noise + v_noise) * 0.5
                if hf_noise >= (46.0 if strict else 62.0):
                    return False

            if strict:
                white_mask = (gray >= 248).astype(np.uint8)
                if white_mask.size > 0:
                    kernel = np.ones((3, 3), np.uint8)
                    opened = cv2.morphologyEx(white_mask, cv2.MORPH_OPEN, kernel)
                    isolated_white_ratio = float(np.mean((white_mask > 0) & (opened == 0)))
                    if isolated_white_ratio >= 0.001:
                        return False
                    if near_white_ratio >= 0.08 and isolated_white_ratio >= 0.00035:
                        return False
            return True
        except Exception:
            return False

    def _glasses_scene_frame_metrics(self, frame_obj):
        metrics = {
            "mean": 0.0,
            "std": 0.0,
            "white": 0.0,
            "black": 0.0,
            "hf": 0.0,
        }
        try:
            if frame_obj is None or getattr(frame_obj, "size", 0) <= 0:
                return metrics
            if len(frame_obj.shape) == 3:
                gray = cv2.cvtColor(frame_obj, cv2.COLOR_BGR2GRAY)
            else:
                gray = frame_obj
            if gray.size <= 0:
                return metrics
            metrics["mean"] = round(float(np.mean(gray)), 3)
            metrics["std"] = round(float(np.std(gray)), 3)
            metrics["white"] = round(float(np.mean(gray >= 248)), 6)
            metrics["black"] = round(float(np.mean(gray <= 6)), 6)
            small = cv2.resize(gray, (160, 90), interpolation=cv2.INTER_AREA)
            small_i16 = small.astype(np.int16)
            if small_i16.shape[1] > 1 and small_i16.shape[0] > 1:
                h_noise = float(np.mean(np.abs(small_i16[:, 1:] - small_i16[:, :-1])))
                v_noise = float(np.mean(np.abs(small_i16[1:, :] - small_i16[:-1, :])))
                metrics["hf"] = round((h_noise + v_noise) * 0.5, 3)
        except Exception:
            pass
        return metrics

    def _log_glasses_scene_frame_reject(self, reason, eye_id, width, height, frame_obj=None):
        try:
            self.glasses_rejected_scene_frame_count += 1
            now = time.time()
            if self.glasses_rejected_scene_frame_count <= 3 or (now - self.last_glasses_reject_log_time) >= 5.0:
                self.last_glasses_reject_log_time = now
                m = self._glasses_scene_frame_metrics(frame_obj)
                log(
                    "glasses scene frame rejected",
                    "reason=", reason,
                    "count=", self.glasses_rejected_scene_frame_count,
                    "eye=", eye_id,
                    "w=", width,
                    "h=", height,
                    "mean=", m.get("mean"),
                    "std=", m.get("std"),
                    "white=", m.get("white"),
                    "black=", m.get("black"),
                    "hf=", m.get("hf"),
                )
        except Exception:
            pass

    def _log_glasses_scene_frame_publish(self, eye_id, width, height, frame_obj=None, encoded_len=0, mime=""):
        try:
            self.glasses_published_scene_frame_count += 1
            now = time.time()
            if self.glasses_published_scene_frame_count <= 3 or (now - self.last_glasses_publish_log_time) >= 5.0:
                self.last_glasses_publish_log_time = now
                m = self._glasses_scene_frame_metrics(frame_obj)
                log(
                    "glasses scene frame published",
                    "count=", self.glasses_published_scene_frame_count,
                    "eye=", eye_id,
                    "w=", width,
                    "h=", height,
                    "mime=", mime,
                    "encoded=", encoded_len,
                    "mean=", m.get("mean"),
                    "std=", m.get("std"),
                    "white=", m.get("white"),
                    "black=", m.get("black"),
                    "hf=", m.get("hf"),
                )
        except Exception:
            pass

    def _track_glasses_scene_arrival(self, eye_id, width, height):
        # 眼镜启动卡顿诊断：统计场景帧到达速率与最大间隔。
        # 首帧记录相对 device_started_at 的延迟；之后每 2 秒输出 fps + 最大帧间隔。
        # 该统计在场景帧被识别后立即执行，早于任何下游消费/丢弃判断，
        # 因此能反映眼镜场景摄像头本身的出流速率，与前端解码/渲染无关。
        try:
            now = time.time()
            if self.glasses_scene_first_frame_at == 0.0:
                self.glasses_scene_first_frame_at = now
                delay_ms = ((now - self.device_started_at) * 1000.0) if self.device_started_at > 0 else -1.0
                log(
                    "glasses-startup:first-scene-frame",
                    "delay_ms_since_device_start=", round(delay_ms, 1),
                    "eye=", eye_id,
                    "w=", width,
                    "h=", height,
                )
            if self.glasses_scene_last_frame_at > 0:
                gap_ms = (now - self.glasses_scene_last_frame_at) * 1000.0
                self.glasses_scene_max_gap_ms = max(self.glasses_scene_max_gap_ms, gap_ms)
                self.glasses_scene_metric_max_gap_ms = max(self.glasses_scene_metric_max_gap_ms, gap_ms)
            self.glasses_scene_last_frame_at = now
            self.glasses_scene_arrival_count += 1
            self.glasses_scene_metric_count += 1
            if self.glasses_scene_metric_start_at == 0.0:
                self.glasses_scene_metric_start_at = now
                return
            if (now - self.glasses_scene_metric_start_at) >= 2.0:
                window_s = now - self.glasses_scene_metric_start_at
                fps = self.glasses_scene_metric_count / window_s if window_s > 0 else 0.0
                since_start_s = (now - self.device_started_at) if self.device_started_at > 0 else -1.0
                log(
                    "glasses-startup:scene-frame-metrics",
                    "fps=", round(fps, 1),
                    "frames=", self.glasses_scene_metric_count,
                    "max_gap_ms=", round(self.glasses_scene_metric_max_gap_ms, 1),
                    "total=", self.glasses_scene_arrival_count,
                    "since_start_s=", round(since_start_s, 1),
                )
                self.glasses_scene_metric_start_at = now
                self.glasses_scene_metric_count = 0
                self.glasses_scene_metric_max_gap_ms = 0.0
        except Exception:
            pass

    def _sync_driver_refs(self):
        if self.driver is None:
            self.sdk = None
            self.types = None
            self.sdk_root = None
            self.config_dir = None
            self.types_dir = None
            self.py_status_cb = None
            self.py_image_cb = None
            self.py_gaze_cb = None
            self.py_point_process_cb = None
            self.py_point_finish_cb = None
            return
        self.sdk = getattr(self.driver, "sdk", None)
        self.types = getattr(self.driver, "types", None)
        self.sdk_root = getattr(self.driver, "sdk_root", None)
        self.config_dir = getattr(self.driver, "config_dir", None)
        self.types_dir = getattr(self.driver, "types_dir", None)
        self.py_status_cb = getattr(self.driver, "py_status_cb", None)
        self.py_image_cb = getattr(self.driver, "py_image_cb", None)
        self.py_gaze_cb = getattr(self.driver, "py_gaze_cb", None)
        self.py_point_process_cb = getattr(self.driver, "py_point_process_cb", None)
        self.py_point_finish_cb = getattr(self.driver, "py_point_finish_cb", None)

    def _set_driver(self, model_name, device_type=None):
        previous_model = getattr(self, "sdk_model", None)
        normalized_model = self._normalize_model_name(model_name)
        normalized_device_type = self._normalize_device_type(device_type or MODEL_TO_DEVICE_TYPE.get(normalized_model, DEFAULT_DEVICE_TYPE))
        if normalized_model in DESKTOP_SDK_MODELS:
            self.preferred_desktop_sdk_model = normalized_model
        self.sdk_model = normalized_model
        self.device_type = normalized_device_type
        # When model changes in-process (Pro <-> aSeeGlassesPlus), startup env overrides
        # may still point to previous model paths. Clear these so driver can rescan.
        if previous_model and previous_model != normalized_model:
            try:
                os.environ.pop("MRT_SDK_ROOT", None)
                os.environ.pop("MRT_TYPES_DIR", None)
                log("cleared sdk env overrides due to model switch", "from", previous_model, "to", normalized_model)
            except Exception:
                pass
        self.driver = create_sdk_driver(self.sdk_model, SCRIPT_PATH, log)
        self.pwd_source = "unknown"
        self.started = False
        self.tracking_active = False
        self.calibration_active = False
        os.environ["MRT_SDK_MODEL"] = self.sdk_model
        self._sync_driver_refs()
        log("sdk driver ready", "device_type", self.device_type, "model", self.sdk_model)

    def ensure_model(self, device_type=None, model_name=None):
        if model_name is not None and str(model_name).strip() != "":
            desired_model = self._normalize_model_name(model_name)
            normalized_device_type = self._normalize_device_type(device_type or MODEL_TO_DEVICE_TYPE.get(desired_model, DEFAULT_DEVICE_TYPE))
        elif device_type is None or str(device_type).strip() == "":
            desired_device_type = self.device_type or DEFAULT_DEVICE_TYPE
            desired_model, normalized_device_type = self._model_from_device_type(desired_device_type)
        else:
            desired_device_type = self._normalize_device_type(device_type)
            desired_model, normalized_device_type = self._model_from_device_type(desired_device_type)
        if self.driver is None:
            self._set_driver(desired_model, normalized_device_type)
            return
        if desired_model == self.sdk_model:
            self.device_type = normalized_device_type
            return
        log("switch sdk model", "from", self.sdk_model, "to", desired_model, "device_type", normalized_device_type)
        if self.started or self.sdk is not None:
            self.stop_device()
        self._set_driver(desired_model, normalized_device_type)

    def find_paths(self):
        if self.driver is None:
            self._set_driver(self.sdk_model, self.device_type)
        self.driver.find_paths()
        self._sync_driver_refs()

    def load(self):
        if self.driver is None:
            self._set_driver(self.sdk_model, self.device_type)
        self.driver.load(
            self.camera_state_callback,
            self.image_callback,
            self.gaze_callback,
            self.point_process_callback,
            self.point_finish_callback,
        )
        self._sync_driver_refs()
        log("callbacks bound", "model", self.sdk_model)

    def bind_loop(self, loop):
        self.loop = loop
        log("loop bound")

    def _read_pwd_from_ini(self, ini_path):
        cf = ConfigParser()
        loaded = cf.read(str(ini_path), encoding="utf-8")
        if not loaded:
            raise RuntimeError(f"config.ini_not_found: {ini_path}")
        if not cf.has_section("softdog"):
            raise RuntimeError(f"config.ini_missing_section_softdog: {ini_path}")
        pwd = str(cf.get("softdog", "pwd", fallback="") or "").strip()
        if not pwd:
            raise RuntimeError(f"config.ini_softdog_pwd_empty: {ini_path}")
        return pwd

    def _fallback_pwd_ini_candidates(self):
        candidates = []
        env_ini = str(os.getenv("MRT_SOFTDOG_INI_PATH", "") or "").strip()
        if env_ini:
            candidates.append(Path(env_ini))
        env_sdk_root = str(os.getenv("MRT_SDK_ROOT", "") or "").strip()
        if env_sdk_root:
            candidates.append(Path(env_sdk_root) / "config.ini")
        here = Path(__file__).resolve()
        rels = [
            Path("SDK/invensun_7/Pro/bin/windows/x64/Pro200_Release/config.ini"),
            Path("invensun_7/Pro/bin/windows/x64/Pro200_Release/config.ini"),
        ]
        for p in [here.parent, *here.parents]:
            for rel in rels:
                candidates.append((p / rel).resolve())
        # Deduplicate while preserving order.
        out = []
        seen = set()
        for c in candidates:
            try:
                k = str(c).lower() if os.name == "nt" else str(c)
            except Exception:
                k = str(c)
            if k in seen:
                continue
            seen.add(k)
            out.append(c)
        return out

    def read_pwd(self):
        env_pwd = os.getenv("MRT_SOFTDOG_PWD", "").strip()
        if env_pwd:
            self.pwd_source = "env:MRT_SOFTDOG_PWD"
            log("read softdog pwd from env", "pwd length", len(env_pwd))
            return env_pwd.encode("utf-8")

        if self.driver is None:
            self._set_driver(self.sdk_model, self.device_type)
        if self.driver.config_ini is None:
            self.find_paths()
        ini = self.driver.config_ini

        if self.sdk_model == "aSeeGlassesPlus":
            return self._read_glasses_pwd(ini)

        # Desktop modes (Pro) require a valid password from their own config.ini.
        if ini is None:
            raise RuntimeError("config_ini_not_found")
        pwd = self._read_pwd_from_ini(Path(ini))
        self.pwd_source = str(ini)
        log("read config.ini", str(ini))
        return pwd.encode("utf-8")

    def _read_glasses_pwd(self, ini):
        # Glasses mode (aSeeGlassesPlus) must use its own config.ini password.
        # Never fall back to the desktop (Pro/A8) password by default: doing so
        # makes the vendor SDK validate against the wrong softdog and pop the
        # desktop "Pro" activation dialog instead of the glasses dialog.
        candidates = []
        if ini is not None:
            candidates.append(Path(ini))
        fallback_raw = str(os.getenv("MRT_ALLOW_DESKTOP_PWD_FALLBACK_FOR_GLASSES", "")).strip().lower()
        if fallback_raw in {"1", "true", "yes", "on"}:
            candidates.extend(self._fallback_pwd_ini_candidates())

        pwd = ""
        for candidate in candidates:
            try:
                log("read config.ini", str(candidate))
                pwd = self._read_pwd_from_ini(candidate)
                self.pwd_source = str(candidate)
                break
            except Exception as e:
                log("read config.ini skipped", str(candidate), str(e))
                continue

        if not pwd:
            # An empty password lets the vendor SDK pop its own glasses
            # activation dialog (where the user enters the glasses key) instead
            # of failing with a softdog error or falling back to the Pro key.
            self.pwd_source = "glasses:empty"
        return pwd.encode("utf-8")

    def handle_path(self, raw_path, create_dir: bool = False, create_parent: bool = False):
        """
        Normalize and validate a file-system path with UTF-8 safety checks.
        """
        try:
            if raw_path is None:
                raise ValueError("path is empty")
            if isinstance(raw_path, Path):
                path_obj = raw_path
            else:
                path_text = str(raw_path).strip()
                if not path_text:
                    raise ValueError("path is empty")
                path_obj = Path(path_text)

            # Validate that the path can be round-tripped in UTF-8 (for Chinese paths).
            normalized_text = str(path_obj)
            _ = normalized_text.encode("utf-8").decode("utf-8")

            path_obj = path_obj.expanduser()

            if create_parent:
                path_obj.parent.mkdir(parents=True, exist_ok=True)
            if create_dir:
                path_obj.mkdir(parents=True, exist_ok=True)

            return path_obj
        except Exception as e:
            log("handle_path error", "input=", repr(raw_path), "error=", str(e))
            raise

    def _windows_short_path(self, raw_path: str) -> str:
        if os.name != "nt":
            return raw_path
        try:
            abs_path = os.path.abspath(raw_path)
            kernel32 = windll.kernel32
            get_short = kernel32.GetShortPathNameW
            buffer = create_unicode_buffer(32768)
            ret = get_short(c_wchar_p(abs_path), buffer, len(buffer))
            if ret <= 0 or ret >= len(buffer):
                return raw_path
            short_path = buffer.value
            return short_path or raw_path
        except Exception:
            return raw_path

    def _has_non_ascii(self, text: str) -> bool:
        try:
            return not str(text or "").isascii()
        except Exception:
            return True

    def _is_h264_like_codec(self, codec: str) -> bool:
        cc = str(codec or "").strip().lower()
        return cc in ("h264", "avc1", "x264")

    def _get_windows_ascii_temp_dir(self) -> Path:
        candidates = []
        public_root = os.environ.get("PUBLIC", "").strip()
        if public_root:
            candidates.append(Path(public_root) / "Documents" / "MRT_Recordings_Temp")
        candidates.append(Path("C:/Users/Public/Documents/MRT_Recordings_Temp"))
        candidates.append(Path.cwd() / "recordings_tmp")

        for candidate in candidates:
            try:
                candidate.mkdir(parents=True, exist_ok=True)
                return candidate
            except Exception:
                continue
        return Path.cwd()

    def _resolve_windows_video_writer_path(self, desired_path: str) -> str:
        if os.name != "nt":
            return desired_path
        try:
            vp = Path(desired_path)
            short_parent = self._windows_short_path(str(vp.parent))
            if short_parent and short_parent != str(vp.parent):
                return str(Path(short_parent) / vp.name)
            if not self._has_non_ascii(str(vp)):
                return str(vp)
            temp_dir = self._get_windows_ascii_temp_dir()
            vp_hash = hashlib.sha1(str(vp).encode("utf-8", errors="ignore")).hexdigest()[:12]
            temp_name = f"rec_{vp_hash}_{int(time.time() * 1000)}.mp4"
            fallback_path = temp_dir / temp_name
            log("video writer path fallback", "desired=", str(vp), "fallback=", str(fallback_path))
            return str(fallback_path)
        except Exception as e:
            log("resolve writer path exception", str(e))
            return desired_path

    def _finalize_video_output_path(self):
        try:
            target = Path(self.video_path) if self.video_path else None
            actual = Path(self.video_actual_path) if self.video_actual_path else (target if target else None)
            if not actual:
                return
            if not actual.exists():
                return
            if not target:
                self.video_path = str(actual)
                self.video_actual_path = str(actual)
                return
            try:
                same = actual.resolve() == target.resolve()
            except Exception:
                same = str(actual) == str(target)
            if same:
                self.video_actual_path = str(target)
                return

            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                try:
                    target.unlink()
                except Exception:
                    pass
            try:
                shutil.move(str(actual), str(target))
            except Exception:
                shutil.copy2(str(actual), str(target))
                try:
                    actual.unlink()
                except Exception:
                    pass
            self.video_actual_path = str(target)
            log("video moved to target path", "from=", str(actual), "to=", str(target))
        except Exception as e:
            log("finalize video output failed", str(e))

    def start_device(self):
        if self.driver is None:
            self._set_driver(self.sdk_model, self.device_type)
        self.ensure_loaded()
        self.exit_calibration = False
        password = self.read_pwd() if self.driver.requires_softdog_password else b""
        if not self.driver.requires_softdog_password:
            self.pwd_source = "not-required"
        ret = self.driver.start_device(password)
        if ret == 0:
            self.started = True
            self.tracking_active = False
            self.device_started_at = time.time()
            self.glasses_scene_eye_id = None
            self.glasses_fallback_eye_id = None
            self.glasses_scene_locked = False
            self.glasses_last_good_scene_frame = None
            self.glasses_last_good_scene_preview = None
            self.glasses_last_good_scene_mime = "image/jpeg"
            self.glasses_last_good_scene_size = (0, 0)
            # 重置启动诊断统计，确保每次启动从 0 开始计时。
            self.glasses_scene_arrival_count = 0
            self.glasses_scene_first_frame_at = 0.0
            self.glasses_scene_last_frame_at = 0.0
            self.glasses_scene_max_gap_ms = 0.0
            self.glasses_scene_metric_start_at = 0.0
            self.glasses_scene_metric_count = 0
            self.glasses_scene_metric_max_gap_ms = 0.0
            self._sync_driver_refs()
        log("start_device ret", ret, "model", self.sdk_model, "device_type", self.device_type)
        return ret

    def stop_device(self):
        errors = []
        ret_code = 0

        if self.calibration_active and self.driver is not None:
            try:
                self.driver.cancel_calibration()
                self.driver.end_calibration()
            except Exception as e:
                errors.append(f"end calibration exception: {e}")
            self.calibration_active = False

        # Stop active recording first to flush CSV/video and persist metadata.
        try:
            if self.is_recording:
                ret_record = self.stop_recording()
                if ret_record != 0:
                    errors.append(f"stop_recording={ret_record}")
        except Exception as e:
            errors.append(f"stop_recording exception: {e}")

        # Fail-safe resource release.
        try:
            if self.video_writer is not None:
                self.video_writer.release()
                self.video_writer = None
        except Exception as e:
            errors.append(f"video_writer release exception: {e}")

        try:
            if self.csv_file:
                try:
                    self.csv_file.flush()
                except Exception:
                    pass
                self.csv_file.close()
            self.csv_file = None
            self.csv_writer = None
        except Exception as e:
            errors.append(f"csv close exception: {e}")

        try:
            self._signal_encoded_stream_recording_stop()
        except Exception as e:
            errors.append(f"encoded recording stop signal exception: {e}")

        try:
            if self.record_thread and self.record_thread.is_alive():
                self.is_recording = False
                self.record_thread.join(timeout=2.0)
            self.record_thread = None
            with self.stream_frame_lock:
                self.latest_stream_frame = None
                self.latest_stream_frame_seq = 0
        except Exception as e:
            errors.append(f"record thread join exception: {e}")

        # Stop tracking if SDK supports it.
        try:
            if self.driver is not None:
                ret_tracking = self.driver.stop_tracking()
                if ret_tracking not in (0, None):
                    errors.append(f"_7i_stop_tracking={ret_tracking}")
        except Exception as e:
            errors.append(f"_7i_stop_tracking exception: {e}")

        # Stop SDK device.
        try:
            if self.driver is not None:
                ret = self.driver.stop_sdk()
                if ret not in (0, None):
                    ret_code = ret
                    errors.append(f"_7i_stop={ret}")
        except Exception as e:
            if ret_code == 0:
                ret_code = -1
            errors.append(f"_7i_stop exception: {e}")

        # A8 桌面式眼动仪在 _7i_stop 后需要约 2 秒让设备完成复位；若紧接着
        # 立即 start，gazepre 标定会与「尚未完成复位」的设备状态竞争，导致标定
        # 静默失效、校准得分 0（用户实测：停止后立刻启动必失败，慢约 1 秒即正常）。
        # Pro/眼镜无此复位需求；若无条件 sleep 会让 Pro 的 stop 耗时超 2 秒，
        # 超过前端 1200ms 超时，导致 stop 超时后立即 start 的竞态，重开设备打不开。
        # 故复位延迟仅对 A8 生效。
        if self.sdk_model == "A8":
            time.sleep(2.0)

        # Disconnect SDK device (best effort).
        try:
            if self.driver is not None:
                ret_disconnect = self.driver.disconnect()
                if ret_disconnect not in (0, None):
                    errors.append(f"_7i_device_disconnect={ret_disconnect}")
        except Exception as e:
            errors.append(f"_7i_device_disconnect exception: {e}")
        try:
            if self.driver is not None:
                self.driver.cleanup()
        except Exception as e:
            errors.append(f"driver_cleanup exception: {e}")

        self.started = False
        self.tracking_active = False
        self.calibration_active = False
        self.device_started_at = 0.0
        self.glasses_scene_eye_id = None
        self.glasses_fallback_eye_id = None
        self.glasses_scene_locked = False
        self.glasses_last_good_scene_frame = None
        self.glasses_last_good_scene_preview = None
        self.glasses_last_good_scene_mime = "image/jpeg"
        self.glasses_last_good_scene_size = (0, 0)
        self._sync_driver_refs()

        if errors:
            log("stop_device completed with warnings", "; ".join(errors))
        else:
            log("stop_device completed successfully")
        return ret_code

    def camera_state_callback(self, state, ctx=None, *args):
        try:
            state_int = int(state)
        except Exception:
            state_int = state
        try:
            log("camera_state", state_int, "model", self.sdk_model, "device_type", self.device_type)
        except Exception:
            pass

    def _iter_annexb_nals(self, payload: bytes):
        try:
            size = len(payload)
            i = 0
            while i + 3 < size:
                start = -1
                start_len = 0
                j = i
                while j + 3 < size:
                    if payload[j] == 0 and payload[j + 1] == 0 and payload[j + 2] == 1:
                        start = j
                        start_len = 3
                        break
                    if j + 4 < size and payload[j] == 0 and payload[j + 1] == 0 and payload[j + 2] == 0 and payload[j + 3] == 1:
                        start = j
                        start_len = 4
                        break
                    j += 1
                if start < 0:
                    return
                nal_start = start + start_len
                next_start = size
                j = nal_start
                while j + 3 < size:
                    if payload[j] == 0 and payload[j + 1] == 0 and (
                        payload[j + 2] == 1 or (j + 4 < size and payload[j + 2] == 0 and payload[j + 3] == 1)
                    ):
                        next_start = j
                        break
                    j += 1
                if nal_start < next_start:
                    yield payload[nal_start:next_start]
                i = next_start
        except Exception:
            return

    def _is_h265_key_packet(self, payload: bytes) -> bool:
        try:
            for nal in self._iter_annexb_nals(payload):
                if len(nal) < 2:
                    continue
                nal_type = (nal[0] >> 1) & 0x3F
                if 16 <= nal_type <= 21:
                    return True
        except Exception:
            pass
        return False

    def _remember_h265_parameter_sets(self, payload: bytes):
        nal_types = set()
        updates = {}
        try:
            for nal in self._iter_annexb_nals(payload):
                if len(nal) < 2:
                    continue
                nal_type = (nal[0] >> 1) & 0x3F
                nal_types.add(nal_type)
                # HEVC VPS/SPS/PPS. Keep the latest parameter sets so recording can
                # begin on a later IDR frame without inheriting stale decoder state.
                if nal_type in (32, 33, 34):
                    updates[nal_type] = b"\x00\x00\x00\x01" + bytes(nal)
        except Exception:
            pass
        if updates:
            try:
                with self.encoded_record_lock:
                    self.h265_parameter_sets.update(updates)
            except Exception:
                pass
        return nal_types

    def _has_h265_parameter_sets(self, packet_nal_types=None) -> bool:
        packet_types = set(packet_nal_types or set())
        if {32, 33, 34}.issubset(packet_types):
            return True
        try:
            with self.encoded_record_lock:
                available = set(self.h265_parameter_sets.keys())
            return {32, 33, 34}.issubset(available | packet_types)
        except Exception:
            return False

    def _h265_parameter_sets_prefix(self, packet_nal_types=None) -> bytes:
        packet_types = set(packet_nal_types or set())
        try:
            with self.encoded_record_lock:
                parts = [
                    self.h265_parameter_sets.get(nal_type, b"")
                    for nal_type in (32, 33, 34)
                    if nal_type not in packet_types
                ]
            return b"".join(part for part in parts if part)
        except Exception:
            return b""

    def _encoded_record_queue_size(self) -> int:
        try:
            configured = int(str(os.getenv("MRT_ENCODED_RECORD_QUEUE_SIZE", "")).strip() or "1024")
            return max(64, min(8192, configured))
        except Exception:
            return 1024

    def _start_encoded_stream_recording(self) -> bool:
        ff = self._find_ffmpeg()
        if not ff:
            self.last_recording_error = "ffmpeg not found for encoded stream recording"
            log("encoded recording start failed: ffmpeg not found")
            return False
        try:
            q = queue.Queue(maxsize=self._encoded_record_queue_size())
            with self.encoded_record_lock:
                self.encoded_record_queue = q
                self.encoded_record_process = None
                self.encoded_record_active = True
                self.encoded_record_started = False
                self.encoded_record_failed = False
                self.encoded_record_packet_count = 0
                self.encoded_record_written_bytes = 0
                self.encoded_record_dropped_packets = 0
                self.encoded_record_keyframe_count = 0
                self.encoded_record_width = 0
                self.encoded_record_height = 0
                self.encoded_record_last_log_time = 0.0
                self.encoded_record_last_wait_log_time = 0.0
                self.encoded_record_ffmpeg = ff
                self.encoded_record_stop_event.clear()
            self.chosen_codec = "hevc-copy"
            self.video_actual_path = self.video_path
            log("encoded recording armed", "ffmpeg=", ff, "video=", self.video_path, "queue_size=", q.maxsize)
            return True
        except Exception as e:
            self.last_recording_error = f"encoded recording init failed: {e}"
            log("encoded recording init failed", str(e))
            return False

    def _signal_encoded_stream_recording_stop(self):
        q = None
        try:
            with self.encoded_record_lock:
                self.encoded_record_active = False
                self.encoded_record_stop_event.set()
                q = self.encoded_record_queue
        except Exception:
            q = None
        if q is None:
            return
        try:
            q.put_nowait(None)
        except queue.Full:
            try:
                q.get_nowait()
            except Exception:
                pass
            try:
                q.put_nowait(None)
            except Exception:
                pass
        except Exception:
            pass

    def _open_encoded_record_process(self):
        ff = ""
        try:
            with self.encoded_record_lock:
                ff = self.encoded_record_ffmpeg
        except Exception:
            ff = ""
        if not ff:
            ff = self._find_ffmpeg()
        if not ff:
            raise RuntimeError("ffmpeg not found")

        output_path = self.video_path
        if os.name == "nt" and output_path:
            output_path = self._resolve_windows_video_writer_path(output_path)
        self.video_actual_path = output_path

        cmd = [
            ff,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-fflags",
            "+genpts",
        ]
        try:
            configured_fps = str(os.getenv("MRT_ENCODED_RECORD_FPS", "")).strip()
            if configured_fps:
                fps_val = float(configured_fps)
            elif self._is_glasses_mode():
                fps_val = self._glasses_scene_fps()
            else:
                fps_val = self._get_record_target_fps()
            fps_val = max(1.0, min(240.0, float(fps_val)))
            cmd.extend(["-r", f"{fps_val:g}"])
        except Exception:
            cmd.extend(["-r", "60" if self._is_glasses_mode() else "30"])
        cmd.extend(
            [
                "-f",
                "hevc",
                "-i",
                "pipe:0",
                "-an",
                "-c:v",
                "copy",
                "-tag:v",
                "hvc1",
                "-movflags",
                "+faststart",
                output_path,
            ]
        )
        run_kwargs = {
            "stdin": subprocess.PIPE,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "bufsize": 0,
        }
        if os.name == "nt":
            try:
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startupinfo.wShowWindow = 0
                run_kwargs["startupinfo"] = startupinfo
                run_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            except Exception:
                pass
        process = subprocess.Popen(cmd, **run_kwargs)
        with self.encoded_record_lock:
            self.encoded_record_process = process
        return process

    def _offer_encoded_recording_packet(
        self,
        payload: bytes,
        width: int,
        height: int,
        ts,
        keyframe: bool,
        nal_types=None,
    ):
        try:
            if not payload:
                return
            with self.encoded_record_lock:
                active = bool(self.encoded_record_active)
                failed = bool(self.encoded_record_failed)
                q = self.encoded_record_queue
            if not active or failed or q is None:
                return
            item = (
                payload,
                int(width) if width else 0,
                int(height) if height else 0,
                float(ts) if ts is not None else time.time() * 1000000.0,
                bool(keyframe),
                set(nal_types or set()),
            )
            try:
                q.put_nowait(item)
            except queue.Full:
                with self.encoded_record_lock:
                    self.encoded_record_dropped_packets += 1
                    self.encoded_record_failed = True
                    self.last_recording_error = "编码录制队列积压，已停止写入以保护实时预览"
                log("encoded recording queue overflow; recording write stopped", "queue_size=", q.maxsize)
        except Exception as e:
            try:
                log("encoded recording offer failed", str(e))
            except Exception:
                pass

    def _record_encoded_stream_loop(self):
        log("encoded stream record thread started", "video_path=", self.video_path)
        process = None
        wrote_first_packet = False
        had_loop_error = False
        try:
            with self.encoded_record_lock:
                q = self.encoded_record_queue
            if q is None:
                self.last_recording_error = "encoded recording queue is not initialized"
                log("encoded stream record thread missing queue")
                return

            while True:
                try:
                    item = q.get(timeout=0.2)
                except queue.Empty:
                    with self.record_lock:
                        still_recording = bool(self.is_recording)
                    with self.encoded_record_lock:
                        should_stop = bool(self.encoded_record_stop_event.is_set())
                    if should_stop or not still_recording:
                        break
                    continue

                if item is None:
                    break

                payload, width, height, _ts, keyframe, nal_types = item
                with self.encoded_record_lock:
                    failed = bool(self.encoded_record_failed)
                if failed:
                    continue

                if process is None:
                    if not keyframe:
                        now_wait = time.time()
                        if now_wait - self.encoded_record_last_wait_log_time >= 1.0:
                            self.encoded_record_last_wait_log_time = now_wait
                            log("encoded recording waiting for keyframe", "size=", len(payload))
                        continue
                    if not self._has_h265_parameter_sets(nal_types):
                        now_wait = time.time()
                        if now_wait - self.encoded_record_last_wait_log_time >= 1.0:
                            self.encoded_record_last_wait_log_time = now_wait
                            log("encoded recording waiting for HEVC parameter sets", "nal_types=", sorted(list(nal_types)))
                        continue
                    process = self._open_encoded_record_process()
                    prefix = self._h265_parameter_sets_prefix(nal_types)
                    if prefix and process.stdin:
                        process.stdin.write(prefix)
                    wrote_first_packet = True
                    timeline_started_at = time.perf_counter()
                    with self.record_lock:
                        self.record_start_time = time.time()
                        self.record_start_perf = timeline_started_at
                        self.record_first_sample_elapsed_ms = None
                        self.record_timeline_ready = True
                    with self.encoded_record_lock:
                        self.encoded_record_started = True
                        self.encoded_record_width = int(width or 0)
                        self.encoded_record_height = int(height or 0)
                    log(
                        "encoded recording started at keyframe",
                        "w=", width,
                        "h=", height,
                        "prefix_bytes=", len(prefix),
                        "video=", self.video_actual_path or self.video_path,
                    )

                if process is None or process.stdin is None:
                    continue
                process.stdin.write(payload)
                with self.encoded_record_lock:
                    self.encoded_record_packet_count += 1
                    self.encoded_record_written_bytes += len(payload)
                    if keyframe:
                        self.encoded_record_keyframe_count += 1
                    self.encoded_record_width = int(width or self.encoded_record_width or 0)
                    self.encoded_record_height = int(height or self.encoded_record_height or 0)
                    packet_count = self.encoded_record_packet_count
                    byte_count = self.encoded_record_written_bytes
                    key_count = self.encoded_record_keyframe_count
                now_log = time.time()
                if packet_count == 1 or now_log - self.encoded_record_last_log_time >= 2.0:
                    self.encoded_record_last_log_time = now_log
                    log(
                        "encoded recording packets",
                        packet_count,
                        "bytes=",
                        byte_count,
                        "keyframes=",
                        key_count,
                        "queue=",
                        q.qsize(),
                    )
        except Exception as e:
            had_loop_error = True
            self.last_recording_error = f"encoded stream record error: {e}"
            with self.encoded_record_lock:
                self.encoded_record_failed = True
            log("encoded stream record loop error", str(e))
        finally:
            try:
                if process is not None and process.stdin:
                    process.stdin.close()
            except Exception:
                pass
            if process is not None:
                try:
                    ret = process.wait(timeout=20.0)
                    if ret != 0:
                        self.last_recording_error = f"ffmpeg encoded recording failed ({ret})"
                        with self.encoded_record_lock:
                            self.encoded_record_failed = True
                        log("encoded recording ffmpeg failed", "code=", ret, "path=", self.video_actual_path or self.video_path)
                except subprocess.TimeoutExpired:
                    self.last_recording_error = "ffmpeg encoded recording finalize timeout"
                    with self.encoded_record_lock:
                        self.encoded_record_failed = True
                    try:
                        process.kill()
                    except Exception:
                        pass
                    log("encoded recording ffmpeg finalize timeout")
            elif wrote_first_packet:
                self.last_recording_error = "encoded recording process missing"
            elif not had_loop_error:
                self.last_recording_error = "录制期间未收到可写入的 HEVC 关键帧"
                log("encoded recording finished without keyframe")

            with self.encoded_record_lock:
                packet_count = self.encoded_record_packet_count
                byte_count = self.encoded_record_written_bytes
                dropped = self.encoded_record_dropped_packets
                key_count = self.encoded_record_keyframe_count
                failed = self.encoded_record_failed
                self.encoded_record_active = False
                self.encoded_record_process = None
                self.encoded_record_queue = None
                self.encoded_record_stop_event.clear()
            try:
                self._post_process_video()
            except Exception as e:
                log("post_process_encoded_video error", str(e))
            try:
                self._finalize_video_output_path()
            except Exception as e:
                log("finalize encoded video path exception", str(e))
            try:
                vp = Path(self.video_path) if self.video_path else None
                ap = Path(self.video_actual_path) if self.video_actual_path else None
                if vp and vp.exists():
                    log("encoded video file exists", str(vp), "bytes=", vp.stat().st_size)
                elif vp:
                    log("encoded video file missing", str(vp))
                if ap and ap.exists() and (not vp or str(ap) != str(vp)):
                    log("encoded actual video file exists", str(ap), "bytes=", ap.stat().st_size)
            except Exception as e:
                log("encoded video file stat error", str(e))
            log(
                "encoded stream record thread finished",
                "packets=", packet_count,
                "bytes=", byte_count,
                "keyframes=", key_count,
                "dropped=", dropped,
                "failed=", failed,
            )

    def _offer_encoded_video_packet(self, payload: bytes, width: int, height: int, ts, codec_id: int = 2):
        try:
            if not payload or self.loop is None or self.encoded_video_clients <= 0:
                return
            try:
                w = int(width) if width else 0
                h = int(height) if height else 0
                if w > 0 and h > 0:
                    self.scene_frame_width = w
                    self.scene_frame_height = h
            except Exception:
                pass
            self.encoded_video_seq = (int(self.encoded_video_seq) + 1) & 0xFFFFFFFF
            timestamp_us = 0.0
            try:
                timestamp_us = float(ts)
            except Exception:
                timestamp_us = time.time() * 1000000.0
            keyframe = self._is_h265_key_packet(payload) if codec_id == 2 else False
            with self.stream_frame_lock:
                waiting_for_keyframe = bool(getattr(self, "encoded_video_wait_for_keyframe", False))
                if waiting_for_keyframe and not keyframe:
                    now_wait = time.time()
                    if now_wait - float(getattr(self, "last_encoded_wait_keyframe_log_time", 0.0) or 0.0) >= 1.0:
                        self.last_encoded_wait_keyframe_log_time = now_wait
                        try:
                            log("encoded stream waiting for keyframe", "reset_seq", self.encoded_video_reset_seq, "size", len(payload))
                        except Exception:
                            pass
                    return
                if waiting_for_keyframe and keyframe:
                    self.encoded_video_wait_for_keyframe = False
                    try:
                        log("encoded stream resumed at keyframe", "reset_seq", self.encoded_video_reset_seq, "size", len(payload))
                    except Exception:
                        pass
            flags = 1 if keyframe else 0
            with self.stream_frame_lock:
                stream_reset_seq = int(getattr(self, "encoded_video_reset_seq", 0) or 0) & 0xFFFFFFFF
            header = struct.pack(
                "<4sBBBBHHIdII",
                b"MRTV",
                1,                # version
                int(codec_id),    # 1=H.264/AVC, 2=H.265/HEVC
                flags,
                1,                # Annex B
                max(0, min(65535, int(width) if width else 0)),
                max(0, min(65535, int(height) if height else 0)),
                int(self.encoded_video_seq),
                float(timestamp_us),
                len(payload),
                stream_reset_seq,
            )
            packet = header + payload

            def offer_encoded(data: bytes):
                try:
                    if self.encoded_video_queue.full() or self.encoded_video_queue.qsize() >= 12:
                        with self.stream_frame_lock:
                            self.encoded_video_reset_seq += 1
                            self.encoded_video_wait_for_keyframe = True
                        try:
                            while True:
                                self.encoded_video_queue.get_nowait()
                        except Exception:
                            pass
                        return
                    self.encoded_video_queue.put_nowait(data)
                except Exception:
                    pass

            self.loop.call_soon_threadsafe(offer_encoded, packet)
            self.encoded_video_frame_count += 1
            now = time.time()
            if self.encoded_video_frame_count == 1 or (now - self.last_encoded_video_log_time) >= 1.0:
                self.last_encoded_video_log_time = now
                log(
                    "encoded video frames",
                    self.encoded_video_frame_count,
                    "clients",
                    self.encoded_video_clients,
                    "codec",
                    "hevc" if codec_id == 2 else "avc",
                    "key",
                    keyframe,
                    "size",
                    len(payload),
                    "w",
                    width,
                    "h",
                    height,
                )
        except Exception as e:
            try:
                log("encoded video publish failed", str(e))
            except Exception:
                pass

    def image_callback(self, eye, image, size, width, height, ts, ctx):
        try:
            if self.loop is None:
                return
            try:
                eye_id = int(eye)
            except Exception:
                eye_id = -1
            is_glasses_mode = self._is_glasses_mode()
            frame_role = "scene"
            if is_glasses_mode:
                wants_glasses_eye_images = self.image_clients > 0
                # Fast path: drop non-scene frames as early as possible.
                # In glasses mode, ~240+ non-scene callbacks/sec arrive (left/right eye),
                # and they are only needed when the eye-image panel is connected.
                if self.glasses_scene_locked and eye_id != self.glasses_scene_eye_id and not wants_glasses_eye_images:
                    try:
                        self.glasses_dropped_non_scene_count += 1
                        if self.glasses_dropped_non_scene_count <= 5 or (time.time() - self.last_glasses_drop_log_time) >= 10.0:
                            self.last_glasses_drop_log_time = time.time()
                            log(
                                "glasses non-scene frame dropped",
                                "count=", self.glasses_dropped_non_scene_count,
                                "eye=", eye_id,
                                "scene_eye=", self.glasses_scene_eye_id,
                                "w=", width,
                                "h=", height,
                                "size=", size,
                            )
                    except Exception:
                        pass
                    return
                now_ts = time.time()
                if eye_id == 1:
                    frame_role = "left_eye"
                elif eye_id == 2:
                    frame_role = "right_eye"
                else:
                    if self.glasses_scene_eye_id != eye_id:
                        self.glasses_scene_eye_id = eye_id
                        self.glasses_scene_locked = True
                        try:
                            log("glasses scene stream locked", "eye", eye_id, "w", width, "h", height, "size", size)
                        except Exception:
                            pass
                if self.glasses_scene_locked:
                    if eye_id != self.glasses_scene_eye_id:
                        if frame_role not in ("left_eye", "right_eye") or not wants_glasses_eye_images:
                            return
                else:
                    # Wait for true scene stream first. Only fallback to eye stream if scene stream
                    # is never seen shortly after start (for vendor variant compatibility).
                    warmup_sec = 2.5
                    started_at = float(self.device_started_at or 0.0)
                    if started_at > 0 and (now_ts - started_at) < warmup_sec:
                        if frame_role != "scene" and not wants_glasses_eye_images:
                            return
                    if frame_role != "scene":
                        if wants_glasses_eye_images:
                            pass
                        else:
                            if self.glasses_fallback_eye_id is None:
                                self.glasses_fallback_eye_id = eye_id
                                try:
                                    log("glasses fallback eye stream selected", "eye", eye_id, "w", width, "h", height, "size", size)
                                except Exception:
                                    pass
                            if eye_id != self.glasses_fallback_eye_id:
                                return
                            frame_role = "scene"
            with self.record_lock:
                stream_recording = bool(self.is_recording and self.record_source == "stream" and frame_role == "scene")
            if is_glasses_mode and frame_role == "scene":
                self._track_glasses_scene_arrival(eye_id, width, height)
            need_image_stream = self.image_clients > 0
            need_encoded_stream = self.encoded_video_clients > 0
            if is_glasses_mode and frame_role == "scene" and need_image_stream and need_encoded_stream:
                # Avoid duplicate JPEG decoding while the WebCodecs connection is
                # active. When WebCodecs falls back it closes that connection first,
                # leaving the JPEG client as the only consumer. This keeps the SDK
                # software-decode path as a fallback so the preview never goes blank
                # when the platform cannot hardware-decode HEVC.
                need_image_stream = False
            encoded_stream_recording = bool(is_glasses_mode and frame_role == "scene" and stream_recording)
            decoded_stream_recording = bool(stream_recording and not encoded_stream_recording)
            keep_scene_decoder_warm = bool(
                is_glasses_mode and frame_role == "scene" and need_image_stream
            )
            if not need_image_stream and not need_encoded_stream and not stream_recording and not keep_scene_decoder_warm:
                return

            raw_scene_payload = None
            raw_scene_keyframe = False
            raw_scene_nal_types = set()
            if is_glasses_mode and frame_role == "scene":
                try:
                    raw_size = int(size) if size else 0
                    if raw_size > 0 and image:
                        raw_scene_payload = string_at(image, raw_size)
                        raw_scene_nal_types = self._remember_h265_parameter_sets(raw_scene_payload)
                        raw_scene_keyframe = any(16 <= nal_type <= 21 for nal_type in raw_scene_nal_types)
                except Exception as e:
                    try:
                        log("scene packet copy failed", str(e))
                    except Exception:
                        pass

            if need_encoded_stream and is_glasses_mode and frame_role == "scene" and raw_scene_payload:
                try:
                    self._offer_encoded_video_packet(
                        raw_scene_payload,
                        int(width) if width else 0,
                        int(height) if height else 0,
                        ts,
                        codec_id=2,
                    )
                except Exception as e:
                    try:
                        log("encoded scene packet publish failed", str(e))
                    except Exception:
                        pass

            if encoded_stream_recording and raw_scene_payload:
                self._offer_encoded_recording_packet(
                    raw_scene_payload,
                    int(width) if width else 0,
                    int(height) if height else 0,
                    ts,
                    raw_scene_keyframe,
                    raw_scene_nal_types,
                )
                if not need_image_stream:
                    return

            if (
                is_glasses_mode
                and frame_role == "scene"
                and not need_image_stream
                and not decoded_stream_recording
            ):
                return

            preview_due = False
            stream_record_due = False
            if need_image_stream or decoded_stream_recording:
                now = time.time()
                target_fps = 10.0 if is_glasses_mode else 15.0
                try:
                    if is_glasses_mode:
                        env_fps = str(os.getenv("MRT_IMAGE_MAX_FPS_GLASSES", "")).strip()
                    else:
                        env_fps = str(os.getenv("MRT_IMAGE_MAX_FPS", "")).strip()
                    if env_fps:
                        parsed_fps = float(env_fps)
                        if parsed_fps >= 1.0:
                            target_fps = parsed_fps
                except Exception:
                    pass
                last_enqueue = float(self.last_image_enqueue_time_by_role.get(frame_role, 0.0))
                if now - last_enqueue >= (1.0 / max(1.0, target_fps)):
                    preview_due = True
                    self.last_image_enqueue_time = now
                    self.last_image_enqueue_time_by_role[frame_role] = now
                if decoded_stream_recording:
                    record_target_fps = self._get_record_target_fps()
                    last_record_frame = float(self.last_stream_record_frame_time_by_role.get(frame_role, 0.0))
                    if now - last_record_frame >= (1.0 / max(1.0, record_target_fps)):
                        stream_record_due = True
                        self.last_stream_record_frame_time_by_role[frame_role] = now

            payload_size = int(size)
            img_bytes = b""
            need_frame_payload = bool(stream_record_due or preview_due)
            # H265 scene packets must be fed continuously. Even when preview is
            # throttled, skipping compressed packets breaks the decoder reference
            # chain and can surface as white noise/artifacts later.
            need_decode_payload = bool(need_frame_payload or keep_scene_decoder_warm)
            allow_cached_fallback = bool(need_image_stream and (not decoded_stream_recording))
            skip_decode_until_keyframe = False
            if need_decode_payload and is_glasses_mode and frame_role == "scene":
                with self.stream_frame_lock:
                    waiting_for_decode_keyframe = bool(getattr(self, "stream_decode_wait_for_keyframe", False))
                if waiting_for_decode_keyframe:
                    try:
                        if raw_scene_payload and not raw_scene_keyframe:
                            raw_scene_keyframe = self._is_h265_key_packet(raw_scene_payload)
                        if not raw_scene_keyframe:
                            now_wait = time.time()
                            if now_wait - float(getattr(self, "last_stream_decode_wait_keyframe_log_time", 0.0) or 0.0) >= 1.0:
                                self.last_stream_decode_wait_keyframe_log_time = now_wait
                                log("stream decoder waiting for keyframe", "size", len(raw_scene_payload or b""))
                            skip_decode_until_keyframe = True
                        else:
                            with self.stream_frame_lock:
                                self.stream_decode_wait_for_keyframe = False
                            log("stream decoder resumed at keyframe", "size", len(raw_scene_payload or b""))
                    except Exception as e:
                        try:
                            log("stream decoder keyframe gate failed", str(e))
                        except Exception:
                            pass
                        skip_decode_until_keyframe = True
            if self.driver is not None:
                try:
                    img_bytes, payload_size = self.driver.preprocess_image_payload(
                        eye,
                        image,
                        size,
                        width,
                        height,
                        emit_frame=need_frame_payload,
                        allow_cached_fallback=allow_cached_fallback,
                    ) if (need_decode_payload and not skip_decode_until_keyframe) else (b"", 0)
                except Exception as e:
                    log("driver image preprocess failed", str(e))
                    if need_frame_payload:
                        payload_size = int(size)
                        img_bytes = string_at(image, size)
                    else:
                        payload_size = 0
                        img_bytes = b""
            elif need_frame_payload:
                payload_size = int(size)
                img_bytes = string_at(image, size)

            try:
                self.image_callback_called_count += 1
                now = time.time()
                if self.image_callback_called_count <= 3 or (now - self.last_image_callback_log_time) >= 2.0:
                    self.last_image_callback_log_time = now
                    head = ""
                    try:
                        if img_bytes:
                            head = img_bytes[:8].hex()
                    except Exception:
                        pass
                    log("image_callback called", self.image_callback_called_count, "eye", eye, "size", payload_size, "w", width, "h", height, "head", head)
            except Exception:
                pass

            if not preview_due and not stream_record_due:
                return

            png_bytes = None
            image_mime = "image/png"
            frame_bgr = None
            try:
                w = int(width)
                h = int(height)
                if is_glasses_mode and frame_role == "scene" and w > 0 and h > 0:
                    self.scene_frame_width = w
                    self.scene_frame_height = h
                pixels = w * h
                if pixels > 0 and payload_size in (pixels, pixels * 3, pixels * 4):
                    ch = int(payload_size // pixels)
                    arr = np.frombuffer(img_bytes, np.uint8)
                    if ch == 1:
                        frame = arr.reshape(h, w)
                    elif ch == 3:
                        frame = arr.reshape(h, w, 3)
                    else:
                        frame = arr.reshape(h, w, 4)
                    if decoded_stream_recording or (is_glasses_mode and frame_role == "scene"):
                        if ch == 1:
                            frame_bgr = cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR)
                        elif ch == 4:
                            frame_bgr = cv2.cvtColor(frame, cv2.COLOR_BGRA2BGR)
                        else:
                            frame_bgr = frame
                    if need_image_stream and preview_due and not (is_glasses_mode and frame_role == "scene"):
                        encode_ext = ".png"
                        encode_params = []
                        if is_glasses_mode and eye_id not in (1, 2) and ch >= 3:
                            encode_ext = ".jpg"
                            image_mime = "image/jpeg"
                            encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), 82]
                        else:
                            image_mime = "image/png"
                        ok, enc = cv2.imencode(encode_ext, frame, encode_params)
                        if ok:
                            png_bytes = enc.tobytes()
                elif len(img_bytes) >= 8 and img_bytes[:8] == b"\x89PNG\r\n\x1a\n":
                    if need_image_stream:
                        png_bytes = img_bytes
                        image_mime = "image/png"
                    if decoded_stream_recording:
                        arr = np.frombuffer(img_bytes, np.uint8)
                        frame_bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
                elif len(img_bytes) >= 2 and img_bytes[:2] == b"\xff\xd8":
                    if need_image_stream:
                        png_bytes = img_bytes
                        image_mime = "image/jpeg"
                    if decoded_stream_recording:
                        arr = np.frombuffer(img_bytes, np.uint8)
                        frame_bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            except Exception as e:
                try:
                    self.image_decode_error_count += 1
                    now = time.time()
                    if self.image_decode_error_count <= 3 or (now - self.last_image_error_log_time) >= 3.0:
                        self.last_image_error_log_time = now
                        head = ""
                        try:
                            head = img_bytes[:16].hex()
                        except Exception:
                            pass
                        log("image decode error", str(e), "eye", eye, "size", payload_size, "w", width, "h", height, "head", head)
                except Exception:
                    pass
                return

            used_cached_scene_frame = False
            if is_glasses_mode and frame_role == "scene" and frame_bgr is not None:
                if not self._is_usable_glasses_scene_frame(frame_bgr, strict=True):
                    self._log_glasses_scene_frame_reject(
                        "before_publish_or_record",
                        eye_id,
                        width,
                        height,
                        frame_bgr,
                    )
                    cached_frame = self.glasses_last_good_scene_frame
                    cached_size = self.glasses_last_good_scene_size
                    if cached_frame is None or cached_size != (int(width), int(height)):
                        return
                    frame_bgr = cached_frame.copy()
                    used_cached_scene_frame = True
                else:
                    self.glasses_last_good_scene_frame = np.ascontiguousarray(frame_bgr)
                    self.glasses_last_good_scene_size = (int(width), int(height))

            if stream_record_due and frame_bgr is not None:
                with self.stream_frame_lock:
                    self.latest_stream_frame = np.ascontiguousarray(frame_bgr)
                    self.latest_stream_frame_seq += 1

            if not need_image_stream:
                return
            if not preview_due:
                return

            if is_glasses_mode and frame_role == "scene":
                if used_cached_scene_frame and self.glasses_last_good_scene_preview:
                    png_bytes = self.glasses_last_good_scene_preview
                    image_mime = self.glasses_last_good_scene_mime or "image/jpeg"
                elif frame_bgr is not None:
                    ok, enc = cv2.imencode(".jpg", frame_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 82])
                    if ok:
                        png_bytes = enc.tobytes()
                        image_mime = "image/jpeg"
                        self.glasses_last_good_scene_preview = png_bytes
                        self.glasses_last_good_scene_mime = image_mime

            if not png_bytes:
                return
            if is_glasses_mode and frame_role == "scene":
                self._log_glasses_scene_frame_publish(
                    eye_id,
                    width,
                    height,
                    frame_bgr,
                    encoded_len=len(png_bytes),
                    mime=image_mime,
                )
            if is_glasses_mode:
                data = json.dumps({
                    "type": "image_frame",
                    "kind": frame_role,
                    "eye": eye_id,
                    "mime": image_mime,
                    "width": int(width),
                    "height": int(height),
                    "timestamp": int(ts) if ts is not None else 0,
                    "data": base64.b64encode(png_bytes).decode("ascii"),
                })
            else:
                data = png_bytes
            try:
                self.image_frame_count += 1
                now = time.time()
                if self.image_frame_count == 1:
                    try:
                        log("image first frame", "clients", self.image_clients, "kind", frame_role, "eye", eye_id, "mime", image_mime, "size", len(data), "w", width, "h", height)
                    except Exception:
                        pass
                if now - self.last_image_log_time >= 1.0:
                    self.last_image_log_time = now
                    try:
                        log("image frames", self.image_frame_count, "clients", self.image_clients, "kind", frame_role, "eye", eye_id, "mime", image_mime, "last_size", len(data), "w", width, "h", height)
                    except Exception:
                        pass
            except Exception:
                pass
            def offer_image(payload: bytes):
                try:
                    if self.image_queue.full():
                        try:
                            self.image_queue.get_nowait()
                        except Exception:
                            pass
                    self.image_queue.put_nowait(payload)
                except Exception:
                    pass

            self.loop.call_soon_threadsafe(offer_image, data)
        except Exception:
            pass

    def gaze_callback(self, eyes, ctx=None, *args):
        try:
            if self.loop is None:
                return
            if eyes is None:
                return
            obj = eyes.__getitem__(0)
            def _pick_xy(gaze_obj):
                return pick_gaze_xy(gaze_obj, self._is_glasses_mode())

            left_pick, left_source, left_mask = _pick_xy(obj.left_gaze)
            right_pick, right_source, right_mask = _pick_xy(obj.right_gaze)
            recom_pick, recom_source, recom_mask = _pick_xy(obj.recom_gaze)

            if self._is_glasses_mode():
                # Glasses mode:
                # The Chinese aSeeGlasses Plus manual marks recommend as deprecated,
                # but recom_gaze itself is the SDK recommended gaze point.
                if recom_pick is not None:
                    re_gaze_x, re_gaze_y = recom_pick
                else:
                    re_gaze_x, re_gaze_y = 0.0, 0.0
                    recom_source = "recom:none"
            else:
                if recom_pick is not None:
                    re_gaze_x, re_gaze_y = recom_pick
                else:
                    try:
                        recommend = int(getattr(obj, "recommend", 0))
                    except Exception:
                        recommend = 0
                    if recommend == 1 and left_pick is not None:
                        re_gaze_x, re_gaze_y = left_pick
                        recom_source = f"fallback-left:{left_source}"
                    elif recommend == 2 and right_pick is not None:
                        re_gaze_x, re_gaze_y = right_pick
                        recom_source = f"fallback-right:{right_source}"
                    elif left_pick is not None and right_pick is not None:
                        re_gaze_x = (left_pick[0] + right_pick[0]) * 0.5
                        re_gaze_y = (left_pick[1] + right_pick[1]) * 0.5
                        recom_source = "fallback-avg"
                    elif left_pick is not None:
                        re_gaze_x, re_gaze_y = left_pick
                        recom_source = f"fallback-left:{left_source}"
                    elif right_pick is not None:
                        re_gaze_x, re_gaze_y = right_pick
                        recom_source = f"fallback-right:{right_source}"
                    else:
                        re_gaze_x, re_gaze_y = 0.0, 0.0
                        recom_source = "none"

            if left_pick is not None:
                left_gaze_x, left_gaze_y = left_pick
            else:
                left_gaze_x, left_gaze_y = 0.0, 0.0
            if right_pick is not None:
                right_gaze_x, right_gaze_y = right_pick
            else:
                right_gaze_x, right_gaze_y = 0.0, 0.0

            recom_output = self._recom_gaze_fields_for_output(obj, re_gaze_x, re_gaze_y)
            fixation_stats = self._resolve_fixation_stats(
                obj,
                re_gaze_x,
                re_gaze_y,
                gaze_valid=(recom_pick is not None or left_pick is not None or right_pick is not None),
            )

            now = time.time()
            if now - self.last_gaze_log_time >= 1.0:
                self.last_gaze_log_time = now
                try:
                    lg_gp_x = float(obj.left_gaze.gaze_point.x)
                    lg_gp_y = float(obj.left_gaze.gaze_point.y)
                    lg_raw_x = float(obj.left_gaze.raw_point.x)
                    lg_raw_y = float(obj.left_gaze.raw_point.y)
                    lg_sm_x = float(obj.left_gaze.smooth_point.x)
                    lg_sm_y = float(obj.left_gaze.smooth_point.y)
                    rg_gp_x = float(obj.right_gaze.gaze_point.x)
                    rg_gp_y = float(obj.right_gaze.gaze_point.y)
                    rg_raw_x = float(obj.right_gaze.raw_point.x)
                    rg_raw_y = float(obj.right_gaze.raw_point.y)
                    rg_sm_x = float(obj.right_gaze.smooth_point.x)
                    rg_sm_y = float(obj.right_gaze.smooth_point.y)
                    re_gp_x = float(obj.recom_gaze.gaze_point.x)
                    re_gp_y = float(obj.recom_gaze.gaze_point.y)
                    re_raw_x = float(obj.recom_gaze.raw_point.x)
                    re_raw_y = float(obj.recom_gaze.raw_point.y)
                    re_sm_x = float(obj.recom_gaze.smooth_point.x)
                    re_sm_y = float(obj.recom_gaze.smooth_point.y)
                    re_dir_x = float(obj.recom_gaze.gaze_direction.x)
                    re_dir_y = float(obj.recom_gaze.gaze_direction.y)
                    re_dir_z = float(obj.recom_gaze.gaze_direction.z)
                    re_org_x = float(obj.recom_gaze.gaze_origin.x)
                    re_org_y = float(obj.recom_gaze.gaze_origin.y)
                    re_org_z = float(obj.recom_gaze.gaze_origin.z)
                    recommend = int(getattr(obj, "recommend", 0))
                    log(
                        "gaze sample",
                        "ts",
                        obj.timestamp,
                        "re",
                        round(float(re_gaze_x), 6),
                        round(float(re_gaze_y), 6),
                        "left",
                        round(float(left_gaze_x), 6),
                        round(float(left_gaze_y), 6),
                        "right",
                        round(float(right_gaze_x), 6),
                        round(float(right_gaze_y), 6),
                        "src",
                        f"re:{recom_source}/l:{left_source}/r:{right_source}",
                        "recommend",
                        recommend,
                        "mask",
                        f"{recom_mask}/{left_mask}/{right_mask}",
                        "cand_re_gp_sm_raw",
                        f"({round(re_gp_x, 4)},{round(re_gp_y, 4)})/({round(re_sm_x, 4)},{round(re_sm_y, 4)})/({round(re_raw_x, 4)},{round(re_raw_y, 4)})",
                        "cand_l_gp_sm_raw",
                        f"({round(lg_gp_x, 4)},{round(lg_gp_y, 4)})/({round(lg_sm_x, 4)},{round(lg_sm_y, 4)})/({round(lg_raw_x, 4)},{round(lg_raw_y, 4)})",
                        "cand_r_gp_sm_raw",
                        f"({round(rg_gp_x, 4)},{round(rg_gp_y, 4)})/({round(rg_sm_x, 4)},{round(rg_sm_y, 4)})/({round(rg_raw_x, 4)},{round(rg_raw_y, 4)})",
                        "re_dir",
                        f"({round(re_dir_x, 4)},{round(re_dir_y, 4)},{round(re_dir_z, 4)})",
                        "re_org",
                        f"({round(re_org_x, 4)},{round(re_org_y, 4)},{round(re_org_z, 4)})",
                    )
                except Exception:
                    pass

            with self.record_lock:
                if self.is_recording and self.record_timeline_ready and self.csv_writer:
                    try:
                        row = self._csv_row_from_eye(obj, re_gaze_x, re_gaze_y, fixation_stats, recom_output)
                        self.csv_writer.writerow(row)
                        self.csv_flush_counter += 1
                        if self.csv_flush_counter >= self.csv_flush_interval:
                            self.csv_flush_counter = 0
                            try:
                                self.csv_file.flush()
                            except Exception:
                                pass
                    except Exception:
                        pass

            # Throttle WebSocket broadcast to ~20Hz – the frontend only reads at
            # ~20Hz anyway, so serializing JSON at 60-120Hz wastes CPU.
            now_broadcast = time.time()
            if now_broadcast - self.last_eye_broadcast_time < 0.045:
                return
            self.last_eye_broadcast_time = now_broadcast

            payload = {
                # Backward compatibility for legacy renderer field path.
                "timestamp": obj.timestamp,
                "eye_data": {
                    "ts": obj.timestamp,
                    "recommend": obj.recommend,
                    "re_gaze": {
                        "gaze_bit_mask": recom_output["gaze_bit_mask"],
                        "gaze": {"x": re_gaze_x, "y": re_gaze_y},
                        "gaze_point": {"x": recom_output["gaze_point"][0], "y": recom_output["gaze_point"][1]},
                        "raw": {"x": recom_output["raw_point"][0], "y": recom_output["raw_point"][1]},
                        "smooth": {"x": recom_output["smooth_point"][0], "y": recom_output["smooth_point"][1]},
                        "direction": {"x": recom_output["gaze_direction"][0], "y": recom_output["gaze_direction"][1], "z": recom_output["gaze_direction"][2]},
                        "origin": {"x": recom_output["gaze_origin"][0], "y": recom_output["gaze_origin"][1], "z": recom_output["gaze_origin"][2]},
                    },
                    "l_gaze": {
                        "gaze_bit_mask": obj.left_gaze.gaze_bit_mask,
                        "gaze": {"x": left_gaze_x, "y": left_gaze_y},
                        "gaze_point": {"x": obj.left_gaze.gaze_point.x, "y": obj.left_gaze.gaze_point.y},
                        "raw": {"x": obj.left_gaze.raw_point.x, "y": obj.left_gaze.raw_point.y},
                        "smooth": {"x": obj.left_gaze.smooth_point.x, "y": obj.left_gaze.smooth_point.y},
                        "direction": {"x": obj.left_gaze.gaze_direction.x, "y": obj.left_gaze.gaze_direction.y, "z": obj.left_gaze.gaze_direction.z},
                        "origin": {"x": obj.left_gaze.gaze_origin.x, "y": obj.left_gaze.gaze_origin.y, "z": obj.left_gaze.gaze_origin.z},
                    },
                    "r_gaze": {
                        "gaze_bit_mask": obj.right_gaze.gaze_bit_mask,
                        "gaze": {"x": right_gaze_x, "y": right_gaze_y},
                        "gaze_point": {"x": obj.right_gaze.gaze_point.x, "y": obj.right_gaze.gaze_point.y},
                        "raw": {"x": obj.right_gaze.raw_point.x, "y": obj.right_gaze.raw_point.y},
                        "smooth": {"x": obj.right_gaze.smooth_point.x, "y": obj.right_gaze.smooth_point.y},
                        "direction": {"x": obj.right_gaze.gaze_direction.x, "y": obj.right_gaze.gaze_direction.y, "z": obj.right_gaze.gaze_direction.z},
                        "origin": {"x": obj.right_gaze.gaze_origin.x, "y": obj.right_gaze.gaze_origin.y, "z": obj.right_gaze.gaze_origin.z},
                    },
                    "l_pupil": {
                        "center": {"x": obj.left_pupil.pupil_center.x, "y": obj.left_pupil.pupil_center.y},
                        "dist": obj.left_pupil.pupil_distance,
                        "dia": obj.left_pupil.pupil_diameter,
                        "dia_mm": obj.left_pupil.pupil_diameter_mm,
                    },
                    "r_pupil": {
                        "center": {"x": obj.right_pupil.pupil_center.x, "y": obj.right_pupil.pupil_center.y},
                        "dist": obj.right_pupil.pupil_distance,
                        "dia": obj.right_pupil.pupil_diameter,
                        "dia_mm": obj.right_pupil.pupil_diameter_mm,
                    },
                    "l_ex": {
                        "blink": obj.left_ex_data.blink,
                        "openness": obj.left_ex_data.openness,
                        "eyelid_up": obj.left_ex_data.eyelid_up,
                        "eyelid_down": obj.left_ex_data.eyelid_down,
                    },
                    "r_ex": {
                        "blink": obj.right_ex_data.blink,
                        "openness": obj.right_ex_data.openness,
                        "eyelid_up": obj.right_ex_data.eyelid_up,
                        "eyelid_down": obj.right_ex_data.eyelid_down,
                    },
                    "stats": {
                        "timestamp_us": fixation_stats.get("timestamp_us", 0),
                        "duration_us": fixation_stats.get("duration_us", 0),
                        "timestamp_ms": fixation_stats.get("timestamp_ms", 0.0),
                        "duration_ms": fixation_stats.get("duration_ms", 0.0),
                        "count": fixation_stats.get("count", 0),
                        "state": fixation_stats.get("state", 0),
                        "center": fixation_stats.get("center", {"x": 0.0, "y": 0.0}),
                    },
                }
            }
            msg = json.dumps(payload)

            def offer_eye(payload_text: str):
                try:
                    if self.eye_queue.full():
                        try:
                            self.eye_queue.get_nowait()
                        except Exception:
                            pass
                    self.eye_queue.put_nowait(payload_text)
                except Exception:
                    pass

            self.loop.call_soon_threadsafe(offer_eye, msg)
        except Exception:
            pass

    def point_process_callback(self, index, percent, ctx):
        if self.loop is None:
            return
        payload = {"type": "notify_progress", "index": index, "percent": percent}
        self.loop.call_soon_threadsafe(self.notify_queue.put_nowait, json.dumps(payload))

    def point_finish_callback(self, index, error, ctx):
        if self.loop is None:
            return
        callback_ctx = ctx if isinstance(ctx, dict) else {}
        eye = callback_ctx.get("eye", "")
        attempt = callback_ctx.get("attempt")
        try:
            log("calib point finish", "index", index, "error", error, "glasses", self._is_glasses_mode(), "eye", eye, "attempt", attempt)
        except Exception:
            pass
        payload = {"type": "notify_finish", "index": index, "error": error, "eye": eye, "attempt": attempt}
        self.loop.call_soon_threadsafe(self.notify_queue.put_nowait, json.dumps(payload))
        self.finish_event.set()

    def start_calibration(self, points):
        self.exit_calibration = False
        if self.driver is None:
            return -1
        if self.calibration_active:
            log("start_calibration cleaning previous active calibration")
            try:
                self.driver.cancel_calibration()
            finally:
                self.driver.end_calibration()
                self.calibration_active = False
        self.last_calibration_stop_tracking_result = None
        # Keep the desktop calibration sequence aligned with the previously
        # stable SDK flow: enter calibration directly without stopping tracking
        # first. Calling stop_tracking immediately before start_calibration can
        # leave the SDK transition in progress, so point-finish callbacks arrive
        # late or not at all and the renderer advances only after its timeout.
        ret = self.driver.start_calibration(points)
        self.calibration_active = (ret == 0)
        log("start_calibration lifecycle", "points", points, "ret", ret, "active", self.calibration_active)
        return ret

    def start_calibration_point(self, pt_index, x, y, attempt=None):
        self.finish_event.clear()
        if self.driver is None:
            return -1
        try:
            point_x = float(x)
            point_y = float(y)
        except Exception:
            point_x = 0.0
            point_y = 0.0

        if self._is_glasses_mode():
            # aSeeGlassesPlus sample uses scene-centered coordinates:
            # center=(0,0), right is +X, down is +Y.
            # Accept both normalized [0..1] input (web UI) and centered input.
            if 0.0 <= point_x <= 1.0 and 0.0 <= point_y <= 1.0:
                scene_w = max(1, int(self.scene_frame_width or 1280))
                scene_h = max(1, int(self.scene_frame_height or 720))
                point_x = (point_x * float(scene_w)) - (float(scene_w) * 0.5)
                # SDK has (0,0) at center, +X is right, +Y is down.
                # Web UI has (0,0) at top-left, +X is right, +Y is down.
                point_y = (point_y * float(scene_h)) - (float(scene_h) * 0.5)
                log(
                    "glasses calibration point mapped",
                    "index",
                    pt_index,
                    "norm",
                    x,
                    y,
                    "scene",
                    point_x,
                    point_y,
                    "scene_wh",
                    scene_w,
                    scene_h,
                )
            else:
                log(
                    "glasses calibration point passthrough",
                    "index",
                    pt_index,
                    "scene",
                    point_x,
                    point_y,
                )

        return self.driver.start_calibration_point(pt_index, point_x, point_y, attempt)

    def cancel_calibration(self):
        self.exit_calibration = True
        self.finish_event.set()
        if not self._is_glasses_mode():
            try:
                if self.driver is not None:
                    self.driver.cancel_calibration()
            except Exception:
                pass
            self.calibration_active = False
            return 0, 0
        cancel_ret = 0
        complete_ret = 0
        try:
            if self.driver is not None:
                cancel_ret = self.driver.cancel_calibration()
                complete_ret = self.driver.end_calibration() if self.calibration_active else 0
                self.calibration_active = False
                log("cancel_calibration lifecycle complete", "cancel", cancel_ret, "complete", complete_ret)
        except Exception as ex:
            log("cancel_calibration lifecycle exception", ex)
            cancel_ret = -1
            self.calibration_active = False
        return cancel_ret, complete_ret

    def cancel_calibration_point(self):
        if self.driver is None:
            return -1, None, None
        try:
            ret = self.driver.cancel_calibration()
            left, right = getattr(self.driver, "last_calibration_point_cancel_results", (ret, None))
            return ret, left, right
        except Exception as ex:
            log("cancel_calibration_point exception", ex)
            return -1, -1, -1

    def complete_calibration(self):
        if self.driver is None:
            return -1, "", 0.0, 0.0
        self.driver.last_calibration_complete_result = None
        try:
            return self.driver.complete_calibration()
        except Exception as ex:
            log("complete_calibration exception", ex)
            return -1, "", 0.0, 0.0
        finally:
            if self.driver.last_calibration_complete_result is None:
                self.driver.end_calibration()
            self.calibration_active = False

    def start_tracking(self, coe_str):
        try:
            if self.driver is None:
                return -1
            ret = self.driver.start_tracking(coe_str)
            self.tracking_active = (ret == 0)
            if ret == 0 and self._is_glasses_mode():
                self._reset_stream_video_decoder("after_tracking_start")
            return ret
        except Exception:
            self.tracking_active = False
            return -1

    def _empty_fixation_stats(self, state=0):
        return {
            "timestamp_us": 0,
            "duration_us": 0,
            "timestamp_ms": 0.0,
            "duration_ms": 0.0,
            "count": 0,
            "state": int(state),
            "center": {"x": 0.0, "y": 0.0},
            "source": "empty",
        }

    def _sdk_fixation_stats(self, obj):
        try:
            timestamp_us = getattr(obj.stats, "timestamp", 0)
            duration_us = getattr(obj.stats, "duration", 0)
            return {
                "timestamp_us": timestamp_us,
                "duration_us": duration_us,
                "timestamp_ms": float(timestamp_us) / 1000.0,
                "duration_ms": float(duration_us) / 1000.0,
                "count": getattr(obj.stats, "count", 0),
                "state": getattr(obj.stats, "state", 0),
                "center": {
                    "x": getattr(obj.stats.center, "x", 0.0),
                    "y": getattr(obj.stats.center, "y", 0.0),
                },
                "source": "sdk",
            }
        except Exception:
            return self._empty_fixation_stats()

    def _is_valid_fixation_stats(self, stats):
        try:
            state = int(stats.get("state", 0))
            count = int(stats.get("count", 0))
            cx = float((stats.get("center") or {}).get("x", 0.0))
            cy = float((stats.get("center") or {}).get("y", 0.0))
            duration_us = float(stats.get("duration_us", 0) or 0)
            if state not in (3, 4):
                return False
            if count <= 0:
                return False
            if not (math.isfinite(cx) and math.isfinite(cy)):
                return False
            if (cx, cy) in [(-1.0, -1.0)]:
                return False
            return duration_us >= 0
        except Exception:
            return False

    def _reset_glasses_fixation_candidate(self, reset_sequence=False):
        self.glasses_fixation_candidate = None
        if reset_sequence:
            self.glasses_fixation_sequence = 0

    def _timestamp_us_from_eye(self, obj):
        try:
            ts = int(getattr(obj, "timestamp", 0) or 0)
            if ts > 0:
                return ts
        except Exception:
            pass
        try:
            return int(time.time() * 1000000)
        except Exception:
            return 0

    def _fallback_fixation_stats_for_glasses(self, obj, gaze_x, gaze_y, gaze_valid, sdk_state=0):
        try:
            x = float(gaze_x)
            y = float(gaze_y)
            if not gaze_valid or not (math.isfinite(x) and math.isfinite(y)):
                candidate = self.glasses_fixation_candidate
                if candidate and candidate.get("mature"):
                    stats = self._stats_from_glasses_candidate(candidate, state=4)
                    self._reset_glasses_fixation_candidate()
                    return stats
                self._reset_glasses_fixation_candidate()
                return self._empty_fixation_stats(state=sdk_state)

            ts_us = self._timestamp_us_from_eye(obj)
            candidate = self.glasses_fixation_candidate
            if candidate is None:
                self.glasses_fixation_sequence += 1
                self.glasses_fixation_candidate = {
                    "id": self.glasses_fixation_sequence,
                    "start_ts_us": ts_us,
                    "last_ts_us": ts_us,
                    "sum_x": x,
                    "sum_y": y,
                    "count": 1,
                    "center_x": x,
                    "center_y": y,
                    "mature": False,
                }
                return self._empty_fixation_stats(state=sdk_state)

            cx = float(candidate.get("center_x", x))
            cy = float(candidate.get("center_y", y))
            dist = math.hypot(x - cx, y - cy)
            if dist > self.glasses_fixation_radius_px:
                end_stats = None
                if candidate.get("mature"):
                    end_stats = self._stats_from_glasses_candidate(candidate, state=4)
                self.glasses_fixation_sequence += 1
                self.glasses_fixation_candidate = {
                    "id": self.glasses_fixation_sequence,
                    "start_ts_us": ts_us,
                    "last_ts_us": ts_us,
                    "sum_x": x,
                    "sum_y": y,
                    "count": 1,
                    "center_x": x,
                    "center_y": y,
                    "mature": False,
                }
                if end_stats is not None:
                    return end_stats
                return self._empty_fixation_stats(state=sdk_state)

            candidate["last_ts_us"] = ts_us
            candidate["sum_x"] = float(candidate.get("sum_x", 0.0)) + x
            candidate["sum_y"] = float(candidate.get("sum_y", 0.0)) + y
            candidate["count"] = int(candidate.get("count", 0)) + 1
            sample_count = max(1, int(candidate.get("count", 1)))
            candidate["center_x"] = float(candidate.get("sum_x", x)) / sample_count
            candidate["center_y"] = float(candidate.get("sum_y", y)) / sample_count
            duration_us = max(0, int(candidate.get("last_ts_us", ts_us)) - int(candidate.get("start_ts_us", ts_us)))
            if sample_count >= self.glasses_fixation_min_samples and duration_us >= self.glasses_fixation_min_duration_us:
                candidate["mature"] = True
                return self._stats_from_glasses_candidate(candidate, state=3)
            return self._empty_fixation_stats(state=sdk_state)
        except Exception:
            return self._empty_fixation_stats(state=sdk_state)

    def _stats_from_glasses_candidate(self, candidate, state):
        try:
            timestamp_us = int(candidate.get("start_ts_us", 0) or 0)
            last_ts_us = int(candidate.get("last_ts_us", timestamp_us) or timestamp_us)
            duration_us = max(0, last_ts_us - timestamp_us)
            sample_count = int(candidate.get("count", 0) or 0)
            center_x = float(candidate.get("center_x", 0.0))
            center_y = float(candidate.get("center_y", 0.0))
            return {
                "timestamp_us": timestamp_us,
                "duration_us": duration_us,
                "timestamp_ms": float(timestamp_us) / 1000.0,
                "duration_ms": float(duration_us) / 1000.0,
                "count": sample_count,
                "state": int(state),
                "center": {"x": center_x, "y": center_y},
                "source": "glasses_fallback",
            }
        except Exception:
            return self._empty_fixation_stats(state=state)

    def _resolve_fixation_stats(self, obj, re_gaze_x, re_gaze_y, gaze_valid=True):
        sdk_stats = self._sdk_fixation_stats(obj)
        if not self._is_glasses_mode():
            return sdk_stats
        if self._is_valid_fixation_stats(sdk_stats):
            self._reset_glasses_fixation_candidate()
            return sdk_stats
        if not self.tracking_active:
            self._reset_glasses_fixation_candidate()
            return sdk_stats
        return self._fallback_fixation_stats_for_glasses(
            obj,
            re_gaze_x,
            re_gaze_y,
            gaze_valid,
            sdk_state=sdk_stats.get("state", 0),
        )

    def _recom_gaze_fields_for_output(self, obj, re_gaze_x, re_gaze_y):
        def point3(point):
            try:
                return (
                    float(getattr(point, "x", 0.0)),
                    float(getattr(point, "y", 0.0)),
                    float(getattr(point, "z", 0.0)),
                )
            except Exception:
                return (0.0, 0.0, 0.0)

        recom = getattr(obj, "recom_gaze", None)
        try:
            recom_mask = int(getattr(recom, "gaze_bit_mask", 0) or 0)
        except Exception:
            recom_mask = 0
        try:
            recom_re = float(getattr(recom, "re", 0.0) or 0.0)
        except Exception:
            recom_re = 0.0

        return {
            "gaze_bit_mask": recom_mask,
            "gaze_point": point3(getattr(recom, "gaze_point", None)),
            "raw_point": point3(getattr(recom, "raw_point", None)),
            "smooth_point": point3(getattr(recom, "smooth_point", None)),
            "gaze_origin": point3(getattr(recom, "gaze_origin", None)),
            "gaze_direction": point3(getattr(recom, "gaze_direction", None)),
            "re": recom_re,
        }

    def stop_tracking(self):
        try:
            if self.driver is not None:
                ret = self.driver.stop_tracking()
                self.tracking_active = False
                return 0 if ret is None else ret
            self.tracking_active = False
            return 0
        except Exception:
            self.tracking_active = False
            return 0

    def set_screen_size(self, width_mm, height_mm):
        if self.driver is None:
            return -1
        try:
            return self.driver.set_screen_size(width_mm, height_mm)
        except Exception:
            return -1

    def set_smooth(self, smooth_way):
        if self.driver is None:
            return -1
        try:
            return self.driver.set_smooth(smooth_way)
        except Exception:
            return -1

    def ensure_loaded(self):
        if self.driver is None:
            self._set_driver(self.sdk_model, self.device_type)
        self._sync_driver_refs()
        if self.sdk is None or self.types is None:
            self.load()
            log("ensure_loaded done")

    def ensure_started(self, device_type=None, model_name=None):
        self.ensure_model(device_type, model_name)
        if not self.started:
            self.ensure_loaded()
            ret = self.start_device()
            log("ensure_started ret", ret)
            return ret
        return 0

    def get_runtime_info(self):
        sdk_root = str(self.sdk_root) if self.sdk_root else ""
        types_dir = str(self.types_dir) if self.types_dir else ""
        config_ini = ""
        try:
            if self.driver is not None and getattr(self.driver, "config_ini", None) is not None:
                config_ini = str(self.driver.config_ini)
        except Exception:
            config_ini = ""
        return {
            "device_type": self.device_type,
            "model": self.sdk_model,
            "record_source": self._record_source_from_device_type(self.device_type),
            "sdk_root": sdk_root,
            "types_dir": types_dir,
            "config_ini": config_ini,
        }

    def _get_record_target_fps(self):
        target_fps = 30.0
        try:
            configured_fps = float(self.record_target_fps)
            if configured_fps > 0:
                target_fps = configured_fps
        except Exception:
            pass
        return max(1.0, min(240.0, float(target_fps)))

    def _glasses_scene_fps(self):
        # 眼镜场景摄像头帧率由硬件固定，aSeeGlasses Plus 1280x720 为 60fps。
        # 允许通过环境变量覆盖，以兼容未来不同帧率的眼镜型号。
        try:
            configured = str(os.getenv("MRT_GLASSES_SCENE_FPS", "")).strip()
            if configured:
                return max(1.0, min(240.0, float(configured)))
        except Exception:
            pass
        return GLASSES_SCENE_FPS

    def _normalize_record_target_fps(self, value):
        try:
            fps = float(value)
        except Exception:
            return 30.0
        best = min(VIDEO_RECORD_FPS_OPTIONS, key=lambda item: abs(item - fps))
        return float(best)

    def _init_video_writer(self, width, height, fps=None):
        writer_path = self.video_path
        if os.name == "nt" and self.video_path:
            writer_path = self._resolve_windows_video_writer_path(self.video_path)
        self.video_actual_path = writer_path

        try:
            writer_fps = self._get_record_target_fps() if fps is None else max(1.0, min(240.0, float(fps)))
        except Exception:
            writer_fps = self._get_record_target_fps()
        # Windows OpenCV wheels commonly lack an H.264 encoder. Prefer the
        # bundled ffmpeg as a one-pass writer so stop does not require a full
        # second transcode and low-end Windows machines retain smoother frames.
        if os.name == "nt":
            ff = self._find_ffmpeg()
            if ff:
                ffmpeg_writer = FfmpegRawVideoWriter(ff, writer_path, width, height, writer_fps)
                if ffmpeg_writer.isOpened():
                    self.video_writer = ffmpeg_writer
                    self.chosen_codec = "h264"
                    log(
                        "video_writer chosen_codec",
                        "ffmpeg-h264",
                        "size=",
                        width,
                        height,
                        "fps=",
                        writer_fps,
                        "path=",
                        writer_path,
                    )
                    return True
                log("ffmpeg raw H.264 writer unavailable; falling back to OpenCV", ffmpeg_writer.last_error)

        # Retain the existing OpenCV path as a compatibility fallback.
        codec_candidates = ['H264', 'h264', 'avc1', 'X264', 'mp4v']
        writer = None
        chosen_codec = None
        for codec in codec_candidates:
            try:
                fourcc = cv2.VideoWriter_fourcc(*codec)
                w = cv2.VideoWriter(writer_path, fourcc, writer_fps, (int(width), int(height)))
                ok = bool(w and w.isOpened())
                log("try codec", codec, "opened=", ok, "fps=", writer_fps)
                if ok:
                    writer = w
                    chosen_codec = codec
                    break
                try:
                    w.release()
                except Exception:
                    pass
            except Exception as e:
                log("codec init error", codec, str(e))

        self.video_writer = writer
        self.chosen_codec = chosen_codec
        log("video_writer chosen_codec", chosen_codec, "size=", width, height, "fps=", writer_fps, "path=", writer_path, "final_path=", self.video_path)
        if not self.video_writer:
            self.last_recording_error = (
                "桌面视频编码器初始化失败"
                f"（已尝试：{', '.join(codec_candidates)}；路径：{writer_path}）"
            )
            self.is_recording = False
            return False

        if chosen_codec and (not self._is_h264_like_codec(chosen_codec)):
            ff = self._find_ffmpeg()
            if ff:
                log("non-h264 codec selected, will transcode on stop", "codec=", chosen_codec, "ffmpeg=", ff)
            else:
                log("warning: non-h264 codec selected and ffmpeg not found", "codec=", chosen_codec)
        return True

    def _record_screen_loop(self):
        log("screen record thread started", "video_path=", self.video_path)
        capture = None
        try:
            with mss.mss() as sct:
                available_monitors = [dict(item) for item in sct.monitors]
                monitor = resolve_capture_monitor(
                    available_monitors,
                    self.record_capture_display,
                    require_target=self.record_split_screen,
                )
                log(
                    "screen capture monitor resolution",
                    "requested=", self.record_capture_display,
                    "split_screen=", self.record_split_screen,
                    "available=", available_monitors,
                    "selected=", monitor,
                )
                if monitor is None:
                    self.last_recording_error = "无法匹配被试显示器，已取消录制，请重新检查分屏配置"
                    self.record_start_success = False
                    self.record_start_ready.set()
                    return
                width, height = recording_frame_size(monitor["width"], monitor["height"])
                self.scene_frame_width = int(width)
                self.scene_frame_height = int(height)
                log("screen recording size", "source", monitor["width"], monitor["height"], "output", width, height)
                capture = ScreenCapture(sct, monitor, log)
                capture.__enter__()

                target_fps = self._get_record_target_fps()
                if not self._init_video_writer(width, height, target_fps):
                    self.record_start_success = False
                    self.record_start_ready.set()
                    return
                self.record_start_success = True
                self.record_start_ready.set()
                frame_interval = 1.0 / target_fps
                next_frame_time = time.perf_counter()
                written_frames = 0
                captured_frames = 0
                profile = str(os.getenv("MRT_RECORD_PROFILE", "")).strip().lower() in ("1", "true", "yes", "on")
                prof_grab_ms = 0.0
                prof_resize_ms = 0.0
                prof_write_ms = 0.0
                prof_frames = 0
                prof_last_at = time.perf_counter()

                while True:
                    with self.record_lock:
                        if not self.is_recording:
                            break
                    # Capture screen
                    t_grab_begin = time.perf_counter() if profile else 0.0
                    frame = capture.grab()
                    t_resize_begin = time.perf_counter() if profile else 0.0
                    if frame.shape[:2] != (height, width):
                        frame = cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
                    t_write_begin = time.perf_counter() if profile else 0.0
                    captured_frames += 1

                    now = time.perf_counter()
                    frames_written_this_round = 0

                    if not self.record_timeline_ready:
                        with self.record_lock:
                            self.record_start_time = time.time()
                            self.record_start_perf = now
                            self.record_first_sample_elapsed_ms = None
                            self.record_timeline_ready = True

                    # Use a monotonic frame schedule. If capture is slower than target FPS,
                    # duplicate the latest frame so encoded video duration stays aligned
                    # with recording elapsed time.
                    while next_frame_time <= now or frames_written_this_round == 0:
                        if self.video_writer:
                            self.video_writer.write(frame)
                        written_frames += 1
                        frames_written_this_round += 1
                        next_frame_time += frame_interval

                    if profile:
                        t_end = time.perf_counter()
                        prof_grab_ms += (t_resize_begin - t_grab_begin) * 1000
                        prof_resize_ms += (t_write_begin - t_resize_begin) * 1000
                        prof_write_ms += (t_end - t_write_begin) * 1000
                        prof_frames += 1
                        if t_end - prof_last_at >= 5.0:
                            log(
                                "record perf",
                                "backend=", capture.backend,
                                "source=", monitor["width"], "x", monitor["height"],
                                "output=", width, "x", height,
                                "target_fps=", target_fps,
                                "grab_ms=", round(prof_grab_ms / prof_frames, 2),
                                "resize_ms=", round(prof_resize_ms / prof_frames, 2),
                                "write_ms=", round(prof_write_ms / prof_frames, 2),
                                "captured=", captured_frames,
                                "written=", written_frames,
                            )
                            prof_grab_ms = 0.0
                            prof_resize_ms = 0.0
                            prof_write_ms = 0.0
                            prof_frames = 0
                            prof_last_at = t_end

                    self.record_written_frames = written_frames
                    self.record_captured_frames = captured_frames

                    delay = next_frame_time - time.perf_counter()
                    if delay > 0:
                        time.sleep(delay)

                self.record_written_frames = written_frames
                self.record_captured_frames = captured_frames
                try:
                    expected_duration_sec = written_frames / target_fps if target_fps > 0 else 0.0
                    log(
                        "record loop stats",
                        "captured_frames=", captured_frames,
                        "written_frames=", written_frames,
                        "target_fps=", target_fps,
                        "expected_duration_sec=", round(expected_duration_sec, 3),
                    )
                except Exception:
                    pass
                        
        except Exception as e:
            self.last_recording_error = f"屏幕录制失败：{e}"
            log("screen record loop error", str(e))
        finally:
            if capture is not None:
                capture.close()
            self.record_start_ready.set()
            if self.video_writer:
                writer = self.video_writer
                writer.release()
                writer_error = str(getattr(writer, "last_error", "") or "").strip()
                if writer_error:
                    self.last_recording_error = writer_error
                self.video_writer = None
            try:
                self._post_process_video()
            except Exception as e:
                log("post_process_video error", str(e))
            try:
                self._finalize_video_output_path()
            except Exception as e:
                log("finalize video path exception", str(e))
            try:
                vp = Path(self.video_path) if self.video_path else None
                ap = Path(self.video_actual_path) if self.video_actual_path else None
                if vp and vp.exists():
                    log("video file exists", str(vp), "bytes=", vp.stat().st_size)
                elif vp:
                    log("video file missing", str(vp))
                if ap and ap.exists() and (not vp or str(ap) != str(vp)):
                    log("video actual file exists", str(ap), "bytes=", ap.stat().st_size)
            except Exception as e:
                log("video file stat error", str(e))
            log("screen record thread finished")

    def _record_stream_loop(self):
        log("stream record thread started", "video_path=", self.video_path)
        try:
            target_fps = self._get_record_target_fps()
            frame_interval = 1.0 / target_fps
            next_frame_time = time.perf_counter()
            first_frame_wait_started = time.perf_counter()
            max_first_frame_wait_sec = 10.0
            try:
                env_wait = float(str(os.getenv("MRT_STREAM_FIRST_FRAME_WAIT_SEC", "")).strip() or "10")
                if env_wait > 0:
                    max_first_frame_wait_sec = env_wait
            except Exception:
                pass

            written_frames = 0
            captured_frames = 0
            last_frame = None
            last_seq = -1
            is_glasses_mode = self._is_glasses_mode()
            warmup_done = False
            warmup_unique_frames = 0
            warmup_first_frame_at = 0.0
            warmup_stable_streak = 0
            warmup_quality_rejects = 0
            warmup_prev_gray_small = None
            warmup_required_unique_frames = 8 if is_glasses_mode else 3
            warmup_min_stable_frames = 4 if is_glasses_mode else 2
            warmup_max_wait_sec = 2.5 if is_glasses_mode else 1.0
            last_decoder_reset_seq = int(getattr(self, "stream_video_reset_seq", 0) or 0)
            try:
                env_frames = int(
                    str(os.getenv("MRT_STREAM_RECORD_WARMUP_FRAMES", "")).strip()
                    or str(warmup_required_unique_frames)
                )
                warmup_required_unique_frames = max(1, min(24, env_frames))
            except Exception:
                warmup_required_unique_frames = 8 if is_glasses_mode else 3
            try:
                env_stable = int(
                    str(os.getenv("MRT_STREAM_RECORD_WARMUP_STABLE_FRAMES", "")).strip()
                    or str(warmup_min_stable_frames)
                )
                warmup_min_stable_frames = max(1, min(12, env_stable))
            except Exception:
                warmup_min_stable_frames = 4 if is_glasses_mode else 2
            try:
                env_wait = float(
                    str(os.getenv("MRT_STREAM_RECORD_WARMUP_WAIT_SEC", "")).strip()
                    or str(warmup_max_wait_sec)
                )
                if env_wait > 0:
                    warmup_max_wait_sec = max(0.2, min(8.0, env_wait))
            except Exception:
                warmup_max_wait_sec = 2.5 if is_glasses_mode else 1.0

            def _is_usable_stream_frame(frame_obj, strict_for_startup=False):
                try:
                    if frame_obj is None:
                        return False
                    if getattr(frame_obj, "size", 0) <= 0:
                        return False
                    flat = frame_obj.ravel()
                    if flat.size <= 0:
                        return False
                    if np.count_nonzero(flat) == 0:
                        return False

                    if len(frame_obj.shape) == 3:
                        gray = cv2.cvtColor(frame_obj, cv2.COLOR_BGR2GRAY)
                    else:
                        gray = frame_obj
                    mean_val = float(np.mean(gray))
                    std_val = float(np.std(gray))
                    if mean_val <= 0.5 or mean_val >= 254.5:
                        return False
                    if std_val < 0.25:
                        return False
                    if is_glasses_mode:
                        return self._is_usable_glasses_scene_frame(frame_obj, strict=strict_for_startup)
                    return True
                except Exception:
                    return False

            def _frame_stability_diff(frame_obj, prev_small):
                try:
                    if len(frame_obj.shape) == 3:
                        gray = cv2.cvtColor(frame_obj, cv2.COLOR_BGR2GRAY)
                    else:
                        gray = frame_obj
                    small = cv2.resize(gray, (160, 90), interpolation=cv2.INTER_AREA)
                    if prev_small is None:
                        return 0.0, small
                    diff = cv2.absdiff(small, prev_small)
                    return float(np.mean(diff)), small
                except Exception:
                    return 0.0, prev_small

            while True:
                with self.record_lock:
                    if not self.is_recording:
                        break
                now = time.perf_counter()

                frame = None
                frame_seq = last_seq
                has_new_frame = False
                decoder_reset_seq = last_decoder_reset_seq
                with self.stream_frame_lock:
                    decoder_reset_seq = int(getattr(self, "stream_video_reset_seq", 0) or 0)
                    if self.latest_stream_frame is not None:
                        try:
                            frame = self.latest_stream_frame.copy()
                            frame_seq = self.latest_stream_frame_seq
                        except Exception:
                            frame = None

                if decoder_reset_seq != last_decoder_reset_seq:
                    last_decoder_reset_seq = decoder_reset_seq
                    warmup_done = False
                    warmup_unique_frames = 0
                    warmup_first_frame_at = 0.0
                    warmup_stable_streak = 0
                    warmup_quality_rejects = 0
                    warmup_prev_gray_small = None
                    first_frame_wait_started = now
                    last_frame = None
                    last_seq = frame_seq
                    next_frame_time = now + frame_interval
                    try:
                        log("stream record warmup reset", "decoder_reset_seq=", decoder_reset_seq)
                    except Exception:
                        pass

                if frame is not None:
                    if last_frame is None or frame_seq != last_seq:
                        has_new_frame = True
                        startup_guard = is_glasses_mode and ((not warmup_done) or written_frames < int(max(1.0, target_fps)))
                        # After warmup with a few frames written, skip the expensive
                        # quality check – image_callback already filtered bad frames
                        # via _is_usable_glasses_scene_frame(strict=True) before
                        # placing them into latest_stream_frame.
                        if startup_guard or not is_glasses_mode:
                            if not _is_usable_stream_frame(frame, strict_for_startup=startup_guard):
                                frame = None
                                has_new_frame = False
                                if not warmup_done:
                                    warmup_quality_rejects += 1
                    if frame is not None and has_new_frame:
                        if not warmup_done:
                            frame_diff, warmup_prev_gray_small = _frame_stability_diff(frame, warmup_prev_gray_small)
                            diff_threshold = 24.0 if is_glasses_mode else 32.0
                            if frame_diff <= diff_threshold:
                                warmup_stable_streak += 1
                            else:
                                warmup_stable_streak = 1
                        if not frame.flags["C_CONTIGUOUS"]:
                            frame = np.ascontiguousarray(frame)
                        last_frame = frame
                        last_seq = frame_seq
                        captured_frames += 1

                if last_frame is None:
                    if now - first_frame_wait_started > max_first_frame_wait_sec:
                        self.last_recording_error = f"视频流不可用，{max_first_frame_wait_sec:.1f}s 内未收到设备图像帧"
                        with self.record_lock:
                            self.is_recording = False
                        break
                    next_frame_time = now + frame_interval
                    continue

                if not warmup_done:
                    if has_new_frame:
                        warmup_unique_frames += 1
                        if warmup_first_frame_at <= 0:
                            warmup_first_frame_at = now
                    warmup_elapsed = (now - warmup_first_frame_at) if warmup_first_frame_at > 0 else 0.0
                    warmup_requirements_met = (
                        warmup_unique_frames >= warmup_required_unique_frames
                        and warmup_stable_streak >= warmup_min_stable_frames
                    )
                    if (not warmup_requirements_met) and warmup_elapsed < warmup_max_wait_sec:
                        next_frame_time = now + frame_interval
                        continue
                    warmup_done = True
                    next_frame_time = now + frame_interval
                    try:
                        log(
                            "stream record warmup done",
                            "required_frames=",
                            warmup_required_unique_frames,
                            "seen_frames=",
                            warmup_unique_frames,
                            "stable_streak=",
                            warmup_stable_streak,
                            "min_stable=",
                            warmup_min_stable_frames,
                            "quality_rejects=",
                            warmup_quality_rejects,
                            "elapsed_sec=",
                            round(warmup_elapsed, 3),
                        )
                    except Exception:
                        pass

                if self.video_writer is None:
                    h, w = last_frame.shape[:2]
                    if w <= 0 or h <= 0:
                        next_frame_time = now + frame_interval
                        continue
                    if not self._init_video_writer(w, h, target_fps):
                        return

                frames_written_this_round = 0
                while next_frame_time <= now or frames_written_this_round == 0:
                    if self.video_writer:
                        self.video_writer.write(last_frame)
                    written_frames += 1
                    frames_written_this_round += 1
                    next_frame_time += frame_interval

                self.record_written_frames = written_frames
                self.record_captured_frames = captured_frames

                delay = next_frame_time - time.perf_counter()
                if delay > 0:
                    time.sleep(delay)
                else:
                    # Yield CPU time to asyncio event loop and other threads
                    # when behind schedule, preventing WebSocket starvation.
                    time.sleep(0)

            self.record_written_frames = written_frames
            self.record_captured_frames = captured_frames
            try:
                expected_duration_sec = written_frames / target_fps if target_fps > 0 else 0.0
                log(
                    "stream record loop stats",
                    "captured_frames=", captured_frames,
                    "written_frames=", written_frames,
                    "target_fps=", target_fps,
                    "expected_duration_sec=", round(expected_duration_sec, 3),
                )
            except Exception:
                pass
        except Exception as e:
            log("stream record loop error", str(e))
        finally:
            if self.video_writer:
                writer = self.video_writer
                writer.release()
                writer_error = str(getattr(writer, "last_error", "") or "").strip()
                if writer_error:
                    self.last_recording_error = writer_error
                self.video_writer = None
            try:
                self._post_process_video()
            except Exception as e:
                log("post_process_video error", str(e))
            try:
                self._finalize_video_output_path()
            except Exception as e:
                log("finalize video path exception", str(e))
            try:
                vp = Path(self.video_path) if self.video_path else None
                ap = Path(self.video_actual_path) if self.video_actual_path else None
                if vp and vp.exists():
                    log("video file exists", str(vp), "bytes=", vp.stat().st_size)
                elif vp:
                    log("video file missing", str(vp))
                if ap and ap.exists() and (not vp or str(ap) != str(vp)):
                    log("video actual file exists", str(ap), "bytes=", ap.stat().st_size)
            except Exception as e:
                log("video file stat error", str(e))
            log("stream record thread finished")

    def _safe_subject_name(self, name: str) -> str:
        return safe_subject_name(name)

    def _post_process_video(self):
        prior_recording_error = str(self.last_recording_error or "").strip()
        try:
            source_path = self.video_actual_path or self.video_path
            vp = Path(source_path) if source_path else None
            if not vp or not vp.exists():
                return
            cc = (self.chosen_codec or "").lower()
            if self._is_h264_like_codec(cc):
                self.video_actual_path = str(vp)
                return
            ff = self._find_ffmpeg()
            if not ff:
                self.last_recording_error = "ffmpeg not found for non-h264 transcode"
                log("post_process_video skip: ffmpeg not found", "path=", str(vp))
                return
            log("post_process_video using ffmpeg", "codec=", cc, "ffmpeg=", ff, "path=", str(vp))
            out_tmp = vp.with_name(vp.stem + "_h264.mp4")
            cmd = [
                ff,
                "-y",
                "-i",
                str(vp),
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                "-an",
                str(out_tmp),
            ]
            run_kwargs = {
                "stdout": subprocess.PIPE,
                "stderr": subprocess.PIPE,
            }
            if os.name == "nt":
                try:
                    startupinfo = subprocess.STARTUPINFO()
                    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                    startupinfo.wShowWindow = 0
                    run_kwargs["startupinfo"] = startupinfo
                    run_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                except Exception:
                    pass
            r = subprocess.run(cmd, **run_kwargs)
            if r.returncode != 0:
                try:
                    stderr_text = r.stderr.decode("utf-8", errors="ignore").strip()
                except Exception:
                    stderr_text = ""
                self.last_recording_error = f"ffmpeg transcode failed ({r.returncode})"
                log("post_process_video ffmpeg failed", "code=", r.returncode, "path=", str(vp), "stderr=", stderr_text)
                return
            if not out_tmp.exists():
                return
            try:
                size_ok = out_tmp.stat().st_size > 0
            except Exception:
                size_ok = False
            if not size_ok:
                return
            backup = vp.with_name(vp.stem + ".bak.mp4")
            try:
                if backup.exists():
                    backup.unlink()
                vp.replace(backup)
                out_tmp.replace(vp)
            except Exception as error:
                self.last_recording_error = f"ffmpeg transcode replace failed: {error}"
                log("post_process_video replace failed", "path=", str(vp), "error=", str(error))
                try:
                    if backup.exists() and not vp.exists():
                        backup.replace(vp)
                except Exception as restore_error:
                    log("post_process_video restore backup failed", str(restore_error))
                return
            try:
                if backup.exists():
                    backup.unlink()
            except Exception:
                pass
            self.video_actual_path = str(vp)
            self.chosen_codec = "h264"
            if not prior_recording_error:
                self.last_recording_error = ""
            log("post_process_video success", "path=", str(vp))
        except Exception as e:
            self.last_recording_error = prior_recording_error or f"video post-process failed: {e}"
            log("post_process_video exception", str(e))

    def _probe_recorded_video_duration_seconds(self) -> float:
        source_path = self.video_path or self.video_actual_path
        capture = None
        try:
            if not source_path or not Path(source_path).exists():
                return 0.0
            capture = cv2.VideoCapture(str(source_path))
            if not capture or not capture.isOpened():
                return 0.0
            fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
            frames = float(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0)
            duration = frames / fps if fps > 0 and frames > 0 else 0.0
            return duration if math.isfinite(duration) and duration > 0 else 0.0
        except Exception as e:
            log("probe recorded video duration failed", str(e))
            return 0.0
        finally:
            if capture is not None:
                try:
                    capture.release()
                except Exception:
                    pass
    
    def _find_ffmpeg(self):
        try:
            env_candidates = [
                os.environ.get("MRT_FFMPEG_PATH", ""),
                os.environ.get("MRT_FFMPEG", ""),
                os.environ.get("FFMPEG_PATH", ""),
            ]
            for candidate in env_candidates:
                c = str(candidate or "").strip().strip('"')
                if not c:
                    continue
                try:
                    p = Path(c)
                    if p.exists() and p.is_file():
                        return str(p)
                except Exception:
                    continue

            try:
                from_path = shutil.which("ffmpeg")
                if from_path:
                    return from_path
            except Exception:
                pass

            here = Path(__file__).resolve()
            binary_name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
            candidates = []
            for base in [here.parent, *here.parents]:
                candidates.append(base / binary_name)
                candidates.append(base / "bin" / binary_name)
                candidates.append(base / "ffbuild" / binary_name)
                candidates.append(base / "Tool" / binary_name)
                candidates.append(base / "Tool" / "bin" / binary_name)
                candidates.append(base / "tool" / binary_name)
                candidates.append(base / "tool" / "bin" / binary_name)
                tool_dir = base / "Tool"
                if tool_dir.exists():
                    try:
                        for d in tool_dir.iterdir():
                            if d.is_dir() and d.name.lower().startswith("ffmpeg"):
                                candidates.append(d / binary_name)
                                candidates.append(d / "bin" / binary_name)
                                candidates.append(d / "ffbuild" / binary_name)
                    except Exception:
                        pass
                tool_dir_lower = base / "tool"
                if tool_dir_lower.exists():
                    try:
                        for d in tool_dir_lower.iterdir():
                            if d.is_dir() and d.name.lower().startswith("ffmpeg"):
                                candidates.append(d / binary_name)
                                candidates.append(d / "bin" / binary_name)
                                candidates.append(d / "ffbuild" / binary_name)
                    except Exception:
                        pass

            if os.name == "nt":
                for env_key in ("ProgramFiles", "ProgramFiles(x86)"):
                    root = str(os.environ.get(env_key, "") or "").strip()
                    if not root:
                        continue
                    base = Path(root)
                    candidates.append(base / "ffmpeg" / "bin" / "ffmpeg.exe")
                    candidates.append(base / "FFmpeg" / "bin" / "ffmpeg.exe")

            seen = set()
            for c in candidates:
                try:
                    key = str(c).lower() if os.name == "nt" else str(c)
                    if key in seen:
                        continue
                    seen.add(key)
                    if c.exists() and c.is_file():
                        return str(c)
                except Exception:
                    pass
            return None
        except Exception:
            return None

    def _csv_header(self):
        header = [
            "timestamp",
            "video_time_ms",
            "recommend",
            "recom_gaze_x",
            "recom_gaze_y",
            "recom_gaze_bit_mask",
            "recom_gaze_point_x",
            "recom_gaze_point_y",
            "recom_gaze_point_z",
            "recom_raw_point_x",
            "recom_raw_point_y",
            "recom_raw_point_z",
            "recom_smooth_point_x",
            "recom_smooth_point_y",
            "recom_smooth_point_z",
            "recom_origin_x",
            "recom_origin_y",
            "recom_origin_z",
            "recom_direction_x",
            "recom_direction_y",
            "recom_direction_z",
            "recom_re",
        ]
        header.extend(
            [
                "left_gaze_bit_mask",
                "left_gaze_point_x",
                "left_gaze_point_y",
                "left_gaze_point_z",
                "left_raw_point_x",
                "left_raw_point_y",
                "left_raw_point_z",
                "left_smooth_point_x",
                "left_smooth_point_y",
                "left_smooth_point_z",
                "left_origin_x",
                "left_origin_y",
                "left_origin_z",
                "left_direction_x",
                "left_direction_y",
                "left_direction_z",
                "left_re",
            ]
        )
        # header.append("left_ex_data_0")
        header.extend(
            [
                "right_gaze_bit_mask",
                "right_gaze_point_x",
                "right_gaze_point_y",
                "right_gaze_point_z",
                "right_raw_point_x",
                "right_raw_point_y",
                "right_raw_point_z",
                "right_smooth_point_x",
                "right_smooth_point_y",
                "right_smooth_point_z",
                "right_origin_x",
                "right_origin_y",
                "right_origin_z",
                "right_direction_x",
                "right_direction_y",
                "right_direction_z",
                "right_re",
            ]
        )
        header.extend(
            [
                "left_pupil_bit_mask",
                "left_pupil_center_x",
                "left_pupil_center_y",
                "left_pupil_distance",
                "left_pupil_diameter",
                "left_pupil_diameter_mm",
                "left_pupil_minor_axis",
                "left_pupil_minor_axis_mm",
            ]
        )
        header.extend(
            [
                "right_pupil_bit_mask",
                "right_pupil_center_x",
                "right_pupil_center_y",
                "right_pupil_distance",
                "right_pupil_diameter",
                "right_pupil_diameter_mm",
                "right_pupil_minor_axis",
                "right_pupil_minor_axis_mm",
            ]
        )
        header.extend(
            [
                "left_eye_data_ex_bit_mask",
                "left_blink",
                "left_openness",
                "left_eyelid_up",
                "left_eyelid_down",
                "left_ex_data_bit_mask",
            ]
        )
        header.extend(
            [
                "right_eye_data_ex_bit_mask",
                "right_blink",
                "right_openness",
                "right_eyelid_up",
                "right_eyelid_down",
                "right_ex_data_bit_mask",
            ]
        )
        header.extend(
            [
                "fixation_timestamp",
                "fixation_duration",
                "fixation_timestamp_us",
                "fixation_duration_us",
                "fixation_timestamp_ms",
                "fixation_duration_ms",
                "fixation_count",
                "fixation_state",
                "fixation_center_x",
                "fixation_center_y",
                "stimulus",
                "triggerMark",
                "customMarker",
            ]
        )
        if self._is_glasses_mode():
            header.extend(
                [
                    "gyro_timestamp",
                    "quat_data[0]",
                    "quat_data[1]",
                    "quat_data[2]",
                    "quat_data[3]",
                    "gyro[0]",
                    "gyro[1]",
                    "gyro[2]",
                    "accel[0]",
                    "accel[1]",
                    "accel[2]",
                    "mag[0]",
                    "mag[1]",
                    "mag[2]",
                ]
            )
        return header

    def _format_csv_decimal(self, value, digits=6):
        if isinstance(value, bool):
            return value
        try:
            if isinstance(value, (float, np.floating)):
                numeric = float(value)
                if not math.isfinite(numeric):
                    return value
                text = f"{numeric:.{digits}f}".rstrip("0").rstrip(".")
                return "0" if text in ("", "-0") else text
        except Exception:
            return value
        return value

    def _csv_row_from_eye(self, obj, re_gaze_x, re_gaze_y, fixation_stats=None, recom_output=None):
        raw_elapsed_ms = 0
        try:
            if self.record_start_perf:
                raw_elapsed_ms = int((time.perf_counter() - self.record_start_perf) * 1000)
        except Exception:
            raw_elapsed_ms = 0
        if self.record_first_sample_elapsed_ms is None:
            self.record_first_sample_elapsed_ms = raw_elapsed_ms
        elapsed_base_ms = int(self.record_first_sample_elapsed_ms or 0)
        elapsed_ms = max(0, raw_elapsed_ms - elapsed_base_ms)
        if recom_output is None:
            recom_output = self._recom_gaze_fields_for_output(obj, re_gaze_x, re_gaze_y)
        recom_gaze_point = recom_output.get("gaze_point", (0.0, 0.0, 0.0))
        recom_raw_point = recom_output.get("raw_point", (0.0, 0.0, 0.0))
        recom_smooth_point = recom_output.get("smooth_point", (0.0, 0.0, 0.0))
        recom_origin = recom_output.get("gaze_origin", (0.0, 0.0, 0.0))
        recom_direction = recom_output.get("gaze_direction", (0.0, 0.0, 0.0))
        row = [
            obj.timestamp,
            elapsed_ms,
            obj.recommend,
            re_gaze_x,
            re_gaze_y,
            recom_output.get("gaze_bit_mask", 0),
            recom_gaze_point[0],
            recom_gaze_point[1],
            recom_gaze_point[2],
            recom_raw_point[0],
            recom_raw_point[1],
            recom_raw_point[2],
            recom_smooth_point[0],
            recom_smooth_point[1],
            recom_smooth_point[2],
            recom_origin[0],
            recom_origin[1],
            recom_origin[2],
            recom_direction[0],
            recom_direction[1],
            recom_direction[2],
            recom_output.get("re", 0.0),
        ]
        row.extend(
            [
                obj.left_gaze.gaze_bit_mask,
                obj.left_gaze.gaze_point.x,
                obj.left_gaze.gaze_point.y,
                obj.left_gaze.gaze_point.z,
                obj.left_gaze.raw_point.x,
                obj.left_gaze.raw_point.y,
                obj.left_gaze.raw_point.z,
                obj.left_gaze.smooth_point.x,
                obj.left_gaze.smooth_point.y,
                obj.left_gaze.smooth_point.z,
                obj.left_gaze.gaze_origin.x,
                obj.left_gaze.gaze_origin.y,
                obj.left_gaze.gaze_origin.z,
                obj.left_gaze.gaze_direction.x,
                obj.left_gaze.gaze_direction.y,
                obj.left_gaze.gaze_direction.z,
                obj.left_gaze.re,
            ]
        )
        row.extend(
            [
                obj.right_gaze.gaze_bit_mask,
                obj.right_gaze.gaze_point.x,
                obj.right_gaze.gaze_point.y,
                obj.right_gaze.gaze_point.z,
                obj.right_gaze.raw_point.x,
                obj.right_gaze.raw_point.y,
                obj.right_gaze.raw_point.z,
                obj.right_gaze.smooth_point.x,
                obj.right_gaze.smooth_point.y,
                obj.right_gaze.smooth_point.z,
                obj.right_gaze.gaze_origin.x,
                obj.right_gaze.gaze_origin.y,
                obj.right_gaze.gaze_origin.z,
                obj.right_gaze.gaze_direction.x,
                obj.right_gaze.gaze_direction.y,
                obj.right_gaze.gaze_direction.z,
                obj.right_gaze.re,
            ]
        )
        row.extend(
            [
                obj.left_pupil.pupil_bit_mask,
                obj.left_pupil.pupil_center.x,
                obj.left_pupil.pupil_center.y,
                obj.left_pupil.pupil_distance,
                obj.left_pupil.pupil_diameter,
                obj.left_pupil.pupil_diameter_mm,
                obj.left_pupil.pupil_minor_axis,
                obj.left_pupil.pupil_minor_axis_mm,
        ]
        )
        row.extend(
            [
                obj.right_pupil.pupil_bit_mask,
                obj.right_pupil.pupil_center.x,
                obj.right_pupil.pupil_center.y,
                obj.right_pupil.pupil_distance,
                obj.right_pupil.pupil_diameter,
                obj.right_pupil.pupil_diameter_mm,
                obj.right_pupil.pupil_minor_axis,
                obj.right_pupil.pupil_minor_axis_mm,
            ]
        )
        row.extend(
            [
                obj.left_ex_data.eye_data_ex_bit_mask,
                obj.left_ex_data.blink,
                obj.left_ex_data.openness,
                obj.left_ex_data.eyelid_up,
                obj.left_ex_data.eyelid_down,
                obj.left_ex_data.ex_data_bit_mask,
            ]
        )
        row.extend(
            [
                obj.right_ex_data.eye_data_ex_bit_mask,
                obj.right_ex_data.blink,
                obj.right_ex_data.openness,
                obj.right_ex_data.eyelid_up,
                obj.right_ex_data.eyelid_down,
                obj.right_ex_data.ex_data_bit_mask,
            ]
        )

        if fixation_stats is None:
            fixation_stats = self._resolve_fixation_stats(obj, re_gaze_x, re_gaze_y)
        fixation_timestamp_us = fixation_stats.get("timestamp_us", 0)
        fixation_duration_us = fixation_stats.get("duration_us", 0)
        try:
            fixation_timestamp_ms = float(fixation_stats.get("timestamp_ms", float(fixation_timestamp_us) / 1000.0))
        except Exception:
            fixation_timestamp_ms = ""
        try:
            fixation_duration_ms = float(fixation_stats.get("duration_ms", float(fixation_duration_us) / 1000.0))
        except Exception:
            fixation_duration_ms = ""
        fixation_center = fixation_stats.get("center", {"x": 0.0, "y": 0.0}) or {"x": 0.0, "y": 0.0}

        row.extend(
            [
                fixation_timestamp_ms,
                fixation_duration_ms,
                fixation_timestamp_us,
                fixation_duration_us,
                fixation_timestamp_ms,
                fixation_duration_ms,
                fixation_stats.get("count", 0),
                fixation_stats.get("state", 0),
                fixation_center.get("x", 0.0),
                fixation_center.get("y", 0.0),
            ]
        )
        row.append(getattr(self, "current_stimulus", ""))
        
        # Add marker columns
        trigger_mark = ""
        custom_marker_names = []

        # Emit each marker only once (first sample row whose elapsed time reaches marker timestamp)
        with self.recording_markers_lock:
            for i, marker in enumerate(self.recording_markers):
                if i in self.recording_markers_emitted:
                    continue
                marker_ts = int(marker.get('timestamp', 0) or 0)
                marker_elapsed_ms = max(0, marker_ts - elapsed_base_ms)
                if elapsed_ms < marker_elapsed_ms:
                    continue

                self.recording_markers_emitted.add(i)
                if marker.get('type') == 'trigger':
                    trigger_mark = str(marker.get('triggerValue', ''))
                elif marker.get('type') == 'custom':
                    marker_name = str(marker.get('name', '') or '').strip()
                    if marker_name:
                        custom_marker_names.append(marker_name)

        custom_marker = ",".join(custom_marker_names)
        
        row.append(trigger_mark)
        row.append(custom_marker)

        if self._is_glasses_mode():
            gyro = getattr(obj, "gyro", None)

            def gyro_component(name, index):
                try:
                    values = getattr(gyro, name, None)
                    return float(values[index]) if values is not None else ""
                except Exception:
                    return ""

            try:
                gyro_timestamp = int(getattr(gyro, "timestamp", 0) or 0) if gyro is not None else ""
            except Exception:
                gyro_timestamp = ""
            row.extend(
                [
                    gyro_timestamp,
                    gyro_component("quat_data", 0),
                    gyro_component("quat_data", 1),
                    gyro_component("quat_data", 2),
                    gyro_component("quat_data", 3),
                    gyro_component("gyro", 0),
                    gyro_component("gyro", 1),
                    gyro_component("gyro", 2),
                    gyro_component("accel", 0),
                    gyro_component("accel", 1),
                    gyro_component("accel", 2),
                    gyro_component("mag", 0),
                    gyro_component("mag", 1),
                    gyro_component("mag", 2),
                ]
            )
        
        return [self._format_csv_decimal(value, 6) for value in row]

    def add_custom_marker(self, name: str, timestamp: int):
        """Add a custom marker during recording"""
        if not self.is_recording:
            log("add_custom_marker ignored (not recording)")
            return None
        
        marker = {
            'type': 'custom',
            'name': name,
            'timestamp': timestamp,
            'videoTime': timestamp,
        }
        with self.recording_markers_lock:
            self.recording_markers.append(marker)
        log(f"Custom marker added: {name} at {timestamp}ms")
        return marker
    
    def add_trigger_marker(self, trigger_value: int, timestamp: int):
        """Add a trigger marker during recording"""
        if not self.is_recording:
            log("add_trigger_marker ignored (not recording)")
            return None
        
        marker = {
            'type': 'trigger',
            'triggerValue': trigger_value,
            'timestamp': timestamp,
            'videoTime': timestamp,
        }
        with self.recording_markers_lock:
            self.recording_markers.append(marker)
        log(f"Trigger marker added: {trigger_value} at {timestamp}ms")
        return marker
    
    def on_trigger_received(self, trigger_value: int):
        """
        Callback method to be invoked when a trigger signal is received from hardware.
        
        This method is designed to be called by external trigger hardware integration
        (e.g., parallel port, serial port, USB device, or future SDK trigger support).
        
        Args:
            trigger_value: The trigger signal value (typically 0-255 for TTL signals)
        
        Returns:
            The created marker object if recording is active, None otherwise
        
        Note:
            Currently, the eye-tracking SDK does not provide built-in trigger signal
            reception. This method provides the infrastructure for when trigger hardware
            becomes available. Possible integration methods:
            
            1. Parallel port (LPT) - for TTL trigger signals
            2. Serial port (COM) - for serial trigger devices
            3. USB trigger device - custom USB hardware
            4. Future SDK callback - if SDK adds trigger support
            5. Network triggers - from external stimulus presentation software
        """
        if not self.is_recording:
            log("on_trigger_received ignored (not recording)")
            return None
        
        # Calculate timestamp relative to recording start
        current_time = time.time()
        timestamp = int((current_time - self.record_start_time) * 1000)
        
        # Add the trigger marker
        marker = self.add_trigger_marker(trigger_value, timestamp)
        
        log(f"Hardware trigger received: value={trigger_value}, timestamp={timestamp}ms")
        return marker
    
    def get_recording_markers(self):
        """Get all recording markers"""
        with self.recording_markers_lock:
            return self.recording_markers.copy()

    def clear_recording_markers(self):
        """Clear all recording markers"""
        with self.recording_markers_lock:
            self.recording_markers.clear()
            self.recording_markers_emitted.clear()
        log("Recording markers cleared")

    def start_recording(self, project_path=None, subject_name: str = "", video_sampling_rate_hz=None, capture_display=None, split_screen=False):
        with self.record_finalize_lock:
            if self.recording_finalizing:
                self.last_recording_error = "上一段录制仍在保存处理中，请等待保存完成"
                log("start_recording blocked: previous recording is finalizing")
                return -1
        with self.record_lock:
            if self.is_recording:
                return 0
            if self.record_thread and self.record_thread.is_alive():
                self.last_recording_error = "上一段录制仍在收尾处理中，请稍后再试"
                log("start_recording blocked: previous record thread still alive")
                return -1
        self.last_recording_error = ""
        self.record_target_fps = self._normalize_record_target_fps(video_sampling_rate_hz)
        self.record_capture_display = capture_display if isinstance(capture_display, dict) else None
        self.record_split_screen = bool(split_screen)
        if not self.started:
            self.last_recording_error = "设备未启动，请先启动设备后再录制"
            log("start_recording blocked: device is not started")
            return -1

        self.clear_recording_markers()
        self._reset_glasses_fixation_candidate(reset_sequence=True)

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        project_path_str = project_path if isinstance(project_path, str) else ""
        try:
            project_path_str = (project_path_str or "").strip()
        except Exception:
            project_path_str = ""

        try:
            if project_path_str:
                project_root = self.handle_path(project_path_str)
                record_dir = self.handle_path(project_root / "recordings", create_dir=True)
            else:
                record_dir = self.handle_path(Path(__file__).parent / "recordings", create_dir=True)
        except Exception as e:
            self.last_recording_error = f"recordings path resolve failed: {e}"
            log("start_recording path handling failed", str(e))
            return -1

        self.record_dir = str(record_dir)

        try:
            self.current_subject_name = str(subject_name or "").strip()
        except Exception:
            self.current_subject_name = ""
        safe_name = self._safe_subject_name(self.current_subject_name)

        video_path = record_dir / f"{safe_name}_{timestamp}.mp4"
        csv_path = record_dir / f"{safe_name}_{timestamp}.csv"
        self.current_record_name = f"{safe_name}_{timestamp}"

        try:
            self.video_path = str(video_path)
            self.video_actual_path = str(video_path)
            self.csv_path = str(csv_path)
            log("start_recording resolved", "project_path=", project_path_str or None, "record_dir=", str(record_dir), "video=", self.video_path, "csv=", self.csv_path)
            self.csv_file = open(str(csv_path), 'w', newline='', encoding='utf-8')
            self.csv_writer = csv.writer(self.csv_file)
            header = self._csv_header()
            self.csv_writer.writerow(header)
            try:
                self.csv_file.flush()
            except Exception:
                pass

            self.record_start_time = time.time()
            self.record_start_perf = time.perf_counter()
            self.record_timeline_ready = False
            self.record_first_sample_elapsed_ms = None
            self.record_written_frames = 0
            self.record_captured_frames = 0
            self.csv_flush_counter = 0
            self.record_source = self._record_source_from_device_type(self.device_type)
            if self.record_source == "stream":
                self.current_stimulus = self.current_record_name
                if not self._start_encoded_stream_recording():
                    try:
                        self.csv_file.close()
                    except Exception:
                        pass
                    self.csv_file = None
                    self.csv_writer = None
                    with self.record_lock:
                        self.is_recording = False
                        self.record_timeline_ready = False
                    return -1
            with self.stream_frame_lock:
                self.latest_stream_frame = None
                self.latest_stream_frame_seq = 0

            record_target = self._record_encoded_stream_loop if self.record_source == "stream" else self._record_screen_loop
            self.record_thread = threading.Thread(target=record_target)
            self.record_thread.daemon = True
            self.record_start_success = self.record_source == "stream"
            self.record_start_ready.clear()

            # Status from an older recording must never be reported for this
            # new capture, especially if its worker exits before stop is sent.
            with self.record_finalize_lock:
                self.record_finalize_last_result = None

            with self.record_lock:
                self.is_recording = True

            self.record_thread.start()

            if self.record_source == "screen":
                start_wait_sec = 4.0
                try:
                    configured_wait = float(
                        str(os.getenv("MRT_RECORD_START_WAIT_SEC", "")).strip() or "4"
                    )
                    if configured_wait > 0:
                        start_wait_sec = max(1.0, min(5.0, configured_wait))
                except Exception:
                    pass
                start_ready = self.record_start_ready.wait(timeout=start_wait_sec)
                if not start_ready or not self.record_start_success:
                    if not self.last_recording_error:
                        self.last_recording_error = (
                            f"桌面录制启动超时（{start_wait_sec:.1f}s 内编码器未就绪）"
                            if not start_ready
                            else "桌面录制编码器未就绪"
                        )
                    with self.record_lock:
                        self.is_recording = False
                        self.record_timeline_ready = False
                    record_thread_ref = self.record_thread
                    if record_thread_ref and record_thread_ref.is_alive():
                        record_thread_ref.join(timeout=1.0)
                    if record_thread_ref and not record_thread_ref.is_alive():
                        self.record_thread = None
                    if self.csv_file:
                        try:
                            self.csv_file.flush()
                            self.csv_file.close()
                        except Exception:
                            pass
                    self.csv_file = None
                    self.csv_writer = None
                    for failed_path in {self.video_actual_path, self.video_path, self.csv_path}:
                        if not failed_path:
                            continue
                        try:
                            artifact = Path(failed_path)
                            if artifact.exists():
                                artifact.unlink()
                        except Exception as cleanup_error:
                            log("failed recording artifact cleanup error", failed_path, str(cleanup_error))
                    log("start_recording desktop capture not ready", self.last_recording_error)
                    return -1

            log(f"Started recording to {video_path} and {csv_path}", "source=", self.record_source, "device_type=", self.device_type, "video_sampling_rate_hz=", self.record_target_fps)
            return 0
        except Exception as e:
            self.last_recording_error = str(e)
            log("start_recording exception", str(e))
            if self.record_source == "stream":
                try:
                    self._signal_encoded_stream_recording_stop()
                except Exception:
                    pass
            # Clean up csv_file if it was opened before the failure
            if self.csv_file:
                try:
                    self.csv_file.close()
                except Exception:
                    pass
                self.csv_file = None
                self.csv_writer = None
            with self.record_lock:
                self.is_recording = False
                self.record_timeline_ready = False
            return -1

    def _notify_recording_finalized(self, payload):
        if self.loop is None:
            return
        try:
            message = json.dumps(payload, ensure_ascii=False)
            self.loop.call_soon_threadsafe(self.notify_queue.put_nowait, message)
        except Exception as e:
            log("recording finalized notification failed", str(e))

    def _recording_finalize_worker(self, recording_id, video_path, csv_path):
        started_at = time.time()
        error_code = 0
        error_message = ""
        try:
            ret = self.stop_recording()
            if ret != 0:
                error_code = ret
                error_message = self.last_recording_error or "录制文件保存失败"

            record_thread_ref = self.record_thread
            if record_thread_ref and record_thread_ref.is_alive():
                error_code = -1
                error_message = self.last_recording_error or "录制线程仍在收尾处理中"

            if error_code == 0 and self.last_recording_error:
                error_code = -1
                error_message = self.last_recording_error

            video_file = Path(video_path) if video_path else None
            if error_code == 0 and (not video_file or not video_file.exists()):
                error_code = -1
                error_message = "录制视频文件不存在"
            elif error_code == 0:
                try:
                    if video_file.stat().st_size <= 0:
                        error_code = -1
                        error_message = "录制视频文件为空"
                except Exception as e:
                    error_code = -1
                    error_message = f"无法检查录制视频文件：{e}"

        except Exception as e:
            error_code = -1
            error_message = str(e) or "录制文件保存异常"
            self.last_recording_error = error_message
            log("recording finalize worker exception", error_message)
        finally:
            elapsed_ms = int(round((time.time() - started_at) * 1000))
            video_size = 0
            try:
                if video_path and Path(video_path).exists():
                    video_size = int(Path(video_path).stat().st_size)
            except Exception:
                pass
            payload = {
                "type": "notify_recording_finalized",
                "recording_id": recording_id,
                "error": error_code,
                "msg": "ok" if error_code == 0 else (error_message or "录制文件保存失败"),
                "video_path": video_path or "",
                "csv_path": csv_path or "",
                "video_size": video_size,
                "elapsed_ms": elapsed_ms,
            }
            with self.record_finalize_lock:
                self.recording_finalizing = False
                self.record_finalize_thread = None
                self.record_finalize_last_result = dict(payload)
            log("recording finalize worker finished", payload)
            self._notify_recording_finalized(payload)

    def begin_stop_recording(self):
        with self.record_finalize_lock:
            if self.recording_finalizing:
                return {
                    "accepted": True,
                    "recording_id": self.current_record_name or "",
                    "video_path": self.video_path or "",
                    "csv_path": self.csv_path or "",
                }
            with self.record_lock:
                is_recording = bool(self.is_recording)
                record_thread_alive = bool(self.record_thread and self.record_thread.is_alive())
            if not is_recording and not record_thread_alive:
                # A capture thread can terminate before the UI sends stop (for
                # example after a VideoWriter/MSS failure). If this recording
                # has no finalization result yet, still close/validate it so the
                # renderer receives the real backend error instead of `idle`.
                has_recording_context = bool(
                    self.current_record_name and (self.video_path or self.csv_path)
                )
                if self.record_finalize_last_result or not has_recording_context:
                    return {
                        "accepted": False,
                        "recording_id": self.current_record_name or "",
                        "video_path": self.video_path or "",
                        "csv_path": self.csv_path or "",
                    }
                log(
                    "recording finalize recovery started for inactive capture",
                    "recording_id=", self.current_record_name or None,
                    "video=", self.video_path or None,
                    "csv=", self.csv_path or None,
                    "last_error=", self.last_recording_error or None,
                )

            recording_id = self.current_record_name or f"recording_{int(time.time() * 1000)}"
            video_path = self.video_path or ""
            csv_path = self.csv_path or ""
            self.recording_finalizing = True
            self.record_finalize_last_result = None
            with self.record_lock:
                self.is_recording = False
                self.record_timeline_ready = False
            worker = threading.Thread(
                target=self._recording_finalize_worker,
                args=(recording_id, video_path, csv_path),
                name=f"recording-finalize-{recording_id}",
                daemon=True,
            )
            self.record_finalize_thread = worker
            worker.start()
            log("recording finalize worker started", "recording_id=", recording_id, "video=", video_path)
            return {
                "accepted": True,
                "recording_id": recording_id,
                "video_path": video_path,
                "csv_path": csv_path,
            }

    def stop_recording(self):
        with self.record_lock:
            record_thread_alive = bool(self.record_thread and self.record_thread.is_alive())
            has_pending_cleanup = bool(
                self.record_thread is not None or self.csv_file is not None or self.video_writer is not None
            )
            if not self.is_recording and not record_thread_alive and not has_pending_cleanup:
                log("stop_recording ignored (not recording)", "video=", self.video_path or None, "csv=", self.csv_path or None, "record_dir=", self.record_dir or None)
                return 0
            self.is_recording = False
            self.record_timeline_ready = False
            self.record_start_perf = 0.0
            self.record_start_time = 0
            self.record_first_sample_elapsed_ms = None

        if self.record_source == "stream":
            self._signal_encoded_stream_recording_stop()

        record_thread_ref = self.record_thread
        if record_thread_ref:
            wait_started = time.time()
            max_wait_sec = 45.0
            try:
                env_wait = float(str(os.getenv("MRT_RECORD_STOP_WAIT_SEC", "")).strip() or "45")
                if env_wait > 0:
                    max_wait_sec = env_wait
            except Exception:
                pass
            record_thread_ref.join(timeout=0.6)
            while record_thread_ref.is_alive() and (time.time() - wait_started) < max_wait_sec:
                record_thread_ref.join(timeout=0.6)
            waited = round(time.time() - wait_started, 3)
            if record_thread_ref.is_alive():
                self.last_recording_error = f"录制收尾超时（>{max_wait_sec:.1f}s）"
                log("stop_recording finalize timeout", "waited=", waited, "max_wait_sec=", max_wait_sec)
            else:
                log("stop_recording finalize done", "waited=", waited)
                self.record_thread = None

        with self.record_lock:
            if self.csv_file:
                try:
                    self.csv_file.flush()
                except Exception:
                    pass
                self.csv_file.close()
            self.csv_file = None
            self.csv_writer = None

        event_summary = None
        try:
            if self.csv_path and Path(self.csv_path).exists():
                event_summary = postprocess_eye_event_csv(
                    self.csv_path,
                    self.scene_frame_width,
                    self.scene_frame_height,
                    is_glasses_mode=self._is_glasses_mode(),
                )
                log("eye event postprocess complete", event_summary)
        except Exception as e:
            log("eye event postprocess failed", str(e))

        with self.stream_frame_lock:
            self.latest_stream_frame = None
            self.latest_stream_frame_seq = 0

        try:
            vp = Path(self.video_path) if self.video_path else None
            cp = Path(self.csv_path) if self.csv_path else None
            if cp and cp.exists():
                log("csv file", str(cp), "bytes=", cp.stat().st_size)
            elif cp:
                log("csv file missing", str(cp))
            if vp and vp.exists():
                log("video file", str(vp), "bytes=", vp.stat().st_size)
            elif vp:
                log("video file missing", str(vp))
        except Exception as e:
            log("stop_recording stat error", str(e))

        log("Stopped recording", "record_dir=", self.record_dir or None)

        try:
            if self.record_dir and self.csv_path:
                stem = Path(self.csv_path).stem
                now_iso = datetime.now().isoformat()

                standard_meta_path = self.handle_path(
                    Path(self.record_dir) / f"{stem}.meta.json",
                    create_parent=True,
                )
                existing_meta = {}
                try:
                    if standard_meta_path.exists():
                        with open(str(standard_meta_path), 'r', encoding='utf-8') as f:
                            loaded = json.load(f)
                            if isinstance(loaded, dict):
                                existing_meta = loaded
                except Exception:
                    existing_meta = {}

                merged_meta = dict(existing_meta)
                merged_meta['version'] = 1
                merged_meta['subjectName'] = self.current_subject_name or ""
                merged_meta['recordingEnd'] = now_iso
                merged_meta['updatedAt'] = now_iso
                merged_meta['videoSamplingRateHz'] = int(round(self._get_record_target_fps()))
                duration_seconds = self._probe_recorded_video_duration_seconds()
                if duration_seconds > 0:
                    merged_meta['durationSeconds'] = round(duration_seconds, 6)
                merged_meta['eyeEventSchemaVersion'] = 1
                merged_meta['eyeEventSummary'] = event_summary or {}
                merged_meta['eyeEventFrameWidth'] = int(self.scene_frame_width or 0)
                merged_meta['eyeEventFrameHeight'] = int(self.scene_frame_height or 0)
                if self.record_source == "stream":
                    try:
                        with self.encoded_record_lock:
                            output_is_h264 = self._is_h264_like_codec(self.chosen_codec)
                            merged_meta['recordSource'] = 'stream'
                            merged_meta['videoPipeline'] = 'encoded-hevc-to-h264' if output_is_h264 else 'encoded-hevc-copy'
                            merged_meta['sourceVideoCodec'] = 'hevc'
                            merged_meta['videoCodec'] = 'h264' if output_is_h264 else 'hevc'
                            merged_meta['encodedPackets'] = int(self.encoded_record_packet_count)
                            merged_meta['encodedBytes'] = int(self.encoded_record_written_bytes)
                            merged_meta['encodedKeyframes'] = int(self.encoded_record_keyframe_count)
                            merged_meta['encodedDroppedPackets'] = int(self.encoded_record_dropped_packets)
                            merged_meta['encodedWidth'] = int(self.encoded_record_width)
                            merged_meta['encodedHeight'] = int(self.encoded_record_height)
                    except Exception:
                        pass
                with self.recording_markers_lock:
                    markers_snapshot = list(self.recording_markers)
                if markers_snapshot:
                    merged_meta['markers'] = markers_snapshot

                with open(str(standard_meta_path), 'w', encoding='utf-8') as f:
                    json.dump(merged_meta, f, ensure_ascii=False, indent=2)

        except Exception as e:
            log("Failed to save markers metadata", str(e))

        return 0
