import React from 'react';

let overlayMaskRefCount = 0;

function getRendererTheme(): string {
  const theme = document?.documentElement?.dataset?.theme;
  return typeof theme === 'string' ? theme : '';
}

function syncOverlayMask(): void {
  window.ipcRenderer?.send('set-main-window-overlay-mask', {
    active: overlayMaskRefCount > 0,
    theme: getRendererTheme(),
  });
}

function acquireMainWindowOverlayMask(): () => void {
  overlayMaskRefCount += 1;
  syncOverlayMask();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    overlayMaskRefCount = Math.max(0, overlayMaskRefCount - 1);
    syncOverlayMask();
  };
}

export function useMainWindowOverlayMask(active: boolean): void {
  React.useEffect(() => {
    if (!active) return;
    const release = acquireMainWindowOverlayMask();

    const resync = () => {
      if (overlayMaskRefCount <= 0) return;
      syncOverlayMask();
      window.setTimeout(() => {
        if (overlayMaskRefCount > 0) syncOverlayMask();
      }, 120);
    };

    document.addEventListener('fullscreenchange', resync);
    document.addEventListener('webkitfullscreenchange', resync as EventListener);
    window.addEventListener('resize', resync);

    return () => {
      document.removeEventListener('fullscreenchange', resync);
      document.removeEventListener('webkitfullscreenchange', resync as EventListener);
      window.removeEventListener('resize', resync);
      release();
    };
  }, [active]);
}
