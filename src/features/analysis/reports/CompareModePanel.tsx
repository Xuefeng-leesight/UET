import type { BlinkIntervalData } from '@shared/contracts/domain/analysis';
import React from 'react';
import type { RecordingRecord } from '@shared/contracts/domain/models';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import CustomSelect from '@/shared/ui/CustomSelect';
import type {
  CompareConfig,
  CompareGroupBy,
  CompareResult,
  InsightCard,
  InsightReport,
  InsightStyleVariant,
} from '@shared/contracts/domain/reporting';
import type { ExtendedStimulus, HeatmapPoint } from '@/shared/types/mrt';
import type { NormalizedAoiShape } from '@shared/domain/aoi/aoiReport';
import { computeAoiStatsRows } from '@shared/domain/aoi/aoiReport';
import {
  buildCompareResult,
  COMPARE_METRIC_DEFS,
  filterPointsByConfig,
  formatMetricValue,
} from '@/features/analysis/reports/compareEngine';
import { getRecordingFrameSizeOptions } from '@/features/records/domain/recordFrameSize';
import { buildInsightReport } from '@/features/analysis/reports/insightEngine';
import { useLanguage } from '@/app/i18n/useLanguage';
import { useSystemInsightStyleVariant } from '@/features/analysis/reports/styleVariants';
import { parseAoiStore } from '@/features/analysis/aoi/aoiPersistence';

interface CompareModePanelProps {
  records: RecordingRecord[];
  stimuli: ExtendedStimulus[];
  projectDir: string;
  preselectedRecordIds?: string[];
  onNotify?: (message: string) => void;
  aiBusy?: boolean;
  aiBusyText?: string;
  onAiBusyChange?: (busy: boolean, text?: string) => void;
  onCompareResultChange?: (result: CompareResult | null) => void;
  onInsightGenerated?: (report: InsightReport, compare: CompareResult) => void;
}

type AoiStore = { byRecordId: Record<string, NormalizedAoiShape[]> };

const recordMetricDefs = COMPARE_METRIC_DEFS.filter((metric, index) => index < 8
  || ['blinkCount', 'totalBlinkDurationMs', 'avgBlinkDurationMs'].includes(metric.key));

const formatTs = (value: string): string => {
  if (!value) return '-';
  return value;
};

const resolveDurationMs = (points: HeatmapPoint[]): number => {
  const sorted = [...points]
    .map((point) => (typeof point.timestamp === 'number' && Number.isFinite(point.timestamp) ? point.timestamp : null))
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  if (sorted.length < 2) return 0;
  return Math.max(0, sorted[sorted.length - 1] - sorted[0]);
};

const groupByOptions: Array<{ id: CompareGroupBy; label: string }> = [
  { id: 'subject', label: '按受试者' },
  { id: 'stimulus', label: '按刺激物' },
];

const styleClassMap: Record<
  InsightStyleVariant,
  {
    primaryButton: string;
    insightButton: string;
    aiButton: string;
    busyPanel: string;
  }
> = {
  ocean: {
    primaryButton: 'bg-sky-500 border border-sky-500 text-white hover:bg-sky-600',
    insightButton: 'border-sky-200 text-sky-600 hover:bg-sky-50',
    aiButton: 'border-sky-200 bg-sky-50 text-sky-600 hover:bg-sky-50',
    busyPanel: 'border-sky-200 bg-sky-50 text-sky-600',
  },
  forest: {
    primaryButton: 'bg-sky-500 border border-sky-500 text-white hover:bg-sky-600',
    insightButton: 'border-sky-200 text-sky-600 hover:bg-sky-50',
    aiButton: 'border-sky-200 bg-sky-50 text-sky-600 hover:bg-sky-50',
    busyPanel: 'border-sky-200 bg-sky-50 text-sky-600',
  },
  amber: {
    primaryButton: 'bg-sky-500 border border-sky-500 text-white hover:bg-sky-600',
    insightButton: 'border-sky-200 text-sky-600 hover:bg-sky-50',
    aiButton: 'border-sky-200 bg-sky-50 text-sky-600 hover:bg-sky-50',
    busyPanel: 'border-sky-200 bg-sky-50 text-sky-600',
  },
};

const CompareModePanel: React.FC<CompareModePanelProps> = ({
  records,
  stimuli,
  projectDir,
  preselectedRecordIds = [],
  onNotify,
  aiBusy = false,
  aiBusyText = '',
  onAiBusyChange,
  onCompareResultChange,
  onInsightGenerated,
}) => {
  const { language } = useLanguage();
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set(preselectedRecordIds));
  const [groupBy, setGroupBy] = React.useState<CompareGroupBy>('subject');
  const [stimulusName, setStimulusName] = React.useState<string>('');
  const styleVariant = useSystemInsightStyleVariant();
  const [pointsByRecordId, setPointsByRecordId] = React.useState<Record<string, HeatmapPoint[]>>({});
  const [blinkDataByRecordId, setBlinkDataByRecordId] = React.useState<Record<string, BlinkIntervalData | undefined>>({});
  const [csvTextByRecordId, setCsvTextByRecordId] = React.useState<Record<string, string>>({});
  const [aoiStore, setAoiStore] = React.useState<AoiStore>({ byRecordId: {} });
  const [compareResult, setCompareResult] = React.useState<CompareResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [aiEnhancing, setAiEnhancing] = React.useState(false);
  const styleClasses = React.useMemo(() => styleClassMap[styleVariant], [styleVariant]);
  const normalizeStimulusKey = React.useCallback((value: string): string => value.trim().toLowerCase().replace(/\s+/g, ''), []);

  const stimulusNameById = React.useMemo(() => {
    const map = new Map<string, string>();
    stimuli.forEach((stimulus) => {
      const id = String(stimulus?.id || '').trim();
      const name = String(stimulus?.name || '').trim();
      if (!id || !name) return;
      map.set(id, name);
    });
    return map;
  }, [stimuli]);

  const stimulusIdByName = React.useMemo(() => {
    const map = new Map<string, string>();
    stimuli.forEach((stimulus) => {
      const id = String(stimulus?.id || '').trim();
      const name = String(stimulus?.name || '').trim();
      if (!id || !name) return;
      map.set(name, id);
    });
    return map;
  }, [stimuli]);

  const stimulusIdByNormalizedName = React.useMemo(() => {
    const map = new Map<string, string>();
    stimuli.forEach((stimulus) => {
      const id = String(stimulus?.id || '').trim();
      const name = String(stimulus?.name || '').trim();
      if (!id || !name) return;
      map.set(normalizeStimulusKey(name), id);
    });
    return map;
  }, [normalizeStimulusKey, stimuli]);

  const resolveStimulusDisplayName = React.useCallback(
    (value: unknown): string => {
      const token = String(value || '').trim();
      if (!token) return '';

      const byId = stimulusNameById.get(token);
      if (byId) return byId;

      const byName = stimulusIdByName.get(token);
      if (byName) return stimulusNameById.get(byName) || token;

      const normalizedToken = normalizeStimulusKey(token);
      const byNormalizedName = stimulusIdByNormalizedName.get(normalizedToken);
      if (byNormalizedName) return stimulusNameById.get(byNormalizedName) || token;

      const byPattern = /^stimulus_(.+)$/i.exec(token)?.[1]?.trim();
      if (byPattern && stimulusNameById.has(byPattern)) {
        return stimulusNameById.get(byPattern) || token;
      }

      if (normalizedToken) {
        for (const [normalizedName, id] of stimulusIdByNormalizedName.entries()) {
          if (normalizedName.includes(normalizedToken) || normalizedToken.includes(normalizedName)) {
            return stimulusNameById.get(id) || token;
          }
        }
      }

      return token;
    },
    [normalizeStimulusKey, stimulusIdByName, stimulusIdByNormalizedName, stimulusNameById],
  );

  const resolveStimulusId = React.useCallback(
    (tokenRaw: unknown): string => {
      const token = String(tokenRaw || '').trim();
      if (!token) return '';
      if (stimulusNameById.has(token)) return token;

      const byName = stimulusIdByName.get(token);
      if (byName) return byName;

      const normalizedToken = normalizeStimulusKey(token);
      const byNormalizedName = stimulusIdByNormalizedName.get(normalizedToken);
      if (byNormalizedName) return byNormalizedName;

      const byPattern = /^stimulus_(.+)$/i.exec(token)?.[1]?.trim();
      if (byPattern && stimulusNameById.has(byPattern)) return byPattern;

      if (normalizedToken) {
        for (const [normalizedName, id] of stimulusIdByNormalizedName.entries()) {
          if (normalizedName.includes(normalizedToken) || normalizedToken.includes(normalizedName)) {
            return id;
          }
        }
      }
      return '';
    },
    [normalizeStimulusKey, stimulusIdByName, stimulusIdByNormalizedName, stimulusNameById],
  );

  const normalizePointsForCompare = React.useCallback(
    (points: HeatmapPoint[]): HeatmapPoint[] => {
      let changed = false;
      const normalized = points.map((point) => {
        const raw = String(point.stimulusName || '').trim();
        if (!raw) return point;
        const displayName = resolveStimulusDisplayName(raw);
        if (!displayName || displayName === raw) return point;
        changed = true;
        return { ...point, stimulusName: displayName };
      });
      return changed ? normalized : points;
    },
    [resolveStimulusDisplayName],
  );

  const notify = React.useCallback(
    (message: string) => {
      if (onNotify) onNotify(message);
    },
    [onNotify],
  );
  const recordAoiScopeId = React.useCallback((recordId: string): string => `record:${recordId}`, []);

  React.useEffect(() => {
    setSelectedIds(new Set(preselectedRecordIds.filter((id) => records.some((record) => record.id === id))));
  }, [preselectedRecordIds, records]);

  React.useEffect(() => {
    if (!projectDir || !ipcClient.isAvailable()) {
      setCompareResult(null);
      onCompareResultChange?.(null);
      return;
    }

    let cancelled = false;
    ipcClient
      .loadCompareResult({ projectDir })
      .then((res) => {
        if (cancelled) return;
        if (res.ok && res.compareResult) {
          setCompareResult(res.compareResult);
          onCompareResultChange?.(res.compareResult);
        } else {
          setCompareResult(null);
          onCompareResultChange?.(null);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setCompareResult(null);
        onCompareResultChange?.(null);
      });

    return () => {
      cancelled = true;
    };
  }, [projectDir, onCompareResultChange]);

  React.useEffect(() => {
    if (!projectDir || !ipcClient.isAvailable()) {
      setAoiStore({ byRecordId: {} });
      return;
    }
    let cancelled = false;
    ipcClient
      .loadAoi({ projectDir })
      .then((res) => {
        if (cancelled) return;
        const store = res.ok ? parseAoiStore(res.data) : null;
        setAoiStore({ byRecordId: store?.byRecordId ?? {} });
      })
      .catch(() => {
        if (!cancelled) setAoiStore({ byRecordId: {} });
      });

    return () => {
      cancelled = true;
    };
  }, [projectDir]);

  const ensureRecordData = React.useCallback(
    async (record: RecordingRecord): Promise<{ points: HeatmapPoint[]; csvText: string; blinkData?: BlinkIntervalData }> => {
      const cachedPoints = pointsByRecordId[record.id];
      const cachedCsvText = csvTextByRecordId[record.id];
      if (cachedPoints && typeof cachedCsvText === 'string') {
        return { points: cachedPoints, csvText: cachedCsvText, blinkData: blinkDataByRecordId[record.id] };
      }
      if (!record.csvPath) return { points: cachedPoints || [], csvText: cachedCsvText || '' };

      const res = await ipcClient.loadRecordPoints({
        csvPath: record.csvPath,
        includeMarkerOnlyRows: true,
        includeSdkSaccades: true,
        pointMode: 'fixation',
        includePupilSamples: true,
        isGlassesMode: record.deviceType === '眼镜式',
        ...getRecordingFrameSizeOptions(record),
      });
      if (!res.ok || !Array.isArray(res.points)) {
        throw new Error('message' in res && res.message ? res.message : '完整统计数据加载失败');
      }
      const parsed = [...res.points, ...(res.pupilSamples || [])] as HeatmapPoint[];
      setPointsByRecordId((prev) => ({ ...prev, [record.id]: parsed }));
      setCsvTextByRecordId((prev) => ({ ...prev, [record.id]: '' }));
      setBlinkDataByRecordId((prev) => ({ ...prev, [record.id]: res.blinkData }));
      return { points: parsed, csvText: '', blinkData: res.blinkData };
    },
    [pointsByRecordId, csvTextByRecordId, blinkDataByRecordId],
  );

  const selectedRecords = React.useMemo(
    () => records.filter((record) => selectedIds.has(record.id)),
    [records, selectedIds],
  );

  React.useEffect(() => {
    if (!ipcClient.isAvailable()) return;
    if (selectedRecords.length === 0) return;
    Promise.all(selectedRecords.map((record) => ensureRecordData(record)))
      .catch(() => {
      })
      .finally(() => {
      });
  }, [selectedRecords, ensureRecordData]);

  const stimulusOptions = React.useMemo(() => {
    const set = new Set<string>();
    for (const record of selectedRecords) {
      const points = normalizePointsForCompare(pointsByRecordId[record.id] || []);
      for (const point of points) {
        const name = String(point.stimulusName || '').trim();
        if (name) set.add(name);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [normalizePointsForCompare, pointsByRecordId, selectedRecords]);

  React.useEffect(() => {
    if (groupBy !== 'stimulus') return;
    if (stimulusName) return;
    if (stimulusOptions.length === 0) return;
    setStimulusName(stimulusOptions[0]);
  }, [groupBy, stimulusName, stimulusOptions]);

  React.useEffect(() => {
    if (groupBy === 'stimulus') return;
    if (!stimulusName) return;
    setStimulusName('');
  }, [groupBy, stimulusName]);

  const toggleRecord = (recordId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(recordId)) {
        next.delete(recordId);
      } else {
        next.add(recordId);
      }
      return next;
    });
  };

  const selectAll = () => setSelectedIds(new Set(records.map((record) => record.id)));
  const clearAll = () => setSelectedIds(new Set());

  const createCurrentConfig = React.useCallback((): CompareConfig => {
    const effectiveStimulusName = groupBy === 'stimulus' ? stimulusName || null : null;
    return {
      recordIds: selectedRecords.map((record) => record.id),
      groupBy,
      stimulusName: effectiveStimulusName,
      segmentName: null,
      createdAt: new Date().toISOString(),
    };
  }, [selectedRecords, groupBy, stimulusName]);

  const configSignature = React.useCallback(
    (config: CompareConfig): string =>
      JSON.stringify({
        recordIds: [...config.recordIds].sort(),
        groupBy: config.groupBy,
        stimulusName: config.stimulusName || '',
      }),
    [],
  );

  const handleGenerateCompare = async (): Promise<CompareResult | null> => {
    if (selectedRecords.length === 0) {
      notify('请至少选择一条记录');
      return null;
    }
    if (!ipcClient.isAvailable()) {
      notify('IPC 不可用，无法读取 CSV');
      return null;
    }

    setLoading(true);
    try {
      const fullBlinkDataByRecord: Record<string, BlinkIntervalData | undefined> = {};
      const pointsEntries = await Promise.all(
        selectedRecords.map(async (record) => {
          const data = await ensureRecordData(record);
          fullBlinkDataByRecord[record.id] = data.blinkData ? {
            ...data.blinkData,
            intervals: data.blinkData.intervals.map((interval) => ({ ...interval,
              stimulusName: interval.stimulusName ? resolveStimulusDisplayName(interval.stimulusName) : undefined })),
          } : undefined;
          return [record.id, normalizePointsForCompare(data.points)] as const;
        }),
      );
      const fullPointsByRecord = Object.fromEntries(pointsEntries) as Record<string, HeatmapPoint[]>;

      const config = createCurrentConfig();

      const aoiRowsByRecord = Object.fromEntries(
        selectedRecords.map((record) => {
          const rawPoints = fullPointsByRecord[record.id] || [];
          const filteredPoints = filterPointsByConfig(rawPoints, record, config);
          const store = aoiStore.byRecordId || {};

          const scopedRecordShapes = Array.isArray(store[recordAoiScopeId(record.id)])
            ? (store[recordAoiScopeId(record.id)] as NormalizedAoiShape[])
            : [];
          const legacyRecordShapes = Array.isArray(store[record.id]) ? (store[record.id] as NormalizedAoiShape[]) : [];
          const recordScopedShapes = scopedRecordShapes.length > 0 ? scopedRecordShapes : legacyRecordShapes;
          let rows =
            recordScopedShapes.length > 0
              ? computeAoiStatsRows({
                  shapes: recordScopedShapes,
                  points: filteredPoints,
                  recordDurationMs: resolveDurationMs(filteredPoints),
                  frameWidth: record.videoWidth,
                  blinkData: fullBlinkDataByRecord[record.id],
                })
              : [];

          if (rows.length === 0) {
            const pointsByStimulusId = new Map<string, HeatmapPoint[]>();
            filteredPoints.forEach((point) => {
              const stimulusId = resolveStimulusId(point?.stimulusName);
              if (!stimulusId) return;
              const list = pointsByStimulusId.get(stimulusId) || [];
              list.push(point);
              pointsByStimulusId.set(stimulusId, list);
            });

            if (config.stimulusName) {
              const selectedStimulusId = resolveStimulusId(config.stimulusName);
              if (selectedStimulusId && !pointsByStimulusId.has(selectedStimulusId)) {
                pointsByStimulusId.set(selectedStimulusId, []);
              }
            }

            const scopedRows = Array.from(pointsByStimulusId.entries()).flatMap(([stimulusId, stimulusPoints]) => {
              const shapes = Array.isArray(store[stimulusId]) ? (store[stimulusId] as NormalizedAoiShape[]) : [];
              if (shapes.length === 0) return [];
              return computeAoiStatsRows({
                shapes,
                points: stimulusPoints,
                recordDurationMs: resolveDurationMs(stimulusPoints),
                frameWidth: record.videoWidth,
                  blinkData: fullBlinkDataByRecord[record.id],
              }).map((row) => ({
                ...row,
                // Avoid row-key collisions when AOI ids are reused across stimuli.
                aoiId: `${stimulusId}::${row.aoiId}`,
              }));
            });

            if (scopedRows.length > 0) {
              rows = scopedRows;
            }
          }

          return [record.id, rows] as const;
        }),
      );

      const nextResult = buildCompareResult({
        config,
        records,
        pointsByRecord: fullPointsByRecord,
        aoiRowsByRecord,
        blinkDataByRecord: fullBlinkDataByRecord,
      });

      setCompareResult(nextResult);
      onCompareResultChange?.(nextResult);
      notify('多记录对比已生成');
      return nextResult;
    } catch (error: unknown) {
      notify(`生成对比失败：${error instanceof Error ? error.message : '未知错误'}`);
      return null;
    } finally {
      setLoading(false);
    }
  };

  const handleSaveCompare = async () => {
    if (!projectDir || !compareResult) {
      notify('暂无可保存的对比结果');
      return;
    }
    if (!ipcClient.isAvailable()) {
      notify('IPC 不可用，无法保存结果');
      return;
    }

    setSaving(true);
    try {
      const res = await ipcClient.saveCompareResult({ projectDir, compareResult });
      if (res.ok) {
        notify('对比结果已保存');
      } else {
        const msg = 'message' in res ? res.message : undefined;
        notify(`保存失败：${msg || '未知错误'}`);
      }
    } catch (error: unknown) {
      notify(`保存异常：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleGenerateInsight = async () => {
    const currentConfig = createCurrentConfig();
    const currentSig = configSignature(currentConfig);
    const existingSig = compareResult ? configSignature(compareResult.config) : '';

    let base = compareResult;
    if (!base || currentSig !== existingSig) {
      base = await handleGenerateCompare();
    }
    if (!base) {
      notify('请先生成有效对比结果');
      return;
    }

    const report = buildInsightReport({
      compareResult: base,
      tone: 'enterprise',
      styleVariant,
      outputLanguage: language,
    });
    onInsightGenerated?.(report, base);
    notify('洞察报告已生成，可前往洞察页查看');
  };

  const toInsightCard = React.useCallback(
    (
      row: {
        title: string;
        severity: 'info' | 'good' | 'warn' | 'risk';
        summary: string;
        evidence: string[];
        recommendation: string;
      },
      prefix: string,
      idx: number,
    ): InsightCard => ({
      id: `${prefix}_${idx}_${Math.random().toString(36).slice(2, 8)}`,
      title: row.title,
      severity: row.severity,
      summary: row.summary,
      evidence: row.evidence,
      recommendation: row.recommendation,
    }),
    [],
  );

  const handleEnhanceInsightWithAi = async () => {
    setAiEnhancing(true);
    onAiBusyChange?.(true, 'AI 多记录增强生成中...');
    if (!projectDir) {
      notify('未检测到工程目录');
      setAiEnhancing(false);
      onAiBusyChange?.(false, '');
      return;
    }

    const currentConfig = createCurrentConfig();
    const currentSig = configSignature(currentConfig);
    const existingSig = compareResult ? configSignature(compareResult.config) : '';

    let base = compareResult;
    if (!base || currentSig !== existingSig) {
      base = await handleGenerateCompare();
    }
    if (!base) {
      notify('请先生成有效对比结果');
      setAiEnhancing(false);
      onAiBusyChange?.(false, '');
      return;
    }

    const baseReport = buildInsightReport({
      compareResult: base,
      tone: 'enterprise',
      styleVariant,
      outputLanguage: language,
    });

    const targetRecords = records.filter((record) => base!.config.recordIds.includes(record.id));
    const dataEntries = await Promise.all(
      targetRecords.map(async (record) => {
        const data = await ensureRecordData(record);
        return [record.id, data] as const;
      }),
    );
    const rawPointsByRecord = Object.fromEntries(
      dataEntries.map(([recordId, data]) => [recordId, data.points]),
    );
    const rawCsvByRecord = Object.fromEntries(
      dataEntries.map(([recordId, data]) => [recordId, data.csvText || '']),
    );
    const rawFiles = targetRecords.map((record) => ({
      recordId: record.id,
      recordName: String(record.name || record.id),
      filePath: record.csvPath || '',
    }));

    try {
      const aiRes = await ipcClient.runAiAnalysis({
        mode: 'compare',
        projectDir,
        outputLanguage: language,
        input: {
          compareResult: base,
          ruleInsight: {
            title: baseReport.title,
            executiveSummary: baseReport.executiveSummary,
            keyFindings: baseReport.keyFindings,
            risks: baseReport.risks,
            recommendations: baseReport.recommendations,
          },
          rawPointsByRecord,
          rawCsvByRecord,
          rawFiles,
        },
      });

      if (!aiRes.ok) {
        const message = 'message' in aiRes ? aiRes.message : '';
        notify(`AI 增强失败：${message || '未知错误'}`);
        return;
      }

      const enhancedReport: InsightReport = {
        ...baseReport,
        aiAugmentation: {
          mode: 'compare',
          provider: aiRes.provider,
          model: aiRes.model,
          createdAt: new Date().toISOString(),
          compression: aiRes.compression,
          usage: aiRes.usage,
          result: {
            summary: aiRes.result.summary,
            keyFindings: aiRes.result.keyFindings.map((item, idx) => toInsightCard(item, 'ai_finding', idx)),
            risks: aiRes.result.risks.map((item, idx) => toInsightCard(item, 'ai_risk', idx)),
            recommendations: aiRes.result.recommendations,
            warnings: aiRes.result.warnings,
          },
        },
      };

      onInsightGenerated?.(enhancedReport, base);
      notify(aiRes.retriedByAggressiveCompression ? 'AI 增强洞察已生成（超时后自动压缩重试）' : 'AI 增强洞察已生成，可前往洞察页查看');
    } catch (error: unknown) {
      notify(`AI 增强异常：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setAiEnhancing(false);
      onAiBusyChange?.(false, '');
    }
  };

  const topMetrics = (compareResult?.metrics || [])
    .filter((metric) => typeof metric.span === 'number' && Number.isFinite(metric.span))
    .sort((a, b) => (b.span || 0) - (a.span || 0))
    .slice(0, 6);

  return (
    <div className="h-full flex flex-col gap-4 overflow-y-auto pr-1 pb-4">
      <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <label className="font-semibold">分组维度</label>
            <CustomSelect
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as CompareGroupBy)}
              fullWidth={false}
              truncateOptionLabel={false}
              className="px-2 py-1.5 border border-slate-200 rounded-lg text-xs text-slate-700 font-semibold min-w-[116px]"
            >
              {groupByOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </CustomSelect>

            <label className="font-semibold">刺激物</label>
            <CustomSelect
              value={stimulusName}
              onChange={(e) => setStimulusName(e.target.value)}
              disabled={groupBy !== 'stimulus'}
              fullWidth={false}
              truncateOptionLabel={false}
              className="px-2 py-1.5 border border-slate-200 rounded-lg text-xs text-slate-700 font-semibold min-w-[136px] max-w-[240px]"
            >
              <option value="">{groupBy === 'stimulus' ? '请选择刺激物' : '全部'}</option>
              {stimulusOptions.map((item) => (
                <option key={item} value={item} data-i18n-skip="true">
                  {item}
                </option>
              ))}
            </CustomSelect>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={handleGenerateCompare}
              disabled={loading}
              className={`px-3 py-2 rounded-lg text-xs font-bold disabled:opacity-50 ${styleClasses.primaryButton}`}
            >
              {loading ? '生成中...' : '生成多记录对比'}
            </button>
            <button
              onClick={handleSaveCompare}
              disabled={saving || !compareResult}
              className="px-3 py-2 rounded-lg border border-slate-300 text-slate-700 text-xs font-bold hover:bg-slate-50 disabled:opacity-50"
            >
              {saving ? '保存中...' : '保存对比结果'}
            </button>
            <button
              onClick={() => {
                void handleGenerateInsight();
              }}
              disabled={loading || (!compareResult && selectedIds.size === 0)}
              className={`px-3 py-2 rounded-lg border text-xs font-bold disabled:opacity-50 ${styleClasses.insightButton}`}
            >
              生成洞察报告
            </button>
            <button
              onClick={() => {
                void handleEnhanceInsightWithAi();
              }}
              disabled={loading || aiEnhancing || aiBusy || (!compareResult && selectedIds.size === 0)}
              className={`px-3 py-2 rounded-lg border text-xs font-bold disabled:opacity-50 ${styleClasses.aiButton}`}
            >
              {aiEnhancing || aiBusy ? 'AI增强中...' : 'AI增强洞察'}
            </button>
          </div>
        </div>
      </div>

      {(aiBusy || aiEnhancing) ? (
        <div className={`rounded-lg border px-3 py-2 text-xs ${styleClasses.busyPanel}`}>
          {aiBusyText || 'AI 任务后台执行中，切换页面不会中断。'}
        </div>
      ) : null}

      <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-bold text-slate-500 tracking-widest">记录选择</div>
          <div className="flex items-center gap-2 text-xs">
            <button onClick={selectAll} className="px-2 py-1 rounded border border-slate-200 hover:bg-slate-50">
              全选
            </button>
            <button onClick={clearAll} className="px-2 py-1 rounded border border-slate-200 hover:bg-slate-50">
              清空
            </button>
            <span className="text-slate-500">已选 {selectedIds.size} / {records.length}</span>
          </div>
        </div>

        <div className="max-h-48 overflow-auto border border-slate-100 rounded-xl">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">选择</th>
                <th className="px-3 py-2 text-left">记录</th>
                <th className="px-3 py-2 text-left">受试者</th>
                <th className="px-3 py-2 text-left">录制时间</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id} className="border-t border-slate-100 hover:bg-slate-50/50">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(record.id)}
                      onChange={() => toggleRecord(record.id)}
                    />
                  </td>
                  <td data-i18n-skip="true" className="px-3 py-2 text-slate-700 font-semibold">{record.name}</td>
                  <td data-i18n-skip="true" className="px-3 py-2 text-slate-600">{record.subjectName || '—'}</td>
                  <td className="px-3 py-2 text-slate-500">{formatTs(record.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
          <div className="text-xs font-bold text-slate-500 tracking-widest mb-3">差异指标 TOP</div>
          {topMetrics.length === 0 ? (
            <div className="text-sm text-slate-400">暂无对比结果</div>
          ) : (
            <div className="space-y-2">
              {topMetrics.map((metric) => (
                <div key={metric.key} className="rounded-lg border border-slate-100 p-2">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-slate-700">{metric.label}</div>
                    <div className="text-xs text-slate-500">跨度 {formatMetricValue(metric.span, metric.unit)} {metric.unit}</div>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    均值 {formatMetricValue(metric.mean, metric.unit)} · 中位数 {formatMetricValue(metric.median, metric.unit)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
          <div className="text-xs font-bold text-slate-500 tracking-widest mb-3">分组汇总</div>
          {!compareResult || compareResult.groups.length === 0 ? (
            <div className="text-sm text-slate-400">暂无分组结果</div>
          ) : (
            <div className="max-h-64 overflow-auto border border-slate-100 rounded-xl">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-2 py-2 text-left">分组</th>
                    <th className="px-2 py-2 text-left">记录数</th>
                    <th className="px-2 py-2 text-left">注视次数均值</th>
                    <th className="px-2 py-2 text-left">AOI总停留时长均值(ms)</th>
                  </tr>
                </thead>
                <tbody>
                  {compareResult.groups.map((group) => (
                    <tr key={group.groupKey} className="border-t border-slate-100">
                      <td data-i18n-skip="true" className="px-2 py-2 text-slate-700">{group.groupKey}</td>
                      <td className="px-2 py-2 text-slate-500">{group.recordCount}</td>
                      <td className="px-2 py-2 text-slate-500">{formatMetricValue(group.metrics.fixationCount, '次')}</td>
                      <td className="px-2 py-2 text-slate-500">{formatMetricValue(group.metrics.aoiTotalDurationMs, 'ms')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
        <div className="text-xs font-bold text-slate-500 tracking-widest mb-3">记录级指标</div>
        {!compareResult || compareResult.records.length === 0 ? (
          <div className="text-sm text-slate-400">暂无记录级对比结果</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-2 py-2 text-left">记录</th>
                  <th className="px-2 py-2 text-left">受试者</th>
                  <th className="px-2 py-2 text-left">分组</th>
                  {recordMetricDefs.map((metric) => (
                    <th key={metric.key} className="px-2 py-2 text-left whitespace-nowrap">
                      {metric.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {compareResult.records.map((record) => (
                  <tr key={record.recordId} className="border-t border-slate-100">
                    <td data-i18n-skip="true" className="px-2 py-2 text-slate-700 font-semibold">{record.recordName}</td>
                    <td data-i18n-skip="true" className="px-2 py-2 text-slate-600">{record.subjectName || '—'}</td>
                    <td data-i18n-skip="true" className="px-2 py-2 text-slate-600">{record.groupKey}</td>
                    {recordMetricDefs.map((metric) => (
                      <td key={`${record.recordId}-${metric.key}`} className="px-2 py-2 text-slate-500 whitespace-nowrap">
                        {formatMetricValue(record.metrics[metric.key], metric.unit)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
        <div className="text-xs font-bold text-slate-500 tracking-widest mb-3">AOI 综合排名</div>
        {!compareResult || compareResult.aoi.length === 0 ? (
          <div className="text-sm text-slate-400">暂无 AOI 结果</div>
        ) : (
          <div className="max-h-64 overflow-auto border border-slate-100 rounded-xl">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-2 py-2 text-left">AOI</th>
                  <th className="px-2 py-2 text-left">AOI命中记录数</th>
                  <th className="px-2 py-2 text-left">总注视次数</th>
                  <th className="px-2 py-2 text-left">总停留时长(ms)</th>
                  <th className="px-2 py-2 text-left">平均停留时长(ms)</th>
                </tr>
              </thead>
              <tbody>
                {compareResult.aoi.map((row) => (
                  <tr key={row.aoiId} className="border-t border-slate-100">
                    <td data-i18n-skip="true" className="px-2 py-2 text-slate-700">{row.name}</td>
                    <td className="px-2 py-2 text-slate-500">{row.hitRecordCount}</td>
                    <td className="px-2 py-2 text-slate-500">{row.totalFixationCount}</td>
                    <td className="px-2 py-2 text-slate-500">{Math.round(row.totalVisitDurationMs ?? row.totalDurationMs)}</td>
                    <td className="px-2 py-2 text-slate-500">{(row.avgVisitDurationMs ?? row.avgDurationMs).toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {compareResult?.notes && compareResult.notes.length > 0 ? (
          <ul className="mt-3 list-disc pl-5 text-xs text-amber-700 space-y-1">
            {compareResult.notes.map((note, idx) => (
              <li key={`note-${idx}`}>{note}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
};

export default CompareModePanel;
