export const DEFAULT_TIME_OFFSET_MS = 0;

const STORAGE_KEY = 'mrt_time_offset_ms';

export function getStoredTimeOffsetMs(): number {
  return DEFAULT_TIME_OFFSET_MS;
}

export function storeTimeOffsetMs(next: number): void {
  try {
    const clamped = clampTimeOffsetMs(next);
    // Offset setting has been removed; keep storage cleared and broadcast 0.
    localStorage.removeItem(STORAGE_KEY);
    try {
      window.dispatchEvent(new CustomEvent('mrt:timeOffsetMs', { detail: clamped }));
    } catch {
    }
  } catch {
  }
}

export function clampTimeOffsetMs(v: number): number {
  void v;
  return DEFAULT_TIME_OFFSET_MS;
}
