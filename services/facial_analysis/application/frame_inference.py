from __future__ import annotations

import base64
import threading
from typing import Any

import cv2
import mediapipe as mp
import numpy as np

from .service import classify_basic_emotion, ensure_face_landmarker_model


class FrameInferenceSession:
    """MediaPipe-only session. It never enumerates, opens, or reads a camera."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._landmarker: Any = None
        self._last_error = ""

    def start(self) -> dict[str, Any]:
        with self._lock:
            if self._landmarker is not None:
                return {"ok": True, **self.status()}
            try:
                from mediapipe.tasks.python import BaseOptions as mp_BaseOptions
                from mediapipe.tasks.python import vision as mp_vision

                self._landmarker = mp_vision.FaceLandmarker.create_from_options(
                    mp_vision.FaceLandmarkerOptions(
                        base_options=mp_BaseOptions(model_asset_path=str(ensure_face_landmarker_model())),
                        running_mode=mp_vision.RunningMode.IMAGE,
                        num_faces=1,
                        min_face_detection_confidence=0.5,
                        min_face_presence_confidence=0.5,
                        output_face_blendshapes=True,
                    )
                )
                self._last_error = ""
                return {"ok": True, **self.status()}
            except Exception as error:
                self._last_error = str(error)
                self._landmarker = None
                return {"ok": False, "message": self._last_error, **self.status()}

    def stop(self) -> dict[str, Any]:
        with self._lock:
            landmarker = self._landmarker
            self._landmarker = None
        if landmarker is not None:
            # mediapipe FaceLandmarker.close() 在 Windows 上可能阻塞数十秒
            # （实测约 42 秒）。若在 stop 内同步 close，会让 stop_preview 命令
            # 长时间无响应、前端报超时，且后续 start 也要等 close 完成后才能
            # 重开。改为后台线程异步关闭，stop 立即返回。
            try:
                threading.Thread(
                    target=self._close_landmarker_safe,
                    args=(landmarker,),
                    name="mrt-facial-landmarker-close",
                    daemon=True,
                ).start()
            except Exception:
                try:
                    landmarker.close()
                except Exception:
                    pass
        return {"ok": True, **self.status()}

    @staticmethod
    def _close_landmarker_safe(landmarker: Any) -> None:
        try:
            landmarker.close()
        except Exception:
            pass

    def status(self) -> dict[str, Any]:
        return {
            "running": self._landmarker is not None,
            "state": "ready" if self._landmarker is not None else "closed",
            "inferenceReady": self._landmarker is not None,
            "cameraOwnedBy": "renderer",
            "lastError": self._last_error,
        }

    def infer_data_url(self, data_url: str, captured_at_ms: float, sequence: int) -> dict[str, Any]:
        with self._lock:
            if self._landmarker is None:
                started = self.start()
                if not started.get("ok"):
                    return started
            try:
                encoded = data_url.split(",", 1)[1] if "," in data_url else data_url
                raw = base64.b64decode(encoded, validate=True)
                frame = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
                if frame is None or frame.size == 0:
                    raise ValueError("无法解码表情帧")
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                detected = self._landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
                result: dict[str, Any] = {
                    "ok": True,
                    "capturedAtMs": captured_at_ms,
                    "sequence": sequence,
                    "width": int(frame.shape[1]),
                    "height": int(frame.shape[0]),
                    "faceBox": None,
                    "landmarks": [],
                    "expression": None,
                    "emotionScore": 0.0,
                    "emotionScores": {},
                    "expressions": {},
                }
                if detected.face_landmarks:
                    points = detected.face_landmarks[0]
                    xs = [float(point.x) for point in points]
                    ys = [float(point.y) for point in points]
                    result["faceBox"] = {
                        "x": min(xs), "y": min(ys),
                        "w": max(xs) - min(xs), "h": max(ys) - min(ys),
                    }
                    result["landmarks"] = [
                        {"x": round(float(point.x), 5), "y": round(float(point.y), 5)}
                        for point in points
                    ]
                if detected.face_blendshapes:
                    expressions = {
                        item.category_name: float(item.score)
                        for item in detected.face_blendshapes[0]
                    }
                    emotion, score, scores = classify_basic_emotion(expressions)
                    result.update({
                        "expressions": expressions,
                        "expression": emotion,
                        "emotionScore": score,
                        "emotionScores": scores,
                    })
                self._last_error = ""
                return result
            except Exception as error:
                self._last_error = str(error)
                return {"ok": False, "message": self._last_error, **self.status()}
