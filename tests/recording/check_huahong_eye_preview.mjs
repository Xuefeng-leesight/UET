import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Run the production socket handlers and animation-frame callbacks. The only
// browser substitutes are sockets, image elements, URLs and the frame clock.
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const page = ts.createSourceFile('RecordingPage.tsx',
  fs.readFileSync('src/features/recording/RecordingPage.tsx', 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let eyeEffect;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(page) === 'React.useEffect'
      && node.arguments[0]?.getText(page).includes('const clearEyeImages =')) {
    assert.equal(eyeEffect, undefined, 'Exactly one production eye-preview effect must be selected');
    eyeEffect = node.arguments[0].getText(page);
  }
  ts.forEachChild(node, visit);
}
visit(page);
assert.ok(eyeEffect, 'Production eye-preview effect must be present');
const wsSource = ts.createSourceFile('recordingWsModule.ts',
  fs.readFileSync('src/features/recording/domain/recordingWsModule.ts', 'utf8'),
  ts.ScriptTarget.Latest, true);
const sceneFunction = wsSource.statements.find(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'connectImageWebSocket');
assert.ok(sceneFunction, 'Production scene-preview connection must be present');

function createHarness({ glasses = true, enabled = true, suspended = false } = {}) {
  const sockets = [];
  const frames = new Map();
  const urls = new Map();
  const revoked = new Set();
  const status = { scene: null, single: null, left: null, right: null, connected: false };
  let nextFrame = 0;
  let nextUrl = 0;
  let now = 10000;
  const ref = current => ({ current });
  const image = () => ref({ src: '' });
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.({}); }
    sendFrame(data) { this.onmessage?.({ data }); }
    close() { this.readyState = 3; }
    finishClose() { this.readyState = 3; this.onclose?.({}); }
  }
  const context = vm.createContext({
    exports: {}, console: { log() {}, error() {} },
    WebSocket: Socket, ArrayBuffer, Uint8Array, Blob,
    Date: { now: () => now },
    URL: {
      createObjectURL(blob) { const url = `blob:test/${++nextUrl}`; urls.set(url, blob); return url; },
      revokeObjectURL(url) { revoked.add(url); urls.delete(url); },
    },
    window: {
      atob: data => Buffer.from(data, 'base64').toString('binary'),
      requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
      cancelAnimationFrame(id) { frames.delete(id); },
    },
    ipcClient: { videoDebugLog() {} },
    recordingSettings: { showEyeImage: enabled }, glassesPreviewSuspended: suspended,
    isGlassesMode: glasses, wsIp: '127.0.0.1', wsImagePort: '9102',
    eyeImageRef: image(), leftEyeImageRef: image(), rightEyeImageRef: image(),
    eyeImageWsRef: ref(null), eyeImageRafIdRef: ref(null), eyeImageRafRunningRef: ref(false),
    eyeImageLatestFrameRef: ref({ single: null, left: null, right: null }),
    eyeImageLastUrlRef: ref({ single: null, left: null, right: null }),
    setEyeImageLastAt: value => { status.single = value; },
    setLeftEyeImageLastAt: value => { status.left = value; },
    setRightEyeImageLastAt: value => { status.right = value; },
    sceneRef: image(), sceneWsRef: ref(null),
  });
  vm.runInContext(compile(fs.readFileSync('src/features/recording/domain/remoteRecordingProtocol.ts', 'utf8')), context);
  vm.runInContext(compile(sceneFunction.getText(wsSource)), context);
  vm.runInContext(compile(`globalThis.runEyeEffect = ${eyeEffect};`), context);
  context.exports.connectImageWebSocket({
    wsIp: context.wsIp, wsImagePort: context.wsImagePort,
    wsImageRef: context.sceneWsRef, imageCanvasRef: context.sceneRef,
    setWsConnected: value => { status.connected = value; },
    setLastImageAt: value => { status.scene = value; },
  });
  const sceneSocket = context.sceneWsRef.current;
  const cleanup = context.runEyeEffect();
  const eyeSocket = context.eyeImageWsRef.current;
  sceneSocket.open();
  eyeSocket?.open();
  return {
    context, sockets, urls, revoked, status, frames, sceneSocket, eyeSocket, cleanup,
    broadcast(data) { sceneSocket.sendFrame(data); eyeSocket?.sendFrame(data); },
    tick() {
      now += 16;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback(now));
    },
    async bytes(ref) {
      const blob = urls.get(ref.current.src);
      assert.ok(blob, 'The production image element must reference a live Blob');
      return [...new Uint8Array(await blob.arrayBuffer())];
    },
  };
}

const jpeg = value => [0xff, 0xd8, value, 0xff, 0xd9];
const message = (kind, value, extra = {}) => JSON.stringify({
  type: 'image_frame', kind, mime: 'image/jpeg', data: Buffer.from(jpeg(value)).toString('base64'), ...extra,
});

// ET28 shares the existing image endpoint: each consumer must select its own
// channel. Both eye status timestamps must advance on the very first frame.
{
  const h = createHarness();
  h.broadcast(message('scene', 1));
  h.broadcast(message('left_eye', 2));
  h.broadcast(message('right_eye', 3));
  h.tick();
  assert.deepEqual(await h.bytes(h.context.sceneRef), jpeg(1));
  assert.deepEqual(await h.bytes(h.context.leftEyeImageRef), jpeg(2));
  assert.deepEqual(await h.bytes(h.context.rightEyeImageRef), jpeg(3));
  assert.equal(h.context.eyeImageRef.current.src, '');
  assert.equal(h.status.left, h.status.right, 'One eye must not starve the other status update');
  assert.ok(h.status.left > 0);
  const oldLeftUrl = h.context.leftEyeImageRef.current.src;
  h.broadcast(message('left_eye', 4));
  h.broadcast(message('left_eye', 5));
  h.broadcast(message('right_eye', 6));
  h.tick();
  assert.deepEqual(await h.bytes(h.context.sceneRef), jpeg(1), 'Eye frames must not replace the scene');
  assert.deepEqual(await h.bytes(h.context.leftEyeImageRef), jpeg(5), 'Preview keeps the newest frame per eye');
  assert.deepEqual(await h.bytes(h.context.rightEyeImageRef), jpeg(6));
  assert.ok(h.revoked.has(oldLeftUrl), 'Replacing an eye frame must release its previous Blob');
  h.broadcast(message('scene', 7));
  h.broadcast(message('unknown', 8));
  h.broadcast('{malformed');
  h.tick();
  assert.deepEqual(await h.bytes(h.context.sceneRef), jpeg(7));
  assert.deepEqual(await h.bytes(h.context.leftEyeImageRef), jpeg(5), 'Scene frames must not replace an eye');
  assert.deepEqual(await h.bytes(h.context.rightEyeImageRef), jpeg(6));
  h.eyeSocket.finishClose();
  for (const imageRef of [h.context.eyeImageRef, h.context.leftEyeImageRef, h.context.rightEyeImageRef]) {
    assert.equal(imageRef.current.src, '');
  }
  assert.equal(h.status.left, null);
  assert.equal(h.status.right, null);
  h.sceneSocket.finishClose();
  assert.equal(h.context.sceneRef.current.src, '');
  assert.equal(h.status.scene, null);
  assert.equal(h.frames.size, 0);
  assert.equal(h.urls.size, 0);
}

// ET10 keeps its combined preview and historical binary JPEG/PNG support.
{
  const h = createHarness({ glasses: false });
  h.broadcast(message('scene', 11));
  h.tick();
  assert.deepEqual(await h.bytes(h.context.sceneRef), jpeg(11));
  assert.deepEqual(await h.bytes(h.context.eyeImageRef), jpeg(11));
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 12]);
  h.broadcast(png.buffer);
  h.tick();
  assert.deepEqual(await h.bytes(h.context.sceneRef), [...png]);
  assert.deepEqual(await h.bytes(h.context.eyeImageRef), [...png]);
  assert.equal(h.urls.get(h.context.eyeImageRef.current.src).type, 'image/png');
  h.cleanup();
  h.sceneSocket.finishClose();
  assert.equal(h.urls.size, 0);
  assert.equal(h.frames.size, 0);
}

// Existing Pupil left/right frames and historical normalized aliases retain
// their labels; the extra numeric eye field cannot override the channel kind.
for (const [left, right] of [['left_eye', 'right_eye'], ['left', 'right'], ['Left-Eye', 'Right Eye']]) {
  const h = createHarness();
  h.broadcast(message(left, 21, { eye: 1 }));
  h.broadcast(message(right, 22, { eye: 2 }));
  h.tick();
  assert.deepEqual(await h.bytes(h.context.leftEyeImageRef), jpeg(21));
  assert.deepEqual(await h.bytes(h.context.rightEyeImageRef), jpeg(22));
  assert.equal(h.context.sceneRef.current.src, '');
  h.cleanup();
  h.sceneSocket.finishClose();
  assert.equal(h.urls.size, 0);
}

// Hiding/suspending the existing panel must not arm another image connection.
for (const options of [{ enabled: false }, { suspended: true }]) {
  const h = createHarness(options);
  assert.equal(h.eyeSocket, null);
  assert.equal(h.sockets.length, 1);
  h.sceneSocket.finishClose();
  assert.equal(h.frames.size, 0);
}

// A prior socket can finish closing after React has already connected the next
// device. Its delayed events must not stop or overwrite the new eye stream.
{
  const h = createHarness();
  const old = h.eyeSocket;
  h.cleanup();
  const replacementCleanup = h.context.runEyeEffect();
  const replacement = h.context.eyeImageWsRef.current;
  assert.notEqual(replacement, old);
  replacement.open();
  replacement.sendFrame(message('left_eye', 31));
  replacement.sendFrame(message('right_eye', 32));
  h.tick();
  const replacementUrls = [...h.urls.keys()];
  const replacementFrameCount = h.frames.size;
  h.cleanup();
  assert.equal(replacement.readyState, 1, 'Prior cleanup must not close the replacement socket');
  assert.equal(h.frames.size, replacementFrameCount, 'Prior cleanup must not cancel the replacement frame loop');
  assert.deepEqual([...h.urls.keys()], replacementUrls, 'Prior cleanup must not revoke replacement image URLs');
  old.finishClose();
  old.sendFrame(message('left_eye', 99));
  old.open();
  h.tick();
  assert.deepEqual(await h.bytes(h.context.leftEyeImageRef), jpeg(31),
    'Delayed prior-socket events must not overwrite or clear the new device');
  assert.deepEqual(await h.bytes(h.context.rightEyeImageRef), jpeg(32));
  assert.equal(h.context.eyeImageWsRef.current, replacement);
  replacementCleanup();
  replacement.finishClose();
  replacement.sendFrame(message('left_eye', 98));
  replacement.open();
  h.tick();
  assert.equal(h.context.leftEyeImageRef.current.src, '');
  assert.equal(h.context.rightEyeImageRef.current.src, '');
  assert.equal(h.context.eyeImageWsRef.current, null);
  h.sceneSocket.finishClose();
  assert.equal(h.frames.size, 0);
  assert.equal(h.urls.size, 0);
}

console.log('Huahong eye preview checks passed: production scene/eye routing, ET10/Pupil compatibility, per-eye rendering, cleanup and stale socket isolation.');
