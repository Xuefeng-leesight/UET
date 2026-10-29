"""Validate Capture frames and normalize supported formats to bounded BGR."""

import io

from ...domain.samples import VideoFrame
from .data_normalizer import identity
from .network import PupilProtocolError, WireMessage

STREAMS = {"frame.world": "scene", "frame.eye.0": "right_eye", "frame.eye.1": "left_eye"}


def decode_frame(message: WireMessage, generation: int, sequence: int) -> VideoFrame:
    stream = STREAMS.get(message.topic)
    if stream is None or len(message.raw_parts) != 3:
        raise PupilProtocolError("Expected a supported frame topic and exactly one image buffer")
    payload = message.payload
    if payload.get("format") not in ("bgr", "jpeg"):
        raise PupilProtocolError("Capture Frame Publisher must use BGR or JPEG")
    width, height = payload.get("width"), payload.get("height")
    if any(type(v) is not int or not 1 <= v <= 8192 for v in (width, height)):
        raise PupilProtocolError("Invalid frame dimensions")
    pixels = message.raw_parts[2]
    if width * height * 3 > 32 * 1024 * 1024:
        raise PupilProtocolError("Decoded frame exceeds 32 MiB limit")
    if payload["format"] == "jpeg":
        from PIL import Image

        try:
            with Image.open(io.BytesIO(pixels)) as image:
                if image.format != "JPEG" or image.size != (width, height):
                    raise ValueError("JPEG dimensions or encoding do not match metadata")
                pixels = image.convert("RGB").tobytes("raw", "BGR")
        except (OSError, ValueError) as exc:
            raise PupilProtocolError(f"Invalid JPEG frame: {exc}") from exc
    if len(pixels) != width * height * 3:
        raise PupilProtocolError("BGR buffer size does not match dimensions")
    index = payload.get("index")
    if index is not None and (type(index) is not int or index < 0):
        raise PupilProtocolError("Invalid source frame index")
    return VideoFrame(identity(message, generation, sequence), stream, width, height, "bgr", pixels, index)
