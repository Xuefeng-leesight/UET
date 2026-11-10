import * as dgram from 'node:dgram'
import { randomUUID } from 'node:crypto'
import { SerialPort } from 'serialport'
import type { EventEmitter } from 'node:events'
import type {
  CommunicationBatchResult, CommunicationChannel, ConfigureCommunicationPayload,
  ConfigureCommunicationResult, ReadCommunicationPayload, RecordingCommunicationContext,
  RecordingCommunicationEvent, RecordingCommunicationStartContext, SendRecordingTriggerPayload,
  SerialPortDescription, TriggerNetworkConfig,
} from '../../../shared/contracts/ipc/communication'
import { CommunicationJournal } from './communicationJournal'
import { normalizeTriggerNetworkConfig, validateUdpDestination } from './triggerConfiguration'

type Result = { ok: true } | { ok: false; message: string }
export interface SerialConnection extends EventEmitter {
  isOpen: boolean
  open(callback: (error?: Error | null) => void): void
  write(data: Buffer, callback: (error?: Error | null) => void): unknown
  drain(callback: (error?: Error | null) => void): void
  close(callback: (error?: Error | null) => void): void
}
type Journal = Pick<CommunicationJournal, 'append' | 'status' | 'close'>
type Dependencies = {
  createUdp: () => dgram.Socket
  createSerial: (config: Required<TriggerNetworkConfig>) => SerialConnection
  listPorts: () => Promise<SerialPortDescription[]>
  createJournal: (context: RecordingCommunicationStartContext) => Journal
  now: () => number
  epoch: () => number
  timeoutMs: number
  maxEvents: number
  maxBytes: number
}
type Session = {
  context: RecordingCommunicationStartContext
  config: Required<TriggerNetworkConfig>
  journal: Journal
  phase: 'starting' | 'active' | 'stopping' | 'stopped'
  udp?: dgram.Socket
  serial?: SerialConnection
  serialOpening?: boolean
  queue: RecordingCommunicationEvent[]
  bytes: number
  errors: string[]
  pending: Set<Promise<Result>>
  startup?: Promise<void>
  stopPromise?: Promise<void>
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
const failure = (error: unknown): Result => ({ ok: false, message: messageOf(error) })
const validateMark = (mark: unknown): number => {
  if (typeof mark !== 'number' || !Number.isInteger(mark) || mark < 0 || mark > 65535) throw new Error('Trigger标记必须为0到65535的整数')
  return mark
}
export const encodeCommunicationPayload = (data: Buffer): string => {
  const text = data.toString('utf8')
  return Buffer.from(text, 'utf8').equals(data)
    ? JSON.stringify({ encoding: 'utf-8', data: text })
    : JSON.stringify({ encoding: 'base64', data: data.toString('base64') })
}

/** Owns actual I/O and its durable capture journal. Renderer polling only transports ACKs. */
export class RecordingCommunicationService {
  private current?: Session
  private readonly udpSends = new Set<dgram.Socket>()
  private readonly deps: Dependencies

  constructor(dependencies: Partial<Dependencies> = {}) {
    this.deps = {
      createUdp: () => dgram.createSocket('udp4'),
      createSerial: config => new SerialPort({ path: config.serialPath, baudRate: config.serialBaudRate,
        dataBits: config.serialDataBits, stopBits: config.serialStopBits, parity: config.serialParity,
        autoOpen: false, highWaterMark: 65536 }),
      listPorts: () => SerialPort.list(),
      createJournal: context => new CommunicationJournal(context),
      now: () => performance.now(), epoch: () => Date.now(), timeoutMs: 3000,
      maxEvents: 10000, maxBytes: 16 * 1024 * 1024, ...dependencies,
    }
  }

  clock(): { ok: true; mainMonotonicMs: number } { return { ok: true, mainMonotonicMs: this.deps.now() } }

  async listSerialPorts(): Promise<{ ok: true; ports: SerialPortDescription[] } | { ok: false; message: string }> {
    try {
      const ports = await this.deps.listPorts()
      return { ok: true, ports: ports.filter(port => typeof port.path === 'string' && port.path.length > 0 && port.path.length <= 512 && !/[\0\r\n]/.test(port.path))
        .map(({ path, manufacturer, serialNumber, vendorId, productId }) => ({ path, manufacturer, serialNumber, vendorId, productId })) }
    } catch (error) { return { ok: false, message: messageOf(error) } }
  }

  async configure(payload: ConfigureCommunicationPayload): Promise<ConfigureCommunicationResult> {
    let session: Session | undefined
    try {
      if (this.current && this.current.phase !== 'stopped') throw new Error('已有通信录制尚未停止')
      const config = normalizeTriggerNetworkConfig(payload?.config)
      const context = payload?.context
      // The journal validates the identity, clocks and safe path before any port is opened.
      const journal = this.deps.createJournal(context)
      session = { context: { ...context }, config, journal, phase: 'starting', queue: [], bytes: 0, errors: [], pending: new Set() }
      // A stopped queue is safely recoverable from its own journal and cannot leak into this recording.
      this.current = session
      const opening = session
      session.startup = Promise.resolve().then(async () => {
        if (opening.phase !== 'starting') throw new Error('通信启动已取消')
        if (config.enabled) await this.openUdp(opening)
        if (opening.phase !== 'starting') throw new Error('通信启动已取消')
        if (config.serialEnabled) await this.openSerial(opening)
      })
      await session.startup
      if (session.phase !== 'starting' || session.errors.length) throw new Error(session.errors[0] || '通信启动已取消')
      session.phase = 'active'
      return { ok: true, mainMonotonicMs: this.deps.now(), mainEpochMs: this.deps.epoch() }
    } catch (error) {
      if (session) { this.fault(session, `通信启动失败：${messageOf(error)}`); await this.stopSession(session) }
      return { ok: false, message: messageOf(error), cleanupPending: !!session && session.phase !== 'stopped' }
    }
  }

  private async openUdp(session: Session): Promise<void> {
    const socket = this.deps.createUdp()
    session.udp = socket
    socket.on('message', data => {
      if (session.phase === 'starting' || session.phase === 'active') this.capture(session, 'udp_receive', data)
    })
    socket.on('error', error => this.fault(session, `UDP接收失败：${messageOf(error)}`))
    await this.operation(socket, done => socket.bind(session.config.udpReceivePort, '0.0.0.0', () => done()), 'UDP监听启动超时')
  }

  private async openSerial(session: Session): Promise<void> {
    const port = this.deps.createSerial(session.config)
    session.serial = port
    session.serialOpening = true
    port.on('data', (data: Buffer) => {
      if (session.phase !== 'starting' && session.phase !== 'active') return
      // Serial reads are byte chunks, not protocol messages. Never truncate a large read.
      for (let offset = 0; offset < data.length; offset += 65536) {
        if (session.phase !== 'starting' && session.phase !== 'active') break
        this.capture(session, 'trigger_receive', data.subarray(offset, offset + 65536))
      }
    })
    port.on('error', error => this.fault(session, `串口错误：${messageOf(error)}`))
    port.on('close', () => {
      if (session.phase === 'active' || session.phase === 'starting') this.fault(session, '串口意外断开')
    })
    try {
      await this.operation(port, done => {
        try {
          port.open(error => {
            session.serialOpening = false
            done(error)
            if (session.phase === 'stopping') void this.stopSession(session)
          })
        } catch (error) { session.serialOpening = false; throw error }
      }, '串口打开超时')
      // stopSession owns closing even when opening finishes during cancellation.
      // Do not await an unbounded close callback here; stopSession applies its timeout.
    }
    catch (error) {
      // A late open callback is fenced above. Until it arrives the owner remains
      // stopping and cleanupPending=true, so the backend cannot finalize early.
      throw error
    }
  }

  private operation(emitter: EventEmitter, start: (done: (error?: Error | null) => void) => void, timeout: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (error?: Error | null) => {
        if (settled) return
        settled = true; clearTimeout(timer); emitter.off('error', done); emitter.off('close', closed)
        if (error) reject(error); else resolve()
      }
      const closed = () => done(new Error('通信端口已关闭'))
      const timer = setTimeout(() => done(new Error(timeout)), this.deps.timeoutMs)
      emitter.once('error', done); emitter.once('close', closed)
      try { start(done) } catch (error) { done(new Error(messageOf(error))) }
    })
  }

  private capture(session: Session, channel: CommunicationChannel, data: Buffer): void {
    if (session.phase === 'stopped') return
    const mainMonotonicMs = this.deps.now()
    const event: RecordingCommunicationEvent = { recordingId: session.context.recordingId, generation: session.context.generation,
      eventId: randomUUID(), channel, mainMonotonicMs, capturedAtEpochMs: this.deps.epoch(),
      videoTimeMs: mainMonotonicMs + session.context.videoTimeOffsetMs, payloadEnvelope: encodeCommunicationPayload(data) }
    try {
      session.journal.append(event)
      // The overflow event remains durable for backend recovery; memory is strictly bounded.
      const bytes = Buffer.byteLength(event.payloadEnvelope, 'utf8')
      if (session.queue.length >= this.deps.maxEvents || session.bytes + bytes > this.deps.maxBytes) {
        this.fault(session, '通信待确认队列达到上限；已写日志，已停止收发，请完成录制并检查后端连接')
        return
      }
      session.queue.push(event); session.bytes += bytes
    } catch (error) { this.fault(session, `通信日志持久化失败：${messageOf(error)}`) }
  }

  private fault(session: Session, message: string): void {
    if (session.phase === 'stopped') return
    if (!session.errors.includes(message) && session.errors.length < 100) session.errors.push(message)
    try { session.journal.status('error', session.errors) }
    catch (error) {
      const detail = `通信错误状态写入失败：${messageOf(error)}`
      if (!session.errors.includes(detail) && session.errors.length < 100) session.errors.push(detail)
    }
    // stopSession waits pending sends before closing their journal.
    void this.stopSession(session)
  }

  private identity(context: RecordingCommunicationContext): Session {
    const session = this.current
    if (!session || !context || session.context.recordingId !== context.recordingId || session.context.generation !== context.generation) {
      throw new Error('通信录制上下文已过期或不存在')
    }
    return session
  }

  read(payload: ReadCommunicationPayload): CommunicationBatchResult {
    try {
      const session = this.identity(payload?.context)
      const maximum = payload.maxEvents ?? 64
      if (!Number.isInteger(maximum) || maximum < 1 || maximum > 256) throw new Error('通信读取数量必须为1到256')
      if (payload.ackEventIds !== undefined) {
        if (!Array.isArray(payload.ackEventIds) || payload.ackEventIds.length > 10000 || payload.ackEventIds.some(id => typeof id !== 'string' || id.length > 128)) throw new Error('通信确认列表无效')
        const acknowledged = new Set(payload.ackEventIds)
        session.queue = session.queue.filter(event => {
          if (!acknowledged.has(event.eventId)) return true
          session.bytes -= Buffer.byteLength(event.payloadEnvelope, 'utf8'); return false
        })
      }
      return { ok: true, events: session.queue.slice(0, maximum), pendingCount: session.queue.length,
        stopped: session.phase === 'stopped', errors: [...session.errors] }
    } catch (error) { return { ok: false, message: messageOf(error) } }
  }

  async flushStop(payload: ReadCommunicationPayload): Promise<CommunicationBatchResult> {
    try {
      const context = payload?.context
      if (!context || typeof context.recordingId !== 'string' || !context.recordingId ||
          !Number.isSafeInteger(context.generation) || context.generation < 0) throw new Error('通信录制上下文无效')
      if (!this.current || (this.current.phase === 'stopped' &&
          (this.current.context.recordingId !== context.recordingId || this.current.context.generation !== context.generation))) {
        return { ok: true, events: [], pendingCount: 0, stopped: true, errors: [] }
      }
      const session = this.identity(payload?.context)
      await this.stopSession(session)
      if (session.phase !== 'stopped') return { ok: false, message: session.errors.at(-1) || '通信端口尚未关闭，请重试停止' }
      return this.read(payload)
    } catch (error) { return { ok: false, message: messageOf(error) } }
  }

  private stopSession(session: Session): Promise<void> {
    if (session.stopPromise) return session.stopPromise
    session.phase = 'stopping'
    // Stop accepting RX immediately. Already-submitted TX callbacks remain eligible for capture.
    session.stopPromise = (async () => {
      if (session.startup) await Promise.allSettled([session.startup])
      if (session.udp) await new Promise<void>(resolve => {
        try { session.udp!.close(() => resolve()) } catch { resolve() } // Not bound after a failed start.
      })
      await Promise.allSettled([...session.pending])
      if (session.serialOpening) {
        if (!session.errors.includes('串口仍在打开，尚未确认关闭；请重试停止')) session.errors.push('串口仍在打开，尚未确认关闭；请重试停止')
        try { session.journal.status('error', session.errors) }
        catch (error) { session.errors.push(`通信错误状态写入失败：${messageOf(error)}`) }
        session.stopPromise = undefined
        return
      }
      if (session.serial?.isOpen) {
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('串口关闭超时')), this.deps.timeoutMs)
            try { session.serial!.close(error => { clearTimeout(timer); error ? reject(error) : resolve() }) }
            catch (error) { clearTimeout(timer); reject(error) }
          })
        } catch (error) { session.errors.push(`串口关闭失败：${messageOf(error)}`) }
      }
      if (session.serial?.isOpen) {
        // Keep the journal and session owner alive; a failed stop must be retryable.
        try { session.journal.status('error', session.errors) }
        catch (error) { session.errors.push(`通信错误状态写入失败：${messageOf(error)}`) }
        session.stopPromise = undefined
        return
      }
      try { session.journal.status(session.errors.length ? 'error' : 'stopped', session.errors) }
      catch (error) { session.errors.push(`通信结束状态写入失败：${messageOf(error)}`) }
      try { session.journal.close() } catch (error) {
        session.errors.push(`通信日志关闭失败：${messageOf(error)}`)
        try { session.journal.status('error', session.errors) } catch { /* Already visible in the retained errors. */ }
      }
      session.phase = 'stopped'
    })()
    return session.stopPromise
  }

  private track(session: Session | undefined, task: Promise<Result>): Promise<Result> {
    if (session) { session.pending.add(task); void task.finally(() => session.pending.delete(task)) }
    return task
  }

  private sendUdpBytes(data: Buffer, targetIp: string, port: number, session?: Session): Promise<Result> {
    const task = (async (): Promise<Result> => {
      let socket: dgram.Socket | undefined
      try {
        socket = this.deps.createUdp(); this.udpSends.add(socket)
        await this.operation(socket, done => socket!.send(data, port, targetIp, done), 'UDP发送超时')
        if (session) {
          this.capture(session, 'udp_send', data)
          if (session.errors.length) throw new Error(session.errors[0])
        }
        return { ok: true }
      } catch (error) {
        if (session) this.fault(session, `UDP发送失败：${messageOf(error)}`)
        return failure(error)
      } finally {
        if (socket) { this.udpSends.delete(socket); try { socket.close() } catch {} }
      }
    })()
    return this.track(session, task)
  }

  async sendUdp(payload: { targetIp: string; port: number; mark: number }): Promise<Result> {
    try {
      const { targetIp, port } = validateUdpDestination(payload?.targetIp, payload?.port)
      const mark = validateMark(payload?.mark)
      const session = this.current?.phase === 'active' ? this.current : undefined
      if (this.current && this.current.phase !== 'active' && this.current.phase !== 'stopped') throw new Error('通信录制正在启动或停止')
      return this.sendUdpBytes(Buffer.from(String(mark), 'utf8'), targetIp, port, session)
    } catch (error) { return failure(error) }
  }

  async sendTrigger(payload: SendRecordingTriggerPayload): Promise<Result> {
    try {
      const mark = validateMark(payload?.mark)
      const session = payload?.context ? this.identity(payload.context) : this.current
      if (!session || session.phase !== 'active' || session.errors.length) throw new Error('通信录制未启用或已停止')
      const data = Buffer.from(String(mark), 'utf8')
      const sends: Promise<Result>[] = []
      if (session.config.enabled) sends.push(this.sendUdpBytes(data, session.config.targetIp, session.config.udpSendPort, session))
      if (session.config.serialEnabled) {
        const task = (async (): Promise<Result> => {
          try {
            const serial = session.serial
            if (!serial?.isOpen) throw new Error('串口未打开')
            await this.operation(serial, done => {
              serial.write(data, error => { if (error) done(error); else serial.drain(done) })
            }, '串口发送或排空超时')
            this.capture(session, 'trigger_send', data)
            if (session.errors.length) throw new Error(session.errors[0])
            return { ok: true }
          } catch (error) { this.fault(session, `串口发送失败：${messageOf(error)}`); return failure(error) }
        })()
        sends.push(this.track(session, task))
      }
      const results = await Promise.all(sends)
      return results.find(result => result.ok === false) ?? { ok: true }
    } catch (error) { return failure(error) }
  }

  async shutdown(): Promise<void> {
    if (this.current) await this.stopSession(this.current)
    for (const socket of this.udpSends) { try { socket.close() } catch {} }
    this.udpSends.clear()
  }
}

export const recordingCommunicationService = new RecordingCommunicationService()
