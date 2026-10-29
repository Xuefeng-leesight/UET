import type { LanguageCode } from '@/app/i18n/i18nConfig';
import type { ExtendedStimulus } from '@/shared/types/mrt';
import {
  DEFAULT_CALIBRATION_POINT_STYLE,
  normalizeCalibrationPointStyle,
  type CalibrationPointStyle,
} from '@/features/recording/domain/calibrationPointStyle';

export type ParticipantEyeData = {
  recomGazeX: string;
  recomGazeY: string;
  recomPointX?: string;
  recomPointY?: string;
  recomRawX?: string;
  recomRawY?: string;
  recomSmoothX?: string;
  recomSmoothY?: string;
  leftGazeX?: string;
  leftGazeY?: string;
  leftPointX?: string;
  leftPointY?: string;
  leftRawX?: string;
  leftRawY?: string;
  leftSmoothX?: string;
  leftSmoothY?: string;
  rightGazeX?: string;
  rightGazeY?: string;
  rightPointX?: string;
  rightPointY?: string;
  rightRawX?: string;
  rightRawY?: string;
  rightSmoothX?: string;
  rightSmoothY?: string;
};

export type ParticipantWindowState = {
  isRecording: boolean;
  isPreviewing?: boolean;
  stimulus: ExtendedStimulus | null;
  eyeData: ParticipantEyeData;
  bgColor: string;
  hideGaze: boolean;
  calibrationState: 'none' | 'calibrating' | 'finished';
  calibrationMode?: 'auto' | 'click';
  calibPointIndex: number;
  calibScale: number;
  calibrationPointStyle?: CalibrationPointStyle;
  isCalibrationTestMode?: boolean;
  language?: LanguageCode;
  /** Main-process revision used only to acknowledge that the first view rendered. */
  participantRenderRevision?: number;
};

export const EMPTY_PARTICIPANT_EYE_DATA: ParticipantEyeData = {
  recomGazeX: '',
  recomGazeY: '',
  recomPointX: '',
  recomPointY: '',
  recomRawX: '',
  recomRawY: '',
  recomSmoothX: '',
  recomSmoothY: '',
  leftGazeX: '',
  leftGazeY: '',
  leftPointX: '',
  leftPointY: '',
  leftRawX: '',
  leftRawY: '',
  leftSmoothX: '',
  leftSmoothY: '',
  rightGazeX: '',
  rightGazeY: '',
  rightPointX: '',
  rightPointY: '',
  rightRawX: '',
  rightRawY: '',
  rightSmoothX: '',
  rightSmoothY: '',
};

export const DEFAULT_PARTICIPANT_WINDOW_STATE: ParticipantWindowState = {
  isRecording: false,
  isPreviewing: false,
  stimulus: null,
  eyeData: EMPTY_PARTICIPANT_EYE_DATA,
  bgColor: '#000000',
  hideGaze: true,
  calibrationState: 'none',
  calibrationMode: 'auto',
  calibPointIndex: 4,
  calibScale: 1,
  calibrationPointStyle: DEFAULT_CALIBRATION_POINT_STYLE,
  isCalibrationTestMode: false,
  language: 'zh-CN',
};

export function createParticipantWindowState(
  input: Partial<ParticipantWindowState> = {},
): ParticipantWindowState {
  return {
    ...DEFAULT_PARTICIPANT_WINDOW_STATE,
    ...input,
    eyeData: {
      ...EMPTY_PARTICIPANT_EYE_DATA,
      ...(input.eyeData || {}),
    },
    calibrationPointStyle: normalizeCalibrationPointStyle(
      input.calibrationPointStyle ?? DEFAULT_PARTICIPANT_WINDOW_STATE.calibrationPointStyle,
    ),
  };
}
