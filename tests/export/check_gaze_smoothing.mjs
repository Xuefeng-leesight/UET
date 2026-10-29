import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url), modules = new Map(), handlers = {};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrt-gaze-smoothing-'));
function load(file) {
  file = path.resolve(file);
  if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file, exports);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(js, { exports, process, console, Buffer, Error, setTimeout, clearTimeout, require(name) {
    if (name === 'electron') return { ipcMain: { handle: (name, callback) => { handlers[name] = callback; } },
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) } };
    return name.startsWith('.') ? load(path.resolve(path.dirname(file), name) + '.ts') : require(name);
  } }, { filename: file });
  return exports;
}
const data = load('shared/domain/eyeExportData.ts');
const filter = load('shared/domain/gazeSmoothing.ts');
const eyes = ['recom', 'left', 'right'];
const smoothKeys = eyes.flatMap(eye => [...'xyz'].map(axis => `${eye}_smooth_point_${axis}`));
const keys = [...smoothKeys, ...eyes.map(eye => `${eye}_gaze_bit_mask`)];
const unsupported = ['left_openness', 'right_openness', 'left_eyelid_up', 'right_eyelid_up', 'left_eyelid_down', 'right_eyelid_down',
  'gyro_timestamp', 'gyro_quaternion', 'gyroscope', 'acceleration', 'magnetometer'];
const fields = ['video_time_ms', 'source_timestamp_s', 'source_receive_sequence', 'source_model', 'source_backend', 'source_generation',
  'source_topic', 'gaze_mapping_mode', 'gaze_rejected_eye_ids', 'gaze_coordinate_space', 'geometry_space', 'gaze_raw_semantics', 'pupil_pairing',
  'gaze_source_order', 'gaze_valid', 'pupil_valid', 'gaze_model_quality', 'source_event_type', 'customMarker', 'triggerMark', 'blink',
  'world_image_width', 'world_image_height', 'world_resolution_epoch', 'gaze_velocity_px_ms', 'recom_gaze_x', 'recom_gaze_y',
  ...eyes.flatMap(eye => [`${eye}_gaze_bit_mask`, `${eye}_pupil_valid`, `${eye}_pupil_model_quality`, `${eye}_pupil_source_timestamp_s`,
    `${eye}_pupil_image_width`, `${eye}_pupil_image_height`, `${eye}_blink`,
    ...['raw_point', 'gaze_point', 'smooth_point'].flatMap(field => [...'xyz'].map(axis => `${eye}_${field}_${axis}`))]), ...unsupported];
const headers = new Map(fields.map((field, index) => [field.toLowerCase(), index]));
const row = values => fields.map(field => String(values[field] ?? ''));
const gaze = (time, x = time, overrides = {}) => row({ video_time_ms: time, source_timestamp_s: time / 1000,
  source_receive_sequence: time + 1, source_model: 'PupilCore', source_backend: 'native', source_generation: 1,
  source_topic: 'gaze.3d.01.', gaze_mapping_mode: 'binocular', gaze_coordinate_space: 'world_normalized_top_left',
  geometry_space: 'world_camera_mm', gaze_raw_semantics: 'calibrated_3d_point', gaze_source_order: 'in_order',
  gaze_valid: 1, pupil_valid: 1, gaze_model_quality: 'good', recom_gaze_x: .5, recom_gaze_y: .5,
  world_image_width: 1280, world_image_height: 720, world_resolution_epoch: 0,
  ...Object.fromEntries(eyes.flatMap(eye => [[`${eye}_gaze_bit_mask`, 3], [`${eye}_pupil_valid`, 1],
    [`${eye}_pupil_model_quality`, 'good'], [`${eye}_pupil_source_timestamp_s`, time / 1000],
    [`${eye}_pupil_image_width`, 400], [`${eye}_pupil_image_height`, 400],
    ...['raw_point', 'gaze_point'].flatMap(field => [...'xyz'].map((axis, i) => [`${eye}_${field}_${axis}`, [x, -2, 500][i]])),
    ...[...'xyz'].map(axis => [`${eye}_smooth_point_${axis}`, 9999])])), ...overrides });
const derive = rows => data.buildDerivedExportRows(rows, headers, false);
const measure = (key, source, derived = {}, context = {}) => data.resolveExportMeasurement(key, source[headers.get(key)] || '', source, headers, { ...context, derivedValues: derived });
const absent = (value, prefixes = eyes) => {
  for (const eye of prefixes) for (const axis of 'xyz') assert.equal(value[`${eye}_smooth_point_${axis}`], undefined);
};
const near = (actual, expected, epsilon = 1e-10) => assert.ok(Math.abs(Number(actual) - expected) <= epsilon, `${actual} != ${expected}`);
try {
  assert.equal(filter.GAZE_SMOOTHING_V1.timeConstantMs, 25);
  assert.equal(filter.GAZE_SMOOTHING_V1.maxGapMs, 100);
  const tiny = filter.createGazeSmoothingFilter();
  assert.equal(tiny.add({ timeMs: 0, point: [0, 0, 0], context: 'same' }), null);
  near(tiny.add({ timeMs: 1e-8, point: [1, 0, 0], context: 'same' })[0], -Math.expm1(-1e-8 / 25), 1e-20);
  const original = [gaze(0, 0), gaze(25, 10), gaze(50, 10), gaze(75, 10)];
  const snapshot = JSON.stringify(original), derived = derive(original);
  absent(derived[0]);
  for (let i = 1; i < original.length; i++) for (const eye of eyes) {
    near(derived[i][`${eye}_smooth_point_x`], 10 * (1 - Math.exp(-i)));
    near(derived[i][`${eye}_smooth_point_y`], -2);
    near(derived[i][`${eye}_smooth_point_z`], 500);
    assert.equal(measure(`${eye}_gaze_bit_mask`, original[i], derived[i]), '7', 'bit2 reflects the same independently derived XYZ that are exported');
    assert.equal(measure(`${eye}_gaze_bit_mask`, original[0], derived[0]), '3', 'initialization is not falsely marked smoothed');
  }
  assert.equal(JSON.stringify(original), snapshot, 'source raw and fake old smoothing cells remain untouched');
  assert.equal(derived[1].gaze_smoothing_provenance, filter.GAZE_SMOOTHING_PROVENANCE);
  assert.equal(measure('recom_smooth_point_x', original[1]), '', 'a raw copied smooth value never becomes a measured or derived smooth point');
  assert.equal(measure('recom_smooth_point_x', gaze(25, 10, { geometry_space: '' }), derived[1]), '', 'provenance cannot make an unqualified current coordinate space valid');
  const incomplete = { gaze_smoothing_provenance: filter.GAZE_SMOOTHING_PROVENANCE, recom_smooth_point_x: '1', recom_smooth_point_y: '2' };
  assert.equal(measure('recom_smooth_point_x', original[1], incomplete), '', 'a partial derived vector cannot authorize any smooth member');
  const unequal = derive([gaze(0, 0), gaze(10, 10), gaze(35, 10)]);
  near(unequal[2].recom_smooth_point_x, 10 * (1 - Math.exp(-35 / 25)), 1e-9);

  for (const change of [
    { geometry_space: '' }, { geometry_space: 'normalized_2d' }, { gaze_raw_semantics: 'normalized_2d_alias' },
    { recom_raw_point_z: '' }, { recom_raw_point_y: 'NaN' }, { recom_raw_point_x: 'Infinity' },
    { gaze_valid: 0 }, { recom_gaze_bit_mask: 0 }, { gaze_model_quality: 'bad' }, { blink: 1 },
  ]) {
    const result = derive([gaze(0), gaze(10, 10, change), gaze(20), gaze(30)]);
    absent(result[1], ['recom']); absent(result[2], ['recom']);
    assert.ok(result[3].recom_smooth_point_x);
  }
  const independent = derive([gaze(0), gaze(10, 10, { gaze_valid: 0, recom_gaze_bit_mask: 0, right_pupil_model_quality: 'bad' }), gaze(20), gaze(30)]);
  absent(independent[1], ['recom', 'right']);
  assert.ok(independent[1].left_smooth_point_x, 'bad recommendation/right eye and missing recommended speed cannot erase the independently valid left eye');
  assert.ok(independent[2].left_smooth_point_x); absent(independent[2], ['right']);
  const unavailableRecommendation = derive([gaze(0), gaze(10, 10, { recom_raw_point_z: '', gaze_valid: 0, gaze_raw_semantics: 'unavailable' })]);
  absent(unavailableRecommendation[1], ['recom']);
  assert.ok(unavailableRecommendation[1].left_smooth_point_x, 'a missing recommended point does not change a valid independent eye stream');
  for (const rejection of [{ left_pupil_model_quality: 'bad' }, { left_pupil_valid: 0 }, { left_blink: 1 }]) {
    const result = derive([gaze(0), gaze(10, 10, { gaze_model_quality: '', ...rejection })]);
    absent(result[1], ['recom']); assert.ok(result[1].right_smooth_point_x);
    const mono = derive([gaze(0, 0, { source_topic: 'gaze.3d.0.' }), gaze(10, 10, {
      source_topic: 'gaze.3d.0.', gaze_model_quality: '', ...rejection })]);
    assert.ok(mono[1].recom_smooth_point_x, 'a known right-eye recommendation is independent of rejected left measurements');
  }
  for (const change of [{ left_pupil_valid: 0 }, { left_gaze_bit_mask: 0 }, { left_blink: 1 },
    { left_raw_point_z: '' }, { left_pupil_source_timestamp_s: '' }]) {
    const result = derive([gaze(0), gaze(10, 10, change)]);
    absent(result[1], ['left']); assert.ok(result[1].right_smooth_point_x);
  }
  const repeatedEye = derive([gaze(0), gaze(10, 10, { left_pupil_source_timestamp_s: 0 }), gaze(20), gaze(30)]);
  absent(repeatedEye[1], ['left']); absent(repeatedEye[2], ['left']);
  assert.ok(repeatedEye[3].left_smooth_point_x);
  assert.ok(repeatedEye[1].right_smooth_point_x, 'a repeated left pupil frame does not disrupt the right eye');
  for (const offsetSeconds of [-10, 10]) {
    const stale = derive([gaze(10000, 0, { left_pupil_source_timestamp_s: 10 + offsetSeconds, pupil_pairing: 'base_data' }),
      gaze(10025, 10, { left_pupil_source_timestamp_s: 10.025 + offsetSeconds, pupil_pairing: 'base_data' })]);
    absent(stale[1], ['left']); assert.ok(stale[1].right_smooth_point_x, 'one stale/future eye cannot remove the other current eye');
  }
  const pairedFuture = pairing => derive([gaze(0, 0, { left_pupil_source_timestamp_s: .01, pupil_pairing: pairing }),
    gaze(25, 10, { left_pupil_source_timestamp_s: .035, pupil_pairing: pairing })]);
  near(pairedFuture('base_data')[1].left_smooth_point_x, derived[1].left_smooth_point_x);
  absent(pairedFuture('legacy')[1], ['left']);
  const recentPast = derive([gaze(100, 0, { left_pupil_source_timestamp_s: .05, pupil_pairing: 'legacy' }),
    gaze(125, 10, { left_pupil_source_timestamp_s: .075, pupil_pairing: 'legacy' })]);
  near(recentPast[1].left_smooth_point_x, derived[1].left_smooth_point_x);

  for (const change of [{ source_generation: 2 }, { source_topic: 'gaze.3d.1.' }, { source_backend: 'capture' },
    { gaze_mapping_mode: 'monocular' }, { gaze_rejected_eye_ids: '0' }, { world_image_width: 1920 },
    { world_image_height: 1080 }, { world_resolution_epoch: 1 }]) {
    const result = derive([gaze(0), gaze(10, 10, change), gaze(20, 20, change)]);
    absent(result[1]); assert.ok(result[2].recom_smooth_point_x);
  }
  const eyeResize = derive([gaze(0), gaze(10, 10, { left_pupil_image_width: 800 }), gaze(20, 20, { left_pupil_image_width: 800 })]);
  absent(eyeResize[1], ['left']); assert.ok(eyeResize[1].right_smooth_point_x); assert.ok(eyeResize[2].left_smooth_point_x);
  const mutableContext = { videoWidth: 1280, videoHeight: 720 }, contextStream = data.createExportSmoothingDeriver(headers, mutableContext);
  contextStream(gaze(0)); mutableContext.videoWidth = 1920;
  absent(contextStream(gaze(10))); assert.ok(contextStream(gaze(20)).recom_smooth_point_x);
  for (const problem of [{ source_timestamp_s: '' }, { source_timestamp_s: -1 }, { source_timestamp_s: 0 },
    { source_receive_sequence: '' }, { source_receive_sequence: 1 }, { source_receive_sequence: 1.5 }, { gaze_source_order: 'late_source_time' }]) {
    const result = derive([gaze(0), gaze(10, 10, problem), gaze(20), gaze(30)]);
    absent(result[1]); absent(result[2]); assert.ok(result[3].recom_smooth_point_x);
  }
  const gap = derive([gaze(0), gaze(101), gaze(111)]);
  absent(gap[1]); assert.ok(gap[2].recom_smooth_point_x);
  assert.ok(derive([gaze(0), gaze(100)])[1].recom_smooth_point_x, 'the agreed 100ms boundary is inclusive');
  const sorted = derive([gaze(0, 90, { gaze_source_order: 'late_source_time', source_receive_sequence: 2 }),
    gaze(6, 0, { source_receive_sequence: 1 }), gaze(20, 20, { source_receive_sequence: 3 }), gaze(30, 30, { source_receive_sequence: 4 })]);
  sorted.slice(0, 3).forEach(value => absent(value)); assert.ok(sorted[3].left_smooth_point_x, 'sorted CSV cannot bridge an acquisition-order discontinuity');
  const interruptions = [original[0], row({ source_model: 'PupilCore', source_event_type: 'fixation', source_receive_sequence: 9000 }),
    row({ source_event_type: 'blink', blink: 1 }),
    row({ source_model: 'PupilCore', customMarker: 'event cue' }), original[1]];
  const interrupted = derive(interruptions);
  near(interrupted[4].recom_smooth_point_x, derived[1].recom_smooth_point_x);
  interrupted.slice(1, 4).forEach(value => absent(value));
  const markerSample = derive([gaze(0), gaze(25, 10, { customMarker: 'on real sample' })]);
  near(markerSample[1].recom_smooth_point_x, derived[1].recom_smooth_point_x);

  // Historical explicit video ms remains usable, but ambiguous timestamp alone never seeds smoothing.
  const oldFields = fields.filter(key => !['source_timestamp_s', 'source_receive_sequence', ...eyes.map(eye => `${eye}_pupil_source_timestamp_s`)].includes(key));
  const oldHeaders = new Map(oldFields.map((key, index) => [key.toLowerCase(), index]));
  const oldRows = original.map(source => oldFields.map(key => source[headers.get(key.toLowerCase())]));
  near(data.buildDerivedExportRows(oldRows, oldHeaders)[1].recom_smooth_point_x, derived[1].recom_smooth_point_x);
  const noClock = new Map(oldHeaders); noClock.delete('video_time_ms');
  data.buildDerivedExportRows(oldRows, noClock).forEach(value => absent(value));
  for (const key of unsupported) for (const value of ['0', '1', '[1,2,3]', '{"x":4}', 'raw-string']) {
    const source = gaze(0, 0, { [key]: value });
    assert.equal(measure(key, source), '', `Pupil has no qualified source for ${key}`);
    source[headers.get('source_model')] = 'aSeeGlassesPlus';
    assert.equal(measure(key, source), value, 'legacy SDK measurements remain untouched');
  }
  const legacy = original.map(source => { const result = [...source]; result[headers.get('source_model')] = 'aSeeGlassesPlus'; return result; });
  derive(legacy).forEach(value => absent(value));
  assert.equal(measure('left_smooth_point_x', legacy[1]), '9999', 'existing non-Pupil SDK smoothing remains its original source value');

  // Real main-process export and the production renderer callback consume the exact same causal stream.
  load('electron/domains/recording/recordPointHandlers.ts').registerRecordPointHandlers();
  load('electron/domains/recording/recordExportHandlers.ts').registerRecordExportHandlers({ trimFixedDecimal: value => String(value) });
  const { parseCsvLineFast } = load('electron/domains/recording/recordCsvParser.ts');
  const csvPath = path.join(root, 'input.csv');
  const allRows = [...interruptions, ...Array.from({ length: 110 }, (_, i) => gaze(50 + i * 10, 10))];
  const csv = [fields, ...allRows].map(cells => cells.join(',')).join('\n') + '\n';
  fs.writeFileSync(csvPath, csv);
  const record = { id: 'smooth', name: 'actual', csvPath, videoWidth: 1280, videoHeight: 720 };
  const exported = await handlers['export-records-csv']({}, { records: [record], columns: keys });
  assert.equal(exported.ok, true, exported.message);
  const fileRows = fs.readFileSync(exported.files[0], 'utf8').trim().split('\n').map(parseCsvLineFast);
  const ast = ts.createSourceFile('ExportPage.tsx', fs.readFileSync('src/features/export/ExportPage.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callbackNode;
  function find(node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'previewRecordData') callbackNode = node.initializer; ts.forEachChild(node, find); }
  find(ast); assert.ok(callbackNode);
  let previewRows, previewError;
  const preview = vm.runInNewContext(ts.transpileModule(`(${callbackNode.getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    ...data, projectDir: null, isEn: true, exportModality: 'eye-tracking', previewOperationRef: { current: 0 },
    ipcClient: { isAvailable: () => true, previewRecordCsv: payload => handlers['preview-record-csv']({}, payload) },
    setFeedback() {}, setPreviewRecord() {}, setPreviewLoading() {}, setPreviewData: value => { previewRows = value; }, setPreviewError: value => { previewError = value; },
    availableColumns: keys, selectedColumns: new Set(keys), columnSourceMap: {}, columnJoinSourceMap: {},
    buildSubjectInfoForRecord: () => ({}), buildRecordMetadataValues: () => ({}), getColumnHeader: key => key,
  });
  await preview(record); assert.ok(!previewError, previewError);
  assert.equal(previewRows.length, 101);
  assert.deepEqual(JSON.parse(JSON.stringify(previewRows)), JSON.parse(JSON.stringify(fileRows.slice(0, 101))), 'the truncated real preview equals the corresponding full export prefix, including bit2');
  assert.equal(fileRows.length, allRows.length + 1, 'no resampling or row changes');
  assert.equal(fs.readFileSync(csvPath, 'utf8'), csv);
  assert.ok(!fileRows[0].some(value => value.includes('provenance')), 'internal algorithm provenance adds no export column');
  console.log('PASS causal 3D smoothing v1: analytic response, source/eye qualification, discontinuities, receive-order sorting, legacy compatibility, unsupported-source guards, and real preview/full export parity');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
