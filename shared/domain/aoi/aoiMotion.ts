import type { AoiKeyframe, AoiPoint, AoiShape } from './aoiTypes';

type AoiGeometryCarrier = {
  type: AoiShape['type'];
  metric?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  points?: AoiPoint[];
  keyframes?: AoiKeyframe[];
};

function clonePoints(points?: AoiPoint[]): AoiPoint[] {
  return Array.isArray(points) ? points.map((point) => ({ x: point.x, y: point.y })) : [];
}

function polygonArea(points: AoiPoint[]): number {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y - points[j].x * points[i].y;
  }
  return Math.abs(area / 2);
}

export function computeAoiMetric(
  type: AoiShape['type'],
  geometry: Pick<AoiGeometryCarrier, 'x' | 'y' | 'w' | 'h' | 'points'>,
): number {
  if (type === 'polygon') {
    return Math.round(polygonArea(clonePoints(geometry.points)));
  }
  const width = typeof geometry.w === 'number' && Number.isFinite(geometry.w) ? geometry.w : 0;
  const height = typeof geometry.h === 'number' && Number.isFinite(geometry.h) ? geometry.h : 0;
  if (type === 'ellipse') {
    return Math.round(Math.PI * (width / 2) * (height / 2));
  }
  return Math.round(width * height);
}

export function getAoiGeometrySnapshot<T extends AoiGeometryCarrier>(shape: T): AoiKeyframe {
  const snapshot: AoiKeyframe = {
    timeMs: 0,
    metric: computeAoiMetric(shape.type, shape),
  };
  if (shape.type === 'polygon') {
    snapshot.points = clonePoints(shape.points);
    return snapshot;
  }
  snapshot.x = typeof shape.x === 'number' && Number.isFinite(shape.x) ? shape.x : 0;
  snapshot.y = typeof shape.y === 'number' && Number.isFinite(shape.y) ? shape.y : 0;
  snapshot.w = typeof shape.w === 'number' && Number.isFinite(shape.w) ? shape.w : 0;
  snapshot.h = typeof shape.h === 'number' && Number.isFinite(shape.h) ? shape.h : 0;
  return snapshot;
}

export function applyAoiGeometry<T extends AoiGeometryCarrier>(shape: T, geometry: Partial<AoiKeyframe>): T {
  const metric = computeAoiMetric(shape.type, geometry);
  const next = { ...shape, metric } as T & Record<string, unknown>;
  if (shape.type === 'polygon') {
    next.points = clonePoints(geometry.points);
    delete next.x;
    delete next.y;
    delete next.w;
    delete next.h;
    return next as T;
  }
  next.x = typeof geometry.x === 'number' && Number.isFinite(geometry.x) ? geometry.x : 0;
  next.y = typeof geometry.y === 'number' && Number.isFinite(geometry.y) ? geometry.y : 0;
  next.w = typeof geometry.w === 'number' && Number.isFinite(geometry.w) ? geometry.w : 0;
  next.h = typeof geometry.h === 'number' && Number.isFinite(geometry.h) ? geometry.h : 0;
  delete next.points;
  return next as T;
}

export function sortAoiKeyframes(keyframes?: AoiKeyframe[]): AoiKeyframe[] {
  return (Array.isArray(keyframes) ? keyframes : [])
    .filter(
      (keyframe): keyframe is AoiKeyframe =>
        !!keyframe &&
        typeof keyframe.timeMs === 'number' &&
        Number.isFinite(keyframe.timeMs) &&
        keyframe.timeMs > 0,
    )
    .map((keyframe) => ({
      ...keyframe,
      timeMs: Math.max(0, Math.round(keyframe.timeMs)),
      metric:
        typeof keyframe.metric === 'number' && Number.isFinite(keyframe.metric)
          ? keyframe.metric
          : 0,
      points: clonePoints(keyframe.points),
    }))
    .sort((a, b) => a.timeMs - b.timeMs);
}

function interpolateNumber(fromValue: number, toValue: number, ratio: number): number {
  return fromValue + (toValue - fromValue) * ratio;
}

function interpolatePoints(fromPoints: AoiPoint[], toPoints: AoiPoint[], ratio: number): AoiPoint[] {
  if (fromPoints.length !== toPoints.length) {
    return ratio < 0.5 ? clonePoints(fromPoints) : clonePoints(toPoints);
  }
  return fromPoints.map((point, index) => ({
    x: interpolateNumber(point.x, toPoints[index].x, ratio),
    y: interpolateNumber(point.y, toPoints[index].y, ratio),
  }));
}

function interpolateGeometry(
  type: AoiShape['type'],
  fromGeometry: AoiKeyframe,
  toGeometry: AoiKeyframe,
  ratio: number,
): AoiKeyframe {
  const t = Math.max(0, Math.min(1, ratio));
  if (type === 'polygon') {
    return {
      timeMs: Math.round(interpolateNumber(fromGeometry.timeMs, toGeometry.timeMs, t)),
      points: interpolatePoints(clonePoints(fromGeometry.points), clonePoints(toGeometry.points), t),
      metric: 0,
    };
  }
  return {
    timeMs: Math.round(interpolateNumber(fromGeometry.timeMs, toGeometry.timeMs, t)),
    x: interpolateNumber(fromGeometry.x || 0, toGeometry.x || 0, t),
    y: interpolateNumber(fromGeometry.y || 0, toGeometry.y || 0, t),
    w: interpolateNumber(fromGeometry.w || 0, toGeometry.w || 0, t),
    h: interpolateNumber(fromGeometry.h || 0, toGeometry.h || 0, t),
    metric: 0,
  };
}

export function resolveAoiShapeAtTime<T extends AoiGeometryCarrier>(shape: T, timeMs: number): T {
  const keyframes = sortAoiKeyframes(shape.keyframes);
  if (keyframes.length === 0 || timeMs <= 0) {
    return applyAoiGeometry(shape, getAoiGeometrySnapshot(shape));
  }

  const baseGeometry = getAoiGeometrySnapshot(shape);
  let previous = baseGeometry;
  for (const keyframe of keyframes) {
    if (timeMs === keyframe.timeMs) {
      return applyAoiGeometry(shape, keyframe);
    }
    if (timeMs < keyframe.timeMs) {
      const span = Math.max(1, keyframe.timeMs - previous.timeMs);
      const ratio = (timeMs - previous.timeMs) / span;
      return applyAoiGeometry(shape, interpolateGeometry(shape.type, previous, keyframe, ratio));
    }
    previous = keyframe;
  }

  return applyAoiGeometry(shape, previous);
}

export function upsertAoiKeyframe<T extends AoiGeometryCarrier>(
  shape: T,
  timeMs: number,
  geometry?: Partial<AoiKeyframe>,
): T {
  const targetTime = Math.max(0, Math.round(timeMs));
  const snapshot = geometry ? { ...geometry } : getAoiGeometrySnapshot(resolveAoiShapeAtTime(shape, targetTime));
  const nextGeometry: AoiKeyframe = {
    ...snapshot,
    timeMs: targetTime,
    metric: computeAoiMetric(shape.type, snapshot),
    points: clonePoints(snapshot.points),
  };

  if (targetTime <= 0) {
    return applyAoiGeometry(shape, nextGeometry);
  }

  const keyframes = sortAoiKeyframes(shape.keyframes).filter((keyframe) => keyframe.timeMs !== targetTime);
  keyframes.push(nextGeometry);
  keyframes.sort((a, b) => a.timeMs - b.timeMs);
  return { ...shape, keyframes } as T;
}

export function removeAoiKeyframe<T extends AoiGeometryCarrier>(shape: T, timeMs: number): T {
  const targetTime = Math.max(0, Math.round(timeMs));
  return {
    ...shape,
    keyframes: sortAoiKeyframes(shape.keyframes).filter((keyframe) => keyframe.timeMs !== targetTime),
  } as T;
}

export function findNearbyKeyframeTime<T extends AoiGeometryCarrier>(
  shape: T,
  timeMs: number,
  toleranceMs: number,
): number | null {
  const targetTime = Math.max(0, Math.round(timeMs));
  const tolerance = Math.max(0, Math.round(toleranceMs));
  const keyframes = sortAoiKeyframes(shape.keyframes);
  const exact = keyframes.find((keyframe) => Math.abs(keyframe.timeMs - targetTime) <= tolerance);
  return exact ? exact.timeMs : null;
}
