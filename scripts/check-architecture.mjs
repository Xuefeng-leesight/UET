import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs']);
const ignored = new Set(['node_modules', 'dist', 'dist-electron', 'release', '.git']);
const violations = [];
const forbiddenRendererRoots = ['src/components/', 'src/services/', 'src/legacy/'];

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(fullPath));
    else if (sourceExtensions.has(path.extname(entry.name))) files.push(fullPath);
  }
  return files;
}

function importsOf(source) {
  const matches = source.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g);
  return [...matches].map((match) => match[1]);
}

for (const file of walk(root)) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  const imports = importsOf(fs.readFileSync(file, 'utf8'));

  if (relative.startsWith('electron/')) {
    for (const specifier of imports) {
      if (specifier.startsWith('@/') || /(?:^|\/)src\//.test(specifier)) {
        violations.push(`${relative}: Electron must not import renderer source: ${specifier}`);
      }
    }
  }

  // Platform layer must not depend on domain layer (no reverse dependency).
  // Domains may use platform utilities, but platform code must stay generic.
  if (relative.startsWith('electron/platform/')) {
    for (const specifier of imports) {
      if (specifier.includes('domains/')) {
        violations.push(`${relative}: platform layer must not depend on domains: ${specifier}`);
      }
    }
  }

  if (relative.startsWith('shared/')) {
    for (const specifier of imports) {
      if (specifier === 'react' || specifier === 'electron' || specifier.startsWith('@/') || /(?:^|\/)(src|electron)\//.test(specifier)) {
        violations.push(`${relative}: shared contract must be runtime independent: ${specifier}`);
      }
    }
  }

  if (forbiddenRendererRoots.some((prefix) => relative.startsWith(prefix))) {
    violations.push(`${relative}: legacy renderer layout is not allowed`);
  }

  if (relative === 'electron/main.ts' && /ipcMain\.(?:handle|on)\s*\(/.test(fs.readFileSync(file, 'utf8'))) {
    violations.push(`${relative}: IPC handlers belong in electron/domains`);
  }

  if (relative.startsWith('src/features/')) {
    for (const specifier of imports) {
      if (specifier.includes('/pages/') || /Page(?:\.tsx)?$/.test(specifier)) {
        violations.push(`${relative}: features must not import another route page: ${specifier}`);
      }
    }
  }

  if (relative.startsWith('src/') && !relative.startsWith('src/infrastructure/')) {
    const source = fs.readFileSync(file, 'utf8');
    if (source.includes('window.ipcRenderer')) {
      violations.push(`${relative}: renderer code must use the infrastructure IPC facade`);
    }
  }
}

const sdkServer = path.join(root, 'SDK', 'server');
if (fs.existsSync(sdkServer)) {
  const applicationSources = fs.readdirSync(sdkServer, { recursive: true }).filter((entry) =>
    /\.(?:py|ts|tsx|js|mjs)$/.test(String(entry)),
  );
  for (const source of applicationSources) {
    violations.push(`SDK/server/${source}: application source belongs in services`);
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}

console.log('Architecture dependency checks passed.');
