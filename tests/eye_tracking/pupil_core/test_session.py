import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

from tests.eye_tracking.pupil_core.tools.preview import LatestFrames
from tests.eye_tracking.pupil_core.tools.session import AcquisitionSession
from tests.eye_tracking.pupil_core.test_protocol import MockCapture


class SessionTests(unittest.TestCase):
    def test_preview_only_has_no_recording_side_effects(self):
        with MockCapture() as capture:
            session = AcquisitionSession(capture.config(), LatestFrames(), seconds=0.1)
            session.thread.start()
            self.assertTrue(session.done.wait(5))
            session.thread.join()
            self.assertEqual(session.result["status"], "complete", session.result)
            self.assertIsNone(session.result["recording"])
            self.assertEqual(set(capture.requests), {"v", "SUB_PORT"})

    def test_capture_to_real_video_csv_end_to_end(self):
        if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
            if os.environ.get("MRT_REQUIRE_MEDIA_TESTS") == "1":
                self.fail("FFmpeg/ffprobe required")
            self.skipTest("FFmpeg/ffprobe unavailable")
        with tempfile.TemporaryDirectory() as temp, MockCapture(video_size=(16, 16), version="mrt-pupil-simulator/1") as capture:
            session = AcquisitionSession(capture.config(), LatestFrames(), seconds=0.3,
                                         output_dir=Path(temp), name="integration", fps=30)
            session.thread.start()
            self.assertTrue(session.done.wait(15))
            session.thread.join()
            self.assertEqual(session.result["status"], "complete", session.result)
            recording = session.result["recording"]
            self.assertTrue(recording["videoVerified"])
            self.assertGreater(recording["outputFrames"], 1)
            self.assertGreater(recording["gazeRows"], 0)
            metadata = json.loads((Path(temp) / "integration.meta.json").read_text(encoding="utf-8"))
            self.assertEqual(metadata["status"], "complete")
            self.assertTrue(metadata["sourceInfo"]["simulatedSource"])
            self.assertEqual(set(capture.requests), {"v", "SUB_PORT"})
