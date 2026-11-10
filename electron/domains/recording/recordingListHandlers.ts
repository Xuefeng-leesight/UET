import { ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as readline from 'node:readline'
import path from 'node:path'
import type { TimeSegment, TimelineMarker } from '../../../shared/domain/timeline'
import { parseRecordingCalibrationScores } from '../../../shared/domain/calibrationScores'
import {
  RECORD_POINTS_INDEX_VERSION,
  makeCsvPointParserState,
  parseCsvLineFast,
  parseCsvPartsToHeatmapPoint,
  writeTextFileAtomic,
  type CsvPointParserState,
} from './recordPointsModel'

export type RecordingListDependencies = {
  buildLocalResourceUrl: (filePath: string) => Promise<string>
  normalizeDataSamplingRateHz: (value: unknown) => number
  normalizeProjectDeviceModel: (value: unknown, deviceType?: unknown) => string
  normalizeProjectDeviceType: (value: unknown) => '桌面式' | '眼镜式'
  probeMediaDurationSeconds: (sourcePath: string) => Promise<number | undefined>
}

export function registerRecordingListHandlers(dependencies: RecordingListDependencies): void {
  const {
    buildLocalResourceUrl,
    normalizeDataSamplingRateHz,
    normalizeProjectDeviceModel,
    normalizeProjectDeviceType,
    probeMediaDurationSeconds,
  } = dependencies

  ipcMain.handle('load-recordings', async (_event, value: unknown) => {
    const payload = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const projectDir = typeof payload.projectDir === 'string' ? payload.projectDir : ''
    if (!projectDir) {
      return { ok: false, records: [] }
    }
  
    const recordingsDir = path.join(projectDir, 'recordings')
    const projectMeta = await (async (): Promise<Record<string, unknown> | null> => {
      try {
        const raw = await fs.promises.readFile(path.join(projectDir, 'project.json'), 'utf-8')
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
      } catch {
        return null
      }
    })()
    const projectDeviceType = normalizeProjectDeviceType(projectMeta?.deviceType)
    const projectDeviceModel = normalizeProjectDeviceModel(projectMeta?.deviceModel, projectDeviceType)
  
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(recordingsDir, { withFileTypes: true })
    } catch {
      entries = []
    }
  
    const readJsonIfExists = async (filePath: string): Promise<Record<string, unknown> | null> => {
      try {
        const raw = await fs.promises.readFile(filePath, 'utf-8')
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
      } catch {
        return null
      }
    }
    type RecordingFile = {
      path: string; stat: fs.Stats; subjectName: string; timestamp: string
      stableId?: string; integratedMeta?: Record<string, unknown>
    }
    const mp4ByKey = new Map<string, RecordingFile>()
    const csvByKey = new Map<string, RecordingFile>()
    const localFiles = new Map(entries.filter(entry => entry.isFile()).map(entry => [entry.name.toLowerCase(), entry.name]))
    const integratedMetadata = new Map<string, Record<string, unknown> | null>()
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const fullPath = path.join(recordingsDir, entry.name)
      const ext = path.extname(entry.name).toLowerCase()
      if (ext !== '.mp4' && ext !== '.csv') continue
      const name = path.basename(entry.name, path.extname(entry.name))
      const legacy = /^(.*?)_(\d{8}_\d{6})$/.exec(name)
      try {
        const stat = await fs.promises.stat(fullPath)
        let info: RecordingFile
        let key: string
        if (legacy) {
          const subjectName = legacy[1]
          if (subjectName.toLowerCase() === (ext === '.mp4' ? 'recording' : 'gaze')) continue
          key = `${subjectName}|${legacy[2]}`
          info = { path: fullPath, stat, subjectName, timestamp: legacy[2] }
        } else {
          // Earlier Huahong recordings used UUIDs without a date suffix. Only
          // accept the integrated recorder's local metadata; never follow paths
          // embedded in it or infer a vendor from the filename alone.
          if (!/^huahong_[a-f0-9]{12}$/i.test(name)) continue
          key = name.toLowerCase()
          if (!integratedMetadata.has(key)) {
            const metaName = localFiles.get(`${key}.meta.json`)
            integratedMetadata.set(key, metaName ? await readJsonIfExists(path.join(recordingsDir, metaName)) : null)
          }
          const meta = integratedMetadata.get(key)
          if (meta?.productIntegration !== true || !['HH_ET10C', 'HH_ET28'].includes(String(meta.deviceModel))) continue
          // The old metadata only has monotonic source time. Use file mtime for
          // display, while keeping the identity independent of time and subject.
          const date = stat.mtime
          const pad = (value: number) => String(value).padStart(2, '0')
          const timestamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
          info = { path: fullPath, stat, subjectName: name, timestamp, stableId: `rec_${key}`, integratedMeta: meta }
        }
        const target = ext === '.mp4' ? mp4ByKey : csvByKey
        target.set(key, info)
      } catch {
      }
    }
  
    const records: Array<Record<string, unknown>> = []
  
    const allKeys = new Set([...mp4ByKey.keys(), ...csvByKey.keys()])
  
    const recordingsSummaryVersion = 10
    const recordingsSummaryDir = path.join(projectDir, '.config')
    const recordingsSummaryPath = path.join(recordingsSummaryDir, 'recordings-summary.json')
    const facialRoot = path.join(projectDir, 'facial-analysis')
    const summarySourceNames = entries
      .filter((entry) => {
        if (!entry.isFile()) return false
        const lower = entry.name.toLowerCase()
        return lower.endsWith('.csv') || lower.endsWith('.mp4') || lower.endsWith('.meta.json')
      })
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right))
    const summarySourceStats = await Promise.all(
      summarySourceNames.map(async (name) => {
        try {
          const stat = await fs.promises.stat(path.join(recordingsDir, name))
          return [name, stat.size, Math.floor(stat.mtimeMs)]
        } catch {
          return [name, -1, -1]
        }
      }),
    )
    let facialSummaryStats: Array<[string, number, number]> = []
    try {
      const facialDirs = await fs.promises.readdir(facialRoot, { withFileTypes: true })
      const trackedFacialFiles = ['facial-video.json', path.join('source', 'face.mp4'), path.join('analysis', 'result.json')]
      facialSummaryStats = (await Promise.all(facialDirs.filter((entry) => entry.isDirectory()).flatMap((entry) => (
        trackedFacialFiles.map(async (relativePath) => {
          const signatureName = `${entry.name}/${relativePath.replace(/\\/g, '/')}`
          try {
            const stat = await fs.promises.stat(path.join(facialRoot, entry.name, relativePath))
            return [signatureName, stat.size, Math.floor(stat.mtimeMs)] as [string, number, number]
          } catch {
            return [signatureName, -1, -1] as [string, number, number]
          }
        })
      )))).sort((left, right) => left[0].localeCompare(right[0]))
    } catch {
    }
    const recordingsSummarySignature = createHash('sha256')
      .update(JSON.stringify({
        sources: summarySourceStats,
        facialSources: facialSummaryStats,
        projectDeviceType,
        projectDeviceModel,
      }))
      .digest('hex')
  
    try {
      const raw = await fs.promises.readFile(recordingsSummaryPath, 'utf-8')
      const cached = JSON.parse(raw)
      if (
        cached?.version === recordingsSummaryVersion &&
        cached?.signature === recordingsSummarySignature &&
        Array.isArray(cached?.records)
      ) {
        return { ok: true, records: cached.records, summaryCacheHit: true }
      }
    } catch {
    }
  
    const normalizeTimelineMarkers = (input: unknown): TimelineMarker[] => {
      if (!Array.isArray(input)) return []
      const out: TimelineMarker[] = []
  
      const toFinite = (value: unknown): number | null => {
        const n = typeof value === 'number' ? value : Number(value)
        if (!Number.isFinite(n)) return null
        return n
      }
  
      input.forEach((item, idx) => {
        if (!item || typeof item !== 'object') return
        const marker = item as Record<string, unknown>
        const rawTs = toFinite(marker.timestamp)
        if (rawTs === null) return
        const type = String(marker.type ?? '').trim()
        const shouldConvertMs = type === 'trigger' || type === 'custom'
        const timestamp = Math.max(0, shouldConvertMs ? rawTs / 1000 : rawTs)
        const triggerValue = toFinite(marker.triggerValue)
        const fallbackName =
          type === 'trigger'
            ? `Trigger ${triggerValue !== null ? triggerValue : ''}`.trim()
            : type === 'custom'
              ? '自定义标记'
              : `标记 ${idx + 1}`
        const name = String(marker.name ?? fallbackName).trim() || fallbackName
  
        out.push({
          id: typeof marker.id === 'string' && marker.id.trim() ? marker.id : `tm_${idx}_${Math.round(timestamp * 1000)}`,
          name,
          timestamp,
          color:
            typeof marker.color === 'string' && marker.color.trim()
              ? marker.color
              : type === 'trigger'
                ? '#ef4444'
                : type === 'custom'
                  ? '#8b5cf6'
                  : '#f97316',
          note: typeof marker.note === 'string' ? marker.note : undefined,
          createdAt: typeof marker.createdAt === 'string' && marker.createdAt ? marker.createdAt : new Date().toISOString(),
          updatedAt: typeof marker.updatedAt === 'string' && marker.updatedAt ? marker.updatedAt : new Date().toISOString(),
        })
      })
  
      out.sort((a, b) => a.timestamp - b.timestamp)
      return out
    }
  
    const normalizeTimeSegments = (input: unknown): TimeSegment[] => {
      if (!Array.isArray(input)) return []
      const out: TimeSegment[] = []
  
      const toFinite = (value: unknown): number | null => {
        const n = typeof value === 'number' ? value : Number(value)
        if (!Number.isFinite(n)) return null
        return n
      }
  
      input.forEach((item, idx) => {
        if (!item || typeof item !== 'object') return
        const segment = item as Record<string, unknown>
        const rawStart = toFinite(segment.startTime)
        const rawEnd = toFinite(segment.endTime)
        if (rawStart === null || rawEnd === null) return
  
        const startTime = Math.max(0, Math.min(rawStart, rawEnd))
        const endTime = Math.max(startTime + 0.05, Math.max(rawStart, rawEnd))
        out.push({
          id:
            typeof segment.id === 'string' && segment.id.trim()
              ? segment.id
              : `ts_${idx}_${Math.round(startTime * 1000)}_${Math.round(endTime * 1000)}`,
          name: String(segment.name ?? `分段 ${idx + 1}`).trim() || `分段 ${idx + 1}`,
          startTime,
          endTime,
          color: typeof segment.color === 'string' && segment.color.trim() ? segment.color : '#22c55e',
          enabled: segment.enabled !== false,
          note: typeof segment.note === 'string' ? segment.note : undefined,
          createdAt:
            typeof segment.createdAt === 'string' && segment.createdAt ? segment.createdAt : new Date().toISOString(),
          updatedAt:
            typeof segment.updatedAt === 'string' && segment.updatedAt ? segment.updatedAt : new Date().toISOString(),
        })
      })
  
      out.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
      return out
    }
  
    type CsvRecordMetrics = {
      durationSeconds?: number
      samplingRateHz?: number
      configuredSamplingRateHz?: number
      validityPercent?: number
    }
  
    const toOptionalFiniteNumber = (value: unknown): number | undefined => {
      const n = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(n) ? n : undefined
    }
  
    const metricsFromRecordMeta = (value: unknown): CsvRecordMetrics | null => {
      if (!value || typeof value !== 'object') return null
      const meta = value as Record<string, unknown>
      const durationSeconds = toOptionalFiniteNumber(meta.durationSeconds)
      const huahong = meta.deviceModel === 'HH_ET28' || meta.deviceModel === 'HH_ET10C'
      const gazeRows = typeof meta.gazeRows === 'number' && Number.isSafeInteger(meta.gazeRows) ? meta.gazeRows : undefined
      const samplingRateHz =
        huahong && typeof gazeRows === 'number' && gazeRows >= 0 && typeof durationSeconds === 'number' && durationSeconds > 0
          ? gazeRows / durationSeconds
          : typeof meta.samplingRateHz !== 'undefined'
          ? meta.deviceModel === 'PupilCore'
            ? toOptionalFiniteNumber(meta.gazeMessageRateHz ?? meta.samplingRateHz)
            : normalizeDataSamplingRateHz(meta.samplingRateHz)
          : undefined
      const configuredSamplingRateHz =
        typeof meta.configuredSamplingRateHz !== 'undefined'
          ? normalizeDataSamplingRateHz(meta.configuredSamplingRateHz)
          : undefined
      const validityPercent = toOptionalFiniteNumber(meta.validityPercent)
      const out: CsvRecordMetrics = {}
      if (typeof durationSeconds === 'number') out.durationSeconds = durationSeconds
      if (typeof samplingRateHz === 'number') out.samplingRateHz = samplingRateHz
      if (typeof configuredSamplingRateHz === 'number') out.configuredSamplingRateHz = configuredSamplingRateHz
      if (typeof validityPercent === 'number') out.validityPercent = validityPercent
      return Object.keys(out).length > 0 ? out : null
    }
  
    const mergeRecordMetrics = (...items: Array<CsvRecordMetrics | null | undefined>): CsvRecordMetrics | null => {
      const out: CsvRecordMetrics = {}
      for (const item of items) {
        if (!item) continue
        if (typeof item.durationSeconds === 'number' && Number.isFinite(item.durationSeconds)) out.durationSeconds = item.durationSeconds
        if (typeof item.samplingRateHz === 'number' && Number.isFinite(item.samplingRateHz)) out.samplingRateHz = item.samplingRateHz
        if (typeof item.configuredSamplingRateHz === 'number' && Number.isFinite(item.configuredSamplingRateHz)) {
          out.configuredSamplingRateHz = item.configuredSamplingRateHz
        }
        if (typeof item.validityPercent === 'number' && Number.isFinite(item.validityPercent)) out.validityPercent = item.validityPercent
      }
      return Object.keys(out).length > 0 ? out : null
    }
  
    const parseMetricTimeMs = (value: string): number => {
      const raw = String(value || '').trim()
      if (!raw) return NaN
      return Number(raw)
    }
  
    const metricsFromRecordPointsIndex = async (
      csvPath: string,
      stat: fs.Stats,
    ): Promise<CsvRecordMetrics | null> => {
      const parsed = path.parse(csvPath)
      const indexPath = path.join(parsed.dir, `${parsed.name}.points.index.json`)
      try {
        const raw = await fs.promises.readFile(indexPath, 'utf-8')
        const meta = JSON.parse(raw)
        if (!meta || typeof meta !== 'object') return null
        if (meta.version !== RECORD_POINTS_INDEX_VERSION) return null
        if (path.resolve(String(meta.sourceCsvPath || '')) !== path.resolve(csvPath)) return null
        if (Number(meta.sourceSizeBytes) !== Number(stat.size)) return null
        if (Math.floor(Number(meta.sourceMtimeMs || 0)) !== Math.floor(Number(stat.mtimeMs || 0))) return null
  
        const totalRows = toOptionalFiniteNumber(meta.totalRows) ?? 0
        const durationMs = toOptionalFiniteNumber(meta.durationMs) ?? 0
        const validRows =
          toOptionalFiniteNumber(meta.gazePointCount) ??
          toOptionalFiniteNumber(meta.fixationPointCount) ??
          0
        const durationSeconds = durationMs > 0 ? durationMs / 1000 : undefined
        const samplingRateHz =
          durationSeconds && durationSeconds > 0 && totalRows > 0
            ? normalizeDataSamplingRateHz(totalRows / durationSeconds)
            : undefined
        const validityPercent = totalRows > 0 ? (Math.max(0, validRows) / totalRows) * 100 : undefined
        const out: CsvRecordMetrics = {}
        if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)) out.durationSeconds = durationSeconds
        if (typeof samplingRateHz === 'number' && Number.isFinite(samplingRateHz)) {
          out.samplingRateHz = samplingRateHz
          out.configuredSamplingRateHz = samplingRateHz
        }
        if (typeof validityPercent === 'number' && Number.isFinite(validityPercent)) {
          out.validityPercent = Math.max(0, Math.min(100, validityPercent))
        }
        return Object.keys(out).length > 0 ? out : null
      } catch {
        return null
      }
    }
  
    const computeCsvMetrics = async (
      csvPath: string,
      metaMetrics: CsvRecordMetrics | null,
    ): Promise<CsvRecordMetrics | null> => {
      let stat: fs.Stats
      try {
        stat = await fs.promises.stat(csvPath)
      } catch {
        return metaMetrics
      }
  
      const indexedMetrics = await metricsFromRecordPointsIndex(csvPath, stat)
      if (
        indexedMetrics &&
        typeof indexedMetrics.durationSeconds === 'number' &&
        typeof indexedMetrics.samplingRateHz === 'number' &&
        typeof indexedMetrics.validityPercent === 'number'
      ) {
        return mergeRecordMetrics(indexedMetrics, metaMetrics)
      }
  
      let rowCount = 0
      let validCount = 0
      let firstMs: number | null = null
      let lastMs: number | null = null
      let headerParsed = false
      let timeIdx = -1
      let parserState: CsvPointParserState | null = null
  
      const normalizeMetricHeader = (value: unknown): string =>
        String(value || '').replace(/^\uFEFF/, '').trim().toLowerCase()
  
      try {
        const rs = fs.createReadStream(csvPath, { encoding: 'utf-8' })
        const rl = readline.createInterface({ input: rs, crlfDelay: Infinity })
        for await (const line of rl) {
          if (!headerParsed) {
            headerParsed = true
            const headers = parseCsvLineFast(line)
            const normalizedHeaders = headers.map(normalizeMetricHeader)
            const findHeader = (candidates: string[]): number => {
              const normalized = candidates.map(normalizeMetricHeader)
              for (let i = 0; i < normalizedHeaders.length; i += 1) {
                if (normalized.includes(normalizedHeaders[i])) return i
              }
              return -1
            }
            timeIdx = findHeader(['video_time_ms'])
            parserState = makeCsvPointParserState(headers, {
              includeMarkerOnlyRows: false,
              pointMode: 'gaze',
              isGlassesMode: projectDeviceType === '眼镜式',
            })
            continue
          }
          if (!line) continue
          const parts = parseCsvLineFast(line)
          rowCount += 1
          if (timeIdx >= 0 && timeIdx < parts.length) {
            const v = parseMetricTimeMs(parts[timeIdx])
            if (Number.isFinite(v)) {
              if (firstMs === null) firstMs = v
              lastMs = v
            }
          }
  
          if (parserState) {
            const point = parseCsvPartsToHeatmapPoint(parts, parserState)
            if (
              point &&
              !point.markerOnly &&
              typeof point.x === 'number' &&
              Number.isFinite(point.x) &&
              typeof point.y === 'number' &&
              Number.isFinite(point.y)
            ) {
              validCount += 1
            }
          }
        }
        rl.close()
        rs.close()
      } catch {
        return mergeRecordMetrics(indexedMetrics, metaMetrics)
      }
  
      const start = firstMs ?? 0
      const end = lastMs ?? 0
      const spanMs = Math.max(0, end - start)
      const durationSeconds = spanMs > 0 ? spanMs / 1000 : end > 0 && firstMs === null ? end / 1000 : undefined
      const samplingRateHz =
        typeof durationSeconds === 'number' && durationSeconds > 0 && rowCount > 0
          ? normalizeDataSamplingRateHz(rowCount / durationSeconds)
          : undefined
      const validityPercent = rowCount > 0 ? (validCount / rowCount) * 100 : undefined
  
      const computedMetrics: CsvRecordMetrics = {}
      if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)) computedMetrics.durationSeconds = durationSeconds
      if (typeof samplingRateHz === 'number' && Number.isFinite(samplingRateHz)) {
        computedMetrics.samplingRateHz = samplingRateHz
        computedMetrics.configuredSamplingRateHz = samplingRateHz
      }
      if (typeof validityPercent === 'number' && Number.isFinite(validityPercent)) {
        computedMetrics.validityPercent = Math.max(0, Math.min(100, validityPercent))
      }
      return mergeRecordMetrics(computedMetrics, indexedMetrics, metaMetrics)
    }
  
    for (const key of allKeys) {
      const mp4Info = mp4ByKey.get(key)
      const csvInfo = csvByKey.get(key)
      if (!mp4Info && !csvInfo) continue
  
      const parsedSubjectName = mp4Info?.subjectName || csvInfo?.subjectName || ''
      const ts = mp4Info?.timestamp || csvInfo?.timestamp || ''
  
      if (!ts) continue
  
      const datePart = ts.slice(0, 8)
      const timePart = ts.slice(9, 15)
      const year = datePart.slice(0, 4)
      const month = datePart.slice(4, 6)
      const day = datePart.slice(6, 8)
      const hour = timePart.slice(0, 2)
      const minute = timePart.slice(2, 4)
      const second = timePart.slice(4, 6)
      const humanTimestamp = `${year}-${month}-${day} ${hour}:${minute}:${second}`
  
      const id = mp4Info?.stableId || csvInfo?.stableId || `rec_${ts}_${parsedSubjectName || 'unknown'}`
      const name = mp4Info ? path.basename(mp4Info.path, path.extname(mp4Info.path)) : (csvInfo ? path.basename(csvInfo.path, path.extname(csvInfo.path)) : id)
  
      const metaPath = path.join(recordingsDir, `${name}.meta.json`)
      const meta = mp4Info?.integratedMeta || csvInfo?.integratedMeta || await readJsonIfExists(metaPath)
      const metaMetrics = metricsFromRecordMeta(meta)
      const storedDuration = metaMetrics?.durationSeconds
      const probedDuration =
        typeof storedDuration === 'number' && storedDuration > 0
          ? storedDuration
          : mp4Info?.path
            ? await probeMediaDurationSeconds(mp4Info.path)
            : undefined
      const authoritativeMetrics =
        typeof probedDuration === 'number'
          ? mergeRecordMetrics(metaMetrics, { durationSeconds: probedDuration })
          : metaMetrics
      const csvMetrics = csvInfo?.path
        ? await computeCsvMetrics(csvInfo.path, authoritativeMetrics)
        : authoritativeMetrics
  
      const duration = ''
      const fps = ''
      const timelineMarkers = normalizeTimelineMarkers(meta?.markers)
      const timelineSegments = normalizeTimeSegments(meta?.segments)
      const country = typeof meta?.country === 'string' ? meta.country : undefined
      const deviceType = normalizeProjectDeviceType(meta?.deviceType ?? projectDeviceType)
      const deviceModel = normalizeProjectDeviceModel(meta?.deviceModel ?? projectDeviceModel, deviceType)
      const calibrationScores = parseRecordingCalibrationScores(meta, deviceModel) ?? undefined
      const savedScores = meta?.calibrationScores
      const hasEt28Report = Boolean(meta && Object.hasOwn(meta, 'calibrationQuality'))
        || Boolean(savedScores && typeof savedScores === 'object' && Object.hasOwn(savedScores, 'et28Quality'))
      // The list carries normalized scores rather than the original metadata.
      // Do not let rejected ET28 reports revive through their old scalar aliases
      // when the renderer parses that normalized list again.
      const rejectedEt28Report = deviceModel === 'HH_ET28' && hasEt28Report && !calibrationScores
      const calibrationLeftScore = calibrationScores?.et28Quality ? calibrationScores.left
        : !rejectedEt28Report && typeof meta?.calibrationLeftScore === 'number' ? meta.calibrationLeftScore : undefined
      const calibrationRightScore = calibrationScores?.et28Quality ? calibrationScores.right
        : !rejectedEt28Report && typeof meta?.calibrationRightScore === 'number' ? meta.calibrationRightScore : undefined
      const configuredSamplingRateHz =
        typeof meta?.configuredSamplingRateHz === 'number'
          ? normalizeDataSamplingRateHz(meta.configuredSamplingRateHz)
          : csvMetrics
            ? csvMetrics.configuredSamplingRateHz
            : undefined
      const videoWidth =
        toOptionalFiniteNumber(meta?.encodedWidth) ??
        toOptionalFiniteNumber(meta?.eyeEventFrameWidth)
      const videoHeight =
        toOptionalFiniteNumber(meta?.encodedHeight) ??
        toOptionalFiniteNumber(meta?.eyeEventFrameHeight)
  
      const metaSubjectName = typeof meta?.subjectName === 'string' ? meta.subjectName.trim() : ''
      const subjectName = metaSubjectName || parsedSubjectName
      const integratedRecorder = ['PupilCore', 'HH_ET10C', 'HH_ET28'].includes(deviceModel)
      const missingArtifact = !mp4Info || !csvInfo
      const missingArtifactMessage = missingArtifact
        ? `录制文件不完整：缺少${!mp4Info ? '视频' : '眼动 CSV'}文件。`
        : undefined
  
      records.push({
        id,
        name,
        subjectName,
        timestamp: humanTimestamp,
        duration,
        fps,
        calibrationLeftScore,
        calibrationRightScore,
        calibrationScores,
        country,
        deviceType,
        deviceModel,
        samplingRateHz: csvMetrics ? csvMetrics.samplingRateHz : undefined,
        configuredSamplingRateHz,
        validityPercent: csvMetrics ? csvMetrics.validityPercent : undefined,
        durationSeconds: csvMetrics ? csvMetrics.durationSeconds : undefined,
        videoWidth,
        videoHeight,
        mp4Path: mp4Info?.path,
        mp4Url: mp4Info ? await buildLocalResourceUrl(mp4Info.path) : undefined,
        csvPath: csvInfo?.path,
        timelineMarkers: timelineMarkers.length > 0 ? timelineMarkers : undefined,
        timelineSegments: timelineSegments.length > 0 ? timelineSegments : undefined,
        modalities: {
          'eye-tracking': {
            status: integratedRecorder && (meta?.status !== 'complete' || missingArtifact)
              ? meta?.status === 'failed' ? 'failed' : 'partial' : csvInfo || mp4Info ? 'complete' : 'partial',
            ...(integratedRecorder ? {
              message: meta?.recoveredAfterInterruption === true
                ? '异常中断后已恢复部分数据，不能作为完整录制；原件保留在 .pupil 附档。'
                : meta?.error || meta?.recoveryError || missingArtifactMessage || (meta?.status === 'complete' ? undefined : '录制尚未完整收尾'),
              recordingStatus: meta?.status ?? 'unknown',
              recordingError: meta?.error ?? meta?.recoveryError,
              recoveredAfterInterruption: meta?.recoveredAfterInterruption === true,
            } : {}),
            sourcePath: mp4Info?.path,
            dataPath: csvInfo?.path,
          },
        },
      })
    }

    // Facial captures use their own storage tree. Merge them into the common
    // experiment record index so facial-only and multimodal sessions share one list.
    let facialEntries: fs.Dirent[] = []
    try {
      facialEntries = await fs.promises.readdir(facialRoot, { withFileTypes: true })
    } catch {
      facialEntries = []
    }
    for (const entry of facialEntries) {
      if (!entry.isDirectory()) continue
      const recordId = entry.name
      const recordDir = path.join(facialRoot, recordId)
      const manifestPath = path.join(recordDir, 'facial-video.json')
      const manifest = await readJsonIfExists(manifestPath)
      const relativeVideo = typeof manifest?.videoPath === 'string' ? manifest.videoPath : 'source/face.mp4'
      const videoPath = path.join(recordDir, relativeVideo)
      let videoExists = false
      let videoStat: fs.Stats | null = null
      try {
        videoStat = await fs.promises.stat(videoPath)
        videoExists = videoStat.isFile()
      } catch {
      }
      const analysisPath = path.join(recordDir, 'analysis', 'result.json')
      let analysisExists = false
      try {
        analysisExists = (await fs.promises.stat(analysisPath)).isFile()
      } catch {
      }
      if (!manifest && !videoExists && !analysisExists) continue

      const matching = records.find((record) => {
        const name = String(record.name || '').replace(/\.(mp4|csv)$/i, '')
        return name === recordId || String(record.id || '') === recordId
      })
      const facialResult = {
        status: videoExists ? 'complete' as const : 'partial' as const,
        sourcePath: videoExists ? videoPath : undefined,
        analysisPath: analysisExists ? analysisPath : undefined,
      }
      if (matching) {
        const modalities = matching.modalities && typeof matching.modalities === 'object'
          ? matching.modalities as Record<string, unknown>
          : {}
        matching.modalities = { ...modalities, 'facial-expression': facialResult }
        continue
      }

      const createdAt = typeof manifest?.createdAt === 'string'
        ? manifest.createdAt
        : videoStat?.mtime.toISOString() || new Date().toISOString()
      const timestamp = (() => {
        const match = /_(\d{8})_(\d{6})$/.exec(recordId)
        if (!match) return createdAt
        return `${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[1].slice(6, 8)} ${match[2].slice(0, 2)}:${match[2].slice(2, 4)}:${match[2].slice(4, 6)}`
      })()
      const subjectName = recordId.replace(/_\d{8}_\d{6}$/, '') || 'subject'
      const capture = manifest?.capture && typeof manifest.capture === 'object' ? manifest.capture as Record<string, unknown> : {}
      // Duration fallback chain: manifest capture.durationMs is authoritative,
      // but a manifest written without a duration (e.g. imported video, or a
      // stop that timed out after the video was already encoded) would leave
      // the list showing "—". Fall back to encodedDurationMs, then to the
      // analysis result's source.durationMs before giving up.
      let durationMs = toOptionalFiniteNumber(capture.durationMs) ?? toOptionalFiniteNumber(capture.encodedDurationMs)
      if (durationMs === undefined && analysisExists) {
        const analysis = await readJsonIfExists(analysisPath)
        const source = analysis?.source && typeof analysis.source === 'object' ? analysis.source as Record<string, unknown> : {}
        durationMs = toOptionalFiniteNumber(source.durationMs)
      }
      records.push({
        id: `facial:${recordId}`,
        name: recordId,
        subjectName,
        timestamp,
        duration: durationMs ? `${(durationMs / 1000).toFixed(1)}s` : '',
        fps: String(capture.fps || ''),
        durationSeconds: durationMs ? durationMs / 1000 : undefined,
        mp4Path: videoExists ? videoPath : undefined,
        mp4Url: videoExists ? await buildLocalResourceUrl(videoPath) : undefined,
        modalities: { 'facial-expression': facialResult },
      })
    }
  
    records.sort((a, b) => {
      if (a.timestamp < b.timestamp) return 1
      if (a.timestamp > b.timestamp) return -1
      return 0
    })
  
    try {
      await fs.promises.mkdir(recordingsSummaryDir, { recursive: true })
      await writeTextFileAtomic(
        recordingsSummaryPath,
        `${JSON.stringify({
          version: recordingsSummaryVersion,
          signature: recordingsSummarySignature,
          createdAt: new Date().toISOString(),
          records,
        })}\n`,
      )
    } catch (error) {
      console.warn('[recordings-summary] failed to persist cache', {
        projectDir,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  
    try {
      console.log('[main] load-recordings', {
        projectDir,
        count: records.length,
        sample: records.slice(0, 5).map(r => ({
          id: r.id,
          name: r.name,
          mp4Path: r.mp4Path,
          mp4Url: r.mp4Url,
          csvPath: r.csvPath,
        })),
      })
    } catch {
    }
  
    return {
      ok: true,
      records,
      summaryCacheHit: false,
    }
  })
  
}
