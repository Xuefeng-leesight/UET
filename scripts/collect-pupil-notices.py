"""Archive installed distribution notices plus corresponding MRT Python source."""
import importlib.metadata
import hashlib
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
import zipfile

root = Path(__file__).resolve().parents[1]
destination = root / 'services/dist/pupil-third-party'
(root / 'services/build').mkdir(parents=True, exist_ok=True)
output = Path(tempfile.mkdtemp(prefix='pupil-notices-', dir=root / 'services/build'))
inventory = []
for dist in importlib.metadata.distributions():
    name, version = dist.metadata['Name'], dist.version
    notices = []
    for item in dist.files or ():
        if any(key in item.name.lower() for key in ('license', 'copying', 'notice')):
            source = Path(dist.locate_file(item))
            if not source.is_file():
                continue
            relative = Path(name) / str(item).replace('..', '_parent_')
            target = output / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            notices.append(str(relative))
    inventory.append({'name': name, 'version': version, 'license': dist.metadata.get('License-Expression') or dist.metadata.get('License'),
                      'homePage': dist.metadata.get('Home-page'), 'projectUrls': dist.metadata.get_all('Project-URL', []),
                      'sourceDistributionIndex': f'https://pypi.org/pypi/{name}/{version}/json', 'notices': notices})
(output / 'installed-distributions.json').write_text(json.dumps(inventory, indent=2), encoding='utf-8')
(output / 'installed-versions.txt').write_text('\n'.join(sorted(f"{d['name']}=={d['version']}" for d in inventory)) + '\n', encoding='utf-8')
vendor = root / 'services/eye_tracking/adapters/pupil_native/vendor'
dependencies = json.loads((vendor / 'dependencies.json').read_text())
spec = dependencies['pye3d']
archive = root / 'services/build/pupil-sources' / f"pye3d-{spec['revision']}.tar.gz"
if importlib.metadata.version('pye3d') != spec['version'] or not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest() != spec['sha256']:
    raise SystemExit('Prepare the pinned LGPL pye3d environment with scripts/install-pupil-native.py before packaging')
for name, spec in dependencies.items():
    filename = spec['filename'] if 'filename' in spec else f"{name}-{spec['revision']}.tar.gz"
    source = root / 'services/build/pupil-sources' / filename
    if not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != spec['sha256']:
        raise SystemExit(f'Missing or altered {name} source archive; run scripts/install-pupil-native.py')
    shutil.copyfile(source, output / filename)
    # Some wheels omit their upstream notices. Preserve those from exact sources.
    with tarfile.open(source) as bundle:
        for entry in bundle.getmembers():
            if entry.isfile() and entry.size < 1024 * 1024 and any(key in Path(entry.name).name.lower() for key in ('license', 'copying', 'notice')):
                relative = Path(entry.name)
                if relative.is_absolute() or '..' in relative.parts:
                    raise SystemExit('Unsafe source archive path')
                target = output / 'source-notices' / name / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(bundle.extractfile(entry).read())
for name in ('NOTICE.md', 'COPYING', 'COPYING.LESSER', 'source-manifest.json', 'dependencies.json'):
    shutil.copyfile(vendor / name, output / name)
with zipfile.ZipFile(output / 'mrt-pupil-source.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for directory in ('services/eye_tracking', 'tests/eye_tracking', 'tools/pupil'):
        for source in (root / directory).rglob('*'):
            if not source.is_file() or any(p in ('.venv', '__pycache__') for p in source.parts):
                continue
            if source.suffix in ('.py', '.json', '.md', '.txt', '.spec', '.mjs') or source.name.startswith('COPYING'):
                archive.write(source, source.relative_to(root))
    for name in ('scripts/build-pupil-server.mjs', 'scripts/collect-pupil-notices.py', 'scripts/install-pupil-native.py',
                 'docs/方案/PupilCore原生后端方案.md'):
        archive.write(root / name, name)
    # Historical local validation notes are supplementary, not rebuild inputs.
    # Keep required source, build scripts and license checks strict above.
    for name in ('docs/debug/pupil-native-2026-10-13-validation.md',):
        source = root / name
        if source.is_file():
            archive.write(source, name)
        else:
            print(f'Optional validation note not included (missing): {name}')
if destination.is_symlink() or destination.exists() and not destination.is_dir():
    raise SystemExit('Refusing to replace redirected notices directory')
destination.parent.mkdir(parents=True, exist_ok=True)
if destination.exists():
    shutil.rmtree(destination)  # Generated output only: remove stale prior-version notices.
os.replace(output, destination)
print(f'Archived {len(inventory)} distribution notices and MRT Pupil source in {destination}')
