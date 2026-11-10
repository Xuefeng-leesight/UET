import type { RecordingRecord } from '@shared/contracts/domain/models';
import type { HeatmapPoint } from '@/shared/types/mrt';
import type { BlinkIntervalData } from '@shared/contracts/domain/analysis';
import { summarizeBlinkIntervals } from '@shared/domain/blinkIntervals';
import type { AoiStatsRow } from '@shared/domain/aoi/aoiReport';
import type {
  CompareAoiSummary,
  CompareConfig,
  CompareGroupSummary,
  CompareMetricKey,
  CompareMetricSummary,
  CompareRecordSnapshot,
  CompareResult,
} from '@shared/contracts/domain/reporting';

export const COMPARE_METRIC_DEFS: Array<{ key: CompareMetricKey; label: string; unit: string }> = [
  { key: 'durationSeconds', label: '时长', unit: 's' },
  { key: 'samplingRateHz', label: '采样率', unit: 'Hz' },
  { key: 'validityPercent', label: '有效率', unit: '%' },
  { key: 'fixationCount', label: '全记录注视次数', unit: '次' },
  { key: 'totalFixationDurationMs', label: '全记录总注视时长', unit: 'ms' },
  { key: 'avgFixationDurationMs', label: '全记录平均注视时长', unit: 'ms' },
  { key: 'maxFixationDurationMs', label: '全记录最大注视时长', unit: 'ms' },
  { key: 'saccadeCount', label: '全记录眼跳次数', unit: '次' },
  { key: 'avgSaccadeVelocity', label: '全记录平均眼跳速度', unit: 'normalized/ms' },
  { key: 'avgSaccadeAmplitude', label: '全记录平均眼跳幅度', unit: 'normalized' },
  { key: 'avgPupilDiameter', label: '全记录平均瞳孔直径', unit: 'mm' },
  { key: 'blinkCount', label: '完整眨眼起始事件数（按眼）', unit: '次' },
  { key: 'totalBlinkDurationMs', label: '所选范围眨眼区间重叠时长（按眼相加）', unit: 'ms' },
  { key: 'avgBlinkDurationMs', label: '起始眨眼事件平均完整时长', unit: 'ms' },
  { key: 'aoiHitCount', label: 'AOI命中数', unit: '个' },
  { key: 'aoiTotalDurationMs', label: 'AOI总停留时长', unit: 'ms' },
];

const nowIso = (): string => new Date().toISOString();

const toFinite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
};

const toPositiveFinite = (value: unknown): number | null => {
  const n = toFinite(value);
  if (n === null || n <= 0) return null;
  return n;
};

const mean = (values: number[]): number | null => {
  if (values.length === 0) return null;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
};

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
};

const stdDev = (values: number[]): number => {
  if (values.length <= 1) return 0;
  const avg = mean(values);
  if (avg === null) return 0;
  const variance = values.reduce((acc, v) => acc + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(Math.max(0, variance));
};

const detectAnomalies = (ranking: Array<{ recordId: string; value: number }>): string[] => {
  if (ranking.length < 4) return [];
  const values = ranking.map((item) => item.value);
  const avg = mean(values);
  if (avg === null) return [];
  const sd = stdDev(values);
  const threshold = Math.max(sd * 1.5, Math.abs(avg) * 0.15);
  if (threshold <= 0) return [];
  return ranking
    .filter((item) => Math.abs(item.value - avg) > threshold)
    .map((item) => item.recordId);
};

const uniqueFixationCount = (points: HeatmapPoint[]): number => {
  const ids = new Set<number>();
  let fallback = 0;
  for (const point of points) {
    if (isSdkSaccadePoint(point)) continue;
    if (typeof point.id === 'number' && Number.isFinite(point.id)) {
      ids.add(Math.round(point.id));
    } else {
      fallback += 1;
    }
  }
  if (ids.size > 0) return ids.size;
  return fallback;
};

const sortByTimestamp = (points: HeatmapPoint[]): HeatmapPoint[] => {
  return [...points].sort((a, b) => {
    const ta = typeof a.timestamp === 'number' && Number.isFinite(a.timestamp) ? a.timestamp : Number.POSITIVE_INFINITY;
    const tb = typeof b.timestamp === 'number' && Number.isFinite(b.timestamp) ? b.timestamp : Number.POSITIVE_INFINITY;
    return ta - tb;
  });
};

const fixationStateOf = (point: HeatmapPoint | null | undefined): number | null => {
  const value = Number(point?.fixationState);
  return Number.isFinite(value) ? Math.round(value) : null;
};

const isSdkSaccadePoint = (point: HeatmapPoint | null | undefined): boolean => {
  const state = fixationStateOf(point);
  return state === 1 || state === 2;
};

const isTerminalSdkSaccadePoint = (point: HeatmapPoint, nextPoint: HeatmapPoint | null): boolean => {
  const state = fixationStateOf(point);
  if (state === 2) return true;
  return state === 1 && !isSdkSaccadePoint(nextPoint);
};

const computeDurationSeconds = (record: RecordingRecord, points: HeatmapPoint[]): number | null => {
  const recordDuration = toFinite(record.durationSeconds);
  if (recordDuration !== null && recordDuration > 0) return recordDuration;

  const sorted = sortByTimestamp(points);
  const firstTs = sorted.find((point) => typeof point.timestamp === 'number' && Number.isFinite(point.timestamp))?.timestamp;
  const lastTs =
    [...sorted]
      .reverse()
      .find((point) => typeof point.timestamp === 'number' && Number.isFinite(point.timestamp))?.timestamp ?? null;
  if (typeof firstTs === 'number' && typeof lastTs === 'number' && lastTs >= firstTs) {
    return (lastTs - firstTs) / 1000;
  }

  const totalWeightMs = sorted.reduce((acc, point) => {
    const w = toFinite(point.weight);
    return acc + (w && w > 0 ? w : 0);
  }, 0);
  if (totalWeightMs > 0) return totalWeightMs / 1000;
  return null;
};

const pickGroupKey = (config: CompareConfig, record: RecordingRecord, points: HeatmapPoint[]): string => {
  if (config.groupBy === 'subject') {
    return String(record.subjectName || '未命名受试者').trim() || '未命名受试者';
  }
  if (config.groupBy === 'segment') {
    if (config.segmentName) {
      return String(config.segmentName);
    }
    const segments = record.timelineSegments || [];
    if (!segments.length) return '无分段';

    const counter = new Map<string, number>();
    for (const point of points) {
      const ts = toFinite(point.timestamp);
      if (ts === null) continue;
      const matched = segments.find((segment) => {
        const startMs = Number(segment.startTime) * 1000;
        const endMs = Number(segment.endTime) * 1000;
        return Number.isFinite(startMs) && Number.isFinite(endMs) && ts >= startMs && ts <= endMs;
      });
      if (!matched) continue;
      const key = String(matched.name || '').trim();
      if (!key) continue;
      counter.set(key, (counter.get(key) || 0) + 1);
    }

    let winner = '';
    let best = -1;
    for (const [key, count] of counter.entries()) {
      if (count > best) {
        winner = key;
        best = count;
      }
    }
    if (winner) return winner;
    return String(segments[0]?.name || '无分段');
  }

  if (config.stimulusName) return String(config.stimulusName);

  const counter = new Map<string, number>();
  for (const point of points) {
    const key = String(point.stimulusName || '').trim();
    if (!key) continue;
    counter.set(key, (counter.get(key) || 0) + 1);
  }
  let winner = '';
  let best = -1;
  for (const [key, count] of counter.entries()) {
    if (count > best) {
      winner = key;
      best = count;
    }
  }
  return winner || '未标注刺激物';
};

export const filterPointsByConfig = (points: HeatmapPoint[], record: RecordingRecord, config: CompareConfig): HeatmapPoint[] => {
  let next = points;

  if (config.stimulusName) {
    const target = String(config.stimulusName || '').trim();
    next = next.filter((point) => String(point.stimulusName || '').trim() === target);
  }

  if (config.segmentName) {
    const target = String(config.segmentName || '').trim();
    const segment = (record.timelineSegments || []).find((item) => String(item.name || '').trim() === target);
    if (!segment) return [];
    const startMs = Number(segment.startTime) * 1000;
    const endMs = Number(segment.endTime) * 1000;
    next = next.filter((point) => {
      const ts = toFinite(point.timestamp);
      if (ts === null) return false;
      return ts >= startMs && ts <= endMs;
    });
  }

  return next;
};

const hasExplicitSaccadeMetric = (point: HeatmapPoint): boolean => {
  return (
    toFinite(point.saccadeStartX) !== null &&
    toFinite(point.saccadeStartY) !== null &&
    toFinite(point.saccadeEndX) !== null &&
    toFinite(point.saccadeEndY) !== null &&
    (toPositiveFinite(point.saccadeDurationMs) !== null ||
      toPositiveFinite(point.saccadeAmplitude) !== null ||
      toPositiveFinite(point.saccadeVelocity) !== null ||
      toPositiveFinite(point.saccadePeakVelocity) !== null)
  );
};

const computeSaccades = (points: HeatmapPoint[]): { count: number; avgVelocity: number | null; avgAmplitude: number | null } => {
  const sorted = sortByTimestamp(points).filter((point) => !point.markerOnly && !point.sampleOnly);
  let count = 0;
  let totalAmplitude = 0;
  let amplitudeCount = 0;
  let totalVelocity = 0;
  let velocityCount = 0;
  let lastNonSaccadePoint: HeatmapPoint | null = null;

  for (let i = 0; i < sorted.length; i += 1) {
    const point = sorted[i];
    const nextPoint = sorted[i + 1] || null;
    if (isSdkSaccadePoint(point)) {
      if (!isTerminalSdkSaccadePoint(point, nextPoint)) continue;
      const durationMs = toPositiveFinite(point.saccadeDurationMs) ?? toPositiveFinite(point.weight);
      const explicitAmplitude = toPositiveFinite(point.saccadeAmplitude);
      const inferredAmplitude =
        point.saccadeMetricUnit !== 'pixels' && lastNonSaccadePoint &&
        toFinite(lastNonSaccadePoint.x) !== null &&
        toFinite(lastNonSaccadePoint.y) !== null &&
        toFinite(point.x) !== null &&
        toFinite(point.y) !== null
          ? Math.hypot((point.x as number) - (lastNonSaccadePoint.x as number), (point.y as number) - (lastNonSaccadePoint.y as number))
          : null;
      const amplitude = explicitAmplitude ?? inferredAmplitude;
      const velocity =
        toPositiveFinite(point.saccadeVelocity) ??
        (point.saccadeMetricUnit !== 'pixels' && durationMs !== null && amplitude !== null ? amplitude / durationMs : null);

      count += 1;
      if (amplitude !== null) {
        totalAmplitude += amplitude;
        amplitudeCount += 1;
      }
      if (velocity !== null) {
        totalVelocity += velocity;
        velocityCount += 1;
      }
      continue;
    }

    if (hasExplicitSaccadeMetric(point)) {
      const durationMs = toPositiveFinite(point.saccadeDurationMs);
      const amplitude = toPositiveFinite(point.saccadeAmplitude);
      const velocity =
        toPositiveFinite(point.saccadeVelocity) ??
        (point.saccadeMetricUnit !== 'pixels' && durationMs !== null && amplitude !== null ? amplitude / durationMs : null);

      count += 1;
      if (amplitude !== null) {
        totalAmplitude += amplitude;
        amplitudeCount += 1;
      }
      if (velocity !== null) {
        totalVelocity += velocity;
        velocityCount += 1;
      }
    }
    lastNonSaccadePoint = point;
  }

  return {
    count,
    avgVelocity: velocityCount > 0 ? totalVelocity / velocityCount : count > 0 ? null : 0,
    avgAmplitude: amplitudeCount > 0 ? totalAmplitude / amplitudeCount : count > 0 ? null : 0,
  };
};

const computeRecordMetrics = (
  record: RecordingRecord,
  filteredPoints: HeatmapPoint[],
  aoiRows: AoiStatsRow[],
  blinkSummary: ReturnType<typeof summarizeBlinkIntervals> | null,
): Record<CompareMetricKey, number | null> => {
  const eventPoints = filteredPoints.filter((point) => !point.markerOnly && !point.sampleOnly);
  const fixationCount = uniqueFixationCount(eventPoints);
  const totalFixationDurationMs = eventPoints.reduce((acc, point) => {
    if (isSdkSaccadePoint(point)) return acc;
    const w = toFinite(point.weight);
    return acc + (w && w > 0 ? w : 0);
  }, 0);
  const maxFixationDurationMs = eventPoints.reduce((acc, point) => {
    if (isSdkSaccadePoint(point)) return acc;
    const w = toFinite(point.weight);
    if (w === null) return acc;
    return Math.max(acc, w);
  }, 0);

  const durationSeconds = computeDurationSeconds(record, filteredPoints);
  // Events and pupil-valid samples cannot establish the device's sampling rate.
  const samplingRateHz = toPositiveFinite(record.samplingRateHz);
  const validityPercent = toFinite(record.validityPercent);

  const pupilSourcePoints = filteredPoints.some((point) => point.sampleOnly || point.pupilSamplesIncluded)
    ? filteredPoints.filter((point) => point.sampleOnly)
    : eventPoints;
  const pupilValues = pupilSourcePoints
    .map((point) => toPositiveFinite(point.pupilDiameter))
    .filter((value): value is number => value !== null);
  const avgPupilDiameter = mean(pupilValues);

  const saccade = computeSaccades(filteredPoints);

  const aoiHitCount = aoiRows.filter((row) => row.fixationCount > 0).length;
  const aoiTotalDurationMs = aoiRows.reduce((acc, row) => acc + row.totalVisitDurationMs, 0);

  return {
    durationSeconds,
    samplingRateHz,
    validityPercent,
    fixationCount,
    totalFixationDurationMs,
    avgFixationDurationMs: fixationCount > 0 ? totalFixationDurationMs / fixationCount : 0,
    maxFixationDurationMs,
    saccadeCount: saccade.count,
    avgSaccadeVelocity: saccade.avgVelocity,
    avgSaccadeAmplitude: saccade.avgAmplitude,
    avgPupilDiameter,
    blinkCount: blinkSummary?.onsetCount ?? null,
    totalBlinkDurationMs: blinkSummary?.overlapDurationMs ?? null,
    avgBlinkDurationMs: blinkSummary?.averageFullDurationMs ?? null,
    aoiHitCount,
    aoiTotalDurationMs,
  };
};

const summarizeMetric = (
  key: CompareMetricKey,
  label: string,
  unit: string,
  snapshots: CompareRecordSnapshot[],
): CompareMetricSummary => {
  const ranking = snapshots
    .map((snapshot) => ({
      recordId: snapshot.recordId,
      value: snapshot.metrics[key],
    }))
    .filter((item): item is { recordId: string; value: number } => typeof item.value === 'number' && Number.isFinite(item.value))
    .sort((a, b) => b.value - a.value);

  const values = ranking.map((item) => item.value);
  const avg = mean(values);
  const med = median(values);
  const min = values.length > 0 ? Math.min(...values) : null;
  const max = values.length > 0 ? Math.max(...values) : null;
  const span = min !== null && max !== null ? max - min : null;

  return {
    key,
    label,
    unit,
    mean: avg,
    median: med,
    min,
    max,
    span,
    topRecordId: ranking[0]?.recordId || null,
    bottomRecordId: ranking[ranking.length - 1]?.recordId || null,
    anomalyRecordIds: detectAnomalies(ranking),
    ranking,
  };
};

const summarizeGroups = (snapshots: CompareRecordSnapshot[]): CompareGroupSummary[] => {
  const map = new Map<string, CompareRecordSnapshot[]>();
  for (const snapshot of snapshots) {
    const key = snapshot.groupKey || '未分组';
    const list = map.get(key) || [];
    list.push(snapshot);
    map.set(key, list);
  }

  const groups: CompareGroupSummary[] = [];
  for (const [groupKey, list] of map.entries()) {
    const metrics = {} as Record<CompareMetricKey, number | null>;
    for (const def of COMPARE_METRIC_DEFS) {
      const values = list
        .map((item) => item.metrics[def.key])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      metrics[def.key] = mean(values);
    }
    groups.push({ groupKey, recordCount: list.length, metrics });
  }

  groups.sort((a, b) => b.recordCount - a.recordCount || a.groupKey.localeCompare(b.groupKey));
  return groups;
};

const summarizeAoi = (aoiRowsByRecord: Record<string, AoiStatsRow[]>): CompareAoiSummary[] => {
  const map = new Map<
    string,
    {
      aoiId: string;
      name: string;
      color: string;
      hitRecordIds: Set<string>;
      totalFixationCount: number;
      totalVisitCount: number;
      totalDurationMs: number;
      rowCount: number;
    }
  >();

  for (const [recordId, rows] of Object.entries(aoiRowsByRecord)) {
    for (const row of rows || []) {
      const key = String(row.aoiId || row.name || '').trim();
      if (!key) continue;
      const current =
        map.get(key) ||
        {
          aoiId: key,
          name: row.name || key,
          color: row.color || 'aoi_0',
          hitRecordIds: new Set<string>(),
          totalFixationCount: 0,
          totalVisitCount: 0,
          totalDurationMs: 0,
          rowCount: 0,
        };

      if (row.fixationCount > 0) current.hitRecordIds.add(recordId);
      current.totalFixationCount += row.fixationCount;
      current.totalVisitCount += row.visits;
      current.totalDurationMs += row.totalVisitDurationMs;
      current.rowCount += 1;

      map.set(key, current);
    }
  }

  return Array.from(map.values())
    .map((item) => ({
      aoiId: item.aoiId,
      name: item.name,
      color: item.color,
      hitRecordCount: item.hitRecordIds.size,
      totalFixationCount: item.totalFixationCount,
      totalVisitCount: item.totalVisitCount,
      totalVisitDurationMs: item.totalDurationMs,
      avgVisitDurationMs: item.totalVisitCount > 0 ? item.totalDurationMs / item.totalVisitCount : 0,
      totalDurationMs: item.totalDurationMs,
      avgDurationMs: item.totalVisitCount > 0 ? item.totalDurationMs / item.totalVisitCount : 0,
    }))
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs || b.totalFixationCount - a.totalFixationCount);
};

const createResultId = (): string => `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export function buildCompareResult(params: {
  config: CompareConfig;
  records: RecordingRecord[];
  pointsByRecord: Record<string, HeatmapPoint[]>;
  aoiRowsByRecord: Record<string, AoiStatsRow[]>;
  blinkDataByRecord?: Record<string, BlinkIntervalData | undefined>;
}): CompareResult {
  const { config, records, pointsByRecord, aoiRowsByRecord } = params;

  const targetRecords = records.filter((record) => config.recordIds.includes(record.id));

  const snapshots: CompareRecordSnapshot[] = targetRecords.map((record) => {
    const rawPoints = pointsByRecord[record.id] || [];
    const filteredPoints = filterPointsByConfig(rawPoints, record, config);
    const rawAoiRows = aoiRowsByRecord[record.id] || [];
    const filteredAoiRows = rawAoiRows;
    const blinkData = params.blinkDataByRecord?.[record.id];
    const blinkIntervals = (blinkData?.intervals || []).filter((interval) => !config.stimulusName
      || String(interval.stimulusName || '').trim() === config.stimulusName.trim());
    const segment = config.segmentName ? record.timelineSegments?.find((item) => item.name.trim() === config.segmentName.trim()) : undefined;
    const blinkRanges = config.segmentName
      ? segment ? [{ startTimeMs: segment.startTime * 1000, endTimeMs: segment.endTime * 1000 }] : []
      : undefined;
    const usableScope = (!config.segmentName || (segment && Number.isFinite(segment.startTime)
      && Number.isFinite(segment.endTime) && segment.endTime > segment.startTime))
      && (!config.stimulusName || !blinkData?.intervals.some((interval) => !String(interval.stimulusName || '').trim()));
    const blinkSummary = blinkData?.intervals.length && usableScope ? summarizeBlinkIntervals(blinkIntervals, blinkRanges) : null;
    const metrics = computeRecordMetrics(record, filteredPoints, filteredAoiRows, blinkSummary);
    // The source label belongs to the onset; it does not provide stimulus
    // boundaries with which to intersect the remainder of a blink interval.
    if (config.stimulusName) metrics.totalBlinkDurationMs = null;
    return {
      recordId: record.id,
      recordName: String(record.name || record.id),
      subjectName: String(record.subjectName || ''),
      groupKey: pickGroupKey(config, record, filteredPoints),
      timestamp: String(record.timestamp || ''),
      metrics,
    };
  });

  const saccadeUnits = new Set(targetRecords.flatMap((record) =>
    filterPointsByConfig(pointsByRecord[record.id] || [], record, config)
      .filter((point) => isSdkSaccadePoint(point) || hasExplicitSaccadeMetric(point))
      .map((point) => point.saccadeMetricUnit || 'normalized')));
  const mixedSaccadeUnits = saccadeUnits.size > 1;
  if (mixedSaccadeUnits) {
    for (const snapshot of snapshots) {
      snapshot.metrics.avgSaccadeAmplitude = null;
      snapshot.metrics.avgSaccadeVelocity = null;
    }
  }
  const metrics = COMPARE_METRIC_DEFS.map((def) => {
    const unit = saccadeUnits.has('pixels') && !mixedSaccadeUnits
      ? def.key === 'avgSaccadeAmplitude' ? 'px' : def.key === 'avgSaccadeVelocity' ? 'px/ms' : def.unit
      : def.unit;
    return summarizeMetric(def.key, def.label, unit, snapshots);
  });
  const groups = summarizeGroups(snapshots);
  const aoi = summarizeAoi(
    Object.fromEntries(Object.entries(aoiRowsByRecord).filter(([recordId]) => config.recordIds.includes(recordId))),
  );

  const notes: string[] = [];
  if (targetRecords.some((record) => params.blinkDataByRecord?.[record.id])) {
    notes.push('眨眼仅统计已完整配对的源区间；按源眼别分别计数，左右同时发生也各计一次，未提供眼别的事件保留未指定。次数按起始时间落入左闭右开时间窗计数；重叠时长单独裁切并按眼相加，平均时长仍使用起始事件的完整源时长。');
    notes.push('没有完整配对时保持缺失，不能认定真实眨眼为零；未配对阶段不计次数。源眨眼区间没有有效空间位置，不能据此报告 AOI 眨眼次数或持续时长。');
    if (config.stimulusName) notes.push('刺激物筛选按眨眼起始阶段的源标签归属，只统计起始事件数及其完整源平均时长；缺少精确刺激物边界时不报告眨眼重叠时长，起始标签缺失时保持该筛选的眨眼指标缺失。');
    if (targetRecords.some((record) => (params.blinkDataByRecord?.[record.id]?.unpairedPhaseCount || 0) > 0)) {
      notes.push('部分记录存在未配对或异常眨眼阶段；完整区间统计不代表该记录全部真实眨眼均已检测。');
    }
  }
  if (mixedSaccadeUnits) notes.push('当前记录的眼跳幅度/速度包含像素与归一化两种单位，未混合计算；请按相同单位分组比较。');
  if (saccadeUnits.has('pixels')) notes.push('像素眼跳指标依赖场景分辨率与成像条件，不能直接解释为视角或跨设备物理运动差异。');
  if (targetRecords.some((record) => (pointsByRecord[record.id] || []).some((point) => point.sampleOnly))) {
    notes.push('全记录瞳孔均值使用当前筛选范围内合格瞳孔采样的毫米直径，允许无有效注视坐标的样本；AOI瞳孔统计另要求有效坐标。左右眼均有效时先取双眼均值，仅一眼有效时使用该眼。');
  }
  if (config.recordIds.length < 2) {
    notes.push('当前仅选择了 1 条记录，建议至少选择 2 条记录以形成有效对比。');
  }
  if (snapshots.some((item) => (item.metrics.fixationCount || 0) === 0)) {
    notes.push('部分记录在当前筛选条件下无有效注视数据，可能影响结论稳定性。');
  }
  if (config.stimulusName) {
    notes.push(`已应用刺激物筛选：${config.stimulusName}`);
  }
  if (config.segmentName) {
    notes.push(`已应用时间分段筛选：${config.segmentName}`);
  }

  return {
    id: createResultId(),
    createdAt: nowIso(),
    config,
    records: snapshots,
    groups,
    metrics,
    aoi,
    notes,
  };
}

export function formatMetricValue(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return '-';
  const decimals = unit === '%' || unit === 'Hz' ? 1 : unit === 'ms' ? 0 : 3;
  if (decimals <= 0) return `${Math.round(value)}`;
  return `${value.toFixed(decimals)}`;
}
