"""Windows-only acquisition; vendor pointers never leave callbacks.

Each model owns a fresh process. Host arrival is the explicit source clock;
ET10 currTimePts has no verified unit and is not treated as a synchronized clock.
"""
import ctypes as C
import logging
import math
import os
from pathlib import Path
import queue
import threading
import time

from ...domain.capabilities import DeviceCapabilities
from ...domain.contracts import EyeTrackingError
from ...domain.samples import GazeSample, SampleIdentity, VideoFrame
from .et28_eye_preview import ET28EyePreview
from .et28_samples import aiot_gaze_sample

MODELS = ('HH_ET10C', 'HH_ET28')
# ET28's bundled C++ Mark/SCEEN examples allow ten seconds for native sampling.
# Keep ET10's existing contract separate instead of shortening both to five.
NATIVE_CALIBRATION_TIMEOUT_S = {'HH_ET10C': 5, 'HH_ET28': 10}
# Product profile confirmed against the working vendor MARK demo. Crop type 1
# selects the SDK's center-crop calibration configuration, not a UI-only crop.
ET28_WORLD_PROFILE = (1920, 1080, 1)
ET28_SMOOTH_LEVEL = 12


def checked(code, operation):
    if code not in (0, None):
        raise EyeTrackingError(f'{operation}: vendor error {code}')


def valid_point(point):
    return all(math.isfinite(v) and 0 <= v <= 1 for v in point)


def _et28_quality_report(bias):
    # Native count is untrusted; the SDK allocates only 25 entries per array.
    count = int(bias.numOfCalibrate)
    limit = min(count, len(bias.Bias), len(bias.cablicStatus), len(bias.Score))
    points = []
    for index in range(limit):
        point = bias.Bias[index]
        values = [float(point.x), float(point.y)]
        points.append({'index': index + 1, 'status': int(bias.cablicStatus[index]),
                       'score': int(bias.Score[index]),
                       'bias': [value if math.isfinite(value) else None for value in values]})
    return {'count': count, 'points': points, 'truncated': count > limit}


def physical_screen(config):
    from .vendor.et10c_gaze._ctypes_defs import GazeTrackerScreenPhysicalInfo
    fields = ('angle_deg', 'distance_mm', 'width_mm', 'height_mm', 'bottom_mm')
    values = [config.get(k) for k in fields]
    if any(type(v) is not int for v in values):
        raise ValueError('ET10C requires measured screen: ' + ', '.join(fields))
    angle, distance, width, height, bottom = values
    if not (0 <= angle <= 180 and 0 <= distance <= 5000 and 1 <= width <= 5000
            and 1 <= height <= 5000 and 0 <= bottom <= 1000):
        raise ValueError('ET10C screen geometry out of range')
    return GazeTrackerScreenPhysicalInfo(*values)


class HuahongService:
    def __init__(self, model, sdk_root, config=None):
        if model not in MODELS:
            raise ValueError('Explicit Huahong model required')
        self.model, self.root, self.config = model, Path(sdk_root), config or {}
        self.state, self.generation, self.sequence = 'idle', 0, 0
        self.samples = queue.Queue(maxsize=512)
        self.failure = ''
        self.queued_bytes = 0
        self.byte_limit = 64 * 1024 * 1024
        self.last_gaze = 0.0
        self.tracking_started = 0.0
        self.tracker = None
        self._et28 = None
        self.worker = None
        self.tracking = False
        self.shape = None
        self.points = 0
        self._et28_feature = b''
        self.calibration_quality = None
        self._eye_preview = None
        self._lock = threading.Lock()
        self._last_frame = 0.0
        self.versions = {}

    @property
    def capabilities(self):
        return DeviceCapabilities(self.model, ('scene', 'left_eye', 'right_eye') if self.model == 'HH_ET28' else ('left_eye',),
                                  ('bgr',), True, False, ('points',), ())

    def identity(self, topic):
        with self._lock:
            self.sequence += 1
            # Python 3.12 on Windows uses coarse GetTickCount64 for monotonic;
            # distinct native callbacks can share its tick. Record actual host
            # arrival intervals with QPC/perf_counter, while freshness checks
            # keep their existing monotonic receive-clock domain.
            source_time = time.perf_counter()
            received = time.monotonic()
            return SampleIdentity(self.model, topic, self.generation, self.sequence, source_time, received)

    def push(self, sample):
        if self.state not in ('connecting', 'ready'):
            return
        size = len(sample.pixels) if isinstance(sample, VideoFrame) else 512
        if isinstance(sample, GazeSample):
            self.last_gaze = sample.identity.received_monotonic_s
        with self._lock:
            if self.queued_bytes + size > self.byte_limit:
                self.failure = 'Acquisition queue byte limit exceeded'
                return
            try:
                self.samples.put_nowait(sample)
                self.queued_bytes += size
            except queue.Full:
                self.failure = 'Acquisition queue overflow; recording cannot be lossless'

    def _take(self, timeout):
        sample = self.samples.get(timeout=timeout)
        with self._lock:
            self.queued_bytes -= len(sample.pixels) if isinstance(sample, VideoFrame) else 512
        return sample

    def gaze(self, points, identity=None):
        good = [(eye, p) for eye, p in points if valid_point(p)]
        position = tuple(sum(p[i] for _, p in good) / len(good) for i in (0, 1)) if good else None
        self.push(GazeSample(identity or self.identity('gaze'), position,
                             'world_normalized_top_left' if self.model == 'HH_ET28' else 'screen_normalized_top_left',
                             None, bool(good), tuple(eye for eye, _ in good)))

    def _et10_output(self, output):
        identity = self.identity('gaze')
        points = []
        for eye, flag, field in [('left', 'haveLeftScreenPoint', 'tLeftScreenPoint'),
                                  ('right', 'haveRightScreenPoint', 'tRightScreenPoint')]:
            if getattr(output, flag):
                p = getattr(output, field)
                points.append((eye, (float(p.f32X), float(p.f32Y))))
        if output.haveMergeScreenPoint:
            p = output.mergeScreenPoint
            merged = (float(p.f32X), float(p.f32Y))
            if valid_point(merged):
                self.push(GazeSample(identity, merged, 'screen_normalized_top_left', None, True,
                                     tuple(eye for eye, _ in points)))
                return
        self.gaze(points, identity)

    def _et10_camera(self, data, width, height):
        try:
            import numpy as np
            if not (0 < width <= 8192 and 0 < height <= 8192 and width * height * 3 <= 32 * 1024 * 1024):
                raise ValueError('Invalid ET10 frame dimensions')
            # Sample binding supplies grayscale bytes copied from the native callback.
            if len(data) != width * height:
                raise ValueError('Unexpected ET10 grayscale frame length')
            pixels = np.repeat(np.frombuffer(data, dtype=np.uint8).reshape(height, width, 1), 3, axis=2).tobytes()
            self._last_frame = time.monotonic()
            self.push(VideoFrame(self.identity('eye'), 'left_eye', width, height, 'bgr', pixels, None))
        except Exception as exc:
            self.failure = str(exc)

    def connect(self):
        if self.state == 'failed':
            raise EyeTrackingError('Native cleanup failed; restart the isolated acquisition process')
        if self.state == 'ready':
            return
        if os.name != 'nt' or C.sizeof(C.c_void_p) != 8:
            raise EyeTrackingError('Huahong requires Windows x64')
        self.generation += 1
        self.sequence, self.failure, self._last_frame = 0, '', 0.0
        self._et28_feature = b''
        self.calibration_quality = None
        if self._eye_preview:
            self._eye_preview.close()
            self._eye_preview = None
        while not self.samples.empty():
            self.samples.get_nowait()
        self.queued_bytes = 0
        self.last_gaze = 0.0
        self.state = 'connecting'
        try:
            if self.model == 'HH_ET10C':
                from .vendor.et10c_gaze import GazeTracker
                screen = physical_screen(self.config.get('screen', {}))
                dll = self.root / 'et10/bin/windows/x64'
                if not (dll / 'et10c_interface.dll').is_file():
                    raise EyeTrackingError('Missing ET10C runtime DLL')
                self.tracker = GazeTracker(dll_dir=str(dll), screen_info=screen, log_file=None,
                                           res_type=self.config.get('res_type'), device=self.config.get('device_index'))
                self.versions = {'sdk': self.tracker.sdk_version, 'algorithm': self.tracker.alg_version,
                                 'device': self.tracker.device_version}
                self.tracker.set_output_callback(self._et10_output)
                self.tracker.set_camera_callback(self._et10_camera)
                self.tracker.set_device_status_callback(on_connect=lambda _: None, on_disconnect=lambda _: setattr(self, 'failure', 'Device disconnected'))
                self.tracker.start_camera()
                self.tracker.start_eye_detect()
            else:
                self._connect_et28()
            deadline = time.monotonic() + 5
            while not self._last_frame and not self.failure and time.monotonic() < deadline:
                time.sleep(.01)
            if self.failure or not self._last_frame:
                raise EyeTrackingError(self.failure or 'No live camera frame within 5 seconds')
            self.state = 'ready'
        except BaseException:
            self.close()
            raise

    def _connect_et28(self):
        from .aiot_et28 import AiotET28

        native = AiotET28(self.root / 'et28-aiot/bin/windows/x64')
        self._et28 = native

        def active():
            return self._et28 is native and self.state in ('connecting', 'ready')

        def disconnected(_):
            if active():
                self.failure = 'Device disconnected'

        native.open(disconnected)
        self.versions = native.versions()
        legacy = {key: self.config[key] for key in ('world_width', 'crop_type') if key in self.config}
        if legacy:
            logging.info('huahong.et28 fixed_camera_profile=%s ignored_legacy_camera_config=%s',
                         ET28_WORLD_PROFILE, legacy)
        match = native.configure_camera(ET28_WORLD_PROFILE)
        width, height = match.m_worldWidth, match.m_worldHeight
        self.shape = (width, height)
        preview = ET28EyePreview(match.m_irOneEyeWidth, match.m_irOneEyeHeight, self.identity)
        self._eye_preview = preview

        def camera(_, pointer, length):
            try:
                if not active():
                    return
                identity = self.identity('scene')
                if not pointer or length != width * height * 3:
                    raise ValueError('Invalid ET28 BGR frame length')
                pixels = C.string_at(pointer, length)
                if active():
                    self._last_frame = time.monotonic()
                    self.push(VideoFrame(identity, 'scene', width, height, 'bgr', pixels, None))
            except Exception as exc:
                if active():
                    self.failure = str(exc)

        def output(_, pointer):
            try:
                if not active():
                    return
                if not pointer:
                    raise ValueError('Null tracking pointer')
                identity = self.identity('gaze')
                sample = aiot_gaze_sample(pointer.contents, identity, (width, height), (preview.width, preview.height))
                if active():
                    self.push(sample)
            except Exception as exc:
                if active():
                    self.failure = str(exc)

        native.start_camera(camera,
                            lambda _, ptr, size: preview.accept('left_eye', ptr, size),
                            lambda _, ptr, size: preview.accept('right_eye', ptr, size), output)

    def read(self, timeout_ms=100):
        if self.tracker and self.tracker.worker_error:
            self.failure = self.tracker.worker_error
        if self.failure:
            self.calibration_quality = None
            raise EyeTrackingError(self.failure)
        if self.state != 'ready':
            return []
        if time.monotonic() - self._last_frame > 3:
            self.calibration_quality = None
            raise EyeTrackingError('Camera stopped delivering frames')
        if self.tracking and time.monotonic() - max(self.last_gaze, self.tracking_started) > 3:
            self.calibration_quality = None
            raise EyeTrackingError('Tracker stopped delivering gaze samples')
        result = self._eye_preview.take() if self._eye_preview else []
        try:
            result.append(self._take(0 if result else max(0, timeout_ms) / 1000))
        except queue.Empty:
            # An eye callback may arrive while waiting for the scene/gaze queue.
            return result or (self._eye_preview.take() if self._eye_preview else [])
        while len(result) < 128:
            try:
                result.append(self._take(0))
            except queue.Empty:
                break
        return result

    def start_calibration(self, points):
        if type(points) is not int or points not in (1, 3, 5, 9) or (self.model == 'HH_ET10C' and points == 1):
            raise ValueError('Unsupported calibration point count')
        self._et28_feature = b''
        self.calibration_quality = None
        self.stop_tracking()
        if self.tracker:
            # reConfig takes both the total point count and this round's count.
            # The binding retains the total for partial retries; this entry point
            # always starts a whole calibration, including changes from 5 to 3/9.
            previous_points = self.tracker.calib_points
            self.tracker.calib_points = points
            try:
                self.tracker.reconfigure(to_calib_points=points)
            except Exception:
                self.tracker.calib_points = previous_points
                raise
        else:
            self._et28.start_calibration(points)
            self.versions = self._et28.versions(include_algorithm=True)
            logging.info('huahong.et28 calibration_initialized points=%s eye_mode=TWOEYE versions=%s',
                         points, self.versions)
        self.points = points

    def restore_calibration(self, feature, points):
        """Reuse a feature saved from an earlier calibration (vendor demo: load cablic.dat)."""
        if type(points) is not int or points not in (1, 3, 5, 9):
            raise ValueError('Unsupported calibration point count')
        if not feature:
            raise ValueError('Empty calibration feature')
        self.stop_tracking()
        self.calibration_quality = None
        if self.tracker:
            self.tracker.load_calibration_feature(feature)
        else:
            # start_tracking initialises the tracker and loads these bytes.
            self._et28_feature = bytes(feature)
        self.points = points

    def calibration_point(self, x, y):
        if not valid_point((x, y)):
            raise ValueError('Calibration point must be normalized 0..1')
        timeout = NATIVE_CALIBRATION_TIMEOUT_S[self.model]
        if self.tracker:
            checked(self.tracker.perform_one_point_calibration((x, y), timeout=timeout), 'calibration_point')
        else:
            self._et28.calibration_point(x, y, timeout)

    def cancel_calibration(self):
        self._et28_feature = b''
        self.calibration_quality = None
        if self.tracker:
            self.tracker.calibration_stop()
        elif self._et28:
            self._et28.stop_calibration()

    def feature(self):
        self.calibration_quality = None
        if self.tracker:
            if not self.tracker.check_calibration_finished():
                raise EyeTrackingError('Vendor calibration is incomplete')
            bias = self.tracker.get_calibration_bias()
            if int(bias.numOfCalibrate) != self.points or any(int(bias.cablicStatus[i]) not in (0, 1) for i in range(self.points)):
                raise EyeTrackingError('ET10C calibration quality failed')
            return self.tracker.get_calibration_feature()
        self._et28_feature = b''
        try:
            left, right = self._et28.calibration_bias()
        except (EyeTrackingError, OSError) as exc:
            logging.warning('huahong.calibration quality unavailable: %s', exc)
            reports = None
        else:
            reports = {'left': _et28_quality_report(left), 'right': _et28_quality_report(right)}
            logging.info('huahong.calibration quality model=%s expected_count=%s left=%s right=%s',
                         self.model, self.points, reports['left'], reports['right'])
            for eye, report in reports.items():
                for point in report['points'][:self.points]:
                    logging.info('huahong.calibration point_quality eye=%s index=%s status=%s score=%s bias_px=%s',
                                 eye, point['index'], point['status'], point['score'], point['bias'])
            if any(report['count'] != self.points or report['truncated'] for report in reports.values()):
                logging.warning('huahong.calibration quality report incomplete expected_count=%s', self.points)
                reports = None
        self._et28_feature = self._et28.feature()
        # Score is the SDK's unsigned per-point value (observed values exceed
        # 100). The mean is our display aggregation, not a vendor whole-round
        # score. Keep every native point; non-finite biases are reported as null.
        if reports:
            self.calibration_quality = {'version': 1, 'provider': 'HH_ET28',
                                        'aggregation': 'arithmetic_mean', **reports}
        return self._et28_feature

    def start_tracking(self):
        if self.tracking:
            return
        if self.tracker:
            self.tracker.start_tracker()
        else:
            if not self._et28_feature:
                raise EyeTrackingError('ET28 tracking requires a validated feature from this calibration')
            # Use the explicit feature-loading path shared by both vendor demos.
            # Reload this round's validated bytes after initialization instead of
            # relying on undocumented retention of the native calibration state.
            try:
                self._et28.init_tracker(self.points)
                self._et28.load_feature(self._et28_feature)
            except Exception:
                self.calibration_quality = None
                raise
            logging.info('huahong.et28 tracking_start smooth_level=%s', ET28_SMOOTH_LEVEL)
            native = self._et28

            def run():
                try:
                    native.start_tracking(ET28_SMOOTH_LEVEL)
                except Exception as exc:
                    self.calibration_quality = None
                    self.failure = str(exc)
            self.worker = threading.Thread(target=run, name='huahong-tracker', daemon=True)
            self.tracking_started = time.monotonic()
            self.worker.start()
        if self.tracker:
            self.tracking_started = time.monotonic()
        self.tracking = True
        if self._et28:
            self._wait_for_et28_tracking()

    def _wait_for_et28_tracking(self):
        deadline = time.monotonic() + 3
        while not self.failure and self.worker.is_alive() and time.monotonic() < deadline:
            if self.last_gaze > self.tracking_started:
                return
            try:
                # This command owns the reader. Drain pre-recording frames
                # while waiting so a slow startup cannot fill the scene queue.
                self._take(.02)
            except queue.Empty:
                pass
        self.calibration_quality = None
        self._et28_feature = b''
        self.stop_tracking()
        raise EyeTrackingError(self.failure or 'ET28 tracker did not start delivering gaze samples')

    def stop_tracking(self):
        if not self.tracking:
            return
        if self.tracker:
            checked(self.tracker.stop_tracker(), 'stopTracker')
        elif self._et28 and self.worker and self.worker.is_alive():
            self._et28.stop_tracking()
        if self.worker:
            self.worker.join(5)
            if self.worker.is_alive():
                raise EyeTrackingError('Tracker did not stop; process restart required')
            self.worker = None
        self.tracking = False

    def close(self):
        self.state = 'closing'
        self._et28_feature = b''
        self.calibration_quality = None
        if self._eye_preview:
            self._eye_preview.close()
        try:
            self.stop_tracking()
            if self.tracker:
                self.tracker.close()
                self.tracker = None
            if self._et28:
                self._et28.close()
                self._et28 = None
        except BaseException:
            self.state = 'failed'
            raise
        else:
            self.state = 'idle'
