"""Original export-column units, exact frame dimensions and Capture geometry."""
from types import SimpleNamespace
from dataclasses import asdict
import json
import unittest

from services.eye_tracking.adapters.pupil_core.data_normalizer import DataNormalizer
from services.eye_tracking.adapters.pupil_core.service import PupilService
from services.eye_tracking.adapters.pupil_native.source import message
from services.eye_tracking.domain.samples import GazeSample, PupilSample
from services.eye_tracking.infrastructure.pupil_csv import gaze_csv_row
from services.eye_tracking.infrastructure.pupil_events import event_rows
from .test_pupil_pixel_provenance import native_pupil, outputs


class StandardPupilColumnsTests(unittest.TestCase):
    def test_existing_pupil_columns_are_normalized_without_changing_raw_pixels_or_mm(self):
        pupil = native_pupil()
        sample, row, _ = outputs(pupil)
        self.assertEqual(row['pupil_center_space'], 'eye_image_normalized_top_left')
        self.assertEqual(row['pupil_axis_unit'], 'image_width_ratio')
        self.assertEqual(row['right_pupil_image_width'], 200)
        self.assertEqual(row['right_pupil_image_height'], 100)
        self.assertEqual(row['right_pupil_center_x'], .1)
        self.assertEqual(row['right_pupil_center_y'], .3)
        self.assertEqual(row['right_pupil_diameter'], .2)
        self.assertEqual(row['right_pupil_minor_axis'], .15)
        self.assertEqual(row['right_pupil_diameter_px'], 40)
        self.assertEqual(row['right_pupil_diameter_mm'], 3)
        self.assertEqual(row['right_pupil_distance'], '')
        self.assertEqual(sample.pupils[0].circle_center_3d, (0, 0, 20))

    def test_missing_dimensions_do_not_guess_axes_or_mix_native_2d_and_projected_centers(self):
        pupil = native_pupil()
        pupil.pop('eye_resolution')
        pupil['norm_pos'] = [.8, .1]  # 3D projection, unlike native ellipse_2d.
        _, row, _ = outputs(pupil)
        for name in ('center_x', 'center_y', 'diameter', 'minor_axis', 'image_width', 'image_height'):
            self.assertEqual(row[f'right_pupil_{name}'], '')
        self.assertEqual(row['right_pupil_diameter_px'], 40)
        pupil.pop('ellipse_2d')
        pupil.pop('confidence_2d')
        pupil.pop('native_source')
        _, row, _ = outputs(pupil)
        self.assertEqual(row['right_pupil_center_x'], .8)
        self.assertAlmostEqual(row['right_pupil_center_y'], .9)
        self.assertEqual(row['right_pupil_minor_axis'], '')

    def test_capture_uses_exact_matching_eye_frames_including_later_in_same_batch(self):
        pupil = native_pupil()
        for key in ('eye_resolution', 'ellipse_2d', 'confidence_2d', 'native_source'):
            pupil.pop(key)
        pupil['norm_pos'] = [.11, .67]
        pupil_message = message(pupil)
        gaze = message(dict(topic='gaze.3d.0.', timestamp=10., confidence=.95,
                            norm_pos=[.5, .5], base_data=[pupil]))
        frame = message(dict(topic='frame.eye.0', timestamp=10., format='bgr',
                             width=200, height=100, index=1), bytes(200 * 100 * 3))
        service = PupilService(source=SimpleNamespace(receive=lambda _: [pupil_message, gaze, frame]))
        values = service._receive(0)
        self.assertIsInstance(values[0], PupilSample)
        self.assertEqual(values[0].image_resolution, (200, 100))
        self.assertIsInstance(values[1], GazeSample)
        self.assertEqual(gaze_csv_row(values[1], 0)['right_pupil_diameter'], .2)
        later = {**pupil, 'timestamp': 10.01}
        service.network = SimpleNamespace(receive=lambda _: [message(later)])
        self.assertIsNone(service._receive(0)[0].image_resolution, 'Do not borrow a different eye-frame timestamp')
        other_eye = {**pupil, 'id': 1, 'topic': 'pupil.1.3d'}
        service.network = SimpleNamespace(receive=lambda _: [message(other_eye)])
        self.assertIsNone(service._receive(0)[0].image_resolution, 'Do not borrow the opposite eye dimensions')
        service.network = SimpleNamespace(open=lambda: None)
        service.begin_connect()
        self.assertFalse(service._eye_frame_sizes, 'Reconnect cannot reuse old camera dimensions')

    def test_capture_genuine_3d_is_preserved_without_fake_binocular_single_eye_points(self):
        right = native_pupil()
        left = {**right, 'topic': 'pupil.1.3d', 'id': 1}
        payload = dict(topic='gaze.3d.01.', timestamp=10., confidence=.95, norm_pos=[.3, .4],
                       base_data=[right, left], gaze_point_3d=[100, 50, 500],
                       eye_centers_3d={'0': [20, 10, -20], '1': [-40, 10, -20]},
                       gaze_normals_3d={'0': [.2, .1, 1], '1': [.3, .1, 1]})
        row = gaze_csv_row(DataNormalizer().normalize(message(payload), 1, 1), 0)
        self.assertEqual(row['source_backend'], 'capture')
        self.assertEqual(row['geometry_space'], 'world_camera_mm')
        self.assertEqual(row['recom_gaze_point_x'], 100)
        self.assertEqual(row['recom_raw_point_z'], 500)
        self.assertEqual(row['recom_gaze_x'], .3)
        self.assertEqual(row['recom_gaze_y'], .6)
        self.assertEqual(row['recom_re'], .95)
        self.assertEqual(row['right_origin_x'], 20)
        self.assertEqual(row['right_re'], .95)
        self.assertNotEqual(row['left_direction_x'], '')
        self.assertEqual(row['left_gaze_point_x'], '')
        self.assertEqual(row['right_gaze_x'], '')
        self.assertEqual(row['recom_smooth_point_x'], '')
        payload.update(topic='gaze.3d.0.', base_data=[right])
        row = gaze_csv_row(DataNormalizer().normalize(message(payload), 1, 1), 0)
        self.assertEqual(row['right_gaze_point_z'], 500)
        self.assertEqual(row['right_raw_point_x'], 100)
        self.assertEqual(row['right_gaze_x'], .3)
        self.assertEqual(row['left_gaze_point_x'], '')

    def test_capture_without_3d_keeps_replay_but_never_fills_3d_or_smoothed_columns(self):
        payload = dict(topic='gaze.2d.0.', timestamp=10., confidence=.95, norm_pos=[.3, .4], base_data=[])
        row = gaze_csv_row(DataNormalizer().normalize(message(payload), 1, 1), 0)
        self.assertEqual(row['recom_gaze_x'], .3)
        for kind in ('gaze_point', 'raw_point', 'smooth_point'):
            for axis in 'xyz':
                self.assertEqual(row[f'recom_{kind}_{axis}'], '')

    def test_capture_2d_gaze_preserves_actual_2d_pupil_contributors(self):
        pupil = dict(topic='pupil.0.2d', id=0, timestamp=10., confidence=.9,
                     method='2d c++', norm_pos=[.25, .75], diameter=40., eye_resolution=[200, 100],
                     ellipse={'center': [50., 25.], 'axes': [30., 40.]})
        payload = dict(topic='gaze.2d.0.', timestamp=10., confidence=.9,
                       norm_pos=[.3, .4], base_data=[pupil])
        row = gaze_csv_row(DataNormalizer().normalize(message(payload), 1, 1), 0)
        self.assertEqual(row['right_pupil_center_x'], .25)
        self.assertEqual(row['right_pupil_center_y'], .25)
        self.assertEqual(row['right_pupil_diameter'], .2)
        self.assertEqual(row['right_pupil_minor_axis'], .15)
        self.assertEqual(row['right_pupil_diameter_mm'], '')
        self.assertEqual(row['recom_gaze_point_x'], '')

    def test_capture_complete_global_blink_populates_original_index_and_duration_without_eye_guess(self):
        normalizer = DataNormalizer()
        samples = [normalizer.normalize(message(dict(topic='blinks', timestamp=stamp,
                    confidence=.5, type=phase)), 1, sequence)
                   for sequence, (stamp, phase) in enumerate(((10.1, 'onset'), (10.3, 'offset')), 1)]
        rows, _ = event_rows([json.dumps(asdict(sample)) + '\n' for sample in samples], 10, 1)
        onset = rows[0]
        self.assertEqual(onset['blink_index'], 1)
        self.assertAlmostEqual(onset['blink_duration_ms'], 200)
        self.assertEqual(onset['blink_marker'], '')
        self.assertEqual(onset['left_blink'], '')
        self.assertEqual(onset['right_blink'], '')
        self.assertEqual(rows[1]['blink_index'], '')


if __name__ == '__main__':
    unittest.main()
