"""Isolated Huahong command worker and recording lifecycle."""
from concurrent.futures import Future, TimeoutError as FutureTimeoutError
from dataclasses import asdict
import copy
import base64
import hashlib
import json
import logging
from pathlib import Path
import queue
import threading
import time
import uuid
from ..adapters.huahong.service import HuahongService, NATIVE_CALIBRATION_TIMEOUT_S
from ..adapters.huahong.data_normalizer import gaze_csv_row
from ..domain.samples import GazeSample, VideoFrame
from ..infrastructure.pupil_recorder import PupilRecorder
from ..infrastructure.recording_paths import RecordingPaths
from ..infrastructure.huahong_diagnostics import HuahongWatchdog

RECORDING_PREPARATION_BYTE_LIMIT = 64 * 1024 * 1024
RECORDING_PREPARATION_TIMEOUT_S = 5.0  # The existing frontend waits six seconds.

def calibration_point_timeout_s(model):
    # Give the model's native point operation one second to return its result.
    return NATIVE_CALIBRATION_TIMEOUT_S[model] + 1.0


def _calibration_mean(quality, eye):
    points = quality[eye]['points']
    return sum(point['score'] for point in points) / len(points)


class HuahongRuntime:
    def __init__(self, model, sdk_root, *, project_roots=(), ffmpeg='ffmpeg', ffprobe='ffprobe'):
        self.model = model
        self.paths = RecordingPaths(project_roots, model)
        self.service = HuahongService(model, sdk_root)
        self.ffmpeg, self.ffprobe = ffmpeg, ffprobe
        self.requests, self.events = queue.Queue(16), queue.Queue(64)
        self._latest, self._lock, self._stop = {}, threading.Lock(), threading.Event()
        self._thread = threading.Thread(target=self._run, name='huahong-runtime')
        self.recorder = self.finalizer = self.world = self.screen = None
        self._recording_accepted = False
        self.completed = queue.Queue(1)
        self.last_result, self.recording_info = {}, {}
        self.last_error, self.stimulus = '', ''
        self.tracking, self.verified, self.token = False, False, ''
        self.calibration_points, self.calibration_task, self.calibration_generation = {}, None, 0
        self.point_result = queue.Queue(1)
        self.calibration_expected = 0
        self.calibration_attempt = 0
        self.calibration_session = None
        self.calibration_pending = None
        self.calibration_deadline = 0.0
        self.calibration_quality = None
        self._screen_tick = 0
        self._acquisition_error = None
        self.recovery_results = []
        self._diagnostics = HuahongWatchdog(model, snapshot=self._diagnostic_snapshot)

    def _diagnostic_snapshot(self):
        # Observations only: never acquire an SDK/preview/queue lock from the
        # watchdog whose purpose is to diagnose that owner's stalled operation.
        now = time.monotonic()
        eye = getattr(self.service, '_eye_preview', None)
        def age(value):
            return round((now - value) * 1000) if value else None
        return {'state': self.service.state, 'generation': self.service.generation,
                'sequence': getattr(self.service, 'sequence', None),
                'scene_age_ms': age(getattr(self.service, '_last_frame', 0)),
                'queued_bytes': getattr(self.service, 'queued_bytes', None),
                'ir_frames': getattr(eye, 'received_frames', 0),
                'ir_age_ms': age(getattr(eye, 'last_frame', 0))}

    def start(self):
        self._thread.start()

    def request(self, command, args=None):
        future = Future()
        try:
            if self._stop.is_set():
                raise RuntimeError('Service shutting down')
            self.requests.put_nowait((command, args or {}, future))
        except Exception as exc:
            future.set_exception(exc)
        return future

    def take_latest(self):
        with self._lock:
            result, self._latest = tuple(self._latest.values()), {}
        return result

    def event(self, value):
        try:
            self.events.put_nowait(value)
        except queue.Full:
            raise RuntimeError('Command event queue overflow')

    def close(self):
        self._stop.set()
        self._thread.join(25)
        if self._thread.is_alive():
            raise RuntimeError('Huahong worker shutdown timed out')

    def finish(self, error=''):
        if self.recorder is None:
            return
        recorder, self.recorder = self.recorder, None
        accepted, self._recording_accepted = self._recording_accepted, False
        def finalize():
            try:
                result = recorder.finish(error=error)
            except Exception as exc:
                result = {'status': 'failed', 'error': str(exc)}
            self.completed.put({**result, 'recording_id': recorder.name, '_recording_accepted': accepted})
        self.finalizer = threading.Thread(target=finalize, name='huahong-finalizer')
        self.finalizer.start()

    def _cancel(self):
        self.calibration_generation += 1
        self.verified, self.token = False, ''
        self.calibration_quality = None
        self.service.calibration_quality = None
        # Avoid unverified concurrent calls into vendor calibration. A cancelled
        # point finishes at its native timeout; its result is stale.
        self.calibration_points.clear()
        self.calibration_expected = 0
        self.calibration_attempt = 0
        self.calibration_session = None
        self.calibration_pending = None
        self.calibration_deadline = 0.0

    def _poll_calibration(self):
        if self.calibration_pending and time.monotonic() >= self.calibration_deadline:
            _, index, attempt = self.calibration_pending
            session = self.calibration_session
            logging.warning('huahong.calibration watchdog model=%s index=%s attempt=%s timeout_s=%s',
                            self.model, index, attempt, calibration_point_timeout_s(self.model))
            self._cancel()
            self.event({'type': 'notify_finish', 'index': index, 'attempt': attempt,
                        'error': -1, 'msg': 'Calibration point timed out; restart calibration',
                        'source': self.model, 'calibration_session': session,
                        'calibration_invalidated': True,
                        '_calibration_generation': self.calibration_generation})
        if self.calibration_task and not self.point_result.empty():
            generation, index, attempt, error, msg = self.point_result.get_nowait()
            self.calibration_task.join()
            self.calibration_task = None
            self.calibration_pending = None
            if generation == self.calibration_generation:
                session = self.calibration_session
                invalidated = error != 0 and self.model == 'HH_ET28'
                if error == 0:
                    self.calibration_points[index] = True
                elif invalidated:
                    # Both ET28 vendor demos end the entire round on a failed
                    # native point; no API establishes a safe in-round retry.
                    self._cancel()
                    msg = f'{msg}; restart calibration'
                self.event({'type': 'notify_finish', 'index': index, 'attempt': attempt,
                            'error': error, 'msg': msg, 'source': self.model,
                            'calibration_session': session,
                            **({'calibration_invalidated': True} if invalidated else {}),
                            '_calibration_generation': self.calibration_generation})

    def _command(self, command, args):
        if command == 'get_device_status':
            return {'model': self.model, 'acquisition_ready': self.service.state == 'ready',
                    'state': self.service.state, 'last_error': self.last_error,
                    'calibration_verified': self.verified, 'timestamp_source': 'host_arrival',
                    'recovered_recordings': self.recovery_results, 'versions': self.service.versions,
                    'capabilities': asdict(self.service.capabilities)}
        if command == 'get_recording_status':
            return {'status': 'recording' if self.recorder else 'finalizing' if self.finalizer else
                    'finalized' if self.last_result else 'idle', 'result': self.last_result, **self.recording_info}
        if command == 'stop_recording':
            self.finish()
            return self._command('get_recording_status', {})
        if command == 'get_recording_markers':
            return {'markers': list(self.recorder.markers) if self.recorder else self.last_result.get('markers', [])}
        if command == 'set_stimulus':
            name = args.get('name', '')
            if not isinstance(name, str) or len(name) > 4096:
                raise ValueError('Invalid stimulus')
            self.stimulus = name
            if self.recorder:
                self.recorder.set_stimulus(name, time.perf_counter())
            return {}
        if command in ('add_custom_marker', 'add_trigger_marker'):
            if not self.recorder:
                raise RuntimeError('Recording required')
            if command == 'add_custom_marker':
                name = args.get('name')
                if not isinstance(name, str) or not name.strip() or len(name) > 4096:
                    raise ValueError('Invalid marker')
                marker = {'type': 'custom', 'name': name}
            else:
                value = args.get('triggerValue')
                if type(value) is not int or not 0 <= value <= 255:
                    raise ValueError('Invalid trigger')
                marker = {'type': 'trigger', 'triggerValue': value}
            elapsed = (time.perf_counter() - self.recorder.timeline.t0) * 1000
            marker.update(timestamp=elapsed, videoTime=elapsed, timestampSource='host_arrival')
            self.recorder.add_marker(marker)
            return {'marker': marker}
        if command == 'start':
            if args.get('sdk_model', self.model) != self.model:
                raise ValueError('Model switching requires a new acquisition process')
            if self.recorder or self.finalizer or self.calibration_task:
                raise RuntimeError('Wait for recording/calibration finalization')
            if self.service.state != 'ready':
                if not self.paths.roots:
                    raise ValueError('Authorized project root required')
                config_path = self.paths.roots[0] / 'huahong.json'
                if config_path.exists():
                    if config_path.is_symlink() or config_path.stat().st_size > 65536:
                        raise ValueError('Unsafe Huahong configuration')
                    config = json.loads(config_path.read_text(encoding='utf-8'))
                    if not isinstance(config, dict):
                        raise ValueError('Huahong config must be an object')
                    self.service.config = config
                self.service.connect()
            return {'model': self.model, 'acquisition_ready': True}
        if command == 'stop':
            if self.recorder or self.finalizer or self.calibration_task:
                raise RuntimeError('Wait for recording/calibration finalization')
            self._cancel()
            with self._diagnostics.phase('service.close', timeout_s=5):
                self.service.close()
            self.world, self.tracking = None, False
            with self._lock:
                self._latest.clear()
            return {}
        if self.service.state != 'ready':
            raise RuntimeError('Connect device first')
        if command == 'start_calibration':
            if self.recorder or self.finalizer or self.calibration_task:
                raise RuntimeError('Stop recording and wait for pending calibration')
            self._cancel()
            session = args.get('calibration_session')
            if session is not None and (not isinstance(session, str) or not 1 <= len(session) <= 128):
                raise ValueError('Invalid calibration session')
            points = args.get('points', 5)
            self.service.start_calibration(points)
            self.calibration_session = session or uuid.uuid4().hex
            self.calibration_expected, self.tracking = points, False
            return {'calibration_provider': self.model}
        if command in ('cancel_calibration', 'cancel_calibration_point'):
            if args.get('calibration_session', self.calibration_session) != self.calibration_session:
                raise ValueError('Stale calibration session')
            self._cancel()
            return {'attempt': args.get('attempt'), 'calibration_provider': self.model}
        if command == 'start_calibration_point':
            if args.get('calibration_session', self.calibration_session) != self.calibration_session:
                raise ValueError('Stale calibration session')
            if self.calibration_task or not self.calibration_expected:
                raise RuntimeError('Calibration point is already pending or calibration has not started')
            index, attempt = args.get('index'), args.get('attempt', self.calibration_attempt + 1)
            x, y = args.get('x'), args.get('y')
            if type(index) is not int or index != len(self.calibration_points) + 1 or index > self.calibration_expected:
                raise ValueError('Invalid calibration index')
            if type(attempt) is not int or attempt <= self.calibration_attempt:
                raise ValueError('Invalid calibration attempt')
            if any(type(v) not in (int, float) for v in (x, y)):
                raise ValueError('Invalid calibration coordinate')
            self.calibration_attempt = attempt
            generation = self.calibration_generation
            self.calibration_pending = (generation, index, attempt)
            self.calibration_deadline = time.monotonic() + calibration_point_timeout_s(self.model)
            def calibrate():
                started = time.monotonic()
                logging.info('huahong.calibration point_start model=%s index=%s attempt=%s native_timeout_s=%s',
                             self.model, index, attempt, NATIVE_CALIBRATION_TIMEOUT_S[self.model])
                error, msg = 0, ''
                try:
                    self.service.calibration_point(x, y)
                except Exception as exc:
                    error, msg = -1, str(exc)
                logging.info('huahong.calibration point_result model=%s index=%s attempt=%s elapsed_ms=%s error=%s msg=%s',
                             self.model, index, attempt, round((time.monotonic() - started) * 1000), error, msg)
                self.point_result.put((generation, index, attempt, error, msg))
            self.calibration_task = threading.Thread(target=calibrate, name='huahong-calibration')
            self.calibration_task.start()
            return {'index': index, 'attempt': attempt, 'calibration_provider': self.model, 'point_pending': True}
        if command == 'complete_calibration':
            if args.get('calibration_session', self.calibration_session) != self.calibration_session:
                raise ValueError('Stale calibration session')
            if self.calibration_task or len(self.calibration_points) != self.calibration_expected or not self.calibration_expected:
                raise RuntimeError('All calibration points must succeed')
            try:
                feature = self.service.feature()
                if not feature:
                    raise RuntimeError('Empty calibration feature')
                token = json.dumps({'version': 1, 'model': self.model, 'generation': self.service.generation,
                                     'config_sha256': hashlib.sha256(json.dumps(self.service.config, sort_keys=True).encode()).hexdigest(),
                                     'feature': base64.b64encode(feature).decode(), 'nonce': uuid.uuid4().hex})
                # The shared completion flow expects tracking to be active when
                # it caches this coefficient, just as for the original SDK.
                self.service.start_tracking()
                quality = copy.deepcopy(self.service.calibration_quality) if self.model == 'HH_ET28' else None
                if self.model == 'HH_ET28' and not quality:
                    raise RuntimeError('Validated ET28 calibration quality is unavailable')
                scores = ({'left_score': _calibration_mean(quality, 'left'),
                           'right_score': _calibration_mean(quality, 'right'),
                           'calibration_quality': copy.deepcopy(quality)} if quality else {})
            except Exception:
                self._cancel()
                self.tracking = False
                raise
            self.token = token
            self.verified, self.tracking = True, True
            self.calibration_quality = quality
            self.calibration_expected = 0
            return {'coe': self.token, 'calibration_provider': self.model, 'tracking_error': 0, **scores}
        if command == 'start_tracking':
            if not self.verified or args.get('coe') != self.token:
                raise ValueError('Complete calibration in this connection; stale or foreign coefficients rejected')
            self.service.start_tracking()
            self.tracking = True
            return {}
        if command == 'stop_tracking':
            if self.recorder or self.finalizer:
                raise RuntimeError('Stop recording before stopping tracking')
            self.service.stop_tracking()
            self.tracking = False
            return {}
        if command == 'start_recording':
            if self.recorder or self.finalizer or not self.verified or not self.tracking:
                raise RuntimeError('Calibrated tracking required; a recording may already be finalizing')
            if self.service.last_gaze < self.service.tracking_started or time.monotonic() - self.service.last_gaze > .5:
                raise RuntimeError('Wait for live gaze samples before recording')
            directory = self.paths.directory(args.get('project_path'))
            if self.model == 'HH_ET10C':
                import mss
                from .sdk_policies import resolve_capture_monitor
                if self.screen:
                    self.screen.close()
                self.screen = mss.mss()
                display = args.get('capture_display') or self.service.config.get('capture_display')
                # A single physical monitor is unambiguous. With multiple displays
                # require participant-window geometry or an explicit configured target.
                self.monitor = resolve_capture_monitor(self.screen.monitors, display,
                    require_target=bool(args.get('split_screen')) or len(self.screen.monitors) > 2)
                if self.monitor is None:
                    raise ValueError('Experiment display must match a physical monitor')
                self.world = self.capture_screen()
            if not self.world or time.monotonic() - self.world.identity.received_monotonic_s > .5:
                raise RuntimeError('Live recording frame required')
            name = 'huahong_' + uuid.uuid4().hex[:12]
            self.recorder = PupilRecorder(directory, name, self.world, ffmpeg=self.ffmpeg, ffprobe=self.ffprobe,
                fps=args.get('video_sampling_rate_hz', 30), source_model=self.model, row_mapper=gaze_csv_row,
                stimulus=self.stimulus, source_info={'timestampSource': 'host_arrival',
                    'sourceClock': 'time.perf_counter', 'receiveClock': 'time.monotonic',
                    'model': self.model, 'versions': self.service.versions},
                metadata={'subjectName': args.get('subject_name', ''), 'deviceType': '桌面式' if self.model == 'HH_ET10C' else '眼镜式',
                          'calibrationVerified': True, 'calibrationProvider': self.model,
                          **({'calibrationQuality': copy.deepcopy(self.calibration_quality),
                              'calibrationLeftScore': _calibration_mean(self.calibration_quality, 'left'),
                              'calibrationRightScore': _calibration_mean(self.calibration_quality, 'right')}
                             if self.calibration_quality else {}),
                          'coordinateSpace': 'screen_normalized_top_left' if self.model == 'HH_ET10C' else 'world_normalized_top_left',
                          'timestampSource': 'host_arrival'})
            self.recording_info = {'recording_id': name, 'video_path': str(self.recorder.video_path),
                                   'csv_path': str(self.recorder.csv_path), 'source_model': self.model}
            self.last_result = {}
            self._recording_accepted = False
            try:
                self._prepare_recording()
            except Exception as exc:
                self.finish(str(exc))
                raise
            self._recording_accepted = True
            return self.recording_info
        if command in ('set_screen_size', 'set_smooth'):
            raise ValueError('Huahong physical parameters must be configured in huahong.json before connecting')
        raise ValueError(f'Unsupported Huahong command: {command}')

    def capture_screen(self):
        import numpy as np
        raw = self.screen.grab(self.monitor)
        pixels = np.asarray(raw)[:, :, :3].copy().tobytes()
        return VideoFrame(self.service.identity('screen'), 'scene', raw.width, raw.height, 'bgr', pixels, None)

    def _publish_samples(self, samples):
        for sample in samples:
            if isinstance(sample, VideoFrame) and sample.stream == 'scene':
                self.world = sample
            if isinstance(sample, VideoFrame) or self.tracking:
                with self._lock:
                    self._latest[sample.stream if isinstance(sample, VideoFrame) else 'gaze'] = sample

    def _capture_recording_screen(self, samples):
        if self.screen and time.monotonic() - self._screen_tick >= 1 / self.recorder.timeline.fps:
            samples.append(self.capture_screen())
            self._screen_tick = time.monotonic()

    def _recording_samples(self, samples):
        # ET28 infrared frames are live diagnostics, not additional recording
        # tracks. Do not charge preview bytes to the lossless scene/gaze queue.
        if self.model == 'HH_ET28':
            return [sample for sample in samples if not isinstance(sample, VideoFrame) or sample.stream == 'scene']
        return samples

    def _prepare_recording(self):
        # Recorder.start is bounded, but Windows encoder preparation can outlast
        # the SDK's raw-frame queue. Only this thread continues to touch the SDK.
        recorder, ready = self.recorder, Future()
        deadline = time.monotonic() + RECORDING_PREPARATION_TIMEOUT_S
        def prepare():
            try:
                recorder.start()
            except BaseException as exc:
                ready.set_exception(exc)
            else:
                ready.set_result(None)
        worker = threading.Thread(target=prepare, name='huahong-recorder-prepare')
        worker.start()
        pending, pending_bytes, failure = [], 0, None
        try:
            while not ready.done():
                if self._stop.is_set() and failure is None:
                    failure = RuntimeError('Service shutdown during recording preparation')
                if time.monotonic() >= deadline and failure is None:
                    failure = RuntimeError('Recording preparation timed out')
                    pending.clear()
                try:
                    with self._diagnostics.phase('service.read', timeout_s=2):
                        samples = self.service.read(1)
                except Exception as exc:
                    self._acquisition_error = exc
                    failure = failure or exc
                    samples = []
                if failure is None:
                    try:
                        self._capture_recording_screen(samples)
                    except Exception as exc:
                        failure = exc
                self._publish_samples(samples)
                if failure is None:
                    samples = self._recording_samples(samples)
                    size = sum(len(sample.pixels) for sample in samples if isinstance(sample, VideoFrame))
                    size += len(samples) * 512
                    size += sum(len(sample.pupils) * 512 for sample in samples if isinstance(sample, GazeSample))
                    if pending_bytes + size > RECORDING_PREPARATION_BYTE_LIMIT:
                        failure = RuntimeError('Recording preparation buffer byte limit exceeded')
                        pending.clear()
                    else:
                        pending.extend(samples)
                        pending_bytes += size
                # Even after a recording-only failure, drain acquisition until the
                # bounded start call exits, then hand cleanup to the finalizer.
                try:
                    ready.result(timeout=.005)
                except FutureTimeoutError:
                    pass
                except BaseException as exc:
                    failure = failure or exc
        finally:
            worker.join()
        # A failed encoder/dependency must retain its actual cause. Buffering
        # may have exceeded its budget while startup was still reporting that
        # failure; the secondary pre-roll error must not hide it.
        ready.result()
        if failure is not None:
            raise failure
        if time.monotonic() >= deadline:
            raise RuntimeError('Recording preparation timed out')
        if self._stop.is_set():
            raise RuntimeError('Service shutdown during recording preparation')
        if pending:
            recorder.submit(pending, ())

    def _run(self):
        self._diagnostics.start()
        try:
            self._run_owned()
        except BaseException:
            logging.exception('huahong.runtime failed model=%s', self.model)
            raise
        finally:
            self._diagnostics.close()

    def _run_owned(self):
        try:
            from ..infrastructure.pupil_recovery import recover_directory
            for directory in self.paths.recovery_directories():
                self.recovery_results.extend(recover_directory(directory, ffmpeg=self.ffmpeg,
                    ffprobe=self.ffprobe, source_model=self.model))
            while not self._stop.is_set():
                if self.finalizer and not self.completed.empty():
                    self.last_result = self.completed.get_nowait()
                    accepted = self.last_result.pop('_recording_accepted', False)
                    try:
                        video_size = Path(self.last_result['video_path']).stat().st_size if self.last_result.get('video_path') else 0
                    except OSError as exc:
                        video_size = 0
                        self.last_result.update(status='failed',
                            error=self.last_result.get('error') or f'Recording video is unavailable: {exc}')
                    self.last_result.update(error=0 if self.last_result.get('status') == 'complete' else -1,
                                            msg=self.last_result.get('error', '') or self.last_result.get('status', ''),
                                            elapsed_ms=round(self.last_result.get('durationSeconds', 0) * 1000),
                                            video_size=video_size)
                    self.finalizer.join()
                    self.finalizer = None
                    if self.screen:
                        self.screen.close()
                        self.screen = None
                    if accepted:
                        self.event({'type': 'notify_recording_finalized', **self.last_result})
                self._poll_calibration()
                try:
                    command, args, future = self.requests.get(timeout=.005)
                    if future.set_running_or_notify_cancel():
                        session = args.get('calibration_session', self.calibration_session)
                        try:
                            with self._diagnostics.phase('command:' + command,
                                                         timeout_s=10 if command == 'start' else 5):
                                result = self._command(command, args)
                            response = {'type': 'rsp_cmd', 'id': command, 'error': 0, 'msg': 'ok', **result}
                        except Exception as exc:
                            self.last_error = str(exc)
                            logging.warning('huahong.command failed model=%s command=%s error=%s',
                                            self.model, command, exc)
                            response = {'type': 'rsp_cmd', 'id': command, 'error': -1, 'msg': str(exc)}
                        if 'calibration' in command:
                            response['calibration_provider'] = self.model
                            response['calibration_session'] = (self.calibration_session
                                if command == 'start_calibration' and response['error'] == 0 else session)
                            if command == 'start_calibration_point':
                                response.setdefault('index', args.get('index'))
                                response.setdefault('attempt', args.get('attempt'))
                            response['_calibration_generation'] = self.calibration_generation
                        future.set_result(response)
                except queue.Empty:
                    pass
                if self.service.state == 'ready':
                    try:
                        if self._acquisition_error:
                            error, self._acquisition_error = self._acquisition_error, None
                            raise error
                        with self._diagnostics.phase('service.read', timeout_s=2):
                            samples = self.service.read(1)
                    except Exception as exc:
                        self.last_error = str(exc)
                        logging.exception('huahong.acquisition failed model=%s', self.model)
                        self.finish(str(exc))
                        self._cancel()
                        self.tracking = False
                        self.event({'type': 'notify_device_error', 'source': self.model, 'msg': str(exc)})
                        if self.calibration_task:
                            self.calibration_task.join(calibration_point_timeout_s(self.model))
                            if self.calibration_task.is_alive():
                                raise RuntimeError('Calibration stuck; isolated process must exit')
                        with self._diagnostics.phase('service.close', timeout_s=5):
                            self.service.close()
                        self.world = None
                        with self._lock:
                            self._latest.clear()
                        continue
                    # Encoder, disk and desktop capture failures belong to this
                    # recording. They do not imply that the SDK/camera failed.
                    try:
                        if self.recorder:
                            self._capture_recording_screen(samples)
                        with self._diagnostics.phase('publish_samples', timeout_s=2):
                            self._publish_samples(samples)
                        if self.recorder:
                            self.recorder.submit(self._recording_samples(samples), ())
                    except Exception as exc:
                        self.last_error = str(exc)
                        logging.exception('huahong.recording failed model=%s', self.model)
                        self.finish(str(exc))
        finally:
            self._stop.set()
            self._cancel()
            while not self.requests.empty():
                _, _, future = self.requests.get_nowait()
                if not future.done():
                    future.set_exception(RuntimeError('Service shut down'))
            self.finish('Service shutdown during recording')
            if self.calibration_task:
                self.calibration_task.join(calibration_point_timeout_s(self.model))
                if self.calibration_task.is_alive():
                    raise RuntimeError('Calibration did not exit; refusing native deinit')
            try:
                with self._diagnostics.phase('service.close', timeout_s=5):
                    self.service.close()
            except Exception as exc:
                self.last_error = str(exc)
            if self.finalizer:
                self.finalizer.join(20)
            if self.screen:
                self.screen.close()
