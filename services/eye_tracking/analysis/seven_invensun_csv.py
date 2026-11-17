"""Column layout of the 7invensun (Pro/A8/aSee) sample CSV.

One list shared by the 7invensun recorder and the converter that writes
Pupil/Huahong recordings in the same layout, so both always match.
"""

SEVEN_INVENSUN_BASE_HEADER = (
    'timestamp', 'video_time_ms', 'recommend', 'recom_gaze_x',
    'recom_gaze_y', 'recom_gaze_bit_mask', 'recom_gaze_point_x', 'recom_gaze_point_y',
    'recom_gaze_point_z', 'recom_raw_point_x', 'recom_raw_point_y', 'recom_raw_point_z',
    'recom_smooth_point_x', 'recom_smooth_point_y', 'recom_smooth_point_z', 'recom_origin_x',
    'recom_origin_y', 'recom_origin_z', 'recom_direction_x', 'recom_direction_y',
    'recom_direction_z', 'recom_re', 'left_gaze_bit_mask', 'left_gaze_point_x',
    'left_gaze_point_y', 'left_gaze_point_z', 'left_raw_point_x', 'left_raw_point_y',
    'left_raw_point_z', 'left_smooth_point_x', 'left_smooth_point_y', 'left_smooth_point_z',
    'left_origin_x', 'left_origin_y', 'left_origin_z', 'left_direction_x',
    'left_direction_y', 'left_direction_z', 'left_re', 'right_gaze_bit_mask',
    'right_gaze_point_x', 'right_gaze_point_y', 'right_gaze_point_z', 'right_raw_point_x',
    'right_raw_point_y', 'right_raw_point_z', 'right_smooth_point_x', 'right_smooth_point_y',
    'right_smooth_point_z', 'right_origin_x', 'right_origin_y', 'right_origin_z',
    'right_direction_x', 'right_direction_y', 'right_direction_z', 'right_re',
    'left_pupil_bit_mask', 'left_pupil_center_x', 'left_pupil_center_y', 'left_pupil_distance',
    'left_pupil_diameter', 'left_pupil_diameter_mm', 'left_pupil_minor_axis', 'left_pupil_minor_axis_mm',
    'right_pupil_bit_mask', 'right_pupil_center_x', 'right_pupil_center_y', 'right_pupil_distance',
    'right_pupil_diameter', 'right_pupil_diameter_mm', 'right_pupil_minor_axis', 'right_pupil_minor_axis_mm',
    'left_eye_data_ex_bit_mask', 'left_blink', 'left_openness', 'left_eyelid_up',
    'left_eyelid_down', 'left_ex_data_bit_mask', 'right_eye_data_ex_bit_mask', 'right_blink',
    'right_openness', 'right_eyelid_up', 'right_eyelid_down', 'right_ex_data_bit_mask',
    'fixation_timestamp', 'fixation_duration', 'fixation_timestamp_us', 'fixation_duration_us',
    'fixation_timestamp_ms', 'fixation_duration_ms', 'fixation_count', 'fixation_state',
    'fixation_center_x', 'fixation_center_y', 'stimulus', 'triggerMark',
    'customMarker',
)

# Optional groups appended after the base columns, in this order.
SEVEN_INVENSUN_MOUSE_COLUMNS = ("mouse_x", "mouse_y")
SEVEN_INVENSUN_GYRO_COLUMNS = (
    "gyro_timestamp", "quat_data[0]", "quat_data[1]", "quat_data[2]", "quat_data[3]",
    "gyro[0]", "gyro[1]", "gyro[2]", "accel[0]", "accel[1]", "accel[2]", "mag[0]", "mag[1]", "mag[2]",
)


def seven_invensun_csv_header(record_mouse=False, glasses=False):
    header = list(SEVEN_INVENSUN_BASE_HEADER)
    if record_mouse:
        header.extend(SEVEN_INVENSUN_MOUSE_COLUMNS)
    if glasses:
        header.extend(SEVEN_INVENSUN_GYRO_COLUMNS)
    return header
