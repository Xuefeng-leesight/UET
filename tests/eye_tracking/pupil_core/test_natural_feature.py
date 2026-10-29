import time
import unittest

import cv2
import msgpack
import numpy as np

from services.eye_tracking.adapters.pupil_core.natural_feature import NaturalFeatureTracker
from services.eye_tracking.adapters.pupil_core.network import decode_message
from services.eye_tracking.adapters.pupil_core.calibration import PupilCalibration
from tests.eye_tracking.pupil_core.test_calibration import FakeRemote


def frame(index, dx=0, dy=0, blank=False, jpeg=False):
    pixels = np.full((240, 320, 3), 190, np.uint8)
    if not blank:
        cv2.circle(pixels, (160 + dx, 120 + dy), 35, (0, 0, 0), -1)
        cv2.circle(pixels, (160 + dx, 120 + dy), 20, (255, 255, 255), -1)
        cv2.circle(pixels, (160 + dx, 120 + dy), 8, (0, 0, 0), -1)
        cv2.line(pixels, (110 + dx, 70 + dy), (120 + dx, 85 + dy), (0, 0, 0), 3)
    data = {'timestamp': 100 + index / 30, 'index': index, 'width': 320, 'height': 240,
            'format': 'jpeg' if jpeg else 'bgr'}
    buffer = cv2.imencode('.jpg', pixels)[1].tobytes() if jpeg else pixels.tobytes()
    return decode_message([b'frame.world', msgpack.packb(data), buffer], max_bytes=1024 * 1024)


class NaturalFeatureTests(unittest.TestCase):
    def test_moving_card_tracks_actual_center_in_bgr_and_jpeg(self):
        for jpeg in (False, True):
            tracker = NaturalFeatureTracker(frame(0, jpeg=jpeg), .5, .5)
            for index in range(1, 15):
                point = tracker.update(frame(index, index * 2, index, jpeg=jpeg))
                self.assertIsNotNone(point)
                self.assertAlmostEqual(point[0], 160 + index * 2, delta=1)
                self.assertAlmostEqual(point[1], 120 + index, delta=1)

    def test_large_frame_tracking_returns_original_source_pixels(self):
        def large(index, dx=0, dy=0):
            original = frame(index, dx, dy)
            pixels = np.frombuffer(original.raw_parts[2], np.uint8).reshape(240, 320, 3)
            pixels = cv2.resize(pixels, (1920, 1440))
            data = dict(original.payload, width=1920, height=1440)
            return decode_message([b'frame.world', msgpack.packb(data), pixels.tobytes()], max_bytes=10_000_000)
        tracker = NaturalFeatureTracker(large(0), .5, .5)
        self.assertEqual(tracker.tracking_size, (640, 480))
        point = tracker.update(large(1, 2, 1))
        self.assertIsNotNone(point)
        self.assertAlmostEqual(point[0], 972, delta=3)
        self.assertAlmostEqual(point[1], 726, delta=3)

    def test_blank_target_and_tracking_loss_are_not_static_references(self):
        with self.assertRaisesRegex(ValueError, '可追踪'):
            NaturalFeatureTracker(frame(0, blank=True), .5, .5)
        tracker = NaturalFeatureTracker(frame(0), .5, .5)
        self.assertIsNone(tracker.update(frame(1, blank=True)))
        tracker = NaturalFeatureTracker(frame(0), .5, .5)
        self.assertIsNone(tracker.update(frame(30)))

    def test_calibration_references_follow_scene_and_loss_retries(self):
        calibration = PupilCalibration(FakeRemote(), tracker_factory=lambda *args: NaturalFeatureTracker(*args))
        calibration.start(points=1)
        calibration.observe_card_data(frame(0))
        calibration.sample_card_point(1, .5, .5, 1)
        for index in range(1, 12):
            calibration.observe_card_data(frame(index, index * 2, index))
        refs = calibration.card_sample['refs']
        self.assertGreater(refs[-1]['norm_pos'][0], .55)
        self.assertLess(refs[-1]['norm_pos'][1], .48)
        self.assertAlmostEqual(refs[-1]['screen_pos'][0], 182, delta=1)
        calibration.observe_card_data(frame(12, blank=True))
        calibration.card_sample['until'] = time.monotonic() - 1
        response = calibration.tick()
        self.assertEqual(response['error'], -1)
        self.assertIn('追踪丢失', response['msg'])
        self.assertEqual(calibration.card_index, 1)
        self.assertEqual(calibration.card_refs, [])
        calibration.cancel()
        self.assertIsNone(calibration.card_sample)
