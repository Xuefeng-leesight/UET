import type {
  CompareMetricSummary,
  CompareResult,
  InsightCard,
  InsightReport,
  InsightStyleVariant,
  InsightTone,
} from '@shared/contracts/domain/reporting';
import { formatMetricValue } from '@/features/analysis/reports/compareEngine';
import { normalizeInsightStyleVariant } from '@/features/analysis/reports/styleVariants';

type OutputLanguage = 'zh-CN' | 'en-US';

const nowIso = (): string => new Date().toISOString();

const createInsightId = (): string => `ins_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const cardId = (): string => `card_${Math.random().toString(36).slice(2, 8)}`;

const normalizeOutputLanguage = (value?: string): OutputLanguage => (value === 'en-US' ? 'en-US' : 'zh-CN');

const isEnglishOutput = (language: OutputLanguage): boolean => language === 'en-US';

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

const metricDisplayLabel = (metric: CompareMetricSummary, language: OutputLanguage): string => {
  if (!isEnglishOutput(language)) return metric.label;
  return METRIC_LABEL_EN_BY_KEY[metric.key] || metric.label;
};

const metricDisplayUnit = (metric: CompareMetricSummary, language: OutputLanguage): string => {
  if (!isEnglishOutput(language)) return metric.unit;
  return unitToEnglish(metric.unit);
};

const tonePrefix = (tone: InsightTone, language: OutputLanguage): string => {
  if (isEnglishOutput(language)) {
    if (tone === 'academic') return 'Research Findings';
    if (tone === 'consulting') return 'Business Insights';
    return 'Management Summary';
  }
  if (tone === 'academic') return '研究结论';
  if (tone === 'consulting') return '业务洞察';
  return '管理摘要';
};

const toneLead = (tone: InsightTone, language: OutputLanguage): string => {
  if (isEnglishOutput(language)) {
    if (tone === 'academic') return 'Findings show';
    if (tone === 'consulting') return 'Performance suggests';
    return 'From a management perspective';
  }
  if (tone === 'academic') return '统计结果表明';
  if (tone === 'consulting') return '业务表现显示';
  return '管理视角下';
};

const toneRecommendationLead = (tone: InsightTone, language: OutputLanguage): string => {
  if (isEnglishOutput(language)) {
    if (tone === 'academic') return 'Research Suggestions';
    if (tone === 'consulting') return 'Action Suggestions';
    return 'Management Suggestions';
  }
  if (tone === 'academic') return '研究建议';
  if (tone === 'consulting') return '行动建议';
  return '管理建议';
};

const mapRecordName = (result: CompareResult, recordId: string): string => {
  const hit = result.records.find((item) => item.recordId === recordId);
  if (!hit) return recordId;
  return hit.recordName;
};

const metricSummaryText = (metric: CompareMetricSummary, language: OutputLanguage): string => {
  const metricLabel = metricDisplayLabel(metric, language);
  const metricUnit = metricDisplayUnit(metric, language);
  const span = formatMetricValue(metric.span, metricUnit);
  const avg = formatMetricValue(metric.mean, metricUnit);
  if (isEnglishOutput(language)) {
    return `${metricLabel} cross-record span is ${span}${metricUnit ? ` ${metricUnit}` : ''}, overall average is ${avg}${
      metricUnit ? ` ${metricUnit}` : ''
    }`;
  }
  return `${metricLabel}跨记录差异为 ${span}${metricUnit ? ` ${metricUnit}` : ''}，整体均值 ${avg}${metricUnit ? ` ${metricUnit}` : ''}`;
};

const buildPrimaryFindings = (result: CompareResult, language: OutputLanguage): InsightCard[] => {
  const bySpan = result.metrics
    .filter((metric) => typeof metric.span === 'number' && Number.isFinite(metric.span) && (metric.span || 0) > 0)
    .sort((a, b) => (b.span || 0) - (a.span || 0))
    .slice(0, 3);

  return bySpan.map((metric, idx) => {
    const useEnglish = isEnglishOutput(language);
    const metricLabel = metricDisplayLabel(metric, language);
    const metricUnit = metricDisplayUnit(metric, language);
    const top = metric.topRecordId ? mapRecordName(result, metric.topRecordId) : '-';
    const bottom = metric.bottomRecordId ? mapRecordName(result, metric.bottomRecordId) : '-';
    return {
      id: cardId(),
      title: useEnglish ? `Key difference ${idx + 1}: ${metricLabel}` : `关键差异 ${idx + 1}：${metricLabel}`,
      severity: idx === 0 ? 'warn' : 'info',
      summary: metricSummaryText(metric, language),
      evidence: useEnglish
        ? [
            `Top record: ${top}`,
            `Bottom record: ${bottom}`,
            `Median: ${formatMetricValue(metric.median, metricUnit)}`,
          ]
        : [`最高记录：${top}`, `最低记录：${bottom}`, `中位数：${formatMetricValue(metric.median, metricUnit)}`],
      recommendation:
        metric.key === 'validityPercent'
          ? useEnglish
            ? 'Prioritize checking device stability and participant state for low-validity records.'
            : '建议优先排查低有效率记录的设备稳定性与受试状态。'
          : metric.key === 'aoiTotalDurationMs'
            ? useEnglish
              ? 'Review stimulus content alongside AOI layout to locate attention-allocation differences.'
              : '建议结合 AOI 布局复核刺激物内容，定位注意力分配差异来源。'
            : useEnglish
              ? 'Include this metric as a key checkpoint in the next experiment cycle.'
              : '建议将该指标纳入下一轮实验的重点复核项。',
    } satisfies InsightCard;
  });
};

const buildRiskCards = (result: CompareResult, language: OutputLanguage): InsightCard[] => {
  const useEnglish = isEnglishOutput(language);
  const cards: InsightCard[] = [];

  const anomalyMetrics = result.metrics.filter((metric) => metric.anomalyRecordIds.length > 0);
  for (const metric of anomalyMetrics.slice(0, 3)) {
    const metricLabel = metricDisplayLabel(metric, language);
    const metricUnit = metricDisplayUnit(metric, language);
    const names = metric.anomalyRecordIds.map((id) => mapRecordName(result, id));
    cards.push({
      id: cardId(),
      title: useEnglish ? `Anomaly: ${metricLabel}` : `异常波动：${metricLabel}`,
      severity: 'risk',
      summary: useEnglish
        ? `${metricLabel} shows clear anomalous records, which may affect conclusion stability.`
        : `${metricLabel}存在明显异常波动记录，可能影响结论稳定性。`,
      evidence: useEnglish
        ? [`Error record: ${names.join(', ')}`, `Span: ${formatMetricValue(metric.span, metricUnit)} ${metricUnit}`]
        : [`异常记录：${names.join('、')}`, `差异范围：${formatMetricValue(metric.span, metricUnit)} ${metricUnit}`],
      recommendation: useEnglish
        ? 'Prioritize reviewing original timeline and marker events of anomalous records to confirm interference.'
        : '建议优先复查异常记录的原始时间轴和标记事件，确认是否受干扰。',
    });
  }

  if (result.records.some((item) => (item.metrics.validityPercent || 0) > 0 && (item.metrics.validityPercent || 0) < 60)) {
    cards.push({
      id: cardId(),
      title: useEnglish ? 'Data quality risk: low validity' : '数据质量风险：有效率偏低',
      severity: 'risk',
      summary: useEnglish
        ? 'Some records have validity below 60%, which may bias AOI metrics.'
        : '部分记录有效率低于 60%，可能导致 AOI 指标偏差。',
      evidence: result.records
        .filter((item) => (item.metrics.validityPercent || 0) > 0 && (item.metrics.validityPercent || 0) < 60)
        .map((item) =>
          useEnglish
            ? `${item.recordName}: ${formatMetricValue(item.metrics.validityPercent, '%')}%`
            : `${item.recordName}：${formatMetricValue(item.metrics.validityPercent, '%')}%`,
        ),
      recommendation: useEnglish
        ? 'Consider re-recording key samples or clearly annotating low-quality data limitations in the report.'
        : '建议补录关键样本或在报告中标注低质量数据限制。',
    });
  }

  return cards;
};

export function buildInsightReport(params: {
  compareResult: CompareResult;
  tone: InsightTone;
  styleVariant?: InsightStyleVariant;
  outputLanguage?: OutputLanguage;
}): InsightReport {
  const { compareResult, tone } = params;
  const outputLanguage = normalizeOutputLanguage(params.outputLanguage);
  const useEnglish = isEnglishOutput(outputLanguage);
  const styleVariant = normalizeInsightStyleVariant(params.styleVariant);
  const keyFindings = buildPrimaryFindings(compareResult, outputLanguage);
  const risks = buildRiskCards(compareResult, outputLanguage);

  const recommendations: string[] = [];
  if (keyFindings.length > 0) {
    recommendations.push(
      tone === 'academic'
        ? useEnglish
          ? 'Prioritize repeat tests and sample verification on the top 1-2 difference metrics to avoid key effects being masked by averages.'
          : '优先围绕差异最大的 1-2 个指标做重复试验与样本复核，避免均值掩盖关键效应。'
        : tone === 'consulting'
          ? useEnglish
            ? 'Focus first on the top 1-2 difference metrics, define executable optimization actions, and set next-round acceptance criteria.'
            : '优先聚焦差异最大的 1-2 个指标，形成可执行优化动作并设置下一轮验收标准。'
          : useEnglish
            ? 'Prioritize a dedicated review around the top 1-2 difference metrics to avoid key issues being masked by averages.'
            : '优先围绕差异最大的 1-2 个指标做专项复盘，避免平均值掩盖关键问题。',
    );
  }
  if (compareResult.aoi.length > 0) {
    recommendations.push(
      tone === 'academic'
        ? useEnglish
          ? 'Run comparative analysis between high-dwell and low-dwell AOIs, and add stimulus information-hierarchy explanation in the methodology.'
          : '针对高停留 AOI 与低停留 AOI 做对照分析，并在方法部分补充刺激物信息层级解释。'
        : tone === 'consulting'
          ? useEnglish
            ? 'Use high-dwell vs low-dwell AOIs to prioritize page/asset redesign and directly map to business conversion metrics.'
            : '围绕高停留 AOI 与低停留 AOI 输出页面/素材改版优先级，直接连接业务转化指标。'
          : useEnglish
            ? 'Compare high-dwell and low-dwell AOIs to optimize stimulus information hierarchy.'
            : '针对高停留 AOI 与低停留 AOI 做对照分析，优化刺激物信息层级。',
    );
  }
  if (risks.length > 0) {
    recommendations.push(
      tone === 'academic'
        ? useEnglish
          ? 'Address risk items and annotate data limitations before publishing interim research conclusions.'
          : '建议先处理风险项并标注数据限制，再发布阶段性研究结论。'
        : tone === 'consulting'
          ? useEnglish
            ? 'Mitigate risk items first, then deliver client conclusions externally to reduce strategy misjudgment and communication cost.'
            : '建议先消减风险项，再对外提交客户结论，降低策略误判与沟通成本。'
          : useEnglish
            ? 'Handle risk items first, then publish business conclusions to reduce misjudgment probability.'
            : '先处理风险项，再推进业务结论发布，减少误判概率。',
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      tone === 'academic'
        ? useEnglish
          ? 'Data distribution is stable; you can proceed to paper/project reporting.'
          : '当前数据分布稳定，可进入论文/课题汇报阶段。'
        : tone === 'consulting'
          ? useEnglish
            ? 'Data distribution is stable; you can proceed to client reporting and strategy rollout.'
            : '当前数据分布稳定，可直接进入客户汇报与策略落地阶段。'
          : useEnglish
            ? 'Data distribution is stable; you can proceed to management reporting.'
            : '当前数据分布稳定，可直接进入管理汇报阶段。',
    );
  }

  const recommendationLead = toneRecommendationLead(tone, outputLanguage);
  const normalizedRecommendations = recommendations.map((item) =>
    useEnglish ? `${recommendationLead}: ${item}` : `${recommendationLead}：${item}`,
  );

  const topFocusMetric =
    keyFindings[0]?.title.replace(useEnglish ? /^Key difference\s*\d+\s*:\s*/i : /^关键差异\s*\d+：/, '') ||
    (useEnglish ? 'core behavioral metrics' : '核心行为指标');

  const executiveSummary = [
    useEnglish
      ? `${tonePrefix(tone, outputLanguage)}: This comparison covers ${compareResult.records.length} records and ${compareResult.groups.length} groups.`
      : `${tonePrefix(tone, outputLanguage)}：本次比较覆盖 ${compareResult.records.length} 条记录、${compareResult.groups.length} 个分组。`,
    useEnglish
      ? `${toneLead(tone, outputLanguage)}, the most significant differences concentrate in ${topFocusMetric}.`
      : `${toneLead(tone, outputLanguage)}，最显著差异集中在 ${topFocusMetric}。`,
    risks.length > 0
      ? useEnglish
        ? `Identified ${risks.length} risks. Review risks before publishing final conclusions.`
        : `共识别 ${risks.length} 项风险，建议先完成风险复核后再发布正式结论。`
      : tone === 'academic'
        ? useEnglish
          ? 'No major risks found; results can be used for research discussion and interim reporting.'
          : '未发现明显风险项，当前结果可用于研究讨论与阶段汇报。'
        : tone === 'consulting'
          ? useEnglish
            ? 'No major risks found; results can be used for client communication and strategy recommendations.'
            : '未发现明显风险项，可直接用于客户沟通与策略建议。'
          : useEnglish
            ? 'No major risks found; results can be used for business communication.'
            : '未发现明显风险项，可直接用于业务沟通。',
  ];

  return {
    id: createInsightId(),
    createdAt: nowIso(),
    compareResultId: compareResult.id,
    tone,
    styleVariant,
    title: useEnglish
      ? `${tonePrefix(tone, outputLanguage)} - Multi-record Comparison Insight Report`
      : `${tonePrefix(tone, outputLanguage)} - 多记录对比洞察报告`,
    executiveSummary,
    keyFindings,
    risks,
    recommendations: normalizedRecommendations,
    appendix: {
      recordCount: compareResult.records.length,
      groupBy: compareResult.config.groupBy,
      metricCount: compareResult.metrics.length,
      aoiCount: compareResult.aoi.length,
    },
  };
}
