# Pupil Labs numerical components

Source: https://github.com/pupil-labs/pupil
Pinned revision: `7a3cd9e8d2e54ac123ab0ed292d741732db899a2`.
Copyright (C) Pupil Labs. LGPL-3.0; see COPYING and COPYING.LESSER.

`calibrate_3d.py`, `bundle_adjustment.py`, `utils.py` are unmodified upstream numerical modules.
`models.py` contains upstream Model3D, Model3D_Monocular and Model3D_Binocular from gaze_mapping/gazer_3d/gazer_headset.py.
MRT changes (2026-10-11): remove GUI/plugin inheritance and unused imports; inline normalized image coordinate conversion;
use MRT's independently implemented closest-line solver. The numerical calibration and model prediction remain upstream implementations.
Calibration-only imports are lazy so prediction never loads SciPy on the acquisition owner thread.
`camera_intrinsics.json` extracts the upstream default_intrinsics table including its per-eye additions. These are model defaults, not individual camera calibration.
Hashes of original source files are in source-manifest.json.
`../events.py` adapts the confidence differential blink filter from upstream `blink_detection.py`;
MRT changes: independent eye histories, bounded buffers, gap session IDs and phase deduplication.

Distributions must retain this notice and license texts and provide corresponding source, including modifications and build instructions.
Other installed libraries have their own licenses; collect their distribution metadata separately. A separate worker process does not waive license obligations.
