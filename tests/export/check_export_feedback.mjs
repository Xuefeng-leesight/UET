import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText;
const json = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const calls = [];
const facialAnalysis = { samples: [], tracks: { emotion: { events: [{ label: 'happy,"quoted"', startMs: 1, apexMs: 2, endMs: 3, peak: .75 }] } } };
let results = {};
const ipcClient = {
  isAvailable: () => true,
  exportRecordsCsv: async (payload) => { calls.push(['csv', payload]); return results.csv; },
  exportVideoFast: async (payload) => { calls.push(['video', payload]); if (results.video instanceof Error) throw results.video; return results.video; },
  exportTextFast: async (payload) => { calls.push(['text', payload]); return results.text; },
  loadFacialAnalysis: async (payload) => { calls.push(['load', payload]); if (results.load instanceof Error) throw results.load; return results.load; },
};
const exports = {};
vm.runInNewContext(compile(fs.readFileSync('src/features/export/recordExportWorkflow.ts', 'utf8')), {
  exports, Error, require: (name) => { assert.equal(name, '@/infrastructure/electron/ipcClient'); return { ipcClient }; },
});
const { runEyeTrackingExport, runFacialExport, describeExportOutcome } = exports;
const reset = () => {
  calls.length = 0;
  results = { csv: { ok: true, exportDir: '/out', files: ['/out/a.csv', '/out/b.csv'] }, video: { ok: true, path: '/out/a.mp4' }, text: { ok: true, path: '/out/a.json' }, load: { ok: true, result: facialAnalysis } };
};
const csvPayload = { records: [{ id: 'a' }, { id: 'b' }], columns: ['record_name', 'video_time_ms'] };
reset();
let outcome = await runEyeTrackingExport(csvPayload);
assert.equal(outcome.exported, 2);
assert.equal(calls[0][1], csvPayload, 'The complete existing CSV payload reaches IPC unchanged.');
for (const isEn of [false, true]) assert.equal(describeExportOutcome(outcome, isEn).kind, 'success');
results.csv = { ok: true, exportDir: '/out', files: ['/out/a.csv'] };
outcome = await runEyeTrackingExport(csvPayload);
assert.equal(outcome.failed, 1);
assert.equal(describeExportOutcome(outcome, false).kind, 'partial', 'ok:true with omitted files is partial, not success.');
results.csv = { ok: false, message: '已取消导出' };
assert.equal(describeExportOutcome(await runEyeTrackingExport(csvPayload), true).kind, 'canceled');
results.csv = { ok: false, message: 'Disk is full' };
assert.equal(describeExportOutcome(await runEyeTrackingExport(csvPayload), true).kind, 'error');
results.csv = Promise.reject(new Error('CSV IPC rejected'));
assert.equal(describeExportOutcome(await runEyeTrackingExport(csvPayload), true).kind, 'error');

const faceRecord = { id: 'face-a', name: 'original-record-name', modalities: { 'facial-expression': { sourcePath: '/in/face.mp4' } } };
const faceArgs = { records: [faceRecord], artifacts: new Set(['video', 'analysis-json', 'emotion-events-csv']), projectDir: '/project', resolveName: () => 'Display name', isCurrent: () => true };
reset();
outcome = await runFacialExport(faceArgs);
assert.deepEqual(json(outcome), { total: 3, exported: 3, failed: 0, canceled: false });
assert.deepEqual(calls.map(([method]) => method), ['video', 'load', 'text', 'text']);
assert.deepEqual(json(calls[0][1]), { sourcePath: '/in/face.mp4', defaultName: 'Display name_facial.mp4', preserveAudio: true });
assert.deepEqual(json(calls[1][1]), { projectDir: '/project', recordId: 'original-record-name' });
assert.equal(calls[2][1].content, JSON.stringify(facialAnalysis, null, 2));
assert.equal(calls[3][1].content, '"Emotion","Start[ms]","Apex[ms]","End[ms]","Peak"\n"happy,""quoted""","1","2","3","0.75"');
reset();
results.video = { ok: false, reason: 'canceled', message: '已取消' };
outcome = await runFacialExport(faceArgs);
assert.equal(outcome.canceled, true);
assert.deepEqual(calls.map(([method]) => method), ['video'], 'Cancel stops subsequent save dialogs.');
reset();
results.text = { ok: false, reason: 'canceled' };
outcome = await runFacialExport(faceArgs);
assert.equal(outcome.exported, 1);
assert.equal(outcome.canceled, true);
assert.equal(calls.length, 3, 'Cancel after a saved video retains its count and stops CSV export.');
reset();
results.video = { ok: false, reason: 'write_failed', message: 'Disk is full' };
outcome = await runFacialExport(faceArgs);
assert.equal(outcome.exported, 2);
assert.equal(outcome.failed, 1);
assert.equal(describeExportOutcome(outcome, true).kind, 'partial');
reset();
results.load = { ok: false, result: null, message: 'Analysis missing' };
outcome = await runFacialExport(faceArgs);
assert.equal(outcome.failed, 2);
assert.equal(outcome.exported, 1);
for (const malformedAnalysis of [{ samples: [] }, { tracks: { emotion: { events: {} } } }]) {
  reset();
  results.load = { ok: true, result: malformedAnalysis };
  outcome = await runFacialExport({ ...faceArgs, artifacts: new Set(['analysis-json', 'emotion-events-csv']) });
  assert.equal(outcome.exported, 1, 'JSON already saved remains successful when CSV generation fails.');
  assert.equal(outcome.failed, 1, 'Only the remaining CSV is counted as failed.');
  assert.equal(outcome.total, outcome.exported + outcome.failed, 'No output may be counted twice after malformed analysis data.');
  assert.equal(describeExportOutcome(outcome, true).kind, 'partial');
}
reset();
results.video = new Error('Video IPC rejected');
results.load = new Error('Analysis IPC rejected');
outcome = await runFacialExport(faceArgs);
assert.equal(outcome.failed, 3);
assert.equal(describeExportOutcome(outcome, false).kind, 'error');
reset();
outcome = await runFacialExport({ ...faceArgs, records: [{ id: 'missing', modalities: {} }], artifacts: new Set(['video']) });
assert.equal(outcome.failed, 1, 'A requested missing artifact cannot be counted as success.');
reset();
const delayedVideo = deferred();
let current = true;
results.video = delayedVideo.promise;
const oldExport = runFacialExport({ ...faceArgs, isCurrent: () => current });
current = false;
delayedVideo.resolve({ ok: true, path: '/out/late.mp4' });
await oldExport;
assert.deepEqual(calls.map(([method]) => method), ['video'], 'A context change stops the rest of the old export sequence.');

// Execute the actual page handlers, including the production payload builder,
// rather than reproducing busy/late-result behavior in the test.
const source = fs.readFileSync('src/features/export/ExportPage.tsx', 'utf8');
const ast = ts.createSourceFile('ExportPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function initializer(name) {
  const found = [];
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found.push(node.initializer); ts.forEachChild(node, visit); }
  visit(ast);
  assert.equal(found.length, 1, `Expected one production ${name}`);
  return found[0];
}
const evaluate = (name, globals) => vm.runInNewContext(compile(`(${initializer(name).getText(ast)})`), { Error, ...globals });
const modalitySelects = [];
function findModalitySelect(node) {
  if (ts.isJsxOpeningElement(node) && node.tagName.getText(ast) === 'CustomSelect') modalitySelects.push(node);
  ts.forEachChild(node, findModalitySelect);
}
findModalitySelect(ast);
assert.equal(modalitySelects.length, 1);
const selectProperty = (name) => {
  const attribute = modalitySelects[0].attributes.properties.find((item) => ts.isJsxAttribute(item) && item.name.getText(ast) === name);
  assert.ok(attribute && ts.isJsxExpression(attribute.initializer), `Modality selector must bind ${name}`);
  return attribute.initializer.expression.getText(ast);
};
for (const exporting of [false, true]) {
  assert.equal(vm.runInNewContext(compile(`(${selectProperty('disabled')})`), { exporting }), exporting,
    'The production modality selector stays disabled while the export IPC is pending.');
}
const modalityChanges = [];
const exportBusyRef = { current: true };
const changeModality = vm.runInNewContext(compile(`(${selectProperty('onChange')})`), {
  exportBusyRef, setExportModality: (value) => modalityChanges.push(value),
});
changeModality({ target: { value: 'facial-expression' } });
assert.equal(modalityChanges.length, 0, 'A selection queued before rerender cannot bypass the synchronous export lock.');
exportBusyRef.current = false;
changeModality({ target: { value: 'facial-expression' } });
assert.deepEqual(modalityChanges, ['facial-expression']);
function contextEffect() {
  const found = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'React.useEffect'
      && node.arguments[1]?.getText(ast) === '[exportModality, projectDir]') found.push(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(found.length, 1, 'The page owns context invalidation in one effect.');
  return found[0];
}
function pageHarness(overrides = {}) {
  const notices = [], busy = [], previews = [];
  const scope = {
    isEn: true, ipcClient, exportModality: 'eye-tracking', projectDir: '/project',
    exportBusyRef: { current: false }, operationRef: { current: 0 }, previewOperationRef: { current: 0 },
    modalityRecords: [{ id: 'csv-a', name: 'A', csvPath: '/in/a.csv', subjectName: 'Subject', samplingRateHz: 120 }, { id: 'missing', name: 'Missing CSV' }],
    resolveRecordExportName: (record) => record.name, buildSubjectInfoForRecord: () => ({ age: '23' }), buildRecordMetadataValues: () => ({ record_name: 'A' }),
    availableColumns: ['a', 'b'], selectedColumns: new Set(['b']), columnHeaderMap: { b: 'B' }, columnSourceMap: { b: ['legacy_b'] }, columnJoinSourceMap: {},
    selectedFacialArtifacts: new Set(['video']), runEyeTrackingExport, runFacialExport, describeExportOutcome,
    setFeedback: (value) => notices.push(value), setExporting: (value) => busy.push(value),
    setPreviewRecord: (value) => previews.push(['record', value]), setPreviewData: (value) => previews.push(['data', value]),
    setPreviewLoading: (value) => previews.push(['loading', value]), setPreviewError: (value) => previews.push(['error', value]),
    ...overrides,
  };
  return { scope, notices, busy, previews, run: evaluate('exportRecords', scope), preview: evaluate('previewRecordData', scope), closePreview: evaluate('closePreview', scope) };
}
reset();
results.csv = { ok: true, exportDir: '/out', files: ['/out/a.csv'] };
let page = pageHarness();
await page.run(['csv-a', 'missing', 'another-modality']);
assert.equal(page.notices.at(-1).kind, 'partial', 'Selected records without CSV are reported as missing.');
assert.match(page.notices.at(-1).message, /1 file\(s\) saved, 1 item\(s\)/);
assert.deepEqual(json(calls[0][1].records.map((record) => record.id)), ['csv-a']);
assert.deepEqual(json(calls[0][1].columns), ['b']);
assert.deepEqual(json(calls[0][1].records[0].subjectInfo), { age: '23' });
assert.deepEqual(json(calls[0][1].headerMap), { b: 'B' });
results.csv = { ok: false, message: '已取消导出' };
page = pageHarness();
await page.run(['csv-a', 'missing']);
assert.equal(page.notices.at(-1).kind, 'canceled');
assert.match(page.notices.at(-1).message, /2 item\(s\) not exported/, 'Cancellation counts every selected record, including missing CSV.');

reset();
const pendingCsv = deferred();
results.csv = pendingCsv.promise;
page = pageHarness();
const first = page.run(['csv-a']);
await page.run(['csv-a']);
assert.equal(calls.length, 1, 'The synchronous busy guard prevents double export before React rerenders.');
pendingCsv.resolve({ ok: true, files: ['/out/a.csv'] });
await first;
assert.deepEqual(page.busy, [true, false]);
assert.equal(page.notices.at(-1).kind, 'success');

reset();
const staleCsv = deferred();
results.csv = staleCsv.promise;
page = pageHarness();
const stale = page.run(['csv-a']);
page.scope.operationRef.current += 1; // effect cleanup on unmount/project/modality change
const noticeCount = page.notices.length;
staleCsv.resolve({ ok: true, files: ['/out/a.csv'] });
await stale;
assert.equal(page.notices.length, noticeCount, 'Late export completion cannot replace the current context feedback.');
assert.deepEqual(page.busy, [true], 'Late finally cannot clear a newer operation busy state.');

for (const response of [{ ok: false }, new Error('Preview rejected')]) {
  page = pageHarness({ ipcClient: { ...ipcClient, previewRecordCsv: async () => { if (response instanceof Error) throw response; return response; } } });
  await page.preview(page.scope.modalityRecords[0]);
  assert.ok(page.previews.some(([kind, value]) => kind === 'error' && value), 'Preview failure is visible in the preview dialog.');
  assert.deepEqual(page.previews.at(-1), ['loading', false]);
}
const previewPending = deferred();
page = pageHarness({ ipcClient: { ...ipcClient, previewRecordCsv: () => previewPending.promise } });
const preview = page.preview(page.scope.modalityRecords[0]);
page.closePreview();
const previewCount = page.previews.length;
previewPending.resolve({ ok: true, headers: [], rows: [] });
await preview;
assert.equal(page.previews.length, previewCount, 'Closed previews ignore late data and loading updates.');
page = pageHarness({ setSelectedIds: () => {} });
page.scope.exportBusyRef.current = true;
const setup = vm.runInNewContext(compile(`(${contextEffect().getText(ast)})`), page.scope);
const cleanup = setup();
assert.equal(page.scope.exportBusyRef.current, false);
assert.equal(page.scope.operationRef.current, 1);
assert.equal(page.scope.previewOperationRef.current, 1);
cleanup();
assert.equal(page.scope.operationRef.current, 2, 'The real effect invalidates export on unmount or context change.');
assert.equal(page.scope.previewOperationRef.current, 2, 'The real effect also invalidates preview.');
assert.ok(!source.includes('window.alert'), 'Export and preview feedback remains inside the application.');
console.log('Export feedback checks passed: real CSV/facial contracts, partial/missing/canceled outcomes, payload/order, duplicate clicks, stale results and preview errors.');
