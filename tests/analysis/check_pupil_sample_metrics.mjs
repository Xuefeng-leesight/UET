// Full-path statistical regression: actual samples stay separate from events.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const modules = new Map();
const handlers = {};
function load(file) {
  file = path.resolve(file);
  if (modules.has(file)) return modules.get(file);
  const exports = {};
  modules.set(file, exports);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(js, { exports, process, console, Buffer, setTimeout, clearTimeout,
    require(name) {
      if (name === 'electron') return { ipcMain: { handle: (name, handler) => { handlers[name] = handler; } } };
      let target = name.startsWith('@/') ? path.resolve('src', name.slice(2))
        : name.startsWith('@shared/') ? path.resolve('shared', name.slice(8))
        : name.startsWith('.') ? path.resolve(path.dirname(file), name) : null;
      if (!target) return require(name);
      return load(target + '.ts');
    },
  }, { filename: file });
  return exports;
}
const parser = load('electron/domains/recording/recordCsvParser.ts');
const index = load('electron/domains/recording/recordPointsIndex.ts');
const { computeAoiStatsRows } = load('shared/domain/aoi/aoiReport.ts');
const { buildCompareResult } = load('src/features/analysis/reports/compareEngine.ts');
const { normalizePointsToDurationMs } = load('src/features/analysis/aoi/aoiAnalysisModel.ts');
load('electron/domains/recording/recordPointHandlers.ts').registerRecordPointHandlers();

const headers = ['source_model', 'source_event_type', 'video_time_ms', 'recom_gaze_x', 'recom_gaze_y',
  'recom_gaze_bit_mask', 'left_pupil_diameter_mm', 'right_pupil_diameter_mm', 'left_pupil_diameter',
  'left_pupil_model_quality', 'right_pupil_model_quality', 'left_pupil_diameter_mm_valid', 'right_pupil_diameter_mm_valid',
  'left_pupil_valid', 'right_pupil_valid',
  'left_blink', 'right_blink', 'fixation_state', 'fixation_index', 'fixation_center_x', 'fixation_center_y',
  'fixation_duration_ms', 'fixation_timestamp_ms', 'saccade_index', 'saccade_duration_ms', 'saccade_distance_px',
  'average_saccade_velocity_px_ms', 'peak_saccade_velocity_px_ms', 'saccade_start_x', 'saccade_start_y', 'saccade_end_x', 'saccade_end_y'];
const parts = values => headers.map(key => String(values[key] ?? ''));
const base = { source_model: 'PupilCore', recom_gaze_x: .25, recom_gaze_y: .25, recom_gaze_bit_mask: 1,
  left_pupil_diameter_mm: 3, right_pupil_diameter_mm: 4 };
const gaze = values => parser.parseCsvPartsToHeatmapPoint(parts({ ...base, ...values }), parser.makeCsvPointParserState(headers, { pointMode: 'gaze' }));
assert.equal(gaze({}).pupilDiameter, 3.5);
assert.equal(gaze({ left_pupil_diameter_mm: -1 }).pupilDiameter, 4);
assert.equal(gaze({ left_pupil_diameter_mm: Infinity }).pupilDiameter, 4);
assert.equal(gaze({ left_blink: 1 }).pupilDiameter, 4);
assert.equal(gaze({ left_pupil_model_quality: 'bad' }).pupilDiameter, 4);
assert.equal(gaze({ left_pupil_diameter_mm_valid: 0 }).pupilDiameter, 4);
assert.equal(gaze({ left_pupil_valid: 0, left_pupil_model_quality: 'good' }).pupilDiameter, 4,
  'historical invalid detection must not become valid because a 3D model has good quality');
assert.equal(gaze({ right_pupil_valid: 0, right_pupil_model_quality: 'good' }).pupilDiameter, 3);
assert.equal(gaze({ left_pupil_valid: 0, right_pupil_valid: 0 }).pupilDiameter, undefined);
assert.equal(gaze({ left_pupil_valid: '', right_pupil_valid: '' }).pupilDiameter, 3.5,
  'missing historical validity declaration remains unknown, not invalid');
assert.equal(gaze({ left_pupil_model_quality: 'unknown' }).pupilDiameter, 3.5);
assert.equal(gaze({ left_pupil_diameter_mm: '', right_pupil_diameter_mm: '', left_pupil_diameter: 40 }).pupilDiameter, undefined);
assert.equal(gaze({ source_event_type: 'fixation' }), null);
assert.equal(gaze({ recom_gaze_bit_mask: 0 }), null);
const statisticalSample = values => parser.parseCsvPartsToHeatmapPoint(parts({ ...base, ...values }),
  parser.makeCsvPointParserState(headers, { pointMode: 'gaze', pupilSamplesOnly: true }));
for (const invalidTime of ['', NaN, Infinity]) {
  assert.equal(statisticalSample({ video_time_ms: invalidTime }), null,
    'missing or invalid sample timestamps must not become video time zero');
}
assert.equal(statisticalSample({ video_time_ms: 0 }).timestamp, 0, 'genuine video time zero remains valid');
const authoritativeHeaders = [...headers, 'timestamp'];
for (const invalidVideoTime of ['', NaN, Infinity]) {
  assert.equal(parser.parseCsvPartsToHeatmapPoint(
    [...parts({ ...base, video_time_ms: invalidVideoTime }), '1790000000000'],
    parser.makeCsvPointParserState(authoritativeHeaders, { pointMode: 'gaze', pupilSamplesOnly: true }),
  ), null, 'an explicit video clock must not fall back to an epoch or device clock on a missing row value');
}
const historicalHeaders = headers.filter(header => header !== 'video_time_ms').concat('timestamp');
const historicalValues = { ...base, timestamp: 1000 };
assert.equal(parser.parseCsvPartsToHeatmapPoint(
  historicalHeaders.map(header => String(historicalValues[header] ?? '')),
  parser.makeCsvPointParserState(historicalHeaders, { pointMode: 'gaze', pupilSamplesOnly: true }),
).timestamp, 1000, 'records without a video-time column retain the historical timestamp path');
// Historical 7invensun unqualified pupil diameter remains readable.
assert.equal(gaze({ source_model: '', left_pupil_diameter_mm: '', right_pupil_diameter_mm: '', left_pupil_diameter: 3.25 }).pupilDiameter, 3.25);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mrt-pupil-analysis-'));
try {
  const csvPath = path.join(tmp, 'record.csv');
  const rows = [
    parts({ ...base, video_time_ms: 1000 }),
    parts({ ...base, video_time_ms: 1050, left_pupil_diameter_mm: 4, right_pupil_diameter_mm: 4 }),
    parts({ ...base, video_time_ms: 1100, left_pupil_diameter_mm: '', right_pupil_diameter_mm: 5 }),
    parts({ ...base, video_time_ms: 1150, recom_gaze_bit_mask: 0 }),
    parts({ source_model: 'PupilCore', source_event_type: 'fixation', video_time_ms: 1000,
      fixation_state: 4, fixation_index: 1, fixation_center_x: .25, fixation_center_y: .25,
      fixation_duration_ms: 120, fixation_timestamp_ms: 1000 }),
    parts({ source_model: 'PupilCore', source_event_type: 'saccade', video_time_ms: 1200,
      fixation_state: 2, saccade_index: 1, fixation_center_x: .75, fixation_center_y: .25,
      saccade_duration_ms: 20, saccade_distance_px: 200, average_saccade_velocity_px_ms: 8,
      peak_saccade_velocity_px_ms: 10, saccade_start_x: .25, saccade_start_y: .25, saccade_end_x: .75, saccade_end_y: .25 }),
  ];
  const csv = [headers.join(','), ...rows.map(row => row.join(','))].join('\n') + '\n';
  fs.writeFileSync(csvPath, csv);
  const result = await handlers['load-record-points']({}, { csvPath, pointMode: 'fixation', includeSdkSaccades: true,
    includePupilSamples: true, frameWidth: 1280, frameHeight: 720 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.truncated, false);
  assert.equal(result.points.length, 2);
  assert.equal(result.pupilSamples.length, 4);
  assert.equal(result.pupilSamples.find(point => point.timestamp === 1150).samplePositionValid, false);
  assert.ok(Number.isNaN(result.pupilSamples.find(point => point.timestamp === 1150).x), 'missing gaze must not be fabricated');
  assert.equal(result.pupilSamples.every(point => point.sampleOnly && point.timeBase === 'video_time_ms'), true);
  assert.equal(result.points.every(point => point.pupilSamplesIncluded), true);
  assert.equal(result.points[1].saccadeMetricUnit, 'pixels');
  assert.equal(fs.readFileSync(csvPath, 'utf8'), csv, 'raw CSV must not be modified by analysis');
  const meta = await index.buildRecordPointsIndex(csvPath, fs.statSync(csvPath), index.getRecordPointsIndexOptions({}));
  const exact = await index.loadRecordPointsFromIndex(meta, 'gaze', { maxPoints: 2, includeMarkerOnlyRows: false, exact: true, pupilSamplesOnly: true });
  assert.equal(exact.points.length, 4, 'exact statistics must not apply display decimation');
  assert.equal(exact.truncated, false);
  const display = await index.loadRecordPointsFromIndex(meta, 'gaze', { maxPoints: 2, includeMarkerOnlyRows: false });
  assert.equal(display.truncated, true, 'normal visualization still honors its memory cap');

  const points = [...result.points, ...result.pupilSamples];
  const originalTimes = points.map(point => point.timestamp);
  const shape = { id: 'a', name: 'Target', type: 'rect', color: 'sky', visible: true, showStats: true, x: 0, y: 0, w: 1, h: 1 };
  const stats = computeAoiStatsRows({ shapes: [shape], points, frameWidth: 1280, recordDurationMs: 10000 })[0];
  assert.equal(stats.fixationCount, 1, 'samples must never inflate event counts');
  assert.equal(stats.totalDurationMs, 120);
  assert.equal(stats.pupilSampleCount, 3);
  assert.equal(stats.avgPupilDiameter, 12.5 / 3);
  assert.equal(stats.avgSaccadeAmplitude, 200, 'pixel amplitude must not be multiplied by frame width again');
  assert.equal(stats.avgSaccadeVelocity, 8);
  assert.equal(stats.peakSaccadeVelocity, 10);
  assert.deepEqual(points.map(point => point.timestamp), originalTimes, 'statistics must not mutate source timestamps');
  assert.deepEqual(Array.from(normalizePointsToDurationMs(points, 10000), p => p.timestamp), [1000, 1000, 1050, 1100, 1150, 1200]);
  const roundTripped = JSON.parse(JSON.stringify(points));
  assert.equal(computeAoiStatsRows({ shapes: [shape], points: roundTripped })[0].pupilSampleCount, 3,
    'explicit invalid-position flag survives JSON replacing NaN with null');
  const windowShape = { ...shape, analysisTimeRanges: [{ id: 'range', startTimeMs: 1040, endTimeMs: 1110 }] };
  const windowStats = computeAoiStatsRows({ shapes: [windowShape], points, recordDurationMs: 10000 })[0];
  assert.equal(windowStats.pupilSampleCount, 2);
  assert.equal(windowStats.avgPupilDiameter, 4.5);
  assert.equal(windowStats.fixationCount, 0);
  const startWindowShape = { ...shape, analysisTimeRanges: [{ id: 'start', startTimeMs: 0, endTimeMs: 1 }] };
  const untimedSamples = [undefined, NaN, Infinity].map(timestamp => ({
    sampleOnly: true, samplePositionValid: true, x: .25, y: .25, pupilDiameter: 4, timestamp,
  }));
  assert.equal(computeAoiStatsRows({ shapes: [startWindowShape], points: untimedSamples })[0].pupilSampleCount, 0);
  assert.equal(computeAoiStatsRows({ shapes: [startWindowShape], points: [{
    ...untimedSamples[0], timestamp: 0, timeBase: 'video_time_ms',
  }] })[0].pupilSampleCount, 1);
  assert.equal(computeAoiStatsRows({ shapes: [startWindowShape], points: normalizePointsToDurationMs([
    ...untimedSamples, { ...untimedSamples[0], timestamp: 0, timeBase: 'video_time_ms' },
  ], 10000) })[0].pupilSampleCount, 1, 'renderer normalization must also preserve missing sample time');
  assert.equal(computeAoiStatsRows({ shapes: [{ ...shape, activationTimeMs: 1150 }], points })[0].pupilSampleCount, 0);
  const dynamic = { ...shape, w: .5, h: .5, keyframes: [
    { id: 'start', timeMs: 1000, x: 0, y: 0, w: .5, h: .5 },
    { id: 'end', timeMs: 1100, x: .6, y: 0, w: .4, h: .5 },
  ] };
  assert.equal(computeAoiStatsRows({ shapes: [dynamic], points })[0].pupilSampleCount, 1,
    'each sample must be hit-tested at the moving AOI position at its own time');

  const config = { recordIds: ['r'], groupBy: 'subject' };
  const records = [{ id: 'r', name: 'Pupil', durationSeconds: 10 }];
  const build = (customPoints = points, customConfig = config, customRecords = records) => buildCompareResult({
    config: customConfig, records: customRecords, pointsByRecord: { r: customPoints }, aoiRowsByRecord: {},
  });
  const comparison = build();
  assert.equal(comparison.records[0].metrics.avgPupilDiameter, 4, 'full-record pupil statistics include valid pupil without valid gaze');
  assert.equal(comparison.records[0].metrics.fixationCount, 1);
  assert.equal(comparison.records[0].metrics.samplingRateHz, null, 'event rate is not device sample rate');
  assert.equal(comparison.metrics.find(metric => metric.key === 'avgSaccadeVelocity').unit, 'px/ms');
  assert.equal(comparison.records[0].metrics.avgSaccadeVelocity, 8);
  const segmentRecord = { ...records[0], timelineSegments: [{ name: 'window', startTime: 1.04, endTime: 1.11 }] };
  assert.equal(build(points, { ...config, segmentName: 'window' }, [segmentRecord]).records[0].metrics.avgPupilDiameter, 4.5);
  assert.equal(build(result.points).records[0].metrics.avgPupilDiameter, null, 'empty complete sample data must remain missing');
  const mixed = build([...points, { x: .5, y: .5, fixationState: 2, saccadeAmplitude: .1, saccadeVelocity: .002, saccadeMetricUnit: 'normalized' }]);
  assert.equal(mixed.records[0].metrics.avgSaccadeVelocity, null);
  assert.equal(mixed.notes.some(note => note.includes('两种单位')), true);
  const noAmplitude = build([{ x: .5, y: .5, fixationState: 2, timestamp: 2000, saccadeMetricUnit: 'pixels', saccadeDurationMs: 20, saccadeVelocity: 8 }]);
  assert.equal(noAmplitude.records[0].metrics.avgSaccadeAmplitude, null);
  assert.equal(noAmplitude.records[0].metrics.avgSaccadeVelocity, 8);
  const noAmplitudeAoi = computeAoiStatsRows({ shapes: [shape], points: [{ x: .5, y: .5, fixationState: 2, timestamp: 2000, timeBase: 'video_time_ms', saccadeMetricUnit: 'pixels', saccadeDurationMs: 20, saccadeVelocity: 8 }] })[0];
  assert.equal(noAmplitudeAoi.avgSaccadeAmplitude, null);
  assert.equal(noAmplitudeAoi.avgSaccadeVelocity, 8);
  assert.equal(noAmplitudeAoi.peakSaccadeVelocity, null);
  const legacy = build([{ x: .5, y: .5, id: 1, weight: 100, pupilDiameter: 3.5 }]);
  assert.equal(legacy.records[0].metrics.avgPupilDiameter, 3.5);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('Exact Pupil samples, quality filtering, report/AOI statistics, video time, units and legacy compatibility passed.');
