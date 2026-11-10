"""Headless upstream Gazer3D models with bounded timestamp pairing."""
from bisect import bisect_left
import numpy as np

from .camera import Intrinsics
from .vendor.models import Model3D_Binocular, Model3D_Monocular
from ..pupil_core.pupil_quality import pupil_rejection


def usable(pupil):
    if pupil_rejection(pupil, pupil.get('topic')):
        return False
    normal = pupil['circle_3d'].get('normal')
    return (isinstance(normal, (list, tuple)) and len(normal) == 3 and
            all(type(v) in (int, float) and np.isfinite(v) for v in normal) and
            .5 <= np.linalg.norm(normal) <= 1.5)


def features(pupils):
    return np.asarray([[p['id'], *p['sphere']['center'], *p['circle_3d']['normal']] for p in pupils], dtype=float)


def matched_calibration(refs, pupils):
    by_eye = [sorted((p for p in pupils if p.get('id') == eye and
                     usable(p)), key=lambda p: p['timestamp']) for eye in (0, 1)]
    times = [[p['timestamp'] for p in data] for data in by_eye]
    matches = []
    for ref in sorted(refs, key=lambda p: p['timestamp']):
        pair = []
        for data, stamps in zip(by_eye, times):
            index = bisect_left(stamps, ref['timestamp'])
            options = [data[i] for i in (index - 1, index) if 0 <= i < len(data)]
            if not options:
                break
            nearest = min(options, key=lambda p: abs(p['timestamp'] - ref['timestamp']))
            if abs(nearest['timestamp'] - ref['timestamp']) > .05:
                break
            pair.append(nearest)
        if len(pair) == 2 and abs(pair[0]['timestamp'] - pair[1]['timestamp']) <= .05:
            matches.append((ref, *pair))
    if len(matches) < 10:
        raise ValueError('Not enough synchronized, quality-approved calibration observations')
    return matches


class NativeGazer:
    def __init__(self, intrinsics, params=None):
        self.intrinsics = Intrinsics(intrinsics)
        common = {'intrinsics': self.intrinsics, 'initial_depth': 500}
        self.binocular = Model3D_Binocular(initial_eye_translation0=(20, 15, -20),
                                          initial_eye_translation1=(-40, 15, -20), **common)
        self.eyes = [Model3D_Monocular(initial_eye_translation=pos, **common)
                     for pos in ((20, 15, -20), (-40, 15, -20))]
        # Each independently fitted monocular pose has its own depth scale.
        # Substituting binocular depth changes that model's projection/parallax.
        if params is not None:
            self.binocular.set_params(**params['binocular'])
            for model, value in zip(self.eyes, params['eyes']):
                model.set_params(**value)

    def fit(self, refs, pupils):
        matches = matched_calibration(refs, pupils)
        rays = self.intrinsics.unprojectPoints([r['screen_pos'] for r, _, _ in matches], normalize=True)
        eye0 = features([p for _, p, _ in matches])
        eye1 = features([p for _, _, p in matches])
        self.binocular.fit(np.hstack((eye1, eye0)), rays)
        for model, x in zip(self.eyes, (eye0, eye1)):
            model.fit(x, rays)
        params = {'binocular': self.binocular.get_params(), 'eyes': [m.get_params() for m in self.eyes],
                  'matched_observations': len(matches), 'intrinsics': self.intrinsics.spec,
                  'reference_depth_mm': 500, 'eye_translation_source': 'Pupil Core default anthropometry'}
        # A converged optimizer alone is insufficient: reject invalid projections.
        predictions = [self.predict([p0, p1]) for _, p0, p1 in matches]
        if any(g is None or 'norm_pos' not in g for g in predictions):
            raise ValueError('Calibration produced degenerate gaze geometry')
        errors = [np.linalg.norm(np.asarray(g['norm_pos']) - r['norm_pos']) for g, (r, _, _) in zip(predictions, matches)]
        params['training_mean_error_normalized'] = float(np.mean(errors))
        size = np.asarray(self.intrinsics.resolution)
        metrics = {}
        for key, eye in (('binocular', None), ('right', '0'), ('left', '1')):
            values = []
            normalized_errors = []
            for prediction, (ref, _, _) in zip(predictions, matches):
                value = prediction if eye is None else prediction['monocular'].get(eye)
                if value is None:
                    raise ValueError('Calibration produced invalid monocular geometry')
                difference = np.asarray(value['norm_pos']) - ref['norm_pos']
                values.append(float(np.linalg.norm(difference * size)))
                normalized_errors.append(float(np.linalg.norm(difference)))
            if not np.isfinite(values).all() or np.mean(normalized_errors) > .15:
                raise ValueError(f'Calibration {key} reprojection error is too large; resample distributed targets')
            metrics[key] = {'mean_error_px': float(np.mean(values)),
                            'p95_error_px': float(np.percentile(values, 95)), 'samples': len(values)}
        params['training_reprojection'] = {'unit': 'source_pixels', 'lower_is_better': True,
                                           'independent_validation': False, **metrics}
        params['monocular_depth_policy'] = 'independent_model_fitted_depth'
        from ..pupil_core.angular_metrics import angular_errors, summarize_angles, camera_provenance
        params['training_angular'] = {
            **camera_provenance(self.intrinsics), 'independentValidationPerformed': False,
            'metricFormulaAlignedWith': 'Pupil Core Accuracy Visualizer', 'officialPipelineEquivalent': False,
            'pairing': 'nearest quality-approved pupil to training reference within 50ms',
            'metrics': {key: summarize_angles(angular_errors(
                [ref['norm_pos'] for ref, _, _ in matches],
                [(g if eye is None else g['monocular'][eye])['norm_pos'] for g in predictions],
                self.intrinsics)) for key, eye in (('binocular', None), ('left', '1'), ('right', '0'))}}
        if not np.isfinite(errors).all() or np.mean(errors) > .15:
            raise ValueError('Calibration reprojection error is too large; resample distributed targets')
        return params

    def predict(self, pupils):
        if (not pupils or len(pupils) > 2 or any(not isinstance(p, dict) or
                type(p.get('id')) is not int or p['id'] not in (0, 1) or
                type(p.get('timestamp')) not in (float, int) or not np.isfinite(p['timestamp'])
                for p in pupils) or len({p['id'] for p in pupils}) != len(pupils)):
            return None
        received = sorted(pupils, key=lambda p: p['id'])
        pupils = [p for p in received if usable(p)]
        if not pupils:
            return None
        # Use the calibrated model for the actual contributing eye. Never
        # copy the good eye into its partner or keep the rejected pair's time.
        rejected = [p['id'] for p in received if all(p is not used for used in pupils)]
        singles = {}
        for pupil in pupils:
            single = next(self.eyes[pupil['id']].predict(features([pupil])), None)
            if single and np.isfinite(single['gaze_point_3d']).all() and np.isfinite(single['norm_pos']).all():
                singles[str(pupil['id'])] = single
        if len(pupils) == 2:
            result = next(self.binocular.predict(np.hstack((features([pupils[1]]), features([pupils[0]])))), None)
        else:
            result = singles.get(str(pupils[0]['id']))
        if result is None or not np.isfinite(result['norm_pos']).all() or not np.isfinite(result['gaze_point_3d']).all():
            if not singles:
                return None
            # Independent monocular projections remain real measurements when
            # binocular intersection is degenerate. Keep the recommendation
            # missing; neither select an arbitrary eye nor average the models.
            result = {}
        reason = ('binocular_geometry_unavailable' if not result else
                  'paired_eye_quality_rejected' if rejected else
                  'binocular' if len(pupils) == 2 else 'single_eye_input')
        return {**result, 'monocular': singles, 'topic': 'gaze.3d.01.' if len(pupils) == 2 else f"gaze.3d.{pupils[0]['id']}.",
                'confidence': float(np.mean([p['confidence'] for p in pupils])),
                'timestamp': float(np.mean([p['timestamp'] for p in pupils])), 'base_data': pupils,
                'mapping_mode': 'binocular' if len(pupils) == 2 else 'monocular',
                'mapping_reason': reason,
                'rejected_eye_ids': rejected,
                'native_source': True, 'world_resolution': list(self.intrinsics.resolution)}
