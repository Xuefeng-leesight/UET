import { useRef, useState } from 'react'
import type { CalibrationScores } from '@/features/recording/domain/calibrationScores'
import type { TriggerConfig } from '@/shared/types/mrt'
import { DEFAULT_CALIBRATION_POINT_STYLE } from '@/features/recording/domain/calibrationPointStyle'
import type { EyeTrackingData, RecordingSettings } from '@/features/recording/domain/recordingContracts'
import type { EncodedVideoPreviewController, EncodedVideoPreviewStatus } from '@/features/recording/domain/recordingWsModule'
import { useRecordingLifecycleController } from '@/features/recording/domain/useRecordingLifecycleController'
import { useSamplingRateHz, useVideoSamplingRateHz } from '@/features/recording/sampling-rate/useSamplingRate'
import { createEyeDataStore } from '@/features/recording/domain/recordingEyeDataStore'

export type RecordingMonitorLayout = 'single' | '2x2' | '3x3'
export type RecordingMonitorTileId = 'device' | 'participant' | 'facial'

export type RecordingFinalizationResult = {
  recordingId: string
  ok: boolean
  message: string
  videoPath: string
  csvPath: string
  videoSize: number
  elapsedMs: number
}

const DEFAULT_RECORDING_SETTINGS: RecordingSettings = {
  subjectId: '',
  bgColor: '#000000',
  randomOrder: false,
  externalMarkers: true,
  endOnClick: false,
  endOnKey: true,
  calibrationType: '五点校准',
  showEyeImage: false,
  saveRawData: false,
  saveEyeCalibration: true,
  calibrationPointStyle: DEFAULT_CALIBRATION_POINT_STYLE,
  hideGaze: false,
  recordMouse: false,
  splitScreenMode: false,
  sdkEnvironment: 301,
  sdkResolution: 202,
  recordingViewMode: null,
}

export function useRecordingDeviceState(createEmptyEyeData: () => EyeTrackingData) {
  const [recordingSettings, setRecordingSettings] = useState<RecordingSettings>(DEFAULT_RECORDING_SETTINGS)
  const [isCameraOn, setIsCameraOn] = useState(false)
  const [wsConnected, setWsConnected] = useState(false)
  const [wsIp, setWsIp] = useState('127.0.0.1')
  const [wsImagePort, setWsImagePort] = useState('9001')
  const [wsCmdPort] = useState('9003')
  const [wsEyePort, setWsEyePort] = useState('9002')
  const wsImageRef = useRef<WebSocket | null>(null)
  const encodedVideoPreviewRef = useRef<EncodedVideoPreviewController | null>(null)
  const wsCmdRef = useRef<WebSocket | null>(null)
  const wsEyeRef = useRef<WebSocket | null>(null)
  const imageCanvasRef = useRef<HTMLImageElement | null>(null)
  const videoPreviewCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const [lastImageAt, setLastImageAt] = useState<number | null>(null)
  const [videoPreviewMode, setVideoPreviewMode] = useState<'image' | 'webcodecs'>('image')
  const [videoPreviewStatus, setVideoPreviewStatus] = useState<EncodedVideoPreviewStatus | null>(null)
  const [videoPreviewFrameSize, setVideoPreviewFrameSize] = useState<{ width: number; height: number } | null>(null)
  const [calibrationCoe, setCalibrationCoe] = useState<string | null>(null)
  const [calibrationScores, setCalibrationScores] = useState<CalibrationScores | null>(null)
  const activeTrackingCoeRef = useRef<string | null>(null)
  const recordingLifecycle = useRecordingLifecycleController()
  const [recordingFinalizationResult, setRecordingFinalizationResult] = useState<RecordingFinalizationResult | null>(null)
  const recordingFinalizationHandlingRef = useRef(false)
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [recordingMonitorLayout, setRecordingMonitorLayout] = useState<RecordingMonitorLayout>('single')
  const [recordingMonitorLayoutResetToken, setRecordingMonitorLayoutResetToken] = useState(0)
  const [hiddenRecordingMonitorTileIds, setHiddenRecordingMonitorTileIds] = useState<RecordingMonitorTileId[]>(['participant', 'facial'])
  const [isRecordingCaptureReady, setIsRecordingCaptureReady] = useState(false)
  const { samplingRateHz } = useSamplingRateHz()
  const { videoSamplingRateHz } = useVideoSamplingRateHz()
  const [playbackIndex, setPlaybackIndex] = useState<number | null>(null)
  const [eyeDataStore] = useState(() => createEyeDataStore(createEmptyEyeData()))
  const [customGroups, setCustomGroups] = useState<string[]>([])
  const [triggerConfig, setTriggerConfig] = useState<TriggerConfig | null>(null)

  return {
    recordingSettings, setRecordingSettings,
    isCameraOn, setIsCameraOn,
    wsConnected, setWsConnected,
    wsIp, setWsIp,
    wsImagePort, setWsImagePort,
    wsCmdPort,
    wsEyePort, setWsEyePort,
    wsImageRef,
    encodedVideoPreviewRef,
    wsCmdRef,
    wsEyeRef,
    imageCanvasRef,
    videoPreviewCanvasRef,
    lastImageAt, setLastImageAt,
    videoPreviewMode, setVideoPreviewMode,
    videoPreviewStatus, setVideoPreviewStatus,
    videoPreviewFrameSize, setVideoPreviewFrameSize,
    calibrationCoe, setCalibrationCoe,
    calibrationScores, setCalibrationScores,
    activeTrackingCoeRef,
    recordingLifecycle,
    isRecording: recordingLifecycle.isRecording,
    isRecordingFinalizing: recordingLifecycle.isFinalizing,
    recordingFinalizationResult, setRecordingFinalizationResult,
    recordingFinalizationHandlingRef,
    isPreviewing, setIsPreviewing,
    recordingMonitorLayout, setRecordingMonitorLayout,
    recordingMonitorLayoutResetToken, setRecordingMonitorLayoutResetToken,
    hiddenRecordingMonitorTileIds, setHiddenRecordingMonitorTileIds,
    isRecordingCaptureReady, setIsRecordingCaptureReady,
    samplingRateHz,
    videoSamplingRateHz,
    playbackIndex, setPlaybackIndex,
    eyeDataStore, setEyeData: eyeDataStore.set,
    customGroups, setCustomGroups,
    triggerConfig, setTriggerConfig,
  }
}
