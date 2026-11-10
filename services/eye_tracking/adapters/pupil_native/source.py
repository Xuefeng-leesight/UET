"""In-process adapter contract backed by owned camera workers; no Remote API."""
from collections import deque
from dataclasses import asdict
import threading
import time
import uuid

from .config import NativeConfig
from .process import PipeWorker
from .camera import source_clock
from ..pupil_core.network import WireMessage


def message(payload, pixels=None):
    import msgpack
    parts = (payload['topic'].encode(), msgpack.packb(payload, use_bin_type=True))
    return WireMessage(payload['topic'], payload, parts if pixels is None else (*parts, pixels), time.monotonic())


class NativeSource:
    backend = 'native'
    fit_timeout_s = 120  # Includes first-load verification of frozen numerical libraries.

    def __init__(self, config=NativeConfig(), *, worker_factory=PipeWorker):
        self.config = config
        self.worker_factory = worker_factory
        self.version = 'mrt-pupil-native/1'
        self._owner = None
        self.workers = {}
        self.cameras = {}
        self.last_eye = {}
        self.camera_ready_at = {}
        self.fit_worker = None
        self.fit_id = ''
        self.mapper = None
        self.pupils = [deque(), deque()]
        self.last_gaze = None

    def _check_owner(self):
        if self._owner != threading.get_ident():
            raise RuntimeError('Native source must be used by its owning thread')

    def calibration_camera(self):
        """Use only the live calibrated mapper's camera for validation angles."""
        self._check_owner()
        return self.mapper.intrinsics if self.mapper is not None else None

    def open(self):
        if self._owner is not None:
            raise RuntimeError('Native source already open')
        self._owner = threading.get_ident()
        try:
            self.reset_events()
            task = {**asdict(self.config), 'intrinsics': self.config.intrinsics()}
            self.started = time.monotonic()
            for role in (0, 1, 2):
                self.workers[role] = self.worker_factory('camera', {**task, 'role': role}, capacity=8 if role == 2 else 128)
        except Exception:
            self.close()
            raise

    def source_time(self):
        self._check_owner()
        return source_clock()

    def enable_pupil_detection(self):
        self._check_owner()  # Detection already runs inside both owned eye workers.

    @property
    def ready(self):
        return set(self.cameras) == {0, 1, 2} and set(self.last_eye) == {0, 1}

    def cancel_fit(self):
        self.fit_id = ''
        if self.fit_worker is not None:
            self.fit_worker.close()
            self.fit_worker = None

    def invalidate_mapping(self):
        self.cancel_fit()
        self.mapper = None
        self.reset_events()
        self.last_gaze = None
        for data in self.pupils:
            data.clear()

    def reset_events(self):
        from .events import NativeEvents
        from .saccades import Saccades
        self.events = NativeEvents()
        self.saccades = Saccades()
        self.last_gaze_eyes = None

    def fit_card_calibration(self, refs, pupils):
        self._check_owner()
        if set(self.cameras) != {0, 1, 2}:
            raise ValueError('Three cameras must be ready before fitting')
        self.cancel_fit()
        self.fit_id = uuid.uuid4().hex
        self.fit_data = {'ref_list': refs, 'pupil_list': pupils}
        self.fit_worker = self.worker_factory('fit', {'request_id': self.fit_id, 'refs': refs, 'pupils': pupils,
                                                     'intrinsics': self.cameras[2]['intrinsics']})

    def _fit_results(self):
        if self.fit_worker is None:
            return []
        output = []
        for result in self.fit_worker.poll():
            if result['kind'] == 'error':
                return self._fit_failed(result['message'])
            if result.get('request_id') != self.fit_id or result['kind'] != 'fit':
                continue
            from .gazer import NativeGazer
            try:
                self.mapper = NativeGazer(self.cameras[2]['intrinsics'], result['params'])
            except Exception as exc:
                return self._fit_failed(f'Invalid calibration model: {exc}')
            stamp = self.source_time()
            for subject, extra in [('calibration.setup.v2', {'calib_data': self.fit_data}),
                                   ('calibration.successful', {}),
                                   ('calibration.result.v2', {'version': 2, 'params': result['params']})]:
                output.append(message({'topic': f'notify.{subject}', 'subject': subject, 'timestamp': stamp,
                                       'gazer_class_name': 'Gazer3D', 'native_source': True, **extra}))
            self.cancel_fit()
            break
        if self.fit_worker is not None and self.fit_worker.error:
            return self._fit_failed(self.fit_worker.error)
        return output

    def _fit_failed(self, reason):
        self.cancel_fit()
        return [message({'topic': 'notify.calibration.failed', 'subject': 'calibration.failed',
                         'timestamp': self.source_time(), 'gazer_class_name': 'Gazer3D', 'reason': reason})]

    def _gaze(self, pair):
        if self.mapper is None:
            return []
        gaze = self.mapper.predict(pair)
        if gaze is None:
            gaze = {'topic': 'gaze.3d.01.' if len(pair) == 2 else f"gaze.3d.{pair[0]['id']}.",
                    'timestamp': sum(p['timestamp'] for p in pair) / len(pair),
                    'confidence': min(p['confidence'] for p in pair), 'base_data': pair,
                    'native_source': True, 'world_resolution': self.cameras[2]['intrinsics']['resolution']}
        if self.last_gaze is not None and gaze['timestamp'] <= self.last_gaze:
            # Mixed asynchronous gaze topics can arrive out of source-time
            # order even when each eye camera clock is monotonic. Preserve the
            # measurement for the source-time-sorted recording, but do not feed
            # a late sample into the causal online event detectors.
            self.events.reset_fixation()
            self.saccades.reset_motion()
            self.last_gaze_eyes = None
            return [message({**gaze, 'source_order': 'late_source_time'})]
        gaze['source_order'] = 'in_order'
        eyes = tuple(sorted(p['id'] for p in gaze['base_data']))
        if self.last_gaze_eyes is not None and eyes != self.last_gaze_eyes:
            self.events.reset_fixation()
            self.saccades.reset_motion()
        self.last_gaze_eyes = eyes
        self.last_gaze = gaze['timestamp']
        return [message(gaze), *[message(e) for e in self.events.fixation(gaze)],
                *[message(e) for e in self.saccades.push(gaze)]]

    def _match(self):
        output = []
        a, b = self.pupils
        while a and b:
            delta = a[0]['timestamp'] - b[0]['timestamp']
            if abs(delta) <= .025:
                output.extend(self._gaze([a.popleft(), b.popleft()]))
            else:
                output.extend(self._gaze([(a if delta < 0 else b).popleft()]))
        now = source_clock()
        for data in self.pupils:
            while data and now - data[0]['timestamp'] > .05:
                output.extend(self._gaze([data.popleft()]))
        return output

    def receive(self, timeout_ms=100):
        self._check_owner()
        if type(timeout_ms) is not int or not 0 <= timeout_ms <= 1000:
            raise ValueError('Poll timeout must be 0..1000 ms')
        output = self._fit_results()
        deadline = time.monotonic() + timeout_ms / 1000
        while True:
            for role, worker in self.workers.items():
                for packet in worker.poll(32 if role != 2 else 1):
                    if packet['kind'] == 'error':
                        raise RuntimeError(f"Camera ID{role}: {packet['message']}")
                    if packet['kind'] == 'ready':
                        self.cameras[role] = packet
                        self.camera_ready_at[role] = time.monotonic()
                        continue
                    for item in packet.get('items', []):
                        data = item['payload']
                        output.append(message(data, item.get('pixels')))
                        if data['topic'].endswith('.3d'):
                            self.last_eye[role] = time.monotonic()
                            self.pupils[role].append(data)
                        elif data['topic'].endswith('.2d'):
                            output.extend(message(e) for e in self.events.pupil(data))
                if worker.error:
                    raise RuntimeError(worker.error)
            output.extend(self._match())
            now = time.monotonic()
            if now - self.started > self.config.startup_timeout_s and set(self.cameras) != {0, 1, 2}:
                raise TimeoutError('Native camera initialization timed out')
            if set(self.cameras) == {0, 1, 2}:
                for role in (0, 1):
                    if now - self.last_eye.get(role, self.camera_ready_at[role]) > 2:
                        raise TimeoutError(f'Native eye camera ID{role} interrupted')
            if output or now >= deadline:
                return output
            time.sleep(.001)

    def audit(self):
        from importlib.metadata import version
        return {'backend': 'native', 'cameraIntrinsicsArchived': True,
                'pupilDataSchemaVersion': 4,
                'standardExportContract': 'original 133 columns; pupil centre normalized by true eye-image dimensions; pupil axes divided by eye-image width; raw pixels remain internal',
                'cameras': self.cameras, 'algorithmRevision': '7a3cd9e8d2e54ac123ab0ed292d741732db899a2',
                'pupilDetector': f"pupil-detectors {version('pupil-detectors')}", 'eyeModel': f"pye3d {version('pye3d')}",
                'pairing': 'one-to-one <=25ms; unpaired monocular after 50ms',
                'gazeMappingPolicy': 'quality-approved contributors only; one good eye uses its calibrated monocular model and source timestamp; no averaging of monocular predictions',
                'gazeContinuityPolicy': 'source-eye changes or non-increasing source time reset motion/fixation candidates; late gaze is retained with source_order and excluded from causal online detection; recording sorts by original source time; source timestamps are never shifted',
                'fixationAlgorithm': 'MRT angular dispersion 1.5deg/100ms, sliding 300ms',
                'fixationAlgorithmVersion': '3',
                'fixationPositionPolicy': 'online windows retain window means; completed native intervals use each accepted sample once for full-interval position, direction and confidence means',
                'fixationCompletionPolicy': 'valid dispersion exit completes; invalidity, gaps, source changes and recording end remain incomplete; clipped intervals excluded from completed analyses',
                'saccadeAlgorithm': 'MRT I-VT 30deg/s, 8..100ms, >=2 intervals, gap<=50ms; incomplete events discarded',
                'blinkAlgorithm': 'Pupil confidence differential 200ms, threshold 0.5, per eye'}

    def close(self):
        if self._owner is None:
            return
        self._check_owner()
        self.cancel_fit()
        for worker in self.workers.values():
            worker.close()
        self.workers.clear()
        self.cameras.clear()
        self.last_eye.clear()
        self.camera_ready_at.clear()
        for data in self.pupils:
            data.clear()
        self.mapper = None
        self.last_gaze = None
        self._owner = None
