import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import path from 'node:path'
import { writeTextFileAtomic } from '../../platform/fs/atomicWrite'
import type { AnalysisCommand } from '../../platform/python/analysisLaunch'

type GazeMappingDependencies = {
  buildLocalResourceUrl: (filePath: string) => Promise<string>
  getMainWindow: () => BrowserWindow | null
  getMappingCommand: (jobPath: string) => AnalysisCommand | null
  logVideoDebug: (event: string, details?: unknown) => void
  isModuleAllowed?: (code: string) => boolean
}

type UnknownRecord = Record<string, unknown>

type GazePointInput = {
  x?: unknown
  y?: unknown
  timestamp?: unknown
  weight?: unknown
  durationMs?: unknown
  id?: unknown
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' ? value as UnknownRecord : {}
}

function optionalFiniteNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function safeTimestampForPath(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function isGazeMappingRecordPath(projectDir: string, outputPath: string): boolean {
  const mappingDir = path.resolve(projectDir, 'analysis', 'gaze-mapping')
  return path.dirname(outputPath) === mappingDir && /^mapping_.*\.json$/i.test(path.basename(outputPath))
}

export function createGazeMappingDomain(dependencies: GazeMappingDependencies) {
  const {
    buildLocalResourceUrl,
    getMainWindow,
    getMappingCommand,
    logVideoDebug,
  } = dependencies

  async function runGazeMappingProcess(jobPath: string): Promise<{ ok: boolean; output: string; message?: string }> {
    const serverCommand = getMappingCommand(jobPath)
    if (!serverCommand) {
      logVideoDebug('gaze-mapping-runtime-missing', { jobPath, isPackaged: app.isPackaged })
      return { ok: false, output: '', message: '未找到 Python/OpenCV 映射运行环境' }
    }
    const args = serverCommand.args
    logVideoDebug('gaze-mapping-process-spawn', {
      command: serverCommand.command,
      args,
      cwd: serverCommand.cwd,
      commandExists: fs.existsSync(serverCommand.command),
      isPackaged: app.isPackaged,
    })
    return new Promise((resolve) => {
      const child = spawn(serverCommand.command, args, {
        cwd: serverCommand.cwd,
        env: serverCommand.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (result: { ok: boolean; output: string; message?: string }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
        }
        logVideoDebug('gaze-mapping-process-timeout', { stdout: stdout.slice(-1000), stderr: stderr.slice(-1000) })
        finish({ ok: false, output: stdout, message: '映射处理超时，请缩短视频或增大关键帧间隔' })
      }, 30 * 60 * 1000)
      child.stdout?.on('data', (chunk) => {
        stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk)
      })
      child.once('error', (error) => {
        logVideoDebug('gaze-mapping-process-error', { message: error.message, stack: error.stack || null })
        finish({ ok: false, output: stdout, message: error.message })
      })
      child.once('close', (code) => {
        logVideoDebug('gaze-mapping-process-close', {
          code,
          stdout: stdout.slice(-1000),
          stderr: stderr.slice(-1000),
        })
        if (code === 0) {
          finish({ ok: true, output: stdout.trim() })
        } else {
          // Only surface the mapping process's own structured error (a JSON
          // line with a "message" field). Never leak raw C++/framework logs.
          const lines = `${stderr}\n${stdout}`.trim().split(/\r?\n/).filter(Boolean)
          let message = `映射进程退出，代码 ${code}`
          for (const line of lines) {
            if (/ModuleNotFoundError: No module named ['"](?:cv2|numpy)['"]/.test(line)) {
              message = '离线映射环境缺少 OpenCV 或 NumPy，请安装分析依赖或重新安装完整版本'
            }
            try {
              const parsed = JSON.parse(line) as UnknownRecord
              if (typeof parsed.message === 'string' && parsed.message.trim()) {
                message = parsed.message.trim()
                break
              }
            } catch {
            }
          }
          finish({ ok: false, output: stdout, message })
        }
      })
    })
  }

  function registerHandlers(): void {
    ipcMain.handle('select-gaze-mapping-image', async () => {
      const win = getMainWindow()
      if (!win) return { canceled: true }
      const filters = [{ name: '静态图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'] }]
      const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters })
      if (result.canceled || result.filePaths.length === 0) return { canceled: true }
      const filePath = path.resolve(result.filePaths[0])
      try {
        await fs.promises.access(filePath, fs.constants.R_OK)
        const url = await buildLocalResourceUrl(filePath)
        return { canceled: false, path: filePath, url, name: path.basename(filePath) }
      } catch (error) {
        return { canceled: true, message: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('save-gaze-mapping-screenshot', async (_event, input: unknown) => {
      try {
        const payload = asRecord(input)
        const projectDir = typeof payload.projectDir === 'string' ? path.resolve(payload.projectDir) : ''
        const content = typeof payload.dataUrl === 'string' ? payload.dataUrl.replace(/^data:image\/png;base64,/, '') : ''
        if (!projectDir || !content) return { ok: false, message: '缺少工程目录或截图数据' }
        const assetsDir = path.join(projectDir, 'analysis', 'gaze-mapping', 'assets')
        await fs.promises.mkdir(assetsDir, { recursive: true })
        const filePath = path.join(assetsDir, `video_frame_${safeTimestampForPath()}.png`)
        await fs.promises.writeFile(filePath, Buffer.from(content, 'base64'))
        return { ok: true, path: filePath, url: await buildLocalResourceUrl(filePath), name: path.basename(filePath) }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('list-gaze-mapping-records', async (_event, input: unknown) => {
      try {
        const payload = asRecord(input)
        const projectDir = typeof payload.projectDir === 'string' ? path.resolve(payload.projectDir) : ''
        if (!projectDir) return { ok: true, records: [] }
        const mappingDir = path.join(projectDir, 'analysis', 'gaze-mapping')
        const entries = await fs.promises.readdir(mappingDir, { withFileTypes: true }).catch(() => [])
        const records = await Promise.all(entries
          .filter((entry) => entry.isFile() && /^mapping_.*\.json$/i.test(entry.name))
          .map(async (entry) => {
            try {
              const outputPath = path.join(mappingDir, entry.name)
              const result = JSON.parse(await fs.promises.readFile(outputPath, 'utf-8')) as UnknownRecord
              const imagePath = typeof result.imagePath === 'string' ? result.imagePath : path.join(mappingDir, 'assets', String(result.imageRef || ''))
              await fs.promises.access(imagePath, fs.constants.R_OK)
              const videoPath = typeof result.videoPath === 'string' ? result.videoPath : ''
              const videoUrl = videoPath
                ? await fs.promises.access(videoPath, fs.constants.R_OK).then(() => buildLocalResourceUrl(videoPath)).catch(() => null)
                : null
              // The list only needs summary fields. Large gazeData arrays are
              // loaded on demand when a user selects one mapping record.
              const { gazeData: _gazeData, ...summaryResult } = result
              return { outputPath, result: { ...summaryResult, gazeData: [], imagePath, imageUrl: await buildLocalResourceUrl(imagePath), videoPath, videoUrl } }
            } catch {
              return null
            }
          }))
        const availableRecords = records.filter((record): record is NonNullable<typeof record> => Boolean(record))
        availableRecords.sort((a, b) => String(asRecord(b.result).createdAt || '').localeCompare(String(asRecord(a.result).createdAt || '')))
        return { ok: true, records: availableRecords }
      } catch (error) {
        return { ok: false, records: [], message: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('load-gaze-mapping-record', async (_event, input: unknown) => {
      try {
        const payload = asRecord(input)
        const projectDir = typeof payload.projectDir === 'string' ? path.resolve(payload.projectDir) : ''
        const outputPath = typeof payload.outputPath === 'string' ? path.resolve(payload.outputPath) : ''
        if (!projectDir || !outputPath || !isGazeMappingRecordPath(projectDir, outputPath)) {
          return { ok: false, message: '无效的映射记录路径' }
        }
        const result = JSON.parse(await fs.promises.readFile(outputPath, 'utf-8')) as UnknownRecord
        const mappingDir = path.dirname(outputPath)
        const imagePath = typeof result.imagePath === 'string'
          ? result.imagePath
          : path.join(mappingDir, 'assets', String(result.imageRef || ''))
        await fs.promises.access(imagePath, fs.constants.R_OK)
        const videoPath = typeof result.videoPath === 'string' ? result.videoPath : ''
        const videoUrl = videoPath
          ? await fs.promises.access(videoPath, fs.constants.R_OK).then(() => buildLocalResourceUrl(videoPath)).catch(() => null)
          : null
        return {
          ok: true,
          record: {
            outputPath,
            result: { ...result, imagePath, imageUrl: await buildLocalResourceUrl(imagePath), videoPath, videoUrl },
          },
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('delete-gaze-mapping-record', async (_event, input: unknown) => {
      try {
        const payload = asRecord(input)
        const projectDir = typeof payload.projectDir === 'string' ? path.resolve(payload.projectDir) : ''
        const outputPath = typeof payload.outputPath === 'string' ? path.resolve(payload.outputPath) : ''
        if (!projectDir || !outputPath) return { ok: false, message: '缺少工程目录或映射记录路径' }
        if (!isGazeMappingRecordPath(projectDir, outputPath)) {
          return { ok: false, message: '无效的映射记录路径' }
        }
        const mappingDir = path.resolve(projectDir, 'analysis', 'gaze-mapping')
        const result = JSON.parse(await fs.promises.readFile(outputPath, 'utf-8')) as UnknownRecord
        const assetsDir = path.resolve(mappingDir, 'assets')
        const imagePath = typeof result.imagePath === 'string'
          ? path.resolve(result.imagePath)
          : path.resolve(assetsDir, String(result.imageRef || ''))
        if (imagePath !== assetsDir && path.dirname(imagePath) === assetsDir) {
          await fs.promises.unlink(imagePath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          })
        }
        await fs.promises.unlink(outputPath)
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('update-gaze-mapping-point', async (_event, input: unknown) => {
      try {
        const payload = asRecord(input)
        const projectDir = typeof payload.projectDir === 'string' ? path.resolve(payload.projectDir) : ''
        const outputPath = typeof payload.outputPath === 'string' ? path.resolve(payload.outputPath) : ''
        const action = payload.action === 'set-deleted' || payload.action === 'restore-all-deleted'
          ? payload.action
          : 'calibrate'
        if (!projectDir || !outputPath) return { ok: false, message: '缺少工程目录或映射记录路径' }
        if (!isGazeMappingRecordPath(projectDir, outputPath)) {
          return { ok: false, message: '无效的映射记录路径' }
        }
        const result = JSON.parse(await fs.promises.readFile(outputPath, 'utf-8')) as UnknownRecord
        if (!Array.isArray(result.gazeData)) {
          return { ok: false, message: '未找到需要更新的映射点' }
        }
        if (action === 'restore-all-deleted') {
          let restoredCount = 0
          result.gazeData = result.gazeData.map((value) => {
            const point = asRecord(value)
            if (point.deleted !== true) return point
            restoredCount += 1
            const restored: UnknownRecord = { ...point, deleted: false }
            delete restored.deletedAt
            return restored
          })
          if (restoredCount > 0) {
            await writeTextFileAtomic(outputPath, JSON.stringify(result, null, 2))
          }
          return { ok: true, restoredCount }
        }
        const pointIndex = Number(payload.pointIndex)
        if (!Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= result.gazeData.length) {
          return { ok: false, message: '未找到需要校准的映射点' }
        }
        const point = asRecord(result.gazeData[pointIndex])
        if (payload.sourceId !== undefined && String(point.sourceId) !== String(payload.sourceId)) {
          return { ok: false, message: '映射点标识不匹配，请重新打开记录后再试' }
        }
        if (action === 'set-deleted') {
          const deleted = payload.deleted === true
          const updated: UnknownRecord = {
            ...point,
            deleted,
            ...(deleted ? { deletedAt: new Date().toISOString() } : {}),
          }
          if (!deleted) delete updated.deletedAt
          result.gazeData[pointIndex] = updated
        } else {
          const x = Number(payload.x)
          const y = Number(payload.y)
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return { ok: false, message: '缺少有效的映射点校准数据' }
          }
          result.gazeData[pointIndex] = {
            ...point,
            x,
            y,
            originalX: Number.isFinite(Number(point.originalX)) ? Number(point.originalX) : Number(point.x),
            originalY: Number.isFinite(Number(point.originalY)) ? Number(point.originalY) : Number(point.y),
            manualCalibrated: true,
            calibratedAt: new Date().toISOString(),
          }
        }
        await writeTextFileAtomic(outputPath, JSON.stringify(result, null, 2))
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('run-gaze-mapping', async (_event, input: unknown) => {
      if (dependencies.isModuleAllowed && !dependencies.isModuleAllowed('eye_tracking')) {
        return { ok: false, message: '当前 License 未授权眼动模块。' }
      }
      const payload = asRecord(input)
      const videoPath = typeof payload.videoPath === 'string' ? path.resolve(payload.videoPath) : ''
      const imagePath = typeof payload.imagePath === 'string' ? path.resolve(payload.imagePath) : ''
      const projectDir = typeof payload.projectDir === 'string' ? path.resolve(payload.projectDir) : ''
      const gazePoints = Array.isArray(payload.gazePoints) ? payload.gazePoints as GazePointInput[] : []
      if (!videoPath || !imagePath || !projectDir || gazePoints.length === 0) {
        logVideoDebug('gaze-mapping-invalid-input', {
          hasVideoPath: Boolean(videoPath),
          hasImagePath: Boolean(imagePath),
          hasProjectDir: Boolean(projectDir),
          gazePointCount: gazePoints.length,
        })
        return { ok: false, message: '缺少视频、静态图片或注视点数据' }
      }
      if (gazePoints.length > 1_000_000) {
        return { ok: false, message: '注视点数量超过 100 万，请先裁剪数据范围' }
      }
      try {
        const keyframeIntervalFrames = Math.max(1, Math.min(300, Math.round(Number(payload.keyframeIntervalFrames) || 15)))
        logVideoDebug('gaze-mapping-start', {
          videoPath,
          imagePath,
          projectDir,
          gazePointCount: gazePoints.length,
          keyframeIntervalFrames,
          isPackaged: app.isPackaged,
        })
        await Promise.all([
          fs.promises.access(videoPath, fs.constants.R_OK),
          fs.promises.access(imagePath, fs.constants.R_OK),
          fs.promises.mkdir(path.join(projectDir, 'analysis', 'gaze-mapping'), { recursive: true }),
        ])
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
        const mappingDir = path.join(projectDir, 'analysis', 'gaze-mapping')
        const assetsDir = path.join(mappingDir, 'assets')
        await fs.promises.mkdir(assetsDir, { recursive: true })
        const savedImagePath = path.join(assetsDir, `${stamp}_${path.basename(imagePath)}`)
        await fs.promises.copyFile(imagePath, savedImagePath)
        const outputPath = path.join(mappingDir, `mapping_${stamp}.json`)
        const jobPath = path.join(app.getPath('temp'), `mrt-gaze-mapping-${process.pid}-${Date.now()}.json`)
        const job = {
          videoPath,
          imagePath: savedImagePath,
          outputPath,
          gazePoints: gazePoints.map((point, index) => ({
            x: Number(point?.x),
            y: Number(point?.y),
            timestamp: optionalFiniteNumber(point?.timestamp),
            weight: optionalFiniteNumber(point?.weight),
            durationMs: optionalFiniteNumber(point?.durationMs),
            id: point?.id ?? index,
          })),
          keyframeIntervalFrames,
        }
        await fs.promises.writeFile(jobPath, JSON.stringify(job), 'utf-8')
        try {
          const processResult = await runGazeMappingProcess(jobPath)
          if (!processResult.ok) {
            logVideoDebug('gaze-mapping-failed', {
              message: processResult.message || '映射失败',
              output: processResult.output,
            })
            return { ok: false, message: processResult.message || '映射失败' }
          }
          const raw = await fs.promises.readFile(outputPath, 'utf-8')
          const parsedResult = JSON.parse(raw) as UnknownRecord
          const result: UnknownRecord = {
            ...parsedResult,
            recordId: typeof payload.recordId === 'string' ? payload.recordId : '',
            recordName: typeof payload.recordName === 'string' ? payload.recordName : path.basename(videoPath),
            createdAt: new Date().toISOString(),
            imagePath: savedImagePath,
            imageUrl: await buildLocalResourceUrl(savedImagePath),
            videoPath,
            videoUrl: await buildLocalResourceUrl(videoPath),
          }
          await fs.promises.writeFile(outputPath, JSON.stringify(result, null, 2), 'utf-8')
          logVideoDebug('gaze-mapping-complete', {
            outputPath,
            summary: result.summary || null,
          })
          return { ok: true, outputPath, result }
        } finally {
          await fs.promises.rm(jobPath, { force: true }).catch(() => undefined)
        }
      } catch (error) {
        logVideoDebug('gaze-mapping-exception', {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : null,
        })
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  return { registerHandlers }
}
