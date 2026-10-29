import type { HeatmapPoint } from '@/shared/types/mrt';
export { RECORD_POINTS_PARSE_VERSION as HEATMAP_POINT_PARSE_VERSION } from '@shared/constants/recordPoints';

const heatmapBrushCache = new Map<number, HTMLCanvasElement>();
let heatmapPaletteCache: Uint8ClampedArray | null = null;

export type HeatmapPerspectiveStyle = 'standard' | 'soft';

const getHeatmapBrushCanvas = (radius: number): HTMLCanvasElement => {
  const hit = heatmapBrushCache.get(radius);
  if (hit) return hit;

  const brush = document.createElement('canvas');
  brush.width = radius * 2;
  brush.height = radius * 2;
  const brushCtx = brush.getContext('2d');
  if (brushCtx) {
    const grad = brushCtx.createRadialGradient(radius, radius, 0, radius, radius, radius);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(0.35, 'rgba(0,0,0,0.7)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    brushCtx.fillStyle = grad;
    brushCtx.fillRect(0, 0, radius * 2, radius * 2);
  }

  heatmapBrushCache.set(radius, brush);
  return brush;
};

const getHeatmapPalette = (): Uint8ClampedArray => {
  if (heatmapPaletteCache) return heatmapPaletteCache;

  const paletteCanvas = document.createElement('canvas');
  paletteCanvas.width = 1;
  paletteCanvas.height = 256;
  const palCtx = paletteCanvas.getContext('2d');
  if (!palCtx) {
    heatmapPaletteCache = new Uint8ClampedArray(256 * 4);
    return heatmapPaletteCache;
  }

  const gradient = palCtx.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0.0, 'rgba(0,0,255,0)');
  gradient.addColorStop(0.2, 'rgba(0,70,255,0.85)');
  gradient.addColorStop(0.4, 'rgba(0,210,255,0.9)');
  gradient.addColorStop(0.62, 'rgba(60,220,60,0.92)');
  gradient.addColorStop(0.82, 'rgba(255,210,0,0.95)');
  gradient.addColorStop(1.0, 'rgba(255,55,0,1)');
  palCtx.fillStyle = gradient;
  palCtx.fillRect(0, 0, 1, 256);

  heatmapPaletteCache = palCtx.getImageData(0, 0, 1, 256).data;
  return heatmapPaletteCache;
};

export function drawHeatmap(
  canvas: HTMLCanvasElement,
  points: HeatmapPoint[],
  settings: { radius: number; opacity: number; intensity: number },
  clearCanvas: boolean = true,
): void {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;

  const width = canvas.width;
  const height = canvas.height;

  if (clearCanvas) {
    ctx.clearRect(0, 0, width, height);
  }
  if (points.length === 0) return;

  const validPoints = points.filter(
    (p) =>
      !p.markerOnly &&
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      p.x >= 0 &&
      p.x <= 1 &&
      p.y >= 0 &&
      p.y <= 1,
  );
  if (validPoints.length === 0) return;

  const radius = Math.max(4, Math.round(settings.radius || 0));
  const intensity = Math.max(0.05, Math.min(1, settings.intensity));
  const opacity = Math.max(0.05, Math.min(1, settings.opacity));
  const blurPx = Math.max(2, Math.round(radius * 0.7));

  const brushCanvas = getHeatmapBrushCanvas(radius);

  let maxWeight = 1;
  for (const p of validPoints) {
    const w = typeof p.weight === 'number' && Number.isFinite(p.weight) ? p.weight : 1;
    if (w > maxWeight) maxWeight = w;
  }

  const densityCanvas = document.createElement('canvas');
  densityCanvas.width = width;
  densityCanvas.height = height;
  const densityCtx = densityCanvas.getContext('2d');
  if (!densityCtx) return;

  densityCtx.clearRect(0, 0, width, height);
  densityCtx.globalCompositeOperation = 'lighter';

  validPoints.forEach((p) => {
    const x = p.x * width;
    const y = p.y * height;
    const w = typeof p.weight === 'number' && Number.isFinite(p.weight) ? p.weight : 1;
    const normW = Math.max(0, Math.min(1, w / maxWeight));
    const weighted = Math.pow(normW, 0.72);
    const pointAlpha = intensity * (0.2 + 0.8 * weighted);
    densityCtx.globalAlpha = Math.min(1, pointAlpha);
    densityCtx.drawImage(brushCanvas, x - radius, y - radius);
  });
  densityCtx.globalAlpha = 1;
  densityCtx.globalCompositeOperation = 'source-over';

  const smoothCanvas = document.createElement('canvas');
  smoothCanvas.width = width;
  smoothCanvas.height = height;
  const smoothCtx = smoothCanvas.getContext('2d', { willReadFrequently: true });
  if (!smoothCtx) return;

  smoothCtx.clearRect(0, 0, width, height);
  smoothCtx.filter = `blur(${blurPx}px)`;
  smoothCtx.drawImage(densityCanvas, 0, 0);
  smoothCtx.filter = 'none';
  smoothCtx.globalAlpha = 0.2;
  smoothCtx.drawImage(densityCanvas, 0, 0);
  smoothCtx.globalAlpha = 1;

  const imageData = smoothCtx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const palette = getHeatmapPalette();

  const alphaHistogram = new Uint32Array(256);
  let nonZeroCount = 0;
  for (let i = 3; i < data.length; i += 4) {
    const alpha = data[i];
    if (alpha <= 0) continue;
    alphaHistogram[alpha] += 1;
    nonZeroCount += 1;
  }

  let normAlpha = 255;
  if (nonZeroCount > 0) {
    const target = Math.max(1, Math.floor(nonZeroCount * 0.985));
    let acc = 0;
    for (let a = 1; a < 256; a += 1) {
      acc += alphaHistogram[a];
      if (acc >= target) {
        normAlpha = a;
        break;
      }
    }
  }
  normAlpha = Math.max(24, normAlpha);

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha <= 0) continue;

    const normalized = Math.max(0, Math.min(1, alpha / normAlpha));
    const curved = Math.pow(normalized, 0.72);
    const idx = Math.max(0, Math.min(255, Math.round(curved * 255))) * 4;

    data[i] = palette[idx];
    data[i + 1] = palette[idx + 1];
    data[i + 2] = palette[idx + 2];
    data[i + 3] = Math.min(255, Math.round(255 * opacity * Math.pow(curved, 0.9)));
  }

  ctx.putImageData(imageData, 0, 0);
}

export function drawHeatmapPerspective(
  canvas: HTMLCanvasElement,
  points: HeatmapPoint[],
  settings: { radius: number; opacity: number; intensity: number },
  style: HeatmapPerspectiveStyle = 'standard',
  clearCanvas: boolean = true,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const width = canvas.width;
  const height = canvas.height;

  if (clearCanvas) {
    ctx.clearRect(0, 0, width, height);
  }

  const blackAlpha = style === 'soft' ? 0.82 : 1;
  ctx.fillStyle = `rgba(0,0,0,${blackAlpha})`;
  ctx.fillRect(0, 0, width, height);

  if (points.length === 0) return;

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = width;
  maskCanvas.height = height;

  drawHeatmap(maskCanvas, points, { ...settings, opacity: 1 }, true);

  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(maskCanvas, 0, 0);
  ctx.restore();
}

export function drawGazePaths(
  canvas: HTMLCanvasElement,
  pathsByRecord: Record<string, HeatmapPoint[]>,
  colorsByRecord: Record<string, string>,
  progress: number,
  maxWeight: number,
  settings?: { maxRadius: number; borderWidth: number; opacity: number; showLines: boolean; showBorder: boolean },
  clearCanvas: boolean = true,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const width = canvas.width;
  const height = canvas.height;

  if (clearCanvas) {
    ctx.clearRect(0, 0, width, height);
  }

  const recordIds = Object.keys(pathsByRecord);
  if (recordIds.length === 0) return;

  const maxRadius =
    settings && Number.isFinite(settings.maxRadius) ? Math.max(2, Math.min(260, settings.maxRadius)) : 24;
  const borderWidth =
    settings && Number.isFinite(settings.borderWidth) ? Math.max(1, Math.min(40, settings.borderWidth)) : 2;
  const opacity =
    settings && Number.isFinite(settings.opacity) ? Math.max(0, Math.min(1, settings.opacity)) : 1;
  const showLines = settings ? settings.showLines !== false : true;
  const showBorder = settings ? settings.showBorder !== false : true;

  ctx.globalAlpha = opacity;

  recordIds.forEach((id) => {
    const points = pathsByRecord[id];
    if (!points || points.length === 0) return;
    const color = colorsByRecord[id] || '#ff4b4b';

    const total = points.length;

    if (total === 1) {
      const p0 = points[0];
      const px0 = Math.max(0, Math.min(width, p0.x * width));
      const py0 = Math.max(0, Math.min(height, p0.y * height));
      const w0 = typeof p0.weight === 'number' && Number.isFinite(p0.weight) ? p0.weight : 0;
      const r0 = maxWeight > 0 ? w0 / maxWeight : 0;
      const baseOuter0 = 6 + (maxRadius - 6) * r0;
      const scale0 = Math.max(0, Math.min(1, progress));
      const outerRadius0 = baseOuter0 * scale0;
      const innerRadius0 = showBorder ? Math.max(2, outerRadius0 - borderWidth * 1.2) : outerRadius0;

      if (showBorder) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(px0, py0, outerRadius0, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px0, py0, innerRadius0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#000000';
      ctx.font = '10px system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('1', px0, py0);
      return;
    }

    const segmentCount = Math.max(1, total - 1);
    const clampedProgress = Math.max(0, Math.min(1, progress));
    const pathPos = clampedProgress * segmentCount;
    const lastFullSegment = Math.floor(pathPos);
    const clampedLast = Math.min(segmentCount - 1, Math.max(0, lastFullSegment));
    const segIndexForT = clampedLast;
    const segStartPos = segIndexForT;
    const rawT = pathPos - segStartPos;
    const segmentT = Math.max(0, Math.min(1, rawT));

    if (showLines) {
      ctx.lineWidth = borderWidth;
      ctx.strokeStyle = color;
      ctx.beginPath();
      const pStart = points[0];
      const startX = Math.max(0, Math.min(width, pStart.x * width));
      const startY = Math.max(0, Math.min(height, pStart.y * height));
      ctx.moveTo(startX, startY);

      for (let i = 0; i < segmentCount; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        const ax = Math.max(0, Math.min(width, a.x * width));
        const ay = Math.max(0, Math.min(height, a.y * height));
        const bx = Math.max(0, Math.min(width, b.x * width));
        const by = Math.max(0, Math.min(height, b.y * height));

        if (i < clampedLast) {
          ctx.lineTo(bx, by);
        } else if (i === clampedLast) {
          const ix = ax + (bx - ax) * segmentT;
          const iy = ay + (by - ay) * segmentT;
          ctx.lineTo(ix, iy);
          break;
        }
      }

      ctx.stroke();
    }

    ctx.font = '10px system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const maxVisibleIndex = Math.min(total - 1, clampedLast + 1);

    for (let index = 0; index <= maxVisibleIndex; index += 1) {
      const p = points[index];
      const px = Math.max(0, Math.min(width, p.x * width));
      const py = Math.max(0, Math.min(height, p.y * height));

      const w = typeof p.weight === 'number' && Number.isFinite(p.weight) ? p.weight : 0;
      const ratio = maxWeight > 0 ? w / maxWeight : 0;
      const baseOuter = 6 + (maxRadius - 6) * ratio;

      let scale = 1;
      if (index === clampedLast + 1) {
        scale = segmentT;
      }

      const outerRadius = baseOuter * scale;
      const innerRadius = showBorder ? Math.max(2, outerRadius - borderWidth * 1.2) : outerRadius;

      if (showBorder) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(px, py, outerRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px, py, innerRadius, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#000000';
      const label = String(index + 1);
      ctx.fillText(label, px, py);
    }
  });

  ctx.globalAlpha = 1;
}

export function drawHoneycombCursor(
  canvas: HTMLCanvasElement,
  point: HeatmapPoint | null,
  settings: { cursorStyle: 'solid' | 'hollow' | 'cross'; radius: number; borderWidth: number; opacity: number },
  clearCanvas: boolean = true,
  color: string = '#0ea5e9',
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const width = canvas.width;
  const height = canvas.height;
  
  if (clearCanvas) {
    ctx.clearRect(0, 0, width, height);
  }

  if (!point) return;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;

  const px = Math.max(0, Math.min(width, point.x * width));
  const py = Math.max(0, Math.min(height, point.y * height));

  const radius = Math.max(1, Math.min(500, settings.radius));
  const borderWidth = Math.max(1, Math.min(40, settings.borderWidth));
  const opacity = Math.max(0, Math.min(1, settings.opacity));

  ctx.globalAlpha = opacity;

  const border = '#ffffff';

  if (settings.cursorStyle === 'cross') {
    ctx.strokeStyle = color;
    ctx.lineWidth = borderWidth;
    ctx.beginPath();
    ctx.moveTo(px - radius, py);
    ctx.lineTo(px + radius, py);
    ctx.moveTo(px, py - radius);
    ctx.lineTo(px, py + radius);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }

  if (settings.cursorStyle === 'hollow') {
    ctx.strokeStyle = color;
    ctx.lineWidth = borderWidth;
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(px, py, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = border;
  ctx.lineWidth = borderWidth;
  ctx.beginPath();
  ctx.arc(px, py, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.globalAlpha = 1;
}
