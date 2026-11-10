// Run Huahong mapper output through the real replay consumer.
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
  vm.runInNewContext(javascript, { exports, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), `Unreviewed consumer dependency: ${name}`);
    return dependencies[name];
  } }, { filename: relative, timeout: 1000 });
  return exports;
}

const constants = loadSource('shared/constants/recordPoints.ts');
const parser = loadSource('electron/domains/recording/recordCsvParser.ts', {
  '../../../shared/constants/recordPoints': constants,
});
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const { row, position } of cases) {
  for (const eye of ['recom', 'left', 'right']) {
    for (const column of ['gaze_point', 'raw_point', 'smooth_point']) {
      for (const axis of 'xyz') assert.equal(row[`${eye}_${column}_${axis}`], '');
    }
    assert.ok(['', 0, 1].includes(row[`${eye}_gaze_bit_mask`]), 'CSV must not claim independent raw/smooth points');
  }
  for (const pointSource of [undefined, 'recommended', 'raw', 'smooth']) {
    for (const pointMode of ['auto', 'gaze']) {
      const headers = Object.keys(row);
      const state = parser.makeCsvPointParserState(headers, {
        isGlassesMode: row.source_model === 'HH_ET28', pointSource, pointMode,
      });
      const parse = (value) => parser.parseCsvPartsToHeatmapPoint(headers.map(key => String(value[key] ?? '')), state);
      const point = parse(row);
      if (position === null) {
        assert.equal(point, null);
      } else {
        assert.ok(point, `${row.source_model}/${pointSource}/${pointMode} must fall back to recommended gaze`);
        assert.equal(point.x, position[0]);
        assert.equal(point.y, position[1]);
        assert.equal(point.timestamp, row.video_time_ms);
        assert.equal(point.pupilDiameter, undefined);
        assert.equal(parse({ ...row, recom_gaze_bit_mask: 0 }), null);
      }
    }
  }
}
console.log('Huahong CSV replay preserves recommended 2D gaze for every display path without physical 3D aliases.');
