import { createGazeSmoothingFilter, GAZE_SMOOTHING_PROVENANCE, type GazeVector3 } from './gazeSmoothing'

/** Shared CSV export interpretation. Empty cells are missing measurements, never zero. */
export const finiteCsvNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || typeof value === 'boolean' || String(value).trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function makeExportRowReader(headers: Map<string, number>) {
  return (row: string[], ...sources: string[]): string => {
    for (const source of sources) {
      const index = headers.get(source.toLowerCase().trim())
      if (index !== undefined && row[index]?.trim()) return row[index]
    }
    return ''
  }
}

/** Metadata stays missing when the source has no finite measurement; measured zero is retained. */
export function buildNumericExportMetadata(record: {
  validityPercent?: unknown; samplingRateHz?: unknown; configuredSamplingRateHz?: unknown; durationSeconds?: unknown
}): Record<string, string> {
  const format = (value: unknown, digits?: number): string => {
    const number = finiteCsvNumber(value)
    return number === null ? '' : digits === undefined ? String(number) : number.toFixed(digits)
  }
  return {
    tracking_ratio_pct: format(record.validityPercent, 1),
    sampling_rate_hz: format(record.samplingRateHz),
    configured_sampling_rate_hz: format(record.configuredSamplingRateHz),
    record_duration_s: format(record.durationSeconds, 1),
  }
}

export function formatExportVideoTime(value: unknown): string {
  const number = finiteCsvNumber(value)
  if (number === null || number < 0) return ''
  const totalMs = Math.round(number)
  return `${String(Math.floor(totalMs / 3600000)).padStart(2, '0')}:${String(Math.floor(totalMs % 3600000 / 60000)).padStart(2, '0')}:${String(Math.floor(totalMs % 60000 / 1000)).padStart(2, '0')}.${String(totalMs % 1000).padStart(3, '0')}`
}

const dateClockMs = (date: Date): number =>
  ((date.getHours() * 60 + date.getMinutes()) * 60 + date.getSeconds()) * 1000 + date.getMilliseconds()
const parseRecordClockMs = (value: unknown): number | null => {
  const raw = typeof value === 'string' ? value.trim() : ''
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})?$/.exec(raw)
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null
  if (match[8]) {
    const instant = new Date(raw.replace(' ', 'T'))
    return Number.isFinite(instant.getTime()) ? dateClockMs(instant) : null
  }
  return ((hour * 60 + minute) * 60 + second) * 1000 + Number((match[7] || '0').padEnd(3, '0'))
}

/** Pupil time is seconds from an arbitrary epoch. Civil time needs an explicit recording clock. */
export function resolveExportTimeOfDay(recordTimestamp: unknown, row: string[], headers: Map<string, number>): string {
  const read = makeExportRowReader(headers)
  const explicit = read(row, 'time_of_day')
  if (/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/.test(explicit)) return explicit
  const start = parseRecordClockMs(recordTimestamp)
  const elapsed = finiteCsvNumber(read(row, 'video_time_ms'))
  if (start !== null && elapsed !== null && elapsed >= 0) return formatExportVideoTime(Math.round(start + elapsed) % 86400000)
  // Legacy 7invensun files carry a system timestamp (microseconds or milliseconds).
  // Never guess a Pupil/Huahong source clock, or format a relative time as a wall clock.
  if (hasIndependentEvents(read, row) || headers.has('source_timestamp_s')) return ''
  const timestamp = finiteCsvNumber(read(row, 'timestamp'))
  if (timestamp === null || timestamp < 100_000_000_000) return ''
  const date = new Date(timestamp >= 100_000_000_000_000 ? timestamp / 1000 : timestamp)
  return Number.isFinite(date.getTime()) ? formatExportVideoTime(dateClockMs(date)) : ''
}
type ReadCell = ReturnType<typeof makeExportRowReader>
const hasIndependentEvents = (read: ReadCell, row: string[]) =>
  ['PupilCore', 'HH_ET10C', 'HH_ET28'].includes(read(row, 'source_model'))
const isAnnotationOnly = (read: ReadCell, row: string[]) =>
  hasIndependentEvents(read, row) && !read(row, 'source_event_type') && !!read(row, 'customMarker', 'triggerMark') &&
  !read(row, 'gaze_valid', 'pupil_valid', 'fixation_state', 'fixationState',
    'source_topic', 'source_timestamp_s', 'recom_gaze_x', 'recomGazeX', 'recom_gaze_y', 'recomGazeY',
    'left_pupil_diameter_mm', 'right_pupil_diameter_mm', 'left_pupil_diameter', 'right_pupil_diameter')
const isEvent = (read: ReadCell, row: string[]) => !!read(row, 'source_event_type')
const isLateSourceSample = (read: ReadCell, row: string[]) => read(row, 'gaze_source_order') === 'late_source_time'
const normalizedSpace = (read: ReadCell, row: string[]) =>
  read(row, 'gaze_coordinate_space').includes('normalized') || hasIndependentEvents(read, row)
const timeMs = (read: ReadCell, row: string[], hasVideoTime: boolean): number | null => {
  // A present video-time column is authoritative; never replace a missing cell by another clock.
  const videoTime = read(row, 'video_time_ms')
  if (hasVideoTime) return finiteCsvNumber(videoTime)
  const timestamp = finiteCsvNumber(read(row, 'timestamp'))
  return timestamp !== null && timestamp >= 100_000_000_000_000 ? timestamp / 1000 : timestamp
}
const blinkActive = (read: ReadCell, row: string[], ...keys: string[]) => {
  const value = finiteCsvNumber(read(row, ...keys))
  return value !== null && value !== 0
}
const validity = (read: ReadCell, row: string[]): boolean | null => {
  const model = read(row, 'source_model')
  const value = hasIndependentEvents(read, row)
    ? finiteCsvNumber(read(row, 'gaze_valid', ...(model === 'PupilCore' ? ['pupil_valid'] : ['recom_gaze_bit_mask'])))
    : finiteCsvNumber(read(row, 'fixation_state', 'fixationState'))
  return value === null ? null : value !== 0
}

/** Preserve legacy coordinate/ms numbers, and expose normalized/ms separately with honest units. */
export function createExportMotionDeriver(headers: Map<string, number>) {
  const read = makeExportRowReader(headers)
  let previous: { x: number; y: number; time: number; context: string } | null = null
  return (row: string[]): Record<string, string> => {
    const out: Record<string, string> = {}
    const sourceSpeed = read(row, 'gaze_velocity_ms', 'gazeVelocityMs')
    if (sourceSpeed) out.gaze_velocity_unit = read(row, 'gaze_velocity_unit') || 'unspecified_source_unit'
    // Match the native mapper: retain late samples but break causal motion continuity.
    if (isLateSourceSample(read, row)) { previous = null; return out }
    if (isEvent(read, row) || isAnnotationOnly(read, row)) return out
    const valid = validity(read, row)
    const x = finiteCsvNumber(read(row, 'recom_gaze_x', 'recomGazeX'))
    const y = finiteCsvNumber(read(row, 'recom_gaze_y', 'recomGazeY'))
    const time = timeMs(read, row, headers.has('video_time_ms'))
    const normalized = normalizedSpace(read, row)
    if (valid === false || (hasIndependentEvents(read, row) && valid !== true) ||
        blinkActive(read, row, 'blink') || blinkActive(read, row, 'left_blink', 'leftBlink') ||
        blinkActive(read, row, 'right_blink', 'rightBlink') ||
        x === null || y === null || time === null || x < 0 || y < 0 || (normalized && (x > 1 || y > 1))) {
      previous = null
      return out
    }
    const unit = normalized ? 'normalized/ms' : 'source_coordinate/ms'
    const context = [read(row, 'source_model'), read(row, 'source_backend'), read(row, 'source_generation'),
      read(row, 'stimulus'), read(row, 'gaze_coordinate_space'), unit,
      // A monocular/bino model switch can move the fitted point without actual eye motion.
      // Pupil topics identify the actual contributing eye (0, 1 or 01), including historical files.
      read(row, 'source_topic'), read(row, 'gaze_mapping_mode'), read(row, 'gaze_rejected_eye_ids')].join('|')
    const before = previous
    previous = { x, y, time, context }
    // Native speed was computed before source-time CSV sorting. Its empty cell
    // preserves a causal break that sorted neighbors cannot safely reconstruct.
    if (read(row, 'source_model') === 'PupilCore' && read(row, 'source_backend') === 'native' &&
        read(row, 'gaze_source_order') === 'in_order' && headers.has('gaze_velocity_px_ms') &&
        finiteCsvNumber(read(row, 'gaze_velocity_px_ms')) === null) return out
    if (!before || before.context !== context) return out
    const deltaMs = time - before.time
    // Matches the acquisition/analysis continuity boundary; missing intervals are not measured motion.
    if (deltaMs <= 0 || deltaMs > 100) return out
    const speed = String(Math.hypot(x - before.x, y - before.y) / deltaMs)
    if (!sourceSpeed) {
      out.gaze_velocity_ms = speed
      out.gaze_velocity_unit = unit
    }
    if (unit === 'normalized/ms') out.gaze_velocity_normalized_ms = speed
    return out
  }
}

export type ExportSegment = { startRow: number; endRow: number; index: number; durationMs: number; marker?: number }
export type ExportSegments = { invalidGaze: ExportSegment[]; blinks: ExportSegment[] }
type PendingSegment = { startRow: number; endRow: number; startTime: number; lastTime: number; context: string; marker?: number }

/** Stream-safe scanner used by both disk export and the bounded preview. */
export function createExportSegmentScanner(headers: Map<string, number>) {
  const read = makeExportRowReader(headers)
  const segments: ExportSegments = { invalidGaze: [], blinks: [] }
  let invalid: PendingSegment | null = null
  let blink: PendingSegment | null = null
  let captureBlink = false
  let capturePairId = ''
  const close = (kind: 'invalidGaze' | 'blinks', endTime?: number | null) => {
    const pending = kind === 'invalidGaze' ? invalid : blink
    if (!pending) return
    segments[kind].push({ startRow: pending.startRow, endRow: pending.endRow,
      index: segments[kind].length + 1, durationMs: Math.max(0, (endTime ?? pending.lastTime) - pending.startTime), marker: pending.marker })
    if (kind === 'invalidGaze') invalid = null
    else blink = null
  }
  const append = (pending: PendingSegment | null, index: number, time: number, context: string, marker?: number): PendingSegment =>
    pending ? { ...pending, endRow: index, lastTime: time, marker: (pending.marker ?? 0) | (marker ?? 0) }
      : { startRow: index, endRow: index, startTime: time, lastTime: time, context, marker }
  const add = (row: string[], index: number) => {
    // Recorder marker rows carry a zero gaze mask and may inherit blink display
    // flags. They have no actual sampling validity or source measurement.
    if (isAnnotationOnly(read, row) || isLateSourceSample(read, row)) return
    const time = timeMs(read, row, headers.has('video_time_ms'))
    const context = [read(row, 'source_model'), read(row, 'source_generation'), read(row, 'stimulus')].join('|')
    const event = isEvent(read, row)
    const separated = hasIndependentEvents(read, row)
    if (!event) {
      // Event insertion may carry earlier timestamps; continuity is checked on sample rows only.
      if (invalid && (time === null || context !== invalid.context || time <= invalid.lastTime || time - invalid.lastTime > 100)) close('invalidGaze')
      const valid = validity(read, row)
      if (valid === false && time !== null) invalid = append(invalid, index, time, context)
      else close('invalidGaze', valid === true ? time : null)
    }
    if (separated) {
      // New files preserve paired IDs and durations directly. Only old phase-only Capture files need pairing.
      if (read(row, 'left_blink', 'right_blink', 'blink_index') || read(row, 'blink_pair_status').startsWith('unpaired')) return
      if (blink && (context !== blink.context || time === null || time < blink.lastTime)) blink = null
      const phase = read(row, 'blink_phase')
      if (phase === 'onset' && time !== null) {
        captureBlink = true
        capturePairId = read(row, 'blink_pair_id')
        blink = append(null, index, time, context, 0)
      } else if (phase === 'offset' && time !== null && blink && read(row, 'blink_pair_id') === capturePairId) close('blinks', time)
      else if (blink && time !== null) blink = append(blink, index, time, context, 0)
      return
    }
    if (blink && (time === null || context !== blink.context || time <= blink.lastTime || time - blink.lastTime > 100)) close('blinks')
    const marker = (blinkActive(read, row, 'left_blink', 'leftBlink') ? 1 : 0) |
      (blinkActive(read, row, 'right_blink', 'rightBlink') ? 2 : 0)
    if (marker && time !== null) blink = append(blink, index, time, context, marker)
    else close('blinks', time)
  }
  const finish = (complete = true): ExportSegments => {
    // A truncated preview must not present its cutoff as an event's true end.
    if (complete) { close('invalidGaze'); if (!captureBlink) close('blinks') }
    return segments
  }
  return { add, finish }
}

export function createExportSegmentReader(headers: Map<string, number>, segments: ExportSegments) {
  const read = makeExportRowReader(headers)
  let invalidCursor = 0
  let blinkCursor = 0
  return (row: string[], index: number): Record<string, string> => {
    const out: Record<string, string> = {}
    while (invalidCursor < segments.invalidGaze.length && index > segments.invalidGaze[invalidCursor].endRow) invalidCursor++
    while (blinkCursor < segments.blinks.length && index > segments.blinks[blinkCursor].endRow) blinkCursor++
    if (isAnnotationOnly(read, row) || isLateSourceSample(read, row)) return out
    const invalid = segments.invalidGaze[invalidCursor]
    if (invalid && index >= invalid.startRow && !isEvent(read, row) && validity(read, row) === false) {
      out.invalid_gaze_index = String(invalid.index)
      out.invalid_gaze_duration_ms = String(Number(invalid.durationMs.toFixed(3)))
    }
    const blink = segments.blinks[blinkCursor]
    if (blink && index >= blink.startRow) {
      out.blink_index = String(blink.index)
      out.blink_duration_ms = String(Number(blink.durationMs.toFixed(3)))
      out.blink_marker = blink.marker ? String(blink.marker) : ''
    }
    return out
  }
}

export type ExportMeasurementContext = {
  videoWidth?: unknown; videoHeight?: unknown
  /** Internal derivations only; these keys are not selectable export columns. */
  derivedValues?: Readonly<Record<string, string>>
}

/** Same causal CSV adapter for the bounded preview and full streaming export. */
export function createExportSmoothingDeriver(headers: Map<string, number>, context: ExportMeasurementContext = {}) {
  const read = makeExportRowReader(headers)
  const eyes = ['recom', 'left', 'right'] as const
  const filters = { recom: createGazeSmoothingFilter(), left: createGazeSmoothingFilter(), right: createGazeSmoothingFilter() }
  let previousGazeTime: number | null = null
  const reset = () => { eyes.forEach(eye => filters[eye].reset()); previousGazeTime = null }
  let sequenceScope = ''
  let sequenceHighWater: number | null = null
  const sourceTime = (row: string[], key: string, scale = 1000): number | null => {
    const value = finiteCsvNumber(read(row, key))
    return value === null || !Number.isFinite(value * scale) ? null : value * scale
  }
  return (row: string[]): Record<string, string> => {
    const output: Record<string, string> = {}
    if (isEvent(read, row)) return output
    if (read(row, 'source_model') !== 'PupilCore') { reset(); sequenceHighWater = null; sequenceScope = ''; return output }
    if (isAnnotationOnly(read, row)) return output
    const scope = [read(row, 'source_model'), read(row, 'source_backend'), read(row, 'source_generation')].join('|')
    if (scope !== sequenceScope) { reset(); sequenceHighWater = null; sequenceScope = scope }
    // Source-time sorting can move a late sample before the normal sample that
    // preceded it at acquisition. Preserve that causal boundary using the gaze
    // receive high-water mark; non-gaze messages may occupy intermediate IDs.
    if (headers.has('source_receive_sequence')) {
      const sequence = finiteCsvNumber(read(row, 'source_receive_sequence'))
      if (sequence === null || !Number.isSafeInteger(sequence) || sequence < 0 ||
          (sequenceHighWater !== null && sequence <= sequenceHighWater)) { reset(); return output }
      sequenceHighWater = sequence
    }
    if (isLateSourceSample(read, row)) { reset(); return output }
    const clockKey = headers.has('source_timestamp_s') ? 'source_timestamp_s' : 'video_time_ms'
    const time = sourceTime(row, clockKey, clockKey === 'source_timestamp_s' ? 1000 : 1)
    if (time === null || (clockKey === 'video_time_ms' && time < 0) ||
        (previousGazeTime !== null && time <= previousGazeTime)) { reset(); return output }
    if (previousGazeTime !== null && time - previousGazeTime > 100) reset()
    previousGazeTime = time
    const commonContext = [scope, clockKey, read(row, 'geometry_space'),
      read(row, 'source_topic'), read(row, 'gaze_mapping_mode'), read(row, 'gaze_rejected_eye_ids'),
      read(row, 'gaze_coordinate_space'), read(row, 'stimulus'),
      read(row, 'world_image_width'), read(row, 'world_image_height'), read(row, 'world_resolution_epoch'),
      String(context.videoWidth ?? ''), String(context.videoHeight ?? '')].join('|')
    for (const eye of eyes) {
      const raw = [...'xyz'].map(axis => finiteCsvNumber(resolveExportMeasurement(`${eye}_raw_point_${axis}`,
        read(row, `${eye}_raw_point_${axis}`), row, headers, context)))
      const mask = finiteCsvNumber(resolveExportMeasurement(`${eye}_gaze_bit_mask`, read(row, `${eye}_gaze_bit_mask`), row, headers, context))
      const topic = read(row, 'source_topic')
      const contributors = topic === 'gaze.3d.0.' ? ['right'] : topic === 'gaze.3d.1.' ? ['left'] : ['left', 'right']
      const contributorRejected = contributors.some(member => read(row, `${member}_pupil_valid`) === '0' ||
        read(row, `${member}_pupil_model_quality`) === 'bad' || blinkActive(read, row, `${member}_blink`))
      const valid = eye === 'recom' ? validity(read, row) === true && read(row, 'gaze_model_quality') !== 'bad' &&
        !blinkActive(read, row, 'blink') && !contributorRejected
        : read(row, `${eye}_pupil_valid`) !== '0' && read(row, `${eye}_pupil_model_quality`) !== 'bad' && !blinkActive(read, row, `${eye}_blink`)
      const point = valid && mask !== null && (mask & 2) !== 0 && raw.every(value => value !== null) &&
        read(row, 'geometry_space') === 'world_camera_mm' && read(row, 'gaze_raw_semantics') !== 'normalized_2d_alias'
        ? raw as unknown as GazeVector3 : null
      const eyeClock = `${eye}_pupil_source_timestamp_s`
      const hasEyeClock = eye !== 'recom' && headers.has(eyeClock)
      const eyeTime = hasEyeClock ? sourceTime(row, eyeClock) : time
      // Match paired_pupils: explicit base_data may straddle a binocular mean
      // gaze time; a legacy cache may only contribute a past, recent eye frame.
      // Eye source seconds cannot be compared with a relative video clock.
      const ageMs = eyeTime === null ? Infinity : time - eyeTime
      const paired = !hasEyeClock || (clockKey === 'source_timestamp_s' && ageMs <= 100 &&
        ageMs >= (read(row, 'pupil_pairing') === 'base_data' ? -100 : 0))
      const filtered = filters[eye].add({ timeMs: paired ? eyeTime : null, point,
        context: [commonContext, eye, eye !== 'recom' && headers.has(eyeClock) ? eyeClock : clockKey,
          eye === 'recom' ? '' : read(row, 'pupil_pairing'),
          read(row, `${eye}_pupil_image_width`), read(row, `${eye}_pupil_image_height`)].join('|') })
      if (filtered) [...'xyz'].forEach((axis, index) => { output[`${eye}_smooth_point_${axis}`] = String(filtered[index]) })
    }
    if (Object.keys(output).length) output.gaze_smoothing_provenance = GAZE_SMOOTHING_PROVENANCE
    return output
  }
}

/** Map Pupil measurements into the established 7invensun column units and member masks. */
export function resolveExportMeasurement(key: string, raw: string, row: string[], headers: Map<string, number>, context: ExportMeasurementContext = {}): string {
  const read = makeExportRowReader(headers)
  if (key === 'timestamp' && headers.has('video_time_ms')) return read(row, 'video_time_ms')
  if (read(row, 'source_model') !== 'PupilCore') return raw
  if (/^(left|right)_(openness|eyelid_up|eyelid_down)$/.test(key) ||
      ['gyro_timestamp', 'gyro_quaternion', 'gyroscope', 'acceleration', 'magnetometer'].includes(key)) return ''
  const finiteText = (value: string, positive = false): string => {
    const number = finiteCsvNumber(value)
    return number !== null && (!positive || number > 0) ? value : ''
  }
  const ratioText = (value: string, positive = false): string => {
    const number = finiteCsvNumber(value)
    return number !== null && number >= 0 && number <= 1 && (!positive || number > 0) ? value : ''
  }
  const gazeRejected = (eye: string): boolean => eye === 'recom'
    ? read(row, 'gaze_valid', 'pupil_valid') === '0' || read(row, 'recom_gaze_bit_mask') === '0'
    : read(row, `${eye}_gaze_bit_mask`) === '0'
  const standardValue = (field: string): string => resolveExportMeasurement(field, read(row, field), row, headers, context)
  if (key === 'fixation_center_x' || key === 'fixation_center_y') {
    const pixels = finiteText(read(row, key.replace('center', 'point') + '_px'))
    if (pixels) return pixels
    // Recorder fixation_center is top-left normalized, unlike the standard pixel column.
    const normalized = finiteCsvNumber(read(row, key))
    const dimension = finiteCsvNumber(key.endsWith('_x') ? context.videoWidth : context.videoHeight)
    return normalized !== null && normalized >= 0 && normalized <= 1 && dimension !== null && dimension > 0 ? String(normalized * dimension) : ''
  }
  const pupil = /^(left|right)_pupil_(center_[xy]|diameter|diameter_mm|minor_axis|minor_axis_mm|distance|bit_mask)$/.exec(key)
  if (pupil) {
    const eye = pupil[1]
    const member = pupil[2]
    if (member === 'distance' || member === 'minor_axis_mm') return ''
    if (member === 'bit_mask') {
      const members = [['center_x', 'center_y'], ['distance'], ['diameter'], ['diameter_mm'], ['minor_axis'], ['minor_axis_mm']]
      const mask = members.reduce((bits, fields, bit) => fields.every((field) => standardValue(`${eye}_pupil_${field}`) !== '') ? bits | (1 << bit) : bits, 0)
      const observed = read(row, `${eye}_pupil_valid`, `${eye}_pupil_pixel_valid`, `${eye}_pupil_source_timestamp_s`, `${eye}_pupil_raw_diameter_px`, `${eye}_pupil_raw_diameter_mm`)
      return mask || observed ? String(mask) : ''
    }
    if (member === 'diameter_mm') {
      if (read(row, `${eye}_pupil_diameter_mm_valid`) === '0' || read(row, `${eye}_pupil_valid`) === '0' || read(row, `${eye}_pupil_model_quality`) === 'bad') return ''
      return finiteText(raw, true)
    }
    const independent2d = read(row, `${eye}_pupil_pixel_source`) === 'detected_2d_ellipse'
    const pixelValid = read(row, `${eye}_pupil_pixel_valid`)
    if (pixelValid === '0' || (pixelValid !== '1' && read(row, `${eye}_pupil_valid`) === '0') ||
        (!independent2d && read(row, `${eye}_pupil_model_quality`) === 'bad')) return ''
    const center = member.startsWith('center_')
    const normalized = center ? read(row, 'pupil_center_space') === 'eye_image_normalized_top_left'
      : read(row, 'pupil_axis_unit') === 'image_width_ratio'
    if (normalized) return ratioText(raw, !center)
    const dimension = finiteCsvNumber(read(row, `${eye}_pupil_image_${member === 'center_y' ? 'height' : 'width'}`))
    if (dimension === null || dimension <= 0) return ''
    // A scene/video width is never an eye-image width. Unknown old centre units stay missing.
    if (center && read(row, 'pupil_center_space') !== 'eye_image_pixels_top_left') return ''
    const pixels = finiteCsvNumber(member === 'diameter' ? read(row, `${eye}_pupil_diameter_px`) || raw : raw)
    return pixels !== null ? ratioText(String(pixels / dimension), !center) : ''
  }
  if (/^(left|right)_blink$/.test(key)) {
    const value = finiteCsvNumber(raw)
    return value === 0 ? '0' : value === 1 || value === 3 ? '3' : ''
  }
  const gazePosition = /^(recom|left|right)_gaze_[xy]$/.exec(key)
  if (gazePosition) return gazeRejected(gazePosition[1]) ? '' : ratioText(raw)
  const gaze = /^(recom|left|right)_(gaze_bit_mask|(?:gaze_point|raw_point|smooth_point|origin|direction)_[xyz]|re)$/.exec(key)
  if (gaze) {
    const eye = gaze[1]
    const member = gaze[2]
    if (gazeRejected(eye)) return member === 'gaze_bit_mask' ? '0' : ''
    if (member === 'gaze_bit_mask') {
      const members = ['gaze_point', 'raw_point', 'smooth_point', 'origin', 'direction', 're']
      const mask = members.reduce((bits, field, bit) => {
        const fields = field === 're' ? [`${eye}_re`] : [...'xyz'].map((axis) => `${eye}_${field}_${axis}`)
        return fields.every((fieldKey) => standardValue(fieldKey) !== '') ? bits | (1 << bit) : bits
      }, 0)
      return mask || raw || read(row, `${eye}_gaze_x`) ? String(mask) : ''
    }
    // The standard origin is a corneal-curvature centre. Pupil's eye-sphere centre is not it.
    if (member.startsWith('origin_')) return ''
    if (member.startsWith('smooth_point_')) {
      const derived = context.derivedValues
      return read(row, 'geometry_space') === 'world_camera_mm' && read(row, 'gaze_raw_semantics') !== 'normalized_2d_alias' &&
        !isEvent(read, row) && !isAnnotationOnly(read, row) && derived?.gaze_smoothing_provenance === GAZE_SMOOTHING_PROVENANCE &&
        [...'xyz'].every(axis => finiteCsvNumber(derived[`${eye}_smooth_point_${axis}`]) !== null)
        ? derived[key] : ''
    }
    if (member === 're') {
      const value = finiteCsvNumber(raw)
      return value !== null && value >= 0 && value <= 1 ? raw : ''
    }
    // Old Capture point/raw/smooth aliases were normalized 2D positions, not camera-space 3D.
    return read(row, 'geometry_space') === 'world_camera_mm' ? finiteText(raw) : ''
  }
  if (key === 'recommend') {
    if (isEvent(read, row) || isAnnotationOnly(read, row)) return ''
    if (read(row, 'gaze_valid', 'pupil_valid') === '0') return '0'
    const topic = read(row, 'source_topic')
    if (read(row, 'gaze_valid', 'pupil_valid') !== '1' || read(row, 'gaze_mapping_mode') !== 'monocular') return ''
    return topic === 'gaze.3d.1.' ? '1' : topic === 'gaze.3d.0.' ? '2' : ''
  }
  return raw
}

export function buildDerivedExportRows(rows: string[][], headers: Map<string, number>, complete = true, context: ExportMeasurementContext = {}): Record<string, string>[] {
  const scanner = createExportSegmentScanner(headers)
  rows.forEach(scanner.add)
  const segmentValues = createExportSegmentReader(headers, scanner.finish(complete))
  const motion = createExportMotionDeriver(headers)
  const smoothing = createExportSmoothingDeriver(headers, context)
  return rows.map((row, index) => ({ ...motion(row), ...segmentValues(row, index), ...smoothing(row) }))
}
