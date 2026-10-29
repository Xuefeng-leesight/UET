import { invokeSafe, invokeSafeNoPayload } from '@/infrastructure/electron/ipcCore';
import type { AiAnalysisMode, AiSettingsUpdate, CompareResult, InsightReport, SaveCompareResultResult, LoadCompareResultResult, SaveInsightReportResult, LoadInsightReportResult, ExportInsightReportBundleResult, LoadAiSettingsResult, SaveAiSettingsResult, TestAiConnectionResult, RunAiAnalysisResult, LoadSingleRecordAiReportResult } from '@/infrastructure/electron/ipcTypes';

export const reportsIpcClient = {
  saveCompareResult: async (payload: {
    projectDir: string;
    compareResult: CompareResult;
  }): Promise<SaveCompareResultResult> => {
    return invokeSafe<SaveCompareResultResult>('save-compare-result', payload, { ok: false });
  },

  loadCompareResult: async (payload: {
    projectDir: string;
    compareId?: string;
  }): Promise<LoadCompareResultResult> => {
    return invokeSafe<LoadCompareResultResult>('load-compare-result', payload, { ok: false, compareResult: null });
  },

  saveInsightReport: async (payload: {
    projectDir: string;
    report: InsightReport;
  }): Promise<SaveInsightReportResult> => {
    return invokeSafe<SaveInsightReportResult>('save-insight-report', payload, { ok: false });
  },

  loadInsightReport: async (payload: {
    projectDir: string;
    reportId?: string;
  }): Promise<LoadInsightReportResult> => {
    return invokeSafe<LoadInsightReportResult>('load-insight-report', payload, { ok: false, report: null });
  },

  exportInsightReportBundle: async (payload: {
    projectDir: string;
    report: InsightReport;
    compareResult: CompareResult;
    html: string;
    csv: string;
  }): Promise<ExportInsightReportBundleResult> => {
    return invokeSafe<ExportInsightReportBundleResult>('export-insight-report-bundle', payload, { ok: false });
  },

  loadAiSettings: async (): Promise<LoadAiSettingsResult> => {
    return invokeSafeNoPayload<LoadAiSettingsResult>('load-ai-settings', { ok: false, settings: null });
  },

  saveAiSettings: async (payload: {
    settings: AiSettingsUpdate;
  }): Promise<SaveAiSettingsResult> => {
    return invokeSafe<SaveAiSettingsResult>('save-ai-settings', payload, { ok: false });
  },

  testAiConnection: async (): Promise<TestAiConnectionResult> => {
    return invokeSafeNoPayload<TestAiConnectionResult>('test-ai-connection', { ok: false });
  },

  runAiAnalysis: async (payload: {
    mode: AiAnalysisMode;
    projectDir?: string;
    outputLanguage?: 'zh-CN' | 'en-US';
    input: unknown;
  }): Promise<RunAiAnalysisResult> => {
    return invokeSafe<RunAiAnalysisResult>('run-ai-analysis', payload, { ok: false });
  },

  loadSingleRecordAiReport: async (payload: {
    projectDir: string;
    recordId?: string;
  }): Promise<LoadSingleRecordAiReportResult> => {
    return invokeSafe<LoadSingleRecordAiReportResult>('load-single-ai-report', payload, { ok: false, report: null });
  }
};
