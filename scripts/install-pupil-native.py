"""Prepare the dedicated environment with a hash-pinned, relicensed pye3d source.

Run using the native .venv Python. Needs a C++ compiler and Eigen3 CMake package.
The unchanged upstream source archive is retained for corresponding-source delivery.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request

root = Path(__file__).resolve().parents[1]
if sys.prefix == sys.base_prefix:
    raise SystemExit('Run this script using a dedicated virtual environment, not system/vendor Python')
dependencies = json.loads((root / 'services/eye_tracking/adapters/pupil_native/vendor/dependencies.json').read_text())
cache = root / 'services/build/pupil-sources'
cache.mkdir(parents=True, exist_ok=True)
for name, spec in dependencies.items():
    filename = spec['filename'] if 'filename' in spec else f"{name}-{spec['revision']}.tar.gz"
    archive = cache / filename
    if not archive.exists():
        request = urllib.request.Request(spec['url'], headers={'User-Agent': 'MRT-native-build'})
        with urllib.request.urlopen(request, timeout=60) as response:
            content = response.read(32 * 1024 * 1024)
        if hashlib.sha256(content).hexdigest() != spec['sha256']:
            raise SystemExit(f'{name} source hash mismatch')
        archive.write_bytes(content)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != spec['sha256']:
        raise SystemExit(f'Cached {name} source hash mismatch')
spec = dependencies['pye3d']
archive = cache / f"pye3d-{spec['revision']}.tar.gz"
subprocess.run([sys.executable, '-m', 'pip', 'install', '-r', str(root / 'services/eye_tracking/requirements/pupil-native.txt')], check=True)
env = {**os.environ, 'SETUPTOOLS_SCM_PRETEND_VERSION': spec['version']}
subprocess.run([sys.executable, '-m', 'pip', 'install', '--no-deps', str(archive)], check=True, env=env)
print('Installed pinned native algorithms; source retained at', archive)
