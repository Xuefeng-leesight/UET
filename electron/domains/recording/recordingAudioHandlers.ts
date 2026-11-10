import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import path from 'node:path'
import { pupilAudioFilter, type PupilAudioSync } from '../../../shared/domain/pupilAudioSync'

type RecordingAudioSession = {
  sessionId: string
  videoPath: string
  tempAudioPath: string
  mimeType: string
  deviceLabel: string
  stream: fs.WriteStream
  bytesWritten: number
  startedAtMs: number
  writeError: string | null
  pupilSync?: PupilAudioSync
}

type RecordingAudioDependencies = {
  findFfmpegBinary: () => string | null
  runCommand: (command: string, args: string[], cwd?: string) => Promise<void>
}

export type RecordingAudioDomain = {
  abortAll: () => Promise<void>
  registerHandlers: () => void
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' ? value as UnknownRecord : {}
}

function toAudioChunk(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (Array.isArray(value)) return Buffer.from(value.map((item) => Number(item)))
  if (value == null) return Buffer.alloc(0)
  throw new TypeError('音频分片格式无效')
}

export function recordingAudioExtension(mimeType: string): string {
  const normalized = String(mimeType || '').toLowerCase()
  if (normalized.includes('ogg')) return '.ogg'
  if (normalized.includes('mp4') || normalized.includes('m4a')) return '.m4a'
  return '.webm'
}

async function closeRecordingAudioStream(sessionInfo: RecordingAudioSession): Promise<void> {
  if (sessionInfo.stream.closed) return
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onFinish = () => {
      cleanup()
      resolve()
    }
    const cleanup = () => {
      sessionInfo.stream.off('error', onError)
      sessionInfo.stream.off('finish', onFinish)
    }
    sessionInfo.stream.once('error', onError)
    sessionInfo.stream.once('finish', onFinish)
    sessionInfo.stream.end()
  })
}

export function createRecordingAudioDomain(dependencies: RecordingAudioDependencies): RecordingAudioDomain {
  const sessions = new Map<string, RecordingAudioSession>()

  async function waitForRecordingVideoFinalized(sessionInfo: RecordingAudioSession): Promise<void> {
    const metaPath = path.join(
      path.dirname(sessionInfo.videoPath),
      `${path.basename(sessionInfo.videoPath, path.extname(sessionInfo.videoPath))}.meta.json`,
    )
    const deadline = Date.now() + 70_000
    while (Date.now() < deadline) {
      try {
        const [videoStat, metaStat] = await Promise.all([
          fs.promises.stat(sessionInfo.videoPath),
          fs.promises.stat(metaPath),
        ])
        if (
          videoStat.isFile()
          && videoStat.size > 0
          && metaStat.isFile()
          && metaStat.mtimeMs >= sessionInfo.startedAtMs - 2_000
        ) {
          const meta = asRecord(JSON.parse(await fs.promises.readFile(metaPath, 'utf-8')))
          if (meta.deviceModel !== 'PupilCore') return
          if (meta.status === 'failed') throw new Error('Pupil 视频收尾失败，原音频已保留')
          if ((meta.status === 'complete' || meta.status === 'partial') && meta.videoVerified === true) {
            const sync = sessionInfo.pupilSync
            if (!sync || sync.sourceTimeOriginS !== meta.sourceTimeOriginS
              || sync.recordingId !== path.basename(sessionInfo.videoPath, '.mp4')) {
              throw new Error('Pupil 音频缺少匹配的源时钟对齐信息，原音频已保留')
            }
            return
          }
        }
      } catch (error) {
        // Legacy services can write metadata non-atomically. A transient torn
        // JSON must wait for completion, not turn an old-device recording into failure.
        if (!(error instanceof SyntaxError)
          && !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 300))
    }
    throw new Error('等待录制视频收尾超时')
  }

  async function updateRecordingAudioMeta(sessionInfo: RecordingAudioSession): Promise<void> {
    const metaPath = path.join(
      path.dirname(sessionInfo.videoPath),
      `${path.basename(sessionInfo.videoPath, path.extname(sessionInfo.videoPath))}.meta.json`,
    )
    try {
      const raw = await fs.promises.readFile(metaPath, 'utf-8')
      const parsed: unknown = JSON.parse(raw)
      const next: UnknownRecord = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as UnknownRecord
        : {}
      next.audioRecorded = true
      next.audioCodec = 'aac'
      next.audioInputLabel = sessionInfo.deviceLabel
      if (sessionInfo.pupilSync) next.audioSynchronization = sessionInfo.pupilSync
      next.updatedAt = new Date().toISOString()
      await fs.promises.writeFile(metaPath, JSON.stringify(next, null, 2), 'utf-8')
    } catch (error) {
      console.warn('[recording-audio] metadata update failed', error instanceof Error ? error.message : String(error))
    }
  }

  async function muxRecordingAudio(sessionInfo: RecordingAudioSession): Promise<void> {
    const ffmpegBin = dependencies.findFfmpegBinary()
    if (!ffmpegBin) throw new Error('未找到 ffmpeg，无法将麦克风音频写入视频')
    await waitForRecordingVideoFinalized(sessionInfo)
    const ext = path.extname(sessionInfo.videoPath) || '.mp4'
    const stem = path.basename(sessionInfo.videoPath, ext)
    const dir = path.dirname(sessionInfo.videoPath)
    const mergedPath = path.join(dir, `${stem}.audio_merge_${Date.now()}.tmp`)
    const backupPath = path.join(dir, `${stem}.video_only_${Date.now()}.tmp`)
    const args = [
      '-y', '-i', sessionInfo.videoPath, '-i', sessionInfo.tempAudioPath,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac',
      '-b:a', '128k', '-af', sessionInfo.pupilSync ? pupilAudioFilter(sessionInfo.pupilSync) : 'apad',
      '-shortest', '-movflags', '+faststart',
      '-f', 'mp4', mergedPath,
    ]
    try {
      await dependencies.runCommand(ffmpegBin, args)
      const mergedStat = await fs.promises.stat(mergedPath)
      if (!mergedStat.isFile() || mergedStat.size <= 0) throw new Error('合并后的视频为空文件')
      await fs.promises.rename(sessionInfo.videoPath, backupPath)
      try {
        await fs.promises.rename(mergedPath, sessionInfo.videoPath)
      } catch (error) {
        // Restore the original video with retries; if that also fails, keep the
        // backup on disk and surface its path instead of silently losing data.
        let restored = false
        for (let attempt = 0; attempt < 3 && !restored; attempt += 1) {
          try {
            await fs.promises.rename(backupPath, sessionInfo.videoPath)
            restored = true
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 200))
          }
        }
        if (!restored) {
          console.error('[recording-audio] original video restore failed; file kept at', backupPath)
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`${message}（原视频已保留：${backupPath}）`)
        }
        throw error
      }
      await fs.promises.unlink(backupPath).catch(() => {})
      await updateRecordingAudioMeta(sessionInfo)
    } finally {
      await fs.promises.unlink(mergedPath).catch(() => {})
    }
  }

  async function abortSession(sessionId: string): Promise<void> {
    const sessionInfo = sessions.get(sessionId)
    if (!sessionInfo) return
    sessions.delete(sessionId)
    try { sessionInfo.stream.destroy() } catch {}
    await fs.promises.unlink(sessionInfo.tempAudioPath).catch(() => {})
  }

  async function abortAll(): Promise<void> {
    await Promise.all(Array.from(sessions.keys(), abortSession))
  }

  function registerHandlers(): void {
    ipcMain.handle('start-recording-audio', async (_event, payload: unknown) => {
      const input = asRecord(payload)
      const videoPath = typeof input.videoPath === 'string' ? path.resolve(input.videoPath) : ''
      const mimeType = typeof input.mimeType === 'string' ? input.mimeType : ''
      const deviceLabel = typeof input.deviceLabel === 'string' ? input.deviceLabel.trim() : ''
      if (!videoPath || path.extname(videoPath).toLowerCase() !== '.mp4') {
        return { ok: false, message: '无效的录制视频路径' }
      }
      const sessionId = randomUUID()
      const tempDir = path.join(app.getPath('temp'), 'mrt-recording-audio')
      const tempAudioPath = path.join(tempDir, `${sessionId}${recordingAudioExtension(mimeType)}`)
      try {
        await fs.promises.mkdir(tempDir, { recursive: true })
        const stream = fs.createWriteStream(tempAudioPath, { flags: 'w' })
        const sessionInfo: RecordingAudioSession = {
          sessionId, videoPath, tempAudioPath, mimeType, deviceLabel, stream,
          bytesWritten: 0, startedAtMs: Date.now(), writeError: null,
        }
        stream.on('error', (error) => {
          sessionInfo.writeError = error.message || '音频临时文件写入失败'
        })
        sessions.set(sessionId, sessionInfo)
        return { ok: true, sessionId }
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误'
        return { ok: false, message: `创建音频临时文件失败：${message}` }
      }
    })

    ipcMain.handle('append-recording-audio', async (_event, payload: unknown) => {
      const input = asRecord(payload)
      const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
      const sessionInfo = sessions.get(sessionId)
      if (!sessionInfo) return { ok: false, message: '音频录制会话不存在' }
      if (sessionInfo.writeError) return { ok: false, message: sessionInfo.writeError }
      try {
        const chunk = toAudioChunk(input.chunk)
        if (chunk.length <= 0) return { ok: true }
        await new Promise<void>((resolve, reject) => {
          sessionInfo.stream.write(chunk, (error) => error ? reject(error) : resolve())
        })
        sessionInfo.bytesWritten += chunk.length
        return { ok: true }
      } catch (error) {
        sessionInfo.writeError = error instanceof Error ? error.message : '音频分片写入失败'
        return { ok: false, message: sessionInfo.writeError }
      }
    })

    ipcMain.handle('finish-recording-audio', async (_event, payload: unknown) => {
      const input = asRecord(payload)
      const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
      const sessionInfo = sessions.get(sessionId)
      if (!sessionInfo) return { ok: false, message: '音频录制会话不存在' }
      sessions.delete(sessionId)
      let merged = false
      try {
        await closeRecordingAudioStream(sessionInfo)
        if (sessionInfo.writeError) throw new Error(sessionInfo.writeError)
        if (sessionInfo.bytesWritten <= 0) throw new Error('没有采集到麦克风音频')
        if (typeof input.synchronizationError === 'string') throw new Error(input.synchronizationError)
        if (input.pupilSync !== undefined) {
          const sync = asRecord(input.pupilSync)
          if (sync.provider !== 'PupilCore' || typeof sync.recordingId !== 'string'
            || typeof sync.sourceTimeOriginS !== 'number' || !Number.isFinite(sync.sourceTimeOriginS)
            || sync.hardwareLatencyMeasured !== false) throw new Error('Invalid Pupil audio synchronization metadata')
          sessionInfo.pupilSync = sync as PupilAudioSync
          pupilAudioFilter(sessionInfo.pupilSync)
        }
        await muxRecordingAudio(sessionInfo)
        merged = true
        return { ok: true, videoPath: sessionInfo.videoPath }
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误'
        // Do not destroy the only audio copy when muxing or clock validation fails.
        return { ok: false, message: `音频合并失败：${message}；原音频保留在 ${sessionInfo.tempAudioPath}` }
      } finally {
        if (merged) await fs.promises.unlink(sessionInfo.tempAudioPath).catch(() => {})
      }
    })

    ipcMain.handle('abort-recording-audio', async (_event, payload: unknown) => {
      const input = asRecord(payload)
      const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
      await abortSession(sessionId)
      return { ok: true }
    })
  }

  return { abortAll, registerHandlers }
}
