"""Scene-camera angular residuals and explicitly custom score metadata.

The comparison statistic follows Pupil Core Accuracy Visualizer's
acos(mean(cos(error))) with its default strict <5 degree outlier selection.
Also retain unfiltered arithmetic mean/P95 so exclusions cannot hide failures.
Pair selection belongs to the caller and is recorded separately.
"""
import math

SCORING_POLICY = 'mrt_angular_linear_v1'


def angular_score(error_deg):
    """User-approved display scale; no pass/fail or official rating implied."""
    if error_deg is None:
        return None
    if type(error_deg) not in (int, float) or not math.isfinite(error_deg) or not 0 <= error_deg <= 180:
        raise ValueError('Invalid angular score input')
    # Round half up, so displayed tenths do not depend on bankers rounding.
    value = max(1., min(10., 10. - 2. * error_deg))
    return math.floor(value * 10 + .5 + 1e-12) / 10


def score_label(metric):
    value = metric.get('qualityScore')
    return f'{value:.1f}/10' if value is not None else '不可用'


def angular_errors(references, predictions, camera):
    import numpy as np
    if len(references) != len(predictions):
        raise ValueError('Angular pairs must have equal lengths')
    if not references:
        return []
    width, height = camera.resolution
    def rays(points):
        points = np.asarray(points, dtype=float)
        if points.shape != (len(references), 2) or not np.isfinite(points).all():
            raise ValueError('Invalid angular coordinates')
        pixels = points * [width, -height] + [0, height]
        values = np.asarray(camera.unprojectPoints(pixels, normalize=True), dtype=float).reshape(-1, 3)
        norms = np.linalg.norm(values, axis=1)
        if not np.isfinite(values).all() or np.any(norms <= 0):
            raise ValueError('Invalid unprojected rays')
        return values / norms[:, None]
    cosine = np.clip(np.sum(rays(references) * rays(predictions), axis=1), -1, 1)
    return np.degrees(np.arccos(cosine)).tolist()


def summarize_angles(errors, threshold=5.0):
    import numpy as np
    values = list(errors)
    if not math.isfinite(threshold) or not 0 < threshold <= 180:
        raise ValueError('Invalid angular exclusion threshold')
    if any(not math.isfinite(v) or not 0 <= v <= 180 for v in values):
        raise ValueError('Invalid angular errors')
    selected = [v for v in values if v < threshold]
    accuracy = math.degrees(math.acos(max(-1., min(1.,
        sum(math.cos(math.radians(v)) for v in selected) / len(selected))))) if selected else None
    return {
        'unit': 'degrees', 'samples': len(values),
        'meanErrorDeg': float(np.mean(values)) if values else None,
        'medianErrorDeg': float(np.median(values)) if values else None,
        'p95ErrorDeg': float(np.percentile(values, 95)) if values else None,
        'maxErrorDeg': max(values) if values else None,
        'pupilCoreAccuracyDeg': accuracy,
        'qualityScore': angular_score(accuracy), 'scoringPolicy': SCORING_POLICY,
        'scoreInputMetric': 'pupilCoreAccuracyDeg', 'scoreRange': [1, 10],
        'scoreFormula': 'round_half_up(clamp(10 - 2 * error_deg, 1, 10), 1)',
        'scoreHigherIsBetter': True, 'scoreIsOfficial': False,
        'pupilCoreUsedSamples': len(selected), 'excludedSamples': len(values) - len(selected),
        'outlierThresholdDeg': threshold,
        'pupilCoreFormula': 'degrees(acos(mean(cos(error_rad)))), error_deg < threshold',
    }


def camera_provenance(camera):
    return {'intrinsics': camera.spec, 'coordinateSpace': 'world_camera_undistorted_unit_rays',
            'intrinsicsIndividuallyCalibrated': camera.spec.get('individually_calibrated', False)}
