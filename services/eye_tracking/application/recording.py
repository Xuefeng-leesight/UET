"""Recording use-case coordination around the stateful SDK service."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RecordingStartOutcome:
    error: int
    message: str
    video_path: str
    csv_path: str
    recording_id: str


@dataclass(frozen=True)
class RecordingStatusSnapshot:
    finalizing: bool
    recording: bool
    last_result: dict[str, Any]


class RecordingCoordinator:
    def __init__(self, service: Any) -> None:
        self._service = service

    def start(self, args: dict[str, Any]) -> RecordingStartOutcome:
        requested_device_type = args.get("device_type")
        if requested_device_type is not None and str(requested_device_type).strip():
            normalize = getattr(self._service, "_normalize_device_type", None)
            expected = normalize(requested_device_type) if callable(normalize) else str(requested_device_type).strip()
            actual = normalize(self._service.device_type) if callable(normalize) else str(self._service.device_type).strip()
            if expected != actual:
                return RecordingStartOutcome(
                    error=-1,
                    message=f"录制设备类型不一致：期望 {expected}，当前服务为 {actual}；请重新启动眼动设备",
                    video_path="",
                    csv_path="",
                    recording_id="",
                )
        ret = self._service.start_recording(
            args.get("project_path"),
            args.get("subject_name", ""),
            args.get("video_sampling_rate_hz", 30),
            args.get("capture_display"),
            args.get("split_screen", False),
        )
        return RecordingStartOutcome(
            error=ret,
            message="ok" if ret == 0 else (self._service.last_recording_error or "failed"),
            video_path=self._service.video_path if ret == 0 else "",
            csv_path=self._service.csv_path if ret == 0 else "",
            recording_id=self._service.current_record_name if ret == 0 else "",
        )

    def begin_stop(self) -> tuple[dict[str, Any], dict[str, Any]]:
        stop_result = self._service.begin_stop_recording()
        with self._service.record_finalize_lock:
            last_result = dict(self._service.record_finalize_last_result or {})
        return stop_result, last_result

    def status(self) -> RecordingStatusSnapshot:
        with self._service.record_finalize_lock:
            finalizing = bool(self._service.recording_finalizing)
            last_result = dict(self._service.record_finalize_last_result or {})
        with self._service.record_lock:
            recording = bool(self._service.is_recording)
        return RecordingStatusSnapshot(finalizing=finalizing, recording=recording, last_result=last_result)
