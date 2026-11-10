import React from 'react';
import MrtAppShell from '@/app/MrtAppShell';
import ErrorBoundary from '@/app/ErrorBoundary';
import ParticipantDisplayWindow from '@/features/recording/ParticipantDisplayWindow';
import { useLanguage } from '@/app/i18n/useLanguage';
import { useDomTranslation } from '@/app/i18n/useDomTranslation';
import LicenseGate from '@/features/licensing/LicenseGate';
import { ENABLE_LICENSE_AUTHORIZATION } from '@/app/config';

const App: React.FC = () => {
  const { language } = useLanguage();
  useDomTranslation(language);
  React.useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const mode = new URLSearchParams(window.location.search).get('screenMode');
  if (mode === 'participant') {
    return (
      <ErrorBoundary>
        <ParticipantDisplayWindow />
      </ErrorBoundary>
    );
  }
  if (mode === 'license') {
    return (
      <ErrorBoundary>
        <LicenseGate>
          <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">
            授权成功，正在进入软件…
          </div>
        </LicenseGate>
      </ErrorBoundary>
    );
  }
  return (
    <ErrorBoundary>
      {ENABLE_LICENSE_AUTHORIZATION ? (
        <LicenseGate>
          <MrtAppShell />
        </LicenseGate>
      ) : <MrtAppShell />}
    </ErrorBoundary>
  );
};

export default App;
