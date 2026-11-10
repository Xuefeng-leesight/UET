from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import re
import signal
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any, Callable

import cv2

try:
    from .process_output import decode_process_output
except ImportError:
    # Keep the standalone `python application/service.py ...` CLI usable.
    from process_output import decode_process_output

BLENDSHAPE_LABELS = {
    "browDownLeft": "左眉下压", "browDownRight": "右眉下压", "browInnerUp": "眉心上扬",
    "browOuterUpLeft": "左眉外侧上扬", "browOuterUpRight": "右眉外侧上扬", "cheekPuff": "鼓腮",
    "cheekSquintLeft": "左脸颊眯起", "cheekSquintRight": "右脸颊眯起", "eyeBlinkLeft": "左眼眨眼",
    "eyeBlinkRight": "右眼眨眼", "eyeLookDownLeft": "左眼向下看", "eyeLookDownRight": "右眼向下看",
    "eyeLookInLeft": "左眼向内看", "eyeLookInRight": "右眼向内看", "eyeLookOutLeft": "左眼向外看",
    "eyeLookOutRight": "右眼向外看", "eyeLookUpLeft": "左眼向上看", "eyeLookUpRight": "右眼向上看",
    "eyeSquintLeft": "左眼眯眼", "eyeSquintRight": "右眼眯眼", "eyeWideLeft": "左眼睁大",
    "eyeWideRight": "右眼睁大", "jawForward": "下巴前伸", "jawLeft": "下巴左移", "jawOpen": "张嘴",
    "jawRight": "下巴右移", "mouthClose": "闭嘴", "mouthDimpleLeft": "左嘴角酒窝",
    "mouthDimpleRight": "右嘴角酒窝", "mouthFrownLeft": "左嘴角下垂", "mouthFrownRight": "右嘴角下垂",
    "mouthFunnel": "嘴唇收拢", "mouthLeft": "嘴巴左移", "mouthLowerDownLeft": "左下唇下压",
    "mouthLowerDownRight": "右下唇下压", "mouthPressLeft": "左嘴唇紧压", "mouthPressRight": "右嘴唇紧压",
    "mouthPucker": "撅嘴", "mouthRight": "嘴巴右移", "mouthRollLower": "下唇内卷", "mouthRollUpper": "上唇内卷",
    "mouthShrugLower": "下唇耸起", "mouthShrugUpper": "上唇耸起", "mouthSmileLeft": "左嘴角微笑",
    "mouthSmileRight": "右嘴角微笑", "mouthStretchLeft": "左嘴角拉伸", "mouthStretchRight": "右嘴角拉伸",
    "mouthUpperUpLeft": "左上唇上扬", "mouthUpperUpRight": "右上唇上扬", "noseSneerLeft": "左鼻翼皱起",
    "noseSneerRight": "右鼻翼皱起",
}


# ---- Blendshapes → Ekman 7 种基础表情映射 ----

BASIC_EMOTIONS: dict[str, dict[str, float]] = {
    "高兴": {
        "mouthSmileLeft": 1.0, "mouthSmileRight": 1.0,
        "cheekSquintLeft": 0.7, "cheekSquintRight": 0.7,
        "eyeSquintLeft": 0.4, "eyeSquintRight": 0.4,
    },
    "悲伤": {
        "mouthFrownLeft": 1.0, "mouthFrownRight": 1.0,
        "browInnerUp": 0.8,
        "browDownLeft": 0.5, "browDownRight": 0.5,
        "mouthLowerDownLeft": 0.3, "mouthLowerDownRight": 0.3,
    },
    "愤怒": {
        "browDownLeft": 1.0, "browDownRight": 1.0,
        "eyeSquintLeft": 0.7, "eyeSquintRight": 0.7,
        "jawForward": 0.5,
        "mouthPressLeft": 0.5, "mouthPressRight": 0.5,
        "noseSneerLeft": 0.4, "noseSneerRight": 0.4,
    },
    "惊讶": {
        "browOuterUpLeft": 1.0, "browOuterUpRight": 1.0,
        "browInnerUp": 0.8,
        "eyeWideLeft": 0.8, "eyeWideRight": 0.8,
        "jawOpen": 0.8,
        "mouthUpperUpLeft": 0.3, "mouthUpperUpRight": 0.3,
    },
    "恐惧": {
        "browInnerUp": 1.0,
        "browOuterUpLeft": 0.8, "browOuterUpRight": 0.8,
        "eyeWideLeft": 0.8, "eyeWideRight": 0.8,
        "mouthStretchLeft": 0.6, "mouthStretchRight": 0.6,
        "jawOpen": 0.4,
    },
    "厌恶": {
        "noseSneerLeft": 1.0, "noseSneerRight": 1.0,
        "browDownLeft": 0.5, "browDownRight": 0.5,
        "mouthFrownLeft": 0.5, "mouthFrownRight": 0.5,
        "mouthUpperUpLeft": 0.3, "mouthUpperUpRight": 0.3,
    },
    "轻蔑": {
        # 单侧不对称微笑
        "mouthSmileLeft": 1.0,
        "mouthSmileRight": 1.0,
    },
}


def classify_basic_emotion(blendshapes_dict: dict[str, float]) -> tuple[str, float, dict[str, float]]:
    """
    从 51 blendshapes 推断 7 种基础表情（高兴/悲伤/愤怒/惊讶/恐惧/厌恶/轻蔑） + 中性。
    返回 (表情名, 置信度, {各表情分数...})
    """
    # Real-time samples keep MediaPipe's English category names, while
    # whole-video analysis stores the translated Chinese labels for display.
    # Accept both representations so saved analysis is classified from the
    # actual frame values instead of treating every lookup as zero/neutral.
    def blendshape_value(shape: str) -> float:
        value = blendshapes_dict.get(shape)
        if value is None:
            value = blendshapes_dict.get(BLENDSHAPE_LABELS.get(shape, ""), 0.0)
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return 0.0
        return parsed if math.isfinite(parsed) else 0.0

    scores: dict[str, float] = {}
    for emotion, weights in BASIC_EMOTIONS.items():
        if emotion == "轻蔑":
            # 轻蔑 = 单侧微笑不对称（|左-右| > 0.3 且至少一侧高）
            left_smile = blendshape_value("mouthSmileLeft")
            right_smile = blendshape_value("mouthSmileRight")
            asymmetry = abs(left_smile - right_smile)
            max_smile = max(left_smile, right_smile)
            if max_smile > 0.35 and asymmetry > 0.25:
                scores[emotion] = round(max_smile * asymmetry, 4)
            else:
                scores[emotion] = 0.0
        else:
            total = 0.0
            norm = 0.0
            for shape, weight in weights.items():
                value = blendshape_value(shape)
                if weight > 0:
                    total += value * weight
                    norm += weight
            scores[emotion] = round(total / max(norm, 1e-6), 4)

    best = max(scores, key=scores.get)  # type: ignore[arg-type]
    best_score = scores[best]
    neutral_score = round(max(0.0, min(1.0, 1.0 - best_score / 0.25)), 4)
    scores["中性"] = neutral_score
    if best_score < 0.25:
        return ("中性", neutral_score, scores)
    return (best, best_score, scores)


def build_result_from_samples(samples_path: Path, video_path: Path, record_id: str) -> dict[str, Any]:
    """从预览线程实时记录的 samples.jsonl 合成为 result.json"""
    samples: list[dict[str, Any]] = []
    if samples_path.is_file():
        # Renderer samples are always UTF-8 JSONL. Relying on the Windows
        # process locale made Python choose GBK and fail as soon as a sample
        # contained UTF-8 Chinese labels. Replacement keeps one malformed byte
        # from aborting the entire recording while invalid JSON lines are still
        # skipped by the parser below.
        with open(samples_path, "r", encoding="utf-8-sig", errors="replace") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        samples.append(json.loads(line))
                    except Exception:
                        continue

    if not samples:
        return {"ok": False, "message": "无帧级数据"}

    valid_count = sum(1 for s in samples if s.get("faceBox"))
    total = len(samples)
    valid_ratio = round(valid_count / total, 4) if total > 0 else 0.0

    # 构建表情事件
    def _build_events(label: str, threshold: float, min_duration_ms: int) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        active: list[dict[str, Any]] = []
        for sample in samples:
            expressions = sample.get("expressions", {})
            value = float(expressions.get(label, 0.0))
            t = int(sample.get("t", 0))
            if value >= threshold:
                active.append({"t": t, "v": value})
            elif active:
                start, end = active[0]["t"], active[-1]["t"]
                if end - start >= min_duration_ms:
                    apex = max(active, key=lambda x: x["v"])
                    events.append({"label": label, "startMs": start, "apexMs": apex["t"], "endMs": end, "peak": round(apex["v"], 4)})
                active = []
        return events

    # 构建基础情绪事件
    def _build_emotion_events(emotion_name: str, sample_list: list[dict[str, Any]], threshold: float, min_duration_ms: int) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        active: list[dict[str, Any]] = []
        for sample in sample_list:
            scores = sample.get("emotionScores", {})
            value = float(scores.get(emotion_name, 0.0))
            t = int(sample.get("t", 0))
            if value >= threshold:
                active.append({"t": t, "v": value})
            elif active:
                start, end = active[0]["t"], active[-1]["t"]
                if end - start >= min_duration_ms:
                    apex = max(active, key=lambda x: x["v"])
                    events.append({"label": emotion_name, "startMs": start, "apexMs": apex["t"], "endMs": end, "peak": round(apex["v"], 4)})
                active = []
        return events

    # 构建 blendshape 表情事件（使用英文 blendshape 名称匹配数据）
    expression_events: list[dict[str, Any]] = []
    for label in BLENDSHAPE_LABELS:
        events = _build_events(label, 0.35, 120)
        for e in events:
            e["label"] = BLENDSHAPE_LABELS[label]  # 转为中文显示
        expression_events.extend(events)
    expression_events.sort(key=lambda e: e["startMs"])

    # 构建基础情绪事件
    emotion_events: list[dict[str, Any]] = []
    for emotion_name in ("中性", "高兴", "悲伤", "愤怒", "惊讶", "恐惧", "厌恶", "轻蔑"):
        events = _build_emotion_events(emotion_name, samples, 0.3, 120)
        emotion_events.extend(events)
    emotion_events.sort(key=lambda e: e["startMs"])

    # 视频信息
    video_info: dict[str, Any] = {"path": str(video_path), "sha256": "", "width": 0, "height": 0, "fps": 0, "durationMs": 0}
    if video_path.is_file():
        cap = cv2.VideoCapture(str(video_path))
        if cap.isOpened():
            video_info["width"] = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
            video_info["height"] = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
            video_info["fps"] = float(cap.get(cv2.CAP_PROP_FPS) or 0)
            frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            video_info["durationMs"] = int(round(frame_count / video_info["fps"] * 1000)) if video_info["fps"] > 0 else 0
            cap.release()
        # 计算视频文件 hash
        digest = hashlib.sha256()
        with video_path.open("rb") as src:
            for chunk in iter(lambda: src.read(1024 * 1024), b""):
                digest.update(chunk)
        video_info["sha256"] = digest.hexdigest()

    result = {
        "schemaVersion": 1,
        "recordId": record_id,
        "source": video_info,
        "engine": {"name": "mediapipe-face-landmarker-realtime", "mediaPipeAvailable": True},
        "quality": {
            "sampledFrames": total,
            "validFaceRatio": valid_ratio,
            "multipleFaceRatio": 0,
            "blurryRatio": 0,
            "grade": "good" if valid_ratio >= 0.8 else "warning",
        },
        "alignment": {"timeBase": "record-local-ms", "sourceOffsetMs": 0, "method": "preview-thread", "confirmed": True},
        "tracks": {
            "emotion": {"available": True, "events": emotion_events},
            "expression": {"available": True, "events": expression_events},
            "microExpression": {"available": False, "events": []},
        },
        "samples": samples,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    output_path = video_path.parent.parent / "analysis" / "result.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "resultPath": str(output_path), "result": result}


def ensure_face_landmarker_model() -> Path:
    configured = os.environ.get("MRT_FACE_LANDMARKER_MODEL", "").strip()
    if configured and Path(configured).is_file():
        return Path(configured)
    # 优先使用 facial-analysis application 目录下随包分发的本地模型文件
    local = Path(os.path.dirname(os.path.abspath(__file__)), "face_landmarker_v2_with_blendshapes.task")
    if local.is_file() and local.stat().st_size > 1_000_000:
        return local
    cache_dir = Path(os.environ.get("MRT_FACE_MODEL_DIR", Path.home() / ".uet-sa" / "models"))
    model = cache_dir / "face_landmarker.task"
    if model.is_file() and model.stat().st_size > 1_000_000:
        return model
    cache_dir.mkdir(parents=True, exist_ok=True)
    temporary = cache_dir / "face_landmarker.task.download"
    # urlretrieve has no timeout; use urlopen with an explicit socket timeout
    # so an unreachable/offline host can't hang the preview thread indefinitely.
    source_url = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task"
    try:
        with urllib.request.urlopen(source_url, timeout=60) as response, open(temporary, "wb") as out_file:
            shutil.copyfileobj(response, out_file, length=1024 * 1024)
    except Exception:
        if temporary.exists():
            try:
                temporary.unlink()
            except OSError:
                pass
        raise
    temporary.replace(model)
    return model


# ---- Library API (返回 dict，可被 WS server import) ----

def _find_ffmpeg_binary() -> str | None:
    """定位 ffmpeg 二进制：环境变量 → PATH → SDK 目录扫描"""
    for key in ("MRT_FFMPEG_PATH", "MRT_FFMPEG", "FFMPEG_PATH"):
        value = os.environ.get(key, "").strip().strip('"')
        if not value:
            continue
        try:
            p = Path(value)
            if p.exists() and p.is_file():
                return str(p)
        except Exception:
            continue
    try:
        found = shutil.which("ffmpeg")
        if found:
            return found
    except Exception:
        pass
    binary = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    here = Path(__file__).resolve()
    for base in [here.parent, *here.parents]:
        for rel in (
            base / "SDK" / "Tool" / "ffmpeg" / "bin" / binary,
            base / "sdk" / "Tool" / "ffmpeg" / "bin" / binary,
            base / "Tool" / "ffmpeg" / "bin" / binary,
            base / "SDK" / "tool" / "ffmpeg" / "bin" / binary,
        ):
            try:
                if rel.exists() and rel.is_file():
                    return str(rel)
            except Exception:
                continue
    return None


def _get_device_names() -> dict[int, str]:
    """通过 ffmpeg 获取摄像头真实设备名称，返回 {index: name}"""
    names: dict[int, str] = {}
    if sys.platform == "darwin":
        cmd_fmt = ["ffmpeg", "-f", "avfoundation", "-list_devices", "true", "-i", ""]
    elif sys.platform.startswith("win"):
        cmd_fmt = ["ffmpeg", "-f", "dshow", "-list_devices", "true", "-i", "dummy"]
    else:
        return names

    # 优先使用环境变量/SDK 目录中的 ffmpeg，找不到则回落 PATH 里的 ffmpeg
    ffmpeg_bin = _find_ffmpeg_binary()
    if ffmpeg_bin:
        cmd = [ffmpeg_bin] + cmd_fmt[1:]
    else:
        cmd = cmd_fmt

    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=8)
        output = decode_process_output(proc.stderr)
        in_avfoundation_video_section = False
        for line in output.splitlines():
            line = line.strip()
            if sys.platform == "darwin":
                if "AVFoundation video devices:" in line:
                    in_avfoundation_video_section = True
                    continue
                if "AVFoundation audio devices:" in line:
                    in_avfoundation_video_section = False
                    continue
                if not in_avfoundation_video_section:
                    continue
                # [AVFoundation ...] [0] FaceTime HD Camera
                m = re.match(r'^\[AVFoundation[^\]]*\]\s*\[(\d+)\]\s*(.+)$', line)
                if m:
                    idx = int(m.group(1))
                    name = m.group(2).strip()
                    # 过滤掉屏幕捕获虚拟设备
                    if "capture screen" not in name.lower() and "screen capture" not in name.lower():
                        names[idx] = name
            else:
                # ffmpeg 8.x 的 dshow 输出是扁平格式：`"name" (video)` / `"name" (audio)`，
                # 无 section 标题。用 (video)/(audio) 后缀区分，只取视频设备，跳过音频
                # 设备和 Alternative name 别名行。
                m = re.match(r'^\[dshow[^\]]*\]\s*"(.+)"\s*\((\w+)\)', line)
                if m:
                    kind = m.group(2).lower()
                    if kind == "video":
                        name = m.group(1).strip()
                        names[len(names)] = name
    except Exception:
        pass
    return names

def list_cameras(limit: int = 8) -> dict[str, Any]:
    """枚举人脸摄像头，返回 {ok, cameras: [{id, index, name, width, height, backend}]}"""
    cameras: list[dict[str, Any]] = []
    if sys.platform == "darwin":
        backend = cv2.CAP_AVFOUNDATION
    elif sys.platform.startswith("win"):
        backend = cv2.CAP_DSHOW
    else:
        backend = cv2.CAP_ANY

    # 通过 ffmpeg 获取真实设备名称（失败时回落通用名称）
    device_names = _get_device_names()

    if sys.platform == "darwin":
        # AVFoundation discovery already provides stable video indexes. Do not
        # open every camera with OpenCV just to enumerate it: that races with
        # the FFmpeg-backed 1280x720 session started immediately afterwards and
        # can leave the device configuration lock busy.
        cameras = [
            {
                "id": str(index),
                "index": index,
                "name": name,
                "width": 640,
                "height": 480,
                "backend": "avfoundation",
            }
            for index, name in sorted(device_names.items())
            if index < max(1, limit)
        ]
        return {"ok": True, "cameras": cameras}

    # 抑制 OpenCV stderr 噪音（枚举时打印的 "out device of bound" 是无害的）
    _stderr_backup = None
    try:
        _stderr_backup = os.dup(2)
        _devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(_devnull, 2)
        os.close(_devnull)
    except Exception:
        pass

    try:
        consecutive_failures = 0
        max_consecutive_failures = 3
        for index in range(max(1, limit)):
            try:
                capture = cv2.VideoCapture(index, backend)
            except Exception:
                # DirectShow can raise a C++ exception for a single index when a
                # device is locked by another process or its driver is unstable.
                # Skip that index instead of failing the whole enumeration.
                consecutive_failures += 1
                if consecutive_failures >= max_consecutive_failures:
                    break
                continue
            try:
                if not capture.isOpened():
                    consecutive_failures += 1
                    if consecutive_failures >= max_consecutive_failures:
                        break
                    continue

                # macOS 摄像头预热：首次读取可能返回空帧
                frame = None
                for _ in range(5):
                    ok, f = capture.read()
                    if ok and f is not None and f.size > 0:
                        frame = f
                        break
                    time.sleep(0.05)

                if frame is None:
                    consecutive_failures += 1
                    if consecutive_failures >= max_consecutive_failures:
                        break
                    continue

                consecutive_failures = 0
                cameras.append({
                    "id": str(index),
                    "index": index,
                    "name": device_names.get(index) or f"摄像头 {index + 1}",
                    "width": 1920,
                    "height": 1080,
                    "backend": capture.getBackendName() if hasattr(capture, "getBackendName") else "opencv",
                })
            finally:
                capture.release()
    finally:
        # 恢复 stderr
        if _stderr_backup is not None:
            try:
                os.dup2(_stderr_backup, 2)
                os.close(_stderr_backup)
            except Exception:
                pass

    return {"ok": True, "cameras": cameras}


def capture_video(
    camera_index: int,
    output: Path,
    width: int = 1280,
    height: int = 720,
    fps: float = 30.0,
    stop_event: threading.Event | None = None,
    on_preview: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """
    采集人脸视频，返回 {ok, path, frameCount, durationMs, startedWallMs, width, height, fps, message}
    
    参数:
        stop_event: 库调用时传入 threading.Event，set() 后停止采集
        on_preview: 预览帧回调，参数 {"dataUrl": "data:image/jpeg;base64,..."}
    """
    output.parent.mkdir(parents=True, exist_ok=True)
    capture_output = output.with_suffix(".capture.avi")
    if sys.platform == "darwin":
        backend = cv2.CAP_AVFOUNDATION
    elif sys.platform.startswith("win"):
        backend = cv2.CAP_DSHOW
    else:
        backend = cv2.CAP_ANY
    capture = cv2.VideoCapture(camera_index, backend)
    if not capture.isOpened():
        return {"ok": False, "message": "无法打开表情摄像头"}
    capture.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    capture.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    capture.set(cv2.CAP_PROP_FPS, fps)
    # AVFoundation 需要读帧后分辨率设置才生效，预热读取几帧
    for _ in range(5):
        ok, f = capture.read()
        if ok and f is not None and f.size > 0:
            width = int(f.shape[1])
            height = int(f.shape[0])
            break
        time.sleep(0.03)
    actual_width = max(1, int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or width))
    actual_height = max(1, int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or height))
    actual_fps = float(capture.get(cv2.CAP_PROP_FPS) or fps or 30.0)
    writer = cv2.VideoWriter(str(capture_output), cv2.VideoWriter_fourcc(*"MJPG"), actual_fps, (actual_width, actual_height))
    if not writer.isOpened():
        capture.release()
        return {"ok": False, "message": "无法创建表情视频文件"}

    started_wall_ms = int(time.time() * 1000)
    started_monotonic_ns = time.monotonic_ns()
    frame_count = 0
    live_landmarker = None
    try:
        from mediapipe.tasks.python import vision as mp_vision
        from mediapipe.tasks.python import BaseOptions as mp_BaseOptions
        live_landmarker = mp_vision.FaceLandmarker.create_from_options(
            mp_vision.FaceLandmarkerOptions(
                base_options=mp_BaseOptions(model_asset_path=str(ensure_face_landmarker_model())),
                running_mode=mp_vision.RunningMode.IMAGE,
                num_faces=1,
                min_face_detection_confidence=0.5,
                min_face_presence_confidence=0.5,
                output_face_blendshapes=True,
            )
        )
    except Exception:
        live_landmarker = None
    samples_path = output.parent / "samples.jsonl"

    def should_stop() -> bool:
        if stop_event is not None:
            return stop_event.is_set()
        return False

    try:
        while not should_stop():
            ok, frame = capture.read()
            if not ok or frame is None:
                time.sleep(0.01)
                continue
            if frame.shape[1] != actual_width or frame.shape[0] != actual_height:
                frame = cv2.resize(frame, (actual_width, actual_height))
            writer.write(frame)
            frame_count += 1
            if on_preview and frame_count % max(1, int(round(actual_fps / 12.0))) == 0:
                preview = frame
                if preview.shape[1] > 480:
                    preview = cv2.resize(preview, (480, int(preview.shape[0] * 480 / preview.shape[1])))
                encoded, jpeg = cv2.imencode('.jpg', preview, [cv2.IMWRITE_JPEG_QUALITY, 68])
                if encoded:
                    payload: dict[str, Any] = {"dataUrl": "data:image/jpeg;base64," + base64.b64encode(jpeg.tobytes()).decode("ascii")}
                    sample: dict[str, Any] = {
                        "t": int((time.monotonic_ns() - started_monotonic_ns) / 1_000_000),
                        "faceBox": None, "expressions": {}, "emotion": None,
                        "emotionScore": 0.0, "emotionScores": {},
                    }
                    if live_landmarker is not None:
                        try:
                            rgb = cv2.cvtColor(preview, cv2.COLOR_BGR2RGB)
                            detected = live_landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
                            if detected.face_landmarks:
                                pts = detected.face_landmarks[0]
                                xs = [lm.x for lm in pts]
                                ys = [lm.y for lm in pts]
                                sample["faceBox"] = {"x": min(xs), "y": min(ys), "w": max(xs) - min(xs), "h": max(ys) - min(ys)}
                            if detected.face_blendshapes:
                                expressions = {item.category_name: float(item.score) for item in detected.face_blendshapes[0]}
                                emotion, emotion_score, emotion_scores = classify_basic_emotion(expressions)
                                sample.update({"expressions": expressions, "emotion": emotion, "emotionScore": emotion_score, "emotionScores": emotion_scores})
                        except Exception:
                            pass
                    payload.update({"faceBox": sample["faceBox"], "expression": sample["emotion"], "emotionScores": sample["emotionScores"]})
                    try:
                        with samples_path.open("a", encoding="utf-8") as sample_file:
                            sample_file.write(json.dumps(sample, ensure_ascii=False) + "\n")
                    except Exception:
                        pass
                    on_preview(payload)
    finally:
        writer.release()
        capture.release()
        try:
            if live_landmarker is not None:
                live_landmarker.close()
        except Exception:
            pass

    duration_ms = int((time.monotonic_ns() - started_monotonic_ns) / 1_000_000)
    ffmpeg = _find_ffmpeg_binary()
    transcode_error = ""
    if ffmpeg:
        completed = subprocess.run(
            [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(capture_output),
             "-an", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", str(output)],
            capture_output=True,
        )
        if completed.returncode != 0:
            transcode_error = decode_process_output(completed.stderr).strip() or "H.264 转码失败"
    else:
        transcode_error = "未找到 FFmpeg，无法生成浏览器兼容视频"
    try:
        if output.exists() and output.stat().st_size > 0:
            capture_output.unlink(missing_ok=True)
    except Exception:
        pass

    return {
        "ok": not bool(transcode_error),
        "path": str(output),
        "message": transcode_error or "ok",
        "frameCount": frame_count,
        "startedWallMs": started_wall_ms,
        "startedMonotonicNs": started_monotonic_ns,
        "durationMs": duration_ms,
        "width": actual_width,
        "height": actual_height,
        "fps": actual_fps,
        "endedWallMs": int(time.time() * 1000),
    }


def distance(a: Any, b: Any) -> float:
    return math.hypot(float(a.x) - float(b.x), float(a.y) - float(b.y))


def analyze_video(video: Path, output: Path, record_id: str) -> dict[str, Any]:
    """
    分析人脸视频，返回 {ok, result: {...}} 或 {ok: false, message}
    """
    capture = cv2.VideoCapture(str(video))
    if not capture.isOpened():
        return {"ok": False, "message": "无法读取表情视频"}
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    duration_ms = int(round(frame_count / fps * 1000)) if fps > 0 else 0
    target_hz = min(15.0, fps) if fps > 0 else 10.0
    sample_step = max(1, int(round(fps / target_hz))) if fps > 0 else 1
    face_mesh = None
    face_landmarker = None
    media_pipe_module = None
    engine = "opencv-haar"
    try:
        import mediapipe as mp  # type: ignore
        media_pipe_module = mp
        options = mp.tasks.vision.FaceLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=str(ensure_face_landmarker_model())),
            running_mode=mp.tasks.vision.RunningMode.VIDEO,
            num_faces=2,
            min_face_detection_confidence=0.5,
            min_face_presence_confidence=0.5,
            min_tracking_confidence=0.5,
            output_face_blendshapes=True,
        )
        face_landmarker = mp.tasks.vision.FaceLandmarker.create_from_options(options)
        engine = "mediapipe-face-landmarker"
    except Exception:
        try:
            if media_pipe_module is not None:
                face_mesh = media_pipe_module.solutions.face_mesh.FaceMesh(
                    static_image_mode=False, max_num_faces=2, refine_landmarks=True,
                    min_detection_confidence=0.5, min_tracking_confidence=0.5,
                )
                engine = "mediapipe-face-mesh"
        except Exception:
            face_mesh = None
    cascade = None
    if face_landmarker is None and face_mesh is None:
        cascade_factory = getattr(cv2, "CascadeClassifier", None)
        cascade_data = getattr(getattr(cv2, "data", None), "haarcascades", "")
        if callable(cascade_factory) and cascade_data:
            cascade = cascade_factory(cascade_data + "haarcascade_frontalface_default.xml")
    samples: list[dict[str, Any]] = []
    valid_frames = 0
    multi_face_frames = 0
    blurry_frames = 0
    index = 0
    while True:
        ok, frame = capture.read()
        if not ok or frame is None:
            break
        if index % sample_step != 0:
            index += 1
            continue
        timestamp_ms = int(round(index / fps * 1000)) if fps > 0 else int(capture.get(cv2.CAP_PROP_POS_MSEC) or 0)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        blurry = sharpness < 45.0
        if blurry:
            blurry_frames += 1
        face_count = 0
        expressions: dict[str, float] = {}
        face_box: dict[str, float] | None = None
        face_landmarks: list[dict[str, float]] = []
        if face_landmarker is not None and media_pipe_module is not None:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image = media_pipe_module.Image(image_format=media_pipe_module.ImageFormat.SRGB, data=rgb)
            result = face_landmarker.detect_for_video(mp_image, timestamp_ms)
            face_count = len(result.face_landmarks or [])
            if result.face_landmarks:
                points = result.face_landmarks[0]
                xs = [float(point.x) for point in points]
                ys = [float(point.y) for point in points]
                face_box = {"x": min(xs), "y": min(ys), "w": max(xs) - min(xs), "h": max(ys) - min(ys)}
                face_landmarks = [{"x": round(float(point.x), 5), "y": round(float(point.y), 5)} for point in points]
            if result.face_blendshapes:
                expressions = {
                    BLENDSHAPE_LABELS[item.category_name]: round(float(item.score), 4)
                    for item in result.face_blendshapes[0]
                    if item.category_name in BLENDSHAPE_LABELS
                }
        elif face_mesh is not None:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            result = face_mesh.process(rgb)
            landmarks_list = result.multi_face_landmarks or []
            face_count = len(landmarks_list)
            if landmarks_list:
                points = landmarks_list[0].landmark
                xs = [float(point.x) for point in points]
                ys = [float(point.y) for point in points]
                face_box = {"x": min(xs), "y": min(ys), "w": max(xs) - min(xs), "h": max(ys) - min(ys)}
                face_landmarks = [{"x": round(float(point.x), 5), "y": round(float(point.y), 5)} for point in points]
                face_width = max(1e-6, distance(points[234], points[454]))
                mouth_width = distance(points[61], points[291]) / face_width
                mouth_open = distance(points[13], points[14]) / face_width
                left_eye = distance(points[159], points[145]) / max(1e-6, distance(points[33], points[133]))
                right_eye = distance(points[386], points[374]) / max(1e-6, distance(points[362], points[263]))
                smile = max(0.0, min(1.0, (mouth_width - 0.34) / 0.18))
                expressions = {
                    "微笑": round(smile, 4),
                    "张嘴": round(max(0.0, min(1.0, mouth_open / 0.18)), 4),
                    "眨眼": round(max(0.0, min(1.0, 1.0 - ((left_eye + right_eye) / 0.5))), 4),
                }
        elif cascade is not None:
            faces = cascade.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=5, minSize=(48, 48))
            face_count = len(faces)
            if face_count > 0:
                x, y, w, h = faces[0]
                face_box = {"x": float(x / frame.shape[1]), "y": float(y / frame.shape[0]), "w": float(w / frame.shape[1]), "h": float(h / frame.shape[0])}
        if face_count > 0:
            valid_frames += 1
        if face_count > 1:
            multi_face_frames += 1
        # 基础表情分类
        basic_emotion_label, basic_emotion_score, basic_emotion_scores = classify_basic_emotion(expressions)
        samples.append({
            "timestampMs": timestamp_ms,
            "faceCount": face_count,
            "quality": round(max(0.0, min(1.0, sharpness / 160.0)), 4),
            "expressions": expressions,
            "faceBox": face_box,
            "landmarks": face_landmarks,
            "basicEmotionLabel": basic_emotion_label,
            "basicEmotionScore": basic_emotion_score,
            "basicEmotionScores": basic_emotion_scores,
        })
        index += 1
    capture.release()
    if face_mesh is not None:
        face_mesh.close()
    if face_landmarker is not None:
        face_landmarker.close()

    def build_events(label: str, threshold: float, min_duration_ms: int) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        active: list[dict[str, Any]] = []
        for sample in samples:
            value = float(sample.get("expressions", {}).get(label, 0.0))
            if value >= threshold:
                active.append({"t": sample["timestampMs"], "v": value})
            elif active:
                start, end = active[0]["t"], active[-1]["t"]
                if end - start >= min_duration_ms:
                    apex = max(active, key=lambda item: item["v"])
                    events.append({"label": label, "startMs": start, "apexMs": apex["t"], "endMs": end, "peak": round(apex["v"], 4)})
                active = []
        return events

    expression_events = []
    for label in BLENDSHAPE_LABELS.values():
        expression_events.extend(build_events(label, 0.35, 120))
    expression_events.sort(key=lambda item: item["startMs"])
    emotion_events: list[dict[str, Any]] = []
    for emotion_name in ("中性", "高兴", "悲伤", "愤怒", "惊讶", "恐惧", "厌恶", "轻蔑"):
        active: list[dict[str, Any]] = []
        for sample in samples:
            value = float(sample.get("basicEmotionScores", {}).get(emotion_name, 0.0))
            timestamp = int(sample.get("timestampMs", 0))
            if value >= 0.3:
                active.append({"t": timestamp, "v": value})
            elif active:
                start, end = active[0]["t"], active[-1]["t"]
                if end - start >= 120:
                    apex = max(active, key=lambda item: item["v"])
                    emotion_events.append({"label": emotion_name, "startMs": start, "apexMs": apex["t"], "endMs": end, "peak": round(apex["v"], 4)})
                active = []
        if active:
            start, end = active[0]["t"], active[-1]["t"]
            if end - start >= 120:
                apex = max(active, key=lambda item: item["v"])
                emotion_events.append({"label": emotion_name, "startMs": start, "apexMs": apex["t"], "endMs": end, "peak": round(apex["v"], 4)})
    emotion_events.sort(key=lambda item: item["startMs"])
    micro_candidates = []
    if fps >= 50:
        for label in BLENDSHAPE_LABELS.values():
            micro_candidates.extend({**event, "status": "candidate"} for event in build_events(label, 0.35, 40) if 40 <= int(event["endMs"]) - int(event["startMs"]) <= 500)
        micro_candidates.sort(key=lambda item: item["startMs"])
    sampled = max(1, len(samples))
    digest = hashlib.sha256()
    with video.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    video_hash = digest.hexdigest()
    result = {
        "schemaVersion": 1,
        "recordId": record_id,
        "source": {"path": str(video), "sha256": video_hash, "width": width, "height": height, "fps": fps, "durationMs": duration_ms},
        "engine": {"name": engine, "mediaPipeAvailable": face_landmarker is not None or face_mesh is not None},
        "quality": {
            "sampledFrames": len(samples),
            "validFaceRatio": round(valid_frames / sampled, 4),
            "multipleFaceRatio": round(multi_face_frames / sampled, 4),
            "blurryRatio": round(blurry_frames / sampled, 4),
            "grade": "good" if valid_frames / sampled >= 0.8 and blurry_frames / sampled < 0.3 else "warning",
        },
        "alignment": {"timeBase": "record-local-ms", "sourceOffsetMs": 0, "method": "video-pts", "confirmed": False},
        "tracks": {
            "emotion": {"available": face_landmarker is not None, "events": emotion_events},
            "microExpression": {"available": fps >= 50 and face_landmarker is not None, "events": micro_candidates},
            "expression": {"available": face_landmarker is not None or face_mesh is not None, "events": expression_events},
        },
        "samples": samples,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "resultPath": str(output), "result": result}


# ---- CLI (兼容独立命令行调用) ----

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    camera_parser = sub.add_parser("list-cameras")
    camera_parser.add_argument("--limit", type=int, default=8)
    capture_parser = sub.add_parser("capture")
    capture_parser.add_argument("--camera", type=int, required=True)
    capture_parser.add_argument("--output", type=Path, required=True)
    capture_parser.add_argument("--width", type=int, default=1920)
    capture_parser.add_argument("--height", type=int, default=1080)
    capture_parser.add_argument("--fps", type=float, default=30.0)
    analyze_parser = sub.add_parser("analyze")
    analyze_parser.add_argument("--video", type=Path, required=True)
    analyze_parser.add_argument("--output", type=Path, required=True)
    analyze_parser.add_argument("--record-id", required=True)
    args = parser.parse_args(argv)

    if args.command == "list-cameras":
        result = list_cameras(args.limit)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0 if result["ok"] else 1

    if args.command == "capture":
        # CLI mode: use signal + stdin for stop
        stop_event: threading.Event | None = None
        running = True

        def on_signal(*_: Any) -> None:
            nonlocal running
            running = False

        signal.signal(signal.SIGINT, on_signal)
        signal.signal(signal.SIGTERM, on_signal)

        def listen_for_stop() -> None:
            nonlocal running
            try:
                for line in sys.stdin:
                    if line.strip().lower() == "stop":
                        running = False
                        return
            except Exception:
                return

        stop_event = threading.Event()

        def stdin_watcher() -> None:
            try:
                for line in sys.stdin:
                    if line.strip().lower() == "stop":
                        stop_event.set()  # type: ignore[union-attr]
                        return
            except Exception:
                return

        threading.Thread(target=stdin_watcher, name="facial-capture-stop", daemon=True).start()

        result = capture_video(args.camera, args.output, args.width, args.height, args.fps, stop_event=stop_event)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0 if result["ok"] else 1

    # analyze
    result = analyze_video(args.video, args.output, args.record_id)
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
