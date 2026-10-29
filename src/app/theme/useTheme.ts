import { useEffect, useState } from 'react';
import { applyTheme, DEFAULT_THEME, getStoredTheme, type ThemeName } from '@/app/theme/theme';

export function useTheme(): { theme: ThemeName; setTheme: (next: ThemeName) => void } {
  const [theme, setThemeState] = useState<ThemeName>(() => getStoredTheme() || DEFAULT_THEME);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return {
    theme,
    setTheme: setThemeState,
  };
}

