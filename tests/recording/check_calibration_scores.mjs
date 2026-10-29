import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8').replaceAll('import.meta.url', JSON.stringify(new URL(file, 'file:///').href)), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, console, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, ...globals });
  return exports;
}
const scoresModule = load('shared/domain/calibrationScores.ts');
const { parseCalibrationPayload, calibrationScoresFromCompletion, calibrationScorePresentation } = scoresModule;
const json = (value) => JSON.parse(JSON.stringify(value));
const et28Eye = (values) => ({ count: values.length, truncated: false,
  points: values.map((score, index) => ({ index: index + 1, status: index % 2, score, bias: [0, null] })) });
const et28Quality = { version: 1, provider: 'HH_ET28', aggregation: 'arithmetic_mean',
  left: et28Eye([100, 97, 101]), right: et28Eye([101, 102, 103]) };
const et28Message = { calibration_provider: 'HH_ET28', calibration_quality: et28Quality, left_score: 0, right_score: 0 };
const et28Scores = calibrationScoresFromCompletion(null, et28Message);
assert.equal(et28Scores.left, 298 / 3);
assert.equal(et28Scores.right, 102, 'Original scores above 100 are not percentages and must not be capped');
assert.equal(et28Scores.pupilScores, undefined);
assert.deepEqual(json(parseCalibrationPayload(json({ coe: 'et28', scores: et28Scores })).scores), json(et28Scores));
for (const points of [1, 3, 5, 9]) {
  assert.ok(scoresModule.parseEt28CalibrationQuality({ ...et28Quality,
    left: et28Eye(Array(points).fill(101)), right: et28Eye(Array(points).fill(99)) }));
}
for (const mutate of [
  (quality) => { quality.provider = 'PupilCore'; },
  (quality) => { quality.version = 2; },
  (quality) => { quality.aggregation = 'percentage'; },
  (quality) => { quality.left.count = 0; },
  (quality) => { quality.left.truncated = true; },
  (quality) => { quality.left.points.pop(); },
  (quality) => { quality.left.points[0].index = 2; },
  (quality) => { quality.left.points[0].status = 2; },
  (quality) => { quality.left.points[0].score = -1; },
  (quality) => { quality.left.points[0].score = 0x100000000; },
  (quality) => { quality.left.points[0].score = '100'; },
  (quality) => { quality.left.points[0].score = 99.5; },
  (quality) => { quality.left.points[0].bias = [Infinity, 0]; },
  (quality) => { quality.right = et28Eye([1, 2, 3, 4, 5]); },
]) {
  const quality = json(et28Quality);
  mutate(quality);
  assert.equal(scoresModule.parseEt28CalibrationQuality(quality), null);
  assert.equal(calibrationScoresFromCompletion(et28Scores, { ...et28Message, calibration_quality: quality }), null,
    'An invalid report must not borrow prior or contradictory scalar scores');
  assert.equal(parseCalibrationPayload({ scores: { ...et28Scores, et28Quality: quality } }).scores, null);
}
assert.equal(scoresModule.parseRecordingCalibrationScores({ deviceModel: 'HH_ET28', calibrationVerified: false,
  calibrationProvider: 'HH_ET28', calibrationQuality: et28Quality, calibrationScores: et28Scores }), null);
assert.equal(scoresModule.parseRecordingCalibrationScores({ deviceModel: 'aSeeGlassesPlus',
  calibrationScores: { left: 8.2, right: 9.1, et28Quality } }).left, 8.2,
  'Other devices must not consume ET28 reports');
const metric = (error, score, extra = {}) => ({
  qualityScore: score, pupilCoreAccuracyDeg: error, scoringPolicy: 'mrt_angular_linear_v1',
  scoreInputMetric: 'pupilCoreAccuracyDeg', scoreIsOfficial: false,
  meanErrorDeg: error, p95ErrorDeg: error, samples: 12, pupilCoreUsedSamples: 11,
  excludedSamples: 1, outlierThresholdDeg: 5, ...extra,
});
const trainingMessage = { calibration_provider: 'PupilCore', left_score: 7.87, right_score: 11.39,
  training_angular: { intrinsicsIndividuallyCalibrated: false,
    metrics: { left: metric(.663, 8.7), right: metric(1.184, 7.6), binocular: metric(2.333, 5.3) } } };
const trained = calibrationScoresFromCompletion(null, trainingMessage);
assert.equal(trained.left, 7.87, 'Pixel fields must retain their existing meaning');
assert.equal(trained.pupilScores.training.metrics.left.qualityScore, 8.7);
assert.equal(trained.pupilScores.training.metrics.binocular.qualityScore, 5.3);

// Existing calibration_result.json round-trip keeps optional reports and legacy keys.
const restored = parseCalibrationPayload(json({ coe: ' session ', scores: trained }));
assert.equal(restored.coe, 'session');
assert.deepEqual(json(restored.scores), json(trained));
const historical = parseCalibrationPayload({ calibrationCoe: 'old', scores: { leftScore: '7.87', right_scroe: '11.39' } }).scores;
assert.equal(historical.left, 7.87);
assert.equal(historical.right, 11.39);
assert.equal(historical.pupilScores, undefined, 'Historical pixel errors cannot be silently converted to scores');
assert.equal(parseCalibrationPayload({ scores: { left: '', right: null } }).scores, null);

const validated = calibrationScoresFromCompletion(trained, { calibration_provider: 'PupilCore', validation: {
  angular: { intrinsicsIndividuallyCalibrated: false, metrics: {
    left: metric(1, 8, { targetsWithSamples: 2, validityPercent: 60.5 }),
    right: metric(null, null, { samples: 0, pupilCoreUsedSamples: 0, excludedSamples: 0 }),
  } },
} });
assert.deepEqual(json(validated.pupilScores.training), json(trained.pupilScores.training));
assert.equal(validated.left, 7.87);
assert.equal(validated.pupilScores.validation.metrics.left.qualityScore, 8);
assert.equal(validated.pupilScores.validation.metrics.right.qualityScore, null);
assert.deepEqual(json(parseCalibrationPayload(json({ scores: validated })).scores), json(validated));
assert.equal(calibrationScoresFromCompletion(validated, trainingMessage).pupilScores.validation, undefined,
  'A new fit invalidates preceding independent validation');
const unavailable = calibrationScoresFromCompletion(trained, { calibration_provider: 'PupilCore', validation: { angularAccuracyAvailable: false } });
assert.ok(unavailable.pupilScores.validation);
assert.equal(calibrationScorePresentation(unavailable, true, false).left.value, '---');

// Only typed, internally consistent backend scores may enter live or restored state.
for (const change of [
  { qualityScore: 11 }, { qualityScore: '8.7' }, { qualityScore: 0 }, { qualityScore: 8.6 },
  { scoreIsOfficial: true }, { scoringPolicy: 'unknown' }, { scoreInputMetric: 'meanErrorDeg' },
  { pupilCoreAccuracyDeg: -1 }, { pupilCoreAccuracyDeg: NaN }, { meanErrorDeg: Infinity },
  { p95ErrorDeg: 181 }, { samples: -1 }, { samples: 12.5 }, { excludedSamples: 2 },
  { pupilCoreUsedSamples: 0 }, { outlierThresholdDeg: 0 }, { qualityScore: null },
]) {
  const angular = { metrics: { left: metric(.663, 8.7, change), right: metric(1, 8) } };
  const live = calibrationScoresFromCompletion(null, { ...trainingMessage, training_angular: angular });
  assert.equal(live.pupilScores.training.metrics.left, undefined, JSON.stringify(change));
  const saved = parseCalibrationPayload({ scores: { left: 7.87, right: 11.39, pupilScores: { training: angular } } });
  assert.equal(saved.scores.pupilScores.training.metrics.left, undefined, JSON.stringify(change));
}
const floor = calibrationScoresFromCompletion(null, { ...trainingMessage,
  training_angular: { metrics: { left: metric(4.75, 1) } } });
assert.equal(floor.pupilScores.training.metrics.left.qualityScore, 1);
const legacyDevice = calibrationScoresFromCompletion(validated, { left_score: 8.2, right_scroe: 9.1 });
assert.deepEqual(json(legacyDevice), { left: 8.2, right: 9.1 });

// Render the actual unchanged result box JSX from RecordingPage, using production presentation.
const page = fs.readFileSync('src/features/recording/RecordingPage.tsx', 'utf8');
const ast = ts.createSourceFile('RecordingPage.tsx', page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let resultBox;
function visit(node) {
  if (ts.isJsxElement(node) && node.openingElement.getText(ast) === '<div className="space-y-1.5">'
      && node.getText(ast).includes('{calibrationResult.title}')) resultBox = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(resultBox, 'Production calibration result box must remain present');
const renderSource = ts.transpileModule(`const element = (${resultBox});`, {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
}).outputText;
function render(scores, pupil, isEn) {
  const calibrationResult = calibrationScorePresentation(scores, pupil, isEn);
  const element = vm.runInNewContext(`${renderSource}\nelement;`, { React, calibrationResult, isEn });
  return renderToStaticMarkup(element);
}
for (const isEn of [false, true]) {
  const et28Html = render(et28Scores, false, isEn);
  assert.match(et28Html, /99\.33/);
  assert.match(et28Html, /102\.00/);
  assert.ok(et28Html.includes(isEn ? 'SDK point scores' : '校准点原始分数的算术均值'));
  assert.ok(et28Html.includes(isEn ? 'Software summary' : '软件汇总值'));
  assert.doesNotMatch(et28Html.replace(/<[^>]*>/g, ''), /\/10|px/);
  const trainingHtml = render(trained, true, isEn);
  assert.match(trainingHtml, /8\.7\/10/);
  assert.match(trainingHtml, /7\.6\/10/);
  assert.ok(trainingHtml.includes(isEn ? 'Calibration training score' : '校准训练分'));
  assert.ok(trainingHtml.includes(isEn ? 'not an official Pupil score' : '非 Pupil 官方评分'));
  assert.ok(trainingHtml.includes(isEn ? 'excluded 1' : '剔除 1'));
  const validationHtml = render(validated, true, isEn);
  assert.ok(validationHtml.includes(isEn ? 'Independent validation score' : '独立验证分'));
  assert.match(validationHtml, /8\.0\/10/);
  assert.match(validationHtml, /---/);
  assert.doesNotMatch(validationHtml, /7\.6\/10/, 'Missing validation eye must not fall back to its training score');
  assert.match(validationHtml, /2\/3/);
  assert.match(validationHtml, /60\.5%/);
  assert.match(render(historical, true, isEn).replace(/<[^>]*>/g, ''), /px/);
  assert.match(render(historical, true, isEn), /7\.87/);
  assert.doesNotMatch(render(historical, true, isEn), /\/10/);
  assert.match(render(legacyDevice, false, isEn), /8\.20/);
  assert.doesNotMatch(render(legacyDevice, false, isEn).replace(/<[^>]*>/g, ''), /\/10|px/);
}

// Execute the production persistence effect: Pupil validation stays visible in
// test mode, so finished reports must save before the user exits that mode.
const controller = fs.readFileSync('src/app/MrtApplicationController.tsx', 'utf8');
const controllerAst = ts.createSourceFile('controller.tsx', controller, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let saveEffect;
function findSaveEffect(node) {
  if (ts.isCallExpression(node) && node.expression.getText(controllerAst) === 'useEffect'
      && node.arguments[0]?.getText(controllerAst).includes('ipcClient.saveCalibrationResult')) {
    saveEffect = node.arguments[0].getText(controllerAst);
  }
  ts.forEachChild(node, findSaveEffect);
}
findSaveEffect(controllerAst);
assert.ok(saveEffect);
const runSaveEffect = ts.transpileModule(`const save = ${saveEffect}; save();`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
for (const [model, testMode, state, scores, expected] of [
  ['PupilCore', true, 'finished', validated, 1],
  ['PupilCore', true, 'finished', unavailable, 1],
  ['PupilCore', true, 'calibrating', validated, 0],
  ['PupilCore', true, 'none', validated, 0],
  ['PupilCore', true, 'finished', trained, 0],
  ['PupilCore', false, 'finished', trained, 1],
  ['aSeeGlassesPlus', true, 'finished', legacyDevice, 0],
  ['aSeeGlassesPlus', false, 'finished', legacyDevice, 1],
]) {
  const saved = [];
  vm.runInNewContext(runSaveEffect, {
    recordingSettings: { saveEyeCalibration: true, calibrationType: 'three' }, simulateMode: false,
    calibrationState: state, isCalibrationTestMode: testMode, activeDeviceModel: model,
    activeDataDir: '/experiment', calibrationCoe: 'test-token', calibrationScores: scores,
    currentRecordingSubjectId: 'subject', currentRecordingSubjectName: 'Test',
    ipcClient: { isAvailable: () => true, saveCalibrationResult: (payload) => saved.push(json(payload)) },
  });
  assert.equal(saved.length, expected, `${model}/${testMode}/${state}`);
  if (saved.length) assert.deepEqual(json(parseCalibrationPayload(saved[0].result).scores), json(scores));
}

// Exercise score writes through the real WS lifecycle, including pending/late/canceled results.
let liveScores = null;
let writes = 0;
const ws = load('src/features/recording/domain/recordingWsModule.ts', {
  '@/features/recording/domain/recordingCommunication': { finishRecordingCommunication: async () => {} },
  '@/features/recording/domain/huahongCalibrationSession': load('src/features/recording/domain/huahongCalibrationSession.ts'),
  '@/features/recording/domain/calibrationScores': scoresModule,
  '@/infrastructure/electron/ipcClient': { ipcClient: { videoDebugLog() {}, isAvailable: () => false } },
  '@/features/recording/domain/webcodecsVideoRenderer': {},
}, { WebSocket: class {}, alert() {}, document: { fullscreenElement: null },
  console: { log() {}, warn() {}, error: console.error } });
const ref = { current: null };
const stateRef = { current: { arrIndex: 0, pointIndex: 1, points: 3, pointPending: true } };
ws.connectCmdWebSocket({ wsIp: '127.0.0.1', wsCmdPort: '9003', wsCmdRef: ref, calibStateRef: stateRef,
  setCalibrationState() {}, setCalibScale() {}, setCalibrationCoe() {}, processPoint() {}, advanceCalibration() {},
  setCalibrationScores(value) { liveScores = typeof value === 'function' ? value(liveScores) : value; writes++; } });
const respond = (message) => ref.current.onmessage({ data: JSON.stringify({
  type: 'rsp_cmd', error: 0, calibration_provider: 'PupilCore', ...message,
}) });
respond({ id: 'start_calibration', calibration_session: 'fit' });
respond({ id: 'complete_calibration', calibration_session: 'fit', result_pending: true, ...trainingMessage });
assert.equal(writes, 0, 'ACK/pending cannot set a score');
respond({ id: 'complete_calibration', calibration_session: 'old', ...trainingMessage });
assert.equal(writes, 0, 'Stale sessions cannot set a score');
respond({ id: 'complete_calibration', calibration_session: 'fit', ...trainingMessage });
assert.equal(writes, 1);
assert.equal(liveScores.pupilScores.training.metrics.left.qualityScore, 8.7);
respond({ id: 'start_calibration', calibration_session: 'validate' });
respond({ id: 'complete_calibration', calibration_session: 'validate', validation: { angular: validated.pupilScores.validation } });
assert.equal(writes, 2);
assert.equal(liveScores.pupilScores.validation.metrics.left.qualityScore, 8);
const before = liveScores;
respond({ id: 'cancel_calibration' });
stateRef.current.pointPending = false;
respond({ id: 'complete_calibration', calibration_session: 'validate', ...trainingMessage });
respond({ id: 'complete_calibration', ...trainingMessage });
respond({ id: 'complete_calibration', error: -1, msg: 'timeout' });
assert.equal(liveScores, before, 'Canceled, late or failed results must not rewrite accepted scores');
const staleSocket = ref.current;
ref.current = null;
staleSocket.onmessage({ data: JSON.stringify({ type: 'rsp_cmd', id: 'complete_calibration', error: 0, ...trainingMessage }) });
assert.equal(writes, 2, 'Disconnected sockets cannot restore stale scores');
console.log('Calibration score checks passed: persistence, score validation, bilingual production JSX and WS lifecycle.');
