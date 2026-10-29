"""Explicit MRT CSV mapping; no fake single-eye gaze, pupil units or calibration."""

from ..domain.samples import GazeSample, paired_pupils, pupil_pixels_valid

CSV_FIELDS = (
    "timestamp", "video_time_ms", "recom_gaze_x", "recom_gaze_y", "recom_gaze_bit_mask",
    "recom_gaze_point_x", "recom_gaze_point_y", "recom_raw_point_x", "recom_raw_point_y",
    "recom_smooth_point_x", "recom_smooth_point_y", "pupil_confidence", "pupil_valid",
    "source_timestamp_s", "source_topic", "source_generation", "source_receive_sequence",
    "source_model", "stimulus", "triggerMark", "customMarker",
    "left_pupil_diameter_mm", "right_pupil_diameter_mm", "left_pupil_diameter_px", "right_pupil_diameter_px",
    "left_pupil_source_timestamp_s", "right_pupil_source_timestamp_s",
    "source_event_type", "source_event_id", "fixation_state", "fixation_index",
    "fixation_timestamp_ms", "fixation_duration_ms", "fixation_center_x", "fixation_center_y",
    "blink", "blink_phase", "blink_pair_status", "blink_pair_id",
    "gaze_invalid_reason", "gaze_model_quality", "pupil_pairing",
    "left_pupil_model_confidence", "right_pupil_model_confidence",
    "left_pupil_model_quality", "right_pupil_model_quality",
    "source_norm_pos_x", "source_norm_pos_y",
    "left_pupil_raw_diameter_mm", "right_pupil_raw_diameter_mm",
)

# Existing front-end export keys. New geometry is opt-in per row so historical
# normalized point aliases keep their original interpretation.
CSV_FIELDS += ('source_backend', 'geometry_space', 'pupil_center_space', 'recom_re',
               'gaze_velocity_px_ms', 'gaze_velocity_deg_ms')
CSV_FIELDS += tuple(f'{eye}_{key}' for eye in ('left', 'right') for key in (
    'pupil_center_x', 'pupil_center_y', 'pupil_minor_axis', 'pupil_diameter', 'pupil_distance',
    'pupil_valid', 'gaze_x', 'gaze_y', 'gaze_bit_mask', 're'))
CSV_FIELDS += tuple(f'{eye}_{key}_{axis}' for eye in ('recom', 'left', 'right')
                    for key in ('origin', 'direction') for axis in 'xyz')
CSV_FIELDS += tuple(f'{eye}_{key}_{axis}' for eye in ('recom', 'left', 'right')
                    for key in ('gaze_point', 'raw_point', 'smooth_point') for axis in 'xyz'
                    if f'{eye}_{key}_{axis}' not in CSV_FIELDS)
CSV_FIELDS += ('left_blink', 'right_blink', 'blink_marker', 'blink_index', 'blink_duration_ms')
CSV_FIELDS += ('saccade_index', 'saccade_duration_ms', 'saccade_distance_px', 'saccade_distance_deg',
               'average_saccade_velocity_px_ms', 'average_saccade_velocity_deg_ms',
               'peak_saccade_velocity_px_ms', 'peak_saccade_velocity_deg_ms',
               'saccade_start_x', 'saccade_start_y', 'saccade_end_x', 'saccade_end_y',
               'fixation_point_x_px', 'fixation_point_y_px')
CSV_FIELDS += ('saccade_endpoint_distance_px', 'saccade_endpoint_distance_deg',
               'fixation_direction_x', 'fixation_direction_y', 'fixation_direction_z')
CSV_FIELDS += ('gaze_valid', 'gaze_coordinate_space', 'source_coordinate_space',
               'gaze_bit_mask_semantics', 'gaze_raw_semantics', 'gaze_smoothing',
               'gaze_mapping_mode', 'gaze_mapping_reason', 'gaze_rejected_eye_ids', 'gaze_source_order')
CSV_FIELDS += tuple(f'{eye}_{key}' for eye in ('left', 'right') for key in (
    'pupil_confidence', 'pupil_invalid_reason', 'pupil_raw_diameter_px', 'pupil_diameter_mm_valid'))
CSV_FIELDS += ('source_event_algorithm', 'source_event_algorithm_version', 'source_event_algorithm_parameters',
               'source_event_start_timestamp_s', 'source_event_duration_ms', 'source_event_clipped',
               'source_event_completion')
CSV_FIELDS += ('pupil_model_quality_policy',)
CSV_FIELDS += tuple(f'{eye}_pupil_{key}' for eye in ('left', 'right') for key in (
    'pixel_confidence', 'pixel_valid', 'pixel_source', 'projected_diameter_px', 'raw_projected_diameter_px'))
CSV_FIELDS += ('pupil_axis_unit',)
CSV_FIELDS += tuple(f'{eye}_pupil_image_{axis}' for eye in ('left', 'right') for axis in ('width', 'height'))
CSV_FIELDS += ('udp_send', 'udp_receive', 'trigger_send', 'trigger_receive',
               'communication_recording_id', 'communication_channel', 'communication_text_encoding')
# Internal continuity evidence, not additional user-selectable export columns.
CSV_FIELDS += ('world_image_width', 'world_image_height', 'world_resolution_epoch')


def vector_columns(row, prefix, value):
    if value is not None:
        for axis, component in zip('xyz', value):
            row[f'{prefix}_{axis}'] = component


def gaze_csv_row(sample: GazeSample, t0_s: float, pupils=None) -> dict:
    if sample.coordinate_space != "world_normalized_bottom_left":
        raise ValueError("Unverified gaze coordinate space")
    row = dict.fromkeys(CSV_FIELDS, "")
    video_time_ms = (sample.identity.source_time_s - t0_s) * 1000
    row.update(timestamp=video_time_ms, video_time_ms=video_time_ms, source_model="PupilCore",
               recom_gaze_bit_mask=1 if sample.valid else 0,
               pupil_confidence=sample.confidence, pupil_valid=int(sample.valid),
               source_timestamp_s=sample.identity.source_time_s, source_topic=sample.identity.topic,
               source_generation=sample.identity.generation,
               source_receive_sequence=sample.identity.received_sequence,
               gaze_invalid_reason=sample.invalid_reason, gaze_model_quality=sample.model_quality,
               pupil_pairing=sample.pupil_pairing)
    row['source_backend'] = 'native' if sample.native else 'capture'
    row['pupil_center_space'] = 'eye_image_normalized_top_left'
    row['pupil_axis_unit'] = 'image_width_ratio'
    row['pupil_model_quality_policy'] = 'mrt_pupil_model_bounds_v1'
    row.update(gaze_valid=int(sample.valid), gaze_coordinate_space='world_normalized_top_left',
               source_coordinate_space=sample.coordinate_space,
               gaze_bit_mask_semantics='mrt_availability_bits_0_recommended_1_raw_2_smooth',
               gaze_raw_semantics='calibrated_3d_point' if sample.point_3d is not None else 'unavailable',
               gaze_smoothing='unavailable',
               gaze_mapping_mode=sample.mapping_mode, gaze_mapping_reason=sample.mapping_reason,
               gaze_rejected_eye_ids=','.join(str(eye) for eye in sample.rejected_eye_ids),
               gaze_source_order=sample.source_order)
    row['world_resolution_epoch'] = sample.world_resolution_epoch
    if sample.world_resolution is not None:
        row['world_image_width'], row['world_image_height'] = sample.world_resolution
    if sample.position is not None:
        row["source_norm_pos_x"], row["source_norm_pos_y"] = sample.position
    if sample.valid and sample.position is not None:
        x, y_bottom = sample.position
        # MRT scene image space is top-left; Pupil norm_pos is bottom-left.
        row['recom_gaze_x'], row['recom_gaze_y'] = x, 1 - y_bottom
    # The standard 3D/smoothing columns never receive a normalized 2D alias.
    contributors = paired_pupils(sample, pupils, include_invalid=True)
    for eye, pupil in contributors.items():
        mm_valid = pupil.valid and pupil.diameter_mm is not None and pupil.model_quality != 'bad'
        pixel_valid = pupil_pixels_valid(pupil)
        row[f"{eye}_pupil_diameter_mm"] = pupil.diameter_mm if mm_valid else ""
        row[f"{eye}_pupil_raw_diameter_mm"] = pupil.diameter_mm if pupil.diameter_mm is not None else ""
        row[f"{eye}_pupil_raw_diameter_px"] = pupil.diameter_px if pupil.diameter_px is not None else ""
        row[f"{eye}_pupil_diameter_px"] = pupil.diameter_px if pixel_valid and pupil.diameter_px is not None else ""
        row[f'{eye}_pupil_pixel_confidence'] = pupil.pixel_confidence if pupil.pixel_confidence is not None else ''
        row[f'{eye}_pupil_pixel_valid'] = int(pupil.pixel_valid) if pupil.pixel_valid is not None else ''
        row[f'{eye}_pupil_pixel_source'] = pupil.pixel_source
        row[f'{eye}_pupil_raw_projected_diameter_px'] = pupil.projected_diameter_px if pupil.projected_diameter_px is not None else ''
        row[f'{eye}_pupil_projected_diameter_px'] = pupil.projected_diameter_px if (
            pupil.valid and pupil.model_quality != 'bad' and pupil.projected_diameter_px is not None) else ''
        row[f'{eye}_pupil_confidence'] = pupil.confidence if pupil.confidence is not None else ''
        row[f'{eye}_pupil_diameter_mm_valid'] = int(mm_valid)
        row[f'{eye}_pupil_invalid_reason'] = (
            'invalid_detection' if not pupil.valid else 'bad_3d_model' if pupil.model_quality == 'bad' else '')
        row[f"{eye}_pupil_source_timestamp_s"] = pupil.identity.source_time_s
        row[f"{eye}_pupil_model_confidence"] = pupil.model_confidence if pupil.model_confidence is not None else ""
        row[f"{eye}_pupil_model_quality"] = pupil.model_quality
        row[f'{eye}_pupil_valid'] = int(pupil.valid)
        if pupil.image_resolution is not None:
            width, height = pupil.image_resolution
            row[f'{eye}_pupil_image_width'], row[f'{eye}_pupil_image_height'] = width, height
            if pixel_valid:
                row[f'{eye}_pupil_diameter'] = pupil.diameter_px / width if pupil.diameter_px is not None else ''
                row[f'{eye}_pupil_minor_axis'] = pupil.minor_axis_px / width if pupil.minor_axis_px is not None else ''
        if pixel_valid and pupil.center_normalized is not None:
            row[f'{eye}_pupil_center_x'], row[f'{eye}_pupil_center_y'] = pupil.center_normalized
        # Pupil's circle-centre Z is a model depth, not the 7invensun SDK's
        # pupil-to-lens distance. Its exact equivalent has not been verified.
    if sample.native or sample.point_3d is not None or sample.eye_centers_3d or sample.eye_normals_3d:
        # Capture also publishes genuine 3D geometry. Backend identity must
        # not suppress it or replace it with normalized coordinates.
        row['geometry_space'] = 'world_camera_mm'
        # Bit 0 denotes the normalized recommendation, bit 1 the actual raw
        # point, and bit 2 an independently smoothed point. No filter runs here.
        row['recom_gaze_bit_mask'] = 1 if sample.valid and sample.position is not None else 0
        for key in ('gaze_point', 'raw_point', 'smooth_point'):
            for axis in 'xyz':
                row[f'recom_{key}_{axis}'] = ''
        good = {eye for eye, pupil in contributors.items() if pupil.model_quality == 'good' and pupil.valid}
        # Each monocular projection has its own quality. A rejected binocular
        # recommendation must not erase a genuinely valid monocular result.
        for eye in good:
            single = sample.monocular.get(eye)
            if not sample.native:
                vector_columns(row, f'{eye}_origin', sample.eye_centers_3d.get(eye))
                vector_columns(row, f'{eye}_direction', sample.eye_normals_3d.get(eye))
                if eye in sample.eye_normals_3d:
                    row[f'{eye}_re'] = contributors[eye].confidence
                if len(sample.contributing_eyes) == 1 and sample.valid and sample.point_3d is not None:
                    single = {'position': sample.position, 'point': sample.point_3d,
                              'origin': sample.eye_centers_3d.get(eye),
                              'direction': sample.eye_normals_3d.get(eye)}
            if single:
                vector_columns(row, f'{eye}_origin', single.get('origin'))
                vector_columns(row, f'{eye}_direction', single.get('direction'))
                row[f'{eye}_gaze_x'], y = single['position']
                row[f'{eye}_gaze_y'] = 1 - y
                row[f'{eye}_gaze_bit_mask'] = 3
                row[f'{eye}_re'] = contributors[eye].confidence
                vector_columns(row, f'{eye}_gaze_point', single['point'])
                vector_columns(row, f'{eye}_raw_point', single['point'])
        if sample.valid:
            vector_columns(row, 'recom_gaze_point', sample.point_3d)
            vector_columns(row, 'recom_raw_point', sample.point_3d)
            if sample.point_3d is not None:
                row['recom_gaze_bit_mask'] |= 2
            centers = [sample.eye_centers_3d[e] for e in good if e in sample.eye_centers_3d]
            if centers and sample.point_3d is not None:
                import math
                origin = tuple(sum(v[i] for v in centers) / len(centers) for i in range(3))
                direction = tuple(sample.point_3d[i] - origin[i] for i in range(3))
                length = math.sqrt(sum(v * v for v in direction))
                if length > 1e-9:
                    vector_columns(row, 'recom_origin', origin)
                    vector_columns(row, 'recom_direction', tuple(v / length for v in direction))
    if sample.valid:
        row['recom_re'] = sample.confidence if sample.confidence is not None else ''
    return row


class NativeCsvMapper:
    """Native/Capture sample speeds, reset at invalidity or source discontinuity."""
    def __init__(self):
        self.previous = None

    def __call__(self, sample, t0_s, pupils=None):
        import math
        row = gaze_csv_row(sample, t0_s, pupils)
        if (not sample.valid or sample.position is None or sample.world_resolution is None
                or sample.source_order == 'late_source_time'):
            self.previous = None
            return row
        point = (sample.position[0] * sample.world_resolution[0], sample.position[1] * sample.world_resolution[1])
        direction = tuple(row[f'recom_direction_{a}'] for a in 'xyz')
        previous, self.previous = self.previous, (sample, point, direction)
        if previous is not None:
            before, before_point, before_direction = previous
            dt = (sample.identity.source_time_s - before.identity.source_time_s) * 1000
            if dt <= 0:
                # Capture mixes asynchronous gaze topics. A late or duplicate
                # sample remains recorded but must not seed the next derivative.
                self.previous = None
                return row
            if (0 < dt <= 100 and before.identity.generation == sample.identity.generation
                    and before.world_resolution == sample.world_resolution
                    and before.world_resolution_epoch == sample.world_resolution_epoch
                    and before.native == sample.native
                    and before.identity.topic == sample.identity.topic
                    and before.contributing_eyes == sample.contributing_eyes):
                row['gaze_velocity_px_ms'] = math.dist(point, before_point) / dt
                if all(type(v) in (float, int) for v in (*direction, *before_direction)):
                    dot = sum(a * b for a, b in zip(direction, before_direction))
                    row['gaze_velocity_deg_ms'] = math.degrees(math.acos(max(-1, min(1, dot)))) / dt
        return row
