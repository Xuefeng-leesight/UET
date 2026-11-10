"""MRT I-VT saccades, explicit 30deg/s threshold and 8..100ms duration.

These are algorithmic estimates, not vendor SDK events. Invalid data and gaps
discard incomplete candidates instead of bridging missing samples.
"""
import math
from .geometry import gaze_direction


class Saccades:
    def __init__(self):
        self.previous = None
        self.candidate = []
        self.overlong = False
        self.index = 0

    def reset_motion(self):
        """Break continuity without reusing event IDs or resetting blink state."""
        self.previous, self.candidate = None, []
        self.overlong = False

    def push(self, gaze):
        direction = gaze_direction(gaze)
        position, size = gaze.get('norm_pos'), gaze.get('world_resolution')
        if direction is None or size is None:
            self.previous, self.candidate = None, []
            self.overlong = False
            return []
        current = (gaze, tuple(direction), (position[0] * size[0], position[1] * size[1]))
        previous, self.previous = self.previous, current
        if previous is None:
            return []
        dt = (gaze['timestamp'] - previous[0]['timestamp']) * 1000
        if not 0 < dt <= 50 or size != previous[0]['world_resolution']:
            self.candidate = []
            self.overlong = False
            return []
        angle = self.angle(previous[1], current[1])
        angular, pixel = angle / dt, math.dist(previous[2], current[2]) / dt
        if angular >= .03:
            if self.overlong:
                return []
            self.candidate.append((previous, current, dt, angular, pixel))
            if (gaze['timestamp'] - self.candidate[0][0][0]['timestamp']) * 1000 > 100 or len(self.candidate) > 64:
                self.candidate = []
                self.overlong = True
            return []
        self.overlong = False
        candidate, self.candidate = self.candidate, []
        if not candidate:
            return []
        start, end = candidate[0][0], candidate[-1][1]
        duration = (end[0]['timestamp'] - start[0]['timestamp']) * 1000
        if len(candidate) < 2 or not 8 <= duration <= 100:
            return []
        self.index += 1
        return [{'topic': 'saccades', 'native_source': True, 'timestamp': start[0]['timestamp'],
                 'duration': duration, 'id': self.index, 'norm_pos': end[0]['norm_pos'],
                 'event_algorithm': 'mrt_ivt', 'event_algorithm_version': '1',
                 'event_algorithm_parameters': {'velocity_threshold_deg_s': 30, 'min_duration_ms': 8,
                    'max_duration_ms': 100, 'max_sample_gap_ms': 50, 'min_velocity_segments': 2},
                 'event_complete': True, 'event_completion_reason': 'velocity_below_threshold',
                 'confidence': min(v[1][0]['confidence'] for v in candidate),
                 'metrics': {'saccade_endpoint_distance_px': math.dist(start[2], end[2]),
                    'saccade_endpoint_distance_deg': self.angle(start[1], end[1]),
                    'average_saccade_velocity_px_ms': sum(v[4] * v[2] for v in candidate) / duration,
                    'average_saccade_velocity_deg_ms': sum(v[3] * v[2] for v in candidate) / duration,
                    'peak_saccade_velocity_px_ms': max(v[4] for v in candidate),
                    'peak_saccade_velocity_deg_ms': max(v[3] for v in candidate),
                    'saccade_start_x': start[0]['norm_pos'][0], 'saccade_start_y': 1-start[0]['norm_pos'][1],
                    'saccade_end_x': end[0]['norm_pos'][0], 'saccade_end_y': 1-end[0]['norm_pos'][1]}}]

    @staticmethod
    def angle(a, b):
        return math.degrees(math.acos(max(-1, min(1, sum(x*y for x, y in zip(a, b))))))
