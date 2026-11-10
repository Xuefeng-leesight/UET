# 7invensun adapter

This package owns the three existing 7invensun device implementations:

- `ProDriver` — Pro desktop device;
- `A8Driver` — A8 desktop device;
- `ASeeGlassesPlusDriver` — aSeeGlassesPlus glasses device.

Vendor assets live under `SDK/invensun_7/{Pro,A8,aSeeGlassesPlus}`.
Electron resolves this container in development and under the packaged
`resources/SDK/invensun_7` directory; the existing SDK resource copy preserves
the vendor subdirectory. Python also discovers it when launched directly.
`MRT_SDK_CONTAINER` accepts either `SDK` or `SDK/invensun_7`, while
`MRT_SDK_ROOT` and `MRT_TYPES_DIR` continue to mean the exact runtime and Python
type directories. Automatic discovery requires the vendor directory; flat
`SDK/Pro`, `SDK/A8` and `SDK/aSeeGlassesPlus` layouts are not selected. `SDK/huahong`
is a separate vendor and is not searched for these three models.

The migration is structural and behavior-preserving. DLL names, ctypes
signatures, callback retention, H.265 handling,
calibration sequence, coefficient encoding, and model aliases remain in the
driver implementation. `paths.py` owns path discovery and Windows path
encoding. `ctypes_types.py` owns dynamic vendor type loading and historical
symbol aliases. `data_normalizer.py` owns the existing gaze-point selection
rule used by `SDKService`.

The compatibility module is now located at
`services/eye_tracking/adapters/invensun_7/sdk_driver.py`. It aliases the driver
implementation so script and package imports resolve the same classes; it must
not become a second implementation. The process entry point is
`services/eye_tracking/entrypoints/server.py`. The former root-level entry point
and `sdk_driver.py` were moved on 2026-10-16, with internal imports updated.
See [service layout and command migration](../../../README.md).

Importing this package has no vendor side effects: it does not load a DLL,
read a password, connect hardware, or start a decoder. DLL loading starts only
after `load()` is called by the existing `SDKService` lifecycle.

The adapter cannot be hardware-validated in this workspace because no Pro, A8,
or aSeeGlassesPlus device is connected. Automated checks cover import isolation,
factory/model routing, path selection, callback/type alias helpers, gaze
selection edge cases, source compilation, and the complete legacy driver
surface. A real-device acceptance pass is still required for each model.
