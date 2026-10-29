import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  path.join(repositoryRoot, 'services', 'build', 'eye-tracking'),
  path.join(repositoryRoot, 'services', 'build', 'facial-analysis'),
  path.join(repositoryRoot, 'services', 'build', 'pupil-core'),
  path.join(repositoryRoot, 'services', 'dist', 'mrt-ws-server.exe'),
  path.join(repositoryRoot, 'services', 'dist', 'facial-ws-server.exe'),
  path.join(repositoryRoot, 'services', 'dist', 'mrt-pupil-server.exe'),
  path.join(repositoryRoot, 'services', 'dist', 'pupil-backend'),
  path.join(repositoryRoot, 'services', 'dist', 'pupil-third-party'),
  path.join(repositoryRoot, 'services', 'dist', 'ffprobe.exe'),
];

for (const target of targets) {
  fs.rmSync(target, { recursive: true, force: true });
}

console.log('Removed stale Python service build artifacts.');
