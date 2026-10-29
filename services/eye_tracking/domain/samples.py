"""Source time is seconds; receive time is host monotonic seconds.

Normalized positions retain an explicit coordinate space. They are not MRT
screen pixels. Missing measurements remain None, never synthetic zeroes.
"""

from dataclasses import dataclass, field
from typing import Literal


@dataclass(frozen=True)
class SampleIdentity:
    source: str
    topic: str
    generation: int
    received_sequence: int  # Local reception only, not a source packet counter.
    source_time_s: float
    received_monotonic_s: float


@dataclass(frozen=True)
class GazeSample:
    identity: SampleIdentity
    position: tuple[float, float] | None
    coordinate_space: str
    confidence: float | None
    valid: bool
    contributing_eyes: tuple[Literal["right", "left"], ...]
    pupils: tuple["PupilSample", ...] = ()
    pupil_pairing: str = "legacy"
    model_quality: str = "unknown"
    invalid_reason: str = ""
    point_3d: tuple[float, float, float] | None = None
    eye_centers_3d: dict = field(default_factory=dict)
    eye_normals_3d: dict = field(default_factory=dict)
    monocular: dict = field(default_factory=dict)
    world_resolution: tuple[int, int] | None = None
    native: bool = False
    mapping_mode: str = ""
    mapping_reason: str = ""
    rejected_eye_ids: tuple[int, ...] = ()
    source_order: str = ""
    world_resolution_epoch: int = 0  # Changes when validated scene dimensions change.


@dataclass(frozen=True)
class PupilSample:
    identity: SampleIdentity
    eye: Literal["right", "left"]
    diameter_px: float | None
    diameter_mm: float | None
    confidence: float | None
    valid: bool
    model_confidence: float | None = None
    model_quality: str = "unknown"
    center: tuple[float, float] | None = None
    minor_axis_px: float | None = None
    circle_center_3d: tuple[float, float, float] | None = None
    pixel_confidence: float | None = None
    pixel_valid: bool | None = None
    pixel_source: str = ""
    projected_diameter_px: float | None = None
    image_resolution: tuple[int, int] | None = None
    center_normalized: tuple[float, float] | None = None


def pupil_pixels_valid(pupil):
    # Historical native messages did not retain the independent 2D confidence.
    # Preserve their existing interpretation, but do not claim it is known.
    return pupil.valid if pupil.pixel_valid is None else pupil.pixel_valid


def paired_pupils(sample, pupils=None, *, include_invalid=False):
    if sample.pupil_pairing == "base_data":
        # A binocular timestamp is the average of its contributors: a real
        # contributing pupil may be slightly later than that average.
        return {p.eye: p for p in sample.pupils if p.identity.generation == sample.identity.generation
                and (include_invalid or p.valid) and abs(sample.identity.source_time_s - p.identity.source_time_s) <= .1}
    return {eye: p for eye, p in (pupils or {}).items() if (include_invalid or p.valid)
            and p.identity.generation == sample.identity.generation
            and 0 <= sample.identity.source_time_s - p.identity.source_time_s <= .1}


@dataclass(frozen=True)
class EyeEventSample:
    identity: SampleIdentity
    kind: Literal["fixation", "blink", "saccade"]
    event_id: int | None
    duration_ms: float | None
    position: tuple[float, float] | None
    confidence: float | None
    valid: bool
    phase: str = ""
    eye: str | None = None
    metrics: dict = field(default_factory=dict)
    native: bool = False
    algorithm: str = ""
    algorithm_version: str = ""
    algorithm_parameters: dict = field(default_factory=dict)
    complete: bool | None = None
    completion_reason: str = ""


@dataclass(frozen=True)
class VideoFrame:
    identity: SampleIdentity
    stream: Literal["scene", "right_eye", "left_eye"]
    width: int
    height: int
    pixel_format: Literal["bgr"]
    pixels: bytes
    source_index: int | None
