type DetectMessage = {
  type: 'detect';
  width: number;
  height: number;
  buffer: ArrayBuffer;
};

type CloseMessage = {
  type: 'close';
};

type OpenCvRuntime = typeof import('@techstark/opencv-js');
type DetectionMode = 'target-detector-canny';

const OUTER_MIN_CIRCULARITY = 0.6;
const TARGET_DETECTOR_MIN_AREA = 500;
const TARGET_DETECTOR_MIN_AREA_RATIO = 0.00054;
const TARGET_DETECTOR_MIN_AREA_FLOOR = 80;
const TARGET_DETECTOR_CENTER_DISTANCE_PX = 20;
const TARGET_DETECTOR_MIN_HOLE_AREA_RATIO = 0.08;
const TARGET_DETECTOR_MAX_HOLE_AREA_RATIO = 0.6;
const MAX_DIAGNOSTIC_CANDIDATES = 5;
const TARGET_INNER_OUTER_RADIUS_RATIO = 0.45;

let cvReadyPromise: Promise<OpenCvRuntime> | null = null;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const perspectiveCorrectConcentricCenter = (
  outerCenter: { x: number; y: number },
  innerCenter: { x: number; y: number },
): { x: number; y: number } => {
  const ratioSq = TARGET_INNER_OUTER_RADIUS_RATIO * TARGET_INNER_OUTER_RADIUS_RATIO;
  const denominator = Math.max(1e-6, 1 - ratioSq);
  return {
    x: (innerCenter.x - ratioSq * outerCenter.x) / denominator,
    y: (innerCenter.y - ratioSq * outerCenter.y) / denominator,
  };
};

async function getOpenCv(): Promise<OpenCvRuntime> {
  if (!cvReadyPromise) {
    cvReadyPromise = import('@techstark/opencv-js').then(async (module) => {
      const moduleRecord = module as unknown as Record<string, unknown>;
      const ready = moduleRecord.default ?? module;
      return await Promise.resolve(ready) as OpenCvRuntime;
    });
  }
  return cvReadyPromise;
}

function detectBullseyeCenter(
  cv: OpenCvRuntime,
  message: DetectMessage,
): {
  point: { x: number; y: number; confidence: number } | null;
  diagnostics: {
    width: number;
    height: number;
    contours: number;
    minArea: number;
    config: {
      outerMinCircularity: number;
      centerDistancePx: number;
      innerOuterRadiusRatio: number;
      minHoleAreaRatio: number;
      maxHoleAreaRatio: number;
    };
    selectedCandidate: {
      contourIndex: number;
      x: number;
      y: number;
      confidence: number;
      areaRatio: number;
      circularity: number;
      aspectRatio: number;
      centerDistanceRatio: number;
      holeAreaRatio: number;
      dotAreaRatio: number;
      rawCenters: {
        outer: { x: number; y: number };
        hole: { x: number; y: number };
        dot: { x: number; y: number };
      };
      correctedCenter: { x: number; y: number };
      correctionDelta: { x: number; y: number };
      rect: { x: number; y: number; width: number; height: number };
      detector: 'black-ring';
      mode: DetectionMode;
    } | null;
    candidates: Array<{
      contourIndex: number;
      x: number;
      y: number;
      confidence: number;
      areaRatio: number;
      circularity: number;
      aspectRatio: number;
      centerDistanceRatio: number;
      holeAreaRatio: number;
      dotAreaRatio: number;
      rawCenters: {
        outer: { x: number; y: number };
        hole: { x: number; y: number };
        dot: { x: number; y: number };
      };
      correctedCenter: { x: number; y: number };
      correctionDelta: { x: number; y: number };
      rect: { x: number; y: number; width: number; height: number };
      detector: 'black-ring';
      mode: DetectionMode;
    }>;
  };
} {
  const width = Math.max(1, Math.floor(message.width || 1));
  const height = Math.max(1, Math.floor(message.height || 1));
  const rgba = new Uint8ClampedArray(message.buffer);
  const pixels = width * height;
  if (rgba.length < pixels * 4) {
    return {
      point: null,
      diagnostics: {
        width,
        height,
        contours: 0,
        minArea: 0,
        config: {
          outerMinCircularity: OUTER_MIN_CIRCULARITY,
          centerDistancePx: TARGET_DETECTOR_CENTER_DISTANCE_PX,
          innerOuterRadiusRatio: TARGET_INNER_OUTER_RADIUS_RATIO,
          minHoleAreaRatio: TARGET_DETECTOR_MIN_HOLE_AREA_RATIO,
          maxHoleAreaRatio: TARGET_DETECTOR_MAX_HOLE_AREA_RATIO,
        },
        selectedCandidate: null,
        candidates: [],
      },
    };
  }

  const source = new cv.Mat(height, width, cv.CV_8UC4);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    source.data.set(rgba);
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(blurred, edges, 50, 150, 3, false);
    cv.findContours(edges, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);

    const total = contours.size();
    const frameArea = width * height;
    const minArea = Math.max(
      TARGET_DETECTOR_MIN_AREA_FLOOR,
      Math.min(TARGET_DETECTOR_MIN_AREA, Math.floor(frameArea * TARGET_DETECTOR_MIN_AREA_RATIO)),
    );
    const hierarchyData = hierarchy.data32S;

    let bestPoint: { x: number; y: number; confidence: number } | null = null;
    let bestArea = 0;
    let bestConfidence = -1;
    let selectedCandidate:
      | {
          contourIndex: number;
          x: number;
          y: number;
          confidence: number;
          areaRatio: number;
          circularity: number;
          aspectRatio: number;
          centerDistanceRatio: number;
          holeAreaRatio: number;
          dotAreaRatio: number;
          rawCenters: {
            outer: { x: number; y: number };
            hole: { x: number; y: number };
            dot: { x: number; y: number };
          };
          correctedCenter: { x: number; y: number };
          correctionDelta: { x: number; y: number };
          rect: { x: number; y: number; width: number; height: number };
          detector: 'black-ring';
          mode: DetectionMode;
        }
      | null = null;
    const candidates: Array<{
      contourIndex: number;
      x: number;
      y: number;
      confidence: number;
      areaRatio: number;
      circularity: number;
      aspectRatio: number;
      centerDistanceRatio: number;
      holeAreaRatio: number;
      dotAreaRatio: number;
      rawCenters: {
        outer: { x: number; y: number };
        hole: { x: number; y: number };
        dot: { x: number; y: number };
      };
      correctedCenter: { x: number; y: number };
      correctionDelta: { x: number; y: number };
      rect: { x: number; y: number; width: number; height: number };
      detector: 'black-ring';
      mode: DetectionMode;
    }> = [];

    for (let i = 0; i < total; i++) {
      const child = hierarchyData[i * 4 + 2];
      if (child === -1) continue;
      const grandChild = hierarchyData[child * 4 + 2];
      if (grandChild === -1) continue;
      const cnt0 = contours.get(i);
      const cnt1 = contours.get(child);
      const cnt2 = contours.get(grandChild);
      try {
        const area = Math.abs(cv.contourArea(cnt0));
        if (area < minArea) continue;

        const perimeter = cv.arcLength(cnt0, true);
        if (perimeter <= 0) continue;
        const circularity = (4 * Math.PI * area) / (perimeter * perimeter);
        if (circularity <= OUTER_MIN_CIRCULARITY) continue;

        const M0 = cv.moments(cnt0, false);
        const M1 = cv.moments(cnt1, false);
        const M2 = cv.moments(cnt2, false);
        if (
          !M0 ||
          !M1 ||
          !M2 ||
          Math.abs(M0.m00) <= 1e-6 ||
          Math.abs(M1.m00) <= 1e-6 ||
          Math.abs(M2.m00) <= 1e-6
        ) {
          continue;
        }

        const area1 = Math.abs(cv.contourArea(cnt1));
        const areaRatio1 = area > 0 ? area1 / area : 0;
        const area2 = Math.abs(cv.contourArea(cnt2));
        const areaRatio2 = area > 0 ? area2 / area : 0;
        if (areaRatio1 < TARGET_DETECTOR_MIN_HOLE_AREA_RATIO || areaRatio1 > TARGET_DETECTOR_MAX_HOLE_AREA_RATIO) continue;

        const cx0 = M0.m10 / M0.m00;
        const cy0 = M0.m01 / M0.m00;
        const cx1 = M1.m10 / M1.m00;
        const cy1 = M1.m01 / M1.m00;
        const cx2 = M2.m10 / M2.m00;
        const cy2 = M2.m01 / M2.m00;
        const dist1 = Math.hypot(cx0 - cx1, cy0 - cy1);
        const dist2 = Math.hypot(cx1 - cx2, cy1 - cy2);
        if (dist1 >= TARGET_DETECTOR_CENTER_DISTANCE_PX || dist2 >= TARGET_DETECTOR_CENTER_DISTANCE_PX) continue;

        const rect = cv.boundingRect(cnt0);
        const aspectRatio = rect.height > 0 ? rect.width / rect.height : 0;
        const correctedCenter = perspectiveCorrectConcentricCenter(
          { x: cx0, y: cy0 },
          { x: cx1, y: cy1 },
        );
        const correctionDelta = {
          x: correctedCenter.x - cx2,
          y: correctedCenter.y - cy2,
        };
        const x = clamp01(correctedCenter.x / Math.max(1, width - 1));
        const y = clamp01(correctedCenter.y / Math.max(1, height - 1));
        const centerDistanceRatio = Math.max(dist1, dist2) / TARGET_DETECTOR_CENTER_DISTANCE_PX;
        const circularityScore = clamp01((circularity - OUTER_MIN_CIRCULARITY) / 0.4);
        const centerScore = clamp01(1 - centerDistanceRatio);
        const sizeScore = clamp01(area / Math.max(1, TARGET_DETECTOR_MIN_AREA * 4));
        const confidence = clamp01(0.68 + circularityScore * 0.12 + centerScore * 0.15 + sizeScore * 0.05);
        const candidate = {
          contourIndex: i,
          x,
          y,
          confidence,
          areaRatio: area / frameArea,
          circularity,
          aspectRatio,
          centerDistanceRatio,
          holeAreaRatio: areaRatio1,
          dotAreaRatio: areaRatio2,
          rawCenters: {
            outer: { x: cx0, y: cy0 },
            hole: { x: cx1, y: cy1 },
            dot: { x: cx2, y: cy2 },
          },
          correctedCenter: { x: correctedCenter.x, y: correctedCenter.y },
          correctionDelta,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          detector: 'black-ring' as const,
          mode: 'target-detector-canny' as const,
        };
        candidates.push(candidate);
        if (confidence > bestConfidence || (confidence === bestConfidence && area > bestArea)) {
          bestConfidence = confidence;
          bestArea = area;
          bestPoint = { x, y, confidence };
          selectedCandidate = candidate;
        }
      } finally {
        cnt2.delete();
        cnt1.delete();
        cnt0.delete();
      }
    }

    candidates.sort((a, b) => b.confidence - a.confidence || b.areaRatio - a.areaRatio);
    return {
      point: bestPoint,
      diagnostics: {
        width,
        height,
        contours: total,
        minArea,
        config: {
          outerMinCircularity: OUTER_MIN_CIRCULARITY,
          centerDistancePx: TARGET_DETECTOR_CENTER_DISTANCE_PX,
          innerOuterRadiusRatio: TARGET_INNER_OUTER_RADIUS_RATIO,
          minHoleAreaRatio: TARGET_DETECTOR_MIN_HOLE_AREA_RATIO,
          maxHoleAreaRatio: TARGET_DETECTOR_MAX_HOLE_AREA_RATIO,
        },
        selectedCandidate,
        candidates: candidates.slice(0, MAX_DIAGNOSTIC_CANDIDATES),
      },
    };
  } finally {
    source.delete();
    gray.delete();
    blurred.delete();
    edges.delete();
    contours.delete();
    hierarchy.delete();
  }
}

self.onmessage = (event: MessageEvent<DetectMessage | CloseMessage>) => {
  const message = event.data;
  if (!message || message.type === 'close') return;
  void (async () => {
    try {
      const cv = await getOpenCv();
      const result = detectBullseyeCenter(cv, message);
      self.postMessage({ type: 'result', point: result.point, diagnostics: result.diagnostics });
    } catch (error: unknown) {
      self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  })();
};
