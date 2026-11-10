import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { exports, console: { log() {}, warn() {}, error: console.error }, performance, Error,
    ...globals, require(name) { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; } });
  return exports;
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const lifecycleDomain = load('src/features/recording/domain/recordingLifecycle.ts');
const lifecycleHook = load('src/features/recording/domain/useRecordingLifecycleController.ts', {
  react: { useReducer: (_reducer, initial) => [initial, () => {}], useRef: current => ({ current }),
    useCallback: callback => callback, useMemo: calculate => calculate() },
  '@/features/recording/domain/recordingLifecycle': lifecycleDomain,
});
const result = { recordingId: 'current-record', videoPath: '/project/current.mp4' };
function fail(lifecycle, operationId = 'operation') {
  lifecycle.receiveFinalization(operationId, { ...result, ok: false, message: 'encoder failed' });
}

// No React render occurs here: command continuations need the new state now.
{
  const lifecycle = lifecycleHook.useRecordingLifecycleController();
  lifecycle.begin('operation');
  lifecycle.confirmStart('operation', result.recordingId, result.videoPath);
  assert.equal(lifecycle.stateRef.current.status, 'recording');
  fail(lifecycle);
  assert.equal(lifecycle.stateRef.current.status, 'failed');
  lifecycle.begin('new-operation');
  lifecycle.confirmStart('operation', 'stale', '/stale.mp4');
  assert.equal(lifecycle.stateRef.current.operationId, 'new-operation');
  assert.equal(lifecycle.stateRef.current.status, 'preparing');
}

class Recorder {
  static isTypeSupported() { return true; }
  state = 'inactive';
  mimeType = 'audio/webm';
  starts = 0;
  listeners = new Map();
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  start() { this.state = 'recording'; this.starts++; }
  stop() { this.state = 'inactive'; this.listeners.get('stop')?.(); }
}
function prepared() {
  return { stream: {}, recorder: new Recorder(), setting: { label: 'mic' },
    cleaned: 0, cleanup() { this.cleaned++; }, audioClock: () => 1 };
}
function audioHarness() {
  const calls = { abort: [], finish: [] };
  const ipc = {
    startRecordingAudio: async ({ videoPath }) => ({ ok: true, sessionId: videoPath }),
    appendRecordingAudio: async () => ({ ok: true }),
    abortRecordingAudio: async ({ sessionId }) => { calls.abort.push(sessionId); return { ok: true }; },
    finishRecordingAudio: async ({ sessionId }) => { calls.finish.push(sessionId); return { ok: true }; },
  };
  const audio = load('src/features/recording/domain/audioRecording.ts', {
    '@/infrastructure/electron/ipcClient': { ipcClient: ipc },
    '@shared/domain/pupilAudioSync': {},
  });
  return { audio, ipc, calls };
}

function startHarness(audioState, microphone, lifecycle) {
  const ready = [];
  const start = load('src/features/recording/domain/recordingStartModule.ts', {
    '@/features/recording/domain/recordingCommunication': { startRecordingCommunication: async () => {} },
    '@/infrastructure/electron/ipcClient': { ipcClient: {
      requireLicenseModule: async () => ({ ok: true }), isAvailable: () => false,
    } },
    '@/features/recording/domain/recordingWsModule': { sendCmdWithResponse: async () => ({ ok: true,
      response: { recording_id: result.recordingId, video_path: result.videoPath } }) },
    '@/app/i18n/useDomTranslation': { translateTextForLanguage: value => value },
    '@/app/i18n/language': { getStoredLanguage: () => 'zh' },
    '@/features/recording/domain/audioRecording': { ...audioState.audio,
      prepareSelectedAudioRecording: async () => microphone },
  }, { window: { requestAnimationFrame: callback => callback() }, alert() { throw new Error('unexpected alert'); } });
  const params = { stimuli: [], subjects: [], subjectId: 'subject', projectDir: '/project', wsCmdRef: { current: null },
    requireStimuli: false, enableFullscreen: false, captureReadyDelayMs: 0,
    onPreparing: () => lifecycle.begin('operation'),
    onConfirmed: value => lifecycle.confirmStart('operation', value.recordingId, value.videoPath),
    onFailed: message => lifecycle.failStart('operation', message),
    isRecordingCurrent: () => lifecycle.stateRef.current.operationId === 'operation' && lifecycle.stateRef.current.status === 'recording',
    setIsRecordingCaptureReady: value => ready.push(value), setPlaybackIndex() {},
  };
  return { start, params, ready };
}

{
  const audioState = audioHarness(), lifecycle = lifecycleHook.useRecordingLifecycleController(), mic = prepared();
  const { start, params, ready } = startHarness(audioState, mic, lifecycle);
  const completed = await start.startRecording(params);
  assert.equal(completed.recordingId, result.recordingId);
  assert.deepEqual(ready, [false, true]);
  assert.equal(mic.recorder.starts, 1, 'ordinary non-Pupil microphone recording still starts');
  await audioState.audio.stopPreparedAudioRecording(mic);
  assert.deepEqual(audioState.calls.finish, [result.videoPath]);
}

{
  const audioState = audioHarness(), lifecycle = lifecycleHook.useRecordingLifecycleController(), oldMic = prepared();
  const pendingAudio = deferred();
  audioState.ipc.startRecordingAudio = ({ videoPath }) => videoPath === result.videoPath
    ? pendingAudio.promise : Promise.resolve({ ok: true, sessionId: videoPath });
  const { start, params, ready } = startHarness(audioState, oldMic, lifecycle);
  const starting = start.startRecording(params);
  await flush();
  fail(lifecycle);
  const newMic = prepared();
  await audioState.audio.startPreparedAudioRecording(newMic, '/project/new.mp4');
  pendingAudio.resolve({ ok: true, sessionId: result.videoPath });
  assert.equal(await starting, null);
  assert.deepEqual(ready, [false], 'a late microphone reply must not restore capture readiness');
  assert.equal(oldMic.recorder.starts, 0);
  assert.equal(newMic.recorder.state, 'recording');
  assert.deepEqual(audioState.calls.abort, [result.videoPath]);
  await audioState.audio.stopPreparedAudioRecording(oldMic);
  assert.equal(newMic.recorder.state, 'recording', 'old continuation cleanup cannot stop the new microphone');
  await audioState.audio.stopActiveAudioRecording();
  assert.deepEqual(audioState.calls.finish, ['/project/new.mp4']);
}

{
  const audioState = audioHarness(), lifecycle = lifecycleHook.useRecordingLifecycleController(), mic = prepared();
  const startAudio = audioState.audio.startPreparedAudioRecording;
  audioState.audio.startPreparedAudioRecording = async (...args) => {
    await startAudio(...args);
    fail(lifecycle);
  };
  const { start, params, ready } = startHarness(audioState, mic, lifecycle);
  assert.equal(await start.startRecording(params), null);
  assert.deepEqual(ready, [false]);
  assert.equal(mic.recorder.starts, 1);
  assert.equal(mic.recorder.state, 'inactive', 'failure after audio started settles that exact microphone instance');
  assert.deepEqual(audioState.calls.finish, [result.videoPath]);
}

{
  const audioState = audioHarness(), oldMic = prepared(), newMic = prepared();
  const clock = deferred();
  const starting = audioState.audio.startPreparedAudioRecording(oldMic, '/old.mp4', () => clock.promise);
  await flush();
  await audioState.audio.stopActiveAudioRecording();
  await audioState.audio.startPreparedAudioRecording(newMic, '/new.mp4');
  clock.resolve({});
  await assert.rejects(starting, /取消/);
  assert.equal(oldMic.recorder.starts, 0);
  assert.equal(newMic.recorder.state, 'recording');
  await audioState.audio.stopActiveAudioRecording();
  assert.equal(newMic.recorder.state, 'inactive', 'old Pupil clock catch must retain the new active instance');
  assert.deepEqual(audioState.calls.finish, ['/old.mp4', '/new.mp4']);
}

const source = fs.readFileSync('src/app/MrtApplicationController.tsx', 'utf8');
const tree = ts.createSourceFile('controller.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ['startRecordingCore', 'startFacialAutoCapture'].includes(node.name.getText(tree))) {
    callbacks.set(node.name.getText(tree), node.initializer.arguments[0].getText(tree));
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert.equal(callbacks.size, 2);
const controllerCode = ts.transpileModule([...callbacks].map(([name, body]) => `const ${name} = ${body};
globalThis.${name} = ${name};`).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function coreHarness() {
  const lifecycle = lifecycleHook.useRecordingLifecycleController();
  const ref = current => ({ current });
  const calls = { stopCommands: 0, facialStarts: 0 };
  const ctx = { performance, recordingLifecycle: lifecycle, activeDeviceProfile: { deviceType: '眼镜式', stimulusEnabled: false },
    recordingSettings: {}, playbackOrderRef: ref(null), playbackSequenceRef: ref(null), setPlaybackIndex() {},
    currentStimulusNameRef: ref(''), currentTriggerMarkRef: ref(''), stimuli: [], subjects: [],
    currentRecordingSubjectName: 'subject', currentRecordingSubject: null, currentRecordingSubjectId: 'subject',
    calibrationScores: { left: 1, right: 1 }, recordingMetaPendingRef: ref(null), activeDataDir: '/project',
    samplingRateHz: 100, videoSamplingRateHz: 30, eyeSamplesRef: ref([]),
    activeCustomMarkersRef: ref(new Map()), activeContinuousMarkersRef: ref(new Map()), pendingInstantMarkersRef: ref(new Map()),
    hiddenRecordingMonitorTileIds: [], hasFacialExpressionModality: true, isFixedRemoteEyeMonitor: false,
    facialSettings: { enabled: true, width: 640, height: 480, fps: 30 },
    validateFacialCaptureReady: async () => ({ ok: true }), wsCmdRef: ref(null),
    setIsRecordingCaptureReady() {}, createParticipantWindowState: value => value,
    normalizeCalibrationPointStyle: value => value, language: 'zh',
    ipcClient: { videoDebugLog() {}, saveFile: async () => ({ ok: true }) },
    facialBrowserPreviewRef: ref({ stream: {}, settings: {} }), facialSessionStatus: { inferenceReady: true },
    facialBrowserRecordingRef: ref(null), setFacialCaptureNotice() {},
    setIsFacialCapturing: value => { if (value) calls.facialStarts++; },
    facialAutoCaptureRecordIdRef: ref(''), facialAutoCaptureActiveRef: ref(false), MediaRecorder: Recorder,
    sendCmdOverWs: () => { calls.stopCommands++; },
  };
  ctx.startRecordingMod = async params => {
    params.onPreparing(); params.onConfirmed(result); return result;
  };
  vm.runInNewContext(controllerCode, ctx);
  return { ctx, lifecycle, calls };
}

{
  const { ctx, calls } = coreHarness();
  await ctx.startRecordingCore('operation');
  assert.equal(calls.facialStarts, 1, 'normal combined recording starts facial capture');
}
{
  const { ctx, lifecycle, calls } = coreHarness();
  ctx.startRecordingMod = async params => {
    params.onPreparing(); params.onConfirmed(result); fail(lifecycle); return result;
  };
  await ctx.startRecordingCore('operation');
  assert.equal(calls.facialStarts, 0, 'backend finalization before the core continuation prevents facial startup');
  assert.equal(calls.stopCommands, 0);
}
{
  const { ctx, lifecycle, calls } = coreHarness();
  const file = deferred();
  ctx.ipcClient.saveFile = () => file.promise;
  const starting = ctx.startRecordingCore('operation');
  await flush();
  fail(lifecycle);
  lifecycle.begin('new-operation');
  lifecycle.confirmStart('new-operation', 'new-record', '/project/new.mp4');
  const newerFacial = { recordId: 'new-record' };
  ctx.facialBrowserRecordingRef.current = newerFacial;
  file.resolve({ ok: true });
  await starting;
  assert.equal(calls.facialStarts, 0, 'a late file creation cannot start stale facial capture');
  assert.equal(ctx.facialBrowserRecordingRef.current, newerFacial);
  assert.equal(calls.stopCommands, 0, 'stale facial startup must not stop the new backend recording');
}

console.log('Recording start continuations passed: synchronous operation state, late microphone/clock isolation, normal audio/facial start, and stale facial save isolation.');
