"""Pupil measurements retain source semantics; no aSee callback emulation."""

import math
from typing import Any

from ...domain.samples import EyeEventSample, GazeSample, PupilSample, SampleIdentity
from .network import PupilProtocolError, WireMessage
from .pupil_quality import model_rejection


def finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except OverflowError:
        return None
    return number if math.isfinite(number) else None


def identity(message: WireMessage, generation: int, sequence: int) -> SampleIdentity:
    timestamp = finite_number(message.payload.get("timestamp"))
    if timestamp is None:
        raise PupilProtocolError("Missing or non-finite source timestamp")
    return SampleIdentity("PupilCore", message.topic, generation, sequence, timestamp, message.received_monotonic_s)


def confidence_of(payload: dict) -> float | None:
    confidence = finite_number(payload.get("confidence"))
    return confidence if confidence is not None and 0 <= confidence <= 1 else None


def positive_measurement(value: Any) -> float | None:
    number = finite_number(value)
    return number if number is not None and number > 0 else None


def vector(value, size):
    if not isinstance(value, (list, tuple)) or len(value) != size:
        return None
    result = tuple(finite_number(v) for v in value)
    return result if all(v is not None for v in result) else None


def image_resolution(value):
    return tuple(value) if (isinstance(value, (tuple, list)) and len(value) == 2
                           and all(type(v) is int and 0 < v <= 8192 for v in value)) else None


def event_provenance(payload, kind):
    native = payload.get('native_source') is True
    algorithm = payload.get('event_algorithm') if native else f'pupil_capture_online_{kind}'
    version = payload.get('event_algorithm_version') if native else ''
    parameters = payload.get('event_algorithm_parameters') if native else {}
    if not isinstance(algorithm, str) or not algorithm or len(algorithm) > 100:
        algorithm = f'mrt_native_legacy_{kind}'
    version = version if isinstance(version, str) and len(version) <= 40 else ''
    parameters = parameters if isinstance(parameters, dict) and len(parameters) <= 20 else {}
    parameters = {key: value for key, value in parameters.items()
                  if isinstance(key, str) and len(key) <= 80 and
                  (type(value) is bool or finite_number(value) is not None or
                   isinstance(value, str) and len(value) <= 100)}
    complete = payload.get('event_complete') if native else None
    complete = complete if type(complete) is bool else None
    reason = payload.get('event_completion_reason') if native else ''
    reason = reason if isinstance(reason, str) and len(reason) <= 100 else ''
    return dict(native=native, algorithm=algorithm, algorithm_version=version,
                algorithm_parameters=parameters, complete=complete, completion_reason=reason)


def geometry(payload, eyes):
    centers, normals, singles = {}, {}, {}
    raw_centers, raw_normals = payload.get('eye_centers_3d', {}), payload.get('gaze_normals_3d', {})
    for eye in eyes:
        key = '0' if eye == 'right' else '1'
        center = vector(raw_centers.get(key), 3) if isinstance(raw_centers, dict) else None
        normal = vector(raw_normals.get(key), 3) if isinstance(raw_normals, dict) else None
        if len(eyes) == 1:
            center = center or vector(payload.get('eye_center_3d'), 3)
            normal = normal or vector(payload.get('gaze_normal_3d'), 3)
        if center is not None:
            centers[eye] = center
        if normal is not None:
            length = math.sqrt(sum(v * v for v in normal))
            if length > 1e-9:
                normals[eye] = tuple(v / length for v in normal)
        source = payload.get('monocular', {})
        single = source.get(key, {}) if isinstance(source, dict) else {}
        if isinstance(single, dict):
            position, point = vector(single.get('norm_pos'), 2), vector(single.get('gaze_point_3d'), 3)
            if position is not None and point is not None and all(0 <= v <= 1 for v in position):
                origin = vector(single.get('eye_center_3d'), 3)
                normal = vector(single.get('gaze_normal_3d'), 3)
                length = math.sqrt(sum(v * v for v in normal)) if normal else 0
                singles[eye] = {'position': position, 'point': point, 'origin': origin,
                                'direction': tuple(v / length for v in normal) if length > 1e-9 else None}
    return centers, normals, singles


class DataNormalizer:
    def __init__(self, confidence_threshold: float = 0.6) -> None:
        threshold = finite_number(confidence_threshold)
        if threshold is None or not 0 <= threshold <= 1:
            raise ValueError("Confidence threshold must be 0..1")
        self.threshold = threshold

    def normalize(self, message: WireMessage, generation: int, sequence: int, *, eye_frame_sizes=None,
                  world_frame_size=None, world_frame_epoch=0) -> GazeSample | PupilSample | EyeEventSample:
        payload = message.payload
        sample_id = identity(message, generation, sequence)
        confidence = confidence_of(payload)
        confident = confidence is not None and confidence >= self.threshold
        if message.topic == 'saccades' and payload.get('native_source') is True:
            duration = positive_measurement(payload.get('duration'))
            position = vector(payload.get('norm_pos'), 2)
            event_id = payload.get('id')
            metrics = payload.get('metrics')
            if type(event_id) is not int or event_id < 1 or duration is None or duration > 86400000 or not isinstance(metrics, dict):
                raise PupilProtocolError('Invalid native saccade event')
            allowed = ('saccade_endpoint_distance_px', 'saccade_endpoint_distance_deg', 'average_saccade_velocity_px_ms',
                       'average_saccade_velocity_deg_ms', 'peak_saccade_velocity_px_ms', 'peak_saccade_velocity_deg_ms',
                       'saccade_start_x', 'saccade_start_y', 'saccade_end_x', 'saccade_end_y')
            measured = {key: number for key in allowed if (number := finite_number(metrics.get(key))) is not None
                        and (0 <= number <= 1 if key in ('saccade_start_x', 'saccade_start_y', 'saccade_end_x', 'saccade_end_y') else number >= 0)}
            return EyeEventSample(sample_id, 'saccade', event_id, duration, position, confidence,
                                  confident and position is not None and all(0 <= v <= 1 for v in position),
                                  metrics=measured, **event_provenance(payload, 'saccade'))
        if message.topic == "fixations":
            event_id = payload.get("id")
            duration = positive_measurement(payload.get("duration"))
            raw = payload.get("norm_pos")
            position = tuple(finite_number(v) for v in raw) if isinstance(raw, (tuple, list)) and len(raw) == 2 else None
            if type(event_id) is not int or event_id < 0 or duration is None or duration > 86400000:
                raise PupilProtocolError("Invalid fixation identity or duration")
            if position is not None and any(v is None for v in position):
                position = None
            valid = confident and position is not None and all(0 <= v <= 1 for v in position)
            resolution = image_resolution(payload.get('world_resolution')) or image_resolution(world_frame_size)
            metrics = {}
            if resolution is not None and valid:
                metrics = {'fixation_point_x_px': position[0] * resolution[0],
                           'fixation_point_y_px': (1 - position[1]) * resolution[1]}
            if payload.get('native_source') is True and valid:
                direction = vector(payload.get('direction'), 3)
                length = math.sqrt(sum(v * v for v in direction)) if direction is not None else 0
                if length > 1e-9:
                    metrics.update({f'fixation_direction_{axis}': value / length for axis, value in zip('xyz', direction)})
            return EyeEventSample(sample_id, "fixation", event_id, duration, position, confidence, valid,
                                  metrics=metrics, **event_provenance(payload, 'fixation'))
        if message.topic == "blinks":
            phase = payload.get("type")
            if phase not in ("onset", "offset"):
                raise PupilProtocolError("Invalid blink phase")
            # Capture already applies its event detector criteria. Its confidence
            # is not pupil ellipse confidence; preserve it and require paired phases.
            # Capture does not provide reliable left/right attribution here.
            eye = {0: 'right', 1: 'left'}.get(payload.get('eye_id')) if type(payload.get('eye_id')) is int else None
            session = payload.get('detector_session') if payload.get('native_source') is True else None
            session = session if type(session) is int and session >= 0 else None
            return EyeEventSample(sample_id, "blink", session, None, None, confidence, confidence is not None,
                                  phase, eye, **event_provenance(payload, 'blink'))
        if message.topic == "gaze" or message.topic.startswith("gaze."):
            raw_position = payload.get("norm_pos")
            position = None
            if isinstance(raw_position, (list, tuple)) and len(raw_position) == 2:
                x, y = (finite_number(v) for v in raw_position)
                if x is not None and y is not None:
                    position = (x, y)
            eyes = set()
            pupils = []
            base_data = payload.get("base_data", [])
            if isinstance(base_data, list):
                for pupil in base_data:
                    eye_id = pupil.get("id") if isinstance(pupil, dict) else None
                    if type(eye_id) is int and eye_id in (0, 1):
                        eyes.add("right" if eye_id == 0 else "left")
                        topic = pupil.get("topic")
                        stamp = finite_number(pupil.get("timestamp"))
                        supported_topic = (topic == f'pupil.{eye_id}.3d' or
                                           message.topic.startswith('gaze.2d.') and topic == f'pupil.{eye_id}.2d')
                        if supported_topic and stamp is not None and abs(stamp - sample_id.source_time_s) <= .1:
                            base = self.normalize(WireMessage(topic, pupil, (), message.received_monotonic_s), generation, sequence,
                                                  eye_frame_sizes=eye_frame_sizes)
                            if not any(p.eye == base.eye for p in pupils):
                                pupils.append(base)
            # Off-scene coordinates are preserved, not clipped into a valid edge.
            in_scene = position is not None and all(0 <= v <= 1 for v in position)
            quality = "bad" if any(p.model_quality == "bad" for p in pupils) else "good" if pupils and len(pupils) == len(eyes) and all(p.model_quality == "good" for p in pupils) else "unknown"
            reason = "missing_position" if position is None else "off_scene" if not in_scene else "low_confidence" if not confident else "bad_3d_model" if quality == "bad" else ""
            centers, normals, singles = geometry(payload, eyes)
            resolution = image_resolution(payload.get('world_resolution')) or image_resolution(world_frame_size)
            return GazeSample(sample_id, position, "world_normalized_bottom_left", confidence,
                              not reason, tuple(sorted(eyes)), tuple(pupils),
                              "base_data" if isinstance(base_data, list) and base_data else "legacy", quality, reason,
                              vector(payload.get('gaze_point_3d'), 3), centers, normals, singles, resolution,
                              payload.get('native_source') is True,
                              payload.get('mapping_mode', '') if payload.get('mapping_mode') in ('binocular', 'monocular') else '',
                              payload.get('mapping_reason', '') if isinstance(payload.get('mapping_reason'), str) and len(payload['mapping_reason']) <= 100 else '',
                              tuple(eye for eye in payload.get('rejected_eye_ids', []) if type(eye) is int and eye in (0, 1))
                              if isinstance(payload.get('rejected_eye_ids'), (list, tuple)) else (),
                              payload.get('source_order', '') if payload.get('source_order') in ('in_order', 'late_source_time') else '',
                              world_frame_epoch)
        if message.topic.startswith("pupil."):
            eye_id = payload.get("id")
            if type(eye_id) is not int or eye_id not in (0, 1):
                raise PupilProtocolError("Invalid pupil eye id")
            if message.topic.split(".")[1] != str(eye_id):
                raise PupilProtocolError("Pupil topic and eye id disagree")
            diameter_px = positive_measurement(payload.get("diameter"))
            diameter_mm = positive_measurement(payload.get("diameter_3d"))
            ellipse = payload.get('ellipse_2d', payload.get('ellipse', {}))
            ellipse = ellipse if isinstance(ellipse, dict) else {}
            axes = vector(ellipse.get('axes'), 2)
            # Failed 2D detectors can return a placeholder (0, 0) center with
            # zero axes, while the separate 3D model still has a usable diameter.
            # Do not turn this placeholder into a measured pupil image position.
            ellipse_valid = axes is not None and all(axis > 0 for axis in axes)
            center = vector(ellipse.get('center'), 2) if ellipse_valid else None
            resolution = image_resolution(payload.get('eye_resolution'))
            if resolution is None and eye_frame_sizes:
                # Capture uses the exact originating eye-frame timestamp.
                # Do not guess a camera size or borrow another frame's size.
                resolution = image_resolution(eye_frame_sizes.get((eye_id, sample_id.source_time_s)))
            normalized_center = None
            if center is not None and resolution is not None:
                normalized_center = (center[0] / resolution[0], center[1] / resolution[1])
            circle = payload.get('circle_3d', {})
            model_quality = ("unknown" if not message.topic.endswith(".3d") or payload.get("model_confidence") is None else
                             "bad" if model_rejection(payload) else "good")
            separate_ellipse = 'ellipse_2d' in payload
            if normalized_center is None and ellipse_valid and not separate_ellipse:
                source_normalized = vector(payload.get('norm_pos'), 2)
                if source_normalized is not None:
                    normalized_center = (source_normalized[0], 1 - source_normalized[1])
            projected_pixels = not separate_ellipse and 'pye3d' in str(payload.get('method', '')).lower()
            pixel_source = ('detected_2d_ellipse' if separate_ellipse or message.topic.endswith('.2d') else
                            'pye3d_projected_ellipse' if projected_pixels else 'source_3d_datum')
            pixel_confidence = confidence_of({'confidence': payload.get('confidence_2d')}) if separate_ellipse else confidence
            # pye3d can recover a 3D circle by image search and assign it a new
            # confidence. That value does not validate the original 2D ellipse.
            pixel_valid = (pixel_confidence is not None and pixel_confidence >= self.threshold
                           and (diameter_px is not None or ellipse_valid))
            if separate_ellipse and 'confidence_2d' not in payload:
                pixel_valid = None  # Explicitly unknown for historical native data.
            elif projected_pixels and model_quality == 'bad':
                pixel_valid = False  # Capture's pye3d pixels are a model projection.
            return PupilSample(sample_id, "right" if eye_id == 0 else "left", diameter_px, diameter_mm,
                               confidence, confident and (diameter_px is not None or diameter_mm is not None),
                               finite_number(payload.get("model_confidence")),
                               model_quality,
                               center,
                               min(axes) if ellipse_valid else None,
                               vector(circle.get('center'), 3) if isinstance(circle, dict) else None,
                               pixel_confidence, pixel_valid, pixel_source,
                               positive_measurement(payload.get('projected_diameter_px')),
                               resolution, normalized_center)
        raise PupilProtocolError(f"Unsupported data topic: {message.topic}")
