import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { exports, console, Buffer, Uint8Array, ArrayBuffer, Error, setTimeout, clearTimeout, ...globals,
    require: (name) => { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; } }, { filename: file });
  return exports;
}
const syncModule = load('shared/domain/pupilAudioSync.ts');
const first = { sourceTimeS: 10, midpointMs: 1000, roundTripMs: 10, generation: 1, recordingId: 'audio', sourceTimeOriginS: 10 };
const last = { ...first, sourceTimeS: 20, midpointMs: 11000 };
const sync = syncModule.calculatePupilAudioSync({ first, last, startedMs: 1250, stoppedMs: 10250, audioDurationS: 9 });
assert.equal(sync.offsetSeconds, .25);
assert.equal(sync.tempo, 1);
assert.equal(sync.hardwareLatencyMeasured, false);
assert.ok(syncModule.pupilAudioFilter({ ...sync, offsetSeconds: -.2 }).includes('atrim=start=0.200000'));
assert.throws(() => syncModule.calculatePupilAudioSync({ first, last: { ...last, generation: 2 }, startedMs: 1250, stoppedMs: 10250, audioDurationS: 9 }));
assert.throws(() => syncModule.calculatePupilAudioSync({ first, last: { ...last, roundTripMs: 500 }, startedMs: 1250, stoppedMs: 10250, audioDurationS: 9 }));
assert.throws(() => syncModule.pupilAudioFilter({ ...sync, tempo: 0 }));

// Exercise the real renderer lifecycle without microphone hardware.
let rendererNow = 1000;
const rendererAudio = load('src/features/recording/domain/audioRecording.ts', {
  '@/infrastructure/electron/ipcClient': { ipcClient: {
    startRecordingAudio: async () => ({ ok: true, sessionId: 'renderer' }),
    appendRecordingAudio: async () => ({ ok: true }),
    abortRecordingAudio: async () => ({ ok: true }),
    finishRecordingAudio: async payload => payload.synchronizationError
      ? ({ ok: false, message: 'clock failed; retained audio' }) : ({ ok: true, videoPath: 'audio.mp4' }),
  } },
  '@shared/domain/pupilAudioSync': syncModule,
}, { performance: { now: () => rendererNow } });
function prepared() {
  const listeners = new Map();
  return { stream: {}, setting: { label: 'mic' }, cleanup() {}, audioClock: () => rendererNow / 1000,
    recorder: { state: 'inactive', mimeType: 'audio/webm', starts: 0,
      addEventListener: (name, fn) => listeners.set(name, fn),
      start() { this.state = 'recording'; this.starts++; },
      stop() { this.state = 'inactive'; listeners.get('stop')?.(); },
    } };
}
let sampleCount = 0;
await rendererAudio.startPreparedAudioRecording(prepared(), 'audio.mp4', async () => {
  if (++sampleCount > 1) throw new Error('source disconnected');
  return first;
});
rendererNow = 2000;
const earlyStop = await rendererAudio.stopActiveAudioCapture();
assert.equal(earlyStop.ok, false);
assert.equal((await rendererAudio.stopActiveAudioRecording()).message, earlyStop.message,
  'Asynchronous capture stop errors must reach finalization notice');
let resolveClock;
const delayedClock = new Promise(resolve => { resolveClock = resolve; });
const cancelled = prepared();
const starting = rendererAudio.startPreparedAudioRecording(cancelled, 'audio.mp4', () => delayedClock);
await Promise.resolve();
await rendererAudio.stopActiveAudioCapture();
resolveClock(first);
await assert.rejects(starting, /取消/);
assert.equal(cancelled.recorder.starts, 0, 'A delayed clock response must not start audio after stop');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mrt-audio-contract-'));
const handlers = {};
const audio = load('electron/domains/recording/recordingAudioHandlers.ts', {
  electron: { app: { getPath: () => temp }, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } } },
  'node:crypto': crypto, 'node:fs': fs, 'node:path': path, '../../../shared/domain/pupilAudioSync': syncModule,
});
function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}
let muxCalls = 0;
const domain = audio.createRecordingAudioDomain({ findFfmpegBinary: () => 'ffmpeg', runCommand: async (_, args) => { muxCalls++; ffmpeg(args); } });
domain.registerHandlers();
try {
  const video = path.join(temp, 'audio.mp4');
  const meta = path.join(temp, 'audio.meta.json');
  const input = path.join(temp, 'microphone.webm');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=16x16:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:a', 'libopus', input]);
  const initial = { deviceModel: 'PupilCore', status: 'preparing', sourceTimeOriginS: 10 };
  fs.writeFileSync(meta, JSON.stringify(initial));
  async function start() {
    const result = await handlers['start-recording-audio']({}, { videoPath: video, mimeType: 'audio/webm' });
    assert.equal(result.ok, true);
    assert.equal((await handlers['append-recording-audio']({}, { sessionId: result.sessionId, chunk: fs.readFileSync(input) })).ok, true);
    return result.sessionId;
  }
  const sessionId = await start();
  const completing = handlers['finish-recording-audio']({}, { sessionId, pupilSync: sync });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(muxCalls, 0, 'Preparing metadata is not a finalized video');
  fs.writeFileSync(meta, JSON.stringify({ ...initial, status: 'complete', videoVerified: true }));
  const result = await completing;
  assert.equal(result.ok, true, result.message);
  assert.equal(muxCalls, 1);
  const written = JSON.parse(fs.readFileSync(meta, 'utf8'));
  assert.equal(written.audioSynchronization.offsetSeconds, .25);
  const pcm = ffmpeg(['-i', video, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1']);
  const peak = (start, end) => {
    let max = 0;
    for (let i = Math.round(start * 48000) * 2; i < Math.min(pcm.length, end * 48000 * 2); i += 2) max = Math.max(max, Math.abs(pcm.readInt16LE(i)));
    return max;
  };
  assert.ok(peak(0, .15) < 20, 'Audio must begin with measured delay, not at video zero');
  assert.ok(peak(.35, .6) > 1000, 'Actual AAC contains delayed microphone sound');
  assert.ok(pcm.length / 2 / 48000 >= 1.9, 'Audio padded to video duration');
  const failedId = await start();
  const failure = await handlers['finish-recording-audio']({}, { sessionId: failedId, synchronizationError: 'clock disconnected' });
  assert.equal(failure.ok, false);
  assert.equal(muxCalls, 1);
  assert.ok(fs.existsSync(path.join(temp, 'mrt-recording-audio', `${failedId}.webm`)), 'Failure preserves sole audio copy');
  fs.writeFileSync(meta, JSON.stringify({ deviceModel: 'Pro' }));
  const legacyId = await start();
  assert.equal((await handlers['finish-recording-audio']({}, { sessionId: legacyId })).ok, true, 'Legacy audio does not require Pupil sync');
  console.log('Audio clocks, preparing gate, actual delayed AAC, failure retention and legacy path verified.');
} finally {
  await domain.abortAll();
  fs.rmSync(temp, { recursive: true, force: true });
}
