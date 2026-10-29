"""Audit safeguards: detect corruption without counting legitimate blanks as loss."""
from pathlib import Path
import tempfile
import unittest

from tools.pupil.audit_recording import (
    applicable, audit, blank_reason, equivalent, json_lines,
    longest_blank_run, pupil_center_problem, value_problem,
)


class RecordingAuditTests(unittest.TestCase):
    def test_comparison_does_not_hide_large_timestamp_corruption(self):
        self.assertFalse(equivalent('1791951592036', '1791951592037'))
        self.assertFalse(equivalent({'gaze': [0.2, 0.3]}, {'gaze': [0.2, None]}))
        self.assertTrue(equivalent({'gaze': [0.2, 0.3]}, {'gaze': ['0.2', '0.3']}))
        self.assertTrue(equivalent('', None))
        self.assertFalse(equivalent('', 0))

    def test_applicable_rows_do_not_count_success_or_other_eye_as_missing(self):
        self.assertFalse(applicable('gaze_invalid_reason', {'pupil_valid': '1'}))
        self.assertTrue(applicable('gaze_invalid_reason', {'pupil_valid': '0'}))
        event = dict(source_event_type='blink', blink_marker='2', blink_phase='offset', blink_pair_status='paired')
        self.assertFalse(applicable('left_blink', event))
        self.assertTrue(applicable('right_blink', event))
        self.assertFalse(applicable('blink_duration_ms', event))
        event['blink_phase'] = 'onset'
        self.assertTrue(applicable('blink_duration_ms', event))
        self.assertFalse(applicable('left_pupil_diameter_mm', event))

    def test_missing_value_attribution_keeps_real_pipeline_loss_visible(self):
        row = {'pupil_valid': '1'}
        self.assertEqual(blank_reason('recom_gaze_x', row, '.5', {}), '转换或保存缺失')
        raw = {'base_data': [{'id': 0, 'confidence': .6, 'diameter': 0, 'projected_diameter_px': 36}]}
        self.assertEqual(blank_reason('right_pupil_diameter_px', row, '', raw), '原始2D检测直径为零，未用3D投影伪填')

    def test_zero_ellipse_center_is_not_validated_by_3d_projection(self):
        raw = {'base_data': [{'id': 0, 'ellipse_2d': {'center': [0, 0], 'axes': [0, 0]},
                             'ellipse': {'center': [112, 68], 'axes': [31, 36]}}]}
        self.assertIsNotNone(pupil_center_problem(raw, 'right'))
        raw['base_data'][0]['ellipse_2d']['axes'] = [31, 36]
        self.assertIsNone(pupil_center_problem(raw, 'right'))

    def test_contract_checks_preserve_offscene_raw_data_and_valid_zero(self):
        for value in ('nan', 'inf', 'invalid'):
            self.assertIsNotNone(value_problem('recom_gaze_x', value))
        self.assertIsNotNone(value_problem('recom_gaze_x', '1.2'))
        self.assertIsNone(value_problem('source_norm_pos_x', '1.2'))
        self.assertIsNone(value_problem('right_blink', '0'))
        self.assertIsNotNone(value_problem('right_blink', '2'))
        self.assertIsNotNone(value_problem('left_pupil_diameter_px', '0'))

    def test_blank_spans_are_not_terminated_by_valid_zero(self):
        scope = [{'video_time_ms': str(t), 'field': v} for t, v in [(1, ''), (2, ''), (4, 0), (5, '')]]
        self.assertEqual(longest_blank_run(scope, 'field', 6), 3)

    def test_truncated_journal_and_source_output_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'samples.jsonl'
            path.write_text('{"a":1}')
            with self.assertRaisesRegex(ValueError, 'Truncated'):
                list(json_lines(path))
            with self.assertRaisesRegex(ValueError, 'separate'):
                audit(root / 'record.csv', root / 'output', 'ffprobe')
