import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const forbiddenTrackedNames = new Set(['.DS_Store']);
const forbiddenTrackedSegments = new Set([
  '__pycache__',
  '.venv',
  'node_modules',
  'dist',
  'dist-electron',
  'release',
]);
const forbiddenTrackedExtensions = ['.pyc', '.log'];
const requiredFiles = [
  'docs/架构/系统架构.md',
  'docs/维护/维护手册.md',
  'shared/contracts/ipc/channels.ts',
  'services/eye_tracking/entrypoints/server.py',
  'services/eye_tracking/entrypoints/pupil_server.py',
  'services/eye_tracking/entrypoints/huahong_server.py',
  'services/facial_analysis/server.py',
];

function gitLines(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
}

const violations = [];
const trackedFiles = gitLines(['ls-files']);

for (const relative of trackedFiles) {
  const segments = relative.split('/');
  const basename = segments.at(-1) ?? '';
  if (forbiddenTrackedNames.has(basename)) {
    violations.push(`${relative}: system metadata must not be tracked`);
  }
  if (segments.some((segment) => forbiddenTrackedSegments.has(segment))) {
    violations.push(`${relative}: generated/dependency directory must not be tracked`);
  }
  if (forbiddenTrackedExtensions.some((extension) => relative.endsWith(extension))) {
    violations.push(`${relative}: generated log/cache file must not be tracked`);
  }
}

for (const relative of requiredFiles) {
  if (!fs.existsSync(path.join(root, relative))) {
    violations.push(`${relative}: required delivery/architecture file is missing`);
  }
}

const sdkApplicationSources = trackedFiles.filter((relative) =>
  relative.startsWith('SDK/') && /\.(?:py|ts|tsx|js|mjs)$/.test(relative),
);
for (const relative of sdkApplicationSources) {
  violations.push(`${relative}: application source must not be tracked under vendor SDK`);
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}

console.log(`Repository hygiene checks passed (${trackedFiles.length} tracked files inspected).`);
