import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import vm from 'node:vm';
import ts from 'typescript';

const handlers = {};
const linkFixtures = new Set();
const linkReadAttempts = [];
// Windows CI may not grant symlink creation. Model only the Dirent type while
// retaining real local files and reads, so the same exclusion test always runs.
const listingFs = { ...fs, promises: { ...fs.promises,
  async readdir(directory, options) {
    const entries = await fs.promises.readdir(directory, options);
    if (!options?.withFileTypes) return entries;
    return entries.map(entry => linkFixtures.has(path.join(directory, entry.name))
      ? { ...entry, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true }
      : entry);
  },
  async readFile(file, ...args) {
    if (linkFixtures.has(file)) linkReadAttempts.push(file);
    return fs.promises.readFile(file, ...args);
  },
} };
function writeLinkFixture(target, link) {
  fs.copyFileSync(target, link);
  linkFixtures.add(link);
}
function load(file, dependencies = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, { exports, process, console: { ...console, log() {} }, setTimeout, clearTimeout,
    require(name) { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; } });
  return exports;
}
const constants = load('shared/constants/recordPoints.ts');
const parser = load('electron/domains/recording/recordCsvParser.ts', { '../../../shared/constants/recordPoints': constants });
const index = load('electron/domains/recording/recordPointsIndex.ts', {
  '../../../shared/domain/fixationDetection': load('shared/domain/fixationDetection.ts'),
  'node:fs': fs, 'node:path': path,
  '../../platform/fs/atomicWrite': load('electron/platform/fs/atomicWrite.ts', { 'node:fs': fs }),
  './recordBlinkIntervals': load('electron/domains/recording/recordBlinkIntervals.ts'),
  '../../../shared/constants/recordPoints': constants, './recordCsvParser': parser,
});
const profiles = load('src/features/recording/device/deviceProfile.ts');
const mapping = load('src/features/records/domain/recordingsMapping.ts', {
  '@shared/domain/timeline': load('shared/domain/timeline.ts'),
  '@shared/domain/calibrationScores': load('shared/domain/calibrationScores.ts'),
});
const recordModalities = load('shared/domain/recordModalities.ts');
const rendererLoader = load('src/features/records/domain/recordingsLoader.ts', {
  '@/features/records/domain/recordingsMapping': mapping,
  '@/infrastructure/electron/ipcClient': { ipcClient: {
    loadRecordings: payload => handlers['load-recordings']({}, payload),
  } },
});
load('electron/domains/recording/recordMetadataHandlers.ts', {
  electron: { ipcMain: { handle(name, handler) { handlers[name] = handler; } } },
  'node:fs': fs, 'node:path': path,
  '../filesystem/pathValidation': { validateUtf8Path: async () => ({ ok: true }) },
  '../../../shared/domain/calibrationScores': load('shared/domain/calibrationScores.ts'),
}).registerRecordMetadataHandlers({ normalizeDataSamplingRateHz: Number });
load('electron/domains/recording/recordingListHandlers.ts', {
  electron: { ipcMain: { handle(name, handler) { handlers[name] = handler; } } },
  'node:fs': listingFs, 'node:path': path, 'node:crypto': crypto, 'node:readline': readline,
  '../../../shared/domain/calibrationScores': load('shared/domain/calibrationScores.ts'),
  './recordPointsModel': { ...index, ...parser },
}).registerRecordingListHandlers({
  buildLocalResourceUrl: async value => value,
  normalizeDataSamplingRateHz: Number,
  normalizeProjectDeviceType: profiles.normalizeDeviceType,
  normalizeProjectDeviceModel: profiles.normalizeDeviceModel,
  probeMediaDurationSeconds: async () => undefined,
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huahong-record-list-'));
const directory = path.join(root, 'recordings');
const summaryPath = path.join(root, '.config', 'recordings-summary.json');
const primary = 'huahong_4d5c12ef4f5e';
const timestamp = new Date(2026, 9, 19, 15, 39, 46);
const meta = (model = 'HH_ET28', patch = {}) => ({
  productIntegration: true, deviceModel: model, deviceType: model === 'HH_ET10C' ? '桌面式' : '眼镜式',
  status: 'complete', subjectName: '张三', durationSeconds: 29.9, samplingRateHz: 119.8, validityPercent: 93,
  encodedWidth: 1920, encodedHeight: 1080, ...patch,
});
function writeRecord(name, metadata, extensions = ['mp4', 'csv']) {
  for (const extension of extensions) {
    const file = path.join(directory, `${name}.${extension}`);
    fs.writeFileSync(file, extension === 'csv' ? 'timestamp,gaze_x,gaze_y\n0,0.5,0.5\n' : 'metadata-only list fixture');
    fs.utimesSync(file, timestamp, timestamp);
  }
  if (metadata !== undefined) fs.writeFileSync(path.join(directory, `${name}.meta.json`),
    typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
}
const read = async () => {
  const result = await handlers['load-recordings']({}, { projectDir: root });
  assert.equal(result.ok, true);
  return result;
};
try {
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ deviceModel: 'HH_ET28', deviceType: '眼镜式' }));
  writeRecord(primary, meta('HH_ET28', { video_path: '/outside/must-not-be-used.mp4', csv_path: '../outside.csv' }));
  const first = await read();
  assert.equal(first.records.length, 1, 'The actual saved huahong_UUID MP4/CSV must appear in the existing list');
  const saved = first.records[0];
  assert.equal(saved.id, `rec_${primary}`);
  assert.equal(saved.name, primary);
  assert.equal(saved.subjectName, '张三');
  assert.equal(saved.timestamp, '2026-10-19 15:39:46');
  assert.equal(saved.mp4Path, path.join(directory, `${primary}.mp4`));
  assert.equal(saved.csvPath, path.join(directory, `${primary}.csv`));
  assert.equal(saved.deviceModel, 'HH_ET28');
  assert.equal(saved.deviceType, '眼镜式');
  assert.equal(saved.videoWidth, 1920);
  assert.equal(saved.videoHeight, 1080);
  assert.equal(saved.durationSeconds, 29.9);
  assert.equal(saved.modalities['eye-tracking'].status, 'complete');
  const cached = await read();
  assert.equal(cached.summaryCacheHit, true);
  assert.deepEqual(JSON.parse(JSON.stringify(cached.records)), JSON.parse(JSON.stringify(first.records)));

  // The previous scanner could cache an empty list for these exact same files.
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  assert.equal(summary.version, 10);
  for (const version of [7, 8]) {
    fs.writeFileSync(summaryPath, JSON.stringify({ ...summary, version, records: [] }));
    const afterUpgrade = await read();
    assert.equal(afterUpgrade.summaryCacheHit, false);
    assert.equal(afterUpgrade.records.length, 1, 'Old summaries must not hide existing recordings after upgrading');
  }

  const et10 = 'huahong_111111111111';
  const csvOnly = 'huahong_222222222222';
  const videoOnly = 'huahong_333333333333';
  const failed = 'huahong_444444444444';
  const mixedCase = 'huahong_dddddddddddd';
  writeRecord(et10, meta('HH_ET10C'));
  writeRecord(csvOnly, meta(), ['csv']);
  fs.renameSync(path.join(directory, `${csvOnly}.csv`), path.join(directory, `${csvOnly}.CSV`));
  writeRecord(videoOnly, meta('HH_ET28', { status: 'preparing' }), ['mp4']);
  writeRecord(failed, meta('HH_ET28', { status: 'failed', error: 'encoder failed' }));
  writeRecord(mixedCase, meta());
  fs.renameSync(path.join(directory, `${mixedCase}.csv`), path.join(directory, `${mixedCase.toUpperCase()}.CSV`));
  fs.renameSync(path.join(directory, `${mixedCase}.meta.json`), path.join(directory, `${mixedCase.toUpperCase()}.META.JSON`));
  writeRecord('王五_20261019_153000', undefined);
  writeRecord('pupil_abcdefabcdef_20261019_153100', meta('PupilCore'));
  writeRecord('huahong_abcdefabcdef_20261019_153200', meta('HH_ET28'));
  const excluded = [
    ['huahong_555555555555', '{broken'],
    ['huahong_666666666666', undefined],
    ['huahong_777777777777', meta('Pro')],
    ['huahong_888888888888', meta('HH_ET28', { productIntegration: false })],
    ['huahong_999999999999', []],
    ['unrelated', meta()],
    ['pupil_aaaaaaaaaaaa', meta('PupilCore')],
  ];
  for (const [name, metadata] of excluded) writeRecord(name, metadata);
  const linkedMeta = 'huahong_bbbbbbbbbbbb';
  writeRecord(linkedMeta, undefined);
  writeLinkFixture(path.join(directory, `${primary}.meta.json`), path.join(directory, `${linkedMeta}.meta.json`));
  const mediaLink = 'huahong_cccccccccccc';
  writeRecord(mediaLink, meta(), []);
  writeLinkFixture(path.join(directory, `${primary}.mp4`), path.join(directory, `${mediaLink}.mp4`));

  const beforeRead = Object.fromEntries(fs.readdirSync(directory).map(name => [name, fs.readFileSync(path.join(directory, name), 'utf8')]));
  const mixed = await read();
  assert.equal(mixed.summaryCacheHit, false, 'New artifacts must invalidate the prior summary');
  assert.equal(mixed.records.length, 9);
  const byName = new Map(mixed.records.map(record => [record.name, record]));
  for (const [name] of excluded) assert.equal(byName.has(name), false, `${name} must not be inferred as an integrated Huahong recording`);
  assert.equal(byName.has(linkedMeta), false, 'Metadata links must not expand discovery outside ordinary local files');
  assert.equal(byName.has(mediaLink), false);
  assert.equal(byName.get(et10).deviceType, '桌面式');
  assert.equal(byName.get(et10).deviceModel, 'HH_ET10C');
  assert.equal(byName.get(csvOnly).modalities['eye-tracking'].status, 'partial');
  assert.match(byName.get(csvOnly).modalities['eye-tracking'].message, /缺少视频/);
  assert.equal(byName.get(csvOnly).mp4Path, undefined);
  assert.equal(byName.get(csvOnly).csvPath, path.join(directory, `${csvOnly}.CSV`));
  assert.equal(byName.get(videoOnly).modalities['eye-tracking'].status, 'partial');
  assert.match(byName.get(videoOnly).modalities['eye-tracking'].message, /缺少眼动 CSV/);
  assert.equal(byName.get(videoOnly).csvPath, undefined);
  assert.equal(byName.get(failed).modalities['eye-tracking'].status, 'failed');
  assert.equal(byName.get(failed).modalities['eye-tracking'].message, 'encoder failed');
  assert.equal(byName.get(mixedCase).id, `rec_${mixedCase}`);
  assert.equal(byName.get(mixedCase).csvPath, path.join(directory, `${mixedCase.toUpperCase()}.CSV`));
  assert.equal(byName.get(mixedCase).modalities['eye-tracking'].status, 'complete', 'Case differences must not split the same UUID pair');
  assert.equal(byName.get('王五_20261019_153000').id, 'rec_20261019_153000_王五');
  assert.equal(byName.get('pupil_abcdefabcdef_20261019_153100').deviceModel, 'PupilCore');
  assert.equal(byName.get('huahong_abcdefabcdef_20261019_153200').deviceModel, 'HH_ET28');
  for (const [name, contents] of Object.entries(beforeRead)) {
    assert.equal(fs.readFileSync(path.join(directory, name), 'utf8'), contents, 'Listing must not rewrite original media or metadata');
  }

  // Completion, subsequent refresh, and changes to the display name must preserve
  // the UUID-based identity used by selection, finalization recovery, and AOIs.
  const partialId = byName.get(videoOnly).id;
  writeRecord(videoOnly, meta('HH_ET28', { subjectName: '李四', durationSeconds: 35.1 }));
  const later = new Date(2026, 9, 19, 16, 0, 0);
  fs.utimesSync(path.join(directory, `${videoOnly}.mp4`), later, later);
  const refreshed = await read();
  assert.equal(refreshed.summaryCacheHit, false);
  const completed = refreshed.records.find(record => record.name === videoOnly);
  assert.equal(completed.id, partialId);
  assert.equal(completed.subjectName, '李四');
  assert.equal(completed.durationSeconds, 35.1);
  assert.equal(completed.modalities['eye-tracking'].status, 'complete');
  assert.equal(refreshed.records[0].id, partialId, 'UUID recordings sort with existing local timestamps');
  assert.equal((await read()).summaryCacheHit, true);

  const updated = await handlers['save-record-meta']({}, { projectDir: root, recordName: primary,
    meta: { subjectName: '修改后的姓名', calibrationLeftScore: 9, segments: [] } });
  assert.equal(updated.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, `${primary}.meta.json`), 'utf8')).productIntegration, true,
    'Existing metadata editing must retain the recorder source marker');
  let rendererRecords;
  await rendererLoader.loadRecordsForProject({ projectDir: root, setRecords(value) { rendererRecords = value; } });
  const eyeRecords = recordModalities.filterRecordsByModality(rendererRecords, 'eye-tracking');
  assert.equal(eyeRecords.length, 9, 'The actual renderer loader, mapper and modality filter must retain the discovered records');
  assert.equal(recordModalities.filterRecordsByModality(rendererRecords, 'facial-expression').length, 0);
  const edited = eyeRecords.find(record => record.name === primary);
  assert.equal(edited.id, saved.id, 'Metadata edits must retain the recording identity');
  assert.equal(edited.subjectName, '修改后的姓名');
  assert.equal(edited.mp4Path, saved.mp4Path);
  assert.equal(edited.csvPath, saved.csvPath);
  assert.equal(edited.modalities['eye-tracking'].status, 'complete');
  assert.equal(eyeRecords.find(record => record.name === csvOnly).modalities['eye-tracking'].status, 'partial');
  assert.equal(linkReadAttempts.length, 0, 'The loader must exclude symbolic metadata entries before reading their contents');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('Huahong saved recordings appear through the production list handler: UUID/legacy names, local metadata, partial/error states, cache upgrade and refresh, stable IDs, unchanged originals.');
