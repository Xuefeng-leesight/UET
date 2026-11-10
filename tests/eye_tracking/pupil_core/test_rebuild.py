import csv
from dataclasses import asdict
import json
from pathlib import Path
import tempfile
import unittest

import msgpack
from services.eye_tracking.adapters.pupil_core.data_normalizer import DataNormalizer
from tools.pupil.rebuild_recording import rebuild, digest
from .test_quality import gaze, pupil


class RebuildTests(unittest.TestCase):
    def fixture(self, root):
        source = root / "source"
        source.mkdir()
        csv_path = source / "record.csv"
        csv_path.write_text("original CSV\n")
        csv_path.with_suffix(".mp4").write_bytes(b"original completed video")
        csv_path.with_suffix(".meta.json").write_text(json.dumps({"status": "complete", "deviceModel": "PupilCore",
            "sourceTimeOriginS": 10, "durationSeconds": 1}))
        sidecar = csv_path.with_suffix(".pupil")
        sidecar.mkdir()
        wire = gaze(stamp=10.2, bases=[pupil(0, 10.2), {**pupil(1, 10.2), "model_confidence": .1}])
        (sidecar / "source-messages.msgpack").write_bytes(msgpack.packb({"parts": wire.raw_parts,
            "received_monotonic_s": wire.received_monotonic_s}, use_bin_type=True))
        normalized = DataNormalizer().normalize(wire, 1, 1)
        (sidecar / "normalized-samples.jsonl").write_text(json.dumps(asdict(normalized)) + "\n")
        (sidecar / "context.json").write_text(json.dumps({"stimuli": [[0, "target"]], "markers": []}))
        return csv_path

    def test_rebuild_is_separate_reproducible_and_never_claims_repaired_accuracy(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = self.fixture(root)
            inputs = list(source.parent.rglob("*"))
            hashes = {p: digest(p) for p in inputs if p.is_file()}
            result = rebuild(source, root / "derived")
            self.assertEqual(result["status"], "derived")
            self.assertEqual(result["gazeRows"], 1)
            self.assertEqual(result["validGazeRows"], 0)
            self.assertEqual(result["replayedMessages"], 1)
            self.assertFalse(result["accuracyRepaired"])
            with Path(result["csv_path"]).open() as handle:
                row = next(csv.DictReader(handle))
            self.assertEqual(row["source_norm_pos_x"], "0.5")
            self.assertEqual(row["gaze_invalid_reason"], "bad_3d_model")
            self.assertEqual(row["left_pupil_diameter_px"], "41.0")
            self.assertEqual({p: digest(p) for p in hashes}, hashes)
            with self.assertRaises(FileExistsError):
                rebuild(source, root / "derived")
            with self.assertRaises(ValueError):
                rebuild(source, source.with_suffix(".pupil") / "derived")

    def test_source_identity_mismatch_fails_without_guessing(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = self.fixture(root)
            journal = source.with_suffix(".pupil") / "normalized-samples.jsonl"
            old = json.loads(journal.read_text())
            old["identity"]["source_time_s"] += 1
            journal.write_text(json.dumps(old) + "\n")
            with self.assertRaisesRegex(ValueError, "correspondence"):
                rebuild(source, root / "derived")
            self.assertEqual(json.loads((root / "derived/derived.meta.json").read_text())["status"], "failed")
