import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/features/recording/domain/recordingLifecycle.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports });
const { INITIAL_RECORDING_LIFECYCLE_STATE: initial, recordingLifecycleReducer: reduce,
  matchesRecordingFinalization: matches, selectRecordingLifecycleFlags: flags } = exports;
const confirmed = (operationId = 'new-operation', recordingId = 'new-recording', videoPath = 'C:\\project\\new.mp4') =>
  reduce(reduce(initial, { type: 'START_REQUESTED', operationId }),
    { type: 'START_CONFIRMED', operationId, recordingId, videoPath });
const result = { recordingId: 'new-recording', videoPath: 'C:/project/new.mp4', ok: false,
  message: 'encoder failed', csvPath: '', videoSize: 0, elapsedMs: 10 };

assert.equal(matches(confirmed(), result), true, 'Windows path separators compare consistently');
assert.equal(matches(confirmed(), { ...result, videoPath: 'c:/PROJECT/new.mp4' }), true);
assert.equal(matches(confirmed(), { ...result, recordingId: 'old-recording' }), false);
assert.equal(matches(confirmed(), { ...result, videoPath: 'C:/other/new.mp4' }), false);
assert.equal(matches(confirmed(), { ...result, recordingId: '', videoPath: '' }), false);
assert.equal(matches(confirmed(), { ...result, recordingId: '' }), true, 'legacy path identity remains supported');
assert.equal(matches(confirmed(), { ...result, videoPath: '' }), true, 'legacy ID identity remains supported');
assert.equal(matches(confirmed('op', 'id', '/project/New.mp4'), { recordingId: 'id', videoPath: '/project/new.mp4' }), false);
const active = confirmed();
assert.equal(reduce(active, { type: 'BACKEND_FINALIZED', operationId: 'old-operation', result }), active);
assert.equal(reduce(active, { type: 'FINALIZE_FAILED', operationId: active.operationId, error: 'unidentified' }), active,
  'unidentified user-stop events do not gain permission to finish an active recording');
let normalStop = reduce(active, { type: 'STOP_REQUESTED', operationId: active.operationId });
normalStop = reduce(normalStop, { type: 'STOP_ACCEPTED', operationId: active.operationId });
assert.equal(reduce(normalStop, { type: 'FINALIZED', operationId: active.operationId }).status, 'completed');
assert.equal(reduce(normalStop, { type: 'FINALIZE_FAILED', operationId: active.operationId, error: 'save error' }).status, 'failed');

// Run the actual controller effect so an ignored result cannot perform teardown
// even if a reducer itself correctly rejects the stale event.
const source = fs.readFileSync('src/app/MrtApplicationController.tsx', 'utf8');
const tree = ts.createSourceFile('controller.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect, startCallback;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect'
      && node.arguments[0]?.getText(tree).includes('if (!recordingFinalizationResult ||')) {
    effect = node.arguments[0].getText(tree);
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'handleStartRecording') {
    startCallback = node.initializer.arguments[0].getText(tree);
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(effect);
assert.ok(startCallback);
const effectCode = ts.transpileModule(`const run = ${effect};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(state, incoming = result) {
  const calls = { audio: 0, device: 0, captureReady: [], notices: [], logs: [] };
  const ctx = {
    recordingFinalizationResult: incoming,
    recordingFinalizationHandlingRef: { current: false },
    recordingLifecycle: { state, receiveFinalization(operationId, received) {
      this.state = reduce(this.state, { type: 'BACKEND_FINALIZED', operationId, result: received });
    } },
    matchesRecordingFinalization: matches,
    setRecordingFinalizationResult(value) { ctx.recordingFinalizationResult = value; },
    setIsRecordingCaptureReady(value) { calls.captureReady.push(value); },
    async stopActiveAudioRecording() { calls.audio++; return { ok: true }; },
    async stopDeviceGracefully() { calls.device++; },
    setIsCameraOn() {},
    showNotice(...args) { calls.notices.push(args); },
    ipcClient: { videoDebugLog(event) { calls.logs.push(event); } },
    isEn: false, activeDataDir: '/project', recordingFinalizingProjectDirRef: { current: '/project' },
    recordingCompletionDialogPendingRef: { current: false }, scheduleRefreshRecordsAfterStop() {}, console,
  };
  vm.runInNewContext(`${effectCode}\nglobalThis.run = run;`, ctx);
  return { ctx, calls, run: () => ctx.run() };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

for (const status of ['recording', 'stopping', 'finalizing', 'completed', 'failed', 'idle']) {
  const state = { ...active, status };
  const { ctx, calls, run } = harness(state, { ...result, recordingId: 'old-recording', videoPath: 'C:/project/old.mp4' });
  run();
  await flush();
  assert.equal(ctx.recordingLifecycle.state, state);
  assert.equal(calls.audio, 0, `${status}: stale results must not stop audio`);
  assert.equal(calls.device, 0, `${status}: stale results must not stop the new recording/device`);
  assert.equal(ctx.recordingFinalizationResult, null);
  assert.equal(ctx.recordingFinalizationHandlingRef.current, false);
}

for (const status of ['recording', 'stopping', 'finalizing']) {
  const { ctx, calls, run } = harness({ ...active, status });
  run();
  assert.equal(ctx.recordingLifecycle.state.status, 'failed');
  assert.equal(flags(ctx.recordingLifecycle.state).isRecording, false);
  assert.equal(flags(ctx.recordingLifecycle.state).isFinalizing, false);
  assert.equal(ctx.recordingLifecycle.state.error, 'encoder failed');
  await flush();
  assert.equal(calls.audio, 1);
  assert.equal(calls.device, 1);
  assert.deepEqual(calls.captureReady, [false]);
  ctx.recordingFinalizationResult = result;
  run();
  await flush();
  assert.equal(calls.device, 1, 'duplicate finalization does not repeat teardown');
}

// Both existing backends return the same identity at start and at completion:
// 7invensun uses current_record_name/video_path, Pupil uses recorder.name/video_path.
for (const [recordingId, videoPath] of [
  ['subject_20261016_174428', 'C:\\project\\recordings\\subject_20261016_174428.mp4'],
  ['pupil_0123456789ab_20261016_174428', '/project/recordings/pupil_0123456789ab_20261016_174428.mp4'],
]) {
  const recording = confirmed('legacy-operation', recordingId, videoPath);
  const stopping = reduce(recording, { type: 'STOP_REQUESTED', operationId: recording.operationId });
  const { ctx, calls, run } = harness(stopping, { ...result, recordingId, videoPath, ok: true, message: 'ok' });
  run();
  await flush();
  assert.equal(ctx.recordingLifecycle.state.status, 'completed');
  assert.equal(calls.device, 1);
}

for (const matching of [true, false]) {
  const preparing = reduce(initial, { type: 'START_REQUESTED', operationId: 'new-operation' });
  const received = matching ? result : { ...result, recordingId: 'old-recording', videoPath: 'C:/project/old.mp4' };
  const { ctx, calls, run } = harness(preparing, received);
  run();
  assert.equal(ctx.recordingFinalizationResult, received, 'before-ACK result waits for the start identity');
  assert.equal(calls.audio, 0);
  assert.equal(calls.device, 0);
  ctx.recordingLifecycle.state = reduce(preparing, { type: 'START_CONFIRMED', operationId: 'new-operation',
    recordingId: active.recordingId, videoPath: active.videoPath });
  run();
  await flush();
  assert.equal(ctx.recordingLifecycle.state.status, matching ? 'failed' : 'recording');
  assert.equal(calls.device, matching ? 1 : 0);
}

{
  const preparing = reduce(initial, { type: 'START_REQUESTED', operationId: 'rejected-operation' });
  const { ctx, calls, run } = harness(preparing);
  run();
  ctx.recordingLifecycle.state = reduce(preparing, { type: 'START_FAILED', operationId: 'rejected-operation', error: 'not started' });
  run();
  await flush();
  assert.equal(calls.device, 0, 'failed startup does not authorize a finalization shutdown');
  assert.equal(ctx.recordingLifecycle.state.error, 'not started');
}

{
  let notices = 0;
  const startCode = ts.transpileModule(`const start = ${startCallback}; start();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(startCode, { isRecording: false, isRecordingFinalizing: false, isEn: false,
    recordingFinalizationHandlingRef: { current: true }, showNotice() { notices++; } });
  assert.equal(notices, 1, 'a new start waits until the accepted result finishes device teardown');
}

console.log('Recording finalization lifecycle passed: identity guard, stale-event teardown isolation, spontaneous failure, before-ACK deferral, normal stop and teardown ownership.');
