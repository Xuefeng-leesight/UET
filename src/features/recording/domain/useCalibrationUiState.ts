import { useRef, useState } from 'react'
import type { CardDetectionFrameProviderRef } from '@/features/recording/domain/recordingWsModule'
import type { RecordingMonitorLayout, RecordingMonitorTileId } from '@/features/recording/domain/useRecordingDeviceState'

export type CalibrationState = 'none' | 'calibrating' | 'finished'
export type CardDetectionStatus = 'idle' | 'detecting' | 'ready' | 'submitting' | 'error'

export function useCalibrationUiState() {
  const [calibrationState, setCalibrationState] = useState<CalibrationState>('none')
  const [isCalibrationTestMode, setIsCalibrationTestMode] = useState(false)
  const [isCalibrationTrackerReady, setIsCalibrationTrackerReady] = useState(false)
  const [isCalibrationStarting, setIsCalibrationStarting] = useState(false)
  const calibrationStartingRef = useRef(false)
  const calibrationTestStartingRef = useRef(false)
  const glassesCalibrationMonitorLayoutRef = useRef<{
    layout: RecordingMonitorLayout
    hiddenTileIds: RecordingMonitorTileId[]
  } | null>(null)
  const previousCalibrationStateRef = useRef<CalibrationState>('none')
  const [calibPointIndex, setCalibPointIndex] = useState(4)
  const [calibScale, setCalibScale] = useState(1)
  const [cardDetectedPoint, setCardDetectedPoint] = useState<{ x: number; y: number } | null>(null)
  const [cardCompletedPoints, setCardCompletedPoints] = useState<Array<{ x: number; y: number }>>([])
  const [cardDetectionStatus, setCardDetectionStatus] = useState<CardDetectionStatus>('idle')
  const [cardDetectionMessage, setCardDetectionMessage] = useState('')
  const cardSubmittedPointRef = useRef<{ x: number; y: number } | null>(null)
  const cardDetectionStatusRef = useRef<CardDetectionStatus>('idle')
  const cardDetectionFrameRef = useRef<CardDetectionFrameProviderRef['current']>(null)
  const cardDetectionFrameEnabledRef = useRef(false)

  return {
    calibrationState, setCalibrationState,
    isCalibrationTrackerReady, setIsCalibrationTrackerReady,
    isCalibrationTestMode, setIsCalibrationTestMode,
    isCalibrationStarting, setIsCalibrationStarting,
    calibrationStartingRef,
    calibrationTestStartingRef,
    glassesCalibrationMonitorLayoutRef,
    previousCalibrationStateRef,
    calibPointIndex, setCalibPointIndex,
    calibScale, setCalibScale,
    cardDetectedPoint, setCardDetectedPoint,
    cardCompletedPoints, setCardCompletedPoints,
    cardDetectionStatus, setCardDetectionStatus,
    cardDetectionMessage, setCardDetectionMessage,
    cardSubmittedPointRef,
    cardDetectionStatusRef,
    cardDetectionFrameRef,
    cardDetectionFrameEnabledRef,
  }
}
