import { ipcMain } from 'electron'
import * as fs from 'node:fs'
import * as readline from 'node:readline'
import { computeAoiStatsRows } from '../../../shared/domain/aoi/aoiReport'
import { createRecordAoiExportDeriver } from './recordAoiExport'
import {
  DEFAULT_MAX_RECORD_POINTS,
  buildRecordPointsIndex,
  createMainPointSampler,
  finalizeMainHeatmapPoints,
  getPointTimestampMs,
  getRecordPointsIndexOptions,
  getRecordPointsIndexPaths,
  inspectGlassesModeSample,
  loadRecordPointsFromIndex,
  makeCsvPointParserState,
  parseCsvLineFast,
  parseCsvPartsToHeatmapPoint,
  pointMatchesLoadOptions,
  type CsvPointParserState,
  type MainHeatmapPoint,
} from './recordPointsModel'

const DEFAULT_CSV_PREVIEW_ROWS = 100

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function registerRecordPointHandlers(): void {
  ipcMain.handle('preview-record-csv', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const csvPath = typeof payload?.csvPath === 'string' ? payload.csvPath : ''
    const maxRows = Math.max(1, Math.min(1000, Math.round(Number(payload?.maxRows) || DEFAULT_CSV_PREVIEW_ROWS)))
    if (!csvPath) {
      return { ok: false, headers: [], rows: [], message: '参数错误' }
    }
    try {
      const stat = await fs.promises.stat(csvPath)
      const rs = fs.createReadStream(csvPath, { encoding: 'utf-8' })
      const rl = readline.createInterface({ input: rs, crlfDelay: Infinity })
      let headers: string[] = []
      const rows: string[][] = []
      let seenHeader = false
      let truncated = false
      for await (const line of rl) {
        if (!seenHeader) {
          headers = parseCsvLineFast(line).map((h) => String(h || '').replace(/^\uFEFF/, '').trim())
          seenHeader = true
          continue
        }
        if (!line) continue
        if (rows.length >= maxRows) {
          truncated = true
          break
        }
        rows.push(parseCsvLineFast(line).map((cell) => cell.trim()))
      }
      rl.close()
      rs.close()
      const deriveAoi = await createRecordAoiExportDeriver(csvPath, payload.aoiContext)
      return { ok: true, headers, rows, fileSizeBytes: stat.size, truncated,
        ...(deriveAoi ? { derivedAoiRows: rows.map(deriveAoi) } : {}) }
    } catch (error: unknown) {
      return { ok: false, headers: [], rows: [], message: error instanceof Error ? error.message : '读取 CSV 失败' }
    }
  })
  
  const aggregateHeatmapPoints = (
    source: MainHeatmapPoint[],
    maxPoints: number,
    viewportWidth: number,
    viewportHeight: number,
  ): MainHeatmapPoint[] => {
    if (source.length <= maxPoints) return source
    const markers = source.filter((point) => point.markerOnly)
    const availableCells = Math.max(100, maxPoints - markers.length)
    const aspect = Math.max(0.25, Math.min(4, viewportWidth / Math.max(1, viewportHeight)))
    const columns = Math.max(1, Math.floor(Math.sqrt(availableCells * aspect)))
    const rows = Math.max(1, Math.floor(availableCells / columns))
    type Cell = { x: number; y: number; weight: number; count: number; point: MainHeatmapPoint }
    const cells = new Map<number, Cell>()
    for (const point of source) {
      if (point.markerOnly || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
      const normalizedX = Math.max(0, Math.min(0.999999, Number(point.x)))
      const normalizedY = Math.max(0, Math.min(0.999999, Number(point.y)))
      const column = Math.floor(normalizedX * columns)
      const row = Math.floor(normalizedY * rows)
      const key = row * columns + column
      const weight = Number.isFinite(Number(point.weight)) ? Math.max(0.000001, Number(point.weight)) : 1
      const current = cells.get(key)
      if (!current) {
        cells.set(key, { x: point.x * weight, y: point.y * weight, weight, count: 1, point })
      } else {
        current.x += point.x * weight
        current.y += point.y * weight
        current.weight += weight
        current.count += 1
        if (getPointTimestampMs(point) < getPointTimestampMs(current.point)) current.point = point
      }
    }
    const aggregated = Array.from(cells.values()).map((cell) => ({
      ...cell.point,
      x: cell.x / cell.weight,
      y: cell.y / cell.weight,
      weight: cell.weight,
    }))
    aggregated.sort((left, right) => getPointTimestampMs(left) - getPointTimestampMs(right))
    return [...aggregated.slice(0, availableCells), ...markers.slice(0, Math.max(0, maxPoints - aggregated.length))]
  }
  
  ipcMain.handle('load-record-points', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const csvPath = typeof payload?.csvPath === 'string' ? payload.csvPath : ''
    if (!csvPath) {
      return { ok: false, points: [], message: '参数错误' }
    }
    const requestedMaxPoints = Math.max(1000, Math.min(1_000_000, Math.round(Number(payload?.maxPoints) || DEFAULT_MAX_RECORD_POINTS)))
    const aggregateForHeatmap = payload?.aggregateForHeatmap === true
    const maxPoints = aggregateForHeatmap
      ? Math.min(DEFAULT_MAX_RECORD_POINTS, Math.max(requestedMaxPoints, requestedMaxPoints * 8))
      : requestedMaxPoints
    const finalizeResponsePoints = (points: MainHeatmapPoint[]) => aggregateForHeatmap
      ? aggregateHeatmapPoints(
          points,
          requestedMaxPoints,
          Math.max(1, Number(payload?.viewportWidth) || Number(payload?.frameWidth) || 1280),
          Math.max(1, Number(payload?.viewportHeight) || Number(payload?.frameHeight) || 720),
        )
      : points
    const pointMode: 'auto' | 'fixation' | 'gaze' =
      payload?.pointMode === 'fixation' || payload?.pointMode === 'gaze' || payload?.pointMode === 'auto'
        ? payload.pointMode
        : 'auto'
    const pointSource: 'recommended' | 'raw' | 'smooth' =
      payload?.pointSource === 'recommended' || payload?.pointSource === 'raw' || payload?.pointSource === 'smooth'
        ? payload.pointSource
        : 'smooth'
    const includeMarkerOnlyRows = payload?.includeMarkerOnlyRows === true
    const includeSdkSaccades = payload?.includeSdkSaccades === true
    const includePupilSamples = payload?.includePupilSamples === true && pointMode === 'fixation'
    const startTimeMs = Number(payload?.startTimeMs)
    const endTimeMs = Number(payload?.endTimeMs)
    try {
      const stat = await fs.promises.stat(csvPath)
      if (pointMode === 'fixation' || pointMode === 'gaze') {
        try {
          const indexOptions = getRecordPointsIndexOptions(payload)
          const meta = await buildRecordPointsIndex(csvPath, stat, indexOptions)
          if (meta) {
            const indexed = await loadRecordPointsFromIndex(meta, pointMode, {
              maxPoints,
              includeMarkerOnlyRows,
              includeSdkSaccades,
              pointSource,
              startTimeMs: Number.isFinite(startTimeMs) ? startTimeMs : undefined,
              endTimeMs: Number.isFinite(endTimeMs) ? endTimeMs : undefined,
              exact: includePupilSamples,
            })
            const pupilSamples = includePupilSamples ? await loadRecordPointsFromIndex(meta, 'gaze', {
              maxPoints,
              includeMarkerOnlyRows: false,
              includeSdkSaccades: true,
              pointSource: 'recommended',
              startTimeMs: Number.isFinite(startTimeMs) ? startTimeMs : undefined,
              endTimeMs: Number.isFinite(endTimeMs) ? endTimeMs : undefined,
              exact: true,
              pupilSamplesOnly: true,
            }) : null
            return {
              ok: true,
              points: includePupilSamples
                ? indexed.points.map((point) => ({ ...point, pupilSamplesIncluded: true }))
                : finalizeResponsePoints(indexed.points),
              ...(pupilSamples ? { pupilSamples: pupilSamples.points } : {}),
              ...(pupilSamples?.blinkData ? { blinkData: pupilSamples.blinkData } : {}),
              fileSizeBytes: stat.size,
              totalRows: meta.totalRows,
              parsedPoints: indexed.parsedPoints,
              truncated: indexed.truncated,
              indexUsed: true,
              indexPath: getRecordPointsIndexPaths(csvPath).metaPath,
              indexCreatedAt: meta.createdAt,
            }
          }
        } catch (indexError) {
          if (includePupilSamples) throw indexError
          console.warn('[points-index] fallback to csv parser', {
            csvPath,
            message: indexError instanceof Error ? indexError.message : String(indexError),
          })
        }
      }
      if (includePupilSamples) throw new Error('无法建立完整统计索引；未使用抽样数据代替完整统计。')
      const rs = fs.createReadStream(csvPath, { encoding: 'utf-8' })
      const rl = readline.createInterface({ input: rs, crlfDelay: Infinity })
      let parserState: CsvPointParserState | null = null
      let totalRows = 0
  	    const sampler = createMainPointSampler(maxPoints)
  	    let autoDetectComplete = payload?.isGlassesMode === true
  	    let autoFiniteGazeSamples = 0
  	    let autoCenteredLikeSamples = 0
  	    const pendingAutoRows: string[][] = []
  	    const addPoint = (point: MainHeatmapPoint) => {
        if (
          pointMatchesLoadOptions(point, {
            includeMarkerOnlyRows,
            includeSdkSaccades,
            startTimeMs: Number.isFinite(startTimeMs) ? startTimeMs : undefined,
            endTimeMs: Number.isFinite(endTimeMs) ? endTimeMs : undefined,
          })
        ) {
          sampler.addPoint(point)
        }
  	    }
  	    const flushAutoRows = () => {
  	      if (!parserState) return
  	      if (!autoDetectComplete) {
  	        parserState.isGlassesMode = autoFiniteGazeSamples >= 8 && autoCenteredLikeSamples / autoFiniteGazeSamples > 0.8
  	        autoDetectComplete = true
  	      }
  	      for (const parts of pendingAutoRows.splice(0)) {
  	        const point = parseCsvPartsToHeatmapPoint(parts, parserState)
  	        if (point) addPoint(point)
  	      }
  	    }
  
  	    for await (const line of rl) {
        if (!parserState) {
          parserState = makeCsvPointParserState(parseCsvLineFast(line), {
            includeMarkerOnlyRows: payload?.includeMarkerOnlyRows === true,
            includeSdkSaccades,
            pointMode,
            pointSource,
            isGlassesMode: payload?.isGlassesMode === true,
            frameWidth: Number(payload?.frameWidth) || undefined,
            frameHeight: Number(payload?.frameHeight) || undefined,
          })
          continue
  	      }
  	      if (!line) continue
  	      totalRows += 1
  	      const parts = parseCsvLineFast(line)
  	      if (!autoDetectComplete && autoFiniteGazeSamples < 120 && pendingAutoRows.length < 500) {
  	        const sample = inspectGlassesModeSample(parts, parserState)
  	        autoFiniteGazeSamples += sample.finite
  	        autoCenteredLikeSamples += sample.centeredLike
  	        pendingAutoRows.push(parts)
  	        if (autoFiniteGazeSamples >= 120 || pendingAutoRows.length >= 500) flushAutoRows()
  	        continue
  	      }
  	      if (!autoDetectComplete) flushAutoRows()
  	      const point = parseCsvPartsToHeatmapPoint(parts, parserState)
  	      if (point) addPoint(point)
  	    }
  	    flushAutoRows()
  	    rl.close()
      rs.close()
      const sampled = sampler.finish()
      const finalized = finalizeMainHeatmapPoints(sampled.points)
      return {
        ok: true,
        points: finalizeResponsePoints(finalized),
        fileSizeBytes: stat.size,
        totalRows,
        parsedPoints: sampled.parsedPoints,
        truncated: sampled.truncated,
        indexUsed: false,
      }
    } catch (error: unknown) {
      return { ok: false, points: [], message: error instanceof Error ? error.message : '读取 CSV 点位失败' }
    }
  })
  
  ipcMain.handle('compute-aoi-stats', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const jobs = Array.isArray(payload?.jobs) ? payload.jobs : []
    try {
      const rowsByRecordId: Record<string, Array<Record<string, unknown>>> = {}
      for (const jobInput of jobs) {
        const job = asRecord(jobInput)
        const recordId = String(job?.recordId || '').trim()
        if (!recordId) continue
        const shapes = Array.isArray(job?.shapes) ? job.shapes : []
        const points = Array.isArray(job?.points) ? job.points : []
        const blinkInput = asRecord(job?.blinkData)
        const blinkData = Array.isArray(blinkInput.intervals) ? {
          intervals: blinkInput.intervals.filter((interval) => interval && typeof interval.id === 'string'
            && ['left', 'right', 'unspecified'].includes(interval.eye)
            && Number.isFinite(interval.startTimeMs) && Number.isFinite(interval.endTimeMs)
            && interval.startTimeMs >= 0 && interval.endTimeMs > interval.startTimeMs),
          unpairedPhaseCount: Math.max(0, Math.floor(Number(blinkInput.unpairedPhaseCount) || 0)),
        } : undefined
        const rows = computeAoiStatsRows({
          shapes,
          points,
          recordDurationMs: Number.isFinite(Number(job?.recordDurationMs)) ? Number(job.recordDurationMs) : 0,
          timeOffsetMs: 0,
          frameWidth: Number.isFinite(Number(job?.frameWidth)) ? Number(job.frameWidth) : undefined,
          blinkData,
        })
        const participantKey = String(job?.participantKey || recordId).trim() || recordId
        rowsByRecordId[recordId] = rows.map((row) => ({ ...row, recordId, participantKey }))
      }
      return { ok: true, rowsByRecordId }
    } catch (error) {
      return {
        ok: false,
        rowsByRecordId: {},
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })
  
}
