import { ipcClient } from '@/infrastructure/electron/ipcClient';

export type CalibrationState = 'none' | 'calibrating' | 'finished';

type CalibrationTimer = ReturnType<typeof setTimeout> | null;
type CalibrationCommand = (id: string, args?: Record<string, unknown>) => boolean;

// Define calibration sequences based on 9-point grid indices
// 9-point grid layout:
// 0: top-left (0.1, 0.1)
// 1: top-center (0.5, 0.1)
// 2: top-right (0.9, 0.1)
// 3: mid-left (0.1, 0.5)
// 4: center (0.5, 0.5)
// 5: mid-right (0.9, 0.5)
// 6: bottom-left (0.1, 0.9)
// 7: bottom-center (0.5, 0.9)
// 8: bottom-right (0.9, 0.9)

const CALIBRATION_SEQUENCES: Record<number, number[]> = {
  1: [4],                 // 1-point: center
  3: [4, 0, 8],           // 3-point: center → top-left → bottom-right
  5: [4, 0, 2, 6, 8],     // 5-point: center → top-left → top-right → bottom-left → bottom-right
  9: [0, 1, 2, 3, 4, 5, 6, 7, 8], // 9-point: sequential order
};

// Pupil indices only identify progress. Actual references always come from the detected card.
export function getPupilCalibrationSequence(points: number): number[] {
  return Array.from({ length: points }, (_, index) => index);
}

export function createCalibrationController(params: {
  calibStateRef: { current: { arrIndex: number; pointIndex: number; timerId: CalibrationTimer; safetyTimerId: CalibrationTimer; points: number; pointPending?: boolean; pointAttempt?: number; pointCancelling?: boolean; sequenceOverride?: number[] } };
  setCalibPointIndex: (idx: number) => void;
  setCalibScale: (v: number) => void;
  sendCmd: CalibrationCommand;
  calibIntervalMs: number;
  calibPoints: Array<{ x: number; y: number }>;
  calibrationMode?: 'auto' | 'click';
  onPointTimeout?: (pointIndex: number) => void;
  onPointCommandRejected?: (pointIndex: number) => void;
}): {
  processPoint: (arrIdx: number, ptIdx: number) => void;
  triggerCurrentPoint: (pointOverride?: { x: number; y: number }) => void;
  advanceCalibration: () => void;
} {
  const {
    calibStateRef,
    setCalibPointIndex,
    setCalibScale,
    sendCmd,
    calibIntervalMs,
    calibPoints,
    calibrationMode = 'auto',
    onPointTimeout,
    onPointCommandRejected,
  } = params;
  const FINALIZE_DELAY_MS = calibrationMode === 'click' ? 3000 : 0;

  const triggerCurrentPoint = (pointOverride?: { x: number; y: number }) => {
    const arrIdx = calibStateRef.current.arrIndex;
    const ptIdx = calibStateRef.current.pointIndex;
    if (ptIdx <= 0) return;
    if (calibStateRef.current.pointPending || calibStateRef.current.pointCancelling) return;
    const point = pointOverride || calibPoints[arrIdx];
    if (!point) return;
    const pointAttempt = (calibStateRef.current.pointAttempt ?? 0) + 1;
    calibStateRef.current.pointAttempt = pointAttempt;
    calibStateRef.current.pointCancelling = false;
    calibStateRef.current.pointPending = true;
    const sent = sendCmd('start_calibration_point', { index: ptIdx, x: point.x, y: point.y, attempt: pointAttempt });
    void ipcClient.videoDebugLog({
      event: 'calibration:point-command-sent',
      details: { pointIndex: ptIdx, arrayIndex: arrIdx, pointAttempt, point, sent, calibrationMode },
    });
    if (!sent && calibrationMode === 'click') {
      calibStateRef.current.pointPending = false;
      onPointCommandRejected?.(ptIdx);
      return;
    }
    // The glasses SDK sample submits each selected point exactly once and does
    // not gate the calibration thread on finish callbacks or a point timeout.
    // The command response advances the click-driven flow instead.
    if (calibrationMode === 'click') return;
    if (calibStateRef.current.safetyTimerId) clearTimeout(calibStateRef.current.safetyTimerId);
    calibStateRef.current.safetyTimerId = setTimeout(() => {
      calibStateRef.current.safetyTimerId = null;
      console.warn('Calibration point timeout', ptIdx, calibrationMode);
      void ipcClient.videoDebugLog({
        event: 'calibration:point-timeout',
        details: { pointIndex: ptIdx, arrayIndex: arrIdx, pointAttempt, calibrationMode },
      });
      calibStateRef.current.pointPending = false;
      onPointTimeout?.(ptIdx);
      advanceCalibration();
    }, 8000);
  };

  const processPoint = (arrIdx: number, ptIdx: number) => {
    setCalibPointIndex(arrIdx);
    setCalibScale(1.0);
    calibStateRef.current.pointPending = false;
    calibStateRef.current.pointCancelling = false;

    if (calibStateRef.current.timerId) clearTimeout(calibStateRef.current.timerId);
    if (calibStateRef.current.safetyTimerId) clearTimeout(calibStateRef.current.safetyTimerId);

    if (calibrationMode === 'click') {
      calibStateRef.current.timerId = null;
      return;
    }
    calibStateRef.current.timerId = setTimeout(() => {
      triggerCurrentPoint();
    }, calibIntervalMs);
  };

  const advanceCalibration = () => {
    if (calibStateRef.current.safetyTimerId) {
      clearTimeout(calibStateRef.current.safetyTimerId);
      calibStateRef.current.safetyTimerId = null;
    }
    calibStateRef.current.pointPending = false;
    calibStateRef.current.pointCancelling = false;

    const totalPoints = calibStateRef.current.points;
    const currentPointIndex = calibStateRef.current.pointIndex;
    
    // Check if calibration is complete
    if (totalPoints <= currentPointIndex) {
      if (calibStateRef.current.timerId) clearTimeout(calibStateRef.current.timerId);
      calibStateRef.current.timerId = null;
      if (FINALIZE_DELAY_MS > 0) {
        // Keep the final point locked while the sample-compatible three-second
        // wait is running so it cannot be submitted repeatedly.
        calibStateRef.current.pointPending = true;
        calibStateRef.current.timerId = setTimeout(() => {
          console.log('CALIB COMPLETE SEND', { delayMs: FINALIZE_DELAY_MS, calibrationMode });
          sendCmd('complete_calibration');
        }, FINALIZE_DELAY_MS);
      } else {
        console.log('CALIB COMPLETE SEND', { delayMs: 0, calibrationMode });
        sendCmd('complete_calibration');
      }
      return;
    }

    // Get the calibration sequence for this calibration type
    const sequence = calibStateRef.current.sequenceOverride || CALIBRATION_SEQUENCES[totalPoints] || CALIBRATION_SEQUENCES[9];
    
    // Get the next array index from the sequence
    const nextArrIdx = sequence[currentPointIndex] || 0;

    calibStateRef.current.arrIndex = nextArrIdx;
    calibStateRef.current.pointIndex += 1;

    processPoint(nextArrIdx, calibStateRef.current.pointIndex);
  };

  return { processPoint, triggerCurrentPoint, advanceCalibration };
}

export function getCalibrationPointsCount(calibrationType: string): number {
  if (calibrationType === '一点校准' || calibrationType === '卡片式一点校准') return 1;
  if (calibrationType === '三点校准' || calibrationType === '卡片式三点校准') return 3;
  if (calibrationType === '五点校准' || calibrationType === '卡片式五点校准') return 5;
  return 9;
}

export function isCardCalibrationType(calibrationType: string): boolean {
  return calibrationType === '卡片式一点校准' || calibrationType === '卡片式三点校准' || calibrationType === '卡片式五点校准' || calibrationType === '卡片式九点校准';
}

export function cancelCalibration(params: {
  calibStateRef: { current: { timerId: CalibrationTimer; safetyTimerId: CalibrationTimer } };
  setCalibrationState: (s: CalibrationState) => void;
  setCalibScale: (v: number) => void;
  sendCmd: CalibrationCommand;
  exitFullscreen?: boolean;
}): void {
  const { calibStateRef, setCalibrationState, setCalibScale, sendCmd, exitFullscreen = true } = params;

  if (calibStateRef.current.timerId) clearTimeout(calibStateRef.current.timerId);
  if (calibStateRef.current.safetyTimerId) clearTimeout(calibStateRef.current.safetyTimerId);
  calibStateRef.current.timerId = null;
  calibStateRef.current.safetyTimerId = null;

  setCalibrationState('none');
  setCalibScale(1.0);
  sendCmd('cancel_calibration');

  if (exitFullscreen) {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    if (ipcClient.isAvailable()) {
      void ipcClient.setWindowFullScreen({ fullscreen: false });
    }
  }
}
