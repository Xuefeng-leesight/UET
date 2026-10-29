import { DEFAULT_LANGUAGE, LANGUAGE_STORAGE_KEY, type LanguageCode } from '@/app/i18n/i18nConfig';

const LANGUAGE_EVENT_NAME = 'mrt:language';

const normalizeLanguage = (value: unknown): LanguageCode => {
  if (value === 'en-US') return 'en-US';
  return 'zh-CN';
};

export function getStoredLanguage(): LanguageCode {
  try {
    const raw = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return normalizeLanguage(raw);
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export function storeLanguage(next: LanguageCode): void {
  const normalized = normalizeLanguage(next);
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, normalized);
  } catch {
  }
  try {
    window.dispatchEvent(new CustomEvent(LANGUAGE_EVENT_NAME, { detail: normalized }));
  } catch {
  }
}

export function subscribeLanguageChange(listener: (next: LanguageCode) => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== LANGUAGE_STORAGE_KEY) return;
    listener(getStoredLanguage());
  };

  const onCustom = (event: Event) => {
    const next = normalizeLanguage((event as CustomEvent<LanguageCode>)?.detail);
    listener(next);
  };

  window.addEventListener('storage', onStorage);
  window.addEventListener(LANGUAGE_EVENT_NAME, onCustom);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(LANGUAGE_EVENT_NAME, onCustom);
  };
}

