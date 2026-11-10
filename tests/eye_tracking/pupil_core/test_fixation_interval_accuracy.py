"""Full native fixation centres must use unique samples, not overlapping windows."""
import math
import unittest

import numpy as np

from services.eye_tracking.adapters.pupil_native.events import NativeEvents
from .test_native_boundaries import gaze
from .test_data_accuracy import rows_for


class FixationIntervalAccuracyTests(unittest.TestCase):
    def samples(self):
        # Nonuniform drift and confidence make a last-window mean and an
        # unweighted mean of window means observably wrong.
        return [dict(gaze(index / 100, .8 * (index / 100) ** 2),
                     confidence=.6 + .4 * index / 100) for index in range(101)]

    def test_completed_interval_has_unique_sample_mean_and_full_duration(self):
        detector = NativeEvents()
        samples = self.samples()
        windows = [event for sample in samples for event in detector.fixation(sample)]
        final = detector.fixation(gaze(1.01, 5))[0]
        self.assertTrue(final['event_complete'])
        self.assertEqual(final['timestamp'], 0)
        self.assertAlmostEqual(final['duration'], 1000)
        self.assertEqual(final['id'], windows[-1]['id'])
        expected = np.mean([s['norm_pos'] for s in samples], axis=0)
        np.testing.assert_allclose(final['norm_pos'], expected)
        self.assertNotAlmostEqual(final['norm_pos'][0], windows[-1]['norm_pos'][0])
        self.assertAlmostEqual(final['confidence'], np.mean([s['confidence'] for s in samples]))
        rays = np.array([[math.sin(math.radians(.8 * (i / 100) ** 2)), 0,
                          math.cos(math.radians(.8 * (i / 100) ** 2))] for i in range(101)])
        direction = rays.mean(axis=0)
        np.testing.assert_allclose(final['direction'], direction / np.linalg.norm(direction))
        self.assertEqual(final['event_algorithm_parameters']['position_semantics'], 'complete_interval_sample_mean')
        rows, _ = rows_for([*windows, final], duration=2)
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(rows[0]['fixation_point_x_px'], expected[0] * 1280)
        self.assertAlmostEqual(rows[0]['fixation_duration_ms'], 1000)
        self.assertIsNone(detector.interval)

    def test_incomplete_retains_window_semantics_and_does_not_leak_into_next_event(self):
        detector = NativeEvents()
        windows = [event for sample in self.samples() for event in detector.fixation(sample)]
        interrupted = detector.fixation({**gaze(1.01), 'confidence': .1})[0]
        self.assertFalse(interrupted['event_complete'])
        self.assertEqual(interrupted['norm_pos'], windows[-1]['norm_pos'])
        self.assertEqual(interrupted['event_algorithm_parameters']['position_semantics'], 'online_window_sample_mean')
        self.assertIsNone(detector.interval)
        for i in range(21):
            detector.fixation(gaze(2 + i / 100, 1))
        final = detector.fixation(gaze(2.21, 5))[0]
        self.assertEqual(final['id'], 2)
        self.assertEqual(final['timestamp'], 2)
        self.assertAlmostEqual(final['duration'], 200)
        np.testing.assert_allclose(final['norm_pos'], [.51, .5])


if __name__ == '__main__':
    unittest.main()
