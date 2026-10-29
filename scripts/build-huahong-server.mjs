// Build with an independently prepared Huahong environment; never pip-install into
// the legacy vendor environment. Run this on the target operating system.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const python = process.env.MRT_HUAHONG_PYTHON_BIN || path.join(root,
  'services/eye_tracking/adapters/huahong/.venv', windows ? 'Scripts/python.exe' : 'bin/python');
// Resolve the bundled Windows tool from the project root, independent of cwd.
const probe = process.env.MRT_FFPROBE_PATH
  || (windows ? path.join(root, 'SDK/Tool/ffmpeg/bin/ffprobe.exe') : undefined);
if (!fs.existsSync(python)) throw new Error('Prepare the isolated Huahong .venv or set MRT_HUAHONG_PYTHON_BIN; see adapters/huahong/README.md');
if (!probe || !path.isAbsolute(probe) || !fs.existsSync(probe) || !fs.statSync(probe).isFile()) {
  throw new Error(`ffprobe not found at ${probe || '(unset)'}. On Windows, place ffprobe.exe in SDK/Tool/ffmpeg/bin, or set MRT_FFPROBE_PATH to the absolute path of the target-platform ffprobe executable.`);
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}
run(probe, ['-version']);
run(python, ['-c', 'import numpy, cv2, mss, msgpack, PIL.Image, websockets.asyncio.server, PyInstaller; cv2.SIFT_create()']);
run(python, ['-m', 'PyInstaller', '--clean', '--noconfirm', '--distpath', 'services/dist',
  '--workpath', 'services/build/huahong', 'services/eye_tracking/packaging/mrt-huahong-server.spec']);
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
