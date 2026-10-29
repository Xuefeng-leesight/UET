"""Capture geometry uses validated frames and never crosses motion boundaries."""
from dataclasses import replace
import math
from types import SimpleNamespace
import unittest

from services.eye_tracking.adapters.pupil_core.data_normalizer import DataNormalizer
from services.eye_tracking.adapters.pupil_core.service import PupilService
from services.eye_tracking.adapters.pupil_native.source import message
from services.eye_tracking.domain.samples import GazeSample
from services.eye_tracking.infrastructure.pupil_csv import NativeCsvMapper
from .test_pupil_pixel_provenance import native_pupil


def frame(stamp, width=200, height=100):
    return message(dict(topic='frame.world', timestamp=stamp, format='bgr',
                        width=width, height=height, index=1), bytes(width * height * 3))


def gaze(stamp=10., x=.5, point_x=0.):
    pupil = {**native_pupil(), 'timestamp': stamp}
    return message(dict(topic='gaze.3d.0.', timestamp=stamp, confidence=.95,
                        norm_pos=[x, .25], base_data=[pupil], gaze_point_3d=[point_x, 0., 500.],
                        eye_center_3d=[0., 0., 0.], gaze_normal_3d=[point_x, 0., 500.]))


def service_for(messages):
    return PupilService(source=SimpleNamespace(receive=lambda _: messages))


class CaptureGeometryTests(unittest.TestCase):
    def test_capture_binds_real_scene_dimensions_to_gaze_and_fixation(self):
        fixation = message(dict(topic='fixations', timestamp=10., id=3, duration=150.,
                                confidence=.95, norm_pos=[.3, .25]))
        service = service_for([gaze(), fixation, frame(10.)])
        samples = service._receive(0)
        self.assertEqual(samples[0].world_resolution, (200, 100))
        self.assertEqual(samples[1].metrics, {'fixation_point_x_px': 60., 'fixation_point_y_px': 75.})
        self.assertFalse(samples[0].native)
        self.assertEqual(DataNormalizer().normalize(fixation, 1, 1).metrics, {})
        self.assertIsNone(DataNormalizer().normalize(gaze(), 1, 1).world_resolution)
        service.network = SimpleNamespace(open=lambda: None)
        service.begin_connect()
        self.assertIsNone(service._world_resolution)
        self.assertEqual(service._world_resolution_epoch, 0)

    def test_capture_speed_uses_true_pixel_scale_and_actual_3d_direction(self):
        service = service_for([frame(10.), gaze(), gaze(10.01, .6, 10.)])
        samples = [sample for sample in service._receive(0) if isinstance(sample, GazeSample)]
        mapper = NativeCsvMapper()
        self.assertEqual(mapper(samples[0], 10)['gaze_velocity_px_ms'], '')
        row = mapper(samples[1], 10)
        self.assertAlmostEqual(row['gaze_velocity_px_ms'], 2.)
        self.assertAlmostEqual(row['gaze_velocity_deg_ms'], math.degrees(math.atan(10 / 500)) / 10)
        # A 2D mapping can supply image-plane speed but cannot supply angles.
        two_d = [replace(sample, point_3d=None, eye_centers_3d={}, eye_normals_3d={}) for sample in samples]
        mapper = NativeCsvMapper()
        mapper(two_d[0], 10)
        row = mapper(two_d[1], 10)
        self.assertAlmostEqual(row['gaze_velocity_px_ms'], 2.)
        self.assertEqual(row['gaze_velocity_deg_ms'], '')

    def test_motion_resets_for_source_eye_gap_reconnect_resolution_and_mapping_changes(self):
        service = service_for([frame(10.), gaze(), gaze(10.01, .6, 10.)])
        before, after = [sample for sample in service._receive(0) if isinstance(sample, GazeSample)]
        changes = {
            'contributing_eye': replace(after, contributing_eyes=('left',)),
            'gap': replace(after, identity=replace(after.identity, source_time_s=10.2)),
            'reconnect': replace(after, identity=replace(after.identity, generation=2)),
            'resolution': replace(after, world_resolution=(100, 50)),
            'resolution_epoch': replace(after, world_resolution_epoch=2),
            'mapping_topic': replace(after, identity=replace(after.identity, topic='gaze.2d.0.')),
            'invalid': replace(after, valid=False),
            'no_dimensions': replace(after, world_resolution=None),
        }
        for reason, changed in changes.items():
            with self.subTest(reason=reason):
                mapper = NativeCsvMapper()
                mapper(before, 10)
                row = mapper(changed, 10)
                self.assertEqual(row['gaze_velocity_px_ms'], '')
                self.assertEqual(row['gaze_velocity_deg_ms'], '')

    def test_late_capture_sample_is_retained_but_cannot_seed_next_derivative(self):
        service = service_for([frame(10.), gaze(10.01), gaze(10., .6, 10.), gaze(10.02, .7, 20.), gaze(10.03, .8, 30.)])
        samples = [sample for sample in service._receive(0) if isinstance(sample, GazeSample)]
        mapper = NativeCsvMapper()
        rows = [mapper(sample, 10) for sample in samples]
        self.assertEqual(rows[1]['source_timestamp_s'], 10.)
        self.assertEqual(rows[1]['recom_raw_point_x'], 10.)
        self.assertEqual([row['gaze_velocity_px_ms'] for row in rows[:3]], ['', '', ''])
        self.assertAlmostEqual(rows[3]['gaze_velocity_px_ms'], 2.)

    def test_dimensions_change_and_return_without_gaze_still_breaks_continuity(self):
        service = service_for([frame(10.), gaze(), frame(10.001, 100, 50),
                               frame(10.002), gaze(10.01, .6, 10.)])
        samples = [sample for sample in service._receive(0) if isinstance(sample, GazeSample)]
        self.assertEqual([sample.world_resolution for sample in samples], [(200, 100), (200, 100)])
        self.assertEqual([sample.world_resolution_epoch for sample in samples], [0, 2])
        mapper = NativeCsvMapper()
        before = mapper(samples[0], 10)
        after = mapper(samples[1], 10)
        self.assertEqual(after['gaze_velocity_px_ms'], '')
        # Source-time CSV sorting must retain the resolution change even when
        # the camera returns to its old size before another gaze sample arrives.
        self.assertEqual([before['world_resolution_epoch'], after['world_resolution_epoch']], [0, 2])
        for row in (before, after):
            self.assertEqual((row['world_image_width'], row['world_image_height']), (200, 100))
        unknown = mapper(replace(samples[1], world_resolution=None), 10)
        self.assertEqual((unknown['world_image_width'], unknown['world_image_height']), ('', ''))


if __name__ == '__main__':
    unittest.main()
