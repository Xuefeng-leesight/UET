import os


DEFAULT_DEVICE_TYPE = "桌面式"
DESKTOP_SDK_MODELS = {"Pro", "A8"}
DEVICE_TYPE_TO_MODEL = {"桌面式": "Pro", "眼镜式": "aSeeGlassesPlus"}


def normalize_model_name(model_name):
    normalized = str(model_name or "").strip().lower()
    if normalized in {"hh_et10c", "hh_et28"}:
        raise ValueError("Huahong requires the isolated huahong_server process")
    if normalized in {"aseeglassesplus", "asee_glasses_plus", "asee-glasses-plus", "glassesplus"}:
        return "aSeeGlassesPlus"
    if normalized in {"a8", "asee_a8", "asee-a8"}:
        return "A8"
    return "Pro"


def normalize_device_type(device_type):
    raw = str(device_type or "").strip()
    lower = raw.lower()
    if raw == "眼镜式" or lower in {"aseeglassesplus", "asee_glasses_plus", "asee-glasses-plus", "glasses", "glassesplus"}:
        return "眼镜式"
    if raw == "桌面式" or lower in {"pro", "a8", "desktop", "pro200"}:
        return "桌面式"
    return DEFAULT_DEVICE_TYPE


def model_from_device_type(device_type, preferred_desktop_model="Pro"):
    normalized_type = normalize_device_type(device_type)
    preferred = normalize_model_name(preferred_desktop_model)
    if normalized_type == "桌面式" and preferred in DESKTOP_SDK_MODELS:
        return preferred, normalized_type
    return DEVICE_TYPE_TO_MODEL.get(normalized_type, "Pro"), normalized_type


def record_source_from_device_type(device_type):
    return "stream" if normalize_device_type(device_type) == "眼镜式" else "screen"


def resolve_capture_monitor(monitors, capture_display=None, require_target=False):
    """Match an Electron display descriptor to an MSS monitor.

    Electron normally reports DIP coordinates while MSS may report either DIP
    or physical pixels. Score both representations and reject uncertain split-
    screen matches instead of silently recording the experimenter display.
    """
    candidates = [dict(item) for item in list(monitors or [])[1:]]
    if not candidates:
        return None
    if not capture_display:
        return None if require_target else candidates[0]
    bounds = capture_display.get("bounds") if isinstance(capture_display, dict) else None
    if not isinstance(bounds, dict):
        return None if require_target else candidates[0]
    try:
        x = float(bounds.get("x", 0))
        y = float(bounds.get("y", 0))
        width = max(1.0, float(bounds.get("width", 0)))
        height = max(1.0, float(bounds.get("height", 0)))
        scale = max(0.5, min(4.0, float(capture_display.get("scaleFactor", 1) or 1)))
    except (TypeError, ValueError):
        return None if require_target else candidates[0]

    variants = [
        (x, y, width, height),
        (x * scale, y * scale, width * scale, height * scale),
        (x, y, width * scale, height * scale),
    ]

    def score(candidate, variant):
        vx, vy, vw, vh = variant
        cw = max(1.0, float(candidate.get("width", 0)))
        ch = max(1.0, float(candidate.get("height", 0)))
        span = max(cw, ch, vw, vh, 1.0)
        return (
            abs(float(candidate.get("left", 0)) - vx) / span
            + abs(float(candidate.get("top", 0)) - vy) / span
            + abs(cw - vw) / max(cw, vw)
            + abs(ch - vh) / max(ch, vh)
        )

    ranked = sorted(
        ((min(score(candidate, variant) for variant in variants), candidate) for candidate in candidates),
        key=lambda item: item[0],
    )
    best_score, best = ranked[0]
    return best if best_score <= 0.35 else (None if require_target else candidates[0])


def safe_subject_name(name, platform_name=None):
    base = str(name or "").strip()
    if not base:
        return "subject"
    forbidden = '<>:"/\\|?*'
    result = "".join("_" if ord(ch) < 32 or ch in forbidden or ch.isspace() else ch for ch in base).strip(" ._")
    if not result:
        return "subject"
    if (platform_name or os.name) == "nt":
        reserved = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
        if result.upper() in reserved:
            result = f"subject_{result}"
        result = result.rstrip(" .")
    return result or "subject"
