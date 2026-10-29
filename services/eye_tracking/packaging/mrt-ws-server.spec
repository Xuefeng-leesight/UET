from pathlib import Path
import sys
from PyInstaller.utils.hooks import collect_all

dxcam_datas, dxcam_binaries, dxcam_hiddenimports = collect_all("dxcam") if sys.platform == "win32" else ([], [], [])

spec_root = Path(globals().get("SPECPATH", Path.cwd())).resolve()
server_root = spec_root.parent

a = Analysis(
    [str(server_root / "entrypoints" / "server.py")],
    pathex=[str(server_root)],
    binaries=dxcam_binaries,
    datas=dxcam_datas,
    hiddenimports=["numpy", "cv2", "mss", "mss.tools", "websockets", "mediapipe", "analysis.gaze_mapper", "analysis.eye_event_postprocess", "application.sdk_service", "transport.server_runtime", "transport.protocol", "adapters.invensun_7", "adapters.invensun_7.driver", "adapters.invensun_7.sdk_driver", "adapters.invensun_7.paths", "adapters.invensun_7.ctypes_types", "adapters.invensun_7.data_normalizer"] + dxcam_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="mrt-ws-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    # The packaged executable is also invoked as a short-lived gaze-mapping CLI.
    # Keep standard streams available; Electron starts it with windowsHide=true,
    # so this does not expose a console window to the user.
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
