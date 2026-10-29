export type CompareGroupBy = 'subject' | 'stimulus' | 'segment';

export interface CompareConfig {
  recordIds: string[];
  groupBy: CompareGroupBy;
  stimulusName?: string | null;
  segmentName?: string | null;
  createdAt: string;
}

export type CompareMetricKey =
  | 'durationSeconds'
  | 'samplingRateHz'
  | 'validityPercent'
  | 'fixationCount'
  | 'totalFixationDurationMs'
  | 'avgFixationDurationMs'
  | 'maxFixationDurationMs'
  | 'saccadeCount'
  | 'avgSaccadeVelocity'
  | 'avgSaccadeAmplitude'
  | 'avgPupilDiameter'
  | 'blinkCount'
  | 'totalBlinkDurationMs'
  | 'avgBlinkDurationMs'
  | 'aoiHitCount'
  | 'aoiTotalDurationMs';

export interface CompareMetricSummary {
  key: CompareMetricKey;
  label: string;
  unit: string;
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
  span: number | null;
  topRecordId: string | null;
  bottomRecordId: string | null;
  anomalyRecordIds: string[];
  ranking: Array<{ recordId: string; value: number }>;
}

export interface CompareRecordSnapshot {
  recordId: string;
  recordName: string;
  subjectName: string;
  groupKey: string;
  timestamp: string;
  metrics: Record<CompareMetricKey, number | null>;
}

export interface CompareGroupSummary {
  groupKey: string;
  recordCount: number;
  metrics: Record<CompareMetricKey, number | null>;
}

export interface CompareAoiSummary {
  aoiId: string;
  name: string;
  color: string;
  hitRecordCount: number;
  totalFixationCount: number;
  totalVisitCount: number;
  totalVisitDurationMs: number;
  avgVisitDurationMs: number;
  totalDurationMs: number;
  avgDurationMs: number;
}

export interface CompareResult {
  id: string;
  createdAt: string;
  config: CompareConfig;
  records: CompareRecordSnapshot[];
  groups: CompareGroupSummary[];
  metrics: CompareMetricSummary[];
  aoi: CompareAoiSummary[];
  notes: string[];
}

export type InsightSeverity = 'info' | 'good' | 'warn' | 'risk';

export interface InsightCard {
  id: string;
  title: string;
  severity: InsightSeverity;
  summary: string;
  evidence: string[];
  recommendation: string;
}

export interface AiSettings {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyMasked: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  updatedAt: string;
  securityMode: 'encrypted' | 'plain';
}

export interface AiSettingsUpdate {
  baseUrl: string;
  model: string;
  apiKey?: string;
  clearApiKey?: boolean;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export type AiAnalysisMode = 'single' | 'compare';

export interface AiTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AiCompressionMeta {
  inputPointCount: number;
  retainedPointCount: number;
  sampledPointCount: number;
  anomalyPointCount: number;
  strategy: 'layered';
}

export interface AiAnalysisResult {
  summary: string[];
  keyFindings: Array<{
    title: string;
    severity: InsightSeverity;
    summary: string;
    evidence: string[];
    recommendation: string;
  }>;
  risks: Array<{
    title: string;
    severity: InsightSeverity;
    summary: string;
    evidence: string[];
    recommendation: string;
  }>;
  recommendations: string[];
  warnings: string[];
}

export interface AiAugmentation {
  mode: AiAnalysisMode;
  provider: string;
  model: string;
  createdAt: string;
  compression: AiCompressionMeta;
  usage?: AiTokenUsage;
  result: AiAnalysisResult;
}

export interface SingleRecordAiReport {
  id: string;
  createdAt: string;
  recordId: string;
  recordName: string;
  subjectName: string;
  provider: string;
  model: string;
  compression: AiCompressionMeta;
  usage?: AiTokenUsage;
  result: AiAnalysisResult;
}

export type InsightTone = 'enterprise' | 'academic' | 'consulting';
export type InsightStyleVariant = 'ocean' | 'forest' | 'amber';

export interface InsightReport {
  id: string;
  createdAt: string;
  compareResultId: string;
  tone: InsightTone;
  styleVariant?: InsightStyleVariant;
  title: string;
  executiveSummary: string[];
  keyFindings: InsightCard[];
  risks: InsightCard[];
  recommendations: string[];
  appendix: {
    recordCount: number;
    groupBy: CompareGroupBy;
    metricCount: number;
    aoiCount: number;
  };
  aiAugmentation?: AiAugmentation;
}

export interface ReportExportArtifact {
  kind: 'html' | 'pdf' | 'csv';
  path: string;
}
