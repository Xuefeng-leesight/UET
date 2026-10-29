import { useEffect, useState } from 'react';
import { getStoredSimulateMode, setStoredSimulateMode, SIMULATE_MODE_EVENT, SIMULATE_MODE_STORAGE_KEY } from '@/features/recording/simulate/simulateMode';

export function useSimulateMode(): { simulateMode: boolean; setSimulateMode: (enabled: boolean) => void } {
  const [simulateMode, setSimulateModeState] = useState<boolean>(() => getStoredSimulateMode());

  useEffect(() => {
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<unknown>).detail;
      const enabled = Boolean(
        typeof detail === 'object' && detail !== null && 'enabled' in detail && detail.enabled,
      );
      setSimulateModeState(enabled);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SIMULATE_MODE_STORAGE_KEY) return;
      setSimulateModeState(getStoredSimulateMode());
    };
    window.addEventListener(SIMULATE_MODE_EVENT, onCustom as EventListener);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SIMULATE_MODE_EVENT, onCustom as EventListener);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return {
    simulateMode,
    setSimulateMode: (enabled: boolean) => {
      const effectiveEnabled = setStoredSimulateMode(enabled);
      setSimulateModeState(effectiveEnabled);
    },
  };
}
