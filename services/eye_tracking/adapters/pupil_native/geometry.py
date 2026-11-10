"""Closest points of two non-parallel 3D lines, with explicit degeneracy."""
import numpy as np


def gaze_direction(gaze):
    """Cyclopean direction in world-camera coordinates; no camera-origin shortcut."""
    point = gaze.get('gaze_point_3d')
    centers = list(gaze.get('eye_centers_3d', {}).values())
    if not centers and gaze.get('eye_center_3d') is not None:
        centers = [gaze['eye_center_3d']]
    position = gaze.get('norm_pos')
    if (point is None or not centers or position is None or len(position) != 2 or
            gaze.get('confidence', 0) < .6 or not all(0 <= v <= 1 for v in position)):
        return None
    direction = np.asarray(point, dtype=float) - np.mean(centers, axis=0)
    length = np.linalg.norm(direction)
    return direction / length if np.isfinite(length) and length > 1e-9 else None


def nearest_intersection(line0, line1):
    a, b = (np.asarray(p, dtype=float) for p in line0)
    c, d = (np.asarray(p, dtype=float) for p in line1)
    u, v, w = b - a, d - c, a - c
    aa, bb, cc = u @ u, u @ v, v @ v
    denominator = aa * cc - bb * bb
    if not np.isfinite(denominator) or denominator <= 1e-12 * aa * cc:
        return None, None
    s = (bb * (v @ w) - cc * (u @ w)) / denominator
    t = (aa * (v @ w) - bb * (u @ w)) / denominator
    p, q = a + s * u, c + t * v
    return (p + q) / 2, float(np.linalg.norm(p - q))
