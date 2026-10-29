/** Software clock alignment only. This does not measure microphone hardware latency. */
export type PupilClockSample = {
  sourceTimeS: number;
  midpointMs: number;
  roundTripMs: number;
  generation: number;
  recordingId: string;
  sourceTimeOriginS: number;
};

export type PupilAudioSync = {
  provider: 'PupilCore';
  recordingId: string;
  sourceTimeOriginS: number;
  offsetSeconds: number;
  tempo: number;
  estimatedClockErrorMs: number;
  hardwareLatencyMeasured: false;
};

export function calculatePupilAudioSync(input: {
  first: PupilClockSample; last: PupilClockSample;
  startedMs: number; stoppedMs: number; audioDurationS: number;
}): PupilAudioSync {
  const { first, last, startedMs, stoppedMs, audioDurationS } = input;
  const numbers = [first.sourceTimeS, last.sourceTimeS, first.midpointMs, last.midpointMs,
    first.roundTripMs, last.roundTripMs, first.sourceTimeOriginS, last.sourceTimeOriginS,
    startedMs, stoppedMs, audioDurationS];
  if (!numbers.every(Number.isFinite) || first.recordingId !== last.recordingId
    || first.generation !== last.generation || first.sourceTimeOriginS !== last.sourceTimeOriginS
    || !first.recordingId || first.roundTripMs < 0 || last.roundTripMs < 0
    || Math.max(first.roundTripMs, last.roundTripMs) > 200) {
    throw new Error('Pupil 音频时钟采样无效或连接发生变化，保留原音频供恢复');
  }
  const elapsedMs = last.midpointMs - first.midpointMs;
  const rate = (last.sourceTimeS - first.sourceTimeS) * 1000 / elapsedMs;
  const sourceDuration = (stoppedMs - startedMs) / 1000 * rate;
  const tempo = audioDurationS / sourceDuration;
  if (elapsedMs <= 0 || sourceDuration <= 0 || audioDurationS <= 0
    || rate < 0.99 || rate > 1.01 || tempo < 0.99 || tempo > 1.01) {
    throw new Error('Pupil 或音频时钟跳变，拒绝自动合并');
  }
  return {
    provider: 'PupilCore', recordingId: first.recordingId, sourceTimeOriginS: first.sourceTimeOriginS,
    offsetSeconds: first.sourceTimeS + (startedMs - first.midpointMs) / 1000 * rate - first.sourceTimeOriginS,
    tempo,
    estimatedClockErrorMs: Math.max(first.roundTripMs, last.roundTripMs) / 2,
    hardwareLatencyMeasured: false,
  };
}

export function pupilAudioFilter(sync: PupilAudioSync): string {
  if (!Number.isFinite(sync.offsetSeconds) || Math.abs(sync.offsetSeconds) > 3600
    || !Number.isFinite(sync.tempo) || sync.tempo < 0.99 || sync.tempo > 1.01
    || !Number.isFinite(sync.estimatedClockErrorMs) || sync.estimatedClockErrorMs < 0 || sync.estimatedClockErrorMs > 100) {
    throw new Error('Invalid Pupil audio synchronization parameters');
  }
  const filters = ['asetpts=PTS-STARTPTS', `atempo=${sync.tempo.toFixed(9)}`];
  if (sync.offsetSeconds < 0) filters.push(`atrim=start=${(-sync.offsetSeconds).toFixed(6)}`, 'asetpts=PTS-STARTPTS');
  else filters.push(`adelay=${(sync.offsetSeconds * 1000).toFixed(3)}:all=1`);
  return [...filters, 'apad'].join(',');
}
