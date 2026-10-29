import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { EventEmitter } from 'node:events';

// Exercise the production resolver with virtual installations on each target
// platform. Neither the recording brand nor acquisition configuration may
// influence an offline command, even if those configurations are invalid.
const files = new Set();
const probes = [];
const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('electron/platform/python/analysisLaunch.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, { exports, require: name => {
  if (name === 'node:fs') return { statSync(file) {
    probes.push(file);
    if (!files.has(file)) throw new Error('ENOENT');
    return { isFile: () => true };
  } };
  if (name === 'node:path') return path;
  throw new Error(name);
}});
const { buildGazeMappingCommand: build } = exports;
const repo = path.resolve('/repo');
const appDir = path.join(repo, 'dist-electron');
const resourcesPath = path.resolve('/installed/resources');
const job = path.join(repo, '实验数据', 'mapping job.json');
const mapper = path.join(repo, 'services/eye_tracking/analysis/gaze_mapper.py');
const models = ['Pro', 'A8', 'aSeeGlassesPlus', 'PupilCore', 'HH_ET10C', 'HH_ET28', 'future-device'];
for (const platform of ['win32', 'darwin', 'linux']) {
  for (const model of models) {
    files.clear();
    files.add(mapper);
    probes.length = 0;
    const env = { MRT_SDK_MODEL: model, MRT_SDK_PATH: '/missing/device.dll',
      MRT_TYPES_PATH: '/missing/types', MRT_PUPIL_WORLD_UID: 'invalid-camera',
      MRT_PUPIL_EXECUTABLE: '/wrong-device-exe', MRT_PUPIL_BACKEND: 'invalid',
      MRT_HUAHONG_PROJECT_ROOT: '/missing', ET28_DLL_DIR: '/missing', ET10C_DLL_DIR: '/missing',
      MRT_WS_PORT: 'bad-port', MRT_SOFTDOG_PASSWORD: 'test-only', PATH: '/runtime/bin', KEEP_ME: 'ok' };
    const options = { appDir, resourcesPath, platform, env, packaged: false };
    const command = build(options, job);
    assert.equal(command.command, platform === 'win32' ? 'py' : 'python3');
    assert.deepEqual(Array.from(command.args), [...(platform === 'win32' ? ['-3'] : []),
      '-m', 'services.eye_tracking.analysis.gaze_mapper', '--job', job]);
    assert.equal(command.cwd, repo);
    assert.deepEqual(Object.keys(command.env).sort(), ['KEEP_ME', 'PATH', 'PYTHONIOENCODING', 'PYTHONUTF8']);
    assert.equal(env.MRT_SDK_MODEL, model, 'Must not mutate the parent process configuration');
    assert.equal(command.env.KEEP_ME, 'ok');
    assert.equal(command.env.PYTHONIOENCODING, 'utf-8');
    assert.ok(!probes.some(file => file.includes('device.dll') || file.includes('ffprobe')));

    const interpreter = path.join(repo, 'services/eye_tracking/adapters/pupil_native/.venv',
      platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    files.add(interpreter);
    assert.equal(build(options, job).command, interpreter, 'Reuse installed Python, independent of SDK model');
    assert.equal(build({ ...options, env: { ...env, MRT_PYTHON_BIN: 'custom python' } }, job).command, 'custom python');
    assert.equal(build({ ...options, env: { ...env, MRT_ANALYSIS_PYTHON_BIN: 'analysis python', MRT_PYTHON_BIN: 'other' } }, job).command, 'analysis python');

    const suffix = platform === 'win32' ? '.exe' : '';
    const candidates = [
      path.join(resourcesPath, 'py', `mrt-ws-server${suffix}`),
      path.join(resourcesPath, 'py', `mrt-huahong-server${suffix}`),
      path.join(resourcesPath, 'py', 'pupil-backend', platform === 'darwin'
        ? 'PupilBackend.app/Contents/MacOS/mrt-pupil-server' : `mrt-pupil-server${suffix}`),
    ];
    files.clear();
    assert.equal(build({ ...options, packaged: true }, job), null);
    for (const executable of candidates) {
      files.clear();
      files.add(executable);
      const packaged = build({ ...options, packaged: true }, job);
      assert.equal(packaged.command, executable);
      assert.deepEqual(Array.from(packaged.args), ['--gaze-map-job', job]);
      assert.equal(packaged.cwd, path.dirname(executable));
      assert.equal(packaged.env.MRT_SDK_MODEL, undefined);
    }
    files.clear();
    assert.equal(build(options, job), null, 'Missing analysis installation stays a real error');
  }
}

// The main-process binding must use this resolver, not derive a command from
// the active device. Execute the actual dependency object without booting Electron.
const mainAst = ts.createSourceFile('main.ts', fs.readFileSync('electron/main.ts', 'utf8'), ts.ScriptTarget.Latest, true);
let mappingDependencies;
function findMappingBinding(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(mainAst) === 'gazeMappingDomain') {
    mappingDependencies = node.initializer.arguments[0];
  }
  ts.forEachChild(node, findMappingBinding);
}
findMappingBinding(mainAst);
assert.ok(mappingDependencies);
files.clear();
files.add(mapper);
const bindings = vm.runInNewContext(ts.transpileModule(`(${mappingDependencies.getText(mainAst)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, {
  __dirname: appDir, process: { resourcesPath, platform: 'darwin', env: { MRT_SDK_MODEL: 'HH_ET28' } },
  app: { isPackaged: false }, buildGazeMappingCommand: build,
  buildLocalResourceUrl() {}, mainWindow: { getMainWindow() {} }, logMainVideoDebug() {},
  isLicenseModuleAllowed: () => true,
  getPyServerCommand: () => { throw new Error('Offline mapping must not inspect active SDK'); },
});
assert.equal(bindings.getMappingCommand(job).args.at(-1), job);
assert.equal(bindings.getMappingCommand(job).command, 'python3');

// Exercise the actual process result handling: dependencies missing, structured
// errors, launch errors and timeout must not be reported as successful mapping.
const domainAst = ts.createSourceFile('mapping.ts', fs.readFileSync('electron/domains/mapping/gazeMappingHandlers.ts', 'utf8'), ts.ScriptTarget.Latest, true);
let processFunction;
function findProcess(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'runGazeMappingProcess') processFunction = node;
  ts.forEachChild(node, findProcess);
}
findProcess(domainAst);
assert.ok(processFunction);
for (const kind of ['success', 'cv2', 'numpy', 'structured', 'error', 'timeout', 'missing']) {
  let cleared = false;
  let killed = false;
  let timeoutCallback;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { killed = true; };
  const command = { command: 'python3', args: ['-m', 'services.eye_tracking.analysis.gaze_mapper', '--job', job], cwd: repo, env: {} };
  const run = vm.runInNewContext(ts.transpileModule(`(${processFunction.getText(domainAst)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    app: { isPackaged: false }, fs, Buffer,
    getMappingCommand: received => { assert.equal(received, job); return kind === 'missing' ? null : command; },
    logVideoDebug() {},
    setTimeout: fn => { timeoutCallback = fn; return 'timer'; },
    clearTimeout: id => { assert.equal(id, 'timer'); cleared = true; },
    spawn(executable, args, options) {
      assert.equal(executable, command.command);
      assert.deepEqual(args, command.args);
      assert.equal(options.cwd, repo);
      assert.equal(options.windowsHide, true);
      queueMicrotask(() => {
        if (kind === 'success') {
          child.stdout.emit('data', Buffer.from('{"ok":true}'));
          child.emit('close', 0);
        } else if (kind === 'error') {
          child.emit('error', new Error('ENOENT interpreter'));
          child.emit('close', 1);
        } else if (kind === 'timeout') {
          timeoutCallback();
          child.emit('close', 0); // A late exit cannot turn failure into success.
        } else {
          const text = kind === 'structured' ? '{"ok":false,"message":"参考图没有可匹配特征"}'
            : `ModuleNotFoundError: No module named '${kind}'`;
          child.stderr.emit('data', Buffer.from(text));
          child.emit('close', 1);
        }
      });
      return child;
    },
  });
  const result = await run(job);
  assert.equal(result.ok, kind === 'success');
  if (kind === 'cv2' || kind === 'numpy') assert.match(result.message, /缺少 OpenCV 或 NumPy/);
  if (kind === 'structured') assert.equal(result.message, '参考图没有可匹配特征');
  if (kind === 'error') assert.equal(result.message, 'ENOENT interpreter');
  if (kind === 'timeout') { assert.ok(killed); assert.match(result.message, /超时/); }
  if (kind === 'missing') assert.match(result.message, /未找到 Python/);
  else assert.ok(cleared);
}

// Facial launch inherits only interpreter flags, never the eye-tracking module
// or acquisition arguments. It must preserve py -3 after the entrypoint move.
const facialSource = ts.createSourceFile('facialHandlers.ts',
  fs.readFileSync('electron/domains/facial/facialHandlers.ts', 'utf8'), ts.ScriptTarget.Latest, true);
let facialCommandSource;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'getFacialServerCommand') {
    facialCommandSource = node.getText(facialSource);
  }
  ts.forEachChild(node, visit);
}
visit(facialSource);
assert.ok(facialCommandSource);
let eyeArgs = [];
const facialScript = '/repo/services/facial_analysis/server.py';
const facialCommand = vm.runInNewContext(ts.transpileModule(`(${facialCommandSource});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, {
  dependencies: { getPyServerCommand: () => ({ command: 'py', args: eyeArgs, env: {} }), scriptPath: facialScript },
  app: { isPackaged: false, getPath: () => '/temp' }, fs: { existsSync: () => true }, path, process: { pid: 123 },
  FACIAL_RUNTIME_INFO_FILE: 'uet-sa-facial-runtime.json', FACIAL_WS_PORTS: { image: 9011, data: 9012, cmd: 9013 },
});
for (const entry of [
  ['/repo/services/eye_tracking/entrypoints/server.py'], ['C:\\repo\\services\\eye_tracking\\entrypoints\\server.py'],
  ['/repo/services/eye_tracking/server.py'],
  ['-m', 'services.eye_tracking.entrypoints.pupil_server'], ['-m', 'services.eye_tracking.entrypoints.huahong_server'],
  ['-m', 'services.eye_tracking.pupil_server'], ['-m', 'services.eye_tracking.huahong_server'],
]) {
  for (const prefix of [[], ['-3'], ['-3', '-X', 'utf8']]) {
    eyeArgs = [...prefix, ...entry, '--control-stdin', '--eye-port', '9002'];
    const command = facialCommand();
    assert.deepEqual(Array.from(command.args), [...prefix, facialScript, '9011', '9012', '9013']);
    assert.equal(command.cwd, path.dirname(facialScript));
  }
}
console.log('Mapping launch: all brands on Windows/macOS/Linux, offline environments and missing installs pass; facial launcher regression passes.');
