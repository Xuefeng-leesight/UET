import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const base = path.resolve('SDK/huahong');
const manifest = JSON.parse(fs.readFileSync(path.join(base, 'INTEGRATION_MANIFEST.json'), 'utf8'));
for (const directory of Object.values(manifest.models)) {
  if (!/^et(?:10|28)\/bin\/windows\/x64$/.test(directory)) throw new Error(`Unexpected Huahong runtime layout: ${directory}`);
  const expected = manifest.runtime.filter(item => path.posix.dirname(item.path) === directory).map(item => path.posix.basename(item.path)).sort();
  const actual = fs.readdirSync(path.join(base, directory)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Huahong runtime contents differ from manifest: ${directory}`);
}
for (const reference of manifest.reference_only) {
  if (!fs.existsSync(path.join(base, reference))) throw new Error(`Missing Huahong reference: ${reference}`);
}
for (const item of manifest.runtime) {
  const filename = path.join(base, item.path);
  if (!fs.existsSync(filename)) throw new Error(`Missing Huahong runtime: ${item.path}`);
  const data = fs.readFileSync(filename);
  const digest = crypto.createHash('sha256').update(data).digest('hex');
  if (digest !== item.sha256 || data.length !== item.bytes) throw new Error(`Huahong runtime checksum mismatch: ${item.path}`);
}
console.log(`Huahong runtime validation passed (${manifest.runtime.length} files); native/device behavior requires Windows hardware.`);
