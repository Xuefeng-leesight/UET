import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = new Map();
function load(relativePath) {
  if (cache.has(relativePath)) return cache.get(relativePath);
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  vm.runInNewContext(outputText, {
    module,
    exports: module.exports,
    require: (id) => {
      assert.ok(id.startsWith('@shared/'), `Unexpected dependency: ${id}`);
      return load(id.replace('@shared/', 'shared/') + '.ts');
    },
  });
  cache.set(relativePath, module.exports);
  return module.exports;
}

const { resolveAoiPlaybackStimulusSpan: resolve } = load('src/features/analysis/aoi/aoiAnalysisModel.ts');
const spans = [
  { stimulusId: 'a', startMs: 0, endMs: 5665 },
  { stimulusId: 'b', startMs: 5665, endMs: 12000 },
  { stimulusId: 'a', startMs: 12000, endMs: 20867 },
];
const cases = [
  [0, null, 0],
  [5664, 'a', 0],
  [5665, 'a', 0],
  [5665, null, 0], // End of the current stimulus, including unselected playback.
  [5665, 'b', 1], // Explicitly selecting the next stimulus starts its own AOI.
  [5665.001, null, 1],
  [5666, 'a', 1], // Never extend the selected stimulus into the next one.
  [5750, 'a', 1], // Overshoot from the supplied log must be clamped by playback.
  [12000, null, 1],
  [12000, 'a', 2], // Repeated stimulus: use the new occurrence at its start.
  [20867, 'a', 2],
  [20867, null, 2],
];
for (const [time, selected, index] of cases) {
  assert.equal(resolve(spans, time, selected), spans[index], `${time}/${selected}`);
}
assert.equal(resolve([], 0, null), null);
const fractional = [
  { stimulusId: 'a', startMs: 0, endMs: 5665.5 },
  { stimulusId: 'b', startMs: 5665.5, endMs: 10000 },
];
assert.equal(resolve(fractional, 5665.49, null), fractional[0]);
assert.equal(resolve(fractional, 5665.5, null), fractional[0]);
assert.equal(resolve(fractional, 5665.51, 'a'), fractional[1]);
assert.equal(resolve(fractional, (5665.5 / 1000) * 1000, 'a'), fractional[0]);
console.log('Passed 17 AOI playback boundary checks.');
