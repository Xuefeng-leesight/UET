import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planCleanup, applyCleanup } from '../../scripts/clean-service-artifacts.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrt-service-cleanup-'));
const write = (relative) => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'fixture');
  return file;
};
try {
  const remove = [
    'services/build/pupil-app-output/old.bin',
    'services/build/pupil-app-experiment/old.bin',
    'services/dist/mrt-pupil-server',
    'services/eye_tracking/entrypoints/__pycache__/server.pyc',
  ];
  const keep = [
    'services/eye_tracking/entrypoints/server.py',
    'services/eye_tracking/.venv/lib/__pycache__/dependency.pyc',
    'services/eye_tracking/venv/lib/__pycache__/dependency.pyc',
    'services/eye_tracking/alternate-env/pyvenv.cfg',
    'services/eye_tracking/alternate-env/lib/__pycache__/dependency.pyc',
    'services/eye_tracking/adapters/pupil_native/.venv/lib/dependency.py',
    'services/dist/pupil-backend/_internal/library.bin',
    'services/dist/pupil-third-party/source.tar.gz',
    'services/dist/ffprobe',
    'services/build/pupil-sources/pye3d-source.tar.gz',
    'services/build/pupil-validation/evidence.log',
    'services/build/pupil-core/intermediate.bin',
    'services/build/huahong/intermediate.bin',
  ];
  [...remove, ...keep].forEach(write);
  const plan = planCleanup(root);
  remove.forEach((name) => assert.ok(fs.existsSync(path.join(root, name)), 'planning must not delete'));
  applyCleanup(root, plan);
  remove.forEach((name) => assert.ok(!fs.existsSync(path.join(root, name)), name));
  keep.forEach((name) => assert.ok(fs.existsSync(path.join(root, name)), name));
  assert.equal(planCleanup(root).entries.length, 0, 'cleanup is idempotent');
  applyCleanup(root, planCleanup(root, { includeBuildCache: true }));
  assert.ok(!fs.existsSync(path.join(root, 'services/build/pupil-core')));
  assert.ok(!fs.existsSync(path.join(root, 'services/build/huahong')));

  const tracked = 'services/build/pupil-app-output/important.py';
  write(tracked);
  const protectedPlan = planCleanup(root, { trackedFiles: [tracked] });
  assert.ok(protectedPlan.skipped.some((text) => text.includes('Git-tracked')));
  assert.throws(() => applyCleanup(root, { entries: [{ relative: 'services/build/pupil-app-output' }] }, [tracked]), /tracked/);
  assert.ok(fs.existsSync(path.join(root, tracked)));
  assert.throws(() => applyCleanup(root, { entries: [{ relative: '../outside' }] }), /Outside services/);

  // Directory symlinks are never traversed; replacing a planned directory is rejected.
  const outside = path.join(root, 'keep-outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'preserve.txt'), 'preserve');
  fs.symlinkSync(outside, path.join(root, 'services/build/pupil-app-experiment'), 'junction');
  const redirected = planCleanup(root);
  assert.ok(redirected.skipped.some((text) => text.includes('Redirected path')));
  assert.throws(() => applyCleanup(root, { entries: [{ relative: 'services/build/pupil-app-experiment' }] }), /Redirected/);
  assert.equal(fs.readFileSync(path.join(outside, 'preserve.txt'), 'utf8'), 'preserve');
  console.log('Service cleanup checks passed: preview, preservation, cache opt-in, tracked files, symlinks and idempotence.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
