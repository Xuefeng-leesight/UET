import json
import math
import unittest

from services.eye_tracking.adapters.pupil_core.angular_metrics import angular_errors, angular_score, summarize_angles
from services.eye_tracking.adapters.pupil_core.validation import measure_target
from services.eye_tracking.adapters.pupil_native.camera import Intrinsics
from . import test_quality as fixtures


def camera(scale=1):
    return Intrinsics({'resolution': [1280 * scale, 720 * scale],
        'camera_matrix': [[800 * scale, 0, 640 * scale], [0, 800 * scale, 360 * scale], [0, 0, 1]],
        'dist_coefs': [0, 0, 0, 0, 0], 'cam_type': 'radial', 'provenance': 'test',
        'individually_calibrated': False})


class AngularMetricsTests(unittest.TestCase):
    def test_custom_score_anchors_rounding_clipping_and_invalid_values(self):
        for degrees, expected in ((0, 10), (.5, 9), (1, 8), (2, 6), (4.5, 1), (180, 1),
                                  (.625, 8.8), (.663, 8.7), (1.184, 7.6), (2.333, 5.3)):
            with self.subTest(degrees=degrees):
                self.assertEqual(angular_score(degrees), expected)
        self.assertIsNone(angular_score(None))
        for invalid in (-1, 181, math.nan, math.inf, True, '1'):
            with self.assertRaises(ValueError):
                angular_score(invalid)

    def test_known_ray_angle_and_resolution_invariance(self):
        dx = 800 * math.tan(math.radians(3)) / 1280
        for cam in (camera(), camera(2)):
            errors = angular_errors([[.5, .5], [.5, .5]], [[.5 + dx, .5], [.5, .5]], cam)
            self.assertAlmostEqual(errors[0], 3, places=9)
            self.assertAlmostEqual(errors[1], 0, places=5)

    def test_distorted_radial_and_fisheye_roundtrip(self):
        for kind, distortion in [('radial', [.1, -.02, .001, -.001, 0]), ('fisheye', [.01, -.01, 0, 0])]:
            cam = Intrinsics({**camera().spec, 'cam_type': kind, 'dist_coefs': distortion})
            pixels = cam.projectPoints([[0, 0, 1], [math.tan(math.radians(3)), 0, 1]]).reshape(-1, 2)
            norm = [[x / 1280, 1-y / 720] for x, y in pixels]
            self.assertAlmostEqual(angular_errors([norm[0]], [norm[1]], cam)[0], 3, places=6)

    def test_official_cosine_mean_is_not_arithmetic_mean_and_exclusions_are_visible(self):
        result = summarize_angles([1., 3., 5., 6.])
        oracle = math.degrees(math.acos((math.cos(math.radians(1))+math.cos(math.radians(3)))/2))
        self.assertAlmostEqual(result['pupilCoreAccuracyDeg'], oracle)
        self.assertEqual(result['meanErrorDeg'], 3.75)
        self.assertEqual(result['pupilCoreUsedSamples'], 2)
        self.assertEqual(result['excludedSamples'], 2)
        self.assertEqual(result['qualityScore'], angular_score(oracle))
        self.assertNotEqual(result['qualityScore'], angular_score(result['meanErrorDeg']))
        self.assertEqual(result['scoringPolicy'], 'mrt_angular_linear_v1')
        self.assertFalse(result['scoreIsOfficial'])
        self.assertEqual(result['scoreInputMetric'], 'pupilCoreAccuracyDeg')
        self.assertIsNone(summarize_angles([6.])['pupilCoreAccuracyDeg'])
        self.assertIsNone(summarize_angles([5., 6.])['qualityScore'])
        self.assertIsNone(summarize_angles([])['meanErrorDeg'])
        self.assertIsNone(summarize_angles([])['qualityScore'])
        json.dumps(summarize_angles([]), allow_nan=False)
        with self.assertRaises(ValueError):
            summarize_angles([math.nan])

    def test_independent_samples_keep_eye_metrics_missing_instead_of_copying_fusion(self):
        dx = 800 * math.tan(math.radians(1)) / 1280
        refs = [{'timestamp': t, 'norm_pos': [.5, .5]} for t in (10, 10.02)]
        data = fixtures.gaze(stamp=10.01, pos=(.5 + dx, .5)).payload
        data['monocular'] = {'1': {'norm_pos': [.5, .5], 'gaze_point_3d': [0, 0, 500]}}
        result = measure_target(refs, [data], (1280, 720), camera())
        self.assertAlmostEqual(result['angular']['metrics']['binocular']['meanErrorDeg'], 1, places=8)
        self.assertAlmostEqual(result['angular']['metrics']['left']['meanErrorDeg'], 0, places=5)
        self.assertIsNone(result['angular']['metrics']['right']['meanErrorDeg'])
        self.assertEqual(result['angular']['metrics']['left']['qualityScore'], 10)
        self.assertIsNone(result['angular']['metrics']['right']['qualityScore'])
        no_camera = measure_target(refs, [data], (1280, 720))
        self.assertFalse(no_camera['angularAccuracyAvailable'])
        mismatch = measure_target(refs, [data], (1280, 720), camera(2))
        self.assertFalse(mismatch['angularAccuracyAvailable'])
        self.assertEqual(mismatch['angularUnavailableReason'], 'camera_resolution_mismatch')

    def test_full_validation_preserves_fit_archives_custom_scores_without_pass_fail(self):
        helper = fixtures.CalibrationQualityTests()
        calibration = helper.begin()
        calibration.pending, calibration.token = False, 'fit'
        calibration.network.calibration_camera = lambda: Intrinsics({**camera().spec,
            'resolution': [2, 1], 'camera_matrix': [[1, 0, 1], [0, 1, .5], [0, 0, 1]]})
        calibration.start_validation('fit')
        for x, y in ((.15, .15), (.85, .15), (.5, .85)):
            self.assertEqual(helper.sample(calibration, x, y)['error'], 0)
        result = calibration.finish()
        report = result['validation']
        self.assertTrue(report['angularAccuracyAvailable'])
        self.assertEqual(report['qualityScore'], 10)
        self.assertEqual(report['scoringPolicy'], 'mrt_angular_linear_v1')
        self.assertIn('融合独立验证分：10.0/10', result['msg'])
        self.assertIn('非厂商评分', result['msg'])
        self.assertIn('覆盖 3/3 个目标，有效率 100.0%', result['msg'])
        self.assertIn('左眼独立验证分：不可用', result['msg'])
        self.assertIsNone(report['angular']['metrics']['left']['qualityScore'])
        self.assertIsNone(report['angular']['metrics']['right']['qualityScore'])
        self.assertEqual(report['accuracyAcceptance'], 'not_configured')
        self.assertEqual(report['calibrationToken'], 'fit')
        self.assertFalse(report['angular']['officialPipelineEquivalent'])
        self.assertEqual(calibration.network.fits, [])
        self.assertEqual(calibration.snapshot()['validation'], report)
        json.dumps(calibration.snapshot(), allow_nan=False)
        calibration.start_validation('fit')
        calibration.cancel()
        self.assertEqual(calibration.snapshot()['validation'], report)

    def test_validation_without_camera_has_no_score(self):
        helper = fixtures.CalibrationQualityTests()
        calibration = helper.begin()
        calibration.pending, calibration.token = False, 'fit'
        calibration.start_validation('fit')
        for x, y in ((.15, .15), (.85, .15), (.5, .85)):
            self.assertEqual(helper.sample(calibration, x, y)['error'], 0)
        result = calibration.finish()
        self.assertIsNone(result['validation']['qualityScore'])
        self.assertFalse(result['validation']['angularAccuracyAvailable'])
        self.assertNotIn('/10', result['msg'])

    def test_training_position_reuse_requires_retry_and_does_not_refit(self):
        helper = fixtures.CalibrationQualityTests()
        calibration = helper.begin()
        calibration.pending, calibration.token = False, 'fit'
        calibration.card_centers = [(.15, .85)]
        calibration.start_validation('fit')
        helper.sample(calibration, .15, .15)
        self.assertEqual(calibration.card_index, 1)
        self.assertEqual(calibration.validation_points, [])
        self.assertEqual(calibration.network.fits, [])
