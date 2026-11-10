import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

function load(file, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name) => { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; } });
  return exports;
}
const visibility = load('src/features/mapping/mappingVisibility.ts');
const { DEFAULT_MAPPING_CONFIDENCE_THRESHOLD, isMappingPointVisible, mappingVisibilityMessage } = visibility;
const page = fs.readFileSync('src/features/mapping/MappingPage.tsx', 'utf8');
const ast = ts.createSourceFile('MappingPage.tsx', page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map();
let statusSpan;
let selectionLifecycle;
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    const value = node.initializer;
    if (ts.isArrowFunction(value)) functions.set(node.name.text, value.getText(ast));
    else if (ts.isCallExpression(value) && /^React\.use(Callback|Memo)$/.test(value.expression.getText(ast))) {
      functions.set(node.name.text, value.arguments[0].getText(ast));
    }
  }
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'span'
      && node.getText(ast).includes('mappingVisibilityMessage')) statusSpan = node.getText(ast);
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'React.useEffect'
      && node.arguments[0]?.getText(ast).includes('recordSelectionRequestRef.current += 1')) {
    selectionLifecycle = node.arguments[0].getText(ast);
    assert.equal(node.arguments[1]?.getText(ast), '[projectDir]');
  }
  ts.forEachChild(node, visit);
}
visit(ast);
function action(name, globals) {
  assert.ok(functions.has(name), name);
  return vm.runInNewContext(ts.transpileModule(`(() => { const action = ${functions.get(name)}; return action; })();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, globals);
}
const tr = (zh) => zh;
const json = (value) => JSON.parse(JSON.stringify(value));
const points = [0.1908, 0.52, 0.7311].map((confidence, index) => ({
  x: 100 + index, y: 200, confidence, timestampMs: index * 1000, durationMs: 100, sourceId: index,
}));
assert.equal(DEFAULT_MAPPING_CONFIDENCE_THRESHOLD, 0);
assert.match(page, /useState\(DEFAULT_MAPPING_CONFIDENCE_THRESHOLD\)/);
assert.equal(points.filter((p) => isMappingPointVisible(p, DEFAULT_MAPPING_CONFIDENCE_THRESHOLD)).length, 3);
assert.equal(points.filter((p) => isMappingPointVisible(p, 80)).length, 0);
assert.equal(isMappingPointVisible({ confidence: 0.8 }, 80), true);
for (const p of [{ confidence: 1, deleted: true }, { confidence: NaN }, { confidence: -1 }, { confidence: 1.1 }]) {
  assert.equal(isMappingPointVisible(p, 0), false);
}
for (const isEn of [false, true]) {
  const source = ts.transpileModule(`const node = (${statusSpan}); node;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  const html = renderToStaticMarkup(vm.runInNewContext(source, {
    React, result: { gazeData: points }, confidenceThreshold: 80, isEn, tr, mappingVisibilityMessage,
  }));
  assert.match(html, /0\/3/);
  assert.ok(html.includes(isEn ? 'All points are hidden' : '全部映射点已被隐藏'));
}

// IPC list responses deliberately omit gazeData. Read the complete saved record
// before both history selection and image export.
const summary = { outputPath: '/project/analysis/gaze-mapping/mapping_test.json', result: {
  recordId: 'pupil', recordName: 'Pupil test', imagePath: '/reference.png', imageUrl: '/reference.png',
  videoPath: '/record.mp4', videoUrl: '/record.mp4', video: { name: 'record.mp4', width: 1280, height: 720, fps: 30 },
  resolution: { width: 1280, height: 720 }, summary: { mappedPoints: 3, inputPoints: 3, mappingRate: 1 }, gazeData: [],
} };
const complete = { ...summary, result: { ...summary.result, gazeData: points } };
const loads = [];
let loadResponse = { ok: true, record: complete };
const data = load('src/features/mapping/mappingRecordData.ts', {
  '@/infrastructure/electron/ipcClient': { ipcClient: { async loadGazeMappingRecord(payload) { loads.push(payload); return loadResponse; } } },
});
assert.equal((await data.loadCompleteMappingRecord('/project', summary)).result.gazeData.length, 3);
assert.deepEqual(json(loads[0]), { projectDir: '/project', outputPath: summary.outputPath });
loadResponse = { ok: false, message: 'missing file' };
await assert.rejects(data.loadCompleteMappingRecord('/project', summary), /missing file/);
loadResponse = { ok: true, record: complete };
const state = {};
const globals = {
  projectDir: '/project', records: [{ id: 'pupil' }], recordSelectionRequestRef: { current: 0 },
  tr, translateBackendMessage: (value, fallback) => value || fallback,
  loadCompleteMappingRecord: data.loadCompleteMappingRecord,
  handleRecordChange: async () => {}, getDisplayRecordName: (record) => record.name,
  gazeWindowRequestKeyRef: { current: '' }, gazeWindowRangeRef: { current: null },
};
for (const name of ['Message', 'Result', 'OutputPath', 'ImageFile', 'SelectedPointId', 'IsManualCalibrating', 'ActiveViewTab',
  'SelectedRecordId', 'VideoFile', 'VideoSize', 'CurrentTimeMs', 'Duration', 'IsPlaying', 'GazeFile', 'GazePoints']) {
  globals[`set${name}`] = (value) => { state[name] = value; };
}
globals.setMappingRecords = (update) => { state.records = update([summary]); };
await action('loadMappingRecord', globals)(summary);
assert.equal(state.Result.gazeData.length, 3);
assert.equal(state.records[0].result.gazeData.length, 3);
assert.equal(state.ActiveViewTab, 'mapped');
// An orphaned historical mapping must not retain another record's video/CSV.
const orphaned = { ...complete, result: { ...complete.result, videoPath: undefined, videoUrl: undefined } };
Object.assign(state, { VideoFile: { path: '/previous.mp4' }, GazeFile: { path: '/previous.csv' }, GazePoints: points });
await action('loadMappingRecord', {
  ...globals, records: [], loadCompleteMappingRecord: async () => orphaned,
})(summary);
assert.equal(state.VideoFile, null);
assert.equal(state.GazeFile, null);
assert.equal(state.GazePoints.length, 0);
assert.equal(state.Result, orphaned.result);
// A slow history read must not override a later record selection.
let release;
const lateGlobals = { ...globals, recordSelectionRequestRef: { current: 0 }, loadCompleteMappingRecord: () => new Promise((resolve) => { release = resolve; }) };
const previousResult = state.Result;
const pending = action('loadMappingRecord', lateGlobals)(summary);
lateGlobals.recordSelectionRequestRef.current += 1;
release({ ...complete, result: { ...complete.result, recordName: 'late result' } });
await pending;
assert.equal(state.Result, previousResult);
// The production project-change/unmount effect invalidates pending history reads.
assert.ok(selectionLifecycle);
const selectionEffect = vm.runInNewContext(`(${selectionLifecycle})`, {
  recordSelectionRequestRef: lateGlobals.recordSelectionRequestRef,
});
const beforeMount = lateGlobals.recordSelectionRequestRef.current;
const cleanup = selectionEffect();
assert.equal(lateGlobals.recordSelectionRequestRef.current, beforeMount + 1);
const pendingOnUnmount = action('loadMappingRecord', lateGlobals)(summary);
cleanup();
release({ ...complete, result: { ...complete.result, recordName: 'old project result' } });
await pendingOnUnmount;
assert.equal(state.Result, previousResult);
let exportedPoints = null;
await action('downloadMappingRecord', {
  ...globals, exportingRecordPath: '', setExportingRecordPath() {}, confidenceThreshold: 0,
  lineWidth: 2.5, pointRadius: 10, trajectoryColor: '#ef4444', isMappingPointVisible,
  Image: class { async decode() {} }, document: { createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob: (cb) => cb({ arrayBuffer: async () => new ArrayBuffer(1) }) }) },
  drawMappedTrajectory: (_context, mapped) => { exportedPoints = mapped; },
  ipcClient: { exportImageFast: async () => ({ ok: true }) }, window: { alert() {} },
})(summary);
assert.equal(exportedPoints.length, 3, 'Export must load actual saved points, not the empty list summary');

// Production CSV -> full-page mapping request: native 3D millimeters never
// replace normalized fixation centers; timestamps/durations stay milliseconds.
const constants = load('shared/constants/recordPoints.ts');
const parser = load('electron/domains/recording/recordCsvParser.ts', { '../../../shared/constants/recordPoints': constants });
const rows = [
  { source_model: 'PupilCore', source_event_type: 'fixation', fixation_state: '4', fixation_count: '1', fixation_center_x: '0', fixation_center_y: '0', video_time_ms: '458.443', fixation_timestamp_ms: '458.443', fixation_duration_ms: '129.974', recom_raw_point_x: '-190', recom_raw_point_y: '450' },
  { source_model: 'PupilCore', source_event_type: 'fixation', fixation_state: '4', fixation_count: '2', fixation_center_x: '.4', fixation_center_y: '.8', video_time_ms: '1500', fixation_timestamp_ms: '1500', fixation_duration_ms: '120', recom_raw_point_x: '-100', recom_raw_point_y: '520' },
];
const headers = Object.keys(rows[0]);
const parserState = parser.makeCsvPointParserState(headers, { pointMode: 'fixation', isGlassesMode: true, frameWidth: 1280, frameHeight: 720 });
const fixationPoints = rows.map((row) => parser.parseCsvPartsToHeatmapPoint(headers.map((key) => row[key]), parserState));
const dedupeFixationEvents = action('dedupeFixationEvents', {});
const loadAll = action('loadAllGazePoints', {
  recordDataService: { async loadPoints(request) { assert.equal(request.pointMode, 'fixation'); return { ok: true, points: fixationPoints }; } },
  videoSize: { width: 1280, height: 720 }, MAX_MAPPING_GAZE_POINTS: 500000,
  dedupeFixationEvents, setMessage() {}, translateBackendMessage: globals.translateBackendMessage,
});
let mappingRequest;
await action('runMapping', {
  videoFile: { path: '/record.mp4' }, imageFile: { path: '/reference.png' }, gazeFile: { path: '/record.csv' },
  projectDir: '/project', tr, setMessage() {}, setIsMapping() {}, setResult() {}, setOutputPath() {},
  loadAllGazePoints: loadAll, selectedRecord: { id: 'pupil', deviceType: '眼镜式' }, MAPPING_KEYFRAME_INTERVAL_FRAMES: 15,
  getDisplayRecordName: () => 'Pupil test', translateBackendMessage: globals.translateBackendMessage,
  ipcClient: { runGazeMapping: async (payload) => { mappingRequest = payload; return { ok: false, message: 'stop after boundary verification' }; } },
})();
assert.deepEqual(json(mappingRequest.gazePoints.map(({ x, y, timestamp, durationMs }) => ({ x, y, timestamp, durationMs }))), [
  { x: 0, y: 0, timestamp: 458.443, durationMs: 129.974 }, { x: .4, y: .8, timestamp: 1500, durationMs: 120 },
]);

// Optional local artifact verification; experiment data remain unmodified and
// are never copied into the committed fixture set.
if (process.argv[2]) {
  const actual = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const visible = actual.gazeData.filter((p) => isMappingPointVisible(p, DEFAULT_MAPPING_CONFIDENCE_THRESHOLD));
  assert.equal(actual.summary.mappedPoints, 62);
  assert.equal(visible.length, 62);
  assert.equal(actual.gazeData.filter((p) => isMappingPointVisible(p, 80)).length, 0);
  assert.match(mappingVisibilityMessage(actual.gazeData, 80, false), /0\/62.*全部映射点已被隐藏/);
  console.log('Real Pupil mapping: 62/62 visible by default; explicit 80% hides all and explains why.');
}
console.log('Mapping display checks passed: confidence filtering, bilingual status, history hydration/export, late selection and Pupil 2D/time contracts.');
