import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  vm.runInNewContext(source, { exports, console, performance, setTimeout, clearTimeout, ...globals,
    require(name) { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; } });
  return exports;
}
const clock = load('shared/domain/communicationClock.ts');
const { createRecordingCommunicationBridge } = load('src/features/recording/domain/recordingCommunication.ts', {
  '@/infrastructure/electron/ipcClient': { ipcClient: {} }, '@shared/domain/communicationClock': clock,
}, { setTimeout: () => 1, clearTimeout() {} });
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  let time = 0;
  let disconnected = false;
  let failStop = false;
  const calls = [], notices = [], stored = new Map();
  const events = [{ eventId: 'true-io-1', recordingId: 'pupil_test', generation: 7,
    channel: 'udp_receive', mainMonotonicMs: 10100, videoTimeMs: 100,
    payloadEnvelope: JSON.stringify({ encoding: 'utf-8', data: 'a\r\n\t\0中' }) }];
  const port = {
    async readRecordingCommunicationClock() { const value = time + 1 + 10000; time += 2; return { ok: true, mainMonotonicMs: value }; },
    async configureRecordingCommunication(input) { calls.push(['configure', input]); return { ok: true }; },
    async readRecordingCommunication({ ackEventIds = [] }) {
      for (const id of ackEventIds) { assert.ok(stored.has(id)); const index = events.findIndex(event => event.eventId === id); if (index >= 0) events.splice(index, 1); }
      calls.push(['read', ackEventIds]);
      return { ok: true, events: [...events], pendingCount: events.length, stopped: false, errors: [] };
    },
    async flushStopRecordingCommunication() {
      calls.push(['stop-io']);
      if (failStop) { failStop = false; return { ok: false, message: 'close failed' }; }
      return { ok: true, events: [...events], pendingCount: events.length, stopped: true, errors: [] };
    },
  };
  const bridge = createRecordingCommunicationBridge(port, () => time);
  const command = async (id, args) => {
    if (id === 'get_source_clock') {
      const stamp = 500 + (time + 1) / 1000; time += 2;
      return { ok: true, response: { source_time_s: stamp, source_time_origin_s: 500, recording_id: 'pupil_test', generation: 7 } };
    }
    calls.push(['persist', args]);
    if (disconnected) return { ok: false, error: 'socket closed' };
    stored.set(args.event_id, args);
    return { ok: true };
  };
  return { bridge, port, calls, notices, stored, events,
    start: overrides => bridge.start({ recordingId: 'pupil_test', journalPath: '/project/pupil_test.pupil/communication-capture.jsonl',
      config: { enabled: true }, command, onError: message => notices.push(message), ...overrides }),
    disconnect: () => { disconnected = true; }, failNextStop: () => { failStop = true; } };
}

{
  const h = harness();
  await h.start(); await flush();
  const context = h.calls.find(call => call[0] === 'configure')[1].context;
  assert.ok(Math.abs(context.videoTimeOffsetMs + 10000) < 1e-8);
  assert.equal(context.clockUncertaintyMs, 2);
  const event = h.stored.get('true-io-1');
  assert.equal(event.video_time_ms, 100, 'Use the captured time, never receipt time.');
  assert.equal(JSON.parse(event.text).data, 'a\r\n\t\0中');
  await Promise.all([h.bridge.finish(), h.bridge.finish()]);
  assert.equal(h.calls.filter(call => call[0] === 'stop-io').length, 1);
  assert.equal(h.events.length, 0);
  assert.equal(h.bridge.isActive(), false);
  assert.equal(h.notices.length, 0);
}
{
  const h = harness(); h.disconnect();
  await h.start(); await flush();
  await h.bridge.finish();
  assert.equal(h.stored.size, 0);
  assert.equal(h.events.length, 1, 'Unacknowledged actual I/O remains in the durable capture owner.');
  assert.ok(h.notices.some(message => message.includes('本地通信日志恢复')));
  assert.equal(h.bridge.isActive(), false, 'A closed socket cannot prevent I/O shutdown and disk recovery.');
}
{
  const h = harness(); await h.start(); h.failNextStop();
  await assert.rejects(h.bridge.finish(), /close failed/);
  await h.bridge.finish();
  assert.equal(h.calls.filter(call => call[0] === 'stop-io').length, 2, 'Failed stop remains retryable.');
}
{
  const h = harness();
  await assert.rejects(h.start({ isCurrent: () => false }), /取消/);
  assert.equal(h.calls.filter(call => call[0] === 'configure').length, 0);
}
{
  const h = harness(); let checks = 0;
  await assert.rejects(h.start({ isCurrent: () => ++checks === 1 }), /取消/);
  assert.equal(h.calls.filter(call => call[0] === 'stop-io').length, 1);
}
{
  const h = harness();
  let configured;
  h.port.configureRecordingCommunication = () => new Promise(resolve => { configured = resolve; });
  const starting = h.start();
  const rejected = assert.rejects(starting, /取消/);
  await flush();
  let stopped = false;
  const stopping = h.bridge.finish().then(() => { stopped = true; });
  await flush();
  assert.equal(stopped, false, 'Stop must not pass an in-flight main-process port open.');
  configured({ ok: true });
  await Promise.all([rejected, stopping]);
  assert.equal(h.calls.filter(call => call[0] === 'stop-io').length, 1);
  assert.equal(h.bridge.hasSession(), false);
}
{
  const h = harness();
  h.port.configureRecordingCommunication = async () => ({ ok: false, message: 'open failed; close pending', cleanupPending: true });
  await assert.rejects(h.start(), /close pending/);
  assert.equal(h.bridge.hasSession(), true, 'Failed configure still owns its unresolved ports.');
  h.failNextStop();
  await assert.rejects(h.bridge.finish(), /close failed/);
  assert.equal(h.bridge.hasSession(), true);
  await h.bridge.finish();
  assert.equal(h.bridge.hasSession(), false);
}
{
  const h = harness();
  h.port.configureRecordingCommunication = async () => { throw new Error('IPC response lost'); };
  await assert.rejects(h.start(), /IPC response lost/);
  assert.equal(h.bridge.hasSession(), true);
  await h.bridge.finish();
  assert.equal(h.calls.filter(call => call[0] === 'stop-io').length, 1);
}
{
  const valid = { sourceTimeS: 10, sourceTimeOriginS: 9, recordingId: 'r', generation: 1, beforeMs: 0, afterMs: 2 };
  const main = { mainMonotonicMs: 100, beforeMs: 2, afterMs: 4 };
  assert.throws(() => clock.alignCommunicationClock('r', [valid, { ...valid, generation: 2 }], [main]), /会话/);
  assert.throws(() => clock.alignCommunicationClock('r', [{ ...valid, sourceTimeOriginS: 11 }], [main]), /会话/);
  assert.throws(() => clock.alignCommunicationClock('r', [{ ...valid, afterMs: 1000 }], [main]), /延迟/);
  const chosen = clock.alignCommunicationClock('r', [{ ...valid, afterMs: 200 }, valid], [main]);
  assert.equal(chosen.clockUncertaintyMs, 2, 'Select the measured minimum RTT, not the last response.');
}
console.log('PASS communication clock, byte preservation, exact ACK, cancellation, idempotent stop, retry and socket-loss recovery');
