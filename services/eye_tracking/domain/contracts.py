"""Minimal acquisition contract; MRT recording is an application concern."""

from typing import Protocol

from .capabilities import DeviceCapabilities
from .samples import EyeEventSample, GazeSample, PupilSample, VideoFrame

EyeSample = GazeSample | PupilSample | VideoFrame | EyeEventSample


class EyeTrackingError(RuntimeError):
    """Acquisition failed; never translate this into a successful command."""


class UnsupportedCapability(EyeTrackingError):
    pass


class EyeTracker(Protocol):
    @property
    def capabilities(self) -> DeviceCapabilities: ...

    def connect(self) -> None:
        """Return only after acquisition readiness has been verified."""
        ...

    def read(self, timeout_ms: int = 100) -> list[EyeSample]: ...

    def close(self) -> None: ...
