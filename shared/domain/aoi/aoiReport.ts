import type { BlinkIntervalData, HeatmapPoint } from '../../contracts/domain/analysis';
import type { AoiAnalysisTimeRange, AoiKeyframe } from './aoiTypes';
import { resolveAoiShapeAtTime } from './aoiMotion';
import { applyPositiveDriftScaleCorrection, pickTimestampUnitScale } from '../time/timestampAlignment';

export type NormalizedAoiShape = {
  id: string;
  name: string;
  type: 'ellipse' | 'rect' | 'polygon';
  visible: boolean;
  showStats: boolean;
  color: string;
  metric?: number;
  activationTimeMs?: number;
  analysisTimeRanges?: AoiAnalysisTimeRange[];
  /** Legacy single-range data is read for backward compatibility. */
  analysisTimeRange?: AoiAnalysisTimeRange;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  points?: { x: number; y: number }[];
  keyframes?: AoiKeyframe[];
};

export type AoiStatsRow = {
  aoiId: string;
  recordId?: string;
  participantKey?: string;
  name: string;
  type: NormalizedAoiShape['type'];
  color: string;
  area: number;
  firstFixationId: number | null;
  fixationCount: number;
  fixationCountPreEntry: number;
  firstFixationDurationMs: number;
  totalDurationMs: number;
  avgDurationMs: number;
  maxFixationDurationMs: number;
  firstEnterTimeMs: number | null;
  visitorCount: number;
  visits: number;
  revisitCount: number;
  reVisitorCount: number;
  totalVisitDurationMs: number;
  firstVisitDurationMs: number;
  firstVisitFixationDurationMs: number;
  firstVisitFixationCount: number;
  avgVisitDurationMs: number;
  totalSaccadeDurationMs: number;
  saccadeCount: number;
  saccadeVelocityCount?: number;
  saccadeAmplitudeCount?: number;
  avgSaccadeDurationMs: number;
  avgSaccadeVelocity: number | null;
  avgSaccadeAmplitude: number | null;
  peakSaccadeVelocity: number | null;
  avgPupilDiameter: number | null;
  pupilSampleCount: number;
  totalBlinkDurationMs: number | null;
  blinkCount: number | null;
  avgBlinkDurationMs: number | null;
  blinkDataStatus?: 'unlocalized_intervals' | 'not_observed';
  minFixationDurationMs: number;
  secondFixationDurationMs: number;
  regressionDurationMs: number;
  longFixationCount: number;
};

function polygonArea(points: { x: number; y: number }[]): number {
  if (!points || points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y - points[j].x * points[i].y;
  }
  return Math.abs(area / 2);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function positiveFinite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function finiteCoordinate(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const tolerance = 0.001;
  if (n < -tolerance || n > 1 + tolerance) return null;
  return clamp01(n);
}

function hasExplicitSaccadePath(point: HeatmapPoint): boolean {
  return (
    finiteCoordinate(point.saccadeStartX) !== null &&
    finiteCoordinate(point.saccadeStartY) !== null &&
    finiteCoordinate(point.saccadeEndX) !== null &&
    finiteCoordinate(point.saccadeEndY) !== null
  );
}

function fixationStateOf(point: HeatmapPoint | null | undefined): number | null {
  const value = Number((point as HeatmapPoint | undefined)?.fixationState);
  return Number.isFinite(value) ? Math.round(value) : null;
}

function isSdkSaccadePoint(point: HeatmapPoint | null | undefined): boolean {
  const state = fixationStateOf(point);
  return state === 1 || state === 2;
}

function isTerminalSdkSaccadePoint(point: HeatmapPoint, nextPoint: HeatmapPoint | null): boolean {
  const state = fixationStateOf(point);
  if (state === 2) return true;
  return state === 1 && !isSdkSaccadePoint(nextPoint);
}

function pointInRect(x: number, y: number, s: NormalizedAoiShape): boolean {
  const sx = clamp01(Number(s.x || 0));
  const sy = clamp01(Number(s.y || 0));
  const sw = clamp01(Number(s.w || 0));
  const sh = clamp01(Number(s.h || 0));
  return x >= sx && x <= sx + sw && y >= sy && y <= sy + sh;
}

function pointInEllipse(x: number, y: number, s: NormalizedAoiShape): boolean {
  const sx = clamp01(Number(s.x || 0));
  const sy = clamp01(Number(s.y || 0));
  const sw = clamp01(Number(s.w || 0));
  const sh = clamp01(Number(s.h || 0));
  if (sw <= 0 || sh <= 0) return false;
  const cx = sx + sw / 2;
  const cy = sy + sh / 2;
  const rx = sw / 2;
  const ry = sh / 2;
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function pointInPolygon(x: number, y: number, s: NormalizedAoiShape): boolean {
  const pts = s.points || [];
  if (pts.length < 3) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const xi = clamp01(pts[i].x);
    const yi = clamp01(pts[i].y);
    const xj = clamp01(pts[j].x);
    const yj = clamp01(pts[j].y);
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 0.0000001) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function isInside(x: number, y: number, s: NormalizedAoiShape): boolean {
  if (s.type === 'rect') return pointInRect(x, y, s);
  if (s.type === 'ellipse') return pointInEllipse(x, y, s);
  return pointInPolygon(x, y, s);
}

function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const cross = (x1: number, y1: number, x2: number, y2: number) => x1 * y2 - y1 * x2;
  const eps = 1e-9;
  const abx = bx - ax;
  const aby = by - ay;
  const acx = cx - ax;
  const acy = cy - ay;
  const adx = dx - ax;
  const ady = dy - ay;
  const cdx = dx - cx;
  const cdy = dy - cy;
  const cax = ax - cx;
  const cay = ay - cy;
  const cbx = bx - cx;
  const cby = by - cy;
  const d1 = cross(abx, aby, acx, acy);
  const d2 = cross(abx, aby, adx, ady);
  const d3 = cross(cdx, cdy, cax, cay);
  const d4 = cross(cdx, cdy, cbx, cby);
  const between = (a: number, b: number, c: number) => Math.min(a, b) - eps <= c && c <= Math.max(a, b) + eps;
  if (Math.abs(d1) <= eps && between(ax, bx, cx) && between(ay, by, cy)) return true;
  if (Math.abs(d2) <= eps && between(ax, bx, dx) && between(ay, by, dy)) return true;
  if (Math.abs(d3) <= eps && between(cx, dx, ax) && between(cy, dy, ay)) return true;
  if (Math.abs(d4) <= eps && between(cx, dx, bx) && between(cy, dy, by)) return true;
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function segmentIntersectsAoi(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  s: NormalizedAoiShape,
): boolean {
  if (isInside(ax, ay, s) || isInside(bx, by, s)) return true;
  if (s.type === 'rect') {
    const x1 = clamp01(Number(s.x || 0));
    const y1 = clamp01(Number(s.y || 0));
    const x2 = x1 + clamp01(Number(s.w || 0));
    const y2 = y1 + clamp01(Number(s.h || 0));
    if (x2 <= x1 || y2 <= y1) return false;
    return (
      segmentsIntersect(ax, ay, bx, by, x1, y1, x2, y1) ||
      segmentsIntersect(ax, ay, bx, by, x2, y1, x2, y2) ||
      segmentsIntersect(ax, ay, bx, by, x2, y2, x1, y2) ||
      segmentsIntersect(ax, ay, bx, by, x1, y2, x1, y1)
    );
  }
  if (s.type === 'ellipse') {
    const sx = clamp01(Number(s.x || 0));
    const sy = clamp01(Number(s.y || 0));
    const sw = clamp01(Number(s.w || 0));
    const sh = clamp01(Number(s.h || 0));
    if (sw <= 0 || sh <= 0) return false;
    const cx = sx + sw / 2;
    const cy = sy + sh / 2;
    const rx = sw / 2;
    const ry = sh / 2;
    const px = (ax - cx) / rx;
    const py = (ay - cy) / ry;
    const dx = (bx - ax) / rx;
    const dy = (by - ay) / ry;
    const a = dx * dx + dy * dy;
    if (a <= 0) return false;
    const b = 2 * (px * dx + py * dy);
    const c = px * px + py * py - 1;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return false;
    const root = Math.sqrt(disc);
    const t1 = (-b - root) / (2 * a);
    const t2 = (-b + root) / (2 * a);
    return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1);
  }
  const pts = s.points || [];
  if (pts.length < 3) return false;
  for (let i = 0; i < pts.length; i += 1) {
    const j = (i + 1) % pts.length;
    if (segmentsIntersect(ax, ay, bx, by, clamp01(pts[i].x), clamp01(pts[i].y), clamp01(pts[j].x), clamp01(pts[j].y))) {
      return true;
    }
  }
  return false;
}

function segmentIntersectsAoiDuringInterval(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  s: NormalizedAoiShape,
  startMs: number,
  endMs: number,
): boolean {
  const sampleTimes = [startMs, startMs + Math.max(0, endMs - startMs) / 2, endMs];
  for (const sampleTime of sampleTimes) {
    const shapeAtTime = resolveAoiShapeAtTime(s, sampleTime);
    if (segmentIntersectsAoi(ax, ay, bx, by, shapeAtTime)) return true;
  }
  return false;
}

function parseBlinkState(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return false;
    if (value === 3 || value === 6) return true;
    if (value === 0 || value === 10) return false;
    return value !== 0;
  }
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (!text) return false;
    const numeric = Number(text);
    if (Number.isFinite(numeric)) {
      if (numeric === 3 || numeric === 6) return true;
      if (numeric === 0 || numeric === 10) return false;
      return numeric !== 0;
    }
    return ['true', 'yes', 'y', 'on', 'blink', 'closed'].includes(text);
  }
  return false;
}

function isBlinkActive(point: HeatmapPoint): boolean {
  const direct = (point as HeatmapPoint & { blink?: unknown }).blink;
  if (typeof direct !== 'undefined') return parseBlinkState(direct);
  const left = (point as HeatmapPoint & { leftBlink?: unknown }).leftBlink;
  const right = (point as HeatmapPoint & { rightBlink?: unknown }).rightBlink;
  return parseBlinkState(left) || parseBlinkState(right);
}

function shapeArea01(s: NormalizedAoiShape): number {
  if (s.type === 'rect') {
    return clamp01(Number(s.w || 0)) * clamp01(Number(s.h || 0));
  }
  if (s.type === 'ellipse') {
    const w = clamp01(Number(s.w || 0));
    const h = clamp01(Number(s.h || 0));
    return Math.PI * (w / 2) * (h / 2);
  }
  return polygonArea((s.points || []).map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) })));
}

function getAoiActivationTimeMs(s: NormalizedAoiShape): number {
  const direct = typeof s.activationTimeMs === 'number' && Number.isFinite(s.activationTimeMs) ? s.activationTimeMs : 0;
  return Math.max(0, Math.round(direct));
}

function getAoiAnalysisTimeRanges(s: NormalizedAoiShape): AoiAnalysisTimeRange[] {
  const candidates = [
    ...(Array.isArray(s.analysisTimeRanges) ? s.analysisTimeRanges : []),
    ...(s.analysisTimeRange ? [s.analysisTimeRange] : []),
  ];
  const normalized = candidates
    .map((range, index) => {
      const start = Number(range?.startTimeMs);
      const end = Number(range?.endTimeMs);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      const startTimeMs = Math.max(0, Math.round(start));
      const endTimeMs = Math.max(0, Math.round(end));
      if (endTimeMs <= startTimeMs) return null;
      return {
        id: String(range?.id || '').trim() || `aoi_range_${startTimeMs}_${endTimeMs}_${index}`,
        startTimeMs,
        endTimeMs,
        enabled: range?.enabled !== false,
      } satisfies AoiAnalysisTimeRange;
    })
    .filter((range): range is NonNullable<typeof range> => range !== null)
    .sort((left, right) => left.startTimeMs - right.startTimeMs || left.endTimeMs - right.endTimeMs);
  const nonOverlapping: AoiAnalysisTimeRange[] = [];
  normalized.forEach((range) => {
    const previous = nonOverlapping[nonOverlapping.length - 1];
    if (!previous || range.startTimeMs >= previous.endTimeMs) nonOverlapping.push(range);
  });
  return nonOverlapping;
}

export function getHitAoiNames(params: {
  shapes: NormalizedAoiShape[];
  x: number;
  y: number;
  timeMs: number;
}): string[] {
  const x = finiteCoordinate(params.x);
  const y = finiteCoordinate(params.y);
  if (x === null || y === null) return [];
  const timeMs = Math.max(0, Number.isFinite(params.timeMs) ? params.timeMs : 0);
  const names: string[] = [];
  for (const shape of params.shapes || []) {
    if (!shape || shape.visible === false || timeMs < getAoiActivationTimeMs(shape)) continue;
    const ranges = getAoiAnalysisTimeRanges(shape).filter((range) => range.enabled !== false);
    if (ranges.length > 0 && !ranges.some((range) => timeMs >= range.startTimeMs && timeMs <= range.endTimeMs)) {
      continue;
    }
    if (!isInside(x, y, resolveAoiShapeAtTime(shape, timeMs))) continue;
    const name = String(shape.name || '').trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function computeAoiStatsRows(params: {
  shapes: NormalizedAoiShape[];
  points: HeatmapPoint[];
  recordDurationMs?: number;
  timeOffsetMs?: number;
  frameWidth?: number;
  blinkData?: BlinkIntervalData;
}): AoiStatsRow[] {
  const { shapes, points, recordDurationMs, timeOffsetMs, frameWidth, blinkData } = params;

  const sortedPoints = (() => {
    const list = (points || []).map((point) => ({ ...point }));
    let minTs = Infinity;
    let maxTs = -Infinity;
    for (const p of list) {
      const ts = typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? (p.timestamp as number) : NaN;
      if (!Number.isFinite(ts)) continue;
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }
    if (!Number.isFinite(minTs)) minTs = 0;
    if (!Number.isFinite(maxTs)) maxTs = minTs;
    const span = Math.max(0, maxTs - minTs);

    const durationMs = typeof recordDurationMs === 'number' && Number.isFinite(recordDurationMs) ? recordDurationMs : 0;
    const offsetMs = typeof timeOffsetMs === 'number' && Number.isFinite(timeOffsetMs) ? timeOffsetMs : 0;

    let scale = pickTimestampUnitScale(span, durationMs);
    scale = applyPositiveDriftScaleCorrection({
      maxTs,
      baseTs: minTs,
      scale,
      durationMs,
    });

    for (const p of list) {
      const ts = typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? (p.timestamp as number) : NaN;
      if (p.sampleOnly && !Number.isFinite(ts)) {
        p.timestamp = undefined;
        continue;
      }
      const nextTs = Number.isFinite(ts)
        ? (p.timeBase === 'video_time_ms' ? ts : (ts - minTs) * scale) + offsetMs
        : offsetMs;
      p.timestamp = nextTs;
    }

    list.sort((a, b) => {
      const ta = typeof a.timestamp === 'number' && Number.isFinite(a.timestamp) ? (a.timestamp as number) : 0;
      const tb = typeof b.timestamp === 'number' && Number.isFinite(b.timestamp) ? (b.timestamp as number) : 0;
      return ta - tb;
    });
    return list;
  })();
  const fixationSourcePoints = sortedPoints.filter((p) => !p.markerOnly && !p.sampleOnly);
  const pupilSourcePoints = sortedPoints.some((p) => p.sampleOnly || p.pupilSamplesIncluded)
    ? sortedPoints.filter((p) => p.sampleOnly)
    : fixationSourcePoints;
  const hasFixationIds = fixationSourcePoints.some((p) => typeof p.id === 'number' && Number.isFinite(p.id));
  const eventPoints = (() => {
    if (!hasFixationIds) return fixationSourcePoints;
    const byId = new Map<string, HeatmapPoint>();
    const unkeyedPoints: HeatmapPoint[] = [];
    const mergeEventFields = (primary: HeatmapPoint, fallback: HeatmapPoint): Partial<HeatmapPoint> => ({
      pupilDiameter:
        typeof primary.pupilDiameter === 'number' && Number.isFinite(primary.pupilDiameter)
          ? primary.pupilDiameter
          : fallback.pupilDiameter,
      saccadeDurationMs:
        typeof primary.saccadeDurationMs === 'number' && Number.isFinite(primary.saccadeDurationMs)
          ? primary.saccadeDurationMs
          : fallback.saccadeDurationMs,
      saccadeAmplitude:
        typeof primary.saccadeAmplitude === 'number' && Number.isFinite(primary.saccadeAmplitude)
          ? primary.saccadeAmplitude
          : fallback.saccadeAmplitude,
      saccadeVelocity:
        typeof primary.saccadeVelocity === 'number' && Number.isFinite(primary.saccadeVelocity)
          ? primary.saccadeVelocity
          : fallback.saccadeVelocity,
      saccadePeakVelocity:
        typeof primary.saccadePeakVelocity === 'number' && Number.isFinite(primary.saccadePeakVelocity)
          ? primary.saccadePeakVelocity
          : fallback.saccadePeakVelocity,
      saccadeStartX:
        typeof primary.saccadeStartX === 'number' && Number.isFinite(primary.saccadeStartX)
          ? primary.saccadeStartX
          : fallback.saccadeStartX,
      saccadeStartY:
        typeof primary.saccadeStartY === 'number' && Number.isFinite(primary.saccadeStartY)
          ? primary.saccadeStartY
          : fallback.saccadeStartY,
      saccadeEndX:
        typeof primary.saccadeEndX === 'number' && Number.isFinite(primary.saccadeEndX)
          ? primary.saccadeEndX
          : fallback.saccadeEndX,
      saccadeEndY:
        typeof primary.saccadeEndY === 'number' && Number.isFinite(primary.saccadeEndY)
          ? primary.saccadeEndY
          : fallback.saccadeEndY,
      fixationState:
        typeof primary.fixationState === 'number' && Number.isFinite(primary.fixationState)
          ? primary.fixationState
          : fallback.fixationState,
    });
    for (const p of fixationSourcePoints) {
      const id = typeof p.id === 'number' && Number.isFinite(p.id) ? (p.id as number) : null;
      if (id === null) {
        unkeyedPoints.push(p);
        continue;
      }
      const state = fixationStateOf(p);
      const key = `${state ?? 'unknown'}:${id}`;
      const prev = byId.get(key);
      if (!prev) {
        byId.set(key, p);
        continue;
      }
      const ts = typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? (p.timestamp as number) : Number.POSITIVE_INFINITY;
      const prevTs =
        typeof prev.timestamp === 'number' && Number.isFinite(prev.timestamp) ? (prev.timestamp as number) : Number.POSITIVE_INFINITY;
      const w = typeof p.weight === 'number' && Number.isFinite(p.weight) ? (p.weight as number) : 0;
      const prevW = typeof prev.weight === 'number' && Number.isFinite(prev.weight) ? (prev.weight as number) : 0;
      if (ts < prevTs) {
        byId.set(key, {
          ...p,
          weight: Math.max(w, prevW),
          ...mergeEventFields(p, prev),
        });
      } else if (w > prevW) {
        byId.set(key, {
          ...prev,
          weight: w,
          ...mergeEventFields(prev, p),
        });
      } else {
        byId.set(key, {
          ...prev,
          ...mergeEventFields(prev, p),
        });
      }
    }
    const list = [...Array.from(byId.values()), ...unkeyedPoints];
    list.sort((a, b) => {
      const ta = typeof a.timestamp === 'number' && Number.isFinite(a.timestamp) ? (a.timestamp as number) : 0;
      const tb = typeof b.timestamp === 'number' && Number.isFinite(b.timestamp) ? (b.timestamp as number) : 0;
      return ta - tb;
    });
    return list;
  })();

  return (shapes || []).map((s) => {
    const configuredActivationTimeMs = getAoiActivationTimeMs(s);
    const configuredAnalysisTimeRanges = getAoiAnalysisTimeRanges(s);
    const analysisTimeRanges = configuredAnalysisTimeRanges.filter((range) => range.enabled !== false);
    const hasConfiguredAnalysisTimeRanges = configuredAnalysisTimeRanges.length > 0;
    let fixationCount = 0;
    let totalDurationMs = 0;
    let fixationCountPreEntry = 0;
    let firstFixationDurationMs = 0;
    let maxFixationDurationMs = 0;
    let firstEnterTimeMs: number | null = null;
    let firstFixationId: number | null = null;
    let visits = 0;
    let prevInside = false;
    let currentVisitStartMs: number | null = null;
    let currentVisitLastEndMs: number | null = null;
    let firstVisitFixationDurationMs = 0;
    let firstVisitFixationCount = 0;
    let inFirstVisit = false;
    let firstVisitFinalized = false;

    let totalSaccadeDurationMs = 0;
    let firstVisitSaccadeDurationMs = 0;
    let saccadeCount = 0;
    let totalSaccadeAmplitude = 0;
    let totalSaccadeVelocity = 0;
    let saccadeAmplitudeCount = 0;
    let saccadeVelocityCount = 0;
    let peakSaccadeVelocity = 0;

    let pupilSum = 0;
    let pupilSampleCount = 0;
    let totalBlinkDurationMs = 0;
    let blinkCount = 0;
    let minFixationDurationMs = Infinity;
    let secondFixationDurationMs = 0;
    let fixationIndexInside = 0;
    let longFixationCount = 0;

    const durationOf = (p: HeatmapPoint): number => {
      const w = typeof p.weight === 'number' && Number.isFinite(p.weight) ? (p.weight as number) : 0;
      return Math.max(0, w);
    };
    const tsOf = (p: HeatmapPoint): number => {
      const ts = typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? (p.timestamp as number) : 0;
      return Math.max(0, ts);
    };
    const analysisRangeAtTime = (timeMs: number): { startTimeMs: number; endTimeMs: number } | null => {
      if (timeMs < configuredActivationTimeMs) return null;
      if (!hasConfiguredAnalysisTimeRanges) {
        return { startTimeMs: configuredActivationTimeMs, endTimeMs: Number.POSITIVE_INFINITY };
      }
      const range = analysisTimeRanges.find(
        (item) => timeMs >= Math.max(configuredActivationTimeMs, item.startTimeMs) && timeMs <= item.endTimeMs,
      );
      if (!range) return null;
      return {
        startTimeMs: Math.max(configuredActivationTimeMs, range.startTimeMs),
        endTimeMs: range.endTimeMs,
      };
    };
    const durationWithinAnalysisRanges = (startTimeMs: number, durationMs: number): number => {
      const safeDurationMs = Math.max(0, durationMs);
      if (!hasConfiguredAnalysisTimeRanges) return safeDurationMs;
      const endTimeMs = startTimeMs + safeDurationMs;
      return analysisTimeRanges.reduce((total, range) => {
        const rangeStartMs = Math.max(configuredActivationTimeMs, range.startTimeMs);
        const overlapStartMs = Math.max(startTimeMs, rangeStartMs);
        const overlapEndMs = Math.min(endTimeMs, range.endTimeMs);
        return total + Math.max(0, overlapEndMs - overlapStartMs);
      }, 0);
    };

    // Pupil measurements belong to actual gaze samples, independently of event
    // counts and durations. Resolve moving AOIs at each sample's own video time.
    for (const sample of pupilSourcePoints) {
      if (sample.samplePositionValid === false) continue;
      const pd = positiveFinite(sample.pupilDiameter);
      const ts = sample.timestamp;
      if (pd === null || typeof ts !== 'number' || !Number.isFinite(ts) || !analysisRangeAtTime(ts)) continue;
      const x = finiteCoordinate(sample.x);
      const y = finiteCoordinate(sample.y);
      if (x === null || y === null || !isInside(x, y, resolveAoiShapeAtTime(s, ts))) continue;
      pupilSum += pd;
      pupilSampleCount += 1;
    }

    let globalFixationIndex = 0;
    const hasExplicitSaccadeFields = eventPoints.some(
      (p) =>
        hasExplicitSaccadePath(p) &&
        ((typeof p.saccadeDurationMs === 'number' && Number.isFinite(p.saccadeDurationMs)) ||
          (typeof p.saccadeAmplitude === 'number' && Number.isFinite(p.saccadeAmplitude)) ||
          (typeof p.saccadeVelocity === 'number' && Number.isFinite(p.saccadeVelocity)) ||
          (typeof p.saccadePeakVelocity === 'number' && Number.isFinite(p.saccadePeakVelocity))),
    );
    let lastNonSaccadeEvent: HeatmapPoint | null = null;
    let sdkSaccadeStartMs: number | null = null;
    let lastAnalysisRangeEndMs: number | null = null;

    for (let eventIndex = 0; eventIndex < eventPoints.length; eventIndex += 1) {
      const p = eventPoints[eventIndex];
      const nextEventFixation = eventPoints[eventIndex + 1] || null;
      const sdkSaccade = isSdkSaccadePoint(p);
      const ts = tsOf(p);
      const activeAnalysisRange = analysisRangeAtTime(ts);
      if (!activeAnalysisRange) {
        if (prevInside && !firstVisitFinalized) {
          firstVisitFinalized = true;
          inFirstVisit = false;
        }
        prevInside = false;
        currentVisitStartMs = null;
        currentVisitLastEndMs = null;
        sdkSaccadeStartMs = null;
        lastNonSaccadeEvent = null;
        lastAnalysisRangeEndMs = null;
        continue;
      }
      const startsAfterAnalysisGap =
        lastAnalysisRangeEndMs !== null && activeAnalysisRange.startTimeMs > lastAnalysisRangeEndMs;
      if (startsAfterAnalysisGap) {
        if (prevInside && !firstVisitFinalized) {
          firstVisitFinalized = true;
          inFirstVisit = false;
        }
        prevInside = false;
        currentVisitStartMs = null;
        currentVisitLastEndMs = null;
        sdkSaccadeStartMs = null;
        lastNonSaccadeEvent = null;
      }
      lastAnalysisRangeEndMs = activeAnalysisRange.endTimeMs;
      const x = typeof p.x === 'number' && Number.isFinite(p.x) ? clamp01(p.x) : NaN;
      const y = typeof p.y === 'number' && Number.isFinite(p.y) ? clamp01(p.y) : NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      const shapeAtTime = resolveAoiShapeAtTime(s, ts);
      const inside = isInside(x, y, shapeAtTime);
      if (inside && !prevInside) visits += 1;

      if (inside) {
        const eventDurationMs = durationWithinAnalysisRanges(ts, durationOf(p));
        if (currentVisitStartMs === null) {
          currentVisitStartMs = ts;
          currentVisitLastEndMs = ts + eventDurationMs;
          if (!firstVisitFinalized) {
            inFirstVisit = true;
          }
        } else {
          const endMs = ts + eventDurationMs;
          if (currentVisitLastEndMs === null || endMs > currentVisitLastEndMs) currentVisitLastEndMs = endMs;
        }
      }

      if (sdkSaccade) {
        if (sdkSaccadeStartMs === null) sdkSaccadeStartMs = ts;
        const inferredSdkDuration =
          isTerminalSdkSaccadePoint(p, nextEventFixation) && sdkSaccadeStartMs !== null
            ? Math.max(0, ts - sdkSaccadeStartMs)
            : 0;
        const durationForStats =
          positiveFinite(p.saccadeDurationMs) ??
          positiveFinite(durationOf(p)) ??
          (inferredSdkDuration > 0 ? inferredSdkDuration : null);
        const metricScale = p.saccadeMetricUnit === 'pixels' ? 1 : (frameWidth ?? 1);
        const scaleMetric = (value: unknown) => {
          const number = positiveFinite(value);
          return number === null ? null : number * metricScale;
        };
        const explicitAmplitude = scaleMetric(p.saccadeAmplitude);
        const explicitVelocity = scaleMetric(p.saccadeVelocity);
        const explicitPeakVelocity = scaleMetric(p.saccadePeakVelocity);
        const prevX =
          lastNonSaccadeEvent && typeof lastNonSaccadeEvent.x === 'number' && Number.isFinite(lastNonSaccadeEvent.x)
            ? clamp01(lastNonSaccadeEvent.x)
            : null;
        const prevY =
          lastNonSaccadeEvent && typeof lastNonSaccadeEvent.y === 'number' && Number.isFinite(lastNonSaccadeEvent.y)
            ? clamp01(lastNonSaccadeEvent.y)
            : null;
        const inferredAmplitude = p.saccadeMetricUnit !== 'pixels' && prevX !== null && prevY !== null
          ? Math.hypot(x - prevX, y - prevY) * (frameWidth ?? 1) : null;
        const amplitudeForStats = explicitAmplitude ?? inferredAmplitude;
        const velocityForStats =
          explicitVelocity ??
          (p.saccadeMetricUnit !== 'pixels' && durationForStats !== null && amplitudeForStats !== null ? amplitudeForStats / durationForStats : null);
        const peakVelocityValue = explicitPeakVelocity ?? (p.saccadeMetricUnit !== 'pixels' ? velocityForStats : null);
        const explicitPath = hasExplicitSaccadePath(p);
        const crossesAoi =
          (explicitPath && p.saccadeMetricUnit === 'pixels'
            ? segmentIntersectsAoiDuringInterval(p.saccadeStartX!, p.saccadeStartY!, p.saccadeEndX!, p.saccadeEndY!, s, ts, ts + (durationForStats ?? 0))
            : inside ||
          (prevX !== null &&
            prevY !== null &&
            segmentIntersectsAoiDuringInterval(prevX, prevY, x, y, s, Math.max(0, ts - (durationForStats ?? 0)), ts)));
        if (isTerminalSdkSaccadePoint(p, nextEventFixation) && crossesAoi) {
          totalSaccadeDurationMs += durationForStats ?? 0;
          if (inFirstVisit && !firstVisitFinalized) firstVisitSaccadeDurationMs += durationForStats ?? 0;
          saccadeCount += 1;
          if (amplitudeForStats !== null) {
            totalSaccadeAmplitude += amplitudeForStats;
            saccadeAmplitudeCount += 1;
          }
          if (velocityForStats !== null) {
            totalSaccadeVelocity += velocityForStats;
            saccadeVelocityCount += 1;
          }
          if (peakVelocityValue !== null && peakVelocityValue > peakSaccadeVelocity) peakSaccadeVelocity = peakVelocityValue;
        }
        if (isTerminalSdkSaccadePoint(p, nextEventFixation)) {
          sdkSaccadeStartMs = null;
        }
      } else if (hasExplicitSaccadeFields) {
        sdkSaccadeStartMs = null;
        const explicitDuration = positiveFinite(p.saccadeDurationMs);
        const metricScale = p.saccadeMetricUnit === 'pixels' ? 1 : (frameWidth ?? 1);
        const scaleMetric = (value: unknown) => {
          const number = positiveFinite(value);
          return number === null ? null : number * metricScale;
        };
        const explicitAmplitude = scaleMetric(p.saccadeAmplitude);
        const explicitVelocity = scaleMetric(p.saccadeVelocity);
        const explicitPeakVelocity = scaleMetric(p.saccadePeakVelocity);
        const hasSaccadeValue =
          explicitDuration !== null || explicitAmplitude !== null || explicitVelocity !== null || explicitPeakVelocity !== null;
        const nextTs = nextEventFixation ? tsOf(nextEventFixation) : ts;
        const sx = finiteCoordinate(p.saccadeStartX);
        const sy = finiteCoordinate(p.saccadeStartY);
        const ex = finiteCoordinate(p.saccadeEndX);
        const ey = finiteCoordinate(p.saccadeEndY);
        const saccadeStartMs = ts + durationOf(p);
        const saccadeEndMs = Math.max(saccadeStartMs, nextTs);
        const inferredDuration = Math.max(0, saccadeEndMs - saccadeStartMs);
        const durationForStats = explicitDuration ?? (inferredDuration > 0 ? inferredDuration : null);
        const amplitudeForStats = explicitAmplitude;
        const velocityForStats =
          explicitVelocity ??
          (p.saccadeMetricUnit !== 'pixels' && explicitDuration !== null && explicitAmplitude !== null ? explicitAmplitude / explicitDuration : null);
        const peakVelocityValue = explicitPeakVelocity ?? (p.saccadeMetricUnit !== 'pixels' ? velocityForStats : null);
        const crossesAoi =
          sx !== null &&
          sy !== null &&
          ex !== null &&
          ey !== null &&
          segmentIntersectsAoiDuringInterval(sx, sy, ex, ey, s, saccadeStartMs, saccadeEndMs);
        if (hasSaccadeValue && crossesAoi) {
          totalSaccadeDurationMs += durationForStats ?? 0;
          if (inFirstVisit && !firstVisitFinalized) firstVisitSaccadeDurationMs += durationForStats ?? 0;
          saccadeCount += 1;
          if (amplitudeForStats !== null) {
            totalSaccadeAmplitude += amplitudeForStats;
            saccadeAmplitudeCount += 1;
          }
          if (velocityForStats !== null) {
            totalSaccadeVelocity += velocityForStats;
            saccadeVelocityCount += 1;
          }
          if (peakVelocityValue !== null && peakVelocityValue > peakSaccadeVelocity) peakSaccadeVelocity = peakVelocityValue;
        }
      }

      if (!inside && prevInside) {
        const start = currentVisitStartMs;
        const end = currentVisitLastEndMs;
        if (start !== null && end !== null && end >= start) {
          if (!firstVisitFinalized) {
            firstVisitFinalized = true;
            inFirstVisit = false;
          }
        }
        currentVisitStartMs = null;
        currentVisitLastEndMs = null;
      }

      prevInside = inside;
      if (sdkSaccade) continue;
      sdkSaccadeStartMs = null;
      lastNonSaccadeEvent = p;
      globalFixationIndex += 1;
      if (!inside) continue;

      fixationCount += 1;
      fixationIndexInside += 1;
      const w = durationWithinAnalysisRanges(ts, durationOf(p));
      totalDurationMs += w;
      if (w < minFixationDurationMs) minFixationDurationMs = w;
      if (fixationIndexInside === 2) secondFixationDurationMs = Math.round(w);
      if (w > maxFixationDurationMs) maxFixationDurationMs = w;
      if (w >= 2000) longFixationCount += 1;

      if (firstEnterTimeMs === null) {
        firstEnterTimeMs = Math.max(0, Math.round(ts - activeAnalysisRange.startTimeMs));
        firstFixationId = typeof p.id === 'number' && Number.isFinite(p.id) ? Math.round(p.id) : null;
        fixationCountPreEntry = Math.max(0, globalFixationIndex - 1);
        firstFixationDurationMs = Math.round(w);
      }

      if (inFirstVisit && !firstVisitFinalized) {
        firstVisitFixationCount += 1;
        firstVisitFixationDurationMs += w;
      }

    }

    if (prevInside) {
      const start = currentVisitStartMs;
      const end = currentVisitLastEndMs;
      if (start !== null && end !== null && end >= start) {
        if (!firstVisitFinalized) {
          firstVisitFinalized = true;
        }
      }
    }

    let blinkOpen = false;
    let blinkStartMs = 0;
    let blinkEndMs = 0;
    let lastBlinkAnalysisRangeEndMs: number | null = null;
    for (let i = 0; i < sortedPoints.length; i += 1) {
      // Complete source blink intervals do not contain gaze positions. A
      // fixation flag or a nearby sample cannot establish AOI dwell duration.
      if (blinkData !== undefined) break;
      const point = sortedPoints[i];
      if (point.markerOnly || point.sampleOnly) continue;
      const ts = tsOf(point);
      const activeBlinkRange = analysisRangeAtTime(ts);
      if (!activeBlinkRange) {
        if (blinkOpen) {
          totalBlinkDurationMs += Math.max(0, blinkEndMs - blinkStartMs);
          blinkOpen = false;
        }
        lastBlinkAnalysisRangeEndMs = null;
        continue;
      }
      if (lastBlinkAnalysisRangeEndMs !== null && activeBlinkRange.startTimeMs > lastBlinkAnalysisRangeEndMs && blinkOpen) {
        totalBlinkDurationMs += Math.max(0, blinkEndMs - blinkStartMs);
        blinkOpen = false;
      }
      lastBlinkAnalysisRangeEndMs = activeBlinkRange.endTimeMs;
      const x = typeof point.x === 'number' && Number.isFinite(point.x) ? clamp01(point.x) : NaN;
      const y = typeof point.y === 'number' && Number.isFinite(point.y) ? clamp01(point.y) : NaN;
      const nextPoint = sortedPoints[i + 1];
      const nextTs =
        nextPoint && typeof nextPoint.timestamp === 'number' && Number.isFinite(nextPoint.timestamp)
          ? Math.max(0, nextPoint.timestamp)
          : NaN;
      const pointDuration = durationOf(point);
      const inferredDuration = pointDuration > 0 ? pointDuration : Number.isFinite(nextTs) ? Math.max(0, nextTs - ts) : 0;
      const pointEnd = ts + durationWithinAnalysisRanges(ts, inferredDuration);

      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        if (blinkOpen) {
          totalBlinkDurationMs += Math.max(0, blinkEndMs - blinkStartMs);
          blinkOpen = false;
        }
        continue;
      }

      const shapeAtTime = resolveAoiShapeAtTime(s, ts);
      const inside = isInside(x, y, shapeAtTime);
      const active = inside && isBlinkActive(point);
      if (active) {
        if (!blinkOpen) {
          blinkOpen = true;
          blinkCount += 1;
          blinkStartMs = ts;
          blinkEndMs = pointEnd;
        } else if (pointEnd > blinkEndMs) {
          blinkEndMs = pointEnd;
        }
      } else if (blinkOpen) {
        totalBlinkDurationMs += Math.max(0, blinkEndMs - blinkStartMs);
        blinkOpen = false;
      }
    }
    if (blinkOpen) {
      totalBlinkDurationMs += Math.max(0, blinkEndMs - blinkStartMs);
    }

    const visitDurationByDefinition = totalDurationMs + totalSaccadeDurationMs;
    const firstVisitDurationByDefinition = firstVisitFixationDurationMs + firstVisitSaccadeDurationMs;
    const avgDurationMs = fixationCount > 0 ? totalDurationMs / fixationCount : 0;
    const revisitCount = Math.max(0, visits - 1);
    const visitorCount = fixationCount > 0 ? 1 : 0;
    const reVisitorCount = visits > 1 ? 1 : 0;
    const avgVisitDurationMs = visits > 0 ? visitDurationByDefinition / visits : 0;
    const avgSaccadeDurationMs = saccadeCount > 0 ? totalSaccadeDurationMs / saccadeCount : 0;
    const avgSaccadeVelocity = saccadeVelocityCount > 0 ? totalSaccadeVelocity / saccadeVelocityCount : null;
    const avgSaccadeAmplitude = saccadeAmplitudeCount > 0 ? totalSaccadeAmplitude / saccadeAmplitudeCount : null;

    const avgPupilDiameter = pupilSampleCount > 0 ? pupilSum / pupilSampleCount : null;
    const avgBlinkDurationMs = blinkCount > 0 ? totalBlinkDurationMs / blinkCount : 0;
    const regressionDurationMs = Math.max(0, Math.round(totalDurationMs) - Math.round(firstVisitFixationDurationMs));

    return {
      aoiId: s.id,
      name: s.name,
      type: s.type,
      color: s.color,
      area: shapeArea01(s),
      firstFixationId,
      fixationCount,
      fixationCountPreEntry,
      firstFixationDurationMs,
      totalDurationMs: Math.round(totalDurationMs),
      avgDurationMs: Math.round(avgDurationMs),
      maxFixationDurationMs: Math.round(maxFixationDurationMs),
      firstEnterTimeMs,
      visitorCount,
      visits,
      revisitCount,
      reVisitorCount,
      totalVisitDurationMs: Math.round(visitDurationByDefinition),
      firstVisitDurationMs: Math.round(firstVisitDurationByDefinition),
      firstVisitFixationDurationMs: Math.round(firstVisitFixationDurationMs),
      firstVisitFixationCount: Math.round(firstVisitFixationCount),
      avgVisitDurationMs: Math.round(avgVisitDurationMs),
      totalSaccadeDurationMs: Math.round(totalSaccadeDurationMs),
      saccadeCount: Math.round(saccadeCount),
      saccadeVelocityCount,
      saccadeAmplitudeCount: Math.round(saccadeAmplitudeCount),
      avgSaccadeDurationMs: Math.round(avgSaccadeDurationMs),
      avgSaccadeVelocity,
      avgSaccadeAmplitude,
      peakSaccadeVelocity: peakSaccadeVelocity > 0 ? peakSaccadeVelocity : null,
      avgPupilDiameter: avgPupilDiameter !== null ? avgPupilDiameter : null,
      pupilSampleCount,
      totalBlinkDurationMs: blinkData === undefined ? Math.round(totalBlinkDurationMs) : null,
      blinkCount: blinkData === undefined ? Math.round(blinkCount) : null,
      avgBlinkDurationMs: blinkData === undefined ? Math.round(avgBlinkDurationMs) : null,
      ...(blinkData ? { blinkDataStatus: blinkData.intervals.length > 0 ? 'unlocalized_intervals' as const : 'not_observed' as const } : {}),
      minFixationDurationMs: Math.round(Number.isFinite(minFixationDurationMs) ? minFixationDurationMs : 0),
      secondFixationDurationMs,
      regressionDurationMs,
      longFixationCount,
    };
  });
}
