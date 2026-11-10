import { BrowserWindow, ipcMain } from 'electron'

type WindowControlDependencies = {
  applyMainWindowAppearance: () => void
  getMainWindow: () => BrowserWindow | null
  logRendererShutdown: () => void
  prepareMainWindowClose: () => void
  restartPythonServer: () => void
  setMainWindowModalMask: (active: unknown) => void
  setMainWindowOverlayTheme: (theme: unknown) => void
  setMainWindowTheme: (theme: unknown) => void
  stopPythonServer: () => void
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function registerWindowControlHandlers(dependencies: WindowControlDependencies): void {
  const {
    applyMainWindowAppearance,
    getMainWindow,
    logRendererShutdown,
    prepareMainWindowClose,
    restartPythonServer,
    setMainWindowModalMask,
    setMainWindowOverlayTheme,
    setMainWindowTheme,
    stopPythonServer,
  } = dependencies

  ipcMain.handle('set-window-fullscreen', async (_event, input: unknown) => {
    const win = getMainWindow()
    if (!win) return { ok: false }
    const next = Boolean(asRecord(input).fullscreen)
    win.setFullScreen(next)
    win.setMenuBarVisibility(false)
    win.setAutoHideMenuBar(true)
    applyMainWindowAppearance()
    setTimeout(applyMainWindowAppearance, 120)
    return { ok: true }
  })

  ipcMain.handle('minimize-main-window', async () => {
    try {
      const win = getMainWindow()
      const target = win && !win.isDestroyed()
        ? win
        : BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows().find((item) => !item.isDestroyed())
      if (!target || target.isDestroyed()) return { ok: false }
      target.minimize()
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  ipcMain.handle('stop-py-server', async () => {
    console.log('[ipc] stop-py-server called')
    stopPythonServer()
    return { ok: true }
  })

  ipcMain.handle('restart-py-server', async () => {
    console.log('[ipc] restart-py-server called')
    restartPythonServer()
    return { ok: true }
  })

  ipcMain.handle('renderer-shutdown-complete', async () => {
    console.log('[app] renderer-shutdown-complete')
    logRendererShutdown()
    prepareMainWindowClose()
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      try {
        win.close()
      } catch (error) {
        console.error('[app] failed to close main window after renderer ack:', error)
      }
    }
    return { ok: true }
  })

  ipcMain.on('set-main-window-theme', (_event, input: unknown) => {
    setMainWindowTheme(asRecord(input).theme)
  })

  ipcMain.on('set-main-window-overlay-mask', (_event, input: unknown) => {
    const payload = asRecord(input)
    if ('theme' in payload) setMainWindowOverlayTheme(payload.theme)
    setMainWindowModalMask(payload.active)
  })
}
