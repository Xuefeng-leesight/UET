import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, dependencies = {}, fakeProcess = { env: {} }, globals = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, { exports, console, process: fakeProcess, URL, ...globals,
    require(name) { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; } });
  return exports;
}
const profile = load('src/features/recording/device/deviceProfile.ts');
const timers = new Map();
let timerId = 0;
const flow = load('src/features/recording/domain/calibrationFlow.ts', {
  '@/infrastructure/electron/ipcClient': { ipcClient: { videoDebugLog() {} } },
}, undefined, {
  setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
  clearTimeout(id) { timers.delete(id); },
});
const et28 = profile.getDeviceProfile('眼镜式', 'HH_ET28');
assert.equal(et28.calibrationMode, 'click');
assert.equal(et28.defaultCalibrationType, '卡片式五点校准');
assert.deepEqual(Array.from(et28.calibrationTypes, flow.getCalibrationPointsCount), [3, 5, 9]);
assert.ok(et28.calibrationTypes.every(flow.isCardCalibrationType), 'ET28 must enable the shared physical-card detector');
assert.deepEqual(JSON.parse(JSON.stringify(profile.getSdkResolutionOptions(et28))), [
  { label: '1920 * 1080', value: 204 },
], 'ET28 must reuse the resolution selector with only its fixed scene resolution');
const savedResolutions = [201, 202, 203, 204, undefined, '201', '1600x1200'];
for (const saved of savedResolutions) {
  assert.equal(profile.normalizeSdkResolution(saved, et28), 204,
    `ET28 must normalize saved resolution ${saved} before display or persistence`);
}
for (const model of ['aSeeGlassesPlus', 'PupilCore', 'Pro', 'A8', 'HH_ET10C']) {
  const deviceProfile = profile.getDeviceProfile(profile.deviceTypeFromModel(model), model);
  assert.deepEqual(Array.from(profile.getSdkResolutionOptions(deviceProfile), option => option.value), [201, 202, 203, 204],
    `${model} resolution options must stay unchanged`);
  for (const saved of savedResolutions) {
    assert.equal(profile.normalizeSdkResolution(saved, deviceProfile),
      [201, 202, 203, 204].includes(Number(saved)) ? Number(saved) : 202,
      `${model} must retain its existing saved resolution/default`);
  }
}
let startArgs;
const camera = load('src/features/recording/domain/cameraModule.ts', {
  '@/features/recording/device/deviceProfile': profile,
  '@/features/recording/domain/recordingWsModule': {
    stopDeviceCommand: async () => ({ ok: true }),
    startDeviceCommand: async ({ args }) => {
      startArgs = args;
      return { ok: true, response: { model: args.sdk_model } };
    },
    sendCmdWithResponse: async () => { throw new Error('Unexpected tracking restore'); },
  },
}, undefined, { window: { screen: { width: 1920, height: 1080 } }, console: { log() {} } });
for (const model of ['HH_ET28', 'aSeeGlassesPlus', 'PupilCore', 'Pro', 'A8', 'HH_ET10C']) {
  const deviceType = profile.deviceTypeFromModel(model);
  for (const saved of savedResolutions) {
    let cameraOn = false;
    const result = await camera.startCamera({ wsCmdRef: { current: null }, deviceModel: model, deviceType,
      sdkResolution: saved, setIsCameraOn(value) { cameraOn = value; } });
    assert.equal(result.ok, true);
    assert.equal(cameraOn, true);
    assert.equal(startArgs.sdk_model, model);
    assert.equal(startArgs.sdk_resolution, model === 'HH_ET28' ? 204
      : deviceType === '桌面式' ? 201
        : [201, 202, 203, 204].includes(Number(saved)) ? Number(saved) : 202,
    `${model} actual start request must respect its own resolution policy for saved value ${saved}`);
  }
}
await camera.startCamera({ wsCmdRef: { current: null }, deviceModel: 'HH_ET28',
  sdkResolution: 201, setIsCameraOn() {} });
assert.equal(startArgs.sdk_resolution, 204, 'ET28 fixed resolution also applies when legacy callers omit deviceType');
const et10 = profile.getDeviceProfile('桌面式', 'HH_ET10C');
assert.equal(et10.calibrationMode, 'auto');
assert.deepEqual(Array.from(et10.calibrationTypes), Array.from(profile.DESKTOP_PROFILE.calibrationTypes));
assert.equal(et10.defaultCalibrationType, profile.DESKTOP_PROFILE.defaultCalibrationType);
assert.ok(et10.calibrationTypes.every(type => !flow.isCardCalibrationType(type)));
assert.deepEqual(Array.from(profile.getDeviceProfile('眼镜式', 'aSeeGlassesPlus').calibrationTypes),
  ['一点校准', '三点校准', '卡片式一点校准', '卡片式三点校准']);
assert.equal(profile.getDeviceProfile('眼镜式', 'PupilCore').defaultCalibrationType, '卡片式九点校准');
for (const calibrationType of et28.calibrationTypes) {
  const points = flow.getCalibrationPointsCount(calibrationType);
  const calibStateRef = { current: { arrIndex: 4, pointIndex: 1, points, timerId: null, safetyTimerId: null } };
  const commands = [];
  const controller = flow.createCalibrationController({
    calibStateRef, setCalibPointIndex() {}, setCalibScale() {},
    sendCmd(id, args) { commands.push({ id, args }); return true; },
    calibIntervalMs: 0, calibPoints: [], calibrationMode: et28.calibrationMode,
  });
  for (let index = 1; index <= points; index++) {
    controller.triggerCurrentPoint({ x: .23, y: .67 });
    controller.advanceCalibration();
  }
  assert.deepEqual(commands.map(command => command.args.index), Array.from({ length: points }, (_, i) => i + 1),
    'Huahong receives sequential point identities, independently of the shared target grid');
  assert.ok(commands.every(command => command.args.x === .23 && command.args.y === .67),
    'Card sampling must preserve the detected scene position');
  const finish = timers.get(calibStateRef.current.timerId);
  assert.equal(typeof finish, 'function');
  finish();
  assert.equal(commands.at(-1).id, 'complete_calibration');
  timers.clear();
}
const selection = load('electron/platform/sdk/sdkSelection.ts', { './sdkRuntime': {
  DEFAULT_SDK_MODEL: 'Pro', GLASSES_SDK_MODEL: 'aSeeGlassesPlus', DESKTOP_SDK_MODELS: new Set(['Pro', 'A8']),
} }).createSdkSelection({});
const launch = load('electron/platform/python/huahongLaunch.ts', { 'node:fs': fs, 'node:path': path });
for (const [model, kind, source] of [['HH_ET10C', '桌面式', 'screen'], ['HH_ET28', '眼镜式', 'stream']]) {
  assert.equal(profile.normalizeDeviceModel(model), model);
  assert.equal(profile.deviceTypeFromModel(model), kind);
  assert.equal(profile.getDeviceProfile(kind, model).recordSource, source);
  assert.equal(selection.normalizeProjectDeviceModel(model, kind), model);
  assert.equal(selection.modelFromDeviceType(kind, model), model);
  const options = { appDir: path.resolve('dist-electron'), resourcesPath: '', packaged: false, platform: 'win32',
    env: { MRT_SDK_MODEL: model, MRT_HUAHONG_PROJECT_ROOT: '/authorized project', MRT_HUAHONG_PYTHON_BIN: '/isolated/python',
      MRT_SDK_ROOT: '/old-vendor', MRT_SOFTDOG_PWD: 'test', ET28_DLL_DIR: '/old-et28' },
    ffmpeg: '/ffmpeg', rendererUrl: 'http://localhost:31873' };
  const command = launch.buildHuahongCommand(options);
  assert.equal(command.command, '/isolated/python');
  assert.ok(command.args.includes('services.eye_tracking.entrypoints.huahong_server'));
  assert.ok(command.args.includes(model));
  assert.ok(command.args.includes('/authorized project'));
  for (const key of ['MRT_SDK_ROOT', 'MRT_SOFTDOG_PWD', 'ET28_DLL_DIR']) assert.equal(command.env[key], undefined);
  assert.equal(options.env.MRT_SDK_ROOT, '/old-vendor');
  assert.throws(() => launch.buildHuahongCommand({ ...options, platform: 'darwin' }), /Windows/);
  assert.throws(() => launch.buildHuahongCommand({ ...options, env: { MRT_SDK_MODEL: model } }), /授权/);
  assert.throws(() => launch.buildHuahongCommand({ ...options, packaged: true, resourcesPath: '/missing' }), /缺失/);
}
const packaging = JSON.parse(fs.readFileSync('package.json', 'utf8')).build.extraResources;
assert.ok(packaging.find(item => item.from === 'SDK').filter.includes('!huahong{,/**}'));
assert.deepEqual(packaging.find(item => item.from === 'SDK/huahong/et28/bin/windows/x64').filter, ['*.dll']);
assert.ok(packaging.some(item => item.to === 'py/mrt-huahong-server.exe'));
await import('./check_calibration_flow.mjs');
await import('./check_process_diagnostics.mjs');
console.log('Huahong product contracts passed: shared card/desktop calibration, point identities, explicit models, isolated launch, path/password boundary, packaging whitelist.');
