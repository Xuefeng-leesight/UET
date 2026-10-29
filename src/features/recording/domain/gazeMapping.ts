export type GlassesGazeSpace = 'normalized' | 'centered_pixels' | 'centered_small';

export type NormalizeGazePointParams = {
  rawX: unknown;
  rawY: unknown;
  isGlassesMode: boolean;
  frameWidth?: number;
  frameHeight?: number;
  glassesSpaceHint?: GlassesGazeSpace | null;
};

export type NormalizeGazePointResult = {
  point: { x: number; y: number } | null;
  glassesSpace: GlassesGazeSpace | null;
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const SMALL_CENTERED_THRESHOLD = 32;
const CENTERED_FRAME_TOLERANCE = 0.03;

const parseFiniteNumber = (value: unknown): number | null => {
  const n = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : null;
};

export const isUsableNormalizedGazePoint = (rawX: unknown, rawY: unknown): boolean => {
  const x = parseFiniteNumber(rawX);
  const y = parseFiniteNumber(rawY);
  if (x === null || y === null) return false;
  if (Math.abs(x) < 0.000001 && Math.abs(y) < 0.000001) return false;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1;
};

export const isDisabledSmallCenteredGlassesPoint = (rawX: unknown, rawY: unknown): boolean => {
  const x = parseFiniteNumber(rawX);
  const y = parseFiniteNumber(rawY);
  if (x === null || y === null) return false;
  const outsideNormalized =
    x < -0.01 ||
    x > 1.01 ||
    y < -0.01 ||
    y > 1.01;
  if (!outsideNormalized) return false;
  return Math.max(Math.abs(x), Math.abs(y)) <= SMALL_CENTERED_THRESHOLD;
};

export const normalizeGazePoint = (params: NormalizeGazePointParams): NormalizeGazePointResult => {
  const {
    rawX,
    rawY,
    isGlassesMode,
    frameWidth = 1280,
    frameHeight = 720,
    glassesSpaceHint = null,
  } = params;

  const x = parseFiniteNumber(rawX);
  const y = parseFiniteNumber(rawY);
  if (x === null || y === null) {
    return { point: null, glassesSpace: isGlassesMode ? glassesSpaceHint : null };
  }

  if (!isGlassesMode) {
    return { point: { x: clamp01(x), y: clamp01(y) }, glassesSpace: null };
  }

  const outsideNormalized =
    x < -0.01 ||
    x > 1.01 ||
    y < -0.01 ||
    y > 1.01;
  if (isDisabledSmallCenteredGlassesPoint(x, y)) {
    return { point: null, glassesSpace: null };
  }

  const absMax = Math.max(Math.abs(x), Math.abs(y));
  const inferCenteredMode = (): GlassesGazeSpace =>
    absMax <= SMALL_CENTERED_THRESHOLD ? 'normalized' : 'centered_pixels';

  let inferredSpace: GlassesGazeSpace;
  if (outsideNormalized) {
    if (glassesSpaceHint === 'centered_pixels') {
      inferredSpace = glassesSpaceHint;
    } else {
      inferredSpace = inferCenteredMode();
    }
  } else if (glassesSpaceHint === 'centered_pixels') {
    inferredSpace = glassesSpaceHint;
  } else {
    inferredSpace = 'normalized';
  }

  if (inferredSpace === 'centered_pixels') {
    const safeW = Math.max(1, Number(frameWidth) || 1280);
    const safeH = Math.max(1, Number(frameHeight) || 720);
    const nx = (x + safeW * 0.5) / safeW;
    const ny = (y + safeH * 0.5) / safeH;
    if (
      nx < -CENTERED_FRAME_TOLERANCE ||
      nx > 1 + CENTERED_FRAME_TOLERANCE ||
      ny < -CENTERED_FRAME_TOLERANCE ||
      ny > 1 + CENTERED_FRAME_TOLERANCE
    ) {
      return { point: null, glassesSpace: 'centered_pixels' };
    }
    return {
      point: {
        x: clamp01(nx),
        y: clamp01(ny),
      },
      glassesSpace: 'centered_pixels',
    };
  }

  return {
    point: { x: clamp01(x), y: clamp01(y) },
    glassesSpace: 'normalized',
  };
};

/** object-contain geometry; coordinates are relative to the source image, never its letterbox. */
export const containedImageBox = (width: number, height: number, sourceWidth: number, sourceHeight: number) => {
  if (![width, height, sourceWidth, sourceHeight].every((v) => Number.isFinite(v) && v > 0)) return null;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const imageWidth = sourceWidth * scale;
  const imageHeight = sourceHeight * scale;
  return { left: (width - imageWidth) / 2, top: (height - imageHeight) / 2, width: imageWidth, height: imageHeight };
};

export const pointerToImagePoint = (
  clientX: number, clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  sourceWidth: number, sourceHeight: number,
): { x: number; y: number } | null => {
  const box = containedImageBox(rect.width, rect.height, sourceWidth, sourceHeight);
  if (!box || ![clientX, clientY, rect.left, rect.top].every(Number.isFinite)) return null;
  const x = (clientX - rect.left - box.left) / box.width;
  const y = (clientY - rect.top - box.top) / box.height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
};
