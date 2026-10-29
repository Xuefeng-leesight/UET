/** Align actual I/O observations to the recording's source clock using measured round trips. */
export type SourceClockObservation = {
  sourceTimeS: number;
  sourceTimeOriginS: number;
  beforeMs: number;
  afterMs: number;
  recordingId: string;
  generation: number;
};
export type MainClockObservation = { mainMonotonicMs: number; beforeMs: number; afterMs: number };

function best<T extends { beforeMs: number; afterMs: number }>(observations: readonly T[]): T {
  const candidates = observations.filter(item => Number.isFinite(item.beforeMs) && Number.isFinite(item.afterMs)
    && item.afterMs >= item.beforeMs);
  if (!candidates.length) throw new Error('通信时钟没有有效的往返测量');
  return [...candidates].sort((a, b) => (a.afterMs - a.beforeMs) - (b.afterMs - b.beforeMs))[0];
}

export function alignCommunicationClock(recordingId: string, sources: readonly SourceClockObservation[], mains: readonly MainClockObservation[]) {
  if (!recordingId || !sources.length || sources.some(sample => sample.recordingId !== recordingId
    || !Number.isInteger(sample.generation) || sample.generation < 0
    || sample.generation !== sources[0].generation || !Number.isFinite(sample.sourceTimeS)
    || !Number.isFinite(sample.sourceTimeOriginS) || sample.sourceTimeS < sample.sourceTimeOriginS
    || sample.sourceTimeOriginS !== sources[0].sourceTimeOriginS)) {
    throw new Error('通信时钟的录制或设备连接会话不一致');
  }
  if (mains.some(sample => !Number.isFinite(sample.mainMonotonicMs))) throw new Error('通信主进程时钟无效');
  const source = best(sources);
  const main = best(mains);
  const clockUncertaintyMs = (source.afterMs - source.beforeMs + main.afterMs - main.beforeMs) / 2;
  if (clockUncertaintyMs > 250) throw new Error('通信时钟往返延迟过大，无法可靠对齐录制时间');
  const sourceOffset = (source.sourceTimeS - source.sourceTimeOriginS) * 1000 - (source.beforeMs + source.afterMs) / 2;
  const mainOffset = (main.beforeMs + main.afterMs) / 2 - main.mainMonotonicMs;
  return { generation: source.generation, videoTimeOffsetMs: sourceOffset + mainOffset, clockUncertaintyMs };
}
