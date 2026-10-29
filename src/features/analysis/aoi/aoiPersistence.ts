import type { AoiKeyframe, AoiPoint, AoiShape } from '@shared/domain/aoi/aoiTypes';
import { normalizeAoiAnalysisTimeRanges } from '@/features/analysis/aoi/aoiAnalysisModel';

export type AoiStore = {
  version: 2 | 3;
  byRecordId: Record<string, AoiShape[]>;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
};

const finiteNumber = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

const normalizePoints = (value: unknown): AoiPoint[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const points = value.flatMap<AoiPoint>((item) => {
    const record = asRecord(item);
    const x = finiteNumber(record?.x);
    const y = finiteNumber(record?.y);
    return x === undefined || y === undefined ? [] : [{ x, y }];
  });
  return points.length > 0 ? points : undefined;
};

const normalizeKeyframes = (value: unknown): AoiKeyframe[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const frames = value.flatMap<AoiKeyframe>((item) => {
    const record = asRecord(item);
    const timeMs = finiteNumber(record?.timeMs);
    if (timeMs === undefined) return [];
    const frame: AoiKeyframe = {
      timeMs: Math.max(0, Math.round(timeMs)),
      metric: finiteNumber(record?.metric) ?? 0,
    };
    const x = finiteNumber(record?.x);
    const y = finiteNumber(record?.y);
    const w = finiteNumber(record?.w);
    const h = finiteNumber(record?.h);
    const points = normalizePoints(record?.points);
    if (x !== undefined) frame.x = x;
    if (y !== undefined) frame.y = y;
    if (w !== undefined) frame.w = w;
    if (h !== undefined) frame.h = h;
    if (points) frame.points = points;
    return [frame];
  });
  frames.sort((left, right) => left.timeMs - right.timeMs);
  return frames.length > 0 ? frames : undefined;
};

export const normalizePersistedAoiShape = (value: unknown): AoiShape | null => {
  const record = asRecord(value);
  const id = typeof record?.id === 'string' ? record.id.trim() : '';
  if (!record || !id) return null;
  const type = record.type === 'ellipse' || record.type === 'polygon' ? record.type : 'rect';
  const shape: AoiShape = {
    id,
    name: typeof record.name === 'string' && record.name.trim() ? record.name : id,
    type,
    visible: record.visible !== false,
    showStats: record.showStats === true,
    color: typeof record.color === 'string' && record.color.trim() ? record.color : 'sky',
    metric: finiteNumber(record.metric) ?? 0,
  };
  const activationTimeMs = finiteNumber(record.activationTimeMs);
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  const w = finiteNumber(record.w);
  const h = finiteNumber(record.h);
  const points = normalizePoints(record.points);
  const keyframes = normalizeKeyframes(record.keyframes);
  const analysisTimeRanges = normalizeAoiAnalysisTimeRanges(record.analysisTimeRanges, record.analysisTimeRange);
  if (activationTimeMs !== undefined) shape.activationTimeMs = Math.max(0, Math.round(activationTimeMs));
  if (x !== undefined) shape.x = x;
  if (y !== undefined) shape.y = y;
  if (w !== undefined) shape.w = w;
  if (h !== undefined) shape.h = h;
  if (points) shape.points = points;
  if (keyframes) shape.keyframes = keyframes;
  if (analysisTimeRanges) shape.analysisTimeRanges = analysisTimeRanges;
  return shape;
};

export const parseAoiStore = (value: unknown): AoiStore | null => {
  const store = asRecord(value);
  const version = store?.version;
  if (version !== 2 && version !== 3) return null;
  const rawByRecordId = asRecord(store.byRecordId);
  if (!rawByRecordId) return { version, byRecordId: {} };
  const byRecordId: Record<string, AoiShape[]> = {};
  for (const [scopeId, rawShapes] of Object.entries(rawByRecordId)) {
    if (!Array.isArray(rawShapes)) continue;
    byRecordId[scopeId] = rawShapes
      .map(normalizePersistedAoiShape)
      .filter((shape): shape is AoiShape => shape !== null);
  }
  return { version, byRecordId };
};
