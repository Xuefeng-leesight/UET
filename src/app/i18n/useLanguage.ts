import React from 'react';
import { getStoredLanguage, storeLanguage, subscribeLanguageChange } from '@/app/i18n/language';
import type { LanguageCode } from '@/app/i18n/i18nConfig';

export function useLanguage(): { language: LanguageCode; setLanguage: (next: LanguageCode) => void } {
  const [language, setLanguageState] = React.useState<LanguageCode>(() => getStoredLanguage());

  const setLanguage = React.useCallback((next: LanguageCode) => {
    setLanguageState(next);
    storeLanguage(next);
  }, []);

  React.useEffect(() => {
    return subscribeLanguageChange((next) => setLanguageState(next));
  }, []);

  return { language, setLanguage };
}

