import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import vm from 'node:vm';
import ts from 'typescript';
function load(file, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { exports, console, require: name => { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; } });
  return exports;
}
const parser = load('electron/domains/recording/recordCsvParser.ts', {
  '../../../shared/constants/recordPoints': load('shared/constants/recordPoints.ts'),
});
const csvPath = process.argv[2];
const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
const header = parser.parseCsvLineFast(lines.shift());
const parse = mode => {
  const state = parser.makeCsvPointParserState(header, { pointMode: mode, isGlassesMode: true });
  return lines.map(line => parser.parseCsvPartsToHeatmapPoint(parser.parseCsvLineFast(line), state)).filter(Boolean);
};
const gazes = parse('gaze');
assert.equal(gazes.length, 3, 'Events must not become duplicate gaze');
assert.equal(gazes[1].blink, true);
assert.equal(gazes[1].leftBlink, undefined);
const fixations = parse('fixation');
assert.equal(fixations.length, 1);
assert.equal(fixations[0].id, 1);
assert.equal(fixations[0].x, 0);
assert.equal(fixations[0].y, 0);
assert.ok(Math.abs(fixations[0].fixationDurationMs - 400) < 1e-6);
const handlers = {};
const exportDir = path.join(path.dirname(csvPath), 'export');
fs.mkdirSync(exportDir);
load('electron/domains/recording/recordExportHandlers.ts', {
  electron: { ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, dialog: { showOpenDialog: async () => ({ filePaths: [exportDir] }) } },
  'node:fs': fs, 'node:readline': readline, 'node:path': path, './recordPointsModel': parser,
  '../../../shared/domain/eyeExportData': load('shared/domain/eyeExportData.ts', { './gazeSmoothing': load('shared/domain/gazeSmoothing.ts') }),
  './recordAoiExport': { AOI_EXPORT_KEYS: new Set(['aoi_id', 'aoi_name', 'aoi_hit', 'aoi_enter_time_ms', 'aoi_exit_time_ms', 'aoi_dwell_time_ms', 'aoi_fixation_count']), createRecordAoiExportDeriver: async (_path, context) => { assert.equal(context?.projectDir, undefined, 'This legacy fixture has no AOI context; full AOI IPC is covered separately.'); return undefined; } },
  '../../../shared/constants/eyeExportColumns': load('shared/constants/eyeExportColumns.ts'),
}).registerRecordExportHandlers({ trimFixedDecimal: (value, digits) => Number(value.toFixed(digits)).toString() });
const result = await handlers['export-records-csv']({}, { records: [{ name: 'actual_export', csvPath }],
  columns: ['video_time_ms', 'fixation_state', 'fixation_count', 'fixation_duration', 'blink_index', 'blink_duration_ms', 'blink_marker', 'left_blink', 'right_blink'],
  columnSourceMap: { fixation_count: ['fixation_index', 'fixation_count'], fixation_duration: ['fixation_duration_ms', 'fixation_duration'] } });
assert.equal(result.ok, true, result.message);
const exported = fs.readFileSync(path.join(exportDir, 'actual_export.csv'), 'utf8').trim().split('\n').slice(1).map(parser.parseCsvLineFast);
const sourceFixation = lines.map(parser.parseCsvLineFast).find(row => row[header.indexOf('source_event_type')] === 'fixation');
assert.ok(sourceFixation);
assert.ok(exported.some(r => r[1] === sourceFixation[header.indexOf('fixation_state')] && r[2] === '1' && Math.abs(Number(r[3]) - 400) < 1e-6));
const sourceBlink = lines.map(parser.parseCsvLineFast).find(row => row[header.indexOf('source_event_type')] === 'blink' && row[header.indexOf('blink_phase')] === 'onset');
assert.ok(sourceBlink);
const sourceBlinkDuration = sourceBlink[header.indexOf('blink_duration_ms')];
assert.ok(Math.abs(Number(sourceBlinkDuration) - 100) < 1e-6, 'The 10.15s–10.25s source blink is 100ms within floating-point precision.');
assert.ok(exported.some(r => r[4] === '1' && r[5] === sourceBlinkDuration && r[6] === ''), 'Export retains the complete global blink duration exactly without inventing an eye marker.');
assert.ok(exported.every(r => r[7] === '' && r[8] === ''), 'A global Capture blink must not fabricate either standard per-eye blink state.');
console.log('Actual fixation/gaze parsing and user CSV export verified.');
