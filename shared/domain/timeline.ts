export interface TimelineMarker {
  id: string;
  name: string;
  timestamp: number; // seconds
  color: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TimeSegment {
  id: string;
  name: string;
  startTime: number; // seconds
  endTime: number; // seconds
  color: string;
  /** Disabled segments remain visible but are excluded from global statistics. */
  enabled?: boolean;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MarkerManager {
  list(): TimelineMarker[];
  get(id: string): TimelineMarker | undefined;
  setAll(markers: unknown): TimelineMarker[];
  add(input: Omit<Partial<TimelineMarker>, 'id' | 'createdAt' | 'updatedAt'> & { name: string; timestamp: number }): TimelineMarker;
  update(id: string, patch: Partial<Omit<TimelineMarker, 'id' | 'createdAt'>>): TimelineMarker | undefined;
  remove(id: string): boolean;
  clear(): void;
  serialize(): TimelineMarker[];
}

export interface SegmentManager {
  list(): TimeSegment[];
  get(id: string): TimeSegment | undefined;
  setAll(segments: unknown, options?: { duration?: number }): TimeSegment[];
  add(
    input: Omit<Partial<TimeSegment>, 'id' | 'createdAt' | 'updatedAt'> & {
      name: string;
      startTime: number;
      endTime: number;
    },
    options?: { duration?: number },
  ): TimeSegment | undefined;
  update(
    id: string,
    patch: Partial<Omit<TimeSegment, 'id' | 'createdAt'>>,
    options?: { duration?: number },
  ): TimeSegment | undefined;
  remove(id: string): boolean;
  clear(): void;
  serialize(): TimeSegment[];
}

export interface MarkerPersistence {
  load(): Promise<unknown>;
  save(markers: TimelineMarker[]): Promise<void>;
}

const DEFAULT_MARKER_COLOR = '#f97316';
const DEFAULT_SEGMENT_COLOR = '#22c55e';
const SEGMENT_MIN_DURATION_SECONDS = 0.05;
const SEGMENT_OVERLAP_EPS = 1e-6;

const toFiniteNumber = (value: unknown): number | null => {
  const v = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(v)) return null;
  return v;
};

const clampNumber = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

const normalizeTimestampSeconds = (raw: Record<string, unknown>): number | null => {
  const rawTimestamp = toFiniteNumber(raw.timestamp);
  if (rawTimestamp === null) return null;

  // Recording markers from backend use milliseconds; timeline markers use seconds.
  const markerType = String(raw.type ?? '').trim();
  const shouldConvertMs = markerType === 'trigger' || markerType === 'custom';
  const seconds = shouldConvertMs ? rawTimestamp / 1000 : rawTimestamp;
  return Math.max(0, seconds);
};

const normalizeSegmentRange = (
  startRaw: number,
  endRaw: number,
  options?: { duration?: number },
): { startTime: number; endTime: number } => {
  const duration = Number.isFinite(options?.duration) ? Math.max(0, Number(options?.duration)) : null;

  let startTime = Math.max(0, Math.min(startRaw, endRaw));
  let endTime = Math.max(0, Math.max(startRaw, endRaw));

  if (duration !== null) {
    startTime = clampNumber(startTime, 0, duration);
    endTime = clampNumber(endTime, 0, duration);
  }

  if (endTime - startTime < SEGMENT_MIN_DURATION_SECONDS) {
    if (duration !== null && duration > 0) {
      endTime = Math.min(duration, startTime + SEGMENT_MIN_DURATION_SECONDS);
      if (endTime - startTime < SEGMENT_MIN_DURATION_SECONDS) {
        startTime = Math.max(0, endTime - SEGMENT_MIN_DURATION_SECONDS);
      }
    } else {
      endTime = startTime + SEGMENT_MIN_DURATION_SECONDS;
    }
  }

  return { startTime, endTime };
};

export const createTimelineMarker = (input: {
  name: string;
  timestamp: number;
  color?: string;
  note?: string;
}): TimelineMarker => {
  const now = new Date().toISOString();
  return {
    id: `tm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: input.name.trim() || '未命名标记',
    timestamp: Math.max(0, input.timestamp),
    color: input.color && input.color.trim() ? input.color : DEFAULT_MARKER_COLOR,
    note: input.note,
    createdAt: now,
    updatedAt: now,
  };
};

export const createTimeSegment = (input: {
  name: string;
  startTime: number;
  endTime: number;
  color?: string;
  note?: string;
  enabled?: boolean;
}, options?: { duration?: number }): TimeSegment => {
  const now = new Date().toISOString();
  const range = normalizeSegmentRange(input.startTime, input.endTime, options);
  return {
    id: `ts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: input.name.trim() || '未命名分段',
    startTime: range.startTime,
    endTime: range.endTime,
    color: input.color && input.color.trim() ? input.color : DEFAULT_SEGMENT_COLOR,
    enabled: input.enabled !== false,
    note: input.note,
    createdAt: now,
    updatedAt: now,
  };
};

export const normalizeTimelineMarkers = (input: unknown): TimelineMarker[] => {
  if (!Array.isArray(input)) return [];
  const out: TimelineMarker[] = [];

  input.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const raw = item as Record<string, unknown>;
    const ts = normalizeTimestampSeconds(raw);
    if (ts === null) return;

    const markerType = String(raw.type ?? '').trim();
    const triggerValue = toFiniteNumber(raw.triggerValue);
    const fallbackName =
      markerType === 'trigger'
        ? `Trigger ${triggerValue !== null ? triggerValue : ''}`.trim()
        : markerType === 'custom'
          ? '自定义标记'
          : `标记 ${index + 1}`;

    const name = String(raw.name ?? fallbackName).trim() || fallbackName;
    const color =
      typeof raw.color === 'string' && raw.color.trim()
        ? raw.color
        : markerType === 'trigger'
          ? '#ef4444'
          : markerType === 'custom'
            ? '#8b5cf6'
            : DEFAULT_MARKER_COLOR;

    const createdAt = typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString();
    const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : createdAt;
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id : `tm_${index}_${Math.round(ts * 1000)}`;

    out.push({
      id,
      name,
      timestamp: ts,
      color,
      note: typeof raw.note === 'string' ? raw.note : undefined,
      createdAt,
      updatedAt,
    });
  });

  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
};

export const normalizeTimeSegments = (input: unknown, options?: { duration?: number }): TimeSegment[] => {
  if (!Array.isArray(input)) return [];
  const out: TimeSegment[] = [];

  input.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const raw = item as Record<string, unknown>;

    const rawStart = toFiniteNumber(raw.startTime);
    const rawEnd = toFiniteNumber(raw.endTime);
    if (rawStart === null || rawEnd === null) return;

    const range = normalizeSegmentRange(rawStart, rawEnd, options);
    const createdAt = typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString();
    const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : createdAt;
    const id =
      typeof raw.id === 'string' && raw.id.trim()
        ? raw.id
        : `ts_${index}_${Math.round(range.startTime * 1000)}_${Math.round(range.endTime * 1000)}`;

    out.push({
      id,
      name: String(raw.name ?? `分段 ${index + 1}`).trim() || `分段 ${index + 1}`,
      startTime: range.startTime,
      endTime: range.endTime,
      color: typeof raw.color === 'string' && raw.color.trim() ? raw.color : DEFAULT_SEGMENT_COLOR,
      enabled: raw.enabled !== false,
      note: typeof raw.note === 'string' ? raw.note : undefined,
      createdAt,
      updatedAt,
    });
  });

  out.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  return out;
};

export const hasSegmentOverlap = (left: TimeSegment, right: TimeSegment): boolean => {
  return left.startTime < right.endTime - SEGMENT_OVERLAP_EPS && right.startTime < left.endTime - SEGMENT_OVERLAP_EPS;
};

export const validateTimeSegment = (
  candidate: TimeSegment,
  existing: TimeSegment[],
  options?: { allowSameId?: boolean },
): { ok: boolean; error?: string } => {
  if (!Number.isFinite(candidate.startTime) || !Number.isFinite(candidate.endTime)) {
    return { ok: false, error: '分段时间无效' };
  }
  if (candidate.startTime < 0 || candidate.endTime < 0) {
    return { ok: false, error: '分段时间不能小于 0' };
  }
  if (candidate.endTime <= candidate.startTime) {
    return { ok: false, error: '结束时间必须大于开始时间' };
  }
  if (candidate.endTime - candidate.startTime < SEGMENT_MIN_DURATION_SECONDS - SEGMENT_OVERLAP_EPS) {
    return { ok: false, error: `分段长度不能小于 ${SEGMENT_MIN_DURATION_SECONDS.toFixed(2)} 秒` };
  }

  const allowSameId = options?.allowSameId === true;
  for (const segment of existing) {
    if (allowSameId && segment.id === candidate.id) continue;
    if (hasSegmentOverlap(candidate, segment)) {
      return { ok: false, error: `与分段“${segment.name}”时间重叠` };
    }
  }

  return { ok: true };
};

export const addTimelineMarker = (
  markers: TimelineMarker[],
  input: { name: string; timestamp: number; color?: string; note?: string },
): TimelineMarker[] => {
  return normalizeTimelineMarkers([...markers, createTimelineMarker(input)]);
};

export const updateTimelineMarker = (
  markers: TimelineMarker[],
  id: string,
  patch: Partial<Omit<TimelineMarker, 'id' | 'createdAt'>>,
): TimelineMarker[] => {
  const next = markers.map((marker) => {
    if (marker.id !== id) return marker;
    const ts = patch.timestamp !== undefined ? Math.max(0, Number(patch.timestamp) || 0) : marker.timestamp;
    return {
      ...marker,
      ...patch,
      timestamp: ts,
      updatedAt: new Date().toISOString(),
    };
  });
  return normalizeTimelineMarkers(next);
};

export const removeTimelineMarker = (markers: TimelineMarker[], id: string): TimelineMarker[] => {
  return normalizeTimelineMarkers(markers.filter((marker) => marker.id !== id));
};

export const addTimeSegment = (
  segments: TimeSegment[],
  input: {
    name: string;
    startTime: number;
    endTime: number;
    color?: string;
    note?: string;
    enabled?: boolean;
  },
  options?: { duration?: number },
): { ok: boolean; segments: TimeSegment[]; segment?: TimeSegment; error?: string } => {
  const normalized = normalizeTimeSegments(segments, options);
  const candidate = createTimeSegment(input, options);
  const validation = validateTimeSegment(candidate, normalized);
  if (!validation.ok) {
    return { ok: false, segments: normalized, error: validation.error };
  }

  const next = normalizeTimeSegments([...normalized, candidate], options);
  return { ok: true, segments: next, segment: candidate };
};

export const updateTimeSegment = (
  segments: TimeSegment[],
  id: string,
  patch: Partial<Omit<TimeSegment, 'id' | 'createdAt'>>,
  options?: { duration?: number },
): { ok: boolean; segments: TimeSegment[]; segment?: TimeSegment; error?: string } => {
  const normalized = normalizeTimeSegments(segments, options);
  const target = normalized.find((segment) => segment.id === id);
  if (!target) {
    return { ok: false, segments: normalized, error: '分段不存在' };
  }

  const mergedRange = normalizeSegmentRange(
    patch.startTime !== undefined ? Number(patch.startTime) : target.startTime,
    patch.endTime !== undefined ? Number(patch.endTime) : target.endTime,
    options,
  );

  const candidate: TimeSegment = {
    ...target,
    ...patch,
    startTime: mergedRange.startTime,
    endTime: mergedRange.endTime,
    name: patch.name !== undefined ? String(patch.name).trim() || target.name : target.name,
    color: patch.color !== undefined ? String(patch.color).trim() || target.color : target.color,
    updatedAt: new Date().toISOString(),
  };

  const validation = validateTimeSegment(candidate, normalized, { allowSameId: true });
  if (!validation.ok) {
    return { ok: false, segments: normalized, error: validation.error };
  }

  const next = normalizeTimeSegments(
    normalized.map((segment) => (segment.id === id ? candidate : segment)),
    options,
  );
  return {
    ok: true,
    segments: next,
    segment: next.find((segment) => segment.id === id),
  };
};

export const removeTimeSegment = (segments: TimeSegment[], id: string, options?: { duration?: number }): TimeSegment[] => {
  return normalizeTimeSegments(
    normalizeTimeSegments(segments, options).filter((segment) => segment.id !== id),
    options,
  );
};

export class InMemoryMarkerManager implements MarkerManager {
  private markers: TimelineMarker[] = [];

  constructor(initial?: unknown) {
    this.markers = normalizeTimelineMarkers(initial ?? []);
  }

  list(): TimelineMarker[] {
    return [...this.markers];
  }

  get(id: string): TimelineMarker | undefined {
    return this.markers.find((marker) => marker.id === id);
  }

  setAll(markers: unknown): TimelineMarker[] {
    this.markers = normalizeTimelineMarkers(markers);
    return this.list();
  }

  add(input: Omit<Partial<TimelineMarker>, 'id' | 'createdAt' | 'updatedAt'> & { name: string; timestamp: number }): TimelineMarker {
    const marker = createTimelineMarker({
      name: input.name,
      timestamp: input.timestamp,
      color: input.color,
      note: input.note,
    });
    this.markers = normalizeTimelineMarkers([...this.markers, marker]);
    return marker;
  }

  update(id: string, patch: Partial<Omit<TimelineMarker, 'id' | 'createdAt'>>): TimelineMarker | undefined {
    const before = this.get(id);
    if (!before) return undefined;
    this.markers = updateTimelineMarker(this.markers, id, patch);
    return this.get(id);
  }

  remove(id: string): boolean {
    const exists = this.markers.some((marker) => marker.id === id);
    if (!exists) return false;
    this.markers = removeTimelineMarker(this.markers, id);
    return true;
  }

  clear(): void {
    this.markers = [];
  }

  serialize(): TimelineMarker[] {
    return this.list();
  }
}

export class InMemorySegmentManager implements SegmentManager {
  private segments: TimeSegment[] = [];

  constructor(initial?: unknown, options?: { duration?: number }) {
    this.segments = normalizeTimeSegments(initial ?? [], options);
  }

  list(): TimeSegment[] {
    return [...this.segments];
  }

  get(id: string): TimeSegment | undefined {
    return this.segments.find((segment) => segment.id === id);
  }

  setAll(segments: unknown, options?: { duration?: number }): TimeSegment[] {
    this.segments = normalizeTimeSegments(segments, options);
    return this.list();
  }

  add(
    input: Omit<Partial<TimeSegment>, 'id' | 'createdAt' | 'updatedAt'> & {
      name: string;
      startTime: number;
      endTime: number;
    },
    options?: { duration?: number },
  ): TimeSegment | undefined {
    const result = addTimeSegment(this.segments, input, options);
    if (!result.ok || !result.segment) return undefined;
    this.segments = result.segments;
    return result.segment;
  }

  update(
    id: string,
    patch: Partial<Omit<TimeSegment, 'id' | 'createdAt'>>,
    options?: { duration?: number },
  ): TimeSegment | undefined {
    const result = updateTimeSegment(this.segments, id, patch, options);
    if (!result.ok || !result.segment) return undefined;
    this.segments = result.segments;
    return result.segment;
  }

  remove(id: string): boolean {
    const exists = this.segments.some((segment) => segment.id === id);
    if (!exists) return false;
    this.segments = this.segments.filter((segment) => segment.id !== id);
    return true;
  }

  clear(): void {
    this.segments = [];
  }

  serialize(): TimeSegment[] {
    return this.list();
  }
}

export const loadMarkersFromPersistence = async (persistence: MarkerPersistence): Promise<TimelineMarker[]> => {
  try {
    const loaded = await persistence.load();
    return normalizeTimelineMarkers(loaded);
  } catch {
    return [];
  }
};

export const saveMarkersToPersistence = async (
  persistence: MarkerPersistence,
  markers: TimelineMarker[],
): Promise<boolean> => {
  try {
    await persistence.save(normalizeTimelineMarkers(markers));
    return true;
  } catch {
    return false;
  }
};
