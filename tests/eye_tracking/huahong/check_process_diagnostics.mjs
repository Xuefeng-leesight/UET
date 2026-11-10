import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, dependencies, globals = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, { exports, URL, ...globals,
    require(name) { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; } });
  return exports;
}

const launch = load('electron/platform/python/huahongLaunch.ts', {
  'node:fs': { existsSync: () => true }, 'node:path': path,
});
for (const packaged of [false, true]) {
  const env = { MRT_SDK_MODEL: 'HH_ET28', MRT_HUAHONG_PROJECT_ROOT: '/project',
    PYTHONUNBUFFERED: '0', PYTHONFAULTHANDLER: '0' };
  const command = launch.buildHuahongCommand({ appDir: '/app/dist-electron', resourcesPath: '/resources',
    packaged, platform: 'win32', env, ffmpeg: null, rendererUrl: 'file:///app/index.html' });
  assert.equal(command.env.PYTHONUNBUFFERED, '1');
  assert.equal(command.env.PYTHONFAULTHANDLER, '1');
  assert.equal(env.PYTHONUNBUFFERED, '0', 'launch must not mutate the parent environment');
  assert.equal(env.PYTHONFAULTHANDLER, '0');
}

function harness({ spawnError = false, platform = 'win32' } = {}) {
  const logs = [], timers = new Map(), children = [];
  let timerId = 0;
  const app = Object.assign(new EventEmitter(), { isPackaged: true });
  const fakeProcess = { env: { MRT_SDK_MODEL: 'HH_ET28', MRT_HUAHONG_PROJECT_ROOT: '/private-project',
    MRT_SOFTDOG_PWD: 'secret-do-not-log', ACCESS_TOKEN: 'token-do-not-log' }, platform, resourcesPath: '/resources' };
  const module = load('electron/platform/python/pythonRuntime.ts', {
    electron: { app }, 'node:fs': {}, 'node:os': {}, 'node:path': path,
    'node:readline': { createInterface: ({ input }) => input },
    'node:child_process': { spawn() {
      if (spawnError) throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      const child = Object.assign(new EventEmitter(), { pid: 1200 + children.length,
        exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(),
        shutdown: [], stdin: { write(line, callback) { child.shutdown.push(line); callback(null); } },
        kill() { throw new Error('tests never execute kill timers'); } });
      children.push(child);
      return child;
    } },
    '../../../shared/constants/debug': { ENABLE_DEBUG_TESTING: true },
    '../sdk/sdkRuntime': { DEFAULT_SDK_MODEL: 'Pro' },
    '../logging/videoDebugLogger': { logVideoDebugEvent(event) { logs.push(JSON.parse(JSON.stringify(event))); } },
    './pupilLaunch': {}, './huahongLaunch': launch,
  }, { process: fakeProcess, console: { log() {}, warn() {}, error() {} },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); } });
  const runtime = module.createPythonRuntime({ appDir: '/app/dist-electron', getMainWindow: () => null,
    getSdkContainerPath() { throw new Error('wrong vendor'); },
    getSdkRootPath() { throw new Error('wrong vendor'); },
    resolveSdkPaths() { throw new Error('wrong vendor'); }, findFfmpegBinary: () => null });
  return { runtime, logs, timers, children, fakeProcess, app };
}

{
  const { runtime, children, fakeProcess, logs, timers } = harness();
  runtime.startPyServer();
  assert.equal(logs.length, 0, 'spawn request is not a successful process start');
  const child = children[0];
  child.emit('spawn');
  fakeProcess.env.MRT_SDK_MODEL = 'HH_ET10C';
  child.stdout.emit('line', 'Huahong service listening');
  child.stderr.emit('line', 'Windows fatal exception: access violation');
  child.emit('exit', 3221225477, null);
  assert.equal(logs[0].event, 'eye-server:process-start');
  for (const log of logs) {
    assert.equal(log.details.model, 'HH_ET28', 'each event identifies the child, not a newly selected model');
    assert.equal(log.details.pid, child.pid);
  }
  assert.deepEqual(logs.at(-1).details, { model: 'HH_ET28', pid: child.pid, code: 3221225477,
    signal: null, stopRequested: false, shuttingDown: false, serverStarted: true, portBindError: false });
  assert.equal(runtime.isRunning(), false);
  assert.deepEqual([...timers.values()].map(timer => timer.delay), [3000], 'diagnostics preserve the crash retry policy');
  assert.ok(!JSON.stringify(logs).includes('secret-do-not-log'));
  assert.ok(!JSON.stringify(logs).includes('token-do-not-log'));
  assert.ok(!JSON.stringify(logs).includes('/private-project'));
}

{
  const { runtime, children, logs, timers } = harness();
  runtime.startPyServer();
  const child = children[0];
  child.emit('spawn');
  runtime.stopPyServer();
  assert.deepEqual(child.shutdown, ['shutdown\n']);
  child.emit('exit', 0, null);
  assert.equal(logs.at(-1).details.stopRequested, true);
  assert.equal(timers.size, 0, 'normal shutdown clears the force-kill timer without retry');
}

{
  const { runtime, children, logs } = harness();
  runtime.startPyServer();
  const child = children[0];
  child.pid = undefined;
  child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0].details, { model: 'HH_ET28', pid: null, stage: 'process',
    errorCode: 'ENOENT', errorName: 'Error', message: 'spawn ENOENT', stopRequested: false });
  assert.equal(runtime.isRunning(), false);
}

for (const [options, stage] of [[{ spawnError: true }, 'spawn'], [{ platform: 'darwin' }, 'command']]) {
  const { runtime, logs } = harness(options);
  runtime.startPyServer();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'eye-server:process-error');
  assert.equal(logs[0].details.stage, stage);
  assert.equal(logs[0].details.model, 'HH_ET28');
  assert.equal(logs[0].details.pid, null);
  assert.equal(runtime.isRunning(), false);
}

console.log('Huahong process diagnostics passed: unbuffered/fault launch, child identity, native exit code, requested shutdown, launch failures, unchanged retry policy.');
