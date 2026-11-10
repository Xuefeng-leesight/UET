import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const modules = new Map();
function load(file) {
  file = path.resolve(file);
  if (modules.has(file)) return modules.get(file);
  const exports = {};
  modules.set(file, exports);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(js, { exports, console, require(name) {
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name) + '.ts');
    return require(name);
  } }, { filename: file });
  return exports;
}
const { createAoiExportRowDeriver, buildAoiExportRows } = load('shared/domain/aoi/aoiExport.ts');
const { getHitAoiNames } = load('shared/domain/aoi/aoiReport.ts');
const shape = (overrides = {}) => ({ id: 'a', name: 'Target', type: 'rect', visible: true, showStats: true,
  color: 'sky', x: 0, y: 0, w: .5, h: 1, ...overrides });
const sample = (timeMs, x = .25, values = {}) => ({ timeMs, x, y: .5, valid: true, ...values });
const fixation = (key, startTimeMs, durationMs, values = {}) => ({ key, startTimeMs, durationMs, x: .25, y: .5, complete: true, ...values });
const run = (observations, options = {}) => buildAoiExportRows({ shapes: [shape()], observations, ...options });
const json = value => JSON.parse(JSON.stringify(value));
const values = (rows, key) => Array.from(rows, row => row[key]);

// The only observed exit is the continuous outside sample; a tail cannot close itself.
const visits = run([sample(0), sample(10), sample(20, .75), sample(30, .75), sample(40), sample(50)]);
assert.deepEqual(values(visits, 'aoi_hit'), ['1', '1', '0', '0', '1', '1']);
assert.deepEqual(values(visits, 'aoi_enter_time_ms'), ['0', '0', '0', '', '40', '40']);
assert.deepEqual(values(visits, 'aoi_exit_time_ms'), ['', '', '20', '', '', '']);
assert.deepEqual(values(visits, 'aoi_dwell_time_ms'), ['0', '10', '10', '', '0', '10']);
assert.ok(visits.every(row => row.aoi_fixation_count === ''), 'absence of an event source never proves zero fixations');
assert.equal(run([sample(0)], { fixationsAvailable: true })[0].aoi_fixation_count, '0');

// No source row is copied. Overlaps are parallel, ordered arrays, including unknown members.
const overlappingShapes = [shape({ id: 'left', name: 'same', w: .6 }), shape({ id: 'right', name: 'same', x: .4, w: .6 })];
const overlaps = run([sample(0, .2), sample(10, .5), sample(20, .8), sample(30, .2)], { shapes: overlappingShapes, fixationsAvailable: true });
assert.equal(overlaps.length, 4);
assert.equal(overlaps[0].aoi_id, '["left","right"]');
assert.equal(overlaps[0].aoi_name, '["same","same"]', 'equal display names do not merge distinct AOIs');
assert.equal(overlaps[0].aoi_enter_time_ms, '[0,null]');
assert.equal(overlaps[1].aoi_enter_time_ms, '[0,10]');
assert.equal(overlaps[2].aoi_exit_time_ms, '[20,null]');
assert.equal(overlaps[2].aoi_dwell_time_ms, '[10,10]');
assert.equal(overlaps[3].aoi_enter_time_ms, '[30,10]');
assert.equal(overlaps[3].aoi_exit_time_ms, '[null,30]');
assert.equal(overlaps[0].aoi_fixation_count, '[0,null]');
for (const row of overlaps) for (const value of Object.values(row)) assert.equal(JSON.parse(value).length, 2);
assert.ok(Object.values(run([sample(0)], { shapes: [] })[0]).every(value => value === ''));

// Missing position/time/validity is unknown, not origin, outside, or a reliable exit.
for (const bad of [
  { x: null }, { y: undefined }, { x: '' }, { x: NaN }, { y: Infinity }, { x: -.01 }, { y: 1.01 },
  { timeMs: null }, { timeMs: '' }, { timeMs: undefined }, { timeMs: -1 }, { timeMs: NaN },
  { valid: false }, { valid: undefined },
]) {
  const rows = run([sample(0), sample(10, .25, bad), sample(20)]);
  assert.equal(rows[1].aoi_hit, '', JSON.stringify(bad));
  assert.equal(rows[1].aoi_exit_time_ms, '', JSON.stringify(bad));
  assert.equal(rows[2].aoi_enter_time_ms, '20', 'missing observation breaks, rather than bridges, a visit');
  assert.equal(rows[2].aoi_dwell_time_ms, '0');
}
assert.equal(run([sample(0, 0, { y: 0 })])[0].aoi_hit, '1', 'real zero coordinates and video time are valid');
assert.equal(run([sample(0, .75)])[0].aoi_hit, '0', 'a valid observed outside position is known zero');

// Gaps, reversed/duplicate sample clocks and source changes break visit continuity.
for (const middle of [sample(101), sample(0), sample(-1), sample(10, .25, { continuityKey: 'other' }), sample(10, .25, { breakBefore: true })]) {
  const rows = run([sample(0, .25, { continuityKey: 'first' }), middle]);
  assert.equal(rows[1].aoi_exit_time_ms, '');
  if (middle.timeMs >= 0) assert.equal(rows[1].aoi_dwell_time_ms, '0');
}
assert.equal(run([sample(0), sample(100)])[1].aoi_dwell_time_ms, '100');
assert.equal(run([sample(0), sample(30)], { maxGapMs: 20 })[1].aoi_enter_time_ms, '30');
assert.equal(run([sample(0), sample(101, .75)])[1].aoi_exit_time_ms, '', 'an outside sample beyond the gap does not establish the missing exit');
assert.throws(() => createAoiExportRowDeriver({ shapes: [], maxGapMs: 0 }), /positive/);

// Event and marker rows can contain earlier clocks, but cannot add or interrupt samples.
const annotations = run([sample(0), { kind: 'event', timeMs: -500 }, { kind: 'annotation', timeMs: 9 }, sample(10), sample(20, .75)]);
assert.equal(annotations[1].aoi_hit, '');
assert.equal(annotations[2].aoi_hit, '');
assert.equal(annotations[3].aoi_dwell_time_ms, '10');
assert.equal(annotations[4].aoi_exit_time_ms, '20');
assert.equal(run([sample(0), sample(10, .25, { customMarker: 'real sample' })])[1].aoi_dwell_time_ms, '10');

// Geometry exactly uses the existing dynamic AOI engine, without per-vendor branches.
const geometries = [
  shape(), shape({ type: 'ellipse', w: .8, h: .6 }),
  shape({ type: 'polygon', points: [{ x: .1, y: .1 }, { x: .9, y: .1 }, { x: .5, y: .9 }] }),
  shape({ w: .2, keyframes: [{ timeMs: 100, metric: 0, x: .8, y: 0, w: .2, h: 1 }] }),
];
for (const aoi of geometries) for (const timeMs of [0, 25, 50, 75, 100, 200]) for (const x of [0, .25, .5, .75, 1]) {
  const expected = getHitAoiNames({ shapes: [aoi], x, y: .5, timeMs }).length > 0 ? '1' : '0';
  assert.equal(run([sample(timeMs, x)], { shapes: [aoi] })[0].aoi_hit, expected);
}
const moving = run([sample(0, .1), sample(50, .1)], { shapes: [geometries[3]] });
assert.equal(moving[1].aoi_hit, '0');
assert.equal(moving[1].aoi_exit_time_ms, '50', 'an observed moving boundary may establish an exit');
const coordinates = [sample(0), sample(10), sample(20, .75)];
assert.deepEqual(json(run(coordinates.map(row => ({ ...row, continuityKey: 'PupilCore:gen1' })))),
  json(run(coordinates.map(row => ({ ...row, continuityKey: '7invensun:gen1' })))), 'vendors use the same already-normalized spatial contract');

// Disabled, malformed or unfinished definitions never silently become all-time, origin AOIs.
for (const badShape of [
  shape({ visible: false }), shape({ x: undefined }), shape({ x: null }), shape({ w: 0 }),
  shape({ activationTimeMs: NaN }), shape({ keyframes: [{ timeMs: 100, metric: 0, x: .1 }] }),
  shape({ analysisTimeRanges: [{ startTimeMs: 0, endTimeMs: 100, enabled: false }] }),
  shape({ analysisTimeRanges: [{ startTimeMs: null, endTimeMs: 100 }] }),
  shape({ analysisTimeRanges: [{ startTimeMs: 100, endTimeMs: 0 }] }),
]) assert.equal(run([sample(10)], { shapes: [badShape] })[0].aoi_hit, '');
assert.equal(run([sample(0)], { shapes: [shape({ analysisTimeRanges: [] })] })[0].aoi_hit, '1', 'editor-cleared ranges mean unrestricted time');
assert.throws(() => run([sample(0)], { shapes: [shape(), shape()] }), /distinct/);
const ranged = shape({ activationTimeMs: 20, analysisTimeRanges: [
  { startTimeMs: 0, endTimeMs: 50 }, { startTimeMs: 50, endTimeMs: 100, enabled: false },
  { startTimeMs: 120, endTimeMs: 180 },
] });
const rangedRows = run([sample(0), sample(20), sample(50), sample(60), sample(120), sample(140), sample(181, .75)], { shapes: [ranged] });
assert.deepEqual(values(rangedRows, 'aoi_hit'), ['', '1', '1', '', '1', '1', '']);
assert.deepEqual(values(rangedRows, 'aoi_dwell_time_ms'), ['', '0', '30', '', '0', '20', '']);
assert.ok(rangedRows.every(row => row.aoi_exit_time_ms === ''), 'range endings are not observed spatial exits');
const skippedWindow = run([sample(20), sample(40), sample(70)], { shapes: [shape({ analysisTimeRanges: [
  { startTimeMs: 0, endTimeMs: 40 }, { startTimeMs: 60, endTimeMs: 100 },
] })] });
assert.equal(skippedWindow[2].aoi_enter_time_ms, '70', 'even without an intervening CSV row the disabled time span breaks continuity');
assert.equal(run([sample(5)], { shapes: [shape({ analysisTimeRange: { startTimeMs: 10, endTimeMs: 30 } })] })[0].aoi_hit, '');

// Only complete, uniquely identified fixations whose onsets belong to this visit count.
const event = fixation('g1:1', 0, 10);
const fixations = [event, { ...event }, fixation('g1:2', 10, 10), fixation('g2:1', 10, 10),
  fixation('not-complete', 0, 1, { complete: false }), fixation('outside', 0, 10, { x: .75 }),
  fixation('future', 0, 100), fixation('before', 0, 30)];
const counted = run([sample(0), sample(5), sample(10), sample(20), sample(25, .75), sample(30), sample(40)], { fixations, fixationsAvailable: true });
assert.deepEqual(values(counted, 'aoi_fixation_count'), ['0', '0', '1', '3', '3', '0', '0']);
assert.equal(counted[4].aoi_exit_time_ms, '25');
assert.equal(counted[5].aoi_enter_time_ms, '30');
assert.equal(run([sample(0), sample(10)], { fixations, fixationsAvailable: false })[1].aoi_fixation_count, '');
for (const missingEvidence of [{ x: null }, { startTimeMs: NaN }, { key: '' }, { durationMs: 0 }]) {
  assert.equal(run([sample(0), sample(20)], { fixationsAvailable: true, fixations: [fixation('missing', 0, 10, missingEvidence)] })[1].aoi_fixation_count, '',
    'an unlocalized or untimed complete event cannot silently become a known zero count');
}
assert.throws(() => run([], { fixations: [event, { ...event, durationMs: 20 }] }), /conflicting/);
const gapCount = run([sample(0), sample(101), sample(110)], { fixationsAvailable: true, fixations: [fixation('cross-gap', 0, 105)] });
assert.equal(gapCount[2].aoi_fixation_count, '0', 'an old event ending in a new observation visit does not belong to it');
const dynamicCount = run([sample(0, .1), sample(50, .5), sample(100, .9)], {
  shapes: [geometries[3]], fixationsAvailable: true, fixations: [fixation('moving', 50, 50, { x: .5 })],
});
assert.equal(dynamicCount[2].aoi_fixation_count, '1', 'fixation membership uses the shape at its onset, not completion geometry');
const rangeCount = run([sample(20), sample(30), sample(50), sample(120), sample(130)], {
  shapes: [ranged], fixationsAvailable: true, fixations: [fixation('pre-activation', 10, 20), fixation('active', 20, 10), fixation('disabled', 60, 70)],
});
assert.deepEqual(values(rangeCount, 'aoi_fixation_count'), ['0', '1', '1', '0', '0']);

// Streaming and batch are identical, and original definitions/events/observations stay intact.
const options = { shapes: overlappingShapes, observations: coordinates, fixations, fixationsAvailable: true };
const before = JSON.stringify(options);
const stream = createAoiExportRowDeriver(options);
assert.deepEqual(json(buildAoiExportRows(options)), json(coordinates.map(stream)));
assert.equal(JSON.stringify(options), before);
console.log('AOI export: seven standard fields, overlap arrays, dynamic geometry/windows, observed visits, complete fixation counts, and streaming parity passed.');
