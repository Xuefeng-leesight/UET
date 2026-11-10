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
const source = process.argv[2];
const [header, data] = fs.readFileSync(source, 'utf8').trim().split('\n').map(parser.parseCsvLineFast);
for (const pointSource of ['recommended', 'raw', 'smooth']) {
  const state = parser.makeCsvPointParserState(header, { pointSource, isGlassesMode: true });
  const point = parser.parseCsvPartsToHeatmapPoint(data, state);
  assert.equal(point.x, .25);
  assert.equal(point.y, .25);
  assert.equal(point.pupilDiameter, undefined);
}
const handlers = {};
const exportDir = path.join(path.dirname(source), 'export');
fs.mkdirSync(exportDir);
load('electron/domains/recording/recordExportHandlers.ts', {
  electron: { ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, dialog: { showOpenDialog: async () => ({ filePaths: [exportDir] }) } },
  'node:fs': fs, 'node:readline': readline, 'node:path': path, './recordPointsModel': parser,
  '../../../shared/domain/eyeExportData': load('shared/domain/eyeExportData.ts', { './gazeSmoothing': load('shared/domain/gazeSmoothing.ts') }),
  './recordAoiExport': { AOI_EXPORT_KEYS: new Set(['aoi_id', 'aoi_name', 'aoi_hit', 'aoi_enter_time_ms', 'aoi_exit_time_ms', 'aoi_dwell_time_ms', 'aoi_fixation_count']), createRecordAoiExportDeriver: async (_path, context) => { assert.equal(context?.projectDir, undefined, 'This legacy fixture has no AOI context; full AOI IPC is covered separately.'); return undefined; } },
  '../../../shared/constants/eyeExportColumns': load('shared/constants/eyeExportColumns.ts'),
}).registerRecordExportHandlers({ trimFixedDecimal: (value, digits) => Number(value.toFixed(digits)).toString() });
const columns = ['recom_gaze_x', 'recom_gaze_point_x', 'recom_gaze_point_z', 'recom_smooth_point_x',
  'left_pupil_diameter', 'left_pupil_diameter_mm', 'left_openness', 'gyro_timestamp'];
const result = await handlers['export-records-csv']({}, { records: [{ name: 'native_export', csvPath: source }], columns });
assert.equal(result.ok, true, result.message);
const rows = fs.readFileSync(path.join(exportDir, 'native_export.csv'), 'utf8').trim().split('\n').map(parser.parseCsvLineFast);
assert.deepEqual(Array.from(rows[1].slice(0, 3), Number), [.25, 125, 500]);
assert.deepEqual(Array.from(rows[1].slice(3)), ['', '', '', '', '']);
assert.equal(data[header.indexOf('left_pupil_diameter')], '40', 'An archived pixel-like value without usable normalized units remains in the source, not the standard normalized diameter column.');
console.log('Native 3D/2D export, missing measurements and standard normalized/mm separation verified.');
