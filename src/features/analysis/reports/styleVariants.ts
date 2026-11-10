import React from 'react';
import type { InsightStyleVariant } from '@shared/contracts/domain/reporting';
import { getStoredTheme, type ThemeName } from '@/app/theme/theme';

export const DEFAULT_INSIGHT_STYLE_VARIANT: InsightStyleVariant = 'ocean';

export const normalizeInsightStyleVariant = (value: unknown): InsightStyleVariant => {
  if (value === 'forest' || value === 'amber' || value === 'ocean') return value;
  return DEFAULT_INSIGHT_STYLE_VARIANT;
};

export const mapThemeToInsightStyleVariant = (theme: ThemeName | string | null | undefined): InsightStyleVariant => {
  // Reporting visuals should follow the system primary color family to stay coherent
  // across light and dark modes.
  if (theme === 'modern-light' || theme === 'dark') return 'ocean';
  return DEFAULT_INSIGHT_STYLE_VARIANT;
};

const getCurrentThemeName = (): ThemeName | null => {
  if (typeof document !== 'undefined') {
    const raw = document.documentElement.dataset.theme;
    if (raw === 'modern-light' || raw === 'dark') return raw;
  }
  return getStoredTheme();
};

export const useSystemInsightStyleVariant = (): InsightStyleVariant => {
  const [variant, setVariant] = React.useState<InsightStyleVariant>(() =>
    mapThemeToInsightStyleVariant(getCurrentThemeName()),
  );

  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const sync = () => {
      setVariant(mapThemeToInsightStyleVariant(getCurrentThemeName()));
    };
    sync();

    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return variant;
};
