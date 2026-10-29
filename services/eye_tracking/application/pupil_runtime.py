"""Single-owner acquisition worker and MRT recording lifecycle.

ZeroMQ never crosses threads. Preview is replaceable; recording overflow fails
explicitly. Closing MRT never closes Capture or starts Capture recordings.
"""

from concurrent.futures import Future
from datetime import datetime
from pathlib import Path
import logging
import math
import faulthandler
import queue
import threading
import time
import uuid

from ..adapters.pupil_core.network import PupilNetwork
from ..adapters.pupil_core.service import PupilService
from ..domain.samples import GazeSample, PupilSample, VideoFrame
from ..infrastructure.pupil_recorder import PupilRecorder
from ..infrastructure.recording_paths import RecordingPaths
from ..infrastructure.pupil_recovery import recover_directory
from ..infrastructure.recording_communication import validate_communication


class PupilRuntime:
    def __init__(self, config, *, project_roots=(), ffmpeg="ffmpeg", ffprobe="ffprobe", source=None, prepare_native=False):
        self.service = PupilService(config, first_frame_timeout_s=source.config.startup_timeout_s if source else 1.5, source=source)
        self.paths = RecordingPaths(project_roots)
        self.ffmpeg, self.ffprobe = ffmpeg, ffprobe
        self.requests = queue.Queue(maxsize=16)
        self.events = queue.Queue(maxsize=32)
        self._completed = queue.Queue(maxsize=1)
        self._lock = threading.Lock()
        self._latest = {}
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="pupil-runtime")
        self.recorder = None
        self.finalizer = None
        self.last_result = {}
        self.last_error = ""
        self.tracking = False
        self.world = None
        self.recording_info = {}
        self.stimulus = ""
        self.recovery_results = []
        self._pending_start = None
        self._pending_prepare_start = None
        self._canceled_starts = set()
        self._prepare_native = prepare_native and getattr(source, 'backend', '') == 'native'
        self.preparation = None

    def _resolve_start(self, error=''):
        self._pending_prepare_start = None
        future, self._pending_start = self._pending_start, None
        if future is not None and not future.done():
            future.set_result({'type': 'rsp_cmd', 'id': 'start', 'error': -1 if error else 0,
                               'msg': error or 'ok', 'model': 'PupilCore', 'acquisition_ready': not bool(error)})

    def _event(self, event):
        if self.events.full():
            self.events.get_nowait()
        self.events.put_nowait(event)

    def _calibration_result(self, result):
        if result is not None:
            if result.get("id", "complete_calibration") == "complete_calibration":
                self.tracking = result["error"] == 0
            self._event({"type": "rsp_cmd", "id": "complete_calibration", **result})

    def start(self):
        self._thread.start()

    def request(self, command, args=None):
        future = Future()
        if self._stop.is_set():
            future.set_exception(RuntimeError("Service is shutting down"))
        else:
            try:
                self.requests.put_nowait((command, args or {}, future))
            except queue.Full:
                future.set_exception(RuntimeError("Command queue is full"))
        return future

    def cancel_start(self, future):
        # Queued requests can be canceled directly; running requests are closed
        # by the acquisition owner even when the regular command queue is full.
        if not future.cancel() and not future.done():
            with self._lock:
                self._canceled_starts.add(future)

    def take_latest(self):
        with self._lock:
            latest, self._latest = self._latest, {}
            return tuple(latest.values())

    def close(self):
        self._stop.set()
        self._thread.join(25)
        if self._thread.is_alive():
            raise RuntimeError("Pupil worker did not finish shutdown")

    def _finish(self, error=""):
        if self.recorder is None or self.finalizer is not None:
            return
        recorder = self.recorder
        self.recorder = None

        def finalize():
            try:
                result = recorder.finish(error=error)
            except Exception as exc:
                result = {"status": "failed", "error": str(exc)}
            self._completed.put({**result, "recording_id": recorder.name})

        self.finalizer = threading.Thread(target=finalize, name="pupil-finalizer")
        self.finalizer.start()

    def _collect(self):
        try:
            result = self._completed.get_nowait()
        except queue.Empty:
            return
        self.finalizer.join()
        self.finalizer = None
        try:
            video_size = Path(result["video_path"]).stat().st_size if result.get("video_path") else 0
        except OSError:
            video_size = 0
        self.last_result = {**result, "error": 0 if result.get("status") == "complete" else -1,
                            "msg": result.get("error", "") or result["status"],
                            "elapsed_ms": round(result.get("durationSeconds", 0) * 1000),
                            "video_size": video_size}
        event = {"type": "notify_recording_finalized", **self.last_result}
        # Status remains queryable even if no command client consumes notifications.
        self._event(event)

    def _feature_status(self):
        worker = self.service.calibration.worker
        if worker is None:
            return None
        return {"ready": worker.ready, "busy": worker.busy, "error": worker.error,
                "pid": worker.process.pid if worker.process is not None else None}

    def _command(self, command, args):
        if command == "get_source_clock":
            recorder = self.recorder
            if self.service.state != "ready" or not self.recording_info or recorder is None or self.finalizer is not None or recorder.state != 'recording':
                raise RuntimeError("An active connected Pupil recording is required for clock alignment")
            if recorder._first_frame.identity.generation != self.service.generation or self.recording_info.get('recording_id') != recorder.name:
                raise RuntimeError('Clock alignment cannot cross recording or connection generations')
            recorder.check()
            before = time.monotonic()
            source_time = self.service.network.source_time()
            return {"source_time_s": source_time, "remote_round_trip_ms": (time.monotonic() - before) * 1000,
                    "generation": self.service.generation, **self.recording_info}
        if command == "get_device_status":
            connected, version, error = self.service.state == "ready", self.service.network.version, ""
            native = getattr(self.service.network, 'backend', '') == 'native'
            if not connected and not native:
                remote = PupilNetwork(self.service.network.config)
                try:
                    remote.open()
                    connected, version = True, remote.version
                except Exception as exc:
                    error = str(exc)
                finally:
                    remote.close()
            return {"model": "PupilCore", "capture_connected": connected, "capture_version": version,
                    "acquisition_ready": self.service.state == "ready", "state": self.service.state,
                    "last_error": error or self.last_error, "calibration_verified": self.service.calibration.verified,
                    "recovered_recordings": self.recovery_results,
                    "backend_revision": "pupil-native-v7-score" if native else "pupil-free-card-v7",
                    "backend": "native" if native else "capture",
                    **({'algorithm_ready': self.preparation.ready, 'algorithm_error': self.preparation.error}
                       if self.preparation is not None else {}),
                    "received_by_topic": dict(self.service.received),
                    "calibration_feature": self._feature_status()}
        if command == "start":
            if self.finalizer or self.recorder:
                raise RuntimeError("Stop and finalize recording before reconnecting")
            if args.get("sdk_model", "PupilCore") != "PupilCore":
                raise ValueError("This service only supports PupilCore")
            if self.service.state == 'connecting' or self._pending_start is not None:
                raise RuntimeError('Device start already pending')
            if self.preparation is not None and not self.preparation.ready:
                if self.preparation.error:
                    raise RuntimeError(self.preparation.error)
                self._pending_prepare_start = time.monotonic() + 4
                return None
            if self.service.state != "ready":
                if getattr(self.service.network, 'backend', '') == 'native':
                    self.service.begin_connect()
                    return None
                self.service.connect()
                self.last_error = ""
            return {"model": "PupilCore", "acquisition_ready": True}
        if command == "stop":
            if self.recorder or self.finalizer:
                raise RuntimeError("Stop and finalize recording before stopping acquisition")
            self.service.calibration.cancel()
            self.service.close()
            self._resolve_start('Device start canceled')
            self.world, self.tracking = None, False
            with self._lock:
                self._latest.clear()
            return {}
        if command in ("start_tracking", "stop_tracking"):
            if command == "start_tracking" and self.service.state != "ready":
                raise RuntimeError("Acquisition is not ready")
            if command == "start_tracking" and (not self.service.calibration.verified or
                                                args.get("coe") != self.service.calibration.token):
                raise ValueError("请在本软件完成本次 Pupil 校准；历史校准不能跨连接复用")
            self.tracking = command == "start_tracking"
            return {"calibration_verified": self.service.calibration.verified}
        if command == "start_calibration":
            if self.service.state != "ready" or self.recorder or self.finalizer:
                raise RuntimeError("Connect the camera and stop recording before calibration")
            self.tracking = False
            if args.get("validation") is True:
                self.service.calibration.start_validation(args.get("coe"))
                self.tracking = True
            else:
                if hasattr(self.service.network, 'invalidate_mapping'):
                    self.service.network.invalidate_mapping()
                self.service.calibration.start(points=args.get("points", 9))
            return {"calibration_provider": "PupilCore", "tracker_initializing": True,
                    "calibration_session": self.service.calibration.session_id}
        if command == "start_calibration_point":
            self.service.calibration.sample_card_point(args.get("index"), args.get("x"), args.get("y"), args.get("attempt"))
            return {"point_pending": True, "index": args.get("index"), "attempt": args.get("attempt"),
                    "calibration_provider": "PupilCore"}
        if command == "cancel_calibration":
            self.service.calibration.cancel()
            self.tracking = False
            return {"calibration_provider": "PupilCore"}
        if command == "finish_calibration":
            self.service.calibration.finish()
            return {"calibration_provider": "PupilCore", "result_pending": True}
        if command == "complete_calibration":
            if self.service.calibration.pending:
                try:
                    measured = self.service.calibration.finish()
                except Exception as exc:
                    self.tracking = False
                    return self.service.calibration.fail(str(exc))
                if measured is not None:
                    return measured
                return {"result_pending": True, "calibration_provider": "PupilCore"}
            return {"coe": self.service.calibration.complete(), "calibration_provider": "PupilCore"}
        if command == "set_stimulus":
            name = args.get("name", "")
            if not isinstance(name, str) or len(name) > 4096:
                raise ValueError("Invalid stimulus name")
            if self.recorder:
                self.recorder.set_stimulus(name, self.service.network.source_time())
            self.stimulus = name
            return {}
        if command in ("add_custom_marker", "add_trigger_marker"):
            if not self.recorder:
                raise RuntimeError("Markers require an active recording")
            if command == "add_custom_marker":
                name = args.get("name")
                if not isinstance(name, str) or not name.strip() or len(name) > 4096:
                    raise ValueError("Invalid marker name")
                marker = {"type": "custom", "name": name}
            else:
                value = args.get("triggerValue")
                if type(value) is not int or not 0 <= value <= 255:
                    raise ValueError("Trigger value must be 0..255")
                marker = {"type": "trigger", "triggerValue": value}
            elapsed = max(0.0, (self.service.network.source_time() - self.recorder.timeline.t0) * 1000)
            marker.update(timestamp=elapsed, videoTime=elapsed,
                          timestampSource='pupil_native' if getattr(self.service.network, 'backend', '') == 'native' else 'pupil_remote')
            self.recorder.add_marker(marker)
            return {"marker": marker}
        if command == "get_recording_markers":
            return {"markers": list(self.recorder.markers) if self.recorder else self.last_result.get("markers", [])}
        if command == 'record_communication':
            recorder = self.recorder
            if recorder is None or self.finalizer is not None or self.service.state != 'ready':
                raise RuntimeError('Communication events require an active connected recording')
            event = validate_communication(args, recorder.name, self.service.generation)
            if recorder._first_frame.identity.generation != self.service.generation:
                raise RuntimeError('Communication cannot cross connection generations')
            # The I/O owner maps the actual send/receive completion instant using
            # get_source_clock. Receipt time must not replace that event time.
            elapsed = (self.service.network.source_time() - recorder.timeline.t0) * 1000
            if not math.isfinite(elapsed) or event['video_time_ms'] > elapsed:
                raise ValueError('Communication event is ahead of the recording source clock')
            accepted = recorder.add_communication(event)
            return {'recording_id': recorder.name, 'event_id': event['event_id'],
                    'recorded': True, 'duplicate': not accepted}
        if command == "get_recording_status":
            return {"status": "finalizing" if self.finalizer else "recording" if self.recorder else
                    "finalized" if self.last_result else "idle", "result": self.last_result,
                    **self.recording_info}
        if command == "start_recording":
            if self.recorder or self.finalizer:
                raise RuntimeError("A recording is active or finalizing")
            if self.service.state != "ready" or self.world is None:
                raise RuntimeError("A real world frame is required before recording")
            if time.monotonic() - self.world.identity.received_monotonic_s > 0.5:
                raise RuntimeError("World frame is stale; wait for live video before recording")
            if self.service.network.version.startswith("mrt-pupil-simulator/"):
                raise RuntimeError("Simulator recordings are not enabled in the production service")
            if not self.service.calibration.verified or not self.tracking:
                raise RuntimeError("Complete Pupil calibration in this connection before recording")
            audit = self.service.calibration.snapshot()
            directory = self.paths.directory(args.get("project_path"))
            name = "pupil_" + uuid.uuid4().hex[:12] + datetime.now().strftime("_%Y%m%d_%H%M%S")
            subject = args.get("subject_name", "")
            if not isinstance(subject, str) or len(subject) > 4096:
                raise ValueError("Invalid subject name")
            recorder = PupilRecorder(directory, name, self.world, ffmpeg=self.ffmpeg, ffprobe=self.ffprobe,
                                     fps=args.get("video_sampling_rate_hz", 30),
                                     calibration_data=audit,
                                     source_info={"captureVersion": self.service.network.version,
                                                  **(self.service.network.audit() if hasattr(self.service.network, 'audit') else {}),
                                                  "simulatedSource": False}, stimulus=self.stimulus,
                                     metadata={"subjectName": subject, "deviceType": "眼镜式",
                                               "calibrationVerified": True, "calibrationProvider": "PupilCore",
                                               "calibrationMode": "natural_feature", "independentValidationPerformed": audit["independentValidationPerformed"],
                                               "calibrationTrainingAngular": (audit.get("result") or {}).get("params", {}).get("training_angular"),
                                               "calibrationValidation": audit.get("validation"),
                                               "videoSource": "world", "splitScreen": bool(args.get("split_screen"))})
            from ..infrastructure.pupil_csv import NativeCsvMapper
            recorder.row_mapper = NativeCsvMapper()
            recorder.start()
            if hasattr(self.service.network, 'reset_events'):
                self.service.network.reset_events()
            self.recorder = recorder
            self.last_result = {}
            self.recording_info = {"recording_id": name, "video_path": str(recorder.video_path),
                                   "csv_path": str(recorder.csv_path), "source_model": "PupilCore",
                                   "source_time_origin_s": recorder.timeline.t0,
                                   "communication_journal_path": str(recorder.sidecar / 'communication-capture.jsonl')}
            return self.recording_info
        if command == "stop_recording":
            self._finish()
            return self._command("get_recording_status", {})
        raise ValueError(f"Unsupported Pupil command: {command}")

    def _run(self):
        try:
            if self._prepare_native:
                from ..adapters.pupil_native.preparation import NativePreparation
                self.preparation = NativePreparation(self.service.network.worker_factory)
            try:
                for directory in self.paths.recovery_directories():
                    if self._stop.is_set():
                        break
                    self.recovery_results.extend(recover_directory(directory, ffmpeg=self.ffmpeg, ffprobe=self.ffprobe))
            except Exception as exc:
                # An inaccessible historical folder must not leave a live WS
                # server waiting forever on a dead acquisition worker.
                self.last_error = f"Recording recovery failed: {exc}"
                self.recovery_results.append({"status": "failed", "error": self.last_error})
            while not self._stop.is_set():
                if self.preparation is not None:
                    self.preparation.poll()
                self._collect()
                try:
                    # Do not throttle high-rate eye cameras while waiting for commands.
                    command, args, future = self.requests.get(timeout=0 if self.service.state == "ready" else 0.01)
                    if future.set_running_or_notify_cancel():
                        calibration_command = 'calibration' in command
                        if calibration_command:
                            logging.info('pupil.command begin; id=%s execution=pipe-v3', command)
                            faulthandler.dump_traceback_later(3, repeat=False)
                        before = time.monotonic()
                        try:
                            result = self._command(command, args)
                            if result is None and command == 'start':
                                self._pending_start = future
                            else:
                                future.set_result({"type": "rsp_cmd", "id": command, "error": 0, "msg": "ok", **result})
                        except Exception as exc:
                            self.last_error = str(exc)
                            future.set_result({"type": "rsp_cmd", "id": command, "error": -1, "msg": str(exc)})
                        finally:
                            if calibration_command:
                                faulthandler.cancel_dump_traceback_later()
                                logging.info('pupil.command returned; id=%s elapsed_ms=%s', command,
                                             round((time.monotonic() - before) * 1000))
                except queue.Empty:
                    pass
                with self._lock:
                    canceled, self._canceled_starts = self._canceled_starts, set()
                if self._pending_start is not None and self._pending_start in canceled:
                    self.service.close()
                    self._resolve_start('Device start canceled after command connection closed')
                if self._pending_prepare_start is not None:
                    try:
                        if self.preparation.error:
                            raise RuntimeError(self.preparation.error)
                        if time.monotonic() >= self._pending_prepare_start:
                            raise TimeoutError('Pupil 内置算法初始化超过开启等待时间，请检查后端日志后重新连接')
                        if self.preparation.ready:
                            self._pending_prepare_start = None
                            self.service.begin_connect()
                    except Exception as exc:
                        self.last_error = str(exc)
                        self._resolve_start(str(exc))
                if self.service.state == 'connecting':
                    try:
                        self.service.poll_connect(10)
                        if self.service.state == 'ready':
                            self.last_error = ''
                            self._resolve_start()
                    except Exception as exc:
                        self.last_error = str(exc)
                        self._resolve_start(str(exc))
                if self.service.state == "ready":
                    calibration_pending = self.service.calibration.pending
                    try:
                        samples = self.service.read(10)
                        was_verified = self.service.calibration.verified
                        for message in self.service.last_messages:
                            self._calibration_result(self.service.calibration.observe_card_data(message))
                            if message.topic.startswith("notify.calibration."):
                                self._calibration_result(self.service.calibration.handle(message))
                        self._calibration_result(self.service.calibration.tick())
                        if was_verified and not self.service.calibration.verified:
                            self.tracking = False
                            self._finish("Capture calibration changed during recording")
                        for sample in samples:
                            if isinstance(sample, VideoFrame) and sample.stream == "scene":
                                self.world = sample
                            if isinstance(sample, (VideoFrame, PupilSample)) or (self.tracking and isinstance(sample, GazeSample)):
                                with self._lock:
                                    key = sample.stream if isinstance(sample, VideoFrame) else sample.eye if isinstance(sample, PupilSample) else "gaze"
                                    self._latest[key] = sample
                        if self.recorder:
                            self.recorder.submit(samples, self.service.last_messages)
                    except Exception as exc:
                        self.last_error = str(exc)
                        result = self.service.calibration.fail(str(exc))
                        if calibration_pending:
                            self._calibration_result(result)
                        self.tracking = False
                        self._event({"type": "notify_device_error", "source": "PupilCore", "msg": str(exc)})
                        self._finish(str(exc))
                        self.service.close()
                        self.world = None
                        with self._lock:
                            self._latest.clear()
        finally:
            if self.preparation is not None:
                self.preparation.close()
            self._resolve_start('Service shutdown during device start')
            self._finish("Service shutdown during recording")
            try:
                self.service.calibration.cancel()
            except Exception:
                pass
            self.service.close()
            if self.finalizer:
                self.finalizer.join(20)
                self._collect()
            while not self.requests.empty():
                _, _, future = self.requests.get_nowait()
                if not future.done():
                    future.set_exception(RuntimeError("Service shut down"))
