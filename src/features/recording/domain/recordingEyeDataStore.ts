import { useSyncExternalStore } from 'react';
import type { EyeTrackingData } from '@/features/recording/domain/recordingContracts';

export type EyeDataUpdater = EyeTrackingData | ((previous: EyeTrackingData) => EyeTrackingData);

export interface EyeDataStore {
  getSnapshot: () => EyeTrackingData;
  subscribe: (listener: () => void) => () => void;
  set: (updater: EyeDataUpdater) => void;
}

const subscribeDisabled = () => () => {};

export function createEyeDataStore(initialValue: EyeTrackingData): EyeDataStore {
  let current = initialValue;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (updater) => {
      const next = typeof updater === 'function' ? updater(current) : updater;
      if (Object.is(current, next)) return;
      current = next;
      listeners.forEach((listener) => listener());
    },
  };
}

export function useEyeDataSnapshot(store: EyeDataStore, enabled = true): EyeTrackingData {
  return useSyncExternalStore(
    enabled ? store.subscribe : subscribeDisabled,
    store.getSnapshot,
    store.getSnapshot,
  );
}
