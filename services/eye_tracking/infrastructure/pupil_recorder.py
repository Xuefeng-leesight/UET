"""MRT-owned recording worker; never invokes Capture R/r.

A bounded worker queue separates acquisition from encoding. Readiness and
project authorization are enforced by the application layer before construction.
"""

import csv
import json
import logging
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import time
from contextlib import ExitStack
from dataclasses import asdict

from ..domain.contracts import EyeSample, EyeTrackingError
from ..domain.samples import EyeEventSample, GazeSample, PupilSample, VideoFrame
from .pupil_csv import CSV_FIELDS, gaze_csv_row
from .pupil_recovery import RecordingLease, atomic_json, write_gaze_csv
from .pupil_events import append_events, order_csv
from .pupil_video_verification import verify_video
from .pupil_metrics import journal_metrics
from .recording_communication import append_communications, validate_communication
from ..domain.timeline import FrameTimeline


class RecordingError(EyeTrackingError):
    pass


def _load_msgpack():
    try:
        import msgpack
    except ImportError as exc:
        raise RecordingError(f"Recording dependency unavailable: {exc}") from exc
    return msgpack


def validate_record_name(name: str) -> None:
    # Cross-platform basename, including Windows reserved names and trailing dots.
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", name):
        raise ValueError("Record name must be 1..80 ASCII letters/digits/underscore/hyphen")
    if name.upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}:
        raise ValueError("Reserved Windows record name")


class PupilRecorder:
    def __init__(self, directory: Path, name: str, first_frame: VideoFrame, *, ffmpeg: str = "ffmpeg",
                 ffprobe: str = "ffprobe", fps: int = 30, max_gap_s: float = 0.5,
                 queue_size: int = 128, queue_bytes: int = 64 * 1024 * 1024, source_info: dict | None = None,
                 metadata: dict | None = None, stimulus: str = "",
                 source_model: str = "PupilCore", row_mapper=gaze_csv_row, calibration_data: dict | None = None):
        self.calibration_data = calibration_data
        self.source_model, self.row_mapper = source_model, row_mapper
        validate_record_name(name)
        if type(queue_size) is not int or queue_size < 1 or type(queue_bytes) is not int or queue_bytes < 1:
            raise ValueError("Recording queue limits must be positive integers")
        if first_frame.width % 2 or first_frame.height % 2:
            raise ValueError("H.264 yuv420p recording requires even dimensions")
        self.timeline = FrameTimeline(first_frame, fps, max_gap_s)
        self.directory, self.name = Path(directory).resolve(), name
        self.sidecar = self.directory / f"{name}.pupil"
        self.video_path = self.directory / f"{name}.mp4"
        self.csv_path = self.directory / f"{name}.csv"
        self.meta_path = self.directory / f"{name}.meta.json"
        self.ffmpeg, self.ffprobe = ffmpeg, ffprobe
        self._queue = queue.Queue(maxsize=queue_size)
        self._queue_bytes_limit = queue_bytes
        self._queued_bytes = 0
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._done = threading.Event()
        self._error = ""
        self._process = None
        self._thread = None
        self.state = "idle"
        self.result = {}
        self._frames_written = 0
        self._repeated = 0
        self._gaze_written = 0
        self._valid_gaze_written = 0
        self._gaze_outside = 0
        self._first_frame = first_frame
        self._meta_owned = False
        self._lease = None
        self.source_info = dict(source_info or {"captureVersion": "unknown", "simulatedSource": None})
        self.metadata = dict(metadata or {})
        # Glasses analyze their complete scene video, regardless of material
        # playback on another display. Match the existing 7invensun rule and
        # use device type so new glasses adapters inherit the same behavior.
        self._uses_recording_stimulus = self.metadata.get("deviceType", "眼镜式") == "眼镜式"
        self.markers = []
        self._communication_ids = {}
        self.stimuli = [(0.0, self.name if self._uses_recording_stimulus else stimulus)]

    def add_marker(self, marker):
        if len(self.markers) >= 100000:
            raise RecordingError("Recording marker limit reached")
        self.markers.append(dict(marker))
        self._save_context()

    def add_communication(self, event):
        self.check()
        if self.state != 'recording' or self._stop.is_set():
            raise RecordingError('Communication events require an active recording')
        event = validate_communication(event, self.name, self._first_frame.identity.generation)
        prior = self._communication_ids.get(event['event_id'])
        if prior is not None:
            if event != prior:
                raise RecordingError('Conflicting communication event id')
            return False
        if len(self._communication_ids) >= 100000:
            raise RecordingError('Communication event limit reached')
        path = self.sidecar / 'communication-events.jsonl'
        encoded = (json.dumps(event, ensure_ascii=False, allow_nan=False) + '\n').encode('utf-8')
        if path.is_symlink() or not path.is_file() or path.stat().st_size + len(encoded) > 64 * 1024 * 1024:
            raise RecordingError('Communication journal unavailable or size limit reached')
        with path.open('ab') as journal:
            journal.write(encoded)
            journal.flush()
            os.fsync(journal.fileno())
        self._communication_ids[event['event_id']] = event
        return True

    def set_stimulus(self, name, source_time):
        if self._uses_recording_stimulus:
            return
        if len(self.stimuli) >= 100000:
            raise RecordingError("Recording stimulus limit reached")
        self.stimuli.append((max(0.0, (source_time - self.timeline.t0) * 1000), name))
        self._save_context()

    def _save_context(self):
        atomic_json(self.sidecar / "context.json", {"markers": self.markers, "stimuli": self.stimuli})

    def start(self, timeout_s: float = 10) -> None:
        if self.state != "idle":
            raise RecordingError("Recorder is single-use")
        # Development interpreters may support preview but lack recording's
        # serializer. Reject that before reserving any recording files or lease.
        try:
            _load_msgpack()
        except RecordingError as exc:
            self._set_error(str(exc))
            self.state = "failed"
            self.result = {"status": "failed", "error": str(exc),
                           "video_path": str(self.video_path), "csv_path": str(self.csv_path)}
            self._ready.set()
            self._done.set()
            raise
        self.directory.mkdir(parents=True, exist_ok=True)
        if any(p.exists() for p in (self.video_path, self.csv_path, self.meta_path, self.sidecar)):
            raise FileExistsError("Recording already exists; refusing to overwrite")
        # Exclusive directory reservation also serializes competing recorder instances.
        self.sidecar.mkdir()
        self._lease = RecordingLease(self.sidecar)
        self.state = "preparing"
        self._thread = threading.Thread(target=self._run, name="pupil-recorder", daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout_s):
            self.finish(error="Encoder preparation timed out", timeout_s=timeout_s)
            raise RecordingError("Encoder preparation timed out")
        self.check()

    def check(self) -> None:
        with self._lock:
            error = self._error
        if error:
            raise RecordingError(error)

    def _set_error(self, error: str) -> None:
        with self._lock:
            if not self._error:
                self._error = error

    def submit(self, samples: list[EyeSample], raw_messages=()) -> None:
        self.check()
        if self.state != "recording" or self._stop.is_set():
            raise RecordingError("Recorder is not accepting samples")
        # Account bytes, not just item count; one BGR frame can be tens of MB.
        size = sum(len(s.pixels) for s in samples if isinstance(s, VideoFrame))
        size += sum(sum(map(len, m.raw_parts)) for m in raw_messages) + len(samples) * 512
        size += sum(len(s.pupils) * 512 for s in samples if isinstance(s, GazeSample))
        with self._lock:
            if self._queued_bytes + size > self._queue_bytes_limit:
                self._error = "Recording queue byte limit exceeded"
            else:
                self._queued_bytes += size
        self.check()
        try:
            self._queue.put_nowait((tuple(samples), tuple(raw_messages), size))
        except queue.Full as exc:
            with self._lock:
                self._queued_bytes -= size
            self._set_error("Recording queue full; acquisition must stop")
            raise RecordingError("Recording queue full; acquisition must stop") from exc

    def finish(self, *, error: str = "", timeout_s: float = 15) -> dict:
        if self._done.is_set():
            return dict(self.result)
        if error:
            self._set_error(error)
        if self._thread is None:
            return self.result
        self._stop.set()
        self.state = "finalizing"
        if not self._done.wait(timeout_s):
            self._set_error("Recorder finalization timed out")
            process = self._process
            if process is not None and process.poll() is None:
                process.kill()  # Only the encoder started by this recorder.
            if not self._done.wait(3):
                self.state = "failed"
                return {"status": "failed", "error": "Recorder worker has not exited", "video_path": str(self.video_path)}
        self._thread.join(1)
        return dict(self.result)

    def _emit(self, frames, frame_map) -> None:
        for output in frames:
            pixels = output.source.pixels
            if len(pixels) != output.source.width * output.source.height * 3:
                raise RecordingError("Malformed BGR sample")
            remaining = memoryview(pixels)
            while remaining:
                written = self._process.stdin.write(remaining)
                if not written:
                    raise RecordingError("Encoder input pipe closed")
                remaining = remaining[written:]
            frame_map.writerow((output.index, output.pts_s, output.source.identity.source_time_s,
                                output.source.source_index, output.source.identity.received_sequence,
                                int(output.repeated)))
            self._frames_written += 1
            self._repeated += int(output.repeated)

    def _run(self) -> None:
        duration = 0.0
        video_verified = False
        verification_method = None
        event_metadata = {}
        quality_metadata = {}
        pupils = {}
        phase = "prepare"
        try:
            # Keep worker initialization inside the same failure/finalization
            # boundary as encoding. Otherwise a dead worker leaves start/finish
            # waiting for signals that can never arrive and holds its lease.
            msgpack = _load_msgpack()
            with ExitStack() as files:
                def open_file(name, mode="x", **kwargs):
                    return files.enter_context((self.sidecar / name).open(mode, **kwargs))
                # Reserve public metadata early; failure cannot overwrite user files.
                initial_meta = {**self.metadata, "deviceModel": self.source_model, "status": "preparing", "productIntegration": True,
                                "sourceInfo": self.source_info, "sourceTimeOriginS": self.timeline.t0,
                                "connectionGeneration": self._first_frame.identity.generation,
                                "encodedWidth": self._first_frame.width, "encodedHeight": self._first_frame.height,
                                "videoSamplingRateHz": self.timeline.fps,
                                "coordinateSpace": "world_normalized_top_left"}
                with self.meta_path.open("x", encoding="utf-8") as metadata_file:
                    self._meta_owned = True
                    json.dump(initial_meta, metadata_file)
                    metadata_file.flush()
                    os.fsync(metadata_file.fileno())
                atomic_json(self.sidecar / "recovery.json", {**initial_meta, "version": 1, "name": self.name})
                self._save_context()
                if self.calibration_data is not None:
                    open_file("calibration.msgpack", "xb").write(msgpack.packb(self.calibration_data, use_bin_type=True))
                csv_file = files.enter_context(self.csv_path.open("x+", newline="", encoding="utf-8"))
                csv_writer = csv.DictWriter(csv_file, fieldnames=CSV_FIELDS)
                csv_writer.writeheader()
                source_file = open_file("normalized-samples.jsonl", encoding="utf-8")
                raw_file = open_file("source-messages.msgpack", "xb")
                frame_map_file = open_file("frame-map.csv", newline="", encoding="utf-8")
                frame_map = csv.writer(frame_map_file)
                frame_map.writerow(("output_index", "pts_s", "source_timestamp_s", "source_index", "receive_sequence", "repeated"))
                stderr_file = open_file("encoder.stderr.txt", encoding="utf-8")
                gaze_spool = open_file("gaze-spool.jsonl", "x+", encoding="utf-8")
                event_spool = open_file("events-spool.jsonl", encoding="utf-8")
                open_file('communication-events.jsonl', encoding='utf-8')
                open_file('communication-capture.jsonl', encoding='utf-8')
                frame = self._first_frame
                command = [self.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
                           "-f", "rawvideo", "-pixel_format", "bgr24", "-video_size", f"{frame.width}x{frame.height}",
                           "-framerate", str(self.timeline.fps), "-i", "pipe:0", "-an", "-c:v", "libx264",
                           "-preset", "veryfast", "-tune", "zerolatency", "-g", str(self.timeline.fps),
                           "-pix_fmt", "yuv420p", "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
                           "-frag_duration", "1000000", "-flush_packets", "1", str(self.video_path)]
                self.check()
                phase = "encode"
                self._process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                                 stderr=stderr_file, bufsize=0)
                self._emit(self.timeline.initial(), frame_map)
                if self._process.poll() is not None:
                    raise RecordingError("Encoder exited during preparation")
                self.state = "recording"
                self._ready.set()
                checkpoint_at = time.monotonic()
                # The first world sample is held by the timeline; don't enqueue it twice.
                while not self._stop.is_set() or not self._queue.empty():
                    try:
                        samples, messages, size = self._queue.get(timeout=0.05)
                    except queue.Empty:
                        if self._process.poll() is not None:
                            raise RecordingError("Encoder exited during recording")
                        continue
                    try:
                        for message in messages:
                            if not message.topic.startswith("frame."):
                                raw_file.write(msgpack.packb({"received_monotonic_s": message.received_monotonic_s,
                                                             "parts": message.raw_parts}, use_bin_type=True))
                        for sample in samples:
                            if sample.identity.generation != frame.identity.generation:
                                raise RecordingError("Recording cannot mix connection generations")
                            if isinstance(sample, VideoFrame):
                                if sample.stream == "scene":
                                    self._emit(self.timeline.push(sample), frame_map)
                            else:
                                source_file.write(json.dumps(asdict(sample), allow_nan=False) + "\n")
                                if isinstance(sample, PupilSample):
                                    pupils[sample.eye] = sample
                                if isinstance(sample, GazeSample):
                                    gaze_spool.write(json.dumps(self.row_mapper(sample, self.timeline.t0, pupils), allow_nan=False) + "\n")
                                if isinstance(sample, EyeEventSample):
                                    event_spool.write(json.dumps(asdict(sample), allow_nan=False) + "\n")
                        if time.monotonic() - checkpoint_at >= 1:
                            for handle in (source_file, raw_file, gaze_spool, event_spool, frame_map_file):
                                handle.flush()
                                os.fsync(handle.fileno())
                            checkpoint_at = time.monotonic()
                    finally:
                        with self._lock:
                            self._queued_bytes -= size
                tail, duration = self.timeline.finish()
                self._emit(tail, frame_map)
                self._process.stdin.close()
                if self._process.wait(timeout=10) != 0:
                    raise RecordingError("Encoder failed; inspect encoder.stderr.txt")
                phase = "verify-video"
                verification_method = verify_video(self.video_path, ffmpeg=self.ffmpeg, ffprobe=self.ffprobe,
                    frames=self._frames_written, width=frame.width, height=frame.height,
                    duration=duration, fps=self.timeline.fps)
                video_verified = True
                logging.info("recording.video_verified method=%s frames=%s", verification_method, self._frames_written)
                phase = "finalize-csv"
                gaze_spool.flush()
                gaze_spool.seek(0)
                # The application stops mutating context before calling finish().
                csv_file.seek(0)
                csv_file.truncate()
                counts = write_gaze_csv(gaze_spool, csv_file, duration, self.stimuli, self.markers, source_model=self.source_model)
                self._gaze_written, self._valid_gaze_written = counts["gazeRows"], counts["validGazeRows"]
                self._gaze_outside = counts["gazeOutsideVideo"]
                event_spool.flush()
                event_metadata = append_events(self.sidecar / "events-spool.jsonl", csv_file, self.timeline.t0, duration)
                event_metadata.update(append_communications(self.sidecar / 'communication-events.jsonl', csv_file,
                    duration, self.name, self._first_frame.identity.generation, self.timeline.t0, self.source_model))
                order_csv(csv_file, self.sidecar)
                for handle in (csv_file, source_file, raw_file):
                    handle.flush()
                    os.fsync(handle.fileno())
                if self.source_model == "PupilCore":
                    quality_metadata = journal_metrics(self.sidecar / "normalized-samples.jsonl", self.timeline.t0, duration)
                if event_metadata.get('communicationCaptureErrors'):
                    self._set_error('Communication capture incomplete; saved video and available events retained: '
                                    + '; '.join(event_metadata['communicationCaptureErrors']))
        except Exception as exc:
            logging.exception("recording.worker_failed phase=%s", phase)
            self._set_error(f"{phase}: {exc}")
        finally:
            process = self._process
            if process is not None:
                try:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=3)
                    if process.stdin is not None and not process.stdin.closed:
                        process.stdin.close()
                except (OSError, subprocess.TimeoutExpired) as exc:
                    self._set_error(f"Encoder cleanup failed: {exc}")
            self.state = "partial" if self._error and video_verified else "failed" if self._error else "complete"
            huahong = self.source_model in ("HH_ET10C", "HH_ET28")
            self.result = {**self.metadata, **event_metadata, **quality_metadata, "status": self.state, "error": self._error, "video_path": str(self.video_path),
                           "csv_path": str(self.csv_path), "durationSeconds": duration,
                           "outputFrames": self._frames_written, "repeatedFrames": self._repeated,
                           "gazeRows": self._gaze_written, "gazeOutsideVideo": self._gaze_outside,
                           "samplingRateHz": self._gaze_written / duration if duration else 0,
                           "validityPercent": 100 * self._valid_gaze_written / self._gaze_written if self._gaze_written else 0,
                           "deviceModel": self.source_model, "deviceType": self.metadata.get("deviceType", "眼镜式"), "productIntegration": True,
                           "calibrationVerified": self.metadata.get("calibrationVerified", False),
                           "markers": list(self.markers), "videoSamplingRateHz": self.timeline.fps,
                           "sourceTimeOriginS": self.timeline.t0,
                           **({"pupilDataSchemaVersion": 4,
                               "standardExportContract": "original_133_columns; eye-image-normalized pupil geometry; 7invensun member validity bits; unsupported physical quantities remain missing",
                               "measurementAvailability": {
                                   "independentSmoothing": "not_implemented; standard smooth columns empty",
                                   "eyelidGeometryAndOpenness": "not_provided_by_pupil_core",
                                   "imu": "not_supported_by_pupil_core",
                                   "vendorPupilBitMasks": "not_provided; standard export constructs six member-validity bits from actual output measurements",
                                   "pupilEllipseMinorAxisMm": "not_measured; image short axis is normalized by the true eye-image width in standard columns",
                                   "pupilToLensDistance": "not_verified; circle Z is not substituted",
                                   "cornealCurvatureOrigin": "not_measured; eye-sphere centre remains internal only",
                                   "nativeMonocularGazeDepth": "model_estimate_not_measured_depth"},
                               "eventCompletionPolicy": "native fixation requires an observed valid dispersion exit; gaps, invalidity, source changes and recording end remain incomplete; legacy events without completion declarations retain legacy interpretation",
                               "pupilValidityPolicy": "per-eye 2D detection validity, 3D detection confidence and MRT model quality policy are independent; rejected analytical values stay empty, raw diameters and quality provenance are retained",
                               "fixationPositionPolicy": "native algorithm v3 completed events use the mean of unique accepted samples over the whole interval; online/incomplete and legacy Capture positions retain reported window semantics"}
                              if self.source_model == 'PupilCore' else {}),
                           "encodedWidth": self._first_frame.width, "encodedHeight": self._first_frame.height,
                           "coordinateSpace": "screen_normalized_top_left" if self.source_model == "HH_ET10C" else "world_normalized_top_left",
                           "gazeCompatibilityAliases": (
                               "Huahong live/replay raw/smooth are normalized 2D compatibility aliases; CSV gaze_x/y only for recommended/available monocular gaze; 3D/raw/smooth point fields empty"
                               if huahong else "native live/replay recommended=raw in normalized 2D; native CSV raw=calibrated 3D point; independent smoothing unavailable"
                               if self.source_info.get('backend') == 'native' else "Capture live/replay recommended=raw in normalized 2D; CSV 3D/raw points require actual 3D geometry; independent smoothing unavailable"),
                           **({"measurementSemantics": {
                               "pupilGeometry": "not mapped to CSV; vendor units unverified",
                               "vendorEyeData": (
                                   "ET28 eyeInfo/sightLine retained as vendor fields in normalized-samples.jsonl; units unverified"
                                   if self.source_model == "HH_ET28" else "ET10 pupil/eye geometry not exposed by this adapter"),
                               "csvGaze": "normalized 2D gaze_x/y; bit 0 indicates validity; physical 3D/raw/smooth points unavailable"}}
                              if huahong else {"measurementSemantics": {
                               "pupilCenter": "eye image normalized, top-left; exact eye-frame size or original 2D detector norm_pos required",
                               "pupilDiameter": "detected ellipse long-axis pixels divided by exact eye-image width; original px retained internally",
                               "pupilMinorAxis": "detected ellipse short-axis pixels divided by exact eye-image width",
                               "pupilDiameterMm": "pye3d refractive model estimate, not direct physical measurement",
                               "pupilDistance": "standard column unavailable; pupil circle Z is not a verified pupil-to-lens distance",
                               "nativeGeometry": "3D points/origins in world camera millimeters; direction unit vectors",
                               "nativeMonocularDepth": "estimated gaze distance, not independent depth measurement",
                               "missingFields": "eyelids/openness, gyro, independent smoothing, corneal-curvature origin, pupil-to-lens distance and mm ellipse minor axis have no verified equivalent"}}
                              if self.source_model == 'PupilCore' else {}),
                           "pupilAlignment": "not applicable: Huahong gaze callbacks do not use Pupil gaze.base_data or pupil pairing" if huahong else "authoritative gaze.base_data within +/-100ms; missing contributors stay missing; legacy fallback past-only; model quality retained",
                           "networkLossless": False, "videoVerified": video_verified, "videoVerificationMethod": verification_method, "sourceInfo": self.source_info}
            try:
                # Only replace metadata created by this recorder, not unrelated files.
                if self._meta_owned:
                    atomic_json(self.meta_path, self.result)
                atomic_json(self.sidecar / "diagnostics.json", self.result)
            except (OSError, ValueError) as exc:
                self._set_error(str(exc))
                self.state = "failed"
                self.result.update(status="failed", error=f"Metadata finalization failed: {exc}")
            if self._lease:
                self._lease.close()
            self._ready.set()
            self._done.set()
