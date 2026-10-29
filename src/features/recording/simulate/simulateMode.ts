export const SIMULATE_MODE_STORAGE_KEY = 'mrt.simulateMode';
export const SIMULATE_MODE_EVENT = 'mrt:simulateMode';
const simulateEnv = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env;
export const SIMULATE_MODE_AVAILABLE = Boolean(simulateEnv?.DEV);

export function isSimulateModeAvailable(): boolean {
  return SIMULATE_MODE_AVAILABLE;
}

function parseStoredSimulateMode(value: string | null): boolean {
  if (value === '1') return true;
  if (value === '0') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return false;
}

export function getStoredSimulateMode(): boolean {
  if (!isSimulateModeAvailable()) {
    try {
      localStorage.setItem(SIMULATE_MODE_STORAGE_KEY, '0');
    } catch {
    }
    return false;
  }

  try {
    const v = localStorage.getItem(SIMULATE_MODE_STORAGE_KEY);
    return parseStoredSimulateMode(v);
  } catch {
    return false;
  }
}

export function setStoredSimulateMode(enabled: boolean): boolean {
  const effectiveEnabled = isSimulateModeAvailable() && enabled;

  try {
    localStorage.setItem(SIMULATE_MODE_STORAGE_KEY, effectiveEnabled ? '1' : '0');
  } catch {
  }
  try {
    window.dispatchEvent(new CustomEvent(SIMULATE_MODE_EVENT, { detail: { enabled: effectiveEnabled } }));
  } catch {
  }

  return effectiveEnabled;
}
