"""Causal source-time resampling. Never squeeze missing frames out of the video."""

import math
from dataclasses import dataclass

from .contracts import EyeTrackingError
from .samples import VideoFrame


@dataclass(frozen=True)
class OutputFrame:
    index: int
    pts_s: float
    source: VideoFrame
    repeated: bool


class FrameTimeline:
    def __init__(self, first: VideoFrame, fps: int = 30, max_gap_s: float = 0.5):
        if type(fps) is not int or not 1 <= fps <= 120:
            raise ValueError("Output FPS must be an integer in 1..120")
        if not math.isfinite(max_gap_s) or not 1 / fps <= max_gap_s <= 5:
            raise ValueError("Maximum gap must be between one output frame and 5 seconds")
        if first.stream != "scene" or first.pixel_format != "bgr":
            raise ValueError("Recording requires a scene BGR frame")
        if not math.isfinite(first.identity.source_time_s) or first.width < 1 or first.height < 1:
            raise ValueError("Invalid initial frame")
        self.fps, self.max_gap_s = fps, max_gap_s
        self.t0 = first.identity.source_time_s
        self.current = first
        self.next_index = 0
        self._last_sequence = None

    def initial(self) -> list[OutputFrame]:
        return self._until(self.t0 + 1e-6)

    def _until(self, exclusive_time_s: float) -> list[OutputFrame]:
        frames = []
        # Tolerance absorbs timestamp subtraction noise, not a whole frame.
        while self.t0 + self.next_index / self.fps < exclusive_time_s - 1e-9:
            sequence = self.current.identity.received_sequence
            frames.append(OutputFrame(self.next_index, self.next_index / self.fps,
                                      self.current, self._last_sequence == sequence))
            self._last_sequence = sequence
            self.next_index += 1
        return frames

    def push(self, frame: VideoFrame) -> list[OutputFrame]:
        if (frame.stream, frame.width, frame.height, frame.pixel_format, frame.identity.generation) != (
            self.current.stream, self.current.width, self.current.height,
            self.current.pixel_format, self.current.identity.generation,
        ):
            raise EyeTrackingError("Stream dimensions, format or connection generation changed during recording")
        delta = frame.identity.source_time_s - self.current.identity.source_time_s
        if not math.isfinite(delta) or delta <= 0 or delta > self.max_gap_s:
            reason = ('nonfinite' if not math.isfinite(delta) else 'repeated' if delta == 0
                      else 'regressed' if delta < 0 else 'gap')
            raise EyeTrackingError(
                "Frame timestamp regressed/repeated or exceeded maximum recording gap "
                f"(reason={reason}, source={frame.identity.source}, stream={frame.stream}, "
                f"generation={frame.identity.generation}, "
                f"previous_sequence={self.current.identity.received_sequence}, "
                f"current_sequence={frame.identity.received_sequence}, "
                f"previous_time={self.current.identity.source_time_s:.9f}, "
                f"current_time={frame.identity.source_time_s:.9f}, delta_s={delta:.9f}, "
                f"max_gap_s={self.max_gap_s})")
        frames = self._until(frame.identity.source_time_s)
        self.current = frame
        return frames

    def finish(self) -> tuple[list[OutputFrame], float]:
        # Do not invent an arbitrary wall-clock tail. Include the last acquired
        # frame for one output interval, then round the CFR end to a frame boundary.
        cutoff = self.current.identity.source_time_s + 1 / self.fps
        frames = self._until(cutoff)
        return frames, self.next_index / self.fps
