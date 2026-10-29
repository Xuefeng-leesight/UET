import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync('src/features/recording/domain/webcodecsVideoWorker.ts', 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
let now = 100;
let socket;
let interval;
const messages = [];
class MockDecoder {
  static async isConfigSupported(config) { return { supported: true, config }; }
  constructor(callbacks) { this.callbacks = callbacks; this.decodeQueueSize = 0; }
  configure() {}
  close() {}
  decode(chunk) {
    now += 7;
    this.callbacks.output({ timestamp: chunk.timestamp, displayWidth: 1280, displayHeight: 720, close() {} });
  }
}
const self = { VideoDecoder: MockDecoder, EncodedVideoChunk: class { constructor(args) { Object.assign(this, args); } }, VideoFrame: class {}, postMessage: m => messages.push(m) };
const context = vm.createContext({ self, performance: { now: () => now, timeOrigin: 1000 }, WebSocket: class { constructor() { socket = this; } close() {} }, setInterval: f => { interval = f; return 1; }, clearInterval: () => { interval = null; } });
vm.runInContext(code, context);
self.onmessage({ data: { type: 'init', url: 'ws://test' } });
function packet(seq, keyframe) {
  const b = new ArrayBuffer(33); const v = new DataView(b);
  [0x4d, 0x52, 0x54, 0x56, 1, 2, keyframe ? 1 : 0].forEach((n, i) => v.setUint8(i, n));
  v.setUint16(8, 1280, true); v.setUint16(10, 720, true);
  v.setUint32(12, seq, true); v.setFloat64(16, seq * 16667, true); v.setUint32(24, 1, true);
  return b;
}
socket.onmessage({ data: packet(1, false) });
await new Promise(r => setImmediate(r));
socket.onmessage({ data: packet(2, true) });
await new Promise(r => setImmediate(r));
now += 2000; interval();
const metric = messages.find(m => m.status === 'pipeline-metrics');
assert.equal(metric.receivedPackets, 2);
assert.equal(metric.outputFrames, 1);
assert.equal(metric.dropped, 1);
assert.equal(metric.maxDecodeMs, 7);
assert.equal(metric.pendingPackets, 0);
assert.equal(messages.find(m => m.type === 'frame').outputEpochMs, 1107);
assert.equal(messages.find(m => m.status === 'decoder-configured').actualDecoderBackend, 'not-exposed-by-webcodecs');
now += 2000; interval();
assert.equal(messages.at(-1).outputFrames, 0, 'stalls must still emit metrics');
self.onmessage({ data: { type: 'close' } });
assert.equal(interval, null, 'closing must stop the diagnostics timer');
console.log('WebCodecs diagnostics: timing, keyframe wait, idle reporting and cleanup passed');
