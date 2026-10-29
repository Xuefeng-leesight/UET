import React from 'react';
import { DEFAULT_TIME_OFFSET_MS, storeTimeOffsetMs } from '@/features/analysis/time-offset/timeOffset';

export function useTimeOffsetMs(): { timeOffsetMs: number; setTimeOffsetMs: (next: number) => void } {
  const setTimeOffsetMs = React.useCallback((_next: number) => {
    // Offset setting has been removed; force value to 0.
    storeTimeOffsetMs(DEFAULT_TIME_OFFSET_MS);
  }, []);

  React.useEffect(() => {
    // Ensure legacy stored offsets are cleared immediately.
    storeTimeOffsetMs(DEFAULT_TIME_OFFSET_MS);
    return undefined;
  }, []);

  return { timeOffsetMs: DEFAULT_TIME_OFFSET_MS, setTimeOffsetMs };
}
