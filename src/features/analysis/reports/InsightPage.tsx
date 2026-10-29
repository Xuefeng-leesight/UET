import React from 'react';
import type { CompareResult, InsightReport, InsightSeverity, InsightStyleVariant } from '@shared/contracts/domain/reporting';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import { buildInsightReport } from '@/features/analysis/reports/insightEngine';
import { buildCompareCsv, renderInsightReportHtml } from '@/features/analysis/reports/reportRenderer';
import { useLanguage } from '@/app/i18n/useLanguage';
import {
  useSystemInsightStyleVariant,
} from '@/features/analysis/reports/styleVariants';

interface InsightPageProps {
  projectDir: string;
  report: InsightReport | null;
  compareResult: CompareResult | null;
  onNotify?: (message: string) => void;
}

const styleClassMap: Record<
  InsightStyleVariant,
  {
    headerCard: string;
    saveButton: string;
    exportButton: string;
    summaryCard: string;
    findingCard: string;
    recommendationCard: string;
    aiCard: string;
    aiFindingCard: string;
  }
> = {
  ocean: {
    headerCard: 'border-slate-200 bg-white',
    saveButton: 'border-sky-200 text-sky-600 hover:bg-sky-50',
    exportButton: 'border-sky-200 bg-sky-50 text-sky-600 hover:bg-sky-50',
    summaryCard: 'border-slate-200 bg-white',
    findingCard: 'border-slate-200 bg-white',
    recommendationCard: 'border-slate-200 bg-white',
    aiCard: 'border-sky-200 bg-sky-50',
    aiFindingCard: 'border-slate-200 bg-white',
  },
  forest: {
    headerCard: 'border-slate-200 bg-white',
    saveButton: 'border-sky-200 text-sky-600 hover:bg-sky-50',
    exportButton: 'border-sky-200 bg-sky-50 text-sky-600 hover:bg-sky-50',
    summaryCard: 'border-slate-200 bg-white',
    findingCard: 'border-slate-200 bg-white',
    recommendationCard: 'border-slate-200 bg-white',
    aiCard: 'border-sky-200 bg-sky-50',
    aiFindingCard: 'border-slate-200 bg-white',
  },
  amber: {
    headerCard: 'border-slate-200 bg-white',
    saveButton: 'border-sky-200 text-sky-600 hover:bg-sky-50',
    exportButton: 'border-sky-200 bg-sky-50 text-sky-600 hover:bg-sky-50',
    summaryCard: 'border-slate-200 bg-white',
    findingCard: 'border-slate-200 bg-white',
    recommendationCard: 'border-slate-200 bg-white',
    aiCard: 'border-sky-200 bg-sky-50',
    aiFindingCard: 'border-slate-200 bg-white',
  },
};

const badgeClassMapByStyle: Record<InsightStyleVariant, Record<InsightSeverity, string>> = {
  ocean: {
    info: 'bg-sky-100 text-sky-700 border-sky-200',
    good: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    warn: 'bg-amber-100 text-amber-700 border-amber-200',
    risk: 'bg-rose-100 text-rose-700 border-rose-200',
  },
  forest: {
    info: 'bg-sky-100 text-sky-700 border-sky-200',
    good: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    warn: 'bg-amber-100 text-amber-700 border-amber-200',
    risk: 'bg-rose-100 text-rose-700 border-rose-200',
  },
  amber: {
    info: 'bg-sky-100 text-sky-700 border-sky-200',
    good: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    warn: 'bg-amber-100 text-amber-700 border-amber-200',
    risk: 'bg-rose-100 text-rose-700 border-rose-200',
  },
};

const InsightPage: React.FC<InsightPageProps> = ({ projectDir, report, compareResult, onNotify }) => {
  const { language } = useLanguage();
  const [saving, setSaving] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const styleVariant = useSystemInsightStyleVariant();
  const isEn = language === 'en-US';

  const displayReport = React.useMemo<InsightReport | null>(() => {
    if (!report || !compareResult) return null;
    const rebuilt = buildInsightReport({
      compareResult,
      tone: report.tone,
      styleVariant,
      outputLanguage: language,
    });
    return {
      ...rebuilt,
      id: report.id,
      createdAt: report.createdAt,
      compareResultId: report.compareResultId,
      aiAugmentation: report.aiAugmentation,
    };
  }, [compareResult, language, report, styleVariant]);

  const text = React.useMemo(() => ({
    ipcSaveUnavailable: isEn ? 'IPC unavailable, cannot save report' : 'IPC 不可用，无法保存报告',
    saveSuccess: isEn ? 'Insight report saved' : '洞察报告已保存',
    saveFailed: isEn ? 'Save failed' : '洞察报告保存失败',
    saveError: isEn ? 'Save error' : '洞察报告保存异常',
    ipcExportUnavailable: isEn ? 'IPC unavailable, cannot export report package' : 'IPC 不可用，无法导出报告包',
    exportSuccess: isEn ? 'Export succeeded' : '导出成功',
    exportFailed: isEn ? 'Export failed' : '导出失败',
    exportError: isEn ? 'Export error' : '导出异常',
    unknownError: isEn ? 'Unknown error' : '未知错误',
    empty: isEn ? 'No insight report yet. Generate one in Reports under "Multi-record Comparison".' : '暂无洞察报告。请先在统计报表页的“多记录对比”模式生成洞察报告。',
    pageTag: isEn ? 'Insights' : '洞察报告',
    generatedAt: isEn ? 'Generated at' : '生成时间',
    linkedCompare: isEn ? 'Linked comparison' : '关联对比',
    save: isEn ? 'Save report' : '保存报告',
    saving: isEn ? 'Saving...' : '保存中...',
    export: isEn ? 'Export report package' : '导出报告包',
    exporting: isEn ? 'Exporting...' : '导出中...',
    executiveSummary: isEn ? 'Executive summary' : '执行摘要',
    keyFindings: isEn ? 'Key findings' : '关键发现',
    risks: isEn ? 'Risks' : '风险项',
    recommendations: isEn ? 'Recommendations' : '建议动作',
    recommendation: isEn ? 'Recommendation: ' : '建议：',
    noFindings: isEn ? 'No key findings' : '暂无关键发现',
    noRisks: isEn ? 'No risks' : '暂无风险项',
    aiConclusion: isEn ? 'AI enhanced conclusion' : 'AI 增强结论',
    dataCompression: isEn ? 'Data compression' : '数据压缩',
    points: isEn ? 'pts' : '点',
    aiSummary: isEn ? 'AI executive summary' : 'AI 执行摘要',
    aiRecommendations: isEn ? 'AI recommendations' : 'AI 建议动作',
    aiWarnings: isEn ? 'AI notes' : 'AI 注意事项',
    aiFindings: isEn ? 'AI key findings' : 'AI 关键发现',
    aiRisks: isEn ? 'AI risks' : 'AI 风险项',
  }), [isEn]);

  const isReady = Boolean(displayReport && compareResult);
  const styleClasses = styleClassMap[styleVariant];
  const badgeClassMap = badgeClassMapByStyle[styleVariant];

  const notify = (message: string) => {
    if (onNotify) onNotify(message);
  };

  const handleSave = async () => {
    if (!displayReport || !projectDir) return;
    if (!ipcClient.isAvailable()) {
      notify(text.ipcSaveUnavailable);
      return;
    }

    setSaving(true);
    try {
      const reportToSave: InsightReport = { ...displayReport, styleVariant };
      const res = await ipcClient.saveInsightReport({ projectDir, report: reportToSave });
      if (res.ok) {
        notify(text.saveSuccess);
      } else {
        const msg = 'message' in res ? res.message : undefined;
        notify(`${text.saveFailed}${isEn ? ': ' : '：'}${msg || text.unknownError}`);
      }
    } catch (error: unknown) {
      notify(`${text.saveError}${isEn ? ': ' : '：'}${error instanceof Error ? error.message : text.unknownError}`);
    } finally {
      setSaving(false);
    }
  };

  const handleExportBundle = async () => {
    if (!displayReport || !compareResult || !projectDir) return;
    if (!ipcClient.isAvailable()) {
      notify(text.ipcExportUnavailable);
      return;
    }

    setExporting(true);
    try {
      const reportToExport: InsightReport = { ...displayReport, styleVariant };
      const html = renderInsightReportHtml(reportToExport, compareResult);
      const csv = buildCompareCsv(compareResult);
      const res = await ipcClient.exportInsightReportBundle({
        projectDir,
        report: reportToExport,
        compareResult,
        html,
        csv,
      });
      if (res.ok) {
        const artifactKinds = (res.artifacts || []).map((item) => item.kind.toUpperCase()).join(' / ');
        notify(`${text.exportSuccess}${isEn ? ': ' : '：'}${artifactKinds || 'HTML/CSV/PDF'}`);
      } else {
        const msg = 'message' in res ? res.message : text.unknownError;
        if (msg && msg.includes('已取消')) return;
        notify(`${text.exportFailed}${isEn ? ': ' : '：'}${msg || text.unknownError}`);
      }
    } catch (error: unknown) {
      notify(`${text.exportError}${isEn ? ': ' : '：'}${error instanceof Error ? error.message : text.unknownError}`);
    } finally {
      setExporting(false);
    }
  };

  if (!isReady) {
    return (
      <div className="h-full flex items-center justify-center rounded-2xl border border-slate-200 bg-white text-sm text-slate-500">
        {text.empty}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col gap-4 overflow-y-auto pr-1 pb-4" data-i18n-skip="true">
      <div className={`bg-white rounded-2xl border p-5 shadow-sm ${styleClasses.headerCard}`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] font-bold text-slate-400 tracking-widest">{text.pageTag}</div>
            <h2 className="mt-1 text-xl font-bold text-slate-800">{displayReport.title}</h2>
            <div className="mt-2 text-xs text-slate-500">
              {text.generatedAt}：{new Date(displayReport.createdAt).toLocaleString(language)} · {text.linkedCompare}：{displayReport.compareResultId}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className={`px-3 py-2 rounded-lg border text-xs font-bold disabled:opacity-50 ${styleClasses.saveButton}`}
            >
              {saving ? text.saving : text.save}
            </button>
            <button
              onClick={handleExportBundle}
              disabled={exporting}
              className={`px-3 py-2 rounded-lg border text-xs font-bold disabled:opacity-50 ${styleClasses.exportButton}`}
            >
              {exporting ? text.exporting : text.export}
            </button>
          </div>
        </div>
      </div>

      <div className={`bg-white rounded-2xl border p-4 shadow-sm ${styleClasses.summaryCard}`}>
        <div className="text-xs font-bold text-slate-500 tracking-widest mb-2">{text.executiveSummary}</div>
        <ul className="list-disc pl-5 space-y-2 text-sm text-slate-700">
          {displayReport.executiveSummary.map((item, idx) => (
            <li key={`summary-${idx}`}>{item}</li>
          ))}
        </ul>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className={`bg-white rounded-2xl border p-4 shadow-sm ${styleClasses.findingCard}`}>
          <div className="text-xs font-bold text-slate-500 tracking-widest mb-3">{text.keyFindings}</div>
          <div className="space-y-3">
            {displayReport.keyFindings.map((card) => (
              <div key={card.id} className={`rounded-xl border p-3 ${styleClasses.findingCard}`}>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="text-sm font-semibold text-slate-800">{card.title}</div>
                  <span
                    className={`px-2 py-0.5 rounded-full border text-[10px] font-bold ${
                      badgeClassMap[card.severity] || 'bg-slate-100 text-slate-600 border-slate-200'
                    }`}
                  >
                    {card.severity.toUpperCase()}
                  </span>
                </div>
                <p className="text-sm text-slate-600">{card.summary}</p>
                <ul className="mt-2 text-xs text-slate-500 list-disc pl-4 space-y-1">
                  {card.evidence.map((item, idx) => (
                    <li key={`${card.id}-e-${idx}`}>{item}</li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-slate-700">
                  <span className="font-semibold">{text.recommendation}</span>
                  {card.recommendation}
                </p>
              </div>
            ))}
            {displayReport.keyFindings.length === 0 ? <div className="text-sm text-slate-400">{text.noFindings}</div> : null}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
          <div className="text-xs font-bold text-slate-500 tracking-widest mb-3">{text.risks}</div>
          <div className="space-y-3">
            {displayReport.risks.map((card) => (
              <div key={card.id} className="rounded-xl border border-rose-500 bg-rose-50 p-3">
                <div className="text-sm font-bold text-rose-600">{card.title}</div>
                <p className="mt-1 text-sm text-rose-600">{card.summary}</p>
                <ul className="mt-2 text-xs text-rose-600 list-disc pl-4 space-y-1">
                  {card.evidence.map((item, idx) => (
                    <li key={`${card.id}-r-${idx}`}>{item}</li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-rose-600 font-semibold">
                  <span className="font-semibold">{text.recommendation}</span>
                  {card.recommendation}
                </p>
              </div>
            ))}
            {displayReport.risks.length === 0 ? <div className="text-sm text-slate-400">{text.noRisks}</div> : null}
          </div>
        </div>
      </div>

      <div className={`bg-white rounded-2xl border p-4 shadow-sm ${styleClasses.recommendationCard}`}>
        <div className="text-xs font-bold text-slate-500 tracking-widest mb-3">{text.recommendations}</div>
        <ol className="list-decimal pl-5 space-y-2 text-sm text-slate-700">
          {displayReport.recommendations.map((item, idx) => (
            <li key={`rec-${idx}`}>{item}</li>
          ))}
        </ol>
      </div>

      {displayReport.aiAugmentation ? (
        <div className={`bg-white rounded-2xl border p-4 shadow-sm ${styleClasses.aiCard}`}>
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <div className="text-xs font-bold text-slate-500 tracking-widest">{text.aiConclusion}</div>
              <div className="text-sm text-slate-700 mt-1">
                {displayReport.aiAugmentation.provider} · {displayReport.aiAugmentation.model}
              </div>
              <div className="text-[11px] text-slate-500 mt-1">
                {text.dataCompression}：{displayReport.aiAugmentation.compression.retainedPointCount} / {displayReport.aiAugmentation.compression.inputPointCount} {text.points}
              </div>
            </div>
            <div className="text-[11px] text-slate-400">
              {new Date(displayReport.aiAugmentation.createdAt).toLocaleString(language)}
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="space-y-3">
              <div>
                <div className="text-xs font-bold text-slate-500 mb-1">{text.aiSummary}</div>
                <ul className="list-disc pl-5 space-y-1 text-sm text-slate-700">
                  {displayReport.aiAugmentation.result.summary.map((item, idx) => (
                    <li key={`ai-summary-${idx}`}>{item}</li>
                  ))}
                </ul>
              </div>

              <div>
                <div className="text-xs font-bold text-slate-500 mb-1">{text.aiRecommendations}</div>
                <ol className="list-decimal pl-5 space-y-1 text-sm text-slate-700">
                  {displayReport.aiAugmentation.result.recommendations.map((item, idx) => (
                    <li key={`ai-rec-${idx}`}>{item}</li>
                  ))}
                </ol>
              </div>

              {displayReport.aiAugmentation.result.warnings.length > 0 ? (
                <div>
                  <div className="text-xs font-bold text-slate-500 mb-1">{text.aiWarnings}</div>
                  <ul className="list-disc pl-5 space-y-1 text-xs text-amber-700">
                    {displayReport.aiAugmentation.result.warnings.map((item, idx) => (
                      <li key={`ai-warning-${idx}`}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            <div className="space-y-3">
              <div>
                <div className="text-xs font-bold text-slate-500 mb-1">{text.aiFindings}</div>
                <div className="space-y-2">
                  {displayReport.aiAugmentation.result.keyFindings.map((card, idx) => (
                    <div key={`ai-finding-${idx}`} className={`rounded-lg border p-3 ${styleClasses.aiFindingCard}`}>
                      <div className="text-sm font-semibold text-slate-800">{card.title}</div>
                      <div className="text-xs text-slate-600 mt-1">{card.summary}</div>
                      <ul className="list-disc pl-4 mt-2 space-y-1 text-xs text-slate-500">
                        {card.evidence.map((item, evidenceIdx) => (
                          <li key={`ai-finding-evidence-${idx}-${evidenceIdx}`}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>

              {displayReport.aiAugmentation.result.risks.length > 0 ? (
                <div>
                  <div className="text-xs font-bold text-slate-500 mb-1">{text.aiRisks}</div>
                  <ul className="list-disc pl-5 space-y-1 text-xs text-rose-600">
                    {displayReport.aiAugmentation.result.risks.map((item, idx) => (
                      <li key={`ai-risk-${idx}`}>{item.title}{isEn ? ': ' : '：'}{item.summary}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default InsightPage;
