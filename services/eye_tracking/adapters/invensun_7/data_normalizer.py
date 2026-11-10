"""Legacy gaze selection only; preserves desktop/glasses masks and fallbacks.

No new coordinate transform, filtering, smoothing or Pupil contract conversion.
"""

import math


def _finite_pair(xv, yv):
    try:
        xf = float(xv)
        yf = float(yv)
        if not (math.isfinite(xf) and math.isfinite(yf)):
            return None
        return xf, yf
    except Exception:
        return None

def _bit_valid(mask, bit):
    try:
        return ((int(mask) >> int(bit)) & 0x1) == 1
    except Exception:
        return False

# Desktop gaze_point is normalized screen space. Glasses mode uses
# smooth_point first because its SDK exposes scene-centered values.
# bit0=gaze_point, bit1=raw_point, bit2=smooth_point
def pick_gaze_xy(gaze_obj, is_glasses):
    mask = getattr(gaze_obj, "gaze_bit_mask", 0)
    fallback_zero = None
    if is_glasses:
        source_defs = (
            ("smooth", 2, gaze_obj.smooth_point),
            ("gaze", 0, gaze_obj.gaze_point),
            ("raw", 1, gaze_obj.raw_point),
        )
    else:
        source_defs = (
            ("gaze", 0, gaze_obj.gaze_point),
            ("smooth", 2, gaze_obj.smooth_point),
            ("raw", 1, gaze_obj.raw_point),
        )
    for source, bit, point in source_defs:
        if not _bit_valid(mask, bit):
            continue
        p = _finite_pair(point.x, point.y)
        if p is None:
            continue
        if p[0] != 0.0 or p[1] != 0.0:
            return p, source, mask
        if fallback_zero is None:
            fallback_zero = (p, source, mask)
    if fallback_zero is not None:
        return fallback_zero
    # Compatibility fallback for SDK builds that do not set mask correctly.
    if is_glasses:
        fallback_source_defs = (
            ("smooth", gaze_obj.smooth_point.x, gaze_obj.smooth_point.y),
            ("gaze", gaze_obj.gaze_point.x, gaze_obj.gaze_point.y),
            ("raw", gaze_obj.raw_point.x, gaze_obj.raw_point.y),
        )
    else:
        fallback_source_defs = (
            ("gaze", gaze_obj.gaze_point.x, gaze_obj.gaze_point.y),
            ("smooth", gaze_obj.smooth_point.x, gaze_obj.smooth_point.y),
            ("raw", gaze_obj.raw_point.x, gaze_obj.raw_point.y),
        )
    for source, x0, y0 in fallback_source_defs:
        p = _finite_pair(x0, y0)
        if p is not None and (p[0] != 0.0 or p[1] != 0.0):
            return p, source, mask
    return None, "none", mask
