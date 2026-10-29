"""Pupil samples mapped to existing MRT websocket envelopes."""

import base64
import io
import json

from ..domain.samples import VideoFrame
from ..domain.samples import paired_pupils, pupil_pixels_valid


def image_message(frame: VideoFrame) -> str:
    from PIL import Image

    if frame.pixel_format != "bgr" or len(frame.pixels) != frame.width * frame.height * 3:
        raise ValueError("Preview requires a valid BGR frame")
    image = Image.frombytes("RGB", (frame.width, frame.height), frame.pixels, "raw", "BGR")
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=82)
    return json.dumps({"type": "image_frame", "kind": frame.stream,
                       "eye": {"scene": 0, "left_eye": 1, "right_eye": 2}[frame.stream],
                       "mime": "image/jpeg", "width": frame.width, "height": frame.height,
                       "timestamp": round(frame.identity.source_time_s * 1_000_000),
                       "source_timestamp_s": frame.identity.source_time_s,
                       "connection_generation": frame.identity.generation,
                       "source": "PupilCore", "timestamp_domain": "pupil_source",
                       "timestamp_unit": "microseconds",
                       "data": base64.b64encode(output.getvalue()).decode("ascii")}, allow_nan=False)


def gaze_message(sample, pupils=None) -> str:
    point = {"x": sample.position[0], "y": 1 - sample.position[1]} if sample.valid and sample.position else None
    timestamp = round(sample.identity.source_time_s * 1_000_000)
    pupil_data = {}
    for eye, pupil in paired_pupils(sample, pupils, include_invalid=True).items():
        pixel_valid = pupil_pixels_valid(pupil)
        if not pupil.valid and not pixel_valid:
            continue
        pupil_data["l_pupil" if eye == "left" else "r_pupil"] = {
                "dia": pupil.diameter_px if pixel_valid else None,
                "dia_mm": pupil.diameter_mm if pupil.valid and pupil.model_quality != "bad" else None,
                "center": dict(zip(('x', 'y'), pupil.center)) if pixel_valid and pupil.center is not None else None,
                "model_confidence": pupil.model_confidence, "model_quality": pupil.model_quality,
                "pixel_confidence": pupil.pixel_confidence, "pixel_valid": pupil.pixel_valid,
                "pixel_source": pupil.pixel_source}
        single = sample.monocular.get(eye) if sample.native and pupil.valid and pupil.model_quality == 'good' else None
        if single:
            position = {'x': single['position'][0], 'y': 1 - single['position'][1]}
            pupil_data['l_gaze' if eye == 'left' else 'r_gaze'] = {
                'gaze_bit_mask': 3, 'gaze': position, 'gaze_point': position,
                'raw': position, 're': pupil.confidence}
    return json.dumps({"timestamp": timestamp, "source": "PupilCore",
                       "coordinate_space": "world_normalized_top_left",
                       "eye_data": {**pupil_data, "ts": timestamp, "re_gaze": {
                           "gaze_bit_mask": 3 if point else 0, "gaze": point,
                           "gaze_point": point, "raw": point,
                           # Neither Pupil path runs independent smoothing. Keep
                           # the optional field while letting display fallback use
                           # the existing normalized recommendation/raw point.
                           "smooth": None}}}, allow_nan=False)
