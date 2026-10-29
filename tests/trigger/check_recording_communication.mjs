import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { SerialPortMock } from 'serialport';
const require = createRequire(import.meta.url);
const modules = new Map();
function load(file) {
  file = path.resolve(file);
  if (modules.has(file)) return modules.get(file);
  const module = { exports: {} }; modules.set(file, module.exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { module, exports: module.exports, process, console, performance, Buffer, setTimeout, clearTimeout,
    require(name) { return name.startsWith('.') ? load(path.resolve(path.dirname(file), `${name}.ts`)) : require(name); } }, { filename: file });
  return module.exports;
}
const { RecordingCommunicationService, encodeCommunicationPayload } = load('electron/domains/trigger/recordingCommunicationService.ts');
const { CommunicationJournal } = load('electron/domains/trigger/communicationJournal.ts');
const { DEFAULT_TRIGGER_NETWORK_CONFIG, normalizeTriggerNetworkConfig } = load('electron/domains/trigger/triggerConfiguration.ts');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mrt-communication-')));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for (let n = 0; n < 100; n++) { if (predicate()) return; await pause(5); } throw Error('condition timeout'); }
let next = 0;
function context(overrides = {}) {
  const recordingId = `record-${++next}`; const dir = path.join(root, `${recordingId}.pupil`); fs.mkdirSync(dir);
  return { recordingId, generation: next, journalPath: path.join(dir, 'communication-capture.jsonl'),
    videoTimeOffsetMs: 123, clockUncertaintyMs: 0.5, ...overrides };
}
const config = overrides => ({ ...DEFAULT_TRIGGER_NETWORK_CONFIG, ...overrides });
const rows = ctx => fs.readFileSync(ctx.journalPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const status = ctx => JSON.parse(fs.readFileSync(path.join(path.dirname(ctx.journalPath), 'communication-capture-status.json'), 'utf8'));
function events(service, ctx) { const result = service.read({ context: ctx, maxEvents: 256 }); assert.equal(result.ok, true); return result.events; }
async function bind(socket) { await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve); }); return socket.address().port; }
async function freePort() { const socket = dgram.createSocket('udp4'); const port = await bind(socket); await new Promise(resolve => socket.close(resolve)); return port; }

try {
  // Exact payload preservation, including empty data and invalid UTF-8.
  for (const original of [Buffer.alloc(0), Buffer.from('中文\n\r\t"\\'), Buffer.from([0xff, 0x00, 0xc3])]) {
    const encoded = encodeCommunicationPayload(original); assert.equal(encoded.includes('\n'), false);
    const value = JSON.parse(encoded); assert.deepEqual(Buffer.from(value.data, value.encoding === 'base64' ? 'base64' : 'utf8'), original);
  }
  assert.equal(normalizeTriggerNetworkConfig({}).serialEnabled, false);
  for (const invalid of [{ udpSendPort: NaN }, { udpReceivePort: 0 }, { targetIp: 'bad' }, { serialEnabled: true },
    { serialPath: 'bad\npath' }, { serialBaudRate: Infinity }, { serialDataBits: 3 }, { serialParity: 'bad' }]) {
    assert.throws(() => normalizeTriggerNetworkConfig(invalid));
  }
  const badContext = context(); assert.throws(() => new CommunicationJournal({ ...badContext, journalPath: path.join(root, 'arbitrary.jsonl') }));
  const journal = new CommunicationJournal(badContext); journal.close();
  fs.writeFileSync(badContext.journalPath, 'existing'); assert.throws(() => new CommunicationJournal(badContext));
  const symlinkContext = context();
  if (process.platform === 'win32') {
    // Directory junctions exercise the same no-link rule without requiring
    // Windows Developer Mode / SeCreateSymbolicLinkPrivilege on CI workers.
    fs.rmdirSync(path.dirname(symlinkContext.journalPath));
    fs.symlinkSync(path.dirname(badContext.journalPath), path.dirname(symlinkContext.journalPath), 'junction');
  } else fs.symlinkSync(badContext.journalPath, symlinkContext.journalPath);
  assert.throws(() => new CommunicationJournal(symlinkContext));

  // Actual OS UDP TX/RX, successful datagrams only, stable clock and durable-before-read.
  const remote = dgram.createSocket('udp4'); const remotePort = await bind(remote); const receivePort = await freePort();
  const received = []; remote.on('message', data => received.push(data.toString()));
  const ctx = context(); const service = new RecordingCommunicationService({ now: () => 500, epoch: () => 1000 });
  assert.equal((await service.configure({ context: ctx, config: config({ enabled: true, udpSendPort: remotePort, udpReceivePort: receivePort }) })).ok, true);
  assert.equal((await service.sendTrigger({ context: ctx, mark: 42 })).ok, true);
  await new Promise((resolve, reject) => remote.send(Buffer.from('receive\n中文'), receivePort, '127.0.0.1', error => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => remote.send(Buffer.alloc(0), receivePort, '127.0.0.1', error => error ? reject(error) : resolve()));
  await until(() => events(service, ctx).length === 3 && received.length === 1);
  assert.equal(received[0], '42'); assert.equal(rows(ctx).length, 3);
  for (const event of events(service, ctx)) { assert.equal(event.mainMonotonicMs, 500); assert.equal(event.videoTimeMs, 623); assert.equal(event.capturedAtEpochMs, 1000); }
  assert.equal(rows(ctx)[0].text, events(service, ctx)[0].payloadEnvelope);
  assert.equal(new Set(events(service, ctx).map(event => event.eventId)).size, 3);
  const first = events(service, ctx)[0].eventId;
  assert.equal(service.read({ context: ctx, ackEventIds: [first] }).pendingCount, 2);
  assert.equal(service.read({ context: { ...ctx, generation: 999 }, ackEventIds: events(service, ctx).map(event => event.eventId) }).ok, false);
  assert.equal(service.read({ context: ctx, maxEvents: 0 }).ok, false);
  assert.equal((await service.sendTrigger({ context: ctx, mark: NaN })).ok, false);
  assert.equal((await service.flushStop({ context: ctx })).stopped, true); assert.equal(status(ctx).status, 'stopped');
  assert.equal(rows(ctx).length, 3); assert.equal((await service.sendTrigger({ context: ctx, mark: 1 })).ok, false);
  const newer = context(); assert.equal((await service.configure({ context: newer, config: config() })).ok, true);
  assert.equal(events(service, newer).length, 0); assert.equal(service.read({ context: ctx }).ok, false);
  await service.shutdown(); await new Promise(resolve => remote.close(resolve));

  // Real SerialPort stream with the official mock binding: write/drain + echoed RX and binary chunks.
  SerialPortMock.binding.createPort('/dev/MRT-MOCK', { echo: true, record: true });
  let serial;
  const serialCtx = context(); const serialService = new RecordingCommunicationService({ createSerial: options => {
    serial = new SerialPortMock({ path: options.serialPath, baudRate: options.serialBaudRate, autoOpen: false, highWaterMark: 65536 }); return serial;
  }, listPorts: () => SerialPortMock.list() });
  assert.equal((await serialService.listSerialPorts()).ports.some(port => port.path === '/dev/MRT-MOCK'), true);
  assert.equal((await serialService.configure({ context: serialCtx, config: config({ serialEnabled: true, serialPath: '/dev/MRT-MOCK' }) })).ok, true);
  assert.equal((await serialService.sendTrigger({ mark: 65535 })).ok, true);
  await until(() => events(serialService, serialCtx).length === 2);
  serial.port.emitData(Buffer.from([0xff, 0x00, 0x01]));
  await until(() => events(serialService, serialCtx).length === 3);
  assert.equal(JSON.parse(events(serialService, serialCtx)[2].payloadEnvelope).encoding, 'base64');
  serial.emit('data', Buffer.alloc(70000, 120));
  assert.equal(events(serialService, serialCtx).length, 5);
  assert.deepEqual(events(serialService, serialCtx).slice(-2).map(event => JSON.parse(event.payloadEnvelope).data.length).join(','), '65536,4464');
  await serialService.flushStop({ context: serialCtx }); assert.equal(status(serialCtx).status, 'stopped');

  // Stop waits for submitted TX, ACK does not own durability, and failed sends create no success rows.
  class FakeSerial extends EventEmitter {
    isOpen = false;
    open(done) { this.isOpen = true; done(); }
    write(_data, done) { this.writeDone = done; }
    drain(done) { this.drainDone = done; }
    close(done) { this.isOpen = false; this.emit('close'); done(); }
  }
  const fake = new FakeSerial(); const pendingCtx = context();
  const pending = new RecordingCommunicationService({ createSerial: () => fake, timeoutMs: 100 });
  await pending.configure({ context: pendingCtx, config: config({ serialEnabled: true, serialPath: '/dev/fake' }) });
  const sending = pending.sendTrigger({ mark: 7 }); const stopping = pending.flushStop({ context: pendingCtx });
  fake.writeDone(); fake.drainDone(); assert.equal((await sending).ok, true); assert.equal((await stopping).stopped, true);
  assert.equal(rows(pendingCtx).length, 1);
  const broken = new FakeSerial(); const brokenCtx = context();
  const brokenService = new RecordingCommunicationService({ createSerial: () => broken, timeoutMs: 30 });
  await brokenService.configure({ context: brokenCtx, config: config({ serialEnabled: true, serialPath: '/dev/fake' }) });
  const badSend = brokenService.sendTrigger({ mark: 8 }); broken.emit('error', new Error('disconnected'));
  assert.equal((await badSend).ok, false); await brokenService.flushStop({ context: brokenCtx });
  assert.equal(rows(brokenCtx).length, 0); assert.equal(status(brokenCtx).status, 'error');
  const timeoutSerial = new FakeSerial(); const timeoutCtx = context();
  const timed = new RecordingCommunicationService({ createSerial: () => timeoutSerial, timeoutMs: 15 });
  await timed.configure({ context: timeoutCtx, config: config({ serialEnabled: true, serialPath: '/dev/fake' }) });
  assert.equal((await timed.sendTrigger({ mark: 9 })).ok, false); await timed.flushStop({ context: timeoutCtx });
  assert.equal(rows(timeoutCtx).length, 0); assert.equal(status(timeoutCtx).status, 'error');

  // Stop during an asynchronous open fences and closes the late serial handle.
  class DelayedSerial extends FakeSerial {
    open(done) { this.openDone = () => { this.isOpen = true; this.emit('open'); done(); }; }
  }
  const delayed = new DelayedSerial(); const delayedCtx = context();
  const delayedService = new RecordingCommunicationService({ createSerial: () => delayed, timeoutMs: 100 });
  const configuring = delayedService.configure({ context: delayedCtx, config: config({ serialEnabled: true, serialPath: '/dev/fake' }) });
  await until(() => !!delayed.openDone);
  const delayedStop = delayedService.flushStop({ context: delayedCtx });
  delayed.openDone(); assert.equal((await configuring).ok, false); assert.equal((await delayedStop).stopped, true);
  assert.equal(delayed.isOpen, false); assert.equal(rows(delayedCtx).length, 0);
  // A receiver bind failure is visible and leaves an error status for recovery.
  const occupied = dgram.createSocket('udp4'); const occupiedPort = await bind(occupied); const bindCtx = context();
  const bindService = new RecordingCommunicationService();
  assert.equal((await bindService.configure({ context: bindCtx, config: config({ enabled: true, udpReceivePort: occupiedPort }) })).ok, false);
  assert.equal(status(bindCtx).status, 'error'); assert.equal((await bindService.flushStop({ context: bindCtx })).stopped, true);
  await new Promise(resolve => occupied.close(resolve));

  // A close failure retains the owner and can be retried; no false stopped result.
  class RetryCloseSerial extends FakeSerial {
    attempts = 0;
    close(done) { if (this.attempts++ === 0) done(new Error('busy')); else super.close(done); }
  }
  const retryPort = new RetryCloseSerial(); const retryCtx = context();
  const retryService = new RecordingCommunicationService({ createSerial: () => retryPort });
  await retryService.configure({ context: retryCtx, config: config({ serialEnabled: true, serialPath: '/dev/fake' }) });
  assert.equal((await retryService.flushStop({ context: retryCtx })).ok, false);
  assert.equal(retryPort.isOpen, true); assert.equal(status(retryCtx).status, 'error');
  assert.equal((await retryService.configure({ context: context(), config: config() })).ok, false);
  assert.equal((await retryService.flushStop({ context: retryCtx })).stopped, true);
  assert.equal(retryPort.isOpen, false); assert.equal(status(retryCtx).status, 'error');

  // Failed configure cannot hide an open resource from the renderer cleanup guard.
  class FailedConfigureSerial extends RetryCloseSerial {
    open(done) { this.isOpen = true; done(new Error('open result uncertain')); }
  }
  const failedConfigPort = new FailedConfigureSerial(); const failedConfigCtx = context();
  const failedConfigService = new RecordingCommunicationService({ createSerial: () => failedConfigPort });
  const failedConfigResult = await failedConfigService.configure({ context: failedConfigCtx, config: config({ serialEnabled: true, serialPath: '/dev/fake' }) });
  assert.equal(failedConfigResult.ok, false); assert.equal(failedConfigResult.cleanupPending, true); assert.equal(failedConfigPort.isOpen, true);
  assert.equal((await failedConfigService.flushStop({ context: failedConfigCtx })).stopped, true);
  assert.equal((await new RecordingCommunicationService().flushStop({ context: failedConfigCtx })).stopped, true);
  assert.equal((await failedConfigService.flushStop({ context: { ...failedConfigCtx, generation: 123456 } })).stopped, true);
  // Timed-out open remains owned until its eventual callback closes the late handle.
  const lateOpen = new DelayedSerial(); const lateCtx = context();
  const lateService = new RecordingCommunicationService({ createSerial: () => lateOpen, timeoutMs: 15 });
  const lateConfigure = await lateService.configure({ context: lateCtx, config: config({ serialEnabled: true, serialPath: '/dev/fake' }) });
  assert.equal(lateConfigure.cleanupPending, true);
  assert.equal((await lateService.flushStop({ context: lateCtx })).ok, false);
  lateOpen.openDone(); await until(() => !lateOpen.isOpen && lateService.read({ context: lateCtx }).stopped);
  assert.equal((await lateService.flushStop({ context: lateCtx })).stopped, true);
  assert.equal(rows(lateCtx).length, 0); assert.equal(status(lateCtx).status, 'error');

  // Queue overflow stops capture visibly; the triggering event is still in the durable journal.
  const overflowSerial = new FakeSerial(); const overflowCtx = context();
  const overflow = new RecordingCommunicationService({ createSerial: () => overflowSerial, maxEvents: 1 });
  await overflow.configure({ context: overflowCtx, config: config({ serialEnabled: true, serialPath: '/dev/fake' }) });
  overflowSerial.emit('data', Buffer.from('a')); overflowSerial.emit('data', Buffer.from('b')); overflowSerial.emit('data', Buffer.from('c'));
  const overflowResult = await overflow.flushStop({ context: overflowCtx });
  assert.equal(overflowResult.events.length, 1); assert.equal(rows(overflowCtx).length, 2); assert.equal(status(overflowCtx).status, 'error');
  assert.ok(overflowResult.errors.some(message => message.includes('上限')));
  // A journal disk error is explicit and no undurable event is exposed as success.
  const diskSerial = new FakeSerial(); const diskCtx = context(); const statuses = [];
  const disk = new RecordingCommunicationService({ createSerial: () => diskSerial, createJournal: () => ({
    append() { throw Error('disk full'); }, status(state, errors) { statuses.push([state, ...errors]); }, close() {},
  }) });
  await disk.configure({ context: diskCtx, config: config({ serialEnabled: true, serialPath: '/dev/fake' }) });
  diskSerial.emit('data', Buffer.from('unwritten'));
  const diskResult = await disk.flushStop({ context: diskCtx });
  assert.equal(diskResult.events.length, 0); assert.ok(diskResult.errors.some(message => message.includes('disk full')));
  assert.equal(statuses.at(-1)[0], 'error');
  console.log('recording communication: UDP loopback, serial mock, durable journal, ACK fencing, shutdown, errors and payload checks passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
