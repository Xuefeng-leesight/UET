import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, safeStorage, screen, session, shell } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import * as readline from 'node:readline'
import { ChildProcess, ChildProcessWithoutNullStreams, spawn, spawnSync, execSync } from 'node:child_process'
import { getPerformanceLogFilePath, initializePerformanceLogger, logPerfEvent } from './platform/logging/performanceLogger'
import { getVideoDebugLogFilePath, initializeVideoDebugLogger, logVideoDebugEvent } from './platform/logging/videoDebugLogger'
import { RECORD_POINTS_PARSE_VERSION } from '../shared/constants/recordPoints'
import { ENABLE_DEBUG_TESTING } from '../shared/constants/debug'
import { computeAoiStatsRows } from '../shared/domain/aoi/aoiReport'
import { MultiplayerCoordinator } from './domains/multiplayer/MultiplayerCoordinator'
import { createFacialDomain } from './domains/facial/facialHandlers'
import { registerAiHandlers } from './domains/ai/aiHandlers'
import { registerFileHandlers } from './domains/filesystem/fileHandlers'
import { registerExportHandlers } from './domains/export/exportHandlers'
import { validateUtf8Path } from './domains/filesystem/pathValidation'
import { registerMultiplayerHandlers } from './domains/multiplayer/multiplayerHandlers'
import { closeUdpTriggerSockets, registerMarkerHandlers } from './domains/markers/markerHandlers'
import { createGazeMappingDomain } from './domains/mapping/gazeMappingHandlers'
import { registerProjectHandlers } from './domains/project/projectHandlers'
import { registerReportHandlers } from './domains/report/reportHandlers'
import { createRecordingAudioDomain } from './domains/recording/recordingAudioHandlers'
import {
  DEFAULT_MAX_RECORD_POINTS,
  RECORD_POINTS_INDEX_VERSION,
  buildRecordPointsIndex,
  createMainPointSampler,
  finalizeMainHeatmapPoints,
  getPointTimestampMs,
  getRecordPointsIndexOptions,
  getRecordPointsIndexPaths,
  inspectGlassesModeSample,
  loadRecordPointsFromIndex,
  makeCsvPointParserState,
  parseCsvLineFast,
  parseCsvPartsToHeatmapPoint,
  pointMatchesLoadOptions,
  writeTextFileAtomic,
  type CsvPointParserState,
  type MainHeatmapPoint,
} from './domains/recording/recordPointsModel'
import { registerRecordingListHandlers } from './domains/recording/recordingListHandlers'
import { registerRecordPointHandlers } from './domains/recording/recordPointHandlers'
import { registerRecordExportHandlers } from './domains/recording/recordExportHandlers'
import { registerRecordMetadataHandlers } from './domains/recording/recordMetadataHandlers'
import { registerRecordMediaHandlers } from './domains/recording/recordMediaHandlers'
import { registerCalibrationDataHandlers } from './domains/recording/calibrationDataHandlers'
import { createScreenDomain } from './domains/screen/screenHandlers'
import { registerWindowControlHandlers } from './domains/system/windowControlHandlers'
import { registerDiagnosticHandlers } from './domains/system/diagnosticHandlers'
import { createStimulusRepository } from './domains/stimuli/stimulusRepository'
import { registerStimulusScreenRecordingHandlers } from './domains/stimuli/stimulusScreenRecordingHandlers'
import { createStimulusTranscoder } from './domains/stimuli/stimulusTranscoding'
import { registerStimulusImportHandlers } from './domains/stimuli/stimulusImportHandlers'
import { registerStimulusLoadHandlers } from './domains/stimuli/stimulusLoadHandlers'
import { registerStimulusMutationHandlers } from './domains/stimuli/stimulusMutationHandlers'
import { registerTriggerHandlers, stopTriggerTcpEyeServer } from './domains/trigger/triggerHandlers'
import {
  DEFAULT_SDK_MODEL,
  DESKTOP_SDK_MODELS,
  GLASSES_SDK_MODEL,
  getSdkContainerPath as resolveSdkContainerPath,
  resolveSdkPaths as resolveSdkRuntimePaths,
  type SdkRuntimeContext,
} from './platform/sdk/sdkRuntime'
import { createSdkSelection } from './platform/sdk/sdkSelection'
import { registerAppShutdownHandlers } from './app/appShutdown'
import { createMainWindowController } from './app/mainWindow'
import { createLicenseWindowController } from './app/licenseWindow'
import {
  STIMULUS_AUDIO_EXTENSIONS,
  STIMULUS_IMAGE_EXTENSIONS,
  STIMULUS_VIDEO_EXTENSIONS,
  buildLocalResourceUrl,
  configurePermissions,
  ensureAsciiMediaCachePath,
  hasNonAsciiPath,
  inferStimulusMediaTypeFromPath,
  isStimulusAudioExtension,
  isStimulusVideoExtension,
  logMainVideoDebug,
  registerLocalFileProtocol,
  shouldTranscodeStimulusVideo,
} from './platform/media/localResourceProtocol'
import { createMediaToolkit } from './platform/media/mediaToolkit'
import { createPythonRuntime } from './platform/python/pythonRuntime'
import { buildGazeMappingCommand } from './platform/python/analysisLaunch'
import { createAuthorizedPathRegistry } from './platform/security/authorizedPaths'
import { getLicenseClientConfig } from './domains/licensing/licenseConfig'
import { createLicenseService } from './domains/licensing/licenseService'
import { registerLicenseHandlers } from './domains/licensing/licenseHandlers'
import { createUpdateService } from './domains/updater/updateService'
import { registerUpdateHandlers } from './domains/updater/updateHandlers'

declare const __ENABLE_LICENSE_AUTHORIZATION__: boolean | undefined
const ENABLE_LICENSE_AUTHORIZATION = typeof __ENABLE_LICENSE_AUTHORIZATION__ === 'boolean'
  ? __ENABLE_LICENSE_AUTHORIZATION__
  : true

if (!ENABLE_DEBUG_TESTING) {
  console.log = () => {}
}

// Register the scheme as privileged.
// This must be done *before* the app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-resource',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      bypassCSP: true, // Allow bypassing CSP for this protocol if needed
      stream: true,    // Efficiently stream the response
    },
  },
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const authorizedPaths = createAuthorizedPathRegistry(path.join(app.getPath('temp'), 'mrt-manager'))

function getErrorDetails(error: unknown): { message: string; code: string; name: string; stack: string | null } {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  return {
    message: error instanceof Error && error.message ? error.message : typeof record.message === 'string' ? record.message : '',
    code: typeof record.code === 'string' ? record.code : '',
    name: error instanceof Error ? error.name : typeof record.name === 'string' ? record.name : '',
    stack: error instanceof Error && error.stack ? error.stack : typeof record.stack === 'string' ? record.stack : null,
  }
}

const EXPERIMENT_MODULE_DIRS = [
  'subjects',
  'stimuli',
  'recordings',
  'monitor',
  'visualization',
  'reports',
  'exports',
]

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.js
// │
process.env.DIST = path.join(__dirname, '../dist')
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public')

// Combined acquisition suspends the glasses H.265 live-preview decoder in the
// renderer, which isolates the native path implicated in Windows host hangs.
// Do not disable Chromium GPU acceleration by default: the analysis views and
// WebCodecs renderer legitimately require WebGL, and Chromium no longer falls
// back to SwiftShader automatically. Keep this opt-in switch for diagnostics.
const windowsGpuSafeMode = process.platform === 'win32'
  && process.env.MRT_WINDOWS_GPU_SAFE_MODE === '1'
if (windowsGpuSafeMode) {
  app.disableHardwareAcceleration()
} else {
  app.commandLine.appendSwitch('enable-accelerated-video-decode')
  const hardwareVideoFeatures = process.platform === 'linux'
    ? 'VaapiVideoDecoder,VaapiVideoEncoder'
    : 'PlatformHEVCDecoderSupport'
  app.commandLine.appendSwitch('enable-features', hardwareVideoFeatures)
}
app.commandLine.appendSwitch('enable-blink-features', 'WebCodecs')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const devServerUrlForSecurity = process.env.VITE_DEV_SERVER_URL?.replace(/\/$/, '')
if (devServerUrlForSecurity) {
  app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', devServerUrlForSecurity)
}
let shouldSkipStartup = false
let isBootstrappingSoftdog = false
let isLicenseModuleAllowed = (_code: string): boolean => !ENABLE_LICENSE_AUTHORIZATION
const multiplayerCoordinator = new MultiplayerCoordinator()
const PROJECT_IMPORT_PROGRESS_CHANNEL = 'project-import-progress'
const MAIN_DEBUG_HEARTBEAT_INTERVAL_MS = 2000

function resolveAppWindowIconPath(): string | undefined {
  const candidates: string[] = []

  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'icon.ico'))
    candidates.push(path.join(process.resourcesPath, 'icon.png'))
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'icon.ico'))
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'icon.png'))
  } else {
    const projectRoot = path.resolve(__dirname, '..')
    candidates.push(path.join(projectRoot, 'icon.ico'))
    candidates.push(path.join(projectRoot, 'icon.png'))
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate
      }
    } catch {
    }
  }
  return undefined
}

let closeParticipantWindow = (): void => {}
const mainWindow = createMainWindowController({
  appDir: __dirname,
  devServerUrl: process.env.VITE_DEV_SERVER_URL,
  indexHtmlPath: path.join(process.env.DIST, 'index.html'),
  resolveAppWindowIconPath,
  closeParticipantWindow: () => closeParticipantWindow(),
})
const licenseWindow = createLicenseWindowController({
  appDir: __dirname,
  devServerUrl: process.env.VITE_DEV_SERVER_URL,
  indexHtmlPath: path.join(process.env.DIST, 'index.html'),
  resolveAppWindowIconPath,
})
let mainDebugHeartbeatTimer: NodeJS.Timeout | null = null
const observedMainWindowIds = new Set<number>()
const mainEventLoopDelay = monitorEventLoopDelay({ resolution: 20 })
mainEventLoopDelay.enable()

function attachMainWindowDebugListeners(win: BrowserWindow): void {
  const windowId = win.id
  if (observedMainWindowIds.has(windowId)) return
  observedMainWindowIds.add(windowId)

  // Accessing `win.webContents` after the window is destroyed throws
  // "Object has been destroyed". Snapshot window identity safely so late
  // events (unresponsive/closed after teardown) never touch a dead window.
  const safeWindowSnapshot = (): { windowId: number | null; webContentsId: number | null; url: string | null } => {
    if (win.isDestroyed()) return { windowId: null, webContentsId: null, url: null }
    const wc = win.webContents
    if (!wc || wc.isDestroyed()) return { windowId, webContentsId: null, url: null }
    return { windowId, webContentsId: wc.id, url: wc.getURL() }
  }

  const emitWindowDebug = (event: string, details: Record<string, unknown> = {}) => {
    logVideoDebugEvent({
      source: 'main',
      event,
      details: {
        ...safeWindowSnapshot(),
        ...details,
      },
    })
  }

  emitWindowDebug('main-window-debug-listeners-attached')

  win.on('unresponsive', () => {
    emitWindowDebug('main-window-unresponsive')
  })

  win.on('responsive', () => {
    emitWindowDebug('main-window-responsive')
  })

  win.on('closed', () => {
    observedMainWindowIds.delete(windowId)
    emitWindowDebug('main-window-debug-closed')
  })

  win.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (isMainFrame) emitWindowDebug('main-window-navigation-start', { url, isInPlace })
  })
  win.webContents.on('did-finish-load', () => {
    emitWindowDebug('main-window-load-finished')
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    emitWindowDebug('main-window-render-process-gone', {
      reason: details.reason,
      exitCode: details.exitCode,
    })
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame, frameProcessId, frameRoutingId) => {
    emitWindowDebug('main-window-did-fail-load', {
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame,
      frameProcessId,
      frameRoutingId,
    })
  })
}

function startMainDebugHeartbeat(): void {
  if (mainDebugHeartbeatTimer) return
  mainDebugHeartbeatTimer = setInterval(() => {
    const win = mainWindow.getMainWindow()
    const wc = win?.webContents ?? null
    const memoryUsage = process.memoryUsage()
    logVideoDebugEvent({
      source: 'main',
      event: 'main-process-heartbeat',
      details: {
        windowCount: BrowserWindow.getAllWindows().length,
        mainWindowId: win?.id ?? null,
        mainWindowDestroyed: win ? win.isDestroyed() : null,
        mainWindowVisible: win && !win.isDestroyed() ? win.isVisible() : null,
        mainWindowFocused: win && !win.isDestroyed() ? win.isFocused() : null,
        webContentsId: wc?.id ?? null,
        webContentsCrashed: wc ? wc.isCrashed() : null,
        webContentsUrl: wc ? wc.getURL() : null,
        rssMb: Math.round(memoryUsage.rss / (1024 * 1024)),
        heapUsedMb: Math.round(memoryUsage.heapUsed / (1024 * 1024)),
        externalMb: Math.round(memoryUsage.external / (1024 * 1024)),
        eventLoopLagMeanMs: Number((mainEventLoopDelay.mean / 1_000_000).toFixed(3)),
        eventLoopLagMaxMs: Number((mainEventLoopDelay.max / 1_000_000).toFixed(3)),
      },
    })
    mainEventLoopDelay.reset()
  }, MAIN_DEBUG_HEARTBEAT_INTERVAL_MS)
  mainDebugHeartbeatTimer.unref?.()
}

function stopMainDebugHeartbeat(): void {
  if (!mainDebugHeartbeatTimer) return
  clearInterval(mainDebugHeartbeatTimer)
  mainDebugHeartbeatTimer = null
}

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  logPerfEvent({ processType: 'main', event: 'single-instance-lock-denied' })
  app.quit()
} else {
  logPerfEvent({ processType: 'main', event: 'single-instance-lock-acquired' })
}

logPerfEvent({
  processType: 'main',
  event: 'main-module-loaded',
  details: {
    isPackaged: app.isPackaged,
    hasDevServer: Boolean(process.env.VITE_DEV_SERVER_URL),
  },
})

function normalizeStimulusToggle(value: unknown): boolean {
  if (value === true) return true
  if (value === false || value == null) return false
  if (typeof value === 'number') return value === 1
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    return v === 'true' || v === '1' || v === 'yes' || v === 'on'
  }
  return false
}

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const MAX_SYNC_METRIC_CSV_BYTES = 80 * 1024 * 1024
const DEFAULT_CSV_PREVIEW_ROWS = 100
const EXPORT_CSV_DECIMAL_PLACES = 3

const trimFixedDecimal = (value: number, digits: number): string => {
  const text = value.toFixed(digits).replace(/\.?0+$/, '')
  return text === '-0' || text === '' ? '0' : text
}

const formatExportCsvCell = (value: unknown, digits = EXPORT_CSV_DECIMAL_PLACES): unknown => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? trimFixedDecimal(value, digits) : value
  }
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text || (!text.includes('.') && !/[eE]/.test(text))) return value
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return value
  const numeric = Number(text)
  return Number.isFinite(numeric) ? trimFixedDecimal(numeric, digits) : value
}

const {
  getSdkContainerPath,
  resolveSdkPaths,
  getSdkRootPath,
  getSdkTypesPath,
  normalizeProjectDeviceType,
  normalizeSdkModelName,
  normalizeProjectDeviceModel,
  modelFromDeviceType,
  applyPreferredSdkModelForProject,
} = createSdkSelection({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appDir: __dirname,
})

const {
  safeTimestampForPath,
  sanitizePathSegment,
  uniqueDirPath,
  uniqueFilePath,
  isSubPath,
  runCommand,
  runCommandCapture,
  probeMediaDurationSeconds,
  createZipArchive,
  findFfmpegBinary,
  prewarmFfmpegBinary,
  toFfmpegSeconds,
  buildAtempoFilterForSlowdown,
  repairVideoToH264,
  normalizeProjectRecordVideos,
} = createMediaToolkit({
  appDir: __dirname,
  requireModule: require,
  normalizeProjectDeviceType,
  getSdkContainerPath,
  getSdkRootPath,
})

// Pre-warm the ffmpeg binary lookup during app boot so the (synchronous,
// probing) scan does not block user-triggered recording/export later.
void prewarmFfmpegBinary()

const pythonRuntime = createPythonRuntime({
  appDir: __dirname,
  getMainWindow: mainWindow.getMainWindow,
  getSdkContainerPath,
  getSdkRootPath,
  resolveSdkPaths,
  findFfmpegBinary,
})

const {
  ensureSoftdogKeyConfigured,
  getPyServerCommand,
  stopPyServer,
  cleanupOrphanedProcesses,
  startPyServer,
  restartPyServerAfterStop,
  restartPyServerForSdkModelChange,
} = pythonRuntime

registerDiagnosticHandlers(mainWindow.getMainWindow)

const transcodeStimulusVideoToMp4 = createStimulusTranscoder(findFfmpegBinary, runCommand)

const {
  deleteUnreferencedStimulusFiles,
  hydrateStimuliFromDisk,
  serializeStimuliForDisk,
  stimulusMediaFileName,
  writeStimuliJson,
} = createStimulusRepository(buildLocalResourceUrl)

const recordingAudioDomain = createRecordingAudioDomain({ findFfmpegBinary, runCommand })
recordingAudioDomain.registerHandlers()

registerFileHandlers(authorizedPaths)

const screenDomain = createScreenDomain({
  devServerUrl: VITE_DEV_SERVER_URL,
  getMainWindow: mainWindow.getMainWindow,
  indexHtmlPath: path.join(process.env.DIST, 'index.html'),
  preloadPath: path.join(__dirname, 'preload.mjs'),
  resolveAppWindowIconPath,
})
closeParticipantWindow = () => screenDomain.closeParticipantWindow()

const gazeMappingDomain = createGazeMappingDomain({
  buildLocalResourceUrl,
  getMainWindow: mainWindow.getMainWindow,
  getMappingCommand: (jobPath) => buildGazeMappingCommand({
    appDir: __dirname, resourcesPath: process.resourcesPath,
    packaged: app.isPackaged, platform: process.platform, env: process.env,
  }, jobPath),
  logVideoDebug: logMainVideoDebug,
  isModuleAllowed: (code) => isLicenseModuleAllowed(code),
})
gazeMappingDomain.registerHandlers()

registerProjectHandlers({
  authorizedPaths,
  applyPreferredSdkModelForProject,
  getMainWindow: mainWindow.getMainWindow,
  normalizeProjectDeviceModel,
  normalizeProjectDeviceType,
  restartPyServerForSdkModelChange,
})

function normalizeDataSamplingRateHz(value: unknown): number {
  const hz = Number(value)
  if (!Number.isFinite(hz) || hz <= 0) return 0
  const candidates = [30, 60, 90, 120, 140, 240]
  let best = candidates[0]
  let bestErr = Infinity
  for (const candidate of candidates) {
    const error = Math.abs(hz - candidate)
    if (error < bestErr) {
      bestErr = error
      best = candidate
    }
  }
  return best
}

registerExportHandlers({
  authorizedPaths,
  buildAtempoFilterForSlowdown,
  createZipArchive,
  findFfmpegBinary,
  getMainWindow: mainWindow.getMainWindow,
  isSubPath,
  runCommand,
  safeTimestampForPath,
  sanitizePathSegment,
  toFfmpegSeconds,
  uniqueDirPath,
  uniqueFilePath,
})

const stimulusScreenRecordingDomain = registerStimulusScreenRecordingHandlers({
  buildLocalResourceUrl,
  findFfmpegBinary,
  getMainWindow: mainWindow.getMainWindow,
  hydrateStimuliFromDisk,
  normalizeStimulusToggle,
  runCommandCapture,
  safeTimestampForPath,
  sanitizePathSegment,
  uniqueFilePath,
  writeStimuliJson,
})

registerStimulusImportHandlers({
  buildLocalResourceUrl,
  hydrateStimuliFromDisk,
  inferStimulusMediaTypeFromPath,
  isStimulusAudioExtension,
  isStimulusVideoExtension,
  normalizeStimulusToggle,
  shouldTranscodeStimulusVideo,
  transcodeStimulusVideoToMp4,
  writeStimuliJson,
})

registerStimulusLoadHandlers({
  buildLocalResourceUrl,
  hydrateStimuliFromDisk,
  normalizeStimulusToggle,
  serializeStimuliForDisk,
  shouldTranscodeStimulusVideo,
  stimulusAudioExtensions: STIMULUS_AUDIO_EXTENSIONS,
  stimulusImageExtensions: STIMULUS_IMAGE_EXTENSIONS,
  stimulusVideoExtensions: STIMULUS_VIDEO_EXTENSIONS,
  transcodeStimulusVideoToMp4,
  writeStimuliJson,
})

registerStimulusMutationHandlers({
  buildLocalResourceUrl,
  deleteUnreferencedStimulusFiles,
  hydrateStimuliFromDisk,
  inferStimulusMediaTypeFromPath,
  normalizeStimulusToggle,
  stimulusMediaFileName,
  writeStimuliJson,
})

registerReportHandlers({
  getMainWindow: mainWindow.getMainWindow,
  safeTimestampForPath,
  sanitizePathSegment,
  uniqueDirPath,
})

registerAiHandlers()

registerRecordingListHandlers({
  buildLocalResourceUrl,
  normalizeDataSamplingRateHz,
  normalizeProjectDeviceModel,
  normalizeProjectDeviceType,
  probeMediaDurationSeconds,
})

registerRecordPointHandlers()

registerRecordMetadataHandlers({ normalizeDataSamplingRateHz })

registerRecordExportHandlers({ trimFixedDecimal })

registerRecordMediaHandlers({
  buildLocalResourceUrl,
  hasNonAsciiPath,
  logVideoDebug: logMainVideoDebug,
  normalizeProjectDeviceType,
  normalizeProjectRecordVideos,
  repairVideoToH264,
  stimulusImageExtensions: STIMULUS_IMAGE_EXTENSIONS,
  stimulusVideoExtensions: STIMULUS_VIDEO_EXTENSIONS,
})

registerCalibrationDataHandlers({ formatExportCsvCell })

registerMultiplayerHandlers(multiplayerCoordinator)

registerTriggerHandlers()

const facialDomain = createFacialDomain({
  buildLocalResourceUrl,
  findFfmpegBinary,
  getMainWindow: mainWindow.getMainWindow,
  getPyServerCommand,
  runCommand,
  scriptPath: path.resolve(__dirname, '../services/facial_analysis/server.py'),
  isModuleAllowed: (code) => isLicenseModuleAllowed(code),
})
facialDomain.registerHandlers()

registerMarkerHandlers()

registerWindowControlHandlers({
  applyMainWindowAppearance: mainWindow.applyMainWindowAppearance,
  getMainWindow: mainWindow.getMainWindow,
  logRendererShutdown: () => logPerfEvent({ processType: 'main', event: 'renderer-shutdown-complete' }),
  prepareMainWindowClose: mainWindow.prepareMainWindowClose,
  restartPythonServer: () => {
    if (pythonRuntime.isRunning()) restartPyServerAfterStop('ipc restart')
    else startPyServer()
  },
  setMainWindowModalMask: mainWindow.setMainWindowModalMask,
  setMainWindowOverlayTheme: mainWindow.setMainWindowOverlayTheme,
  setMainWindowTheme: mainWindow.setMainWindowTheme,
  stopPythonServer: stopPyServer,
})

app.on('second-instance', () => {
  logPerfEvent({ processType: 'main', event: 'app-second-instance' })
  if (shouldSkipStartup) return
  const win = mainWindow.getMainWindow()
  if (!win) return
  if (win.isMinimized()) {
    win.restore()
  }
  if (!win.isVisible()) {
    win.show()
  }
  win.focus()
})

app.on('browser-window-created', (_event, win) => {
  attachMainWindowDebugListeners(win)
})

app.on('render-process-gone', (_event, webContents, details) => {
  logVideoDebugEvent({
    source: 'main',
    event: 'app-render-process-gone',
    details: {
      webContentsId: webContents.id,
      reason: details.reason,
      exitCode: details.exitCode,
      url: webContents.getURL(),
    },
  })
})

app.on('child-process-gone', (_event, details) => {
  logVideoDebugEvent({
    source: 'main',
    event: 'app-child-process-gone',
    details: {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      name: details.name,
      serviceName: details.serviceName,
    },
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  logPerfEvent({
    processType: 'main',
    event: 'window-all-closed',
    details: { isBootstrappingSoftdog, platform: process.platform },
  })
  if (isBootstrappingSoftdog) {
    console.log('[app] window-all-closed ignored during softdog bootstrap')
    return
  }
  screenDomain.closeParticipantWindow()
  stopPyServer()
  stopMainDebugHeartbeat()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  logPerfEvent({ processType: 'main', event: 'app-activate' })
  if (shouldSkipStartup) return
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow.createWindow()
  }
})

app.whenReady().then(async () => {
  await initializePerformanceLogger()
  await initializeVideoDebugLogger()
  logPerfEvent({
    processType: 'main',
    event: 'app-when-ready',
    details: {
      perfLogFilePath: getPerformanceLogFilePath(),
      videoDebugLogFilePath: getVideoDebugLogFilePath(),
    },
  })
  logMainVideoDebug('app-when-ready', {
    perfLogFilePath: getPerformanceLogFilePath(),
    videoDebugLogFilePath: getVideoDebugLogFilePath(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    windowsGpuSafeMode,
  })
  // Query asynchronously so collecting diagnostics does not delay device startup.
  void app.getGPUInfo('complete').then((info) => {
    const gpu = info as Record<string, unknown>;
    logMainVideoDebug('startup:gpu-diagnostics', {
      diagnosticVersion: 1, electron: process.versions.electron, chrome: process.versions.chrome,
      featureStatus: app.getGPUFeatureStatus(), gpuDevice: gpu.gpuDevice,
      auxAttributes: gpu.auxAttributes,
      note: 'GPU inventory and Chromium features; does not identify the WebCodecs decoder backend',
    })
  }).catch((error) => logMainVideoDebug('startup:gpu-diagnostics-error', { error: String(error) }))
  startMainDebugHeartbeat()

  await cleanupOrphanedProcesses()
  await registerLocalFileProtocol(authorizedPaths)
  logPerfEvent({ processType: 'main', event: 'local-protocol-registered' })
  configurePermissions()
  logPerfEvent({ processType: 'main', event: 'permissions-configured' })

  const licenseConfig = getLicenseClientConfig(app.isPackaged)
  const licenseService = createLicenseService({
    ...licenseConfig,
    userDataPath: app.getPath('userData'),
    clientVersion: app.getVersion(),
    onModulesChanged: async (modules) => {
      const eyeTrackingAllowed = modules.some((module) => module.code === 'eye_tracking')
      const facialAnalysisAllowed = modules.some((module) => module.code === 'facial_analysis')
      if (!facialAnalysisAllowed) facialDomain.stop()
      if (!eyeTrackingAllowed) {
        stopPyServer()
        return
      }
      if (pythonRuntime.isRunning()) return
      isBootstrappingSoftdog = true
      try {
        logPerfEvent({ processType: 'main', event: 'licensed-softdog-bootstrap-start' })
        const ready = await ensureSoftdogKeyConfigured((deviceModel) => licenseService.fetchSoftdogPassword(deviceModel))
        if (!ready) {
          logPerfEvent({ processType: 'main', event: 'licensed-softdog-bootstrap-canceled' })
          return
        }
        await cleanupOrphanedProcesses()
        startPyServer()
        logPerfEvent({ processType: 'main', event: 'licensed-py-server-start-triggered' })
      } finally {
        isBootstrappingSoftdog = false
      }
    },
  })
  registerLicenseHandlers(licenseService, licenseConfig.apiOrigin, ENABLE_LICENSE_AUTHORIZATION, () => {
    // 授权成功：先创建主窗口再关闭授权窗口，避免中间态触发 window-all-closed 导致退出。
    mainWindow.createWindow()
    licenseWindow.closeWindow()
  })
  const updateService = createUpdateService({
    licenseService,
    tempPath: app.getPath('temp'),
    clientVersion: app.getVersion(),
    apiOrigin: licenseConfig.apiOrigin,
    expectedWindowsPublisher: licenseConfig.expectedWindowsPublisher,
    quitApplication: () => app.quit(),
  })
  registerUpdateHandlers(updateService)
  isLicenseModuleAllowed = (code) => !ENABLE_LICENSE_AUTHORIZATION || licenseService.hasModule(code)
  if (ENABLE_LICENSE_AUTHORIZATION) {
    await licenseService.initialize()
  } else {
    isBootstrappingSoftdog = true
    try {
      const ready = await ensureSoftdogKeyConfigured((deviceModel) => licenseService.fetchSoftdogPassword(deviceModel))
      if (ready) startPyServer()
    } finally {
      isBootstrappingSoftdog = false
    }
  }
  // 授权总开关开启且本机未激活时，先展示独立的授权窗口（1280×768）；
  // 激活成功后再切换到主窗口。
  if (ENABLE_LICENSE_AUTHORIZATION && !licenseService.getState().canUseApp) {
    licenseWindow.createWindow()
  } else {
    mainWindow.createWindow()
  }
})

app.on('will-quit', () => {
  stopMainDebugHeartbeat()
})

registerAppShutdownHandlers({
  app,
  pythonWaitTimeoutMs: pythonRuntime.waitExitTimeoutMs,
  getPythonProcess: pythonRuntime.getProcess,
  isProcessAlive: pythonRuntime.isProcessAlive,
  stopPythonServer: stopPyServer,
  cleanupOrphanedProcesses,
  closeParticipantWindow: () => screenDomain.closeParticipantWindow(),
  stopFacialDomain: () => facialDomain.stop(),
  abortRecordingAudio: () => void recordingAudioDomain.abortAll(),
  stopStimulusScreenRecordings: () => stimulusScreenRecordingDomain.stopAllStimulusScreenRecordings(),
  closeUdpTriggerSockets,
  stopTriggerTcpEyeServer,
  logEvent: (event) => logPerfEvent({ processType: 'main', event }),
})
