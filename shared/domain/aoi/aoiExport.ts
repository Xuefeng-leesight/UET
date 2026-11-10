import { getHitAoiNames, type NormalizedAoiShape } from './aoiReport';
import type { AoiAnalysisTimeRange } from './aoiTypes';

export type AoiExportObservation = {
  /** Reliable video time in milliseconds; never a device/epoch clock. */
  timeMs?: number | null;
  /** Scene coordinates normalized to the top-left origin. */
  x?: number | null;
  y?: number | null;
  valid?: boolean;
  kind?: 'sample' | 'event' | 'annotation';
  /** A change of source, mapping, or recording generation breaks the visit. */
  continuityKey?: string;
  breakBefore?: boolean;
};

export type AoiExportFixation = {
  /** Stable event identity including its source/generation, not just a reused index. */
  key: string;
  startTimeMs: number;
  durationMs: number;
  x: number;
  y: number;
  complete: boolean;
};

export type AoiExportOptions = {
  /** Already normalized definitions from the applicable record/stimulus scope. */
  shapes: readonly NormalizedAoiShape[];
  fixations?: readonly AoiExportFixation[];
  /** Empty events mean zero only when the caller verified the event source. */
  fixationsAvailable?: boolean;
  maxGapMs?: number;
};

export type AoiExportValues = Record<
  'aoi_id' | 'aoi_name' | 'aoi_hit' | 'aoi_enter_time_ms' | 'aoi_exit_time_ms' | 'aoi_dwell_time_ms' | 'aoi_fixation_count',
  string
>;

type Window = { start: number; end: number; key: number };
type CompleteFixation = AoiExportFixation & { endTimeMs: number };
type Visit = { enter: number; lastInside: number; count: number; cursor: number; window: Window };
type ShapeState = {
  shape: NormalizedAoiShape;
  geometry: NormalizedAoiShape;
  activation: number | null;
  ranges: Window[] | null;
  geometryValid: boolean;
  visit: Visit | null;
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const coordinate = (value: unknown): value is number => finite(value) && value >= -0.001 && value <= 1.001;
const validTime = (value: unknown): value is number => finite(value) && value >= 0;

function geometryValid(shape: NormalizedAoiShape): boolean {
  const valid = (geometry: Pick<NormalizedAoiShape, 'x' | 'y' | 'w' | 'h' | 'points'>) => shape.type === 'polygon'
    ? Array.isArray(geometry.points) && geometry.points.length >= 3 && geometry.points.every(point => coordinate(point.x) && coordinate(point.y))
    : coordinate(geometry.x) && coordinate(geometry.y) && coordinate(geometry.w) && coordinate(geometry.h) && geometry.w > 0 && geometry.h > 0;
  return valid(shape) && (shape.keyframes || []).every(frame => validTime(frame.timeMs) && valid(frame));
}

/** Match the report's ordered, non-overlapping ranges, but never turn an invalid configuration into all time. */
function windows(shape: NormalizedAoiShape): Window[] | null {
  const configured = shape.analysisTimeRanges !== undefined || shape.analysisTimeRange !== undefined;
  if (!configured) return null;
  const source: AoiAnalysisTimeRange[] = [
    ...(Array.isArray(shape.analysisTimeRanges) ? shape.analysisTimeRanges : []),
    ...(shape.analysisTimeRange ? [shape.analysisTimeRange] : []),
  ];
  // An explicitly empty list is the editor's representation of no time restriction.
  if (source.length === 0 && Array.isArray(shape.analysisTimeRanges)) return null;
  const normalized = source.filter(range => finite(range?.startTimeMs) && finite(range?.endTimeMs))
    .map(range => ({ start: Math.max(0, Math.round(range.startTimeMs)), end: Math.max(0, Math.round(range.endTimeMs)), enabled: range.enabled !== false }))
    .filter(range => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const accepted: typeof normalized = [];
  for (const range of normalized) {
    if (!accepted.length || range.start >= accepted[accepted.length - 1].end) accepted.push(range);
  }
  return accepted.flatMap((range, key) => range.enabled ? [{ start: range.start, end: range.end, key }] : []);
}

function activeWindow(state: ShapeState, time: number): Window | null {
  if (!state.geometryValid || state.shape.visible === false || state.activation === null || time < state.activation) return null;
  if (state.ranges === null) return { start: state.activation, end: Infinity, key: -1 };
  const range = state.ranges.find(item => time >= Math.max(state.activation!, item.start) && time <= item.end);
  return range ? { ...range, start: Math.max(state.activation, range.start) } : null;
}

function hit(state: ShapeState, x: number, y: number, timeMs: number): boolean {
  // Reuse the existing rectangle/ellipse/polygon and keyframe interpolation rules.
  return getHitAoiNames({ shapes: [state.geometry], x, y, timeMs }).length > 0;
}

function completeFixations(source: readonly AoiExportFixation[]): { events: CompleteFixation[]; reliable: boolean } {
  const byKey = new Map<string, CompleteFixation>();
  let reliable = true;
  for (const fixation of source) {
    if (!fixation.complete) continue;
    if (!validTime(fixation.startTimeMs) || !finite(fixation.durationMs) || fixation.durationMs <= 0 ||
        !coordinate(fixation.x) || !coordinate(fixation.y) || typeof fixation.key !== 'string' || !fixation.key.trim()) {
      reliable = false;
      continue;
    }
    const endTimeMs = fixation.startTimeMs + fixation.durationMs;
    if (!finite(endTimeMs)) { reliable = false; continue; }
    const next = { ...fixation, endTimeMs };
    const prior = byKey.get(fixation.key);
    if (prior && (prior.startTimeMs !== next.startTimeMs || prior.endTimeMs !== next.endTimeMs || prior.x !== next.x || prior.y !== next.y)) {
      throw new Error(`AOI fixation identity has conflicting complete intervals: ${fixation.key}`);
    }
    byKey.set(fixation.key, next);
  }
  return { events: [...byKey.values()].sort((a, b) => a.endTimeMs - b.endTimeMs || a.startTimeMs - b.startTimeMs), reliable };
}

function afterTime(events: readonly CompleteFixation[], time: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (events[middle].endTimeMs <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Per observed visit: enter is its first inside sample; exit is written only on
 * the first continuous, valid outside sample. Dwell is the observed inside span,
 * not an interpolated exit or a full-record aggregate. Events/annotations never
 * create/close visits. Incomplete tails and observation gaps have no exit.
 *
 * Multiple AOIs use aligned JSON arrays in stored order (unknown members null).
 * One AOI uses scalar cells; no definitions produce empty cells. This function
 * retains constant observation state; callers can stream the original CSV.
 */
export function createAoiExportRowDeriver(options: AoiExportOptions): (observation: AoiExportObservation) => AoiExportValues {
  const gap = options.maxGapMs ?? 100;
  if (!finite(gap) || gap <= 0) throw new Error('AOI observation gap must be a positive number of milliseconds');
  const ids = new Set<string>();
  const states: ShapeState[] = options.shapes.map(shape => {
    if (!shape.id || ids.has(shape.id)) throw new Error('AOI definitions require distinct nonempty IDs');
    ids.add(shape.id);
    return {
      shape,
      geometry: { ...shape, name: shape.id, visible: true, activationTimeMs: 0, analysisTimeRanges: undefined, analysisTimeRange: undefined },
      activation: shape.activationTimeMs === undefined ? 0 : validTime(shape.activationTimeMs) ? Math.round(shape.activationTimeMs) : null,
      ranges: windows(shape),
      geometryValid: geometryValid(shape),
      visit: null,
    };
  });
  const { events, reliable } = completeFixations(options.fixations || []);
  const serialize = (values: (string | number | null)[]): string => values.length === 0 ? ''
    : values.length === 1 ? values[0] === null ? '' : String(values[0]) : JSON.stringify(values);
  const identity = { aoi_id: serialize(states.map(state => state.shape.id)), aoi_name: serialize(states.map(state => state.shape.name)) };
  let previous: { time: number; source?: string } | null = null;
  const reset = () => { for (const state of states) state.visit = null; previous = null; };

  return observation => {
    const hits: (number | null)[] = states.map(() => null);
    const enters: (number | null)[] = states.map(() => null);
    const exits: (number | null)[] = states.map(() => null);
    const dwells: (number | null)[] = states.map(() => null);
    const counts: (number | null)[] = states.map(() => null);
    const output = (): AoiExportValues => ({ ...identity, aoi_hit: serialize(hits), aoi_enter_time_ms: serialize(enters),
      aoi_exit_time_ms: serialize(exits), aoi_dwell_time_ms: serialize(dwells), aoi_fixation_count: serialize(counts) });
    if (observation.kind === 'event' || observation.kind === 'annotation') return output();
    const time = observation.timeMs;
    if (!validTime(time) || observation.valid !== true || !coordinate(observation.x) || !coordinate(observation.y)) {
      reset();
      return output();
    }
    if (observation.breakBefore || (previous && (time <= previous.time || time - previous.time > gap || previous.source !== observation.continuityKey))) reset();
    for (let index = 0; index < states.length; index++) {
      const state = states[index];
      const window = activeWindow(state, time);
      if (!window) { state.visit = null; continue; }
      if (state.visit && state.visit.window.key !== window.key) state.visit = null;
      const inside = hit(state, observation.x, observation.y, time);
      hits[index] = inside ? 1 : 0;
      if (inside && !state.visit) state.visit = { enter: time, lastInside: time, count: 0, cursor: afterTime(events, time), window };
      const visit = state.visit;
      if (!visit) continue;
      if (inside) visit.lastInside = time;
      while (visit.cursor < events.length && events[visit.cursor].endTimeMs <= time) {
        const event = events[visit.cursor++];
        const eventWindow = activeWindow(state, event.startTimeMs);
        if (event.startTimeMs >= visit.enter && event.startTimeMs <= visit.lastInside && eventWindow?.key === visit.window.key &&
            hit(state, event.x, event.y, event.startTimeMs)) visit.count++;
      }
      enters[index] = visit.enter;
      dwells[index] = visit.lastInside - visit.enter;
      counts[index] = options.fixationsAvailable === true && reliable ? visit.count : null;
      if (!inside) { exits[index] = time; state.visit = null; }
    }
    previous = { time, source: observation.continuityKey };
    return output();
  };
}

export function buildAoiExportRows(options: AoiExportOptions & { observations: readonly AoiExportObservation[] }): AoiExportValues[] {
  const derive = createAoiExportRowDeriver(options);
  return options.observations.map(derive);
}
