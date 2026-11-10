"""Direct backend tests: real upstream numerics plus deterministic resource boundaries."""
from contextlib import redirect_stdout
from dataclasses import replace, asdict
import io
import json
import math
import threading
import time
import unittest
from unittest.mock import patch

import numpy as np

from services.eye_tracking.adapters.pupil_native.camera import FrameClock, Intrinsics, intrinsics_for, select_devices, source_clock
from services.eye_tracking.adapters.pupil_native.config import NativeConfig
from services.eye_tracking.adapters.pupil_native.source import NativeSource, message
from services.eye_tracking.adapters.pupil_native.process import PipeWorker
from services.eye_tracking.adapters.pupil_core.calibration import PupilCalibration
from services.eye_tracking.adapters.pupil_core.data_normalizer import DataNormalizer
from services.eye_tracking.infrastructure.pupil_csv import NativeCsvMapper, gaze_csv_row
from services.eye_tracking.infrastructure.pupil_events import event_rows


def observations():
    spec = intrinsics_for('Pupil Cam1 ID2', (1280, 720))
    camera, refs, pupils = Intrinsics(spec), [], []
    for index, (x, y) in enumerate(( (x, y) for x in (.2, .5, .8) for y in (.2, .5, .8))):
        for repeat in range(3):
            stamp = 1 + index + repeat * .01
            pixel = [x * 1280, y * 720]
            target = camera.unprojectPoints([pixel], normalize=True)[0] * 500
            refs.append(dict(timestamp=stamp, screen_pos=pixel, norm_pos=[x, 1-y]))
            for eye, origin in enumerate(([20, 15, -20], [-40, 15, -20])):
                normal = target - np.array(origin)
                normal /= np.linalg.norm(normal)
                pupils.append(dict(id=eye, timestamp=stamp, topic=f'pupil.{eye}.3d',
                    sphere=dict(center=[0, 0, 35]), circle_3d=dict(normal=normal.tolist(), center=[0, 0, 23]),
                    confidence=1., model_confidence=1., diameter=40., diameter_3d=4., eye_resolution=[192, 192],
                    ellipse_2d={'center': [91., 82.], 'axes': [30., 40.]}))
    return spec, refs, pupils


class FakeWorker:
    def __init__(self, kind, task, **_):
        self.kind, self.task = kind, task
        self.items = []
        self.closed = False
        self.error = ''

    def poll(self, limit=64):
        values, self.items = self.items[:limit], self.items[limit:]
        return values

    def close(self):
        self.closed = True


class NativeTests(unittest.TestCase):
    def test_camera_identity_and_intrinsics_fail_closed(self):
        devices = [{'name': f'Pupil Cam3 ID{i}', 'uid': str(i)} for i in range(3)]
        self.assertEqual(select_devices(devices)[0]['uid'], '0')
        for values in (devices[:2], devices + [devices[0]]):
            with self.assertRaises(ValueError):
                select_devices(values)
        with self.assertRaises(ValueError):
            select_devices(devices, ('0', '0', '2'))
        with self.assertRaises(ValueError):
            intrinsics_for('Unknown', (640, 480))
        for name, resolution in [('Pupil Cam1 ID2', (1280, 720)), ('Pupil Cam1 ID2', (1920, 1080)),
                                 ('Pupil Cam3 ID0', (192, 192))]:
            camera = Intrinsics(intrinsics_for(name, resolution))
            pixels = np.asarray([[resolution[0] * .4, resolution[1] * .6]])
            reprojection = camera.projectPoints(camera.unprojectPoints(pixels) * 500).reshape(-1, 2)
            np.testing.assert_allclose(pixels, reprojection, atol=.05)

    def test_clock_rejects_regression_and_stale_samples(self):
        clock = FrameClock(100)
        self.assertEqual(clock.timestamp(1, 101), 101)
        for source, received in ((1, 101.1), (2, 104), (math.nan, 105)):
            with self.assertRaises(ValueError):
                clock.timestamp(source, received)
        self.assertAlmostEqual(FrameClock(0, software=True, latency=-.015).timestamp(1, 200), 199.985)

    def test_windows_high_rate_clock_and_pairing_share_perf_counter_epoch(self):
        with patch('services.eye_tracking.adapters.pupil_native.camera.sys.platform', 'win32'), \
             patch('time.monotonic', return_value=100), \
             patch('time.perf_counter', side_effect=[500.001, 500.009, 500.017, 500.020]):
            clock = FrameClock(0, software=True, latency=-.015)
            stamps = [clock.timestamp(0, source_clock()) for _ in range(3)]
            self.assertTrue(all(b > a for a, b in zip(stamps, stamps[1:])))
            source = NativeSource(worker_factory=FakeWorker)
            source.open()
            try:
                self.assertEqual(source.source_time(), 500.020)
                source.pupils[0].append({'timestamp': 499.9})
                with patch('services.eye_tracking.adapters.pupil_native.source.source_clock', return_value=500.02), \
                     patch.object(source, '_gaze', return_value=[]) as gaze:
                    source._match()
                    gaze.assert_called_once()
            finally:
                source.close()
        for value in (stamps[-1] + .015, 499, math.nan, math.inf):
            with self.assertRaises(ValueError):
                clock.timestamp(0, value)

    def test_real_3d_fit_roundtrip_and_export_geometry(self):
        from services.eye_tracking.adapters.pupil_native.gazer import NativeGazer
        spec, refs, pupils = observations()
        model = NativeGazer(spec)
        with redirect_stdout(io.StringIO()):
            params = model.fit(refs, pupils)
        self.assertLess(params['training_mean_error_normalized'], .001)
        self.assertEqual(params['monocular_depth_policy'], 'independent_model_fitted_depth')
        self.assertFalse(params['training_reprojection']['independent_validation'])
        self.assertFalse(params['training_angular']['independentValidationPerformed'])
        for metric in params['training_angular']['metrics'].values():
            self.assertIsNotNone(metric['meanErrorDeg'])
            self.assertLess(metric['meanErrorDeg'], .1)
            self.assertGreaterEqual(metric['qualityScore'], 9.8)
            self.assertEqual(metric['scoringPolicy'], 'mrt_angular_linear_v1')
        gazer = NativeGazer(spec, params)
        # A binocular depth from a different coordinate scale must not alter
        # the independently fitted monocular model or fallback projection.
        gazer.binocular.last_gaze_distance = 160
        before = gazer.predict([pupils[0]])
        gazer.binocular.last_gaze_distance = 900
        after = gazer.predict([pupils[0]])
        np.testing.assert_allclose(before['norm_pos'], after['norm_pos'])
        datum = gazer.predict(pupils[:2])
        sample = DataNormalizer().normalize(message(datum), 1, 1)
        from services.eye_tracking.transport.pupil_protocol import gaze_message
        live = json.loads(gaze_message(sample))['eye_data']
        self.assertEqual(live['l_pupil']['center'], {'x': 91., 'y': 82.})
        self.assertAlmostEqual(live['l_gaze']['gaze']['x'], sample.monocular['left']['position'][0])
        self.assertAlmostEqual(live['r_gaze']['gaze']['y'], 1 - sample.monocular['right']['position'][1])
        invalid = json.loads(gaze_message(replace(sample, valid=False)))['eye_data']
        self.assertIsNone(invalid['re_gaze']['gaze'])
        self.assertEqual(invalid['l_gaze'], live['l_gaze'])
        self.assertEqual(invalid['r_gaze'], live['r_gaze'])
        row = gaze_csv_row(sample, .9)
        self.assertAlmostEqual(row['left_pupil_center_x'], 91 / 192)
        self.assertEqual(row['left_pupil_minor_axis'], 30 / 192)
        self.assertEqual(row['left_pupil_distance'], '')
        self.assertGreater(row['recom_gaze_point_z'], 400)
        self.assertAlmostEqual(row['recom_gaze_y'], .2, delta=.001)
        self.assertNotEqual(row['left_gaze_x'], row['right_gaze_x'])
        self.assertEqual(row['recom_smooth_point_x'], '')
        self.assertEqual(row['geometry_space'], 'world_camera_mm')
        for eye in ('left', 'right'):
            ray = np.array([row[f'{eye}_gaze_point_{a}'] - row[f'{eye}_origin_{a}'] for a in 'xyz'])
            np.testing.assert_allclose(ray / np.linalg.norm(ray), [row[f'{eye}_direction_{a}'] for a in 'xyz'], atol=1e-6)
        json.dumps(asdict(sample), allow_nan=False)
        mapper = NativeCsvMapper()
        first = mapper(sample, .9)
        self.assertEqual(first['gaze_velocity_px_ms'], '')
        second = replace(sample, identity=replace(sample.identity, source_time_s=1.01), position=(.21, .8))
        self.assertGreater(mapper(second, .9)['gaze_velocity_px_ms'], 0)
        mapper(replace(second, valid=False), .9)
        self.assertEqual(mapper(replace(second, identity=replace(sample.identity, source_time_s=1.02)), .9)['gaze_velocity_px_ms'], '')
        bad = [dict(p, model_confidence=.1) for p in pupils[:2]]
        self.assertIsNone(model.predict(bad))
        for normal in ([0, 0, 0], [math.nan, 0, 1], [1, 0]):
            bad = [dict(p, circle_3d=dict(p['circle_3d'], normal=normal)) for p in pupils[:2]]
            self.assertIsNone(model.predict(bad))

    def test_cancel_timeout_and_late_fit_do_not_authorize(self):
        source = NativeSource(worker_factory=FakeWorker)
        source.open()
        try:
            source.cameras = {i: {'intrinsics': observations()[0]} for i in range(3)}
            calibration = PupilCalibration(source)
            source.fit_card_calibration([], [])
            old = source.fit_worker
            calibration.cancel()
            self.assertTrue(old.closed)
            old.items.append({'kind': 'fit', 'request_id': source.fit_id, 'params': {}})
            self.assertEqual(source._fit_results(), [])
            self.assertIsNone(source.mapper)
            source.fit_card_calibration([], [])
            old = source.fit_worker
            calibration.pending = True
            calibration.finishing = True
            calibration.deadline = time.monotonic() - 1
            result = calibration.tick()
            self.assertEqual(result['error'], -1)
            self.assertTrue(old.closed)
            self.assertFalse(calibration.verified)
        finally:
            source.close()

    def test_failed_fit_keeps_camera_workers(self):
        source = NativeSource(worker_factory=FakeWorker)
        source.open()
        try:
            source.cameras = {2: {'intrinsics': observations()[0]}, 0: {}, 1: {}}
            source.fit_card_calibration([], [])
            source.fit_worker.items.append({'kind': 'error', 'message': 'bad fit'})
            result = source._fit_results()
            self.assertEqual(result[0].payload['subject'], 'calibration.failed')
            self.assertFalse(any(w.closed for w in source.workers.values()))
        finally:
            workers = list(source.workers.values())
            source.close()
            self.assertTrue(all(w.closed for w in workers))

    def test_real_fit_worker_pipe_and_cancellation(self):
        spec, refs, pupils = observations()
        worker = PipeWorker('fit', {'request_id': 'test', 'refs': refs, 'pupils': pupils, 'intrinsics': spec})
        try:
            results = []
            deadline = time.monotonic() + 15
            while not results and not worker.error and time.monotonic() < deadline:
                results.extend(worker.poll())
                time.sleep(.01)
            self.assertFalse(worker.error, worker.error)
            self.assertTrue(results)
            self.assertEqual(results[0]['kind'], 'fit', results)
        finally:
            worker.close()
        self.assertIsNotNone(worker.process.poll())

    def test_eye_blink_phases_cannot_cross_pair(self):
        data = []
        for stamp, eye, phase in [(1., 0, 'onset'), (1.1, 1, 'offset'), (1.2, 0, 'offset')]:
            event = DataNormalizer().normalize(message({'topic': 'blinks', 'timestamp': stamp, 'eye_id': eye,
                                                       'type': phase, 'confidence': .9}), 1, 1)
            data.append(json.dumps(asdict(event)) + '\n')
        rows, report = event_rows(data, .5, 2)
        self.assertEqual(report['blinkOnsets'], 1)
        onset = next(row for row in rows if row['blink_phase'] == 'onset')
        self.assertEqual(onset['blink_marker'], 2)
        self.assertAlmostEqual(onset['blink_duration_ms'], 200)

    def test_no_capture_api_or_camera_open_for_status(self):
        from services.eye_tracking.adapters.pupil_core.network import NetworkConfig
        from services.eye_tracking.application.pupil_runtime import PupilRuntime
        source = NativeSource(worker_factory=FakeWorker)
        runtime = PupilRuntime(NetworkConfig(), source=source)
        with patch('services.eye_tracking.application.pupil_runtime.PupilNetwork', side_effect=AssertionError('Capture API forbidden')):
            result = runtime._command('get_device_status', {})
        self.assertEqual(result['backend'], 'native')
        self.assertFalse(result['acquisition_ready'])
        self.assertEqual(source.workers, {})
