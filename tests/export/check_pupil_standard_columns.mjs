import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import vm from 'node:vm';
import ts from 'typescript';
function load(file, dependencies = {}) {
  const exports = {};
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(compiled, { exports, console, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name];
  } });
  return exports;
}
const data = load('shared/domain/eyeExportData.ts', { './gazeSmoothing': load('shared/domain/gazeSmoothing.ts') });
const standardColumns = load('shared/constants/eyeExportColumns.ts');
assert.equal(standardColumns.EYE_EXPORT_STANDARD_KEYS.length, 133);
const standard = (key, values, context = {}) => {
  const fields = Object.keys(values);
  return data.resolveExportMeasurement(key, String(values[key] ?? ''), fields.map(key => String(values[key] ?? '')),
    new Map(fields.map((field, index) => [field, index])), context);
};
const pupil = { source_model: 'PupilCore', pupil_center_space: 'eye_image_normalized_top_left',
  pupil_axis_unit: 'image_width_ratio', left_pupil_pixel_valid: 1, left_pupil_pixel_source: 'detected_2d_ellipse',
  left_pupil_center_x: .5, left_pupil_center_y: .25, left_pupil_diameter: .2,
  left_pupil_diameter_px: 80, left_pupil_minor_axis: .1, left_pupil_diameter_mm: 4,
  left_pupil_diameter_mm_valid: 1, left_pupil_valid: 1, left_pupil_model_quality: 'good',
  left_pupil_image_width: 400, left_pupil_image_height: 200, left_pupil_distance: 30,
  left_pupil_minor_axis_mm: 3 };
assert.equal(standard('left_pupil_diameter', pupil), '0.2', 'New ratios must never be divided a second time.');
assert.equal(standard('left_pupil_center_y', pupil), '0.25');
assert.equal(standard('left_pupil_bit_mask', pupil), '29', 'SDK members: center bit0, axis bit2, mm bit3, minor bit4.');
assert.equal(standard('left_pupil_distance', pupil), '', 'Pupil circle Z is not a verified pupil-to-lens distance.');
assert.equal(standard('left_pupil_minor_axis_mm', pupil), '', 'A model circle diameter cannot supply ellipse short-axis mm.');
const historical = { ...pupil, pupil_axis_unit: '', pupil_center_space: 'eye_image_pixels_top_left',
  left_pupil_center_x: 200, left_pupil_center_y: 50, left_pupil_diameter: 80, left_pupil_minor_axis: 40 };
for (const [key, expected] of [['center_x', '.5'], ['center_y', '.25'], ['diameter', '.2'], ['minor_axis', '.1']]) {
  assert.equal(Number(standard(`left_pupil_${key}`, historical)), Number(expected));
  assert.equal(standard(`left_pupil_${key}`, { ...historical, left_pupil_image_width: '', left_pupil_image_height: '' },
    { videoWidth: 1920, videoHeight: 1080 }), '', 'Scene resolution cannot substitute for either eye image.');
}
assert.equal(standard('left_pupil_diameter', { ...historical, left_pupil_diameter: '' }), '0.2', 'Qualified px column maps into the original normalized column with a real eye width.');
assert.equal(standard('left_pupil_bit_mask', { ...historical, left_pupil_image_width: '', left_pupil_image_height: '' }), '8');
assert.equal(standard('left_pupil_bit_mask', { ...pupil, left_pupil_pixel_valid: 0 }), '8');
assert.equal(standard('left_pupil_bit_mask', { ...pupil, left_pupil_model_quality: 'bad', left_pupil_valid: 0, left_pupil_diameter_mm_valid: 0 }), '21', 'Good independent 2D survives bad 3D; mm does not.');
assert.equal(standard('left_pupil_center_x', { ...pupil, left_pupil_center_x: 0 }), '0', 'A measured image-edge zero stays valid.');
assert.equal(standard('right_pupil_bit_mask', pupil), '', 'An unobserved eye has no fabricated validity flag.');
for (const invalid of [-1, 1.2, NaN, Infinity, '']) {
  assert.equal(standard('left_pupil_center_x', { ...pupil, left_pupil_center_x: invalid }), '');
  assert.equal(standard('left_pupil_diameter', { ...pupil, left_pupil_diameter: invalid }), '');
}
const geometry = { source_model: 'PupilCore', geometry_space: 'world_camera_mm', gaze_valid: 1,
  source_topic: 'gaze.3d.1.', gaze_mapping_mode: 'monocular', recom_re: .9 };
for (const field of ['gaze_point', 'raw_point', 'origin', 'direction', 'smooth_point']) {
  ['x', 'y', 'z'].forEach((axis, i) => { geometry[`recom_${field}_${axis}`] = [0, 2, 30][i]; });
}
assert.equal(standard('recom_gaze_bit_mask', geometry), '51');
assert.equal(standard('recom_gaze_point_x', geometry), '0');
assert.equal(standard('recom_origin_x', geometry), '', 'Eye-sphere origin is not the standard corneal-curvature origin.');
assert.equal(standard('recom_smooth_point_x', geometry), '', 'A copied calibrated point is not independent smoothing.');
assert.equal(standard('recom_gaze_point_x', { ...geometry, geometry_space: '', source_backend: 'capture' }), '', 'Historical 2D aliases cannot occupy 3D columns.');
assert.equal(standard('recom_gaze_bit_mask', { ...geometry, gaze_valid: 0 }), '0');
assert.equal(standard('recom_gaze_point_x', { ...geometry, gaze_valid: 0 }), '');
assert.equal(standard('recom_gaze_x', { ...geometry, gaze_valid: 0, recom_gaze_x: .5 }), '');
const independentMono = { ...geometry, gaze_valid: 0, left_gaze_bit_mask: 3,
  left_gaze_point_x: 1, left_gaze_point_y: 2, left_gaze_point_z: 30 };
assert.equal(standard('left_gaze_point_x', independentMono), '1', 'A failed binocular recommendation cannot erase an independently valid eye.');
assert.equal(standard('left_gaze_bit_mask', independentMono), '1');
assert.equal(standard('recommend', geometry), '1');
assert.equal(standard('recommend', { ...geometry, source_topic: 'gaze.3d.0.' }), '2');
assert.equal(standard('recommend', { ...geometry, source_topic: 'gaze.3d.01.', gaze_mapping_mode: 'binocular' }), '');
assert.equal(standard('recommend', { ...geometry, gaze_valid: 0 }), '0');
for (const eye of ['left', 'right']) {
  assert.equal(standard(`${eye}_blink`, { source_model: 'PupilCore', [`${eye}_blink`]: 1 }), '3');
  assert.equal(standard(`${eye}_blink`, { source_model: 'PupilCore', [`${eye}_blink`]: 0 }), '0');
  assert.equal(standard(`${eye}_blink`, { source_model: 'PupilCore' }), '');
}
const fixation = { source_model: 'PupilCore', source_event_type: 'fixation', fixation_center_x: .5, fixation_center_y: .25 };
assert.equal(standard('fixation_center_x', fixation, { videoWidth: 1280 }), '640');
assert.equal(standard('fixation_center_y', fixation, { videoHeight: 720 }), '180');
assert.equal(standard('fixation_center_x', fixation), '');
assert.equal(standard('fixation_center_x', { ...fixation, fixation_point_x_px: 0 }, { videoWidth: 1280 }), '0');
assert.equal(standard('fixation_center_x', { ...fixation, fixation_center_x: -1 }, { videoWidth: 1280 }), '');
for (const key of ['left_pupil_diameter', 'left_blink', 'recom_gaze_bit_mask', 'recom_origin_x']) {
  assert.equal(standard(key, { source_model: '7invensun', [key]: 7 }), '7', 'Other devices retain their original values.');
}

// Exercise the actual CSV IPC, not a duplicate export implementation.
const parser = load('electron/domains/recording/recordCsvParser.ts', {
  '../../../shared/constants/recordPoints': load('shared/constants/recordPoints.ts'),
});
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pupil-standard133-'));
const handlers = {};
let dialogs = 0;
try {
  load('electron/domains/recording/recordExportHandlers.ts', {
    electron: { ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
      dialog: { showOpenDialog: async () => { dialogs++; return { filePaths: [root] }; } } },
    'node:fs': fs, 'node:readline': readline, 'node:path': path,
    './recordPointsModel': parser, '../../../shared/domain/eyeExportData': data,
    './recordAoiExport': { AOI_EXPORT_KEYS: new Set(['aoi_id', 'aoi_name', 'aoi_hit', 'aoi_enter_time_ms', 'aoi_exit_time_ms', 'aoi_dwell_time_ms', 'aoi_fixation_count']), createRecordAoiExportDeriver: async (_path, context) => { assert.equal(context?.projectDir, undefined, 'This legacy fixture has no AOI context; full AOI IPC is covered separately.'); return undefined; } },
  '../../../shared/constants/eyeExportColumns': standardColumns,
  }).registerRecordExportHandlers({ trimFixedDecimal: String });
  const row = { ...historical, ...geometry, ...fixation, left_blink: 1 };
  const fields = Object.keys(row);
  const source = path.join(root, 'source.csv');
  const original = fields.join(',')+'\n'+fields.map(key => row[key]).join(',')+'\n';
  fs.writeFileSync(source, original);
  const record = { id: 'r', name: 'standard', csvPath: source, videoWidth: 1280, videoHeight: 720 };
  const columns = ['left_pupil_center_x', 'left_pupil_center_y', 'left_pupil_diameter', 'left_pupil_minor_axis',
    'left_pupil_diameter_mm', 'left_pupil_bit_mask', 'recom_gaze_point_z', 'recom_origin_z', 'recom_gaze_bit_mask',
    'fixation_center_x', 'fixation_center_y', 'left_blink'];
  const result = await handlers['export-records-csv']({}, { records: [record], columns });
  assert.equal(result.ok, true);
  const output = fs.readFileSync(result.files[0], 'utf8').replace(/^\uFEFF/, '').trimEnd().split('\n').map(parser.parseCsvLineFast);
  assert.deepEqual(Array.from(output[0]), columns);
  assert.deepEqual(Array.from(output[1]), ['0.5', '0.25', '0.2', '0.1', '4', '29', '30', '', '51', '640', '180', '3']);
  assert.equal(fs.readFileSync(source, 'utf8'), original, 'Export never migrates the source recording in place.');
  const dialogCount = dialogs;
  const empty = await handlers['export-records-csv']({}, { records: [record], columns: [] });
  assert.equal(empty.ok, false, 'An empty standard selection cannot silently dump all internal source columns.');
  assert.equal(dialogs, dialogCount);
  for (const column of ['source_model', 'left_pupil_diameter_px', 'gaze_velocity_normalized_ms',
    'world_image_width', 'world_image_height', 'world_resolution_epoch', 'gaze_smoothing_provenance']) {
    const unsupported = await handlers['export-records-csv']({}, { records: [record], columns: [column] });
    assert.equal(unsupported.ok, false, 'Internal fields cannot be exposed by an obsolete nonempty IPC selection.');
    assert.equal(dialogs, dialogCount);
  }
  assert.equal(standardColumns.isStandardEyeExportKey('subject_info::Group'), true);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('Pupil standard columns passed: original units/masks, independent quality, historical conversion, missing evidence, real CSV IPC.');
