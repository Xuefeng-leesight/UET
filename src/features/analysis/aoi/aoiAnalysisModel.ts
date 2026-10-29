import type { RecordingRecord } from '@shared/contracts/domain/models';
import type { HeatmapPoint } from '@/shared/types/mrt';
import type { BlinkIntervalData } from '@shared/contracts/domain/analysis';
import type { AoiAnalysisTimeRange } from '@shared/domain/aoi/aoiTypes';
import type { AoiStatsRow } from '@shared/domain/aoi/aoiReport';
import { applyPositiveDriftScaleCorrection, pickTimestampUnitScale } from '@shared/domain/time/timestampAlignment';

export type StimulusPlaybackSpan = {
  stimulusId: string;
  startMs: number;
  endMs: number;
};

export const resolveAoiPlaybackStimulusSpan = (
  spans: StimulusPlaybackSpan[],
  timeMs: number,
  selectedStimulusId: string | null,
): StimulusPlaybackSpan | null => {
  if (spans.length === 0) return null;
  // Endpoints belong to the ending stimulus. An explicitly selected stimulus
  // also owns its start, so seeking to its first frame shows the correct AOI.
  // Only absorb floating-point conversion noise, not a frame or a millisecond.
  const epsilonMs = 1e-6;
  const selectedBoundary = selectedStimulusId
    ? spans.find((span) => span.stimulusId === selectedStimulusId &&
      (Math.abs(timeMs - span.startMs) <= epsilonMs || Math.abs(timeMs - span.endMs) <= epsilonMs))
    : null;
  if (selectedBoundary) return selectedBoundary;
  return spans.find((span, index) =>
    timeMs >= span.startMs - epsilonMs && (timeMs <= span.endMs + epsilonMs || index === spans.length - 1),
  ) || (timeMs < spans[0].startMs ? spans[0] : spans[spans.length - 1]);
};

export type StimulusTimelinePoint = {
  stimulusRaw: string;
  timestamp: number;
};

export type LoadedAoiRecordData = {
  points: HeatmapPoint[];
  stimulusTimelinePoints: StimulusTimelinePoint[];
  blinkData?: BlinkIntervalData;
};

export type RecordScopedHeatmapPoint = HeatmapPoint & {
  __recordId: string;
};

export const KEYFRAME_EDIT_TOLERANCE_MS = 120;
export const RECORD_POINT_ID_SHIFT = 1_000_000;

export const extractStimulusTimelinePointsFromHeatmapPoints = (points: HeatmapPoint[]): StimulusTimelinePoint[] => {
  const out: StimulusTimelinePoint[] = [];
  for (const point of points) {
    const stimulusRaw = String(point.stimulusName || '').trim();
    const timestamp = typeof point.timestamp === 'number' && Number.isFinite(point.timestamp) ? point.timestamp : NaN;
    if (!stimulusRaw || !Number.isFinite(timestamp)) continue;
    out.push({ stimulusRaw, timestamp });
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
};

export const normalizeStimulusKey = (value: string): string =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();

export const parseDurationStringToSeconds = (value: unknown): number | null => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  const mmssMatch = text.match(/^(\d+):(\d{2})(?:\.(\d+))?$/);
  if (mmssMatch) {
    const minutes = Number(mmssMatch[1]);
    const seconds = Number(mmssMatch[2]);
    const fraction = mmssMatch[3] ? Number(`0.${mmssMatch[3]}`) : 0;
    const total = minutes * 60 + seconds + fraction;
    return Number.isFinite(total) && total > 0 ? total : null;
  }
  const numeric = Number(text);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

export const normalizeAoiAnalysisTimeRanges = (
  value: unknown,
  legacyValue?: unknown,
): AoiAnalysisTimeRange[] | undefined => {
  const candidates = [
    ...(Array.isArray(value) ? value : []),
    ...(legacyValue && typeof legacyValue === 'object' ? [legacyValue] : []),
  ];
  const normalized = candidates
    .map<AoiAnalysisTimeRange | null>((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const start = Number((item as AoiAnalysisTimeRange).startTimeMs);
      const end = Number((item as AoiAnalysisTimeRange).endTimeMs);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      const startTimeMs = Math.max(0, Math.round(start));
      const endTimeMs = Math.max(0, Math.round(end));
      if (endTimeMs <= startTimeMs) return null;
      const rawId = String((item as AoiAnalysisTimeRange).id || '').trim();
      return {
        id: rawId || `aoi_range_${startTimeMs}_${endTimeMs}_${index}`,
        startTimeMs,
        endTimeMs,
        enabled: (item as AoiAnalysisTimeRange).enabled !== false,
      } satisfies AoiAnalysisTimeRange;
    })
    .filter((item): item is AoiAnalysisTimeRange => item !== null)
    .sort((left, right) => left.startTimeMs - right.startTimeMs || left.endTimeMs - right.endTimeMs);
  const nonOverlapping: AoiAnalysisTimeRange[] = [];
  normalized.forEach((range) => {
    const previous = nonOverlapping[nonOverlapping.length - 1];
    if (!previous || range.startTimeMs >= previous.endTimeMs) nonOverlapping.push(range);
  });
  return nonOverlapping.length > 0 ? nonOverlapping : undefined;
};

export const isEditableElement = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (target.isContentEditable) return true;
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
};

export const resolveRecordDurationMs = (record: RecordingRecord | null, fallbackDurationMs?: number): number => {
  if (record && typeof record.durationSeconds === 'number' && Number.isFinite(record.durationSeconds) && record.durationSeconds > 0) {
    return Math.max(0, Math.round(record.durationSeconds * 1000));
  }
  if (record) {
    const parsed = parseDurationStringToSeconds(record.duration);
    if (parsed !== null) return Math.max(0, Math.round(parsed * 1000));
  }
  if (typeof fallbackDurationMs === 'number' && Number.isFinite(fallbackDurationMs) && fallbackDurationMs > 0) {
    return Math.max(0, Math.round(fallbackDurationMs));
  }
  return 0;
};

export const normalizePointsToDurationMs = (points: HeatmapPoint[], durationMs: number): HeatmapPoint[] => {
  const source = Array.isArray(points) ? points : [];
  if (source.length === 0) return [];
  let minTs = Infinity;
  let maxTs = -Infinity;
  let hasTimestamp = false;
  for (const point of source) {
    const ts = typeof point.timestamp === 'number' && Number.isFinite(point.timestamp) ? (point.timestamp as number) : NaN;
    if (!Number.isFinite(ts)) continue;
    hasTimestamp = true;
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;
  }
  if (!hasTimestamp) return [...source];

  const span = Math.max(0, maxTs - minTs);
  let scale = pickTimestampUnitScale(span, durationMs);
  scale = applyPositiveDriftScaleCorrection({
    maxTs,
    baseTs: minTs,
    scale,
    durationMs,
  });

  const normalized = source.map((point) => {
    const hasPointTimestamp = typeof point.timestamp === 'number' && Number.isFinite(point.timestamp);
    const ts = hasPointTimestamp ? (point.timestamp as number) : 0;
    return {
      ...point,
      timestamp: point.sampleOnly && !hasPointTimestamp
        ? undefined : Math.max(0, point.timeBase === 'video_time_ms' ? ts : (ts - minTs) * scale),
    };
  });
  normalized.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return normalized;
};

export const normalizeStimulusTimelineRowsToDurationMs = (rows: StimulusTimelinePoint[], durationMs: number): StimulusTimelinePoint[] => {
  const source = Array.isArray(rows) ? rows : [];
  if (source.length === 0) return [];
  let minTs = Infinity;
  let maxTs = -Infinity;
  let hasTimestamp = false;
  for (const row of source) {
    const ts = typeof row.timestamp === 'number' && Number.isFinite(row.timestamp) ? row.timestamp : NaN;
    if (!Number.isFinite(ts)) continue;
    hasTimestamp = true;
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;
  }
  if (!hasTimestamp) return [...source];

  const span = Math.max(0, maxTs - minTs);
  let scale = pickTimestampUnitScale(span, durationMs);
  scale = applyPositiveDriftScaleCorrection({
    maxTs,
    baseTs: minTs,
    scale,
    durationMs,
  });

  const normalized = source.map((row) => ({
    stimulusRaw: String(row.stimulusRaw || ''),
    timestamp: Math.max(0, (row.timestamp - minTs) * scale),
  }));
  normalized.sort((a, b) => a.timestamp - b.timestamp);
  return normalized;
};

export const aggregateAoiStatsRows = (rows: AoiStatsRow[], shapeOrder: string[]): AoiStatsRow[] => {
  if (rows.length === 0) return [];

  const grouped = new Map<string, AoiStatsRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.aoiId) || [];
    list.push(row);
    grouped.set(row.aoiId, list);
  }

  const safeSum = (list: AoiStatsRow[], pick: (row: AoiStatsRow) => number): number =>
    list.reduce((sum, row) => {
      const value = pick(row);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);

  const safeAvg = (sum: number, count: number): number => (count > 0 ? sum / count : 0);

  const shapeOrderMap = new Map<string, number>();
  shapeOrder.forEach((shapeId, index) => {
    shapeOrderMap.set(shapeId, index);
  });

  const output = Array.from(grouped.values()).map((list) => {
    const first = list[0];
    const visits = safeSum(list, (row) => row.visits);
    const fixationCount = safeSum(list, (row) => row.fixationCount);
    const totalDurationMs = safeSum(list, (row) => row.totalDurationMs);
    const totalVisitDurationMs = safeSum(list, (row) => row.totalVisitDurationMs);
    const totalSaccadeDurationMs = safeSum(list, (row) => row.totalSaccadeDurationMs);
    const saccadeCount = safeSum(list, (row) => row.saccadeCount);
    const totalBlinkDurationMs = safeSum(list, (row) => row.totalBlinkDurationMs);
    const blinkCount = safeSum(list, (row) => row.blinkCount);
    const blinkMetricsAvailable = list.every((row) => typeof row.blinkCount === 'number');
    const visitorKeys = new Set<string>();
    const reVisitorKeys = new Set<string>();
    let revisitCount = 0;
    list.forEach((row, index) => {
      const participantKey = String(row.participantKey || row.recordId || `row:${index}`).trim() || `row:${index}`;
      const visitCount = Number.isFinite(row.visits) ? Math.max(0, row.visits) : 0;
      const rowRevisitCount = Number.isFinite(row.revisitCount) ? Math.max(0, row.revisitCount) : Math.max(0, visitCount - 1);
      if (visitCount > 0 || row.visitorCount > 0) visitorKeys.add(participantKey);
      if (rowRevisitCount > 0 || row.reVisitorCount > 0) reVisitorKeys.add(participantKey);
      revisitCount += rowRevisitCount;
    });
    const visitorCount = visitorKeys.size;
    const reVisitorCount = reVisitorKeys.size;

    const firstEnterCandidates = list
      .map((row) => row.firstEnterTimeMs)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const firstFixationIdCandidates = list
      .map((row) => row.firstFixationId)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

    const contributingFirstVisitRows = list.filter((row) => row.visitorCount > 0);
    const contributingFirstVisitCount = contributingFirstVisitRows.length;

    const saccadeVelocityCount = safeSum(list, (row) => row.saccadeVelocityCount ?? row.saccadeCount);
    const saccadeAmplitudeCount = safeSum(list, (row) => row.saccadeAmplitudeCount ?? row.saccadeCount);
    const weightedVelocitySum = safeSum(list, (row) => (row.avgSaccadeVelocity ?? 0) * (row.saccadeVelocityCount ?? row.saccadeCount));
    const weightedAmplitudeSum = safeSum(list, (row) => (row.avgSaccadeAmplitude ?? 0) * (row.saccadeAmplitudeCount ?? row.saccadeCount));
    const peakSaccadeVelocityCandidates = list
      .map((row) => row.peakSaccadeVelocity)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const pupilWeightedSum = safeSum(list, (row) => {
      const value = row.avgPupilDiameter;
      const count = row.pupilSampleCount;
      return typeof value === 'number' && Number.isFinite(value) && Number.isFinite(count) ? value * count : 0;
    });
    const pupilSampleCount = safeSum(list, (row) => row.pupilSampleCount);

    const minFixationCandidates = list
      .map((row) => row.minFixationDurationMs)
      .filter((value) => typeof value === 'number' && Number.isFinite(value) && value > 0);
    const secondFixationCandidates = list
      .map((row) => row.secondFixationDurationMs)
      .filter((value) => typeof value === 'number' && Number.isFinite(value) && value > 0);
    const regressionDurationMs = safeSum(list, (row) => row.regressionDurationMs);
    const longFixationCount = safeSum(list, (row) => row.longFixationCount);

    return {
      ...first,
      firstFixationId: firstFixationIdCandidates.length > 0 ? Math.min(...firstFixationIdCandidates) : null,
      fixationCount,
      fixationCountPreEntry: Math.round(
        safeAvg(
          safeSum(contributingFirstVisitRows, (row) => row.fixationCountPreEntry),
          contributingFirstVisitCount,
        ),
      ),
      firstFixationDurationMs: Math.round(
        safeAvg(
          safeSum(contributingFirstVisitRows, (row) => row.firstFixationDurationMs),
          contributingFirstVisitCount,
        ),
      ),
      totalDurationMs: Math.round(totalDurationMs),
      avgDurationMs: Math.round(safeAvg(totalDurationMs, fixationCount)),
      maxFixationDurationMs: Math.round(Math.max(...list.map((row) => row.maxFixationDurationMs))),
      firstEnterTimeMs:
        firstEnterCandidates.length > 0
          ? Math.round(safeAvg(firstEnterCandidates.reduce((sum, value) => sum + value, 0), firstEnterCandidates.length))
          : null,
      visitorCount: Math.round(visitorCount),
      visits: Math.round(visits),
      revisitCount: Math.round(revisitCount),
      reVisitorCount: Math.round(reVisitorCount),
      totalVisitDurationMs: Math.round(totalVisitDurationMs),
      firstVisitDurationMs: Math.round(
        safeAvg(
          safeSum(contributingFirstVisitRows, (row) => row.firstVisitDurationMs),
          contributingFirstVisitCount,
        ),
      ),
      firstVisitFixationDurationMs: Math.round(
        safeAvg(
          safeSum(contributingFirstVisitRows, (row) => row.firstVisitFixationDurationMs),
          contributingFirstVisitCount,
        ),
      ),
      firstVisitFixationCount: Math.round(
        safeAvg(
          safeSum(contributingFirstVisitRows, (row) => row.firstVisitFixationCount),
          contributingFirstVisitCount,
        ),
      ),
      avgVisitDurationMs: Math.round(safeAvg(totalVisitDurationMs, visits)),
      totalSaccadeDurationMs: Math.round(totalSaccadeDurationMs),
      saccadeCount: Math.round(saccadeCount),
      saccadeVelocityCount,
      saccadeAmplitudeCount: Math.round(saccadeAmplitudeCount),
      avgSaccadeDurationMs: Math.round(safeAvg(totalSaccadeDurationMs, saccadeCount)),
      avgSaccadeVelocity: saccadeVelocityCount > 0 ? weightedVelocitySum / saccadeVelocityCount : null,
      avgSaccadeAmplitude: saccadeAmplitudeCount > 0 ? weightedAmplitudeSum / saccadeAmplitudeCount : null,
      peakSaccadeVelocity: peakSaccadeVelocityCandidates.length > 0 ? Math.max(...peakSaccadeVelocityCandidates) : null,
      avgPupilDiameter: pupilSampleCount > 0 ? pupilWeightedSum / pupilSampleCount : null,
      pupilSampleCount: Math.round(pupilSampleCount),
      totalBlinkDurationMs: blinkMetricsAvailable ? Math.round(totalBlinkDurationMs) : null,
      blinkCount: blinkMetricsAvailable ? Math.round(blinkCount) : null,
      avgBlinkDurationMs: blinkMetricsAvailable ? Math.round(safeAvg(totalBlinkDurationMs, blinkCount)) : null,
      ...(!blinkMetricsAvailable ? { blinkDataStatus: list.some((row) => row.blinkDataStatus === 'unlocalized_intervals')
        ? 'unlocalized_intervals' as const : 'not_observed' as const } : {}),
      minFixationDurationMs: Math.round(
        minFixationCandidates.length > 0 ? Math.min(...minFixationCandidates) : 0,
      ),
      secondFixationDurationMs: Math.round(
        secondFixationCandidates.length > 0
          ? secondFixationCandidates.reduce((sum, v) => sum + v, 0) / secondFixationCandidates.length
          : 0,
      ),
      regressionDurationMs: Math.round(regressionDurationMs),
      longFixationCount: Math.round(longFixationCount),
    };
  });

  output.sort((left, right) => {
    const leftOrder = shapeOrderMap.has(left.aoiId) ? (shapeOrderMap.get(left.aoiId) as number) : Number.MAX_SAFE_INTEGER;
    const rightOrder = shapeOrderMap.has(right.aoiId) ? (shapeOrderMap.get(right.aoiId) as number) : Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.name.localeCompare(right.name, 'zh-CN');
  });

  return output;
};
