import type { TimeSegment, TimelineMarker } from '../../domain/timeline';
import type { CalibrationScores } from '../../domain/calibrationScores';

export const PROJECT_SCHEMA_VERSION = 2 as const;

export type ModalityId = 'eye-tracking' | 'facial-expression';

export type EyeTrackingModality = {
  id: 'eye-tracking';
  enabled: true;
  config: {
    deviceType: '桌面式' | '眼镜式';
    deviceModel: 'Pro' | 'A8' | 'aSeeGlassesPlus' | 'PupilCore' | 'HH_ET10C' | 'HH_ET28';
  };
};

export type FacialExpressionModality = {
  id: 'facial-expression';
  enabled: true;
  config: {
    width?: number;
    height?: number;
    fps?: number;
  };
};

export type ProjectModality = EyeTrackingModality | FacialExpressionModality;

export interface Project {
  id: string;
  name: string;
  code: string;
  manager: string;
  deviceType?: '桌面式' | '眼镜式';
  deviceModel?: 'Pro' | 'A8' | 'aSeeGlassesPlus' | 'PupilCore' | 'HH_ET10C' | 'HH_ET28';
  updatedAt: string;
  notes: string;
  schemaVersion?: typeof PROJECT_SCHEMA_VERSION;
  modalities?: ProjectModality[];
}

export interface Experiment {
  id: string;
  name: string;
  dir: string;
  createdAt?: string;
  updatedAt?: string;
  builtin?: boolean;
}

export interface Subject {
  id: string;
  name: string;
  gender: string;
  age: string;
  [key: string]: unknown;
}

export interface Stimulus {
  id: string;
  name: string;
  url: string;
  order?: number;
  fixedTimeMs?: number;
  playToEnd?: boolean;
  active?: boolean;
  stimulusType?: 'image' | 'video' | 'audio' | 'text' | 'web' | 'group' | 'combo';
  text?: string;
  comboItems?: Array<{
    id: string;
    name: string;
    type: 'image' | 'video' | 'audio' | 'text' | 'web';
    url?: string;
    text?: string;
    widthPct: number;
    heightPct: number;
    centerXPct: number;
    centerYPct: number;
    loop?: boolean;
    fontSize?: number;
    fontColor?: string;
    bgColor?: string;
  }>;
  comboCanvasStyle?: 'fullscreen' | 'landscape' | 'classic' | 'square' | 'portrait';
}

export interface RecordingRecord {
  id: string;
  name: string;
  subjectName: string;
  timestamp: string;
  duration: string;
  fps: string;
  calibrationLeftScore?: number;
  calibrationRightScore?: number;
  calibrationScores?: CalibrationScores;
  country?: string;
  deviceType?: string;
  deviceModel?: string;
  samplingRateHz?: number;
  configuredSamplingRateHz?: number;
  validityPercent?: number;
  durationSeconds?: number;
  videoWidth?: number;
  videoHeight?: number;
  mp4Path?: string;
  mp4Url?: string;
  csvPath?: string;
  markers?: Array<{
    type: 'custom' | 'trigger';
    name?: string;
    triggerValue?: number;
    timestamp: number;
    videoTime: number;
  }>;
  timelineMarkers?: TimelineMarker[];
  timelineSegments?: TimeSegment[];
  modalities?: Partial<Record<ModalityId, {
    status: 'complete' | 'partial' | 'failed';
    sourcePath?: string;
    dataPath?: string;
    analysisPath?: string;
    message?: string;
  }>>;
}

export type ViewType = 'dashboard' | 'detail';
export type TabType =
  | 'subject'
  | 'project-settings'
  | 'images'
  | 'video'
  | 'monitor'
  | 'visual'
  | 'mapping'
  | 'aoi'
  | 'chart'
  | 'export'
  | 'insight'
  | 'facial';
