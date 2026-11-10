import ctypes as C
import builtins
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from services.eye_tracking.adapters.huahong.et28_eye_preview import ET28EyePreview
from services.eye_tracking.adapters.huahong.service import HuahongService
from services.eye_tracking.adapters.huahong.vendor import et28_dll as binding


class ET28EyePreviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        dll = root / 'et28/bin/windows/x64'
        dll.mkdir(parents=True)
        (dll / 'et28_interface.dll').touch()
        self.lib = Mock()
        for name in ('et28_device_init', 'et28_device_connect', 'et28_setCamera_para',
                     'et28_setIrLedBrightness', 'et28_startCamera', 'et28_stopCamera',
                     'et28_device_disconnect', 'et28_device_deinit'):
            getattr(self.lib, name).return_value = 0
        self.lib.et28_getGzSdkVersion.return_value = b'preview-test'

        def parameters(array, capacity, count):
            C.cast(count, C.POINTER(C.c_uint32))[0] = 1
            array[0].m_worldWidth, array[0].m_worldHeight = 1920, 1080
            array[0].m_worldCameraCropType = 1
            array[0].m_irOneEyeWidth, array[0].m_irOneEyeHeight = 2, 2
            return 0

        self.lib.et28_getCamera_para.side_effect = parameters
        self.service = HuahongService('HH_ET28', root)
        self.connect()

    def connect(self):
        self.service.generation += 1
        self.service.state = 'connecting'
        with patch.object(binding, 'library', return_value=self.lib), patch.dict('os.environ', {}, clear=False):
            self.service._connect_et28()
        self.service.state = 'ready'
        self.service._last_frame = time.monotonic()
        self.eye_callback = self.lib.et28_registerEyeCameraCb.call_args.args[0]
        self.scene_callback = self.lib.et28_registerWorldCameraCb.call_args.args[0]

    @staticmethod
    def buffer():
        # Native rows contain [left-eye pixels, right-eye pixels], per sample.
        return (C.c_uint8 * 8)(11, 12, 21, 22, 13, 14, 23, 24)

    @staticmethod
    def scene_buffer():
        buffer = (C.c_uint8 * (1920 * 1080 * 3))()
        C.memmove(buffer, bytes(range(24)), 24)
        return buffer

    def test_registered_ctypes_callback_copies_native_pixels_and_labels_each_eye(self):
        self.assertIsInstance(self.eye_callback, binding.CameraCallback)
        self.assertTrue(any(callback is self.eye_callback for callback in self.service.callbacks))
        self.assertEqual(self.service.capabilities.video_streams, ('scene', 'left_eye', 'right_eye'))
        operations = [call[0] for call in self.lib.mock_calls]
        self.assertLess(operations.index('et28_registerEyeCameraCb'), operations.index('et28_startCamera'))
        buffer = self.buffer()
        self.eye_callback(None, buffer, len(buffer))
        for i in range(len(buffer)):
            buffer[i] = 255
        left, right = self.service.read(0)
        for frame, eye, values in ((left, 'left_eye', (11, 12, 13, 14)),
                                   (right, 'right_eye', (21, 22, 23, 24))):
            self.assertEqual((frame.stream, frame.identity.topic), (eye, eye))
            self.assertEqual((frame.width, frame.height, frame.pixel_format), (2, 2, 'bgr'))
            self.assertEqual(frame.pixels, bytes(value for value in values for _ in range(3)))
            self.assertEqual(frame.identity.source, 'HH_ET28')
            self.assertEqual(frame.identity.generation, self.service.generation)
        self.assertEqual(left.identity.source_time_s, right.identity.source_time_s)
        self.assertEqual(self.service.read(0), [])

    def test_native_rate_only_keeps_latest_pair_without_recording_queue_pressure(self):
        self.service.byte_limit = 1
        old_scene_time = self.service._last_frame
        buffer = self.buffer()
        for i in range(600):
            buffer[0] = i % 256
            self.eye_callback(None, buffer, len(buffer))
        self.assertEqual(self.service.queued_bytes, 0)
        self.assertTrue(self.service.samples.empty())
        self.assertEqual(self.service.failure, '')
        self.assertEqual(self.service._last_frame, old_scene_time)
        self.assertEqual(self.service.last_gaze, 0)
        frames = self.service.read(0)
        self.assertEqual(len(frames), 2)
        self.assertEqual(frames[0].pixels[0], 599 % 256)
        self.assertEqual(frames[0].identity.received_sequence, 600)

    def test_malformed_preview_drops_safely_keeps_last_good_pair_and_recovers(self):
        buffer = self.buffer()
        self.eye_callback(None, buffer, len(buffer))
        with self.assertLogs(level='WARNING') as logged:
            self.eye_callback(None, None, len(buffer))
            self.eye_callback(None, buffer, len(buffer) - 1)
            self.eye_callback(None, buffer, len(buffer) + 1)
            self.eye_callback(None, buffer, 0)
        self.assertEqual(len(logged.records), 1, 'Invalid native frames must not flood the log')
        self.assertEqual(self.service.failure, '')
        self.assertEqual(self.service.read(0)[0].pixels[0], 11)
        buffer[0] = 17
        self.eye_callback(None, buffer, len(buffer))
        with patch('services.eye_tracking.adapters.huahong.et28_eye_preview.time.monotonic', return_value=time.monotonic() + .1):
            self.assertEqual(self.service.read(0)[0].pixels[0], 17)

    def test_preview_conversion_is_limited_to_twenty_hz_and_pending_pair_stays_latest(self):
        buffer = self.buffer()
        with patch('services.eye_tracking.adapters.huahong.et28_eye_preview.time.monotonic', return_value=100) as clock:
            self.eye_callback(None, buffer, len(buffer))
            self.assertEqual(self.service._eye_preview.take()[0].pixels[0], 11)
            buffer[0] = 31
            self.eye_callback(None, buffer, len(buffer))
            clock.return_value = 100.049
            self.assertEqual(self.service._eye_preview.take(), [])
            buffer[0] = 43
            self.eye_callback(None, buffer, len(buffer))
            clock.return_value = 100.05
            self.assertEqual(self.service._eye_preview.take()[0].pixels[0], 43)
            self.assertEqual(self.service._eye_preview.take(), [])

    def test_invalid_dimensions_rejected_before_native_pointer_access(self):
        for dimensions in ((0, 2), (2, 0), (-1, 2), (8193, 1), (2, 8193), (8192, 8192)):
            with self.subTest(dimensions=dimensions), self.assertRaisesRegex(ValueError, 'dimensions'):
                ET28EyePreview(*dimensions, self.service.identity)

    def test_ir_never_replaces_scene_frame_or_makes_stalled_scene_healthy(self):
        buffer = self.buffer()
        self.service._last_frame = time.monotonic() - 4
        self.eye_callback(None, buffer, len(buffer))
        with self.assertRaisesRegex(RuntimeError, 'Camera stopped'):
            self.service.read(0)
        scene_pixels = self.scene_buffer()
        self.scene_callback(None, scene_pixels, len(scene_pixels))
        frames = {frame.stream: frame for frame in self.service.read(0)}
        self.assertEqual(set(frames), {'scene', 'left_eye', 'right_eye'})
        self.assertEqual(frames['scene'].pixels, bytes(scene_pixels))
        self.assertEqual((frames['scene'].width, frames['scene'].height), (1920, 1080))
        self.assertEqual(self.service.shape, (1920, 1080))
        self.assertEqual(self.service.queued_bytes, 0)

    def test_close_clears_pending_pair_and_old_callback_cannot_pollute_reconnect(self):
        old_callback = self.eye_callback
        buffer = self.buffer()
        old_callback(None, buffer, len(buffer))
        old_preview = self.service._eye_preview
        self.service.close()
        self.assertEqual(old_preview.take(), [])
        old_callback(None, buffer, len(buffer))
        self.assertEqual(old_preview.take(), [])
        self.assertEqual(self.service.read(0), [])
        self.connect()
        old_callback(None, buffer, len(buffer))
        self.assertEqual(self.service.read(0), [])
        self.eye_callback(None, buffer, len(buffer))
        frames = self.service.read(0)
        self.assertEqual(len(frames), 2)
        self.assertEqual(frames[0].identity.generation, 2)

    def test_eye_arriving_during_empty_scene_queue_wait_is_delivered(self):
        buffer = self.buffer()
        timer = threading.Timer(.01, self.eye_callback, args=(None, buffer, len(buffer)))
        timer.start()
        try:
            self.assertEqual([frame.stream for frame in self.service.read(100)], ['left_eye', 'right_eye'])
        finally:
            timer.join(1)

    def test_slow_eye_callback_does_not_block_scene_reader_or_preview_close(self):
        preview = self.service._eye_preview
        entered, release, completed = threading.Event(), threading.Event(), threading.Event()
        identity = preview.identity

        def slow_identity(topic):
            entered.set()
            release.wait(2)
            return identity(topic)

        preview.identity = slow_identity
        buffer = self.buffer()
        callback = threading.Thread(target=self.eye_callback, args=(None, buffer, len(buffer)))
        scene_pixels = self.scene_buffer()
        self.scene_callback(None, scene_pixels, len(scene_pixels))
        frames = []

        def read_and_close():
            frames.extend(self.service.read(0))
            preview.close()
            completed.set()

        callback.start()
        reader = threading.Thread(target=read_and_close)
        try:
            self.assertTrue(entered.wait(1))
            reader.start()
            remained_responsive = completed.wait(.5)
        finally:
            release.set()
            callback.join(2)
            if reader.ident is not None:
                reader.join(2)
        self.assertTrue(remained_responsive, 'Optional IR callback blocked scene/control owner')
        self.assertEqual([frame.stream for frame in frames], ['scene'])
        self.assertEqual(preview.take(), [], 'Late eye callback revived closed preview')

    def test_busy_preview_slot_does_not_block_scene_acquisition(self):
        self.service._eye_preview._lock.acquire()
        completed = threading.Event()
        frames = []
        scene_pixels = self.scene_buffer()
        self.scene_callback(None, scene_pixels, len(scene_pixels))

        def read():
            frames.extend(self.service.read(0))
            completed.set()

        reader = threading.Thread(target=read)
        reader.start()
        try:
            remained_responsive = completed.wait(.5)
        finally:
            self.service._eye_preview._lock.release()
            reader.join(2)
        self.assertTrue(remained_responsive)
        self.assertEqual([frame.stream for frame in frames], ['scene'])

    def test_native_size_preview_works_without_loading_scientific_runtime(self):
        preview = ET28EyePreview(400, 400, self.service.identity)
        row = bytes(range(200)) * 2 + bytes(range(200, 256)) * 7 + bytes(range(200, 208))
        self.assertEqual(len(row), 800)
        raw = row * 400
        buffer = (C.c_uint8 * len(raw)).from_buffer_copy(raw)
        real_import = builtins.__import__

        def no_scientific_runtime(name, *args, **kwargs):
            if name.split('.')[0] in ('numpy', 'cv2'):
                raise AssertionError('IR preview imported a native scientific runtime during acquisition')
            return real_import(name, *args, **kwargs)

        with patch('builtins.__import__', side_effect=no_scientific_runtime):
            preview.callback(None, buffer, len(buffer))
            left, right = preview.take()
        for frame, gray in ((left, row[:400]), (right, row[400:])):
            self.assertEqual((frame.width, frame.height), (400, 400))
            self.assertEqual(frame.pixels, bytes(value for value in gray * 400 for _ in range(3)))

    def test_et10_keeps_existing_single_eye_capability(self):
        service = HuahongService('HH_ET10C', '/missing')
        self.assertEqual(service.capabilities.video_streams, ('left_eye',))
        self.assertIsNone(service._eye_preview)


if __name__ == '__main__':
    unittest.main()
