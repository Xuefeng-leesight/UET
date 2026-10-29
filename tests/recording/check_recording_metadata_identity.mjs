import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, dependencies = {}) {
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(js, { exports, Date, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), name);
    return dependencies[name];
  } });
  return exports;
}
const lifecycleDomain = load('src/features/recording/domain/recordingLifecycle.ts');
const { findRecordingMetadataTarget: findTarget } = load('src/features/recording/domain/recordingMetadataTarget.ts', {
  './recordingLifecycle': lifecycleDomain,
});
const lifecycleHook = load('src/features/recording/domain/useRecordingLifecycleController.ts', {
  react: { useReducer: (_reduce, initial) => [initial, () => {}], useRef: current => ({ current }),
    useCallback: value => value, useMemo: calculate => calculate() },
  '@/features/recording/domain/recordingLifecycle': lifecycleDomain,
});
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const startTime = new Date(2026, 9, 19, 15, 40, 0).getTime();
const name = 'huahong_0123456789ab';
const videoPath = `C:\\project\\recordings\\${name}.mp4`;
const identity = { recordingId: name, videoPath, subjectName: '张三', startedAtMs: startTime };
const current = { id: `rec_${name}`, name, subjectName: '张三', timestamp: '2026-10-19 16:10:30',
  mp4Path: videoPath, csvPath: `C:\\project\\recordings\\${name}.csv`, deviceModel: 'HH_ET28', samplingRateHz: 120 };
const previous = { ...current, id: 'rec_previous', name: 'huahong_aaaaaaaaaaaa',
  timestamp: '2026-10-19 15:39:59', mp4Path: 'C:\\project\\recordings\\huahong_aaaaaaaaaaaa.mp4' };

assert.equal(findTarget([previous, current], identity), current,
  'The current recording may finish more than 15 or 30 minutes after its start');
assert.equal(findTarget([previous, { ...current, timestamp: '2026-10-19 15:40:30' }], identity).name, name,
  'An earlier recording that ended one second before this start must not receive its metadata');
assert.equal(findTarget([previous], identity), null, 'An absent exact identity must never fall back to the nearest timestamp');
assert.equal(findTarget([current], { ...identity, videoPath: 'C:/different/file.mp4' }), null,
  'Conflicting ID and path must not authorize a write');
assert.equal(findTarget([current], { ...identity, recordingId: 'different' }), null);
assert.equal(findTarget([current], { ...identity, recordingId: '', videoPath: videoPath.toLowerCase().replaceAll('\\', '/') }), current,
  'Path-only replies retain Windows separator and case compatibility');
assert.equal(findTarget([{ ...current, mp4Path: '/project/A.mp4' }], { ...identity, videoPath: '/project/a.mp4' }), null,
  'POSIX paths remain case sensitive');
assert.equal(findTarget([{ ...current, mp4Path: undefined }], identity).name, name,
  'An identified partial recording can still receive its own metadata');

const legacy = { ...current, name: 'subject_20261019_154000', timestamp: '2026-10-19 15:40:00', deviceModel: 'invensun_7' };
const noIdentity = { ...identity, recordingId: '', videoPath: '' };
assert.equal(findTarget([legacy], noIdentity), legacy, 'Legacy/simulated ACKs without IDs retain the original timestamp lookup');
assert.equal(findTarget([legacy], { ...noIdentity, startedAtMs: startTime + 20_000 }), null);
assert.equal(findTarget([legacy], { ...noIdentity, startedAtMs: NaN }), null);
assert.equal(findTarget([{ ...legacy, subjectName: 'other', timestamp: '2026-10-19 15:40:00' },
  { ...legacy, timestamp: '2026-10-19 15:40:01' }], noIdentity).subjectName, '张三',
  'The historical subject preference is unchanged');

// Execute the actual Controller effect/callback, including ownership checks,
// rather than testing only a second copy of the lookup or save orchestration.
const source = fs.readFileSync('src/app/MrtApplicationController.tsx', 'utf8');
const tree = ts.createSourceFile('controller.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect, core, resetDevice, stopDevice;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect'
      && node.arguments[0]?.getText(tree).includes('.saveRecordMeta(')) effect = node.arguments[0].getText(tree);
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'startRecordingCore') {
    core = node.initializer.arguments[0].getText(tree);
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'resetDeviceUiState') {
    resetDevice = node.initializer.arguments[0].getText(tree);
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'stopDeviceGracefully') {
    stopDevice = node.initializer.arguments[0].getText(tree);
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(effect);
assert.ok(core);
assert.ok(resetDevice);
assert.ok(stopDevice);
const effectCode = ts.transpileModule(`globalThis.run = ${effect};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
function pending(overrides = {}) {
  return { ...identity, operationId: 'operation', confirmed: true, saving: false, projectDir: '/project',
    calibrationLeftScore: 8, calibrationRightScore: 9, country: null, configuredSamplingRateHz: 120,
    videoSamplingRateHz: 30, stimuli: [], ...overrides };
}
function effectHarness(overrides = {}) {
  const calls = { meta: [], raw: [], refresh: 0, updates: 0 };
  const ctx = { Date, console, findRecordingMetadataTarget: findTarget,
    recordingMetaPendingRef: { current: pending() }, recordingLifecycle: { stateRef: { current: { operationId: 'operation' } } },
    recordingMetadataProjectRef: { current: '/project' },
    isRecording: false, isRecordingFinalizing: false, activeDataDir: '/project', records: [previous, current],
    activeDeviceType: '眼镜式', activeDeviceModel: 'HH_ET28', recordingSettings: { saveRawData: true },
    eyeSamplesRef: { current: [{ timestamp: 'original' }] },
    setRecords(update) { calls.updates++; ctx.records = typeof update === 'function' ? update(ctx.records) : update; },
    loadRecordsForProject: async () => { calls.refresh++; },
    ipcClient: { isAvailable: () => true, saveRecordMeta: async value => { calls.meta.push(value); return { ok: true }; },
      saveEyeDataCsv: async value => { calls.raw.push(value); return { ok: true }; } },
    ...overrides };
  vm.runInNewContext(effectCode, ctx);
  return { ctx, calls };
}
function installDeviceTeardown(ctx) {
  const ref = current => ({ current });
  const lifecycle = lifecycleHook.useRecordingLifecycleController();
  lifecycle.begin('operation');
  lifecycle.confirmStart('operation', name, videoPath);
  lifecycle.requestStop('operation');
  lifecycle.acceptStop('operation');
  lifecycle.finalize('operation');
  Object.assign(ctx, { recordingLifecycle: lifecycle, simulateMode: true, isCameraOn: false,
    deviceConnectionRequestedRef: ref(true), deviceConnectionGenerationRef: ref(0),
    calibStateRef: ref({}), simulateCalibrationRef: ref(null), playbackOrderRef: ref(null), playbackSequenceRef: ref(null),
    webCodecsImageFallbackRef: ref(false), wsImageRef: ref(null), wsEyeRef: ref(null), wsCmdRef: ref(null),
    imageCanvasRef: ref(null), videoPreviewCanvasRef: ref(null), facialWsCmdRef: ref(null), facialImageWsRef: ref(null),
    facialBrowserPreviewRef: ref(null), facialAutoCaptureActiveRef: ref(false), facialAutoCaptureRecordIdRef: ref(null),
    createEmptyEyeData: () => ({}), closeWebSocketRef: value => { value.current = null; },
    stopActiveAudioRecording: async () => ({ ok: true }), stopActiveAudioCapture: async () => ({ ok: true }),
    exitRecordingFullscreen: async () => {}, WebSocket: { OPEN: 1 },
  });
  for (const fn of ['clearSimulateCalibAnim', 'clearCalibrationFullscreenTimer', 'setCalibrationState',
    'setIsCalibrationTestMode', 'setCalibScale', 'setIsRecordingCaptureReady', 'setPlaybackIndex', 'setIsCameraOn',
    'setIsPreviewing', 'setEyeData', 'setLastImageAt', 'closeEncodedVideoPreview', 'setWsConnected', 'setVideoPreviewMode',
    'setVideoPreviewStatus', 'setVideoPreviewFrameSize', 'stopFacialAutoCapture', 'setFacialPreviewStream',
    'setFacialPreviewDataUrl', 'setFacialFaceBox', 'setFacialExpression', 'setIsFacialCapturing']) ctx[fn] = () => {};
  ctx.ipcClient.closeRecordingWindow = () => {};
  vm.runInNewContext(ts.transpileModule(`globalThis.resetDeviceUiState = ${resetDevice};
    globalThis.stopDeviceGracefully = ${stopDevice};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, ctx);
}

{
  const { ctx, calls } = effectHarness();
  ctx.run();
  await flush();
  assert.equal(calls.meta.length, 1);
  assert.equal(calls.meta[0].recordName, name);
  assert.equal(calls.raw[0].recordName, name);
  assert.equal(calls.raw[0].rows[0].timestamp, 'original');
  assert.equal(ctx.recordingMetaPendingRef.current, null);
}
for (const overrides of [
  { recordingMetaPendingRef: { current: pending({ confirmed: false }) } },
  { recordingLifecycle: { stateRef: { current: { operationId: 'different' } } } },
  { activeDataDir: '/other-project' },
  { isRecording: true },
  { isRecordingFinalizing: true },
  { records: [previous] },
  { recordingMetaPendingRef: { current: pending({ ...noIdentity, startedAtMs: startTime + 40 * 60_000 }) } },
]) {
  const { ctx, calls } = effectHarness(overrides);
  ctx.run();
  await flush();
  assert.equal(calls.meta.length, 0, 'Unconfirmed, stale, other-project, in-progress or mismatched data cannot be written');
}
{
  const { ctx, calls } = effectHarness({ records: [previous] });
  const owner = ctx.recordingMetaPendingRef.current;
  ctx.run();
  assert.equal(ctx.recordingMetaPendingRef.current, owner,
    'Long recordings retain their exact owner while the final disk refresh is pending');
  ctx.records = [previous, current];
  ctx.run();
  await flush();
  assert.equal(calls.meta[0].recordName, name);
}
{
  const { ctx, calls } = effectHarness({ records: [legacy], recordingMetaPendingRef: { current: pending(noIdentity) } });
  ctx.run();
  await flush();
  assert.equal(calls.meta[0].recordName, legacy.name, 'An accepted legacy ACK still writes its metadata');
}
{
  const { ctx, calls } = effectHarness();
  const save = deferred();
  ctx.ipcClient.saveRecordMeta = value => { calls.meta.push(value); return save.promise; };
  ctx.run();
  const newer = pending({ operationId: 'new-operation', recordingId: 'new-record', videoPath: '/new.mp4' });
  ctx.recordingMetaPendingRef.current = newer;
  ctx.eyeSamplesRef.current = [{ timestamp: 'newer' }];
  save.resolve({ ok: true });
  await flush();
  assert.equal(ctx.recordingMetaPendingRef.current, newer, 'A late save response cannot clear the next recording owner');
  assert.equal(calls.raw.length, 0, 'A late save cannot consume the next recording sample buffer');
  assert.equal(calls.refresh, 0);
}
for (const changeContext of [
  ctx => { ctx.recordingLifecycle.stateRef.current.operationId = 'new-operation'; },
  ctx => { ctx.recordingMetadataProjectRef.current = '/different-project'; },
]) {
  const { ctx, calls } = effectHarness();
  const save = deferred();
  ctx.ipcClient.saveRecordMeta = value => { calls.meta.push(value); return save.promise; };
  ctx.run();
  const owner = ctx.recordingMetaPendingRef.current;
  changeContext(ctx);
  save.resolve({ ok: true });
  await flush();
  assert.equal(ctx.recordingMetaPendingRef.current, owner);
  assert.equal(calls.updates, 0, 'A late save cannot update another operation or project');
  assert.equal(calls.raw.length, 0);
  assert.equal(calls.refresh, 0);
}
{
  const { ctx, calls } = effectHarness();
  const save = deferred();
  ctx.ipcClient.saveRecordMeta = value => { calls.meta.push(value); return save.promise; };
  ctx.run();
  ctx.run();
  assert.equal(calls.meta.length, 1, 'Re-renders during saving must not start a duplicate write');
  installDeviceTeardown(ctx);
  await ctx.stopDeviceGracefully('recording-finalized');
  assert.equal(ctx.recordingLifecycle.stateRef.current.operationId, null);
  save.resolve({ ok: true });
  await flush();
  assert.equal(calls.raw[0].recordName, name, 'Ordinary device teardown must not invalidate accepted metadata');
  assert.equal(calls.refresh, 1);
  assert.equal(ctx.recordingMetaPendingRef.current, null);
}
for (const reason of ['recording-finalized', 'navigate-away']) {
  const { ctx, calls } = effectHarness();
  installDeviceTeardown(ctx);
  await ctx.stopDeviceGracefully(reason);
  assert.equal(ctx.recordingLifecycle.stateRef.current.operationId, null);
  ctx.run();
  await flush();
  assert.equal(calls.meta[0].recordName, name, 'The first disk refresh after normal/manual device reset still persists metadata');
  assert.equal(ctx.recordingMetaPendingRef.current, null);
}
{
  const { ctx, calls } = effectHarness();
  const raw = deferred();
  ctx.ipcClient.saveEyeDataCsv = value => { calls.raw.push(value); return raw.promise; };
  ctx.run();
  await flush();
  assert.equal(calls.raw.length, 1);
  ctx.recordingMetadataProjectRef.current = '/different-project';
  raw.resolve({ ok: true });
  await flush();
  assert.equal(calls.refresh, 0, 'Switching projects during raw-data saving prevents the old reload');
}
{
  const { ctx, calls } = effectHarness();
  const reload = deferred();
  ctx.loadRecordsForProject = async ({ setRecords }) => {
    calls.refresh++;
    await reload.promise;
    setRecords([current]);
  };
  ctx.run();
  await flush();
  assert.equal(calls.refresh, 1);
  const updatesBeforeSwitch = calls.updates;
  ctx.recordingLifecycle.stateRef.current.operationId = 'new-operation';
  reload.resolve();
  await flush();
  assert.equal(calls.updates, updatesBeforeSwitch, 'A pending disk reload cannot overwrite the next operation list');
}

const coreCode = ts.transpileModule(`globalThis.startCore = ${core};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
{
  const lifecycle = lifecycleHook.useRecordingLifecycleController();
  const ref = current => ({ current });
  const oldReply = deferred();
  const ctx = { Date, recordingLifecycle: lifecycle, activeDeviceProfile: { deviceType: '眼镜式', stimulusEnabled: false },
    recordingSettings: {}, playbackOrderRef: ref(null), playbackSequenceRef: ref(null), setPlaybackIndex() {},
    currentStimulusNameRef: ref(''), currentTriggerMarkRef: ref(''), stimuli: [], subjects: [],
    currentRecordingSubjectName: '张三', currentRecordingSubject: null, currentRecordingSubjectId: 'subject',
    calibrationScores: { left: 8, right: 9 }, recordingMetaPendingRef: ref(null), activeDataDir: '/project',
    samplingRateHz: 120, videoSamplingRateHz: 30, eyeSamplesRef: ref([]),
    activeCustomMarkersRef: ref(new Map()), activeContinuousMarkersRef: ref(new Map()), pendingInstantMarkersRef: ref(new Map()),
    hiddenRecordingMonitorTileIds: [], hasFacialExpressionModality: false, isFixedRemoteEyeMonitor: false,
    facialSettings: { enabled: false }, wsCmdRef: ref(null), setIsRecordingCaptureReady() {},
    createParticipantWindowState: value => value, normalizeCalibrationPointStyle: value => value, language: 'zh',
    ipcClient: { videoDebugLog() {} } };
  let count = 0;
  ctx.startRecordingMod = async params => {
    const first = count++ === 0;
    params.onPreparing();
    if (first) await oldReply.promise;
    const response = first ? { recordingId: 'old-record', videoPath: '/old.mp4' }
      : { recordingId: name, videoPath };
    params.onConfirmed(response);
    return response;
  };
  vm.runInNewContext(coreCode, ctx);
  const oldStart = ctx.startCore('old-operation');
  assert.equal(ctx.recordingMetaPendingRef.current.operationId, 'old-operation');
  assert.equal(ctx.recordingMetaPendingRef.current.confirmed, false, 'Pending owner exists before the start ACK');
  lifecycle.failStart('old-operation', 'timeout');
  await ctx.startCore('new-operation');
  const newer = ctx.recordingMetaPendingRef.current;
  assert.equal(newer.confirmed, true);
  assert.equal(newer.recordingId, name);
  assert.equal(newer.videoPath, videoPath);
  oldReply.resolve();
  await oldStart;
  assert.equal(ctx.recordingMetaPendingRef.current, newer);
  assert.equal(newer.recordingId, name, 'A late start ACK cannot retarget a newer pending owner');
  assert.equal(lifecycle.stateRef.current.operationId, 'new-operation');
  assert.equal(lifecycle.stateRef.current.recordingId, name);
}

console.log('Recording metadata identity passed: UUID long/adjacent sessions, exact ID/path conflicts, legacy fallback, project/operation guards, late start ACK and save response isolation.');
