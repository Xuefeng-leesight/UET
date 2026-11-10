import { useRef, useState } from 'react'
import { DEFAULT_FACIAL_RECORDING_SETTINGS } from '@/features/recording/domain/recordingModules'
import type { FacialSessionStatus } from '@/features/recording/domain/recordingContracts'

export type FacialCamera = {
  id: string
  index: number
  name: string
  width: number
  height: number
}

export function useFacialCaptureState() {
  const [facialCameras, setFacialCameras] = useState<FacialCamera[]>([])
  const [facialCameraId, setFacialCameraId] = useState('')
  const [isFacialCapturing, setIsFacialCapturing] = useState(false)
  const [facialCaptureNotice, setFacialCaptureNotice] = useState('')
  const facialServerErrorRef = useRef('')
  const facialAutoCaptureRecordIdRef = useRef<string | null>(null)
  const facialAutoCaptureActiveRef = useRef(false)
  const facialWsCmdRef = useRef<WebSocket | null>(null)
  const facialImageWsRef = useRef<WebSocket | null>(null)
  const [facialPreviewStream, setFacialPreviewStream] = useState<MediaStream | null>(null)
  const [facialPreviewDataUrl, setFacialPreviewDataUrl] = useState<string | null>(null)
  const [facialFaceBox, setFacialFaceBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [facialExpression, setFacialExpression] = useState<string | null>(null)
  const [facialEmotionScores, setFacialEmotionScores] = useState<Record<string, number>>({})
  const [facialLandmarks, setFacialLandmarks] = useState<Array<{ x: number; y: number }>>([])
  const [facialSessionStatus, setFacialSessionStatus] = useState<FacialSessionStatus | null>(null)
  const [facialSettings, setFacialSettings] = useState(DEFAULT_FACIAL_RECORDING_SETTINGS)

  return {
    facialCameras, setFacialCameras,
    facialCameraId, setFacialCameraId,
    isFacialCapturing, setIsFacialCapturing,
    facialCaptureNotice, setFacialCaptureNotice,
    facialServerErrorRef,
    facialAutoCaptureRecordIdRef,
    facialAutoCaptureActiveRef,
    facialWsCmdRef,
    facialImageWsRef,
    facialPreviewStream, setFacialPreviewStream,
    facialPreviewDataUrl, setFacialPreviewDataUrl,
    facialFaceBox, setFacialFaceBox,
    facialExpression, setFacialExpression,
    facialEmotionScores, setFacialEmotionScores,
    facialLandmarks, setFacialLandmarks,
    facialSessionStatus, setFacialSessionStatus,
    facialSettings, setFacialSettings,
  }
}
