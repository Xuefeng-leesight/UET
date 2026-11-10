import type { HeatmapPoint } from '@/shared/types/mrt';
import type { ContainedMediaLayout } from '@/features/records/domain/playback/playbackMediaModel';

export const findPlaybackGazePoint = (points: HeatmapPoint[], timeMs: number): HeatmapPoint | null => {
  if (points.length === 0) return null;
  let low = 0;
  let high = points.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const timestamp = Number(points[middle]?.timestamp);
    if (!Number.isFinite(timestamp)) {
      high = middle - 1;
    } else if (timestamp <= timeMs) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const previousIndex = Math.max(0, Math.min(points.length - 1, high));
  const nextIndex = Math.max(0, Math.min(points.length - 1, low));
  const previous = points[previousIndex];
  const next = points[nextIndex];
  if (!previous) return next || null;
  if (!next || previousIndex === nextIndex) return previous;
  const previousTimestamp = Number(previous.timestamp);
  const nextTimestamp = Number(next.timestamp);
  if (!Number.isFinite(previousTimestamp) || !Number.isFinite(nextTimestamp) || nextTimestamp <= previousTimestamp) {
    return previous;
  }
  if (![previous.x, previous.y, next.x, next.y].every(Number.isFinite)) return previous;
  const ratio = Math.max(0, Math.min(1, (timeMs - previousTimestamp) / (nextTimestamp - previousTimestamp)));
  return {
    ...previous,
    x: previous.x + (next.x - previous.x) * ratio,
    y: previous.y + (next.y - previous.y) * ratio,
    timestamp: timeMs,
  };
};

export const drawPlaybackGazeCursor = (params: {
  canvas: HTMLCanvasElement;
  point: HeatmapPoint | null;
  layout: ContainedMediaLayout;
  style: string;
  radius: number;
  opacity: number;
  color: string;
  clearCanvas?: boolean;
}): void => {
  const { canvas, point, layout, style, radius, opacity, color, clearCanvas = true } = params;
  const context = canvas.getContext('2d');
  if (!context) return;
  if (clearCanvas) context.clearRect(0, 0, canvas.width, canvas.height);
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;

  const x = (layout.drawLeft + point.x * layout.drawWidth) * layout.devicePixelRatio;
  const y = (layout.drawTop + point.y * layout.drawHeight) * layout.devicePixelRatio;
  const cursorRadius = Math.max(1, Math.min(200, radius)) * layout.devicePixelRatio;
  context.globalAlpha = Math.max(0, Math.min(1, opacity));

  if (style === '十字架') {
    context.strokeStyle = color;
    context.lineWidth = Math.max(1, Math.min(40, Math.round(cursorRadius * 0.25)));
    context.beginPath();
    context.moveTo(x - cursorRadius, y);
    context.lineTo(x + cursorRadius, y);
    context.moveTo(x, y - cursorRadius);
    context.lineTo(x, y + cursorRadius);
    context.stroke();
  } else if (style === '点状') {
    context.fillStyle = color;
    context.beginPath();
    context.arc(x, y, Math.max(1, Math.round(cursorRadius * 0.35)), 0, Math.PI * 2);
    context.fill();
  } else {
    context.shadowBlur = Math.max(0, Math.min(80 * layout.devicePixelRatio, Math.round(cursorRadius * 1.2)));
    context.shadowColor = color;
    context.fillStyle = color;
    context.beginPath();
    context.arc(x, y, Math.max(2, cursorRadius), 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
  }
  context.globalAlpha = 1;
};
