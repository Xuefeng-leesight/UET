import { buildHuahongCommand, isHuahongModel } from './huahongLaunch'
import { app, type BrowserWindow as BrowserWindowType } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import * as readline from 'node:readline'
import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { ENABLE_DEBUG_TESTING } from '../../../shared/constants/debug'
import { DEFAULT_SDK_MODEL, type ResolvedSdkPaths } from '../sdk/sdkRuntime'
import { logVideoDebugEvent } from '../logging/videoDebugLogger'
import { buildPupilCommand } from './pupilLaunch'

const PY_SERVER_FORCE_KILL_TIMEOUT_MS = 7000
const PY_SERVER_WAIT_EXIT_TIMEOUT_MS = 9000
const PY_SERVER_RESTART_DELAY_MS = 2500
const PY_SERVER_PORT_RETRY_DELAY_MS = 2500
const PY_SERVER_PORT_RETRY_MAX = 4
// Crash auto-restart (distinct from port-bind retry): when the Python service
// exits unexpectedly (e.g. the vendor SDK segfaults on a stuck USB dongle), the
// port-bind retry path above never triggers, so the service would stay down
// until the user restarts the whole app. Bounded backoff here recovers it.
const PY_SERVER_CRASH_RESTART_MAX = 5
const PY_SERVER_CRASH_RESTART_BASE_DELAY_MS = 3000

function getErrorDetails(error: unknown): { message: string; code: string; name: string; stack: string | null } {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  return {
    message: error instanceof Error && error.message ? error.message : typeof record.message === 'string' ? record.message : '',
    code: typeof record.code === 'string' ? record.code : '',
    name: error instanceof Error ? error.name : typeof record.name === 'string' ? record.name : '',
    stack: error instanceof Error && error.stack ? error.stack : typeof record.stack === 'string' ? record.stack : null,
  }
}

export function createPythonRuntime(deps: {
  appDir: string
  getMainWindow: () => BrowserWindowType | null
  getSdkContainerPath: () => string
  getSdkRootPath: () => string
  resolveSdkPaths: (preferredModel?: string) => ResolvedSdkPaths
  findFfmpegBinary: () => string | null
}) {
  const __dirname = deps.appDir
  const getSdkContainerPath = deps.getSdkContainerPath
  const getSdkRootPath = deps.getSdkRootPath
  const resolveSdkPaths = deps.resolveSdkPaths
  const findFfmpegBinary = deps.findFfmpegBinary
  let pyServerProcess: ChildProcessWithoutNullStreams | null = null
  const stopRequestedProcesses = new WeakSet<ChildProcessWithoutNullStreams>()
  let runningModel = ''
  let runningPupilRoot = ''
  let pyServerStopRequested = false
  let pyServerPortOccupiedNoticeShown = false
  let pyServerPortRetryTimer: NodeJS.Timeout | null = null
  let pyServerShuttingDownForQuit = false
  let pyServerCrashRestartCount = 0
  let pyServerCrashRestartTimer: NodeJS.Timeout | null = null

  // Once the app starts quitting, port-bind retries must never respawn the server.
  app.on('will-quit', () => {
    pyServerShuttingDownForQuit = true
    if (pyServerPortRetryTimer) {
      clearTimeout(pyServerPortRetryTimer)
      pyServerPortRetryTimer = null
    }
    if (pyServerCrashRestartTimer) {
      clearTimeout(pyServerCrashRestartTimer)
      pyServerCrashRestartTimer = null
    }
  })

const SOFTDOG_SECTION = 'softdog'

function getSoftdogIniPath(): string {
  const sdkRoot = getSdkRootPath()
  const iniAtRoot = path.join(sdkRoot, 'config.ini')
  if (fs.existsSync(iniAtRoot)) return iniAtRoot
  return path.join(sdkRoot, 'config', 'config.ini')
}

function readSoftdogPwdFromIni(raw: string): string {
  const lines = String(raw || '').split(/\r?\n/)
  let inSoftdog = false
  for (const line of lines) {
    const trimmed = String(line || '').trim()
    if (!trimmed) continue
    const sectionMatch = /^\[(.+?)\]\s*$/i.exec(trimmed)
    if (sectionMatch) {
      inSoftdog = sectionMatch[1].trim().toLowerCase() === SOFTDOG_SECTION
      continue
    }
    if (inSoftdog && /^\s*pwd\s*=/i.test(trimmed)) {
      const idx = line.indexOf('=')
      if (idx < 0) return ''
      return line.slice(idx + 1).trim()
    }
  }
  return ''
}

function upsertSoftdogPwdInIni(raw: string, pwd: string): string {
  const newline = String(raw || '').includes('\r\n') ? '\r\n' : '\n'
  const lines = String(raw || '').split(/\r?\n/)
  let softdogSectionStart = -1
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = String(lines[i] || '').trim()
    const sectionMatch = /^\[(.+?)\]\s*$/i.exec(trimmed)
    if (sectionMatch && sectionMatch[1].trim().toLowerCase() === SOFTDOG_SECTION) {
      softdogSectionStart = i
      break
    }
  }

  if (softdogSectionStart < 0) {
    const out = [...lines]
    if (out.length > 0 && String(out[out.length - 1] || '').trim().length > 0) {
      out.push('')
    }
    out.push('[softdog]')
    out.push(`pwd=${pwd}`)
    let joined = out.join(newline)
    if (!joined.endsWith(newline)) joined += newline
    return joined
  }

  let sectionEnd = lines.length
  for (let i = softdogSectionStart + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+\]\s*$/i.test(String(lines[i] || '').trim())) {
      sectionEnd = i
      break
    }
  }

  for (let i = softdogSectionStart + 1; i < sectionEnd; i += 1) {
    if (/^\s*pwd\s*=/i.test(String(lines[i] || ''))) {
      lines[i] = `pwd=${pwd}`
      let joined = lines.join(newline)
      if (!joined.endsWith(newline)) joined += newline
      return joined
    }
  }

  const out = [...lines]
  out.splice(sectionEnd, 0, `pwd=${pwd}`)
  let joined = out.join(newline)
  if (!joined.endsWith(newline)) joined += newline
  return joined
}

function sanitizeSoftdogKey(value: string): string {
  return String(value || '').replace(/[\r\n\t]/g, '').trim()
}

async function writeSoftdogPwd(pwd: string): Promise<string> {
  const iniPath = getSoftdogIniPath()
  await fs.promises.mkdir(path.dirname(iniPath), { recursive: true })
  let raw = ''
  try {
    raw = await fs.promises.readFile(iniPath, 'utf-8')
  } catch {
    raw = ''
  }
  const next = upsertSoftdogPwdInIni(raw, pwd)
  await fs.promises.writeFile(iniPath, next, 'utf-8')
  return iniPath
}

type FetchSoftdogPassword = (deviceModel: string) => Promise<{
  ok: boolean;
  configured?: boolean;
  password?: string;
}>;

async function ensureSoftdogKeyConfigured(fetchPassword?: FetchSoftdogPassword): Promise<boolean> {
  if (process.env.MRT_SDK_MODEL === 'PupilCore' || isHuahongModel(process.env.MRT_SDK_MODEL)) return true
  // Always rely on config.ini; never override from env.
  delete process.env.MRT_SOFTDOG_PWD
  // A8 starts directly in the vendor SDK; it has no softdog password requirement.
  if (resolveSdkPaths().model === 'A8') return true
  const iniPath = getSoftdogIniPath()

  let iniPwd = ''
  try {
    const raw = await fs.promises.readFile(iniPath, 'utf-8')
    iniPwd = readSoftdogPwdFromIni(raw)
  } catch {
    iniPwd = ''
  }

  console.log('[softdog] bootstrap', {
    iniPath,
    hasIniPwd: Boolean(iniPwd),
  })

  if (iniPwd) {
    console.log('[softdog] using ini pwd source')
    return true
  }

  // 本地无密码时，按当前设备型号（Pro/A8/aSeeGlassesPlus）从服务器拉取密码，
  // 运营已在后台为该客户该型号设备录入密码时自动填入。
  if (fetchPassword) {
    try {
      const currentModel = resolveSdkPaths().model
      const result = await fetchPassword(currentModel)
      if (result.ok && result.configured && result.password) {
        const pwd = sanitizeSoftdogKey(result.password)
        if (pwd) {
          const writtenPath = await writeSoftdogPwd(pwd)
          console.log('[softdog] key provisioned from server', {
            iniPath: writtenPath,
            model: currentModel,
            keyLength: pwd.length,
            source: 'server',
          })
        }
      } else {
        console.log('[softdog] server password not configured', {
          model: currentModel,
          ok: result.ok,
          configured: result.configured ?? false,
        })
      }
    } catch (error: unknown) {
      console.error('[softdog] server fetch failed', getErrorDetails(error))
    }
  }

  // 不弹窗、不阻止启动：缺密钥时由用户在对应 SDK 的 config.ini 里手动配置，
  // 或在启动设备时由 Python 侧按错误码给出提示。
  return true
}

function getPyServerCommand(): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } | null {
  if (isHuahongModel(process.env.MRT_SDK_MODEL)) {
    return buildHuahongCommand({ appDir: __dirname, resourcesPath: process.resourcesPath,
      packaged: app.isPackaged, platform: process.platform, env: process.env,
      ffmpeg: findFfmpegBinary(), rendererUrl: deps.getMainWindow()?.webContents.getURL() || process.env.VITE_DEV_SERVER_URL || '' })
  }
  if (process.env.MRT_SDK_MODEL === 'PupilCore') {
    return buildPupilCommand({ appDir: __dirname, resourcesPath: process.resourcesPath,
      packaged: app.isPackaged, platform: process.platform, env: process.env,
      ffmpeg: findFfmpegBinary(), rendererUrl: deps.getMainWindow()?.webContents.getURL() || process.env.VITE_DEV_SERVER_URL || '' })
  }
  const imagePort = process.env.MRT_WS_IMAGE_PORT || '9001'
  const eyePort = process.env.MRT_WS_EYE_PORT || '9002'
  const cmdPort = process.env.MRT_WS_CMD_PORT || '9003'
  const args = ['--image_port', imagePort, '--eye_port', eyePort, '--cmd_port', cmdPort]
  const env = { ...process.env }
  try {
    const softdogIniPath = getSoftdogIniPath()
    if (softdogIniPath) {
      env.MRT_SOFTDOG_INI_PATH = env.MRT_SOFTDOG_INI_PATH || softdogIniPath
    }
  } catch {
  }
  // Force UTF-8 stdio on Windows to avoid Chinese text/path logs garbling.
  env.PYTHONUTF8 = env.PYTHONUTF8 || '1'
  env.PYTHONIOENCODING = env.PYTHONIOENCODING || 'utf-8'
  // Electron owns the retry lifecycle. Avoid multiplying it by the Python
  // server's internal retry loop, which previously emitted repeated notices.
  env.MRT_SERVER_BIND_RETRY_MAX = '1'
  env.MRT_DEBUG_TESTING = ENABLE_DEBUG_TESTING ? '1' : '0'
  // Ensure Python recorder can always find ffmpeg for H264 repair/post-process.
  const ffmpegBin = findFfmpegBinary()
  if (ffmpegBin) {
    env.MRT_FFMPEG_PATH = env.MRT_FFMPEG_PATH || ffmpegBin
    env.MRT_FFMPEG = env.MRT_FFMPEG || ffmpegBin
    env.FFMPEG_PATH = env.FFMPEG_PATH || ffmpegBin
    try {
      const ffmpegDir = path.dirname(ffmpegBin)
      const currentPath = env.PATH || env.Path || ''
      const nextPath = currentPath ? `${ffmpegDir}${path.delimiter}${currentPath}` : ffmpegDir
      env.PATH = nextPath
      env.Path = nextPath
    } catch {
    }
    console.log('[py-server] ffmpeg injected for python', ffmpegBin)
  } else {
    console.warn('[py-server] ffmpeg not found during command bootstrap')
  }

  const preferredModel = String(process.env.MRT_SDK_MODEL || DEFAULT_SDK_MODEL).trim() || DEFAULT_SDK_MODEL
  const resolvedSdk = resolveSdkPaths(preferredModel)
  env.MRT_SDK_CONTAINER = getSdkContainerPath()
  env.MRT_SDK_MODEL = resolvedSdk.model
  env.MRT_SDK_ROOT = resolvedSdk.sdkRoot
  env.MRT_TYPES_DIR = resolvedSdk.typesDir
  try {
    const currentPath = env.PATH || env.Path || ''
    const pathParts = currentPath.split(path.delimiter).filter(Boolean)
    if (!pathParts.includes(resolvedSdk.sdkRoot)) {
      const nextPath = currentPath ? `${resolvedSdk.sdkRoot}${path.delimiter}${currentPath}` : resolvedSdk.sdkRoot
      env.PATH = nextPath
      env.Path = nextPath
    }
  } catch {
  }
  try {
    console.log('[py-server] resolved sdk paths', { ...resolvedSdk, sdkContainer: env.MRT_SDK_CONTAINER })
    if (resolvedSdk.source === 'fallback') {
      console.warn('[py-server] sdk path fallback is being used; please verify model folder layout under SDK/invensun_7/')
    }
  } catch {
  }

  if (app.isPackaged) {
    const exePath = path.join(process.resourcesPath, 'py', 'mrt-ws-server.exe')
    if (!fs.existsSync(exePath)) {
      console.warn('[py-server] not found:', exePath)
      return null
    }
    console.log('[py-server] launch mode: packaged-exe')
    return {
      command: exePath,
      args,
      cwd: path.dirname(exePath),
      env,
    }
  }

  const serviceRoot = path.resolve(__dirname, '../services/eye_tracking')
  const scriptPath = path.join(serviceRoot, 'entrypoints', 'server.py')
  if (!fs.existsSync(scriptPath)) {
    console.warn('[py-server] script not found:', scriptPath)
    return null
  }

  const override = process.env.MRT_PYTHON_BIN
  if (override && override.trim().length > 0) {
    console.log('[py-server] launch mode: dev-script', { command: override.trim(), scriptPath })
    return {
      command: override.trim(),
      args: [scriptPath, ...args],
      cwd: serviceRoot,
      env,
    }
  }

  const localPythonCandidates = process.platform === 'win32'
    ? [
        path.join(serviceRoot, 'venv', 'Scripts', 'python.exe'),
        path.join(serviceRoot, '.venv', 'Scripts', 'python.exe'),
      ]
    : [
        path.join(serviceRoot, 'venv', 'bin', 'python3'),
        path.join(serviceRoot, 'venv', 'bin', 'python'),
        path.join(serviceRoot, '.venv', 'bin', 'python3'),
        path.join(serviceRoot, '.venv', 'bin', 'python'),
      ]
  const localPython = localPythonCandidates.find((candidate) => fs.existsSync(candidate))
  if (localPython) {
    console.log('[py-server] launch mode: dev-venv', { command: localPython, scriptPath })
    return {
      command: localPython,
      args: [scriptPath, ...args],
      cwd: serviceRoot,
      env,
    }
  }

  if (process.platform === 'win32') {
    console.log('[py-server] launch mode: dev-script', { command: 'py -3', scriptPath })
    return {
      command: 'py',
      args: ['-3', scriptPath, ...args],
      cwd: serviceRoot,
      env,
    }
  }

  console.log('[py-server] launch mode: dev-script', { command: 'python3', scriptPath })
  return {
    command: 'python3',
    args: [scriptPath, ...args],
    cwd: serviceRoot,
    env,
  }
}

function stopPyServer(): void {
  // Cancel any pending port-bind retry so a stopped server cannot respawn
  // (e.g. during app shutdown or an explicit stop/restart cycle).
  if (pyServerPortRetryTimer) {
    clearTimeout(pyServerPortRetryTimer)
    pyServerPortRetryTimer = null
  }
  if (pyServerCrashRestartTimer) {
    clearTimeout(pyServerCrashRestartTimer)
    pyServerCrashRestartTimer = null
  }
  if (!pyServerProcess) return
  const proc = pyServerProcess
  if (proc.exitCode !== null || proc.signalCode !== null) {
    if (pyServerProcess === proc) {
      pyServerProcess = null
    }
    pyServerStopRequested = false
    return
  }
  if (pyServerStopRequested) {
    console.log('[py-server] Stop already requested, waiting for exit...')
    return
  }
  pyServerStopRequested = true
  stopRequestedProcesses.add(proc)

  let forceKillTimer: NodeJS.Timeout | null = null
  const clearForceKillTimer = () => {
    if (!forceKillTimer) return
    clearTimeout(forceKillTimer)
    forceKillTimer = null
  }
  const finalizeStopState = () => {
    clearForceKillTimer()
    if (pyServerProcess === proc) {
      pyServerProcess = null
    }
    pyServerStopRequested = false
  }
  // If process has already exited gracefully, do not run fallback force-kill.
  proc.once('exit', finalizeStopState)
  proc.once('close', finalizeStopState)

  console.log('[py-server] Stopping Python server, PID:', proc.pid)

  if ((runningModel === 'PupilCore' || isHuahongModel(runningModel))) {
    // Windows process.kill(SIGTERM) is not a Python graceful signal. Use the
    // private parent-child pipe so the recorder can finish before termination.
    proc.stdin.write('shutdown\n', (error) => {
      if (error) console.warn('[py-server] Pupil shutdown pipe failed:', error.message)
    })
    forceKillTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
    }, 30000)
    return
  }

  try {
    if (process.platform === 'win32' && proc.pid) {
      // On Windows, send SIGTERM first to allow graceful shutdown
      try {
        console.log('[py-server] Sending SIGTERM to allow graceful shutdown...')
        proc.kill('SIGTERM')
        
        // Wait a bit for graceful shutdown
        forceKillTimer = setTimeout(() => {
          if (proc.exitCode !== null || proc.signalCode !== null) {
            return
          }
          if (proc.pid && isProcessAlive(proc.pid)) {
            console.log('[py-server] Graceful shutdown timeout, forcing termination...')
            try {
              const result = killWindowsProcessByPid(proc.pid)
              if (result.ok) {
                console.log('[py-server] Process forcefully terminated')
              } else if (result.status !== 128) {
                console.warn('[py-server] Force kill returned non-zero status:', result.status)
              }
            } catch (error: unknown) {
              console.error('[py-server] Force kill failed:', getErrorDetails(error).message || 'unknown')
            }
          }
        }, PY_SERVER_FORCE_KILL_TIMEOUT_MS)
      } catch (error: unknown) {
        console.error('[py-server] SIGTERM failed:', getErrorDetails(error).message || 'unknown')
        // Fallback to force kill
        try {
          if (proc.pid && isProcessAlive(proc.pid)) {
            const result = killWindowsProcessByPid(proc.pid)
            if (result.ok) {
              console.log('[py-server] Process forcefully terminated')
            } else if (result.status !== 128) {
              console.warn('[py-server] Force kill returned non-zero status:', result.status)
            }
          }
        } catch (fallbackError: unknown) {
          console.error('[py-server] Force kill failed:', getErrorDetails(fallbackError).message || 'unknown')
        }
        finalizeStopState()
      }
    } else {
      // On Unix-like systems, send SIGTERM for graceful shutdown
      console.log('[py-server] Sending SIGTERM...')
      proc.kill('SIGTERM')
      
      // Fallback to SIGKILL after timeout
      forceKillTimer = setTimeout(() => {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          return
        }
        if (proc.pid && isProcessAlive(proc.pid)) {
          console.log('[py-server] SIGTERM timeout, sending SIGKILL...')
          try {
            proc.kill('SIGKILL')
          } catch (e) {
            console.error('[py-server] SIGKILL failed:', e)
          }
        }
      }, PY_SERVER_FORCE_KILL_TIMEOUT_MS)
    }
  } catch (e) {
    console.error('[py-server] stop error:', e)
    finalizeStopState()
  }
}

function execFileText(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout, windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

async function listPythonProcessesWithCommandLine(): Promise<Array<{ pid: string; commandLine: string }>> {
  // Prefer wmic for speed; Windows 11 24H2+ removed it, so fall back to PowerShell CIM.
  try {
    const wmicOutput = await execFileText('wmic', ['process', 'where', "name='python.exe'", 'get', 'commandline,processid', '/format:csv'], 5000)
    const entries: Array<{ pid: string; commandLine: string }> = []
    for (const line of wmicOutput.split('\n')) {
      const match = line.match(/,(\d+)\s*$/)
      if (match && line.trim().length > match[0].length) {
        entries.push({ pid: match[1], commandLine: line })
      }
    }
    if (entries.length > 0) return entries
  } catch {
    // wmic unavailable — fall through to PowerShell
  }
  try {
    const psScript = "Get-CimInstance Win32_Process -Filter 'name=''python.exe''' | ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.CommandLine }"
    const psOutput = await execFileText('powershell', ['-NoProfile', '-Command', psScript], 10000)
    const entries: Array<{ pid: string; commandLine: string }> = []
    for (const line of psOutput.split('\n')) {
      const match = line.match(/^\s*(\d+)\|(.*)$/)
      if (match) {
        entries.push({ pid: match[1], commandLine: match[2] })
      }
    }
    return entries
  } catch {
    return []
  }
}

async function cleanupOrphanedProcesses(): Promise<void> {
  if (process.platform !== 'win32') {
    console.log('[cleanup] Not Windows, skipping orphaned process cleanup');
    return;
  }

  console.log('[cleanup] Checking for orphaned processes...');

  try {
    // Kill mrt-ws-server.exe processes
    try {
      const output = await execFileText('tasklist', ['/FI', 'IMAGENAME eq mrt-ws-server.exe', '/FO', 'CSV', '/NH'], 3000)

      if (output.includes('mrt-ws-server.exe')) {
        console.log('[cleanup] Found orphaned mrt-ws-server.exe, killing...');
        const result = await killWindowsProcessByImageAsync('mrt-ws-server.exe')
        if (result.ok) {
          console.log('[cleanup] Killed orphaned mrt-ws-server.exe');
        } else if (result.status !== 128) {
          console.log(`[cleanup] taskkill returned status ${result.status} when killing mrt-ws-server.exe`);
        }
      } else {
        console.log('[cleanup] No orphaned mrt-ws-server.exe found');
      }
    } catch (e) {
      console.log('[cleanup] No mrt-ws-server.exe to clean');
    }

    // Kill python.exe processes running ws_server
    try {
      const pythonOutput = await execFileText('tasklist', ['/FI', 'IMAGENAME eq python.exe', '/FO', 'CSV', '/NH'], 3000)

      if (pythonOutput.includes('python.exe')) {
        const pythonProcesses = await listPythonProcessesWithCommandLine()
        let killedCount = 0

        for (const proc of pythonProcesses) {
          if (proc.commandLine.includes('eye_tracking') || proc.commandLine.includes('mrt-ws-server') || proc.commandLine.includes('ws_server')) {
            try {
              const result = await killWindowsProcessByPidAsync(proc.pid)
              if (result.ok) {
                console.log(`[cleanup] Killed orphaned Python server PID: ${proc.pid}`)
                killedCount++
              } else if (result.status !== 128) {
                console.log(`[cleanup] Failed to kill PID ${proc.pid}, status=${result.status}`)
              }
            } catch {
              console.log(`[cleanup] Failed to kill PID ${proc.pid}`)
            }
          }
        }

        if (killedCount > 0) {
          console.log(`[cleanup] Cleaned up ${killedCount} orphaned Python process(es)`);
        } else {
          console.log('[cleanup] No orphaned Python processes found');
        }
      } else {
        console.log('[cleanup] No Python processes found');
      }
    } catch (e) {
      console.log('[cleanup] No Python processes to check');
    }

    console.log('[cleanup] Orphaned process cleanup completed');
  } catch (error) {
    console.error('[cleanup] Cleanup error:', error);
  }
}

async function runTaskkill(args: string[]): Promise<{ ok: boolean; status: number | null }> {
  try {
    await execFileText('taskkill', args, 5000)
    return { ok: true, status: 0 }
  } catch (error) {
    const status = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number'
      ? error.code
      : null
    return { ok: false, status }
  }
}

function killWindowsProcessByPidAsync(pid: number | string): Promise<{ ok: boolean; status: number | null }> {
  const pidValue = String(pid || '').trim()
  return pidValue ? runTaskkill(['/PID', pidValue, '/F', '/T']) : Promise.resolve({ ok: false, status: null })
}

function killWindowsProcessByImageAsync(imageName: string): Promise<{ ok: boolean; status: number | null }> {
  const imageValue = String(imageName || '').trim()
  return imageValue ? runTaskkill(['/IM', imageValue, '/F', '/T']) : Promise.resolve({ ok: false, status: null })
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killWindowsProcessByPid(pid: number | string): { ok: boolean; status: number | null } {
  const pidValue = String(pid || '').trim()
  if (!pidValue) return { ok: false, status: null }
  const result = spawnSync('taskkill', ['/PID', pidValue, '/F', '/T'], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: 3000,
  })
  return { ok: result.status === 0, status: result.status ?? null }
}

function isPyServerPortBindError(message: string): boolean {
  const msg = String(message || '').toLowerCase()
  return (
    msg.includes('10048') ||
    msg.includes('eaddrinuse') ||
    msg.includes('address already in use') ||
    msg.includes('only one usage of each socket address')
  )
}

function showPyServerPortOccupiedNotice(): void {
  const win = deps.getMainWindow()
  if (pyServerPortOccupiedNoticeShown) return
  if (!win || win.isDestroyed()) return
  pyServerPortOccupiedNoticeShown = true
  const imagePort = process.env.MRT_WS_IMAGE_PORT || '9001'
  const eyePort = process.env.MRT_WS_EYE_PORT || '9002'
  const cmdPort = process.env.MRT_WS_CMD_PORT || '9003'
  try {
    win.webContents.send('app-notice', {
      title: '端口被占用',
      message:
        `无法启动眼动服务器。\n端口 ${imagePort}/${eyePort}/${cmdPort} 被占用。\n\n软件已自动重试，但端口仍被其他进程占用。请关闭其他眼动服务后重新启动软件。`,
      variant: 'danger',
    })
  } catch (error) {
    console.error('[py-server] failed to send app-notice:', error)
  }
}

function startPyServer(portRetryAttempt = 0): void {
  if (pyServerProcess) {
    console.log('[py-server] Server already running')
    return
  }
  
  let cmd: ReturnType<typeof getPyServerCommand>
  try { cmd = getPyServerCommand() } catch (error) {
    const details = getErrorDetails(error)
    logVideoDebugEvent({ source: 'main', event: 'eye-server:process-error', details: {
      model: process.env.MRT_SDK_MODEL || DEFAULT_SDK_MODEL, pid: null, stage: 'command',
      errorCode: details.code, errorName: details.name, message: details.message,
    } })
    deps.getMainWindow()?.webContents.send('app-notice', { title: '眼动服务启动失败',
      message: error instanceof Error ? error.message : String(error), variant: 'danger' })
    return
  }
  if (!cmd) {
    console.log('[py-server] No command available')
    return
  }
  const childModel = cmd.env.MRT_SDK_MODEL || DEFAULT_SDK_MODEL
  
  try {
    const child = spawn(cmd.command, cmd.args, {
      cwd: cmd.cwd,
      env: cmd.env,
      windowsHide: true,
      stdio: 'pipe',
    })
    pyServerProcess = child
    runningModel = childModel
    runningPupilRoot = cmd.env.MRT_HUAHONG_PROJECT_ROOT || cmd.env.MRT_PUPIL_PROJECT_ROOT || ''
    pyServerStopRequested = false
    console.log('[py-server] Started successfully, PID:', child.pid)

    let shouldRetryPortBind = false
    let serverStarted = false
    child.once('spawn', () => {
      logVideoDebugEvent({ source: 'main', event: 'eye-server:process-start', details: {
        model: childModel, pid: child.pid ?? null, packaged: app.isPackaged,
      } })
    })
    const onLine = (tag: string, text: string) => {
      const msg = String(text || '').trim()
      if (!msg) return
      console.log(`[py-server:${tag}]`, msg)
      logVideoDebugEvent({
        source: 'main',
        event: `eye-server:${tag}-line`,
        details: { model: childModel, pid: child.pid ?? null, text: msg },
      })

      if (msg.includes('WebSocket servers started on ports') || msg.includes('PupilCore service listening') || msg.includes('Huahong service listening')) {
        serverStarted = true
        pyServerPortOccupiedNoticeShown = false
        // A successful bind means the service is healthy again; reset the crash
        // restart budget so a later one-off crash still gets the full retries.
        pyServerCrashRestartCount = 0
      }
      
      if (isPyServerPortBindError(msg)) {
        shouldRetryPortBind = true
        console.warn('[py-server] port bind failed', {
          attempt: portRetryAttempt + 1,
          maxAttempts: PY_SERVER_PORT_RETRY_MAX + 1,
          message: msg,
        })
      }
    }

    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout })
      rl.on('line', (line) => onLine('stdout', line))
    }

    if (child.stderr) {
      const rl = readline.createInterface({ input: child.stderr })
      rl.on('line', (line) => onLine('stderr', line))
    }

    child.on('error', (err) => {
      console.error('[py-server] Process error:', err)
      const details = getErrorDetails(err)
      logVideoDebugEvent({ source: 'main', event: 'eye-server:process-error', details: {
        model: childModel, pid: child.pid ?? null, stage: 'process',
        errorCode: details.code, errorName: details.name, message: details.message,
        stopRequested: stopRequestedProcesses.has(child),
      } })
      if (pyServerProcess === child) {
        pyServerProcess = null
      }
      pyServerStopRequested = false
    })
    
    child.on('exit', (code, signal) => {
      console.log('[py-server] Process exited, code:', code, 'signal:', signal)
      logVideoDebugEvent({ source: 'main', event: 'eye-server:process-exit', details: {
        model: childModel, pid: child.pid ?? null, code, signal,
        stopRequested: stopRequestedProcesses.has(child), shuttingDown: pyServerShuttingDownForQuit,
        serverStarted, portBindError: shouldRetryPortBind,
      } })
      const stopWasRequested = pyServerStopRequested
      if (pyServerProcess === child) {
        pyServerProcess = null
      }
      pyServerStopRequested = false
      if (!stopWasRequested && shouldRetryPortBind && portRetryAttempt < PY_SERVER_PORT_RETRY_MAX) {
        const nextAttempt = portRetryAttempt + 1
        const delay = PY_SERVER_PORT_RETRY_DELAY_MS * nextAttempt
        console.warn('[py-server] retrying after port bind failure', {
          nextAttempt: nextAttempt + 1,
          delayMs: delay,
        })
        if (pyServerPortRetryTimer) {
          clearTimeout(pyServerPortRetryTimer)
        }
        pyServerPortRetryTimer = setTimeout(() => {
          pyServerPortRetryTimer = null
          if (pyServerShuttingDownForQuit) return
          if (pyServerStopRequested) return
          if (pyServerProcess) return
          startPyServer(nextAttempt)
        }, delay)
        return
      }
      if (!stopWasRequested && !serverStarted && shouldRetryPortBind && portRetryAttempt >= PY_SERVER_PORT_RETRY_MAX) {
        showPyServerPortOccupiedNotice()
      }

      // Crash / unexpected exit that is NOT an explicit stop and NOT a port-bind
      // issue: auto-restart with backoff so a transient SDK/USB crash (e.g. the
      // vendor DLL segfaulting on a stuck dongle) doesn't leave the service down
      // until the user restarts the app. Bounded by PY_SERVER_CRASH_RESTART_MAX.
      if (!stopWasRequested && !shouldRetryPortBind && !pyServerShuttingDownForQuit) {
        if (pyServerCrashRestartCount < PY_SERVER_CRASH_RESTART_MAX) {
          pyServerCrashRestartCount += 1
          const delay = PY_SERVER_CRASH_RESTART_BASE_DELAY_MS * pyServerCrashRestartCount
          console.warn('[py-server] scheduling crash auto-restart', {
            attempt: pyServerCrashRestartCount,
            maxAttempts: PY_SERVER_CRASH_RESTART_MAX,
            delayMs: delay,
            code,
            signal,
          })
          if (pyServerCrashRestartTimer) {
            clearTimeout(pyServerCrashRestartTimer)
          }
          pyServerCrashRestartTimer = setTimeout(() => {
            pyServerCrashRestartTimer = null
            if (pyServerShuttingDownForQuit) return
            if (pyServerStopRequested) return
            if (pyServerProcess) return
            startPyServer()
          }, delay)
        } else {
          console.error('[py-server] crash auto-restart limit reached; service stays down until manual restart')
        }
      }

      // If exited with error code and it's a port issue, show dialog
      if (code !== 0 && code !== null) {
        console.error('[py-server] Server exited with error code:', code)
      }
    })
  } catch (e) {
    console.error('[py-server] Failed to start:', e)
    const details = getErrorDetails(e)
    logVideoDebugEvent({ source: 'main', event: 'eye-server:process-error', details: {
      model: childModel, pid: null, stage: 'spawn',
      errorCode: details.code, errorName: details.name, message: details.message,
    } })
    pyServerProcess = null
    pyServerStopRequested = false
  }
}

function restartPyServerAfterStop(reason: string, delayMs = PY_SERVER_RESTART_DELAY_MS): void {
  if (!pyServerProcess) return

  const proc = pyServerProcess
  let restartScheduled = false
  const restartOnce = () => {
    if (restartScheduled) return
    restartScheduled = true
    if (pyServerPortRetryTimer) {
      clearTimeout(pyServerPortRetryTimer)
    }
    pyServerPortRetryTimer = setTimeout(() => {
      pyServerPortRetryTimer = null
      if (pyServerShuttingDownForQuit) return
      if (pyServerProcess) return
      console.log('[py-server] restarting after stop', { reason, delayMs })
      startPyServer()
    }, Math.max(0, delayMs))
  }

  proc.once('close', restartOnce)
  stopPyServer()
}

function restartPyServerForSdkModelChange(previousModel: string, nextModel: string): void {
  const prev = runningModel || String(previousModel || '').trim()
  const next = String(nextModel || '').trim()
  if (!next || (prev === next && ((next !== 'PupilCore' && !isHuahongModel(next)) || runningPupilRoot === (process.env.MRT_HUAHONG_PROJECT_ROOT || process.env.MRT_PUPIL_PROJECT_ROOT || '')))) return
  restartPyServerAfterStop(`sdk model change ${prev} -> ${next}`, PY_SERVER_RESTART_DELAY_MS)
}

  return {
    ensureSoftdogKeyConfigured,
    getPyServerCommand,
    stopPyServer,
    cleanupOrphanedProcesses,
    startPyServer,
    restartPyServerAfterStop,
    restartPyServerForSdkModelChange,
    isProcessAlive,
    get waitExitTimeoutMs() { return (runningModel === 'PupilCore' || isHuahongModel(runningModel)) ? 32000 : PY_SERVER_WAIT_EXIT_TIMEOUT_MS },
    isRunning: () => pyServerProcess !== null,
    getProcess: () => pyServerProcess,
  }
}
