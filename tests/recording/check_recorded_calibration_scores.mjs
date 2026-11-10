import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Load production parsing, IPC listing, renderer mapping and JSX together.
const root = process.cwd();
const requireNative = createRequire(import.meta.url);
const modules = new Map();
const handlers = {};
let language = 'zh-CN';
function load(relative) {
  const filename = path.resolve(root, relative);
  if (modules.has(filename)) return modules.get(filename);
  const exports = {};
  modules.set(filename, exports);
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React, esModuleInterop: true,
    },
  }).outputText;
  vm.runInNewContext(js, {
    exports, process, console: { ...console, log() {} }, Buffer, setTimeout, clearTimeout,
    require(specifier) {
      if (specifier === 'react') return React;
      if (specifier.startsWith('node:')) return requireNative(specifier);
      if (specifier === 'electron') return { ipcMain: { handle: (id, callback) => { handlers[id] = callback; } } };
      if (specifier === '@/app/i18n/useLanguage') return { useLanguage: () => ({ language }) };
      if (specifier === '@/shared/ui/CustomSelect') return ({ children, value, onChange }) =>
        React.createElement('select', { value, onChange }, children);
      const base = specifier.startsWith('@shared/') ? path.join(root, 'shared', specifier.slice(8))
        : specifier.startsWith('@/') ? path.join(root, 'src', specifier.slice(2))
          : specifier.startsWith('.') ? path.resolve(path.dirname(filename), specifier) : null;
      assert.ok(base?.startsWith(`${root}${path.sep}`), `Unexpected dependency: ${specifier}`);
      const target = ['.ts', '.tsx'].map((suffix) => `${base}${suffix}`).find(fs.existsSync);
      assert.ok(target, `Missing production dependency: ${specifier}`);
      return load(target);
    },
  }, { filename, timeout: 1000 });
  return exports;
}
const shared = load('shared/domain/calibrationScores.ts');
const { parseRecordingCalibrationScores } = shared;
assert.equal(load('src/features/recording/domain/calibrationScores.ts').parseCalibrationPayload, shared.parseCalibrationPayload,
  'Live calibration must use the same shared parser as recorded scores');
const { mapLoadedRecordings } = load('src/features/records/domain/recordingsMapping.ts');
const RecordsListPage = load('src/features/records/RecordsListPage.tsx').default;
const json = (value) => JSON.parse(JSON.stringify(value));
const metric = (angle, score, extra = {}) => ({
  qualityScore: score, scoringPolicy: 'mrt_angular_linear_v1', scoreInputMetric: 'pupilCoreAccuracyDeg', scoreIsOfficial: false,
  pupilCoreAccuracyDeg: angle, meanErrorDeg: angle, p95ErrorDeg: angle,
  samples: 10, pupilCoreUsedSamples: 10, excludedSamples: 0, outlierThresholdDeg: 5, ...extra,
});
const training = { intrinsicsIndividuallyCalibrated: false, metrics: { left: metric(.5, 9), right: metric(1, 8) } };
const validation = { independentValidationPerformed: true, angular: {
  intrinsicsIndividuallyCalibrated: false,
  metrics: {
    left: metric(2.2900551981748776, 5.4, { samples: 324, pupilCoreUsedSamples: 317, excludedSamples: 7, targetsWithSamples: 3, validityPercent: 94.46 }),
    right: metric(2.739956751548552, 4.5, { samples: 324, pupilCoreUsedSamples: 192, excludedSamples: 132, targetsWithSamples: 3, validityPercent: 94.46 }),
  },
} };
const baseMeta = { deviceModel: 'PupilCore', deviceType: '眼镜式', calibrationProvider: 'PupilCore',
  status: 'complete', durationSeconds: 36.9, subjectName: 'test-subject' };
const cases = {
  validated: { ...baseMeta, independentValidationPerformed: true, calibrationValidation: validation },
  trained: { ...baseMeta, calibrationTrainingAngular: training },
  missingEye: { ...baseMeta, calibrationTrainingAngular: training,
    calibrationValidation: { independentValidationPerformed: true, angular: { metrics: { left: validation.angular.metrics.left } } } },
  missingAngular: { ...baseMeta, calibrationTrainingAngular: training, independentValidationPerformed: true },
  invalidValidation: { ...baseMeta, calibrationTrainingAngular: training,
    calibrationValidation: { angular: { metrics: { left: metric(.5, 10) } } } },
  legacyPupil: { ...baseMeta, calibrationLeftScore: 7.87, calibrationRightScore: 11.39 },
  vendor: { ...baseMeta, deviceModel: 'aSeeGlassesPlus', calibrationLeftScore: 8.2, calibrationRightScore: 9.1,
    calibrationTrainingAngular: training, calibrationValidation: validation },
  empty: baseMeta,
};
const result = parseRecordingCalibrationScores(cases.validated);
assert.equal(result.pupilScores.validation.metrics.left.qualityScore, 5.4);
assert.equal(result.pupilScores.validation.metrics.right.qualityScore, 4.5);
assert.equal(result.pupilScores.training, undefined);
assert.equal(parseRecordingCalibrationScores(cases.missingEye).pupilScores.validation.metrics.right, undefined);
for (const name of ['missingAngular', 'invalidValidation']) {
  assert.equal(parseRecordingCalibrationScores(cases[name]).pupilScores.validation.angularAccuracyAvailable, false, name);
}
const rejectedNormalized = parseRecordingCalibrationScores({ ...baseMeta, calibrationScores: {
  pupilScores: { training, validation: { metrics: { left: metric(.5, 10) } } },
} });
assert.equal(rejectedNormalized.pupilScores.validation.angularAccuracyAvailable, false);
const normalizedValidation = {
  ...baseMeta, independentValidationPerformed: true,
  calibrationScores: { pupilScores: { training, validation: validation.angular } },
};
assert.equal(parseRecordingCalibrationScores(normalizedValidation).pupilScores.validation.metrics.left.qualityScore, 5.4,
  'The performed flag must preserve a valid normalized validation when no raw report is present');
assert.equal(parseRecordingCalibrationScores(normalizedValidation).pupilScores.validation.metrics.right.qualityScore, 4.5);
for (const calibrationValidation of [null, false, 'invalid', [], {}, { angular: null }]) {
  for (const independentValidationPerformed of [true, false]) {
    const parsed = parseRecordingCalibrationScores({ ...normalizedValidation, calibrationValidation, independentValidationPerformed });
    assert.equal(parsed.pupilScores.validation.angularAccuracyAvailable, false,
      'An explicitly unavailable raw validation overrides a normalized validation without borrowing training scores');
    assert.deepEqual(json(parsed.pupilScores.validation.metrics), {});
  }
}
const trainingOnly = parseRecordingCalibrationScores({ ...cases.trained,
  calibrationValidation: null, independentValidationPerformed: false,
});
assert.equal(trainingOnly.pupilScores.training.metrics.left.qualityScore, 9);
assert.equal(trainingOnly.pupilScores.validation, undefined,
  'The normal null placeholder before independent validation must preserve training-only presentation');
assert.equal(parseRecordingCalibrationScores(cases.legacyPupil).pupilScores, undefined);
assert.equal(parseRecordingCalibrationScores(cases.vendor, 'aSeeGlassesPlus').pupilScores, undefined);
assert.equal(parseRecordingCalibrationScores(cases.empty), null);

const profile = load('src/features/recording/device/deviceProfile.ts');
load('electron/domains/recording/recordingListHandlers.ts').registerRecordingListHandlers({
  buildLocalResourceUrl: async (file) => file,
  normalizeDataSamplingRateHz: Number, normalizeProjectDeviceType: profile.normalizeDeviceType,
  normalizeProjectDeviceModel: profile.normalizeDeviceModel, probeMediaDurationSeconds: async () => undefined,
});
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mrt-recorded-calibration-'));
try {
  fs.mkdirSync(path.join(temp, 'recordings'));
  fs.mkdirSync(path.join(temp, 'monitor'));
  fs.writeFileSync(path.join(temp, 'project.json'), JSON.stringify({ deviceType: '眼镜式', deviceModel: 'PupilCore' }));
  // This newer session intentionally conflicts with the record. It cannot be a fallback.
  fs.writeFileSync(path.join(temp, 'monitor/calibration_result.json'), JSON.stringify({ latest: { scores: {
    pupilScores: { validation: { metrics: { left: metric(0, 10), right: metric(0, 10) } } },
  } } }));
  for (const [name, meta] of Object.entries(cases)) {
    const basename = `${name}_20261016_173029`;
    fs.writeFileSync(path.join(temp, 'recordings', `${basename}.mp4`), 'Listing uses persisted duration; decoding is covered by Python media tests.');
    fs.writeFileSync(path.join(temp, 'recordings', `${basename}.meta.json`), JSON.stringify(meta));
  }
  const first = await handlers['load-recordings']({}, { projectDir: temp });
  assert.equal(first.ok, true);
  const cachePath = path.join(temp, '.config/recordings-summary.json');
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  // A previous cache with an identical metadata signature must be invalidated.
  fs.writeFileSync(cachePath, JSON.stringify({ ...cached, version: 6,
    records: cached.records.map(({ calibrationScores: _ignored, ...record }) => record) }));
  const rebuilt = await handlers['load-recordings']({}, { projectDir: temp });
  assert.equal(rebuilt.summaryCacheHit, false);
  const cachedAgain = await handlers['load-recordings']({}, { projectDir: temp });
  assert.equal(cachedAgain.summaryCacheHit, true);
  const records = mapLoadedRecordings(json(cachedAgain.records));
  const get = (name) => records.find((record) => record.name === `${name}_20261016_173029`);
  assert.equal(get('validated').calibrationScores.pupilScores.validation.metrics.left.qualityScore, 5.4);
  assert.equal(get('validated').calibrationScores.pupilScores.validation.metrics.right.qualityScore, 4.5);
  assert.equal(get('trained').calibrationScores.pupilScores.training.metrics.left.qualityScore, 9);
  assert.equal(get('empty').calibrationScores, undefined, 'Current monitor calibration cannot fill an older record');
  assert.equal(get('vendor').calibrationLeftScore, 8.2);

  const render = (record) => renderToStaticMarkup(React.createElement(RecordsListPage, {
    records: [record], project: null, onSelectRecord() {}, onDeleteRecord() {},
  }));
  for (const currentLanguage of ['zh-CN', 'en-US']) {
    language = currentLanguage;
    const isEn = language === 'en-US';
    const validated = render(get('validated'));
    assert.doesNotMatch(validated, /Independent validation score|独立验证分/);
    assert.match(validated, /5\.4\/10/);
    assert.match(validated, /4\.5\/10/);
    assert.ok(validated.includes(isEn ? 'excluded 132' : '剔除 132'));
    assert.ok(validated.includes(isEn ? 'not an official Pupil score' : '非 Pupil 官方评分'));
    const trained = render(get('trained'));
    assert.ok(trained.includes(isEn ? 'Calibration training score' : '校准训练分'));
    assert.match(trained, /9\.0\/10/);
    assert.match(trained, /8\.0\/10/);
    for (const name of ['missingEye', 'missingAngular', 'invalidValidation']) {
      const html = render(get(name));
      assert.doesNotMatch(html, /Independent validation score|独立验证分/);
      assert.match(html, /---/);
      assert.doesNotMatch(html, /9\.0\/10|8\.0\/10/, `${name}: validation must never borrow a training eye score`);
    }
    const legacy = render(get('legacyPupil'));
    assert.match(legacy, /px/);
    assert.match(legacy, /7\.87/);
    assert.match(legacy, /11\.39/);
    assert.doesNotMatch(legacy, /\/10/);
    const vendor = render(get('vendor'));
    assert.match(vendor, /8\.20/);
    assert.match(vendor, /9\.10/);
    assert.doesNotMatch(vendor, /\/10|训练误差|Training error/);
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

// Optional local evidence: inspect an experiment metadata file without changing it.
if (process.argv[2]) {
  const evidence = fs.readFileSync(process.argv[2]);
  const meta = JSON.parse(evidence.toString('utf8'));
  const scores = parseRecordingCalibrationScores(meta);
  assert.ok(scores?.pupilScores?.validation, 'The supplied recording should retain independent validation');
  assert.equal(scores.pupilScores.validation.metrics.left?.qualityScore, 5.4);
  assert.equal(scores.pupilScores.validation.metrics.right?.qualityScore, 4.5);
  const record = mapLoadedRecordings([{ ...meta, id: 'evidence', name: 'Evidence recording', calibrationScores: scores,
    modalities: { 'eye-tracking': { status: 'complete' } } }])[0];
  const html = renderToStaticMarkup(React.createElement(RecordsListPage, {
    records: [record], project: null, onSelectRecord() {}, onDeleteRecord() {},
  }));
  assert.match(html, /5\.4\/10/);
  assert.match(html, /4\.5\/10/);
  assert.ok(evidence.equals(fs.readFileSync(process.argv[2])), 'Original experiment metadata remains unchanged');
  console.log('Supplied experiment metadata: independent validation left 5.4/10, right 4.5/10.');
}
console.log('Recorded calibration checks passed: production IPC/cache/mapping/JSX, independent validation and training separation, legacy pixels and vendor compatibility.');
