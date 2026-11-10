import React from 'react';
import { waitForDeviceStop } from '@/features/recording/domain/recordingWsModule';

interface UseNavigationGuardParams {
  isRecordingPageActive: boolean;
  stopDeviceBeforeNavigate: () => Promise<void>;
  isDeviceStopped: () => boolean;
  timeoutMs?: number;
  stopStrategy?: 'blocking' | 'deferred';
}

export function useNavigationGuard(params: UseNavigationGuardParams) {
  const {
    isRecordingPageActive,
    stopDeviceBeforeNavigate,
    isDeviceStopped,
    timeoutMs = 5000,
    stopStrategy = 'deferred',
  } = params;

  const stopInFlightRef = React.useRef<Promise<void> | null>(null);

  const stopDeviceTask = React.useCallback(async () => {
    if (stopInFlightRef.current) {
      return stopInFlightRef.current;
    }

    const task = (async () => {
      try {
        await stopDeviceBeforeNavigate();
        const stopped = await waitForDeviceStop({
          isStopped: isDeviceStopped,
          timeoutMs,
          intervalMs: 100,
        });
        if (!stopped) {
          console.warn('[useNavigationGuard] stop wait timeout, continue navigation');
        }
      } catch (error) {
        console.error('[useNavigationGuard] stop device before navigation failed:', error);
      }
    })();

    stopInFlightRef.current = task;
    try {
      await task;
    } finally {
      stopInFlightRef.current = null;
    }
  }, [stopDeviceBeforeNavigate, isDeviceStopped, timeoutMs]);

  const guardedNavigate = React.useCallback(
    async (navigate: () => void | Promise<void>) => {
      if (!isRecordingPageActive) {
        await Promise.resolve(navigate());
        return;
      }

      if (stopStrategy === 'deferred') {
        await Promise.resolve(navigate());
        void stopDeviceTask();
        return;
      }

      await stopDeviceTask();
      await Promise.resolve(navigate());
    },
    [isRecordingPageActive, stopStrategy, stopDeviceTask],
  );

  return { guardedNavigate };
}
