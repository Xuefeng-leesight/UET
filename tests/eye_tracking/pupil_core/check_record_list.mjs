// Read a runtime-test recording through the actual Electron list handler.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const handlers = {};
function load(file, dependencies = {}) {
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(js, { exports, process, console, setTimeout, clearTimeout, require: (name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`);
    return dependencies[name];
  } }, { filename: file, timeout: 1000 });
  return exports;
}
const constants = load('shared/constants/recordPoints.ts');
const parser = load('electron/domains/recording/recordCsvParser.ts', { '../../../shared/constants/recordPoints': constants });
const index = load('electron/domains/recording/recordPointsIndex.ts', { 'node:fs': fs, 'node:path': path,
  '../../../shared/domain/fixationDetection': load('shared/domain/fixationDetection.ts'),
  '../../platform/fs/atomicWrite': load('electron/platform/fs/atomicWrite.ts', { 'node:fs': fs }),
  './recordBlinkIntervals': load('electron/domains/recording/recordBlinkIntervals.ts'),
  '../../../shared/constants/recordPoints': constants, './recordCsvParser': parser });
const profile = load('src/features/recording/device/deviceProfile.ts');
const list = load('electron/domains/recording/recordingListHandlers.ts', {
  electron: { ipcMain: { handle: (name, handler) => { handlers[name] = handler; } } },
  'node:fs': fs, 'node:path': path, 'node:crypto': crypto, 'node:readline': readline,
  '../../../shared/domain/calibrationScores': load('shared/domain/calibrationScores.ts'),
  './recordPointsModel': { ...index, ...parser },
});
list.registerRecordingListHandlers({ buildLocalResourceUrl: async (p) => p,
  normalizeDataSamplingRateHz: Number, normalizeProjectDeviceType: profile.normalizeDeviceType,
  normalizeProjectDeviceModel: profile.normalizeDeviceModel, probeMediaDurationSeconds: async () => undefined });
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const result = await handlers['load-recordings']({}, { projectDir: input.projectDir });
assert.equal(result.ok, true);
const record = result.records.find((item) => item.name === input.recordingId);
assert.ok(record, 'Runtime recording must appear in existing MRT list');
assert.equal(record.deviceModel, 'PupilCore');
assert.equal(record.deviceType, '眼镜式');
assert.equal(record.subjectName, '张三');
assert.ok(record.durationSeconds > 0);
assert.equal(record.videoWidth, 64);
assert.equal(record.videoHeight, 48);
assert.equal(record.timelineMarkers.length, 2);
assert.equal(record.calibrationScores.pupilScores.training.metrics.left.qualityScore, 9);
assert.equal(record.calibrationScores.pupilScores.training.metrics.right.qualityScore, 8);
console.log('Runtime MP4/CSV is discoverable in the existing MRT recording list.');
