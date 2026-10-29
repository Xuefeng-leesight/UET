import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const servicesRoot = path.join(root, 'services');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mrt-pycompile-'));

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.venv' || entry.name === '__pycache__') return [];
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    return entry.isFile() && entry.name.endsWith('.py') ? [fullPath] : [];
  });
}

const python = process.env.MRT_PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const sources = walk(servicesRoot);
const failures = [];

try {
  for (const source of sources) {
    const relative = path.relative(servicesRoot, source);
    const output = path.join(tempRoot, `${relative.replaceAll(path.sep, '__')}c`);
    const result = spawnSync(python, ['-m', 'py_compile', source], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PYTHONPYCACHEPREFIX: tempRoot },
    });
    if (result.status !== 0) {
      failures.push(`${relative}: ${result.stderr || result.stdout || `exit ${result.status}`}`);
    }
    if (fs.existsSync(output)) fs.unlinkSync(output);
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`Python source compilation passed (${sources.length} files).`);
