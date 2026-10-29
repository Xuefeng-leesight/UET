"""Re-export an archived Pupil journal into a NEW derived directory.

Run with the isolated Pupil Python environment. Never modifies source files,
video, Capture settings or the project index. Does not repair a bad eye model.
"""
import argparse
from contextlib import ExitStack
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from services.eye_tracking.adapters.pupil_core.data_normalizer import DataNormalizer
from services.eye_tracking.adapters.pupil_core.network import WireMessage
from services.eye_tracking.domain.samples import GazeSample, PupilSample, EyeEventSample
from services.eye_tracking.infrastructure.pupil_csv import NativeCsvMapper
from services.eye_tracking.infrastructure.pupil_recovery import read_json, write_gaze_csv, atomic_json
from services.eye_tracking.infrastructure.pupil_events import append_events, order_csv
from services.eye_tracking.infrastructure.pupil_metrics import journal_metrics


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def rebuild(source_csv, output):
    import msgpack
    source_csv, output = Path(source_csv).resolve(), Path(output).resolve()
    sidecar = source_csv.with_suffix(".pupil")
    if output == source_csv.parent or sidecar == output or sidecar in output.parents:
        raise ValueError("Derived output must be separate from the source recording")
    meta = read_json(source_csv.with_suffix(".meta.json"))
    if meta.get("deviceModel") != "PupilCore" or meta.get("status") != "complete":
        raise ValueError("This tool requires a completed Pupil recording")
    origin, duration = meta["sourceTimeOriginS"], meta["durationSeconds"]
    inputs = [source_csv, source_csv.with_suffix(".meta.json"), source_csv.with_suffix(".mp4"),
              sidecar / "source-messages.msgpack", sidecar / "normalized-samples.jsonl", sidecar / "context.json"]
    if any(p.is_symlink() for p in inputs):
        raise ValueError("Refusing symbolic-link input")
    hashes = {str(p): digest(p) for p in inputs}
    output.mkdir(parents=True, exist_ok=False)
    target = output / (source_csv.stem + ".derived.csv")
    try:
        with ExitStack() as stack:
            def open_output(name):
                return stack.enter_context((output / name).open("x+", encoding="utf-8", newline=""))
            normalized = open_output("normalized-samples.jsonl")
            gaze_spool = open_output("gaze-spool.jsonl")
            event_spool = open_output("events-spool.jsonl")
            original_normalized = stack.enter_context((sidecar / "normalized-samples.jsonl").open(encoding="utf-8"))
            raw = stack.enter_context((sidecar / "source-messages.msgpack").open("rb"))
            unpacker = msgpack.Unpacker(raw, raw=False, strict_map_key=False, max_buffer_size=64 * 1024 * 1024)
            mapper, pupils, count = DataNormalizer(), {}, 0
            csv_mapper = NativeCsvMapper()
            for envelope in unpacker:
                parts = envelope["parts"]
                topic = parts[0].decode()
                if not (topic.startswith(("gaze", "pupil.")) or topic in ("fixations", "blinks", "saccades")):
                    continue
                old = json.loads(next(original_normalized))
                data = msgpack.unpackb(parts[1], raw=False)
                identity = old["identity"]
                if (identity["topic"], identity["source_time_s"], identity["received_monotonic_s"]) != (topic, data["timestamp"], envelope["received_monotonic_s"]):
                    raise ValueError("Raw/normalized source correspondence failed; refusing guessed pairing")
                sample = mapper.normalize(WireMessage(topic, data, tuple(parts), envelope["received_monotonic_s"]),
                                          identity["generation"], identity["received_sequence"])
                normalized.write(json.dumps(asdict(sample), allow_nan=False) + "\n")
                if isinstance(sample, PupilSample):
                    pupils[sample.eye] = sample
                elif isinstance(sample, GazeSample):
                    gaze_spool.write(json.dumps(csv_mapper(sample, origin, pupils), allow_nan=False) + "\n")
                elif isinstance(sample, EyeEventSample):
                    event_spool.write(json.dumps(asdict(sample), allow_nan=False) + "\n")
                count += 1
            if unpacker.tell() != (sidecar / "source-messages.msgpack").stat().st_size or next(original_normalized, None) is not None:
                raise ValueError("Incomplete journal; source was not fully replayed")
            for file in (normalized, gaze_spool, event_spool):
                file.flush()
            context = read_json(sidecar / "context.json")
            with target.open("x+", encoding="utf-8", newline="") as csv_file:
                gaze_spool.seek(0)
                counts = write_gaze_csv(gaze_spool, csv_file, duration, context["stimuli"], context["markers"])
                event_meta = append_events(output / "events-spool.jsonl", csv_file, origin, duration)
                order_csv(csv_file, output)
        quality = journal_metrics(output / "normalized-samples.jsonl", origin, duration)
        if hashes != {str(p): digest(p) for p in inputs}:
            raise ValueError("Source changed during replay; derived output is not trusted")
        result = {**meta, **counts, **event_meta, **quality, "status": "derived", "derived": True,
                  "csv_path": str(target), "originalCsv": str(source_csv), "sourceHashes": hashes,
                  "replayedMessages": count, "samplingRateHz": counts["gazeRows"] / duration,
                  "validityPercent": 100 * counts["validGazeRows"] / counts["gazeRows"] if counts["gazeRows"] else 0,
                  "pupilAlignment": "replayed authoritative gaze.base_data; bad 3D model measurements retained in raw columns",
                  "accuracyRepaired": False}
        atomic_json(output / "derived.meta.json", result)
        return result
    except Exception as exc:
        atomic_json(output / "derived.meta.json", {"status": "failed", "error": str(exc), "sourceHashes": hashes})
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_csv", type=Path)
    parser.add_argument("--output", type=Path, required=True, help="A new directory; existing outputs are never overwritten")
    args = parser.parse_args()
    result = rebuild(args.source_csv, args.output)
    print(json.dumps({k: result[k] for k in ("status", "csv_path", "gazeRows", "validGazeRows", "validityPercent", "replayedMessages", "blinkOnsets")}, ensure_ascii=False))
