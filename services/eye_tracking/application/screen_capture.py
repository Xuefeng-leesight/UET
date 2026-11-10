"""Screen capture adapters; all capture and frame consumption stay on one thread."""

import os
import re

import cv2
import numpy as np


def recording_frame_size(width, height, max_width=None):
    """Fit within a configurable 16:9 bounding box without upscaling.

    `MRT_RECORD_MAX_WIDTH` caps the target width; 0 disables downscaling. The
    height term keeps the frame inside the 16:9 box that the width cap implies,
    so a tall (portrait) or ultra-wide source is not scaled past that bound.
    """
    raw = os.getenv("MRT_RECORD_MAX_WIDTH", "1920") if max_width is None else max_width
    try:
        limit = int(raw)
    except (ValueError, TypeError):
        limit = 1920
    width = int(width)
    height = int(height)
    if width <= 0 or height <= 0:
        return width, height
    if limit == 0:
        return width, height
    if limit < 2:
        limit = 1920
    scale = min(1.0, limit / width, (limit * 9 / 16) / height)
    if scale >= 1.0:
        return width, height
    return max(2, int(width * scale) // 2 * 2), max(2, int(height * scale) // 2 * 2)


def write_all(stream, data):
    """Write a contiguous byte view, including short writes from raw pipes."""
    remaining = memoryview(data).cast("B")
    while remaining:
        written = stream.write(remaining)
        if written is None or written <= 0 or written > len(remaining):
            raise OSError("video pipe did not accept frame bytes")
        remaining = remaining[written:]


class ScreenCapture:
    def __init__(self, sct, monitor, log):
        self.sct = sct
        self.monitor = monitor
        self.log = log
        self.camera = None
        self.backend = "mss"
        self.bounds = (monitor["left"], monitor["top"],
                       monitor["left"] + monitor["width"], monitor["top"] + monitor["height"])

    @staticmethod
    def _bounds(camera):
        # DXcam 0.3.0 exposes geometry through its output descriptor only.
        # Keep this version-specific access isolated and fail back to MSS if absent.
        rect = camera._output.desc.DesktopCoordinates
        return (rect.left, rect.top, rect.right, rect.bottom)

    def __enter__(self):
        requested = os.getenv("MRT_RECORD_CAPTURE_BACKEND", "auto").strip().lower()
        if os.name != "nt" or requested == "mss":
            return self
        try:
            import dxcam
            outputs = re.findall(r"Device\[(\d+)\] Output\[(\d+)\]", dxcam.output_info())
            for device, output in outputs:
                camera = None
                try:
                    camera = dxcam.create(device_idx=int(device), output_idx=int(output), output_color="BGR")
                    if self._bounds(camera) == self.bounds:
                        self.camera = camera
                        self.backend = "dxgi"
                        camera = None
                        break
                except Exception as error:
                    self.log("DXGI output unavailable", device, output, str(error))
                finally:
                    if camera is not None:
                        camera.release()
            if self.camera is None:
                self.log("DXGI target monitor unavailable; using MSS", self.bounds)
        except Exception as error:
            self.close()
            self.log("DXGI unavailable; using MSS", str(error))
        self.log("screen capture backend", self.backend, "bounds", self.bounds)
        return self

    def grab(self):
        if self.camera is not None:
            try:
                if self._bounds(self.camera) != self.bounds:
                    raise RuntimeError("capture display geometry changed")
                # No producer thread: this view remains valid until the next grab,
                # after the caller has resized and fully written the current frame.
                frame = self.camera.grab(copy=False, new_frame_only=False)
                if frame is not None:
                    if frame.shape != (self.monitor["height"], self.monitor["width"], 3):
                        raise RuntimeError("DXGI frame size does not match target monitor")
                    return frame
                # No initial DXGI frame yet: obtain one via MSS without stalling.
            except Exception as error:
                self.log("DXGI capture failed; using MSS", str(error))
                self.close()
        return cv2.cvtColor(np.asarray(self.sct.grab(self.monitor)), cv2.COLOR_BGRA2BGR)

    def close(self):
        camera, self.camera = self.camera, None
        self.backend = "mss"
        if camera is not None:
            try:
                camera.release()
            except Exception as error:
                self.log("DXGI release failed", str(error))

    def __exit__(self, *_):
        self.close()
