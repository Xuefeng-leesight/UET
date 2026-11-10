"""Supported adapter operations, not a claim that a device is ready."""

from dataclasses import dataclass


@dataclass(frozen=True)
class DeviceCapabilities:
    model: str
    video_streams: tuple[str, ...]
    pixel_formats: tuple[str, ...]
    gaze: bool
    pupil: bool
    calibration_modes: tuple[str, ...]
    pupil_units: tuple[str, ...]  # Optional fields; availability is per sample.
