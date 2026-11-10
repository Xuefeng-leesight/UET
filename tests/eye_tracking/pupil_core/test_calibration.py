import time
import unittest
from dataclasses import replace

from services.eye_tracking.adapters.pupil_core.calibration import PupilCalibration
from tests.eye_tracking.pupil_core.test_protocol import message


class FakeRemote:
    def __init__(self):
        self.fits = []
        self.detection_requests = 0

    def enable_pupil_detection(self):
        self.detection_requests += 1

    def source_time(self):
        return 100.0

    def fit_card_calibration(self, refs, pupils):
        self.fits.append({"ref_list": list(refs), "pupil_list": list(pupils)})


def notification(subject, **kwargs):
    return message("notify." + subject, subject=subject, timestamp=101.0,
                   gazer_class_name="Gazer3D", **kwargs)


class StaticTracker:
    # Protocol-state tests inject a deterministic tracker; real optical flow is tested separately.
    def __init__(self, message, x, y):
        self.position = (x * message.payload["width"], y * message.payload["height"])

    def update(self, message):
        return self.position


class CalibrationTests(unittest.TestCase):
    def test_native_scores_require_verified_fit_and_fresh_frame(self):
        calibration = self.begin()
        calibration.network.backend = 'native'
        self.sample(calibration)
        calibration.finish()
        metrics = {'unit': 'source_pixels', 'independent_validation': False,
                   'left': {'mean_error_px': 8.}, 'right': {'mean_error_px': 7.5}}
        from services.eye_tracking.adapters.pupil_core.angular_metrics import summarize_angles
        angular = {'independentValidationPerformed': False, 'metrics': {
            'left': summarize_angles([.5]), 'right': summarize_angles([1.]), 'binocular': summarize_angles([2.])}}
        calibration.handle(notification('calibration.setup.v2', calib_data=calibration.network.fits[0]))
        self.assertIsNone(calibration.handle(notification('calibration.successful')))
        self.assertIsNone(calibration.handle(notification('calibration.result.v2', version=2,
                                                        params={'training_reprojection': metrics, 'training_angular': angular})))
        self.assertFalse(calibration.verified)
        result = calibration.observe_card_data(message(timestamp=102))
        self.assertEqual(result['left_score'], 8.)
        self.assertEqual(result['right_score'], 7.5)
        self.assertEqual(result['score_semantics'], 'training_reprojection_error_px')
        self.assertFalse(result['calibration_metrics']['independent_validation'])
        self.assertEqual(result['training_angular']['metrics']['left']['qualityScore'], 9.)
        self.assertEqual(result['training_angular']['metrics']['right']['qualityScore'], 8.)
        self.assertIn('左眼校准训练分：9.0/10', result['msg'])
        self.assertIn('未独立验证', result['msg'])
        calibration.cancel()
        self.assertIsNone(calibration.observe_card_data(message(timestamp=103)))
        self.assertFalse(calibration.verified)

    def begin(self, points=1):
        calibration = PupilCalibration(FakeRemote(), tracker_factory=StaticTracker)
        calibration.start(points=points)
        calibration.observe_card_data(message(timestamp=100))
        return calibration

    def sample(self, calibration, valid=True):
        calibration.sample_card_point(calibration.card_index, .25, .3, 1)
        for i in range(30):
            timestamp = 100.01 + i / 100
            calibration.observe_card_data(message(timestamp=timestamp))
            for eye in (0, 1):
                calibration.observe_card_data(message(f"pupil.{eye}.3d", timestamp=timestamp,
                    id=eye, confidence=.9 if valid else .1, sphere={"center": [0, 0, 30]}, circle_3d={}, model_confidence=1, diameter_3d=3))
        calibration.card_sample["until"] = time.monotonic() - 1
        return calibration.tick()

    def test_card_coordinates_and_real_result_required(self):
        calibration = self.begin()
        self.assertEqual(self.sample(calibration)["error"], 0)
        ref = calibration.card_refs[0]
        self.assertEqual(ref["norm_pos"], [.25, .7])
        self.assertEqual(ref["screen_pos"], [.5, .3])
        calibration.finish()
        calibration.finish()
        self.assertEqual(len(calibration.network.fits), 1)
        self.assertFalse(calibration.verified)
        calibration.handle(notification("calibration.successful"))
        calibration.handle(notification("calibration.result.v2", params={}, version=2))
        self.assertFalse(calibration.verified)
        calibration.handle(notification("calibration.setup.v2", calib_data=calibration.network.fits[0]))
        calibration.handle(notification("calibration.successful"))
        result = calibration.handle(notification("calibration.result.v2", params={}, version=2))
        self.assertIsNone(result)
        self.assertFalse(calibration.verified)
        self.assertIsNone(calibration.observe_card_data(message(timestamp=100.9)))
        result = calibration.observe_card_data(message(timestamp=102))
        self.assertTrue(calibration.verified)
        self.assertEqual(result["coe"], calibration.complete())
        calibration.handle(notification("calibration.started"))
        self.assertFalse(calibration.verified)

    def test_invalid_points_duplicate_and_stale_frame_rejected(self):
        calibration = self.begin()
        for point in ((float("nan"), .5), (True, .5), (-.1, .5), (.5, 1.1)):
            with self.assertRaises(ValueError):
                calibration.sample_card_point(1, *point, 1)
        with self.assertRaises(ValueError):
            calibration.finish()
        calibration.card_frame = replace(calibration.card_frame, received_monotonic_s=time.monotonic() - 1)
        with self.assertRaises(ValueError):
            calibration.sample_card_point(1, .5, .5, 1)
        calibration.observe_card_data(message(timestamp=100))
        calibration.sample_card_point(1, .5, .5, 1)
        with self.assertRaises(ValueError):
            calibration.sample_card_point(1, .5, .5, 2)
        with self.assertRaises(ValueError):
            calibration.finish()

    def test_resolution_change_rejects_sample_without_advancing(self):
        calibration = self.begin()
        calibration.sample_card_point(1, .5, .5, 1)
        calibration.observe_card_data(message(timestamp=100.01, width=1280, height=720))
        calibration.card_sample["until"] = time.monotonic() - 1
        result = calibration.tick()
        self.assertEqual(result["error"], -1)
        self.assertEqual(calibration.card_index, 1)
        self.assertEqual(calibration.card_refs, [])
        self.assertIn("分辨率", result["msg"])

    def test_degenerate_three_points_do_not_request_fit(self):
        calibration = self.begin(points=3)
        for _ in range(3):
            calibration.observe_card_data(message(timestamp=100))
            self.sample(calibration)
        with self.assertRaisesRegex(ValueError, "覆盖不足"):
            calibration.finish()
        self.assertEqual(calibration.network.fits, [])
        self.assertFalse(calibration.verified)

    def test_insufficient_sampling_retries_same_index(self):
        calibration = self.begin()
        self.assertEqual(self.sample(calibration, valid=False)["error"], -1)
        self.assertEqual(calibration.card_index, 1)
        self.assertEqual(calibration.card_refs, [])
        self.assertFalse(calibration.verified)
        calibration.observe_card_data(message(timestamp=100))
        self.assertEqual(self.sample(calibration)["error"], 0)

    def test_failed_detector_enable_does_not_leave_calibration_running(self):
        from unittest.mock import Mock
        calibration = self.begin()
        calibration.cancel()
        calibration.network.enable_pupil_detection = Mock(side_effect=RuntimeError("Capture timeout"))
        with self.assertRaisesRegex(RuntimeError, "Capture timeout"):
            calibration.start()
        self.assertFalse(calibration.pending)
        self.assertIsNone(calibration.worker)

    def test_zero_pupils_reports_actual_rejection_and_never_advances(self):
        cases = [
            (None, {}, "未收到瞳孔数据", {}),
            ("2d", {"confidence": .9}, "3D 瞳孔检测未输出", {"not_3d": 24}),
            ("3d", {"confidence": .1, "sphere": {}, "circle_3d": {}}, "置信度不足", {"low_confidence": 24}),
            ("3d", {"confidence": .9}, "眼球模型未就绪", {"missing_3d_model": 24}),
            ("3d", {"confidence": .9, "sphere": {}, "circle_3d": {}, "timestamp": 99},
             "时间落后", {"before_reference_window": 24}),
            ("3d", {"confidence": .9, "sphere": {"center": [0, 0, 30]}, "circle_3d": {}, "model_confidence": 1, "diameter_3d": 3, "timestamp": 200},
             "时间不匹配", {}),
        ]
        for mode, data, reason, rejected in cases:
            with self.subTest(reason=reason):
                calibration = self.begin()
                calibration.sample_card_point(1, .25, .3, 1)
                for index in range(12):
                    timestamp = 100.01 + index / 30
                    calibration.observe_card_data(message(timestamp=timestamp))
                    if mode:
                        for eye in (0, 1):
                            calibration.observe_card_data(message(f"pupil.{eye}.{mode}", id=eye,
                                                                  **{"timestamp": timestamp, **data}))
                calibration.card_sample["until"] = time.monotonic() - 1
                result = calibration.tick()
                self.assertEqual(result["error"], -1)
                self.assertIn(reason, result["msg"])
                self.assertEqual(result["pupil_diagnostics"]["paired_by_eye"], [0, 0])
                self.assertEqual(result["pupil_diagnostics"]["rejected"], rejected)
                self.assertEqual(calibration.card_index, 1)
                self.assertEqual(calibration.card_pupils, [])
                self.assertEqual(calibration.network.fits, [])

    def test_mixed_2d_and_3d_samples_keep_only_matching_3d_data(self):
        calibration = self.begin()
        calibration.sample_card_point(1, .25, .3, 1)
        for i in range(12):
            timestamp = 100.01 + i / 30
            calibration.observe_card_data(message(timestamp=timestamp))
            for eye in (0, 1):
                calibration.observe_card_data(message(f"pupil.{eye}.2d", id=eye, timestamp=timestamp,
                                                      confidence=.9, sphere={"center": [0, 0, 30]}, circle_3d={}, model_confidence=1, diameter_3d=3))
                calibration.observe_card_data(message(f"pupil.{eye}.3d", id=eye, timestamp=timestamp,
                                                      confidence=.9, sphere={"center": [0, 0, 30]}, circle_3d={}, model_confidence=1, diameter_3d=3))
        calibration.card_sample["until"] = time.monotonic() - 1
        result = calibration.tick()
        self.assertEqual(result["error"], 0)
        self.assertEqual(result["pupil_diagnostics"]["rejected"], {"not_3d": 24})
        self.assertEqual(result["pupil_diagnostics"]["paired_by_eye"], [12, 12])
        self.assertEqual(len(calibration.card_pupils), 24)
        self.assertEqual(calibration.network.detection_requests, 1)

    def test_cancel_timeout_and_failure_never_restore_token(self):
        calibration = self.begin()
        self.sample(calibration)
        calibration.finish()
        fit = calibration.network.fits[0]
        calibration.cancel()
        for subject, data in (("calibration.setup.v2", {"calib_data": fit}),
                              ("calibration.successful", {}),
                              ("calibration.result.v2", {"version": 2, "params": {}})):
            calibration.handle(notification(subject, **data))
        self.assertFalse(calibration.verified)
        calibration.start()
        calibration.deadline = time.monotonic() - 1
        self.assertEqual(calibration.tick()["error"], -1)
        self.assertFalse(calibration.pending)
        calibration = self.begin()
        self.sample(calibration)
        calibration.finish()
        self.assertEqual(calibration.handle(notification("calibration.failed", reason="Not enough data"))["error"], -1)
        self.assertFalse(calibration.verified)

    def test_wrong_setup_stale_or_wrong_gazer_cannot_authorize(self):
        calibration = self.begin()
        self.sample(calibration)
        calibration.finish()
        calibration.handle(notification("calibration.setup.v2", calib_data={}))
        self.assertFalse(calibration.started)
        stale = message("notify.calibration.setup.v2", subject="calibration.setup.v2", timestamp=99,
                        gazer_class_name="Gazer3D", calib_data=calibration.network.fits[0])
        calibration.handle(stale)
        self.assertFalse(calibration.started)
        calibration.handle(notification("calibration.successful"))
        calibration.handle(notification("calibration.result.v2", params={}, version=2))
        self.assertFalse(calibration.verified)

    def test_fit_success_without_resumed_world_times_out(self):
        calibration = self.begin()
        self.sample(calibration)
        calibration.finish()
        calibration.handle(notification("calibration.setup.v2", calib_data=calibration.network.fits[0]))
        calibration.handle(notification("calibration.successful"))
        calibration.handle(notification("calibration.result.v2", params={}, version=2))
        self.assertFalse(calibration.verified)
        calibration.deadline = time.monotonic() - 1
        self.assertIsNone(calibration.observe_card_data(message(timestamp=102)))
        self.assertEqual(calibration.tick()["error"], -1)
        self.assertFalse(calibration.verified)

    def test_world_watchdog_grace_is_bounded_and_only_during_fit(self):
        from unittest.mock import Mock
        from services.eye_tracking.adapters.pupil_core.service import PupilService
        from services.eye_tracking.adapters.pupil_core.network import PupilTimeout
        service = PupilService(frame_timeout_s=.1)
        service.network = Mock()
        service.state = "ready"
        service._last_world_received = time.monotonic() - 1
        service._receive = Mock(return_value=[])
        service.calibration.pending = True
        service.calibration.finishing = True
        service.calibration.deadline = time.monotonic() + 1
        self.assertEqual(service.read(0), [])
        service.calibration.deadline = time.monotonic() - 1
        with self.assertRaises(PupilTimeout):
            service.read(0)
        self.assertEqual(service.state, "failed")

    def test_world_watchdog_reads_queued_frame_before_timeout(self):
        from unittest.mock import Mock
        from services.eye_tracking.adapters.pupil_core.service import PupilService
        service = PupilService(frame_timeout_s=.1)
        service.network = Mock()
        service.state = "ready"
        service._last_world_received = time.monotonic() - 1
        def receive(_timeout):
            service._last_world_received = time.monotonic()
            return []
        service._receive = receive
        self.assertEqual(service.read(0), [])
        self.assertEqual(service.state, "ready")
