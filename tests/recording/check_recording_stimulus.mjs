import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as icons from 'lucide-react';

// Load production modules without copying the stimulus or timeline algorithms.
const root = process.cwd();
const modules = new Map();
function load(relative) {
  const filename = path.resolve(root, relative);
  if (modules.has(filename)) return modules.get(filename);
  const exports = {};
  modules.set(filename, exports);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React, esModuleInterop: true,
    },
  }).outputText;
  vm.runInNewContext(source, {
    exports, console,
    require(specifier) {
      if (specifier === 'react') return React;
      if (specifier === 'lucide-react') return icons;
      const base = specifier.startsWith('@shared/') ? path.join(root, 'shared', specifier.slice(8))
        : specifier.startsWith('@/') ? path.join(root, 'src', specifier.slice(2))
          : specifier.startsWith('.') ? path.resolve(path.dirname(filename), specifier) : null;
      assert.ok(base?.startsWith(`${root}${path.sep}`), `Unexpected dependency: ${specifier}`);
      const target = ['.ts', '.tsx'].map((suffix) => `${base}${suffix}`).find((candidate) => fs.existsSync(candidate));
      assert.ok(target, `Missing production dependency: ${specifier}`);
      return load(target);
    },
  }, { filename, timeout: 1000 });
  return exports;
}

const { resolveRecordingVideoStimulus } = load('shared/domain/recordingStimulus.ts');
const { TimelineAnalysis } = load('src/features/records/TimelineAnalysis.tsx');
const { parseAoiStore } = load('src/features/analysis/aoi/aoiPersistence.ts');
const json = (value) => JSON.parse(JSON.stringify(value));
const baseRecord = {
  id: 'session-1', name: 'complete-session', subjectName: 'subject', timestamp: '',
  duration: '00:30', fps: '30', durationSeconds: 30,
  deviceType: '眼镜式', deviceModel: 'PupilCore',
  mp4Path: '/project/recordings/session-1.mp4', csvPath: '/project/recordings/session-1.csv',
};
const fullVideo = resolveRecordingVideoStimulus(baseRecord);
assert.deepEqual(json(fullVideo), {
  id: 'record:session-1', name: 'complete-session', stimulusType: 'video', startTime: 0, endTime: 30,
});

// Device type is the common capability. Future glasses need no new registry.
for (const deviceModel of ['PupilCore', 'aSeeGlassesPlus', 'HH_ET28', 'future-glasses']) {
  const record = Object.freeze({ ...baseRecord, deviceModel });
  assert.deepEqual(json(resolveRecordingVideoStimulus(record)), json(fullVideo), deviceModel);
}
assert.deepEqual(json(resolveRecordingVideoStimulus({ ...baseRecord, deviceModel: undefined })), json(fullVideo),
  'Historical glasses records can omit model');
for (const deviceModel of ['Pro', 'A8', 'HH_ET10C', 'PupilCore']) {
  assert.equal(resolveRecordingVideoStimulus({ ...baseRecord, deviceType: '桌面式', deviceModel }), null);
}
assert.equal(resolveRecordingVideoStimulus({ ...baseRecord, deviceType: undefined }), null,
  'A model name must not replace the required device type');
assert.equal(resolveRecordingVideoStimulus(null), null);
assert.equal(resolveRecordingVideoStimulus(undefined), null);
assert.equal(resolveRecordingVideoStimulus({ ...baseRecord, id: ' ' }), null);
assert.equal(resolveRecordingVideoStimulus({ ...baseRecord, modalities: {
  'facial-expression': { status: 'complete', sourcePath: '/face.mp4' },
} }), null, 'A facial-only recording cannot become an eye-tracking stimulus');
assert.ok(resolveRecordingVideoStimulus({ ...baseRecord, modalities: {
  'eye-tracking': { status: 'partial' }, 'facial-expression': { status: 'complete' },
} }), 'A usable partial eye-tracking video retains its full media extent');

for (const missingVideo of [
  { mp4Path: undefined, mp4Url: undefined }, { mp4Path: '', mp4Url: ' ' },
]) assert.equal(resolveRecordingVideoStimulus({ ...baseRecord, ...missingVideo }, 30), null);
assert.ok(resolveRecordingVideoStimulus({ ...baseRecord, mp4Path: undefined, mp4Url: 'mrt-resource://record.mp4' }));
for (const durationSeconds of [undefined, 0, -1, NaN, Infinity]) {
  assert.equal(resolveRecordingVideoStimulus({ ...baseRecord, durationSeconds }), null,
    'The display duration string cannot manufacture a media duration');
  assert.equal(resolveRecordingVideoStimulus({ ...baseRecord, durationSeconds }, 14.375).endTime, 14.375);
}
for (const invalidLoadedDuration of [0, -1, NaN, Infinity]) {
  assert.equal(resolveRecordingVideoStimulus(baseRecord, invalidLoadedDuration).endTime, 30);
}
assert.equal(resolveRecordingVideoStimulus(baseRecord, 14.375).endTime, 14.375,
  'Loaded media duration supersedes metadata without rounding or using gaze extent');
assert.equal(resolveRecordingVideoStimulus(baseRecord, 0.05).endTime, 0.05);

// Stable record scopes must continue to find existing version 2/3 AOIs.
const sameName = resolveRecordingVideoStimulus({ ...baseRecord, id: 'session-2' });
assert.equal(sameName.name, fullVideo.name);
assert.notEqual(sameName.id, fullVideo.id);
assert.equal(resolveRecordingVideoStimulus({ ...baseRecord, name: 'renamed' }).id, fullVideo.id);
for (const version of [2, 3]) {
  const persisted = { version, byRecordId: {
    'record:session-1': [{ id: 'old-aoi', name: 'target', type: 'rect', x: .1, y: .2, w: .3, h: .4,
      keyframes: [{ timeMs: 12000, x: .2, y: .3, w: .3, h: .4 }],
      analysisTimeRanges: [{ id: 'late-range', startTimeMs: 12000, endTimeMs: 18000, enabled: true }] }],
    'record:session-2': [{ id: 'other-aoi', type: 'ellipse' }],
  } };
  const loaded = parseAoiStore(json(persisted));
  assert.equal(loaded.byRecordId[fullVideo.id][0].id, 'old-aoi');
  assert.equal(loaded.byRecordId[sameName.id][0].id, 'other-aoi');
  assert.equal(loaded.byRecordId[fullVideo.id][0].keyframes[0].timeMs, 12000);
  assert.equal(loaded.byRecordId[fullVideo.id][0].analysisTimeRanges[0].endTimeMs, 18000);
}

function render(overrides = {}) {
  return renderToStaticMarkup(React.createElement(TimelineAnalysis, {
    duration: 30, currentTime: 0, stimuli: [], points: [], defaultExpanded: true,
    onSeek() {}, ...overrides,
  }));
}
function renderedEvents(html) {
  return [...html.matchAll(/<div\b[^>]*class="absolute group"[^>]*>/g)].map(([element]) => ({
    title: element.match(/\btitle="([^"]*)"/)?.[1],
    style: element.match(/\bstyle="([^"]*)"/)?.[1],
  }));
}
const stimulusRows = [
  { id: 'material-a', name: 'material-A', stimulusType: 'image', url: '/a.png' },
  { id: 'material-b', name: 'material-B', stimulusType: 'video', url: '/b.mp4' },
];
const sparsePoints = [
  { x: .1, y: .2, timestamp: 3000, stimulusName: 'material-a' },
  { x: .5, y: .7, timestamp: 27000, stimulusName: 'material-b' },
];
for (const points of [[], [{ x: .4, y: .5, timestamp: 9000 }], sparsePoints]) {
  const before = JSON.stringify(points);
  const events = renderedEvents(render({
    points, stimuli: stimulusRows, recordingVideoStimulus: fullVideo,
    selectedStimulusName: 'stale-selection',
  }));
  assert.equal(events.length, 1, 'Empty/sparse/multi-label CSV still has exactly one complete video bar');
  assert.equal(events[0].title, 'complete-session - 00:00 ~ 00:30');
  assert.match(events[0].style, /(?:^|;)left:0%(?:;|$)/);
  assert.match(events[0].style, /(?:^|;)width:100%(?:;|$)/);
  assert.equal(JSON.stringify(points), before, 'Rendering must not rewrite original points or stimulus labels');
}

const markerPoints = [
  { x: .1, y: .2, timestamp: 2000, stimulusName: 'material-a', triggerMark: 42, customMarker: 'manual-A' },
  { x: .5, y: .7, timestamp: 8000, stimulusName: 'material-b', triggerMark: 43, customMarker: 'manual-B' },
];
const glassesEvents = renderedEvents(render({ points: markerPoints, stimuli: stimulusRows,
  recordingVideoStimulus: fullVideo, selectedStimulusName: 'not-in-this-record' }));
assert.equal(glassesEvents.length, 5);
for (const title of ['触发 42 - 00:02', '触发 43 - 00:08', 'manual-A - 00:02', 'manual-B - 00:08']) {
  assert.ok(glassesEvents.some((event) => event.title === title), `Original event preserved: ${title}`);
}
const withoutMarkers = renderedEvents(render({ points: markerPoints, recordingVideoStimulus: fullVideo,
  showMarkTrack: false, showTriggerTrack: false }));
assert.equal(withoutMarkers.length, 1, 'Existing track visibility remains available');

// Desktop material spans and selected-material marker filtering are unchanged.
const desktopEvents = renderedEvents(render({ points: markerPoints, stimuli: stimulusRows,
  selectedStimulusName: 'material-A' }));
assert.ok(desktopEvents.some((event) => event.title === 'material-A - 00:00 ~ 00:05'));
assert.ok(desktopEvents.some((event) => event.title === 'material-B - 00:05 ~ 00:30'));
assert.ok(desktopEvents.some((event) => event.title === 'manual-A - 00:02'));
assert.ok(!desktopEvents.some((event) => event.title === 'manual-B - 00:08'));
assert.equal(renderedEvents(render()).length, 0, 'Unknown media must not gain a synthetic video span');

// A true media duration may exceed stale metadata. Saved user ranges remain
// independent from the full-video descriptor, including ranges near the end.
const segments = [{ id: 'user-range', name: 'later-window', startTime: 12, endTime: 18,
  color: '#00aa00', enabled: true, createdAt: '', updatedAt: '' }];
const beforeSegments = JSON.stringify(segments);
const lateRangeHtml = render({ duration: 10, recordingVideoStimulus: fullVideo, segments });
assert.equal(renderedEvents(lateRangeHtml)[0].title, 'complete-session - 00:00 ~ 00:30');
assert.match(lateRangeHtml, /全局统计范围 00:12 - 00:18/,
  'Existing ranges must use the same real media duration as the complete-video bar');
assert.equal(JSON.stringify(segments), beforeSegments);
const scopedHtml = render({ recordingVideoStimulus: fullVideo, customTimeRangeMode: 'scoped',
  scopedTimeRanges: [{ id: 'aoi-window', startTime: 5, endTime: 7, enabled: false }] });
assert.match(scopedHtml, /AOI 统计范围 00:05 - 00:07/);
assert.equal(renderedEvents(scopedHtml)[0].title, 'complete-session - 00:00 ~ 00:30');

console.log('Recording stimulus checks passed: shared device rule, media boundaries, legacy AOI scopes and production timeline SSR.');
