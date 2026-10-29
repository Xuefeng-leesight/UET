import type { CompareResult, InsightReport } from '@shared/contracts/domain/reporting';
import { formatMetricValue } from '@/features/analysis/reports/compareEngine';
import { normalizeInsightStyleVariant } from '@/features/analysis/reports/styleVariants';

const reportStylePalettes = {
  ocean: {
    accent: '#0284c7',
    accentSoft: '#f0f9ff',
    accentBorder: '#bae6fd',
    accentText: '#0369a1',
    tableHead: '#f0f9ff',
  },
  forest: {
    accent: '#059669',
    accentSoft: '#ecfdf5',
    accentBorder: '#a7f3d0',
    accentText: '#047857',
    tableHead: '#ecfdf5',
  },
  amber: {
    accent: '#d97706',
    accentSoft: '#fffbeb',
    accentBorder: '#fde68a',
    accentText: '#b45309',
    tableHead: '#fffbeb',
  },
} as const;

const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const METRIC_LABEL_EN_BY_KEY: Record<string, string> = {
  durationSeconds: 'Duration',
  samplingRateHz: 'Sampling Rate',
  validityPercent: 'Validity',
  fixationCount: 'Record Fixation Count',
  totalFixationDurationMs: 'Record Total Fixation Duration',
  avgFixationDurationMs: 'Record Average Fixation Duration',
  maxFixationDurationMs: 'Record Max Fixation Duration',
  saccadeCount: 'Record Saccade Count',
  avgSaccadeVelocity: 'Record Average Saccade Velocity',
  avgSaccadeAmplitude: 'Record Average Saccade Amplitude',
  avgPupilDiameter: 'Record Average Pupil Diameter',
  blinkCount: 'Complete Blink Onsets (per eye)',
  totalBlinkDurationMs: 'Blink Interval Overlap Duration (sum across eyes)',
  avgBlinkDurationMs: 'Mean Full Duration of Blink Onsets',
  aoiHitCount: 'AOI Hit Count',
  aoiTotalDurationMs: 'AOI Total Visit Duration',
};

const unitToEnglish = (unit: string): string => {
  if (!unit) return '';
  if (unit === '次') return 'times';
  if (unit === '个') return 'count';
  return unit;
};

const isEnglishReport = (report: InsightReport): boolean =>
  /Multi-record Comparison Insight Report|Management Summary|Business Insights|Research Findings/i.test(report.title);

export function renderInsightReportHtml(report: InsightReport, compare: CompareResult): string {
  const styleVariant = normalizeInsightStyleVariant(report.styleVariant);
  const palette = reportStylePalettes[styleVariant];
  const useEnglish = isEnglishReport(report);
  const text = {
    footer: report.aiAugmentation
      ? useEnglish
        ? 'This report contains rule-based insights and AI-enhanced conclusions. Please review them with the original data.'
        : '本报告包含规则模板洞察与 AI 增强结论，请结合原始数据进行专业复核。'
      : useEnglish
        ? 'This report is generated from rule-based templates and can be further reviewed and annotated in the system.'
        : '本报告为规则模板自动生成，可在系统内继续复核与补充说明。',
    recommendation: useEnglish ? 'Recommendation: ' : '建议：',
    generatedAt: useEnglish ? 'Generated at' : '生成时间',
    compareId: useEnglish ? 'Comparison ID' : '对比ID',
    executiveSummary: useEnglish ? 'Executive Summary' : '执行摘要',
    keyFindings: useEnglish ? 'Key Findings' : '关键发现',
    risks: useEnglish ? 'Risks' : '风险项',
    recommendations: useEnglish ? 'Recommendations' : '建议动作',
    aiConclusion: useEnglish ? 'AI Enhanced Conclusion' : 'AI 增强结论',
    model: useEnglish ? 'Model' : '模型',
    dataCompression: useEnglish ? 'Data Compression' : '数据压缩',
    points: useEnglish ? 'pts' : '点',
    aiSummary: useEnglish ? 'AI Executive Summary' : 'AI 执行摘要',
    aiFindings: useEnglish ? 'AI Key Findings' : 'AI 关键发现',
    aiRisks: useEnglish ? 'AI Risks' : 'AI 风险项',
    aiRecommendations: useEnglish ? 'AI Recommendations' : 'AI 建议动作',
    aiWarnings: useEnglish ? 'AI Notes' : 'AI 注意事项',
    noFindings: useEnglish ? 'No key findings' : '暂无关键发现',
    noRisks: useEnglish ? 'No risks' : '暂无风险项',
    noAiFindings: useEnglish ? 'No AI key findings' : '暂无 AI 关键发现',
    metricsOverview: useEnglish ? 'Core Metrics Overview' : '核心指标概览',
    statisticalNotes: useEnglish ? 'Statistical Scope and Limitations' : '统计口径与限制',
    metric: useEnglish ? 'Metric' : '指标',
    mean: useEnglish ? 'Average' : '均值',
    median: useEnglish ? 'Median' : '中位数',
    span: useEnglish ? 'Span' : '差异范围',
  };
  const findingHtml = report.keyFindings
    .map(
      (card) => `
      <section class="card ${esc(card.severity)}">
        <h3>${esc(card.title)}</h3>
        <p>${esc(card.summary)}</p>
        <ul>${card.evidence.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
        <p><strong>${esc(text.recommendation)}</strong>${esc(card.recommendation)}</p>
      </section>
    `,
    )
    .join('');

  const riskHtml = report.risks
    .map(
      (card) => `
      <section class="card risk">
        <h3>${esc(card.title)}</h3>
        <p>${esc(card.summary)}</p>
        <ul>${card.evidence.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
        <p><strong>${esc(text.recommendation)}</strong>${esc(card.recommendation)}</p>
      </section>
    `,
    )
    .join('');

  const aiSummaryHtml = report.aiAugmentation
    ? report.aiAugmentation.result.summary.map((item) => `<li>${esc(item)}</li>`).join('')
    : '';
  const aiRecommendationHtml = report.aiAugmentation
    ? report.aiAugmentation.result.recommendations.map((item) => `<li>${esc(item)}</li>`).join('')
    : '';
  const aiFindingHtml = report.aiAugmentation
    ? report.aiAugmentation.result.keyFindings
      .map(
        (item) => `
        <section class="card">
          <h3>${esc(item.title)}</h3>
          <p>${esc(item.summary)}</p>
          <ul>${item.evidence.map((evidence) => `<li>${esc(evidence)}</li>`).join('')}</ul>
          <p><strong>${esc(text.recommendation)}</strong>${esc(item.recommendation)}</p>
        </section>
      `,
      )
      .join('')
    : '';
  const aiRiskHtml = report.aiAugmentation
    ? report.aiAugmentation.result.risks
      .map((item) => `<li>${esc(item.title)}${useEnglish ? ': ' : '：'}${esc(item.summary)}</li>`)
      .join('')
    : '';
  const aiWarningHtml = report.aiAugmentation
    ? report.aiAugmentation.result.warnings.map((item) => `<li>${esc(item)}</li>`).join('')
    : '';

  const metricRows = compare.metrics
    .filter((metric, index) => index < 10 || ['blinkCount', 'totalBlinkDurationMs', 'avgBlinkDurationMs'].includes(metric.key))
    .map(
      (metric) => `
      <tr>
        <td>${esc(useEnglish ? (METRIC_LABEL_EN_BY_KEY[metric.key] || metric.label) : metric.label)}</td>
        <td>${esc(formatMetricValue(metric.mean, useEnglish ? unitToEnglish(metric.unit) : metric.unit))}</td>
        <td>${esc(formatMetricValue(metric.median, useEnglish ? unitToEnglish(metric.unit) : metric.unit))}</td>
        <td>${esc(formatMetricValue(metric.span, useEnglish ? unitToEnglish(metric.unit) : metric.unit))}</td>
      </tr>
    `,
    )
    .join('');

  return `<!doctype html>
<html lang="${useEnglish ? 'en-US' : 'zh-CN'}">
<head>
  <meta charset="UTF-8" />
  <title>${esc(report.title)}</title>
  <style>
    :root {
      --accent: ${palette.accent};
      --accent-soft: ${palette.accentSoft};
      --accent-border: ${palette.accentBorder};
      --accent-text: ${palette.accentText};
      --table-head: ${palette.tableHead};
    }
    body { font-family: ${useEnglish ? `'Inter', 'Arial', sans-serif` : `'PingFang SC', 'Microsoft YaHei', sans-serif`}; margin: 24px; color: #0f172a; }
    h1 { font-size: 24px; margin: 0 0 8px; }
    h1::after { content: ''; display: block; width: 88px; height: 4px; border-radius: 999px; background: var(--accent); margin-top: 10px; }
    h2 { font-size: 18px; margin-top: 28px; }
    h3 { font-size: 15px; margin: 0 0 8px; }
    .meta { color: #475569; font-size: 12px; margin-bottom: 16px; }
    .summary { background: var(--accent-soft); border: 1px solid var(--accent-border); border-radius: 10px; padding: 12px 14px; }
    .summary li { margin: 4px 0; }
    .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .card { border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px; background: #fff; }
    .card.info { border-color: var(--accent-border); background: var(--accent-soft); }
    .card.warn { border-color: #f59e0b; }
    .card.risk { border-color: #ef4444; }
    .card.good { border-color: #10b981; }
    .card ul { margin: 8px 0; padding-left: 18px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { border: 1px solid #e2e8f0; padding: 8px; font-size: 12px; text-align: left; }
    th { background: var(--table-head); color: var(--accent-text); }
    .list li { margin: 6px 0; }
    .footer { margin-top: 28px; color: #64748b; font-size: 12px; border-top: 1px solid var(--accent-border); padding-top: 10px; }
  </style>
</head>
<body>
  <h1>${esc(report.title)}</h1>
  <div class="meta">${esc(text.generatedAt)}: ${esc(new Date(report.createdAt).toLocaleString(useEnglish ? 'en-US' : 'zh-CN'))} | ${esc(text.compareId)}: ${esc(report.compareResultId)}</div>

  <h2>${esc(text.executiveSummary)}</h2>
  <div class="summary">
    <ul>${report.executiveSummary.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
  </div>

  <h2>${esc(text.keyFindings)}</h2>
  <div class="cards">${findingHtml || `<p>${esc(text.noFindings)}</p>`}</div>

  <h2>${esc(text.risks)}</h2>
  <div class="cards">${riskHtml || `<p>${esc(text.noRisks)}</p>`}</div>

  <h2>${esc(text.recommendations)}</h2>
  <ul class="list">${report.recommendations.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>

  ${report.aiAugmentation
    ? `
  <h2>${esc(text.aiConclusion)}</h2>
  <div class="meta">${esc(text.model)}: ${esc(report.aiAugmentation.provider)} / ${esc(report.aiAugmentation.model)} | ${esc(text.dataCompression)}: ${esc(report.aiAugmentation.compression.retainedPointCount)} / ${esc(report.aiAugmentation.compression.inputPointCount)} ${esc(text.points)}</div>
  <h3>${esc(text.aiSummary)}</h3>
  <ul class="list">${aiSummaryHtml}</ul>
  <h3>${esc(text.aiFindings)}</h3>
  <div class="cards">${aiFindingHtml || `<p>${esc(text.noAiFindings)}</p>`}</div>
  ${aiRiskHtml ? `<h3>${esc(text.aiRisks)}</h3><ul class="list">${aiRiskHtml}</ul>` : ''}
  <h3>${esc(text.aiRecommendations)}</h3>
  <ul class="list">${aiRecommendationHtml}</ul>
  ${aiWarningHtml ? `<h3>${esc(text.aiWarnings)}</h3><ul class="list">${aiWarningHtml}</ul>` : ''}
  `
    : ''}

  <h2>${esc(text.metricsOverview)}</h2>
  <table>
    <thead>
      <tr>
        <th>${esc(text.metric)}</th>
        <th>${esc(text.mean)}</th>
        <th>${esc(text.median)}</th>
        <th>${esc(text.span)}</th>
      </tr>
    </thead>
    <tbody>
      ${metricRows}
    </tbody>
  </table>

  ${compare.notes?.length ? `<h2>${esc(text.statisticalNotes)}</h2><ul class="list">${compare.notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul>` : ''}

  <div class="footer">${esc(text.footer)}</div>
</body>
</html>`;
}

function csvEscape(value: unknown): string {
  const formatted = formatCsvDecimal(value);
  const text = formatted === null || formatted === undefined ? '' : String(formatted);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatCsvDecimal(value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return value;
    const text = value.toFixed(3).replace(/\.?0+$/, '');
    return text === '-0' || text === '' ? '0' : text;
  }
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || (!text.includes('.') && !/[eE]/.test(text))) return value;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return value;
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return value;
  const fixed = numeric.toFixed(3).replace(/\.?0+$/, '');
  return fixed === '-0' || fixed === '' ? '0' : fixed;
}

export function buildCompareCsv(compare: CompareResult): string {
  const headers = ['record_id', 'record_name', 'subject_name', 'group_key'];
  const metricHeaders = compare.metrics.map((metric) => metric.key);
  const allHeaders = [...headers, ...metricHeaders];

  const lines: string[] = [allHeaders.map(csvEscape).join(',')];

  for (const record of compare.records) {
    const row = [
      record.recordId,
      record.recordName,
      record.subjectName,
      record.groupKey,
      ...metricHeaders.map((key) => record.metrics[key as keyof typeof record.metrics] ?? ''),
    ];
    lines.push(row.map(csvEscape).join(','));
  }

  return lines.join('\n');
}
