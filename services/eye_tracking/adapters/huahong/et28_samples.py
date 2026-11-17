"""Copy ET28 callback data without assigning undocumented physical units."""

import math

from ...domain.samples import GazeSample, PupilSample
from .vendor.aiot_dll import predict_output_to_dict


def _finite(value):
    value = float(value)
    return value if math.isfinite(value) else None


def _json_safe(value):
    if isinstance(value, float):
        return _finite(value)
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return value


def _pupil_sample(identity, eye, pupil, eye_resolution):
    width, height = eye_resolution
    center_x, center_y = pupil['center2d']
    center = None
    diameter_px = minor_axis_px = None
    if pupil['valid2d']:
        if center_x is not None and center_y is not None and 0 <= center_x < width and 0 <= center_y < height:
            center = (center_x / width, center_y / height)
        axes = (pupil['width'], pupil['height'])
        if all(axis is not None and 0 < axis <= width for axis in axes):
            diameter_px, minor_axis_px = max(axes), min(axes)
    diameter_mm = pupil['diameter']
    if not pupil['valid3d'] or diameter_mm is None or diameter_mm <= 0:
        diameter_mm = None
    pixel_valid = center is not None or diameter_px is not None
    return PupilSample(identity, eye, diameter_px, diameter_mm, None, pixel_valid or diameter_mm is not None,
                       minor_axis_px=minor_axis_px, pixel_valid=pixel_valid, pixel_source='detected_2d_ellipse',
                       image_resolution=eye_resolution, center_normalized=center)


def aiot_gaze_sample(output, identity, world_resolution, eye_resolution):
    """Copy per-eye data before native buffers are reused. worldPoint is in scene pixels."""
    width, height = world_resolution
    if type(width) is not int or type(height) is not int or width <= 0 or height <= 0:
        raise ValueError('ET28 world resolution must contain positive integer dimensions')
    prediction = _json_safe(predict_output_to_dict(output))
    monocular, points, pupils = {}, [], []
    for eye in ('left', 'right'):
        eyes = prediction[eye]
        pupil, gaze = eyes['pupil'], eyes['gaze']
        x, y = gaze['worldPoint']
        position = None
        if gaze['valid'] and x is not None and y is not None:
            normalized = (x / width, y / height)
            if all(0 <= component <= 1 for component in normalized):
                position = normalized
                points.append((eye, position))
        monocular[eye] = {
            'position': position,
            'vendor': {
                'haveEyeInfo': pupil['valid2d'],
                'haveGazeInfo': gaze['valid'],
                'worldPoint': dict(zip('xy', gaze['worldPoint'])),
                'eyeInfo': {
                    'pupilCenter': dict(zip('xy', pupil['center2d'])),
                    'pupilWidth': pupil['width'],
                    'pupilHeight': pupil['height'],
                    'pupilAngle': pupil['angle'],
                },
                'sightLine': {
                    'corneaCenter': dict(zip('xyz', gaze['corneaCenter'])),
                    'direction': dict(zip('xyz', gaze['gazeDirection'])),
                },
                'deviceTimestamp': eyes['timeStamp'],
                'pupil3d': {key: pupil[key] for key in ('valid3d', 'center3d', 'diameter')},
                'eyelid': eyes['eyelid'] if eyes['eyelid']['valid'] else None,
                'blink': eyes['blink'],
            },
        }
        pupils.append(_pupil_sample(identity, eye, pupil, eye_resolution))
    position = tuple(sum(point[i] for _, point in points) / len(points) for i in (0, 1)) if points else None
    return GazeSample(identity, position, 'world_normalized_top_left', None, bool(points),
                      tuple(eye for eye, _ in points), pupils=tuple(pupils), pupil_pairing='base_data',
                      monocular=monocular, world_resolution=(width, height),
                      vendor={'mergeGaze': prediction['merge'],
                              'gazeEvent': {kind: event for kind, event in prediction['gazeEvent'].items()
                                            if event['valid']}})
