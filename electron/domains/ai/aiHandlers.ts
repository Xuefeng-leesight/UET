import { app, ipcMain, safeStorage } from 'electron'
import * as fs from 'node:fs'
import path from 'node:path'
import { validateUtf8Path } from '../filesystem/pathValidation'

function sanitizeReportFileStem(raw: unknown, fallback: string): string {
  let value = String(raw ?? '').trim()
  if (!value) return fallback
  value = value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/\s+/g, ' ')
  if (process.platform === 'win32') {
    value = value.replace(/[. ]+$/g, '')
    const reserved = new Set([
      'CON', 'PRN', 'AUX', 'NUL',
      'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
      'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
    ])
    if (reserved.has(value.toUpperCase())) value = `_${value}`
  }
  return value || fallback
}

type AiSettingsSecret = {
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
  timeoutMs: number
  apiKey: string
  hasApiKey: boolean
  updatedAt: string
  securityMode: 'encrypted' | 'plain'
}

type AiTokenUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

type AiCompressionMeta = {
  inputPointCount: number
  retainedPointCount: number
  sampledPointCount: number
  anomalyPointCount: number
  strategy: 'layered'
}

type AiOutputLanguage = 'zh-CN' | 'en-US'

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {}
}

function getErrorDetails(error: unknown): { code: string; message: string; retryable: boolean; name: string } {
  const record = asRecord(error)
  return {
    code: typeof record.code === 'string' ? record.code : '',
    message: error instanceof Error && error.message ? error.message : typeof record.message === 'string' ? record.message : '',
    retryable: record.retryable === true,
    name: error instanceof Error ? error.name : typeof record.name === 'string' ? record.name : '',
  }
}

const DEFAULT_AI_SETTINGS = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4.1-mini',
  temperature: 0.3,
  maxTokens: 1400,
  timeoutMs: 60000,
}

const AI_ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: { type: 'string' },
    },
    keyFindings: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['info', 'good', 'warn', 'risk'] },
          summary: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          recommendation: { type: 'string' },
        },
        required: ['title', 'severity', 'summary', 'evidence', 'recommendation'],
      },
    },
    risks: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['info', 'good', 'warn', 'risk'] },
          summary: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          recommendation: { type: 'string' },
        },
        required: ['title', 'severity', 'summary', 'evidence', 'recommendation'],
      },
    },
    recommendations: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: { type: 'string' },
    },
    warnings: {
      type: 'array',
      maxItems: 8,
      items: { type: 'string' },
    },
  },
  required: ['summary', 'keyFindings', 'risks', 'recommendations', 'warnings'],
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function normalizeAiBaseUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return DEFAULT_AI_SETTINGS.baseUrl
  return raw.replace(/\/+$/, '')
}

function getAiSettingsPath(): string {
  return path.join(app.getPath('userData'), 'config', 'ai_settings.json')
}

function maskApiKey(raw: string): string {
  if (!raw) return ''
  if (raw.length <= 8) return `${'*'.repeat(Math.max(0, raw.length - 2))}${raw.slice(-2)}`
  return `${raw.slice(0, 4)}${'*'.repeat(Math.max(4, raw.length - 8))}${raw.slice(-4)}`
}

function safeJsonStringify(payload: unknown): string {
  try {
    return JSON.stringify(payload)
  } catch {
    return '{}'
  }
}

function normalizeAiOutputLanguage(value: unknown): AiOutputLanguage {
  return value === 'en-US' ? 'en-US' : 'zh-CN'
}

function isEnglishAiOutput(language: AiOutputLanguage): boolean {
  return language === 'en-US'
}

function buildAiSystemPrompt(language: AiOutputLanguage): string {
  if (isEnglishAiOutput(language)) {
    return [
      'You are an eye-tracking experiment analysis assistant.',
      'You must output exactly one valid JSON object only.',
      'Do not output Markdown, code fences, comments, explanations, or any surrounding text.',
      'The JSON must contain: summary, keyFindings, risks, recommendations, warnings.',
      'All natural-language content in every field must be English only.',
      'Do not invent facts. Put uncertain or missing information into warnings.',
    ].join(' ')
  }
  return [
    '你是眼动实验分析助手。',
    '必须只输出一个合法 JSON 对象。',
    '不允许输出 Markdown、代码块、注释、解释或前后缀文本。',
    'JSON 字段必须包含：summary、keyFindings、risks、recommendations、warnings。',
    '所有自然语言内容都必须使用中文。',
    '避免杜撰，不确定或缺失的信息放入 warnings。',
  ].join(' ')
}

function meanAndStd(values: number[]): { mean: number; std: number } {
  if (!values.length) return { mean: 0, std: 0 }
  const mean = values.reduce((acc, value) => acc + value, 0) / values.length
  const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / values.length
  return { mean, std: Math.sqrt(Math.max(0, variance)) }
}

function percentile(sortedValues: number[], ratio: number): number {
  if (!sortedValues.length) return 0
  const clamped = Math.max(0, Math.min(1, ratio))
  const idx = Math.floor((sortedValues.length - 1) * clamped)
  return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, idx))]
}

function normalizeSeverity(value: unknown, fallback: 'info' | 'good' | 'warn' | 'risk'): 'info' | 'good' | 'warn' | 'risk' {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw === 'info' || raw === 'good' || raw === 'warn' || raw === 'risk') return raw
  return fallback
}

function sanitizeStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, maxItems)
}

function normalizeAiCards(
  value: unknown,
  fallbackSeverity: 'info' | 'good' | 'warn' | 'risk',
  outputLanguage: AiOutputLanguage,
): Array<{
  title: string
  severity: 'info' | 'good' | 'warn' | 'risk'
  summary: string
  evidence: string[]
  recommendation: string
}> {
  const useEnglish = isEnglishAiOutput(outputLanguage)
  if (!Array.isArray(value)) return []
  return value
    .map((item, idx) => {
      const raw = asRecord(item)
      const fallbackTitle = useEnglish ? `Finding ${idx + 1}` : `发现 ${idx + 1}`
      const fallbackSummary = useEnglish ? 'No summary available.' : '暂无摘要'
      const fallbackRecommendation = useEnglish
        ? 'Please cross-check with rule-based insights and raw records.'
        : '建议结合原始记录复核。'
      return {
        title: String(raw.title || fallbackTitle).trim() || fallbackTitle,
        severity: normalizeSeverity(raw.severity, fallbackSeverity),
        summary: String(raw.summary || '').trim() || fallbackSummary,
        evidence: sanitizeStringArray(raw.evidence, 6),
        recommendation: String(raw.recommendation || '').trim() || fallbackRecommendation,
      }
    })
    .slice(0, 6)
}

function tryParseJsonLoose(text: string): UnknownRecord | null {
  const raw = String(text || '').trim()
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as UnknownRecord : null
  } catch {
  }

  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) {
    const maybe = raw.slice(first, last + 1)
    try {
      const parsed: unknown = JSON.parse(maybe)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as UnknownRecord : null
    } catch {
    }
  }
  return null
}

function stripMarkdownCodeFence(text: string): string {
  const raw = String(text || '').trim()
  if (!raw) return ''
  if (raw.startsWith('```')) {
    return raw
      .replace(/^```[a-zA-Z0-9_-]*\s*/m, '')
      .replace(/```$/m, '')
      .trim()
  }
  return raw
}

function extractBracedObject(raw: string): string {
  const text = String(raw || '')
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) {
    return text.slice(first, last + 1)
  }
  return text
}

function normalizeJsonLikeText(raw: string): string {
  return String(raw || '')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
    .trim()
}

function tryParseStructuredResponse(text: string): UnknownRecord | null {
  const raw = String(text || '').trim()
  if (!raw) return null

  const fenceStripped = stripMarkdownCodeFence(raw)
  const objectExtracted = extractBracedObject(fenceStripped)
  const candidates = [
    raw,
    fenceStripped,
    objectExtracted,
    normalizeJsonLikeText(raw),
    normalizeJsonLikeText(fenceStripped),
    normalizeJsonLikeText(objectExtracted),
  ]

  for (const candidate of candidates) {
    const parsed = tryParseJsonLoose(candidate)
    if (parsed && typeof parsed === 'object') return parsed
  }

  return null
}

function coerceCompletionToStructuredFallback(text: string, outputLanguage: AiOutputLanguage): UnknownRecord | null {
  const raw = String(text || '').trim()
  if (!raw) return null
  const useEnglish = isEnglishAiOutput(outputLanguage)
  const lines = raw
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^[-*•\d\.\)\s]+/, '')
        .replace(/^["']?(summary|keyFindings|risks|recommendations|warnings)["']?\s*:\s*/i, '')
        .replace(/^[\[\]\{\}",\s]+/, '')
        .replace(/[\[\]\{\}",\s]+$/, '')
        .trim(),
    )
    .filter(Boolean)

  const summary = lines.slice(0, 3)
  const recommendations = lines.filter((line) => /建议|recommend|action|next/i.test(line)).slice(0, 5)
  const findings = (summary.length ? summary : lines.slice(0, 2)).map((line, idx) => ({
    title: useEnglish ? `Text Parsing Finding ${idx + 1}` : `文本解析发现 ${idx + 1}`,
    severity: 'warn',
    summary: line,
    evidence: [line],
    recommendation: useEnglish
      ? 'Please manually cross-check with rule-based insights and raw data.'
      : '建议结合规则洞察与原始数据人工复核。',
  }))

  return {
    summary: summary.length
      ? summary
      : [useEnglish ? 'Model did not return standard JSON; parsed from plain text automatically.' : '模型未返回标准 JSON，已按文本自动解析。'],
    keyFindings: findings,
    risks: [],
    recommendations: recommendations.length
      ? recommendations
      : [useEnglish ? 'Please manually cross-check with rule-based insights and raw data.' : '建议结合规则洞察与原始数据人工复核。'],
    warnings: [useEnglish ? 'Model did not follow JSON protocol; system downgraded to text parsing.' : '模型未按 JSON 协议返回，系统已自动降级为文本解析。'],
  }
}

async function loadAiSettingsSecret(): Promise<AiSettingsSecret> {
  const fallback: AiSettingsSecret = {
    ...DEFAULT_AI_SETTINGS,
    apiKey: '',
    hasApiKey: false,
    updatedAt: new Date().toISOString(),
    securityMode: safeStorage.isEncryptionAvailable() ? 'encrypted' : 'plain',
  }

  const settingsPath = getAiSettingsPath()
  try {
    const raw = await fs.promises.readFile(settingsPath, 'utf-8')
    const parsed = JSON.parse(raw || '{}')
    const next: AiSettingsSecret = {
      baseUrl: normalizeAiBaseUrl(parsed.baseUrl),
      model: typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : DEFAULT_AI_SETTINGS.model,
      temperature: clampNumber(parsed.temperature, 0, 2, DEFAULT_AI_SETTINGS.temperature),
      maxTokens: Math.round(clampNumber(parsed.maxTokens, 200, 8000, DEFAULT_AI_SETTINGS.maxTokens)),
      timeoutMs: Math.round(clampNumber(parsed.timeoutMs, 5000, 180000, DEFAULT_AI_SETTINGS.timeoutMs)),
      apiKey: '',
      hasApiKey: false,
      updatedAt: typeof parsed.updatedAt === 'string' && parsed.updatedAt.trim() ? parsed.updatedAt : new Date().toISOString(),
      securityMode: safeStorage.isEncryptionAvailable() ? 'encrypted' : 'plain',
    }

    if (typeof parsed.apiKeyCipherText === 'string' && parsed.apiKeyCipherText.trim()) {
      if (safeStorage.isEncryptionAvailable()) {
        try {
          const decrypted = safeStorage.decryptString(Buffer.from(parsed.apiKeyCipherText, 'base64')).trim()
          if (decrypted) {
            next.apiKey = decrypted
            next.hasApiKey = true
            next.securityMode = 'encrypted'
          }
        } catch {
        }
      }
    }

    if (!next.hasApiKey && typeof parsed.apiKeyPlainText === 'string' && parsed.apiKeyPlainText.trim()) {
      next.apiKey = parsed.apiKeyPlainText.trim()
      next.hasApiKey = true
      next.securityMode = 'plain'
    }

    return next
  } catch {
    return fallback
  }
}

function toPublicAiSettings(secret: AiSettingsSecret): {
  baseUrl: string
  model: string
  hasApiKey: boolean
  apiKeyMasked: string
  temperature: number
  maxTokens: number
  timeoutMs: number
  updatedAt: string
  securityMode: 'encrypted' | 'plain'
} {
  return {
    baseUrl: secret.baseUrl,
    model: secret.model,
    hasApiKey: secret.hasApiKey,
    apiKeyMasked: secret.hasApiKey ? maskApiKey(secret.apiKey) : '',
    temperature: secret.temperature,
    maxTokens: secret.maxTokens,
    timeoutMs: secret.timeoutMs,
    updatedAt: secret.updatedAt,
    securityMode: secret.securityMode,
  }
}

async function saveAiSettingsSecret(secret: AiSettingsSecret): Promise<{ ok: boolean; message?: string }> {
  const settingsPath = getAiSettingsPath()
  const configDir = path.dirname(settingsPath)
  const payload: UnknownRecord = {
    version: 1,
    baseUrl: normalizeAiBaseUrl(secret.baseUrl),
    model: String(secret.model || '').trim() || DEFAULT_AI_SETTINGS.model,
    temperature: clampNumber(secret.temperature, 0, 2, DEFAULT_AI_SETTINGS.temperature),
    maxTokens: Math.round(clampNumber(secret.maxTokens, 200, 8000, DEFAULT_AI_SETTINGS.maxTokens)),
    timeoutMs: Math.round(clampNumber(secret.timeoutMs, 5000, 180000, DEFAULT_AI_SETTINGS.timeoutMs)),
    updatedAt: secret.updatedAt || new Date().toISOString(),
  }

  const cleanedKey = String(secret.apiKey || '').trim()
  if (cleanedKey) {
    if (safeStorage.isEncryptionAvailable()) {
      try {
        payload.apiKeyCipherText = safeStorage.encryptString(cleanedKey).toString('base64')
      } catch (error: unknown) {
        return { ok: false, message: `密钥加密失败：${getErrorDetails(error).message || '未知错误'}` }
      }
    } else {
      payload.apiKeyPlainText = cleanedKey
    }
  }

  try {
    await fs.promises.mkdir(configDir, { recursive: true })
    await fs.promises.writeFile(settingsPath, JSON.stringify(payload, null, 2), 'utf-8')
    return { ok: true }
  } catch (error: unknown) {
    return { ok: false, message: `保存 AI 设置失败：${getErrorDetails(error).message || '未知错误'}` }
  }
}

// Throw a real Error (keeps stack traces) while carrying the code/retryable
// fields that getErrorDetails and IPC consumers expect.
function aiError(code: string, message: string, retryable = false): Error {
  return Object.assign(new Error(message), { code, retryable })
}

function normalizeAiError(responseStatus: number, errorBody: unknown): { code: string; message: string; retryable: boolean } {
  const bodyText = typeof errorBody === 'string' ? errorBody : safeJsonStringify(errorBody)
  const parsed = tryParseJsonLoose(bodyText)
  const parsedError = asRecord(parsed?.error)
  const message = String(parsedError.message || parsed?.message || bodyText || `HTTP ${responseStatus}`).trim() || `HTTP ${responseStatus}`

  if (responseStatus === 401 || responseStatus === 403) {
    return { code: 'auth_failed', message: `鉴权失败：${message}`, retryable: false }
  }
  if (responseStatus === 408) {
    return { code: 'timeout', message: `请求超时：${message}`, retryable: true }
  }
  if (responseStatus === 413) {
    return { code: 'context_too_large', message: `输入过大：${message}`, retryable: false }
  }
  if (responseStatus === 429) {
    return { code: 'rate_limited', message: `请求过于频繁：${message}`, retryable: true }
  }
  if (responseStatus >= 500) {
    return { code: 'provider_error', message: `模型服务异常：${message}`, retryable: true }
  }
  if (responseStatus === 400 && /response_format|json_schema|schema/i.test(message)) {
    return { code: 'unsupported_response_format', message, retryable: false }
  }
  return { code: 'bad_request', message: `请求失败：${message}`, retryable: false }
}

function extractCompletionText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item
        const record = asRecord(item)
        if (typeof record.text === 'string') return record.text
        return ''
      })
      .join('\n')
      .trim()
  }
  if (content && typeof content === 'object') {
    return safeJsonStringify(content)
  }
  return ''
}

function normalizeAiAnalysisResult(value: unknown, outputLanguage: AiOutputLanguage): {
  summary: string[]
  keyFindings: Array<{ title: string; severity: 'info' | 'good' | 'warn' | 'risk'; summary: string; evidence: string[]; recommendation: string }>
  risks: Array<{ title: string; severity: 'info' | 'good' | 'warn' | 'risk'; summary: string; evidence: string[]; recommendation: string }>
  recommendations: string[]
  warnings: string[]
} {
  const raw = asRecord(value)
  const useEnglish = isEnglishAiOutput(outputLanguage)
  const summary = sanitizeStringArray(raw.summary, 6)
  const keyFindings = normalizeAiCards(raw.keyFindings, 'warn', outputLanguage)
  const risks = normalizeAiCards(raw.risks, 'risk', outputLanguage)
  const recommendations = sanitizeStringArray(raw.recommendations, 8)
  const warnings = sanitizeStringArray(raw.warnings, 8)

  return {
    summary: summary.length
      ? summary
      : [useEnglish ? 'AI did not return a valid summary. Please review the rule-based insight first.' : '当前 AI 未返回有效摘要，建议先查看规则洞察结果。'],
    keyFindings,
    risks,
    recommendations: recommendations.length
      ? recommendations
      : [useEnglish ? 'Please manually cross-check with rule-based insights and raw records.' : '建议结合规则洞察和原始记录进行人工复核。'],
    warnings,
  }
}

function compressPointSeries(points: unknown, maxRetained: number): { points: UnknownRecord[]; meta: AiCompressionMeta } {
  const input = Array.isArray(points) ? points.map(asRecord) : []
  const inputCount = input.length
  if (inputCount === 0) {
    return {
      points: [],
      meta: {
        inputPointCount: 0,
        retainedPointCount: 0,
        sampledPointCount: 0,
        anomalyPointCount: 0,
        strategy: 'layered',
      },
    }
  }

  const safeMax = Math.max(80, Math.min(maxRetained, 4000))
  if (inputCount <= safeMax) {
    return {
      points: input.map((point) => ({
        timestamp: Number.isFinite(Number(point?.timestamp)) ? Number(point.timestamp) : null,
        x: Number.isFinite(Number(point?.x)) ? Number(point.x) : null,
        y: Number.isFinite(Number(point?.y)) ? Number(point.y) : null,
        weight: Number.isFinite(Number(point?.weight)) ? Number(point.weight) : null,
        stimulusName: String(point?.stimulusName || ''),
        leftPupilDiameter: Number.isFinite(Number(point?.leftPupilDiameter)) ? Number(point.leftPupilDiameter) : null,
        rightPupilDiameter: Number.isFinite(Number(point?.rightPupilDiameter)) ? Number(point.rightPupilDiameter) : null,
      })),
      meta: {
        inputPointCount: inputCount,
        retainedPointCount: inputCount,
        sampledPointCount: inputCount,
        anomalyPointCount: 0,
        strategy: 'layered',
      },
    }
  }

  const weights = input
    .map((item) => Number(item?.weight))
    .filter((value) => Number.isFinite(value)) as number[]
  const pupils = input
    .map((item) => {
      const left = Number(item?.leftPupilDiameter)
      const right = Number(item?.rightPupilDiameter)
      if (Number.isFinite(left) && Number.isFinite(right)) return (left + right) / 2
      if (Number.isFinite(left)) return left
      if (Number.isFinite(right)) return right
      return NaN
    })
    .filter((value) => Number.isFinite(value)) as number[]
  const deltas: number[] = []
  for (let idx = 1; idx < input.length; idx += 1) {
    const prevTs = Number(input[idx - 1]?.timestamp)
    const nextTs = Number(input[idx]?.timestamp)
    if (Number.isFinite(prevTs) && Number.isFinite(nextTs) && nextTs >= prevTs) {
      deltas.push(nextTs - prevTs)
    }
  }

  const weightStats = meanAndStd(weights)
  const pupilStats = meanAndStd(pupils)
  const deltaP95 = percentile([...deltas].sort((a, b) => a - b), 0.95)
  const anomalyIndexes = new Set<number>()

  for (let idx = 0; idx < input.length; idx += 1) {
    const current = input[idx]
    const ts = Number(current?.timestamp)
    const w = Number(current?.weight)
    const left = Number(current?.leftPupilDiameter)
    const right = Number(current?.rightPupilDiameter)
    const pupil = Number.isFinite(left) && Number.isFinite(right)
      ? (left + right) / 2
      : Number.isFinite(left) ? left : Number.isFinite(right) ? right : NaN

    let isAnomaly = false
    if (!Number.isFinite(ts)) isAnomaly = true
    if (Number.isFinite(w) && weightStats.std > 0 && Math.abs((w - weightStats.mean) / weightStats.std) >= 2.8) isAnomaly = true
    if (Number.isFinite(pupil) && pupilStats.std > 0 && Math.abs((pupil - pupilStats.mean) / pupilStats.std) >= 2.8) isAnomaly = true
    if (idx > 0 && deltaP95 > 0) {
      const prevTs = Number(input[idx - 1]?.timestamp)
      if (Number.isFinite(prevTs) && Number.isFinite(ts) && ts - prevTs > deltaP95 * 3) isAnomaly = true
    }

    if (isAnomaly) {
      for (let cursor = Math.max(0, idx - 2); cursor <= Math.min(input.length - 1, idx + 2); cursor += 1) {
        anomalyIndexes.add(cursor)
      }
    }
  }

  const selectedIndexes = new Set<number>()
  selectedIndexes.add(0)
  selectedIndexes.add(input.length - 1)
  for (const idx of anomalyIndexes) selectedIndexes.add(idx)

  const slotsLeft = Math.max(0, safeMax - selectedIndexes.size)
  if (slotsLeft > 0) {
    const step = (input.length - 1) / Math.max(1, slotsLeft - 1)
    for (let n = 0; n < slotsLeft; n += 1) {
      const idx = Math.round(n * step)
      selectedIndexes.add(Math.max(0, Math.min(input.length - 1, idx)))
      if (selectedIndexes.size >= safeMax) break
    }
  }

  const sortedSelected = Array.from(selectedIndexes.values()).sort((a, b) => a - b).slice(0, safeMax)
  const retainedPoints = sortedSelected.map((idx) => {
    const point = input[idx]
    return {
      timestamp: Number.isFinite(Number(point?.timestamp)) ? Number(point.timestamp) : null,
      x: Number.isFinite(Number(point?.x)) ? Number(point.x) : null,
      y: Number.isFinite(Number(point?.y)) ? Number(point.y) : null,
      weight: Number.isFinite(Number(point?.weight)) ? Number(point.weight) : null,
      stimulusName: String(point?.stimulusName || ''),
      leftPupilDiameter: Number.isFinite(Number(point?.leftPupilDiameter)) ? Number(point.leftPupilDiameter) : null,
      rightPupilDiameter: Number.isFinite(Number(point?.rightPupilDiameter)) ? Number(point.rightPupilDiameter) : null,
    }
  })

  return {
    points: retainedPoints,
    meta: {
      inputPointCount: inputCount,
      retainedPointCount: retainedPoints.length,
      sampledPointCount: retainedPoints.length,
      anomalyPointCount: anomalyIndexes.size,
      strategy: 'layered',
    },
  }
}

function compressCsvText(csvText: string, maxLines: number): {
  text: string
  inputLines: number
  retainedLines: number
} {
  const raw = String(csvText || '')
  if (!raw.trim()) {
    return { text: '', inputLines: 0, retainedLines: 0 }
  }

  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  const total = lines.length
  const safeLimit = Math.max(120, Math.min(maxLines, 3000))
  if (total <= safeLimit) {
    return { text: lines.join('\n'), inputLines: total, retainedLines: total }
  }

  const header = lines[0] || ''
  const body = lines.slice(1)
  const bodyLimit = Math.max(1, safeLimit - 1)

  const selected = new Set<number>()
  const edge = Math.min(120, Math.max(20, Math.floor(bodyLimit * 0.2)))
  for (let i = 0; i < edge && i < body.length; i += 1) selected.add(i)
  for (let i = Math.max(0, body.length - edge); i < body.length; i += 1) selected.add(i)

  const remaining = Math.max(0, bodyLimit - selected.size)
  if (remaining > 0 && body.length > 0) {
    const step = (body.length - 1) / Math.max(1, remaining - 1)
    for (let i = 0; i < remaining; i += 1) {
      const idx = Math.max(0, Math.min(body.length - 1, Math.round(i * step)))
      selected.add(idx)
      if (selected.size >= bodyLimit) break
    }
  }

  const picked = Array.from(selected.values())
    .sort((a, b) => a - b)
    .slice(0, bodyLimit)
    .map((idx) => body[idx])

  const retainedLines = [header, ...picked]
  return {
    text: retainedLines.join('\n'),
    inputLines: total,
    retainedLines: retainedLines.length,
  }
}

function mergeCompressionMeta(entries: AiCompressionMeta[]): AiCompressionMeta {
  return entries.reduce(
    (acc, item) => ({
      inputPointCount: acc.inputPointCount + item.inputPointCount,
      retainedPointCount: acc.retainedPointCount + item.retainedPointCount,
      sampledPointCount: acc.sampledPointCount + item.sampledPointCount,
      anomalyPointCount: acc.anomalyPointCount + item.anomalyPointCount,
      strategy: 'layered',
    }),
    {
      inputPointCount: 0,
      retainedPointCount: 0,
      sampledPointCount: 0,
      anomalyPointCount: 0,
      strategy: 'layered',
    } satisfies AiCompressionMeta,
  )
}

function compressAiInput(mode: 'single' | 'compare', value: unknown): {
  input: UnknownRecord
  compression: AiCompressionMeta
} {
  const rawInput = asRecord(value)
  if (mode === 'single') {
    const points = Array.isArray(rawInput?.rawPoints) ? rawInput.rawPoints : []
    const compressed = compressPointSeries(points, 320)
    const csvCompressed = compressCsvText(String(rawInput?.rawCsvText || ''), 900)
    return {
      input: {
        ...rawInput,
        rawPoints: compressed.points,
        rawCsvText: csvCompressed.text,
        rawCsvMeta: {
          inputLines: csvCompressed.inputLines,
          retainedLines: csvCompressed.retainedLines,
        },
      },
      compression: compressed.meta,
    }
  }

  const rawPointsByRecord = asRecord(rawInput.rawPointsByRecord)
  const byRecord = Object.fromEntries(
    Object.entries(rawPointsByRecord).filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1])),
  )
  const rawCsvByRecord = asRecord(rawInput.rawCsvByRecord)
  const recordIdSet = new Set<string>([...Object.keys(byRecord), ...Object.keys(rawCsvByRecord)])
  const recordIds = Array.from(recordIdSet.values())
  const perRecordBudget = Math.max(40, Math.floor(960 / Math.max(1, recordIds.length)))
  const nextByRecord: Record<string, UnknownRecord[]> = {}
  const nextCsvByRecord: Record<string, string> = {}
  const nextCsvMetaByRecord: Record<string, { inputLines: number; retainedLines: number }> = {}
  const metas: AiCompressionMeta[] = []

  for (const recordId of recordIds) {
    const compressed = compressPointSeries(byRecord[recordId], perRecordBudget)
    nextByRecord[recordId] = compressed.points
    metas.push(compressed.meta)

    const csvCompressed = compressCsvText(
      String(rawCsvByRecord[recordId] || ''),
      Math.max(80, Math.floor(900 / Math.max(1, recordIds.length))),
    )
    nextCsvByRecord[recordId] = csvCompressed.text
    nextCsvMetaByRecord[recordId] = {
      inputLines: csvCompressed.inputLines,
      retainedLines: csvCompressed.retainedLines,
    }
  }

  return {
    input: {
      ...rawInput,
      rawPointsByRecord: nextByRecord,
      rawCsvByRecord: nextCsvByRecord,
      rawCsvMetaByRecord: nextCsvMetaByRecord,
    },
    compression: mergeCompressionMeta(metas),
  }
}

function estimatePayloadChars(payload: unknown): number {
  return safeJsonStringify(payload).length
}

function deriveAdaptiveTimeoutMs(baseTimeoutMs: number, payload: unknown): number {
  const base = Math.max(5000, Math.min(180000, baseTimeoutMs))
  const chars = estimatePayloadChars(payload)
  let extra = 0
  if (chars > 600000) extra = 120000
  else if (chars > 350000) extra = 90000
  else if (chars > 200000) extra = 60000
  else if (chars > 120000) extra = 30000
  return Math.min(240000, base + extra)
}

function downsampleAiInputForRetry(mode: 'single' | 'compare', value: unknown): UnknownRecord {
  const input = asRecord(value)
  if (mode === 'single') {
    const points = Array.isArray(input?.rawPoints) ? input.rawPoints : []
    const compressedPoints = compressPointSeries(points, 120)
    const compressedCsv = compressCsvText(String(input?.rawCsvText || ''), 300)
    return {
      ...input,
      rawPoints: compressedPoints.points,
      rawCsvText: compressedCsv.text,
      rawCsvMeta: {
        inputLines: compressedCsv.inputLines,
        retainedLines: compressedCsv.retainedLines,
      },
      compressionRetryLevel: 'aggressive',
    }
  }

  const rawPointRecords = asRecord(input.rawPointsByRecord)
  const rawPointsByRecord = Object.fromEntries(
    Object.entries(rawPointRecords).filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1])),
  )
  const rawCsvByRecord = asRecord(input.rawCsvByRecord)
  const ids = Array.from(new Set([...Object.keys(rawPointsByRecord), ...Object.keys(rawCsvByRecord)]))
  const nextPointsByRecord: Record<string, UnknownRecord[]> = {}
  const nextCsvByRecord: Record<string, string> = {}
  const nextCsvMetaByRecord: Record<string, { inputLines: number; retainedLines: number }> = {}

  const pointBudget = Math.max(20, Math.floor(480 / Math.max(1, ids.length)))
  const csvBudget = Math.max(50, Math.floor(450 / Math.max(1, ids.length)))
  for (const id of ids) {
    const compressedPoints = compressPointSeries(rawPointsByRecord[id], pointBudget)
    const compressedCsv = compressCsvText(String(rawCsvByRecord[id] || ''), csvBudget)
    nextPointsByRecord[id] = compressedPoints.points
    nextCsvByRecord[id] = compressedCsv.text
    nextCsvMetaByRecord[id] = {
      inputLines: compressedCsv.inputLines,
      retainedLines: compressedCsv.retainedLines,
    }
  }

  return {
    ...input,
    rawPointsByRecord: nextPointsByRecord,
    rawCsvByRecord: nextCsvByRecord,
    rawCsvMetaByRecord: nextCsvMetaByRecord,
    compressionRetryLevel: 'aggressive',
  }
}

function getAiProviderLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin
  } catch {
    return baseUrl
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function invokeAiCompletion(params: {
  settings: AiSettingsSecret
  payload: unknown
  withSchema: boolean
  outputLanguage: AiOutputLanguage
}): Promise<{ parsed: UnknownRecord; usage?: AiTokenUsage }> {
  const { settings, payload, withSchema, outputLanguage } = params
  const endpoint = `${normalizeAiBaseUrl(settings.baseUrl)}/chat/completions`
  const controller = new AbortController()
  const adaptiveTimeoutMs = deriveAdaptiveTimeoutMs(settings.timeoutMs, payload)
  const timeoutTimer = setTimeout(() => {
    controller.abort()
  }, adaptiveTimeoutMs)

  const body: UnknownRecord = {
    model: settings.model,
    temperature: clampNumber(settings.temperature, 0, 2, DEFAULT_AI_SETTINGS.temperature),
    max_tokens: Math.round(clampNumber(settings.maxTokens, 200, 8000, DEFAULT_AI_SETTINGS.maxTokens)),
    messages: [
      {
        role: 'system',
        content: buildAiSystemPrompt(outputLanguage),
      },
      {
        role: 'user',
        content: safeJsonStringify(payload),
      },
    ],
  }
  if (withSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'mrt_ai_analysis',
        strict: true,
        schema: AI_ANALYSIS_SCHEMA,
      },
    }
  }

  let response: Response
  let text = ''
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    text = await response.text()
  } catch (error: unknown) {
    clearTimeout(timeoutTimer)
    const details = getErrorDetails(error)
    if (details.name === 'AbortError') {
      throw aiError('timeout', '请求超时，请检查网络或增大超时设置。', true)
    }
    throw aiError('network_error', `网络请求失败：${details.message || '未知错误'}`, true)
  } finally {
    clearTimeout(timeoutTimer)
  }

  if (!response.ok) {
    const normalized = normalizeAiError(response.status, text)
    throw normalized
  }

  const parsedResponse = tryParseJsonLoose(text)
  if (!parsedResponse) {
    const fallback = coerceCompletionToStructuredFallback(text, outputLanguage)
    if (fallback) {
      return { parsed: fallback }
    }
    throw aiError('invalid_response', '模型响应不可解析')
  }

  const choices = Array.isArray(parsedResponse.choices) ? parsedResponse.choices : []
  const firstChoice = asRecord(choices[0])
  const message = asRecord(firstChoice.message)
  const usageRecord = asRecord(parsedResponse.usage)
  const content = extractCompletionText(message.content)
  const parsed = tryParseStructuredResponse(content)
  if (!parsed || typeof parsed !== 'object') {
    const fallback = coerceCompletionToStructuredFallback(content, outputLanguage)
    if (fallback) {
      return {
        parsed: fallback,
        usage: parsedResponse.usage
          ? {
            promptTokens: Number(usageRecord.prompt_tokens || 0),
            completionTokens: Number(usageRecord.completion_tokens || 0),
            totalTokens: Number(usageRecord.total_tokens || 0),
          }
          : undefined,
      }
    }
    throw aiError('invalid_json', '模型未返回可解析的 JSON')
  }

  const usage: AiTokenUsage | undefined = parsedResponse.usage
    ? {
      promptTokens: Number(usageRecord.prompt_tokens || 0),
      completionTokens: Number(usageRecord.completion_tokens || 0),
      totalTokens: Number(usageRecord.total_tokens || 0),
    }
    : undefined

  return { parsed, usage }
}

async function runAiAnalysis(params: {
  settings: AiSettingsSecret
  mode: 'single' | 'compare'
  input: UnknownRecord
  outputLanguage: AiOutputLanguage
}): Promise<{ result: ReturnType<typeof normalizeAiAnalysisResult>; usage?: AiTokenUsage }> {
  const { settings, mode, input, outputLanguage } = params
  let lastError: unknown = null

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const basePayload = {
        mode,
        generatedAt: new Date().toISOString(),
        data: input,
      }
      try {
        const resultWithSchema = await invokeAiCompletion({
          settings,
          payload: basePayload,
          withSchema: true,
          outputLanguage,
        })
        return { result: normalizeAiAnalysisResult(resultWithSchema.parsed, outputLanguage), usage: resultWithSchema.usage }
      } catch (schemaError: unknown) {
        if (getErrorDetails(schemaError).code !== 'unsupported_response_format') throw schemaError
        const resultFallback = await invokeAiCompletion({
          settings,
          payload: {
            ...basePayload,
            output_contract: AI_ANALYSIS_SCHEMA,
          },
          withSchema: false,
          outputLanguage,
        })
        return { result: normalizeAiAnalysisResult(resultFallback.parsed, outputLanguage), usage: resultFallback.usage }
      }
    } catch (error: unknown) {
      lastError = error
      const retryable = getErrorDetails(error).retryable
      if (!retryable || attempt >= 2) break
      await delay((attempt + 1) * 450)
    }
  }

  const lastErrorDetails = getErrorDetails(lastError)
  const message = String(lastErrorDetails.message || 'AI 分析失败')
  const code = String(lastErrorDetails.code || 'analysis_failed')
  throw aiError(code, message)
}


export function registerAiHandlers(): void {
  ipcMain.handle('load-ai-settings', async () => {
    try {
      const loaded = await loadAiSettingsSecret()
      return { ok: true, settings: toPublicAiSettings(loaded) }
    } catch (error: unknown) {
      return { ok: false, settings: null, message: `加载 AI 设置失败：${getErrorDetails(error).message || '未知错误'}` }
    }
  })
  
  ipcMain.handle('save-ai-settings', async (_event, value: unknown) => {
    const payload = asRecord(value)
    const raw = asRecord(payload.settings)
    if (Object.keys(raw).length === 0) {
      return { ok: false, message: '参数错误：缺少 settings' }
    }
  
    try {
      const current = await loadAiSettingsSecret()
      const next: AiSettingsSecret = {
        ...current,
        baseUrl: normalizeAiBaseUrl(raw.baseUrl),
        model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : current.model,
        temperature: clampNumber(raw.temperature, 0, 2, current.temperature),
        maxTokens: Math.round(clampNumber(raw.maxTokens, 200, 8000, current.maxTokens)),
        timeoutMs: Math.round(clampNumber(raw.timeoutMs, 5000, 180000, current.timeoutMs)),
        updatedAt: new Date().toISOString(),
      }
  
      if (raw.clearApiKey === true) {
        next.apiKey = ''
        next.hasApiKey = false
      } else if (typeof raw.apiKey === 'string') {
        const cleaned = raw.apiKey.trim()
        if (cleaned) {
          next.apiKey = cleaned
          next.hasApiKey = true
        }
      }
  
      const saved = await saveAiSettingsSecret(next)
      if (!saved.ok) {
        return { ok: false, message: saved.message || '保存失败' }
      }
      return { ok: true, settings: toPublicAiSettings(next) }
    } catch (error: unknown) {
      return { ok: false, message: `保存 AI 设置失败：${getErrorDetails(error).message || '未知错误'}` }
    }
  })
  
  ipcMain.handle('test-ai-connection', async () => {
    const settings = await loadAiSettingsSecret()
    if (!settings.hasApiKey || !settings.apiKey.trim()) {
      return { ok: false, message: '尚未配置 API Key' }
    }
  
    const start = Date.now()
    let timer: NodeJS.Timeout | null = null
    try {
      const endpoint = `${normalizeAiBaseUrl(settings.baseUrl)}/chat/completions`
      const controller = new AbortController()
      timer = setTimeout(() => controller.abort(), Math.max(5000, settings.timeoutMs))
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model: settings.model,
          temperature: 0,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'reply with ok' }],
        }),
        signal: controller.signal,
      })
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (!res.ok) {
        const text = await res.text()
        const normalized = normalizeAiError(res.status, text)
        return {
          ok: false,
          message: normalized.message,
          model: settings.model,
          provider: getAiProviderLabel(settings.baseUrl),
          latencyMs: Date.now() - start,
        }
      }
      return {
        ok: true,
        model: settings.model,
        provider: getAiProviderLabel(settings.baseUrl),
        latencyMs: Date.now() - start,
      }
    } catch (error: unknown) {
      if (timer) {
        clearTimeout(timer)
      }
      return {
        ok: false,
        message: String(getErrorDetails(error).message || '连接失败'),
        model: settings.model,
        provider: getAiProviderLabel(settings.baseUrl),
        latencyMs: Date.now() - start,
      }
    }
  })
  
  ipcMain.handle('run-ai-analysis', async (_event, value: unknown) => {
    const payload = asRecord(value)
    const mode = payload.mode === 'single' || payload.mode === 'compare' ? payload.mode : null
    const input = payload.input
    const projectDir = typeof payload.projectDir === 'string' ? payload.projectDir.trim() : ''
    const outputLanguage = normalizeAiOutputLanguage(payload.outputLanguage)
    const useEnglish = isEnglishAiOutput(outputLanguage)
    if (!mode || !input || typeof input !== 'object') {
      return { ok: false, code: 'bad_payload', message: '参数错误：请提供 mode 与 input' }
    }
  
    const settings = await loadAiSettingsSecret()
    if (!settings.hasApiKey || !settings.apiKey.trim()) {
      return { ok: false, code: 'api_key_missing', message: '未配置 API Key，请先在设置中保存。' }
    }
  
    const compressed = compressAiInput(mode, input)
    let effectiveInput = compressed.input
    let effectiveCompression = compressed.compression
    let retriedByAggressiveCompression = false
  
    const buildUploadHint = (modeValue: 'single' | 'compare', currentInput: UnknownRecord): string => {
      if (modeValue === 'single') {
        const meta = asRecord(currentInput.rawCsvMeta)
        const inLines = Number(meta.inputLines || 0)
        const keptLines = Number(meta.retainedLines || 0)
        if (inLines > 0 && keptLines > 0) {
          return useEnglish
            ? `This upload: 1 raw CSV, ${keptLines}/${inLines} lines (after compression).`
            : `本次上传：1 个原始CSV，行数 ${keptLines}/${inLines}（压缩后）。`
        }
        return useEnglish ? 'This upload: 1 raw CSV.' : '本次上传：1 个原始CSV。'
      }
  
      const byRecord = asRecord(currentInput.rawCsvMetaByRecord)
      const ids = Object.keys(byRecord)
      const totals = ids.reduce(
        (acc, id) => {
          const item = asRecord(byRecord[id])
          return {
            input: acc.input + Number(item.inputLines || 0),
            retained: acc.retained + Number(item.retainedLines || 0),
          }
        },
        { input: 0, retained: 0 },
      )
      if (ids.length > 0 && totals.input > 0) {
        return useEnglish
          ? `This upload: ${ids.length} raw CSV files, ${totals.retained}/${totals.input} lines (after compression).`
          : `本次上传：${ids.length} 个原始CSV，行数 ${totals.retained}/${totals.input}（压缩后）。`
      }
      if (ids.length > 0) {
        return useEnglish ? `This upload: ${ids.length} raw CSV files.` : `本次上传：${ids.length} 个原始CSV。`
      }
      return ''
    }
    try {
      let analyzed: { result: ReturnType<typeof normalizeAiAnalysisResult>; usage?: AiTokenUsage }
      try {
        analyzed = await runAiAnalysis({
          settings,
          mode,
          input: effectiveInput,
          outputLanguage,
        })
      } catch (firstError: unknown) {
        const errorCode = getErrorDetails(firstError).code
        const shouldRetryAggressively = errorCode === 'timeout' || errorCode === 'context_too_large' || errorCode === 'provider_error'
        if (!shouldRetryAggressively) throw firstError
        effectiveInput = downsampleAiInputForRetry(mode, effectiveInput)
        retriedByAggressiveCompression = true
        analyzed = await runAiAnalysis({
          settings,
          mode,
          input: effectiveInput,
          outputLanguage,
        })
        analyzed.result.warnings = [
          ...(Array.isArray(analyzed.result.warnings) ? analyzed.result.warnings : []),
          useEnglish
            ? 'Request timed out. System retried with stronger compression; this result is based on compressed raw data.'
            : '请求超时后已自动进行更强压缩重试，本次结果基于压缩后的原始数据。',
        ]
      }
      const uploadHint = buildUploadHint(mode, effectiveInput)
      if (uploadHint) {
        analyzed.result.warnings = [
          ...(Array.isArray(analyzed.result.warnings) ? analyzed.result.warnings : []),
          uploadHint,
        ]
      }
  
      if (mode === 'single' && projectDir) {
        const pathValidation = await validateUtf8Path(projectDir)
        if (pathValidation.ok) {
          const reportId = `sai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          const record = asRecord(effectiveInput.record)
          const singleReport = {
            id: reportId,
            createdAt: new Date().toISOString(),
            recordId: String(record.recordId || effectiveInput?.recordId || ''),
            recordName: String(record.recordName || effectiveInput?.recordName || (useEnglish ? 'Untitled Record' : '未命名记录')),
            subjectName: String(record.subjectName || effectiveInput?.subjectName || ''),
            provider: getAiProviderLabel(settings.baseUrl),
            model: settings.model,
            compression: effectiveCompression,
            usage: analyzed.usage,
            result: analyzed.result,
          }
          const reportDir = path.join(projectDir, 'reports', 'ai', 'single')
          const reportPath = path.join(reportDir, `${sanitizeReportFileStem(reportId, reportId)}.json`)
          const latestPath = path.join(reportDir, 'latest.json')
          try {
            await fs.promises.mkdir(reportDir, { recursive: true })
            await fs.promises.writeFile(reportPath, JSON.stringify(singleReport, null, 2), 'utf-8')
            await fs.promises.writeFile(
              latestPath,
              JSON.stringify(
                {
                  id: reportId,
                  path: reportPath,
                  updatedAt: new Date().toISOString(),
                },
                null,
                2,
              ),
              'utf-8',
            )
            return {
              ok: true,
              mode,
              result: analyzed.result,
              compression: effectiveCompression,
              usage: analyzed.usage,
              provider: getAiProviderLabel(settings.baseUrl),
              model: settings.model,
              report: singleReport,
              path: reportPath,
            }
          } catch (error: unknown) {
            return {
              ok: true,
              mode,
              result: analyzed.result,
              compression: effectiveCompression,
              usage: analyzed.usage,
              provider: getAiProviderLabel(settings.baseUrl),
              model: settings.model,
              message: `AI 分析已完成，但保存单记录报告失败：${getErrorDetails(error).message || '未知错误'}`,
            }
          }
        }
      }
  
      return {
        ok: true,
        mode,
        result: analyzed.result,
        compression: effectiveCompression,
        usage: analyzed.usage,
        provider: getAiProviderLabel(settings.baseUrl),
        model: settings.model,
        retriedByAggressiveCompression,
      }
    } catch (error: unknown) {
      const details = getErrorDetails(error)
      return {
        ok: false,
        code: String(details.code || 'analysis_failed'),
        message: String(details.message || 'AI 分析失败'),
      }
    }
  })
  
  ipcMain.handle('load-single-ai-report', async (_event, value: unknown) => {
    const payload = asRecord(value)
    const projectDir = typeof payload.projectDir === 'string' ? payload.projectDir.trim() : ''
    const recordIdFilter = typeof payload.recordId === 'string' ? payload.recordId.trim() : ''
    if (!projectDir) {
      return { ok: false, message: '缺少工程目录', report: null }
    }
  
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, message: `路径验证失败：${pathValidation.error}`, report: null }
    }
  
    const reportDir = path.join(projectDir, 'reports', 'ai', 'single')
    try {
      const entries = await fs.promises.readdir(reportDir, { withFileTypes: true })
      const candidates = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json') && entry.name !== 'latest.json')
        .map((entry) => entry.name)
  
      if (candidates.length === 0) {
        return { ok: true, report: null }
      }
  
      const parsedReports: Array<{ report: UnknownRecord; mtimeMs: number }> = []
      for (const fileName of candidates) {
        const fullPath = path.join(reportDir, fileName)
        try {
          const [raw, stat] = await Promise.all([
            fs.promises.readFile(fullPath, 'utf-8'),
            fs.promises.stat(fullPath),
          ])
          const report = asRecord(JSON.parse(raw))
          if (Object.keys(report).length === 0) continue
          if (recordIdFilter && String(report.recordId || '') !== recordIdFilter) continue
          parsedReports.push({ report, mtimeMs: Number(stat?.mtimeMs || 0) })
        } catch {
        }
      }
  
      if (parsedReports.length === 0) {
        return { ok: true, report: null }
      }
  
      parsedReports.sort((a, b) => b.mtimeMs - a.mtimeMs)
      return { ok: true, report: parsedReports[0].report }
    } catch {
      return { ok: true, report: null }
    }
  })
  
}
