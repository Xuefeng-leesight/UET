import csv
from dataclasses import asdict
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from services.eye_tracking.adapters.pupil_core.data_normalizer import DataNormalizer
from services.eye_tracking.infrastructure.pupil_events import event_rows
from services.eye_tracking.infrastructure.pupil_recorder import PupilRecorder
from .test_protocol import message
from .test_recording import frame, gaze


def event(topic="fixations", timestamp=10, **kwargs):
    payload = {"id": 0, "duration": 300, "norm_pos": [0, 1], "confidence": .9, **kwargs}
    return DataNormalizer().normalize(message(topic, timestamp=timestamp, **payload), 1, 1)


class EventTests(unittest.TestCase):
    def test_overlapping_windows_merge_and_clip_to_video(self):
        events = [event(timestamp=9.9), event(timestamp=10.1), event("blinks", timestamp=10.2, type="onset"),
                  event("blinks", timestamp=10.21, type="onset"), event("blinks", timestamp=10.3, type="offset")]
        rows, meta = event_rows(io.StringIO("".join(json.dumps(asdict(e)) + "\n" for e in events)), 10, .35)
        self.assertEqual(meta["fixationEvents"], 1)
        self.assertEqual(meta["blinkOnsets"], 1)
        self.assertEqual(rows[0]["fixation_index"], 1)
        self.assertAlmostEqual(rows[0]["fixation_duration_ms"], 350)
        self.assertEqual((rows[0]["fixation_center_x"], rows[0]["fixation_center_y"]), (0, 0))
        self.assertEqual(rows[1].get("left_blink", ""), "")  # No invented eye attribution for Capture events.

    def test_invalid_event_is_not_fabricated(self):
        for kwargs in ({"id": -1}, {"duration": float("nan")}, {"duration": -1}):
            with self.assertRaises(RuntimeError):
                event(**kwargs)
        self.assertFalse(event(norm_pos=[2, 0]).valid)
        self.assertFalse(event(confidence=.1).valid)

    @unittest.skipUnless(shutil.which("node") and shutil.which("ffmpeg") and shutil.which("ffprobe"), "Media tools required")
    def test_events_reach_real_csv_parser_and_export(self):
        with tempfile.TemporaryDirectory() as temp:
            recorder = PupilRecorder(Path(temp), "events", frame(), fps=10)
            recorder.start()
            recorder.submit([gaze(10.1), gaze(10.2), gaze(10.3), frame(10.4, 2),
                             event(timestamp=10.0), event(timestamp=10.1),
                             event("blinks", timestamp=10.15, type="onset"),
                             event("blinks", timestamp=10.25, type="offset")])
            result = recorder.finish()
            self.assertEqual(result["status"], "complete", result)
            self.assertEqual(result["fixationEvents"], 1)
            self.assertEqual(result["gazeRows"], 3)
            self.assertEqual(result['pupilDataSchemaVersion'], 4)
            self.assertEqual(result['measurementAvailability']['imu'], 'not_supported_by_pupil_core')
            with recorder.csv_path.open(newline="") as handle:
                rows = list(csv.DictReader(handle))
            gaze_rows = [r for r in rows if r["pupil_valid"]]
            self.assertEqual(gaze_rows[1]["blink"], "1")
            self.assertEqual(gaze_rows[2]["blink"], "0")
            timestamps = [float(r["video_time_ms"]) for r in rows]
            self.assertEqual(timestamps, sorted(timestamps))
            check = subprocess.run(["node", str(Path(__file__).with_name("check_events.mjs")), str(recorder.csv_path)],
                                   capture_output=True, text=True, timeout=15)
            self.assertEqual(check.returncode, 0, check.stdout + check.stderr)
