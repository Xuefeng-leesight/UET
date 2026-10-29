"""Headless events. Blink filter adapted from Pupil Labs (LGPL-3.0).

Copyright (C) Pupil Labs; see vendor/COPYING and vendor/COPYING.LESSER.
MRT: per-eye bounded histories, deduplicated phases, reset across time gaps.
Fixations: MRT online angular dispersion (1.5 degrees, >=100 ms), not vendor equivalence.
"""
from collections import deque
import math
import numpy as np
from .geometry import gaze_direction


class NativeEvents:
    def __init__(self):
        self.history = [deque(maxlen=128), deque(maxlen=128)]
        self.phase = [None, None]
        self.blink_session = [0, 0]
        self.gaze = deque(maxlen=128)
        self.fixation_id = 0
        self.active = False
        self.last_fixation = None
        self.interval = None

    def reset_fixation(self):
        """Do not join candidates across mapping sources or data interruptions."""
        self.gaze.clear()
        self.active = False
        self.last_fixation = None
        self.interval = None

    def _end_fixation(self, complete, reason):
        final = self.last_fixation
        if complete and final is not None and self.interval is not None:
            interval = self.interval
            length = np.linalg.norm(interval['direction_sum'])
            direction = (interval['direction_sum'] / length).tolist() if np.isfinite(length) and length > 1e-9 else None
            # Window centres cannot be averaged: overlapping windows would
            # count the same samples repeatedly. Each accepted sample enters
            # this bounded accumulator exactly once, including the first window.
            final = {**final, 'timestamp': interval['start'],
                     'duration': (interval['end'] - interval['start']) * 1000,
                     'norm_pos': (interval['position_sum'] / interval['count']).tolist(),
                     'confidence': interval['confidence_sum'] / interval['count'],
                     'direction': direction,
                     'event_algorithm_parameters': {**final['event_algorithm_parameters'],
                         'position_semantics': 'complete_interval_sample_mean'}}
        result = ([{**final, 'event_complete': complete,
                    'event_completion_reason': reason}] if final is not None else [])
        self.reset_fixation()
        return result

    def _include_interval_sample(self, sample):
        stamp, direction, position, confidence = sample
        if self.interval is None:
            self.interval = {'start': stamp, 'end': stamp, 'count': 0,
                             'direction_sum': np.zeros(3), 'position_sum': np.zeros(2),
                             'confidence_sum': 0.}
        interval = self.interval
        interval['end'] = stamp
        interval['count'] += 1
        interval['direction_sum'] += direction
        interval['position_sum'] += position
        interval['confidence_sum'] += confidence

    def pupil(self, pupil):
        eye, stamp = pupil['id'], pupil['timestamp']
        history = self.history[eye]
        if history and (stamp <= history[-1]['timestamp'] or stamp - history[-1]['timestamp'] > .1):
            history.clear()
            self.phase[eye] = None
            self.blink_session[eye] += 1
        history.append(pupil)
        while len(history) > 2 and history[1]['timestamp'] < stamp - .2:
            history.popleft()
        n = len(history)
        if n < 2 or stamp - history[0]['timestamp'] < .2:
            return []
        response = np.ones(n) / n
        response[n // 2:] *= -1
        if n % 2:
            response[n // 2] = 0
        response = float(np.asarray([p['confidence'] for p in history]) @ response / .45)
        phase = 'onset' if response > .5 else 'offset' if response < -.5 else None
        if phase is None or phase == self.phase[eye]:
            return []
        self.phase[eye] = phase
        return [{'topic': 'blinks', 'type': phase, 'confidence': min(abs(response), 1),
                 'timestamp': history[n // 2]['timestamp'], 'eye_id': eye,
                 'detector_session': self.blink_session[eye], 'native_source': True,
                 'event_algorithm': 'pupil_labs_blink_adapted', 'event_algorithm_version': '1',
                 'event_algorithm_parameters': {'history_ms': 200, 'response_divisor': .45,
                                                'response_threshold': .5, 'max_sample_gap_ms': 100,
                                                'attribution': 'per_eye'}}]

    def fixation(self, gaze):
        stamp = gaze['timestamp']
        direction = gaze_direction(gaze)
        if direction is None:
            return self._end_fixation(False, 'invalid_sample')
        pending = []
        if self.gaze and (stamp <= self.gaze[-1][0] or stamp - self.gaze[-1][0] > .1):
            reason = 'non_increasing_time' if stamp <= self.gaze[-1][0] else 'sampling_gap'
            pending = self._end_fixation(False, reason)
        self.gaze.append((stamp, direction, gaze['norm_pos'], gaze['confidence']))
        while self.gaze and stamp - self.gaze[0][0] > .3:
            self.gaze.popleft()
        rays = np.asarray([p[1] for p in self.gaze])
        dispersion = math.degrees(math.acos(float(np.clip(np.min(rays @ rays.T), -1, 1))))
        if dispersion > 1.5:
            last = self.gaze[-1]
            pending.extend(self._end_fixation(True, 'dispersion_exit'))
            self.gaze.append(last)
            return pending
        duration = stamp - self.gaze[0][0]
        if duration < .1:
            return pending
        if not self.active:
            self.fixation_id += 1
            self.active = True
            for sample in self.gaze:
                self._include_interval_sample(sample)
        else:
            self._include_interval_sample(self.gaze[-1])
        mean_direction = np.mean(rays, axis=0)
        mean_direction /= np.linalg.norm(mean_direction)
        self.last_fixation = {'topic': 'fixations', 'timestamp': self.gaze[0][0], 'duration': duration * 1000,
                 'norm_pos': np.mean([p[2] for p in self.gaze], axis=0).tolist(),
                 'confidence': float(np.mean([p[3] for p in self.gaze])), 'id': self.fixation_id,
                 'world_resolution': gaze['world_resolution'],
                 'direction': mean_direction.tolist(),
                 'native_source': True, 'event_algorithm': 'mrt_angular_dispersion',
                 'event_algorithm_version': '3',
                 'event_algorithm_parameters': {'max_dispersion_deg': 1.5, 'min_duration_ms': 100,
                                                'rolling_window_ms': 300, 'max_sample_gap_ms': 100,
                                                'confidence_threshold': .6,
                                                'position_semantics': 'online_window_sample_mean'},
                 'event_complete': False, 'event_completion_reason': 'online_window'}
        return [*pending, self.last_fixation]
