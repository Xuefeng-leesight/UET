import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const oldPath = (name) => name.replace('et10/bin/windows/x64/', 'et10/dll/')
  .replace('et28/bin/windows/x64/', 'et28/release/bin/');
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Explicit, repeatable migration of locally supplied SDKs. Never overwrite a different file. */
export function migrateHuahongSdk(base) {
  base = path.resolve(base);
  if (fs.lstatSync(base).isSymbolicLink()) throw new Error("SDK root cannot be a symlink");
  const manifest = JSON.parse(fs.readFileSync(path.join(base, 'INTEGRATION_MANIFEST.json'), 'utf8'));
  if (manifest.version !== 2) throw new Error('Expected Huahong manifest version 2');
  const moves = [];
  const inside = (name) => {
    const filename = path.resolve(base, name);
    if (!filename.startsWith(base + path.sep)) throw new Error(`Unsafe SDK path: ${name}`);
    // Refuse symlinks in any existing parent, not just the final file.
    for (let current = filename; current !== base; current = path.dirname(current)) {
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`SDK symlink: ${name}`);
    }
    return filename;
  };
  for (const item of manifest.runtime) {
    const target = inside(item.path);
    const source = inside(oldPath(item.path));
    for (const filename of new Set([target, source])) {
      if (!fs.existsSync(filename)) continue;
      const data = fs.readFileSync(filename);
      if (data.length !== item.bytes || digest(data) !== item.sha256) throw new Error(`SDK checksum mismatch: ${filename}`);
    }
    if (!fs.existsSync(target)) {
      if (!fs.existsSync(source)) throw new Error(`Missing SDK runtime: ${item.path}`);
      moves.push([source, target]);
    }
  }
  for (const model of ['et10', 'et28']) {
    const sourceDirectory = inside(model === 'et10' ? 'et10' : 'et28/release');
    if (!fs.existsSync(sourceDirectory)) continue;
    for (const name of fs.readdirSync(sourceDirectory)) {
      if (['bin', 'dll', 'samples', '__pycache__', '.DS_Store', 'hhlog.txt', 'cablic.dat', 'selfcheck_report.txt'].includes(name)) continue;
      const source = inside(path.relative(base, path.join(sourceDirectory, name)));
      const target = inside(`${model}/samples/${name}`);
      if (fs.existsSync(target)) throw new Error(`SDK sample conflict; keep both copies and resolve manually: ${target}`);
      moves.push([source, target]);
    }
  }
  for (const reference of manifest.reference_only) {
    const target = inside(reference);
    if (!fs.existsSync(target) && !moves.some(([, destination]) => target === destination || target.startsWith(destination + path.sep))) {
      throw new Error(`Missing SDK reference: ${reference}`);
    }
  }
  // Validate the full plan before changing anything; repeated calls on the new layout do nothing.
  for (const [source, target] of moves) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(source, target);
  }
  return moves.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = migrateHuahongSdk(path.resolve('SDK/huahong'));
  console.log(`Huahong SDK migration complete (${count} moves). Run npm run check:huahong-sdk.`);
}
