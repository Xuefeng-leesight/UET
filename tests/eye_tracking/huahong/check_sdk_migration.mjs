import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { migrateHuahongSdk } from '../../../scripts/migrate-huahong-sdk.mjs';

function fixture(run) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mrt-huahong-migration-'));
  const write = (name, data) => {
    const filename = path.join(base, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, data);
  };
  const runtime = [['et10', 'et10c_interface.dll'], ['et28', 'et28_interface.dll']].map(([model, dll]) => {
    const data = Buffer.from(model);
    write(`${model}/${model === 'et10' ? 'dll' : 'release/bin'}/${dll}`, data);
    return { path: `${model}/bin/windows/x64/${dll}`, bytes: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex') };
  });
  write('et10/examples/test.py', 'reference only');
  write('et28/release/selfcheck.py', 'reference only');
  write('INTEGRATION_MANIFEST.json', JSON.stringify({ version: 2, runtime,
    reference_only: ['et10/samples/examples', 'et28/samples/selfcheck.py'] }));
  try { run(base, write); } finally { fs.rmSync(base, { recursive: true, force: true }); }
}
fixture((base, write) => {
  write('et10/cablic.dat', 'keep field data');
  assert.equal(migrateHuahongSdk(base), 4);
  assert.equal(migrateHuahongSdk(base), 0);
  assert.equal(fs.readFileSync(path.join(base, 'et10/cablic.dat'), 'utf8'), 'keep field data');
  assert.equal(fs.readFileSync(path.join(base, 'et10/bin/windows/x64/et10c_interface.dll'), 'utf8'), 'et10');
  assert.equal(fs.existsSync(path.join(base, 'et28/samples/selfcheck.py')), true);
});
fixture((base, write) => {
  write('et28/release/bin/et28_interface.dll', 'broken');
  assert.throws(() => migrateHuahongSdk(base), /checksum/);
  assert.ok(fs.existsSync(path.join(base, 'et10/dll/et10c_interface.dll')), 'no partial migration on invalid DLL');
});
fixture((base, write) => {
  write('et10/samples/examples/test.py', 'different reference');
  assert.throws(() => migrateHuahongSdk(base), /conflict/);
  assert.ok(fs.existsSync(path.join(base, 'et10/dll/et10c_interface.dll')));
});
fixture((base) => {
  fs.unlinkSync(path.join(base, 'et28/release/bin/et28_interface.dll'));
  assert.throws(() => migrateHuahongSdk(base), /Missing SDK runtime/);
  assert.ok(fs.existsSync(path.join(base, 'et10/dll/et10c_interface.dll')));
});
console.log('SDK migration passed: hashes, conflict/missing preflight, sample references, field data and repeatability.');
