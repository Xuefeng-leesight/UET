"""Copy ET28 callback data without assigning undocumented physical units."""

import math

from ...domain.samples import GazeSample


def _finite(value):
    value = float(value)
    return value if math.isfinite(value) else None


def _vector(value, axes):
    return {axis: _finite(getattr(value, axis)) for axis in axes}


def et28_gaze_sample(output, identity, world_resolution):
    """Read while the native callback is alive; retain only owned Python values.

    The vendor example draws worldPoint directly into the scene image, proving
    its pixel/top-left convention. It does not document units for eyeInfo or
    sightLine, so those values remain explicitly vendor data in the journal.
    """
    width, height = world_resolution
    if type(width) is not int or type(height) is not int or width <= 0 or height <= 0:
        raise ValueError('ET28 world resolution must contain positive integer dimensions')
    monocular, points = {}, []
    for eye, suffix in (('left', 'Left'), ('right', 'Right')):
        eye_info = getattr(output, 'eyeInfo' + suffix)
        sight_line = getattr(output, 'sightLine' + suffix)
        world_point = _vector(getattr(output, 'worldPoint' + suffix), 'xy')
        have_gaze = bool(getattr(output, 'haveGazeInfo' + suffix))
        position = None
        if have_gaze and world_point['x'] is not None and world_point['y'] is not None:
            normalized = (world_point['x'] / width, world_point['y'] / height)
            if all(0 <= component <= 1 for component in normalized):
                position = normalized
                points.append((eye, position))
        monocular[eye] = {
            'position': position,
            'vendor': {
                'haveEyeInfo': bool(getattr(output, 'haveEyeInfo' + suffix)),
                'haveGazeInfo': have_gaze,
                'worldPoint': world_point,
                'eyeInfo': {
                    'pupilCenter': _vector(eye_info.pupilCenter, 'xy'),
                    'pupilWidth': _finite(eye_info.pupilWidth),
                    'pupilHeight': _finite(eye_info.pupilHeight),
                    'pupilAngle': _finite(eye_info.pupilAngle),
                },
                'sightLine': {
                    'corneaCenter': _vector(sight_line.corneaCenter, 'xyz'),
                    'direction': _vector(sight_line.direction, 'xyz'),
                },
            },
        }
    position = tuple(sum(point[i] for _, point in points) / len(points) for i in (0, 1)) if points else None
    return GazeSample(identity, position, 'world_normalized_top_left', None, bool(points),
                      tuple(eye for eye, _ in points), monocular=monocular,
                      world_resolution=(width, height))
