export const getPlaybackGazeWindow = (timeMs: number) => {
  const lookBehindMs = 5_000;
  const stepMs = 10_000;
  const startTimeMs = Math.floor(Math.max(0, timeMs - lookBehindMs) / stepMs) * stepMs;
  return { startTimeMs, endTimeMs: startTimeMs + 30_000 };
};

export const buildPlaybackGazeRequestKey = (params: {
  recordId: string;
  csvPath: string;
  pointSource: string;
  deviceSpace: 'glasses' | 'desktop';
  frameWidth: number;
  frameHeight: number;
  startTimeMs: number;
  endTimeMs: number;
}) => [
  params.recordId,
  params.csvPath,
  params.pointSource,
  params.deviceSpace,
  params.frameWidth,
  params.frameHeight,
  params.startTimeMs,
  params.endTimeMs,
].join('|');
