import * as fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RecordingCommunicationEvent, RecordingCommunicationStartContext } from '../../../shared/contracts/ipc/communication'

/** The backend owns communication-events.jsonl; this capture journal has a separate single writer. */
export class CommunicationJournal {
  private fd: number | null = null
  private readonly directory: string
  private readonly context: RecordingCommunicationStartContext

  constructor(context: RecordingCommunicationStartContext) {
    if (!context || typeof context.recordingId !== 'string' || !context.recordingId || context.recordingId.length > 256 ||
        /[\/\\\0]/.test(context.recordingId) || ['.', '..'].includes(context.recordingId) ||
        !Number.isSafeInteger(context.generation) || context.generation < 0 ||
        !Number.isFinite(context.videoTimeOffsetMs) || !Number.isFinite(context.clockUncertaintyMs) || context.clockUncertaintyMs < 0 ||
        typeof context.journalPath !== 'string' || !path.isAbsolute(context.journalPath)) throw new Error('通信录制上下文无效')
    const journalPath = path.resolve(context.journalPath)
    this.directory = path.dirname(journalPath)
    if (path.basename(journalPath) !== 'communication-capture.jsonl' || path.basename(this.directory) !== `${context.recordingId}.pupil` ||
        !fs.lstatSync(this.directory).isDirectory() || fs.lstatSync(this.directory).isSymbolicLink() ||
        fs.realpathSync(this.directory) !== this.directory) throw new Error('通信日志必须位于当前录制的真实sidecar目录')
    this.context = { ...context, journalPath }
    try {
      this.fd = fs.openSync(journalPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_APPEND, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const before = fs.lstatSync(journalPath)
      if (!before.isFile() || before.isSymbolicLink() || before.size !== 0) throw new Error('已有通信日志不可覆盖，请先恢复该录制')
      const fd = fs.openSync(journalPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0))
      const after = fs.fstatSync(fd)
      if (after.ino !== before.ino || after.dev !== before.dev || after.size !== 0) { fs.closeSync(fd); throw new Error('通信日志在打开时发生变化') }
      this.fd = fd
    }
    try { this.status('recording', []) } catch (error) { this.close(); throw error }
  }

  append(event: RecordingCommunicationEvent): void {
    if (this.fd === null) throw new Error('通信日志已关闭')
    const row = { recording_id: event.recordingId, generation: event.generation, event_id: event.eventId,
      channel: event.channel, text: event.payloadEnvelope, video_time_ms: event.videoTimeMs }
    const data = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8')
    let written = 0
    while (written < data.length) {
      const count = fs.writeSync(this.fd, data, written, data.length - written)
      if (count <= 0) throw new Error('通信日志未能完成写入')
      written += count
    }
    fs.fsyncSync(this.fd)
  }

  status(status: 'recording' | 'stopped' | 'error', errors: string[]): void {
    const destination = path.join(this.directory, 'communication-capture-status.json')
    const temporary = `${destination}.${randomUUID()}.tmp`
    const value = { recording_id: this.context.recordingId, generation: this.context.generation,
      status, errors, clock_uncertainty_ms: this.context.clockUncertaintyMs }
    let fd: number | undefined
    try {
      fd = fs.openSync(temporary, 'wx', 0o600)
      fs.writeFileSync(fd, JSON.stringify(value), 'utf8')
      fs.fsyncSync(fd)
      fs.closeSync(fd); fd = undefined
      fs.renameSync(temporary, destination)
      // Windows does not support fsync on directory handles; the files above are still synced.
      if (process.platform !== 'win32') {
        const directoryFd = fs.openSync(this.directory, 'r')
        try { fs.fsyncSync(directoryFd) } finally { fs.closeSync(directoryFd) }
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
      try { fs.unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }

  close(): void {
    if (this.fd !== null) { const fd = this.fd; this.fd = null; fs.closeSync(fd) }
  }
}
