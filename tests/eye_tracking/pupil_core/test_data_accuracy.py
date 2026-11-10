"""Pupil field validity, dimensional provenance and event completion regressions."""
from dataclasses import asdict, replace
import io
import json
import unittest

from services.eye_tracking.adapters.pupil_core.data_normalizer import DataNormalizer
from services.eye_tracking.adapters.pupil_native.events import NativeEvents
from services.eye_tracking.adapters.pupil_native.source import message as native_message
from services.eye_tracking.infrastructure.pupil_csv import NativeCsvMapper, gaze_csv_row
from services.eye_tracking.infrastructure.pupil_events import event_rows
from services.eye_tracking.transport.pupil_protocol import gaze_message
from .test_native_boundaries import gaze as angular_gaze
from .test_protocol import message
from .test_quality import gaze, pupil


def rows_for(payloads, origin=0, duration=1):
    normalizer = DataNormalizer()
    samples = [normalizer.normalize(native_message(payload), 3, sequence)
               for sequence, payload in enumerate(payloads, 1)]
    return event_rows(io.StringIO(''.join(json.dumps(asdict(sample)) + '\n' for sample in samples)), origin, duration)


class PupilDataAccuracyTests(unittest.TestCase):
    def test_late_source_time_retains_measurements_without_seeding_velocity(self):
        normalizer, mapper = DataNormalizer(), NativeCsvMapper()

        def sample(stamp, sequence, order, eyes=(0,)):
            payload = gaze(stamp=stamp, bases=[pupil(eye, stamp) for eye in eyes]).payload
            payload.update(native_source=True, world_resolution=[1280, 720], source_order=order)
            return normalizer.normalize(native_message(payload), 1, sequence)

        mapper(sample(10.006, 1, 'in_order', (0, 1)), 10)
        late = mapper(sample(10., 2, 'late_source_time'), 10)
        self.assertEqual(late['gaze_source_order'], 'late_source_time')
        self.assertEqual(late['source_timestamp_s'], 10.)
        self.assertEqual(late['right_pupil_diameter_mm'], 3.)
        self.assertEqual(late['recom_gaze_x'], .5)
        self.assertEqual(late['gaze_velocity_px_ms'], '')
        self.assertIsNone(mapper.previous)
        self.assertEqual(mapper(sample(10.02, 3, 'in_order'), 10)['gaze_velocity_px_ms'], '')
        self.assertEqual(mapper(sample(10.03, 4, 'in_order'), 10)['gaze_velocity_px_ms'], 0.)

    def test_failed_ellipse_does_not_publish_placeholder_center_or_erase_3d_diameter(self):
        for axes in ([0, 0], [30, 0], [-1, 40], [float('nan'), 40], None):
            with self.subTest(axes=axes):
                source = {**pupil(0, 10), 'confidence': .6, 'eye_resolution': [320, 240],
                          'ellipse_2d': {'center': [0, 0], 'axes': axes}}
                sample = DataNormalizer().normalize(gaze(bases=[source]), 1, 1)
                row = gaze_csv_row(sample, 9)
                live = json.loads(gaze_message(sample))['eye_data']['r_pupil']
                self.assertEqual(row['right_pupil_center_x'], '')
                self.assertEqual(row['right_pupil_minor_axis'], '')
                self.assertEqual(row['right_pupil_diameter_mm'], 3)
                self.assertIsNone(live['center'])
                self.assertEqual(live['dia_mm'], 3)
        source['ellipse_2d']['axes'] = [30, 40]
        row = gaze_csv_row(DataNormalizer().normalize(gaze(bases=[source]), 1, 1), 9)
        self.assertEqual(row['right_pupil_center_x'], 0)
        self.assertEqual(row['right_pupil_minor_axis'], 30 / 320)

    def test_rejected_pupil_retains_raw_diagnostics_without_analytical_values(self):
        source = {**pupil(0, 10), 'confidence': .2,
                  'ellipse_2d': {'center': [20, 30], 'axes': [30, 40]}}
        sample = DataNormalizer().normalize(gaze(bases=[source]), 2, 3)
        row = gaze_csv_row(sample, 9)
        self.assertEqual(row['right_pupil_valid'], 0)
        self.assertEqual(row['right_pupil_diameter_mm_valid'], 0)
        self.assertEqual(row['right_pupil_confidence'], .2)
        self.assertEqual(row['right_pupil_raw_diameter_mm'], 3)
        self.assertEqual(row['right_pupil_raw_diameter_px'], 40)
        self.assertEqual(row['right_pupil_invalid_reason'], 'invalid_detection')
        for field in ('diameter_mm', 'diameter_px', 'diameter', 'center_x', 'minor_axis', 'distance'):
            self.assertEqual(row[f'right_pupil_{field}'], '')
        self.assertNotIn('r_pupil', json.loads(gaze_message(sample))['eye_data'])
        stale = replace(sample, pupils=tuple(replace(p, identity=replace(p.identity, generation=1)) for p in sample.pupils))
        self.assertEqual(gaze_csv_row(stale, 9)['right_pupil_raw_diameter_mm'], '')

    def test_good_monocular_geometry_survives_rejected_binocular_recommendation(self):
        payload = gaze(bases=[pupil(0, 10), {**pupil(1, 10), 'model_confidence': .1}]).payload
        payload.update(native_source=True, monocular={'0': {
            'norm_pos': [.3, .4], 'gaze_point_3d': [10, 20, 500],
            'eye_center_3d': [0, 0, 0], 'gaze_normal_3d': [0, 0, 1]}})
        sample = DataNormalizer().normalize(native_message(payload), 1, 1)
        self.assertFalse(sample.valid)
        row = gaze_csv_row(sample, 9)
        self.assertEqual(row['recom_gaze_bit_mask'], 0)
        self.assertEqual(row['right_gaze_bit_mask'], 3)
        self.assertEqual(row['right_gaze_point_z'], 500)
        self.assertEqual(row['right_gaze_y'], .6)
        self.assertEqual(row['left_gaze_point_z'], '')
        live = json.loads(gaze_message(sample))['eye_data']
        self.assertIsNone(live['re_gaze']['gaze'])
        self.assertEqual(live['r_gaze']['gaze'], {'x': .3, 'y': .6})
        self.assertNotIn('l_gaze', live)

    def test_fixation_is_complete_only_after_observed_valid_dispersion_exit(self):
        detector = NativeEvents()
        windows = [event for index in range(21) for event in detector.fixation(angular_gaze(index / 100))]
        self.assertTrue(windows)
        self.assertTrue(all(event['event_complete'] is False for event in windows))
        rows, metadata = rows_for(windows)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['fixation_state'], 3)
        self.assertEqual(metadata['incompleteFixationEvents'], 1)
        terminal = detector.fixation(angular_gaze(.21, 4))
        self.assertEqual(len(terminal), 1)
        self.assertTrue(terminal[0]['event_complete'])
        rows, metadata = rows_for([*windows, *terminal])
        row = rows[0]
        self.assertEqual(row['fixation_state'], 4)
        self.assertEqual(metadata['completedFixationEvents'], 1)
        self.assertEqual(row['source_backend'], 'native')
        self.assertEqual(row['source_event_algorithm'], 'mrt_angular_dispersion')
        self.assertEqual(row['source_event_algorithm_version'], '3')
        self.assertEqual(json.loads(row['source_event_algorithm_parameters'])['max_dispersion_deg'], 1.5)
        self.assertEqual(row['source_event_completion'], 'complete_interval')
        self.assertEqual(row['source_receive_sequence'], len(windows) + 1)
        self.assertEqual(row['left_pupil_diameter_mm'], '')

    def test_fixation_gap_invalidity_and_source_reset_do_not_fabricate_completion(self):
        for reason, incoming in (('sampling_gap', angular_gaze(1)),
                                 ('non_increasing_time', angular_gaze(.1)),
                                 ('invalid_sample', {**angular_gaze(.21), 'confidence': .1})):
            with self.subTest(reason=reason):
                detector = NativeEvents()
                windows = [event for index in range(21) for event in detector.fixation(angular_gaze(index / 100))]
                end = detector.fixation(incoming)
                rows, _ = rows_for([*windows, *end], duration=2)
                self.assertEqual(rows[0]['fixation_state'], 3)
                self.assertEqual(rows[0]['source_event_completion'], 'incomplete:' + reason)
        detector.reset_fixation()
        self.assertEqual(detector.fixation_id, 1)
        self.assertIsNone(detector.last_fixation)
        self.assertEqual(detector.fixation(angular_gaze(2)), [])

    def test_clipping_keeps_source_interval_and_legacy_completion_is_explicit(self):
        payload = dict(topic='fixations', timestamp=9.9, id=2, duration=400,
                       norm_pos=[.5, .5], confidence=1., native_source=True,
                       event_complete=True, event_algorithm='mrt_angular_dispersion')
        rows, _ = rows_for([payload], origin=10, duration=.2)
        row = rows[0]
        self.assertEqual(row['fixation_state'], 3)
        self.assertEqual(row['source_event_clipped'], 1)
        self.assertAlmostEqual(row['fixation_duration_ms'], 200)
        self.assertAlmostEqual(row['source_event_duration_ms'], 400)
        self.assertEqual(row['source_event_start_timestamp_s'], 9.9)
        self.assertEqual(row['source_timestamp_s'], 9.9)
        payload.pop('event_complete')
        rows, _ = rows_for([payload], origin=9, duration=2)
        self.assertEqual(rows[0]['fixation_state'], 4)
        self.assertEqual(rows[0]['source_event_completion'], 'legacy_completion_unknown')

    def test_native_saccade_rejects_off_scene_or_unphysical_metrics(self):
        payload = dict(topic='saccades', timestamp=0, id=1, duration=30, confidence=1.,
                       native_source=True, norm_pos=[2, .5],
                       metrics={'saccade_endpoint_distance_px': -2, 'peak_saccade_velocity_deg_ms': float('inf'),
                                'saccade_start_x': 3, 'saccade_end_y': 0})
        sample = DataNormalizer().normalize(native_message(payload), 1, 1)
        self.assertFalse(sample.valid)
        self.assertEqual(sample.metrics, {'saccade_end_y': 0})
        payload['norm_pos'] = [.5, .5]
        self.assertTrue(DataNormalizer().normalize(native_message(payload), 1, 1).valid)


if __name__ == '__main__':
    unittest.main()
