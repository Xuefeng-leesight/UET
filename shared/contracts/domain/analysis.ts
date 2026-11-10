/** A complete, matched blink interval; it has no inferred gaze position. */
export interface BlinkInterval {
  id: string;
  startTimeMs: number;
  endTimeMs: number;
  eye: 'left' | 'right' | 'unspecified';
  sourceGeneration: string;
  stimulusName?: string;
}

export interface BlinkIntervalData {
  intervals: BlinkInterval[];
  unpairedPhaseCount: number;
}

/** Serializable gaze/fixation point shared by renderer and main-process analysis. */
export interface HeatmapPoint {
  x: number;
  y: number;
  weight?: number;
  id?: number;
  timestamp?: number;
  timeBase?: 'video_time_ms';
  fixationState?: number;
  fixationTimestampMs?: number;
  fixationDurationMs?: number;
  fixationSource?: 'mrt_7invensun_fallback';
  blink?: boolean;
  leftBlink?: boolean;
  rightBlink?: boolean;
  pupilDiameter?: number;
  leftPupilDiameter?: number;
  rightPupilDiameter?: number;
  /** Actual gaze sample used only for pupil statistics, never a fixation event. */
  sampleOnly?: boolean;
  /** Pupil-only samples may lack valid gaze; never assign those to an AOI. */
  samplePositionValid?: boolean;
  /** True when exact samples were loaded, including a legitimately empty sample set. */
  pupilSamplesIncluded?: boolean;
  /** Unit of the stored saccade amplitude/velocity; missing means legacy normalized units. */
  saccadeMetricUnit?: 'pixels' | 'normalized';
  saccadeDurationMs?: number;
  saccadeAmplitude?: number;
  saccadeVelocity?: number;
  saccadePeakVelocity?: number;
  saccadeStartX?: number;
  saccadeStartY?: number;
  saccadeEndX?: number;
  saccadeEndY?: number;
  stimulusName?: string;
  marker?: string;
  triggerMark?: string;
  customMarker?: string;
  markerOnly?: boolean;
  parseVersion?: number;
  gazeDisplayPath?: 'recommended' | 'raw' | 'smooth';
  visualPointMode?: 'fixation' | 'gaze';
}
