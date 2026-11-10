import csv
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from services.eye_tracking.infrastructure.pupil_recovery import recover_directory
from services.eye_tracking.infrastructure.pupil_recorder import PupilRecorder
from .test_recording import frame


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required")
class RecoveryTests(unittest.TestCase):
    def test_symlink_sidecar_cannot_modify_external_recording(self):
        with tempfile.TemporaryDirectory() as temp, tempfile.TemporaryDirectory() as external:
            target = Path(external) / "user-data"
            target.mkdir()
            link = Path(temp) / "linked.pupil"
            try:
                link.symlink_to(target, target_is_directory=True)
            except OSError:
                self.skipTest("Creating symlinks requires privileges on this platform")
            self.assertEqual(recover_directory(temp), [])
            self.assertEqual(list(target.iterdir()), [])

    def test_live_recording_is_never_recovered(self):
        with tempfile.TemporaryDirectory() as temp:
            recorder = PupilRecorder(Path(temp), "live", frame())
            recorder.start()
            try:
                self.assertEqual(recover_directory(temp), [])
                self.assertEqual(json.loads(recorder.meta_path.read_text())["status"], "preparing")
            finally:
                self.assertEqual(recorder.finish()["status"], "complete")

    def test_abrupt_process_and_encoder_exit_recovers_verified_partial(self):
        with tempfile.TemporaryDirectory() as temp:
            script = '''
import os, sys, time
from pathlib import Path
from services.eye_tracking.infrastructure.pupil_recorder import PupilRecorder
from tests.eye_tracking.pupil_core.test_recording import frame, gaze
r = PupilRecorder(Path(sys.argv[1]), "crash", frame(), fps=30, stimulus="material")
r.start()
r.set_stimulus("later material", 10.2)
r.add_marker({"timestamp": 200, "name": "before crash", "type": "custom"})
for i in range(1, 100):
    r.submit([frame(10 + i / 30, i + 1), gaze(10 + i / 30)])
    time.sleep(.015)
r._process.kill()
r._process.wait()
os._exit(0)
'''
            result = subprocess.run([sys.executable, "-c", script, temp], capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            root = Path(temp)
            spool = root / "crash.pupil/gaze-spool.jsonl"
            with spool.open("a") as handle:
                handle.write('{"torn":')
            results = recover_directory(root)
            self.assertEqual(results, [{"recording_id": "crash", "status": "partial"}])
            meta = json.loads((root / "crash.meta.json").read_text())
            self.assertTrue(meta["videoVerified"])
            self.assertTrue(meta["recoveredAfterInterruption"])
            self.assertGreater(meta["durationSeconds"], 1)
            self.assertGreater(meta["gazeRows"], 0)
            self.assertTrue((root / "crash.pupil/interrupted.mp4").is_file())
            with (root / "crash.csv").open(newline="") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual([r["customMarker"] for r in rows if r["customMarker"]], ["before crash"])
            self.assertTrue(all(row["stimulus"] == "crash" for row in rows))
            context = json.loads((root / "crash.pupil/context.json").read_text())
            self.assertEqual(context["stimuli"], [[0.0, "crash"]])
            timestamps = [float(r["video_time_ms"]) for r in rows]
            self.assertEqual(timestamps, sorted(timestamps))
            self.assertTrue(all(float(r["video_time_ms"]) < meta["durationSeconds"] * 1000 for r in rows))
            self.assertEqual(recover_directory(root), [])  # idempotent

    def test_unreadable_and_legacy_files_are_not_reported_complete(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name, model in (("bad", "PupilCore"), ("old", "Pro")):
                (root / f"{name}.pupil").mkdir()
                (root / f"{name}.mp4").write_bytes(b"unreadable")
                (root / f"{name}.meta.json").write_text(json.dumps({"status": "preparing", "deviceModel": model, "productIntegration": True}))
            results = recover_directory(root)
            self.assertEqual(results[0]["status"], "failed")
            self.assertEqual((root / "bad.mp4").read_bytes(), b"unreadable")
            self.assertEqual(json.loads((root / "old.meta.json").read_text())["status"], "preparing")
