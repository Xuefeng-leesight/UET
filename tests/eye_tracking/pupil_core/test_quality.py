"""Regressions found by replaying the 2026-10-10 hardware recording."""
import csv
from dataclasses import asdict, replace
import io
import json
from pathlib import Path
import tempfile
import time
import unittest

from services.eye_tracking.adapters.pupil_core.calibration import PupilCalibration
from services.eye_tracking.adapters.pupil_core.data_normalizer import DataNormalizer
from services.eye_tracking.adapters.pupil_core.pupil_quality import PupilDiagnostics
from services.eye_tracking.adapters.pupil_core.validation import measure_target
from services.eye_tracking.infrastructure.pupil_csv import gaze_csv_row, CSV_FIELDS
from services.eye_tracking.infrastructure.pupil_events import event_rows, order_csv
from services.eye_tracking.infrastructure.pupil_metrics import journal_metrics
from services.eye_tracking.transport.pupil_protocol import gaze_message
from .test_calibration import FakeRemote, StaticTracker, notification
from .test_protocol import message


def pupil(eye, stamp, **changes):
    return dict(topic=f"pupil.{eye}.3d", id=eye, timestamp=stamp, confidence=.95,
                diameter=40 + eye, diameter_3d=3 + eye, model_confidence=1,
                sphere={"center": [0, 0, 30]}, circle_3d={}, **changes)


def gaze(stamp=10, pos=(.5, .5), bases=None):
    return message("gaze.3d.01.", timestamp=stamp, norm_pos=pos,
                   base_data=bases if bases is not None else [pupil(0, stamp - .004), pupil(1, stamp + .004)])


class QualityTests(unittest.TestCase):
    def test_authoritative_contributors_straddle_gaze_time_and_match_preview_csv(self):
        sample = DataNormalizer().normalize(gaze(), 3, 20)
        row = gaze_csv_row(sample, 9)
        self.assertEqual(sample.model_quality, "good")
        self.assertEqual(row["left_pupil_diameter_mm"], 4)
        self.assertEqual(row["right_pupil_diameter_px"], 40)
        self.assertGreater(row["left_pupil_source_timestamp_s"], 10)
        preview = json.loads(gaze_message(sample))["eye_data"]
        self.assertEqual(preview["l_pupil"]["dia_mm"], 4)
        self.assertEqual(preview["r_pupil"]["dia"], 40)

    def test_monocular_and_stale_base_data_never_borrow_other_cached_eyes(self):
        normalizer = DataNormalizer()
        cached = normalizer.normalize(message(**pupil(1, 9.99)), 3, 1)
        for bases, expected in (([pupil(0, 10)], 40), ([pupil(0, 8)], ""), ([{"id": 0}, None], "")):
            with self.subTest(bases=bases):
                sample = normalizer.normalize(gaze(bases=bases), 3, 2)
                row = gaze_csv_row(sample, 9, {"left": cached})
                self.assertEqual(row["left_pupil_diameter_px"], "")
                self.assertEqual(row["right_pupil_diameter_px"], expected)
        sample = normalizer.normalize(gaze(), 3, 3)
        sample = replace(sample, pupils=tuple(replace(p, identity=replace(p.identity, generation=2)) for p in sample.pupils))
        self.assertEqual(gaze_csv_row(sample, 9)["left_pupil_diameter_px"], "")

    def test_high_detection_confidence_does_not_hide_bad_model(self):
        for changes in ({"model_confidence": .1}, {"sphere": {"center": [0, 0, 18]}}, {"diameter_3d": .8}):
            bad = {**pupil(1, 10), **changes}
            sample = DataNormalizer().normalize(gaze(bases=[pupil(0, 10), bad]), 1, 1)
            self.assertFalse(sample.valid)
            self.assertEqual(sample.invalid_reason, "bad_3d_model")
            row = gaze_csv_row(sample, 9)
            self.assertEqual(row["recom_gaze_x"], "")
            self.assertEqual(row["source_norm_pos_x"], .5)
            self.assertEqual(row["left_pupil_diameter_mm"], "")
            self.assertEqual(row["left_pupil_raw_diameter_mm"], bad["diameter_3d"])
            self.assertEqual(row["left_pupil_diameter_px"], 41)
            self.assertIsNone(json.loads(gaze_message(sample))["eye_data"]["l_pupil"]["dia_mm"])

    def test_metrics_separate_eye_rate_from_gaze_rate_and_ignore_tail(self):
        normalizer = DataNormalizer()
        samples = [normalizer.normalize(gaze(), 1, 1), normalizer.normalize(gaze(stamp=10.5), 1, 2),
                   normalizer.normalize(message(**pupil(0, 10)), 1, 3),
                   normalizer.normalize(gaze(stamp=12), 1, 4)]
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "journal"
            path.write_text("".join(json.dumps(asdict(s)) + "\n" for s in samples))
            metrics = journal_metrics(path, 10, 1)
        self.assertEqual(metrics["gazeMessageRateHz"], 2)
        self.assertEqual(metrics["eyeSamplingRateHz"], {"left": 0, "right": 1})
        self.assertEqual(metrics["eyeModelValidPercent"]["right"], 100)

    def test_validation_interpolates_source_reference_and_rejects_bad_models(self):
        refs = [{"timestamp": 10, "norm_pos": [.4, .5]}, {"timestamp": 10.02, "norm_pos": [.6, .5]}]
        data = gaze(stamp=10.01, pos=(.6, .5)).payload
        bad = {**data, "base_data": [{**pupil(1, 10.01), "model_confidence": .1}]}
        report = measure_target(refs, [data, bad], (1280, 720))
        self.assertEqual(report["gaze_count"], 2)
        self.assertEqual(len(report["errors_px"]), 1)
        self.assertAlmostEqual(report["errors_px"][0], 128)
        self.assertNotIn("angularAccuracy", report)
        self.assertEqual(measure_target([], [], (1280, 720))["errors_px"], [])
        refs[1]["timestamp"] = 11
        self.assertEqual(measure_target(refs, [data], (1280, 720))["errors_px"], [])

    def test_blink_event_confidence_pairing_and_orphan_state(self):
        normalizer = DataNormalizer()
        def blink(stamp, phase, generation=1):
            return normalizer.normalize(message("blinks", timestamp=stamp, type=phase, confidence=.594), generation, 1)
        events = [blink(10.3, "offset"), blink(10.2, "onset"), blink(10.5, "onset"), blink(10.6, "offset", 2)]
        rows, meta = event_rows(io.StringIO("".join(json.dumps(asdict(e)) + "\n" for e in events)), 10, 1)
        self.assertEqual(meta["blinkOnsets"], 1)
        self.assertEqual(meta["blinkUnpairedPhases"], 2)
        self.assertEqual(rows[0]["pupil_confidence"], .594)
        row = gaze_csv_row(normalizer.normalize(gaze(stamp=10.55), 1, 10), 10)
        with tempfile.TemporaryDirectory() as temp:
            with (Path(temp) / "csv").open("w+", newline="") as output:
                writer = csv.DictWriter(output, fieldnames=CSV_FIELDS)
                writer.writeheader()
                writer.writerows([*rows, row])
                order_csv(output, Path(temp))
                output.seek(0)
                result = list(csv.DictReader(output))
        self.assertEqual(next(r for r in result if r["pupil_valid"])["blink"], "")


class CalibrationQualityTests(unittest.TestCase):
    def begin(self, points=9):
        calibration = PupilCalibration(FakeRemote(), tracker_factory=StaticTracker)
        calibration.start(points=points)
        return calibration

    def sample(self, calibration, x, y, bad_count=0):
        calibration.observe_card_data(message(timestamp=100))
        calibration.sample_card_point(calibration.card_index, x, y, 1)
        for index in range(30):
            stamp = 100.01 + index / 100
            calibration.observe_card_data(message(timestamp=stamp))
            for eye in (0, 1):
                data = pupil(eye, stamp)
                if eye == 1 and index < bad_count:
                    data["model_confidence"] = .1
                calibration.observe_card_data(message(**data))
            if calibration.purpose == "validation":
                calibration.observe_card_data(gaze(stamp=stamp, pos=(x, 1 - y)))
        calibration.card_sample["until"] = time.monotonic() - 1
        return calibration.tick()

    def test_bad_models_retry_without_advancing_but_card_position_is_free(self):
        calibration = self.begin()
        result = self.sample(calibration, .1, .1, bad_count=10)
        self.assertEqual(result["error"], -1)
        self.assertIn("80%", result["msg"])
        self.assertEqual(calibration.card_index, 1)
        result = self.sample(calibration, .5, .5)
        self.assertEqual(result["error"], 0)
        self.assertFalse(result["pupil_diagnostics"]["target_region_required"])
        self.assertIsNone(result["pupil_diagnostics"]["target_bounds_top_left"])
        self.assertEqual(calibration.card_index, 2)

    def test_nine_distributed_points_fit_only_once(self):
        calibration = self.begin()
        for y in (.1, .5, .9):
            for x in (.1, .5, .9):
                self.assertEqual(self.sample(calibration, x, y)["error"], 0)
        calibration.finish()
        calibration.finish()
        self.assertEqual(len(calibration.network.fits), 1)
        self.assertFalse(calibration.verified)

    def test_arbitrary_order_and_final_point_outside_bottom_right_can_fit(self):
        calibration = self.begin()
        # No point number corresponds to a grid cell; the final point may be near the top.
        positions = ((.5, .5), (.7, .3), (.3, .6), (.4, .3), (.6, .6),
                     (.3, .4), (.7, .5), (.5, .7), (.45, .2))
        for x, y in positions:
            self.assertEqual(self.sample(calibration, x, y)["error"], 0)
        calibration.finish()
        self.assertEqual(len(calibration.network.fits), 1)

    def test_final_point_quality_failure_keeps_prior_points_and_can_move_then_retry(self):
        for count in (3, 5, 9):
            with self.subTest(points=count):
                calibration = self.begin(count)
                positions = ((.3, .3), (.6, .3), (.5, .6), (.4, .4), (.6, .6),
                             (.3, .5), (.5, .3), (.4, .6))
                for x, y in positions[:count - 1]:
                    self.assertEqual(self.sample(calibration, x, y)["error"], 0)
                prior_refs = list(calibration.card_refs)
                result = self.sample(calibration, .8, .8, bad_count=30)
                self.assertEqual(result["error"], -1)
                self.assertEqual(calibration.card_index, count)
                self.assertEqual(calibration.card_refs, prior_refs)
                self.assertIn(f"已完成 {count - 1} 点保留", result["msg"])
                # Retry freely near the top; no bottom-position requirement and no ref accumulation on failure.
                result = self.sample(calibration, .45, .1)
                self.assertEqual(result["error"], 0)
                self.assertAlmostEqual(result["pupil_diagnostics"]["tracked_center_top_left"][1], .1)
                calibration.finish()
                self.assertEqual(len(calibration.network.fits), 1)

    def test_three_and_five_spread_points_fit_once_without_claiming_success(self):
        for points, positions in ((3, ((.1, .1), (.9, .1), (.5, .9))),
                                  (5, ((.5, .5), (.1, .1), (.9, .1), (.1, .9), (.9, .9)))):
            with self.subTest(points=points):
                calibration = self.begin(points)
                for x, y in positions:
                    self.assertEqual(self.sample(calibration, x, y)["error"], 0)
                calibration.finish()
                calibration.finish()
                self.assertEqual(len(calibration.network.fits), 1)
                self.assertFalse(calibration.verified)

    def test_five_collinear_points_cannot_fit(self):
        calibration = self.begin(5)
        for x in (.1, .3, .5, .7, .9):
            self.assertEqual(self.sample(calibration, x, x)["error"], 0)
        with self.assertRaisesRegex(ValueError, "覆盖不足"):
            calibration.finish()
        self.assertEqual(calibration.network.fits, [])

    def test_nine_concentrated_points_cannot_fit(self):
        calibration = self.begin()
        for _ in range(9):
            self.assertEqual(self.sample(calibration, .5, .5)["error"], 0)
        with self.assertRaisesRegex(ValueError, "覆盖不足"):
            calibration.finish()
        self.assertEqual(calibration.network.fits, [])

    def test_model_ratio_uses_actual_tracked_window_not_initialization_delay(self):
        calibration = self.begin()
        calibration.observe_card_data(message(timestamp=100))
        calibration.sample_card_point(1, .1, .1, 1)
        # Real workers can warm up while the data channel keeps flowing.
        for index in range(60):
            stamp = 100.01 + index / 100
            for eye in (0, 1):
                calibration.observe_card_data(message(**pupil(eye, stamp)))
        for index in range(30):
            stamp = 101 + index / 100
            calibration.observe_card_data(message(timestamp=stamp))
            for eye in (0, 1):
                calibration.observe_card_data(message(**pupil(eye, stamp)))
        calibration.card_sample["until"] = time.monotonic() - 1
        result = calibration.tick()
        self.assertEqual(result["error"], 0)
        self.assertEqual(result["pupil_diagnostics"]["window_samples_by_eye"], [30, 30])
        self.assertEqual(result["pupil_diagnostics"]["paired_fraction_by_eye"], [1, 1])

    def test_nine_points_need_not_reach_screen_edges(self):
        calibration = self.begin()
        for y in (.32, .5, .68):
            for x in (.32, .5, .68):
                self.assertEqual(self.sample(calibration, x, y)["error"], 0)
        calibration.finish()
        self.assertEqual(len(calibration.network.fits), 1)

    def test_sampling_timeout_is_distinct_from_capture_fit_timeout(self):
        calibration = self.begin()
        self.assertEqual(self.sample(calibration, .5, .5)["error"], 0)
        calibration.deadline = time.monotonic() - 1
        result = calibration.tick()
        self.assertIn("已完成 1/9", result["msg"])
        self.assertIn("尚未提交 Capture 拟合", result["msg"])
        self.assertEqual(calibration.network.fits, [])
        self.assertFalse(calibration.verified)

    def test_affected_eye_detection_failure_not_hidden_by_other_eye_model(self):
        diagnostics = PupilDiagnostics()
        for index in range(20):
            data = pupil(0, 100.01 + index / 100)
            data["confidence"] = .1
            diagnostics.observe(message(**data), 100)
        data = pupil(1, 100.2)
        data["model_confidence"] = 0
        diagnostics.observe(message(**data), 100)
        self.assertIn("瞳孔检测置信度不足", diagnostics.failure_message([0, 30]))
        self.assertNotIn("3D 眼球模型未就绪", diagnostics.failure_message([0, 30]))
        self.assertEqual(diagnostics.report([0, 30])["rejected_by_eye"][0], {"low_confidence": 20})

    def test_three_held_out_targets_measure_without_refitting(self):
        calibration = self.begin()
        calibration.pending, calibration.token = False, "fit"
        calibration.start_validation("fit")
        for x, y in ((.15, .15), (.85, .15), (.5, .85)):
            self.assertEqual(self.sample(calibration, x, y)["error"], 0)
        result = calibration.finish()
        self.assertAlmostEqual(result["validation"]["meanErrorPx"], 0)
        self.assertEqual(result["validation"]["validityPercent"], 100)
        self.assertEqual(len(result["validation"]["points"]), 3)
        self.assertEqual(calibration.network.fits, [])

    def test_independent_validation_preserves_fit_and_handles_cancel_changes_timeout(self):
        calibration = self.begin()
        calibration.pending = False
        calibration.token = "pupil-session:original"
        calibration.card_refs = [{"training": True}]
        calibration.start_validation(calibration.token)
        self.assertFalse(calibration.verified)
        calibration.card_index = 4
        calibration.card_centers = [(.1, .9), (.9, .9), (.5, .1)]
        calibration.validation_points = [{"errors_px": [10., 20.], "gaze_count": 4}] * 3
        result = calibration.finish()
        self.assertTrue(calibration.verified)
        self.assertEqual(result["validation"]["meanErrorPx"], 15)
        self.assertEqual(result["validation"]["validityPercent"], 50)
        self.assertEqual(calibration.snapshot()["ref_list"], [{"training": True}])
        self.assertEqual(calibration.network.fits, [])
        calibration.start_validation(calibration.token)
        calibration.cancel()
        self.assertTrue(calibration.verified)
        self.assertTrue(calibration.snapshot()["independentValidationPerformed"])
        calibration.start_validation(calibration.token)
        result = calibration.handle(notification("calibration.setup.v2", calib_data={}))
        self.assertEqual(result["error"], -1)
        self.assertFalse(calibration.verified)
        calibration.token, calibration.pending = "new", False
        calibration.start_validation("new")
        calibration.deadline = time.monotonic() - 1
        self.assertEqual(calibration.tick()["error"], -1)
        self.assertFalse(calibration.verified)
