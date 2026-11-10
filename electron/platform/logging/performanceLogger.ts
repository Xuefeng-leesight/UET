import { app } from 'electron'
import * as fs from 'node:fs'
import path from 'node:path'
import { ENABLE_DEBUG_TESTING } from '../../../shared/constants/debug'

type PerfProcessType = 'main' | 'renderer'

type PerfLogInput = {
  processType: PerfProcessType
  event: string
  sinceRendererStartMs?: unknown
  details?: unknown
}

type PerfLogRecord = {
  ts: string
  sessionId: string
  processType: PerfProcessType
  event: string
  sinceAppStartMs: number
  sinceRendererStartMs?: number
  pid: number
  platform: NodeJS.Platform
  arch: string
  appVersion: string
  details: unknown
}

const MAX_DEPTH = 4
const MAX_ARRAY_ITEMS = 20
const MAX_OBJECT_KEYS = 40
const MAX_STRING_LENGTH = 500
const DEFAULT_LOG_FOLDER = 'performance'
const DEFAULT_LOG_FILENAME = 'mrt-performance'

const appStartHr = process.hrtime.bigint()
const sessionId = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`

let logFilePath: string | null = null
let isInitialized = false
let queuedRecords: PerfLogRecord[] = []
let appendChain: Promise<void> = Promise.resolve()

function getSinceAppStartMs(): number {
  return Number((process.hrtime.bigint() - appStartHr) / BigInt(1_000_000))
}

function getAppVersionSafe(): string {
  try {
    return app.getVersion()
  } catch {
    return process.env.npm_package_version || 'unknown'
  }
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.round(value * 1000) / 1000
}

function sanitizeUnknown(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[max-depth]'
  if (value == null) return null

  const valueType = typeof value
  if (valueType === 'number') {
    return Number.isFinite(value as number) ? value : null
  }
  if (valueType === 'string') {
    const text = value as string
    if (text.length <= MAX_STRING_LENGTH) return text
    return `${text.slice(0, MAX_STRING_LENGTH)}...[truncated]`
  }
  if (valueType === 'boolean') return value
  if (valueType === 'bigint') return (value as bigint).toString()
  if (valueType === 'function') return '[function]'
  if (valueType === 'symbol') return String(value)
  if (valueType === 'undefined') return null

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeUnknown(item, depth + 1))
  }

  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const entries = Object.entries(source).slice(0, MAX_OBJECT_KEYS)
  for (const [key, nestedValue] of entries) {
    out[key] = sanitizeUnknown(nestedValue, depth + 1)
  }
  return out
}

function normalizeLogInput(input: PerfLogInput): PerfLogRecord {
  const rendererDelta = toFiniteNumber(input.sinceRendererStartMs)
  return {
    ts: new Date().toISOString(),
    sessionId,
    processType: input.processType,
    event: String(input.event || 'unknown-event'),
    sinceAppStartMs: getSinceAppStartMs(),
    sinceRendererStartMs: rendererDelta,
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    appVersion: getAppVersionSafe(),
    details: sanitizeUnknown(input.details ?? null),
  }
}

function queueAppend(records: PerfLogRecord[]): void {
  if (!logFilePath || records.length === 0) return
  const chunk = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
  appendChain = appendChain
    .then(async () => {
      await fs.promises.appendFile(logFilePath as string, chunk, 'utf-8')
    })
    .catch((error) => {
      console.error('[perf] failed to append performance log chunk:', error)
    })
}

function flushQueuedRecords(): void {
  if (!logFilePath || queuedRecords.length === 0) return
  const snapshot = queuedRecords
  queuedRecords = []
  queueAppend(snapshot)
}

export async function initializePerformanceLogger(): Promise<string | null> {
  if (!ENABLE_DEBUG_TESTING) return null
  if (isInitialized && logFilePath) return logFilePath

  try {
    const logsRoot = path.join(app.getPath('logs'), DEFAULT_LOG_FOLDER)
    await fs.promises.mkdir(logsRoot, { recursive: true })
    const dayStamp = new Date().toISOString().slice(0, 10)
    logFilePath = path.join(logsRoot, `${DEFAULT_LOG_FILENAME}-${dayStamp}.log`)
    isInitialized = true
    flushQueuedRecords()
    return logFilePath
  } catch (error) {
    console.error('[perf] failed to initialize performance logger:', error)
    return null
  }
}

export function getPerformanceLogFilePath(): string | null {
  return ENABLE_DEBUG_TESTING ? logFilePath : null
}

export function logPerfEvent(input: PerfLogInput): void {
  if (!ENABLE_DEBUG_TESTING) return
  const record = normalizeLogInput(input)
  if (!isInitialized || !logFilePath) {
    queuedRecords.push(record)
    return
  }
  queueAppend([record])
}
