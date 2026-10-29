import type { BlinkIntervalData } from '@shared/contracts/domain/analysis';
import { summarizeBlinkIntervals } from '@shared/domain/blinkIntervals';
import React from 'react';
import {
  AlertTriangle,
  Clock3,
  Database,
  Lightbulb,
  Sparkles,
  X,
} from 'lucide-react';
import type { RecordingRecord } from '@shared/contracts/domain/models';
import CustomSelect from '@/shared/ui/CustomSelect';
import type { ExtendedStimulus, HeatmapPoint } from '@/shared/types/mrt';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import { computeAoiStatsRows, type NormalizedAoiShape } from '@shared/domain/aoi/aoiReport';
import { useTimeOffsetMs } from '@/features/analysis/time-offset/useTimeOffset';
import { getDisplayRecordName } from '@/features/records/domain/recordDisplayName';
import { getRecordingFrameSizeOptions } from '@/features/records/domain/recordFrameSize';
import { useLanguage } from '@/app/i18n/useLanguage';
import { translateTextForLanguage } from '@/app/i18n/useDomTranslation';
import CompareModePanel from '@/features/analysis/reports/CompareModePanel';
import type { CompareResult, InsightReport, SingleRecordAiReport } from '@shared/contracts/domain/reporting';
import { parseAoiStore } from '@/features/analysis/aoi/aoiPersistence';

interface AoiColorDefLike {
  border: string;
  dot: string;
}

interface ChartPageProps {
  aoiColorDefs: Record<string, AoiColorDefLike>;
  stimuli: ExtendedStimulus[];
  records: RecordingRecord[];
  projectDir: string;
  preferredRecordId?: string | null;
  chartMode?: 'single' | 'compare';
  onChartModeChange?: (mode: 'single' | 'compare') => void;
  chartPreselectedRecordIds?: string[];
  onNotify?: (message: string) => void;
  onCompareResultChange?: (result: CompareResult | null) => void;
  aiBusy?: boolean;
  aiBusyText?: string;
  onAiBusyChange?: (busy: boolean, text?: string) => void;
  onInsightGenerated?: (report: InsightReport, compare: CompareResult) => void;
}

const ChartPage: React.FC<ChartPageProps> = ({
  aoiColorDefs,
  stimuli,
  records,
  projectDir,
  preferredRecordId = null,
  chartMode = 'single',
  onChartModeChange,
  chartPreselectedRecordIds = [],
  onNotify,
  onCompareResultChange,
  aiBusy = false,
  aiBusyText = '',
  onAiBusyChange,
  onInsightGenerated,
}) => {
  const { language } = useLanguage();
  const isEn = language === 'en-US';
  const { timeOffsetMs } = useTimeOffsetMs();
  const [selectedRecordId, setSelectedRecordId] = React.useState<string>(() => records[0]?.id || '');
  const lastAppliedPreferredRecordIdRef = React.useRef<string | null>(null);
  const [aoiStore, setAoiStore] = React.useState<{ byRecordId: Record<string, NormalizedAoiShape[]> }>({ byRecordId: {} });
  const [pointsByRecordId, setPointsByRecordId] = React.useState<Record<string, HeatmapPoint[]>>({});
  const [blinkDataByRecordId, setBlinkDataByRecordId] = React.useState<Record<string, BlinkIntervalData | undefined>>({});
  const [csvTextByRecordId, setCsvTextByRecordId] = React.useState<Record<string, string>>({});
  const [aoiReportError, setAoiReportError] = React.useState<string | null>(null);
  const [aoiReportLoading, setAoiReportLoading] = React.useState<boolean>(false);
  const [recordMetricsById, setRecordMetricsById] = React.useState<
    Record<string, { durationMs: number; pointCount: number }>
  >({});
  const [recordMetricsLoading, setRecordMetricsLoading] = React.useState<boolean>(false);

  type FixationMetric =
    | 'fixationCount'
    | 'firstEnterTimeMs'
    | 'fixationCountPreEntry'
    | 'firstFixationDurationMs'
    | 'totalDurationMs'
    | 'avgDurationMs'
    | 'maxFixationDurationMs'
    | 'visitorCount'
    | 'minFixationDurationMs'
    | 'secondFixationDurationMs'
    | 'regressionDurationMs'
    | 'longFixationCount';
  type VisitMetric =
    | 'visits'
    | 'revisitCount'
    | 'reVisitorCount'
    | 'totalVisitDurationMs'
    | 'firstVisitDurationMs'
    | 'avgVisitDurationMs'
    | 'firstVisitFixationCount'
    | 'firstVisitFixationDurationMs';
  type SaccadeMetric =
    | 'saccadeCount'
    | 'totalSaccadeDurationMs'
    | 'avgSaccadeDurationMs'
    | 'avgSaccadeVelocity'
    | 'avgSaccadeAmplitude'
    | 'peakSaccadeVelocity';
  type PupilEye = 'left' | 'right';

  const fixationMetricOptions: Array<{ id: FixationMetric; label: string }> = [
    { id: 'fixationCount', label: '注视次数' },
    { id: 'firstEnterTimeMs', label: '首次注视前时长(毫秒)' },
    { id: 'fixationCountPreEntry', label: '首次注视前次数' },
    { id: 'firstFixationDurationMs', label: '首次注视时长(毫秒)' },
    { id: 'totalDurationMs', label: '总注视时长(毫秒)' },
    { id: 'avgDurationMs', label: '平均注视时长(毫秒)' },
    { id: 'maxFixationDurationMs', label: '最大注视时长(毫秒)' },
    { id: 'minFixationDurationMs', label: '最短浏览时间(毫秒)' },
    { id: 'secondFixationDurationMs', label: '第二次注视时间(毫秒)' },
    { id: 'regressionDurationMs', label: '回视时间(毫秒)' },
    { id: 'longFixationCount', label: '长注视次数' },
    { id: 'visitorCount', label: '注视人数' },
  ];
  const visitMetricOptions: Array<{ id: VisitMetric; label: string }> = [
    { id: 'totalVisitDurationMs', label: '总停留时长(毫秒)' },
    { id: 'firstVisitDurationMs', label: '首次停留时长(毫秒)' },
    { id: 'avgVisitDurationMs', label: '平均停留时长(毫秒)' },
    { id: 'visits', label: '访问次数' },
    { id: 'revisitCount', label: '回看次数' },
    { id: 'reVisitorCount', label: '回看人数' },
    { id: 'firstVisitFixationCount', label: '首次停留注视次数' },
    { id: 'firstVisitFixationDurationMs', label: '首次停留注视时长(毫秒)' },
  ];
  const saccadeMetricOptions: Array<{ id: SaccadeMetric; label: string }> = [
    { id: 'saccadeCount', label: '眼跳次数' },
    { id: 'totalSaccadeDurationMs', label: '总眼跳时长(毫秒)' },
    { id: 'avgSaccadeDurationMs', label: '平均眼跳时长(毫秒)' },
    { id: 'avgSaccadeVelocity', label: '平均眼跳速度(px/ms)' },
    { id: 'avgSaccadeAmplitude', label: '平均眼跳幅度(px)' },
    { id: 'peakSaccadeVelocity', label: '眼跳速度峰值(px/ms)' },
  ];

  const [fixationMetric, setFixationMetric] = React.useState<FixationMetric>('fixationCount');
  const [visitMetric, setVisitMetric] = React.useState<VisitMetric>('totalVisitDurationMs');
  const [saccadeMetric, setSaccadeMetric] = React.useState<SaccadeMetric>('saccadeCount');
  const [pupilEye, setPupilEye] = React.useState<PupilEye>('left');
  const [reportMode, setReportMode] = React.useState<'single' | 'compare'>(chartMode);
  const [singleAiReport, setSingleAiReport] = React.useState<SingleRecordAiReport | null>(null);
  const [singleAiLoading, setSingleAiLoading] = React.useState(false);
  const [singleAiVisible, setSingleAiVisible] = React.useState(false);
  const [isExportingBundle, setIsExportingBundle] = React.useState(false);
  const fixationChartRef = React.useRef<HTMLDivElement | null>(null);
  const visitChartRef = React.useRef<HTMLDivElement | null>(null);
  const saccadeChartRef = React.useRef<HTMLDivElement | null>(null);
  const pupilChartRef = React.useRef<HTMLDivElement | null>(null);
  const notify = React.useCallback((message: string) => {
    if (onNotify) onNotify(message);
  }, [onNotify]);

  const recordAoiScopeId = React.useCallback((recordId: string): string => `record:${recordId}`, []);

  React.useEffect(() => {
    setReportMode(chartMode);
  }, [chartMode]);

  React.useEffect(() => {
    if (!preferredRecordId) return;
    if (!records.some((record) => record.id === preferredRecordId)) return;
    if (lastAppliedPreferredRecordIdRef.current === preferredRecordId) return;
    lastAppliedPreferredRecordIdRef.current = preferredRecordId;
    setSelectedRecordId(preferredRecordId);
  }, [preferredRecordId, records]);

  const switchReportMode = React.useCallback(
    (mode: 'single' | 'compare') => {
      if (mode === reportMode) return;
      setReportMode(mode);
      onChartModeChange?.(mode);
    },
    [reportMode, onChartModeChange],
  );

  React.useEffect(() => {
    if (!records.find((r) => r.id === selectedRecordId)) {
      setSelectedRecordId(records[0]?.id || '');
    }
  }, [records, selectedRecordId]);

  const loadSavedSingleAiReport = React.useCallback(
    async (showEmptyHint: boolean) => {
      if (!projectDir || !selectedRecordId || !ipcClient.isAvailable()) {
        setSingleAiReport(null);
        return;
      }
      try {
        const res = await ipcClient.loadSingleRecordAiReport({
          projectDir,
          recordId: selectedRecordId,
        });
        if (res.ok && res.report) {
          setSingleAiReport(res.report);
          if (showEmptyHint) notify('已加载历史 AI 分析记录');
        } else {
          setSingleAiReport(null);
          if (showEmptyHint) notify('当前记录暂无历史 AI 分析记录');
        }
      } catch {
        setSingleAiReport(null);
        if (showEmptyHint) notify('历史 AI 分析记录加载失败');
      }
    },
    [projectDir, selectedRecordId, notify],
  );

  React.useEffect(() => {
    setSingleAiVisible(false);
    void loadSavedSingleAiReport(false);
  }, [loadSavedSingleAiReport]);

  React.useEffect(() => {
    if (!ipcClient.isAvailable()) return;
    if (!records || records.length === 0) {
      setRecordMetricsById({});
      setRecordMetricsLoading(false);
      return;
    }

    let cancelled = false;
    setRecordMetricsLoading(true);
    setRecordMetricsById({});

    const computeFromPoints = (pts: HeatmapPoint[]) => {
      const sorted = [...pts].sort((a, b) => {
        const ta = typeof a.timestamp === 'number' && Number.isFinite(a.timestamp) ? a.timestamp : 0;
        const tb = typeof b.timestamp === 'number' && Number.isFinite(b.timestamp) ? b.timestamp : 0;
        return ta - tb;
      });
      const count = sorted.length;
      let durationMs = 0;
      const firstTs = sorted.find((p) => typeof p.timestamp === 'number' && Number.isFinite(p.timestamp))?.timestamp;
      const lastTs =
        [...sorted]
          .reverse()
          .find((p) => typeof p.timestamp === 'number' && Number.isFinite(p.timestamp))?.timestamp ?? undefined;
      if (typeof firstTs === 'number' && typeof lastTs === 'number') {
        durationMs = Math.max(0, Math.round(lastTs - firstTs));
      }
      if (durationMs <= 0) {
        durationMs = Math.max(
          0,
          Math.round(
            sorted.reduce((acc, p) => {
              const w = typeof p.weight === 'number' && Number.isFinite(p.weight) ? p.weight : 0;
              return acc + w;
            }, 0),
          ),
        );
      }
      return { durationMs, pointCount: count };
    };

    const queue = records
      .filter((r) => !!r.csvPath)
      .map((r) => r.id);

    const worker = async () => {
      while (!cancelled) {
        const nextId = queue.shift();
        if (!nextId) break;
        const record = records.find((r) => r.id === nextId);
        const csvPath = record?.csvPath;
        if (!csvPath) {
          setRecordMetricsById((prev) => ({ ...prev, [nextId]: { durationMs: 0, pointCount: 0 } }));
          continue;
        }
        try {
          const res = await ipcClient.loadRecordPoints({
            csvPath,
            pointMode: 'fixation',
            includeSdkSaccades: true,
            isGlassesMode: record?.deviceType === '眼镜式',
            ...getRecordingFrameSizeOptions(record),
          });
          if (cancelled) break;
          if (res && res.ok && Array.isArray(res.points)) {
            const pts = res.points as HeatmapPoint[];
            const metrics = computeFromPoints(pts);
            setRecordMetricsById((prev) => ({ ...prev, [nextId]: metrics }));
          } else {
            setRecordMetricsById((prev) => ({ ...prev, [nextId]: { durationMs: 0, pointCount: 0 } }));
          }
        } catch {
          if (!cancelled) setRecordMetricsById((prev) => ({ ...prev, [nextId]: { durationMs: 0, pointCount: 0 } }));
        }
      }
    };

    Promise.all([worker(), worker()]).finally(() => {
      if (!cancelled) setRecordMetricsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [records]);

  React.useEffect(() => {
    if (!projectDir || !ipcClient.isAvailable()) return;
    let cancelled = false;
    (async () => {
      const res = await ipcClient.loadAoi({ projectDir });
      if (cancelled) return;
      const store = res?.ok ? parseAoiStore(res.data) : null;
      setAoiStore({ byRecordId: store?.byRecordId ?? {} });
    })().catch(() => {
      if (!cancelled) setAoiStore({ byRecordId: {} });
    });
    return () => {
      cancelled = true;
    };
  }, [projectDir]);

  React.useEffect(() => {
    if (!selectedRecordId) return;
    if (pointsByRecordId[selectedRecordId] && typeof csvTextByRecordId[selectedRecordId] === 'string') return;
    const record = records.find((r) => r.id === selectedRecordId);
    const csvPath = record?.csvPath;
    if (!csvPath || !ipcClient.isAvailable()) return;

    let cancelled = false;
    setAoiReportLoading(true);
    setAoiReportError(null);
    (async () => {
      try {
        const res = await ipcClient.loadRecordPoints({
          csvPath,
          pointMode: 'fixation',
          includePupilSamples: true,
          includeSdkSaccades: true,
          isGlassesMode: record?.deviceType === '眼镜式',
          ...getRecordingFrameSizeOptions(record),
        });
        if (cancelled) return;
        if (res && res.ok && Array.isArray(res.points)) {
          const pts = [...res.points, ...(res.pupilSamples || [])] as HeatmapPoint[];
          setPointsByRecordId((prev) => ({ ...prev, [selectedRecordId]: pts }));
          setBlinkDataByRecordId((prev) => ({ ...prev, [selectedRecordId]: res.blinkData }));
          setCsvTextByRecordId((prev) => ({ ...prev, [selectedRecordId]: '' }));
        } else {
          setAoiReportError(res && 'message' in res && res.message ? res.message : '数据文件加载失败');
          setPointsByRecordId((prev) => ({ ...prev, [selectedRecordId]: [] }));
          setCsvTextByRecordId((prev) => ({ ...prev, [selectedRecordId]: '' }));
        }
      } catch {
        if (!cancelled) {
          setAoiReportError('数据文件读取异常');
          setPointsByRecordId((prev) => ({ ...prev, [selectedRecordId]: [] }));
          setCsvTextByRecordId((prev) => ({ ...prev, [selectedRecordId]: '' }));
        }
      } finally {
        if (!cancelled) setAoiReportLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedRecordId, records, pointsByRecordId, csvTextByRecordId]);

  const normalizeStimulusKey = React.useCallback((value: string): string => {
    return String(value || '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLocaleLowerCase();
  }, []);

  const stimulusNameById = React.useMemo(() => {
    const map = new Map<string, string>();
    stimuli.forEach((stimulus) => {
      const id = String(stimulus?.id || '').trim();
      const name = String(stimulus?.name || '').trim();
      if (id && name) map.set(id, name);
    });
    return map;
  }, [stimuli]);

  const stimulusIdByName = React.useMemo(() => {
    const map = new Map<string, string>();
    stimuli.forEach((stimulus) => {
      const id = String(stimulus?.id || '').trim();
      const name = String(stimulus?.name || '').trim();
      if (id && name && !map.has(name)) map.set(name, id);
    });
    return map;
  }, [stimuli]);

  const stimulusIdByNormalizedName = React.useMemo(() => {
    const map = new Map<string, string>();
    stimuli.forEach((stimulus) => {
      const id = String(stimulus?.id || '').trim();
      const name = String(stimulus?.name || '').trim();
      const normalizedName = normalizeStimulusKey(name);
      if (id && normalizedName && !map.has(normalizedName)) {
        map.set(normalizedName, id);
      }
    });
    return map;
  }, [normalizeStimulusKey, stimuli]);

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
          if (!normalizedName || normalizedName.length < 2) continue;
          if (normalizedToken.includes(normalizedName)) return id;
        }
      }
      return '';
    },
    [normalizeStimulusKey, stimulusIdByName, stimulusIdByNormalizedName, stimulusNameById],
  );

  const selectedRecord = React.useMemo(
    () => records.find((record) => record.id === selectedRecordId) || null,
    [records, selectedRecordId],
  );
  const selectedRecordIsGlasses = selectedRecord?.deviceType === '眼镜式';
  const pointsForRecord = pointsByRecordId[selectedRecordId] || [];
  const shapesForRecord = React.useMemo(() => {
    const store = aoiStore.byRecordId || {};
    const scopedRecordKey = selectedRecordId ? recordAoiScopeId(selectedRecordId) : '';
    const fromScopedRecord = scopedRecordKey && Array.isArray(store[scopedRecordKey]) ? (store[scopedRecordKey] as NormalizedAoiShape[]) : [];
    if (fromScopedRecord.length > 0) {
      return fromScopedRecord;
    }

    const fromLegacyRecord = Array.isArray(store[selectedRecordId]) ? (store[selectedRecordId] as NormalizedAoiShape[]) : [];
    if (fromLegacyRecord.length > 0) {
      return fromLegacyRecord;
    }

    if (selectedRecordIsGlasses) {
      return [];
    }

    const points = Array.isArray(pointsForRecord) ? pointsForRecord : [];
    const stimulusIds = new Set<string>();
    points.forEach((point) => {
      const stimulusId = resolveStimulusId(point?.stimulusName);
      if (stimulusId) stimulusIds.add(stimulusId);
    });

    const merged: NormalizedAoiShape[] = [];
    const seen = new Set<string>();
    stimulusIds.forEach((stimulusId) => {
      const shapes = Array.isArray(store[stimulusId]) ? (store[stimulusId] as NormalizedAoiShape[]) : [];
      shapes.forEach((shape) => {
        const dedupeKey = `${stimulusId}::${shape.id}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        merged.push(shape);
      });
    });
    if (merged.length > 0) return merged;

    return [];
  }, [aoiStore.byRecordId, pointsForRecord, recordAoiScopeId, resolveStimulusId, selectedRecordId, selectedRecordIsGlasses]);

  const selectedBlinkData = blinkDataByRecordId[selectedRecordId];
  const selectedBlinkSummary = React.useMemo(() => selectedBlinkData?.intervals.length
    ? summarizeBlinkIntervals(selectedBlinkData.intervals) : null, [selectedBlinkData]);

  const selectedRecordDurationMs = selectedRecordId ? recordMetricsById[selectedRecordId]?.durationMs || 0 : 0;

  const statsRows = React.useMemo(() => {
    if (!selectedRecordId) return [];
    const store = aoiStore.byRecordId || {};
    const scopedRecordKey = recordAoiScopeId(selectedRecordId);
    const scopedRecordShapes = Array.isArray(store[scopedRecordKey]) ? (store[scopedRecordKey] as NormalizedAoiShape[]) : null;
    const legacyRecordShapes = Array.isArray(store[selectedRecordId]) ? (store[selectedRecordId] as NormalizedAoiShape[]) : null;
    const recordScopedShapes = scopedRecordShapes && scopedRecordShapes.length > 0 ? scopedRecordShapes : legacyRecordShapes;

    if (recordScopedShapes && recordScopedShapes.length > 0) {
      return computeAoiStatsRows({
        shapes: recordScopedShapes,
        points: Array.isArray(pointsForRecord) ? pointsForRecord : [],
        recordDurationMs: selectedRecordDurationMs,
        timeOffsetMs,
        frameWidth: selectedRecord?.videoWidth,
        blinkData: blinkDataByRecordId[selectedRecordId],
      });
    }

    if (selectedRecordIsGlasses) {
      return [];
    }

    const points = Array.isArray(pointsForRecord) ? pointsForRecord : [];
    const pointsByStimulusId = new Map<string, HeatmapPoint[]>();
    points.forEach((point) => {
      const stimulusId = resolveStimulusId(point?.stimulusName);
      if (!stimulusId) return;
      const list = pointsByStimulusId.get(stimulusId) || [];
      list.push(point);
      pointsByStimulusId.set(stimulusId, list);
    });

    const rows: ReturnType<typeof computeAoiStatsRows> = [];
    Object.entries(store).forEach(([rawKey, value]) => {
      if (!Array.isArray(value) || value.length === 0) return;
      const stimulusId = resolveStimulusId(rawKey);
      if (!stimulusId) return;

      const scopedRows = computeAoiStatsRows({
        shapes: value as NormalizedAoiShape[],
        points: pointsByStimulusId.get(stimulusId) || [],
        recordDurationMs: selectedRecordDurationMs,
        timeOffsetMs,
        frameWidth: selectedRecord?.videoWidth,
        blinkData: blinkDataByRecordId[selectedRecordId],
      }).map((row) => ({
        ...row,
        // Avoid duplicate row keys when AOI ids are reused across different stimuli.
        aoiId: `${stimulusId}::${row.aoiId}`,
      }));
      rows.push(...scopedRows);
    });

    if (rows.length > 0) return rows;

    return [];
  }, [
    aoiStore.byRecordId,
    blinkDataByRecordId,
    pointsForRecord,
    recordAoiScopeId,
    resolveStimulusId,
    selectedRecordDurationMs,
    selectedRecordId,
    selectedRecordIsGlasses,
    timeOffsetMs,
  ]);

  type SeriesItem = { id: string; name: string; value: number; colorHex: string };
  type PupilPoint = { t: number; v: number };
  type PupilTrend = {
    samples: PupilPoint[];
    sampleCount: number;
    min: number | null;
    max: number | null;
    avg: number | null;
    startMs: number | null;
    endMs: number | null;
    hasTimestamp: boolean;
  };

  const formatValue = (metric: FixationMetric | VisitMetric | SaccadeMetric, v: number | null): string => {
    if (v === null || !Number.isFinite(v)) return '-';
    if (metric === 'avgSaccadeVelocity' || metric === 'avgSaccadeAmplitude' || metric === 'peakSaccadeVelocity') {
      return v.toFixed(3);
    }
    return String(Math.round(v));
  };

  const formatPupilValue = (v: number | null): string => {
    if (v === null || !Number.isFinite(v)) return '-';
    return v.toFixed(2);
  };

  const formatTimelineLabel = (ms: number | null): string => {
    if (ms === null || !Number.isFinite(ms)) return '-';
    if (Math.abs(ms) >= 1000) return isEn ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 1000).toFixed(1)}秒`;
    return isEn ? `${Math.round(ms)} ms` : `${Math.round(ms)}毫秒`;
  };

  const buildSeries = (
    rows: typeof statsRows,
    valueOf: (row: (typeof statsRows)[number]) => number,
  ): SeriesItem[] => {
    return (rows || [])
      .map((row) => {
        const raw = valueOf(row);
        const value = Number.isFinite(raw) ? raw : 0;
        const colorHex = /^#[0-9a-f]{6}$/iu.test(String(row.color || ''))
          ? row.color
          : aoiColorDefs[row.color]?.border || aoiColorDefs.sky?.border || '#38bdf8';
        return { id: row.aoiId, name: row.name, value, colorHex } satisfies SeriesItem;
      })
      .sort((a, b) => b.value - a.value);
  };

  const topWithOther = (series: SeriesItem[], limit: number): SeriesItem[] => {
    if (series.length <= limit) return series;
    const head = series.slice(0, limit);
    const other = series.slice(limit).reduce((acc, it) => acc + (Number.isFinite(it.value) ? it.value : 0), 0);
    if (other <= 0) return head;
    return [
      ...head,
      { id: '__other__', name: language === 'en-US' ? 'Other' : '其他', value: other, colorHex: '#94a3b8' },
    ];
  };

  const actionButtonClass =
    'px-3 py-1.5 text-xs font-bold rounded-md border border-sky-200 text-sky-600 bg-sky-50 hover:bg-sky-100 disabled:opacity-50';
  const modeSwitchButtonClass = (active: boolean) =>
    active
      ? 'px-3 py-1.5 text-xs font-bold rounded-md border border-sky-200 text-sky-600 bg-sky-50 shadow-sm'
      : 'px-3 py-1.5 text-xs font-bold rounded-md border border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-100';

  const fixationSeries = React.useMemo(() => {
    return buildSeries(statsRows, (row) => {
      if (fixationMetric === 'firstEnterTimeMs') return row.firstEnterTimeMs ?? 0;
      return row[fixationMetric] ?? 0;
    });
  }, [statsRows, fixationMetric, aoiColorDefs]);

  const visitSeries = React.useMemo(() => {
    return buildSeries(statsRows, (row) => row[visitMetric] ?? 0);
  }, [statsRows, visitMetric, aoiColorDefs]);

  const saccadeSeries = React.useMemo(() => {
    return buildSeries(statsRows.filter((row) => row[saccadeMetric] !== null), (row) => row[saccadeMetric] ?? 0);
  }, [statsRows, saccadeMetric, aoiColorDefs]);

  const fixationMetricLabel = translateTextForLanguage(
    fixationMetricOptions.find((opt) => opt.id === fixationMetric)?.label ?? '指标值',
    language,
  );
  const visitMetricLabel = translateTextForLanguage(
    visitMetricOptions.find((opt) => opt.id === visitMetric)?.label ?? '指标值',
    language,
  );
  const saccadeMetricLabel = translateTextForLanguage(
    saccadeMetricOptions.find((opt) => opt.id === saccadeMetric)?.label ?? '指标值',
    language,
  );
  const pupilEyeLabel = isEn ? (pupilEye === 'left' ? 'Left eye' : 'Right eye') : (pupilEye === 'left' ? '左眼' : '右眼');

  const pupilTrend = React.useMemo<PupilTrend>(() => {
    const pupilSourcePoints = pointsForRecord.some((point) => point.sampleOnly || point.pupilSamplesIncluded)
      ? pointsForRecord.filter((point) => point.sampleOnly) : pointsForRecord;
    const valid = pupilSourcePoints
      .map((point, index) => {
        const value = pupilEye === 'left' ? point?.leftPupilDiameter : point?.rightPupilDiameter;
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
        const ts = point?.timestamp;
        const hasTimestamp = typeof ts === 'number' && Number.isFinite(ts);
        return {
          t: hasTimestamp ? (ts as number) : index,
          v: value,
          hasTimestamp,
        };
      })
      .filter((item): item is { t: number; v: number; hasTimestamp: boolean } => item !== null)
      .sort((a, b) => a.t - b.t);

    if (valid.length === 0) {
      return {
        samples: [],
        sampleCount: 0,
        min: null,
        max: null,
        avg: null,
        startMs: null,
        endMs: null,
        hasTimestamp: false,
      };
    }

    const values = valid.map((item) => item.v);
    const min = values.reduce((a, b) => Math.min(a, b), Infinity);
    const max = values.reduce((a, b) => Math.max(a, b), -Infinity);
    const avg = values.reduce((acc, v) => acc + v, 0) / values.length;
    const sampleLimit = 180;
    let samples: PupilPoint[] = [];

    if (valid.length <= sampleLimit) {
      samples = valid.map((item) => ({ t: item.t, v: item.v }));
    } else {
      const step = (valid.length - 1) / (sampleLimit - 1);
      for (let i = 0; i < sampleLimit; i += 1) {
        const idx = Math.min(valid.length - 1, Math.round(i * step));
        const item = valid[idx];
        if (!item) continue;
        const prev = samples[samples.length - 1];
        if (prev && prev.t === item.t && prev.v === item.v) continue;
        samples.push({ t: item.t, v: item.v });
      }
      const tail = valid[valid.length - 1];
      const latest = samples[samples.length - 1];
      if (!latest || latest.t !== tail.t || latest.v !== tail.v) {
        samples.push({ t: tail.t, v: tail.v });
      }
    }

    return {
      samples,
      sampleCount: valid.length,
      min,
      max,
      avg,
      startMs: valid[0]?.t ?? null,
      endMs: valid[valid.length - 1]?.t ?? null,
      hasTimestamp: valid.some((item) => item.hasTimestamp),
    };
  }, [pointsForRecord, pupilEye]);

  const handleAnalyzeSingleRecordWithAi = React.useCallback(async () => {
    if (!projectDir) {
      notify('未检测到工程目录');
      return;
    }
    const record = records.find((item) => item.id === selectedRecordId);
    if (!record) {
      notify('请先选择记录');
      return;
    }

    if (singleAiReport?.recordId === selectedRecordId) {
      setSingleAiVisible(true);
      return;
    }

    if (ipcClient.isAvailable()) {
      try {
        const saved = await ipcClient.loadSingleRecordAiReport({
          projectDir,
          recordId: selectedRecordId,
        });
        if (saved.ok && saved.report) {
          setSingleAiReport(saved.report);
          setSingleAiVisible(true);
          return;
        }
      } catch {
        // Continue with a fresh analysis when the saved-report lookup fails.
      }
    }

    const rawPoints = (pointsByRecordId[selectedRecordId] || pointsForRecord || []).filter((point) => !point.sampleOnly);
    if (rawPoints.length === 0) {
      notify('当前记录暂无可分析的注视点');
      return;
    }
    const rawCsvText = String(csvTextByRecordId[selectedRecordId] || '');

    setSingleAiLoading(true);
    onAiBusyChange?.(true, 'AI 单记录分析生成中...');
    try {
      const res = await ipcClient.runAiAnalysis({
        mode: 'single',
        projectDir,
        outputLanguage: language,
        input: {
          record: {
            recordId: record.id,
            recordName: getDisplayRecordName(record),
            subjectName: record.subjectName || '',
            timestamp: record.timestamp || '',
            validityPercent: record.validityPercent ?? null,
            samplingRateHz: record.samplingRateHz ?? null,
            durationSeconds: record.durationSeconds ?? null,
          },
          aoiStats: statsRows,
          fixationRanking: fixationSeries.slice(0, 10),
          visitRanking: visitSeries.slice(0, 10),
          saccadeRanking: saccadeSeries.slice(0, 10),
          blinkSummary: selectedBlinkSummary ? { ...selectedBlinkSummary,
            countPolicy: 'complete source intervals, per eye or unspecified; onset in half-open window',
            spatialAssignment: 'unlocalized', unpairedPhaseCount: selectedBlinkData?.unpairedPhaseCount || 0,
          } : null,
          pupilSummary: {
            eye: pupilEye,
            sampleCount: pupilTrend.sampleCount,
            min: pupilTrend.min,
            avg: pupilTrend.avg,
            max: pupilTrend.max,
            startMs: pupilTrend.startMs,
            endMs: pupilTrend.endMs,
          },
          rawPoints,
          rawCsvText,
          rawFile: {
            recordId: record.id,
            recordName: getDisplayRecordName(record),
            filePath: record.csvPath || '',
          },
        },
      });

      if (!res.ok) {
        const message = 'message' in res ? res.message : '';
        notify(`AI 分析失败：${message || '未知错误'}`);
        return;
      }

      if (res.report) {
        setSingleAiReport(res.report);
      } else {
        setSingleAiReport({
          id: `single_ai_${Date.now()}`,
          createdAt: new Date().toISOString(),
          recordId: record.id,
          recordName: getDisplayRecordName(record),
          subjectName: record.subjectName || '',
          provider: res.provider,
          model: res.model,
          compression: res.compression,
          usage: res.usage,
          result: res.result,
        });
      }
      setSingleAiVisible(true);
      notify(res.retriedByAggressiveCompression ? '单记录 AI 分析已生成（超时后自动压缩重试）' : '单记录 AI 分析已生成');
    } catch (error: unknown) {
      notify(`AI 分析异常：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setSingleAiLoading(false);
      onAiBusyChange?.(false, '');
    }
  }, [
    projectDir,
    notify,
    records,
    selectedRecordId,
    singleAiReport,
    pointsByRecordId,
    csvTextByRecordId,
    pointsForRecord,
    statsRows,
    fixationSeries,
    visitSeries,
    saccadeSeries,
    pupilEye,
    pupilTrend,
    selectedBlinkData,
    selectedBlinkSummary,
    language,
    onAiBusyChange,
  ]);

  const sanitizeExportName = React.useCallback((rawName: string): string => {
    const safe = String(rawName || '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
    return safe || 'aoi-report';
  }, []);

  const formatExportCsvCell = React.useCallback((value: unknown): unknown => {
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
  }, []);

  const csvEscape = React.useCallback((value: unknown): string => {
    const formatted = formatExportCsvCell(value);
    const text = formatted === null || formatted === undefined ? '' : String(formatted);
    if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  }, [formatExportCsvCell]);

  const buildStatsCsvContent = React.useCallback((): string => {
    const orderedRows = statsRows.slice().sort((a, b) => b.totalDurationMs - a.totalDurationMs);
    const columns: Array<{ label: string; pick: (row: (typeof orderedRows)[number]) => string | number | null }> = [
      { label: '兴趣区', pick: (row) => row.name },
      { label: '类型', pick: (row) => row.type },
      { label: '注视次数', pick: (row) => row.fixationCount },
      { label: '首次注视前时长(毫秒)', pick: (row) => row.firstEnterTimeMs ?? '' },
      { label: '首次注视前次数', pick: (row) => row.fixationCountPreEntry },
      { label: '首次注视时长(毫秒)', pick: (row) => row.firstFixationDurationMs },
      { label: '总注视时长(毫秒)', pick: (row) => row.totalDurationMs },
      { label: '平均注视时长(毫秒)', pick: (row) => row.avgDurationMs },
      { label: '最大注视时长(毫秒)', pick: (row) => row.maxFixationDurationMs },
      { label: '最短浏览时间(毫秒)', pick: (row) => row.minFixationDurationMs },
      { label: '第二次注视时间(毫秒)', pick: (row) => row.secondFixationDurationMs },
      { label: '回视时间(毫秒)', pick: (row) => row.regressionDurationMs },
      { label: '长注视次数', pick: (row) => row.longFixationCount },
      { label: '注视人数', pick: (row) => row.visitorCount },
      { label: '访问次数', pick: (row) => row.visits },
      { label: '总停留时长(毫秒)', pick: (row) => row.totalVisitDurationMs },
      { label: '首次停留时长(毫秒)', pick: (row) => row.firstVisitDurationMs },
      { label: '首次停留注视次数', pick: (row) => row.firstVisitFixationCount },
      { label: '首次停留注视时长(毫秒)', pick: (row) => row.firstVisitFixationDurationMs },
      { label: '平均停留时长(毫秒)', pick: (row) => row.avgVisitDurationMs },
      { label: '回看次数', pick: (row) => row.revisitCount },
      { label: '回看人数', pick: (row) => row.reVisitorCount },
      { label: '眼跳次数', pick: (row) => row.saccadeCount },
      { label: '总眼跳时长(毫秒)', pick: (row) => row.totalSaccadeDurationMs },
      { label: '平均眼跳时长(毫秒)', pick: (row) => row.avgSaccadeDurationMs },
      { label: '平均眼跳速度(px/ms)', pick: (row) => formatValue('avgSaccadeVelocity', row.avgSaccadeVelocity) },
      { label: '平均眼跳幅度(px)', pick: (row) => formatValue('avgSaccadeAmplitude', row.avgSaccadeAmplitude) },
      { label: '眼跳速度峰值(px/ms)', pick: (row) => formatValue('peakSaccadeVelocity', row.peakSaccadeVelocity) },
      { label: '平均瞳孔直径', pick: (row) => (row.avgPupilDiameter !== null ? row.avgPupilDiameter.toFixed(2) : '') },
    ];

    const lines = [
      columns.map((column) => csvEscape(column.label)).join(','),
      ...orderedRows.map((row) => columns.map((column) => csvEscape(column.pick(row))).join(',')),
    ];
    return `\uFEFF${lines.join('\n')}`;
  }, [csvEscape, statsRows]);

  const handleExportBundle = React.useCallback(async () => {
    if (isExportingBundle) return;
    if (!selectedRecordId) {
      notify('请先选择记录');
      return;
    }
    if (statsRows.length === 0) {
      notify('暂无可导出的表格数据');
      return;
    }
    if (!ipcClient.isAvailable()) {
      notify('当前环境不支持导出（IPC 不可用）');
      return;
    }

    const selectedRecord = records.find((record) => record.id === selectedRecordId);
    const selectedRecordName = sanitizeExportName(
      selectedRecord ? getDisplayRecordName(selectedRecord) : selectedRecordId || 'record',
    );
    const baseName = sanitizeExportName(`aoi_report_${selectedRecordName}_${Date.now()}`);
    const csvContent = buildStatsCsvContent();
    const chartDefs = [
      { key: 'fixation', title: `注视_${fixationMetricLabel}`, ref: fixationChartRef },
      { key: 'visit', title: `访问_${visitMetricLabel}`, ref: visitChartRef },
      { key: 'saccade', title: `眼跳_${saccadeMetricLabel}`, ref: saccadeChartRef },
      { key: 'pupil', title: `瞳孔曲线_${pupilEyeLabel}`, ref: pupilChartRef },
    ];
    const charts = chartDefs
      .map((item) => {
        const element = item.ref.current;
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width < 2 || rect.height < 2) return null;
        return {
          fileName: sanitizeExportName(`${item.key}_${item.title}.png`),
          rect: {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
          },
        };
      })
      .filter((item): item is { fileName: string; rect: { x: number; y: number; width: number; height: number } } => item !== null);
    if (charts.length === 0) {
      notify('未找到可导出的图表，请稍后重试');
      return;
    }

    setIsExportingBundle(true);
    try {
      const saveRes = await ipcClient.exportChartReportBundle({
        baseName,
        csvFileName: `${baseName}.csv`,
        csvContent,
        charts,
      });
      if (saveRes.ok) {
        if (saveRes.failed.length > 0) {
          notify(`导出完成：成功 ${saveRes.files.length} 个，失败 ${saveRes.failed.length} 个`);
        } else {
          notify(`导出成功：共 ${saveRes.files.length} 个文件`);
        }
      } else {
        const message = 'message' in saveRes ? saveRes.message : '';
        if (message && message.includes('已取消')) return;
        notify(`导出失败：${message || '未知错误'}`);
      }
    } catch (error: unknown) {
      notify(`导出异常：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setIsExportingBundle(false);
    }
  }, [
    buildStatsCsvContent,
    fixationMetricLabel,
    isExportingBundle,
    notify,
    pupilEyeLabel,
    records,
    saccadeMetricLabel,
    sanitizeExportName,
    selectedRecordId,
    statsRows.length,
    visitMetricLabel,
  ]);

  if (reportMode === 'compare') {
    return (
      <div className="h-full flex flex-col gap-4 overflow-y-auto pr-1 pb-4">
        <div className="bg-white rounded-2xl border border-slate-200 px-5 py-4 flex items-center justify-between shadow-sm">
          <div>
            <div className="text-[10px] font-bold text-slate-400 tracking-widest">统计报表</div>
            <div className="text-sm font-semibold text-slate-800">多记录对比与洞察生成</div>
          </div>
          <div className="inline-flex shrink-0 gap-2 rounded-lg border border-slate-200 p-1 bg-slate-50">
            <button
              type="button"
              onClick={() => switchReportMode('single')}
              aria-pressed={false}
              className={modeSwitchButtonClass(false)}
            >
              单记录深挖
            </button>
            <button
              type="button"
              aria-pressed={true}
              className={modeSwitchButtonClass(true)}
            >
              多记录对比
            </button>
          </div>
        </div>

        <CompareModePanel
          records={records}
          stimuli={stimuli}
          projectDir={projectDir}
          preselectedRecordIds={chartPreselectedRecordIds}
          onNotify={onNotify}
          aiBusy={aiBusy}
          aiBusyText={aiBusyText}
          onAiBusyChange={onAiBusyChange}
          onCompareResultChange={onCompareResultChange}
          onInsightGenerated={onInsightGenerated}
        />
      </div>
    );
  }

  return (
    <div className="relative h-full flex flex-col gap-4 overflow-y-auto pr-1 pb-4">
      <div className="bg-white rounded-2xl border border-slate-200 px-5 py-4 flex items-center justify-between shadow-sm">
        <div>
          <div className="text-[10px] font-bold text-slate-400 tracking-widest">统计报表</div>
          <div className="text-sm font-semibold text-slate-800">兴趣区注视统计与记录综合分析</div>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-slate-500">
          <div className="flex items-center gap-2 border border-slate-200 rounded-lg px-2 py-1">
            <span className="text-[10px] font-bold text-slate-500">记录</span>
            <CustomSelect
              value={selectedRecordId}
              onChange={(e) => setSelectedRecordId(e.target.value)}
              fullWidth={false}
              truncateOptionLabel={false}
              className="text-[10px] !bg-transparent outline-none border-0 rounded-none shadow-none focus:ring-0 focus:border-transparent text-slate-600 font-bold whitespace-nowrap !w-[150px] min-w-[150px] max-w-[150px]"
            >
              {records.map((r, idx) => (
                <option key={r.id} value={r.id}>
                  {getDisplayRecordName(r) || `记录${idx + 1}`}
                </option>
              ))}
            </CustomSelect>
          </div>
          <span className="px-2 py-1 rounded bg-slate-100">兴趣区数量 {shapesForRecord.length}</span>
          <span className="px-2 py-1 rounded bg-slate-100">点数 {pointsForRecord.length}</span>
          <span className="px-2 py-1 rounded bg-slate-100">记录数 {records.length}</span>
          <button
            type="button"
            onClick={() => {
              void handleAnalyzeSingleRecordWithAi();
            }}
            disabled={singleAiLoading || aiBusy}
            className={actionButtonClass}
          >
            {singleAiLoading || aiBusy ? 'AI分析中...' : 'AI分析'}
          </button>
          <button
            type="button"
            onClick={() => {
              void handleExportBundle();
            }}
            disabled={isExportingBundle || aoiReportLoading || statsRows.length === 0}
            className={actionButtonClass}
          >
            {isExportingBundle ? '导出中...' : '导出'}
          </button>
          <div className="inline-flex shrink-0 gap-2 rounded-lg border border-slate-200 p-1 bg-slate-50">
            <button
              type="button"
              aria-pressed={true}
              className={modeSwitchButtonClass(true)}
            >
              单记录深挖
            </button>
            <button
              type="button"
              onClick={() => switchReportMode('compare')}
              aria-pressed={false}
              className={modeSwitchButtonClass(false)}
            >
              多记录对比
            </button>
          </div>
        </div>
      </div>

      {selectedBlinkData ? (
        <div className="text-xs text-slate-500 px-2">
          {isEn ? 'Complete blink intervals (per eye): ' : '完整眨眼区间（按眼计）：'}
          {selectedBlinkSummary
            ? `${selectedBlinkSummary.onsetCount} · ${isEn ? 'full duration sum' : '完整时长合计'} ${selectedBlinkSummary.overlapDurationMs.toFixed(1)} ms`
            : isEn ? 'No complete pair observed; count unavailable' : '未观察到完整配对，次数缺失'}
          {' · '}{isEn ? 'No spatial position; unassigned to AOIs' : '源区间无空间位置，未分配到 AOI'}
          {selectedBlinkData.unpairedPhaseCount > 0 ? ` · ${isEn ? 'unpaired phases' : '未配对阶段'} ${selectedBlinkData.unpairedPhaseCount}` : ''}
        </div>
      ) : null}

      {aiBusy ? (
        <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-600">
          {aiBusyText || 'AI 任务后台执行中，切换页面不会中断。'}
        </div>
      ) : null}

      {singleAiVisible && singleAiReport?.recordId === selectedRecordId ? (
        <section className="absolute inset-0 z-40 flex min-h-0 flex-col overflow-hidden rounded-2xl border border-sky-200 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.22)]">
          <div className="flex items-center justify-between gap-4 border-b border-sky-100 bg-sky-50/60 px-5 py-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-500 text-white shadow-sm">
                <Sparkles size={17} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-bold text-slate-800">AI 单记录解读</h2>
                  <span className="rounded-full border border-sky-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-sky-600">
                    分析完成
                  </span>
                </div>
                <p className="truncate text-xs text-slate-500" data-i18n-skip="true">
                  {singleAiReport.recordName}
                  {singleAiReport.subjectName ? ` · ${singleAiReport.subjectName}` : ''}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-4">
              <div className="hidden items-center gap-4 text-[11px] text-slate-500 xl:flex">
                <span className="flex items-center gap-1.5" data-i18n-skip="true">
                  <Database size={13} />
                  {singleAiReport.compression.retainedPointCount}/{singleAiReport.compression.inputPointCount} 点
                </span>
                <span className="flex items-center gap-1.5" data-i18n-skip="true">
                  <Clock3 size={13} />
                  {new Date(singleAiReport.createdAt).toLocaleString()}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSingleAiVisible(false)}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
                aria-label="关闭 AI 单记录解读"
                title="关闭"
              >
                <X size={15} />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="space-y-5 p-5">
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)]">
                <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                  <div className="mb-3 flex items-center gap-2 text-xs font-bold text-slate-700">
                    <Sparkles size={15} className="text-sky-500" />
                    执行摘要
                  </div>
                  <ul className="space-y-2.5 text-sm leading-6 text-slate-700">
                    {singleAiReport.result.summary.map((item, idx) => (
                      <li key={`single-ai-summary-${idx}`} className="flex gap-3">
                        <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4">
                  <div className="mb-3 flex items-center gap-2 text-xs font-bold text-slate-700">
                    <Lightbulb size={15} className="text-emerald-600" />
                    建议动作
                  </div>
                  <ol className="space-y-3 text-sm leading-6 text-slate-700">
                    {singleAiReport.result.recommendations.map((item, idx) => (
                      <li key={`single-ai-rec-${idx}`} className="flex gap-3">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-[10px] font-bold text-emerald-700">
                          {idx + 1}
                        </span>
                        <span className="-mt-0.5">{item}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>

              {singleAiReport.result.keyFindings.length > 0 ? (
                <div>
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-xs font-bold text-slate-700">关键发现</h3>
                    <span className="text-[11px] text-slate-400">
                      共 {singleAiReport.result.keyFindings.length} 项
                    </span>
                  </div>
                  <div className="grid gap-3 xl:grid-cols-2">
                    {singleAiReport.result.keyFindings.map((item, idx) => (
                      <article key={`single-ai-finding-${idx}`} className="rounded-xl border border-slate-200 p-4">
                        <div className="mb-2 flex items-start gap-3">
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-[11px] font-bold text-sky-700">
                            {idx + 1}
                          </span>
                          <div className="min-w-0">
                            <h4 className="text-sm font-semibold text-slate-800">{item.title}</h4>
                            <p className="mt-1 text-xs leading-5 text-slate-600">{item.summary}</p>
                          </div>
                        </div>
                        {item.evidence.length > 0 ? (
                          <div className="ml-9 rounded-lg bg-slate-50 px-3 py-2">
                            <div className="mb-1 text-[10px] font-bold text-slate-400">数据依据</div>
                            <ul className="space-y-1 text-xs leading-5 text-slate-500">
                              {item.evidence.map((row, rowIdx) => (
                                <li key={`single-ai-finding-evidence-${idx}-${rowIdx}`}>{row}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        <p className="ml-9 mt-3 text-xs leading-5 text-slate-700">
                          <span className="font-semibold">建议：</span>
                          {item.recommendation}
                        </p>
                      </article>
                    ))}
                  </div>
                </div>
              ) : null}

              {(singleAiReport.result.risks.length > 0 || singleAiReport.result.warnings.length > 0) ? (
                <div className="grid gap-3 xl:grid-cols-2">
                  {singleAiReport.result.risks.length > 0 ? (
                    <div className="rounded-xl border border-rose-200 bg-rose-50/40 p-4">
                      <div className="mb-2 flex items-center gap-2 text-xs font-bold text-rose-700">
                        <AlertTriangle size={14} />
                        风险项
                      </div>
                      <ul className="space-y-2 text-xs leading-5 text-rose-700">
                        {singleAiReport.result.risks.map((item, idx) => (
                          <li key={`single-ai-risk-${idx}`}>
                            <span className="font-semibold">{item.title}：</span>{item.summary}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {singleAiReport.result.warnings.length > 0 ? (
                    <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4">
                      <div className="mb-2 flex items-center gap-2 text-xs font-bold text-amber-700">
                        <AlertTriangle size={14} />
                        数据与模型提示
                      </div>
                      <ul className="space-y-2 text-xs leading-5 text-amber-700">
                        {singleAiReport.result.warnings.map((item, idx) => (
                          <li key={`single-ai-warning-${idx}`}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-slate-100 pt-3 text-[10px] text-slate-400">
                <span data-i18n-skip="true">{singleAiReport.provider} · {singleAiReport.model}</span>
                <span data-i18n-skip="true">压缩 {singleAiReport.compression.retainedPointCount}/{singleAiReport.compression.inputPointCount} 点</span>
                <span data-i18n-skip="true">{new Date(singleAiReport.createdAt).toLocaleString()}</span>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <div className="flex flex-1 min-h-0 flex-col gap-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-4 shrink-0 min-h-[240px]">
        <div ref={fixationChartRef} className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col min-h-0 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="text-xs font-bold text-slate-500 tracking-widest">注视</div>
            <div className="flex items-center border border-slate-200 rounded-lg px-2 py-1">
              <CustomSelect
                value={fixationMetric}
                onChange={(e) => setFixationMetric(e.target.value as FixationMetric)}
                fullWidth={false}
                truncateOptionLabel={false}
                className="text-[10px] !bg-transparent outline-none text-slate-600 font-bold border-0 rounded-none shadow-none focus:ring-0 focus:border-transparent whitespace-nowrap !w-[150px] min-w-[150px] max-w-[150px]"
              >
                {fixationMetricOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </CustomSelect>
            </div>
          </div>
          {aoiReportLoading ? (
            <div className="flex-1 flex items-center justify-center text-[11px] text-slate-400">正在计算兴趣区统计…</div>
          ) : aoiReportError ? (
            <div className="flex-1 flex items-center justify-center text-[11px] text-rose-500">{aoiReportError}</div>
          ) : fixationSeries.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-[11px] text-slate-400">暂无兴趣区统计数据</div>
          ) : (
            (() => {
              const series = topWithOther(fixationSeries, 8);
              const maxV = Math.max(1, ...series.map((it) => it.value));
              return (
                <div className="flex-1 flex items-end gap-3">
                  {series.map((item) => (
                    <div key={item.id} className="flex-1 flex flex-col items-center gap-2 min-w-0">
                      <div className="w-full bg-transparent rounded-lg flex items-end justify-center h-24 overflow-hidden">
                        <div
                          className="rounded-md shadow-none outline-none"
                          data-i18n-skip="true"
                          style={{
                            height: `${Math.max(6, Math.round((item.value / maxV) * 100))}%`,
                            width: '25%',
                            maxWidth: 24,
                            backgroundColor: item.colorHex,
                          }}
                          title={`${item.name}\n${fixationMetricLabel}: ${formatValue(fixationMetric, item.value)}`}
                        />
                      </div>
                      <div className="text-[10px] text-slate-500 truncate w-full text-center" data-i18n-skip="true">{item.name}</div>
                      <div className="text-[10px] font-mono text-slate-700">{formatValue(fixationMetric, item.value)}</div>
                    </div>
                  ))}
                </div>
              );
            })()
          )}
        </div>

        <div ref={visitChartRef} className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col min-h-0 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="text-xs font-bold text-slate-500 tracking-widest">访问</div>
            <div className="flex items-center border border-slate-200 rounded-lg px-2 py-1">
              <CustomSelect
                value={visitMetric}
                onChange={(e) => setVisitMetric(e.target.value as VisitMetric)}
                fullWidth={false}
                truncateOptionLabel={false}
                className="text-[10px] !bg-transparent outline-none text-slate-600 font-bold border-0 rounded-none shadow-none focus:ring-0 focus:border-transparent whitespace-nowrap !w-[150px] min-w-[150px] max-w-[150px]"
              >
                {visitMetricOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </CustomSelect>
            </div>
          </div>
          {aoiReportLoading ? (
            <div className="flex-1 flex items-center justify-center text-[11px] text-slate-400">正在计算兴趣区统计…</div>
          ) : aoiReportError ? (
            <div className="flex-1 flex items-center justify-center text-[11px] text-rose-500">{aoiReportError}</div>
          ) : visitSeries.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-[11px] text-slate-400">暂无兴趣区统计数据</div>
          ) : (
            (() => {
              const series = topWithOther(visitSeries.filter((it) => it.value > 0), 6);
              const total = series.reduce((acc, it) => acc + it.value, 0);
              if (total <= 0) {
                return <div className="flex-1 flex items-center justify-center text-[11px] text-slate-400">暂无数据</div>;
              }
              let offset = 25;
              return (
                <div className="flex-1 flex flex-col gap-3 min-h-0">
                  <div className="flex-1 flex items-center justify-center">
                    <svg viewBox="0 0 42 42" className="w-44 h-44">
                      <circle cx="21" cy="21" r="15.91549430918954" fill="transparent" stroke="#e2e8f0" strokeWidth="6" />
                      {series.map((it) => {
                        const pct = (it.value / total) * 100;
                        const dash = `${pct} ${100 - pct}`;
                        const el = (
                          <circle
                            key={it.id}
                            cx="21"
                            cy="21"
                            r="15.91549430918954"
                            fill="transparent"
                            stroke={it.colorHex}
                            strokeWidth="6"
                            strokeDasharray={dash}
                            strokeDashoffset={offset}
                          >
                            <title data-i18n-skip="true">{`${it.name}\n${visitMetricLabel}: ${formatValue(visitMetric, it.value)}`}</title>
                          </circle>
                        );
                        offset -= pct;
                        return el;
                      })}
                      <text x="21" y="21" textAnchor="middle" dominantBaseline="middle" fill="#334155" fontSize="3.5" fontWeight="700">
                        {formatValue(visitMetric, total)}
                      </text>
                    </svg>
                  </div>
                  <div className="max-h-20 overflow-auto pr-1">
                    <div className="space-y-1">
                      {series.map((it) => (
                        <div
                          key={it.id}
                          className="flex items-center justify-between text-[10px] text-slate-600 gap-2"
                          data-i18n-skip="true"
                          title={`${it.name}\n${visitMetricLabel}: ${formatValue(visitMetric, it.value)}`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="w-2 h-2 rounded-full" style={{ background: it.colorHex }} />
                            <span className="truncate">{it.name}</span>
                          </div>
                          <span className="font-mono text-slate-700">{formatValue(visitMetric, it.value)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })()
          )}
        </div>

        <div ref={saccadeChartRef} className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col min-h-0 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="text-xs font-bold text-slate-500 tracking-widest">眼跳</div>
            <div className="flex items-center border border-slate-200 rounded-lg px-2 py-1">
              <CustomSelect
                value={saccadeMetric}
                onChange={(e) => setSaccadeMetric(e.target.value as SaccadeMetric)}
                fullWidth={false}
                truncateOptionLabel={false}
                className="text-[10px] !bg-transparent outline-none text-slate-600 font-bold border-0 rounded-none shadow-none focus:ring-0 focus:border-transparent whitespace-nowrap !w-[150px] min-w-[150px] max-w-[150px]"
              >
                {saccadeMetricOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </CustomSelect>
            </div>
          </div>
          {aoiReportLoading ? (
            <div className="flex-1 flex items-center justify-center text-[11px] text-slate-400">正在计算兴趣区统计…</div>
          ) : aoiReportError ? (
            <div className="flex-1 flex items-center justify-center text-[11px] text-rose-500">{aoiReportError}</div>
          ) : saccadeSeries.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-[11px] text-slate-400">暂无兴趣区统计数据</div>
          ) : (
            (() => {
              const series = saccadeSeries.slice(0, 12);
              const maxV = Math.max(1, ...series.map((it) => it.value));
              const denom = series.length > 1 ? series.length - 1 : 1;
              const points = series
                .map((it, idx) => {
                  const x = 2 + (idx / denom) * 96;
                  const y = 56 - (it.value / maxV) * 44;
                  return `${x},${y}`;
                })
                .join(' ');
              return (
                <div className="flex-1 flex flex-col">
                  <div className="flex-1 bg-transparent p-3">
                    <svg viewBox="0 0 100 60" className="w-full h-full">
                      <polyline points={points} fill="none" stroke="#0ea5e9" strokeWidth="0.75" />
                      {series.map((it, idx) => {
                        const x = 2 + (idx / denom) * 96;
                        const y = 56 - (it.value / maxV) * 44;
                        return (
                          <circle key={it.id} cx={x} cy={y} r="1.5" fill={it.colorHex} stroke="transparent" strokeWidth="4">
                            <title data-i18n-skip="true">{`${it.name}\n${saccadeMetricLabel}: ${formatValue(saccadeMetric, it.value)}`}</title>
                          </circle>
                        );
                      })}
                    </svg>
                  </div>
                  <div className="mt-3 flex items-center justify-between text-[10px] text-slate-400">
                    <span className="truncate max-w-[40%]" data-i18n-skip={series[0]?.name ? 'true' : undefined}>
                      {series[0]?.name || (language === 'en-US' ? 'Start' : '开始')}
                    </span>
                    <span
                      className="truncate max-w-[40%] text-right"
                      data-i18n-skip={series[series.length - 1]?.name ? 'true' : undefined}
                    >
                      {series[series.length - 1]?.name || (language === 'en-US' ? 'End' : '结束')}
                    </span>
                  </div>
                </div>
              );
            })()
          )}
        </div>

        <div ref={pupilChartRef} className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col min-h-0 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="text-xs font-bold text-slate-500 tracking-widest">瞳孔大小曲线 <span className="font-normal">(mm)</span></div>
            <div className="flex items-center border border-slate-200 rounded-lg px-2 py-1">
              <CustomSelect
                value={pupilEye}
                onChange={(e) => setPupilEye(e.target.value as PupilEye)}
                fullWidth={false}
                truncateOptionLabel={false}
                className="text-[10px] !bg-transparent outline-none text-slate-600 font-bold border-0 rounded-none shadow-none focus:ring-0 focus:border-transparent whitespace-nowrap !w-[104px] min-w-[104px] max-w-[104px]"
              >
                <option value="left">左眼</option>
                <option value="right">右眼</option>
              </CustomSelect>
            </div>
          </div>
          {aoiReportLoading ? (
            <div className="flex-1 flex items-center justify-center text-[11px] text-slate-400">正在计算兴趣区统计…</div>
          ) : aoiReportError ? (
            <div className="flex-1 flex items-center justify-center text-[11px] text-rose-500">{aoiReportError}</div>
          ) : pupilTrend.samples.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-[11px] text-slate-400">
              暂无{pupilEye === 'left' ? '左眼' : '右眼'}瞳孔数据
            </div>
          ) : (
            (() => {
              const series = pupilTrend.samples;
              const minValue = pupilTrend.min ?? 0;
              const maxValue = pupilTrend.max ?? minValue;
              const range = Math.max(1e-6, maxValue - minValue);
              const denom = series.length > 1 ? series.length - 1 : 1;
              const polyline = series
                .map((item, idx) => {
                  const x = (idx / denom) * 100;
                  const y = 56 - ((item.v - minValue) / range) * 44;
                  return `${x},${y}`;
                })
                .join(' ');

              return (
                <div className="flex-1 flex flex-col min-h-0">
                  <div className="flex-1 bg-transparent p-3">
                    <svg viewBox="0 0 100 60" className="w-full h-full">
                      <line x1="0" y1="12" x2="100" y2="12" stroke="#f1f5f9" strokeWidth="0.5" />
                      <line x1="0" y1="56" x2="100" y2="56" stroke="#e2e8f0" strokeWidth="0.5" />
                      <polyline points={polyline} fill="none" stroke="#14b8a6" strokeWidth="1" />
                      {series.map((item, idx) => {
                        const x = (idx / denom) * 100;
                        const y = 56 - ((item.v - minValue) / range) * 44;
                        return (
                          <circle
                            key={`${item.t}-${idx}`}
                            cx={x}
                            cy={y}
                            r={series.length <= 60 ? 1.2 : 0.9}
                            fill="#0f766e"
                            fillOpacity={series.length <= 60 ? 1 : 0.8}
                            stroke="transparent"
                            strokeWidth="4"
                          >
                            <title>
                              {`${pupilEyeLabel}\n${pupilTrend.hasTimestamp ? formatTimelineLabel(item.t) : isEn ? `Sample ${idx + 1}` : `样本 ${idx + 1}`}\n${isEn ? 'Pupil diameter (mm)' : '瞳孔直径 (mm)'}: ${item.v.toFixed(2)}`}
                            </title>
                          </circle>
                        );
                      })}
                    </svg>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] text-slate-500">
                    <div className="rounded bg-slate-50 px-2 py-1">
                      <div className="text-[9px] text-slate-400">最小值</div>
                      <div className="font-mono text-slate-700">{formatPupilValue(pupilTrend.min)}</div>
                    </div>
                    <div className="rounded bg-slate-50 px-2 py-1">
                      <div className="text-[9px] text-slate-400">均值</div>
                      <div className="font-mono text-slate-700">{formatPupilValue(pupilTrend.avg)}</div>
                    </div>
                    <div className="rounded bg-slate-50 px-2 py-1">
                      <div className="text-[9px] text-slate-400">最大值</div>
                      <div className="font-mono text-slate-700">{formatPupilValue(pupilTrend.max)}</div>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[10px] text-slate-400">
                    <span>{pupilTrend.hasTimestamp ? formatTimelineLabel(pupilTrend.startMs) : isEn ? 'Start' : '起点'}</span>
                    <span>{pupilTrend.hasTimestamp ? formatTimelineLabel(pupilTrend.endMs) : isEn ? 'End' : '终点'}</span>
                  </div>
                </div>
              );
            })()
          )}
        </div>
      </div>

        <div className="grid flex-1 min-h-[240px] grid-cols-3 gap-4">
          <div className="h-full bg-white rounded-2xl border border-slate-200 p-4 flex flex-col col-span-3 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-bold text-slate-500 tracking-widest">兴趣区注视统计表</div>
            <span className="text-[10px] text-slate-400">基于兴趣区配置与注视点数据</span>
          </div>
          {aoiReportLoading ? (
            <div className="flex-1 flex items-center justify-center text-[11px] text-slate-400">正在计算兴趣区统计…</div>
          ) : aoiReportError ? (
            <div className="flex-1 flex items-center justify-center text-[11px] text-rose-500">{aoiReportError}</div>
          ) : statsRows.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-[11px] text-slate-400">暂无兴趣区统计数据</div>
          ) : (
            <div className="flex-1 min-h-0 overflow-auto [&::-webkit-scrollbar]:w-[5px] [&::-webkit-scrollbar]:h-[5px] [&::-webkit-scrollbar-corner]:bg-transparent [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-track]:bg-[var(--app-scrollbar-track)] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[var(--app-scrollbar-thumb)] hover:[&::-webkit-scrollbar-thumb]:bg-[var(--app-scrollbar-thumb-hover)] [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-20 [&_thead_th]:bg-[var(--app-surface-2)] [&_thead_th:first-child]:left-0 [&_thead_th:first-child]:z-30 [&_tbody_td:first-child]:sticky [&_tbody_td:first-child]:left-0 [&_tbody_td:first-child]:z-10 [&_tbody_td:first-child]:bg-[var(--app-surface)] [&_tbody_tr:hover_td:first-child]:bg-[var(--app-hover)]">
              <table className="min-w-max text-center border-collapse text-[11px] whitespace-nowrap">
                <thead>
                  <tr className="bg-slate-50 text-slate-500 tracking-widest border-b border-slate-100">
                    <th className="px-4 py-3">兴趣区</th>
                    <th className="px-4 py-3">类型</th>
                    <th className="px-4 py-3">注视次数</th>
                    <th className="px-4 py-3">首次注视前时长(毫秒)</th>
                    <th className="px-4 py-3">首次注视前次数</th>
                    <th className="px-4 py-3">首次注视时长(毫秒)</th>
                    <th className="px-4 py-3">总注视时长(毫秒)</th>
                    <th className="px-4 py-3">平均注视时长(毫秒)</th>
                    <th className="px-4 py-3">最大注视时长(毫秒)</th>
                    <th className="px-4 py-3">最短浏览时间(毫秒)</th>
                    <th className="px-4 py-3">第二次注视时间(毫秒)</th>
                    <th className="px-4 py-3">回视时间(毫秒)</th>
                    <th className="px-4 py-3">长注视次数</th>
                    <th className="px-4 py-3">注视人数</th>
                    <th className="px-4 py-3">访问次数</th>
                    <th className="px-4 py-3">总停留时长(毫秒)</th>
                    <th className="px-4 py-3">首次停留时长(毫秒)</th>
                    <th className="px-4 py-3">首次停留注视次数</th>
                    <th className="px-4 py-3">首次停留注视时长(毫秒)</th>
                    <th className="px-4 py-3">平均停留时长(毫秒)</th>
                    <th className="px-4 py-3">回看次数</th>
                    <th className="px-4 py-3">回看人数</th>
                    <th className="px-4 py-3">眼跳次数</th>
                    <th className="px-4 py-3">总眼跳时长(毫秒)</th>
                    <th className="px-4 py-3">平均眼跳时长(毫秒)</th>
                    <th className="px-4 py-3">平均眼跳速度(px/ms)</th>
                    <th className="px-4 py-3">平均眼跳幅度(px)</th>
                    <th className="px-4 py-3">眼跳速度峰值(px/ms)</th>
                    <th className="px-4 py-3">平均瞳孔直径</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {statsRows
                    .slice()
                    .sort((a, b) => b.totalDurationMs - a.totalDurationMs)
                    .map((row) => (
                      <tr key={row.aoiId} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-semibold text-slate-700">
                          <div className="flex items-center justify-center gap-2">
                            <span
                              className="w-2 h-2 rounded-full"
                              style={{
                                backgroundColor: /^#[0-9a-f]{6}$/iu.test(String(row.color || ''))
                                  ? row.color
                                  : aoiColorDefs[row.color]?.border || aoiColorDefs.sky?.border || '#38bdf8',
                              }}
                            />
                            <span className="truncate" data-i18n-skip="true">{row.name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-500">{row.type}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.fixationCount}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.firstEnterTimeMs ?? '-'}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.fixationCountPreEntry}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.firstFixationDurationMs}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.totalDurationMs}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.avgDurationMs}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.maxFixationDurationMs}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.minFixationDurationMs}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.secondFixationDurationMs}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.regressionDurationMs}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.longFixationCount}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.visitorCount}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.visits}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.totalVisitDurationMs}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.firstVisitDurationMs}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.firstVisitFixationCount}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.firstVisitFixationDurationMs}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.avgVisitDurationMs}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.revisitCount}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.reVisitorCount}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.saccadeCount}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.totalSaccadeDurationMs}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{row.avgSaccadeDurationMs}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{formatValue('avgSaccadeVelocity', row.avgSaccadeVelocity)}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{formatValue('avgSaccadeAmplitude', row.avgSaccadeAmplitude)}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">{formatValue('peakSaccadeVelocity', row.peakSaccadeVelocity)}</td>
                        <td className="px-4 py-3 text-slate-500 font-mono">
                          {row.avgPupilDiameter !== null ? row.avgPupilDiameter.toFixed(2) : '-'}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
          </div>
        </div>
      </div>

    </div>
  );
};

export default ChartPage;
