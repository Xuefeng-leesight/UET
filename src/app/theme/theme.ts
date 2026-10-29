export type ThemeName = 'modern-light' | 'dark' | 'glass';

export const THEME_LABELS: Record<ThemeName, string> = {
  'modern-light': '浅色',
  dark: '深色',
  glass: '玻璃',
};

export const DEFAULT_THEME: ThemeName = 'modern-light';

export const THEME_PREVIEWS: Record<
  ThemeName,
  { bg: string; surface: string; text: string; primary: string; control: string }
> = {
  'modern-light': { bg: '#f5f6f7', surface: '#ffffff', text: '#292b30', primary: '#326bb5', control: '#e7e9ec' },
  dark: { bg: '#1e1f22', surface: '#242529', text: '#d9dadd', primary: '#8aaee0', control: '#3b3e45' },
  glass: { bg: '#e6eefb', surface: '#fbfcfd', text: '#1b2230', primary: '#5c9bf0', control: '#f1f3f6' },
};

const STORAGE_KEY = 'mrt-theme';

export function getStoredTheme(): ThemeName | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // Persist legacy preferences as one of the two supported modes. Read-time
    // normalization also covers consumers mounted before startup migration.
    if (raw === 'deep-blue' || raw === 'bright') {
      const migrated = raw === 'deep-blue' ? 'dark' : DEFAULT_THEME;
      storeTheme(migrated);
      return migrated;
    }   
    if (raw === 'modern-light' || raw === 'dark' || raw === 'glass') {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

export function storeTheme(theme: ThemeName): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
  }
}

export function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
  storeTheme(theme);
  ipcEvents.send('set-main-window-theme', { theme });
}

export function migrateLegacyTheme(): void {
  getStoredTheme();
}
import { ipcEvents } from '@/infrastructure/electron/ipcEvents';
