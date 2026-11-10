// Read actual FFmpeg/CSV output from test_adapter.py through the production list handler.
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
const calibration = load('shared/domain/calibrationScores.ts');
load('electron/domains/recording/recordingListHandlers.ts', {
  electron: { ipcMain: { handle: (name, handler) => { handlers[name] = handler; } } },
  'node:fs': fs, 'node:path': path, 'node:crypto': crypto, 'node:readline': readline,
  '../../../shared/domain/calibrationScores': calibration,
  './recordPointsModel': { ...index, ...parser },
}).registerRecordingListHandlers({ buildLocalResourceUrl: async (value) => value,
  normalizeDataSamplingRateHz: Number, normalizeProjectDeviceType: profile.normalizeDeviceType,
  normalizeProjectDeviceModel: profile.normalizeDeviceModel, probeMediaDurationSeconds: async () => undefined });

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
assert.match(input.recordingId, /^huahong_[a-f0-9]{12}$/);
const result = await handlers['load-recordings']({}, { projectDir: input.projectDir });
assert.equal(result.ok, true);
assert.equal(result.records.length, 1, 'The producer\'s UUID-only MP4/CSV must appear as one recording');
const record = result.records[0];
assert.equal(record.name, input.recordingId);
assert.equal(record.id, `rec_${input.recordingId}`);
assert.equal(record.deviceModel, input.model);
assert.equal(record.deviceType, input.deviceType);
assert.equal(record.subjectName, '张三');
assert.equal(record.videoWidth, 16);
assert.equal(record.videoHeight, 16);
assert.ok(record.durationSeconds > 0);
assert.ok(record.samplingRateHz > 0);
assert.equal(record.validityPercent, 100);
assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
const directory = path.join(input.projectDir, 'recordings');
assert.equal(record.mp4Path, path.join(directory, `${input.recordingId}.mp4`));
assert.equal(record.mp4Url, record.mp4Path);
assert.equal(record.csvPath, path.join(directory, `${input.recordingId}.csv`));
assert.ok(fs.statSync(record.mp4Path).size > 0);
assert.ok(fs.statSync(record.csvPath).size > 0);
const modality = record.modalities['eye-tracking'];
assert.equal(modality.status, 'complete');
assert.equal(modality.recordingStatus, 'complete');
assert.equal(modality.sourcePath, record.mp4Path);
assert.equal(modality.dataPath, record.csvPath);

const metadata = JSON.parse(fs.readFileSync(path.join(directory, `${input.recordingId}.meta.json`), 'utf8'));
assert.equal(metadata.productIntegration, true);
assert.equal(metadata.videoVerified, true);
assert.equal(metadata.coordinateSpace, input.coordinateSpace);
assert.equal(metadata.deviceModel, record.deviceModel);
assert.equal(metadata.subjectName, record.subjectName);
assert.equal(metadata.durationSeconds, record.durationSeconds);
assert.equal(metadata.validityPercent, record.validityPercent);
if (input.calibrationQuality) {
  assert.equal(input.model, 'HH_ET28');
  assert.equal(metadata.calibrationVerified, true);
  assert.equal(metadata.calibrationProvider, 'HH_ET28');
  assert.deepEqual(metadata.calibrationQuality, input.calibrationQuality);
  assert.equal(metadata.calibrationLeftScore, input.calibrationLeftScore);
  assert.equal(metadata.calibrationRightScore, input.calibrationRightScore);
  assert.equal(record.calibrationScores.left, input.calibrationLeftScore);
  assert.equal(record.calibrationScores.right, input.calibrationRightScore);
  assert.deepEqual(JSON.parse(JSON.stringify(record.calibrationScores.et28Quality)), input.calibrationQuality);
  const { mapLoadedRecordings } = load('src/features/records/domain/recordingsMapping.ts', {
    '@shared/domain/timeline': load('shared/domain/timeline.ts'),
    '@shared/domain/calibrationScores': calibration,
  });
  const [mapped] = mapLoadedRecordings(JSON.parse(JSON.stringify([record])));
  assert.equal(mapped.calibrationScores.left, input.calibrationLeftScore);
  assert.equal(mapped.calibrationScores.right, input.calibrationRightScore);
  assert.deepEqual(JSON.parse(JSON.stringify(mapped.calibrationScores.et28Quality)), input.calibrationQuality);
}

// Follow the discovered dataPath through the actual replay parser; a valid
// boundary gaze remains usable even though physical pupil/3D fields are absent.
const lines = fs.readFileSync(modality.dataPath, 'utf8').trim().split(/\r?\n/);
const state = parser.makeCsvPointParserState(parser.parseCsvLineFast(lines[0]), {
  pointMode: 'gaze', pointSource: 'recommended', isGlassesMode: record.deviceType === '眼镜式',
  frameWidth: record.videoWidth, frameHeight: record.videoHeight,
});
const points = lines.slice(1).map(line => parser.parseCsvPartsToHeatmapPoint(parser.parseCsvLineFast(line), state)).filter(Boolean);
assert.equal(points.length, 1);
assert.equal(points[0].x, 0);
assert.equal(points[0].y, 0.75);
assert.equal(points[0].timestamp, 0);
assert.equal(points[0].pupilDiameter, undefined);
console.log(`${input.model}: verified MP4/CSV is discoverable with complete metadata and replayable recommended gaze.`);
