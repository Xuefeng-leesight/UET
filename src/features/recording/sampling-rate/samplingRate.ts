export const DEFAULT_SAMPLING_RATE_HZ = 0;
export const SAMPLING_RATE_STORAGE_KEY = 'mrt_sampling_rate_hz';
export const DEFAULT_VIDEO_SAMPLING_RATE_HZ = 30;
export const VIDEO_SAMPLING_RATE_STORAGE_KEY = 'mrt_video_sampling_rate_hz';
export const VIDEO_SAMPLING_RATE_OPTIONS = [15, 30, 60] as const;

export function clampSamplingRateHz(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_SAMPLING_RATE_HZ;
  const n = Math.round(v);
  if (n < 0) return 0;
  if (n > 1000) return 1000;
  return n;
}

export function getStoredSamplingRateHz(): number {
  try {
    const raw = localStorage.getItem(SAMPLING_RATE_STORAGE_KEY);
    if (!raw) return DEFAULT_SAMPLING_RATE_HZ;
    const n = Number(raw);
    return clampSamplingRateHz(n);
  } catch {
    return DEFAULT_SAMPLING_RATE_HZ;
  }
}

export function storeSamplingRateHz(v: number): void {
  const clamped = clampSamplingRateHz(v);
  try {
    localStorage.setItem(SAMPLING_RATE_STORAGE_KEY, String(clamped));
  } catch {
  }
  try {
    window.dispatchEvent(new CustomEvent('mrt:samplingRateHz', { detail: clamped }));
  } catch {
  }
}

export function clampVideoSamplingRateHz(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_VIDEO_SAMPLING_RATE_HZ;
  const n = Math.round(v);
  return VIDEO_SAMPLING_RATE_OPTIONS.some((option) => option === n) ? n : DEFAULT_VIDEO_SAMPLING_RATE_HZ;
}

export function getStoredVideoSamplingRateHz(): number {
  try {
    const raw = localStorage.getItem(VIDEO_SAMPLING_RATE_STORAGE_KEY);
    if (!raw) return DEFAULT_VIDEO_SAMPLING_RATE_HZ;
    return clampVideoSamplingRateHz(Number(raw));
  } catch {
    return DEFAULT_VIDEO_SAMPLING_RATE_HZ;
  }
}

export function storeVideoSamplingRateHz(v: number): void {
  const clamped = clampVideoSamplingRateHz(v);
  try {
    localStorage.setItem(VIDEO_SAMPLING_RATE_STORAGE_KEY, String(clamped));
  } catch {
  }
  try {
    window.dispatchEvent(new CustomEvent('mrt:videoSamplingRateHz', { detail: clamped }));
  } catch {
  }
}
