import * as fs from 'node:fs'
import * as readline from 'node:readline'
import path from 'node:path'
import type { AoiExportContext } from '../../../shared/contracts/domain/aoiExport'
import { createAoiExportRowDeriver, type AoiExportFixation, type AoiExportValues } from '../../../shared/domain/aoi/aoiExport'
import type { NormalizedAoiShape } from '../../../shared/domain/aoi/aoiReport'
import { finiteCsvNumber, makeExportRowReader, resolveExportMeasurement } from '../../../shared/domain/eyeExportData'
import { buildRecordPointsIndex, getRecordPointsIndexOptions, loadRecordPointsFromIndex } from './recordPointsIndex'
import { makeCsvPointParserState, parseCsvLineFast, parseCsvPartsToHeatmapPoint } from './recordCsvParser'

export const AOI_EXPORT_KEYS = new Set(['aoi_id', 'aoi_name', 'aoi_hit', 'aoi_enter_time_ms', 'aoi_exit_time_ms', 'aoi_dwell_time_ms', 'aoi_fixation_count'])
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

export function normalizeAoiExportContext(value: unknown): AoiExportContext | undefined {
  const source = object(value)
  if (!source || typeof source.projectDir !== 'string' || !source.projectDir.trim() || typeof source.recordId !== 'string' || !source.recordId.trim()) return undefined
  return { projectDir: source.projectDir, recordId: source.recordId,
    deviceType: typeof source.deviceType === 'string' ? source.deviceType : undefined,
    videoWidth: positive(source.videoWidth) ? source.videoWidth : undefined,
    videoHeight: positive(source.videoHeight) ? source.videoHeight : undefined,
    coordinateSpace: source.coordinateSpace === 'original-video' ? 'original-video' : 'mapping' }
}

async function readSource(csvPath: string): Promise<{ headers: string[]; model: string }> {
  const stream = fs.createReadStream(csvPath, { encoding: 'utf8' })
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let headers: string[] | null = null
  try {
    for await (const line of lines) {
      if (headers === null) {
        headers = parseCsvLineFast(line).map(value => value.replace(/^\uFEFF/, '').trim())
        if (!headers.some(value => value.toLowerCase() === 'source_model')) break
      } else if (line) {
        const index = headers.findIndex(value => value.toLowerCase() === 'source_model')
        const model = (parseCsvLineFast(line)[index] || '').trim()
        if (model) return { headers, model }
      }
    }
    return { headers: headers || [], model: '' }
  } finally { lines.close(); stream.destroy() }
}

async function loadShapes(context: AoiExportContext, model: string): Promise<NormalizedAoiShape[]> {
  const file = path.join(context.projectDir, 'visualization', 'aoi.json')
  let data: unknown
  try { data = JSON.parse(await fs.promises.readFile(file, 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(`无法读取 AOI 定义 ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const store = object(data)
  const scopes = object(store?.byRecordId)
  if (!store || ![2, 3].includes(Number(store.version)) || !scopes) throw new Error(`AOI 定义格式无效: ${file}`)
  const primary = `record:${context.recordId}`
  const legacyAllowed = context.deviceType === '眼镜式' || model === 'PupilCore'
  const source = Object.prototype.hasOwnProperty.call(scopes, primary) ? scopes[primary]
    : legacyAllowed && Object.prototype.hasOwnProperty.call(scopes, context.recordId) ? scopes[context.recordId] : undefined
  if (source === undefined) return []
  if (!Array.isArray(source)) throw new Error(`AOI 记录作用域不是数组: ${primary}`)
  return source.map((value): NormalizedAoiShape => {
    const row = object(value)
    if (!row || typeof row.id !== 'string' || !row.id.trim() || !['rect', 'ellipse', 'polygon'].includes(String(row.type))) {
      throw new Error(`AOI 图形定义无效: ${primary}`)
    }
    // Geometry stays exactly as stored. The pure deriver validates it; null must not become zero.
    return { ...row, id: row.id, name: typeof row.name === 'string' && row.name.trim() ? row.name : row.id,
      type: row.type as NormalizedAoiShape['type'], visible: row.visible !== false,
      showStats: row.showStats === true, color: typeof row.color === 'string' ? row.color : 'sky' } as NormalizedAoiShape
  })
}

/** The same full-source preparation and streaming row function serves preview and disk export. */
export async function createRecordAoiExportDeriver(csvPath: string, input: unknown): Promise<((row: string[]) => AoiExportValues) | undefined> {
  const context = normalizeAoiExportContext(input)
  if (!context) return undefined // Existing callers without AOI context retain raw CSV columns.
  const empty = createAoiExportRowDeriver({ shapes: [] })
  if (context.coordinateSpace !== 'original-video') return () => empty({ kind: 'annotation' })
  const source = await readSource(csvPath)
  const shapes = await loadShapes(context, source.model)
  if (!shapes.length) return source.model === 'PupilCore' ? () => empty({ kind: 'annotation' }) : undefined
  const headers = new Map(source.headers.map((header, index) => [header.toLowerCase(), index]))
  const read = makeExportRowReader(headers)
  const hasVideoTime = headers.has('video_time_ms')
  const isGlassesMode = context.deviceType === '眼镜式' || source.model === 'PupilCore'
  const dimensionsKnown = positive(context.videoWidth) && positive(context.videoHeight)
  let fixations: AoiExportFixation[] = []
  let fixationsAvailable = false
  if (hasVideoTime && dimensionsKnown) {
    const options = getRecordPointsIndexOptions({ isGlassesMode, frameWidth: context.videoWidth, frameHeight: context.videoHeight })
    const meta = await buildRecordPointsIndex(csvPath, await fs.promises.stat(csvPath), options)
    if (!meta) throw new Error('无法建立完整 AOI 注视索引；未使用抽样事件代替完整数据。')
    const indexed = await loadRecordPointsFromIndex(meta, 'fixation', { maxPoints: 1_000_000, exact: true, includeMarkerOnlyRows: false, includeSdkSaccades: false, pointSource: 'recommended' })
    if (indexed.truncated) throw new Error('AOI 注视索引不完整；未输出部分统计。')
    const completePoints = indexed.points.filter(point => point.fixationState === 4)
    fixationsAvailable = completePoints.every(point => point.timeBase === 'video_time_ms')
    fixations = completePoints.filter(point => point.timeBase === 'video_time_ms')
      .flatMap(point => {
        const start = point.fixationTimestampMs
        const duration = point.fixationDurationMs
        if (typeof start !== 'number' || !Number.isFinite(start) || start < 0 || !positive(duration) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
          fixationsAvailable = false
          return []
        }
        return [{ key: `${point.fixationSource || 'recorded'}:${point.id ?? 'unkeyed'}:${start}`, startTimeMs: start,
          durationMs: duration, x: point.x, y: point.y, complete: true }]
      })
  }
  const derive = createAoiExportRowDeriver({ shapes, fixations, fixationsAvailable })
  // Never use the parser's default dimensions to interpret a legacy pixel coordinate.
  const parser = dimensionsKnown ? makeCsvPointParserState(source.headers, { pointMode: 'gaze', pointSource: 'recommended', pupilSamplesOnly: true,
    isGlassesMode, frameWidth: context.videoWidth, frameHeight: context.videoHeight }) : null
  return row => {
    const event = read(row, 'source_event_type')
    if (event) return derive({ kind: 'event' })
    const marker = read(row, 'customMarker', 'triggerMark')
    const hasSample = read(row, 'gaze_valid', 'pupil_valid', 'fixation_state', 'fixationState', 'source_topic', 'source_timestamp_s', 'recom_gaze_x', 'recomGazeX', 'recom_gaze_y', 'recomGazeY')
    if (marker && !hasSample) return derive({ kind: 'annotation' })
    const timeMs = hasVideoTime ? finiteCsvNumber(read(row, 'video_time_ms')) : null
    const model = read(row, 'source_model')
    const isPupil = model === 'PupilCore'
    const late = read(row, 'gaze_source_order') === 'late_source_time'
    const validity = read(row, 'gaze_valid', 'pupil_valid')
    let x: number | null = null
    let y: number | null = null
    if (isPupil) {
      x = finiteCsvNumber(resolveExportMeasurement('recom_gaze_x', read(row, 'recom_gaze_x', 'recomGazeX'), row, headers, context))
      y = finiteCsvNumber(resolveExportMeasurement('recom_gaze_y', read(row, 'recom_gaze_y', 'recomGazeY'), row, headers, context))
    } else if (parser) {
      const point = parseCsvPartsToHeatmapPoint(row, parser)
      if (point && !point.markerOnly && point.samplePositionValid !== false) { x = point.x; y = point.y }
    }
    const pupilMask = finiteCsvNumber(read(row, 'recom_gaze_bit_mask'))
    const pupilValid = validity === '1' || (!validity && pupilMask !== null && (pupilMask & 1) !== 0)
    return derive({ timeMs, x, y, valid: !late && validity !== '0' && (!isPupil || pupilValid) && x !== null && y !== null,
      continuityKey: [model, read(row, 'source_backend'), read(row, 'source_generation'), read(row, 'source_topic'),
        read(row, 'gaze_mapping_mode'), read(row, 'gaze_rejected_eye_ids'), read(row, 'gaze_coordinate_space'), read(row, 'stimulus')].join('|'),
      breakBefore: isPupil && read(row, 'source_backend') === 'native' && read(row, 'gaze_source_order') === 'in_order' &&
        headers.has('gaze_velocity_px_ms') && finiteCsvNumber(read(row, 'gaze_velocity_px_ms')) === null,
    })
  }
}
