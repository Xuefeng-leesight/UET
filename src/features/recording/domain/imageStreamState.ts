export type ImageStreamState = 'disconnected' | 'waiting' | 'active' | 'stale';

export const IMAGE_STREAM_STALE_AFTER_MS = 2000;

export function getImageStreamState({
  connected,
  lastFrameAt,
  now = Date.now(),
  staleAfterMs = IMAGE_STREAM_STALE_AFTER_MS,
}: {
  connected: boolean;
  lastFrameAt: number | null;
  now?: number;
  staleAfterMs?: number;
}): ImageStreamState {
  if (!connected) return 'disconnected';
  if (lastFrameAt === null) return 'waiting';
  return Math.max(0, now - lastFrameAt) < staleAfterMs ? 'active' : 'stale';
}

export const IMAGE_STREAM_LABELS: Record<ImageStreamState, string> = {
  disconnected: '图像流未连接',
  waiting: '等待首帧',
  active: '数据正常',
  stale: '数据超时',
};
