import { BrowserWindow, screen } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { logPerfEvent } from '../platform/logging/performanceLogger'

const LICENSE_WINDOW_WIDTH = 1280
const LICENSE_WINDOW_HEIGHT = 768
const LICENSE_WINDOW_BACKGROUND = '#f8fafc'

export function createLicenseWindowController(deps: {
  appDir: string
  devServerUrl?: string
  indexHtmlPath: string
  resolveAppWindowIconPath: () => string | undefined
}) {
  const __dirname = deps.appDir
  let win: BrowserWindow | null = null

  function createWindow(): void {
    if (win && !win.isDestroyed()) {
      win.focus()
      return
    }
    const workArea = screen.getPrimaryDisplay().workAreaSize
    const width = Math.min(LICENSE_WINDOW_WIDTH, workArea.width)
    const height = Math.min(LICENSE_WINDOW_HEIGHT, workArea.height)
    const appIconPath = deps.resolveAppWindowIconPath()

    win = new BrowserWindow({
      width,
      height,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      backgroundColor: LICENSE_WINDOW_BACKGROUND,
      icon: appIconPath,
      webPreferences: {
        preload: path.join(__dirname, 'preload.mjs'),
        webSecurity: true,
        experimentalFeatures: true,
      },
    })
    win.setMenuBarVisibility(false)
    win.setAutoHideMenuBar(true)
    win.center()

    const url = deps.devServerUrl
      ? `${deps.devServerUrl}?screenMode=license`
      : `${pathToFileURL(deps.indexHtmlPath).toString()}?screenMode=license`
    logPerfEvent({
      processType: 'main',
      event: 'license-window-load-url',
      details: { url },
    })
    void win.loadURL(url)

    win.on('closed', () => {
      win = null
    })
  }

  function closeWindow(): void {
    if (win && !win.isDestroyed()) {
      win.close()
    }
  }

  return {
    createWindow,
    getWindow: () => win,
    closeWindow,
  }
}
