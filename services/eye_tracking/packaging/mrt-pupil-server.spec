"""Build on the destination OS; FFmpeg/ffprobe are explicit external assets."""
from pathlib import Path
import os
import sys
from PyInstaller.utils.hooks import collect_all, collect_data_files, copy_metadata

spec_root = Path(SPECPATH).resolve()
repo_root = spec_root.parents[2]
native_datas, native_binaries, native_imports = [], [], []
for module in ('pye3d', 'pupil_detectors', 'uvc', 'cysignals', 'sortedcontainers'):
    data, binaries, imports = collect_all(module)
    native_datas += data
    native_binaries += binaries
    native_imports += imports
for distribution in ('pye3d', 'pupil-detectors', 'pupil-labs-uvc'):
    native_datas += copy_metadata(distribution)
native_datas += collect_data_files('services.eye_tracking.adapters.pupil_native', includes=['vendor/*.json', 'vendor/*.md', 'vendor/COPYING*'])
a = Analysis(
    [str(spec_root.parent / "entrypoints" / "pupil_server.py")],
    pathex=[str(repo_root)],
    binaries=native_binaries, datas=native_datas,
    hiddenimports=native_imports + ["cv2", "numpy", "scipy.optimize", "scipy.sparse", "zmq", "msgpack", "PIL.Image", "PIL.JpegImagePlugin", "websockets.asyncio.server", "services.eye_tracking.analysis.gaze_mapper"],
    # All extensions are built ahead of time. Setuptools is pulled in by
    # optional dependency build paths; its runtime hook imports a build system
    # before our entry point in every service/camera/fit process.
    excludes=["tests", "setuptools", "services.eye_tracking.adapters.invensun_7.sdk_driver", "services.eye_tracking.application.sdk_service"],
    noarchive=False,
)
pyz = PYZ(a.pure)
# Electron already distributes a directory. Keep shared libraries at stable paths
# rather than extracting and verifying them again for every backend launch.
exe = EXE(pyz, a.scripts, [], name="mrt-pupil-server", exclude_binaries=True,
          console=True, debug=False, strip=False, upx=False,
          append_pkg=False,
          codesign_identity=os.environ.get('MRT_PUPIL_CODESIGN_IDENTITY') or None)
if sys.platform == 'darwin':
    # Keep the Python archive as signed bundle data instead of appending ~11MB
    # to the launcher. BUNDLE cross-links PKG into MacOS for the bootloader.
    archive = [(Path(exe.pkgname).name, exe.pkgname, 'PKG')]
    bundle = BUNDLE(exe, archive, a.binaries, a.datas, name="PupilBackend.app",
                    bundle_identifier="com.virtualspaces.mrt.pupil-backend",
                    info_plist={"LSUIElement": True})
else:
    bundle = COLLECT(exe, a.binaries, a.datas, name="pupil-backend", strip=False, upx=False)
