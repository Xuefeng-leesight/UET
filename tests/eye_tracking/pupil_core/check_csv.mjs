// Verify the real legacy consumer, outside the product package.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

function loadSource(relative, dependencies = {}) {
  const source = fs.readFileSync(path.resolve(relative), 'utf8');
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  const context = { exports, require: (name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unreviewed consumer dependency: ${name}`);
    return dependencies[name];
  } };
  vm.runInNewContext(javascript, context, { filename: relative, timeout: 1000 });
  return exports;
}

const constants = loadSource('shared/constants/recordPoints.ts');
const parser = loadSource('electron/domains/recording/recordCsvParser.ts', {
  '../../../shared/constants/recordPoints': constants,
});
const rows = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const source of ['recommended', 'raw', 'smooth']) {
  const headers = Object.keys(rows[0]);
  const state = parser.makeCsvPointParserState(headers, { isGlassesMode: true, pointSource: source });
  const parse = (row) => parser.parseCsvPartsToHeatmapPoint(headers.map((key) => String(row[key] ?? '')), state);
  const point = parse(rows[0]);
  assert.equal(point.x, 0.25);
  assert.equal(point.y, 0.25);
  assert.ok(Math.abs(point.timestamp - 100) < 1e-6);
  assert.equal(point.pupilDiameter, undefined);
  assert.equal(parse({ ...rows[0], left_pupil_diameter: 40, left_pupil_diameter_mm: '' }).pupilDiameter,
    undefined, 'Pupil pixel diameter must never be interpreted as millimeters');
  assert.equal(parse(rows[1]), null);
  assert.equal(parse(rows[2]).x, 0);
  assert.equal(parse(rows[2]).y, 0);
  assert.equal(parse({ ...rows[2], source_model: '' }), null, 'Legacy corner behavior must remain unchanged');
  assert.equal(parse({ ...rows[2], recom_gaze_bit_mask: 0 }), null);
}
console.log('MRT CSV mapping checked; Pupil top-left-zero-pair accepted, legacy sentinel unchanged.');
