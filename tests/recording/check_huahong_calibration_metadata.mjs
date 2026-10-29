import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Exercise the real metadata writer, list IPC, renderer mapping and score cell.
const root = process.cwd();
const requireNative = createRequire(import.meta.url);
const modules = new Map();
const handlers = {};
function load(relative) {
  const filename = path.resolve(root, relative);
  if (modules.has(filename)) return modules.get(filename);
  const exports = {};
  modules.set(filename, exports);
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(js, { exports, process, console: { ...console, log() {} }, Buffer, setTimeout, clearTimeout,
    require(specifier) {
      if (specifier === 'react') return React;
      if (specifier.startsWith('node:')) return requireNative(specifier);
      if (specifier === 'electron') return { ipcMain: { handle: (id, callback) => { handlers[id] = callback; } } };
      if (specifier === '@/app/i18n/useLanguage') return { useLanguage: () => ({ language: 'zh-CN' }) };
      if (specifier === '@/shared/ui/CustomSelect') return ({ children, value, onChange }) =>
        React.createElement('select', { value, onChange }, children);
      const base = specifier.startsWith('@shared/') ? path.join(root, 'shared', specifier.slice(8))
        : specifier.startsWith('@/') ? path.join(root, 'src', specifier.slice(2))
          : specifier.startsWith('.') ? path.resolve(path.dirname(filename), specifier) : null;
      assert.ok(base?.startsWith(`${root}${path.sep}`), `Unexpected dependency: ${specifier}`);
      const target = ['.ts', '.tsx'].map(suffix => `${base}${suffix}`).find(fs.existsSync);
      assert.ok(target, `Missing production dependency: ${specifier}`);
      return load(target);
    },
  }, { filename, timeout: 1000 });
  return exports;
}
const shared = load('shared/domain/calibrationScores.ts');
const profile = load('src/features/recording/device/deviceProfile.ts');
load('electron/domains/recording/recordMetadataHandlers.ts').registerRecordMetadataHandlers({ normalizeDataSamplingRateHz: Number });
load('electron/domains/recording/recordingListHandlers.ts').registerRecordingListHandlers({
  buildLocalResourceUrl: async file => file, normalizeDataSamplingRateHz: Number,
  normalizeProjectDeviceType: profile.normalizeDeviceType, normalizeProjectDeviceModel: profile.normalizeDeviceModel,
  probeMediaDurationSeconds: async () => undefined,
});
const { mapLoadedRecordings } = load('src/features/records/domain/recordingsMapping.ts');
const RecordsListPage = load('src/features/records/RecordsListPage.tsx').default;
const json = value => JSON.parse(JSON.stringify(value));
const eye = scores => ({ count: scores.length, truncated: false,
  points: scores.map((score, index) => ({ index: index + 1, status: index === 1 ? 1 : 0,
    score, bias: [index === 1 ? null : 0.001, -0.002] })) });
const quality = { version: 1, provider: 'HH_ET28', aggregation: 'arithmetic_mean',
  left: eye([100, 97, 101]), right: eye([99, 99, 100]) };
const base = { deviceModel: 'HH_ET28', deviceType: '眼镜式', calibrationProvider: 'HH_ET28',
  calibrationVerified: true, productIntegration: true, status: 'complete', subjectName: '张三',
  durationSeconds: 29.9, samplingRateHz: 120, validityPercent: 99, encodedWidth: 1920, encodedHeight: 1080 };
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mrt-huahong-calibration-meta-'));
const recordings = path.join(directory, 'recordings');
const metaPath = name => path.join(recordings, `${name}.meta.json`);
const readMeta = name => JSON.parse(fs.readFileSync(metaPath(name), 'utf8'));
function writeRecord(name, metadata) {
  fs.writeFileSync(path.join(recordings, `${name}.mp4`), 'List fixture; real encoder coverage is in test_adapter.py.');
  fs.writeFileSync(path.join(recordings, `${name}.csv`), 'timestamp,source_model,recom_gaze_x,recom_gaze_y,recom_gaze_bit_mask\n0,HH_ET28,0.2,0.3,1\n');
  fs.writeFileSync(metaPath(name), JSON.stringify(metadata));
}
async function save(name, meta) {
  const before = json(meta);
  const result = await handlers['save-record-meta']({}, { projectDir: directory, recordName: name, meta });
  assert.equal(result.ok, true);
  assert.deepEqual(meta, before, 'The IPC input must not be mutated while preserving recorder metadata');
  return readMeta(name);
}
async function list() {
  const result = await handlers['load-recordings']({}, { projectDir: directory });
  assert.equal(result.ok, true);
  return mapLoadedRecordings(json(result.records));
}
try {
  fs.mkdirSync(recordings);
  fs.mkdirSync(path.join(directory, 'monitor'));
  fs.writeFileSync(path.join(directory, 'project.json'), JSON.stringify({ deviceModel: 'HH_ET28', deviceType: '眼镜式' }));
  // A later monitor calibration is deliberately different from this recording.
  fs.writeFileSync(path.join(directory, 'monitor/calibration_result.json'), JSON.stringify({ latest: {
    scores: { left: 8, right: 9 }, calibrationQuality: { ...quality, left: eye([80, 80, 80]) },
  } }));
  const current = 'huahong_012345abcdef';
  const legacy = 'huahong_111111111111';
  writeRecord(current, { ...base, calibrationQuality: quality,
    calibrationLeftScore: 1, calibrationRightScore: 2, calibrationScores: { left: 3, right: 4 } });
  writeRecord(legacy, base);
  const before = await list();
  assert.equal(before.find(record => record.name === current).calibrationLeftScore, 298 / 3,
    'All list consumers receive canonical scores even before renderer metadata supplementation');
  assert.equal(before.find(record => record.name === current).calibrationRightScore, 298 / 3);
  assert.equal(before.find(record => record.name === legacy).calibrationScores, undefined,
    'An older record without its own score must not borrow the monitor calibration');

  const stale = { calibrationLeftScore: null, calibrationRightScore: null,
    calibrationScores: { left: 8, right: 9 }, calibrationQuality: null,
    calibrationProvider: 'PupilCore', calibrationVerified: false, deviceModel: 'PupilCore', country: '中国' };
  const stored = await save(current, stale);
  assert.deepEqual(stored.calibrationQuality, quality);
  assert.equal(stored.calibrationLeftScore, 298 / 3);
  assert.equal(stored.calibrationRightScore, 298 / 3);
  assert.deepEqual(stored.calibrationScores, { left: 3, right: 4 }, 'Incoming normalized scores cannot replace the existing snapshot');
  assert.equal(stored.deviceModel, 'HH_ET28');
  assert.equal(stored.calibrationProvider, 'HH_ET28');
  assert.equal(stored.calibrationVerified, true);
  assert.equal(stored.country, '中国', 'Ordinary editable metadata still updates');
  assert.equal(stored.calibrationQuality.left.points[2].score, 101, 'SDK scores are not percentages or 1–10 scores');

  const updated = await list();
  const currentRecord = updated.find(record => record.name === current);
  const displayed = shared.parseRecordingCalibrationScores(currentRecord, 'HH_ET28');
  assert.equal(displayed.left, 298 / 3);
  assert.equal(displayed.right, 298 / 3);
  assert.equal(currentRecord.calibrationLeftScore, 298 / 3);
  assert.equal(currentRecord.calibrationRightScore, 298 / 3);
  const html = renderToStaticMarkup(React.createElement(RecordsListPage, {
    records: [currentRecord], project: null, onSelectRecord() {}, onDeleteRecord() {},
  }));
  assert.match(html, /99\.33/);
  assert.doesNotMatch(html, />8\.00<|>9\.00<|\/10\b/);
  assert.equal(updated.find(record => record.name === legacy).calibrationScores, undefined,
    'Updating the current recording must not fabricate a score on old recordings');

  const noAliases = 'huahong_222222222222';
  writeRecord(noAliases, { ...base, calibrationQuality: { ...quality, left: eye([101, 101, 101]) } });
  const canonical = await save(noAliases, { calibrationLeftScore: 6, calibrationRightScore: 7 });
  assert.equal(canonical.calibrationLeftScore, 101, 'Missing scalar aliases are derived only from this recording\'s raw SDK points');
  assert.equal(canonical.calibrationRightScore, 298 / 3);
  assert.equal(Object.hasOwn(canonical, 'calibrationScores'), false);

  // Protection is deliberately limited to a verified ET28 recorder snapshot.
  const nonAuthoritative = [
    base,
    { ...base, calibrationQuality: { ...quality, right: eye([99, 99]) } },
    { ...base, calibrationQuality: { ...quality, left: { ...quality.left, truncated: true } } },
    { ...base, calibrationQuality: { ...quality, left: { ...quality.left,
      points: quality.left.points.map(point => ({ ...point, status: 2 })) } } },
    { ...base, calibrationQuality: quality, calibrationVerified: false },
    { ...base, calibrationQuality: quality, calibrationProvider: 'other' },
    { ...base, calibrationQuality: quality, deviceModel: 'HH_ET10C' },
    { ...base, calibrationQuality: quality, deviceModel: 'aSeeGlassesPlus' },
    { ...base, calibrationQuality: quality, deviceModel: 'PupilCore', samplingRateHz: 119.7 },
  ];
  for (const [index, metadata] of nonAuthoritative.entries()) {
    const name = `legacy${index}_20261019_170000`;
    writeRecord(name, metadata);
    const saved = await save(name, { calibrationLeftScore: 6, calibrationRightScore: 7, country: 'updated' });
    assert.equal(saved.calibrationLeftScore, 6, `case ${index}: legacy metadata editing remains compatible`);
    assert.equal(saved.calibrationRightScore, 7);
    assert.equal(saved.country, 'updated');
    if (metadata.deviceModel === 'PupilCore') assert.equal(saved.samplingRateHz, 119.7);
  }
  const invalidNormalized = 'normalized_20261019_170001';
  writeRecord(invalidNormalized, { ...base, calibrationLeftScore: 100, calibrationRightScore: 100,
    calibrationScores: { left: 100, right: 100, et28Quality: { ...quality, left: eye([99, 99]) } } });
  const rejectedNames = [...[1, 2, 3, 4, 5].map(index => `legacy${index}_20261019_170000`), invalidNormalized];
  const rawList = await handlers['load-recordings']({}, { projectDir: directory });
  const mappedList = mapLoadedRecordings(json(rawList.records));
  for (const name of rejectedNames) {
    const rawRecord = rawList.records.find(record => record.name === name);
    assert.equal(rawRecord.calibrationScores, undefined, `${name}: the rejected structured report remains unavailable`);
    assert.equal(rawRecord.calibrationLeftScore, undefined, `${name}: IPC must not retain stale scalar aliases`);
    assert.equal(rawRecord.calibrationRightScore, undefined);
    const mappedRecord = mappedList.find(record => record.name === name);
    assert.equal(mappedRecord.calibrationScores, undefined, `${name}: renderer mapping cannot resurrect rejected scores`);
    assert.equal(shared.parseRecordingCalibrationScores(mappedRecord, 'HH_ET28'), null);
  }
  const oldStyle = mappedList.find(record => record.name === 'legacy0_20261019_170000');
  assert.equal(oldStyle.calibrationScores.left, 6, 'No structured report means the historical scalar score remains usable');
  assert.equal(oldStyle.calibrationScores.right, 7);

  // Version 8 could preserve these aliases in a cached list even after the
  // shared parser rejected the raw report. Its matching signature is not enough.
  const summaryPath = path.join(directory, '.config/recordings-summary.json');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  fs.writeFileSync(summaryPath, JSON.stringify({ ...summary, version: 8,
    records: summary.records.map(record => rejectedNames.includes(record.name)
      ? { ...record, calibrationLeftScore: 100, calibrationRightScore: 100 } : record) }));
  const rebuilt = await handlers['load-recordings']({}, { projectDir: directory });
  assert.equal(rebuilt.summaryCacheHit, false, 'Version 8 aliases must be discarded even with unchanged source files');
  assert.equal(JSON.parse(fs.readFileSync(summaryPath, 'utf8')).version, 10);
  for (const record of mapLoadedRecordings(json(rebuilt.records))) {
    if (rejectedNames.includes(record.name)) assert.equal(record.calibrationScores, undefined);
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log('ET28 recording-owned calibration survives stale/null metadata writes, IPC reload and renderer mapping; raw scores remain unscaled and older records are not backfilled.');
