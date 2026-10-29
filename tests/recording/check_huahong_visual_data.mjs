import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const handlers = {};
const cache = new Map();
const quiet = { log() {}, warn() {}, error: console.error };
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file);
  const exports = {};
  cache.set(file, exports);
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, { exports, process, Buffer, console: quiet, setTimeout, clearTimeout,
    window: { setTimeout, clearTimeout }, require(spec) {
      if (spec.startsWith('node:')) return require(spec);
      if (spec === 'electron') return { ipcMain: { handle: (name, fn) => { handlers[name] = fn; } } };
      if (spec === '../filesystem/pathValidation') return { validateUtf8Path: async () => ({ ok: true }) };
      if (spec === '@/infrastructure/electron/ipcClient') return { ipcClient: { isAvailable: () => true } };
      if (spec === '@/features/records/RecordDataService') return { recordDataService: {
        loadPoints: payload => handlers['load-record-points']({}, payload),
      } };
      if (spec === '@/features/analysis/visual/heatmapRendering') return {
        HEATMAP_POINT_PARSE_VERSION: load('shared/constants/recordPoints.ts').RECORD_POINTS_PARSE_VERSION,
      };
      const base = spec.startsWith('@/') ? path.resolve('src', spec.slice(2))
        : spec.startsWith('@shared/') ? path.resolve('shared', spec.slice(8)) : path.resolve(path.dirname(file), spec);
      return load(`${base}.ts`);
    } });
  return exports;
}
const profile = load('src/features/recording/device/deviceProfile.ts');
const normalize = v => Number(v) > 0 ? 120 : 0;
load('electron/domains/recording/recordingListHandlers.ts').registerRecordingListHandlers({
  buildLocalResourceUrl: async p => p, normalizeDataSamplingRateHz: normalize,
  normalizeProjectDeviceType: profile.normalizeDeviceType, normalizeProjectDeviceModel: profile.normalizeDeviceModel,
  probeMediaDurationSeconds: async () => undefined,
});
load('electron/domains/recording/recordPointHandlers.ts').registerRecordPointHandlers();
load('electron/domains/recording/recordMetadataHandlers.ts').registerRecordMetadataHandlers({ normalizeDataSamplingRateHz: normalize });
const { visualHeatmapEffect } = load('src/features/analysis/visual/visualHeatmapEffect.ts');
async function loadVisual(record, pointSource) {
  let data;
  let error;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Visual load timeout')), 10000);
    visualHeatmapEffect({ activeTab: 'visual', selectedRecordId: record.id, visibleRecordIds: new Set([record.id]),
      records: [record], heatmapPointsByRecord: {}, pointSource,
      setHeatmapError: fn => { error = fn(null); },
      setHeatmapLoadingRecordId: id => { if (id === null) { clearTimeout(timeout); resolve(); } },
      setHeatmapPointsByRecord: fn => { data = fn({}); },
    });
  });
  assert.equal(error, null);
  return data[record.id].filter(p => !p.markerOnly);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrt-huahong-visual-'));
const source = process.argv[2];
try {
  fs.mkdirSync(path.join(root, 'recordings'));
  let name = 'huahong_012345abcdef';
  if (source) {
    name = path.basename(source, '.csv');
    for (const ext of ['csv', 'meta.json', 'mp4']) fs.copyFileSync(source.replace(/\.csv$/, `.${ext}`), path.join(root, 'recordings', `${name}.${ext}`));
  } else {
    fs.writeFileSync(path.join(root, 'recordings', `${name}.mp4`), 'Media decoding covered separately');
    const rows = Array.from({ length: 24 }, (_, i) => `${i * 20},${i * 20},${i < 12 ? .2 : .7},0.3,1,HH_ET28,,,`);
    fs.writeFileSync(path.join(root, 'recordings', `${name}.csv`),
      'timestamp,video_time_ms,recom_gaze_x,recom_gaze_y,recom_gaze_bit_mask,source_model,fixation_state,fixation_center_x,fixation_center_y\n' + rows.join('\n') + '\n');
    fs.writeFileSync(path.join(root, 'recordings', `${name}.meta.json`), JSON.stringify({ productIntegration: true,
      deviceModel: 'HH_ET28', deviceType: '眼镜式', durationSeconds: .48, gazeRows: 24, samplingRateHz: 0, status: 'complete' }));
  }
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ deviceModel: 'HH_ET28', deviceType: '眼镜式' }));
  const metaPath = path.join(root, 'recordings', `${name}.meta.json`);
  const original = JSON.parse(fs.readFileSync(metaPath));
  const expectedRate = original.gazeRows / original.durationSeconds;
  const listing = await handlers['load-recordings']({}, { projectDir: root });
  assert.equal(listing.ok, true);
  const record = listing.records[0];
  assert.equal(record.samplingRateHz, expectedRate);
  const csvPath = path.join(root, 'recordings', `${name}.csv`);
  const fixation = await handlers['load-record-points']({}, { csvPath, pointMode: 'fixation', isGlassesMode: true,
    frameWidth: record.videoWidth, frameHeight: record.videoHeight });
  assert.ok(fixation.points.filter(p => !p.markerOnly).length > 0, 'Missing ET28 events must be derived before mapping');
  for (const deviceModel of ['HH_ET28', 'HH_ET10C', 'aSeeGlassesPlus', 'PupilCore']) {
    for (const pointSource of ['recommended', 'raw', 'smooth']) {
      const points = await loadVisual({ ...record, deviceModel }, pointSource);
      assert.ok(points.length > 0);
      assert.ok(points.every(p => p.visualPointMode === 'fixation' && p.fixationState === 4 &&
        p.fixationSource === 'mrt_7invensun_fallback' && p.weight >= 100));
      assert.deepEqual(points.map(p => [p.x, p.y, p.timestamp, p.weight]),
        fixation.points.map(p => [p.x, p.y, p.timestamp, p.weight]), 'Visualization and mapping use identical events');
      console.log(`${deviceModel}/${pointSource}: ${points.length} fixation events; measured rate ${record.samplingRateHz.toFixed(3)} Hz`);
    }
  }
  // Repeated visits to the same location must stay separate, in sequence.
  // The previous shared heatmap aggregation collapsed this into one point.
  const longPath = path.join(root, 'long.csv');
  const longRows = Array.from({ length: 20001 }, (_, i) =>
    `${i * 200 + 100},PupilCore,fixation,4,0.5,0.5,100,${i * 200},${i + 1}`);
  fs.writeFileSync(longPath, 'video_time_ms,source_model,source_event_type,fixation_state,fixation_center_x,fixation_center_y,fixation_duration_ms,fixation_timestamp_ms,fixation_index\n' +
    longRows.join('\n'));
  const visits = await loadVisual({ ...record, id: 'long', deviceModel: 'PupilCore', csvPath: longPath }, 'recommended');
  assert.equal(visits.length, 20001, 'Do not collapse scanpaths into heatmap cells');
  assert.ok(visits.every((p, i) => p.id === i + 1 && p.timestamp === i * 200 + 100 && p.weight === 100));
  await handlers['save-record-meta']({}, { projectDir: root, recordName: name, meta: { samplingRateHz: null } });
  assert.equal(JSON.parse(fs.readFileSync(metaPath)).samplingRateHz, expectedRate);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('Huahong recording metrics and real visual loading passed.');
