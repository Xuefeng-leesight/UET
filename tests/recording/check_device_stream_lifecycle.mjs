import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the production connection-maintenance effect with controlled sockets.
const source = fs.readFileSync('src/app/MrtApplicationController.tsx', 'utf8');
const tree = ts.createSourceFile('controller.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect'
      && node.arguments[0]?.getText(tree).includes('const ensureRecordingConnections =')) {
    effect = node.arguments[0].getText(tree);
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(effect);
const jsEffect = ts.transpileModule(`const run = ${effect};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
for (const [page, camera, requested, expected] of [
  ['detail', false, false, 0], // Initial entry or return: no connection.
  ['detail', true, true, 3], // Explicit start: command, eye and image channels.
  ['dashboard', true, true, 0], // Outside recording: never reconnect.
  ['detail', true, false, 0], // Stop/navigation invalidates even stale camera state.
]) {
  let calls = 0;
  let interval;
  const ref = () => ({ current: null });
  const ctx = {
    currentView: page, activeTab: 'video', shouldUseLocalRecordingPipeline: true,
    simulateMode: false, isCameraOn: camera, deviceConnectionRequestedRef: { current: requested },
    wsCmdRef: ref(), wsEyeRef: ref(), wsImageRef: ref(), encodedVideoPreviewRef: ref(),
    WebSocket: { OPEN: 1, CONNECTING: 0 },
    connectCmdWs: () => calls++, connectEyeWs: () => calls++, connectWebSocket: () => calls++,
    shouldUseCombinedImagePreview: false, activeDeviceProfile: { deviceType: '眼镜式' },
    webCodecsImageFallbackRef: { current: false }, previewAwaitingFrameSinceRef: ref(),
    window: { setInterval: (fn) => { interval = fn; return 1; }, clearInterval: () => {} },
    Date, console,
  };
  vm.runInNewContext(`${jsEffect}\nrun();`, ctx);
  assert.equal(calls, expected);
  if (interval) {
    calls = 0;
    ctx.deviceConnectionRequestedRef.current = false;
    interval();
    assert.equal(calls, 0, 'Pending maintenance must not reconnect after stop');
  }
}

// Execute the existing guard: navigation must wait for shutdown to settle.
const hook = ts.transpileModule(fs.readFileSync('src/app/hooks/useNavigationGuard.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const exports = {};
vm.runInNewContext(hook, { exports, console, require: (name) => name === 'react'
  ? { useRef: (current) => ({ current }), useCallback: (fn) => fn }
  : { waitForDeviceStop: async () => true } });
let release;
const order = [];
const guard = exports.useNavigationGuard({
  isRecordingPageActive: true, isDeviceStopped: () => true, stopStrategy: 'blocking',
  stopDeviceBeforeNavigate: () => new Promise((resolve) => { order.push('stop'); release = resolve; }),
});
const navigation = guard.guardedNavigate(() => order.push('navigate'));
assert.deepEqual(order, ['stop']);
release();
await navigation;
assert.deepEqual(order, ['stop', 'navigate']);
console.log('Device stream lifecycle checks passed.');
await import('./check_recording_finalization_lifecycle.mjs');
await import('./check_recording_start_continuations.mjs');
await import('./check_huahong_eye_preview.mjs');
