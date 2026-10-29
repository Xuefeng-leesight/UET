import { BrowserWindow, ipcMain, screen } from 'electron'
import { ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import path from 'node:path'
import { validateUtf8Path } from '../filesystem/pathValidation'

type StimulusRecord = Record<string, unknown>

function asRecord(value: unknown): StimulusRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as StimulusRecord : {}
}

type StimulusScreenRecordingDependencies = {
  buildLocalResourceUrl: (filePath: string) => Promise<string>
  findFfmpegBinary: () => string | null
  getMainWindow: () => BrowserWindow | null
  hydrateStimuliFromDisk: (items: unknown[], stimuliDir: string) => Promise<StimulusRecord[]>
  normalizeStimulusToggle: (value: unknown) => boolean
  runCommandCapture: (command: string, args: string[], timeoutMs?: number) => Promise<string>
  safeTimestampForPath: () => string
  sanitizePathSegment: (raw: unknown, fallback: string) => string
  uniqueFilePath: (basePath: string) => Promise<string>
  writeStimuliJson: (listPath: string, items: unknown[]) => Promise<void>
}

export function registerStimulusScreenRecordingHandlers(dependencies: StimulusScreenRecordingDependencies): { stopAllStimulusScreenRecordings: () => void } {
  const {
    buildLocalResourceUrl,
    findFfmpegBinary,
    getMainWindow,
    hydrateStimuliFromDisk,
    normalizeStimulusToggle,
    runCommandCapture,
    safeTimestampForPath,
    sanitizePathSegment,
    uniqueFilePath,
    writeStimuliJson,
  } = dependencies

  type StimulusScreenRecordingSession = {
    sessionId: string
    projectDir: string
    stimuliDir: string
    listPath: string
    id: string
    name: string
    group: string
    destPath: string
    startedAt: string
    child: ChildProcess
    stderr: string
    closed: boolean
    closeCode: number | null
    closePromise: Promise<number | null>
  }
  
  const activeStimulusScreenRecordings = new Map<string, StimulusScreenRecordingSession>()
  
  async function resolveMacAvfoundationScreenInput(ffmpegBin: string): Promise<string> {
    const output = await runCommandCapture(ffmpegBin, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], 5000)
    const lines = output.split(/\r?\n/)
    for (const line of lines) {
      const match = line.match(/\[(\d+)\]\s+Capture screen\s+0/i) || line.match(/\[(\d+)\]\s+Screen\s+0/i)
      if (match?.[1]) {
        return `${match[1]}:none`
      }
    }
    for (const line of lines) {
      const match = line.match(/\[(\d+)\].*(screen|display)/i)
      if (match?.[1]) {
        return `${match[1]}:none`
      }
    }
    return '1:none'
  }
  
  async function buildStimulusScreenRecordingArgs(ffmpegBin: string, destPath: string): Promise<string[]> {
    const commonOutput = [
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      destPath,
    ]
  
    if (process.platform === 'darwin') {
      const input = await resolveMacAvfoundationScreenInput(ffmpegBin)
      return [
        '-y',
        '-f',
        'avfoundation',
        '-capture_cursor',
        '1',
        '-framerate',
        '30',
        '-i',
        input,
        ...commonOutput,
      ]
    }
  
    if (process.platform === 'win32') {
      return [
        '-y',
        '-f',
        'gdigrab',
        '-framerate',
        '30',
        '-draw_mouse',
        '1',
        '-i',
        'desktop',
        ...commonOutput,
      ]
    }
  
    const primary = screen.getPrimaryDisplay()
    const width = Math.max(1, Math.round(primary?.bounds?.width || 1920))
    const height = Math.max(1, Math.round(primary?.bounds?.height || 1080))
    const display = String(process.env.DISPLAY || ':0.0')
    return [
      '-y',
      '-f',
      'x11grab',
      '-video_size',
      `${width}x${height}`,
      '-framerate',
      '30',
      '-i',
      display,
      ...commonOutput,
    ]
  }
  
  async function waitForStimulusScreenRecordingClose(sessionInfo: StimulusScreenRecordingSession, timeoutMs = 45000): Promise<number | null> {
    if (sessionInfo.closed) return sessionInfo.closeCode
    let timer: NodeJS.Timeout | null = null
    try {
      return await Promise.race([
        sessionInfo.closePromise,
        new Promise<number | null>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('等待录屏收尾超时')), timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  
  function requestStopStimulusScreenRecording(sessionInfo: StimulusScreenRecordingSession): void {
    if (sessionInfo.closed || sessionInfo.child.killed) return
    try {
      sessionInfo.child.stdin?.write('q')
      sessionInfo.child.stdin?.end()
    } catch {
    }
  
    setTimeout(() => {
      if (sessionInfo.closed || sessionInfo.child.killed) return
      try {
        sessionInfo.child.kill('SIGINT')
      } catch {
      }
    }, 2500).unref?.()
  
    setTimeout(() => {
      if (sessionInfo.closed || sessionInfo.child.killed) return
      try {
        sessionInfo.child.kill('SIGTERM')
      } catch {
      }
    }, 15000).unref?.()
  
    setTimeout(() => {
      if (sessionInfo.closed || sessionInfo.child.killed) return
      try {
        sessionInfo.child.kill('SIGKILL')
      } catch {
      }
    }, 35000).unref?.()
  }
  
  async function appendScreenRecordingStimulus(sessionInfo: StimulusScreenRecordingSession): Promise<StimulusRecord[]> {
    let existing: StimulusRecord[] = []
    try {
      const raw = await fs.promises.readFile(sessionInfo.listPath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) existing = parsed
    } catch {
    }
    existing = await hydrateStimuliFromDisk(existing, sessionInfo.stimuliDir)
  
    let maxOrder = 0
    for (const item of existing) {
      const o = typeof item?.order === 'number' && Number.isFinite(item.order) ? item.order : 0
      if (o > maxOrder) maxOrder = o
    }
  
    const stat = await fs.promises.stat(sessionInfo.destPath)
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error('录屏输出为空文件')
    }
    const kb = stat.size / 1024
    const sizeLabel = kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`
    const fileUrl = await buildLocalResourceUrl(sessionInfo.destPath)
  
    existing.push({
      id: sessionInfo.id,
      name: sessionInfo.name,
      url: fileUrl,
      fileName: path.basename(sessionInfo.destPath),
      size: sizeLabel,
      date: new Date().toISOString().slice(0, 10),
      sourcePath: sessionInfo.destPath,
      order: maxOrder + 1,
      active: true,
      stimulusType: 'video',
      screenRecording: true,
      group: sessionInfo.group || '',
      randomPlay: false,
      endOnClick: false,
      endOnKey: false,
      playToEnd: true,
      recordedAt: sessionInfo.startedAt,
    })
  
    existing.sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0))
    existing = existing.map((s, idx) => ({
      ...s,
      order: idx + 1,
      active: s && typeof s.active === 'boolean' ? s.active : true,
      randomPlay: normalizeStimulusToggle(s?.randomPlay),
      endOnClick: normalizeStimulusToggle(s?.endOnClick),
      endOnKey: normalizeStimulusToggle(s?.endOnKey),
    }))
    await writeStimuliJson(sessionInfo.listPath, existing)
    return existing
  }
  
  async function buildScreenRecordingComboAsset(sessionInfo: StimulusScreenRecordingSession): Promise<StimulusRecord> {
    const stat = await fs.promises.stat(sessionInfo.destPath)
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error('录屏输出为空文件')
    }
    const kb = stat.size / 1024
    const sizeLabel = kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`
    const fileUrl = await buildLocalResourceUrl(sessionInfo.destPath)
    return {
      id: sessionInfo.id,
      name: sessionInfo.name,
      type: 'video',
      url: fileUrl,
      fileName: path.basename(sessionInfo.destPath),
      size: sizeLabel,
    }
  }
  
  
  ipcMain.handle('start-stimulus-screen-recording', async (_event, input: unknown) => {
    const win = getMainWindow()
    const payload = asRecord(input)
    const projectDir = typeof payload?.projectDir === 'string' ? payload.projectDir.trim() : ''
    const rawName = typeof payload?.name === 'string' ? payload.name.trim() : ''
    const group = typeof payload?.group === 'string' ? payload.group.trim() : ''
    if (!projectDir) {
      return { ok: false, message: '缺少 projectDir' }
    }
  
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, message: `路径验证失败：${pathValidation.error}` }
    }
  
    const ffmpegBin = findFfmpegBinary()
    if (!ffmpegBin) {
      return { ok: false, message: '录屏组件不可用，无法录制屏幕' }
    }
  
    const stimuliDir = path.join(projectDir, 'stimuli')
    await fs.promises.mkdir(stimuliDir, { recursive: true })
    const listPath = path.join(stimuliDir, 'stimuli.json')
    const startedAt = new Date().toISOString()
    const id = `stim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const fallbackName = `录屏-${startedAt.replace(/[:.]/g, '-').slice(0, 19)}`
    const baseName = (rawName || fallbackName).replace(/[\\/:*?"<>|]+/g, '_').trim() || fallbackName
    const destPath = path.join(stimuliDir, `${id}.mp4`)
  
    let args: string[] = []
    try {
      args = await buildStimulusScreenRecordingArgs(ffmpegBin, destPath)
    } catch (error: unknown) {
      console.warn('[stimulus-screen-recording] build args failed', error)
      return { ok: false, message: '录屏启动失败，请检查屏幕录制权限' }
    }
  
    try {
      const child = spawn(ffmpegBin, args, {
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe'],
      })
      const sessionId = randomUUID()
      const sessionInfo: StimulusScreenRecordingSession = {
        sessionId,
        projectDir,
        stimuliDir,
        listPath,
        id,
        name: baseName,
        group,
        destPath,
        startedAt,
        child,
        stderr: '',
        closed: false,
        closeCode: null,
        closePromise: Promise.resolve(null),
      }
      sessionInfo.closePromise = new Promise<number | null>((resolve) => {
        child.once('close', (code) => {
          sessionInfo.closed = true
          sessionInfo.closeCode = code
          resolve(code)
        })
      })
      child.stderr?.on('data', (chunk) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk)
        sessionInfo.stderr = `${sessionInfo.stderr}${text}`.slice(-12000)
      })
      child.once('error', (error) => {
        sessionInfo.stderr = `${sessionInfo.stderr}\n${error.message}`.slice(-12000)
      })
      // Startup probe: consider recording started once ffmpeg produces output bytes,
      // failed if the process exits, or give up after a bounded wait (slow machines).
      const STARTUP_PROBE_TIMEOUT_MS = 4000
      const STARTUP_PROBE_INTERVAL_MS = 100
      let probeTimer: NodeJS.Timeout | null = null
      let probeFinished = false
      const probePromise = new Promise<void>((resolve) => {
        const finish = () => {
          if (probeFinished) return
          probeFinished = true
          if (probeTimer) clearInterval(probeTimer)
          probeTimer = null
          resolve()
        }
        const probeStartedAt = Date.now()
        probeTimer = setInterval(() => {
          void fs.promises.stat(destPath).then((stat) => {
            if (stat.isFile() && stat.size > 0) finish()
          }).catch(() => {})
          if (Date.now() - probeStartedAt >= STARTUP_PROBE_TIMEOUT_MS) finish()
        }, STARTUP_PROBE_INTERVAL_MS)
      })
      await Promise.race([sessionInfo.closePromise, probePromise])
      probeFinished = true
      if (probeTimer) clearInterval(probeTimer)
      probeTimer = null
      if (sessionInfo.closed) {
        await fs.promises.unlink(destPath).catch(() => {})
        console.warn('[stimulus-screen-recording] exited immediately', sessionInfo.stderr.trim().slice(-1200))
        return {
          ok: false,
          message: '录屏启动失败，请检查屏幕录制权限',
        }
      }
      activeStimulusScreenRecordings.set(sessionId, sessionInfo)
      if (win && !win.isDestroyed()) {
        win.minimize()
      }
      return { ok: true, sessionId }
    } catch (error: unknown) {
      await fs.promises.unlink(destPath).catch(() => {})
      console.warn('[stimulus-screen-recording] start failed', error)
      return { ok: false, message: '录屏启动失败，请稍后重试' }
    }
  })
  
  ipcMain.handle('stop-stimulus-screen-recording', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
    const sessionInfo = sessionId ? activeStimulusScreenRecordings.get(sessionId) : null
    if (!sessionInfo) {
      return { ok: false, stimuli: [], message: '未找到正在录制的屏幕任务' }
    }
  
    activeStimulusScreenRecordings.delete(sessionId)
    requestStopStimulusScreenRecording(sessionInfo)
    try {
      const code = await waitForStimulusScreenRecordingClose(sessionInfo)
      const stat = await fs.promises.stat(sessionInfo.destPath).catch(() => null)
      if (!stat || !stat.isFile() || stat.size <= 0) {
        console.warn('[stimulus-screen-recording] empty output', sessionInfo.stderr.trim().slice(-1200))
        throw new Error('未生成有效录屏视频')
      }
      if (code !== 0 && code !== 255) {
        console.warn('[stimulus-screen-recording] ffmpeg exited non-zero', {
          code,
          stderr: sessionInfo.stderr.slice(-1200),
        })
      }
      if (payload?.asComboAsset === true) {
        const asset = await buildScreenRecordingComboAsset(sessionInfo)
        return { ok: true, stimuli: [], asset }
      }
      const stimuli = await appendScreenRecordingStimulus(sessionInfo)
      return { ok: true, stimuli }
    } catch (error: unknown) {
      // Only remove the output when it is not a usable video; never delete a
      // successfully recorded file just because post-processing failed.
      const stat = await fs.promises.stat(sessionInfo.destPath).catch(() => null)
      const hasUsableVideo = Boolean(stat && stat.isFile() && stat.size > 0)
      if (!hasUsableVideo) {
        await fs.promises.unlink(sessionInfo.destPath).catch(() => {})
      }
      console.warn('[stimulus-screen-recording] stop/save failed', {
        error,
        keptVideo: hasUsableVideo,
        destPath: hasUsableVideo ? sessionInfo.destPath : undefined,
      })
      const baseMessage = error instanceof Error ? error.message : '录屏保存失败'
      return {
        ok: false,
        stimuli: [],
        message: hasUsableVideo ? `${baseMessage}（录屏视频已保留：${sessionInfo.destPath}）` : baseMessage,
      }
    }
  })

  // Kill every still-running ffmpeg screen-recording child so app shutdown does
  // not leak orphaned capture processes (notably on Windows).
  function stopAllStimulusScreenRecordings(): void {
    for (const session of activeStimulusScreenRecordings.values()) {
      try {
        requestStopStimulusScreenRecording(session)
      } catch (error) {
        console.error('[stimulus-screen-recording] stopAll failed for session', error)
      }
    }
    activeStimulusScreenRecordings.clear()
  }

  return { stopAllStimulusScreenRecordings }
}
