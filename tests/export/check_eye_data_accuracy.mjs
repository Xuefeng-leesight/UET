import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import vm from 'node:vm';
import ts from 'typescript';
const compile = source => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText;
function load(file, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(compile(fs.readFileSync(file, 'utf8')), { exports, console,
    require: name => { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; } });
  return exports;
}
const data = load('shared/domain/eyeExportData.ts', { './gazeSmoothing': load('shared/domain/gazeSmoothing.ts') });
const parser = load('electron/domains/recording/recordCsvParser.ts', {
  '../../../shared/constants/recordPoints': load('shared/constants/recordPoints.ts'),
});
const fields = ['video_time_ms', 'timestamp', 'source_model', 'source_backend', 'source_generation', 'source_event_type',
  'recom_gaze_x', 'recom_gaze_y', 'pupil_valid', 'gaze_valid', 'recom_gaze_bit_mask', 'fixation_state', 'fixation_center_x', 'fixation_center_y',
  'fixation_point_x_px', 'fixation_point_y_px', 'gaze_velocity_px_ms', 'gaze_velocity_deg_ms', 'left_blink', 'right_blink',
  'blink_phase', 'blink_pair_status', 'blink_pair_id', 'blink_index', 'blink_duration_ms', 'blink_marker',
  'stimulus', 'source_event_algorithm_parameters', 'gaze_coordinate_space', 'gaze_smoothing', 'gaze_velocity_ms',
  'source_topic', 'gaze_mapping_mode', 'gaze_rejected_eye_ids', 'customMarker', 'triggerMark', 'source_timestamp_s', 'gaze_source_order',
  'pupil_model_quality_policy', ...['left', 'right'].flatMap(eye => ['pixel_confidence', 'pixel_valid', 'pixel_source',
    'projected_diameter_px', 'raw_projected_diameter_px'].map(field => `${eye}_pupil_${field}`))];
const headers = new Map(fields.map((field, index) => [field.toLowerCase(), index]));
const cells = value => fields.map(field => String(value[field] ?? ''));
const gaze = (time, x, extra = {}) => cells({ source_model: 'PupilCore', source_backend: 'native', source_generation: 1,
  video_time_ms: time, recom_gaze_x: x, recom_gaze_y: .5, pupil_valid: 1, ...extra });
const event = (time, extra = {}) => gaze(time, '', { source_event_type: 'fixation', recom_gaze_y: '', pupil_valid: '', fixation_state: 4, ...extra });
for (const value of ['', ' ', null, undefined, false, 'NaN', 'Infinity']) assert.equal(data.finiteCsvNumber(value), null);
assert.equal(data.finiteCsvNumber('0'), 0);
for (const bad of [null, undefined, '', ' ', false, NaN, Infinity, -Infinity]) {
  const numeric = data.buildNumericExportMetadata({ validityPercent: bad, samplingRateHz: bad, configuredSamplingRateHz: bad, durationSeconds: bad });
  assert.deepEqual(Object.values(numeric), ['', '', '', ''], 'Missing/nonfinite metadata never becomes zero or nonnumeric text.');
}
assert.deepEqual(Object.values(data.buildNumericExportMetadata({ validityPercent: 0, samplingRateHz: 118.73, configuredSamplingRateHz: 0, durationSeconds: 0 })), ['0.0', '118.73', '0', '0.0']);
assert.equal(data.formatExportVideoTime(-.1), '', 'A negative timeline is not silently clamped to zero.');
assert.equal(data.resolveExportTimeOfDay('', gaze(1200, .1), headers), '', 'Elapsed time has no civil time without a recording anchor.');
assert.equal(data.resolveExportTimeOfDay('2026-10-24 12:30:00.000', gaze('', .1), headers), '', 'A missing row time is not recording start.');
assert.equal(data.resolveExportTimeOfDay('2026-10-24 23:59:59.995', gaze(10, .1), headers), '00:00:00.005');
assert.equal(data.resolveExportTimeOfDay('2026-10-24 23:59:59.999', gaze(.9, .1), headers), '00:00:00.000');
for (const bad of ['2026-02-30 12:00:00', '2026-10-24 24:00:00', 'garbage', '1234']) {
  assert.equal(data.resolveExportTimeOfDay(bad, gaze(0, .1), headers), '', 'An invalid wall-clock anchor stays missing.');
}
assert.equal(data.resolveExportTimeOfDay('', gaze(0, .1, { timestamp: 1792800000000000 }), headers), '', 'A Pupil time never becomes epoch by magnitude.');
const legacyClockHeaders = new Map([['timestamp', 0]]);
const legacyInstant = new Date('2026-10-24T12:34:56.789Z');
const legacyClock = data.formatExportVideoTime(((legacyInstant.getHours() * 60 + legacyInstant.getMinutes()) * 60 + legacyInstant.getSeconds()) * 1000 + 789);
assert.equal(data.resolveExportTimeOfDay('', [String(legacyInstant.getTime() * 1000)], legacyClockHeaders), legacyClock, '7invensun real microsecond epoch remains available.');
assert.equal(data.resolveExportTimeOfDay('', [String(legacyInstant.getTime())], legacyClockHeaders), legacyClock, 'Legacy millisecond epoch remains available.');
assert.equal(data.resolveExportTimeOfDay('', ['1200'], legacyClockHeaders), '', 'Relative historical timestamps are not civil clocks.');
assert.equal(data.resolveExportMeasurement('timestamp', '1234', gaze('', .1, { timestamp: 1234 }), headers), '', 'A present missing video clock cannot borrow another timestamp.');
const nativeRows = [gaze(0, 0), event(1, { fixation_center_x: .5, fixation_center_y: .5 }), gaze(10, .1, { gaze_velocity_px_ms: 12.8 }),
  gaze(20, '', { pupil_valid: 0 }), event(22), gaze(25, '', { pupil_valid: 0 }), gaze(30, .2), gaze(40, .3),
  gaze(200, .4), gaze(210, .5, { source_generation: 2 }), gaze(220, .6, { source_generation: 2 }),
  gaze(230, .7, { source_generation: 2, gaze_valid: 0 }), gaze(240, .8, { source_generation: 2 }),
  gaze(250, .9, { source_generation: 2, left_blink: 1 }), gaze(260, 1, { source_generation: 2 }),
  event(270, { source_event_type: 'blink', left_blink: 1, blink_index: 4, blink_duration_ms: 80, blink_marker: 1 }),
  gaze(280, '', { pupil_valid: '' }), gaze(290, .4), gaze(300, .5)];
const derived = data.buildDerivedExportRows(nativeRows, headers);
assert.ok(Math.abs(Number(derived[2].gaze_velocity_ms) - .01) < 1e-12);
assert.equal(derived[2].gaze_velocity_unit, 'normalized/ms');
assert.equal(derived[2].gaze_velocity_normalized_ms, derived[2].gaze_velocity_ms);
assert.equal(derived[2].gaze_velocity_px_ms, undefined, 'Pixel velocity is copied only from a measured pixel column.');
assert.equal(derived[0].invalid_gaze_index, undefined, 'Blank fixation status is not invalidity.');
assert.equal(derived[4].invalid_gaze_index, undefined, 'An inserted event never inherits a sample invalid segment.');
assert.equal(derived[3].invalid_gaze_duration_ms, '10');
assert.equal(derived[5].invalid_gaze_duration_ms, '10');
for (const index of [0, 1, 3, 4, 5, 6, 8, 9, 11, 12, 13, 14, 15, 16, 17]) assert.equal(derived[index].gaze_velocity_ms, undefined, `No bridged speed at row ${index}`);
assert.equal(data.resolveExportMeasurement('fixation_center_x', '.5', nativeRows[1], headers), '', 'Normalized Capture/Pupil fixation is not pixels.');
assert.equal(data.resolveExportMeasurement('fixation_center_x', '.5', nativeRows[1], headers, { videoWidth: 1280, videoHeight: 720 }), '640');
assert.equal(data.resolveExportMeasurement('fixation_center_y', '.5', nativeRows[1], headers, { videoWidth: 1280, videoHeight: 720 }), '360');
const measuredFixation = event(50, { fixation_center_x: .5, fixation_point_x_px: 640 });
assert.equal(data.resolveExportMeasurement('fixation_center_x', '.5', measuredFixation, headers), '640');
const sourceSpeed = data.buildDerivedExportRows([gaze(0, 0), gaze(10, .1, { gaze_velocity_ms: 7 })], headers);
assert.equal(sourceSpeed[1].gaze_velocity_unit, 'unspecified_source_unit', 'Do not assign units to a previously stored ambiguous speed.');

// Model/eye changes must not become derived motion, matching the native speed mapper.
const switchedModels = [
  gaze(0, .1, { source_topic: 'gaze.3d.01.', gaze_mapping_mode: 'binocular' }),
  gaze(10, .2, { source_topic: 'gaze.3d.0.', gaze_mapping_mode: 'monocular', gaze_rejected_eye_ids: '1' }),
  gaze(20, .3, { source_topic: 'gaze.3d.0.', gaze_mapping_mode: 'monocular', gaze_rejected_eye_ids: '1' }),
  gaze(30, .4, { source_topic: 'gaze.3d.1.', gaze_mapping_mode: 'monocular', gaze_rejected_eye_ids: '0' }),
  gaze(40, .5, { source_topic: 'gaze.3d.1.', gaze_mapping_mode: 'monocular', gaze_rejected_eye_ids: '0' }),
];
const switched = data.buildDerivedExportRows(switchedModels, headers);
for (const index of [1, 3]) assert.equal(switched[index].gaze_velocity_ms, undefined, 'Bino/mono or left/right changes reset speed.');
for (const index of [2, 4]) assert.ok(switched[index].gaze_velocity_normalized_ms, 'Continuous same-eye gaze still computes speed.');
for (const key of ['source_topic', 'gaze_mapping_mode', 'gaze_rejected_eye_ids']) {
  const changed = [gaze(0, .1, { [key]: 'a' }), gaze(10, .2, { [key]: 'b' })];
  assert.equal(data.buildDerivedExportRows(changed, headers)[1].gaze_velocity_ms, undefined, `${key} independently resets the model context.`);
}
const historicalEyeSwitch = [gaze(0, .1, { source_topic: 'gaze.3d.0.' }), gaze(10, .2, { source_topic: 'gaze.3d.1.' })];
assert.equal(data.buildDerivedExportRows(historicalEyeSwitch, headers)[1].gaze_velocity_ms, undefined, 'Old files without mapping_mode still identify an eye switch through source_topic.');
const lateSourceRows = [gaze(0, .1), gaze(10, .2), gaze(5, .8, { gaze_source_order: 'late_source_time' }), gaze(20, .3), gaze(30, .4)];
const lateDerived = data.buildDerivedExportRows(lateSourceRows, headers);
assert.equal(lateDerived[2].gaze_velocity_ms, undefined, 'A late source sample is preserved without sequential derived motion.');
assert.equal(lateDerived[3].gaze_velocity_ms, undefined, 'Normal samples surrounding a late sample must not bridge the continuity break.');
assert.equal(lateDerived[3].gaze_velocity_normalized_ms, undefined, 'Explicit normalized velocity follows the same continuity break.');
assert.ok(Math.abs(Number(lateDerived[4].gaze_velocity_ms) - .01) < 1e-12, 'The second following normal sample establishes fresh motion continuity.');
const lateInvalid = data.buildDerivedExportRows([gaze(0, '', { pupil_valid: 0 }), gaze(20, '', { pupil_valid: 0 }),
  gaze(10, .2, { gaze_source_order: 'late_source_time' }), gaze(30, .3)], headers);
assert.equal(lateInvalid[0].invalid_gaze_duration_ms, '30');
assert.equal(lateInvalid[2].invalid_gaze_index, undefined, 'Late data is not assigned an arrival-order invalid segment.');
// NativeCsvMapper clears velocity after late delivery before order_csv sorts by source time.
const causalArrivalRows = [gaze(6, .1, { source_topic: 'gaze.3d.0.', gaze_source_order: 'in_order' }),
  gaze(0, .9, { source_topic: 'gaze.3d.1.', gaze_source_order: 'late_source_time' }),
  gaze(20, .5, { source_topic: 'gaze.3d.0.', gaze_source_order: 'in_order' }),
  gaze(30, .6, { source_topic: 'gaze.3d.0.', gaze_source_order: 'in_order', gaze_velocity_px_ms: 12.8 })];
const causalSortedRows = [...causalArrivalRows].sort((a, b) => Number(a[0]) - Number(b[0]));
assert.deepEqual(causalSortedRows.map(row => row[0]), ['0', '6', '20', '30']);
const causalSorted = data.buildDerivedExportRows(causalSortedRows, headers);
assert.equal(causalSorted[2].gaze_velocity_ms, undefined, 'Source-time sorting must not undo the native mapper causal velocity break.');
assert.equal(causalSorted[2].gaze_velocity_normalized_ms, undefined);
assert.ok(Math.abs(Number(causalSorted[3].gaze_velocity_normalized_ms) - .01) < 1e-12, 'An authoritative later velocity restores derived motion using the fresh normal baseline.');
const zeroMotion = [causalArrivalRows[2], gaze(30, .5, { source_topic: 'gaze.3d.0.', gaze_source_order: 'in_order', gaze_velocity_px_ms: 0 })];
assert.equal(data.buildDerivedExportRows(zeroMotion, headers)[1].gaze_velocity_normalized_ms, '0', 'Measured zero pixel velocity is available, not missing.');
const captureMotion = causalSortedRows.map(row => { const copy = [...row]; copy[headers.get('source_backend')] = 'capture'; return copy; });
assert.ok(data.buildDerivedExportRows(captureMotion, headers)[2].gaze_velocity_normalized_ms, 'Capture does not claim the native authoritative velocity contract.');

for (const markerField of ['customMarker', 'triggerMark']) {
  const annotation = cells({ source_model: 'PupilCore', video_time_ms: 10, recom_gaze_bit_mask: 0, [markerField]: 'marker' });
  const annotationInvalid = [gaze(0, '', { pupil_valid: 0 }), annotation, gaze(20, '', { pupil_valid: 0 }), gaze(30, .3)];
  const invalidValues = data.buildDerivedExportRows(annotationInvalid, headers);
  assert.equal(invalidValues[0].invalid_gaze_duration_ms, '30', 'Standalone annotation must not split an invalid sample interval.');
  assert.equal(invalidValues[2].invalid_gaze_index, '1');
  assert.equal(invalidValues[1].invalid_gaze_index, undefined);
  const annotationMotion = data.buildDerivedExportRows([gaze(0, .1), annotation, gaze(20, .3)], headers);
  assert.ok(Math.abs(Number(annotationMotion[2].gaze_velocity_ms) - .01) < 1e-12, 'Annotation does not interrupt motion continuity.');
  assert.equal(annotationMotion[1].gaze_velocity_ms, undefined);
  for (const source_model of ['', 'PupilCore', 'HH_ET28']) {
    const measured = [gaze(0, .1, { source_model, fixation_state: 1, recom_gaze_bit_mask: 1 }),
      gaze(10, .2, { source_model, fixation_state: 1, recom_gaze_bit_mask: 1, [markerField]: 'attached' }),
      gaze(20, .3, { source_model, fixation_state: 1, recom_gaze_bit_mask: 1 })];
    const values = data.buildDerivedExportRows(measured, headers);
    assert.ok(values[1].gaze_velocity_ms, 'A genuine sample with an attached marker is retained for every device.');
  }
}

const annotationRows = [gaze(0, '', { pupil_valid: 0 }),
  cells({ source_model: 'PupilCore', video_time_ms: 10, recom_gaze_bit_mask: 0, customMarker: 'marker only' }),
  gaze(20, '', { pupil_valid: 0 }), gaze(30, .3)];
const gapInvalid = [gaze(0, '', { pupil_valid: 0 }), gaze(10, '', { pupil_valid: 0 }), gaze(200, '', { pupil_valid: 0 }), gaze(210, .3)];
const gapValues = data.buildDerivedExportRows(gapInvalid, headers);
assert.equal(gapValues[0].invalid_gaze_duration_ms, '10', 'Missing intervals do not extend invalid samples.');
assert.equal(gapValues[2].invalid_gaze_index, '2');
const unfinished = [gaze(0, .2), gaze(10, '', { pupil_valid: 0 }), gaze(20, '', { pupil_valid: 0 })];
assert.equal(data.buildDerivedExportRows(unfinished, headers, false)[1].invalid_gaze_duration_ms, undefined, 'Truncated preview cannot complete a segment.');
assert.equal(data.buildDerivedExportRows(unfinished, headers, true)[1].invalid_gaze_duration_ms, '10');
const outOfBounds = [gaze(0, .1), gaze(10, 1.1), gaze(20, .3)];
assert.equal(data.buildDerivedExportRows(outOfBounds, headers)[2].gaze_velocity_ms, undefined, 'Out-of-frame normalized data cannot bridge motion.');
const backwardsTime = [gaze(10, .1), gaze(0, .2)];
assert.equal(data.buildDerivedExportRows(backwardsTime, headers)[1].gaze_velocity_ms, undefined);
const blankTime = [gaze(0, .1), gaze('', .2, { timestamp: 10 }), gaze(20, .3)];
assert.equal(data.buildDerivedExportRows(blankTime, headers)[2].gaze_velocity_ms, undefined, 'Missing video time cannot be silently replaced by another clock.');
const microHeaders = new Map(['timestamp', 'recom_gaze_x', 'recom_gaze_y'].map((key, index) => [key, index]));
assert.ok(Math.abs(Number(data.buildDerivedExportRows([['1700000000000000', '.1', '.5'], ['1700000000010000', '.2', '.5']], microHeaders)[1].gaze_velocity_ms) - .01) < 1e-12);
const largeVideo = [gaze(1700000000000000, .1), gaze(1700000000010000, .2)];
assert.equal(data.buildDerivedExportRows(largeVideo, headers)[1].gaze_velocity_ms, undefined, 'Explicit video milliseconds are never treated as microseconds.');

const captureRows = [gaze(0, 0, { source_backend: 'capture' }),
  event(10, { source_backend: 'capture', source_event_type: 'blink', blink_phase: 'onset', blink_pair_status: 'paired', blink_pair_id: 1 }),
  gaze(20, .1, { source_backend: 'capture' }),
  event(30, { source_backend: 'capture', source_event_type: 'blink', blink_phase: 'offset', blink_pair_status: 'paired', blink_pair_id: 1 }),
  event(40, { source_backend: 'capture', source_event_type: 'blink', blink_phase: 'onset', blink_pair_status: 'unpaired_onset' })];
const capture = data.buildDerivedExportRows(captureRows, headers);
assert.equal(capture[1].blink_duration_ms, '20');
assert.equal(capture[1].blink_marker, '', 'Capture has no measured eye attribution.');
assert.equal(capture[4].blink_index, undefined);
const mismatched = captureRows.slice(0, 4).map(row => [...row]);
mismatched[3][headers.get('blink_pair_id')] = '2';
assert.equal(data.buildDerivedExportRows(mismatched, headers)[1].blink_index, undefined, 'Different source blink pairs cannot cross-pair.');
const legacyRows = [cells({ video_time_ms: 0, fixation_state: 1, recom_gaze_x: .1, recom_gaze_y: .5 }),
  cells({ video_time_ms: 10, fixation_state: 1, recom_gaze_x: .2, recom_gaze_y: .5 }),
  cells({ video_time_ms: 20, fixation_state: 0, left_blink: 1 }), cells({ video_time_ms: 30, fixation_state: 0, right_blink: 1 }),
  cells({ video_time_ms: 40, fixation_state: 1, fixation_center_x: 640 }), cells({ video_time_ms: 50 })];
const legacy = data.buildDerivedExportRows(legacyRows, headers);
assert.equal(legacy[2].invalid_gaze_duration_ms, '20');
assert.equal(legacy[2].blink_marker, '3');
assert.equal(legacy[1].gaze_velocity_unit, 'source_coordinate/ms');
assert.equal(data.resolveExportMeasurement('fixation_center_x', '640', legacyRows[4], headers), '640');
const huahongRows = [gaze(0, .1, { source_model: 'HH_ET28', pupil_valid: '', recom_gaze_bit_mask: 1 }),
  gaze(10, .2, { source_model: 'HH_ET28', pupil_valid: '', recom_gaze_bit_mask: 1 }),
  gaze(20, .3, { source_model: 'HH_ET28', pupil_valid: '', recom_gaze_bit_mask: 0 })];
assert.ok(data.buildDerivedExportRows(huahongRows, headers)[1].gaze_velocity_normalized_ms);
assert.equal(data.buildDerivedExportRows(huahongRows, headers)[2].invalid_gaze_index, '1');

// Exercise the real preview callback, not a duplicate of its column-selection implementation.
const pageSource = fs.readFileSync('src/features/export/ExportPage.tsx', 'utf8');
const ast = ts.createSourceFile('ExportPage.tsx', pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let previewFunction, metadataFunction;
function findPreview(node) {
  if (ts.isVariableDeclaration(node)) {
    if (node.name.getText(ast) === 'previewRecordData') previewFunction = node.initializer;
    if (node.name.getText(ast) === 'buildRecordMetadataValues') metadataFunction = node.initializer.arguments[0];
  }
  ts.forEachChild(node, findPreview);
}
findPreview(ast);
assert.ok(previewFunction);
assert.ok(metadataFunction);
const buildRecordMetadataValues = vm.runInNewContext(compile(`(${metadataFunction.getText(ast)})`), {
  ...data, resolveRecordExportName: record => record.name,
});
// Execute the production initial-selection effect against a snapshot of the established 133-column order.
const legacyFieldOrder = ["record_name","user","eye_data_record","time_of_day","video_time_ms","timestamp","tracking_ratio_pct","sampling_rate_hz","configured_sampling_rate_hz","record_duration_s","left_pupil_bit_mask","left_pupil_center_x","left_pupil_center_y","left_pupil_minor_axis","left_pupil_minor_axis_mm","right_pupil_bit_mask","right_pupil_center_x","right_pupil_center_y","right_pupil_minor_axis","right_pupil_minor_axis_mm","left_pupil_diameter","right_pupil_diameter","left_pupil_diameter_mm","right_pupil_diameter_mm","left_pupil_distance","right_pupil_distance","recommend","recom_gaze_x","recom_gaze_y","recom_gaze_bit_mask","recom_gaze_point_x","recom_gaze_point_y","recom_gaze_point_z","recom_raw_point_x","recom_raw_point_y","recom_raw_point_z","recom_smooth_point_x","recom_smooth_point_y","recom_smooth_point_z","recom_origin_x","recom_origin_y","recom_origin_z","recom_direction_x","recom_direction_y","recom_direction_z","recom_re","left_gaze_x","left_gaze_y","left_gaze_bit_mask","left_gaze_point_x","left_gaze_point_y","left_gaze_point_z","left_raw_point_x","left_raw_point_y","left_raw_point_z","left_smooth_point_x","left_smooth_point_y","left_smooth_point_z","left_origin_x","left_origin_y","left_origin_z","left_direction_x","left_direction_y","left_direction_z","left_re","right_gaze_x","right_gaze_y","right_gaze_bit_mask","right_gaze_point_x","right_gaze_point_y","right_gaze_point_z","right_raw_point_x","right_raw_point_y","right_raw_point_z","right_smooth_point_x","right_smooth_point_y","right_smooth_point_z","right_origin_x","right_origin_y","right_origin_z","right_direction_x","right_direction_y","right_direction_z","right_re","fixation_timestamp","fixation_duration","fixation_count","fixation_state","fixation_center_x","fixation_center_y","invalid_gaze_index","invalid_gaze_duration_ms","saccade_index","saccade_duration_ms","saccade_amplitude_px","average_saccade_velocity_px_ms","peak_saccade_velocity_px_ms","gaze_velocity_px_ms","gaze_velocity_deg_ms","saccade_distance_deg","average_saccade_velocity_deg_ms","peak_saccade_velocity_deg_ms","gaze_velocity_ms","blink_index","blink_duration_ms","blink_marker","left_blink","left_openness","left_eyelid_up","left_eyelid_down","right_blink","right_openness","right_eyelid_up","right_eyelid_down","gyro_timestamp","gyro_quaternion","gyroscope","acceleration","magnetometer","aoi_id","aoi_name","aoi_hit","aoi_enter_time_ms","aoi_exit_time_ms","aoi_dwell_time_ms","aoi_fixation_count","stimulus","triggerMark","customMarker","udp_send","udp_receive","trigger_send","trigger_receive"];
const legacyHeaders = ["Record name","User","Eye data record","Time of day[hh:mm:ss.ms]","Video time[hh:mm:ss.ms]","Timestamp[ms]","Tracking ratio[%]","Sampling rate hz","Configured sampling rate hz","Record duration s","Left pupil bit mask","Left pupil center x","Left pupil center y","Left pupil minor axis","Left pupil minor axis mm","Right pupil bit mask","Right pupil center x","Right pupil center y","Right pupil minor axis","Right pupil minor axis mm","Left pupil diameter","Right pupil diameter","Left pupil diameter mm","Right pupil diameter mm","Left pupil distance","Right pupil distance","Recommend","Recom gaze x","Recom gaze y","Recom gaze bit mask","Recom gaze point x","Recom gaze point y","Recom gaze point z","Recom raw point x","Recom raw point y","Recom raw point z","Recom smooth point x","Recom smooth point y","Recom smooth point z","Recom origin x","Recom origin y","Recom origin z","Recom direction x","Recom direction y","Recom direction z","Recom re","Left gaze x","Left gaze y","Left gaze bit mask","Left gaze point x","Left gaze point y","Left gaze point z","Left raw point x","Left raw point y","Left raw point z","Left smooth point x","Left smooth point y","Left smooth point z","Left origin x","Left origin y","Left origin z","Left direction x","Left direction y","Left direction z","Left re","Right gaze x","Right gaze y","Right gaze bit mask","Right gaze point x","Right gaze point y","Right gaze point z","Right raw point x","Right raw point y","Right raw point z","Right smooth point x","Right smooth point y","Right smooth point z","Right origin x","Right origin y","Right origin z","Right direction x","Right direction y","Right direction z","Right re","Fixation timestamp[ms]","Fixation duration[ms]","Fixation index","Fixation state","Fixation point x[px]","Fixation point y[px]","Invalid gaze index","Invalid gaze duration[ms]","Saccade index","Saccade duration[ms]","Saccade amplitude[px]","Average saccade velocity[px/ms]","Peak saccade velocity[px/ms]","Gaze velocity[px/ms]","Gaze velocity[deg/ms]","Saccade distance[deg]","Average saccade velocity[deg/ms]","Peak saccade velocity[deg/ms]","Gaze velocity ms","Blink index","Blink duration[ms]","Blink marker","Left blink","Left openness","Left eyelid up","Left eyelid down","Right blink","Right openness","Right eyelid up","Right eyelid down","Gyroscope timestamp","Quat_data","Gyro","Accel","Mag","Aoi id","Aoi name","Aoi hit","Aoi enter time ms","Aoi exit time ms","Aoi dwell time ms","Aoi fixation count","Stimulus","Trigger mark","Custom marker","Udp send","Udp receive","Trigger send","Trigger receive"];
let categoryInitializer, defaultSelectionEffect, selectAllHandler, groupedColumnsFunction;
function findDefaults(node) {
  if (ts.isVariableDeclaration(node)) {
    if (node.name.getText(ast) === 'EXPORT_CATEGORY_DEFS') categoryInitializer = node.initializer;
    if (node.name.getText(ast) === 'groupedColumns') groupedColumnsFunction = node.initializer.arguments[0];
  }
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'React.useEffect' &&
      node.arguments[1]?.getText(ast) === '[availableColumns, subjectAttributeFieldKeys]') defaultSelectionEffect = node.arguments[0];
  if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'onClick' &&
      node.initializer?.getText(ast).includes('setSelectedColumns(new Set(availableColumns))')) selectAllHandler = node.initializer.expression;
  ts.forEachChild(node, findDefaults);
}
findDefaults(ast);
assert.ok(defaultSelectionEffect);
assert.ok(selectAllHandler);
assert.ok(groupedColumnsFunction);
const categories = vm.runInNewContext(compile(`(${categoryInitializer.getText(ast)})`), {});
const allFields = categories.flatMap(category => category.fields);
const availableColumns = allFields.map(field => field.key);
const fieldByKey = Object.fromEntries(allFields.map(field => [field.key, field]));
assert.deepEqual(Array.from(availableColumns), legacyFieldOrder, 'The actual selectable product fields are exactly the established 133 keys in order.');
const standardManifest = load('shared/constants/eyeExportColumns.ts');
assert.deepEqual(Array.from(standardManifest.EYE_EXPORT_STANDARD_KEYS), legacyFieldOrder, 'IPC allowlist and rendered product selection share the same standard field contract.');
assert.equal(new Set(availableColumns).size, 133);
assert.ok(!fs.existsSync('src/features/export/domain/eyeExportMetadata.ts'), 'No unused extended export registry remains.');
let selectedColumns = new Set();
let includeSubjectAttributes = false;
const selectionScope = { availableColumns, subjectAttributeFieldKeys: [],
  setSelectedColumns: update => { selectedColumns = typeof update === 'function' ? update(selectedColumns) : update; },
  setIncludeSubjectAttributes: value => { includeSubjectAttributes = value; },
};
const selectionEffect = vm.runInNewContext(compile(`(${defaultSelectionEffect.getText(ast)})`), selectionScope);
selectionEffect();
assert.equal(selectedColumns.size, 133);
assert.deepEqual(Array.from(selectedColumns), legacyFieldOrder, 'Default selection preserves all standard fields and their order.');
selectedColumns = new Set(['source_model', 'gaze_velocity_normalized_ms', 'record_name']);
selectionEffect();
assert.deepEqual(Array.from(selectedColumns), ['record_name'], 'Stale extension selections are removed instead of remaining available.');
const selectAll = vm.runInNewContext(compile(`(${selectAllHandler.getText(ast)})`), selectionScope);
selectAll();
assert.deepEqual(Array.from(selectedColumns), legacyFieldOrder, 'The actual Select All handler selects only the standard 133 fields.');
assert.equal(includeSubjectAttributes, false);

// Existing user-defined subject attributes remain a separate established capability.
const subjectAttributeFields = [{ key: 'subject_info::%E7%BB%84%E5%88%AB', label: '组别', sources: [] }];
const dynamicGroups = vm.runInNewContext(compile(`(${groupedColumnsFunction.getText(ast)})`), {
  EXPORT_CATEGORY_DEFS: categories, subjectAttributeFields,
})();
const withSubjectAttributes = dynamicGroups.flatMap(group => group.fields.map(field => field.key));
selectionScope.availableColumns = withSubjectAttributes;
selectionScope.subjectAttributeFieldKeys = subjectAttributeFields.map(field => field.key);
selectedColumns = new Set();
selectionEffect();
assert.deepEqual(Array.from(selectedColumns), legacyFieldOrder, 'Subject fields remain excluded from the initial standard selection.');
selectAll();
assert.deepEqual(Array.from(selectedColumns), Array.from(withSubjectAttributes));
assert.equal(includeSubjectAttributes, true, 'Select All still includes the established subject attributes when they exist.');
assert.equal(selectedColumns.size, 134);
selectionScope.availableColumns = availableColumns;
selectionScope.subjectAttributeFieldKeys = [];

const columns = legacyFieldOrder;
const columnSourceMap = Object.fromEntries(allFields.map(field => [field.key, field.sources?.length ? field.sources : [field.key]]));
const columnJoinSourceMap = Object.fromEntries(allFields.filter(field => field.joinSources?.length).map(field => [field.key, field.joinSources]));
const columnHeaderMap = Object.fromEntries(allFields.map(field => [field.key,
  (field.header ?? field.key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_:]+/g, ' ').trim()).toLowerCase().replace(/[a-z]/, letter => letter.toUpperCase())]));
assert.deepEqual(columns.map(key => columnHeaderMap[key]), legacyHeaders, 'All 133 existing headers remain unchanged.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eye-export-accuracy-'));
const handlers = {};
const csv = value => /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
try {
  load('electron/domains/recording/recordExportHandlers.ts', {
    electron: { ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, dialog: { showOpenDialog: async () => ({ filePaths: [root] }) } },
    'node:fs': fs, 'node:readline': readline, 'node:path': path, './recordPointsModel': parser,
    '../../../shared/domain/eyeExportData': data,
    './recordAoiExport': { AOI_EXPORT_KEYS: new Set(['aoi_id', 'aoi_name', 'aoi_hit', 'aoi_enter_time_ms', 'aoi_exit_time_ms', 'aoi_dwell_time_ms', 'aoi_fixation_count']), createRecordAoiExportDeriver: async (_path, context) => { assert.equal(context?.projectDir, undefined, 'This legacy fixture has no AOI context; full AOI IPC is covered separately.'); return undefined; } },
  '../../../shared/constants/eyeExportColumns': standardManifest,
  }).registerRecordExportHandlers({ trimFixedDecimal: (value, digits) => String(Number(value.toFixed(digits))) });
  for (const [name, rows] of [['native', [...nativeRows, measuredFixation, gaze(310, .6, { source_event_algorithm_parameters: '{"threshold":40,"unit":"deg/s"}', gaze_smoothing: 'unavailable', source_timestamp_s: -3.125, gaze_source_order: 'late_source_time',
      pupil_model_quality_policy: 'mrt_pupil_model_bounds_v1', left_pupil_pixel_confidence: .2, left_pupil_pixel_valid: 0,
      left_pupil_pixel_source: 'detected_2d_ellipse', left_pupil_projected_diameter_px: 41.5, left_pupil_raw_projected_diameter_px: 41.5,
      right_pupil_pixel_confidence: .9, right_pupil_pixel_valid: 1, right_pupil_pixel_source: 'source_3d_datum',
      right_pupil_projected_diameter_px: '', right_pupil_raw_projected_diameter_px: 50 })]], ['capture', captureRows], ['legacy', legacyRows], ['huahong', huahongRows], ['annotations', annotationRows], ['late-source', lateSourceRows], ['causal-sorted', causalSortedRows]]) {
    const source = path.join(root, `${name}-source.csv`);
    fs.writeFileSync(source, [fields.join(','), ...rows.map(row => row.map(csv).join(','))].join('\n'));
    const record = { id: name, name, csvPath: source, timestamp: '2026-10-24 23:59:59.990',
      validityPercent: null, samplingRateHz: 118.73, configuredSamplingRateHz: NaN, durationSeconds: 0, videoWidth: 1280, videoHeight: 720 };
    let previewRows, previewError;
    const preview = vm.runInNewContext(compile(`(${previewFunction.getText(ast)})`), {
      ...data, projectDir: null, isEn: true, exportModality: 'eye-tracking', previewOperationRef: { current: 0 },
      ipcClient: { isAvailable: () => true, previewRecordCsv: async () => ({ ok: true, headers: fields, rows, truncated: false }) },
      setFeedback: () => {}, setPreviewRecord: () => {}, setPreviewLoading: () => {}, setPreviewData: value => { previewRows = value; },
      setPreviewError: value => { previewError = value; }, availableColumns: columns, selectedColumns: new Set(columns), columnSourceMap,
      columnJoinSourceMap, buildSubjectInfoForRecord: () => ({}), buildRecordMetadataValues, getColumnHeader: key => columnHeaderMap[key],
    });
    await preview(record);
    assert.ok(!previewError, previewError);
    const result = await handlers['export-records-csv']({}, { records: [record], columns, columnSourceMap, columnJoinSourceMap, headerMap: columnHeaderMap });
    assert.equal(result.ok, true);
    const output = fs.readFileSync(result.files[0], 'utf8').trim().replace(/^\uFEFF/, '').split('\n').map(line => parser.parseCsvLineFast(line).map(cell => cell.replace(/^\t/, '')));
    assert.deepEqual(JSON.parse(JSON.stringify(previewRows)), JSON.parse(JSON.stringify(output)), `${name}: actual preview and disk export must agree`);
    assert.equal(output[0].length, 133, 'User CSV output has only the established standard columns.');
    assert.deepEqual(Array.from(output[0]), legacyHeaders);
    assert.equal(previewRows[0].length, 133, 'The actual preview exposes only the standard columns.');
    const original = [fields.join(','), ...rows.map(row => row.map(csv).join(','))].join('\n');
    assert.equal(fs.readFileSync(source, 'utf8'), original, 'Standard export does not mutate archived measurements or internal provenance.');
    const rawOutput = original.split('\n').map(parser.parseCsvLineFast);
    if (name === 'late-source') {
      assert.equal(rawOutput.length, rows.length + 1, 'Late data is retained as a source row.');
      assert.equal(rawOutput[3][headers.get('recom_gaze_x')], '0.8');
      assert.equal(rawOutput[3][headers.get('gaze_source_order')], 'late_source_time');
      assert.equal(output[4][columns.indexOf('gaze_velocity_ms')], '', 'Actual CSV export does not bridge a late-source discontinuity.');
    }
    if (name === 'causal-sorted') {
      for (const key of ['gaze_velocity_ms', 'gaze_velocity_px_ms']) {
        assert.equal(output[3][columns.indexOf(key)], '', 'Sorted native CSV preserves the causal missing velocity at t20.');
      }
      assert.equal(output[4][columns.indexOf('gaze_velocity_px_ms')], '12.8', 'Authoritative pixel velocity is copied without alteration.');
      assert.ok(Math.abs(Number(output[4][columns.indexOf('gaze_velocity_ms')]) - .01) < 1e-12);
      for (const key of ['recom_gaze_x', 'gaze_source_order', 'gaze_velocity_px_ms']) {
        assert.deepEqual(rawOutput.slice(1).map(row => row[headers.get(key)]), rows.map(row => row[headers.get(key)]), `${key}: original sorted data is preserved.`);
      }
    }

  }
  const timeSource = path.join(root, 'time-source.csv');
  fs.writeFileSync(timeSource, 'video_time_ms,timestamp,source_model,fixation_center_x\n,,PupilCore,0.5\n0,0,PupilCore,0\n');
  const timeResult = await handlers['export-records-csv']({}, { records: [{ name: 'time-export', csvPath: timeSource }],
    columns: ['video_time_ms', 'fixation_center_x', 'gaze_velocity_ms'],
    headerMap: { video_time_ms: 'Video time[HH:mm:ss.ms]', fixation_center_x: 'Fixation point x[px]', gaze_velocity_ms: 'Gaze velocity ms' } });
  assert.equal(timeResult.ok, true);
  const timeRows = fs.readFileSync(timeResult.files[0], 'utf8').trimEnd().replace(/^\uFEFF/, '').split('\n').map(parser.parseCsvLineFast);
  assert.deepEqual(Array.from(timeRows[0]), ['Video time[HH:mm:ss.ms]', 'Fixation point x[px]', 'Gaze velocity ms'], 'Legacy headers remain compatible.');
  assert.equal(timeRows[1][0], '', 'Missing source video time stays blank, not fabricated zero.');
  assert.equal(timeRows[2][0], '\t00:00:00.000', 'Real zero time remains a measurement.');
  for (const overrides of [undefined, { tracking_ratio_pct: null, sampling_rate_hz: NaN, configured_sampling_rate_hz: 'Infinity', record_duration_s: '' }]) {
    const missingResult = await handlers['export-records-csv']({}, { records: [{ name: 'missing-metadata', csvPath: timeSource,
      validityPercent: null, samplingRateHz: '', configuredSamplingRateHz: Infinity, durationSeconds: undefined, metadataValues: overrides }],
      columns: ['time_of_day', 'timestamp', 'tracking_ratio_pct', 'sampling_rate_hz', 'configured_sampling_rate_hz', 'record_duration_s'], columnSourceMap });
    assert.equal(missingResult.ok, true);
    const missingRows = fs.readFileSync(missingResult.files[0], 'utf8').trimEnd().replace(/^\uFEFF/, '').split('\n').map(parser.parseCsvLineFast);
    assert.deepEqual(Array.from(missingRows[1]), ['', '', '', '', '', '']);
    assert.deepEqual(Array.from(missingRows[2]), ['', '\t0', '', '', '', ''], 'Without an anchor real video zero stays zero; wall time stays unknown.');
  }
  const legacyTimeSource = path.join(root, 'legacy-clock.csv');
  fs.writeFileSync(legacyTimeSource, `timestamp\n${legacyInstant.getTime() * 1000}\n`);
  const legacyTimeResult = await handlers['export-records-csv']({}, { records: [{ name: 'legacy-clock-export', csvPath: legacyTimeSource }], columns: ['time_of_day'] });
  assert.equal(legacyTimeResult.ok, true);
  const legacyTimeRows = fs.readFileSync(legacyTimeResult.files[0], 'utf8').trimEnd().replace(/^\uFEFF/, '').split('\n').map(parser.parseCsvLineFast);
  assert.equal(legacyTimeRows[1][0], '\t' + legacyClock, 'Actual IPC export preserves a legacy device civil time.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('Eye export accuracy passed: real preview/export parity, missing/zero metadata, precise Hz, source/civil time, exactly 133 standard fields, unchanged headers, default/select-all, subject attributes, units, gaps, events, native/Capture blinks, 7invensun and Huahong compatibility.');
