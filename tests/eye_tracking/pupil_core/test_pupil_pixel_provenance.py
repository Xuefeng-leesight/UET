"""Independent detected 2D pixels, model projections and 3D measurements."""
import copy
import json
import threading
import unittest
from unittest.mock import patch

import numpy as np

from services.eye_tracking.adapters.pupil_core.data_normalizer import DataNormalizer
from services.eye_tracking.adapters.pupil_native.source import message
from services.eye_tracking.adapters.pupil_native.worker import camera_loop
from services.eye_tracking.infrastructure.pupil_csv import gaze_csv_row
from services.eye_tracking.transport.pupil_protocol import gaze_message


def native_pupil(confidence_2d=.95, confidence_3d=.95):
    return dict(topic='pupil.0.3d', id=0, timestamp=10., method='3d pye3d',
                native_source=True, confidence=confidence_3d, confidence_2d=confidence_2d, eye_resolution=[200, 100],
                model_confidence=1., sphere={'center': [0, 0, 30]},
                circle_3d={'center': [0, 0, 20], 'normal': [0, 0, -1]},
                diameter=40., diameter_3d=3., projected_diameter_px=42.,
                ellipse_2d={'center': [20., 30.], 'axes': [30., 40.]},
                ellipse={'center': [22., 33.], 'axes': [32., 42.]}, location=[22., 33.])


def outputs(pupil):
    payload = dict(topic='gaze.3d.0.', timestamp=pupil['timestamp'], norm_pos=[.5, .5],
                   confidence=pupil['confidence'], base_data=[pupil], native_source=True)
    sample = DataNormalizer().normalize(message(payload), 1, 1)
    return sample, gaze_csv_row(sample, 0), json.loads(gaze_message(sample))['eye_data']


class PupilPixelProvenanceTests(unittest.TestCase):
    def test_camera_worker_preserves_independent_confidences_through_csv_and_live(self):
        import pupil_detectors
        import pye3d.detector_3d
        import uvc

        class Camera:
            frame_sizes = [(192, 192)]
            frame_rates = [120]
            controls = []
            closed = False

            def get_frame(self, timeout):
                class Frame:
                    timestamp = uvc.get_time_monotonic()
                    index = 1
                    gray = np.zeros((192, 192), dtype=np.uint8)
                    bgr = np.zeros((192, 192, 3), dtype=np.uint8)
                return Frame()

            def close(self):
                self.closed = True

        devices = [{'name': f'Pupil Cam3 ID{i}', 'uid': str(i)} for i in range(3)]
        for confidence_2d, confidence_3d in ((.2, .6), (.95, .1)):
            with self.subTest(confidence_2d=confidence_2d, confidence_3d=confidence_3d):
                source = native_pupil(confidence_2d, confidence_3d)
                detection_2d = dict(location=[20., 30.], confidence=confidence_2d,
                                    ellipse=source['ellipse_2d'], diameter=40.)
                detection_3d = {key: value for key, value in source.items()
                                if key not in ('ellipse_2d', 'confidence_2d', 'projected_diameter_px')}
                detection_3d['diameter'] = 42.
                camera, stop, packets = Camera(), threading.Event(), []

                def emit(packet):
                    packets.append(packet)
                    if packet['kind'] == 'data':
                        stop.set()

                with patch.object(uvc, 'device_list', return_value=devices), \
                        patch.object(uvc, 'Capture', return_value=camera), \
                        patch.object(pupil_detectors, 'Detector2D') as detector_2d, \
                        patch.object(pye3d.detector_3d, 'Detector3D') as detector_3d:
                    detector_2d.return_value.detect.return_value = copy.deepcopy(detection_2d)
                    detector_3d.return_value.update_and_detect.return_value = copy.deepcopy(detection_3d)
                    camera_loop({'role': 0, 'eye_fps': 120, 'world_fps': 30}, stop, emit)
                self.assertTrue(camera.closed)
                pupil = packets[1]['items'][1]['payload']
                self.assertEqual(pupil['confidence'], confidence_3d)
                self.assertEqual(pupil['confidence_2d'], confidence_2d)
                self.assertEqual(pupil['diameter'], 40.)
                self.assertEqual(pupil['projected_diameter_px'], 42.)
                sample, row, live = outputs(pupil)
                self.assertEqual(row['right_pupil_confidence'], confidence_3d)
                self.assertEqual(row['right_pupil_pixel_confidence'], confidence_2d)
                self.assertEqual(row['right_pupil_pixel_source'], 'detected_2d_ellipse')
                self.assertEqual(row['right_pupil_raw_diameter_px'], 40.)
                self.assertEqual(row['right_pupil_raw_projected_diameter_px'], 42.)
                self.assertEqual(row['right_pupil_raw_diameter_mm'], 3.)
                if confidence_2d < .6:
                    self.assertEqual(row['right_pupil_pixel_valid'], 0)
                    self.assertEqual(row['right_pupil_diameter_px'], '')
                    self.assertEqual(row['right_pupil_center_x'], '')
                    self.assertEqual(row['right_pupil_minor_axis'], '')
                    self.assertEqual(row['right_pupil_diameter_mm'], 3.)
                    self.assertEqual(row['right_pupil_projected_diameter_px'], 42.)
                    self.assertIsNone(live['r_pupil']['dia'])
                    self.assertIsNone(live['r_pupil']['center'])
                    self.assertEqual(live['r_pupil']['dia_mm'], 3.)
                else:
                    self.assertEqual(row['right_pupil_pixel_valid'], 1)
                    self.assertEqual(row['right_pupil_valid'], 0)
                    self.assertEqual(row['right_pupil_diameter_px'], 40.)
                    self.assertEqual(row['right_pupil_center_x'], 20 / 192)
                    self.assertEqual(row['right_pupil_minor_axis'], 30 / 192)
                    self.assertEqual(row['right_pupil_diameter_mm'], '')
                    self.assertEqual(row['right_pupil_projected_diameter_px'], '')
                    self.assertEqual(live['r_pupil']['dia'], 40.)
                    self.assertIsNone(live['r_pupil']['dia_mm'])
                    self.assertNotIn('r_gaze', live)

    def test_legacy_native_keeps_pixels_with_explicitly_unknown_independent_quality(self):
        pupil = native_pupil()
        pupil.pop('confidence_2d')
        pupil.pop('projected_diameter_px')
        sample, row, live = outputs(pupil)
        self.assertIsNone(sample.pupils[0].pixel_valid)
        self.assertIsNone(sample.pupils[0].pixel_confidence)
        self.assertEqual(row['right_pupil_pixel_valid'], '')
        self.assertEqual(row['right_pupil_pixel_confidence'], '')
        self.assertEqual(row['right_pupil_diameter_px'], 40.)
        self.assertEqual(row['right_pupil_projected_diameter_px'], '')
        self.assertEqual(row['right_pupil_raw_projected_diameter_px'], '')
        self.assertIsNone(live['r_pupil']['pixel_valid'])

    def test_capture_pye3d_pixels_are_model_projection_with_model_quality(self):
        pupil = native_pupil()
        for key in ('ellipse_2d', 'confidence_2d', 'projected_diameter_px', 'native_source'):
            pupil.pop(key)
        pupil['diameter'] = 42.
        _, row, live = outputs(pupil)
        self.assertEqual(row['right_pupil_pixel_source'], 'pye3d_projected_ellipse')
        self.assertEqual(row['right_pupil_center_x'], 22 / 200)
        self.assertEqual(row['right_pupil_diameter_px'], 42.)
        pupil['model_confidence'] = .1
        _, row, live = outputs(pupil)
        self.assertEqual(row['right_pupil_pixel_valid'], 0)
        self.assertEqual(row['right_pupil_raw_diameter_px'], 42.)
        self.assertEqual(row['right_pupil_diameter_px'], '')
        self.assertEqual(row['right_pupil_center_x'], '')
        self.assertEqual(row['right_pupil_diameter_mm'], '')
        self.assertIsNone(live['r_pupil']['dia'])

    def test_invalid_2d_confidence_does_not_inherit_3d_confidence(self):
        for confidence in (None, float('nan'), float('inf'), -1, 1.1, True, '.9'):
            with self.subTest(confidence=confidence):
                _, row, live = outputs(native_pupil(confidence, .95))
                self.assertEqual(row['right_pupil_pixel_valid'], 0)
                self.assertEqual(row['right_pupil_pixel_confidence'], '')
                self.assertEqual(row['right_pupil_diameter_px'], '')
                self.assertEqual(row['right_pupil_diameter_mm'], 3.)
                self.assertEqual(live['r_pupil']['dia_mm'], 3.)

    def test_mrt_quality_policy_remains_conservative_without_claiming_vendor_equivalence(self):
        pupil = native_pupil()
        pupil['sphere']['center'] = [12., 0., 18.]
        _, row, _ = outputs(pupil)
        self.assertEqual(row['pupil_model_quality_policy'], 'mrt_pupil_model_bounds_v1')
        self.assertEqual(row['right_pupil_model_quality'], 'bad')
        self.assertEqual(row['right_pupil_raw_diameter_mm'], 3.)
        self.assertEqual(row['right_pupil_diameter_mm'], '')
        self.assertEqual(row['right_pupil_diameter_px'], 40.)
        self.assertEqual(row['right_pupil_projected_diameter_px'], '')


if __name__ == '__main__':
    unittest.main()
