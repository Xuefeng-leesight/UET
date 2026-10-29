export type DeviceType = '桌面式' | '眼镜式';
export type DeviceModel = 'Pro' | 'A8' | 'aSeeGlassesPlus' | 'PupilCore' | 'HH_ET10C' | 'HH_ET28';
export type CalibrationMode = 'auto' | 'click';
export type RecordSource = 'screen' | 'stream';
export type SdkResolution = 201 | 202 | 203 | 204;

export interface DeviceProfile {
  deviceType: DeviceType;
  sdkModel: DeviceModel;
  stimulusEnabled: boolean;
  calibrationMode: CalibrationMode;
  calibrationTypes: string[];
  defaultCalibrationType: string;
  recordSource: RecordSource;
  fixedSdkResolution?: SdkResolution;
}

const SDK_RESOLUTION_OPTIONS = [
  { label: '1280 * 960', value: 201 },
  { label: '1280 * 720', value: 202 },
  { label: '800 * 600', value: 203 },
  { label: '1920 * 1080', value: 204 },
] as const;

export const getSdkResolutionOptions = (profile: DeviceProfile) =>
  profile.fixedSdkResolution === undefined
    ? SDK_RESOLUTION_OPTIONS
    : SDK_RESOLUTION_OPTIONS.filter((option) => option.value === profile.fixedSdkResolution);

export const normalizeSdkResolution = (value: unknown, profile: DeviceProfile): SdkResolution => {
  if (profile.fixedSdkResolution !== undefined) return profile.fixedSdkResolution;
  const n = Number(value);
  return SDK_RESOLUTION_OPTIONS.find((option) => option.value === n)?.value ?? 202;
};

export const DESKTOP_PROFILE: DeviceProfile = {
  deviceType: '桌面式',
  sdkModel: 'Pro',
  stimulusEnabled: true,
  calibrationMode: 'auto',
  calibrationTypes: ['三点校准', '五点校准', '九点校准'],
  defaultCalibrationType: '五点校准',
  recordSource: 'screen',
};

export const GLASSES_PROFILE: DeviceProfile = {
  deviceType: '眼镜式',
  sdkModel: 'aSeeGlassesPlus',
  stimulusEnabled: true,
  calibrationMode: 'click',
  calibrationTypes: ['一点校准', '三点校准', '卡片式一点校准', '卡片式三点校准'],
  defaultCalibrationType: '三点校准',
  recordSource: 'stream',
};

export const normalizeDeviceType = (value: unknown): DeviceType => {
  const raw = String(value ?? '').trim();
  return raw === '眼镜式' ? '眼镜式' : '桌面式';
};

export const normalizeDeviceModel = (value: unknown, fallbackDeviceType?: unknown): DeviceModel => {
  const raw = String(value ?? '').trim();
  const lower = raw.toLowerCase();
  if (lower === 'hh_et10c') return 'HH_ET10C';
  if (lower === 'hh_et28') return 'HH_ET28';
  if (lower === 'pupilcore' || lower === 'pupil-core') return 'PupilCore';
  if (lower === 'aseeglassesplus' || lower === 'asee_glasses_plus' || lower === 'asee-glasses-plus' || lower === 'glassesplus') {
    return 'aSeeGlassesPlus';
  }
  if (lower === 'a8' || lower === 'asee_a8' || lower === 'asee-a8') return 'A8';
  if (lower === 'pro' || lower === 'pro200' || lower === 'desktop') return 'Pro';
  if (normalizeDeviceType(fallbackDeviceType) === '眼镜式') return 'aSeeGlassesPlus';
  return 'Pro';
};

export const deviceTypeFromModel = (model: unknown): DeviceType => {
  return ['aSeeGlassesPlus', 'PupilCore', 'HH_ET28'].includes(normalizeDeviceModel(model)) ? '眼镜式' : '桌面式';
};

export const getDeviceProfile = (value: unknown, model?: unknown): DeviceProfile => {
  const selected = normalizeDeviceModel(model, value);
  if (selected === 'HH_ET10C') {
    return { ...DESKTOP_PROFILE, sdkModel: selected };
  }
  if (selected === 'HH_ET28') {
    return { ...GLASSES_PROFILE, sdkModel: selected,
      fixedSdkResolution: 204,
      calibrationTypes: ['卡片式三点校准', '卡片式五点校准', '卡片式九点校准'],
      defaultCalibrationType: '卡片式五点校准' };
  }
  if (selected === 'PupilCore') {
    return { ...GLASSES_PROFILE, sdkModel: 'PupilCore', calibrationTypes: ['卡片式三点校准', '卡片式五点校准', '卡片式九点校准'],
      defaultCalibrationType: '卡片式九点校准' };
  }
  const deviceType = normalizeDeviceType(value);
  if (deviceType === '眼镜式') return GLASSES_PROFILE;
  return {
    ...DESKTOP_PROFILE,
    sdkModel: normalizeDeviceModel(model, deviceType),
  };
};
