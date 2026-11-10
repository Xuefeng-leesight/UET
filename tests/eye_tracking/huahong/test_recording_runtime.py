"""Recording failures must not tear down healthy Huahong acquisition."""
import builtins
from dataclasses import replace
from pathlib import Path
import queue
import shutil
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from services.eye_tracking.application import huahong_runtime
from services.eye_tracking.domain.samples import VideoFrame
from tests.eye_tracking.huahong.test_calibration_runtime import ControlledService


class BufferedService(ControlledService):
    """A native producer fails if the command worker stops draining its queue."""
    def __init__(self, capabilities):
        super().__init__(capabilities)
        self.incoming = queue.Queue(3)
        self.producer_stop = threading.Event()
        self.preparing = threading.Event()
        self.preparation_drained = threading.Event()
        self.preparation_samples = []
        self.producer = threading.Thread(target=self.produce, name='test-huahong-native-producer')
        self.producer.start()

    def produce(self):
        while not self.producer_stop.wait(.005):
            if not self.live_samples:
                continue
            try:
                self.incoming.put_nowait(super().read(1))
            except queue.Full:
                self.read_failure.set()
                return

    def read(self, _timeout_ms):
        if self.read_failure.is_set():
            raise RuntimeError('Acquisition queue overflow')
        try:
            samples = self.incoming.get_nowait()
        except queue.Empty:
            return []
        if self.preparing.is_set():
            self.preparation_samples.extend(samples)
            if len(self.preparation_samples) >= 12:
                self.preparation_drained.set()
        return samples

    def close(self):
        self.producer_stop.set()
        self.producer.join(2)
        super().close()


class InfraredService(BufferedService):
    def read(self, timeout_ms):
        samples = super().read(timeout_ms)
        scene = next((sample for sample in samples if isinstance(sample, VideoFrame)), None)
        if scene is not None:
            for stream in ('left_eye', 'right_eye'):
                samples.append(replace(scene, stream=stream, width=256, height=256, pixels=bytes(256 * 256 * 3)))
        return samples


class RecordingRuntimeTests(unittest.TestCase):
    def make_runtime(self, model='HH_ET28', service_type=ControlledService):
        runtime = huahong_runtime.HuahongRuntime(model, '/unused-sdk')
        service = service_type(runtime.service.capabilities)
        service.live_samples = True
        service.start_tracking()
        runtime.service = service
        runtime.verified = runtime.tracking = True
        runtime.token = 'completed-current-calibration'
        runtime.start()
        self.addCleanup(runtime.close)
        return runtime, service

    def command(self, runtime, command, **args):
        result = runtime.request(command, args).result(timeout=2)
        self.assertEqual(result['error'], 0, result)
        return result

    def recorder(self, runtime, *, result=None):
        recorder = Mock()
        recorder.timeline = SimpleNamespace(fps=30, t0=time.monotonic())
        recorder.finish.return_value = result or {'status': 'complete'}
        def create(directory, name, _world, **_kwargs):
            recorder.name = name
            recorder.video_path = directory / (name + '.mp4')
            recorder.csv_path = directory / (name + '.csv')
            return recorder
        self.enterContext(patch.object(runtime.paths, 'directory', return_value=Path('/unused-recordings')))
        self.enterContext(patch.object(huahong_runtime, 'PupilRecorder', side_effect=create))
        return recorder

    def wait_for_live_samples(self, runtime):
        deadline = time.monotonic() + 1
        while runtime.world is None and time.monotonic() < deadline:
            self.command(runtime, 'get_device_status')
            time.sleep(.001)
        self.assertIsNotNone(runtime.world)

    def wait_for_finalization(self, runtime):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            response = self.command(runtime, 'get_recording_status')
            if response['status'] == 'finalized':
                return response['result']
            time.sleep(.001)
        self.fail('Recording cleanup did not finalize')

    def test_slow_encoder_preparation_drains_native_queue_and_keeps_all_samples(self):
        runtime, service = self.make_runtime(service_type=BufferedService)
        self.wait_for_live_samples(runtime)
        recorder = self.recorder(runtime)
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def prepare():
            service.preparing.set()
            entered.set()
            if not release.wait(2):
                raise RuntimeError('Test did not release recorder preparation')
            service.preparing.clear()
        recorder.start.side_effect = prepare
        future = runtime.request('start_recording', {'project_path': '/authorized-project'})
        self.assertTrue(entered.wait(1))
        self.assertTrue(service.preparation_drained.wait(1), 'Encoder startup blocked native acquisition')
        self.assertFalse(service.read_failure.is_set())
        release.set()
        self.assertEqual(future.result(timeout=2)['error'], 0)
        submitted = [sample for call in recorder.submit.call_args_list for sample in call.args[0]]
        self.assertTrue(service.preparation_samples)
        self.assertEqual(submitted[:len(service.preparation_samples)], service.preparation_samples)
        self.assertTrue(self.command(runtime, 'get_device_status')['acquisition_ready'])

    def test_infrared_preview_does_not_enter_preparation_or_recording_buffers(self):
        runtime, service = self.make_runtime(service_type=InfraredService)
        self.wait_for_live_samples(runtime)
        recorder = self.recorder(runtime)
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def prepare():
            service.preparing.set()
            entered.set()
            release.wait(2)
            service.preparing.clear()
        recorder.start.side_effect = prepare
        # A single infrared pair exceeds this limit; scene + gaze do not.
        with patch.object(huahong_runtime, 'RECORDING_PREPARATION_BYTE_LIMIT', 100_000):
            future = runtime.request('start_recording', {'project_path': '/authorized-project'})
            self.assertTrue(entered.wait(1))
            self.assertTrue(service.preparation_drained.wait(1))
            preview = runtime.take_latest()
            self.assertEqual({sample.stream for sample in preview if isinstance(sample, VideoFrame)},
                             {'scene', 'left_eye', 'right_eye'})
            self.assertEqual(runtime.world.stream, 'scene')
            release.set()
            self.assertEqual(future.result(timeout=2)['error'], 0)
        before = recorder.submit.call_count
        deadline = time.monotonic() + 1
        while recorder.submit.call_count <= before and time.monotonic() < deadline:
            self.command(runtime, 'get_device_status')
        self.assertGreater(recorder.submit.call_count, before, 'Exercise regular recording after startup')
        submitted = [sample for call in recorder.submit.call_args_list for sample in call.args[0]]
        self.assertTrue(any(isinstance(sample, VideoFrame) for sample in submitted))
        self.assertFalse(any(isinstance(sample, VideoFrame) and sample.stream != 'scene' for sample in submitted))
        self.assertTrue(self.command(runtime, 'get_device_status')['acquisition_ready'])

    def test_et10_combined_eye_preview_is_not_reclassified_as_et28_infrared(self):
        runtime = huahong_runtime.HuahongRuntime('HH_ET10C', '/unused-sdk')
        service = ControlledService(runtime.service.capabilities)
        eye = replace(service.frame(), stream='left_eye')
        samples = [eye]
        self.assertIs(runtime._recording_samples(samples), samples)
        runtime._publish_samples(samples)
        self.assertIsNone(runtime.world)
        self.assertEqual(runtime.take_latest(), (eye,))

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg/ffprobe required')
    def test_real_recorder_prepares_encodes_and_finalizes_while_acquisition_continues(self):
        runtime, service = self.make_runtime(service_type=BufferedService)
        self.wait_for_live_samples(runtime)
        original_start = huahong_runtime.PupilRecorder.start
        def delayed_start(recorder):
            service.preparing.set()
            if not service.preparation_drained.wait(1):
                raise RuntimeError('Native queue was not drained during encoder preparation')
            original_start(recorder)
            service.preparing.clear()
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(runtime.paths, 'directory', return_value=Path(directory)), \
                patch.object(huahong_runtime.PupilRecorder, 'start', delayed_start):
            started = self.command(runtime, 'start_recording', project_path='/authorized-project')
            self.command(runtime, 'stop_recording')
            result = runtime.events.get(timeout=5)
            self.assertEqual(result['type'], 'notify_recording_finalized')
            self.assertEqual(result['error'], 0, result)
            self.assertTrue(result['videoVerified'])
            self.assertGreater(result['gazeRows'], 0)
            self.assertGreater(result['outputFrames'], 0)
            self.assertGreater(Path(started['video_path']).stat().st_size, 0)
            self.assertTrue(Path(started['csv_path']).is_file())
            self.assertFalse(service.read_failure.is_set())
            self.assertTrue(self.command(runtime, 'get_device_status')['acquisition_ready'])

    def test_preparation_failure_retains_device_and_finalizes_missing_video(self):
        runtime, service = self.make_runtime()
        self.wait_for_live_samples(runtime)
        recorder = self.recorder(runtime, result={
            'status': 'failed', 'error': 'Encoder executable unavailable',
            'video_path': '/unused-recordings/missing-encoder-video.mp4',
        })
        recorder.start.side_effect = RuntimeError('Encoder executable unavailable')
        response = runtime.request('start_recording', {'project_path': '/authorized-project'}).result(timeout=2)
        self.assertEqual(response['error'], -1)
        result = self.wait_for_finalization(runtime)
        self.assertEqual(result['video_size'], 0)
        self.assertEqual(result['msg'], 'Encoder executable unavailable')
        self.assertEqual(result['error'], -1)
        self.assertTrue(self.command(runtime, 'get_device_status')['acquisition_ready'])
        self.assertFalse(service.closed.is_set())
        self.assertTrue(runtime.events.empty(), 'Rejected start emitted a stale finalization event')

    def test_missing_msgpack_returns_real_error_and_allows_device_stop(self):
        runtime, service = self.make_runtime()
        self.wait_for_live_samples(runtime)
        real_import = builtins.__import__

        def missing_msgpack(name, *args, **kwargs):
            if name == 'msgpack':
                raise ModuleNotFoundError("No module named 'msgpack'", name='msgpack')
            return real_import(name, *args, **kwargs)

        with tempfile.TemporaryDirectory() as directory, \
                patch.object(runtime.paths, 'directory', return_value=Path(directory)), \
                patch('builtins.__import__', side_effect=missing_msgpack):
            response = runtime.request('start_recording', {'project_path': '/authorized-project'}).result(timeout=2)
            self.assertEqual(response['error'], -1)
            self.assertIn('msgpack', response['msg'])
            self.assertNotIn('buffer', response['msg'])
            result = self.wait_for_finalization(runtime)
            self.assertEqual(result['status'], 'failed')
            self.assertIn('msgpack', result['msg'])
            self.assertEqual(list(Path(directory).iterdir()), [])
            self.assertTrue(self.command(runtime, 'get_device_status')['acquisition_ready'])
            self.assertTrue(runtime.verified)
            self.assertTrue(runtime.tracking)
            self.assertTrue(runtime.events.empty(), 'Failed start must not emit accepted-recording finalization')
            self.command(runtime, 'stop')
            self.assertTrue(service.closed.is_set())
            self.assertIsNone(runtime.recorder)
            self.assertIsNone(runtime.finalizer)
            self.assertFalse(runtime.verified)

    def test_encoder_error_is_not_hidden_by_preparation_buffer_overflow(self):
        runtime, service = self.make_runtime(service_type=BufferedService)
        self.wait_for_live_samples(runtime)
        recorder = self.recorder(runtime, result={'status': 'failed', 'error': 'Encoder initialization failed'})
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def prepare():
            service.preparing.set()
            entered.set()
            release.wait(2)
            service.preparing.clear()
            raise RuntimeError('Encoder initialization failed')

        recorder.start.side_effect = prepare
        with patch.object(huahong_runtime, 'RECORDING_PREPARATION_BYTE_LIMIT', 1):
            future = runtime.request('start_recording', {'project_path': '/authorized-project'})
            self.assertTrue(entered.wait(1))
            self.assertTrue(service.preparation_drained.wait(1))
            release.set()
            response = future.result(timeout=2)
        self.assertEqual(response['error'], -1)
        self.assertEqual(response['msg'], 'Encoder initialization failed')
        self.assertFalse(recorder.submit.called)
        self.assertEqual(self.wait_for_finalization(runtime)['error'], -1)
        self.assertTrue(self.command(runtime, 'get_device_status')['acquisition_ready'])
        self.command(runtime, 'stop')

    def test_preparation_overflow_fails_recording_but_continues_draining_native_queue(self):
        runtime, service = self.make_runtime(service_type=BufferedService)
        self.wait_for_live_samples(runtime)
        recorder = self.recorder(runtime, result={'status': 'failed', 'error': 'Recording preparation buffer byte limit exceeded'})
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def prepare():
            service.preparing.set()
            entered.set()
            release.wait(2)
            service.preparing.clear()
        recorder.start.side_effect = prepare
        with patch.object(huahong_runtime, 'RECORDING_PREPARATION_BYTE_LIMIT', 1100):
            future = runtime.request('start_recording', {'project_path': '/authorized-project'})
            self.assertTrue(entered.wait(1))
            self.assertTrue(service.preparation_drained.wait(1))
            self.assertFalse(service.read_failure.is_set())
            release.set()
            response = future.result(timeout=2)
        self.assertEqual(response['error'], -1)
        self.assertIn('preparation buffer byte limit', response['msg'])
        self.assertFalse(recorder.submit.called, 'Overflowed pre-roll was silently accepted')
        result = self.wait_for_finalization(runtime)
        self.assertEqual(result['error'], -1)
        self.assertTrue(self.command(runtime, 'get_device_status')['acquisition_ready'])
        self.assertTrue(runtime.events.empty(), 'Rejected overflow emitted a stale finalization event')

    def test_preparation_deadline_never_accepts_late_ready_encoder(self):
        for deadline in (.02, 0):
            with self.subTest(deadline=deadline):
                runtime, service = self.make_runtime(service_type=BufferedService)
                self.wait_for_live_samples(runtime)
                recorder = self.recorder(runtime, result={'status': 'failed', 'error': 'Recording preparation timed out'})
                entered, release = threading.Event(), threading.Event()
                self.addCleanup(release.set)
                def prepare():
                    service.preparing.set()
                    entered.set()
                    if deadline:
                        release.wait(2)
                    service.preparing.clear()
                recorder.start.side_effect = prepare
                with patch.object(huahong_runtime, 'RECORDING_PREPARATION_TIMEOUT_S', deadline):
                    future = runtime.request('start_recording', {'project_path': '/authorized-project'})
                    self.assertTrue(entered.wait(1))
                    if deadline:
                        self.assertTrue(service.preparation_drained.wait(1))
                        self.assertFalse(service.read_failure.is_set())
                    release.set()
                    response = future.result(timeout=2)
                self.assertEqual(response['error'], -1)
                self.assertIn('preparation timed out', response['msg'])
                self.assertFalse(recorder.submit.called)
                self.assertEqual(self.wait_for_finalization(runtime)['error'], -1)
                self.assertTrue(runtime.events.empty())
                self.assertTrue(self.command(runtime, 'get_device_status')['acquisition_ready'])

    def test_shutdown_during_preparation_joins_helper_and_finalizes_recording(self):
        runtime, service = self.make_runtime()
        self.wait_for_live_samples(runtime)
        recorder = self.recorder(runtime)
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def prepare():
            entered.set()
            release.wait(2)
        recorder.start.side_effect = prepare
        future = runtime.request('start_recording', {'project_path': '/authorized-project'})
        self.assertTrue(entered.wait(1))
        closer = threading.Thread(target=runtime.close)
        closer.start()
        self.assertTrue(runtime._stop.wait(1))
        release.set()
        self.assertEqual(future.result(timeout=2)['error'], -1)
        closer.join(2)
        self.assertFalse(closer.is_alive())
        self.assertFalse(runtime._thread.is_alive())
        self.assertTrue(service.closed.is_set())
        self.assertEqual(recorder.finish.call_count, 1)
        self.assertIn('Service shutdown', recorder.finish.call_args.kwargs['error'])
        self.assertFalse(any(thread.name == 'huahong-recorder-prepare' for thread in threading.enumerate()))

    def test_encoder_failure_finalizes_recording_and_preserves_live_device(self):
        runtime, service = self.make_runtime()
        generation = runtime.calibration_generation
        recorder = Mock()
        recorder.timeline = SimpleNamespace(fps=30, t0=time.monotonic())
        fail_submit = threading.Event()
        def submit(*_args):
            if fail_submit.is_set():
                raise RuntimeError('Recording queue byte limit exceeded')
        recorder.submit.side_effect = submit
        recorder.finish.return_value = {
            'status': 'failed', 'error': 'Recording queue byte limit exceeded',
        }

        def create_recorder(directory, name, _world, **_kwargs):
            recorder.name = name
            recorder.video_path = directory / (name + '.mp4')
            recorder.csv_path = directory / (name + '.csv')
            return recorder

        with patch.object(runtime.paths, 'directory', return_value=Path('/unused-recordings')), \
                patch.object(huahong_runtime, 'PupilRecorder', side_effect=create_recorder):
            # A round trip ensures at least one live sample has been read.
            self.command(runtime, 'get_device_status')
            self.command(runtime, 'get_device_status')
            started = self.command(runtime, 'start_recording', project_path='/authorized-project')
            fail_submit.set()
            result = runtime.events.get(timeout=2)
            self.assertEqual(result['type'], 'notify_recording_finalized', result)
            self.assertEqual(result['recording_id'], started['recording_id'])
            self.assertEqual(result['error'], -1)
            self.assertIn('queue byte limit', result['msg'])
            self.assertEqual(self.command(runtime, 'get_recording_status')['status'], 'finalized')
            self.assertTrue(self.command(runtime, 'get_device_status')['acquisition_ready'])
            self.assertFalse(service.closed.is_set())
            self.assertTrue(runtime.verified)
            self.assertTrue(runtime.tracking)
            self.assertEqual(runtime.token, 'completed-current-calibration')
            self.assertEqual(runtime.calibration_generation, generation)
            self.assertTrue(any(sample.stream == 'scene' for sample in runtime.take_latest()
                                if hasattr(sample, 'stream')))
            recorder.finish.assert_called_once_with(error='Recording queue byte limit exceeded')
            self.assertTrue(runtime.events.empty(), 'Recording failure became a device failure')

    def test_real_acquisition_failure_still_closes_device_and_invalidates_calibration(self):
        runtime, service = self.make_runtime()
        service.read_failure.set()
        result = runtime.events.get(timeout=2)
        self.assertEqual(result['type'], 'notify_device_error')
        self.assertTrue(service.closed.wait(2))
        self.assertFalse(runtime.verified)
        self.assertFalse(runtime.tracking)
        self.assertEqual(runtime.token, '')

    def test_desktop_capture_failure_finalizes_without_reporting_device_loss(self):
        runtime, service = self.make_runtime('HH_ET10C')
        recorder = Mock()
        recorder.timeline = SimpleNamespace(fps=30, t0=time.monotonic())
        recorder.finish.return_value = {'status': 'failed', 'error': 'Screen capture failed'}

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
        fail_capture = threading.Event()
        def capture():
            if fail_capture.is_set():
                raise OSError('Screen capture failed')
            return service.frame()
        with patch.object(runtime.paths, 'directory', return_value=Path('/unused-recordings')), \
                patch.object(huahong_runtime, 'PupilRecorder', side_effect=create_recorder), \
                patch.object(runtime, 'capture_screen', side_effect=capture), \
                patch.dict('sys.modules', {'mss': SimpleNamespace(mss=lambda: screen)}):
            self.command(runtime, 'get_device_status')
            self.command(runtime, 'get_device_status')
            self.command(runtime, 'start_recording', project_path='/authorized-project')
            fail_capture.set()
            result = runtime.events.get(timeout=2)
            self.assertEqual(result['type'], 'notify_recording_finalized', result)
            self.assertEqual(result['error'], -1)
            self.assertIn('Screen capture failed', result['msg'])
            self.assertTrue(self.command(runtime, 'get_device_status')['acquisition_ready'])
            self.assertTrue(runtime.verified)
            self.assertTrue(runtime.tracking)
            self.assertFalse(service.closed.is_set())
            recorder.finish.assert_called_once_with(error='Screen capture failed')
            screen.close.assert_called_once_with()


if __name__ == '__main__':
    unittest.main()
