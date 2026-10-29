from pathlib import Path
from PyInstaller.utils.hooks import collect_all

spec_root = Path(globals().get("SPECPATH", Path.cwd())).resolve()
server_root = spec_root.parent
mediapipe_datas, mediapipe_binaries, mediapipe_hiddenimports = collect_all("mediapipe")

a = Analysis(
    [str(server_root / "server.py")],
    pathex=[str(server_root)],
    binaries=mediapipe_binaries,
    datas=[
        (str(server_root / "application" / "face_landmarker_v2_with_blendshapes.task"), "application"),
    ] + mediapipe_datas,
    hiddenimports=["numpy", "cv2", "websockets", "mediapipe", "application.service", "application.frame_inference", "application.process_output", "transport.protocol"] + mediapipe_hiddenimports,
    hookspath=[], hooksconfig={}, runtime_hooks=[], excludes=[], noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, a.binaries, a.datas, [],
    name="facial-ws-server", debug=False, bootloader_ignore_signals=False,
    strip=False, upx=False, upx_exclude=[], runtime_tmpdir=None,
    console=True, disable_windowed_traceback=False, argv_emulation=False,
    target_arch=None, codesign_identity=None, entitlements_file=None,
)
