import React from 'react';
import {
  clampSamplingRateHz,
  clampVideoSamplingRateHz,
  getStoredSamplingRateHz,
  getStoredVideoSamplingRateHz,
  SAMPLING_RATE_STORAGE_KEY,
  storeSamplingRateHz,
  storeVideoSamplingRateHz,
  VIDEO_SAMPLING_RATE_STORAGE_KEY,
} from '@/features/recording/sampling-rate/samplingRate';

export function useSamplingRateHz(): { samplingRateHz: number; setSamplingRateHz: (next: number) => void } {
  const [samplingRateHz, setSamplingRateHzState] = React.useState<number>(() => getStoredSamplingRateHz());

  const setSamplingRateHz = React.useCallback((next: number) => {
    const clamped = clampSamplingRateHz(next);
    setSamplingRateHzState(clamped);
    storeSamplingRateHz(clamped);
  }, []);

  React.useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SAMPLING_RATE_STORAGE_KEY) return;
      setSamplingRateHzState(getStoredSamplingRateHz());
    };
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<unknown>).detail;
      const v = typeof detail === 'number' ? detail : getStoredSamplingRateHz();
      setSamplingRateHzState(clampSamplingRateHz(v));
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('mrt:samplingRateHz', onCustom);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('mrt:samplingRateHz', onCustom);
    };
  }, []);

  return { samplingRateHz, setSamplingRateHz };
}

export function useVideoSamplingRateHz(): { videoSamplingRateHz: number; setVideoSamplingRateHz: (next: number) => void } {
  const [videoSamplingRateHz, setVideoSamplingRateHzState] = React.useState<number>(() => getStoredVideoSamplingRateHz());

  const setVideoSamplingRateHz = React.useCallback((next: number) => {
    const clamped = clampVideoSamplingRateHz(next);
    setVideoSamplingRateHzState(clamped);
    storeVideoSamplingRateHz(clamped);
  }, []);

  React.useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== VIDEO_SAMPLING_RATE_STORAGE_KEY) return;
      setVideoSamplingRateHzState(getStoredVideoSamplingRateHz());
    };
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<unknown>).detail;
      const v = typeof detail === 'number' ? detail : getStoredVideoSamplingRateHz();
      setVideoSamplingRateHzState(clampVideoSamplingRateHz(v));
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('mrt:videoSamplingRateHz', onCustom);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('mrt:videoSamplingRateHz', onCustom);
    };
  }, []);

  return { videoSamplingRateHz, setVideoSamplingRateHz };
}
