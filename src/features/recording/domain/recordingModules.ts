import type { ModalityId } from '@shared/contracts/domain/models';

export type RecordingModuleId = 'eye-tracking' | 'facial';
export type MonitorTileId = 'device' | 'participant' | 'facial';

export interface FacialRecordingSettings {
  enabled: boolean;
  cameraId: string;
  cameraIndex: number | null;
  width: number;
  height: number;
  fps: number;
  showFaceBox: boolean;
  showFaceMask: boolean;
  showConfidence: boolean;
}

const IS_MACOS = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
export const DEFAULT_FACIAL_CAPTURE_PROFILE = IS_MACOS
  ? { width: 640, height: 480, fps: 15 }
  : { width: 1280, height: 720, fps: 30 };

export const DEFAULT_FACIAL_RECORDING_SETTINGS: FacialRecordingSettings = {
  enabled: true,
  cameraId: '',
  cameraIndex: null,
  ...DEFAULT_FACIAL_CAPTURE_PROFILE,
  showFaceBox: true,
  showFaceMask: false,
  showConfidence: true,
};

export const RECORDING_MODULES: ReadonlyArray<{
  id: RecordingModuleId;
  label: string;
  tileId: MonitorTileId;
  /** 采集模块所属的数据模态（与工程 modalities 对齐）。新增模态时在此登记即可按需加载。 */
  modality: ModalityId;
}> = [
  { id: 'eye-tracking', label: '眼动模块', tileId: 'device', modality: 'eye-tracking' },
  { id: 'facial', label: '表情模块', tileId: 'facial', modality: 'facial-expression' },
];

/** 监控 tile -> 数据模态映射。被试屏幕（participant）归属眼动模块，随眼动模态按需加载。 */
export const MONITOR_TILE_MODALITY: Record<MonitorTileId, ModalityId> = {
  device: 'eye-tracking',
  facial: 'facial-expression',
  participant: 'eye-tracking',
};

export function normalizeFacialRecordingSettings(value: unknown): FacialRecordingSettings {
  const raw = value && typeof value === 'object' ? value as Partial<FacialRecordingSettings> : {};
  const finiteInt = (candidate: unknown, fallback: number, min: number, max: number): number => {
    const parsed = Number(candidate);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
  };
  return {
    ...DEFAULT_FACIAL_RECORDING_SETTINGS,
    ...raw,
    width: finiteInt(raw.width, DEFAULT_FACIAL_CAPTURE_PROFILE.width, 320, 7680),
    height: finiteInt(raw.height, DEFAULT_FACIAL_CAPTURE_PROFILE.height, 240, 4320),
    fps: finiteInt(raw.fps, DEFAULT_FACIAL_CAPTURE_PROFILE.fps, 1, 120),
    cameraIndex: Number.isInteger(raw.cameraIndex) ? Number(raw.cameraIndex) : null,
  };
}
