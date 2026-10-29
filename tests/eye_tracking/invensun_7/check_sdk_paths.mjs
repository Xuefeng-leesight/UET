import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('electron/platform/sdk/sdkRuntime.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, { exports, process, require: name => {
  if (name === 'node:fs') return fs;
  if (name === 'node:path') return path;
  throw new Error(name);
} });
const layouts = {
  Pro: ['bin/windows/x64/Pro200_Release', 'samples/Pro200/python3', 'config.ini', '_7i_types.py'],
  A8: ['bin/windows/x64/A8_Release', 'samples/A8/python3', 'config.ini', '_7i_types.py'],
  aSeeGlassesPlus: ['bin', 'samples/python3', 'config/config.ini', 'sdk_types.py'],
};
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mrt-sdk-paths-'));
function create(base) {
  for (const [model, [runtime, types, config, typeFile]] of Object.entries(layouts)) {
    const runtimePath = path.join(base, model, runtime);
    fs.mkdirSync(path.dirname(path.join(runtimePath, config)), { recursive: true });
    fs.mkdirSync(path.join(base, model, types), { recursive: true });
    fs.writeFileSync(path.join(runtimePath, 'aSeeX.dll'), 'fixture');
    fs.writeFileSync(path.join(runtimePath, config), '[softdog]\npwd=fixture');
    fs.writeFileSync(path.join(base, model, types, typeFile), '# fixture');
  }
}
function check(context, base) {
  assert.equal(exports.getSdkContainerPath(context), base);
  for (const [model, [runtime, types]] of Object.entries(layouts)) {
    const resolved = exports.resolveSdkPaths(context, model, {});
    assert.equal(resolved.model, model);
    assert.equal(resolved.source, 'model-dir');
    assert.equal(resolved.sdkRoot, path.join(base, model, runtime));
    assert.equal(resolved.typesDir, path.join(base, model, types));
    const override = exports.resolveSdkPaths(context, model, {
      MRT_SDK_MODEL: model, MRT_SDK_ROOT: resolved.sdkRoot, MRT_TYPES_DIR: resolved.typesDir,
    });
    assert.equal(override.source, 'env');
  }
}
try {
  const project = path.join(temporary, 'project');
  const resources = path.join(temporary, '安装 资源');
  create(path.join(project, 'SDK/invensun_7'));
  create(path.join(resources, 'SDK/invensun_7'));
  check({ isPackaged: false, appDir: path.join(project, 'dist-electron'), resourcesPath: '' }, path.join(project, 'SDK/invensun_7'));
  check({ isPackaged: true, appDir: '', resourcesPath: resources }, path.join(resources, 'SDK/invensun_7'));
  const legacy = path.join(temporary, 'legacy');
  create(path.join(legacy, 'SDK'));
  const legacyContext = { isPackaged: false, appDir: path.join(legacy, 'dist-electron'), resourcesPath: '' };
  assert.equal(exports.getSdkContainerPath(legacyContext), path.join(legacy, 'SDK/invensun_7'));
  for (const model of Object.keys(layouts)) {
    const resolved = exports.resolveSdkPaths(legacyContext, model, {});
    assert.equal(resolved.source, 'fallback', 'Flat layout must not bypass vendor namespace');
    assert.ok(resolved.sdkRoot.startsWith(path.join(legacy, 'SDK/invensun_7')));
  }
  // A sibling vendor cannot be selected as an invensun device.
  create(path.join(project, 'SDK/huahong'));
  check({ isPackaged: false, appDir: path.join(project, 'dist-electron'), resourcesPath: '' }, path.join(project, 'SDK/invensun_7'));
  if (fs.existsSync('SDK/invensun_7')) {
    check({ isPackaged: false, appDir: path.resolve('dist-electron'), resourcesPath: '' }, path.resolve('SDK/invensun_7'));
  }
  const config = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.ok(config.build.extraResources.some(item => item.from === 'SDK' && item.to === 'SDK'), 'Packaging must retain SDK/vendor/model structure');
  console.log('All three SDK models resolved in standard vendor and packaged layouts; flat layout rejected.');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
