import { BrowserWindow, ipcMain, screen } from 'electron'
import * as fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateUtf8Path } from '../filesystem/pathValidation'

type ScreenConfig = {
  enabled: boolean
  experimenterDisplayId: number | null
  participantDisplayId: number | null
}

const DEFAULT_SCREEN_CONFIG: ScreenConfig = {
  enabled: false,
  experimenterDisplayId: null,
  participantDisplayId: null,
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误'
}

type ScreenDomainDependencies = {
  devServerUrl?: string
  getMainWindow: () => BrowserWindow | null
  indexHtmlPath: string
  preloadPath: string
  resolveAppWindowIconPath: () => string | undefined
}

type ParticipantWindowDisplay = {
  bounds: { x: number; y: number; width: number; height: number }
}

type ParticipantWindowPresentation = Pick<
  BrowserWindow,
  'setAlwaysOnTop' | 'setBounds' | 'setFullScreen' | 'setKiosk' | 'setSkipTaskbar'
>

export function applyParticipantWindowPresentation(
  target: ParticipantWindowPresentation,
  display: ParticipantWindowDisplay,
  platform: NodeJS.Platform = process.platform,
): void {
  target.setSkipTaskbar(true)
  target.setBounds(display.bounds, false)
  if (platform === 'win32') {
    // Electron's default always-on-top levels through `status` remain below
    // the Windows taskbar. `screen-saver` is explicitly above it, ensuring
    // the participant stimulus covers the entire captured display.
    target.setKiosk(true)
    target.setAlwaysOnTop(true, 'screen-saver')
    // Kiosk can recalculate bounds during the native transition. Re-assert
    // the configured participant display afterwards so it cannot jump to the
    // primary display in a multi-monitor layout.
    target.setBounds(display.bounds, false)
    return
  }
  target.setFullScreen(true)
}

export function createScreenDomain(dependencies: ScreenDomainDependencies) {
  let participantWin: BrowserWindow | null = null
  let latestSubjectWindowPayload: unknown = null
  let latestSubjectWindowRevision = 0
  let participantRenderedRevision = 0
  let participantRenderWaiter: {
    target: BrowserWindow
    revision: number
    resolve: (ready: boolean) => void
    timer: NodeJS.Timeout
  } | null = null

  type ScreenInfo = {
    id: number
    label: string
    isPrimary: boolean
    bounds: { x: number; y: number; width: number; height: number }
    workArea: { x: number; y: number; width: number; height: number }
    scaleFactor: number
  }
  
  function getScreensSnapshot(): ScreenInfo[] {
    const displays = screen.getAllDisplays()
    const primaryId = screen.getPrimaryDisplay().id
    return displays.map((d, idx) => ({
      id: d.id,
      label: d.id === primaryId ? `主显示器 (${idx + 1})` : `显示器 ${idx + 1}`,
      isPrimary: d.id === primaryId,
      bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
      workArea: { x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height },
      scaleFactor: d.scaleFactor,
    }))
  }
  
  function normalizeScreenConfig(value: unknown): ScreenConfig {
    const raw = asRecord(value)
    const enabled = !!raw.enabled
    const experimenterDisplayId =
      typeof raw.experimenterDisplayId === 'number' && Number.isFinite(raw.experimenterDisplayId)
        ? raw.experimenterDisplayId
        : null
    const participantDisplayId =
      typeof raw.participantDisplayId === 'number' && Number.isFinite(raw.participantDisplayId)
        ? raw.participantDisplayId
        : null
    return {
      enabled,
      experimenterDisplayId,
      participantDisplayId,
    }
  }
  
  function getScreenConfigPath(projectDir: string): string {
    return path.join(projectDir, '.config', 'screen_config.json')
  }
  
  async function loadScreenConfigFromDisk(projectDir: string): Promise<ScreenConfig> {
    const configPath = getScreenConfigPath(projectDir)
    try {
      const raw = await fs.promises.readFile(configPath, 'utf-8')
      const parsed = JSON.parse(raw)
      return normalizeScreenConfig(parsed)
    } catch {
      return { ...DEFAULT_SCREEN_CONFIG }
    }
  }
  
  async function saveScreenConfigToDisk(projectDir: string, config: ScreenConfig): Promise<{ ok: boolean; error?: string; path?: string }> {
    try {
      const configPath = getScreenConfigPath(projectDir)
      await fs.promises.mkdir(path.dirname(configPath), { recursive: true })
      await fs.promises.writeFile(
        configPath,
        JSON.stringify({ version: 1, ...config, updatedAt: new Date().toISOString() }, null, 2),
        'utf-8',
      )
      return { ok: true, path: configPath }
    } catch (error: unknown) {
      return { ok: false, error: `保存屏幕配置失败：${getErrorMessage(error)}` }
    }
  }
  
  function validateScreenConfig(
    config: ScreenConfig,
    screens: ScreenInfo[],
  ): { config: ScreenConfig; warnings: string[] } {
    const warnings: string[] = []
    if (screens.length === 0) {
      return {
        config: { ...DEFAULT_SCREEN_CONFIG },
        warnings: ['未检测到可用显示器，已回退到单屏模式'],
      }
    }
  
    const ids = new Set(screens.map((s) => s.id))
    const primary = screens.find((s) => s.isPrimary) || screens[0]
    const fallbackParticipant = screens.find((s) => s.id !== primary.id) || null
  
    let experimenterDisplayId = config.experimenterDisplayId
    if (experimenterDisplayId === null || !ids.has(experimenterDisplayId)) {
      if (config.experimenterDisplayId !== null) {
        warnings.push('主试屏配置无效，已回退到主显示器')
      }
      experimenterDisplayId = primary.id
    }
  
    let participantDisplayId = config.participantDisplayId
    if (participantDisplayId !== null && !ids.has(participantDisplayId)) {
      warnings.push('被试屏配置无效，已自动选择可用显示器')
      participantDisplayId = fallbackParticipant ? fallbackParticipant.id : null
    }
  
    if (config.enabled && participantDisplayId === null) {
      warnings.push('仅检测到一个显示器，已回退到单屏模式')
    }
  
    if (participantDisplayId !== null && participantDisplayId === experimenterDisplayId) {
      warnings.push('主试屏与被试屏不能相同，已回退到单屏模式')
      participantDisplayId = null
    }
  
    const enabled = !!config.enabled && participantDisplayId !== null
    return {
      config: { enabled, experimenterDisplayId, participantDisplayId },
      warnings,
    }
  }
  
  function resolveParticipantRenderWaiter(ready: boolean): void {
    const waiter = participantRenderWaiter
    if (!waiter) return
    participantRenderWaiter = null
    clearTimeout(waiter.timer)
    waiter.resolve(ready)
  }

  function closeParticipantWindow(): void {
    resolveParticipantRenderWaiter(false)
    if (!participantWin) return
    try {
      if (process.platform === 'win32' && !participantWin.isDestroyed() && participantWin.isKiosk()) {
        participantWin.setKiosk(false)
      }
      participantWin.close()
    } catch (error) {
      console.error('[screen] close participant window failed:', error)
    } finally {
      participantWin = null
    }
  }

  function updateLatestSubjectWindowPayload(payload: unknown): number {
    latestSubjectWindowPayload = payload && typeof payload === 'object' ? payload : {}
    latestSubjectWindowRevision += 1
    return latestSubjectWindowRevision
  }

  function sendLatestSubjectWindowPayload(target: BrowserWindow | null = participantWin): void {
    if (!target || target.isDestroyed() || latestSubjectWindowPayload === null) return
    try {
      target.webContents.send('subject-window:update', {
        ...asRecord(latestSubjectWindowPayload),
        participantRenderRevision: latestSubjectWindowRevision,
      })
    } catch (error) {
      console.warn('[screen] send cached participant state failed:', error)
    }
  }

  function waitForParticipantRender(
    target: BrowserWindow,
    revision: number,
    timeoutMs = 4000,
  ): Promise<boolean> {
    if (participantRenderedRevision >= revision) return Promise.resolve(true)
    resolveParticipantRenderWaiter(false)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (participantRenderWaiter?.target !== target || participantRenderWaiter.revision !== revision) return
        participantRenderWaiter = null
        resolve(false)
      }, timeoutMs)
      participantRenderWaiter = { target, revision, resolve, timer }
    })
  }
  
  async function createParticipantWindow(display: ScreenInfo): Promise<boolean> {
    closeParticipantWindow()
    participantRenderedRevision = 0
    const appIconPath = dependencies.resolveAppWindowIconPath()
  
    const nextWin = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      minimizable: false,
      maximizable: false,
      resizable: false,
      fullscreenable: true,
      skipTaskbar: true,
      autoHideMenuBar: true,
      backgroundColor: '#000000',
      icon: appIconPath,
      fullscreen: false,
      show: false,
      webPreferences: {
        preload: dependencies.preloadPath,
        webSecurity: true,
        experimentalFeatures: true,
      },
    })
    participantWin = nextWin
    nextWin.setMenuBarVisibility(false)
    nextWin.setAutoHideMenuBar(true)
    nextWin.on('closed', () => {
      if (participantWin === nextWin) {
        participantWin = null
      }
    })
  
    const participantUrl = dependencies.devServerUrl
      ? `${dependencies.devServerUrl}?screenMode=participant`
      : `${pathToFileURL(dependencies.indexHtmlPath).toString()}?screenMode=participant`
    const expectedRevision = latestSubjectWindowRevision
    const rendered = waitForParticipantRender(nextWin, expectedRevision)
    await nextWin.loadURL(participantUrl)
    sendLatestSubjectWindowPayload(nextWin)
    const participantReady = expectedRevision > 0 ? await rendered : true
    // Show the window *before* switching it to fullscreen (macOS) or kiosk
    // (Windows). Invoking setFullScreen(true) / setKiosk(true) on a still-hidden
    // window leaves the participant screen painting as a black surface — the
    // native presentation transition never composes the already-rendered web
    // content. Revealing the window first lets the fullscreen/kiosk transition
    // run against a visible window on the configured participant display.
    nextWin.show()
    applyParticipantWindowPresentation(nextWin, display)
    sendLatestSubjectWindowPayload(nextWin)
    return participantReady
  }
  
  async function createRecordingWindow(payload?: { projectDir?: string; forceEnable?: boolean; initialState?: unknown }): Promise<{
    ok: boolean
    message?: string
    config?: ScreenConfig
    warnings?: string[]
    hasParticipantWindow?: boolean
    participantReady?: boolean
    captureDisplay?: Pick<ScreenInfo, 'id' | 'isPrimary' | 'bounds' | 'scaleFactor'>
  }> {
    const mainWindow = dependencies.getMainWindow()
    if (!mainWindow) {
      return { ok: false, message: '主窗口不可用' }
    }
  
    const screens = getScreensSnapshot()
    if (screens.length === 0) {
      return { ok: false, message: '未检测到可用显示器' }
    }
  
    let config: ScreenConfig = { ...DEFAULT_SCREEN_CONFIG }
    const projectDir = typeof payload?.projectDir === 'string' ? payload.projectDir : ''
    if (projectDir) {
      config = await loadScreenConfigFromDisk(projectDir)
    }
  
    if (payload?.forceEnable) {
      const primary = screens.find((s) => s.isPrimary) || screens[0]
      const ids = new Set(screens.map((s) => s.id))
      let experimenterDisplayId = config.experimenterDisplayId
      if (experimenterDisplayId === null || !ids.has(experimenterDisplayId)) {
        experimenterDisplayId = primary.id
      }
      let participantDisplayId = config.participantDisplayId
      if (
        participantDisplayId === null ||
        !ids.has(participantDisplayId) ||
        participantDisplayId === experimenterDisplayId
      ) {
        const fallbackParticipant = screens.find((s) => s.id !== experimenterDisplayId) || null
        participantDisplayId = fallbackParticipant ? fallbackParticipant.id : null
      }
      config = {
        ...config,
        enabled: true,
        experimenterDisplayId,
        participantDisplayId,
      }
    }
  
    const validated = validateScreenConfig(config, screens)
    const experimenter = screens.find((s) => s.id === validated.config.experimenterDisplayId) || screens[0]
  
    try {
      mainWindow.setBounds(experimenter.bounds)
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    } catch (error) {
      console.warn('[screen] move main window failed:', error)
    }
  
    let participantReady = false
    if (validated.config.enabled && validated.config.participantDisplayId !== null) {
      const participant = screens.find((s) => s.id === validated.config.participantDisplayId) || null
      if (participant) {
        try {
          participantReady = await createParticipantWindow(participant)
        } catch (error) {
          console.error('[screen] create participant window failed:', error)
          closeParticipantWindow()
          return {
            ok: false,
            message: '创建被试屏窗口失败',
            config: validated.config,
            warnings: validated.warnings,
            hasParticipantWindow: false,
            participantReady: false,
          }
        }
      }
    } else {
      closeParticipantWindow()
    }
  
    return {
      ok: true,
      config: validated.config,
      warnings: validated.warnings,
      hasParticipantWindow: !!participantWin,
      participantReady,
      captureDisplay: validated.config.enabled && validated.config.participantDisplayId !== null
        ? (() => {
            const display = screens.find((item) => item.id === validated.config.participantDisplayId)
            return display
              ? { id: display.id, isPrimary: display.isPrimary, bounds: display.bounds, scaleFactor: display.scaleFactor }
              : undefined
          })()
        : undefined,
    }
  }
  
  ipcMain.handle('get-screens', async () => {
    try {
      return { ok: true, screens: getScreensSnapshot() }
    } catch (error: unknown) {
      return { ok: false, screens: [], message: `获取显示器信息失败：${getErrorMessage(error)}` }
    }
  })
  
  ipcMain.handle('load-screen-config', async (_event, value: unknown) => {
    const payload = asRecord(value)
    const projectDir = typeof payload.projectDir === 'string' ? payload.projectDir : ''
    if (!projectDir) {
      return { ok: false, message: '缺少 projectDir', config: { ...DEFAULT_SCREEN_CONFIG }, warnings: [] }
    }
  
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, message: `路径验证失败：${pathValidation.error}`, config: { ...DEFAULT_SCREEN_CONFIG }, warnings: [] }
    }
  
    try {
      const loaded = await loadScreenConfigFromDisk(projectDir)
      const validated = validateScreenConfig(loaded, getScreensSnapshot())
      return { ok: true, config: validated.config, warnings: validated.warnings }
    } catch (error: unknown) {
      return { ok: false, message: `读取屏幕配置失败：${getErrorMessage(error)}`, config: { ...DEFAULT_SCREEN_CONFIG }, warnings: [] }
    }
  })
  
  ipcMain.handle('save-screen-config', async (_event, value: unknown) => {
    const payload = asRecord(value)
    const projectDir = typeof payload.projectDir === 'string' ? payload.projectDir : ''
    if (!projectDir) {
      return { ok: false, message: '缺少 projectDir' }
    }
  
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, message: `路径验证失败：${pathValidation.error}` }
    }
  
    const normalized = normalizeScreenConfig(payload.config)
    const validated = validateScreenConfig(normalized, getScreensSnapshot())
    const saved = await saveScreenConfigToDisk(projectDir, validated.config)
    if (!saved.ok) {
      return { ok: false, message: saved.error || '保存屏幕配置失败' }
    }
    return { ok: true, path: saved.path, config: validated.config, warnings: validated.warnings }
  })
  
  ipcMain.handle('validate-screen-config', async (_event, value: unknown) => {
    const payload = asRecord(value)
    const normalized = normalizeScreenConfig(payload.config)
    const validated = validateScreenConfig(normalized, getScreensSnapshot())
    return { ok: true, config: validated.config, warnings: validated.warnings }
  })
  
  ipcMain.handle('create-recording-window', async (_event, value: unknown) => {
    const payload = asRecord(value)
    if ('initialState' in payload) {
      updateLatestSubjectWindowPayload(payload.initialState)
    }
    return createRecordingWindow({
      projectDir: typeof payload.projectDir === 'string' ? payload.projectDir : '',
      forceEnable: !!payload.forceEnable,
      initialState: payload.initialState,
    })
  })
  
  ipcMain.handle('close-recording-window', async () => {
    closeParticipantWindow()
    return { ok: true }
  })
  
  ipcMain.handle('get-recording-monitor-snapshots', async () => {
    return {
      ok: true,
      // The renderer mirrors participant state locally. Returning a full
      // capturePage image here caused delayed previews and stole compositor/GPU
      // time from Windows screen recording.
      participant: null,
      hasParticipantWindow: !!participantWin && !participantWin.isDestroyed(),
    }
  })
  
  ipcMain.handle('update-subject-window', async (_event, payload: unknown) => {
    updateLatestSubjectWindowPayload(payload)
    if (!participantWin || participantWin.isDestroyed()) {
      return { ok: false, message: '被试屏窗口未打开' }
    }
    try {
      sendLatestSubjectWindowPayload(participantWin)
      return { ok: true }
    } catch (error: unknown) {
      return { ok: false, message: `被试屏更新失败：${getErrorMessage(error)}` }
    }
  })

  ipcMain.on('subject-window:ready', (event) => {
    if (!participantWin || participantWin.isDestroyed()) return
    if (event.sender !== participantWin.webContents) return
    sendLatestSubjectWindowPayload(participantWin)
  })

  ipcMain.on('subject-window:rendered', (event, value: unknown) => {
    if (!participantWin || participantWin.isDestroyed()) return
    if (event.sender !== participantWin.webContents) return
    const revision = Number(asRecord(value).revision || 0)
    if (!Number.isFinite(revision) || revision <= 0) return
    participantRenderedRevision = Math.max(participantRenderedRevision, revision)
    const waiter = participantRenderWaiter
    if (!waiter || waiter.target !== participantWin || revision < waiter.revision) return
    resolveParticipantRenderWaiter(true)
  })
  
  ipcMain.on('subject-window:user-input', (_event, payload: unknown) => {
    const mainWindow = dependencies.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return
    try {
      mainWindow.webContents.send('subject-window:user-input', payload || {})
    } catch (error) {
      console.error('[screen] forward subject input failed:', error)
    }
  })
  

  return { closeParticipantWindow }
}
