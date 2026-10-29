import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import * as ReactDOM from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import * as icons from 'lucide-react';

// Execute the actual page expressions, JSX and event handlers. Full page mounts
// would require unrelated Electron, media and chart infrastructure; none of the
// recording-stimulus or duration-ownership logic is reimplemented in this test.
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React, esModuleInterop: true,
  },
}).outputText;
function load(file, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(compile(fs.readFileSync(file, 'utf8')), {
    exports, React, console,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency in ${file}: ${name}`);
      return dependencies[name];
    },
  }, { filename: file, timeout: 1000 });
  return exports;
}
function parse(file) {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function findOne(ast, predicate, label) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(matches.length, 1, `${ast.fileName}: expected one ${label}`);
  return matches[0];
}
function initializer(ast, name) {
  return findOne(ast, (node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === name, name).initializer;
}
function memo(ast, name) {
  const node = initializer(ast, name);
  assert.ok(ts.isCallExpression(node), `${name} must be a memo call`);
  return node.arguments[0];
}
function jsxProp(ast, tag, prop) {
  const element = findOne(ast, (node) => (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
    && node.tagName.getText(ast) === tag && node.attributes.properties.some((attribute) =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === prop), `${tag}.${prop}`);
  const attribute = element.attributes.properties.find((attribute) =>
    ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === prop);
  assert.ok(ts.isJsxExpression(attribute.initializer), `${tag}.${prop} must bind a production expression`);
  return attribute.initializer.expression;
}
function evaluate(node, globals = {}) {
  return vm.runInNewContext(compile(`(${node.getText()})`), { React, ...globals }, { timeout: 1000 });
}
const executeMemo = (ast, name, globals) => evaluate(memo(ast, name), globals)();
const json = (value) => JSON.parse(JSON.stringify(value));
const noop = () => {};
const { resolveRecordingVideoStimulus } = load('shared/domain/recordingStimulus.ts');
const panelDependencies = {
  'lucide-react': icons,
  '@/shared/ui/buttonClasses': load('src/shared/ui/buttonClasses.ts'),
  '@/shared/ui/CustomSelect': ({ children, value, disabled }) =>
    React.createElement('select', { value, disabled, onChange: noop }, children),
};
const panels = {
  aoi: load('src/features/analysis/aoi/AoiBasicSettingsPanel.tsx', panelDependencies).AoiBasicSettingsPanel,
  visual: load('src/features/analysis/visual/VisualSettingsPanel.tsx', panelDependencies).VisualSettingsPanel,
};
const panelProps = {
  stimuli: [{ id: 'desktop-material', name: 'Project material should not appear' }],
  selectedStimulusId: null, recordingVideoName: 'Pupil recording 29.2s',
  showMarkTrack: true, showTriggerTrack: true,
  aoiFontSize: 12, gridFontSize: 12, gridRows: 3, gridCols: 3,
  gridEnabled: false, aoiOpacity: .2, aoiBorderWidth: 2, gridMetricOptions: [],
  visualSubTab: 'heatmap', heatmapSettings: { radius: 30, opacity: .5, intensity: .5 },
};
for (const [kind, Panel] of Object.entries(panels)) {
  for (const isEn of [false, true]) {
    const render = (overrides = {}) => renderToStaticMarkup(React.createElement(Panel, {
      ...panelProps, isGlassesMode: true, isEn, ...overrides,
    }));
    const glasses = render();
    assert.ok(glasses.includes(isEn ? 'Full recording video' : '整段录制视频'));
    assert.ok(glasses.includes(panelProps.recordingVideoName));
    assert.ok(!glasses.includes(panelProps.stimuli[0].name));
    const empty = render({ recordingVideoName: undefined });
    if (kind === 'visual') {
      assert.match(empty, /<select/);
      assert.ok(empty.includes(isEn ? 'Full recording video' : '整段录制视频'));
      assert.ok(!empty.includes('显示所有刺激材料'));
      assert.ok(!empty.includes(isEn ? 'No recording selected' : '未选择记录'));
    } else {
      assert.ok(empty.includes(isEn ? 'No recording selected' : '未选择记录'));
    }
    const desktop = render({ isGlassesMode: false });
    assert.ok(desktop.includes(panelProps.stimuli[0].name));
    assert.ok(!desktop.includes(panelProps.recordingVideoName));
    assert.ok(!desktop.includes(isEn ? 'Full recording video' : '整段录制视频'));
  }
}

// Render the production CustomSelect too: the glasses source is one selected
// option in the existing single-line control, including before record selection.
const CustomSelect = load('src/shared/ui/CustomSelect.tsx', {
  react: React, 'react-dom': ReactDOM, 'lucide-react': icons,
}).default;
const RealVisualPanel = load('src/features/analysis/visual/VisualSettingsPanel.tsx', {
  ...panelDependencies, '@/shared/ui/CustomSelect': CustomSelect,
}).VisualSettingsPanel;
for (const isEn of [false, true]) {
  for (const recordingVideoName of [undefined, panelProps.recordingVideoName]) {
    const markup = renderToStaticMarkup(React.createElement(RealVisualPanel, {
      ...panelProps, isEn, recordingVideoName, isGlassesMode: true,
      selectedStimulusId: 'stale-desktop-material',
    }));
    assert.ok(markup.includes(isEn ? 'Stimulus filter' : '刺激材料筛选'), 'The shared filter heading follows the active language');
    assert.match(markup, /<button[^>]*aria-haspopup="listbox"[^>]*>/, 'Glasses retain the real CustomSelect');
    assert.ok(markup.includes(isEn ? 'Full recording video' : '整段录制视频'));
    assert.equal(markup.includes(panelProps.recordingVideoName), Boolean(recordingVideoName));
    assert.ok(!markup.includes(isEn ? 'Show all stimuli' : '显示所有刺激材料'));
    assert.ok(!markup.includes(panelProps.stimuli[0].name));
  }
  const desktop = renderToStaticMarkup(React.createElement(RealVisualPanel, {
    ...panelProps, isEn, isGlassesMode: false,
  }));
  assert.ok(desktop.includes(isEn ? 'Show all stimuli' : '显示所有刺激材料'));
  assert.ok(!desktop.includes(isEn ? 'Full recording video' : '整段录制视频'));
  const mapping = renderToStaticMarkup(React.createElement(RealVisualPanel, {
    ...panelProps, isEn, isGlassesMode: true, isMappingMode: true,
    selectedStimulusId: panelProps.stimuli[0].id,
  }));
  assert.match(mapping, /<button[^>]*disabled=""[^>]*aria-haspopup="listbox"/);
  assert.ok(mapping.includes(panelProps.stimuli[0].name));
  assert.ok(!mapping.includes(isEn ? 'Full recording video' : '整段录制视频'));
}
for (const isEn of [false, true]) {
  const mapped = renderToStaticMarkup(React.createElement(panels.visual, {
    ...panelProps, isGlassesMode: true, isMappingMode: true, isEn,
  }));
  assert.ok(mapped.includes(panelProps.stimuli[0].name), 'Mapping keeps its existing material selector');
  assert.match(mapped, /<select[^>]*disabled=""/);
  assert.ok(!mapped.includes(panelProps.recordingVideoName));
  assert.ok(!mapped.includes(isEn ? 'Full recording video' : '整段录制视频'));
}

const baseRecord = {
  id: 'new-record', name: 'Current video', deviceType: '眼镜式', deviceModel: 'PupilCore',
  mp4Path: '/project/new.mp4', mp4Url: 'mrt-resource://new.mp4', durationSeconds: 29.2,
};
const pageFiles = {
  aoi: 'src/features/analysis/aoi/AoiPage.tsx',
  visual: 'src/features/analysis/visual/VisualPage.tsx',
};
for (const [kind, file] of Object.entries(pageFiles)) {
  const ast = parse(file);
  const helperImport = findOne(ast, (node) => ts.isImportDeclaration(node)
    && node.moduleSpecifier.text === '@shared/domain/recordingStimulus', 'shared stimulus import');
  assert.ok(helperImport.importClause.namedBindings.elements.some((item) => item.name.text === 'resolveRecordingVideoStimulus'));
  const globals = {
    selectedRecord: baseRecord, projectDir: '/project',
    projectDeviceType: '眼镜式',
    recordListMode: 'records',
    aoiSelectedRecordId: baseRecord.id, selectedRecordId: baseRecord.id,
    isMappingMode: false, isGlassesMode: true, isEn: false,
    resolvedRecordVideoUrl: baseRecord.mp4Url, loadedRecordVideo: null,
    resolveRecordingVideoStimulus,
  };
  const recordVideoKey = evaluate(initializer(ast, 'recordVideoKey'), globals);
  globals.recordVideoKey = recordVideoKey;
  if (kind === 'visual') {
    assert.equal(evaluate(initializer(ast, 'isGlassesMode'), { ...globals, selectedRecord: null }), true,
      'A glasses project defaults to the recording video before any record is selected');
    assert.equal(evaluate(initializer(ast, 'isGlassesMode'), {
      ...globals, selectedRecord: null, projectDeviceType: '桌面式',
    }), false);
    assert.equal(evaluate(initializer(ast, 'isGlassesMode'), {
      ...globals, selectedRecord: null, projectDeviceType: undefined,
    }), false, 'Unknown project type does not invent glasses mode');
    assert.equal(evaluate(initializer(ast, 'isGlassesMode'), {
      ...globals, selectedRecord: null, recordListMode: 'mapping',
    }), false, 'The project fallback must not change mapping filtering before a reference is selected');
    assert.equal(evaluate(initializer(ast, 'isGlassesMode'), {
      ...globals, selectedRecord: null, recordListMode: 'mapping', isMappingMode: true,
    }), false, 'The project fallback must not change the active mapping selector');
    for (const deviceModel of ['HH_ET28', 'PupilCore', 'aSeeGlassesPlus', undefined]) {
      assert.equal(evaluate(initializer(ast, 'isGlassesMode'), {
        ...globals, selectedRecord: { ...baseRecord, deviceModel }, projectDeviceType: '桌面式',
      }), true, 'The selected record type has priority over the project; no vendor whitelist');
    }
    assert.equal(evaluate(initializer(ast, 'isGlassesMode'), {
      ...globals, selectedRecord: { ...baseRecord, deviceType: '桌面式' },
    }), false, 'An explicit desktop record keeps desktop filtering in a glasses project');
    assert.equal(executeMemo(ast, 'recordingVideoStimulus', { ...globals, selectedRecord: null }), null,
      'The default selector must not fabricate a playable recording or duration');
  }
  for (const change of [
    { projectDir: '/other-project' },
    { aoiSelectedRecordId: 'other', selectedRecordId: 'other' },
    { selectedRecord: { ...baseRecord, mp4Path: '/project/replaced.mp4' } },
    { selectedRecord: { ...baseRecord, mp4Url: 'mrt-resource://replaced.mp4' } },
  ]) assert.notEqual(evaluate(initializer(ast, 'recordVideoKey'), { ...globals, ...change }), recordVideoKey,
    `${kind}: project, record and source changes must invalidate media ownership`);

  const stimulus = () => executeMemo(ast, 'recordingVideoStimulus', globals);
  assert.equal(stimulus().endTime, 29.2, `${kind}: metadata provides the duration before media loads`);
  globals.loadedRecordVideo = { recordKey: 'previous-owner', url: baseRecord.mp4Url, duration: 999 };
  assert.equal(stimulus().endTime, 29.2, `${kind}: old record duration rejected even with a reused URL`);
  globals.loadedRecordVideo = { recordKey: recordVideoKey, url: baseRecord.mp4Url, duration: 29.23 };
  assert.equal(stimulus().endTime, 29.23, `${kind}: matching media duration preferred`);
  globals.loadedRecordVideo = { recordKey: recordVideoKey, url: 'mrt-resource://old.mp4', duration: 999 };
  assert.equal(stimulus().endTime, 29.2, `${kind}: old source URL rejected`);
  globals.selectedRecord = { ...baseRecord, durationSeconds: undefined };
  assert.equal(stimulus(), null, `${kind}: unknown current duration never uses stale media`);
  globals.selectedRecord = baseRecord;

  // Invoke the production video event handler, including its owner/source gates.
  const metadataHandler = jsxProp(ast, 'video', 'onLoadedMetadata');
  function metadataWrites(overrides = {}, sourceUrl = baseRecord.mp4Url) {
    const writes = [];
    const handler = evaluate(metadataHandler, {
      ...globals, activeVideoUrl: baseRecord.mp4Url,
      recordVideoOwnerRef: { current: { recordKey: recordVideoKey, url: baseRecord.mp4Url } },
      setLoadedRecordVideo: (value) => writes.push(value), setDuration: noop,
      setAoiVideoNaturalSize: noop, aoiSyncVideoMeta: noop,
      setCurrentTime: noop, setVisualCurrentTime: noop, setIsPlaying: noop, setVideoSize: noop,
      ...overrides,
    });
    handler({ currentTarget: {
      duration: 29.23, currentTime: 0, paused: true, ended: false,
      videoWidth: 1280, videoHeight: 720,
      getAttribute(name) { assert.equal(name, 'src'); return sourceUrl; },
    } });
    return writes;
  }
  assert.deepEqual(json(metadataWrites()), [{ recordKey: recordVideoKey, url: baseRecord.mp4Url, duration: 29.23 }]);
  assert.equal(metadataWrites({ recordVideoOwnerRef: { current: null } }).length, 0);
  assert.equal(metadataWrites({ recordVideoOwnerRef: { current: { recordKey: 'old-owner', url: baseRecord.mp4Url } } }).length, 0);
  assert.equal(metadataWrites({ recordVideoOwnerRef: { current: { recordKey: recordVideoKey, url: 'mrt-resource://old.mp4' } } }).length, 0);
  assert.equal(metadataWrites({}, 'mrt-resource://old.mp4').length, 0, `${kind}: late metadata from an old element cannot claim the new record`);
  if (kind === 'aoi') assert.equal(metadataWrites({ activeVideoUrl: '/project/material.mp4' }).length, 0);
  if (kind === 'visual') assert.equal(metadataWrites({ isMappingMode: true }).length, 0);

  // Exercise the actual TimelineAnalysis JSX bindings, not a parallel test view.
  const descriptor = stimulus();
  const TimelineAnalysis = () => null;
  const timelineGlobals = {
    ...globals, TimelineAnalysis, recordingVideoStimulus: descriptor,
    duration: 999, currentTime: 0, canComputeAoiStats: true,
    stimuli: [], timelinePoints: [], customMarkers: [], timelineSegments: [], selectedSegmentId: null,
    showMarkTrack: true, showTriggerTrack: true, selectedStimulusForAnalysis: null,
    selectedBaseAoi: null, timelineRangeMode: 'global', selectedAoiTimelineRanges: [],
    resolveAoiBorderColor: () => '#0ea5e9',
    handleTimelineSegmentsChange: noop, setSelectedSegmentId: noop, seekTo: noop,
    handleSelectedAoiTimeRangeChange: noop, handleTimeRangeChange: noop,
    handleRemoveSelectedAoiTimeRange: noop, handleSelectedAoiTimeRangeEnabledChange: noop,
    handleTimelineRangeModeChange: noop, handleClearSelectedAoiTimeRange: noop,
    handleClearGlobalTimeRange: noop, handleClearTimelineTimeRange: noop, handleTimelineReset: noop,
  };
  const timeline = (overrides = {}) => executeMemo(ast, 'timelineAnalysisNode', { ...timelineGlobals, ...overrides });
  for (const duration of [0, 999]) {
    const element = timeline({ duration });
    assert.equal(element.type, TimelineAnalysis);
    assert.equal(element.props.recordingVideoStimulus, descriptor, `${kind}: forwards the shared descriptor unchanged`);
    assert.equal(element.props.duration, 29.2, `${kind}: does not use a missing/stale page duration`);
    assert.equal(element.props.points.length, 0, `${kind}: full-video track is available without gaze samples`);
  }
  assert.equal(timeline({ recordingVideoStimulus: null }), null, `${kind}: no invented timeline for unknown video duration`);
  const desktopTimeline = timeline({ isGlassesMode: false, recordingVideoStimulus: null, duration: 14 });
  assert.equal(desktopTimeline.props.duration, 14);
  assert.equal(desktopTimeline.props.recordingVideoStimulus, null);

  const panelTag = kind === 'aoi' ? 'AoiBasicSettingsPanel' : 'VisualSettingsPanel';
  const panelGlobals = { ...globals, recordingVideoStimulus: descriptor };
  assert.equal(evaluate(jsxProp(ast, panelTag, 'recordingVideoName'), panelGlobals), descriptor.name);
  assert.equal(evaluate(jsxProp(ast, panelTag, 'recordingVideoName'), { ...panelGlobals, recordingVideoStimulus: null }), baseRecord.name,
    `${kind}: source name remains visible while video duration is unknown`);
  assert.equal(evaluate(jsxProp(ast, panelTag, 'isEn'), { ...panelGlobals, isEn: true }), true);
  if (kind === 'visual') {
    globals.isMappingMode = true;
    assert.equal(stimulus(), null, 'Mapping cannot acquire a recording-video stimulus');
    const mappedTimeline = timeline({ isMappingMode: true, recordingVideoStimulus: null, duration: 17 });
    assert.equal(mappedTimeline.props.duration, 17);
    assert.equal(mappedTimeline.props.recordingVideoStimulus, null);
    assert.equal(evaluate(jsxProp(ast, panelTag, 'recordingVideoName'), { ...panelGlobals, isMappingMode: true }), undefined);
    assert.equal(evaluate(jsxProp(ast, panelTag, 'isMappingMode'), { ...panelGlobals, isMappingMode: true }), true);
  } else {
    const selectedStatsRecordIds = executeMemo(ast, 'selectedStatsRecordIds', {
      ...globals, records: [baseRecord], aoiStatsMultiSelectEnabled: false,
      aoiStatsSelectedRecordIds: new Set(), aoiSelectedStimulusId: null,
    });
    assert.equal(evaluate(initializer(ast, 'canComputeAoiStats'), { selectedStatsRecordIds }), true,
      'AOI timeline availability does not depend on populated gaze samples');
  }
}

const aoiEditor = parse('src/features/analysis/aoi/useAoiEditor.ts');
for (const id of ['pupil-record', 'other-glasses-record']) {
  assert.equal(executeMemo(aoiEditor, 'aoiStorageScopeId', {
    isGlassesMode: true, aoiSelectedRecordId: id, aoiSelectedStimulusId: 'stale-desktop-material',
  }), `record:${id}`, 'Glasses record scope takes priority over a leftover desktop selection');
}
assert.equal(executeMemo(aoiEditor, 'aoiStorageScopeId', {
  isGlassesMode: false, aoiSelectedRecordId: 'desktop-record', aoiSelectedStimulusId: 'desktop-material',
}), 'desktop-material');
assert.equal(executeMemo(aoiEditor, 'aoiStorageScopeId', {
  isGlassesMode: false, aoiSelectedRecordId: null, aoiSelectedStimulusId: null,
}), null);

console.log('Recording video UI checks passed: production page bindings, media ownership, bilingual panel SSR, mapping compatibility and AOI record scopes.');
