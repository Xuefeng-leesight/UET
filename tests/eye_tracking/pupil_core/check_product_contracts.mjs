import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';

const json = (value) => JSON.parse(JSON.stringify(value));
const fakeProcess = { env: {}, platform: process.platform, resourcesPath: '/resources' };
function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8').replaceAll('import.meta.url', JSON.stringify(new URL(file, 'file:///').href)), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, { exports, console, process: fakeProcess, URL,
    window: { screen: { width: 1920, height: 1080 }, innerWidth: 1920, innerHeight: 1080 },
    require: (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`);
      return dependencies[name];
    }, setTimeout, clearTimeout, ...globals }, { filename: file, timeout: 1000 });
  return exports;
}

const profiles = load('src/features/recording/device/deviceProfile.ts');
const models = load('shared/contracts/domain/models.ts');
const modalities = load('shared/domain/projectModalities.ts', { '../contracts/domain/models': models });
const sdkModule = { DEFAULT_SDK_MODEL: 'Pro', DESKTOP_SDK_MODELS: new Set(['Pro', 'A8']), GLASSES_SDK_MODEL: 'aSeeGlassesPlus' };
const sdk = load('electron/platform/sdk/sdkSelection.ts', { './sdkRuntime': sdkModule }).createSdkSelection({});
for (const [model, kind] of [['Pro', '桌面式'], ['A8', '桌面式'], ['aSeeGlassesPlus', '眼镜式'], ['PupilCore', '眼镜式']]) {
  assert.equal(profiles.normalizeDeviceModel(model), model);
  assert.equal(sdk.normalizeProjectDeviceModel(model, kind), model);
  assert.equal(sdk.modelFromDeviceType(kind, model), model);
  const migrated = modalities.migrateProject({ id: 'p', deviceModel: model, deviceType: kind });
  assert.equal(migrated.deviceModel, model);
  assert.equal(migrated.modalities[0].config.deviceModel, model);
  const profile = profiles.getDeviceProfile(kind, model);
  assert.equal(profile.sdkModel, model);
  assert.equal(profile.recordSource, kind === '眼镜式' ? 'stream' : 'screen');
  if (model === 'PupilCore') assert.deepEqual(json(profile.calibrationTypes), ['卡片式三点校准', '卡片式五点校准', '卡片式九点校准']);
  else assert.deepEqual(json(profile.calibrationTypes), kind === '眼镜式'
    ? ['一点校准', '三点校准', '卡片式一点校准', '卡片式三点校准'] : ['三点校准', '五点校准', '九点校准']);
}

const finalizers = [];
const flow = load('src/features/recording/domain/calibrationFlow.ts', {
  '@/infrastructure/electron/ipcClient': { ipcClient: { videoDebugLog() {} } },
}, { setTimeout: (fn) => { finalizers.push(fn); return 1; } });
const terms = load('src/app/i18n/i18nConfig.ts').EN_TERM_MAP;
for (const count of [3, 5, 9]) {
  const sequence = Array.from({ length: count }, (_, index) => index);
  assert.deepEqual(json(flow.getPupilCalibrationSequence(count)), sequence);
  const type = { 3: '卡片式三点校准', 5: '卡片式五点校准', 9: '卡片式九点校准' }[count];
  assert.equal(flow.getCalibrationPointsCount(type), count);
  assert.equal(flow.isCardCalibrationType(type), true);
  assert.equal(terms[type], `Card ${count}-Point Calibration`);
  const ref = { current: { arrIndex: sequence[0], pointIndex: 1, points: count,
    sequenceOverride: sequence, timerId: null, safetyTimerId: null } };
  const sent = [], visited = [];
  const controller = flow.createCalibrationController({ calibStateRef: ref, calibrationMode: 'click',
    setCalibPointIndex: (index) => visited.push(index), setCalibScale() {},
    sendCmd: (id, args) => { sent.push({ id, args }); return true; },
    calibIntervalMs: 1000, calibPoints: Array.from({ length: 9 }, (_, index) => ({ x: index / 10, y: .1 })) });
  controller.processPoint(sequence[0], 1);
  for (let index = 0; index < count; index++) {
    controller.triggerCurrentPoint({ x: .65, y: .24 });
    controller.triggerCurrentPoint({ x: .65, y: .24 }); // Pending guard prevents duplicate samples.
    controller.advanceCalibration();
  }
  assert.deepEqual(visited, sequence);
  assert.equal(sent.length, count);
  assert.deepEqual(sent.map(({ args }) => args.index), Array.from({ length: count }, (_, index) => index + 1));
  finalizers.pop()();
  assert.equal(sent.at(-1).id, 'complete_calibration');
}
const mapping = load('src/features/recording/domain/gazeMapping.ts');
// Source-image positions survive wide/tall previews, resizing and non-16:9 cameras.
for (const [width, height, sw, sh] of [[1000, 1000, 1280, 720], [1600, 600, 640, 480], [600, 1000, 720, 1280]]) {
  const box = mapping.containedImageBox(width, height, sw, sh);
  for (const [x, y] of [[0, 0], [.5, .5], [.25, .7], [1, 1]]) {
    const point = mapping.pointerToImagePoint(50 + box.left + x * box.width, 30 + box.top + y * box.height,
      { left: 50, top: 30, width, height }, sw, sh);
    assert.ok(point && Math.abs(point.x - x) < 1e-12 && Math.abs(point.y - y) < 1e-12);
  }
  if (box.top > 0) assert.equal(mapping.pointerToImagePoint(50 + width / 2, 31, { left: 50, top: 30, width, height }, sw, sh), null);
  if (box.left > 0) assert.equal(mapping.pointerToImagePoint(51, 30 + height / 2, { left: 50, top: 30, width, height }, sw, sh), null);
}
assert.equal(mapping.pointerToImagePoint(0, 0, { left: 0, top: 0, width: 100, height: 100 }, 0, 720), null);
assert.equal(mapping.pointerToImagePoint(NaN, 0, { left: 0, top: 0, width: 100, height: 100 }, 640, 480), null);

const display = load('src/features/recording/domain/gazeDisplayPath.ts', {
  react: {}, '@/features/recording/domain/gazeMapping': mapping,
});
for (const source of ['recommended', 'raw', 'smooth']) {
  const data = { sourceModel: 'PupilCore', recomGazeBitMask: '7', recomGazeX: '0', recomGazeY: '0',
    recomPointX: '0', recomPointY: '0', recomRawX: '0', recomRawY: '0', recomSmoothX: '0', recomSmoothY: '0' };
  assert.deepEqual(json(display.selectGazeDisplayPoint(data, source, { isGlassesMode: true })), { x: 0, y: 0 });
  assert.equal(display.selectGazeDisplayPoint({ ...data, sourceModel: '' }, source, { isGlassesMode: true }), null);
  assert.equal(display.selectGazeDisplayPoint({ ...data, recomGazeBitMask: '0' }, source, { isGlassesMode: true }), null);
}

let calls = [];
const camera = load('src/features/recording/domain/cameraModule.ts', {
  '@/features/recording/device/deviceProfile': profiles,
  '@/features/recording/domain/recordingWsModule': {
    stopDeviceCommand: async () => { calls.push('stop'); return { ok: true }; },
    startDeviceCommand: async ({ args }) => { calls.push(args.sdk_model); return { ok: true, response: { model: args.sdk_model } }; },
    sendCmdWithResponse: async ({ id }) => { calls.push(id); return { ok: true }; },
  },
});
for (const model of ['Pro', 'A8', 'aSeeGlassesPlus', 'PupilCore']) {
  calls = [];
  const result = await camera.startCamera({ wsCmdRef: { current: null }, deviceModel: model,
    deviceType: profiles.deviceTypeFromModel(model), calibrationCoe: 'old-coefficients', setIsCameraOn() {} });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, model === 'PupilCore' ? ['stop', model] : ['stop', model, 'start_tracking']);
}

const launch = load('electron/platform/python/pupilLaunch.ts', { 'node:fs': fs, 'node:path': path });
const options = { appDir: path.resolve('dist-electron'), resourcesPath: '/resources', packaged: false,
  platform: process.platform, env: { MRT_PUPIL_PYTHON_BIN: '/isolated/python', MRT_SDK_ROOT: '/vendor',
    MRT_SOFTDOG_PWD: 'test-only', MRT_PUPIL_PROJECT_ROOT: '/project with spaces' }, ffmpeg: '/media/ffmpeg', rendererUrl: 'http://localhost:31873' };
const command = launch.buildPupilCommand(options);
assert.equal(command.command, '/isolated/python');
assert.equal(command.cwd, path.resolve('.'));
assert.equal(command.args[1], 'services.eye_tracking.entrypoints.pupil_server');
assert.equal(command.args[command.args.indexOf('--backend') + 1], 'native');
const captureCommand = launch.buildPupilCommand({ ...options, env: { ...options.env, MRT_PUPIL_BACKEND: 'capture' } });
assert.equal(captureCommand.args[captureCommand.args.indexOf('--backend') + 1], 'capture');
assert.throws(() => launch.buildPupilCommand({ ...options, env: { MRT_PUPIL_RIGHT_UID: 'one-eye-only' } }));
assert.ok(command.args.includes('/project with spaces'));
assert.ok(command.args.includes('http://localhost:31873'));
assert.equal(command.env.MRT_SDK_ROOT, undefined);
assert.equal(command.env.MRT_SOFTDOG_PWD, undefined);
assert.equal(options.env.MRT_SDK_ROOT, '/vendor');
const packagedLaunch = load('electron/platform/python/pupilLaunch.ts', {
  'node:path': path, 'node:fs': { existsSync: () => true },
});
for (const platform of ['win32', 'darwin']) {
  const packaged = packagedLaunch.buildPupilCommand({ ...options, packaged: true, platform });
  assert.equal(packaged.command, path.join('/resources', 'py', 'pupil-backend',
    platform === 'win32' ? 'mrt-pupil-server.exe' : 'PupilBackend.app/Contents/MacOS/mrt-pupil-server'));
  assert.equal(packaged.cwd, path.dirname(packaged.command));
}
const resource = JSON.parse(fs.readFileSync('package.json', 'utf8')).build.extraResources;
assert.ok(resource.some((entry) => entry.from === 'services/dist/pupil-backend' && entry.to === 'py/pupil-backend'));
const probeLaunch = load('electron/platform/python/pupilLaunch.ts', {
  'node:path': path,
  'node:fs': { existsSync: (file) => file === '/tools with spaces/ffprobe.exe',
    statSync: () => ({ isFile: () => true }) },
});
const probeCommand = probeLaunch.buildPupilCommand({ ...options, platform: 'win32',
  ffmpeg: '/tools with spaces/ffmpeg.exe' });
assert.equal(probeCommand.args[probeCommand.args.indexOf('--ffprobe') + 1], '/tools with spaces/ffprobe.exe');
const explicitProbe = probeLaunch.buildPupilCommand({ ...options,
  env: { ...options.env, MRT_FFPROBE_PATH: '/explicit/ffprobe' } });
assert.equal(explicitProbe.args[explicitProbe.args.indexOf('--ffprobe') + 1], '/explicit/ffprobe');


let runtimeFileExists = fs.existsSync;
const runtimeModule = load('electron/platform/python/pythonRuntime.ts', {
  electron: { app: { isPackaged: false, on() {} } }, 'node:fs': { ...fs, existsSync: (...args) => runtimeFileExists(...args) }, 'node:os': {}, 'node:path': path,
  'node:readline': {}, 'node:child_process': {}, '../../../shared/constants/debug': { ENABLE_DEBUG_TESTING: false },
  '../sdk/sdkRuntime': sdkModule, '../logging/videoDebugLogger': { logVideoDebugEvent() {} }, './pupilLaunch': launch, './huahongLaunch': load('electron/platform/python/huahongLaunch.ts', { 'node:fs': fs, 'node:path': path }),
});
let vendorCalls = 0;
const runtime = runtimeModule.createPythonRuntime({ appDir: path.resolve('dist-electron'), getMainWindow: () => null,
  getSdkContainerPath: () => '/vendor', getSdkRootPath: () => { vendorCalls++; return '/vendor/Pro'; },
  resolveSdkPaths: (model = 'Pro') => { vendorCalls++; return { model, sdkRoot: '/vendor/' + model, typesDir: '/types', source: 'test' }; },
  findFfmpegBinary: () => '/ffmpeg' });
fakeProcess.env = { MRT_SDK_MODEL: 'PupilCore', MRT_PUPIL_PYTHON_BIN: '/isolated/python' };
assert.ok(runtime.getPyServerCommand().args.includes('services.eye_tracking.entrypoints.pupil_server'));
assert.equal(await runtime.ensureSoftdogKeyConfigured(), true);
assert.equal(vendorCalls, 0, 'Pupil launch must not discover vendor DLLs or passwords');
for (const model of ['Pro', 'A8', 'aSeeGlassesPlus']) {
  fakeProcess.env = { MRT_SDK_MODEL: model, MRT_PYTHON_BIN: '/legacy/python' };
  const cmd = runtime.getPyServerCommand();
  assert.equal(cmd.command, '/legacy/python');
  assert.equal(cmd.env.MRT_SDK_MODEL, model);
  assert.equal(cmd.args[0], path.resolve('services/eye_tracking/entrypoints/server.py'));
  assert.equal(cmd.cwd, path.resolve('services/eye_tracking'));
}
// Moving the entrypoint must not move existing service-local environments or cwd.
const serviceRoot = path.resolve('services/eye_tracking');
const scriptPath = path.join(serviceRoot, 'entrypoints/server.py');
for (const platform of ['win32', 'darwin']) {
  fakeProcess.platform = platform;
  fakeProcess.env = { MRT_SDK_MODEL: 'Pro' };
  for (const directory of ['venv', '.venv']) {
    const python = path.join(serviceRoot, directory, platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3');
    runtimeFileExists = (file) => file === scriptPath || file === python;
    const cmd = runtime.getPyServerCommand();
    assert.equal(cmd.command, python);
    assert.equal(cmd.args[0], scriptPath);
    assert.equal(cmd.cwd, serviceRoot);
  }
  runtimeFileExists = (file) => file === scriptPath;
  const fallback = runtime.getPyServerCommand();
  assert.equal(fallback.command, platform === 'win32' ? 'py' : 'python3');
  assert.deepEqual(Array.from(fallback.args.slice(0, platform === 'win32' ? 2 : 1)), platform === 'win32' ? ['-3', scriptPath] : [scriptPath]);
  assert.equal(fallback.cwd, serviceRoot);
}
fakeProcess.platform = process.platform;
runtimeFileExists = fs.existsSync;
// Shared command UI must wait for Pupil point sampling and asynchronous fitting.
const wsModule = load('src/features/recording/domain/recordingWsModule.ts', {
  '@/features/recording/domain/recordingCommunication': { finishRecordingCommunication: async () => {} },
  '@/features/recording/domain/huahongCalibrationSession': load('src/features/recording/domain/huahongCalibrationSession.ts'),
  '@/features/recording/domain/calibrationScores': load('shared/domain/calibrationScores.ts'),
  '@/infrastructure/electron/ipcClient': { ipcClient: { videoDebugLog() {}, isAvailable: () => false } },
  '@/features/recording/domain/webcodecsVideoRenderer': {},
}, { WebSocket: class {}, document: { fullscreenElement: null }, alert() {},
     console: { log() {}, warn() {}, error: console.error } });
const commandRef = { current: null };
const pointRef = { current: { arrIndex: 4, pointIndex: 1, points: 3, pointAttempt: 1, pointPending: true } };
let advanced = 0, finished = 0, uiState = 'calibrating';
const trackerReadiness = [];
wsModule.connectCmdWebSocket({ wsIp: '127.0.0.1', wsCmdPort: '9003', wsCmdRef: commandRef,
  calibrationMode: 'click', calibStateRef: pointRef, processPoint() {},
  advanceCalibration() { advanced++; }, onCalibrationPointFinished() { finished++; },
  setCalibrationState(value) { uiState = value; }, setCalibScale() {}, setCalibrationCoe() {},
  onCalibrationTrackerReady(value) { trackerReadiness.push(value); } });
const respond = (message) => commandRef.current.onmessage({ data: JSON.stringify({
  type: 'rsp_cmd', error: 0, calibration_provider: 'PupilCore', ...message }) });
respond({ id: 'start_calibration_point', index: 1, attempt: 1, point_pending: true });
assert.equal(advanced, 0);
respond({ id: 'start_calibration_point', index: 1, attempt: 0 });
assert.equal(advanced, 0, 'stale sample response must not advance');
respond({ id: 'start_calibration_point', index: 1, attempt: 1, point_pending: false });
assert.equal(advanced, 1);
assert.equal(finished, 1);
respond({ id: 'complete_calibration', result_pending: true });
assert.equal(uiState, 'calibrating');
respond({ id: 'complete_calibration', coe: 'pupil-session:test' });
assert.equal(uiState, 'finished');
pointRef.current.pointPending = false;
uiState = 'none';
respond({ id: 'complete_calibration', coe: 'pupil-session:late' });
assert.equal(uiState, 'none', 'canceled UI must ignore late success');
respond({ id: 'start_calibration_point', calibration_provider: undefined });
assert.equal(advanced, 2, 'legacy click response remains compatible');
respond({ id: 'start_calibration', tracker_initializing: true, calibration_session: 'session-1' });
assert.equal(trackerReadiness.at(-1), false, 'native initialization must not enable point sampling');
respond({ id: 'calibration_ready', calibration_session: 'stale-session' });
assert.equal(trackerReadiness.at(-1), false, 'old tracker readiness must not enable the current session');
respond({ id: 'calibration_ready', calibration_session: 'session-1' });
assert.equal(trackerReadiness.at(-1), true);
respond({ id: 'cancel_calibration' });
assert.equal(trackerReadiness.at(-1), false);
respond({ id: 'calibration_ready', calibration_session: 'session-1' });
assert.equal(trackerReadiness.at(-1), false, 'canceled readiness must not restore sampling');
respond({ id: 'start_calibration', tracker_initializing: true, calibration_session: 'session-2' });
assert.equal(trackerReadiness.at(-1), false);
respond({ id: 'complete_calibration', error: -1, msg: 'native dependency failed' });
assert.equal(uiState, 'none');
respond({ id: 'start_calibration', tracker_initializing: true, calibration_session: 'current-session' });
respond({ id: 'complete_calibration', error: -1, msg: 'late failure', calibration_session: 'session-2' });
assert.equal(uiState, 'calibrating', 'old failure must not cancel a newer calibration');
respond({ id: 'cancel_calibration' });
uiState = 'none';
respond({ id: 'complete_calibration', error: -1, msg: 'late failure', calibration_session: 'current-session' });
assert.equal(uiState, 'none', 'canceled session failure must stay ignored');
console.log('Production contracts passed: device isolation, card calibration, async results, preview coordinates and launch.');

// Recorded gaze Hz is a measurement, independent of configured camera presets.
const handlers = {};
const electron = { ipcMain: { handle: (id, handler) => { handlers[id] = handler; } } };
const metadata = load('electron/domains/recording/recordMetadataHandlers.ts', {
  electron, 'node:fs': fs, 'node:path': path,
  '../filesystem/pathValidation': { validateUtf8Path: async () => ({ ok: true }) },
  '../../../shared/domain/calibrationScores': load('shared/domain/calibrationScores.ts'),
});
metadata.registerRecordMetadataHandlers({ normalizeDataSamplingRateHz: () => 240 });
const constants = load('shared/constants/recordPoints.ts');
const parser = load('electron/domains/recording/recordCsvParser.ts', { '../../../shared/constants/recordPoints': constants });
const listing = load('electron/domains/recording/recordingListHandlers.ts', {
  electron, 'node:fs': fs, 'node:path': path, 'node:crypto': crypto, 'node:readline': readline,
  '../../../shared/domain/calibrationScores': load('shared/domain/calibrationScores.ts'),
  './recordPointsModel': { ...parser, RECORD_POINTS_INDEX_VERSION: 3,
    ...load('electron/platform/fs/atomicWrite.ts', { 'node:fs': fs }) },
});
listing.registerRecordingListHandlers({ normalizeDataSamplingRateHz: () => 240,
  buildLocalResourceUrl: async (p) => p, normalizeProjectDeviceType: profiles.normalizeDeviceType,
  normalizeProjectDeviceModel: profiles.normalizeDeviceModel, probeMediaDurationSeconds: async () => undefined });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pupil-measured-rate-'));
try {
  fs.mkdirSync(path.join(temp, 'recordings'));
  for (const [model, rate] of [['PupilCore', 246.96], ['aSeeGlassesPlus', 240]]) {
    const name = `${model}_20261010_095149`;
    const metaPath = path.join(temp, 'recordings', `${name}.meta.json`);
    fs.writeFileSync(metaPath, JSON.stringify({ deviceModel: model, deviceType: '眼镜式', samplingRateHz: 246.96,
      durationSeconds: 25, validityPercent: 51.05, status: 'complete' }));
    const result = await handlers['save-record-meta']({}, { projectDir: temp, recordName: name,
      meta: { samplingRateHz: 240, configuredSamplingRateHz: 240 } });
    assert.equal(result.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(metaPath)).samplingRateHz, rate);
    fs.writeFileSync(path.join(temp, 'recordings', `${name}.mp4`), 'list uses metadata; media decoding tested in Python');
  }
  for (let pass = 0; pass < 2; pass++) {
    const records = await handlers['load-recordings']({}, { projectDir: temp });
    assert.equal(records.ok, true);
    assert.equal(records.records.find(r => r.deviceModel === 'PupilCore').samplingRateHz, 246.96);
    assert.equal(records.records.find(r => r.deviceModel === 'aSeeGlassesPlus').samplingRateHz, 240);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp, '.config/recordings-summary.json'))).version, 10);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('Measured Pupil rates survive metadata updates and list caching; legacy presets remain unchanged.');
