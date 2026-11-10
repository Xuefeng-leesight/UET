import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8')
    .replaceAll('import.meta.url', JSON.stringify(new URL(file, 'file:///').href)), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, console: { log() {}, warn() {}, error: console.error },
    require(name) { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; }, ...globals });
  return exports;
}
const debugEvents = [];
const ipc = { ipcClient: { videoDebugLog(event) { debugEvents.push(event); }, isAvailable: () => false } };
const scores = load('shared/domain/calibrationScores.ts');
const sessions = load('src/features/recording/domain/huahongCalibrationSession.ts');
const profiles = load('src/features/recording/device/deviceProfile.ts');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(model) {
  const calibrationMode = profiles.getDeviceProfile(profiles.deviceTypeFromModel(model), model).calibrationMode;
  const timers = new Map();
  let timerId = 0;
  const setTimer = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
  const clearTimer = id => timers.delete(id);
  const runTimer = id => { const timer = timers.get(id); assert.ok(timer); timers.delete(id); timer.callback(); };
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    listeners = new Map();
    failSend = false;
    send(text) { this.sent.push(JSON.parse(text)); if (this.failSend) throw new Error('Send failed'); }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    receive(message) {
      const event = { data: JSON.stringify(message) };
      this.onmessage?.(event);
      for (const listener of [...(this.listeners.get('message') || [])]) listener(event);
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
      for (const listener of [...(this.listeners.get('close') || [])]) listener();
    }
  }
  const flow = load('src/features/recording/domain/calibrationFlow.ts', {
    '@/infrastructure/electron/ipcClient': ipc,
  }, { setTimeout: setTimer, clearTimeout: clearTimer });
  const alerts = [];
  const socketModule = load('src/features/recording/domain/recordingWsModule.ts', {
  '@/features/recording/domain/recordingCommunication': { finishRecordingCommunication: async () => {} },
    '@/infrastructure/electron/ipcClient': ipc,
    '@/features/recording/domain/calibrationScores': scores,
    '@/features/recording/domain/huahongCalibrationSession': sessions,
    '@/features/recording/domain/webcodecsVideoRenderer': {},
  }, { WebSocket: Socket, window: { setTimeout: setTimer, clearTimeout: clearTimer },
    document: { fullscreenElement: null }, alert(message) { alerts.push(message); } });
  const wsCmdRef = { current: null };
  const ref = { current: { arrIndex: 4, pointIndex: 1, points: 3, pointAttempt: 0,
    pointPending: false, timerId: null, safetyTimerId: null } };
  const result = { state: 'none', coefficient: null, activeCoefficient: null, finishedPoints: 0, pointFailure: null, scores: null };
  const send = (id, args = {}) => socketModule.sendCmdOverWs({ wsCmdRef, id, args });
  const sendAsync = (id, args = {}, timeoutMs = 17) => socketModule.sendCmdWithResponse({ wsCmdRef, id, args, timeoutMs });
  const controller = flow.createCalibrationController({
    calibStateRef: ref, calibrationMode, calibIntervalMs: 1,
    calibPoints: Array.from({ length: 9 }, (_, index) => ({ x: .1 + (index % 3) * .4, y: .1 + Math.floor(index / 3) * .4 })),
    setCalibPointIndex() {}, setCalibScale() {}, sendCmd: send,
  });
  socketModule.connectCmdWebSocket({
    wsIp: '127.0.0.1', wsCmdPort: '9003', wsCmdRef, deviceModel: model, calibStateRef: ref, calibrationMode,
    setCalibrationState(value) { result.state = value; }, setCalibScale() {},
    setCalibrationCoe(value) { result.coefficient = value; },
    setCalibrationScores(value) { result.scores = typeof value === 'function' ? value(result.scores) : value; },
    onTrackingCoeActivated(value) { result.activeCoefficient = value || null; },
    onCalibrationPointFinished() { result.finishedPoints++; },
    onCalibrationPointProgress(value) { result.pointFailure = value.error; }, ...controller,
  });
  const socket = wsCmdRef.current;
  const last = id => socket.sent.findLast(message => message.id === id);
  const session = () => last('start_calibration')?.args.calibration_session;
  const respond = (id, extra = {}, token = session()) => socket.receive({ type: 'rsp_cmd', id,
    error: 0, calibration_provider: model, calibration_session: token, ...extra });
  const start = () => { result.state = 'calibrating'; const sent = send('start_calibration', { points: 3 }); return { sent, session: session() }; };
  const submit = () => {
    if (calibrationMode === 'auto' && timers.has(ref.current.timerId)) runTimer(ref.current.timerId);
    else controller.triggerCurrentPoint({ x: .25, y: .75 });
  };
  const finish = (extra = {}, token = session()) => socket.receive({ type: 'notify_finish', source: model,
    calibration_session: token, error: 0, index: ref.current.pointIndex, attempt: ref.current.pointAttempt, ...extra });
  const fireRequestTimeout = () => {
    const entry = [...timers].find(([, timer]) => timer.delay === 17);
    assert.ok(entry, 'Expected a pending request timeout');
    runTimer(entry[0]);
  };
  return { result, ref, socket, timers, alerts, calibrationMode, last, session, respond, start, submit, finish,
    send, sendAsync, runTimer, fireRequestTimeout,
    close: () => socketModule.closeWebSocketRef(wsCmdRef) };
}

for (const model of ['HH_ET10C', 'HH_ET28']) {
  const h = harness(model);
  h.start();
  assert.equal(typeof h.session(), 'string');
  h.respond('start_calibration');
  h.submit();
  const first = h.last('start_calibration_point').args;
  h.respond('start_calibration_point', { point_pending: true, index: first.index, attempt: first.attempt });
  h.respond('start_calibration_point', { index: first.index, attempt: first.attempt });
  assert.equal(h.result.finishedPoints, 0, `${model}: point ACK cannot finish a sample`);
  h.finish({ attempt: first.attempt - 1 });
  h.finish({ index: 2 });
  assert.equal(h.result.finishedPoints, 0, `${model}: mismatched point results must be ignored`);
  h.finish();
  assert.equal(h.result.finishedPoints, 1);
  h.submit();
  if (model === 'HH_ET10C') {
    // ET10 retains point-local retries; ET28 restarts its native round below.
    const failed = h.last('start_calibration_point').args;
    h.finish({ error: -1, msg: 'Native point timeout' });
    const finishLog = debugEvents.findLast(event => event.event === 'calibration:point-finish-received');
    assert.equal(finishLog.details.source, model);
    assert.equal(finishLog.details.error, -1);
    assert.equal(finishLog.details.message, 'Native point timeout');
    assert.equal(finishLog.details.notifyAttempt, failed.attempt);
    assert.equal(h.result.pointFailure, -1);
    assert.equal(h.result.state, 'calibrating');
    assert.equal(h.ref.current.pointIndex, 2);
    assert.equal(h.ref.current.pointPending, false);
    assert.equal(h.result.coefficient, null);
    const sameRound = h.session();
    h.submit();
    assert.equal(h.last('start_calibration_point').args.calibration_session, sameRound);
    h.respond('start_calibration_point', { error: -1, index: failed.index, attempt: failed.attempt });
    assert.equal(h.ref.current.pointPending, true, 'Old attempt failure cannot cancel the retried sample');
  }
  h.finish();
  h.submit();
  h.finish();
  assert.equal(h.result.finishedPoints, 3);
  if (h.calibrationMode === 'click') h.runTimer(h.ref.current.timerId);
  assert.equal(h.socket.sent.at(-1).id, 'complete_calibration');
  assert.equal(h.last('complete_calibration').args.calibration_session, h.session());
  h.respond('complete_calibration', { result_pending: true });
  h.respond('complete_calibration');
  h.respond('complete_calibration', { coe: 'unconfirmed-tracking' });
  assert.equal(h.result.state, 'calibrating');
  assert.equal(h.result.coefficient, null);
  h.respond('complete_calibration', { coe: 'verified', tracking_error: -8 });
  assert.equal(h.result.activeCoefficient, null, 'Tracking failure must not activate the recording cache');
  h.respond('complete_calibration', { coe: 'verified', tracking_error: 0 });
  assert.equal(h.result.state, 'finished');
  assert.equal(h.result.activeCoefficient, 'verified');
  h.close();
  assert.equal(h.result.state, 'none');
  assert.equal(h.result.activeCoefficient, null);
  h.respond('complete_calibration', { coe: 'disconnected', tracking_error: 0 });
  assert.equal(h.result.coefficient, null);

  // Cancellation happens at outbound intent, before any cancel ACK arrives.
  const cancelled = harness(model);
  const old = cancelled.start().session;
  cancelled.send('cancel_calibration');
  assert.equal(cancelled.last('cancel_calibration').args.calibration_session, old);
  assert.equal(cancelled.result.state, 'none');
  cancelled.respond('start_calibration', {}, old);
  cancelled.respond('complete_calibration', { coe: 'cancelled', tracking_error: 0 }, old);
  assert.equal(cancelled.result.state, 'none');
  assert.equal(cancelled.result.coefficient, null);
  const fresh = cancelled.start().session;
  assert.notEqual(fresh, old);
  cancelled.respond('start_calibration', {}, fresh);
  cancelled.submit();
  const point = cancelled.last('start_calibration_point').args;
  cancelled.respond('start_calibration', {}, old);
  cancelled.finish({ index: point.index, attempt: point.attempt }, old);
  cancelled.respond('start_calibration_point', { index: point.index, attempt: point.attempt, point_pending: false }, old);
  cancelled.respond('complete_calibration', { coe: 'old-round', tracking_error: 0 }, old);
  cancelled.respond('cancel_calibration', {}, old);
  assert.equal(cancelled.ref.current.pointPending, true);
  assert.equal(cancelled.result.finishedPoints, 0, 'Same index/attempt from an old session must not advance');
  assert.equal(cancelled.result.state, 'calibrating');
  cancelled.finish({}, fresh);
  assert.equal(cancelled.result.finishedPoints, 1);
  cancelled.submit();
  cancelled.send('cancel_calibration');
  cancelled.finish({}, fresh);
  cancelled.respond('complete_calibration', { coe: 'cancelled-in-flight', tracking_error: 0 }, fresh);
  assert.equal(cancelled.result.state, 'none');
  assert.equal(cancelled.result.finishedPoints, 1);
  assert.equal(cancelled.result.coefficient, null);
  assert.equal(cancelled.timers.size, 0, 'Cancellation clears calibration timers');

  const deadline = harness(model);
  deadline.start(); deadline.respond('start_calibration'); deadline.submit();
  const late = { index: deadline.ref.current.pointIndex, attempt: deadline.ref.current.pointAttempt };
  deadline.finish({ error: -1, calibration_invalidated: true, msg: 'Restart calibration' });
  assert.equal(deadline.result.state, 'none');
  assert.equal(deadline.alerts.length, 1, 'Session timeout keeps the existing error notice');
  deadline.finish(late);
  deadline.respond('complete_calibration', { coe: 'late-success', tracking_error: 0 });
  assert.equal(deadline.result.finishedPoints, 0);
  assert.equal(deadline.result.coefficient, null);

  for (const asynchronous of [false, true]) {
    const failedSend = harness(model);
    failedSend.socket.failSend = true;
    const sent = asynchronous ? (await failedSend.sendAsync('start_calibration', { points: 3 })).ok : failedSend.start().sent;
    assert.equal(sent, false);
    failedSend.respond('start_calibration');
    failedSend.respond('complete_calibration', { coe: 'unsent', tracking_error: 0 });
    assert.equal(failedSend.result.state, 'none');
    assert.equal(failedSend.result.coefficient, null);
  }
  const timeout = harness(model);
  const pending = timeout.sendAsync('start_calibration', { points: 3 });
  await flush();
  timeout.fireRequestTimeout();
  assert.equal((await pending).ok, false);
  timeout.respond('start_calibration');
  timeout.respond('complete_calibration', { coe: 'after-timeout', tracking_error: 0 });
  assert.equal(timeout.result.state, 'none');
  assert.equal(timeout.result.coefficient, null);

  const rejected = harness(model);
  const rejection = rejected.sendAsync('start_calibration', { points: 3 });
  await flush();
  rejected.respond('start_calibration', { error: -1, msg: 'Native start failed' });
  assert.equal((await rejection).ok, false, 'A matching error settles the request after live session invalidation');
  rejected.respond('start_calibration');
  rejected.respond('complete_calibration', { coe: 'after-error', tracking_error: 0 });
  assert.equal(rejected.result.state, 'none');
  assert.equal(rejected.result.coefficient, null);

  const queued = harness(model);
  const pendingStart = queued.sendAsync('start_calibration', { points: 3 });
  await flush();
  const queuedSession = queued.session();
  const pendingCancel = queued.sendAsync('cancel_calibration');
  assert.equal(queued.result.state, 'none', 'Queued cancellation invalidates immediately');
  queued.respond('start_calibration', {}, queuedSession);
  queued.respond('complete_calibration', { coe: 'before-cancel-ACK', tracking_error: 0 }, queuedSession);
  assert.equal(queued.result.coefficient, null);
  queued.fireRequestTimeout();
  assert.equal((await pendingStart).ok, false);
  await flush();
  assert.equal(queued.last('cancel_calibration').args.calibration_session, queuedSession);
  queued.respond('cancel_calibration', {}, queuedSession);
  assert.equal((await pendingCancel).ok, true);
  assert.equal(queued.result.state, 'none');
}

// ET28 native point errors invalidate the whole round, including completed
// points and in-flight success replies. Restart through the existing start API.
for (const nativeError of [-8, -1]) {
  const h = harness('HH_ET28');
  const oldSession = h.start().session;
  h.respond('start_calibration');
  h.submit();
  h.finish();
  h.submit();
  const failedPoint = { ...h.last('start_calibration_point').args };
  h.finish({ error: -1, calibration_invalidated: true,
    msg: `calibration_point: vendor error ${nativeError}; restart calibration` });
  assert.equal(h.result.state, 'none');
  assert.equal(h.result.finishedPoints, 1, 'A failed ET28 sample is not counted as complete');
  assert.equal(h.result.pointFailure, -1);
  assert.equal(h.ref.current.pointPending, false);
  assert.equal(h.timers.size, 0, 'Invalidation clears pending completion and point timers');
  assert.equal(h.alerts.length, 1, 'Keep the shared error notice');
  assert.ok(h.alerts[0].includes(`vendor error ${nativeError}`));
  assert.equal(h.result.coefficient, null);
  assert.equal(h.result.activeCoefficient, null, 'Invalidated rounds cannot retain recording credentials');
  const sentBeforeRetry = h.socket.sent.length;
  h.submit();
  assert.equal(h.send('complete_calibration'), false);
  assert.equal(h.socket.sent.length, sentBeforeRetry, 'No further point/completion can be sent for the invalid round');
  h.finish({ index: failedPoint.index, attempt: failedPoint.attempt }, oldSession);
  h.respond('complete_calibration', { coe: 'invalid-round', tracking_error: 0 }, oldSession);
  assert.equal(h.result.finishedPoints, 1);
  assert.equal(h.result.state, 'none');
  assert.equal(h.result.activeCoefficient, null, 'A late native success cannot authorize recording');

  const freshSession = h.start().session;
  assert.notEqual(freshSession, oldSession);
  h.respond('start_calibration');
  assert.equal(h.ref.current.pointIndex, 1, 'The existing start command restarts at the first point');
  h.submit();
  const freshPoint = h.last('start_calibration_point').args;
  h.finish({ index: freshPoint.index, attempt: freshPoint.attempt }, oldSession);
  h.respond('complete_calibration', { coe: 'old-round-after-restart', tracking_error: 0 }, oldSession);
  assert.equal(h.ref.current.pointPending, true);
  assert.equal(h.result.state, 'calibrating');
  assert.equal(h.result.activeCoefficient, null);
  h.finish();
  h.submit(); h.finish();
  h.submit(); h.finish();
  h.runTimer(h.ref.current.timerId);
  assert.equal(h.last('complete_calibration').args.calibration_session, freshSession);
  h.respond('complete_calibration', { coe: 'new-verified-round', tracking_error: 0 });
  assert.equal(h.result.state, 'finished');
  assert.equal(h.result.coefficient, 'new-verified-round');
  assert.equal(h.result.activeCoefficient, 'new-verified-round');
  h.close();
}

// Scores follow the same accepted completion boundary as calibration credentials.
{
  const h = harness('HH_ET28');
  const eye = values => ({ count: values.length, truncated: false,
    points: values.map((score, index) => ({ index: index + 1, status: 0, score, bias: [0, 0] })) });
  const quality = { version: 1, provider: 'HH_ET28', aggregation: 'arithmetic_mean',
    left: eye([100, 97, 101]), right: eye([101, 101, 101]) };
  const completion = { coe: 'verified-score-round', tracking_error: 0, calibration_quality: quality };
  const old = h.start().session;
  h.respond('start_calibration');
  h.respond('complete_calibration', { ...completion, result_pending: true });
  assert.equal(h.result.scores, null, 'A calibration ACK cannot expose point scores');
  h.send('cancel_calibration');
  h.respond('complete_calibration', completion, old);
  assert.equal(h.result.scores, null, 'Canceled replies cannot restore scores');
  const fresh = h.start().session;
  h.respond('start_calibration');
  h.respond('complete_calibration', completion, old);
  assert.equal(h.result.scores, null, 'A previous round cannot populate a new round');
  h.submit(); h.finish(); h.submit(); h.finish(); h.submit(); h.finish();
  h.runTimer(h.ref.current.timerId);
  h.respond('complete_calibration', completion, fresh);
  assert.equal(h.result.scores.left, 298 / 3);
  assert.equal(h.result.scores.right, 101);
  assert.equal(h.result.scores.et28Quality.left.points[2].score, 101);
  h.close();
  assert.equal(h.result.scores, null, 'Disconnect clears the live score snapshot');
  h.respond('complete_calibration', completion, fresh);
  assert.equal(h.result.scores, null, 'Disconnected replies cannot restore scores');
}

// Session injection/filtering applies only to Huahong, preserving legacy protocols.
for (const model of ['Pro', 'A8', 'aSeeGlassesPlus', 'PupilCore']) {
  const legacy = harness(model);
  legacy.start();
  assert.equal(Object.hasOwn(legacy.last('start_calibration').args, 'calibration_session'), false);
  legacy.respond('start_calibration', model === 'PupilCore' ? { calibration_session: 'native-pupil-session' } : {});
  assert.equal(legacy.result.state, 'calibrating');
}
console.log('Huahong shared calibration WS passed: real send/receive, ACK, ET10 point retries, ET28 failed-round restart, stale credentials/results, cancellation, timeout, disconnect, legacy isolation.');
