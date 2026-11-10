"""Actual UVC image shapes must match the intrinsics before data is produced."""
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from services.eye_tracking.adapters.pupil_native.worker import camera_loop


class NativeFrameDimensionTests(unittest.TestCase):
    def run_camera(self, role=0, *, cam1=False, gray_shape=None, bgr_shape=None, error=None):
        import pupil_detectors
        import pye3d.detector_3d
        import uvc

        size = (1280, 720) if role == 2 else (320, 240) if cam1 else (192, 192)
        gray = np.zeros(gray_shape or (size[1], size[0]), dtype=np.uint8)
        bgr = np.zeros(bgr_shape or (size[1], size[0], 3), dtype=np.uint8)
        frame = SimpleNamespace(timestamp=uvc.get_time_monotonic(), index=1, gray=gray, bgr=bgr)

        class Camera:
            frame_sizes = [size]
            frame_rates = [30, 120]
            controls = []
            closed = False

            def get_frame(self, timeout):
                # Match acquisition timing after imports and detector setup.
                frame.timestamp = uvc.get_time_monotonic()
                return frame

            def close(self):
                self.closed = True

        devices = [{'name': f'Pupil Cam{1 if cam1 else 2} ID{i}', 'uid': str(i)} for i in (0, 1)]
        devices.append({'name': 'Pupil Cam1 ID2', 'uid': '2'})
        camera, stop, packets = Camera(), threading.Event(), []

        def emit(packet):
            packets.append(packet)
            if packet['kind'] == 'data':
                stop.set()

        with patch.object(uvc, 'device_list', return_value=devices), \
                patch.object(uvc, 'Capture', return_value=camera), \
                patch.object(pupil_detectors, 'Detector2D') as detector_2d, \
                patch.object(pye3d.detector_3d, 'Detector3D') as detector_3d:
            location = [size[0] / 4, size[1] / 4]
            detection = {'location': location, 'diameter': 40., 'confidence': .95,
                         'ellipse': {'center': location, 'axes': [30., 40.]}}
            detector_2d.return_value.detect.side_effect = lambda _: dict(detection)
            detector_3d.return_value.update_and_detect.side_effect = lambda *_: dict(detection)
            task = {'role': role, 'eye_fps': 120, 'world_fps': 30}
            if error:
                with self.assertRaisesRegex(ValueError, error):
                    camera_loop(task, stop, emit)
                detector_2d.return_value.detect.assert_not_called()
                detector_3d.return_value.update_and_detect.assert_not_called()
                self.assertFalse(any(packet['kind'] == 'data' for packet in packets))
            else:
                camera_loop(task, stop, emit)
                if role != 2:
                    detector_2d.return_value.detect.assert_called_once()
                    self.assertIs(detector_2d.return_value.detect.call_args.args[0], gray)
                else:
                    detector_2d.assert_not_called()
                    detector_3d.assert_not_called()
        self.assertTrue(camera.closed, 'Camera is released on success and on shape errors')
        return packets, size

    def test_actual_eye_shape_supplies_measurement_dimensions_and_normalization(self):
        for role, cam1 in ((0, True), (1, False)):
            with self.subTest(role=role, cam1=cam1):
                packets, size = self.run_camera(role, cam1=cam1)
                items = packets[-1]['items']
                for item in items[:2]:
                    self.assertEqual(item['payload']['eye_resolution'], list(size))
                    self.assertEqual(item['payload']['norm_pos'], [.25, .75])
                preview = items[2]
                self.assertEqual((preview['payload']['width'], preview['payload']['height']), size)
                self.assertEqual(len(preview['pixels']), size[0] * size[1] * 3)

    def test_wrong_eye_gray_shape_stops_before_detection_or_measurement_publication(self):
        for shape in ((240, 319), (320, 240), (240, 320, 1)):
            with self.subTest(shape=shape):
                self.run_camera(cam1=True, gray_shape=shape,
                                error=r'Camera ID0 gray frame shape .* configured intrinsics/image shape')

    def test_wrong_eye_preview_shape_stops_before_detection_or_data_publication(self):
        for shape in ((192, 191, 3), (192, 192, 4), (192, 192)):
            with self.subTest(shape=shape):
                self.run_camera(bgr_shape=shape,
                                error=r'Camera ID0 bgr frame shape .* configured intrinsics/image shape')

    def test_world_shape_is_checked_before_declaring_frame_dimensions(self):
        packets, size = self.run_camera(2)
        item = packets[-1]['items'][0]
        self.assertEqual(item['payload']['topic'], 'frame.world')
        self.assertEqual((item['payload']['width'], item['payload']['height']), size)
        self.assertEqual(len(item['pixels']), size[0] * size[1] * 3)
        for shape in ((720, 1279, 3), (1280, 720, 3), (720, 1280, 4)):
            with self.subTest(shape=shape):
                self.run_camera(2, bgr_shape=shape,
                                error=r'Camera ID2 bgr frame shape .* configured intrinsics/image shape')


if __name__ == '__main__':
    unittest.main()
