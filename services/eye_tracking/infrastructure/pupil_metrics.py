"""Stream the journal once: distinguish camera Hz, gaze rate and validity."""
import json
from collections import Counter


def journal_metrics(path, origin, duration):
    counts, valid, reasons = Counter(), Counter(), Counter()
    with path.open(encoding="utf-8") as source:
        for line in source:
            if not line.endswith("\n"):
                break
            sample = json.loads(line)
            identity = sample["identity"]
            if not origin <= identity["source_time_s"] < origin + duration:
                continue
            topic = identity["topic"]
            if topic in ("pupil.0.3d", "pupil.1.3d"):
                eye = "right" if topic == "pupil.0.3d" else "left"
                counts[eye] += 1
                valid[eye] += int(sample.get("model_quality") == "good" and sample["valid"])
            elif topic.startswith("gaze"):
                counts["gaze"] += 1
                valid["gaze"] += int(sample["valid"])
                if not sample["valid"]:
                    reasons[sample.get("invalid_reason") or "legacy_unspecified"] += 1
    return {"gazeMessageRateHz": counts["gaze"] / duration if duration else 0,
            "validGazeRateHz": valid["gaze"] / duration if duration else 0,
            "eyeSamplingRateHz": {eye: counts[eye] / duration if duration else 0 for eye in ("left", "right")},
            "eyeModelValidPercent": {eye: 100 * valid[eye] / counts[eye] if counts[eye] else None for eye in ("left", "right")},
            "gazeInvalidReasons": dict(reasons), "samplingRateSemantics": "gaze messages per video second; eye cameras reported separately"}
