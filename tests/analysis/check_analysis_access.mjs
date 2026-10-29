import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const modules = new Map();
let authorized = true;
const stubs = {
  '@/app/settings/ThemeSettingsModal': { __esModule: true, default: () => null },
  '@/app/theme/useTheme': { useTheme: () => ({ theme: 'modern-light', setTheme() {} }) },
  '@/app/i18n/useLanguage': { useLanguage: () => ({ language: 'zh-CN' }) },
  '@/features/licensing/licenseContext': {
    useLicenseState: () => ({}), moduleForModality: id => id,
    isLicenseModuleAuthorized: () => authorized,
  },
};
const compile = source => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
} }).outputText;
function load(file) {
  file = path.resolve(file);
  if (modules.has(file)) return modules.get(file);
  const exports = {};
  modules.set(file, exports);
  vm.runInNewContext(compile(fs.readFileSync(file, 'utf8')), {
    exports, console,
    require(name) {
      if (Object.hasOwn(stubs, name)) return stubs[name];
      let target = name.startsWith('@/') ? path.resolve('src', name.slice(2))
        : name.startsWith('@shared/') ? path.resolve('shared', name.slice(8))
        : name.startsWith('.') ? path.resolve(path.dirname(file), name) : null;
      if (!target) return require(name);
      target = ['.ts', '.tsx'].map(ext => target + ext).find(candidate => fs.existsSync(candidate));
      assert.ok(target, `${file}: unresolved ${name}`);
      return load(target);
    },
  }, { filename: file });
  return exports;
}
const { Sidebar } = load('src/app/layout/Sidebar.tsx');
const { getProjectHiddenTabs, getProjectModalityPageGroups } = load('src/modalities/registry.ts');
const { MODULE_TAB_ORDER, MODULE_PAGE_VISIBILITY } = load('src/app/config.ts');
const ast = ts.createSourceFile('controller.tsx', fs.readFileSync('src/app/MrtApplicationController.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let hiddenMemo;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'effectiveHiddenTabs') hiddenMemo = node.initializer.arguments[0];
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(hiddenMemo);
const pages = ['visual', 'mapping', 'aoi', 'chart', 'insight'];
const labels = ['数据可视', '映射描点', 'AOI分析', '统计报表', '洞察报告'];
const models = ['Pro', 'A8', 'aSeeGlassesPlus', 'PupilCore', 'HH_ET10C', 'HH_ET28', 'future-device'];
const json = value => JSON.parse(JSON.stringify(value));
for (const platform of ['win32', 'darwin', 'linux']) {
  for (const deviceModel of models) {
    for (const legacy of [false, true]) {
      const project = { id: 'project', name: '离线分析', deviceModel, deviceType: '眼镜式',
        ...(legacy ? {} : { modalities: [{ id: 'eye-tracking', enabled: true, config: { deviceModel, deviceType: '眼镜式' } }] }) };
      const hidden = vm.runInNewContext(compile(`(${hiddenMemo.getText(ast)})()`), {
        activeProject: project, getProjectHiddenTabs, MODULE_TAB_ORDER, MODULE_PAGE_VISIBILITY,
        // A profile must not hide analysis, even if a future device introduces
        // acquisition restrictions. The production callback should ignore it.
        activeDeviceProfile: { hiddenTabs: pages }, process: { platform },
      });
      for (const page of pages) assert.ok(!hidden.includes(page), `${platform}/${deviceModel}/${page}`);
      assert.deepEqual(json(getProjectModalityPageGroups(project)[0].pages.map(page => page.id)), pages);
      const markup = renderToStaticMarkup(React.createElement(Sidebar, {
        project, activeTab: 'visual', hiddenTabs: hidden, onBack() {}, onTabChange() {},
      }));
      for (const label of labels) assert.ok(markup.includes(`aria-label="${label}"`), `${deviceModel}: ${label}`);
    }
  }
}
// Actual modality and licensing boundaries still apply, unlike device brands.
const facial = { modalities: [{ id: 'facial-expression', enabled: true, config: {} }] };
for (const page of pages) assert.ok(getProjectHiddenTabs(facial).includes(page));
authorized = false;
const denied = renderToStaticMarkup(React.createElement(Sidebar, {
  project: { deviceModel: 'HH_ET28' }, activeTab: 'visual', onBack() {}, onTabChange() {},
}));
for (const label of labels) assert.ok(!denied.includes(`aria-label="${label}"`));

// All three downstream modules consume the same events. A device label never
// changes AOI metrics, comparison statistics or generated insight evidence.
const { computeAoiStatsRows } = load('shared/domain/aoi/aoiReport.ts');
const { buildCompareResult } = load('src/features/analysis/reports/compareEngine.ts');
const { buildInsightReport } = load('src/features/analysis/reports/insightEngine.ts');
const points = [
  { id: '1', x: .3, y: .3, timestamp: 200, fixationTimestampMs: 0, fixationDurationMs: 200, weight: 200, state: 4, timeBase: 'video_time_ms' },
  { id: '2', x: .7, y: .7, timestamp: 900, fixationTimestampMs: 500, fixationDurationMs: 400, weight: 400, state: 4, timeBase: 'video_time_ms' },
];
const shapes = [{ id: 'target', name: 'Target', type: 'rect', visible: true, showStats: true, color: '#f00', x: 0, y: 0, w: 1, h: 1 }];
const stable = value => JSON.parse(JSON.stringify(value, (key, item) => ['id', 'createdAt', 'compareResultId'].includes(key) ? undefined : item));
let standard;
for (const deviceModel of models) {
  const rows = computeAoiStatsRows({ shapes, points: structuredClone(points), recordDurationMs: 1000, frameWidth: 1920 });
  assert.equal(rows[0].fixationCount, 2);
  assert.equal(rows[0].avgPupilDiameter, null, 'Missing physical pupil data is not fabricated');
  const compare = buildCompareResult({
    config: { recordIds: ['record'], groupBy: 'subject', createdAt: '2026-10-20' },
    records: [{ id: 'record', name: 'same data', deviceModel, deviceType: '眼镜式', durationSeconds: 1, samplingRateHz: 120 }],
    pointsByRecord: { record: structuredClone(points) }, aoiRowsByRecord: { record: rows },
  });
  assert.equal(compare.records[0].metrics.fixationCount, 2);
  assert.equal(compare.records[0].metrics.totalFixationDurationMs, 600);
  assert.equal(compare.records[0].metrics.avgPupilDiameter, null);
  const report = buildInsightReport({ compareResult: compare, tone: 'academic' });
  assert.equal(report.appendix.recordCount, 1);
  const result = stable({ rows, compare, report });
  if (!standard) standard = result;
  else assert.deepEqual(result, standard, `${deviceModel}: analysis differs from 7invensun standard`);
}
console.log('Analysis access: all five sidebar modules across seven device identities and three platforms; shared AOI/statistics/insights and missing-data boundaries pass.');
