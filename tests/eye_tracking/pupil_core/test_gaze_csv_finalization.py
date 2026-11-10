import csv
from dataclasses import replace
import io
import json
import tempfile
import unittest

from services.eye_tracking.adapters.huahong.data_normalizer import gaze_csv_row as huahong_row
from services.eye_tracking.domain.samples import GazeSample, SampleIdentity
from services.eye_tracking.infrastructure.pupil_csv import gaze_csv_row as pupil_row
from services.eye_tracking.infrastructure.pupil_recovery import write_gaze_csv


class GazeCsvFinalizationTests(unittest.TestCase):
    def finalize(self, rows):
        spool = io.StringIO("".join(json.dumps(row) + "\n" for row in rows))
        with tempfile.TemporaryFile(mode="w+", encoding="utf-8", newline="") as output:
            counts = write_gaze_csv(spool, output, 1, [], [])
            output.seek(0)
            return counts, list(csv.DictReader(output))

    def sample(self):
        identity = SampleIdentity("PupilCore", "gaze.3d.01.", 1, 1, 10.1, 100)
        return GazeSample(identity, (0.25, 0.75), "world_normalized_bottom_left",
                          0.9, True, ("left", "right"))

    def test_huahong_gaze_without_pupil_finalizes_and_preserves_missing_data(self):
        sample = self.sample()
        sample = replace(sample, identity=replace(sample.identity, source="HH_ET28"),
                         coordinate_space="world_normalized_top_left", confidence=None)
        rows = [huahong_row(sample, 10), huahong_row(replace(sample, valid=False), 10)]
        self.assertEqual([row["pupil_valid"] for row in rows], ["", ""])
        counts, exported = self.finalize(rows)
        self.assertEqual(counts, {"gazeRows": 2, "validGazeRows": 1, "gazeOutsideVideo": 0})
        self.assertEqual([row["pupil_valid"] for row in exported], ["", ""])
        self.assertEqual([row["source_model"] for row in exported], ["HH_ET28", "HH_ET28"])

    def test_recommended_gaze_bit_is_authoritative_over_pupil_validity(self):
        for mask in (0, 1, 2, 3, 4, 6, 7, "1", "2", "", None, -1, "bad"):
            with self.subTest(mask=mask):
                expected = int(mask in (1, 3, 7, "1"))
                counts, _ = self.finalize([{"video_time_ms": 100,
                                            "recom_gaze_bit_mask": mask,
                                            "pupil_valid": 1 - expected}])
                self.assertEqual(counts["validGazeRows"], expected)

    def test_legacy_spool_without_mask_uses_pupil_flag_and_preserves_rows(self):
        flags = (1, "1", True, 0, "0", "", None)
        rows = [{"video_time_ms": 100, "pupil_valid": flag} for flag in flags]
        rows.append({"video_time_ms": 100})
        counts, exported = self.finalize(rows)
        self.assertEqual(counts, {"gazeRows": 8, "validGazeRows": 3, "gazeOutsideVideo": 0})
        self.assertEqual([row["recom_gaze_bit_mask"] for row in exported], [""] * 8)
        self.assertEqual([row["pupil_valid"] for row in exported],
                         ["1", "1", "True", "0", "0", "", "", ""])

    def test_current_pupil_capture_and_native_rows_keep_gaze_validity(self):
        sample = self.sample()
        native = replace(sample, native=True, point_3d=(1.0, 2.0, 3.0))
        rows = [pupil_row(item, 10) for item in (
            sample, replace(sample, valid=False), native,
            replace(native, valid=False), replace(native, position=None))]
        # Capture without measured 3D only advertises its normalized 2D point;
        # neither backend fabricates raw 3D or an independent smoothed point.
        self.assertEqual([row["recom_gaze_bit_mask"] for row in rows], [1, 0, 3, 0, 2])
        self.assertEqual([rows[0][f'recom_raw_point_{axis}'] for axis in 'xyz'], ['', '', ''])
        self.assertTrue(all(row[f'recom_smooth_point_{axis}'] == '' for row in rows for axis in 'xyz'))
        counts, exported = self.finalize(rows)
        self.assertEqual(counts, {"gazeRows": 5, "validGazeRows": 2, "gazeOutsideVideo": 0})
        self.assertEqual([row["pupil_valid"] for row in exported], ["1", "0", "1", "0", "1"])


if __name__ == "__main__":
    unittest.main()
