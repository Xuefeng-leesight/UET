// Safe housekeeping, separate from the release build's destructive prebuild step.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const obsolete = [
  ['services/build/pupil-app-experiment', 'obsolete application packaging experiment'],
  ['services/build/pupil-app-output', 'obsolete application packaging output'],
  ['services/dist/mrt-pupil-server', 'superseded single-file Pupil executable'],
  ['services/dist/mrt-pupil-server.exe', 'superseded single-file Pupil executable'],
  ['services/build/pupil-sources/opencv_python_headless-4.12.0.88-cp37-abi3-macosx_13_0_arm64.whl', 'unused experimental wheel'],
  ['services/build/pupil-sources/opencv_python_headless-4.13.0.92-cp37-abi3-macosx_13_0_arm64.whl', 'unused experimental wheel'],
];
const buildCaches = [
  'services/build/eye-tracking',
  'services/build/facial-analysis',
  'services/build/huahong',
  'services/build/pupil-core',
  'services/build/pupil-pyinstaller-cache',
];

function safeStat(root, relative) {
  const target = path.resolve(root, relative);
  const services = path.resolve(root, 'services');
  if (!target.startsWith(services + path.sep)) throw new Error(`Outside services: ${relative}`);
  let current = root;
  let stat;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Redirected path: ${relative}`);
  }
  return stat;
}

function sizeOf(filename) {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  return fs.readdirSync(filename).reduce((sum, name) => sum + sizeOf(path.join(filename, name)), 0);
}

export function planCleanup(root, { includeBuildCache = false, trackedFiles = [] } = {}) {
  const candidates = [...obsolete];
  if (includeBuildCache) candidates.push(...buildCaches.map((name) => [name, 'rebuildable PyInstaller cache']));
  const skipped = [];
  const sourceRoot = path.join(root, 'services');
  function scan(relative) {
    const directory = path.join(root, relative);
    // The launcher accepts both .venv and venv; renamed Python environments
    // also carry this marker and must remain outside housekeeping.
    if (fs.existsSync(path.join(directory, 'pyvenv.cfg'))) return;
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
      const child = `${relative}/${item.name}`;
      if (['.venv', 'venv'].includes(item.name) || child === 'services/build' || child === 'services/dist') continue;
      if (item.isDirectory() && item.name === '__pycache__') candidates.push([child, 'Python bytecode cache']);
      else if (item.isDirectory()) scan(child);
      else if (item.isFile() && (item.name.endsWith('.pyc') || item.name === '.DS_Store')) {
        candidates.push([child, 'generated source-directory cache']);
      }
    }
  }
  if (fs.existsSync(sourceRoot) && !fs.lstatSync(sourceRoot).isSymbolicLink()) scan('services');
  const entries = [];
  for (const [relative, reason] of candidates) {
    if (trackedFiles.some((name) => name === relative || name.startsWith(`${relative}/`))) {
      skipped.push(`${relative}: contains Git-tracked files`);
      continue;
    }
    try {
      if (safeStat(root, relative)) entries.push({ relative, reason, bytes: sizeOf(path.join(root, relative)) });
    } catch (error) { skipped.push(error.message); }
  }
  return { entries, skipped };
}

export function applyCleanup(root, plan, trackedFiles = []) {
  // Validate the entire plan again before removing anything; never follow redirects.
  for (const { relative } of plan.entries) {
    safeStat(root, relative);
    if (trackedFiles.some((name) => name === relative || name.startsWith(`${relative}/`))) {
      throw new Error(`Refusing tracked path: ${relative}`);
    }
  }
  for (const { relative } of plan.entries) fs.rmSync(path.join(root, relative), { recursive: true, force: true });
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help')) {
    console.log('node scripts/clean-service-artifacts.mjs [--apply] [--build-cache]\nDefault: preview only. --apply removes the listed artifacts. --build-cache includes rebuildable build caches.\nRun while service builds are idle. Environments, current bundles, licenses, source archives and validation logs are preserved.');
    return;
  }
  if ([...args].some((arg) => !['--apply', '--build-cache'].includes(arg))) throw new Error('Unknown option; use --help');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const trackedFiles = execFileSync('git', ['ls-files', '-z', '--', 'services'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const plan = planCleanup(root, { includeBuildCache: args.has('--build-cache'), trackedFiles });
  for (const entry of plan.entries) console.log(`${(entry.bytes / 1024 ** 2).toFixed(2)} MiB\t${entry.relative}\t${entry.reason}`);
  for (const message of plan.skipped) console.warn(`Skipped: ${message}`);
  if (args.has('--apply')) applyCleanup(root, plan, trackedFiles);
  const bytes = plan.entries.reduce((sum, entry) => sum + entry.bytes, 0);
  console.log(`${args.has('--apply') ? 'Removed' : 'Preview'}: ${plan.entries.length} paths, ${(bytes / 1024 ** 2).toFixed(2)} MiB.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
