import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as net from 'node:net'
import path from 'node:path'
import * as readline from 'node:readline'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { logVideoDebugEvent } from '../../platform/logging/videoDebugLogger'

type UnknownRecord = Record<string, unknown>
type ServerCommand = { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }

// Reject record IDs that could escape the project's facial-analysis dir via
// path traversal ("../", absolute paths, separators). IDs are opaque slugs.
function isSafeRecordId(value: string): boolean {
  if (!value || value.length > 512) return false
  if (value.includes('/') || value.includes('\\')) return false
  if (value === '.' || value === '..') return false
  return true
}

// Extract the embedded `_yyyyMMdd_HHmmss` timestamp from a facial record id
// (e.g. "subject_20240817_142830" -> "20240817142830"). Returns '' when the
// id does not carry a timestamp, so callers can fall back to a stable order.
function extractFacialRecordTimestamp(value: string): string {
  const match = /_(\d{8})_(\d{6})$/.exec(value)
  return match ? `${match[1]}${match[2]}` : ''
}

type FacialDomainDependencies = {
  buildLocalResourceUrl: (filePath: string) => Promise<string>
  findFfmpegBinary: () => string | null
  getMainWindow: () => BrowserWindow | null
  getPyServerCommand: () => ServerCommand | null
  runCommand: (command: string, args: string[], cwd?: string) => Promise<void>
  scriptPath: string
  isModuleAllowed?: (code: string) => boolean
}

export type FacialDomain = {
  registerHandlers: () => void
  stop: () => void
}

const FACIAL_WS_PORTS = { image: 9011, data: 9012, cmd: 9013 } as const
const FACIAL_SERVICE_BUILD_ID = 'facial-analysis-2026-09-09-v2'
const FACIAL_RUNTIME_INFO_FILE = 'uet-sa-facial-runtime.json'

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' ? value as UnknownRecord : {}
}

function relayFacialServerStructuredLog(line: string): boolean {
  try {
    const payload = JSON.parse(line)
    if (!payload || typeof payload !== 'object' || typeof payload.event !== 'string') return false
    const event = String(payload.event || '').trim()
    if (!event) return false
    const details = { ...(payload as Record<string, unknown>) }
    delete details.event
    logVideoDebugEvent({
      source: 'main',
      event: `facial-server:${event}`,
      details,
    })
    return true
  } catch {
    return false
  }
}

function canBindLocalPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    // Must probe the same host the facial server binds (127.0.0.1). Probing
    // 0.0.0.0 here made readiness detection fail and time out on some OSes.
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolve(true))
    })
  })
}

function scanFacialRecords(projectDir: string): Array<{ id: string; name: string; subjectName?: string }> {
  const records: Array<{ id: string; name: string; subjectName?: string }> = []
  const facialDir = path.join(projectDir, 'facial-analysis')
  if (!fs.existsSync(facialDir)) return records
  try {
    const entries = fs.readdirSync(facialDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const recordDir = path.join(facialDir, entry.name)
      const manifestPath = path.join(recordDir, 'facial-video.json')
      const sourceDir = path.join(recordDir, 'source')
      const hasVideo = fs.existsSync(path.join(sourceDir, 'face.mp4'))
        || (fs.existsSync(sourceDir) && fs.readdirSync(sourceDir, { withFileTypes: true }).some((item) => item.isFile() && /\.(mp4|avi|mov|mkv|webm)$/i.test(item.name)))
      if (fs.existsSync(manifestPath) || hasVideo) {
        try {
          const manifest = fs.existsSync(manifestPath)
            ? asRecord(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')))
            : {}
          records.push({
            id: String(manifest.recordId || entry.name),
            name: String(manifest.recordName || entry.name),
            subjectName: typeof manifest.subjectName === 'string' ? manifest.subjectName : undefined,
          })
        } catch {
          records.push({ id: entry.name, name: entry.name })
        }
      }
    }
  } catch {
  }

  // Newest-first: the dropdown should surface the most recent capture on top.
  records.sort((left, right) => {
    const leftTs = extractFacialRecordTimestamp(left.id || left.name || '')
    const rightTs = extractFacialRecordTimestamp(right.id || right.name || '')
    if (leftTs && rightTs && leftTs !== rightTs) return leftTs > rightTs ? -1 : 1
    return 0
  })
  return records
}

export function createFacialDomain(dependencies: FacialDomainDependencies): FacialDomain {
  let serverProcess: ChildProcessWithoutNullStreams | null = null

  async function finalizeBrowserVideo(projectDir: string, recordId: string): Promise<{ ok: boolean; path?: string; message?: string }> {
    if (!projectDir || !recordId) return { ok: false, message: '缺少工程目录或记录ID' }
    if (!isSafeRecordId(recordId)) return { ok: false, message: '记录ID非法' }
    const ffmpeg = dependencies.findFfmpegBinary()
    if (!ffmpeg) return { ok: false, message: '未找到 FFmpeg，原始 WebM 已保留' }

    const sourceDir = path.join(projectDir, 'facial-analysis', recordId, 'source')
    const rawCandidates = [
      path.join(sourceDir, 'face.capture.webm'),
      path.join(sourceDir, 'face.webm'),
    ]
    const rawPath = rawCandidates.find((candidate) => fs.existsSync(candidate)) || ''
    if (!rawPath) return { ok: false, message: '未找到待收尾的 WebM 视频' }
    const rawStat = await fs.promises.stat(rawPath)
    if (!rawStat.isFile() || rawStat.size <= 0) return { ok: false, message: '原始 WebM 为空，无法生成视频' }

    const finalPath = path.join(sourceDir, 'face.mp4')
    const stagedPath = path.join(sourceDir, `face.transcoding-${randomUUID()}.mp4`)
    logVideoDebugEvent({
      source: 'main',
      event: 'facial-video-finalize-start',
      details: { recordId, rawPath, rawBytes: rawStat.size },
    })
    try {
      await dependencies.runCommand(ffmpeg, [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-fflags', '+genpts',
        '-i', rawPath,
        '-map', '0:v:0',
        '-an',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        stagedPath,
      ])
      const finalStat = await fs.promises.stat(stagedPath)
      if (!finalStat.isFile() || finalStat.size <= 0) throw new Error('FFmpeg 未生成有效视频')
      await fs.promises.rm(finalPath, { force: true })
      await fs.promises.rename(stagedPath, finalPath)
      // Only remove the raw capture after the indexed MP4 is safely in place.
      await fs.promises.unlink(rawPath).catch(() => {})
      logVideoDebugEvent({
        source: 'main',
        event: 'facial-video-finalize-complete',
        details: { recordId, finalPath, finalBytes: finalStat.size },
      })
      return { ok: true, path: finalPath }
    } catch (error) {
      await fs.promises.unlink(stagedPath).catch(() => {})
      const cause = error instanceof Error ? error.message : String(error)
      logVideoDebugEvent({
        source: 'main',
        event: 'facial-video-finalize-failed',
        details: { recordId, cause, rawPath },
      })
      return { ok: false, message: `视频收尾失败，原始 WebM 已保留：${cause}` }
    }
  }

  async function selectFacialServerPorts(): Promise<boolean> {
    const available = await Promise.all([
      canBindLocalPort(FACIAL_WS_PORTS.image),
      canBindLocalPort(FACIAL_WS_PORTS.data),
      canBindLocalPort(FACIAL_WS_PORTS.cmd),
    ])
    return available.every(Boolean)
  }

  function getFacialServerCommand(): ServerCommand | null {
    const eyeCmd = dependencies.getPyServerCommand()
    if (!eyeCmd) return null
    const facialEnv = {
      ...eyeCmd.env,
      MRT_FACIAL_PARENT_PID: String(process.pid),
      MRT_FACIAL_RUNTIME_INFO_PATH: path.join(app.getPath('temp'), FACIAL_RUNTIME_INFO_FILE),
      // Facial inference runs beside the glasses H.265 decoder in a separate
      // process. Bound native math/OpenCV worker pools so the two services do
      // not oversubscribe every CPU core and stall the Electron UI/mouse.
      OMP_NUM_THREADS: eyeCmd.env.OMP_NUM_THREADS || '1',
      OPENBLAS_NUM_THREADS: eyeCmd.env.OPENBLAS_NUM_THREADS || '1',
      MKL_NUM_THREADS: eyeCmd.env.MKL_NUM_THREADS || '1',
      NUMEXPR_NUM_THREADS: eyeCmd.env.NUMEXPR_NUM_THREADS || '1',
      MRT_FACIAL_OPENCV_THREADS: eyeCmd.env.MRT_FACIAL_OPENCV_THREADS || '1',
    }
    if (app.isPackaged) {
      const exePath = path.join(process.resourcesPath, 'py', 'facial-ws-server.exe')
      if (!fs.existsSync(exePath)) {
        console.warn('[facial-server] packaged executable not found:', exePath)
        return null
      }
      return {
        command: exePath,
        args: [String(FACIAL_WS_PORTS.image), String(FACIAL_WS_PORTS.data), String(FACIAL_WS_PORTS.cmd)],
        cwd: path.dirname(exePath),
        env: facialEnv,
      }
    }
    if (!fs.existsSync(dependencies.scriptPath)) {
      console.warn('[facial-server] script not found:', dependencies.scriptPath)
      return null
    }
    const eyeScriptIndex = eyeCmd.args.findIndex((arg, index) =>
      /eye_tracking\/(?:entrypoints\/)?server\.py$/i.test(arg.replace(/\\/g, '/'))
      || (arg === '-m' && /^services\.eye_tracking\.(?:entrypoints\.)?(?:pupil_server|huahong_server)$/.test(eyeCmd.args[index + 1])),
    )
    const pythonLauncherArgs = eyeScriptIndex > 0 ? eyeCmd.args.slice(0, eyeScriptIndex) : []
    return {
      command: eyeCmd.command,
      args: [
        ...pythonLauncherArgs,
        dependencies.scriptPath,
        String(FACIAL_WS_PORTS.image),
        String(FACIAL_WS_PORTS.data),
        String(FACIAL_WS_PORTS.cmd),
      ],
      cwd: path.dirname(dependencies.scriptPath),
      env: facialEnv,
    }
  }

  async function waitForReady(
    child: ChildProcessWithoutNullStreams,
    runtimeInfoPath: string,
    timeoutMs = 45000,
  ): Promise<{ ok: boolean; message?: string }> {
    const startedAt = Date.now()
    let commandPortReadyAt: number | null = null
    while (Date.now() - startedAt < timeoutMs) {
      if (child.exitCode !== null || child.signalCode !== null) {
        return { ok: false, message: `表情服务提前退出（代码 ${child.exitCode ?? '未知'}）` }
      }
      if (!(await canBindLocalPort(FACIAL_WS_PORTS.cmd))) {
        commandPortReadyAt ??= Date.now()
        try {
          const runtimeInfo = asRecord(JSON.parse(await fs.promises.readFile(runtimeInfoPath, 'utf-8')))
          const buildId = String(runtimeInfo.buildId || '')
          if (buildId === FACIAL_SERVICE_BUILD_ID) return { ok: true }
          if (buildId) {
            return {
              ok: false,
              message: '表情服务版本与当前应用不一致，请重新安装由本版本生成的完整安装包',
            }
          }
        } catch {
        }
        if (Date.now() - commandPortReadyAt >= 2500) {
          return {
            ok: false,
            message: '表情服务缺少版本标识，检测到旧版或残留程序，请重新安装完整安装包',
          }
        }
      } else {
        commandPortReadyAt = null
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 200))
    }
    return { ok: false, message: `表情服务启动超时（${Math.round(timeoutMs / 1000)} 秒）` }
  }

  function stop(): void {
    if (!serverProcess) return
    const proc = serverProcess
    if (proc.exitCode !== null || proc.signalCode !== null) {
      serverProcess = null
      return
    }
    try {
      proc.kill('SIGTERM')
      setTimeout(() => {
        try { if (proc.exitCode === null) proc.kill('SIGKILL') } catch {}
      }, 5000)
    } catch {
      try { proc.kill('SIGKILL') } catch {}
    }
    serverProcess = null
  }

  async function start(): Promise<{ ok: boolean; message?: string }> {
    if (serverProcess && serverProcess.exitCode === null && serverProcess.signalCode === null) {
      if (!(await canBindLocalPort(FACIAL_WS_PORTS.cmd))) {
        console.log('[facial-server] already running and ready')
        return { ok: true }
      }
      console.warn('[facial-server] tracked process is alive but command port is not ready')
      stop()
    }
    if (!(await selectFacialServerPorts())) {
      console.error('[facial-server] default ports are occupied; refusing to start a second camera owner')
      return { ok: false, message: '表情服务端口 9011–9013 已被占用，请关闭旧程序后重试' }
    }
    const cmd = getFacialServerCommand()
    if (!cmd) return { ok: false, message: '未找到表情服务程序或 Python 运行环境' }
    try {
      let stderrTail = ''
      const runtimeInfoPath = String(cmd.env.MRT_FACIAL_RUNTIME_INFO_PATH || '')
      if (runtimeInfoPath) await fs.promises.unlink(runtimeInfoPath).catch(() => {})
      const child = spawn(cmd.command, cmd.args, {
        cwd: cmd.cwd,
        env: cmd.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      if (child.stdout) {
        const stdoutReader = readline.createInterface({ input: child.stdout })
        stdoutReader.on('line', (line) => {
          const text = String(line || '').trim()
          if (!text) return
          const relayed = relayFacialServerStructuredLog(text)
          if (!relayed) {
            logVideoDebugEvent({
              source: 'main',
              event: 'facial-server:stdout-line',
              details: { text },
            })
          }
          console.log('[facial-server:stdout]', text)
        })
      }
      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString('utf8').trim()
        stderrTail = `${stderrTail}\n${text}`.trim().slice(-4000)
        logVideoDebugEvent({
          source: 'main',
          event: 'facial-server:stderr-chunk',
          details: { text },
        })
        console.log('[facial-server:stderr]', text)
      })
      child.once('close', (code, signal) => {
        console.log('[facial-server] exited, code:', code, 'signal:', signal)
        if (serverProcess === child) serverProcess = null
      })
      child.once('error', (error) => {
        console.error('[facial-server] spawn error:', error.message)
        if (serverProcess === child) serverProcess = null
      })
      serverProcess = child
      console.log('[facial-server] started, PID:', child.pid)
      const ready = await waitForReady(child, runtimeInfoPath)
      if (ready.ok) return ready
      // Never surface raw subprocess stderr (MediaPipe/TFLite native logs) to
      // the UI. Use the friendly readiness message; keep the tail for main-process logs only.
      const message = ready.message || '表情服务未能完成启动'
      console.error('[facial-server] readiness failed:', message, { stderrTail })
      stop()
      return { ok: false, message }
    } catch (error) {
      console.error('[facial-server] failed to start:', error)
      return { ok: false, message: error instanceof Error ? error.message : '表情服务进程创建失败' }
    }
  }

  function isRunning(): boolean {
    return serverProcess !== null
      && serverProcess.exitCode === null
      && serverProcess.signalCode === null
  }

  function registerHandlers(): void {
    ipcMain.handle('start-facial-server', async () => {
      if (dependencies.isModuleAllowed && !dependencies.isModuleAllowed('facial_analysis')) {
        return { ok: false, message: '当前 License 未授权表情模块。', ports: null }
      }
      const result = await start()
      return { ...result, ports: result.ok ? FACIAL_WS_PORTS : null }
    })

    ipcMain.handle('stop-facial-server', async () => {
      stop()
      return { ok: true }
    })

    ipcMain.handle('facial-server-status', async () => {
      const runtimeInfoPath = path.join(app.getPath('temp'), FACIAL_RUNTIME_INFO_FILE)
      let buildId: string | null = null
      try {
        buildId = String(asRecord(JSON.parse(await fs.promises.readFile(runtimeInfoPath, 'utf-8'))).buildId || '') || null
      } catch {
      }
      return { ok: true, running: isRunning(), ports: FACIAL_WS_PORTS, buildId }
    })

    ipcMain.handle('finalize-facial-browser-video', async (_event, payload: unknown) => {
      const input = asRecord(payload)
      const projectDir = typeof input.projectDir === 'string' ? path.resolve(input.projectDir) : ''
      const recordId = typeof input.recordId === 'string' ? input.recordId.trim() : ''
      return finalizeBrowserVideo(projectDir, recordId)
    })

    ipcMain.handle('list-facial-analysis-records', async (_event, payload: unknown) => {
      const input = asRecord(payload)
      const projectDir = typeof input.projectDir === 'string' ? path.resolve(input.projectDir) : ''
      if (!projectDir) return { ok: false, records: [], message: '缺少工程目录' }
      try {
        return { ok: true, records: scanFacialRecords(projectDir) }
      } catch (error) {
        return { ok: false, records: [], message: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('load-facial-analysis', async (_event, payload: unknown) => {
      const input = asRecord(payload)
      const projectDir = typeof input.projectDir === 'string' ? path.resolve(input.projectDir) : ''
      const recordId = typeof input.recordId === 'string' ? input.recordId.trim() : ''
      if (!projectDir || !recordId) {
        return { ok: false, manifest: {}, result: null, videoUrl: null, message: '缺少工程目录或记录ID' }
      }
      if (!isSafeRecordId(recordId)) {
        return { ok: false, manifest: {}, result: null, videoUrl: null, message: '记录ID非法' }
      }
      try {
        const facialDir = path.join(projectDir, 'facial-analysis', recordId)
        const manifestPath = path.join(facialDir, 'facial-video.json')
        const resultPath = path.join(facialDir, 'analysis', 'result.json')
        const legacyResultPath = path.join(facialDir, 'result.json')
        let manifest: unknown = {}
        if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
        let manifestRecord = asRecord(manifest)
        let manifestVideoPath = typeof manifestRecord.videoPath === 'string' ? manifestRecord.videoPath : ''
        const captureRecord = asRecord(manifestRecord.capture)
        const isLegacyRendererWebm = captureRecord.owner === 'renderer'
          && /\.webm$/i.test(manifestVideoPath)
          && !fs.existsSync(path.join(facialDir, 'source', 'face.mp4'))
        if (isLegacyRendererWebm) {
          const migrated = await finalizeBrowserVideo(projectDir, recordId)
          if (migrated.ok) {
            manifestRecord = {
              ...manifestRecord,
              videoPath: 'source/face.mp4',
              capture: {
                ...captureRecord,
                container: 'mp4',
                sourceCaptureFormat: 'webm',
                finalization: 'ffmpeg-h264-faststart',
              },
            }
            manifest = manifestRecord
            manifestVideoPath = 'source/face.mp4'
            await fs.promises.writeFile(manifestPath, JSON.stringify(manifestRecord, null, 2), 'utf-8')
          }
        }
        const candidateVideoPaths = [
          manifestVideoPath ? path.resolve(facialDir, manifestVideoPath) : '',
          path.join(facialDir, 'source', 'face.mp4'),
        ].filter(Boolean)
        let videoPath = candidateVideoPaths.find((candidate) => fs.existsSync(candidate)) || ''
        if (!videoPath) {
          const sourceDir = path.join(facialDir, 'source')
          if (fs.existsSync(sourceDir)) {
            const fallback = fs.readdirSync(sourceDir).find((name) => /\.(mp4|avi|mov|mkv|webm)$/i.test(name))
            if (fallback) videoPath = path.join(sourceDir, fallback)
          }
        }
        let result: unknown = null
        const effectiveResultPath = fs.existsSync(resultPath)
          ? resultPath
          : (fs.existsSync(legacyResultPath) ? legacyResultPath : null)
        if (effectiveResultPath) result = JSON.parse(fs.readFileSync(effectiveResultPath, 'utf-8'))
        const videoUrl = videoPath
          ? await dependencies.buildLocalResourceUrl(videoPath)
          : null
        return { ok: true, manifest, result, videoUrl }
      } catch (error) {
        return { ok: false, manifest: {}, result: null, videoUrl: null, message: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('import-facial-video', async (_event, payload: unknown) => {
      const input = asRecord(payload)
      const projectDir = typeof input.projectDir === 'string' ? path.resolve(input.projectDir) : ''
      const recordId = typeof input.recordId === 'string' ? input.recordId.trim() : ''
      const recordName = typeof input.recordName === 'string' ? input.recordName.trim() : ''
      const subjectName = typeof input.subjectName === 'string' ? input.subjectName.trim() : ''
      if (!projectDir || !recordId) return { ok: false, message: '缺少工程目录或记录ID' }
      if (!isSafeRecordId(recordId)) return { ok: false, message: '记录ID非法' }
      const mainWindow = dependencies.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, message: '主窗口未就绪' }
      try {
        const selection = await dialog.showOpenDialog(mainWindow, {
          title: '导入人脸视频',
          filters: [
            { name: 'Video Files', extensions: ['mp4', 'avi', 'mov', 'mkv', 'webm'] },
            { name: 'All Files', extensions: ['*'] },
          ],
          properties: ['openFile'],
        })
        if (selection.canceled || selection.filePaths.length === 0) {
          return { ok: false, canceled: true, message: '用户取消' }
        }
        const sourcePath = selection.filePaths[0]
        const facialDir = path.join(projectDir, 'facial-analysis', recordId)
        const sourceDir = path.join(facialDir, 'source')
        fs.mkdirSync(sourceDir, { recursive: true })
        const ext = path.extname(sourcePath) || '.mp4'
        const destPath = path.join(sourceDir, `face${ext}`)
        const partialPath = `${destPath}.${randomUUID()}.part`
        // Copy into a unique partial file so a failed import never exposes a
        // truncated video. Rename is atomic on the destination filesystem.
        let hash = ''
        try {
          hash = await new Promise<string>((resolveHash, rejectHash) => {
            const hasher = createHash('sha256')
            const readStream = fs.createReadStream(sourcePath)
            const writeStream = fs.createWriteStream(partialPath, { flags: 'wx' })
            const fail = (error: Error) => {
              readStream.destroy()
              writeStream.destroy()
              rejectHash(error)
            }
            readStream.on('data', (chunk) => hasher.update(chunk))
            readStream.once('error', fail)
            writeStream.once('error', fail)
            writeStream.once('finish', () => resolveHash(hasher.digest('hex')))
            readStream.pipe(writeStream)
          })
          await fs.promises.rename(partialPath, destPath)
        } catch (error) {
          await fs.promises.unlink(partialPath).catch(() => {})
          throw error
        }
        const manifestPath = path.join(facialDir, 'facial-video.json')
        const existingManifest = fs.existsSync(manifestPath)
          ? asRecord(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')))
          : { schemaVersion: 1, recordId }
        const manifest = {
          ...existingManifest,
          recordId,
          recordName: recordName || existingManifest.recordName || recordId,
          subjectName: subjectName || existingManifest.subjectName,
          videoPath: `source/face${ext}`,
          sha256: hash,
          importedAt: new Date().toISOString(),
          sourcePath: path.relative(projectDir, sourcePath),
        }
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
        return { ok: true, manifest }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  return { registerHandlers, stop }
}
