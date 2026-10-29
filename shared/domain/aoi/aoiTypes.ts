export interface AoiPoint {
  x: number;
  y: number;
}

export interface AoiAnalysisTimeRange {
  id?: string;
  startTimeMs: number;
  endTimeMs: number;
  /** Disabled ranges remain saved and visible, but do not contribute to AOI statistics. */
  enabled?: boolean;
}

export interface AoiKeyframe {
  timeMs: number;
  metric: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  points?: AoiPoint[];
}

export interface AoiShape {
  id: string;
  name: string;
  type: 'ellipse' | 'rect' | 'polygon';
  visible: boolean;
  showStats: boolean;
  color: string;
  metric: number;
  activationTimeMs?: number;
  analysisTimeRanges?: AoiAnalysisTimeRange[];
  /** @deprecated Migrated to analysisTimeRanges when an AOI is next saved. */
  analysisTimeRange?: AoiAnalysisTimeRange;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  points?: AoiPoint[];
  keyframes?: AoiKeyframe[];
}
