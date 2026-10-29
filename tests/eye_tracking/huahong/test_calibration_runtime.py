"""Shared calibration protocol through the real command worker, without hardware."""
from dataclasses import dataclass, field
import copy
import json
from pathlib import Path
import queue
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from services.eye_tracking.application import huahong_runtime
from services.eye_tracking.domain.samples import GazeSample, SampleIdentity, VideoFrame


@dataclass
class PointResult:
    error: Exception | None = None
    entered: threading.Event = field(default_factory=threading.Event)
    release: threading.Event = field(default_factory=threading.Event)


class ControlledService:
    """The SDK completes only when a test releases the corresponding call."""

    def __init__(self, capabilities):
        self.capabilities = capabilities
        self.state, self.generation, self.config = 'ready', 1, {}
        self.versions = {}
        self.point_results = queue.Queue()
        self.steps, self.point_calls = [], []
        self.read_failure = threading.Event()
        self.closed = threading.Event()
        self.feature_value = b'completed-native-feature'
        self.feature_error = None
        self.calibration_quality = None
        self.publish_quality = True
        self.tracking_error = None
        self.tracking_calls = 0
        self.feature_calls = 0
        self.live_samples = False
        self.last_gaze = self.tracking_started = 0.0

    def plan_point(self, error=None):
        result = PointResult(error)
        self.steps.append(result)
        self.point_results.put(result)
        return result

    def start_calibration(self, points):
        if points not in (1, 3, 5, 9):
            raise ValueError('Unsupported calibration point count')
        self.points = points
        self.calibration_quality = None

    def calibration_point(self, x, y):
        self.point_calls.append((x, y))
        result = self.point_results.get(timeout=2)
        result.entered.set()
        if not result.release.wait(3):
            raise TimeoutError('Test did not release native calibration')
        if result.error:
            raise result.error

    def feature(self):
        self.feature_calls += 1
        self.calibration_quality = None
        if self.feature_error:
            raise self.feature_error
        if self.capabilities.model == 'HH_ET28' and self.publish_quality:
            self.calibration_quality = {
                'version': 1, 'provider': 'HH_ET28', 'aggregation': 'arithmetic_mean',
                **{eye: {'count': self.points, 'truncated': False,
                         'points': [{'index': i + 1, 'status': 0, 'score': scores[i % 3],
                                     'bias': [.125, -.25]} for i in range(self.points)]}
                   for eye, scores in [('left', [100, 97, 101]), ('right', [99, 99, 100])]},
            }
        return self.feature_value

    def start_tracking(self):
        self.tracking_calls += 1
        if self.tracking_error:
            raise self.tracking_error
        self.tracking_started = time.monotonic()

    def stop_tracking(self):
        pass

    def read(self, _timeout_ms):
        if self.read_failure.is_set():
            raise RuntimeError('Device disconnected during calibration')
        if not self.live_samples:
            return []
        samples = [self.frame()] if self.capabilities.model == 'HH_ET28' else []
        if self.tracking_started:
            self.last_gaze = time.monotonic()
            identity = SampleIdentity(self.capabilities.model, 'gaze', self.generation, 1,
                                      self.last_gaze, self.last_gaze)
            space = ('world_normalized_top_left' if self.capabilities.model == 'HH_ET28'
                     else 'screen_normalized_top_left')
            samples.append(GazeSample(identity, (.5, .5), space, None, True, ('left',)))
        return samples

    def frame(self):
        now = time.monotonic()
        identity = SampleIdentity(self.capabilities.model, 'scene', self.generation, 1, now, now)
        return VideoFrame(identity, 'scene', 4, 2, 'bgr', bytes(24), None)

    def close(self):
        self.state = 'idle'
        self.calibration_quality = None
        self.closed.set()


class CalibrationRuntimeTests(unittest.TestCase):
    def make_runtime(self, model='HH_ET28'):
        runtime = huahong_runtime.HuahongRuntime(model, '/unused-sdk')
        service = ControlledService(runtime.service.capabilities)
        runtime.service = service
        runtime.start()

        def cleanup():
            for step in service.steps:
                step.release.set()
            runtime.close()
            self.assertFalse(runtime._thread.is_alive())

        self.addCleanup(cleanup)
        return runtime, service

    def command(self, runtime, command, **args):
        response = runtime.request(command, args).result(timeout=2)
        self.assertEqual(response['type'], 'rsp_cmd')
        self.assertEqual(response['id'], command)
        if 'calibration' in command:
            self.assertEqual(response['calibration_provider'], runtime.model)
        if command != 'complete_calibration' or response['error'] != 0:
            for field in ('left_score', 'right_score', 'calibration_quality'):
                self.assertNotIn(field, response, 'ACK/failure published a calibration score')
        return response

    def ok(self, runtime, command, **args):
        response = self.command(runtime, command, **args)
        self.assertEqual(response['error'], 0, response)
        return response

    def start_point(self, runtime, service, index, attempt=None, error=None, *, session=None):
        step = service.plan_point(error)
        args = {'index': index, 'x': .25, 'y': .75}
        if attempt is not None:
            args['attempt'] = attempt
        if session is not None:
            args['calibration_session'] = session
        response = self.ok(runtime, 'start_calibration_point', **args)
        self.assertTrue(response['point_pending'])
        self.assertTrue(step.entered.wait(1), 'Native point call did not start')
        return step, response

    def finish_point(self, runtime, service, index, attempt, *, session=None):
        step, _ = self.start_point(runtime, service, index, attempt, session=session)
        step.release.set()
        result = runtime.events.get(timeout=2)
        self.assertEqual((result['type'], result['index'], result['attempt'], result['error']),
                         ('notify_finish', index, attempt, 0))
        return result

    def calibrate(self, runtime, service):
        self.ok(runtime, 'start_calibration', points=3)
        for index in range(1, 4):
            self.finish_point(runtime, service, index, index)
        return self.ok(runtime, 'complete_calibration')

    def wait_for_point_worker(self, runtime):
        deadline = time.monotonic() + 2
        while runtime.calibration_task is not None and time.monotonic() < deadline:
            self.ok(runtime, 'get_recording_status')
        self.assertIsNone(runtime.calibration_task, 'Native point result was not drained')

    def assert_invalidated(self, runtime, generation):
        self.assertGreater(runtime.calibration_generation, generation)
        self.assertFalse(runtime.verified)
        self.assertEqual(runtime.token, '')
        self.assertEqual(runtime.calibration_points, {})
        self.assertEqual(runtime.calibration_expected, 0)
        self.assertIsNone(runtime.calibration_quality)
        self.assertIsNone(runtime.service.calibration_quality)

    def test_completion_starts_tracking_for_both_shared_ui_flows(self):
        for model in ('HH_ET28', 'HH_ET10C'):
            with self.subTest(model=model):
                runtime, service = self.make_runtime(model)
                response = self.calibrate(runtime, service)
                self.assertEqual(response['tracking_error'], 0)
                self.assertEqual(response['calibration_provider'], model)
                self.assertEqual(service.tracking_calls, 1)
                self.assertTrue(runtime.tracking)
                self.assertTrue(runtime.verified)
                self.assertEqual(runtime.token, response['coe'])
                self.assertEqual(json.loads(response['coe'])['model'], model)
                if model == 'HH_ET28':
                    self.assertAlmostEqual(response['left_score'], 298 / 3)
                    self.assertAlmostEqual(response['right_score'], 298 / 3)
                    self.assertEqual(response['calibration_quality'], service.calibration_quality)
                    self.assertEqual(response['calibration_quality']['left']['points'][2]['score'], 101)
                else:
                    self.assertIsNone(runtime.calibration_quality)
                    for field in ('left_score', 'right_score', 'calibration_quality'):
                        self.assertNotIn(field, response)

    def test_quality_snapshot_is_owned_by_completed_session_and_cleared_for_new_round(self):
        runtime, service = self.make_runtime()
        response = self.calibrate(runtime, service)
        expected = copy.deepcopy(response['calibration_quality'])
        service.calibration_quality['left']['points'][0]['score'] = 0
        response['calibration_quality']['right']['points'][0]['score'] = 0
        self.assertEqual(runtime.calibration_quality, expected)
        generation = runtime.calibration_generation
        self.ok(runtime, 'start_calibration', points=3, calibration_session='new-round')
        self.assertGreater(runtime.calibration_generation, generation)
        self.assertFalse(runtime.verified)
        self.assertIsNone(runtime.calibration_quality)
        self.assertIsNone(service.calibration_quality)
        self.assertNotEqual(self.command(runtime, 'complete_calibration')['error'], 0)

    def test_completed_calibration_can_record_immediately_and_stop_for_both_models(self):
        for model, device_type, space in (
                ('HH_ET28', '眼镜式', 'world_normalized_top_left'),
                ('HH_ET10C', '桌面式', 'screen_normalized_top_left')):
            with self.subTest(model=model):
                runtime, service = self.make_runtime(model)
                service.live_samples = True
                recorder = Mock()
                recorder.timeline = SimpleNamespace(fps=30, t0=time.monotonic())
                recorder.finish.return_value = {'status': 'complete', 'durationSeconds': .1}

                def create_recorder(directory, name, _world, **_kwargs):
                    recorder.name = name
                    recorder.video_path = directory / (name + '.mp4')
                    recorder.csv_path = directory / (name + '.csv')
                    return recorder

                screen = Mock()
                screen.monitors = [
                    {'left': 0, 'top': 0, 'width': 960, 'height': 540},
                    {'left': 0, 'top': 0, 'width': 960, 'height': 540},
                ]
                screen_factory = Mock(return_value=screen)
                with patch.object(runtime.paths, 'directory', return_value=Path('/unused-recordings')) as directory, \
                        patch.object(huahong_runtime, 'PupilRecorder', side_effect=create_recorder) as factory, \
                        patch.object(runtime, 'capture_screen', side_effect=service.frame) as capture, \
                        patch.dict('sys.modules', {'mss': SimpleNamespace(mss=screen_factory)}):
                    completed = self.calibrate(runtime, service)
                    self.assertEqual(completed['tracking_error'], 0)
                    # No start_tracking command: this is the existing frontend's next step.
                    started = self.ok(runtime, 'start_recording', project_path='/authorized-project',
                                      subject_name='Test subject')
                    self.assertEqual(service.tracking_calls, 1)
                    self.assertGreaterEqual(service.last_gaze, service.tracking_started)
                    self.assertLess(time.monotonic() - service.last_gaze, .5)
                    self.assertLess(time.monotonic() - runtime.world.identity.received_monotonic_s, .5)
                    directory.assert_called_once_with('/authorized-project')
                    metadata = factory.call_args.kwargs['metadata']
                    self.assertEqual(metadata['deviceType'], device_type)
                    self.assertEqual(metadata['coordinateSpace'], space)
                    self.assertTrue(metadata['calibrationVerified'])
                    self.assertEqual(metadata['calibrationProvider'], model)
                    if model == 'HH_ET28':
                        self.assertEqual(metadata['calibrationQuality'], completed['calibration_quality'])
                        self.assertIsNot(metadata['calibrationQuality'], runtime.calibration_quality)
                        self.assertIsNot(metadata['calibrationQuality']['left'], runtime.calibration_quality['left'])
                        self.assertAlmostEqual(metadata['calibrationLeftScore'], 298 / 3)
                        self.assertAlmostEqual(metadata['calibrationRightScore'], 298 / 3)
                    else:
                        for field in ('calibrationQuality', 'calibrationLeftScore', 'calibrationRightScore'):
                            self.assertNotIn(field, metadata)
                    recorder.start.assert_called_once_with()
                    self.assertEqual(started['recording_id'], recorder.name)
                    self.assertEqual(self.ok(runtime, 'get_recording_status')['status'], 'recording')
                    self.assertNotEqual(self.command(runtime, 'stop_tracking')['error'], 0)
                    stopped = self.ok(runtime, 'stop_recording')
                    self.assertEqual(stopped['status'], 'finalizing')
                    finalized = runtime.events.get(timeout=2)
                    self.assertEqual(finalized['type'], 'notify_recording_finalized')
                    self.assertEqual(finalized['recording_id'], started['recording_id'])
                    self.assertEqual(finalized['error'], 0)
                    self.assertEqual(self.ok(runtime, 'get_recording_status')['status'], 'finalized')
                    recorder.finish.assert_called_once_with(error='')
                    self.assertTrue(recorder.submit.called)
                    if model == 'HH_ET10C':
                        screen_factory.assert_called_once_with()
                        self.assertTrue(capture.called)
                        screen.close.assert_called_once_with()
                    else:
                        screen_factory.assert_not_called()
                        capture.assert_not_called()
                    self.ok(runtime, 'stop_tracking')
                    self.assertFalse(runtime.tracking)
                    self.ok(runtime, 'stop')
                    self.assertTrue(service.closed.is_set())
                    self.assertFalse(runtime.verified)
                    self.assertEqual(runtime.token, '')
                    self.assertIsNone(runtime.calibration_quality)
                    if model == 'HH_ET28':
                        self.assertEqual(metadata['calibrationQuality'], completed['calibration_quality'])

    def test_tracking_start_failure_cannot_authorize_recording(self):
        runtime, service = self.make_runtime()
        self.ok(runtime, 'start_calibration', points=3)
        for index in range(1, 4):
            self.finish_point(runtime, service, index, index)
        generation = runtime.calibration_generation
        service.tracking_error = RuntimeError('Native start tracking failed')
        response = self.command(runtime, 'complete_calibration')
        self.assertNotEqual(response['error'], 0)
        self.assertIn('tracking failed', response['msg'])
        self.assertEqual(service.tracking_calls, 1)
        self.assert_invalidated(runtime, generation)
        self.assertFalse(runtime.tracking)
        self.assertNotEqual(self.command(runtime, 'start_recording')['error'], 0)

    def test_point_ack_does_not_complete_point_or_calibration(self):
        runtime, service = self.make_runtime()
        self.ok(runtime, 'start_calibration', points=3)
        step, response = self.start_point(runtime, service, 1, 1)
        self.assertEqual(response['attempt'], 1)
        self.assertEqual(runtime.calibration_points, {})
        self.assertTrue(runtime.events.empty())
        self.assertFalse(runtime.verified)
        self.assertNotEqual(self.command(runtime, 'complete_calibration')['error'], 0)
        self.assertEqual(service.feature_calls, 0)
        self.assertEqual(service.tracking_calls, 0)
        step.release.set()
        result = runtime.events.get(timeout=2)
        self.assertEqual(result['error'], 0)
        self.assertEqual(runtime.calibration_points, {1: True})
        self.assertNotEqual(self.command(runtime, 'complete_calibration')['error'], 0)

    def test_cancel_rejects_late_success_and_requires_fresh_session(self):
        runtime, service = self.make_runtime()
        self.ok(runtime, 'start_calibration', points=3)
        self.finish_point(runtime, service, 1, 1)
        step, _ = self.start_point(runtime, service, 2, 2)
        generation = runtime.calibration_generation
        self.ok(runtime, 'cancel_calibration', attempt=2)
        self.assert_invalidated(runtime, generation)
        self.assertNotEqual(self.command(runtime, 'start_calibration', points=3)['error'], 0)
        step.release.set()
        self.wait_for_point_worker(runtime)
        self.assertTrue(runtime.events.empty(), 'Cancelled success escaped to the shared UI')
        self.assertNotEqual(self.command(runtime, 'complete_calibration')['error'], 0)
        self.ok(runtime, 'start_calibration', points=3)
        self.finish_point(runtime, service, 1, 1)
        self.assertEqual(runtime.calibration_points, {1: True})

    def test_cancel_invalidates_previous_tracking_token(self):
        runtime, service = self.make_runtime()
        token = self.calibrate(runtime, service)['coe']
        generation = runtime.calibration_generation
        self.ok(runtime, 'cancel_calibration')
        self.assert_invalidated(runtime, generation)
        self.assertNotEqual(self.command(runtime, 'start_tracking', coe=token)['error'], 0)

    def test_disconnect_invalidates_session_before_native_point_returns(self):
        runtime, service = self.make_runtime()
        self.ok(runtime, 'start_calibration', points=3)
        self.finish_point(runtime, service, 1, 1)
        step, _ = self.start_point(runtime, service, 2, 2)
        generation = runtime.calibration_generation
        service.read_failure.set()
        result = runtime.events.get(timeout=2)
        self.assertEqual(result['type'], 'notify_device_error')
        self.assert_invalidated(runtime, generation)
        self.assertFalse(runtime.tracking)
        step.release.set()
        self.assertTrue(service.closed.wait(2), 'Disconnected service was not closed')
        self.wait_for_point_worker(runtime)
        self.assertTrue(runtime.events.empty(), 'Disconnected native success escaped to the UI')
        self.assertEqual(runtime.calibration_points, {})
        self.assertNotEqual(self.command(runtime, 'complete_calibration')['error'], 0)

    def test_disconnect_clears_previously_verified_token(self):
        runtime, service = self.make_runtime()
        token = self.calibrate(runtime, service)['coe']
        generation = runtime.calibration_generation
        service.read_failure.set()
        self.assertEqual(runtime.events.get(timeout=2)['type'], 'notify_device_error')
        self.assertTrue(service.closed.wait(2))
        self.assert_invalidated(runtime, generation)
        self.assertFalse(runtime.tracking)
        self.assertNotEqual(self.command(runtime, 'start_tracking', coe=token)['error'], 0)

    def test_et10_sdk_timeout_keeps_prior_points_and_allows_retry_with_new_attempt(self):
        runtime, service = self.make_runtime('HH_ET10C')
        self.ok(runtime, 'start_calibration', points=3)
        generation, session = runtime.calibration_generation, runtime.calibration_session
        self.finish_point(runtime, service, 1, 1)
        step, _ = self.start_point(runtime, service, 2, 2, TimeoutError('SDK point timeout'))
        step.release.set()
        result = runtime.events.get(timeout=2)
        self.assertEqual((result['type'], result['index'], result['attempt']), ('notify_finish', 2, 2))
        self.assertNotEqual(result['error'], 0)
        self.assertIn('timeout', result['msg'])
        self.assertFalse(result.get('calibration_invalidated', False))
        self.assertEqual(runtime.calibration_generation, generation)
        self.assertEqual(runtime.calibration_session, session)
        self.assertEqual(runtime.calibration_points, {1: True})
        self.assertFalse(runtime.verified)
        self.assertNotEqual(self.command(runtime, 'complete_calibration')['error'], 0)
        self.assertNotEqual(self.command(runtime, 'start_calibration_point', index=2,
                                         attempt=2, x=.5, y=.5)['error'], 0)
        self.finish_point(runtime, service, 2, 3)
        self.finish_point(runtime, service, 3, 4)
        self.ok(runtime, 'complete_calibration')
        self.assertTrue(runtime.verified)

    def test_et28_failed_second_point_requires_new_round_and_rejects_old_session(self):
        for native_error in (-8, -1):
            with self.subTest(native_error=native_error):
                runtime, service = self.make_runtime()
                failed_session, new_session = 'failed-round', 'new-round'
                self.ok(runtime, 'start_calibration', points=3, calibration_session=failed_session)
                generation = runtime.calibration_generation
                self.finish_point(runtime, service, 1, 1, session=failed_session)
                error_text = f'calibration_point: vendor error {native_error}'
                step, _ = self.start_point(runtime, service, 2, 2, RuntimeError(error_text),
                                           session=failed_session)
                step.release.set()
                result = runtime.events.get(timeout=2)
                self.assertEqual((result['type'], result['index'], result['attempt']),
                                 ('notify_finish', 2, 2))
                self.assertNotEqual(result['error'], 0)
                self.assertIn(error_text, result['msg'])
                self.assertIn('restart calibration', result['msg'])
                self.assertEqual(result['calibration_session'], failed_session)
                self.assertTrue(result['calibration_invalidated'])
                # The failure must survive the sender's generation filter even
                # though every prior success/token from the round is now stale.
                self.assertEqual(result['_calibration_generation'], runtime.calibration_generation)
                self.assert_invalidated(runtime, generation)
                self.assertIsNone(runtime.calibration_session)
                self.assertFalse(runtime.tracking)
                for session_args in ({}, {'calibration_session': failed_session}):
                    for command, args in (
                            ('start_calibration_point', {'index': 2, 'attempt': 3, 'x': .5, 'y': .5}),
                            ('complete_calibration', {}), ('start_recording', {})):
                        response = self.command(runtime, command, **args, **session_args)
                        self.assertNotEqual(response['error'], 0, response)
                self.assertEqual((service.feature_calls, service.tracking_calls), (0, 0))
                self.assertEqual(len(service.point_calls), 2)

                self.ok(runtime, 'start_calibration', points=3, calibration_session=new_session)
                self.finish_point(runtime, service, 1, 1, session=new_session)
                new_generation = runtime.calibration_generation
                for command, args in (
                        ('start_calibration_point', {'index': 2, 'attempt': 3, 'x': .5, 'y': .5}),
                        ('complete_calibration', {}), ('cancel_calibration', {})):
                    response = self.command(runtime, command, calibration_session=failed_session, **args)
                    self.assertNotEqual(response['error'], 0)
                    self.assertEqual(runtime.calibration_generation, new_generation)
                    self.assertEqual(runtime.calibration_session, new_session)
                    self.assertEqual(runtime.calibration_points, {1: True})
                for index in (2, 3):
                    self.finish_point(runtime, service, index, index, session=new_session)
                self.ok(runtime, 'complete_calibration', calibration_session=new_session)
                self.assertTrue(runtime.verified)
                self.assertTrue(runtime.tracking)
                self.assertEqual((service.feature_calls, service.tracking_calls), (1, 1))

    def test_runtime_deadline_invalidates_and_discards_late_native_success(self):
        with patch.object(huahong_runtime, 'calibration_point_timeout_s', return_value=.1):
            runtime, service = self.make_runtime()
            session = 'deadline-session'
            self.ok(runtime, 'start_calibration', points=3, calibration_session=session)
            step, _ = self.start_point(runtime, service, 1, 1, session=session)
            generation = runtime.calibration_generation
            result = runtime.events.get(timeout=2)
            self.assertEqual((result['type'], result['index'], result['attempt']), ('notify_finish', 1, 1))
            self.assertNotEqual(result['error'], 0)
            self.assertEqual(result['calibration_session'], session)
            self.assertTrue(result['calibration_invalidated'])
            self.assertIsNone(runtime.calibration_session)
            self.assert_invalidated(runtime, generation)
            self.assertNotEqual(self.command(runtime, 'start_calibration', points=3)['error'], 0)
            step.release.set()
            self.wait_for_point_worker(runtime)
            self.assertTrue(runtime.events.empty(), 'Timed-out native success escaped to the shared UI')
            self.assertEqual(runtime.calibration_points, {})
            self.assertNotEqual(self.command(runtime, 'complete_calibration')['error'], 0)

    def test_et28_point_keeps_its_native_ten_second_window(self):
        for model, timeout in (('HH_ET28', 11), ('HH_ET10C', 6)):
            with self.subTest(model=model):
                runtime = huahong_runtime.HuahongRuntime(model, '/unused-sdk')
                service = ControlledService(runtime.service.capabilities)
                runtime.service = service
                self.assertEqual(huahong_runtime.calibration_point_timeout_s(model), timeout)
                runtime._command('start_calibration', {'points': 3})
                step = service.plan_point()
                runtime._command('start_calibration_point', {'index': 1, 'attempt': 1, 'x': .5, 'y': .5})
                try:
                    self.assertTrue(step.entered.wait(1))
                    at_seven_seconds = runtime.calibration_deadline - timeout + 7
                    with patch.object(huahong_runtime, 'time', SimpleNamespace(monotonic=lambda: at_seven_seconds)):
                        runtime._poll_calibration()
                    if model == 'HH_ET28':
                        self.assertIsNotNone(runtime.calibration_pending)
                        self.assertTrue(runtime.events.empty())
                    else:
                        self.assertIsNone(runtime.calibration_pending)
                        self.assertTrue(runtime.events.get_nowait()['calibration_invalidated'])
                finally:
                    step.release.set()
                    runtime.calibration_task.join(2)
                runtime._poll_calibration()
                if model == 'HH_ET28':
                    self.assertEqual(runtime.events.get_nowait()['error'], 0)
                else:
                    self.assertTrue(runtime.events.empty(), 'Late desktop result escaped its deadline')

    def test_points_are_sequential_and_attempts_are_positive_increasing_integers(self):
        runtime, service = self.make_runtime()
        self.ok(runtime, 'start_calibration', points=3)
        for index, attempt in [(2, 1), (0, 1), (True, 1), (1, 0), (1, -1),
                               (1, True), (1, 1.5), (1, '1')]:
            with self.subTest(index=index, attempt=attempt):
                result = self.command(runtime, 'start_calibration_point', index=index,
                                      attempt=attempt, x=.5, y=.5)
                self.assertNotEqual(result['error'], 0)
        self.assertEqual(service.point_calls, [])
        self.finish_point(runtime, service, 1, 1)
        for index, attempt in [(1, 2), (3, 2), (2, 1)]:
            with self.subTest(index=index, attempt=attempt):
                result = self.command(runtime, 'start_calibration_point', index=index,
                                      attempt=attempt, x=.5, y=.5)
                self.assertNotEqual(result['error'], 0)
        self.assertEqual(len(service.point_calls), 1)
        self.finish_point(runtime, service, 2, 2)

    def test_omitted_attempt_remains_compatible_and_is_assigned_monotonically(self):
        runtime, service = self.make_runtime()
        self.ok(runtime, 'start_calibration', points=3)
        attempts = []
        for index in (1, 2):
            step, response = self.start_point(runtime, service, index)
            attempts.append(response['attempt'])
            step.release.set()
            result = runtime.events.get(timeout=2)
            self.assertEqual(result['attempt'], response['attempt'])
            self.assertEqual(result['error'], 0)
        self.assertEqual(attempts, [1, 2])

    def test_session_is_echoed_through_success_and_cancel_invalidates_its_token(self):
        for model in ('HH_ET28', 'HH_ET10C'):
            with self.subTest(model=model):
                runtime, service = self.make_runtime(model)
                session = model + '-current-session'
                response = self.ok(runtime, 'start_calibration', points=3, calibration_session=session)
                self.assertEqual(response['calibration_session'], session)
                for index in range(1, 4):
                    step, response = self.start_point(runtime, service, index, index, session=session)
                    self.assertEqual(response['calibration_session'], session)
                    step.release.set()
                    notification = runtime.events.get(timeout=2)
                    self.assertEqual(notification['type'], 'notify_finish')
                    self.assertEqual(notification['error'], 0)
                    self.assertEqual(notification['calibration_session'], session)
                    self.assertEqual(notification['source'], model)
                completed = self.ok(runtime, 'complete_calibration', calibration_session=session)
                self.assertEqual(completed['calibration_session'], session)
                cancelled = self.ok(runtime, 'cancel_calibration', calibration_session=session)
                self.assertEqual(cancelled['calibration_session'], session)
                self.assertIsNone(runtime.calibration_session)
                self.assertEqual(runtime.token, '')
                self.assertNotEqual(self.command(runtime, 'start_tracking', coe=completed['coe'],
                                                calibration_session=session)['error'], 0)
                self.assertEqual(service.tracking_calls, 1)

    def test_stale_session_commands_cannot_change_current_calibration(self):
        runtime, service = self.make_runtime()
        old_session, current_session = 'previous-session', 'current-session'
        self.ok(runtime, 'start_calibration', points=3, calibration_session=old_session)
        self.ok(runtime, 'cancel_calibration', calibration_session=old_session)
        self.ok(runtime, 'start_calibration', points=3, calibration_session=current_session)
        self.finish_point(runtime, service, 1, 1, session=current_session)
        generation = runtime.calibration_generation
        for command, args in [
                ('start_calibration_point', {'index': 2, 'attempt': 2, 'x': .5, 'y': .5}),
                ('complete_calibration', {}),
                ('cancel_calibration', {}),
                ('cancel_calibration_point', {'attempt': 1})]:
            with self.subTest(command=command):
                result = self.command(runtime, command, calibration_session=old_session, **args)
                self.assertNotEqual(result['error'], 0)
                self.assertEqual(result['calibration_session'], old_session)
                if command == 'start_calibration_point':
                    self.assertEqual((result['index'], result['attempt']), (args['index'], args['attempt']))
                self.assertIn('Stale calibration session', result['msg'])
                self.assertEqual(runtime.calibration_session, current_session)
                self.assertEqual(runtime.calibration_generation, generation)
                self.assertEqual(runtime.calibration_points, {1: True})
                self.assertEqual(runtime.calibration_expected, 3)
                self.assertEqual(runtime.calibration_attempt, 1)
                self.assertIsNone(runtime.calibration_task)
        self.assertEqual(len(service.point_calls), 1)
        for index in (2, 3):
            self.finish_point(runtime, service, index, index, session=current_session)
        completed = self.ok(runtime, 'complete_calibration', calibration_session=current_session)
        self.assertEqual(completed['calibration_session'], current_session)
        result = self.command(runtime, 'cancel_calibration', calibration_session=old_session)
        self.assertNotEqual(result['error'], 0)
        self.assertTrue(runtime.verified)
        self.assertEqual(runtime.token, completed['coe'])

    def test_completion_failures_echo_session_even_after_invalidation(self):
        for failure in ('empty_feature', 'feature_exception', 'quality_count', 'quality_bad_point',
                        'missing_quality', 'tracking_exception'):
            with self.subTest(failure=failure):
                runtime, service = self.make_runtime()
                session = 'failed-' + failure
                self.ok(runtime, 'start_calibration', points=3, calibration_session=session)
                for index in range(1, 4):
                    self.finish_point(runtime, service, index, index, session=session)
                if failure == 'empty_feature':
                    service.feature_value = b''
                elif failure == 'feature_exception':
                    service.feature_error = RuntimeError('Native feature retrieval failed')
                elif failure.startswith('quality_'):
                    detail = ('left count=2 expected=3' if failure == 'quality_count'
                              else 'right bad points=2(status=2)')
                    service.feature_error = RuntimeError('ET28 calibration quality failed: ' + detail)
                elif failure == 'missing_quality':
                    service.publish_quality = False
                else:
                    service.tracking_error = RuntimeError('Native tracking failed')
                generation = runtime.calibration_generation
                # Omission exercises the active-session fallback before _cancel clears it.
                response = self.command(runtime, 'complete_calibration')
                self.assertNotEqual(response['error'], 0)
                self.assertEqual(response['calibration_session'], session)
                self.assertIsNone(runtime.calibration_session)
                self.assert_invalidated(runtime, generation)
                self.assertNotEqual(self.command(runtime, 'start_recording')['error'], 0)
                if failure.startswith('quality_'):
                    self.assertIn(detail, response['msg'])
                    self.assertEqual(service.tracking_calls, 0)


if __name__ == '__main__':
    unittest.main()
