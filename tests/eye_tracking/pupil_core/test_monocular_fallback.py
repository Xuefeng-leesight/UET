"""Actual calibrated single-eye fallback and motion continuity boundaries."""
from copy import deepcopy
import csv
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from services.eye_tracking.adapters.pupil_native.gazer import NativeGazer
from services.eye_tracking.adapters.pupil_native.source import NativeSource, message
from services.eye_tracking.adapters.pupil_core.data_normalizer import DataNormalizer
from services.eye_tracking.infrastructure.pupil_csv import CSV_FIELDS, NativeCsvMapper
from services.eye_tracking.infrastructure.pupil_events import order_csv
from services.eye_tracking.transport.pupil_protocol import gaze_message
from tests.eye_tracking.pupil_core.test_native import observations


class MonocularFallbackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec, refs, cls.observations = observations()
        cls.params = NativeGazer(cls.spec).fit(refs, cls.observations)

    def setUp(self):
        self.mapper = NativeGazer(self.spec, self.params)
        self.pair = deepcopy(self.observations[:2])
        self.pair[0]['timestamp'] = 10.
        self.pair[1]['timestamp'] = 10.012

    def test_rejected_partner_uses_real_monocular_model_time_and_contributors(self):
        for bad_eye in (0, 1):
            for rejection in ('confidence', 'model_confidence', 'normal'):
                with self.subTest(bad_eye=bad_eye, rejection=rejection):
                    pair = deepcopy(self.pair)
                    if rejection == 'normal':
                        pair[bad_eye]['circle_3d']['normal'] = [0., 0., 0.]
                    else:
                        pair[bad_eye][rejection] = .1
                    good_eye = 1 - bad_eye
                    expected = self.mapper.predict([pair[good_eye]])
                    actual = self.mapper.predict(pair)
                    np.testing.assert_allclose(actual['gaze_point_3d'], expected['gaze_point_3d'])
                    np.testing.assert_allclose(actual['norm_pos'], expected['norm_pos'])
                    self.assertEqual(actual['timestamp'], pair[good_eye]['timestamp'])
                    self.assertEqual(actual['base_data'], [pair[good_eye]])
                    self.assertEqual(actual['topic'], f'gaze.3d.{good_eye}.')
                    self.assertEqual(actual['mapping_reason'], 'paired_eye_quality_rejected')
                    self.assertEqual(actual['rejected_eye_ids'], [bad_eye])
                    sample = DataNormalizer().normalize(message(actual), 3, 10)
                    good_name = 'right' if good_eye == 0 else 'left'
                    self.assertEqual(sample.contributing_eyes, (good_name,))
                    self.assertEqual(set(sample.monocular), {good_name})
                    self.assertTrue(sample.valid)

    def test_good_binocular_and_no_good_eye_remain_distinct(self):
        actual = self.mapper.predict(self.pair)
        self.assertEqual(actual['mapping_mode'], 'binocular')
        self.assertAlmostEqual(actual['timestamp'], 10.006)
        self.assertEqual(len(actual['base_data']), 2)
        self.assertEqual(actual['rejected_eye_ids'], [])
        bad = [dict(p, confidence=.1) for p in self.pair]
        self.assertIsNone(self.mapper.predict(bad))
        self.assertIsNone(self.mapper.predict([self.pair[0], self.pair[0]]))
        self.assertIsNone(self.mapper.predict([dict(self.pair[0], timestamp=float('nan'))]))
        self.assertIsNone(self.mapper.predict([dict(self.pair[0], id=2)]))

    def test_degenerate_binocular_preserves_real_single_eyes_without_fake_recommendation(self):
        expected = {str(pupil['id']): self.mapper.predict([pupil]) for pupil in self.pair}
        for result in (None, {'norm_pos': [float('nan'), .5], 'gaze_point_3d': [0, 0, 500]},
                       {'norm_pos': [.5, .5], 'gaze_point_3d': [0, 0, float('inf')]}):
            with self.subTest(result=result), patch.object(self.mapper.binocular, 'predict', return_value=iter([result])):
                actual = self.mapper.predict(self.pair)
            self.assertNotIn('norm_pos', actual)
            self.assertNotIn('gaze_point_3d', actual)
            self.assertEqual(actual['mapping_mode'], 'binocular')
            self.assertEqual(actual['mapping_reason'], 'binocular_geometry_unavailable')
            self.assertEqual(actual['base_data'], self.pair)
            for eye, single in actual['monocular'].items():
                np.testing.assert_allclose(single['gaze_point_3d'], expected[eye]['gaze_point_3d'])
            sample = DataNormalizer().normalize(message(actual), 1, 1)
            self.assertFalse(sample.valid)
            row = NativeCsvMapper()(sample, 10)
            self.assertEqual(row['recom_gaze_bit_mask'], 0)
            self.assertEqual(row['recom_gaze_point_x'], '')
            self.assertEqual(row['gaze_velocity_px_ms'], '')
            live = json.loads(gaze_message(sample))['eye_data']
            self.assertIsNone(live['re_gaze']['gaze'])
            for side in ('left', 'right'):
                self.assertEqual(row[f'{side}_gaze_bit_mask'], 3)
                self.assertNotEqual(row[f'{side}_gaze_point_x'], '')
            self.assertIn('l_gaze', live)
            self.assertIn('r_gaze', live)

    def test_degenerate_binocular_during_calibration_cannot_pass_with_single_eye_results(self):
        _, references, pupils = observations()
        with patch.object(self.mapper.binocular, 'predict', side_effect=lambda _: iter([None])):
            with self.assertRaisesRegex(ValueError, 'degenerate gaze geometry'):
                self.mapper.fit(references, pupils)

    def test_source_switch_preserves_blinks_and_event_ids_but_breaks_motion(self):
        source = NativeSource()
        source.reset_events()
        source.mapper = self.mapper
        source.cameras = {2: {'intrinsics': self.spec}}
        first = source._gaze(self.pair)
        self.assertEqual(first[0].payload['topic'], 'gaze.3d.01.')
        source.events.fixation_id = 7
        source.events.phase[0] = 'onset'
        source.saccades.index = 8
        source.saccades.overlong = True
        source.saccades.candidate = ['old projection']
        pair = deepcopy(self.pair)
        for p in pair:
            p['timestamp'] += .02
        pair[0]['confidence'] = .1
        result = source._gaze(pair)
        self.assertEqual(result[0].payload['topic'], 'gaze.3d.1.')
        self.assertEqual(len(result), 1, 'Source switch cannot complete an old fixation/saccade')
        self.assertEqual(source.events.phase[0], 'onset')
        self.assertEqual(source.events.fixation_id, 7)
        self.assertEqual(source.saccades.index, 8)
        self.assertFalse(source.saccades.overlong)
        self.assertEqual(source.saccades.candidate, [])
        self.assertEqual(source.last_gaze, pair[1]['timestamp'])

    def test_late_real_source_time_is_retained_and_resets_online_candidates(self):
        source = NativeSource()
        source.reset_events()
        source.mapper = self.mapper
        source.cameras = {2: {'intrinsics': self.spec}}
        source._gaze(self.pair)
        source.events.active = True
        source.saccades.candidate = ['incomplete']
        late = deepcopy(self.pair)
        late[1]['confidence'] = .1  # Right source time precedes previous pair mean.
        outputs = source._gaze(late)
        self.assertEqual(len(outputs), 1, 'Late gaze is retained, without creating online events')
        self.assertEqual(outputs[0].payload['timestamp'], late[0]['timestamp'])
        self.assertEqual(outputs[0].payload['source_order'], 'late_source_time')
        self.assertEqual(outputs[0].payload['topic'], 'gaze.3d.0.')
        self.assertEqual(outputs[0].payload['base_data'], [late[0]])
        self.assertAlmostEqual(source.last_gaze, 10.006)
        self.assertIsNone(source.last_gaze_eyes)
        self.assertFalse(source.events.active)
        self.assertEqual(source.saccades.candidate, [])

    def test_late_source_gaze_is_preserved_in_chronological_recording(self):
        source = NativeSource()
        source.reset_events()
        source.mapper = self.mapper
        source.cameras = {2: {'intrinsics': self.spec}}
        first = source._gaze(self.pair)[0]
        late = deepcopy(self.pair)
        late[1]['confidence'] = .1
        second = source._gaze(late)[0]
        next_eye = dict(self.pair[0], timestamp=10.02)
        third = source._gaze([next_eye])[0]
        normalizer, mapper = DataNormalizer(), NativeCsvMapper()
        rows = [mapper(normalizer.normalize(packet, 1, i), 9)
                for i, packet in enumerate((first, second, third), 1)]
        # Arrival-order differentiation must not let a late monocular sample
        # bridge across the intervening binocular source-time observation.
        self.assertEqual(rows[2]['gaze_velocity_px_ms'], '')
        with tempfile.TemporaryDirectory() as directory:
            with (Path(directory) / 'record.csv').open('w+', newline='') as stream:
                writer = csv.DictWriter(stream, fieldnames=CSV_FIELDS)
                writer.writeheader()
                writer.writerows(rows)
                order_csv(stream, directory)
                stream.seek(0)
                ordered = list(csv.DictReader(stream))
        self.assertEqual(len(ordered), 3)
        self.assertEqual([r['source_receive_sequence'] for r in ordered], ['2', '1', '3'])
        self.assertEqual([float(r['source_timestamp_s']) for r in ordered], [10., 10.006, 10.02])
        self.assertEqual(ordered[0]['gaze_source_order'], 'late_source_time')
        self.assertEqual(ordered[0]['recom_gaze_bit_mask'], '3')

    def test_velocity_is_not_differenced_across_changed_contributors(self):
        mapper = NativeCsvMapper()
        normalizer = DataNormalizer()
        first = normalizer.normalize(message(self.mapper.predict(self.pair)), 1, 1)
        mapper(first, 10)
        pair = deepcopy(self.pair)
        for p in pair:
            p['timestamp'] += .02
        pair[0]['confidence'] = .1
        mono = normalizer.normalize(message(self.mapper.predict(pair)), 1, 2)
        row = mapper(mono, 10)
        self.assertEqual(row['gaze_velocity_px_ms'], '')
        self.assertEqual(row['gaze_velocity_deg_ms'], '')


if __name__ == '__main__':
    unittest.main()
