import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf-8');
const fail = (message) => {
  throw new Error(`Facial recording contract check failed: ${message}`);
};

const tessellationSource = read('src/features/recording/domain/faceMeshTessellation.ts');
const tessellationEdges = [...tessellationSource.matchAll(/\[(\d+),\s*(\d+)\]/g)]
  .map((match) => [Number(match[1]), Number(match[2])]);
if (tessellationEdges.length !== 2556) fail(`expected 2556 MediaPipe edges, found ${tessellationEdges.length}`);
if (tessellationEdges.some(([start, end]) => start < 0 || end < 0 || start >= 468 || end >= 468)) {
  fail('MediaPipe tessellation contains an out-of-range landmark index');
}

const electronServiceSource = read('electron/domains/facial/facialHandlers.ts');
const pythonServiceSource = read('services/facial_analysis/server.py');
const electronBuildId = /FACIAL_SERVICE_BUILD_ID\s*=\s*['"]([^'"]+)['"]/.exec(electronServiceSource)?.[1];
const pythonBuildId = /FACIAL_SERVICE_BUILD_ID\s*=\s*['"]([^'"]+)['"]/.exec(pythonServiceSource)?.[1];
if (!electronBuildId || electronBuildId !== pythonBuildId) fail('Electron and Python service build IDs differ');

const analysisServiceSource = read('services/facial_analysis/application/service.py');
if (!analysisServiceSource.includes('open(samples_path, "r", encoding="utf-8-sig", errors="replace")')) {
  fail('samples.jsonl is not read with an explicit UTF-8 encoding');
}

const controllerSource = read('src/app/MrtApplicationController.tsx');
if (controllerSource.includes("id: 'finalize_renderer_capture'")) {
  fail('recording finalization still invokes implicit facial analysis');
}

console.log(`Facial recording contracts passed (${tessellationEdges.length} fixed edges, build ${electronBuildId}).`);
