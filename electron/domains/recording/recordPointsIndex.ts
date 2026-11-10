import * as fs from 'node:fs'
import path from 'node:path'
import { RECORD_POINTS_PARSE_VERSION } from '../../../shared/constants/recordPoints'
import { createFallbackFixationDetector } from '../../../shared/domain/fixationDetection'
import type { BlinkIntervalData } from '../../../shared/contracts/domain/analysis'
import { createRecordedBlinkCollector } from './recordBlinkIntervals'
import {
  makeCsvPointParserState,
  parseCsvLineFast,
  parseCsvPartsToHeatmapPoint,
  type CsvPointParserState,
  type MainHeatmapPoint,
} from './recordCsvParser'

export const DEFAULT_MAX_RECORD_POINTS = 250_000
// Exact statistics must never silently decimate a record. Keep IPC/memory bounded.
export const MAX_EXACT_ANALYSIS_POINTS = 1_000_000
export const RECORD_POINTS_INDEX_VERSION = 5
const RECORD_POINTS_INDEX_BLOCK_MS = 10_000

type RecordPointsIndexMode = 'fixation' | 'gaze'

type RecordPointsIndexOptions = {
  isGlassesMode: boolean
  frameWidth: number
  frameHeight: number
}

type RecordPointsIndexMeta = {
  version: number
  parseVersion: number
  timeBase: 'video_time_ms' | 'timestamp'
  sourceCsvPath: string
  sourceSizeBytes: number
  sourceMtimeMs: number
  createdAt: string
  blockSizeMs: number
  totalRows: number
  durationMs: number
  minVideoTimeMs: number
  maxVideoTimeMs: number
  fixationPointCount: number
  gazePointCount: number
  analysisEventCount: number
  isGlassesMode: boolean
  frameWidth: number
  frameHeight: number
  blocks: Array<{
    startMs: number
    endMs: number
    byteOffset: number
  }>
  files: {
    analysis: string
  }
}

const recordPointsIndexBuildTasks = new Map<string, Promise<RecordPointsIndexMeta | null>>()

const normalizeIndexFrameSize = (value: unknown, fallback: number): number => {
  const n = Math.round(Number(value))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const getRecordPointsIndexOptions = (input: unknown): RecordPointsIndexOptions => {
  const payload = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  return {
    isGlassesMode: payload.isGlassesMode === true,
    frameWidth: normalizeIndexFrameSize(payload.frameWidth, 1280),
    frameHeight: normalizeIndexFrameSize(payload.frameHeight, 720),
  }
}

export const getRecordPointsIndexPaths = (csvPath: string) => {
  const parsed = path.parse(csvPath)
  const base = path.join(parsed.dir, parsed.name)
  return {
    metaPath: `${base}.points.index.json`,
    analysisPath: `${base}.analysis-events.csv`,
    legacyFixationPath: `${base}.fixation.events.jsonl`,
    legacyGazePath: `${base}.gaze.blocks.jsonl`,
  }
}

const compactMainHeatmapPoint = (point: MainHeatmapPoint): MainHeatmapPoint => {
  const out: MainHeatmapPoint = {
    x: point.x,
    y: point.y,
  }
  const copy = <K extends keyof MainHeatmapPoint>(key: K) => {
    const value = point[key]
    if (value !== undefined) {
      Object.assign(out, { [key]: value })
    }
  }
  copy('weight')
  copy('id')
  copy('timestamp')
  copy('timeBase')
  copy('fixationState')
  copy('fixationTimestampMs')
  copy('fixationDurationMs')
  copy('fixationSource')
  copy('blink')
  copy('leftBlink')
  copy('rightBlink')
  copy('pupilDiameter')
  copy('leftPupilDiameter')
  copy('rightPupilDiameter')
  copy('saccadeMetricUnit')
  copy('saccadeDurationMs')
  copy('saccadeAmplitude')
  copy('saccadeVelocity')
  copy('saccadePeakVelocity')
  copy('saccadeStartX')
  copy('saccadeStartY')
  copy('saccadeEndX')
  copy('saccadeEndY')
  copy('stimulusName')
  copy('marker')
  copy('triggerMark')
  copy('customMarker')
  copy('markerOnly')
  copy('parseVersion')
  return out
}

export const getPointTimestampMs = (point: MainHeatmapPoint): number => {
  const ts = Number(point.timestamp)
  return Number.isFinite(ts) ? Math.max(0, ts) : 0
}

const iterateCsvLinesWithOffsets = async function* (
  filePath: string,
  startOffset = 0,
): AsyncGenerator<{ line: string; byteOffset: number }> {
  const stream = fs.createReadStream(filePath, { start: startOffset })
  let pending = Buffer.alloc(0)
  let pendingOffset = startOffset
  for await (const chunkRaw of stream) {
    const chunk = Buffer.isBuffer(chunkRaw) ? chunkRaw : Buffer.from(chunkRaw)
    pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
    let lineStart = 0
    for (let index = 0; index < pending.length; index += 1) {
      if (pending[index] !== 0x0a) continue
      let lineEnd = index
      if (lineEnd > lineStart && pending[lineEnd - 1] === 0x0d) lineEnd -= 1
      yield {
        line: pending.subarray(lineStart, lineEnd).toString('utf-8'),
        byteOffset: pendingOffset + lineStart,
      }
      lineStart = index + 1
    }
    if (lineStart > 0) {
      pending = pending.subarray(lineStart)
      pendingOffset += lineStart
    }
  }
  if (pending.length > 0) {
    let lineEnd = pending.length
    if (pending[lineEnd - 1] === 0x0d) lineEnd -= 1
    yield {
      line: pending.subarray(0, lineEnd).toString('utf-8'),
      byteOffset: pendingOffset,
    }
  }
}

const ANALYSIS_EVENT_COLUMNS: Array<keyof MainHeatmapPoint> = [
  'x',
  'y',
  'weight',
  'id',
  'timestamp',
  'fixationState',
  'fixationTimestampMs',
  'fixationDurationMs',
  'blink',
  'leftBlink',
  'rightBlink',
  'pupilDiameter',
  'leftPupilDiameter',
  'rightPupilDiameter',
  'saccadeDurationMs',
  'saccadeAmplitude',
  'saccadeVelocity',
  'saccadePeakVelocity',
  'saccadeStartX',
  'saccadeStartY',
  'saccadeEndX',
  'saccadeEndY',
  'stimulusName',
  'marker',
  'triggerMark',
  'customMarker',
  'markerOnly',
  'parseVersion',
  'fixationSource',
  'timeBase',
  'saccadeMetricUnit',
]

const encodeAnalysisCsvCell = (value: unknown): string => {
  if (value === undefined || value === null) return ''
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const encodeAnalysisEvent = (point: MainHeatmapPoint): string =>
  ANALYSIS_EVENT_COLUMNS.map((key) => encodeAnalysisCsvCell(point[key])).join(',')

const parseAnalysisEvent = (parts: string[]): MainHeatmapPoint | null => {
  const valueAt = (key: keyof MainHeatmapPoint): string => {
    const index = ANALYSIS_EVENT_COLUMNS.indexOf(key)
    return index >= 0 ? String(parts[index] || '').trim() : ''
  }
  const numberAt = (key: keyof MainHeatmapPoint): number | undefined => {
    const raw = valueAt(key)
    if (!raw) return undefined
    const value = Number(raw)
    return Number.isFinite(value) ? value : undefined
  }
  const booleanAt = (key: keyof MainHeatmapPoint): boolean | undefined => {
    const raw = valueAt(key)
    if (!raw) return undefined
    return raw === 'true' || raw === '1'
  }
  const x = numberAt('x')
  const y = numberAt('y')
  if (x === undefined || y === undefined) return null
  const point: MainHeatmapPoint = { x, y }
  const numericKeys: Array<keyof MainHeatmapPoint> = [
    'weight', 'id', 'timestamp', 'fixationState', 'fixationTimestampMs', 'fixationDurationMs',
    'pupilDiameter', 'leftPupilDiameter', 'rightPupilDiameter', 'saccadeDurationMs',
    'saccadeAmplitude', 'saccadeVelocity', 'saccadePeakVelocity', 'saccadeStartX',
    'saccadeStartY', 'saccadeEndX', 'saccadeEndY', 'parseVersion',
  ]
  for (const key of numericKeys) {
    const value = numberAt(key)
    if (value !== undefined) Object.assign(point, { [key]: value })
  }
  const booleanKeys: Array<keyof MainHeatmapPoint> = ['blink', 'leftBlink', 'rightBlink', 'markerOnly']
  for (const key of booleanKeys) {
    const value = booleanAt(key)
    if (value !== undefined) Object.assign(point, { [key]: value })
  }
  const stringKeys: Array<keyof MainHeatmapPoint> = ['stimulusName', 'marker', 'triggerMark', 'customMarker']
  for (const key of stringKeys) {
    const value = valueAt(key)
    if (value) Object.assign(point, { [key]: value })
  }
  if (valueAt('fixationSource') === 'mrt_7invensun_fallback') point.fixationSource = 'mrt_7invensun_fallback'
  if (valueAt('timeBase') === 'video_time_ms') point.timeBase = 'video_time_ms'
  if (valueAt('saccadeMetricUnit') === 'pixels') point.saccadeMetricUnit = 'pixels'
  else if (valueAt('saccadeMetricUnit') === 'normalized') point.saccadeMetricUnit = 'normalized'
  return point
}

import { writeTextFileAtomic } from '../../platform/fs/atomicWrite'
export { writeTextFileAtomic } from '../../platform/fs/atomicWrite'

const isRecordPointsIndexMetaValid = async (
  meta: unknown,
  csvPath: string,
  stat: fs.Stats,
  options: RecordPointsIndexOptions,
  paths: ReturnType<typeof getRecordPointsIndexPaths>,
): Promise<boolean> => {
  if (!meta || typeof meta !== 'object') return false
  const candidate = meta as Partial<RecordPointsIndexMeta>
  if (candidate.version !== RECORD_POINTS_INDEX_VERSION) return false
  if (candidate.parseVersion !== RECORD_POINTS_PARSE_VERSION) return false
  if (path.resolve(String(candidate.sourceCsvPath || '')) !== path.resolve(csvPath)) return false
  if (Number(candidate.sourceSizeBytes) !== Number(stat.size)) return false
  if (Math.floor(Number(candidate.sourceMtimeMs || 0)) !== Math.floor(Number(stat.mtimeMs || 0))) return false
  if (Number(candidate.blockSizeMs) !== RECORD_POINTS_INDEX_BLOCK_MS) return false
  if (Boolean(candidate.isGlassesMode) !== options.isGlassesMode) return false
  if (Number(candidate.frameWidth) !== options.frameWidth || Number(candidate.frameHeight) !== options.frameHeight) return false
  if (!Array.isArray(candidate.blocks) || candidate.blocks.length === 0) return false
  if (path.resolve(path.dirname(paths.metaPath), String(candidate.files?.analysis || '')) !== path.resolve(paths.analysisPath)) return false
  try {
    await fs.promises.access(paths.analysisPath, fs.constants.F_OK)
  } catch {
    return false
  }
  return true
}

const readRecordPointsIndexMeta = async (
  csvPath: string,
  stat: fs.Stats,
  options: RecordPointsIndexOptions,
): Promise<RecordPointsIndexMeta | null> => {
  const paths = getRecordPointsIndexPaths(csvPath)
  try {
    const raw = await fs.promises.readFile(paths.metaPath, 'utf-8')
    const meta = JSON.parse(raw)
    if (await isRecordPointsIndexMetaValid(meta, csvPath, stat, options, paths)) {
      return meta
    }
  } catch {
  }
  return null
}

export const buildRecordPointsIndex = async (
  csvPath: string,
  stat: fs.Stats,
  options: RecordPointsIndexOptions,
): Promise<RecordPointsIndexMeta | null> => {
  const paths = getRecordPointsIndexPaths(csvPath)
  const existing = await readRecordPointsIndexMeta(csvPath, stat, options)
  if (existing) return existing

  const taskKey = [
    path.resolve(csvPath),
    stat.size,
    Math.floor(stat.mtimeMs),
    options.isGlassesMode ? 'glasses' : 'desktop',
    options.frameWidth,
    options.frameHeight,
  ].join('|')
  const currentTask = recordPointsIndexBuildTasks.get(taskKey)
  if (currentTask) return currentTask

  const task = (async (): Promise<RecordPointsIndexMeta | null> => {
    const tempSuffix = `.tmp-${process.pid}-${Date.now()}`
    const analysisTempPath = `${paths.analysisPath}${tempSuffix}`
    let headerParsed = false
    let fixationParserState: CsvPointParserState | null = null
    let gazeParserState: CsvPointParserState | null = null
    let totalRows = 0
    let minVideoTimeMs = Infinity
    let maxVideoTimeMs = -Infinity
    let hasVideoTime = false
    let fixationPointCount = 0
    let gazePointCount = 0
    const blocks: RecordPointsIndexMeta['blocks'] = []
    const analysisEvents: MainHeatmapPoint[] = []
    // Use the same event stream for mapping, visualization and AOI. Existing
    // events remain authoritative, including recordings with incomplete events.
    let hasRecordedFixations = false
    const fallbackEvents: MainHeatmapPoint[] = []
    const fallback = createFallbackFixationDetector({
      ...options,
      onFixation: (point) => fallbackEvents.push({ ...point, parseVersion: RECORD_POINTS_PARSE_VERSION }),
    })
    let lastBlockStart = -1
    let nextSyntheticSaccadeId = 1
    let activeSaccade: MainHeatmapPoint | null = null
    let activeStimulusName = ''

    const finishActiveSaccade = () => {
      if (!activeSaccade) return
      analysisEvents.push(activeSaccade)
      activeSaccade = null
    }
    const addStimulusBoundary = (stimulusName: string, timestamp: number) => {
      if (!stimulusName || !Number.isFinite(timestamp)) return
      analysisEvents.push({
        x: 0,
        y: 0,
        timestamp: Math.max(0, timestamp),
        timeBase: hasVideoTime ? 'video_time_ms' : undefined,
        stimulusName,
        markerOnly: true,
        parseVersion: RECORD_POINTS_PARSE_VERSION,
      })
    }

    try {
      for await (const entry of iterateCsvLinesWithOffsets(csvPath)) {
        const { line, byteOffset } = entry
        if (!headerParsed) {
          headerParsed = true
          const headers = parseCsvLineFast(line)
          fixationParserState = makeCsvPointParserState(headers, {
            includeMarkerOnlyRows: true,
            includeSdkSaccades: true,
            pointMode: 'fixation',
            isGlassesMode: options.isGlassesMode,
            frameWidth: options.frameWidth,
            frameHeight: options.frameHeight,
          })
          gazeParserState = makeCsvPointParserState(headers, {
            includeMarkerOnlyRows: false,
            pointMode: 'gaze',
            pointSource: 'recommended',
            isGlassesMode: options.isGlassesMode,
            frameWidth: options.frameWidth,
            frameHeight: options.frameHeight,
          })
          continue
        }
        if (!line) continue
        totalRows += 1
        if (!fixationParserState) continue
        const parts = parseCsvLineFast(line)
        const recordedState = Number(parts[fixationParserState.indexes.fixState])
        const eventType = String(parts[fixationParserState.indexes.sourceEventType] || '').trim()
        if (recordedState === 3 || recordedState === 4 || eventType === 'fixation') {
          hasRecordedFixations = true
          fallbackEvents.length = 0
        }
        const rawVideoTime = fixationParserState.indexes.videoTime >= 0
          ? Number(parts[fixationParserState.indexes.videoTime])
          : Number(parts[fixationParserState.indexes.timestamp])
        if (Number.isFinite(rawVideoTime)) {
          if (fixationParserState.indexes.videoTime >= 0) hasVideoTime = true
          minVideoTimeMs = Math.min(minVideoTimeMs, rawVideoTime)
          maxVideoTimeMs = Math.max(maxVideoTimeMs, rawVideoTime)
          const blockStart = Math.floor(Math.max(0, rawVideoTime) / RECORD_POINTS_INDEX_BLOCK_MS)
            * RECORD_POINTS_INDEX_BLOCK_MS
          if (blockStart !== lastBlockStart) {
            blocks.push({
              startMs: blockStart,
              endMs: blockStart + RECORD_POINTS_INDEX_BLOCK_MS,
              byteOffset,
            })
            lastBlockStart = blockStart
          }
          const nextStimulusName = fixationParserState.indexes.stimulus >= 0
            ? String(parts[fixationParserState.indexes.stimulus] || '').trim()
            : ''
          if (nextStimulusName !== activeStimulusName) {
            addStimulusBoundary(activeStimulusName, rawVideoTime)
            addStimulusBoundary(nextStimulusName, rawVideoTime)
            activeStimulusName = nextStimulusName
          }
        }
        const gazePoint = gazeParserState
          ? parseCsvPartsToHeatmapPoint(parts, gazeParserState)
          : null
        // Event-only rows are not samples; invalid gaze rows and gaps do end a
        // candidate. Detect before any windowing, decimation or heatmap binning.
        if (!hasRecordedFixations) {
          if (eventType === 'blink' || eventType === 'saccade' || recordedState === 1 || recordedState === 2) {
            fallback.add(null)
          } else if (!eventType) {
            fallback.add(gazePoint)
          }
        }
        if (
          gazePoint &&
          !gazePoint.markerOnly &&
          Number.isFinite(gazePoint.x) &&
          Number.isFinite(gazePoint.y)
        ) {
          gazePointCount += 1
        }
        const fixationPoint = parseCsvPartsToHeatmapPoint(parts, fixationParserState)
        if (fixationPoint) {
          const compact = compactMainHeatmapPoint(fixationPoint)
          const state = Number(compact.fixationState)
          if (compact.markerOnly) {
            analysisEvents.push(compact)
          } else if (state === 1 || state === 2) {
            const ts = getPointTimestampMs(compact)
            const compactId = Number(compact.id)
            const activeId = Number(activeSaccade?.id)
            if (
              activeSaccade
              && Number.isFinite(compactId)
              && Number.isFinite(activeId)
              && compactId !== activeId
            ) {
              finishActiveSaccade()
            }
            if (!activeSaccade) {
              activeSaccade = {
                ...compact,
                id: Number.isFinite(compactId) ? compact.id : nextSyntheticSaccadeId++,
                timestamp: ts,
                fixationState: 2,
                saccadeStartX: compact.saccadeStartX ?? compact.x,
                saccadeStartY: compact.saccadeStartY ?? compact.y,
              }
            } else {
              const startTs = getPointTimestampMs(activeSaccade)
              activeSaccade = {
                ...activeSaccade,
                x: compact.x,
                y: compact.y,
                weight: Math.max(0, ts - startTs),
                saccadeDurationMs: compact.saccadeDurationMs ?? Math.max(0, ts - startTs),
                saccadeAmplitude: compact.saccadeAmplitude ?? activeSaccade.saccadeAmplitude,
                saccadeVelocity: compact.saccadeVelocity ?? activeSaccade.saccadeVelocity,
                saccadePeakVelocity: compact.saccadePeakVelocity ?? activeSaccade.saccadePeakVelocity,
                saccadeEndX: compact.saccadeEndX ?? compact.x,
                saccadeEndY: compact.saccadeEndY ?? compact.y,
              }
            }
          } else {
            finishActiveSaccade()
            if (state === 4) {
              fixationPointCount += 1
              analysisEvents.push(compact)
            }
          }
        } else {
          finishActiveSaccade()
        }
      }
      finishActiveSaccade()
      if (!hasRecordedFixations) {
        fallback.finish()
        fixationPointCount = fallbackEvents.length
        for (const point of fallbackEvents) analysisEvents.push(point)
      }
      addStimulusBoundary(activeStimulusName, maxVideoTimeMs)
      analysisEvents.sort((left, right) => getPointTimestampMs(left) - getPointTimestampMs(right))
      const analysisText = [
        ANALYSIS_EVENT_COLUMNS.join(','),
        ...analysisEvents.map(encodeAnalysisEvent),
      ].join('\n') + '\n'
      await fs.promises.writeFile(analysisTempPath, analysisText, 'utf-8')
      await fs.promises.rename(analysisTempPath, paths.analysisPath)

      if (!Number.isFinite(minVideoTimeMs)) minVideoTimeMs = 0
      if (!Number.isFinite(maxVideoTimeMs)) maxVideoTimeMs = 0
      if (blocks.length === 0) {
        blocks.push({ startMs: 0, endMs: RECORD_POINTS_INDEX_BLOCK_MS, byteOffset: 0 })
      }

      const meta: RecordPointsIndexMeta = {
        version: RECORD_POINTS_INDEX_VERSION,
        parseVersion: RECORD_POINTS_PARSE_VERSION,
        timeBase: hasVideoTime ? 'video_time_ms' : 'timestamp',
        sourceCsvPath: path.resolve(csvPath),
        sourceSizeBytes: stat.size,
        sourceMtimeMs: Math.floor(stat.mtimeMs),
        createdAt: new Date().toISOString(),
        blockSizeMs: RECORD_POINTS_INDEX_BLOCK_MS,
        totalRows,
        durationMs: Math.max(0, maxVideoTimeMs - minVideoTimeMs),
        minVideoTimeMs,
        maxVideoTimeMs,
        fixationPointCount,
        gazePointCount,
        analysisEventCount: analysisEvents.length,
        isGlassesMode: options.isGlassesMode,
        frameWidth: options.frameWidth,
        frameHeight: options.frameHeight,
        blocks,
        files: {
          analysis: path.basename(paths.analysisPath),
        },
      }
      await writeTextFileAtomic(paths.metaPath, `${JSON.stringify(meta, null, 2)}\n`)
      return meta
    } catch (error) {
      await fs.promises.rm(analysisTempPath, { force: true }).catch(() => {})
      throw error
    }
  })()

  recordPointsIndexBuildTasks.set(taskKey, task)
  try {
    return await task
  } finally {
    recordPointsIndexBuildTasks.delete(taskKey)
  }
}

export const createMainPointSampler = (maxPoints: number) => {
  let parsedPoints = 0
  let sampleStride = 1
  let truncated = false
  const points: MainHeatmapPoint[] = []
  const compactEvenSamplesInPlace = () => {
    let writeIndex = 0
    for (let readIndex = 0; readIndex < points.length; readIndex += 2) {
      points[writeIndex] = points[readIndex]
      writeIndex += 1
    }
    points.length = writeIndex
  }
  const addPoint = (point: MainHeatmapPoint) => {
    parsedPoints += 1
    if (parsedPoints % sampleStride !== 0) {
      truncated = true
      return
    }
    points.push(point)
    if (points.length >= maxPoints) {
      truncated = true
      sampleStride *= 2
      compactEvenSamplesInPlace()
    }
  }
  return {
    addPoint,
    finish: () => ({
      points,
      parsedPoints,
      truncated,
    }),
  }
}

export const pointMatchesLoadOptions = (
  point: MainHeatmapPoint,
  params: {
    includeMarkerOnlyRows: boolean
    includeSdkSaccades?: boolean
    startTimeMs?: number
    endTimeMs?: number
  },
): boolean => {
  if (point.markerOnly && !params.includeMarkerOnlyRows) return false
  const fixationState = Number(point.fixationState)
  if ((fixationState === 1 || fixationState === 2) && params.includeSdkSaccades !== true) return false
  const ts = getPointTimestampMs(point)
  if (typeof params.startTimeMs === 'number' && Number.isFinite(params.startTimeMs) && ts < params.startTimeMs) return false
  if (typeof params.endTimeMs === 'number' && Number.isFinite(params.endTimeMs) && ts > params.endTimeMs) return false
  return true
}

export const loadRecordPointsFromIndex = async (
  meta: RecordPointsIndexMeta,
  mode: RecordPointsIndexMode,
  params: {
    maxPoints: number
    includeMarkerOnlyRows: boolean
    includeSdkSaccades?: boolean
    pointSource?: 'recommended' | 'raw' | 'smooth'
    startTimeMs?: number
    endTimeMs?: number
    exact?: boolean
    pupilSamplesOnly?: boolean
  },
) => {
  const sampler = createMainPointSampler(params.exact ? Number.POSITIVE_INFINITY : params.maxPoints)
  let blinkData: BlinkIntervalData | undefined
  let exactCount = 0
  const addPoint = (point: MainHeatmapPoint) => {
    if (params.pupilSamplesOnly) {
      if (point.markerOnly || !(typeof point.pupilDiameter === 'number' && point.pupilDiameter > 0)) return
      point = {
        x: point.x, y: point.y, timestamp: point.timestamp, timeBase: point.timeBase,
        stimulusName: point.stimulusName, pupilDiameter: point.pupilDiameter,
        leftPupilDiameter: point.leftPupilDiameter, rightPupilDiameter: point.rightPupilDiameter,
        sampleOnly: true,
        samplePositionValid: point.samplePositionValid !== false,
      }
    }
    exactCount += 1
    if (params.exact && exactCount > MAX_EXACT_ANALYSIS_POINTS) {
      throw new Error('精确统计数据超过当前 100 万点上限；本次统计未生成，未使用抽样值代替完整统计。')
    }
    sampler.addPoint(point)
  }
  const paths = getRecordPointsIndexPaths(meta.sourceCsvPath)
  if (mode === 'fixation') {
    let headerParsed = false
    let columnIndexes: number[] = []
    for await (const entry of iterateCsvLinesWithOffsets(paths.analysisPath)) {
      const line = entry.line
      if (!headerParsed) {
        headerParsed = true
        const headers = parseCsvLineFast(line).map((value) => value.trim())
        columnIndexes = ANALYSIS_EVENT_COLUMNS.map((column) => headers.indexOf(String(column)))
        continue
      }
      if (!line) continue
      const sourceParts = parseCsvLineFast(line)
      const orderedParts = columnIndexes.map((index) => index >= 0 ? sourceParts[index] : '')
      const point = parseAnalysisEvent(orderedParts)
      if (!point || !pointMatchesLoadOptions(point, params)) continue
      addPoint(point)
    }
  } else {
    let headers: string[] = []
    let firstDataByteOffset = 0
    for await (const entry of iterateCsvLinesWithOffsets(meta.sourceCsvPath)) {
      if (headers.length === 0) {
        headers = parseCsvLineFast(entry.line)
        continue
      }
      firstDataByteOffset = entry.byteOffset
      break
    }
    if (headers.length === 0) return { ...sampler.finish(), blinkData }
    if (firstDataByteOffset <= 0) return { ...sampler.finish(), blinkData }
    const blinkCollector = params.pupilSamplesOnly ? createRecordedBlinkCollector(headers) : null
    const parserState = makeCsvPointParserState(headers, {
      includeMarkerOnlyRows: params.includeMarkerOnlyRows,
      pointMode: 'gaze',
      pupilSamplesOnly: params.pupilSamplesOnly,
      pointSource: params.pointSource || 'smooth',
      isGlassesMode: meta.isGlassesMode,
      frameWidth: meta.frameWidth,
      frameHeight: meta.frameHeight,
    })
    const requestedStart = typeof params.startTimeMs === 'number' && Number.isFinite(params.startTimeMs)
      ? params.startTimeMs
      : Number.NEGATIVE_INFINITY
    let startOffset = firstDataByteOffset
    for (const block of meta.blocks) {
      if (block.startMs <= requestedStart) startOffset = block.byteOffset
      else break
    }
    // Complete pairs can straddle the requested sample window; read their
    // source phases before applying statistical window intersections later.
    startOffset = params.pupilSamplesOnly ? firstDataByteOffset : Math.max(firstDataByteOffset, startOffset)
    for await (const entry of iterateCsvLinesWithOffsets(meta.sourceCsvPath, startOffset)) {
      if (!entry.line) continue
      const parts = parseCsvLineFast(entry.line)
      blinkCollector?.addRow(parts)
      const point = parseCsvPartsToHeatmapPoint(parts, parserState)
      if (!point) continue
      const ts = getPointTimestampMs(point)
      if (
        typeof params.endTimeMs === 'number' &&
        Number.isFinite(params.endTimeMs) &&
        ts > params.endTimeMs && !params.pupilSamplesOnly
      ) break
      if (pointMatchesLoadOptions(point, params)) addPoint(point)
    }
    blinkData = blinkCollector?.finish()
  }
  return { ...sampler.finish(), blinkData }
}

