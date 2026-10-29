export interface ClockSyncExchange {
  clientSendAt: number;
  serverReceiveAt: number;
  serverSendAt: number;
  clientReceiveAt: number;
}

export interface ClockSyncEstimate {
  /** 主控时间 - 客户端时间。 */
  offsetMs: number;
  roundTripMs: number;
}

export function estimateClock(exchange: ClockSyncExchange): ClockSyncEstimate {
  const serverProcessingMs = Math.max(0, exchange.serverSendAt - exchange.serverReceiveAt);
  const roundTripMs = Math.max(
    0,
    exchange.clientReceiveAt - exchange.clientSendAt - serverProcessingMs,
  );
  const offsetMs = (
    (exchange.serverReceiveAt - exchange.clientSendAt)
    + (exchange.serverSendAt - exchange.clientReceiveAt)
  ) / 2;
  return { offsetMs, roundTripMs };
}

/**
 * 最低 RTT 的样本受排队和无线网络抖动影响最小。偏移用同一样本，避免把
 * 来自不同网络路径的 RTT 和 offset 拼在一起。
 */
export function selectBestClockEstimate(samples: ClockSyncEstimate[]): ClockSyncEstimate | null {
  const valid = samples.filter((sample) =>
    Number.isFinite(sample.offsetMs) && Number.isFinite(sample.roundTripMs) && sample.roundTripMs >= 0,
  );
  if (valid.length === 0) return null;
  return valid.reduce((best, sample) => sample.roundTripMs < best.roundTripMs ? sample : best);
}

export function coordinatorNow(clientNow: number, offsetMs: number): number {
  return clientNow + offsetMs;
}

export function scheduledDelayMs(executeAt: number, clientNow: number, offsetMs: number): number {
  return Math.max(0, executeAt - coordinatorNow(clientNow, offsetMs));
}

export function adaptiveCommandLeadMs(roundTrips: number[]): number {
  const maxRtt = roundTrips
    .filter((value) => Number.isFinite(value) && value >= 0)
    .reduce((max, value) => Math.max(max, value), 0);
  return Math.max(5000, Math.min(15000, Math.ceil(maxRtt * 4 + 2000)));
}
