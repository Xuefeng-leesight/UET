import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '@/App';
import { applyTheme, DEFAULT_THEME, getStoredTheme, migrateLegacyTheme } from '@/app/theme/theme';
import { initRendererPerformanceLogging, markRendererPerfCheckpoint } from '@/infrastructure/logging';
import { ENABLE_DEBUG_TESTING } from '@/app/config';

if (!ENABLE_DEBUG_TESTING) {
  console.log = () => {};
}

initRendererPerformanceLogging();
markRendererPerfCheckpoint('renderer-entry-start');

try {
  markRendererPerfCheckpoint('renderer-theme-migration-start');
  migrateLegacyTheme();
  markRendererPerfCheckpoint('renderer-theme-migration-finished');
} catch {
  markRendererPerfCheckpoint('renderer-theme-migration-failed');
}

markRendererPerfCheckpoint('renderer-theme-apply-start');
// Set before the first render so Windows typography and surfaces never flash
// the default appearance. Keep this renderer-only; no new platform IPC is needed.
document.documentElement.dataset.platform = /\bWindows NT\b/.test(navigator.userAgent) ? 'windows' : 'other';
applyTheme(getStoredTheme() || DEFAULT_THEME);
markRendererPerfCheckpoint('renderer-theme-apply-finished');

const rootElement = document.getElementById('root');
if (!rootElement) {
  markRendererPerfCheckpoint('renderer-root-missing');
  throw new Error('Could not find root element to mount to');
}

const root = ReactDOM.createRoot(rootElement);
markRendererPerfCheckpoint('renderer-root-created');
markRendererPerfCheckpoint('renderer-react-render-start');
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
markRendererPerfCheckpoint('renderer-react-render-scheduled');

window.setTimeout(() => {
  markRendererPerfCheckpoint('renderer-post-render-1s');
}, 1000);
