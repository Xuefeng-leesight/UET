import { RECORD_POINTS_PARSE_VERSION } from '../../../shared/constants/recordPoints'

export type MainHeatmapPoint = {
  x: number
  y: number
  weight?: number
  id?: number
  timestamp?: number
  timeBase?: 'video_time_ms'
  fixationState?: number
  fixationTimestampMs?: number
  fixationDurationMs?: number
  fixationSource?: 'mrt_7invensun_fallback'
  blink?: boolean
  leftBlink?: boolean
  rightBlink?: boolean
  pupilDiameter?: number
  leftPupilDiameter?: number
  rightPupilDiameter?: number
  sampleOnly?: boolean
  samplePositionValid?: boolean
  pupilSamplesIncluded?: boolean
  saccadeMetricUnit?: 'pixels' | 'normalized'
  saccadeDurationMs?: number
  saccadeAmplitude?: number
  saccadeVelocity?: number
  saccadePeakVelocity?: number
  saccadeStartX?: number
  saccadeStartY?: number
  saccadeEndX?: number
  saccadeEndY?: number
  stimulusName?: string
  marker?: string
  triggerMark?: string
  customMarker?: string
  markerOnly?: boolean
  parseVersion?: number
}

export type CsvPointParserState = {
  headers: string[]
  includeMarkerOnlyRows: boolean
  includeSdkSaccades: boolean
  pointMode: 'auto' | 'fixation' | 'gaze'
  pupilSamplesOnly: boolean
  pointSource: 'recommended' | 'raw' | 'smooth'
  isGlassesMode: boolean
  frameWidth: number
  frameHeight: number
  glassesSpaceHint: 'normalized' | 'centered_pixels' | 'centered_small' | null
  indexes: Record<string, number>
  nextLegacyFixationIndex: number
}

const parseCsvLineSafe = (line: string): string[] => {
  const out: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      const next = line[i + 1]
      if (inQuotes && next === '"') {
        current += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  out.push(current)
  return out
}

export const parseCsvLineFast = (line: string): string[] => (line.includes('"') ? parseCsvLineSafe(line) : line.split(','))

export const makeCsvPointParserState = (
  headersRaw: string[],
  options?: {
    includeMarkerOnlyRows?: boolean
    includeSdkSaccades?: boolean
    pointMode?: 'auto' | 'fixation' | 'gaze'
    pupilSamplesOnly?: boolean
    pointSource?: 'recommended' | 'raw' | 'smooth'
    isGlassesMode?: boolean
    frameWidth?: number
    frameHeight?: number
  },
): CsvPointParserState => {
  const headers = headersRaw.map((h) => String(h || '').replace(/^\uFEFF/, '').trim())
  const findIndex = (candidates: string[]): number => {
    const lower = candidates.map((c) => c.toLowerCase())
    for (let i = 0; i < headers.length; i += 1) {
      if (lower.includes(headers[i].toLowerCase())) return i
    }
    return -1
  }
  return {
    headers,
    includeMarkerOnlyRows: options?.includeMarkerOnlyRows === true,
    includeSdkSaccades: options?.includeSdkSaccades === true,
    pointMode: options?.pointMode || 'auto',
    pupilSamplesOnly: options?.pupilSamplesOnly === true,
    pointSource:
      options?.pointSource === 'recommended' || options?.pointSource === 'raw' || options?.pointSource === 'smooth'
        ? options.pointSource
        : 'smooth',
    isGlassesMode: options?.isGlassesMode === true,
    frameWidth: Math.max(1, Number(options?.frameWidth) || 1280),
    frameHeight: Math.max(1, Number(options?.frameHeight) || 720),
    glassesSpaceHint: null,
    nextLegacyFixationIndex: 0,
    indexes: {
      sourceModel: findIndex(['source_model']),
      sourceEventType: findIndex(['source_event_type']),
      pupilBlink: findIndex(['blink']),
      fixState: findIndex(['fixation_state', 'fixationState']),
      fixCenterX: findIndex(['fixation_center_x', 'fixationCenterX']),
      fixCenterY: findIndex(['fixation_center_y', 'fixationCenterY']),
      fixPointXPx: findIndex(['fixation_point_x_px']),
      fixPointYPx: findIndex(['fixation_point_y_px']),
      fixDurMs: findIndex(['fixation_duration_ms', 'fixation_duration', 'fixationDurationMs']),
      fixCount: findIndex(['fixation_count', 'fixationCount']),
      fixationIndex: findIndex(['fixation_index']),
      saccadeIndex: findIndex(['saccade_index']),
      fixTsMs: findIndex(['fixation_timestamp_ms', 'fixation_timestamp', 'fixationTimestampMs']),
      videoTime: findIndex(['video_time_ms']),
      timestamp: findIndex(['timestamp']),
      lPupilDiaMm: findIndex(['left_pupil_diameter_mm', 'leftPupilDiameterMm']),
      rPupilDiaMm: findIndex(['right_pupil_diameter_mm', 'rightPupilDiameterMm']),
      lPupilDia: findIndex(['left_pupil_diameter', 'leftPupilDiameter']),
      rPupilDia: findIndex(['right_pupil_diameter', 'rightPupilDiameter']),
      lPupilMmValid: findIndex(['left_pupil_diameter_mm_valid']),
      rPupilMmValid: findIndex(['right_pupil_diameter_mm_valid']),
      lPupilValid: findIndex(['left_pupil_valid']),
      rPupilValid: findIndex(['right_pupil_valid']),
      lPupilModelQuality: findIndex(['left_pupil_model_quality']),
      rPupilModelQuality: findIndex(['right_pupil_model_quality']),
      saccadeAmplitude: findIndex(['saccade_amplitude', 'saccadeAmplitude', 'saccade_distance_px']),
      saccadeDuration: findIndex(['saccade_duration_ms', 'saccade_duration', 'saccadeDurationMs']),
      saccadeVelocity: findIndex(['saccade_velocity', 'saccadeVelocity', 'average_saccade_velocity_px_ms']),
      saccadePeakVelocity: findIndex(['saccade_peak_velocity', 'saccadePeakVelocity', 'peak_saccade_velocity_px_ms']),
      saccadeStartX: findIndex(['saccade_start_x']),
      saccadeStartY: findIndex(['saccade_start_y']),
      saccadeEndX: findIndex(['saccade_end_x']),
      saccadeEndY: findIndex(['saccade_end_y']),
      leftBlink: findIndex(['left_blink', 'leftBlink']),
      rightBlink: findIndex(['right_blink', 'rightBlink']),
      stimulus: findIndex(['stimulus']),
      triggerMark: findIndex(['triggerMark']),
      customMarker: findIndex(['customMarker']),
      recomX: findIndex(['recom_gaze_x', 'recomGazeX']),
      recomY: findIndex(['recom_gaze_y', 'recomGazeY']),
      recomMask: findIndex(['recom_gaze_bit_mask']),
      recomGazePointX: findIndex(['recom_gaze_point_x']),
      recomGazePointY: findIndex(['recom_gaze_point_y']),
      recomRawPointX: findIndex(['recom_raw_point_x']),
      recomRawPointY: findIndex(['recom_raw_point_y']),
      recomSmoothPointX: findIndex(['recom_smooth_point_x']),
      recomSmoothPointY: findIndex(['recom_smooth_point_y']),
      lMask: findIndex(['left_gaze_bit_mask']),
      lGazePointX: findIndex(['left_gaze_point_x']),
      lGazePointY: findIndex(['left_gaze_point_y']),
      lRawPointX: findIndex(['left_raw_point_x']),
      lRawPointY: findIndex(['left_raw_point_y']),
      lSmoothPointX: findIndex(['left_smooth_point_x']),
      lSmoothPointY: findIndex(['left_smooth_point_y']),
      rMask: findIndex(['right_gaze_bit_mask']),
      rGazePointX: findIndex(['right_gaze_point_x']),
      rGazePointY: findIndex(['right_gaze_point_y']),
      rRawPointX: findIndex(['right_raw_point_x']),
      rRawPointY: findIndex(['right_raw_point_y']),
      rSmoothPointX: findIndex(['right_smooth_point_x']),
      rSmoothPointY: findIndex(['right_smooth_point_y']),
    },
  }
}

const normalize01Main = (v: number): number => {
  if (!Number.isFinite(v)) return NaN
  const tolerance = 0.001
  if (v < -tolerance || v > 1 + tolerance) return NaN
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

const normalizeMainGazePoint = (
  state: CsvPointParserState,
  rawX: number,
  rawY: number,
): { point: { x: number; y: number } | null; space: CsvPointParserState['glassesSpaceHint'] } => {
  if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return { point: null, space: state.glassesSpaceHint }
  if (!state.isGlassesMode) {
    const x = normalize01Main(rawX)
    const y = normalize01Main(rawY)
    return {
      point: Number.isNaN(x) || Number.isNaN(y) ? null : { x, y },
      space: null,
    }
  }
  const x = rawX
  const y = rawY
  const outsideNormalized = x < -0.01 || x > 1.01 || y < -0.01 || y > 1.01
  const absMax = Math.max(Math.abs(x), Math.abs(y))
  // 与录制侧 gazeMapping.ts 对齐：scene-centered 且 |x|/|y| 均不超过 32 的点
  // 靠近画面中心，眼镜 SDK 常返回为无意义的小抖动值。录制侧会丢弃这类点，
  // 回放侧若继续走旧的 centered_small 分支会把它放大到整个画面，导致轨迹与录制不一致。
  if (outsideNormalized && absMax <= 32) {
    return { point: null, space: state.glassesSpaceHint }
  }
  let inferred: NonNullable<CsvPointParserState['glassesSpaceHint']>
  if (outsideNormalized) {
    inferred = 'centered_pixels'
  } else if (state.glassesSpaceHint === 'centered_pixels') {
    inferred = 'centered_pixels'
  } else {
    inferred = 'normalized'
  }
  if (inferred === 'centered_pixels') {
    const nx = (x + state.frameWidth * 0.5) / state.frameWidth
    const ny = (y + state.frameHeight * 0.5) / state.frameHeight
    if (nx < -0.03 || nx > 1.03 || ny < -0.03 || ny > 1.03) return { point: null, space: 'centered_pixels' }
    return { point: { x: Math.max(0, Math.min(1, nx)), y: Math.max(0, Math.min(1, ny)) }, space: 'centered_pixels' }
  }
  return { point: { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }, space: 'normalized' }
}

export const parseCsvPartsToHeatmapPoint = (parts: string[], state: CsvPointParserState): MainHeatmapPoint | null => {
  const idx = state.indexes
  const getValue = (i: number): number => {
    if (i < 0 || i >= parts.length) return NaN
    const raw = parts[i].trim()
    if (!raw) return NaN
    const v = Number(raw)
    return Number.isNaN(v) ? NaN : v
  }
  const getStringValue = (i: number): string | undefined => {
    if (i < 0 || i >= parts.length) return undefined
    const raw = parts[i].trim()
    return raw || undefined
  }
  const resolveMillis = (msIdx: number): number => {
    const ms = getValue(msIdx)
    return Number.isNaN(ms) ? NaN : ms
  }
  const parseBlinkState = (i: number): boolean | undefined => {
    if (i < 0 || i >= parts.length) return undefined
    const raw = String(parts[i] || '').trim()
    if (!raw) return undefined
    const numeric = Number(raw)
    if (Number.isFinite(numeric)) {
      if (numeric === 3 || numeric === 6) return true
      if (numeric === 0 || numeric === 10) return false
      return numeric !== 0
    }
    return undefined
  }
  const parsePupilSide = (mmIdx: number, baseIdx: number): number | undefined => {
    const mm = getValue(mmIdx)
    if (Number.isFinite(mm) && mm > 0) return mm
    // Pupil's unqualified diameter is an image-width ratio (legacy files: pixels), never millimetres.
    if (getStringValue(idx.sourceModel) === 'PupilCore') return undefined
    const raw = getValue(baseIdx)
    return Number.isFinite(raw) && raw > 0 ? raw : undefined
  }
  const hasBit = (mask: number, bit: number): boolean => Number.isFinite(mask) && ((Math.trunc(mask) >> bit) & 0x1) === 0x1
  const hasDisplayBit = (mask: number): boolean => Number.isFinite(mask) && (Math.trunc(mask) & 0x7) !== 0
  const isZeroPair = (gx: number, gy: number): boolean => Math.abs(gx) < 0.000001 && Math.abs(gy) < 0.000001
  const usablePair = (gx: number, gy: number, mask: number, bit?: number): boolean => {
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) return false
    if (['PupilCore', 'HH_ET10C', 'HH_ET28'].includes(getStringValue(idx.sourceModel))) {
      return gx >= 0 && gx <= 1 && gy >= 0 && gy <= 1
        && (typeof bit === 'number' ? hasBit(mask, bit) : hasDisplayBit(mask))
    }
    if (isZeroPair(gx, gy)) return false
    if (!Number.isFinite(mask)) return true
    if (typeof bit === 'number') return hasBit(mask, bit)
    return hasDisplayBit(mask)
  }
  const pickDisplayPoint = (
    mask: number,
    selectedX: number,
    selectedY: number,
    gazeX: number,
    gazeY: number,
    rawPointX: number,
    rawPointY: number,
    smoothX: number,
    smoothY: number,
  ): { x: number; y: number } | null => {
    const sourceCandidates =
      state.pointSource === 'recommended'
        ? [
            { x: selectedX, y: selectedY, bit: undefined },
            { x: gazeX, y: gazeY, bit: 0 },
          ]
        : state.pointSource === 'raw'
          ? [{ x: rawPointX, y: rawPointY, bit: 1 }]
          : [{ x: smoothX, y: smoothY, bit: 2 }]
    for (const candidate of sourceCandidates) {
      if (usablePair(candidate.x, candidate.y, mask, candidate.bit)) return { x: candidate.x, y: candidate.y }
    }
    if (usablePair(smoothX, smoothY, mask, 2)) return { x: smoothX, y: smoothY }
    if (usablePair(selectedX, selectedY, mask)) return { x: selectedX, y: selectedY }
    if (usablePair(gazeX, gazeY, mask, 0)) return { x: gazeX, y: gazeY }
    if (usablePair(rawPointX, rawPointY, mask, 1)) return { x: rawPointX, y: rawPointY }
    return null
  }

  let x = NaN
  let y = NaN
  let weight = NaN
  let id: number | undefined
  let timestamp: number | undefined
  let fixationState: number | undefined
  let fixationTimestampMs: number | undefined
  let fixationDurationMs: number | undefined
  const videoTimeMs = getValue(idx.videoTime)
  const stimulusName = getStringValue(idx.stimulus)
  const triggerMark = getStringValue(idx.triggerMark)
  const customMarker = getStringValue(idx.customMarker)
  const hasTimelineMarker = Boolean(triggerMark || customMarker)
  const leftBlink = parseBlinkState(idx.leftBlink)
  const rightBlink = parseBlinkState(idx.rightBlink)
  const leftPupilDiameter = leftBlink === true || getValue(idx.lPupilValid) === 0 || getValue(idx.lPupilMmValid) === 0 || getStringValue(idx.lPupilModelQuality) === 'bad'
    ? undefined : parsePupilSide(idx.lPupilDiaMm, idx.lPupilDia)
  const rightPupilDiameter = rightBlink === true || getValue(idx.rPupilValid) === 0 || getValue(idx.rPupilMmValid) === 0 || getStringValue(idx.rPupilModelQuality) === 'bad'
    ? undefined : parsePupilSide(idx.rPupilDiaMm, idx.rPupilDia)
  const pupilDiameter =
    typeof leftPupilDiameter === 'number' && typeof rightPupilDiameter === 'number'
      ? (leftPupilDiameter + rightPupilDiameter) / 2
      : typeof leftPupilDiameter === 'number'
        ? leftPupilDiameter
        : rightPupilDiameter
  const isPupil = ['PupilCore', 'HH_ET10C', 'HH_ET28'].includes(getStringValue(idx.sourceModel))
  const pupilEventType = isPupil ? getStringValue(idx.sourceEventType) : ''
  // Event-only rows must not inflate the gaze count or fabricate a position.
  if (isPupil && state.pointMode === 'gaze' && pupilEventType) return null
  const blink = leftBlink === true || rightBlink === true || (isPupil && parseBlinkState(idx.pupilBlink) === true)
  const saccadeDurationMs = resolveMillis(idx.saccadeDuration)
  const saccadeAmplitude = getValue(idx.saccadeAmplitude)
  const saccadeVelocity = getValue(idx.saccadeVelocity)
  const saccadePeakVelocity = getValue(idx.saccadePeakVelocity)
  const rawSaccadeStartX = normalize01Main(getValue(idx.saccadeStartX))
  const rawSaccadeStartY = normalize01Main(getValue(idx.saccadeStartY))
  const rawSaccadeEndX = normalize01Main(getValue(idx.saccadeEndX))
  const rawSaccadeEndY = normalize01Main(getValue(idx.saccadeEndY))
  const hasParsedSaccadeValue =
    Number.isFinite(saccadeDurationMs) ||
    Number.isFinite(saccadeAmplitude) ||
    Number.isFinite(saccadeVelocity) ||
    Number.isFinite(saccadePeakVelocity)
  const hasFixationFields = idx.fixState !== -1 && idx.fixCenterX !== -1 && idx.fixCenterY !== -1
  const useFixationOnly = state.pointMode === 'fixation'
  const assignFixationLike = (): boolean => {
    if (!hasFixationFields) return false
    const stateValue = getValue(idx.fixState)
    const isFixationState = stateValue === 3 || stateValue === 4
    const isSdkSaccadeState = stateValue === 1 || stateValue === 2
    if (!isFixationState && !(state.includeSdkSaccades && isSdkSaccadeState)) return false
    const explicitPxX = getValue(idx.fixPointXPx)
    const explicitPxY = getValue(idx.fixPointYPx)
    const hasExplicitPixels = Number.isFinite(explicitPxX) && Number.isFinite(explicitPxY)
    const fx = hasExplicitPixels ? explicitPxX / state.frameWidth : getValue(idx.fixCenterX)
    const fy = hasExplicitPixels ? explicitPxY / state.frameHeight : getValue(idx.fixCenterY)
    const fdur = resolveMillis(idx.fixDurMs)
    const fixationIndex = getValue(idx.fixationIndex)
    const saccadeIndex = getValue(idx.saccadeIndex)
    const fcount = Number.isFinite(fixationIndex) ? fixationIndex : getValue(idx.fixCount)
    const fts = resolveMillis(idx.fixTsMs)
    if (!isSdkSaccadeState && !Number.isNaN(fcount) && fcount <= 0) return false
    if (useFixationOnly && isFixationState && stateValue !== 4 && !(hasParsedSaccadeValue && !Number.isNaN(fcount))) return false
    const desktopFixationPoint = !state.isGlassesMode || hasExplicitPixels
      ? (() => {
          const nx = normalize01Main(fx)
          const ny = normalize01Main(fy)
          return Number.isNaN(nx) || Number.isNaN(ny) ? null : { x: nx, y: ny }
        })()
      : null
    const normalized = isPupil && !hasExplicitPixels
      ? { point: Number.isFinite(fx) && Number.isFinite(fy) && fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1
        ? { x: fx, y: fy } : null, space: 'normalized' as const }
      : hasExplicitPixels
      ? { point: desktopFixationPoint, space: state.glassesSpaceHint }
      : state.isGlassesMode
        ? normalizeMainGazePoint(state, fx, fy)
        : { point: desktopFixationPoint, space: null }
    if (normalized.point) {
      state.glassesSpaceHint = normalized.space
      x = normalized.point.x
      y = normalized.point.y
    } else if (isSdkSaccadeState && !assignGazeLike()) {
      return false
    } else if (!isSdkSaccadeState) {
      return false
    }
    weight = !Number.isNaN(fdur) ? fdur : 1
    let eventIndex = isSdkSaccadeState && Number.isFinite(saccadeIndex) ? saccadeIndex : fcount
    if (!isSdkSaccadeState && !Number.isFinite(fixationIndex) && stateValue === 4) {
      state.nextLegacyFixationIndex += 1
      eventIndex = state.nextLegacyFixationIndex
    }
    if (!Number.isNaN(eventIndex) && eventIndex > 0) id = eventIndex
    if (!Number.isNaN(fts)) timestamp = fts
    if (!Number.isNaN(fts)) fixationTimestampMs = fts
    if (!Number.isNaN(fdur)) fixationDurationMs = fdur
    fixationState = stateValue
    return true
  }
  const assignGazeLike = (): boolean => {
    // Pupil native files retain normalized image gaze separately from 3D point
    // columns. All display modes use the calibrated 2D gaze (no extra filter).
    if (getStringValue(idx.sourceModel) === 'PupilCore') {
      const px = getValue(idx.recomX)
      const py = getValue(idx.recomY)
      if (!(getValue(idx.recomMask) & 1) || !Number.isFinite(px) || !Number.isFinite(py) || px < 0 || px > 1 || py < 0 || py > 1) return false
      x = px
      y = py
      state.glassesSpaceHint = 'normalized'
      return true
    }
    const recomDisplay = pickDisplayPoint(
      getValue(idx.recomMask),
      getValue(idx.recomX),
      getValue(idx.recomY),
      getValue(idx.recomGazePointX),
      getValue(idx.recomGazePointY),
      getValue(idx.recomRawPointX),
      getValue(idx.recomRawPointY),
      getValue(idx.recomSmoothPointX),
      getValue(idx.recomSmoothPointY),
    )
    const leftDisplay = pickDisplayPoint(
      getValue(idx.lMask),
      NaN,
      NaN,
      getValue(idx.lGazePointX),
      getValue(idx.lGazePointY),
      getValue(idx.lRawPointX),
      getValue(idx.lRawPointY),
      getValue(idx.lSmoothPointX),
      getValue(idx.lSmoothPointY),
    )
    const rightDisplay = pickDisplayPoint(
      getValue(idx.rMask),
      NaN,
      NaN,
      getValue(idx.rGazePointX),
      getValue(idx.rGazePointY),
      getValue(idx.rRawPointX),
      getValue(idx.rRawPointY),
      getValue(idx.rSmoothPointX),
      getValue(idx.rSmoothPointY),
    )
    let rawX = NaN
    let rawY = NaN
    if (!state.isGlassesMode) {
      const resolveDesktopPath = (
        source: 'recommended' | 'raw' | 'smooth',
      ): { x: number; y: number } | null => {
        const bit = source === 'recommended' ? 0 : source === 'raw' ? 1 : 2
        const candidates = source === 'recommended'
          ? {
              recom: { x: getValue(idx.recomX), y: getValue(idx.recomY), mask: getValue(idx.recomMask) },
              left: { x: getValue(idx.lGazePointX), y: getValue(idx.lGazePointY), mask: getValue(idx.lMask) },
              right: { x: getValue(idx.rGazePointX), y: getValue(idx.rGazePointY), mask: getValue(idx.rMask) },
            }
          : source === 'raw'
            ? {
                recom: { x: getValue(idx.recomRawPointX), y: getValue(idx.recomRawPointY), mask: getValue(idx.recomMask) },
                left: { x: getValue(idx.lRawPointX), y: getValue(idx.lRawPointY), mask: getValue(idx.lMask) },
                right: { x: getValue(idx.rRawPointX), y: getValue(idx.rRawPointY), mask: getValue(idx.rMask) },
              }
            : {
                recom: { x: getValue(idx.recomSmoothPointX), y: getValue(idx.recomSmoothPointY), mask: getValue(idx.recomMask) },
                left: { x: getValue(idx.lSmoothPointX), y: getValue(idx.lSmoothPointY), mask: getValue(idx.lMask) },
                right: { x: getValue(idx.rSmoothPointX), y: getValue(idx.rSmoothPointY), mask: getValue(idx.rMask) },
              }
        const validPoint = (candidate: { x: number; y: number; mask: number }): { x: number; y: number } | null => {
          if (!usablePair(candidate.x, candidate.y, candidate.mask, bit)) return null
          const x = normalize01Main(candidate.x)
          const y = normalize01Main(candidate.y)
          return Number.isNaN(x) || Number.isNaN(y) ? null : { x, y }
        }
        const recom = validPoint(candidates.recom)
        if (recom) return recom
        const left = validPoint(candidates.left)
        const right = validPoint(candidates.right)
        if (left && right) return { x: (left.x + right.x) * 0.5, y: (left.y + right.y) * 0.5 }
        return left || right
      }
      const sourceOrder: Array<'recommended' | 'raw' | 'smooth'> = [
        state.pointSource,
        ...(['smooth', 'recommended', 'raw'] as const).filter((source) => source !== state.pointSource),
      ]
      const desktopDisplay = sourceOrder
        .map(resolveDesktopPath)
        .find((point): point is { x: number; y: number } => Boolean(point)) || null
      if (!desktopDisplay) return false
      rawX = desktopDisplay.x
      rawY = desktopDisplay.y
    } else if (recomDisplay) {
      rawX = recomDisplay.x
      rawY = recomDisplay.y
    } else if (leftDisplay && rightDisplay) {
      rawX = (leftDisplay.x + rightDisplay.x) / 2
      rawY = (leftDisplay.y + rightDisplay.y) / 2
    } else if (leftDisplay) {
      rawX = leftDisplay.x
      rawY = leftDisplay.y
    } else if (rightDisplay) {
      rawX = rightDisplay.x
      rawY = rightDisplay.y
    } else {
      return false
    }
    const normalized = ['PupilCore', 'HH_ET10C', 'HH_ET28'].includes(getStringValue(idx.sourceModel))
      ? { point: { x: rawX, y: rawY }, space: 'normalized' as const }
      : normalizeMainGazePoint(state, rawX, rawY)
    if (!normalized.point) return false
    state.glassesSpaceHint = normalized.space
    x = normalized.point.x
    y = normalized.point.y
    return true
  }

  if (useFixationOnly) {
    if (!assignFixationLike() && !(state.includeMarkerOnlyRows && hasTimelineMarker)) return null
  } else {
    if (state.pointMode === 'gaze') {
      assignGazeLike() || (!state.pupilSamplesOnly && assignFixationLike())
    } else {
      assignFixationLike() || assignGazeLike()
    }
  }
  if (!Number.isNaN(videoTimeMs)) {
    timestamp = videoTimeMs
  } else {
    const rawTs = getValue(idx.timestamp)
    if (!Number.isNaN(rawTs)) timestamp = rawTs
  }
  // Statistical samples must have a usable time; a missing/invalid clock is
  // never an observation at video time zero.
  if (state.pupilSamplesOnly && idx.videoTime >= 0 && !Number.isFinite(videoTimeMs)) return null
  if (state.pupilSamplesOnly && !Number.isFinite(timestamp)) return null
  let markerOnly = false
  const samplePositionValid = Number.isFinite(x) && Number.isFinite(y)
  const pupilWithoutGaze = state.pupilSamplesOnly && !samplePositionValid
    && typeof pupilDiameter === 'number' && pupilDiameter > 0 && Number.isFinite(timestamp)
  if (Number.isNaN(x) || Number.isNaN(y)) {
    if (!pupilWithoutGaze) {
      if (!(state.includeMarkerOnlyRows && hasTimelineMarker && Number.isFinite(timestamp))) return null
      markerOnly = true
    }
  }
  const nx = markerOnly ? 0 : normalize01Main(x)
  const ny = markerOnly ? 0 : normalize01Main(y)
  if (!markerOnly && !pupilWithoutGaze && (Number.isNaN(nx) || Number.isNaN(ny))) return null
  return {
    x: nx,
    y: ny,
    weight: !markerOnly && !Number.isNaN(weight) ? weight : undefined,
    id,
    timestamp,
    timeBase: Number.isFinite(videoTimeMs) ? 'video_time_ms' : undefined,
    fixationState,
    fixationTimestampMs,
    fixationDurationMs,
    blink: blink ? true : undefined,
    leftBlink,
    rightBlink,
    pupilDiameter: typeof pupilDiameter === 'number' && Number.isFinite(pupilDiameter) ? pupilDiameter : undefined,
    leftPupilDiameter,
    rightPupilDiameter,
    saccadeDurationMs: Number.isFinite(saccadeDurationMs) ? saccadeDurationMs : undefined,
    saccadeAmplitude: Number.isFinite(saccadeAmplitude) ? saccadeAmplitude : undefined,
    saccadeVelocity: Number.isFinite(saccadeVelocity) ? saccadeVelocity : undefined,
    saccadePeakVelocity: Number.isFinite(saccadePeakVelocity) ? saccadePeakVelocity : undefined,
    saccadeMetricUnit: [idx.saccadeAmplitude, idx.saccadeVelocity, idx.saccadePeakVelocity]
      .some((index) => /_px(?:_ms)?$/.test(state.headers[index] || '')) ? 'pixels' : 'normalized',
    saccadeStartX: Number.isFinite(rawSaccadeStartX) ? rawSaccadeStartX : undefined,
    saccadeStartY: Number.isFinite(rawSaccadeStartY) ? rawSaccadeStartY : undefined,
    saccadeEndX: Number.isFinite(rawSaccadeEndX) ? rawSaccadeEndX : undefined,
    saccadeEndY: Number.isFinite(rawSaccadeEndY) ? rawSaccadeEndY : undefined,
    stimulusName,
    triggerMark,
    customMarker,
    markerOnly: markerOnly || undefined,
    sampleOnly: state.pupilSamplesOnly || undefined,
    samplePositionValid: state.pupilSamplesOnly ? samplePositionValid : undefined,
    parseVersion: RECORD_POINTS_PARSE_VERSION,
  }
}

export const inspectGlassesModeSample = (
  parts: string[],
  state: CsvPointParserState,
): { finite: number; centeredLike: number } => {
  const idx = state.indexes
  const getValue = (i: number): number => {
    if (i < 0 || i >= parts.length) return NaN
    const raw = parts[i].trim()
    if (!raw) return NaN
    const v = Number(raw)
    return Number.isFinite(v) ? v : NaN
  }
  const hasDisplayPointBit = (mask: number): boolean => Number.isFinite(mask) && (Math.trunc(mask) & 0x7) !== 0
  const pairs = [
    { xIdx: idx.recomX, yIdx: idx.recomY, maskIdx: idx.recomMask },
    { xIdx: idx.lSmoothPointX, yIdx: idx.lSmoothPointY, maskIdx: idx.lMask },
    { xIdx: idx.rSmoothPointX, yIdx: idx.rSmoothPointY, maskIdx: idx.rMask },
  ]
  let finite = 0
  let centeredLike = 0
  for (const pair of pairs) {
    const x = getValue(pair.xIdx)
    const y = getValue(pair.yIdx)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (Math.abs(x) < 0.000001 && Math.abs(y) < 0.000001) continue
    const mask = getValue(pair.maskIdx)
    if (Number.isFinite(mask) && !hasDisplayPointBit(mask)) continue
    finite += 1
    if (x < -0.01 || x > 1.01 || y < -0.01 || y > 1.01) centeredLike += 1
  }
  return { finite, centeredLike }
}

export const finalizeMainHeatmapPoints = (points: MainHeatmapPoint[]): MainHeatmapPoint[] => {
  points.sort((a, b) => {
    if (a.timestamp !== undefined && b.timestamp !== undefined) return a.timestamp - b.timestamp
    return 0
  })
  return points
}
