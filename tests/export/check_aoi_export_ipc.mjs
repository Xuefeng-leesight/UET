import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url), modules = new Map(), handlers = {};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrt-aoi-export-'));
const outputDir = path.join(root, 'out');
fs.mkdirSync(outputDir);
let dialogCalls = 0;
function load(file) {
  file = path.resolve(file);
  if (modules.has(file)) return modules.get(file);
  const exports = {};
  modules.set(file, exports);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(js, { exports, process, console, Buffer, Error, setTimeout, clearTimeout, require(name) {
    if (name === 'electron') return { ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
      dialog: { showOpenDialog: async () => { dialogCalls++; return { canceled: false, filePaths: [outputDir] }; } } };
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name) + '.ts');
    return require(name);
  } }, { filename: file });
  return exports;
}
load('electron/domains/recording/recordPointHandlers.ts').registerRecordPointHandlers();
load('electron/domains/recording/recordExportHandlers.ts').registerRecordExportHandlers({ trimFixedDecimal: value => String(value) });
const { parseCsvLineFast } = load('electron/domains/recording/recordCsvParser.ts');
const { createRecordAoiExportDeriver } = load('electron/domains/recording/recordAoiExport.ts');
const exportData = load('shared/domain/eyeExportData.ts');
const pageSource = fs.readFileSync('src/features/export/ExportPage.tsx', 'utf8');
const pageAst = ts.createSourceFile('ExportPage.tsx', pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let previewFunction;
function findPreview(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(pageAst) === 'previewRecordData') previewFunction = node.initializer;
  ts.forEachChild(node, findPreview);
}
findPreview(pageAst);
assert.ok(previewFunction);
const keys = ['aoi_id', 'aoi_name', 'aoi_hit', 'aoi_enter_time_ms', 'aoi_exit_time_ms', 'aoi_dwell_time_ms', 'aoi_fixation_count'];
const headers = ['video_time_ms', 'source_model', 'source_backend', 'source_generation', 'source_topic', 'source_event_type',
  'gaze_valid', 'pupil_valid', 'recom_gaze_bit_mask', 'recom_gaze_x', 'recom_gaze_y', 'gaze_source_order', 'gaze_velocity_px_ms',
  'fixation_state', 'fixation_index', 'fixation_timestamp_ms', 'fixation_duration_ms', 'fixation_center_x', 'fixation_center_y',
  'customMarker', 'triggerMark', ...keys];
const row = value => headers.map(key => String(value[key] ?? ''));
const sample = (time, x = .25, extra = {}) => row({ video_time_ms: time, source_model: 'PupilCore', source_backend: 'native',
  source_generation: 1, source_topic: 'gaze.3d.01.', gaze_valid: 1, pupil_valid: 1, recom_gaze_bit_mask: 1,
  recom_gaze_x: x, recom_gaze_y: .5, gaze_source_order: 'in_order', gaze_velocity_px_ms: 1, aoi_id: 'stale', aoi_hit: 9, ...extra });
const event = (extra = {}) => row({ video_time_ms: 0, source_model: 'PupilCore', source_backend: 'native',
  source_event_type: 'fixation', source_generation: 1, fixation_state: 4, fixation_index: 1,
  fixation_timestamp_ms: 0, fixation_duration_ms: 10, fixation_center_x: .25, fixation_center_y: .5, ...extra });
const shapes = [
  { id: 'a', name: 'same', type: 'rect', visible: true, showStats: true, color: 'sky', x: 0, y: 0, w: .6, h: 1 },
  { id: 'b', name: 'same', type: 'rect', visible: true, showStats: true, color: 'rose', x: .4, y: 0, w: .6, h: 1,
    keyframes: [{ timeMs: 200, metric: 0, x: 0, y: 0, w: .2, h: 1 }],
    analysisTimeRanges: [{ startTimeMs: 0, endTimeMs: 60 }, { startTimeMs: 200, endTimeMs: 220 }] },
];
const csvPath = path.join(root, 'original.csv');
const rows = [sample(0), event(), event(), row({ video_time_ms: 5, source_model: 'PupilCore', customMarker: 'cue' }), sample(10, .5),
  sample(20, .8), sample(30, .5, { gaze_valid: 0 }), event({ video_time_ms: 30, fixation_state: 3, fixation_index: 2, fixation_timestamp_ms: 30 }),
  sample(40, .5), sample(60, .8), sample(200, .1), sample(210, .1)];
const original = [headers, ...rows].map(values => values.map(value => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value).join(',')).join('\n') + '\n';
fs.writeFileSync(csvPath, original);
const aoiPath = path.join(root, 'visualization', 'aoi.json');
fs.mkdirSync(path.dirname(aoiPath));
const save = scopes => fs.writeFileSync(aoiPath, JSON.stringify({ version: 3, byRecordId: scopes }));
save({ 'record:r': shapes });
const context = { projectDir: root, recordId: 'r', deviceType: '眼镜式', videoWidth: 1280, videoHeight: 720, coordinateSpace: 'original-video' };
const preview = extra => handlers['preview-record-csv']({}, { csvPath, maxRows: 100, aoiContext: context, ...extra });
const exportCsv = extra => handlers['export-records-csv']({}, { records: [{ id: 'r', name: 'actual', csvPath,
  projectDir: root, deviceType: '眼镜式', videoWidth: 1280, videoHeight: 720 }], columns: keys, ...extra });
async function pagePreview() {
  let rows, error, request;
  const compiled = ts.transpileModule(`(${previewFunction.getText(pageAst)})`, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const callback = vm.runInNewContext(compiled, { ...exportData, projectDir: root, isEn: true,
    exportModality: 'eye-tracking', previewOperationRef: { current: 0 },
    ipcClient: { isAvailable: () => true, previewRecordCsv: async payload => {
      request = payload;
      return handlers['preview-record-csv']({}, payload);
    } },
    setFeedback: () => {}, setPreviewRecord: () => {}, setPreviewLoading: () => {},
    setPreviewData: value => { rows = value; }, setPreviewError: value => { error = value; },
    availableColumns: keys, selectedColumns: new Set(keys), columnSourceMap: {}, columnJoinSourceMap: {},
    buildSubjectInfoForRecord: () => ({}), buildRecordMetadataValues: () => ({}), getColumnHeader: key => key,
  });
  await callback({ id: 'r', name: 'actual', csvPath, deviceType: '眼镜式', videoWidth: 1280, videoHeight: 720 });
  return { rows, error, request };
}
try {
  const full = await preview();
  assert.equal(full.ok, true, full.message);
  assert.deepEqual(Array.from(full.headers), headers, 'preview raw headers stay unchanged');
  assert.deepEqual(JSON.parse(JSON.stringify(full.rows)), rows, 'preview raw values stay unchanged');
  const actual = await exportCsv();
  assert.equal(actual.ok, true, actual.message);
  const exported = fs.readFileSync(actual.files[0], 'utf8').trim().split('\n').slice(1).map(parseCsvLineFast);
  assert.equal(exported.length, rows.length, 'overlap and event processing cannot duplicate or delete source rows');
  assert.deepEqual(JSON.parse(JSON.stringify(exported)), JSON.parse(JSON.stringify(full.derivedAoiRows.map(value => keys.map(key => value[key])))));
  const rendered = await pagePreview();
  assert.ok(!rendered.error, rendered.error);
  assert.deepEqual(JSON.parse(JSON.stringify(rendered.request.aoiContext)), context, 'the production page sends the original record scope and real dimensions');
  assert.deepEqual(JSON.parse(JSON.stringify(rendered.rows.slice(1))), JSON.parse(JSON.stringify(exported)), 'the production preview callback renders derived AOI values, overriding stale raw columns');
  assert.equal(exported[0][0], '["a","b"]', 'current definitions replace obsolete raw AOI IDs');
  assert.equal(exported[0][2], '[1,0]');
  assert.equal(exported[4][6], '[1,0]', 'the duplicated complete source event counts once at its end, even beyond a short preview');
  assert.equal(exported[3][2], '[null,null]', 'pure annotation does not claim a sample or outside state');
  assert.equal(exported[4][5], '[10,0]', 'event and marker insertion does not interrupt sample continuity');
  assert.equal(exported[5][4], '[20,null]');
  assert.equal(exported[6][2], '[null,null]');
  assert.equal(exported[8][3], '[40,40]', 'invalid gaze breaks both visits without fabricated exits');
  assert.equal(exported[10][3], '[200,200]', 'gap and inactive AOI time range cannot bridge visits');
  assert.equal(exported.at(-1)[4], '[null,null]', 'a trailing visit never gets a made-up exit');
  const short = await preview({ maxRows: 5 });
  assert.equal(short.truncated, true);
  assert.deepEqual(JSON.parse(JSON.stringify(short.derivedAoiRows)), JSON.parse(JSON.stringify(full.derivedAoiRows.slice(0, 5))));
  assert.equal(fs.readFileSync(csvPath, 'utf8'), original);

  // Context is explicit. Mapping coordinates and missing context cannot acquire original-video AOIs.
  const rawPreview = await preview({ aoiContext: undefined });
  assert.equal(rawPreview.derivedAoiRows, undefined);
  const mapped = await preview({ aoiContext: { ...context, coordinateSpace: 'mapping' } });
  assert.ok(mapped.derivedAoiRows.every(row => keys.every(key => row[key] === '')));
  const noDimensions = await preview({ aoiContext: { ...context, videoWidth: undefined, videoHeight: undefined } });
  assert.equal(noDimensions.derivedAoiRows[0].aoi_hit, '[1,0]', 'normalized Pupil gaze does not need guessed image dimensions');
  assert.equal(noDimensions.derivedAoiRows[4].aoi_fixation_count, '[null,null]', 'no dimensions means no guessed pixel-based fallback events');

  save({ r: shapes });
  assert.equal((await preview()).derivedAoiRows[0].aoi_id, '["a","b"]', 'old glasses scope is supported');
  save({ r: shapes, 'record:r': [] });
  assert.equal((await preview()).derivedAoiRows[0].aoi_id, '', 'an explicitly empty current scope must not resurrect legacy definitions');
  fs.unlinkSync(aoiPath);
  assert.equal((await preview()).derivedAoiRows[0].aoi_hit, '', 'missing file is a legitimate unconfigured AOI state');
  const oldPath = path.join(root, 'legacy.csv');
  fs.writeFileSync(oldPath, 'video_time_ms,recom_gaze_x,recom_gaze_y,aoi_id,aoi_hit\n0,.2,.5,existing,1\n');
  assert.equal(await createRecordAoiExportDeriver(oldPath, context), undefined, 'unconfigured old-device AOI columns retain their original values');
  save({ 'stimulus-name': shapes, r: shapes });
  assert.equal(await createRecordAoiExportDeriver(oldPath, { ...context, deviceType: '桌面式' }), undefined, 'desktop stimulus identity is never guessed from a record ID or label');

  // Known malformed definitions must fail before any output/save dialog, never silently clear cells.
  fs.writeFileSync(aoiPath, '{broken json');
  const brokenPreview = await preview();
  assert.equal(brokenPreview.ok, false);
  assert.match(brokenPreview.message, /AOI/);
  assert.match((await pagePreview()).error, /AOI/, 'the actual page preserves the actionable AOI error from main');
  const before = dialogCalls;
  const brokenExport = await exportCsv();
  assert.equal(brokenExport.ok, false);
  assert.match(brokenExport.message, /AOI/);
  assert.equal(dialogCalls, before);
  save({ 'record:r': 'not an array' });
  assert.equal((await preview()).ok, false);

  // Existing fallback detector completes legacy data from full samples, never a new export-only algorithm.
  save({ 'record:r': [shapes[0]] });
  const fallbackPath = path.join(root, 'fallback.csv');
  fs.writeFileSync(fallbackPath, 'video_time_ms,recom_gaze_x,recom_gaze_y,recom_gaze_bit_mask\n' +
    [0, 20, 40, 60, 80, 100].map(time => `${time},.25,.5,1`).join('\n') + '\n120,.9,.5,1\n');
  const fallback = await handlers['preview-record-csv']({}, { csvPath: fallbackPath, aoiContext: { ...context, deviceType: '桌面式' }, maxRows: 100 });
  assert.equal(fallback.ok, true, fallback.message);
  assert.equal(fallback.derivedAoiRows[5].aoi_fixation_count, '1');
  assert.equal(fallback.derivedAoiRows[6].aoi_exit_time_ms, '120');
  assert.equal(fallback.derivedAoiRows[6].aoi_dwell_time_ms, '100');
  console.log('AOI actual IPC: preview/export parity, complete source/fallback events, dynamic overlap, scope, raw compatibility, and explicit errors passed.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
