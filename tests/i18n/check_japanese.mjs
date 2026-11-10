import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const cache = new Map();
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', code)((name) => {
    if (name.startsWith('@/')) return load(`src/${name.slice(2)}.ts`);
    if (name.startsWith('@shared/')) return load(`shared/${name.slice(8)}.ts`);
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), `${name}.ts`));
    return require(name);
  }, module, module.exports);
  return module.exports;
}

const { translateTextForLanguage: tr } = load('src/app/i18n/useDomTranslation.ts');
const { buildInsightReport } = load('src/features/analysis/reports/insightEngine.ts');
const { renderInsightReportHtml, buildCompareCsv } = load('src/features/analysis/reports/reportRenderer.ts');
const { COMPARE_METRIC_DEFS } = load('src/features/analysis/reports/compareEngine.ts');
const notices = [
  ['确定要删除实验「保存中文名称」吗？\n此操作会永久删除当前实验的全部数据，且不可恢复。', '実験「保存中文名称」を削除しますか？'],
  ['确定要删除工程「保存中文名称」吗？\n此操作会永久删除工程目录及其全部数据，且不可恢复。', 'プロジェクト「保存中文名称」を削除しますか？'],
  ['历史校准应用失败：SDK error\n\n请重新校准后再开始录制。', '再キャリブレーション'],
  ['录制已开始，但历史校准激活失败：SDK error。\n请停止本次录制并重新校准后再录制。', '今回の録画を停止'],
];
for (const [input, expected] of notices) {
  assert.ok(tr(input, 'ja-JP').includes(expected));
  assert.equal(tr(input, 'zh-CN'), input);
  if (input.includes('SDK error')) {
    const localizedReason = tr(input.replace('SDK error', '未知错误'), 'ja-JP');
    assert.ok(!localizedReason.includes('未知错误'));
  }
}
assert.equal(tr('保存\n取消', 'ja-JP'), '保存\nキャンセル');
assert.equal(tr(' \n\n ', 'ja-JP'), ' \n\n ');
assert.equal(tr('保存', 'en-US'), 'Save');
assert.equal(tr('保存', 'zh-CN'), '保存');

const compare = {
  id: 'compare-test', createdAt: '2026-11-03T00:00:00Z',
  config: { recordIds: ['r1', 'r2'], groupBy: 'subject', createdAt: '2026-11-03T00:00:00Z' },
  records: [
    { recordId: 'r1', recordName: '取消<保留>', subjectName: '受试者原名', groupKey: '中文组', metrics: { validityPercent: 50, fixationCount: 10 } },
    { recordId: 'r2', recordName: '保存', subjectName: '受试者二', groupKey: '中文组', metrics: { validityPercent: 95, fixationCount: 20 } },
  ],
  groups: [{ groupKey: '中文组', recordCount: 2, metrics: {} }],
  metrics: [{ key: 'fixationCount', label: '全记录注视次数', unit: '次', mean: 15, median: 15, min: 10, max: 20, span: 10, topRecordId: 'r2', bottomRecordId: 'r1', anomalyRecordIds: ['r1'], ranking: [] }],
  aoi: [], notes: ['当前仅选择了 1 条记录，建议至少选择 2 条记录以形成有效对比。', '已应用刺激物筛选：取消<保留>'],
};
const before = JSON.stringify(compare);
for (const tone of ['enterprise', 'academic', 'consulting']) {
  const report = buildInsightReport({ compareResult: compare, tone, outputLanguage: 'ja-JP' });
  assert.equal(report.outputLanguage, 'ja-JP');
  assert.ok(report.title.includes('インサイトレポート'));
  assert.ok(!/。\s*に/u.test(report.executiveSummary.join('')));
  assert.equal(report.keyFindings[0].evidence[0], '最大値の記録：保存');
  assert.equal(report.keyFindings[0].evidence[1], '最小値の記録：取消<保留>');
  assert.ok(report.keyFindings[0].summary.includes('回'));
  const html = renderInsightReportHtml(report, compare);
  assert.ok(html.includes('<html lang="ja-JP">'));
  assert.ok(html.includes('取消&lt;保留&gt;'));
  for (const zh of ['执行摘要', '关键差异', '差异范围', '建议动作', '核心指标概览', '当前数据', '管理建议', '研究建议', '行动建议', '跨记录差异']) {
    assert.ok(!html.includes(zh), `Untranslated ${zh} in ${tone}`);
  }
  assert.equal(JSON.stringify(compare), before);
  const legacy = buildInsightReport({ compareResult: compare, tone, outputLanguage: 'en-US' });
  delete legacy.outputLanguage;
  assert.ok(renderInsightReportHtml(legacy, compare).includes('<html lang="en-US">'));
  const zh = buildInsightReport({ compareResult: compare, tone });
  assert.ok(renderInsightReportHtml(zh, compare).includes('<html lang="zh-CN">'));
}
assert.ok(buildCompareCsv(compare).startsWith('record_id,record_name,subject_name,group_key,fixationCount'));
assert.ok(buildCompareCsv(compare).includes('取消<保留>,受试者原名,中文组'));
const missing = [];
const originalWarn = console.warn;
console.warn = (...args) => missing.push(args.join(' '));
try {
  for (const metric of COMPARE_METRIC_DEFS) {
    for (const tone of ['enterprise', 'academic', 'consulting']) {
      const fixture = { ...compare, metrics: [{ ...compare.metrics[0], ...metric }], aoi: [{ name: 'AOI原名' }] };
      renderInsightReportHtml(buildInsightReport({ compareResult: fixture, tone, outputLanguage: 'ja-JP' }), fixture);
    }
  }
  const empty = { ...compare, records: [], groups: [], metrics: [], aoi: [], notes: [] };
  for (const tone of ['enterprise', 'academic', 'consulting']) {
    renderInsightReportHtml(buildInsightReport({ compareResult: empty, tone, outputLanguage: 'ja-JP' }), empty);
  }
} finally { console.warn = originalWarn; }
assert.deepEqual(missing, [], 'Every built-in metric and report tone must translate without missing terms');
console.log('Japanese notices, report generation/export, legacy languages and user-data preservation passed.');
