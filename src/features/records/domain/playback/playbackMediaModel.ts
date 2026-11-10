export type PlaybackMediaSnapshot = {
  recordId: string;
  sourceUrl: string | null;
  durationSeconds: number;
  currentTimeSeconds: number;
  intrinsicWidth: number;
  intrinsicHeight: number;
  readyState: number;
  isPlaying: boolean;
};

export type ContainedMediaLayout = {
  canvasCssWidth: number;
  canvasCssHeight: number;
  drawLeft: number;
  drawTop: number;
  drawWidth: number;
  drawHeight: number;
  devicePixelRatio: number;
};

const finitePositive = (value: unknown): number => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : 0;
};

const finiteNonNegative = (value: unknown): number => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : 0;
};

export const createEmptyPlaybackMediaSnapshot = (
  recordId: string,
  sourceUrl: string | null,
): PlaybackMediaSnapshot => ({
  recordId,
  sourceUrl,
  durationSeconds: 0,
  currentTimeSeconds: 0,
  intrinsicWidth: 0,
  intrinsicHeight: 0,
  readyState: 0,
  isPlaying: false,
});

export const readPlaybackMediaSnapshot = (
  recordId: string,
  sourceUrl: string | null,
  media: Pick<HTMLVideoElement, 'duration' | 'currentTime' | 'videoWidth' | 'videoHeight' | 'readyState' | 'paused' | 'ended'>,
): PlaybackMediaSnapshot => ({
  recordId,
  sourceUrl,
  durationSeconds: finitePositive(media.duration),
  currentTimeSeconds: finiteNonNegative(media.currentTime),
  intrinsicWidth: finitePositive(media.videoWidth),
  intrinsicHeight: finitePositive(media.videoHeight),
  readyState: Math.max(0, Math.round(finiteNonNegative(media.readyState))),
  isPlaying: !media.paused && !media.ended,
});

export const mergePlaybackMediaSnapshot = (
  previous: PlaybackMediaSnapshot,
  next: PlaybackMediaSnapshot,
): PlaybackMediaSnapshot => {
  if (previous.recordId !== next.recordId) return next;
  return {
    ...next,
    durationSeconds: next.durationSeconds || previous.durationSeconds,
    intrinsicWidth: next.intrinsicWidth || previous.intrinsicWidth,
    intrinsicHeight: next.intrinsicHeight || previous.intrinsicHeight,
  };
};

export const resolveEffectiveFrameSize = (params: {
  intrinsicWidth?: number;
  intrinsicHeight?: number;
  recordWidth?: number;
  recordHeight?: number;
}): { width: number; height: number; source: 'media' | 'record' | 'pending' } => {
  const intrinsicWidth = finitePositive(params.intrinsicWidth);
  const intrinsicHeight = finitePositive(params.intrinsicHeight);
  if (intrinsicWidth > 0 && intrinsicHeight > 0) {
    return { width: intrinsicWidth, height: intrinsicHeight, source: 'media' };
  }
  const recordWidth = finitePositive(params.recordWidth);
  const recordHeight = finitePositive(params.recordHeight);
  if (recordWidth > 0 && recordHeight > 0) {
    return { width: recordWidth, height: recordHeight, source: 'record' };
  }
  return { width: 0, height: 0, source: 'pending' };
};

export const computeContainedMediaLayout = (params: {
  containerWidth: number;
  containerHeight: number;
  mediaWidth: number;
  mediaHeight: number;
  devicePixelRatio?: number;
}): ContainedMediaLayout | null => {
  const containerWidth = finitePositive(params.containerWidth);
  const containerHeight = finitePositive(params.containerHeight);
  const mediaWidth = finitePositive(params.mediaWidth);
  const mediaHeight = finitePositive(params.mediaHeight);
  if (containerWidth <= 0 || containerHeight <= 0 || mediaWidth <= 0 || mediaHeight <= 0) return null;
  const scale = Math.min(containerWidth / mediaWidth, containerHeight / mediaHeight);
  const drawWidth = Math.min(containerWidth, mediaWidth * scale);
  const drawHeight = Math.min(containerHeight, mediaHeight * scale);
  return {
    canvasCssWidth: containerWidth,
    canvasCssHeight: containerHeight,
    drawLeft: (containerWidth - drawWidth) / 2,
    drawTop: (containerHeight - drawHeight) / 2,
    drawWidth,
    drawHeight,
    devicePixelRatio: Math.max(1, finitePositive(params.devicePixelRatio) || 1),
  };
};

export const playbackProgressPercent = (currentTimeSeconds: number, durationSeconds: number): number => {
  const duration = finitePositive(durationSeconds);
  if (duration <= 0) return 0;
  return Math.max(0, Math.min(100, (finiteNonNegative(currentTimeSeconds) / duration) * 100));
};
