import ctypes as C
from dataclasses import replace
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from services.eye_tracking.adapters.huahong.service import (
    HuahongService, NATIVE_CALIBRATION_TIMEOUT_S, physical_screen, checked,
)
from services.eye_tracking.adapters.huahong.data_normalizer import gaze_csv_row, gaze_message
from services.eye_tracking.adapters.huahong.vendor.et10c_gaze._ctypes_defs import GazeTrackerOutput, GazeTrackerCalibBias
from services.eye_tracking.application.huahong_runtime import HuahongRuntime
from services.eye_tracking.domain.samples import GazeSample, SampleIdentity, VideoFrame
from services.eye_tracking.infrastructure.recording_paths import RecordingPaths
from services.eye_tracking.infrastructure.pupil_recorder import PupilRecorder


class AdapterTests(unittest.TestCase):
    def service(self, model='HH_ET10C'):
        service = HuahongService(model, '/missing')
        service.state = 'ready'
        service._last_frame = time.monotonic()
        return service

    def et28_with_feature(self):
        from services.eye_tracking.adapters.huahong.vendor import et28_dll as b
        service = self.service('HH_ET28')
        service.points, service.lib = 3, Mock()
        payload = b'validated-native-feature'
        def bias(left, right):
            for eye, pointer in enumerate((left, right)):
                value = C.cast(pointer, C.POINTER(b.et28_GazeTrackerCalibBias)).contents
                value.numOfCalibrate = 3
                for index, score in enumerate(((100, 97, 101), (99, 99, 100))[eye]):
                    value.Score[index] = score
                    value.Bias[index].x, value.Bias[index].y = .125, -.25
                value.cablicStatus[1] = 1 if eye == 0 else 0
            C.cast(left, C.POINTER(b.et28_GazeTrackerCalibBias)).contents.Bias[0].x = float('nan')
            return 0
        def length(pointer):
            C.cast(pointer, C.POINTER(C.c_uint32))[0] = len(payload)
        def save(data, written):
            self.assertIsNone(service.calibration_quality, 'Quality published before feature export succeeds')
            data[:len(payload)] = payload
            length(written)
            return 0
        service.lib.et28_getCalibBias.side_effect = bias
        service.lib.et28_getFeatureLen.side_effect = length
        service.lib.et28_SaveCalibrationDataBin.side_effect = save
        self.assertEqual(service.feature(), payload)
        return service, payload

    def test_no_native_load_on_import_or_non_windows_connect(self):
        service = HuahongService('HH_ET28', '/missing')
        with patch('services.eye_tracking.adapters.huahong.service.os.name', 'posix'):
            with self.assertRaisesRegex(RuntimeError, 'Windows x64'):
                service.connect()
        self.assertIsNone(service.lib)

    def test_explicit_model_and_measured_screen_required(self):
        with self.assertRaises(ValueError):
            HuahongService('Pro', '.')
        for screen in ({}, {'angle_deg': True}, dict(angle_deg=0, distance_mm=0, width_mm=-1, height_mm=1, bottom_mm=0)):
            with self.assertRaises(ValueError):
                physical_screen(screen)
        self.assertEqual(physical_screen(dict(angle_deg=20, distance_mm=50, width_mm=500, height_mm=300, bottom_mm=10)).nScreenWidthMM, 500)
        with self.assertRaisesRegex(RuntimeError, '-8'):
            checked(-8, 'point')

    def test_et10_fused_and_single_eye_missing_nonfinite_corner(self):
        service = self.service()
        output = GazeTrackerOutput()
        output.haveLeftScreenPoint = 1
        output.tLeftScreenPoint.f32X, output.tLeftScreenPoint.f32Y = .25, .5
        service._et10_output(output)
        self.assertEqual(service.read(0)[0].position, (.25, .5))
        output.haveMergeScreenPoint = 1
        output.mergeScreenPoint.f32X, output.mergeScreenPoint.f32Y = 0, 0
        service._et10_output(output)
        self.assertEqual(service.read(0)[0].position, (0, 0))
        output.haveLeftScreenPoint = 0
        output.mergeScreenPoint.f32X = float('nan')
        service._et10_output(output)
        sample = service.read(0)[0]
        self.assertFalse(sample.valid)
        self.assertIsNone(sample.position)

    def test_bounded_overflow_and_stale_stream_fail_explicitly(self):
        service = self.service()
        for _ in range(513):
            service.gaze([])
        with self.assertRaisesRegex(RuntimeError, 'overflow'):
            service.read(0)
        service = self.service()
        service._last_frame -= 4
        with self.assertRaisesRegex(RuntimeError, 'stopped'):
            service.read(0)

    def test_top_left_csv_and_preview_agree_and_source_never_pupil(self):
        for model, space in [('HH_ET28', 'world_normalized_top_left'), ('HH_ET10C', 'screen_normalized_top_left')]:
            identity = SampleIdentity(model, 'gaze', 2, 3, 10, 10)
            sample = GazeSample(identity, (0, .75), space, None, True, ('left',))
            row = gaze_csv_row(sample, 9)
            self.assertEqual((row['recom_gaze_x'], row['recom_gaze_y']), (0, .75))
            self.assertEqual(row['source_model'], model)
            self.assertEqual(row['timestamp'], 1000)
            self.assertEqual(json.loads(gaze_message(sample))['eye_data']['re_gaze']['gaze'], {'x': 0, 'y': .75})
            missing = replace(sample, position=None, valid=False)
            self.assertEqual(gaze_csv_row(missing, 9)['recom_gaze_x'], '')
            self.assertIsNone(json.loads(gaze_message(missing))['eye_data']['re_gaze']['gaze'])

    def test_project_boundary_never_accepts_other_vendor(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'project.json').write_text(json.dumps({'deviceModel': 'PupilCore'}))
            with self.assertRaises(ValueError):
                RecordingPaths([root], 'HH_ET28').directory(str(root))
            (root / 'project.json').write_text(json.dumps({'deviceModel': 'HH_ET28'}))
            self.assertEqual(RecordingPaths([root], 'HH_ET28').directory(str(root)), root.resolve() / 'recordings')
            with self.assertRaises(ValueError):
                RecordingPaths([root]).directory(str(root))

    def test_calibration_stale_tokens_and_incomplete_points_rejected(self):
        runtime = HuahongRuntime('HH_ET28', '.')
        runtime.service = Mock(state='ready', generation=1, config={})
        calibrated, _ = self.et28_with_feature()
        def feature():
            runtime.service.calibration_quality = calibrated.calibration_quality
            return b'feature'
        runtime.service.feature.side_effect = feature
        runtime._command('start_calibration', {'points': 3})
        with self.assertRaises(RuntimeError):
            runtime._command('complete_calibration', {})
        runtime.calibration_points = {1: True, 2: True, 3: True}
        token = runtime._command('complete_calibration', {})['coe']
        with self.assertRaises(ValueError):
            runtime._command('start_tracking', {'coe': 'foreign'})
        runtime._command('start_tracking', {'coe': token})
        runtime._command('cancel_calibration', {})
        with self.assertRaises(ValueError):
            runtime._command('start_tracking', {'coe': token})
        with self.assertRaises(ValueError):
            runtime._command('start', {'sdk_model': 'Pro'})

    def test_native_point_failure_not_marked_complete(self):
        runtime = HuahongRuntime('HH_ET28', '.')
        runtime.service = Mock(state='ready', generation=1, config={})
        runtime.service.calibration_point.side_effect = RuntimeError('vendor error -8')
        runtime._command('start_calibration', {'points': 3})
        result = runtime._command('start_calibration_point', {'index': 1, 'x': .5, 'y': .5, 'attempt': 1})
        self.assertTrue(result['point_pending'])
        runtime.calibration_task.join(1)
        generation, index, attempt, error, message = runtime.point_result.get(timeout=1)
        self.assertEqual(error, -1)
        self.assertIn('-8', message)
        runtime.calibration_task = None
        self.assertEqual(runtime.calibration_points, {})

    def test_et10_full_calibration_reconfigures_native_total_and_round_counts(self):
        from services.eye_tracking.adapters.huahong.vendor.et10c_gaze.tracker import GazeTracker
        from services.eye_tracking.adapters.huahong.vendor.et10c_gaze._progress import CalibrationProgress
        service = self.service()
        tracker = GazeTracker.__new__(GazeTracker)
        tracker._closed, tracker.handle = True, 123
        tracker.calib_points, tracker.eye_type = 5, 0
        tracker.screen_info = physical_screen(dict(angle_deg=20, distance_mm=50, width_mm=500, height_mm=300, bottom_mm=10))
        tracker.progress, tracker._lib = CalibrationProgress(), Mock()
        tracker._lib.ET10C_reConfig.return_value = 0
        service.tracker = tracker
        for points in (3, 9, 5):
            with self.subTest(points=points):
                service.start_calibration(points)
                tracker._lib.ET10C_reConfig.assert_called_with(123, 0, points, points, tracker.screen_info)
                self.assertEqual((service.points, tracker.calib_points), (points, points))
        tracker._lib.ET10C_reConfig.return_value = -6
        with self.assertRaises(RuntimeError):
            service.start_calibration(9)
        self.assertEqual((service.points, tracker.calib_points), (5, 5))

    def test_native_calibration_counts_coordinates_and_timeout_errors(self):
        from services.eye_tracking.adapters.huahong.vendor import et28_dll as b
        for model in ('HH_ET10C', 'HH_ET28'):
            service = self.service(model)
            for points in (True, 1.0, 0, 2, 25):
                with self.subTest(model=model, points=points), self.assertRaises(ValueError):
                    service.start_calibration(points)
        service = self.service('HH_ET28')
        service.lib = Mock()
        service.lib.et28_InitCalibration.return_value = 0
        service.start_calibration(1)
        service.lib.et28_InitCalibration.assert_called_once_with(1, b.EyeType.ET28_TWOEYE)
        def point(pointer, timeout):
            value = C.cast(pointer, C.POINTER(b.et28_GzTrackerPoint2d)).contents
            self.assertAlmostEqual(value.x, .25)
            self.assertAlmostEqual(value.y, .75)
            self.assertEqual(timeout, 10)
            return -8
        service.lib.et28_performOnePointCalibration.side_effect = point
        with self.assertRaisesRegex(RuntimeError, 'vendor error -8'):
            service.calibration_point(.25, .75)
        for point in ((float('nan'), .5), (float('inf'), .5), (-.1, .5), (.5, 1.1)):
            with self.subTest(point=point), self.assertRaises(ValueError):
                service.calibration_point(*point)
        self.assertEqual(service.lib.et28_performOnePointCalibration.call_count, 1)

        et10 = self.service()
        et10.tracker = Mock()
        et10.tracker.perform_one_point_calibration.return_value = 0
        et10.calibration_point(.25, .75)
        et10.tracker.perform_one_point_calibration.assert_called_once_with((.25, .75), timeout=5)
        self.assertEqual(NATIVE_CALIBRATION_TIMEOUT_S, {'HH_ET10C': 5, 'HH_ET28': 10})

    def test_et28_verified_feature_is_loaded_after_init_before_tracking_and_resume(self):
        service, payload = self.et28_with_feature()
        service.config.update(world_width=1600, crop_type=0, smooth=3, smooth_coeff=3)
        native_calibrated = False
        entered, stopped = threading.Event(), threading.Event()
        operations = []

        def reinitialize(points):
            nonlocal native_calibrated
            self.assertEqual(points, 3)
            operations.append('init')
            native_calibrated = False
            return 0

        def load(data, length):
            nonlocal native_calibrated
            self.assertEqual(bytes(data[:length]), payload)
            operations.append('load')
            native_calibrated = True
            return 0

        def track(smoothing):
            self.assertEqual(smoothing, 12)
            operations.append('track')
            if not native_calibrated:
                return -1
            entered.set()
            stopped.wait(1)
            return 0

        def stop():
            stopped.set()
            return 0

        service.lib.et28_initTracker.side_effect = reinitialize
        service.lib.et28_LoadCalibrationDataBin.side_effect = load
        service.lib.et28_startTracker.side_effect = track
        service.lib.et28_stopTracker.side_effect = stop
        for _ in range(2):
            entered.clear()
            stopped.clear()
            service.start_tracking()
            self.assertTrue(entered.wait(1))
            self.assertTrue(service.tracking)
            self.assertEqual(service.failure, '')
            service.stop_tracking()
            self.assertFalse(service.tracking)
            self.assertIsNone(service.worker)
        self.assertEqual(operations, ['init', 'load', 'track'] * 2)
        self.assertEqual(service.lib.et28_startTracker.call_count, 2)

    def test_et28_init_or_load_failure_never_starts_native_tracking(self):
        uncalibrated = self.service('HH_ET28')
        uncalibrated.lib = Mock()
        with self.assertRaisesRegex(RuntimeError, 'validated feature'):
            uncalibrated.start_tracking()
        uncalibrated.lib.et28_initTracker.assert_not_called()
        for operation in ('et28_initTracker', 'et28_LoadCalibrationDataBin'):
            with self.subTest(operation=operation):
                service, _ = self.et28_with_feature()
                service.lib.et28_initTracker.return_value = 0
                service.lib.et28_LoadCalibrationDataBin.return_value = 0
                getattr(service.lib, operation).return_value = -7
                with self.assertRaisesRegex(RuntimeError, 'vendor error -7'):
                    service.start_tracking()
                self.assertFalse(service.tracking)
                self.assertIsNone(service.calibration_quality)
                self.assertIsNone(service.worker)
                service.lib.et28_startTracker.assert_not_called()
                if operation == 'et28_initTracker':
                    service.lib.et28_LoadCalibrationDataBin.assert_not_called()

    def test_et28_feature_is_invalidated_by_new_calibration_cancel_close_and_failed_quality(self):
        for action in ('new', 'failed-new', 'cancel', 'close', 'quality'):
            with self.subTest(action=action):
                service, _ = self.et28_with_feature()
                lib = service.lib
                lib.et28_InitCalibration.return_value = -7 if action == 'failed-new' else 0
                lib.et28_getGzAlgVersion.return_value = b'algorithm'
                lib.et28_getFirmWareVersion.return_value = b'firmware'
                for name in ('et28_stopCamera', 'et28_device_disconnect', 'et28_device_deinit'):
                    getattr(lib, name).return_value = 0
                if action == 'new':
                    service.start_calibration(5)
                elif action == 'failed-new':
                    with self.assertRaisesRegex(RuntimeError, 'vendor error -7'):
                        service.start_calibration(5)
                    lib.et28_getGzAlgVersion.assert_not_called()
                    lib.et28_getFirmWareVersion.assert_not_called()
                elif action == 'cancel':
                    service.cancel_calibration()
                elif action == 'close':
                    service.close()
                else:
                    lib.et28_getCalibBias.side_effect = None
                    lib.et28_getCalibBias.return_value = -7
                    with self.assertRaisesRegex(RuntimeError, 'vendor error -7'):
                        service.feature()
                with self.assertRaisesRegex(RuntimeError, 'validated feature'):
                    service.start_tracking()
                self.assertIsNone(service.calibration_quality)
                lib.et28_initTracker.assert_not_called()
                lib.et28_startTracker.assert_not_called()

    def test_et28_quality_snapshot_preserves_sdk_scores_and_sanitizes_only_nonfinite_bias(self):
        service, _ = self.et28_with_feature()
        quality = service.calibration_quality
        self.assertEqual((quality['version'], quality['provider'], quality['aggregation']),
                         (1, 'HH_ET28', 'arithmetic_mean'))
        self.assertEqual([p['score'] for p in quality['left']['points']], [100, 97, 101])
        self.assertEqual([p['score'] for p in quality['right']['points']], [99, 99, 100])
        self.assertEqual(quality['left']['points'][0],
                         {'index': 1, 'status': 0, 'score': 100, 'bias': [None, -.25]})
        self.assertEqual(quality['left']['points'][1],
                         {'index': 2, 'status': 1, 'score': 97, 'bias': [.125, -.25]})
        for eye in ('left', 'right'):
            self.assertEqual(quality[eye]['count'], 3)
            self.assertFalse(quality[eye]['truncated'])
        json.dumps(quality, allow_nan=False)
        service.lib.et28_SaveCalibrationDataBin.side_effect = None
        service.lib.et28_SaveCalibrationDataBin.return_value = -7
        with self.assertRaisesRegex(RuntimeError, 'vendor error -7'):
            service.feature()
        self.assertIsNone(service.calibration_quality)

    def test_et28_quality_is_cleared_on_native_tracking_or_acquisition_failure(self):
        service, _ = self.et28_with_feature()
        service.lib.et28_initTracker.return_value = service.lib.et28_LoadCalibrationDataBin.return_value = 0
        service.lib.et28_startTracker.return_value = -7
        service.start_tracking()
        service.worker.join(1)
        self.assertIn('vendor error -7', service.failure)
        self.assertIsNone(service.calibration_quality)
        for failure in ('native', 'camera', 'gaze'):
            with self.subTest(failure=failure):
                service, _ = self.et28_with_feature()
                if failure == 'native':
                    service.failure = 'native failure'
                elif failure == 'camera':
                    service._last_frame -= 4
                else:
                    service.tracking = True
                    service.last_gaze = service.tracking_started = time.monotonic() - 4
                with self.assertRaises(RuntimeError):
                    service.read(0)
                self.assertIsNone(service.calibration_quality)

    def test_et10_tracking_keeps_its_own_native_contract(self):
        service = self.service()
        service.tracker, service.lib = Mock(), Mock()
        service.tracker.stop_tracker.return_value = 0
        service.start_tracking()
        service.start_tracking()
        service.tracker.start_tracker.assert_called_once_with()
        service.stop_tracking()
        service.tracker.stop_tracker.assert_called_once_with()
        service.lib.et28_initTracker.assert_not_called()
        service.lib.et28_LoadCalibrationDataBin.assert_not_called()

    def test_et10_incomplete_or_bad_quality_cannot_export_feature(self):
        service = self.service()
        service.points, service.tracker = 3, Mock()
        service.tracker.check_calibration_finished.return_value = False
        with self.assertRaisesRegex(RuntimeError, 'incomplete'):
            service.feature()
        service.tracker.check_calibration_finished.return_value = True
        bias = GazeTrackerCalibBias()
        service.tracker.get_calibration_bias.return_value = bias
        for count, status in ((2, 0), (3, 2), (3, -1)):
            bias.numOfCalibrate, bias.cablicStatus[1] = count, status
            with self.subTest(count=count, status=status), self.assertRaisesRegex(RuntimeError, 'quality failed'):
                service.feature()
        service.tracker.get_calibration_feature.assert_not_called()
        bias.numOfCalibrate, bias.cablicStatus[1] = 3, 1
        service.tracker.get_calibration_feature.return_value = b'calibration'
        self.assertEqual(service.feature(), b'calibration')
        self.assertIsNone(service.calibration_quality)

    def test_et28_both_eye_quality_and_feature_length_are_required(self):
        from services.eye_tracking.adapters.huahong.vendor import et28_dll as b
        service = self.service('HH_ET28')
        service.points, service.lib = 3, Mock()
        counts, statuses = [3, 3], [0, 1]
        def bias(left, right):
            for i, pointer in enumerate((left, right)):
                value = C.cast(pointer, C.POINTER(b.et28_GazeTrackerCalibBias)).contents
                value.numOfCalibrate = counts[i]
                value.cablicStatus[1] = statuses[i]
            return 0
        service.lib.et28_getCalibBias.side_effect = bias
        for eye in (0, 1):
            name = ('left', 'right')[eye]
            for status in (2, -1, 3):
                statuses[eye] = status
                with self.subTest(eye=name, status=status), self.assertRaisesRegex(
                        RuntimeError, rf'{name} bad points=2\(status={status}\)'):
                    service.feature()
            statuses[eye] = 0
            for count in (0, 2, 4, 2**32 - 1):
                counts[eye] = count
                with self.subTest(eye=name, count=count), self.assertRaisesRegex(
                        RuntimeError, f'{name} count={count} expected=3'):
                    service.feature()
            counts[eye] = 3
        service.lib.et28_getFeatureLen.assert_not_called()
        statuses[:] = [0, 1]  # Perfect and Common both remain acceptable.
        def set_length(pointer, value):
            C.cast(pointer, C.POINTER(C.c_uint32))[0] = value
        for size in (0, 1024 * 1024 + 1):
            service.lib.et28_getFeatureLen.side_effect = lambda pointer, size=size: set_length(pointer, size)
            with self.subTest(size=size), self.assertRaisesRegex(RuntimeError, 'feature length'):
                service.feature()
        service.lib.et28_SaveCalibrationDataBin.assert_not_called()
        service.lib.et28_getFeatureLen.side_effect = lambda pointer: set_length(pointer, 4)
        for written in (0, 5, 4):
            def save(data, pointer, written=written):
                data[:4] = b'test'
                set_length(pointer, written)
                return 0
            service.lib.et28_SaveCalibrationDataBin.side_effect = save
            if written == 4:
                self.assertEqual(service.feature(), b'test')
            else:
                with self.subTest(written=written), self.assertRaisesRegex(RuntimeError, 'bytes written'):
                    service.feature()

    def test_et28_quality_log_bounds_native_counts_and_sanitizes_bias(self):
        from services.eye_tracking.adapters.huahong.vendor import et28_dll as b
        service = self.service('HH_ET28')
        service.points, service.lib, service._et28_feature = 3, Mock(), b'previous-feature'

        def bias(left, right):
            values = [C.cast(pointer, C.POINTER(b.et28_GazeTrackerCalibBias)).contents
                      for pointer in (left, right)]
            values[0].numOfCalibrate = 2**32 - 1
            values[0].cablicStatus[0], values[0].Score[0] = 2, 77
            values[0].Bias[0].x, values[0].Bias[0].y = float('nan'), float('inf')
            values[1].numOfCalibrate = 3
            values[1].cablicStatus[0], values[1].Score[0] = 1, 91
            values[1].Bias[0].x, values[1].Bias[0].y = .125, -.25
            return 0

        service.lib.et28_getCalibBias.side_effect = bias
        with patch('services.eye_tracking.adapters.huahong.service.logging.info') as log:
            with self.assertRaisesRegex(RuntimeError, 'left count=4294967295 expected=3; left bad points=1'):
                service.feature()
        log.assert_called_once()
        template, model, expected, left, right = log.call_args.args
        self.assertIn('huahong.calibration quality', template)
        self.assertEqual((model, expected), ('HH_ET28', 3))
        self.assertEqual(left['count'], 2**32 - 1)
        self.assertEqual(len(left['points']), 25)
        self.assertTrue(left['truncated'])
        self.assertEqual(left['points'][0], {'index': 1, 'status': 2, 'score': 77, 'bias': [None, None]})
        self.assertEqual(right['count'], 3)
        self.assertEqual(len(right['points']), 3)
        self.assertFalse(right['truncated'])
        self.assertEqual(right['points'][0], {'index': 1, 'status': 1, 'score': 91, 'bias': [.125, -.25]})
        json.dumps([left, right], allow_nan=False)
        self.assertEqual(service._et28_feature, b'')
        service.lib.et28_getFeatureLen.assert_not_called()
        service.lib.et28_SaveCalibrationDataBin.assert_not_called()

    def test_recording_uses_model_specific_csv_and_metadata(self):
        import shutil
        import subprocess
        if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
            self.skipTest('ffmpeg/ffprobe required')
        for model, space, device_type in (
            ('HH_ET28', 'world_normalized_top_left', '眼镜式'),
            ('HH_ET10C', 'screen_normalized_top_left', '桌面式'),
        ):
            with self.subTest(model=model), tempfile.TemporaryDirectory() as tmp:
                identity = SampleIdentity(model, 'scene', 1, 1, 10, 10)
                frame = VideoFrame(identity, 'scene', 16, 16, 'bgr', bytes(16 * 16 * 3), None)
                gaze = GazeSample(replace(identity, topic='gaze'), (0, .75), space, None, True, ('left',))
                source_info = {'timestampSource': 'host_arrival', 'model': model, 'versions': {'sdk': 'test'}}
                calibration = {}
                if model == 'HH_ET28':
                    service, _ = self.et28_with_feature()
                    calibration = {'calibrationQuality': service.calibration_quality,
                                   'calibrationLeftScore': 298 / 3, 'calibrationRightScore': 298 / 3}
                # Keep the production UUID-only stem: date-suffixed fixtures hide
                # failures in discovery of real Huahong recordings.
                recorder = PupilRecorder(Path(tmp) / 'recordings', 'huahong_012345abcdef', frame, fps=10,
                    source_model=model, row_mapper=gaze_csv_row, source_info=source_info,
                    metadata={'subjectName': '张三', 'calibrationVerified': True,
                              'calibrationProvider': model, **calibration,
                              'deviceType': device_type, 'coordinateSpace': space})
                recorder.start()
                recorder.submit([gaze, replace(frame, identity=replace(identity, source_time_s=10.2))], ())
                result = recorder.finish()
                self.assertEqual(result['status'], 'complete', result)
                self.assertEqual(result['deviceModel'], model)
                for metadata in (result, json.loads(recorder.meta_path.read_text())):
                    for key, value in calibration.items():
                        self.assertEqual(metadata[key], value)
                    self.assertEqual(metadata['coordinateSpace'], space)
                    self.assertEqual(metadata['sourceInfo'], source_info)
                    self.assertTrue(metadata['pupilAlignment'].startswith('not applicable: Huahong'))
                    self.assertIn('live/replay', metadata['gazeCompatibilityAliases'])
                    self.assertIn('normalized 2D', metadata['gazeCompatibilityAliases'])
                    self.assertIn('CSV gaze_x/y only', metadata['gazeCompatibilityAliases'])
                    semantics = metadata['measurementSemantics']
                    self.assertIn('units unverified', semantics['pupilGeometry'])
                    if model == 'HH_ET28':
                        self.assertIn('normalized-samples.jsonl', semantics['vendorEyeData'])
                    else:
                        self.assertIn('not exposed', semantics['vendorEyeData'])
                import csv
                with recorder.csv_path.open() as source:
                    rows = list(csv.DictReader(source))
                self.assertEqual(rows[0]['source_model'], model)
                self.assertEqual(float(rows[0]['recom_gaze_y']), .75)
                self.assertEqual(rows[0]['recom_gaze_bit_mask'], '1')
                for field in ('recom_gaze_point_x', 'recom_raw_point_x', 'recom_smooth_point_x', 'pupil_valid'):
                    self.assertEqual(rows[0][field], '')
                checked = subprocess.run(['node', str(Path(__file__).with_name('check_record_list.mjs'))],
                    input=json.dumps({'projectDir': tmp, 'recordingId': recorder.name,
                                      'model': model, 'deviceType': device_type, 'coordinateSpace': space,
                                      **calibration}),
                    text=True, capture_output=True, timeout=10)
                self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)

if __name__ == '__main__':
    unittest.main()

class ET28CallbackTests(unittest.TestCase):
    @staticmethod
    def camera_parameters(**changes):
        from services.eye_tracking.adapters.huahong.vendor import et28_dll as b
        fields = dict(m_worldWidth=1920, m_worldHeight=1080, m_worldFPS=30,
                      m_worldDFoV=112, m_worldHFoV=103, m_worldVFoV=67,
                      m_irWidth=4, m_irHeight=2, m_irOneEyeWidth=2, m_irOneEyeHeight=2,
                      m_irFPS=120, m_irFoV=38, m_worldCameraCropType=1)
        fields.update(changes)
        return b.et28_CameraPara(**fields)

    def library(self):
        lib = Mock()
        for name in ('et28_device_init', 'et28_device_connect', 'et28_setCamera_para',
                     'et28_setIrLedBrightness', 'et28_startCamera', 'et28_InitCalibration'):
            getattr(lib, name).return_value = 0
        for name in ('et28_getGzSdkVersion', 'et28_getGzAlgVersion', 'et28_getFirmWareVersion'):
            getattr(lib, name).return_value = b'test-version'
        def params(array, capacity, count):
            C.cast(count, C.POINTER(C.c_uint32))[0] = 1
            array[0] = self.camera_parameters()
            return 0
        lib.et28_getCamera_para.side_effect = params
        return lib

    def connection_fixture(self, candidates, config=None):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        dll = root / 'et28/bin/windows/x64'
        dll.mkdir(parents=True)
        (dll / 'et28_interface.dll').touch()
        lib = self.library()

        def params(array, capacity, count):
            self.assertGreaterEqual(capacity, len(candidates))
            C.cast(count, C.POINTER(C.c_uint32))[0] = len(candidates)
            for index, candidate in enumerate(candidates):
                array[index] = candidate
            return 0

        lib.et28_getCamera_para.side_effect = params
        service = HuahongService('HH_ET28', root, config)
        return service, lib

    def test_fixed_camera_profile_ignores_legacy_config_and_preserves_full_first_match(self):
        from services.eye_tracking.adapters.huahong.vendor import et28_dll as b
        selected = self.camera_parameters(m_irWidth=800, m_irHeight=400,
                                          m_irOneEyeWidth=400, m_irOneEyeHeight=400)
        candidates = [
            self.camera_parameters(m_worldHeight=1200),
            self.camera_parameters(m_worldWidth=1600, m_worldHeight=1200, m_worldCameraCropType=0),
            self.camera_parameters(m_worldCameraCropType=0),
            selected,
            self.camera_parameters(m_worldFPS=60, m_irFPS=240),
        ]
        for config in ({}, {'world_width': 1600, 'crop_type': 0},
                       {'world_width': 1920, 'crop_type': 2}):
            with self.subTest(config=config):
                service, lib = self.connection_fixture(candidates, config)
                applied = []

                def set_parameters(pointer):
                    applied.append(C.cast(pointer, C.POINTER(b.et28_CameraPara)).contents)
                    # Read the complete native record while its pointer is live.
                    applied[-1] = b.et28_CameraPara.from_buffer_copy(bytes(applied[-1]))
                    return 0

                lib.et28_setCamera_para.side_effect = set_parameters
                with patch.object(b, 'library', return_value=lib), patch.dict('os.environ', {}, clear=False), \
                        self.assertLogs(level='INFO') as logs:
                    service._connect_et28()
                self.assertEqual(len(applied), 1)
                self.assertEqual(bytes(applied[0]), bytes(selected),
                                 'Selection must preserve SDK IR, FPS and FoV fields and the first matching item')
                candidate_log = next(record for record in logs.records if 'camera_candidates=' in record.msg)
                self.assertEqual(candidate_log.args[0], [b.camera_para_to_dict(item) for item in candidates])
                self.assertEqual(service.shape, (1920, 1080))
                self.assertEqual((service._eye_preview.width, service._eye_preview.height), (400, 400))
                lib.et28_startCamera.assert_called_once_with()

    def test_fixed_camera_profile_rejects_unsupported_dimensions_and_crop_without_fallback(self):
        from services.eye_tracking.adapters.huahong.vendor import et28_dll as b
        cases = [
            [],
            [self.camera_parameters(m_worldWidth=1600, m_worldHeight=1200, m_worldCameraCropType=0)],
            [self.camera_parameters(m_worldHeight=1200)],
            [self.camera_parameters(m_worldHeight=0)],
            [self.camera_parameters(m_worldCameraCropType=0), self.camera_parameters(m_worldCameraCropType=2)],
        ]
        for candidates in cases:
            for config in ({'world_width': 1600, 'crop_type': 0}, {'world_width': 1920, 'crop_type': 1}):
                with self.subTest(candidates=[b.camera_para_to_dict(item) for item in candidates], config=config):
                    service, lib = self.connection_fixture(candidates, config)
                    with patch.object(b, 'library', return_value=lib), patch.dict('os.environ', {}, clear=False):
                        with self.assertRaises(RuntimeError):
                            service._connect_et28()
                    lib.et28_setCamera_para.assert_not_called()
                    lib.et28_startCamera.assert_not_called()
                    self.assertIsNone(service.shape)
                    self.assertIsNone(service._eye_preview)

    def test_native_callback_copies_frame_and_normalizes_world_pixels(self):
        from services.eye_tracking.adapters.huahong.vendor import et28_dll as b
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dll = root / 'et28/bin/windows/x64'
            dll.mkdir(parents=True)
            (dll / 'et28_interface.dll').touch()
            lib = self.library()
            service = HuahongService('HH_ET28', root)
            service.state = 'connecting'
            with patch.object(b, 'library', return_value=lib), patch.dict('os.environ', {}, clear=False):
                service._connect_et28()
            self.assertEqual(service.versions, {'sdk': 'test-version'})
            lib.et28_getGzAlgVersion.assert_not_called()
            lib.et28_getFirmWareVersion.assert_not_called()
            lib.et28_setIrLedBrightness.assert_called_once_with(7)
            operations = [call[0] for call in lib.mock_calls]
            self.assertLess(operations.index('et28_device_init'), operations.index('et28_getGzSdkVersion'))
            self.assertLess(operations.index('et28_device_connect'), operations.index('et28_setIrLedBrightness'))
            self.assertLess(operations.index('et28_setIrLedBrightness'), operations.index('et28_startCamera'))
            service.start_calibration(3)
            operations = [call[0] for call in lib.mock_calls]
            self.assertLess(operations.index('et28_InitCalibration'), operations.index('et28_getGzAlgVersion'))
            self.assertLess(operations.index('et28_InitCalibration'), operations.index('et28_getFirmWareVersion'))
            self.assertEqual(service.versions, dict(sdk='test-version', algorithm='test-version', firmware='test-version'))
            camera = lib.et28_registerWorldCameraCb.call_args.args[0]
            raw = bytes(range(256)) * (1920 * 1080 * 3 // 256)
            data = (C.c_uint8 * len(raw)).from_buffer_copy(raw)
            camera(None, data, len(data))
            data[0] = 255
            service.state = 'ready'
            frame = service.read(0)[0]
            self.assertEqual(frame.pixels[0], 0, 'Native memory must be copied before callback returns')
            self.assertEqual(frame.pixels, raw)
            self.assertEqual((frame.width, frame.height), (1920, 1080))
            tracker = lib.et28_registerTrackerOutputCb.call_args.args[0]
            output = b.et28_GzTrackerPredictOutput()
            output.haveGazeInfoLeft = True
            output.worldPointLeft.x, output.worldPointLeft.y = 960, 540
            output.haveEyeInfoLeft = True
            output.eyeInfoLeft.pupilWidth = 12
            tracker(None, C.pointer(output))
            output.worldPointLeft.x = 0
            output.eyeInfoLeft.pupilWidth = 99
            sample = service.read(0)[0]
            self.assertEqual(sample.position, (.5, .5))
            self.assertEqual(sample.monocular['left']['vendor']['eyeInfo']['pupilWidth'], 12)
            self.assertTrue(sample.monocular['left']['vendor']['haveEyeInfo'])
            self.assertEqual(gaze_csv_row(sample, 0)['left_gaze_x'], .5)
            self.assertEqual(json.loads(gaze_message(sample))['eye_data']['l_gaze']['gaze'], {'x': .5, 'y': .5})
            for length in (len(data) - 1, len(data) + 1, 0):
                with self.subTest(length=length):
                    service.failure = ''
                    camera(None, data, length)
                    with self.assertRaisesRegex(RuntimeError, 'length'):
                        service.read(0)
                    self.assertTrue(service.samples.empty(), 'Malformed frame must not enter the recording queue')

    def test_ir_led_initialization_failure_is_logged_and_prevents_camera_start(self):
        from services.eye_tracking.adapters.huahong.vendor import et28_dll as b
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dll = root / 'et28/bin/windows/x64'
            dll.mkdir(parents=True)
            (dll / 'et28_interface.dll').touch()
            lib = self.library()
            lib.et28_setIrLedBrightness.return_value = -9
            service = HuahongService('HH_ET28', root)
            with patch.object(b, 'library', return_value=lib), patch.dict('os.environ', {}, clear=False), \
                    self.assertLogs(level='INFO') as logs:
                with self.assertRaisesRegex(RuntimeError, 'setIrLedBrightness: vendor error -9'):
                    service._connect_et28()
            self.assertTrue(any('brightness=7 result=-9' in line for line in logs.output))
            lib.et28_startCamera.assert_not_called()
            lib.et28_getGzAlgVersion.assert_not_called()
            lib.et28_getFirmWareVersion.assert_not_called()


class ProductContracts(unittest.TestCase):
    def test_typescript_model_launch_and_packaging_contracts(self):
        import subprocess
        subprocess.run(['node', 'tests/eye_tracking/huahong/check_product_contracts.mjs'], check=True, capture_output=True)
