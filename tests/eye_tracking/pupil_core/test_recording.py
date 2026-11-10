import csv
import builtins
from dataclasses import asdict, replace
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

from services.eye_tracking.domain.contracts import EyeTrackingError
from services.eye_tracking.domain.samples import EyeEventSample, GazeSample, SampleIdentity, VideoFrame
from services.eye_tracking.infrastructure.pupil_csv import gaze_csv_row
from services.eye_tracking.infrastructure.pupil_recorder import PupilRecorder, RecordingError, validate_record_name
from services.eye_tracking.domain.timeline import FrameTimeline


def frame(timestamp=10.0, sequence=1, generation=1):
    identity = SampleIdentity("PupilCore", "frame.world", generation, sequence, timestamp, 100)
    return VideoFrame(identity, "scene", 16, 16, "bgr", bytes([0, 0, 255]) * 256, sequence)


def gaze(timestamp=10.1, *, valid=True):
    identity = SampleIdentity("PupilCore", "gaze.3d.01.", 1, 100, timestamp, 100)
    return GazeSample(identity, (0.25, 0.75), "world_normalized_bottom_left", 0.9, valid, ("left", "right"))


class TimelineTests(unittest.TestCase):
    def test_gap_keeps_source_duration_and_records_repeats(self):
        timeline = FrameTimeline(frame(), fps=10, max_gap_s=0.5)
        output = timeline.initial() + timeline.push(frame(10.3, 2))
        tail, duration = timeline.finish()
        output += tail
        self.assertEqual([o.index for o in output], [0, 1, 2, 3])
        self.assertEqual([o.source.source_index for o in output], [1, 1, 1, 2])
        self.assertEqual([o.repeated for o in output], [False, True, True, False])
        self.assertAlmostEqual(duration, 0.4)

    def test_irregular_source_never_uses_a_future_frame(self):
        timeline = FrameTimeline(frame(), fps=30)
        output = timeline.initial()
        for index, timestamp in enumerate((10.011, 10.037, 10.079, 10.091), start=2):
            output += timeline.push(frame(timestamp, index))
        tail, duration = timeline.finish()
        output += tail
        for item in output:
            self.assertLessEqual(item.source.identity.source_time_s - timeline.t0, item.pts_s + 1e-9)
        self.assertAlmostEqual(duration, len(output) / 30)

    def test_invalid_stream_time_gap_and_generation(self):
        for incoming in (frame(10), frame(9), frame(11), frame(10.1, generation=2),
                         replace(frame(10.1), width=18)):
            with self.subTest(incoming=incoming), self.assertRaises(EyeTrackingError):
                FrameTimeline(frame()).push(incoming)

    def test_coordinate_conversion_and_missing_data(self):
        row = gaze_csv_row(gaze(), 10)
        self.assertAlmostEqual(row["video_time_ms"], 100)
        self.assertEqual((row["recom_gaze_x"], row["recom_gaze_y"]), (0.25, 0.25))
        self.assertEqual(row["recom_smooth_point_x"], '')
        self.assertEqual(row.get("left_pupil_diameter", ""), "")  # No source pupil means no invented diameter.
        invalid = gaze_csv_row(gaze(valid=False), 10)
        self.assertEqual(invalid["recom_gaze_x"], "")
        self.assertEqual(invalid["recom_gaze_bit_mask"], 0)

    def test_csv_uses_actual_mrt_parser(self):
        root = Path(__file__).resolve().parents[3]
        if not shutil.which("node") or not (root / "node_modules/typescript").exists():
            if os.environ.get("MRT_REQUIRE_CONSUMER_TESTS") == "1":
                self.fail("Node and repository TypeScript dependency are required")
            self.skipTest("Node/TypeScript unavailable")
        rows = [gaze_csv_row(gaze(), 10), gaze_csv_row(gaze(valid=False), 10),
                gaze_csv_row(replace(gaze(), position=(0.0, 1.0)), 10)]
        result = subprocess.run(["node", str(Path(__file__).with_name("check_csv.mjs"))],
                                input=json.dumps(rows), text=True, capture_output=True, cwd=root, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("top-left-zero-pair", result.stdout)

    def test_path_safety_and_no_overwrite(self):
        for name in ("../old", "a/b", "CON", "com1", "name.", "", "a\\b"):
            with self.assertRaises(ValueError):
                validate_record_name(name)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "existing.mp4"
            path.write_bytes(b"user-data")
            recorder = PupilRecorder(Path(temp), "existing", frame())
            with self.assertRaises(FileExistsError):
                recorder.start()
            self.assertEqual(path.read_bytes(), b"user-data")

    def test_missing_encoder_fails_and_leaves_diagnostics(self):
        with tempfile.TemporaryDirectory() as temp:
            recorder = PupilRecorder(Path(temp), "broken", frame(), ffmpeg=str(Path(temp) / "missing-ffmpeg"))
            with self.assertRaises(RecordingError):
                recorder.start()
            result = recorder.finish()
            self.assertEqual(result["status"], "failed")
            self.assertFalse(result["videoVerified"])
            self.assertTrue((Path(temp) / "broken.pupil" / "diagnostics.json").exists())

    def test_missing_recording_dependency_fails_before_reserving_files(self):
        real_import = builtins.__import__

        def missing_msgpack(name, *args, **kwargs):
            if name == "msgpack":
                raise ModuleNotFoundError("No module named 'msgpack'", name="msgpack")
            return real_import(name, *args, **kwargs)

        with tempfile.TemporaryDirectory() as temp:
            recorder = PupilRecorder(Path(temp), "missing_dependency", frame(), source_model="HH_ET28")
            with patch("builtins.__import__", side_effect=missing_msgpack), \
                    self.assertRaisesRegex(RecordingError, "Recording dependency unavailable:.*msgpack"):
                recorder.start(timeout_s=.1)
            result = recorder.finish(timeout_s=.01)
            self.assertEqual(result["status"], "failed")
            self.assertIn("msgpack", result["error"])
            self.assertTrue(recorder._ready.is_set())
            self.assertTrue(recorder._done.is_set())
            self.assertIsNone(recorder._thread)
            self.assertIsNone(recorder._lease)
            self.assertEqual(list(Path(temp).iterdir()), [])
            self.assertEqual(recorder.finish(), result)

    def test_worker_initialization_failure_signals_completion_and_releases_lease(self):
        real_import = builtins.__import__

        def missing_in_worker(name, *args, **kwargs):
            if name == "msgpack" and threading.current_thread().name == "pupil-recorder":
                raise ModuleNotFoundError("No module named 'msgpack'", name="msgpack")
            return real_import(name, *args, **kwargs)

        with tempfile.TemporaryDirectory() as temp:
            recorder = PupilRecorder(Path(temp), "worker_failure", frame(), source_model="HH_ET28")
            with patch("builtins.__import__", side_effect=missing_in_worker), \
                    patch("threading.excepthook") as unhandled, \
                    patch("services.eye_tracking.infrastructure.pupil_recorder.subprocess.Popen") as encoder, \
                    self.assertLogs(level="ERROR"), \
                    self.assertRaisesRegex(RecordingError, "prepare:.*msgpack"):
                recorder.start(timeout_s=1)
            result = recorder.finish(timeout_s=.01)
            recorder._thread.join(1)
            self.assertEqual(result["status"], "failed")
            self.assertIn("msgpack", result["error"])
            self.assertTrue(recorder._ready.is_set())
            self.assertTrue(recorder._done.is_set())
            self.assertFalse(recorder._thread.is_alive())
            self.assertTrue(recorder._lease.handle.closed)
            self.assertFalse(recorder.video_path.exists())
            diagnostic = json.loads((recorder.sidecar / "diagnostics.json").read_text())
            self.assertEqual(diagnostic["error"], result["error"])
            encoder.assert_not_called()
            unhandled.assert_not_called()

    def test_bounded_queue_never_silently_drops(self):
        recorder = PupilRecorder(Path("unused"), "bounded", frame(), queue_size=1, queue_bytes=2000)
        recorder.state = "recording"
        recorder.submit([frame()])
        with self.assertRaises(RecordingError):
            recorder.submit([frame(10.1, 2)])
        with self.assertRaises(RecordingError):
            recorder.check()
        self.assertEqual(recorder._queue.qsize(), 1)


class MediaRecordingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
            if os.environ.get("MRT_REQUIRE_MEDIA_TESTS") == "1":
                raise RuntimeError("FFmpeg and ffprobe are required for this test run")
            raise unittest.SkipTest("FFmpeg/ffprobe not installed")

    def test_real_mp4_csv_and_frame_map(self):
        with tempfile.TemporaryDirectory() as temp:
            recorder = PupilRecorder(Path(temp), "real", frame(), fps=10)
            recorder.start()
            recorder.submit([gaze(9.9), gaze(10), gaze(10.1), gaze(10.31), gaze(11)])
            recorder.submit([frame(10.3, 2)])
            result = recorder.finish()
            self.assertEqual(result["status"], "complete", result)
            self.assertTrue(result["videoVerified"])
            self.assertEqual(result["outputFrames"], 4)
            self.assertEqual(result["repeatedFrames"], 2)
            self.assertEqual(result["gazeRows"], 3)
            self.assertEqual(result["gazeOutsideVideo"], 2)
            self.assertAlmostEqual(result["durationSeconds"], 0.4)
            with recorder.csv_path.open(newline="", encoding="utf-8") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(len(rows), 3)
            self.assertAlmostEqual(float(rows[1]["video_time_ms"]), 100)
            self.assertEqual(float(rows[1]["recom_gaze_y"]), 0.25)
            with (recorder.sidecar / "frame-map.csv").open(newline="", encoding="utf-8") as handle:
                mapping = list(csv.DictReader(handle))
            self.assertEqual([row["source_index"] for row in mapping], ["1", "1", "1", "2"])
            metadata = json.loads(recorder.meta_path.read_text(encoding="utf-8"))
            self.assertEqual(metadata["deviceModel"], "PupilCore")
            self.assertTrue(metadata["productIntegration"])
            self.assertEqual(recorder.finish(), result)
            self.assertEqual(recorder.state, "complete")

    def test_glasses_use_recording_stimulus_and_preserve_source_data(self):
        import msgpack
        from services.eye_tracking.adapters.pupil_core.network import WireMessage

        cases = (("PupilCore", {}), ("PupilCore", {"deviceType": "眼镜式"}),
                 ("HH_ET28", {"deviceType": "眼镜式"}), ("FutureGlasses", {"deviceType": "眼镜式"}))
        for index, (model, metadata) in enumerate(cases):
            with self.subTest(model=model, metadata=metadata), tempfile.TemporaryDirectory() as temp:
                name = f"scene_{index}"
                recorder = PupilRecorder(Path(temp), name, frame(), fps=10, source_model=model,
                                         metadata=metadata, stimulus="initial material")
                samples = [gaze(10.05), gaze(10.25),
                           EyeEventSample(SampleIdentity(model, "fixations", 1, 101, 10.1, 100),
                                          "fixation", 7, 100, (0.2, 0.8), 0.9, True)]
                packet = WireMessage("vendor.marker", {"original": True},
                                     (b"vendor.marker", msgpack.packb({"original": True})), 100)
                recorder.start()
                recorder.set_stimulus("next material", 10.2)
                recorder.set_stimulus("", 10.3)
                recorder.add_marker({"timestamp": 150, "name": "mark", "type": "custom"})
                recorder.submit([*samples, frame(10.3, 2)], [packet])
                result = recorder.finish()
                self.assertEqual(result["status"], "complete", result)
                self.assertAlmostEqual(result["durationSeconds"], 0.4)
                self.assertEqual(result["deviceModel"], model)
                self.assertEqual(result["deviceType"], "眼镜式")
                self.assertEqual(result["fixationEvents"], 1)
                context = json.loads((recorder.sidecar / "context.json").read_text())
                self.assertEqual(context["stimuli"], [[0.0, name]])
                manifest = json.loads((recorder.sidecar / "recovery.json").read_text())
                self.assertEqual(manifest["name"], name)
                self.assertEqual(manifest["deviceModel"], model)
                with recorder.csv_path.open(newline="", encoding="utf-8") as handle:
                    rows = list(csv.DictReader(handle))
                gaze_rows = [row for row in rows if row["pupil_valid"]]
                self.assertEqual(len(gaze_rows), 2)
                self.assertEqual([row["stimulus"] for row in gaze_rows], [name, name])
                self.assertEqual([row["stimulus"] for row in rows if row["customMarker"]], [name])
                for row in gaze_rows:
                    self.assertEqual((float(row["recom_gaze_x"]), float(row["recom_gaze_y"])), (0.25, 0.25))
                fixation = next(row for row in rows if row["source_event_type"] == "fixation")
                self.assertEqual(fixation["source_event_id"], "7")
                self.assertAlmostEqual(float(fixation["fixation_duration_ms"]), 100)
                self.assertAlmostEqual(float(fixation["fixation_center_x"]), 0.2)
                self.assertAlmostEqual(float(fixation["fixation_center_y"]), 0.2)
                normalized = [json.loads(line) for line in (recorder.sidecar / "normalized-samples.jsonl").read_text().splitlines()]
                self.assertEqual(normalized, json.loads(json.dumps([asdict(sample) for sample in samples])))
                events = [json.loads(line) for line in (recorder.sidecar / "events-spool.jsonl").read_text().splitlines()]
                self.assertEqual(events, [json.loads(json.dumps(asdict(samples[-1])))])
                with (recorder.sidecar / "source-messages.msgpack").open("rb") as source:
                    raw_messages = list(msgpack.Unpacker(source, raw=False))
                self.assertEqual(raw_messages, [{"received_monotonic_s": 100, "parts": list(packet.raw_parts)}])

    def test_desktop_retains_material_changes_in_csv_and_recovery_context(self):
        with tempfile.TemporaryDirectory() as temp:
            recorder = PupilRecorder(Path(temp), "desktop", frame(), fps=10, source_model="HH_ET10C",
                                     metadata={"deviceType": "桌面式"}, stimulus="first material")
            recorder.start()
            recorder.set_stimulus("second material", 10.2)
            recorder.submit([gaze(10.05), gaze(10.25), frame(10.3, 2)])
            result = recorder.finish()
            self.assertEqual(result["status"], "complete", result)
            self.assertEqual(result["deviceType"], "桌面式")
            with recorder.csv_path.open(newline="", encoding="utf-8") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual([row["stimulus"] for row in rows], ["first material", "second material"])
            context = json.loads((recorder.sidecar / "context.json").read_text())
            self.assertEqual([item[1] for item in context["stimuli"]], ["first material", "second material"])
            self.assertAlmostEqual(context["stimuli"][1][0], 200)
            manifest = json.loads((recorder.sidecar / "recovery.json").read_text())
            self.assertEqual(manifest["deviceType"], "桌面式")

    def test_acquisition_failure_finalizes_partial_video(self):
        with tempfile.TemporaryDirectory() as temp:
            recorder = PupilRecorder(Path(temp), "partial", frame(), fps=10)
            recorder.start()
            recorder.submit([frame(10.1, 2)])
            result = recorder.finish(error="Capture disconnected")
            self.assertEqual(result["status"], "partial", result)
            self.assertTrue(result["videoVerified"])
            self.assertIn("disconnected", result["error"])

    def test_missing_ffprobe_uses_full_decode_and_saves_csv(self):
        with tempfile.TemporaryDirectory() as temp:
            recorder = PupilRecorder(Path(temp), "unverified", frame(), ffprobe=str(Path(temp) / "missing-ffprobe"))
            recorder.start()
            result = recorder.finish()
            self.assertEqual(result["status"], "complete", result)
            self.assertTrue(result["videoVerified"])
            self.assertEqual(result["videoVerificationMethod"], "ffmpeg-framemd5")
            self.assertTrue(recorder.csv_path.is_file())

    def test_fallback_rejects_corrupt_video_and_wrong_counts(self):
        from services.eye_tracking.infrastructure.pupil_video_verification import verify_video
        with tempfile.TemporaryDirectory() as temp:
            recorder = PupilRecorder(Path(temp), "checked", frame(), fps=10)
            recorder.start()
            recorder.submit([frame(10.3, 2)])
            result = recorder.finish()
            self.assertEqual(result["status"], "complete", result)
            args = dict(ffmpeg="ffmpeg", ffprobe=str(Path(temp) / "missing"),
                        frames=4, width=16, height=16, duration=.4, fps=10)
            self.assertEqual(verify_video(recorder.video_path, **args), "ffmpeg-framemd5")
            for overrides in ({"frames": 5}, {"width": 18}, {"duration": 1.0}):
                with self.assertRaises(ValueError):
                    verify_video(recorder.video_path, **{**args, **overrides})
            recorder.video_path.write_bytes(b"broken mp4")
            with self.assertRaisesRegex(ValueError, "FFmpeg video verification failed"):
                verify_video(recorder.video_path, **args)

    def test_installer_ffmpeg_can_verify_without_new_options(self):
        binary = Path(__file__).resolve().parents[3] / "node_modules/@ffmpeg-installer"
        binaries = list(binary.glob("*/ffmpeg"))
        if not binaries:
            self.skipTest("Installer binary unavailable on this host")
        with tempfile.TemporaryDirectory() as temp:
            recorder = PupilRecorder(Path(temp), "installer", frame(), fps=10,
                                     ffmpeg=str(binaries[0]), ffprobe=str(Path(temp) / "missing"))
            recorder.start()
            recorder.submit([frame(10.3, 2)])
            result = recorder.finish()
            self.assertEqual(result["status"], "complete", result)
            self.assertEqual(result["videoVerificationMethod"], "ffmpeg-framemd5")

    def test_existing_but_failing_probe_does_not_bypass_failure(self):
        from unittest.mock import patch
        from services.eye_tracking.infrastructure.pupil_video_verification import verify_video
        with patch("subprocess.run", side_effect=subprocess.CalledProcessError(1, "ffprobe")) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                verify_video("video.mp4", ffmpeg="ffmpeg", ffprobe="ffprobe", frames=1,
                             width=16, height=16, duration=.1, fps=10)
            self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
