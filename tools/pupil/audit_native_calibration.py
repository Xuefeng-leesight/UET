"""Read-only comparison of archived native calibration and measured contributors.

Writes a new report only; training residuals are not independent accuracy.
Run with the native Python environment, never from the production backend.
"""
import argparse
import hashlib
import json
from pathlib import Path

import msgpack
import numpy as np

from services.eye_tracking.adapters.pupil_native.gazer import NativeGazer, matched_calibration


def summarize(values):
    return {'samples': len(values), 'mean_error_px': float(np.mean(values)),
            'p95_error_px': float(np.percentile(values, 95)), 'max_error_px': float(max(values))}


def audit(path):
    data = path.read_bytes()
    archive = msgpack.unpackb(data, raw=False, strict_map_key=False)
    if archive.get('backend') != 'native':
        raise ValueError('A native calibration archive is required')
    params = archive['result']['params']
    matches = matched_calibration(archive['ref_list'], archive['pupil_list'])
    models = {key: NativeGazer(params['intrinsics'], params) for key in ('legacy_mixed_depth', 'fixed_model_depth')}
    for eye in models['legacy_mixed_depth'].eyes:
        eye.binocular_model = models['legacy_mixed_depth'].binocular
    report = {'source_sha256': hashlib.sha256(data).hexdigest(), 'source': str(path),
              'unit': 'source_pixels', 'independent_accuracy_measured': False,
              'meaning': 'Training reprojection only; identical saved poses and input pairs, no refit or correction',
              'matched_observations': len(matches), 'reference_centers': archive['centers'], 'comparisons': {}}
    size = np.asarray(params['intrinsics']['resolution'])
    for key, model in models.items():
        errors = {eye: [] for eye in ('binocular', 'left', 'right')}
        for ref, p0, p1 in matches:
            prediction = model.predict([p0, p1])
            if prediction is None:
                raise ValueError('Invalid training prediction')
            for eye, value in [('binocular', prediction), ('right', prediction['monocular']['0']),
                               ('left', prediction['monocular']['1'])]:
                errors[eye].append(float(np.linalg.norm((np.asarray(value['norm_pos']) - ref['norm_pos']) * size)))
        report['comparisons'][key] = {eye: summarize(values) for eye, values in errors.items()}
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    report = audit(args.archive)
    with args.output.open('x', encoding='utf-8') as output:
        json.dump(report, output, indent=2, ensure_ascii=False, allow_nan=False)
        output.write('\n')
    print(json.dumps(report['comparisons'], indent=2))


if __name__ == '__main__':
    main()
