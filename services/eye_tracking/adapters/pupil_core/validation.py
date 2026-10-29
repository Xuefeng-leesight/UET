"""Held-out targets with explicit source-time pairing and camera-based angles."""
import bisect
import math

from .data_normalizer import DataNormalizer
from .network import WireMessage


def measure_target(refs, gaze, size, camera=None):
    refs = sorted(refs, key=lambda r: r["timestamp"])
    times = [r["timestamp"] for r in refs]
    errors, matched = [], []
    count = 0
    if not times:
        return {"errors_px": [], "gaze_count": 0, "samples": [], "ref_list": [], "source_size": list(size)}
    for index, data in enumerate(gaze):
        timestamp = data.get("timestamp")
        if type(timestamp) not in (int, float) or not math.isfinite(timestamp) or not times[0] <= timestamp <= times[-1]:
            continue
        count += 1
        sample = DataNormalizer().normalize(WireMessage(data["topic"], data, (), 0), 0, index)
        if not sample.valid or sample.model_quality != "good":
            continue
        # Interpolate only between actual adjacent source frames, never across
        # missing frames or stale references. Cameras are not synchronized.
        right = bisect.bisect_left(times, timestamp)
        if right == 0:
            position = refs[0]["norm_pos"]
        else:
            left = right - 1
            if times[right] - times[left] > .1:
                continue
            alpha = (timestamp - times[left]) / (times[right] - times[left])
            position = [refs[left]["norm_pos"][axis] * (1 - alpha) + refs[right]["norm_pos"][axis] * alpha for axis in (0, 1)]
        error = math.hypot((sample.position[0] - position[0]) * size[0], (sample.position[1] - position[1]) * size[1])
        errors.append(error)
        matched.append({"timestamp": timestamp, "reference": position, "gaze": sample.position, "error_px": error})
        good_eyes = {p.eye for p in sample.pupils if p.valid and p.model_quality == 'good'}
        matched[-1]['monocular'] = {eye: single['position'] for eye, single in sample.monocular.items() if eye in good_eyes}
    result = {"errors_px": errors, "gaze_count": count, "samples": matched, "ref_list": refs,
              "source_size": list(size), "task": "wearer instructed to fixate physical card center; fixation not independently observable",
              'pairing': 'gaze timestamp; linear reference interpolation, gaps <=100ms; valid good-model gaze',
              'angularAccuracyAvailable': False, 'angularUnavailableReason': 'camera_intrinsics_unavailable'}
    if camera is not None:
        if tuple(camera.resolution) != tuple(size):
            result['angularUnavailableReason'] = 'camera_resolution_mismatch'
        else:
            from .angular_metrics import angular_errors, summarize_angles, camera_provenance
            angles, metrics = {}, {}
            for eye in ('binocular', 'left', 'right'):
                pairs = [(r['reference'], r['gaze'] if eye == 'binocular' else r['monocular'].get(eye)) for r in matched]
                pairs = [(a, b) for a, b in pairs if b is not None]
                angles[eye] = angular_errors([a for a, _ in pairs], [b for _, b in pairs], camera)
                metrics[eye] = summarize_angles(angles[eye])
            result.update(angularAccuracyAvailable=bool(angles['binocular']), angularUnavailableReason=None,
                          angular={**camera_provenance(camera), 'errorsDeg': angles, 'metrics': metrics})
    return result
