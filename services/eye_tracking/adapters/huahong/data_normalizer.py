"""Compatibility aliases preserve top-left coordinates and missing values."""
from dataclasses import replace
import json
import math
from ...infrastructure.pupil_csv import gaze_csv_row as pupil_row
from ...transport.pupil_protocol import image_message as encode_image


def _monocular_position(sample, eye):
    value = sample.monocular.get(eye, {}).get('position')
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    return tuple(value) if all(type(v) in (int, float) and math.isfinite(v) and 0 <= v <= 1 for v in value) else None


def _et28_pupil_center(sample, eye):
    vendor = sample.monocular.get(eye, {}).get('vendor', {})
    if vendor.get('haveEyeInfo') is not True:
        return None
    center = vendor.get('eyeInfo', {}).get('pupilCenter')
    if not isinstance(center, dict):
        return None
    point = {axis: center.get(axis) for axis in ('x', 'y')}
    return point if all(type(value) in (int, float) and math.isfinite(value)
                        for value in point.values()) else None


def gaze_csv_row(sample, t0_s, pupils=None):
    if sample.coordinate_space not in ('world_normalized_top_left', 'screen_normalized_top_left'):
        raise ValueError('Unverified Huahong coordinate space')
    position = (sample.position[0], 1 - sample.position[1]) if sample.position else None
    row = pupil_row(replace(sample, position=position, coordinate_space='world_normalized_bottom_left'), t0_s, pupils)
    row['source_model'] = sample.identity.source
    row['source_backend'] = 'huahong_sdk'
    # The Pupil mapper needs a temporary bottom-left coordinate to produce the
    # existing MRT aliases. Source fields must still describe the actual input.
    row['source_norm_pos_x'], row['source_norm_pos_y'] = sample.position or ('', '')
    row['pupil_valid'] = ''  # Gaze availability does not establish pupil validity.
    row['pupil_center_space'] = ''  # ET28 eyeInfo units are not documented.
    row['recom_gaze_bit_mask'] = 1 if sample.valid and sample.position is not None else 0
    # These export columns denote physical 3D points. Huahong only establishes
    # normalized 2D gaze here, with no separate raw or smoothed measurement.
    for eye in ('recom', 'left', 'right'):
        for key in ('gaze_point', 'raw_point', 'smooth_point'):
            for axis in 'xyz':
                row[f'{eye}_{key}_{axis}'] = ''
    for eye in ('left', 'right'):
        point = _monocular_position(sample, eye)
        if eye not in sample.monocular:
            continue
        row[f'{eye}_gaze_bit_mask'] = 1 if point is not None else 0
        if point is not None:
            row[f'{eye}_gaze_x'], row[f'{eye}_gaze_y'] = point
    return row


def gaze_message(sample, pupils=None):
    point = dict(zip(('x', 'y'), sample.position)) if sample.valid and sample.position else None
    ts = round(sample.identity.source_time_s * 1_000_000)
    # Live UI aliases are explicitly 2D via coordinate_space, with no extra filter.
    def gaze_fields(position):
        return {'gaze_bit_mask': 7 if position else 0, 'gaze': position,
                'gaze_point': position, 'raw': position, 'smooth': position}
    eye_data = {'ts': ts, 're_gaze': gaze_fields(point)}
    for eye, key in (('left', 'l_gaze'), ('right', 'r_gaze')):
        if eye in sample.monocular:
            position = _monocular_position(sample, eye)
            eye_data[key] = gaze_fields(dict(zip(('x', 'y'), position)) if position is not None else None)
    if sample.identity.source == 'HH_ET28':
        # The vendor explicitly calls this 2D point the pupil center, but does
        # not specify its units/origin. The live panel displays the supplied x/y
        # unchanged; do not reinterpret it as normalized, pixel or millimeter data.
        for eye, key in (('left', 'l_pupil'), ('right', 'r_pupil')):
            eye_data[key] = {'center': _et28_pupil_center(sample, eye),
                             'center_space': 'vendor_et28_eye_info', 'center_unit': 'unverified'}
    return json.dumps({'source': sample.identity.source, 'timestamp': ts,
                       'coordinate_space': sample.coordinate_space,
                       'eye_data': eye_data}, allow_nan=False)


def image_payload(frame):
    result = json.loads(encode_image(frame))
    result.update(source=frame.identity.source, timestamp_domain='host_arrival')
    if frame.identity.source == 'HH_ET10C' and frame.stream == 'left_eye':
        # MRT has a single primary preview tile; this is explicitly eye preview,
        # not the screen frame selected separately by the recorder.
        result.update(kind='scene', preview_role='combined_eye', source_stream=frame.stream)
    return result


def image_message(frame):
    return json.dumps(image_payload(frame), allow_nan=False)
