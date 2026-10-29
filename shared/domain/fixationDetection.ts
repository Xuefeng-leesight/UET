import type { HeatmapPoint } from '../contracts/domain/analysis'

// Match sdk_service._fallback_fixation_stats_for_glasses: distance to the
// running center in source-image pixels, >= 100 ms and >= 6 samples.
// This is MRT's fallback, not the vendor SDK's fixation algorithm.
export const FALLBACK_FIXATION_RULE = {
  radiusPx: 35,
  minDurationMs: 100,
  minSamples: 6,
  // A missing interval must not itself satisfy the minimum dwell time.
  maxGapMs: 100,
} as const

export function createFallbackFixationDetector(options: {
  frameWidth: number
  frameHeight: number
  onFixation: (point: HeatmapPoint) => void
}) {
  type Candidate = { start: number; last: number; x: number; y: number; count: number; stimulusName?: string }
  let candidate: Candidate | null = null
  let sequence = 0
  const finish = () => {
    if (!candidate) return
    const { start, last, x, y, count, stimulusName } = candidate
    candidate = null
    const duration = last - start
    if (count < FALLBACK_FIXATION_RULE.minSamples || duration < FALLBACK_FIXATION_RULE.minDurationMs) return
    options.onFixation({
      x: x / count,
      y: y / count,
      id: ++sequence,
      // Completed events use the video-relative end time, as in the existing
      // 7invensun CSV reader. Keep the start separately for event identity.
      timestamp: last,
      timeBase: 'video_time_ms',
      fixationTimestampMs: start,
      fixationDurationMs: duration,
      fixationState: 4,
      fixationSource: 'mrt_7invensun_fallback',
      weight: duration,
      stimulusName,
    })
  }
  const add = (point: HeatmapPoint | null) => {
    const timestamp = point?.timestamp
    if (!point || point.timeBase !== 'video_time_ms' || point.markerOnly ||
        point.blink || point.leftBlink || point.rightBlink ||
        typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0 ||
        !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
        point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
      finish()
      return
    }
    if (candidate) {
      const gap = timestamp - candidate.last
      const distance = Math.hypot(
        (point.x - candidate.x / candidate.count) * options.frameWidth,
        (point.y - candidate.y / candidate.count) * options.frameHeight,
      )
      if (gap <= 0 || gap > FALLBACK_FIXATION_RULE.maxGapMs ||
          distance > FALLBACK_FIXATION_RULE.radiusPx || point.stimulusName !== candidate.stimulusName) finish()
    }
    if (!candidate) {
      candidate = { start: timestamp, last: timestamp, x: point.x, y: point.y, count: 1, stimulusName: point.stimulusName }
    } else {
      candidate.last = timestamp
      candidate.x += point.x
      candidate.y += point.y
      candidate.count += 1
    }
  }
  return { add, finish }
}
