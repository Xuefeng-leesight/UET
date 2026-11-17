import { BrowserWindow, nativeTheme, screen } from 'electron'
import path from 'node:path'
import { logPerfEvent } from '../platform/logging/performanceLogger'

const RENDERER_SHUTDOWN_TIMEOUT_MS = 7000
const DEFAULT_MAIN_WINDOW_WIDTH = 1600
const DEFAULT_MAIN_WINDOW_HEIGHT = 1000

export function createMainWindowController(deps: {
  appDir: string
  devServerUrl?: string
  indexHtmlPath: string
  resolveAppWindowIconPath: () => string | undefined
  closeParticipantWindow: () => void
}) {
  const __dirname = deps.appDir
  let win: BrowserWindow | null = null
  let isWaitingForRendererShutdown = false
  let allowMainWindowClose = false
  let rendererShutdownTimer: NodeJS.Timeout | null = null

type AppThemeName = 'modern-light' | 'dark' | 'glass'
type ThemeWindowAppearance = {
  backgroundColor: string
  titleBarColor: string
  systemThemeSource: 'light' | 'dark'
}

const DEFAULT_APP_THEME: AppThemeName = 'modern-light'
const THEME_WINDOW_APPEARANCE: Record<AppThemeName, ThemeWindowAppearance> = {
  'modern-light': {
    backgroundColor: '#f5f6f7',
    titleBarColor: '#f5f6f7',
    systemThemeSource: 'light',
  },
  dark: {
    backgroundColor: '#1e1f22',
    titleBarColor: '#1e1f22',
    systemThemeSource: 'dark',
  },
  glass: {
    backgroundColor: '#e6eefb',
    titleBarColor: '#e6eefb',
    systemThemeSource: 'light',
  },
}
const SUPPORTS_TITLE_BAR_OVERLAY = process.platform === 'win32' || process.platform === 'linux'
const TITLE_BAR_OVERLAY_HEIGHT = 36
const MODAL_MASK_OPACITY = 0.4

let currentMainTheme: AppThemeName = DEFAULT_APP_THEME
let isMainWindowModalMaskActive = false

function normalizeThemeName(value: unknown): AppThemeName {
  // Older renderers may still send the retired preference over IPC.
  if (value === 'deep-blue') return 'dark'
  if (value === 'modern-light' || value === 'dark' || value === 'glass') {
    return value
  }
  return DEFAULT_APP_THEME
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(255, Math.round(value)))
}

function blendHexWithBlack(hexColor: string, opacity: number): string {
  const normalized = String(hexColor || '').trim()
  const match = /^#([0-9a-f]{6})$/i.exec(normalized)
  if (!match) return normalized || '#000000'

  const raw = match[1]
  const r = parseInt(raw.slice(0, 2), 16)
  const g = parseInt(raw.slice(2, 4), 16)
  const b = parseInt(raw.slice(4, 6), 16)
  const factor = 1 - Math.max(0, Math.min(1, opacity))

  const nr = clampByte(r * factor)
  const ng = clampByte(g * factor)
  const nb = clampByte(b * factor)
  return `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}`
}

function getTitleBarOverlayStyle(appearance: ThemeWindowAppearance): {
  color: string
  height: number
} {
  if (isMainWindowModalMaskActive) {
    return {
      color: blendHexWithBlack(appearance.titleBarColor, MODAL_MASK_OPACITY),
      height: TITLE_BAR_OVERLAY_HEIGHT,
    }
  }
  return {
    color: appearance.titleBarColor,
    height: TITLE_BAR_OVERLAY_HEIGHT,
  }
}

function applyMainWindowTitleBarOverlay(appearance: ThemeWindowAppearance): void {
  if (!SUPPORTS_TITLE_BAR_OVERLAY) return
  if (!win || win.isDestroyed()) return
  const overlayStyle = getTitleBarOverlayStyle(appearance)
  try {
    win.setTitleBarOverlay({
      color: overlayStyle.color,
      height: overlayStyle.height,
    })
  } catch (error) {
    console.warn('[app] setTitleBarOverlay failed:', error)
  }
}

function applyMainWindowAppearance(): void {
  const appearance = THEME_WINDOW_APPEARANCE[currentMainTheme]
  nativeTheme.themeSource = appearance.systemThemeSource
  if (win && !win.isDestroyed()) {
    win.setBackgroundColor(appearance.backgroundColor)
  }
  applyMainWindowTitleBarOverlay(appearance)
}

function setMainWindowTheme(themeValue: unknown): void {
  currentMainTheme = normalizeThemeName(themeValue)
  applyMainWindowAppearance()
}

function setMainWindowModalMask(active: unknown): void {
  isMainWindowModalMaskActive = Boolean(active)
  applyMainWindowAppearance()
}

function clearRendererShutdownTimer(): void {
  if (!rendererShutdownTimer) return
  clearTimeout(rendererShutdownTimer)
  rendererShutdownTimer = null
}

function prepareMainWindowClose(): void {
  clearRendererShutdownTimer()
  isWaitingForRendererShutdown = false
  allowMainWindowClose = true
}

function createWindow() {
  const primaryWorkArea = screen.getPrimaryDisplay().workAreaSize
  const initialWidth = Math.min(DEFAULT_MAIN_WINDOW_WIDTH, primaryWorkArea.width)
  const initialHeight = Math.min(DEFAULT_MAIN_WINDOW_HEIGHT, primaryWorkArea.height)
  currentMainTheme = DEFAULT_APP_THEME
  isMainWindowModalMaskActive = false
  const initialAppearance = THEME_WINDOW_APPEARANCE[currentMainTheme]
  const appIconPath = deps.resolveAppWindowIconPath()
  nativeTheme.themeSource = initialAppearance.systemThemeSource

  logPerfEvent({
    processType: 'main',
    event: 'main-window-create-start',
    details: { hasDevServer: Boolean(deps.devServerUrl) },
  })

  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: initialWidth,
    height: initialHeight,
    backgroundColor: initialAppearance.backgroundColor,
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      webSecurity: true,
      experimentalFeatures: true,
    },
  }
  if (SUPPORTS_TITLE_BAR_OVERLAY) {
    const overlayStyle = getTitleBarOverlayStyle(initialAppearance)
    windowOptions.titleBarStyle = 'hidden'
    windowOptions.titleBarOverlay = {
      color: overlayStyle.color,
      height: overlayStyle.height,
    }
  }

  win = new BrowserWindow(windowOptions)
  win.maximize()
  logPerfEvent({
    processType: 'main',
    event: 'main-window-created',
    details: { id: win.id, bounds: win.getBounds() },
  })
  win.setMenuBarVisibility(false)
  win.setAutoHideMenuBar(true)
  isWaitingForRendererShutdown = false
  allowMainWindowClose = false
  clearRendererShutdownTimer()

  win.on('close', (event) => {
    logPerfEvent({
      processType: 'main',
      event: 'main-window-close-requested',
      details: { allowMainWindowClose, isWaitingForRendererShutdown },
    })
    if (allowMainWindowClose) return
    if (isWaitingForRendererShutdown) {
      event.preventDefault()
      logPerfEvent({ processType: 'main', event: 'main-window-close-waiting-renderer' })
      return
    }

    event.preventDefault()
    isWaitingForRendererShutdown = true

    const activeWin = win
    if (!activeWin || activeWin.isDestroyed()) {
      prepareMainWindowClose()
      if (activeWin && !activeWin.isDestroyed()) {
        activeWin.close()
      }
      return
    }

    try {
      activeWin.webContents.send('app-shutdown-request')
      logPerfEvent({ processType: 'main', event: 'main-window-shutdown-request-sent' })
    } catch (error) {
      console.error('[app] failed to send app-shutdown-request:', error)
      logPerfEvent({
        processType: 'main',
        event: 'main-window-shutdown-request-failed',
        details: { error: (error as Error)?.message || String(error) },
      })
      prepareMainWindowClose()
      if (!activeWin.isDestroyed()) {
        activeWin.close()
      }
      return
    }

    rendererShutdownTimer = setTimeout(() => {
      console.warn('[app] renderer shutdown ack timeout, forcing window close')
      logPerfEvent({ processType: 'main', event: 'main-window-shutdown-ack-timeout' })
      prepareMainWindowClose()
      if (win && !win.isDestroyed()) {
        win.close()
      }
    }, RENDERER_SHUTDOWN_TIMEOUT_MS)
  })

  win.on('closed', () => {
    logPerfEvent({ processType: 'main', event: 'main-window-closed' })
    clearRendererShutdownTimer()
    isWaitingForRendererShutdown = false
    allowMainWindowClose = false
    deps.closeParticipantWindow()
    win = null
  })

  // Test active push message to Renderer-process.
  win.once('ready-to-show', () => {
    logPerfEvent({
      processType: 'main',
      event: 'main-window-ready-to-show',
      details: { id: win?.id ?? null },
    })
  })
  win.webContents.on('dom-ready', () => {
    logPerfEvent({ processType: 'main', event: 'main-window-dom-ready' })
  })
  win.webContents.on('did-finish-load', () => {
    logPerfEvent({
      processType: 'main',
      event: 'main-window-did-finish-load',
      details: { currentUrl: win?.webContents.getURL() || null },
    })
    win?.webContents.send('main-process-message', (new Date).toLocaleString())
  })
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    logPerfEvent({
      processType: 'main',
      event: 'main-window-did-fail-load',
      details: {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      },
    })
  })

  if (deps.devServerUrl) {
    logPerfEvent({
      processType: 'main',
      event: 'main-window-load-url',
      details: { url: deps.devServerUrl },
    })
    win.loadURL(deps.devServerUrl)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    // win.loadFile('dist/index.html')
    logPerfEvent({
      processType: 'main',
      event: 'main-window-load-file',
      details: { distPath: deps.indexHtmlPath },
    })
    win.loadFile(deps.indexHtmlPath)
  }
}

  return {
    createWindow,
    getMainWindow: () => win,
    prepareMainWindowClose,
    applyMainWindowAppearance,
    setMainWindowModalMask,
    setMainWindowTheme,
    setMainWindowOverlayTheme: (theme: unknown) => { currentMainTheme = normalizeThemeName(theme) },
  }
}
