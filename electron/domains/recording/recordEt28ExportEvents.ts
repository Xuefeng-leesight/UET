import * as fs from 'node:fs'
import * as readline from 'node:readline'
import { finiteCsvNumber, makeExportRowReader } from '../../../shared/domain/eyeExportData'
import { parseCsvLineFast } from './recordCsvParser'

type EventRow = { time: number; end: number; fields: Record<string, string | number> }
type Et28ExportEvents = { inserts: EventRow[]; distances: Map<string, number> }

const emptyEvents = (): Et28ExportEvents => ({ inserts: [], distances: new Map() })

function adjacentFixationDistances(events: EventRow[]): Map<string, number> {
  const fixations = events.filter(({ fields }) => fields.source_event_type === 'fixation')
    .sort((a, b) => a.time - b.time)
  const distances = new Map<string, number>()
  const saccades = events.filter(({ fields }) => fields.source_event_type === 'saccade')
    .sort((a, b) => a.end - b.end)
  let next = 0
  for (const saccade of saccades) {
    while (next < fixations.length && fixations[next].time < saccade.end - 1) next++
    const before = fixations[next - 1]
    const after = fixations[next]
    if (!before || !after || before.end > saccade.time + 1 || saccade.time - before.end > 100 ||
        after.time - saccade.end > 100 || before.fields.source_generation !== saccade.fields.source_generation ||
        after.fields.source_generation !== saccade.fields.source_generation) continue
    const ax = finiteCsvNumber(before.fields.fixation_point_x_px)
    const ay = finiteCsvNumber(before.fields.fixation_point_y_px)
    const bx = finiteCsvNumber(after.fields.fixation_point_x_px)
    const by = finiteCsvNumber(after.fields.fixation_point_y_px)
    if (ax !== null && ay !== null && bx !== null && by !== null) {
      distances.set(`${saccade.fields.source_generation}:${saccade.fields.source_event_id}`, Math.hypot(bx - ax, by - ay))
    }
  }
  return distances
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

function parseObject(value: string): Record<string, unknown> {
  try { return object(JSON.parse(value)) } catch { return {} }
}

function pointInFrame(value: unknown, width: number | null, height: number | null): value is [number, number] {
  if (!Array.isArray(value) || value.length !== 2 || width === null || height === null) return false
  const [x, y] = value
  return typeof x === 'number' && typeof y === 'number' && x >= 0 && y >= 0 && x < width && y < height
}

/** Recover event rows for export from legacy ET28 CSVs that only saved SDK payloads. */
export async function readEt28ExportEvents(csvPath: string): Promise<Et28ExportEvents> {
  const stream = fs.createReadStream(csvPath, { encoding: 'utf8' })
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let read: ReturnType<typeof makeExportRowReader> | undefined
  const events: EventRow[] = []
  const recorded: EventRow[] = []
  const seen = new Set<string>()
  const counts = new Map<string, number>()
  try {
    for await (const line of lines) {
      if (!read) {
        const headers = new Map(parseCsvLineFast(line).map((name, index) => [name.trim().toLowerCase(), index]))
        if (!headers.has('et28_gaze_events') || !headers.has('source_model')) return emptyEvents()
        read = makeExportRowReader(headers)
        continue
      }
      if (!line) continue
      const row = parseCsvLineFast(line)
      const model = read(row, 'source_model')
      if (model && model !== 'HH_ET28') return emptyEvents()
      const time = finiteCsvNumber(read(row, 'video_time_ms'))
      if (time === null || model !== 'HH_ET28') continue
      const generation = read(row, 'source_generation')
      const recordedKind = read(row, 'source_event_type')
      if (recordedKind) {
        if (recorded.length >= 100000) throw new Error('ET28 SDK 事件超过 10 万条，无法导出完整事件。')
        const length = finiteCsvNumber(read(row, 'source_event_duration_ms'))
        if (length !== null && length > 0) {
          recorded.push({ time, end: time + length, fields: {
            source_event_type: recordedKind, source_generation: generation, source_event_id: read(row, 'source_event_id'),
            fixation_point_x_px: read(row, 'fixation_point_x_px'), fixation_point_y_px: read(row, 'fixation_point_y_px'),
          } })
          events.length = 0
        }
        continue
      }
      if (recorded.length) continue
      const payload = parseObject(read(row, 'et28_gaze_events'))
      for (const [kind, eye] of [['fixation', ''], ['saccade', ''], ['invalid', ''], ['blink', 'left'], ['blink', 'right']]) {
        const event = eye ? parseObject(read(row, `${eye}_et28_blink_event`)) : object(payload[kind])
        if (eye ? event.blinkDetected !== true : event.valid !== true) continue
        const interval = kind === 'fixation' || kind === 'saccade'
        const start = finiteCsvNumber(interval ? object(event.start).timeStamp : event.startTimeStamp)
        const end = finiteCsvNumber(interval ? object(event.end).timeStamp : event.endTimeStamp)
        const clock = finiteCsvNumber(read(row, `${eye || 'left'}_et28_device_timestamp`))
        if (start === null || end === null || clock === null || start <= 0 || end <= start || end > clock) continue
        const startMs = time + (start - clock)
        const endMs = time + (end - clock)
        if (startMs < 0) continue
        const id = JSON.stringify([generation, kind, eye, start, end])
        if (seen.has(id)) continue
        seen.add(id)
        if (seen.size > 100000) throw new Error('ET28 SDK 事件超过 10 万条，无法导出完整事件。')
        const index = (counts.get(kind) ?? 0) + 1
        counts.set(kind, index)
        const fields: EventRow['fields'] = {
          source_model: 'HH_ET28', source_backend: 'huahong_sdk', source_event_type: kind,
          source_generation: generation, source_event_id: index, source_event_algorithm: 'huahong_et28_sdk',
          source_event_duration_ms: end - start, source_event_completion: 'complete_interval',
          recom_gaze_bit_mask: 0, timestamp: startMs, video_time_ms: startMs,
        }
        if (kind === 'fixation') {
          Object.assign(fields, { fixation_state: 4, fixation_index: index,
            fixation_timestamp_ms: startMs, fixation_duration_ms: end - start })
          const point = event.centroid
          if (pointInFrame(point, finiteCsvNumber(read(row, 'world_image_width')), finiteCsvNumber(read(row, 'world_image_height')))) {
            fields.fixation_point_x_px = point[0]
            fields.fixation_point_y_px = point[1]
          }
        } else if (kind === 'saccade') {
          Object.assign(fields, { fixation_state: 2, saccade_index: index, saccade_duration_ms: end - start })
          for (const [column, sdkField] of [
            ['average_saccade_velocity_px_ms', 'meanVelocity'], ['peak_saccade_velocity_px_ms', 'peakVelocity'],
            ['average_saccade_velocity_deg_ms', 'meanVelocityDeg'], ['peak_saccade_velocity_deg_ms', 'peakVelocityDeg'],
          ]) {
            const value = finiteCsvNumber(event[sdkField])
            if (value !== null && value >= 0) fields[column] = value / 1000
          }
        } else if (kind === 'blink') {
          Object.assign(fields, { blink: 1, blink_phase: 'onset', blink_pair_id: index,
            blink_pair_status: 'paired', blink_index: index, blink_duration_ms: end - start,
            blink_marker: eye === 'left' ? 1 : 2, [`${eye}_blink`]: 1 })
          events.push({ time: endMs, end: endMs, fields: { ...fields,
            timestamp: endMs, video_time_ms: endMs, blink: 0, blink_phase: 'offset',
            blink_index: '', blink_duration_ms: '', [`${eye}_blink`]: 0 } })
        }
        events.push({ time: startMs, end: endMs, fields })
      }
    }
  } finally { lines.close(); stream.destroy() }
  const inserts = events.sort((a, b) => a.time - b.time)
  return { inserts, distances: adjacentFixationDistances(recorded.length ? recorded : inserts) }
}

/** Stream legacy events between original rows, keeping the existing header and row readers. */
function createEt28ExportRowMerger(headers: Map<string, number>, width: number, { inserts, distances }: Et28ExportEvents) {
  let cursor = 0
  const read = makeExportRowReader(headers)
  let stimulus = ''
  const distanceColumn = headers.get('saccade_distance_px')
  const withSaccadeDistance = (row: string[]) => {
    if (distanceColumn !== undefined && !row[distanceColumn] && read(row, 'source_event_type') === 'saccade') {
      const distance = distances.get(`${read(row, 'source_generation')}:${read(row, 'source_event_id')}`)
      if (distance !== undefined) row[distanceColumn] = String(distance)
    }
    return row
  }
  return function* (row: string[]) {
    const time = finiteCsvNumber(read(row, 'video_time_ms'))
    while (time !== null && cursor < inserts.length && inserts[cursor].time <= time) {
      const event = inserts[cursor++]
      const parts = Array<string>(width).fill('')
      for (const [key, value] of Object.entries({ ...event.fields, stimulus })) {
        const index = headers.get(key)
        if (index !== undefined) parts[index] = String(value)
      }
      yield withSaccadeDistance(parts)
    }
    if (!read(row, 'source_event_type')) stimulus = read(row, 'stimulus')
    yield withSaccadeDistance(row)
  }
}

export async function* readRecordExportRows(csvPath: string, events: Et28ExportEvents) {
  const stream = fs.createReadStream(csvPath, { encoding: 'utf8' })
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let merge: ReturnType<typeof createEt28ExportRowMerger> | undefined
  try {
    for await (const line of lines) {
      if (!merge) {
        const headers = parseCsvLineFast(line).map(name => name.trim())
        merge = createEt28ExportRowMerger(
          new Map(headers.map((name, index) => [name.toLowerCase(), index])), headers.length, events)
        yield headers
      } else if (line) {
        yield* merge(parseCsvLineFast(line))
      }
    }
  } finally { lines.close(); stream.destroy() }
}
