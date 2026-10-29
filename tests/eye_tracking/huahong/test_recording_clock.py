"""Host clock resolution must not turn distinct native frames into duplicates."""
import csv
import json
from pathlib import Path
import shutil
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from services.eye_tracking.adapters.huahong.service import HuahongService
from services.eye_tracking.application.huahong_runtime import HuahongRuntime
from services.eye_tracking.domain.contracts import EyeTrackingError
from services.eye_tracking.domain.samples import GazeSample, VideoFrame
from services.eye_tracking.domain.timeline import FrameTimeline
from services.eye_tracking.infrastructure.pupil_recorder import PupilRecorder


class RecordingClockTests(unittest.TestCase):
    def test_distinct_callbacks_with_equal_receive_ticks_keep_precise_source_times(self):
        service = HuahongService('HH_ET28', '/unused-sdk')
        clock = SimpleNamespace(monotonic=lambda: 100.0, perf_counter=Mock(side_effect=(1000.0, 1000.004)))
        with patch('services.eye_tracking.adapters.huahong.service.time', clock):
            first, second = service.identity('scene'), service.identity('scene')
        self.assertEqual((first.received_monotonic_s, second.received_monotonic_s), (100.0, 100.0))
        self.assertEqual((first.source_time_s, second.source_time_s), (1000.0, 1000.004))
        self.assertEqual((first.received_sequence, second.received_sequence), (1, 2))
        scene = lambda identity: VideoFrame(identity, 'scene', 2, 2, 'bgr', bytes(12), None)
        timeline = FrameTimeline(scene(first))
        timeline.initial()
        timeline.push(scene(second))

    def test_recording_markers_and_stimuli_use_source_clock_not_receive_clock(self):
        runtime = HuahongRuntime('HH_ET28', '/unused-sdk')
        recorder = Mock()
        recorder.timeline = SimpleNamespace(t0=1000.0)
        runtime.recorder = recorder
        clock = SimpleNamespace(monotonic=lambda: 100.5, perf_counter=lambda: 1000.5)
        with patch('services.eye_tracking.application.huahong_runtime.time', clock):
            runtime._command('set_stimulus', {'name': 'material'})
            response = runtime._command('add_custom_marker', {'name': 'mark'})
        recorder.set_stimulus.assert_called_once_with('material', 1000.5)
        self.assertEqual(response['marker']['timestamp'], 500.0)
        self.assertEqual(response['marker']['videoTime'], 500.0)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg/ffprobe required')
    def test_real_recording_drains_startup_frames_with_equal_receive_clock_ticks(self):
        service = HuahongService('HH_ET28', '/unused-sdk')
        receive_time = time.monotonic()
        clock = SimpleNamespace(monotonic=lambda: receive_time,
                                perf_counter=Mock(side_effect=(1000.0, 1000.004, 1000.020, 1000.040)))
        with patch('services.eye_tracking.adapters.huahong.service.time', clock):
            identities = [service.identity(topic) for topic in ('scene', 'scene', 'gaze', 'scene')]
        frames = [VideoFrame(identities[index], 'scene', 16, 16, 'bgr', bytes([0, 0, 255]) * 256, None)
                  for index in (0, 1, 3)]
        gaze = GazeSample(identities[2], (.5, .5), 'world_normalized_top_left', None, True, ('left',))
        service.state = 'ready'
        service.tracking_started = receive_time - .1
        service._last_frame = receive_time
        for sample in (frames[1], gaze, frames[2]):
            service.push(sample)
        runtime = HuahongRuntime('HH_ET28', '/unused-sdk')
        runtime.service, runtime.world = service, frames[0]
        runtime.verified = runtime.tracking = True
        drained = threading.Event()
        original_read, original_start = service.read, PupilRecorder.start

        def read(timeout_ms):
            samples = original_read(timeout_ms)
            if samples:
                drained.set()
            return samples

        def start(recorder):
            if not drained.wait(1):
                raise RuntimeError('Recording startup did not drain acquisition')
            original_start(recorder)

        with tempfile.TemporaryDirectory() as directory, \
                patch.object(runtime.paths, 'directory', return_value=Path(directory)), \
                patch.object(service, 'read', side_effect=read), \
                patch.object(PupilRecorder, 'start', start):
            runtime._command('start_recording', {'project_path': '/authorized-project'})
            recorder = runtime.recorder
            try:
                result = recorder.finish()
                self.assertEqual(result['status'], 'complete', result)
                self.assertTrue(result['videoVerified'])
                self.assertEqual(result['outputFrames'], 3)
                self.assertEqual(result['gazeRows'], 1)
                self.assertEqual(result['sourceInfo']['sourceClock'], 'time.perf_counter')
                self.assertEqual(result['sourceInfo']['receiveClock'], 'time.monotonic')
                with (recorder.sidecar / 'frame-map.csv').open(newline='') as handle:
                    mapping = list(csv.DictReader(handle))
                self.assertEqual([float(row['source_timestamp_s']) for row in mapping], [1000.0, 1000.004, 1000.040])
                self.assertEqual([int(row['receive_sequence']) for row in mapping], [1, 2, 4])
                normalized = json.loads((recorder.sidecar / 'normalized-samples.jsonl').read_text())
                self.assertEqual(normalized['identity']['received_monotonic_s'], receive_time)
                self.assertEqual(normalized['identity']['source_time_s'], 1000.020)
            finally:
                recorder.finish()
                runtime.recorder = None

    def test_invalid_frame_time_errors_preserve_strict_validation_and_identify_pair(self):
        service = HuahongService('HH_ET28', '/unused-sdk')
        for stamp, reason in ((1000.0, 'repeated'), (999.9, 'regressed'), (1000.6, 'gap'), (float('nan'), 'nonfinite')):
            with self.subTest(reason=reason):
                clock = SimpleNamespace(monotonic=lambda: 100.0, perf_counter=Mock(side_effect=(1000.0, stamp)))
                with patch('services.eye_tracking.adapters.huahong.service.time', clock):
                    first, second = service.identity('scene'), service.identity('scene')
                make_frame = lambda identity: VideoFrame(identity, 'scene', 2, 2, 'bgr', bytes(12), None)
                timeline = FrameTimeline(make_frame(first))
                with self.assertRaises(EyeTrackingError) as raised:
                    timeline.push(make_frame(second))
                message = str(raised.exception)
                self.assertIn('reason=' + reason, message)
                self.assertIn('source=HH_ET28', message)
                self.assertIn('previous_sequence=' + str(first.received_sequence), message)
                self.assertIn('current_sequence=' + str(second.received_sequence), message)
                self.assertIn('previous_time=', message)
                self.assertIn('current_time=', message)
                self.assertIn('delta_s=', message)
