import { useEffect, useState } from 'react';
import { isDisabledSmallCenteredGlassesPoint, isUsableNormalizedGazePoint } from '@/features/recording/domain/gazeMapping';

export type GazeDisplayPath = 'recommended' | 'raw' | 'smooth';

export const DEFAULT_GAZE_DISPLAY_PATH: GazeDisplayPath = 'smooth';
export const GAZE_DISPLAY_PATH_STORAGE_KEY = 'mrt.gazeDisplayPath';
export const GAZE_DISPLAY_PATH_EVENT = 'mrt:gazeDisplayPath';

export const GAZE_DISPLAY_PATH_OPTIONS: Array<{ value: GazeDisplayPath; label: string; labelEn: string }> = [
  { value: 'recommended', label: '推荐注视点', labelEn: 'Recommended gaze' },
  { value: 'raw', label: '原始注视点', labelEn: 'Raw gaze' },
  { value: 'smooth', label: '平滑注视点', labelEn: 'Smoothed gaze' },
];

export type GazePointLike = { x: number; y: number };

type EyeDataLike = Record<string, unknown>;

const normalizePath = (value: unknown): GazeDisplayPath => {
  return value === 'recommended' || value === 'raw' || value === 'smooth' ? value : DEFAULT_GAZE_DISPLAY_PATH;
};

export const getStoredGazeDisplayPath = (): GazeDisplayPath => {
  if (typeof window === 'undefined') return DEFAULT_GAZE_DISPLAY_PATH;
  try {
    return normalizePath(window.localStorage.getItem(GAZE_DISPLAY_PATH_STORAGE_KEY));
  } catch {
    return DEFAULT_GAZE_DISPLAY_PATH;
  }
};

export const setStoredGazeDisplayPath = (path: GazeDisplayPath): GazeDisplayPath => {
  const next = normalizePath(path);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(GAZE_DISPLAY_PATH_STORAGE_KEY, next);
      window.dispatchEvent(new CustomEvent(GAZE_DISPLAY_PATH_EVENT, { detail: { path: next } }));
    } catch {
    }
  }
  return next;
};

export function useGazeDisplayPath(): {
  gazeDisplayPath: GazeDisplayPath;
  setGazeDisplayPath: (path: GazeDisplayPath) => void;
} {
  const [gazeDisplayPath, setGazeDisplayPathState] = useState<GazeDisplayPath>(() => getStoredGazeDisplayPath());

  useEffect(() => {
    const onCustom = (event: Event) => {
      const next = normalizePath((event as CustomEvent<{ path?: unknown }>).detail?.path);
      setGazeDisplayPathState(next);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== GAZE_DISPLAY_PATH_STORAGE_KEY) return;
      setGazeDisplayPathState(getStoredGazeDisplayPath());
    };
    window.addEventListener(GAZE_DISPLAY_PATH_EVENT, onCustom as EventListener);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(GAZE_DISPLAY_PATH_EVENT, onCustom as EventListener);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return {
    gazeDisplayPath,
    setGazeDisplayPath: (path: GazeDisplayPath) => {
      setGazeDisplayPathState(setStoredGazeDisplayPath(path));
    },
  };
}

const toNumber = (value: unknown): number => {
  const n = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : NaN;
};

const hasPointBit = (mask: number, bit: number): boolean => Number.isFinite(mask) && (Math.trunc(mask) & bit) === bit;

const isZeroPair = (x: number, y: number): boolean => Math.abs(x) < 0.000001 && Math.abs(y) < 0.000001;

const isUsablePoint = (
  point: GazePointLike,
  mask: number,
  requiredBit: number,
  isGlassesMode: boolean,
): boolean => {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  if (isZeroPair(point.x, point.y)) return false;
  if (isGlassesMode) {
    if (isDisabledSmallCenteredGlassesPoint(point.x, point.y)) return false;
    if (!Number.isFinite(mask)) return true;
    const maskValue = Math.trunc(mask);
    const looksLikeCenteredCoordinate = Math.max(Math.abs(point.x), Math.abs(point.y)) > 1.01;
    return hasPointBit(maskValue, requiredBit) || maskValue === 0 || looksLikeCenteredCoordinate;
  }
  if (Number.isFinite(mask)) {
    const maskValue = Math.trunc(mask);
    // Some desktop SDK builds return valid normalized gaze coordinates while
    // leaving gaze_bit_mask at 0. The Python adapter intentionally supports
    // that compatibility case, so the renderer must not discard the point.
    if (maskValue !== 0 && !hasPointBit(maskValue, requiredBit)) return false;
  }
  return isUsableNormalizedGazePoint(point.x, point.y);
};

const averagePair = (left: GazePointLike | null, right: GazePointLike | null): GazePointLike | null => {
  if (left && right) return { x: (left.x + right.x) * 0.5, y: (left.y + right.y) * 0.5 };
  return left || right;
};

export const selectGazeDisplayPoint = (
  eyeData: EyeDataLike | null | undefined,
  path: GazeDisplayPath,
  options: { isGlassesMode: boolean },
): GazePointLike | null => {
  const data = eyeData || {};
  const isGlassesMode = options.isGlassesMode;
  const masks = {
    recom: toNumber(data.recomGazeBitMask),
    left: toNumber(data.leftGazeBitMask),
    right: toNumber(data.rightGazeBitMask),
  };
  const points = {
    recommended: {
      bit: 0x1,
      recom: isGlassesMode
        ? [
            { x: toNumber(data.recomPointX), y: toNumber(data.recomPointY) },
            { x: toNumber(data.recomGazeX), y: toNumber(data.recomGazeY) },
          ]
        : [{ x: toNumber(data.recomGazeX), y: toNumber(data.recomGazeY) }],
      left: isGlassesMode
        ? [
            { x: toNumber(data.leftPointX), y: toNumber(data.leftPointY) },
            { x: toNumber(data.leftGazeX), y: toNumber(data.leftGazeY) },
          ]
        : [{ x: toNumber(data.leftGazeX), y: toNumber(data.leftGazeY) }],
      right: isGlassesMode
        ? [
            { x: toNumber(data.rightPointX), y: toNumber(data.rightPointY) },
            { x: toNumber(data.rightGazeX), y: toNumber(data.rightGazeY) },
          ]
        : [{ x: toNumber(data.rightGazeX), y: toNumber(data.rightGazeY) }],
    },
    raw: {
      bit: 0x2,
      recom: [{ x: toNumber(data.recomRawX), y: toNumber(data.recomRawY) }],
      left: [{ x: toNumber(data.leftRawX), y: toNumber(data.leftRawY) }],
      right: [{ x: toNumber(data.rightRawX), y: toNumber(data.rightRawY) }],
    },
    smooth: {
      bit: 0x4,
      recom: [{ x: toNumber(data.recomSmoothX), y: toNumber(data.recomSmoothY) }],
      left: [{ x: toNumber(data.leftSmoothX), y: toNumber(data.leftSmoothY) }],
      right: [{ x: toNumber(data.rightSmoothX), y: toNumber(data.rightSmoothY) }],
    },
  };

  const resolvePath = (nextPath: GazeDisplayPath): GazePointLike | null => {
    const config = points[nextPath];
    if (['PupilCore', 'HH_ET10C', 'HH_ET28'].includes(String(data.sourceModel || ''))) {
      // (0,0) is a real world-camera corner, not the vendor SDK's missing-value sentinel.
      return config.recom.find((p) => hasPointBit(masks.recom, config.bit)
        && Number.isFinite(p.x) && Number.isFinite(p.y)
        && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) || null;
    }
    const validFrom = (items: GazePointLike[], mask: number): GazePointLike | null => {
      for (const item of items) {
        if (isUsablePoint(item, mask, config.bit, isGlassesMode)) return item;
      }
      return null;
    };
    const recom = validFrom(config.recom, masks.recom);
    if (recom) return recom;
    return averagePair(validFrom(config.left, masks.left), validFrom(config.right, masks.right));
  };

  const primary = resolvePath(normalizePath(path));
  if (primary) return primary;
  for (const fallback of ['smooth', 'recommended', 'raw'] as GazeDisplayPath[]) {
    if (fallback === path) continue;
    const point = resolvePath(fallback);
    if (point) return point;
  }
  return null;
};
