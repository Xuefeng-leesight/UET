export type RecordingViewMode = 'local' | 'monitor' | 'remote';

export type RecordingSettings = {
  subjectId: string;
  bgColor: string;
  randomOrder: boolean;
  externalMarkers: boolean;
  endOnClick: boolean;
  endOnKey: boolean;
  calibrationType: string;
  showEyeImage: boolean;
  saveRawData: boolean;
  saveEyeCalibration: boolean;
  calibrationPointStyle: string;
  hideGaze: boolean;
  recordMouse: boolean;
  splitScreenMode: boolean;
  sdkEnvironment: number;
  sdkResolution: number;
  recordingViewMode: RecordingViewMode | null;
  localIp?: string;
  remoteIp?: string;
};

export type EyeTrackingValue = string | number | boolean | null | undefined;
export type EyeTrackingData = Record<string, EyeTrackingValue>;

export type FacialSessionStatus = {
  running?: boolean;
  inferenceReady?: boolean;
  actual?: { width?: number; height?: number; fps?: number };
};
