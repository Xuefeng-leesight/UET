"""Build on the destination OS; FFmpeg/ffprobe are explicit external assets."""
from pathlib import Path

spec_root = Path(SPECPATH).resolve()
repo_root = spec_root.parents[2]
a = Analysis(
    [str(spec_root.parent / "entrypoints" / "huahong_server.py")],
    pathex=[str(repo_root)],
    binaries=[], datas=[],
    hiddenimports=["numpy", "cv2", "mss", "msgpack", "PIL.Image", "PIL.JpegImagePlugin", "websockets.asyncio.server", "services.eye_tracking.analysis.gaze_mapper"],
    excludes=["tests", "services.eye_tracking.adapters.invensun_7.sdk_driver", "services.eye_tracking.application.sdk_service"],
    noarchive=False,
)
pyz = PYZ(a.pure)
# Directory build: a onefile build leaks its %TEMP%\_MEI folder when killed.
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="mrt-huahong-server",
          console=True, debug=False, strip=False, upx=False)
bundle = COLLECT(exe, a.binaries, a.datas, name="mrt-huahong-server", strip=False, upx=False)
