const TIMESTAMP_UNIT_SCALE_CANDIDATES = [1, 0.001, 1000];
const DEFAULT_DRIFT_TOLERANCE_RATIO = 0.02;

export function pickTimestampUnitScale(spanMs: number, durationMs: number): number {
  const safeSpan = Number.isFinite(spanMs) ? Math.max(0, spanMs) : 0;
  const safeDuration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  if (safeSpan <= 0 || safeDuration <= 0) return 1;

  let best = 1;
  let bestErr = Infinity;
  for (const candidate of TIMESTAMP_UNIT_SCALE_CANDIDATES) {
    const err = Math.abs(safeSpan * candidate - safeDuration);
    if (err < bestErr) {
      bestErr = err;
      best = candidate;
    }
  }
  return best;
}

export function applyPositiveDriftScaleCorrection(params: {
  maxTs: number;
  baseTs: number;
  scale: number;
  durationMs: number;
  toleranceRatio?: number;
}): number {
  const { maxTs, baseTs, scale, durationMs, toleranceRatio = DEFAULT_DRIFT_TOLERANCE_RATIO } = params;
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return scale;

  const projectedEndMs = Math.max(0, (maxTs - baseTs) * scale);
  if (projectedEndMs <= 1000) return scale;

  const driftLimitMs = durationMs * (1 + Math.max(0, toleranceRatio));
  if (projectedEndMs <= driftLimitMs) return scale;

  return scale * (durationMs / projectedEndMs);
}
