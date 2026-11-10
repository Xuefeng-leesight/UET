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
    hookspath=[], hooksconfig={}, runtime_hooks=[],
    # The service only uses mediapipe, OpenCV, numpy and websockets. These are
    # installed in the build Python for other tools and would otherwise be pulled
    # in through mediapipe's optional imports (about 550 MB).
    excludes=[
        "torch", "torchvision", "torchaudio",
        "transformers", "tokenizers", "safetensors", "huggingface_hub", "hf_xet",
        "faiss", "pyarrow", "sklearn", "tiktoken",
        "tensorflow", "jax", "jaxlib",
    ],
    noarchive=False,
)
pyz = PYZ(a.pure)
# Directory build, like mrt-ws-server: a onefile build re-extracts into %TEMP%
# on every launch and leaks the _MEI folder whenever the service is killed.
exe = EXE(
    pyz, a.scripts, [], exclude_binaries=True,
    name="facial-ws-server", debug=False, bootloader_ignore_signals=False,
    strip=False, upx=False,
    console=True, disable_windowed_traceback=False, argv_emulation=False,
    target_arch=None, codesign_identity=None, entitlements_file=None,
)
bundle = COLLECT(exe, a.binaries, a.datas, name="facial-ws-server", strip=False, upx=False)
