import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { exports, process, Buffer, console, require(spec) {
    if (spec.startsWith('node:')) return require(spec);
    if (spec === 'electron') return { ipcMain: { handle: (name, fn) => { handlers[name] = fn; } } };
    const base = spec.startsWith('@shared/') ? path.resolve('shared', spec.slice(8))
      : path.resolve(path.dirname(file), spec);
    return load(`${base}.ts`);
  } }, { filename: file });
  return exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const { createFallbackFixationDetector } = load('shared/domain/fixationDetection.ts');
const sample = (timestamp, x = .2, patch = {}) => ({ timestamp, timeBase: 'video_time_ms', x, y: .3, ...patch });
const stable = (start = 0, x = .2) => Array.from({ length: 6 }, (_, i) => sample(start + i * 20, x));
function detect(points, frameWidth = 1920) {
  const events = [];
  const detector = createFallbackFixationDetector({ frameWidth, frameHeight: 1080, onFixation: p => events.push(p) });
  for (const p of points) detector.add(p);
  detector.finish();
  detector.finish();
  return events;
}
assert.equal(detect(stable()).length, 1, 'Last mature event is emitted once at EOF');
assert.equal(detect(stable())[0].weight, 100);
assert.equal(detect(stable())[0].timestamp, 100);
assert.equal(detect(stable())[0].fixationTimestampMs, 0);
assert.equal(detect(stable().slice(0, 5)).length, 0);
assert.equal(detect(stable().map(p => ({ ...p, timestamp: p.timestamp / 2 }))).length, 0);
assert.equal(detect(Array.from({ length: 8 }, () => sample(20))).length, 0, 'Repeated times cannot create a fixation');
assert.equal(detect(stable().map(p => ({ ...p, timeBase: undefined }))).length, 0, 'Do not guess legacy clock units');
assert.equal(detect([...stable(), ...stable(500)]).length, 2, 'A missing interval cannot extend dwell');
assert.equal(detect([...stable(500), ...stable(0)]).length, 2, 'A clock regression terminates the candidate');
for (const invalid of [null, sample(110, NaN), sample(110, 1.1), sample(110, -.1), sample(110, .2, { blink: true }),
  sample(110, .2, { leftBlink: true }), sample(110, .2, { markerOnly: true })]) {
  assert.equal(detect([...stable(), invalid, ...stable(120)]).length, 2, 'Invalid samples split events');
}
assert.equal(detect([...stable(), ...stable(120).map(p => ({ ...p, stimulusName: 'next' }))]).length, 2);
assert.equal(detect([...stable(), ...stable(120, .22)]).length, 2, '38.4 source pixels exceed the 35px radius');
assert.equal(detect([...stable(), ...stable(120, .22)], 1000).length, 1, 'Measure source pixels, not normalized distance');
assert.equal(detect([...stable(), ...stable(120, .21)])[0].fixationDurationMs, 220);

load('electron/domains/recording/recordPointHandlers.ts').registerRecordPointHandlers();
const { RECORD_POINTS_PARSE_VERSION } = load('shared/constants/recordPoints.ts');
const { normalizeVisualTimestampsToVideo } = load('src/features/analysis/visual/visualDataModel.ts');
const single = detect(stable(20_000));
assert.equal(normalizeVisualTimestampsToVideo(single, 30)[0].timestamp, 20100, 'Sparse events keep actual video time');
assert.deepEqual(normalizeVisualTimestampsToVideo([...single, ...detect(stable(25_000))], 30).map(p => p.timestamp),
  [20100, 25100], 'Sparse time spans must not trigger unit guessing');
const { drawGazePaths } = load('src/features/analysis/visual/heatmapRendering.ts');
const trajectory = detect([...stable(), ...stable(120, .7), ...stable(240, .7)]);
const drawn = { arcs: [], labels: [], lines: [] };
const context = {
  clearRect() {}, beginPath() {}, fill() {}, stroke() {},
  moveTo() {}, lineTo: (...args) => drawn.lines.push(args),
  arc: (x, y, radius) => drawn.arcs.push([x, y, radius]),
  fillText: (text, x, y) => drawn.labels.push([text, x, y]),
};
drawGazePaths({ width: 1920, height: 1080, getContext: () => context }, { record: trajectory }, {}, 1, 220);
assert.deepEqual(drawn.labels.map(([label, x, y]) => [label, Math.round(x), Math.round(y)]),
  [['1', 384, 324], ['2', 1344, 324]]);
assert.equal(drawn.lines.length, 1);
assert.ok(drawn.arcs[0][2] < drawn.arcs[2][2], 'Existing 7invensun renderer uses dwell-weighted circle sizes');

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mrt-fixation-pipeline-'));
const header = ['timestamp', 'video_time_ms', 'recom_gaze_x', 'recom_gaze_y', 'recom_gaze_bit_mask', 'source_model',
  'source_event_type', 'fixation_state', 'fixation_center_x', 'fixation_center_y',
  'fixation_duration_ms', 'fixation_timestamp_ms', 'fixation_count', 'fixation_index', 'customMarker', 'stimulus'];
const row = (p, model, patch = {}) => ({ timestamp: 12345678 + p.timestamp, video_time_ms: p.timestamp,
  recom_gaze_x: p.x, recom_gaze_y: p.y, recom_gaze_bit_mask: 1, source_model: model, stimulus: 'record.mp4', ...patch });
const writeCsv = (name, rows) => {
  const csvPath = path.join(folder, `${name}.csv`);
  fs.writeFileSync(csvPath, [header.join(','), ...rows.map(r => header.map(h => r[h] ?? '').join(','))].join('\n'));
  return csvPath;
};
const read = async (csvPath, extra = {}) => {
  const result = await handlers['load-record-points']({}, { csvPath, pointMode: 'fixation',
    isGlassesMode: true, frameWidth: 1920, frameHeight: 1080, ...extra });
  assert.equal(result.ok, true);
  assert.equal(result.indexUsed, true);
  return result.points;
};
try {
  for (const model of ['HH_ET28', 'PupilCore', 'aSeeGlassesPlus', 'HH_ET10C']) {
    const rows = [...stable(), ...stable(120, .7)].map(p => row(p, model));
    // A timed marker on an invalid sample must remain on the timeline.
    rows.push(row(sample(240), model, { recom_gaze_bit_mask: 0, recom_gaze_x: '', recom_gaze_y: '', customMarker: 'M' }));
    const csvPath = writeCsv(model, rows);
    const original = fs.readFileSync(csvPath, 'utf8');
    const events = await read(csvPath);
    assert.equal(events.length, 2);
    assert.ok(events.every(p => p.fixationState === 4 && p.fixationSource === 'mrt_7invensun_fallback' &&
      p.timeBase === 'video_time_ms' && p.weight === 100));
    assert.equal((await read(csvPath, { pointMode: 'gaze' })).length, 12, 'Raw gaze stays available');
    const window = await read(csvPath, { startTimeMs: 110, endTimeMs: 220 });
    assert.deepEqual(plain(window), plain(events.slice(1)), 'Window and full mapping preserve the same IDs/centers/times');
    const timeline = await read(csvPath, { includeMarkerOnlyRows: true });
    assert.ok(timeline.some(p => p.customMarker === 'M' && p.timestamp === 240));
    assert.equal(timeline.filter(p => p.fixationSource).length, 2);
    const metaPath = csvPath.replace('.csv', '.points.index.json');
    const meta = JSON.parse(fs.readFileSync(metaPath));
    fs.writeFileSync(metaPath, JSON.stringify({ ...meta, parseVersion: 15, fixationPointCount: 0 }));
    fs.writeFileSync(csvPath.replace('.csv', '.analysis-events.csv'), 'x,y\n');
    assert.equal((await read(csvPath)).length, 2, 'Old empty ET28 caches rebuild automatically');
    assert.equal(JSON.parse(fs.readFileSync(metaPath)).parseVersion, RECORD_POINTS_PARSE_VERSION);
    assert.equal(fs.readFileSync(csvPath, 'utf8'), original, 'Never rewrite original gaze data');

    // Existing complete native/MRT events are authoritative, regardless of
    // where in the file they occur. Pupil has separate source_event_type rows.
    const native = writeCsv(`${model}-native`, [...rows, row(sample(300), model, {
      source_event_type: 'fixation', fixation_state: 4, fixation_center_x: .4, fixation_center_y: .6,
      fixation_duration_ms: 125, fixation_timestamp_ms: 175, fixation_count: 10, fixation_index: 7,
    })]);
    const nativePoints = await read(native);
    assert.equal(nativePoints.length, 1);
    assert.equal(nativePoints[0].id, 7);
    assert.equal(nativePoints[0].weight, 125);
    assert.equal(nativePoints[0].x, .4);
    assert.equal(nativePoints[0].timestamp, 300);
    assert.equal(nativePoints[0].fixationSource, undefined, 'Do not relabel or mix existing algorithms');
    const incomplete = writeCsv(`${model}-incomplete`, [...rows, row(sample(300), model, { fixation_state: 3 })]);
    assert.equal((await read(incomplete)).length, 0, 'An incomplete recorded event is not permission to fabricate a completed one');
    for (const boundary of [{ source_event_type: 'blink' }, { source_event_type: 'saccade' }, { fixation_state: 1 }]) {
      const separated = writeCsv(`${model}-boundary`, [
        ...stable().map(p => row(p, model)),
        row(sample(110), model, boundary),
        ...stable(120).map(p => row(p, model)),
      ]);
      assert.equal((await read(separated)).length, 2, 'Explicit blink/saccade rows also terminate a candidate');
    }
  }

  // Exercise MappingPage's real full-record loader, not a parallel request stub.
  const page = ts.createSourceFile('MappingPage.tsx', fs.readFileSync('src/features/mapping/MappingPage.tsx', 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const actions = {};
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.name.text === 'dedupeFixationEvents') actions.dedupe = node.initializer.getText(page);
      if (node.name.text === 'loadAllGazePoints') actions.load = node.initializer.arguments[0].getText(page);
    }
    ts.forEachChild(node, visit);
  }
  visit(page);
  const action = vm.runInNewContext(ts.transpileModule(`
    const dedupeFixationEvents = ${actions.dedupe};
    const action = ${actions.load}; action;
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    recordDataService: { loadPoints: p => handlers['load-record-points']({}, p) },
    videoSize: { width: 1920, height: 1080 }, MAX_MAPPING_GAZE_POINTS: 250_000,
    setMessage: message => { throw Error(message); }, translateBackendMessage: message => message,
  });
  const mappedInput = await action(path.join(folder, 'HH_ET28.csv'), { deviceType: '眼镜式', videoWidth: 1920, videoHeight: 1080 });
  assert.equal(mappedInput.length, 2);
  assert.deepEqual(plain(mappedInput.map(p => [p.timestamp, p.weight, p.id])), [[100, 100, 1], [220, 100, 2]]);
} finally {
  fs.rmSync(folder, { recursive: true, force: true });
}
console.log('Shared fixation pipeline: dwell, source-pixel radius, gaps, invalid samples, existing events, cache upgrade, markers, video time and real mapping loader passed.');
