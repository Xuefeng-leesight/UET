// Build with an independently prepared Pupil environment; never pip-install into
// the legacy vendor environment. Run this on the target operating system.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const python = process.env.MRT_PUPIL_PYTHON_BIN || path.join(root,
  'services/eye_tracking/adapters/pupil_native/.venv', windows ? 'Scripts/python.exe' : 'bin/python');
// Resolve the bundled Windows tool from the project root, independent of cwd.
const probe = process.env.MRT_FFPROBE_PATH
  || (windows ? path.join(root, 'SDK/Tool/ffmpeg/bin/ffprobe.exe') : undefined);
if (!fs.existsSync(python)) throw new Error('Prepare the isolated Pupil .venv or set MRT_PUPIL_PYTHON_BIN; see adapters/pupil_native/README.md');
if (!probe || !path.isAbsolute(probe) || !fs.existsSync(probe) || !fs.statSync(probe).isFile()) {
  throw new Error(`ffprobe not found at ${probe || '(unset)'}. On Windows, place ffprobe.exe in SDK/Tool/ffmpeg/bin, or set MRT_FFPROBE_PATH to the absolute path of the target-platform ffprobe executable.`);
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, PYINSTALLER_CONFIG_DIR: path.join(root, 'services/build/pupil-pyinstaller-cache') } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}
run(probe, ['-version']);
run(python, ['-c', 'import zmq, msgpack, PIL.Image, websockets.asyncio.server, PyInstaller, uvc, pupil_detectors, pye3d, scipy']);
run(python, ['scripts/collect-pupil-notices.py']);
run(python, ['-m', 'PyInstaller', '--clean', '--noconfirm', '--distpath', 'services/dist',
  '--workpath', 'services/build/pupil-core', 'services/eye_tracking/packaging/mrt-pupil-server.spec']);
if (process.platform === 'darwin') {
  const bundleRoot = path.join(root, 'services/dist/pupil-backend');
  if (fs.existsSync(bundleRoot) && (fs.lstatSync(bundleRoot).isSymbolicLink() || !fs.statSync(bundleRoot).isDirectory())) {
    throw new Error('Refusing to replace redirected Pupil build directory');
  }
  fs.rmSync(bundleRoot, { recursive: true, force: true });
  fs.mkdirSync(bundleRoot);
  fs.renameSync(path.join(root, 'services/dist/PupilBackend.app'), path.join(bundleRoot, 'PupilBackend.app'));
}
const probeOutput = path.join(root, 'services/dist', windows ? 'ffprobe.exe' : 'ffprobe');
const probeTemporary = `${probeOutput}.${randomUUID()}.tmp`;
try {
  fs.copyFileSync(probe, probeTemporary, fs.constants.COPYFILE_EXCL);
  // Homebrew assets are often 0555; copying their mode made the second build
  // fail with EACCES. Only change our validated generated destination.
  fs.chmodSync(probeTemporary, 0o755);
  let previous;
  try { previous = fs.lstatSync(probeOutput); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) {
    if (!previous.isFile() || previous.isSymbolicLink()) throw new Error('Refusing to replace a redirected ffprobe build asset');
    fs.chmodSync(probeOutput, 0o755);
  }
  fs.renameSync(probeTemporary, probeOutput);
} finally {
  if (fs.existsSync(probeTemporary)) fs.unlinkSync(probeTemporary);
}
// Bind validation evidence to the complete deliverable, including bundle links.
const backendRoot = path.join(root, 'services/dist/pupil-backend');
const archivePath = path.join(backendRoot, process.platform === 'darwin'
  ? 'PupilBackend.app/Contents/Resources/mrt-pupil-server.pkg' : 'mrt-pupil-server.pkg');
if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile() || fs.statSync(archivePath).size === 0) {
  throw new Error('The standalone Pupil code archive is missing; do not distribute an incomplete backend.');
}
const inventory = [];
function collectChecksums(directory) {
  for (const name of fs.readdirSync(directory).sort()) {
    const filename = path.join(directory, name);
    const stat = fs.lstatSync(filename);
    const relative = path.relative(backendRoot, filename).split(path.sep).join('/');
    if (stat.isSymbolicLink()) inventory.push({ path: relative, symlink: fs.readlinkSync(filename) });
    else if (stat.isDirectory()) collectChecksums(filename);
    else if (stat.isFile()) inventory.push({ path: relative, size: stat.size,
      sha256: createHash('sha256').update(fs.readFileSync(filename)).digest('hex') });
  }
}
collectChecksums(backendRoot);
fs.writeFileSync(path.join(root, 'services/dist/pupil-third-party/pupil-backend-sha256.json'),
  JSON.stringify(inventory, null, 2) + '\n');
