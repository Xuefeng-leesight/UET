// Exercise source pairing through CSV, index, IPC, compare and spatial analysis.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const modules = new Map();
const handlers = {};
function load(file) {
  file = path.resolve(file);
  if (modules.has(file)) return modules.get(file);
  const exports = {};
  modules.set(file, exports);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(js, { exports, process, console, Buffer, setTimeout, clearTimeout,
    require(name) {
      if (name === 'electron') return { ipcMain: { handle: (name, handler) => { handlers[name] = handler; } } };
      const target = name.startsWith('@/') ? path.resolve('src', name.slice(2))
        : name.startsWith('@shared/') ? path.resolve('shared', name.slice(8))
        : name.startsWith('.') ? path.resolve(path.dirname(file), name) : null;
      if (!target) return require(name);
      return load(['.ts', '.tsx'].map(ext => target + ext).find(candidate => fs.existsSync(candidate)));
    },
  }, { filename: file });
  return exports;
}
const { createRecordedBlinkCollector } = load('electron/domains/recording/recordBlinkIntervals.ts');
const { summarizeBlinkIntervals } = load('shared/domain/blinkIntervals.ts');
const { buildCompareResult, COMPARE_METRIC_DEFS, formatMetricValue } = load('src/features/analysis/reports/compareEngine.ts');
const { buildInsightReport } = load('src/features/analysis/reports/insightEngine.ts');
const { renderInsightReportHtml, buildCompareCsv } = load('src/features/analysis/reports/reportRenderer.ts');
const { computeAoiStatsRows } = load('shared/domain/aoi/aoiReport.ts');
const { aggregateAoiStatsRows } = load('src/features/analysis/aoi/aoiAnalysisModel.ts');
const index = load('electron/domains/recording/recordPointsIndex.ts');
load('electron/domains/recording/recordPointHandlers.ts').registerRecordPointHandlers();

const headers = ['source_model', 'source_event_type', 'video_time_ms', 'timestamp', 'blink_phase',
  'blink_pair_id', 'blink_pair_status', 'source_generation', 'blink_marker', 'stimulus'];
const parts = values => headers.map(header => String(values[header] ?? ''));
const phase = (blink_phase, video_time_ms, extra = {}) => ({ source_model: 'PupilCore', source_event_type: 'blink',
  blink_phase, video_time_ms, blink_pair_id: '1', blink_pair_status: 'paired', source_generation: 'g1',
  blink_marker: '1', stimulus: 'A', ...extra });
function collect(rows) {
  const collector = createRecordedBlinkCollector(headers);
  rows.forEach(row => collector.addRow(parts(row)));
  return collector.finish();
}
const data = collect([
  phase('offset', 300), phase('onset', 100), phase('onset', 100), // reordered and duplicate delivery
  phase('onset', 150, { blink_marker: '2' }), phase('offset', 350, { blink_marker: '2' }),
  phase('onset', 400, { blink_pair_id: '2', blink_marker: '' }),
  phase('offset', 500, { blink_pair_id: '2', blink_marker: '' }),
]);
assert.equal(data.intervals.length, 3);
assert.equal(data.unpairedPhaseCount, 0);
assert.deepEqual(Array.from(data.intervals, interval => interval.eye), ['left', 'right', 'unspecified']);
assert.ok(data.intervals.every(interval => !Object.hasOwn(interval, 'x') && !Object.hasOwn(interval, 'y')));
const original = JSON.stringify(data);
const full = summarizeBlinkIntervals(data.intervals);
assert.equal(full.onsetCount, 3, 'simultaneous left/right source pairs remain two per-eye events');
assert.equal(full.overlapDurationMs, 500, 'per-eye intervals sum; this is not binocular wall-clock duration');
assert.equal(full.averageFullDurationMs, 500 / 3);
assert.deepEqual({ ...full.countsByEye }, { left: 1, right: 1, unspecified: 1 });
const firstWindow = summarizeBlinkIntervals(data.intervals, [{ startTimeMs: 0, endTimeMs: 150 }]);
const secondWindow = summarizeBlinkIntervals(data.intervals, [{ startTimeMs: 150, endTimeMs: 200 }]);
assert.equal(firstWindow.onsetCount, 1);
assert.equal(secondWindow.onsetCount, 1, 'the onset exactly on an adjacent boundary counts only in the later window');
assert.equal(secondWindow.overlapDurationMs, 100, 'overlap includes an interval whose onset preceded the window');
assert.equal(secondWindow.averageFullDurationMs, 200, 'source duration is not shortened to the selected 50 ms window');
assert.equal(summarizeBlinkIntervals(data.intervals, [{ startTimeMs: 200, endTimeMs: 250 }]).averageFullDurationMs, null);
assert.equal(summarizeBlinkIntervals(data.intervals, [
  { startTimeMs: 100, endTimeMs: 200 }, { startTimeMs: 150, endTimeMs: 250 },
]).overlapDurationMs, 250, 'overlapping selected windows must not double-count overlap duration');
assert.equal(summarizeBlinkIntervals([...data.intervals, ...data.intervals]).onsetCount, 3);
assert.equal(summarizeBlinkIntervals(data.intervals, []).onsetCount, 0);
assert.equal(JSON.stringify(data), original, 'window calculation never rewrites original source intervals');

for (const rows of [
  [phase('onset', 100)],
  [phase('onset', 100), phase('offset', 300, { blink_marker: '2' })],
  [phase('onset', 100), phase('offset', 300, { source_generation: 'g2' })],
  [phase('onset', 100), phase('onset', 110), phase('offset', 300)],
  [phase('onset', 100), phase('offset', 100)],
  [phase('onset', 300), phase('offset', 100)],
  [phase('onset', 100, { blink_pair_status: 'unpaired_onset' }), phase('offset', 300)],
  [phase('onset', 100, { blink_marker: '3' }), phase('offset', 300, { blink_marker: '3' })],
  [phase('onset', 100, { source_generation: '' }), phase('offset', 300, { source_generation: '' })],
]) {
  const invalid = collect(rows);
  assert.equal(invalid.intervals.length, 0, 'incomplete/conflicting/mismatched source phases cannot create an interval');
  assert.ok(invalid.unpairedPhaseCount > 0);
}
for (const badTime of ['', NaN, Infinity, -1]) {
  const invalid = collect([phase('onset', badTime, { timestamp: 1790000000000 }), phase('offset', 300)]);
  assert.equal(invalid.intervals.length, 0, 'authoritative video time cannot fall back to source/epoch time');
}
assert.equal(collect([phase('onset', 0), phase('offset', 100)]).intervals[0].startTimeMs, 0);
const oldPupil = createRecordedBlinkCollector(['source_model', 'blink']);
oldPupil.addRow(['PupilCore', '1']);
assert.equal(oldPupil.finish().intervals.length, 0, 'historical Pupil without pair schema stays unavailable');
const otherDevice = createRecordedBlinkCollector(headers);
otherDevice.addRow(parts(phase('onset', 0, { source_model: '7invensun' })));
assert.equal(otherDevice.finish(), undefined, 'other devices retain their established input path');
const bounded = createRecordedBlinkCollector(headers);
assert.throws(() => {
  for (let i = 0; i <= 100_000; i += 1) bounded.addRow(parts(phase('onset', i, { blink_pair_id: String(i) })));
}, /10 万/, 'the bounded collector must fail clearly instead of returning partial statistics');

const records = [{ id: 'r', name: 'Pupil', durationSeconds: 1,
  timelineSegments: [{ name: 'window', startTime: .15, endTime: .2 }] }];
const compare = (blinkData, extra = {}) => buildCompareResult({
  config: { recordIds: ['r'], groupBy: 'subject', ...extra }, records, pointsByRecord: { r: [] },
  aoiRowsByRecord: {}, blinkDataByRecord: { r: blinkData },
});
assert.equal(compare(data).records[0].metrics.blinkCount, 3);
const scopedMetrics = compare(data, { segmentName: 'window' }).records[0].metrics;
assert.equal(scopedMetrics.blinkCount, 1);
assert.equal(scopedMetrics.totalBlinkDurationMs, 100);
assert.equal(scopedMetrics.avgBlinkDurationMs, 200);
assert.equal(compare(data, { stimulusName: 'A' }).records[0].metrics.blinkCount, 3);
assert.equal(compare(data, { stimulusName: 'A' }).records[0].metrics.totalBlinkDurationMs, null,
  'an onset stimulus label cannot establish the whole interval stimulus boundary');
assert.equal(compare(data, { stimulusName: 'B' }).records[0].metrics.blinkCount, 0);
assert.equal(compare({ ...data, intervals: data.intervals.map(interval => ({ ...interval, stimulusName: undefined })) },
  { stimulusName: 'A' }).records[0].metrics.blinkCount, null, 'unknown source labels cannot prove zero onsets for a selected stimulus');
assert.equal(compare(data, { segmentName: 'missing' }).records[0].metrics.blinkCount, null,
  'a missing window must not fabricate a known empty observation period');
for (const missing of [undefined, { intervals: [], unpairedPhaseCount: 0 }, { intervals: [], unpairedPhaseCount: 2 }]) {
  const metrics = compare(missing).records[0].metrics;
  assert.equal(metrics.blinkCount, null, 'no complete pairs is not evidence of zero real blinks');
  assert.equal(metrics.totalBlinkDurationMs, null);
  assert.equal(metrics.avgBlinkDurationMs, null);
}
const reportComparison = compare(data);
for (const outputLanguage of ['zh-CN', 'en-US']) {
  const report = buildInsightReport({ compareResult: reportComparison, tone: 'academic', outputLanguage });
  const html = renderInsightReportHtml(report, reportComparison);
  assert.ok(html.includes(outputLanguage === 'en-US' ? 'Complete Blink Onsets (per eye)' : '完整眨眼起始事件数（按眼）'));
  assert.ok(html.includes(outputLanguage === 'en-US' ? 'Blink Interval Overlap Duration (sum across eyes)' : '所选范围眨眼区间重叠时长（按眼相加）'));
  assert.ok(html.includes(reportComparison.notes.find(note => note.includes('左闭右开'))), 'saved reports retain the counting/window policy');
}
const exported = buildCompareCsv(compare({ intervals: [], unpairedPhaseCount: 0 })).trim().split('\n').map(line => line.split(','));
assert.ok(exported[0].includes('blinkCount'));
assert.equal(exported[1][exported[0].indexOf('blinkCount')], '', 'missing blink count exports blank, not zero');

const shape = { id: 'a', name: 'Target', type: 'rect', color: 'sky', visible: true, showStats: true,
  x: 0, y: 0, w: 1, h: 1 };
const positioned = [
  { x: .5, y: .5, timestamp: 100, timeBase: 'video_time_ms', blink: true, fixationState: 4, fixationDurationMs: 100 },
  { x: .5, y: .5, timestamp: 200, timeBase: 'video_time_ms', blink: false, fixationState: 4, fixationDurationMs: 100 },
];
const spatial = computeAoiStatsRows({ shapes: [shape], points: positioned, blinkData: data })[0];
assert.equal(spatial.blinkCount, null);
assert.equal(spatial.totalBlinkDurationMs, null, 'a nearby fixation cannot locate the entire blink interval');
assert.equal(spatial.avgBlinkDurationMs, null);
assert.equal(spatial.blinkDataStatus, 'unlocalized_intervals');
assert.equal(computeAoiStatsRows({ shapes: [shape], points: [], blinkData: { intervals: [], unpairedPhaseCount: 0 } })[0].blinkDataStatus, 'not_observed');
const legacy = computeAoiStatsRows({ shapes: [shape], points: positioned })[0];
assert.equal(legacy.blinkCount, 1, '7invensun point-based blink path remains unchanged');
assert.equal(legacy.totalBlinkDurationMs, 100);
assert.equal(aggregateAoiStatsRows([spatial, legacy], ['a'])[0].blinkCount, null,
  'an aggregate cannot conceal an unavailable source as zero');

// Render the existing JSX and the actual AOI sidebar, in both languages. This
// verifies content/absence states, not browser layout or hardware behavior.
function findNode(file, predicate) {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches = [];
  function visit(node) { if (predicate(node, ast)) matches.push(node); ts.forEachChild(node, visit); }
  visit(ast);
  assert.equal(matches.length, 1, `Expected a single production expression in ${file}`);
  return matches[0];
}
function evaluate(node, globals) {
  const source = ts.transpileModule(`(${node.getText()})`, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
  } }).outputText;
  return vm.runInNewContext(source, { React, ...globals });
}
const chartBlinkJsx = findNode('src/features/analysis/reports/ChartPage.tsx', node =>
  ts.isConditionalExpression(node) && node.condition.getText() === 'selectedBlinkData');
const aoiItems = findNode('src/features/analysis/aoi/AoiPage.tsx', node =>
  ts.isVariableDeclaration(node) && node.name.getText() === 'buildAoiStatsDisplayItems').initializer.arguments[0];
const { AoiStatisticsPanel } = load('src/features/analysis/aoi/AoiStatisticsPanel.tsx');
const compareTable = findNode('src/features/analysis/reports/CompareModePanel.tsx', node =>
  ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'table' && node.getText().includes('recordMetricDefs.map'));
const recordMetricDefs = evaluate(findNode('src/features/analysis/reports/CompareModePanel.tsx', node =>
  ts.isVariableDeclaration(node) && node.name.getText() === 'recordMetricDefs').initializer, { COMPARE_METRIC_DEFS });
const compareMarkup = renderToStaticMarkup(evaluate(compareTable, { compareResult: reportComparison, recordMetricDefs, formatMetricValue }));
assert.ok(compareMarkup.includes('完整眨眼起始事件数（按眼）'));
assert.ok(compareMarkup.includes('所选范围眨眼区间重叠时长（按眼相加）'));
assert.ok(compareMarkup.includes('起始眨眼事件平均完整时长'));
for (const isEn of [false, true]) {
  const renderChart = (selectedBlinkData, selectedBlinkSummary) => renderToStaticMarkup(evaluate(chartBlinkJsx,
    { isEn, selectedBlinkData, selectedBlinkSummary }));
  const available = renderChart({ ...data, unpairedPhaseCount: 2 }, full);
  assert.ok(available.includes(isEn ? 'Complete blink intervals (per eye)' : '完整眨眼区间（按眼计）'));
  assert.ok(available.includes('500.0 ms'));
  assert.ok(available.includes(isEn ? 'unpaired phases' : '未配对阶段'));
  const missing = renderChart({ intervals: [], unpairedPhaseCount: 0 }, null);
  assert.ok(missing.includes(isEn ? 'count unavailable' : '次数缺失'));
  assert.ok(!missing.includes('0.0 ms'));
  assert.equal(renderChart(undefined, null), '', 'legacy device UI does not gain a false Pupil status');
  const buildItems = evaluate(aoiItems, { isEn, gridEnabled: false, selectedAoiMetricIds: ['fixationCount'],
    gridMetricOptions: [{ id: 'fixationCount', label: 'Count' }],
    getAoiMetricValue: (_id, row) => row.fixationCount, formatAoiMetricValue: (_id, value) => String(value) });
  const markup = renderToStaticMarkup(React.createElement(AoiStatisticsPanel, { isEnglish: isEn,
    cards: [{ cardId: 'a', title: 'Target', items: buildItems(spatial) }], onOpenMetricPicker() {} }));
  assert.ok(markup.includes(isEn ? 'Unassigned (source intervals have no position)' : '未分配（源区间无位置）'));
  assert.equal(buildItems(legacy).length, 1, 'legacy AOI values retain the existing display');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mrt-blink-intervals-'));
try {
  // Generate the CSV with the actual recorder producer, with no gaze rows at all.
  const producer = spawnSync(process.env.PYTHON || 'python3', ['-c', `
import csv, io, json, sys
from services.eye_tracking.infrastructure.pupil_events import event_rows
from services.eye_tracking.infrastructure.pupil_csv import CSV_FIELDS
events = []
for eye, start, end in [('left', 100.125, 100.375), ('right', 100.25, 100.5), (None, 100.625, 100.75)]:
    for phase, timestamp in [('onset', start), ('offset', end)]:
        events.append(dict(kind='blink', valid=True, eye=eye, event_id=1, phase=phase, confidence=.9,
            native=eye is not None, identity=dict(source_time_s=timestamp, generation='producer-session',
                received_sequence=len(events), topic='blinks')))
rows, metadata = event_rows(io.StringIO(''.join(json.dumps(e)+'\\n' for e in events)), 100, 1)
writer = csv.DictWriter(sys.stdout, fieldnames=CSV_FIELDS)
writer.writeheader()
writer.writerows(rows)
`], { encoding: 'utf8' });
  assert.equal(producer.status, 0, producer.stderr);
  const csvPath = path.join(tmp, 'source.csv');
  fs.writeFileSync(csvPath, producer.stdout);
  const loaded = await handlers['load-record-points']({}, { csvPath, pointMode: 'fixation', includePupilSamples: true });
  assert.equal(loaded.ok, true, loaded.message);
  assert.equal(loaded.points.length, 0, 'blink phases cannot fabricate fixation/gaze points');
  assert.equal(loaded.pupilSamples.length, 0, 'blink phases cannot fabricate pupil samples');
  assert.equal(loaded.blinkData.intervals.length, 3, 'actual producer paired intervals reach the renderer DTO');
  assert.equal(summarizeBlinkIntervals(loaded.blinkData.intervals).overlapDurationMs, 625);
  assert.equal(fs.readFileSync(csvPath, 'utf8'), producer.stdout, 'analysis leaves original CSV unchanged');
  const meta = await index.buildRecordPointsIndex(csvPath, fs.statSync(csvPath), index.getRecordPointsIndexOptions({}));
  const windowLoad = await index.loadRecordPointsFromIndex(meta, 'gaze', {
    maxPoints: 10, includeMarkerOnlyRows: false, exact: true, pupilSamplesOnly: true, startTimeMs: 300, endTimeMs: 325,
  });
  assert.equal(windowLoad.blinkData.intervals.length, 3, 'a sample window must not lose phases outside it');
  assert.equal(summarizeBlinkIntervals(windowLoad.blinkData.intervals, [{ startTimeMs: 300, endTimeMs: 325 }]).overlapDurationMs, 50);
  const aoiResult = await handlers['compute-aoi-stats']({}, { jobs: [{ recordId: 'r', shapes: [shape],
    points: positioned, blinkData: loaded.blinkData }] });
  assert.equal(aoiResult.ok, true, aoiResult.message);
  assert.equal(aoiResult.rowsByRecordId.r[0].blinkCount, null, 'main-process AOI shares the same unavailable spatial semantics');
  assert.equal(aoiResult.rowsByRecordId.r[0].blinkDataStatus, 'unlocalized_intervals');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('Production blink CSV → index/IPC → report/AOI: pairing, eye policy, windows, missing data and legacy compatibility passed.');
