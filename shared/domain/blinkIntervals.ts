import type { BlinkInterval } from '../contracts/domain/analysis';

export type BlinkTimeRange = { startTimeMs: number; endTimeMs: number };

const usableInterval = (interval: BlinkInterval): boolean =>
  Boolean(interval && typeof interval.id === 'string' && interval.id)
  && ['left', 'right', 'unspecified'].includes(interval.eye)
  && Number.isFinite(interval.startTimeMs) && Number.isFinite(interval.endTimeMs)
  && interval.startTimeMs >= 0 && interval.endTimeMs > interval.startTimeMs;

/** Half-open ranges prevent an onset on a shared boundary counting twice. */
export function mergeBlinkTimeRanges(ranges: BlinkTimeRange[]): BlinkTimeRange[] {
  const sorted = ranges.filter((range) => Number.isFinite(range.startTimeMs)
    && Number.isFinite(range.endTimeMs) && range.endTimeMs > range.startTimeMs)
    .map((range) => ({ ...range })).sort((a, b) => a.startTimeMs - b.startTimeMs);
  const result: BlinkTimeRange[] = [];
  for (const range of sorted) {
    const previous = result[result.length - 1];
    if (previous && range.startTimeMs <= previous.endTimeMs) previous.endTimeMs = Math.max(previous.endTimeMs, range.endTimeMs);
    else result.push(range);
  }
  return result;
}

export function summarizeBlinkIntervals(intervals: BlinkInterval[], ranges?: BlinkTimeRange[]) {
  const unique = new Map<string, BlinkInterval>();
  for (const interval of intervals) if (usableInterval(interval) && !unique.has(interval.id)) unique.set(interval.id, interval);
  const windows = ranges === undefined ? undefined : mergeBlinkTimeRanges(ranges);
  let onsetCount = 0;
  let overlapDurationMs = 0;
  let fullDurationSumMs = 0;
  const countsByEye = { left: 0, right: 0, unspecified: 0 };
  for (const interval of unique.values()) {
    const durationMs = interval.endTimeMs - interval.startTimeMs;
    const onsetInScope = !windows || windows.some((range) => interval.startTimeMs >= range.startTimeMs && interval.startTimeMs < range.endTimeMs);
    if (onsetInScope) {
      onsetCount += 1;
      fullDurationSumMs += durationMs;
      countsByEye[interval.eye] += 1;
    }
    overlapDurationMs += windows
      ? windows.reduce((sum, range) => sum + Math.max(0, Math.min(interval.endTimeMs, range.endTimeMs) - Math.max(interval.startTimeMs, range.startTimeMs)), 0)
      : durationMs;
  }
  return {
    onsetCount,
    overlapDurationMs,
    averageFullDurationMs: onsetCount > 0 ? fullDurationSumMs / onsetCount : null,
    countsByEye,
  };
}
