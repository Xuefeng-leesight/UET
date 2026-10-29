import type { RecordingRecord } from '@shared/contracts/domain/models';
import type { HeatmapPoint } from '@/shared/types/mrt';
import { applyPositiveDriftScaleCorrection, pickTimestampUnitScale } from '@shared/domain/time/timestampAlignment';

export function sanitizeVisualExportName(value: string): string {
  const cleaned = String(value || '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
  return cleaned || 'export';
}

export function buildVisualTempWebmPath(sourcePath: string, name: string, now = Date.now()): string {
  const raw = String(sourcePath || '');
  const lastSep = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  const dir = lastSep >= 0 ? raw.slice(0, lastSep) : '.';
  const isWin = /^[a-zA-Z]:\\/.test(raw) || raw.includes('\\');
  const sep = isWin ? '\\' : '/';
  return `${dir}${sep}.mrt_export_tmp${sep}${sanitizeVisualExportName(name)}_${now}.webm`;
}

export function parseVisualDurationSeconds(value: unknown): number | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  const mmssMatch = text.match(/^(\d+):(\d{2})(?:\.(\d+))?$/);
  if (mmssMatch) {
    const total = Number(mmssMatch[1]) * 60 + Number(mmssMatch[2]) + (mmssMatch[3] ? Number(`0.${mmssMatch[3]}`) : 0);
    return Number.isFinite(total) && total > 0 ? total : null;
  }
  const numeric = Number(text);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export function resolveVisualRecordDurationSeconds(
  recordsById: Map<string, RecordingRecord>,
  recordId: string,
  fallbackSeconds?: number,
): number | undefined {
  const record = recordsById.get(recordId);
  if (record && typeof record.durationSeconds === 'number' && Number.isFinite(record.durationSeconds) && record.durationSeconds > 0) {
    return record.durationSeconds;
  }
  if (record) {
    const parsed = parseVisualDurationSeconds(record.duration);
    if (parsed && parsed > 0) return parsed;
  }
  return typeof fallbackSeconds === 'number' && Number.isFinite(fallbackSeconds) && fallbackSeconds > 0
    ? fallbackSeconds
    : undefined;
}

export function prepareVisualRecordPoints(rawPoints: HeatmapPoint[]): HeatmapPoint[] {
  const normalize01 = (value: unknown): number => {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric < -0.001 || numeric > 1.001) return NaN;
    return Math.max(0, Math.min(1, numeric));
  };
  const next = rawPoints
    .map((point): HeatmapPoint | null => {
      const x = normalize01(point.x);
      const y = normalize01(point.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return {
        ...point,
        x,
        y,
        timestamp: typeof point.timestamp === 'number' && Number.isFinite(point.timestamp) ? point.timestamp : 0,
        weight: typeof point.weight === 'number' && Number.isFinite(point.weight) ? point.weight : undefined,
        id: typeof point.id === 'number' && Number.isFinite(point.id) ? point.id : undefined,
      };
    })
    .filter((point): point is HeatmapPoint => point !== null);
  next.sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));
  return next;
}

export function normalizeVisualTimestampsToVideo(
  points: HeatmapPoint[],
  targetDurationSeconds?: number,
): HeatmapPoint[] {
  if (!points.length) return [];
  // The reader already aligned these points to the recording. Sparse events
  // (even one fixation) must keep their real video time instead of starting at 0.
  if (points.every((point) => point.timeBase === 'video_time_ms')) return points;
  const durationMs = typeof targetDurationSeconds === 'number' && Number.isFinite(targetDurationSeconds) && targetDurationSeconds > 0
    ? targetDurationSeconds * 1000
    : 0;
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const point of points) {
    const timestamp = typeof point.timestamp === 'number' && Number.isFinite(point.timestamp) ? point.timestamp : NaN;
    if (!Number.isFinite(timestamp)) continue;
    minTs = Math.min(minTs, timestamp);
    maxTs = Math.max(maxTs, timestamp);
  }
  if (!Number.isFinite(minTs) || !Number.isFinite(maxTs)) return points;
  const span = Math.max(0, maxTs - minTs);
  if (span <= 0) return points.map((point) => ({ ...point, timestamp: 0 }));
  let scale = pickTimestampUnitScale(span, durationMs);
  const scaledMin = minTs * scale;
  const scaledMax = maxTs * scale;
  const keepOriginalOffset = scaledMin >= -1000
    && scaledMin <= (durationMs > 0 ? Math.max(2000, durationMs * 0.25) : 2000)
    && (durationMs > 0 ? scaledMax <= durationMs * 1.25 + 2000 : scaledMax <= 60 * 60 * 1000);
  const baseTs = keepOriginalOffset ? 0 : minTs;
  scale = applyPositiveDriftScaleCorrection({ maxTs, baseTs, scale, durationMs });
  return points.map((point) => {
    const timestamp = typeof point.timestamp === 'number' && Number.isFinite(point.timestamp) ? point.timestamp : NaN;
    return { ...point, timestamp: Number.isFinite(timestamp) ? Math.max(0, (timestamp - baseTs) * scale) : 0 };
  });
}
