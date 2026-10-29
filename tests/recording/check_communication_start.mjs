import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  // The video-worker branch is not executed by these command/lifecycle checks.
  const source = fs.readFileSync(file, 'utf8').replaceAll('import.meta.url', JSON.stringify(new URL(`../../${file}`, import.meta.url).href));
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports, Error, performance, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error: console.error }, ...globals,
    require(name) { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; } });
  return exports;
}
const deferred = () => {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const clock = load('shared/domain/communicationClock.ts');
const lifecycleDomain = load('src/features/recording/domain/recordingLifecycle.ts');
const lifecycleHook = load('src/features/recording/domain/useRecordingLifecycleController.ts', {
  react: { useReducer: (_reducer, initial) => [initial, () => {}], useRef: current => ({ current }),
    useCallback: callback => callback, useMemo: calculate => calculate() },
  '@/features/recording/domain/recordingLifecycle': lifecycleDomain,
});

function harness(options = {}) {
  const lifecycle = lifecycleHook.useRecordingLifecycleController();
  const calls = [], ready = [], playback = [], alerts = [], notices = [];
  let time = 0, preparationCurrent = true;
  const result = { recordingId: 'pupil_test', videoPath: '/project/pupil_test.mp4' };
  const ipc = {
    requireLicenseModule: async () => ({ ok: true }), isAvailable: () => true,
    closeRecordingWindow: async () => { calls.push('close-window'); return { ok: true }; },
    setWindowFullScreen: async () => ({ ok: true }),
    loadTriggerConfig: async () => { calls.push('load-config'); return options.loadConfig || { ok: true, config: options.config || { enabled: true } }; },
    readRecordingCommunicationClock: async () => { time += 2; return { ok: true, mainMonotonicMs: time + 10000 }; },
    configureRecordingCommunication: async input => {
      calls.push(['configure', input]);
      return options.configure ? options.configure(input) : { ok: true };
    },
    readRecordingCommunication: async () => ({ ok: true, events: [], pendingCount: 0, stopped: false, errors: [] }),
    flushStopRecordingCommunication: async () => {
      calls.push('stop-io');
      return options.stopIo ? options.stopIo() : { ok: true, events: [], pendingCount: 0, stopped: true, errors: [] };
    },
  };
  const communication = load('src/features/recording/domain/recordingCommunication.ts', {
    '@/infrastructure/electron/ipcClient': { ipcClient: ipc }, '@shared/domain/communicationClock': clock,
  }, { performance: { now: () => time++ }, setTimeout: () => 1, clearTimeout() {} });
  class Socket {
    static OPEN = 1;
    readyState = 1;
    listeners = new Map();
    addEventListener(name, listener) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(listener);
    }
    removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
    send(text) {
      const request = JSON.parse(text);
      calls.push(request.id);
      const response = { type: 'rsp_cmd', id: request.id, error: 0 };
      if (request.id === 'start_recording') Object.assign(response, { source_model: options.model || 'PupilCore',
        recording_id: result.recordingId, video_path: result.videoPath,
        communication_journal_path: '/project/pupil_test.pupil/communication-capture.jsonl' });
      if (request.id === 'get_source_clock') Object.assign(response, {
        recording_id: result.recordingId, generation: 3, source_time_s: 500 + time++ / 1000, source_time_origin_s: 500,
      });
      if (request.id === 'stop_recording' && options.failBackendStop) Object.assign(response, { error: 1, msg: 'backend stop not confirmed' });
      queueMicrotask(() => { for (const listener of this.listeners.get('message') || []) listener({ data: JSON.stringify(response) }); });
    }
  }
  const window = { requestAnimationFrame: callback => callback(), setTimeout, clearTimeout, alert: text => alerts.push(text) };
  const ws = load('src/features/recording/domain/recordingWsModule.ts', {
    '@/features/recording/domain/recordingCommunication': communication,
    '@/features/recording/domain/calibrationScores': {}, '@/infrastructure/electron/ipcClient': { ipcClient: ipc },
    '@/features/recording/domain/webcodecsVideoRenderer': {},
    '@/features/recording/domain/huahongCalibrationSession': load('src/features/recording/domain/huahongCalibrationSession.ts'),
  }, { window, WebSocket: Socket });
  const start = load('src/features/recording/domain/recordingStartModule.ts', {
    '@/features/recording/domain/recordingCommunication': communication,
    '@/infrastructure/electron/ipcClient': { ipcClient: ipc }, '@/features/recording/domain/recordingWsModule': ws,
    '@/app/i18n/useDomTranslation': { translateTextForLanguage: value => value },
    '@/app/i18n/language': { getStoredLanguage: () => 'zh' },
    '@/features/recording/domain/audioRecording': {
      prepareSelectedAudioRecording: async () => ({ id: 'prepared-audio' }),
      cancelPreparedAudioRecording: () => calls.push('cancel-audio'),
      startPreparedAudioRecording: async () => calls.push('start-audio'), stopPreparedAudioRecording: async () => calls.push('stop-audio'),
    },
  }, { window, alert: window.alert, document: { fullscreenElement: null } });
  const params = { stimuli: [], subjects: [], subjectId: 'subject', projectDir: '/project', wsCmdRef: { current: new Socket() },
    requireStimuli: false, enableFullscreen: false, captureReadyDelayMs: 0, deviceType: '眼镜式',
    onPreparing: () => { calls.push('preparing'); lifecycle.begin('operation'); },
    onConfirmed: value => { calls.push('confirmed'); lifecycle.confirmStart('operation', value.recordingId, value.videoPath); },
    onFailed: message => { calls.push('failed'); lifecycle.failStart('operation', message); },
    onCommunicationError: message => notices.push(message),
    isPreparationCurrent: () => preparationCurrent,
    isRecordingCurrent: () => lifecycle.stateRef.current.status === 'recording',
    setIsRecordingCaptureReady: value => ready.push(value), setPlaybackIndex: value => playback.push(value),
  };
  return { start: () => start.startRecording(params), stop: () => ws.sendCmdWithResponse({ wsCmdRef: params.wsCmdRef, id: 'stop_recording' }),
    cleanup: communication.finishRecordingCommunication, calls, ready, playback, alerts, notices, lifecycle, result,
    cancelPreparation: () => { preparationCurrent = false; } };
}

for (const config of [{ enabled: true }, { enabled: false, serialEnabled: true }]) {
  const pending = deferred();
  const h = harness({ config, configure: () => pending.promise });
  const starting = h.start();
  await flush();
  assert.equal(h.lifecycle.stateRef.current.status, 'preparing');
  assert.deepEqual(h.ready, [false], 'capture/playback remains unready while actual communication configure is pending');
  assert.ok(!h.calls.includes('confirmed'));
  assert.ok(!h.calls.includes('start-audio'));
  pending.resolve({ ok: true });
  assert.equal((await starting).recordingId, h.result.recordingId);
  assert.deepEqual(h.ready, [false, true]);
  assert.equal(h.lifecycle.stateRef.current.status, 'recording');
  assert.ok(h.calls.indexOf('confirmed') > h.calls.findIndex(call => Array.isArray(call) && call[0] === 'configure'));
  assert.equal((await h.stop()).ok, true);
  assert.ok(h.calls.indexOf('stop-io') < h.calls.indexOf('stop_recording'), 'real WebSocket stop drains the actual communication bridge first');
}
for (const options of [
  { loadConfig: { ok: false, message: 'config unavailable' } },
  { configure: async () => ({ ok: false, message: 'port busy' }) },
]) {
  const h = harness(options);
  assert.equal(await h.start(), null);
  assert.ok(h.calls.includes('stop_recording'), 'communication initialization failure explicitly stops the backend');
  assert.equal(h.lifecycle.stateRef.current.status, 'failed');
  assert.deepEqual(h.ready, [false, false]);
  assert.equal(h.playback.at(-1), null);
  assert.ok(h.calls.includes('cancel-audio'));
  assert.ok(!h.calls.includes('start-audio'));
  assert.ok(!h.calls.includes('confirmed'));
  assert.equal(h.alerts.length, 1);
  await h.cleanup();
}
{
  const h = harness({ configure: async () => ({ ok: false, message: 'port busy' }), failBackendStop: true });
  assert.equal(await h.start(), null);
  assert.equal(h.lifecycle.stateRef.current.status, 'recording', 'unknown backend stop keeps the recording identity and Stop available');
  assert.equal(h.lifecycle.stateRef.current.recordingId, h.result.recordingId);
  assert.deepEqual(h.ready, [false, false], 'unknown backend stop must never make stimulus playback ready');
  assert.ok(!h.calls.includes('failed'));
  assert.ok(!h.calls.includes('start-audio'));
  assert.match(h.alerts[0], /停止命令尚未确认/);
  await h.cleanup();
}
{
  const pending = deferred(), h = harness({ configure: () => pending.promise });
  const starting = h.start(); await flush();
  h.cancelPreparation(); pending.resolve({ ok: true });
  assert.equal(await starting, null);
  assert.ok(h.calls.indexOf('stop-io') < h.calls.indexOf('stop_recording'));
  assert.equal(h.lifecycle.stateRef.current.status, 'failed');
  assert.deepEqual(h.ready, [false, false]);
  assert.ok(!h.calls.includes('confirmed'));
  await h.cleanup();
}
{
  const pending = deferred();
  let closes = 0;
  const h = harness({ configure: () => pending.promise, stopIo: async () => ++closes <= 2
    ? { ok: false, message: 'I/O close pending' }
    : { ok: true, events: [], pendingCount: 0, stopped: true, errors: [] } });
  const starting = h.start(); await flush();
  h.cancelPreparation(); pending.resolve({ ok: true });
  assert.equal(await starting, null);
  assert.equal(h.lifecycle.stateRef.current.status, 'recording');
  assert.deepEqual(h.ready, [false, false]);
  assert.ok(!h.calls.includes('stop_recording'), 'failed I/O shutdown must not finalize the backend before its communication journal is safe');
  assert.equal((await h.stop()).ok, true, 'a later Stop retries the retained communication session');
  assert.equal(closes, 3);
  assert.equal(h.calls.filter(call => call === 'stop_recording').length, 1);
  await h.cleanup();
}
for (const options of [{ config: { enabled: false, serialEnabled: false } }, { model: 'aSeeGlassesPlus' }]) {
  const h = harness(options);
  assert.equal((await h.start()).recordingId, h.result.recordingId);
  assert.ok(!h.calls.some(call => Array.isArray(call) && call[0] === 'configure'));
  assert.ok(!h.calls.includes('get_source_clock'));
  assert.deepEqual(h.ready, [false, true]);
  if (options.model) assert.ok(!h.calls.includes('load-config'), 'other devices retain the established startup path');
  await h.cleanup();
}
console.log('PASS actual recording start + communication bridge + WebSocket stop: pending readiness, UDP/serial setup, failure cleanup, unknown stop state, cancellation, and legacy compatibility');
