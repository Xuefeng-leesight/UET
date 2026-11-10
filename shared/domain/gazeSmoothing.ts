/** MRT software-defined smoothing; neither Pupil nor 7invensun's proprietary filter. */
export const GAZE_SMOOTHING_V1 = Object.freeze({
  algorithm: 'mrt_causal_3d_lowpass', version: 1, timeConstantMs: 25, maxGapMs: 100,
  coordinateSpace: 'world_camera_mm', initialization: 'second_continuous_valid_sample',
})
export const GAZE_SMOOTHING_PROVENANCE = JSON.stringify(GAZE_SMOOTHING_V1)
export type GazeVector3 = readonly [number, number, number]

/** One independent stream. No resampling, extrapolation, or future samples. */
export function createGazeSmoothingFilter() {
  let previous: { timeMs: number; point: GazeVector3; context: string } | null = null
  const reset = () => { previous = null }
  return {
    reset,
    add(input: { timeMs: number | null; point: GazeVector3 | null; context: string }): GazeVector3 | null {
      const { timeMs, point, context } = input
      if (timeMs === null || !Number.isFinite(timeMs) || !point || point.some(value => !Number.isFinite(value))) {
        reset()
        return null
      }
      const before = previous
      if (before && timeMs <= before.timeMs) { reset(); return null }
      if (!before || before.context !== context || timeMs - before.timeMs > GAZE_SMOOTHING_V1.maxGapMs) {
        previous = { timeMs, point, context }
        return null
      }
      const alpha = -Math.expm1(-(timeMs - before.timeMs) / GAZE_SMOOTHING_V1.timeConstantMs)
      // The weighted form also avoids overflowing the difference of large opposite inputs.
      const filtered = point.map((value, axis) => before.point[axis] * (1 - alpha) + value * alpha) as unknown as GazeVector3
      if (filtered.some(value => !Number.isFinite(value))) { reset(); return null }
      previous = { timeMs, point: filtered, context }
      return filtered
    },
  }
}
