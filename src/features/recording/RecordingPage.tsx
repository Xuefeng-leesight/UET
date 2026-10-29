import React from 'react';
import { calibrationScorePresentation, type CalibrationScores } from '@/features/recording/domain/calibrationScores';
import { containedImageBox, pointerToImagePoint } from '@/features/recording/domain/gazeMapping';
import { Camera, Maximize2, Minimize2, Minus, Monitor, RadioTower, ScanFace, WifiOff, Wifi, Video, VideoOff } from 'lucide-react';
import CustomSelect from '@/shared/ui/CustomSelect';
import { btnPrimary, btnSecondary } from '@/shared/ui/buttonClasses';
import type { ModalityId, Subject } from '@shared/contracts/domain/models';
import type { ExtendedStimulus } from '@/shared/types/mrt';
import type { RecordingMarker, CustomMarkerConfig } from '@shared/contracts/domain/recording';
import MarkerIndicators from '@/features/records/MarkerIndicators';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import { getCalibrationPointsCount, getPupilCalibrationSequence } from '@/features/recording/domain/calibrationFlow';
import { CALIB_POINTS } from '@/features/recording/domain/calibrationConstants';
import {
  CALIBRATION_POINT_STYLE_OPTIONS,
  normalizeCalibrationPointStyle,
  renderCalibrationPointVisual,
} from '@/features/recording/domain/calibrationPointStyle';
import type { EyeDataStore } from '@/features/recording/domain/recordingEyeDataStore';
import { RecordingEyeDataPanel, RecordingPreviewGazeDot } from '@/features/recording/domain/RecordingEyeDataViews';
import { type CardDetectionFrameProviderRef, type EncodedVideoPreviewStatus } from '@/features/recording/domain/recordingWsModule';
import { MONITOR_TILE_MODALITY, RECORDING_MODULES, type FacialRecordingSettings, type MonitorTileId, type RecordingModuleId } from '@/features/recording/domain/recordingModules';
import { buildFacialMeshEdges, FACE_OVAL, INNER_LIPS, isRenderableFacialLandmark, LEFT_EYE, OUTER_LIPS, RIGHT_EYE } from '@/features/recording/domain/facialOverlay';
import { RecordingFacialPanel } from '@/features/recording/domain/RecordingFacialPanel';
import { normalizeEyeImageMessageKind } from '@/features/recording/domain/remoteRecordingProtocol';
import { RecordingStimulusPreview } from '@/features/recording/domain/RecordingStimulusPreview';
import type { FacialSessionStatus, RecordingSettings } from '@/features/recording/domain/recordingContracts';
import { useRemoteRecording } from '@/features/recording/domain/useRemoteRecording';
import { getImageStreamState, IMAGE_STREAM_LABELS } from '@/features/recording/domain/imageStreamState';
import CalibrationTestSurface from '@/features/recording/domain/CalibrationTestSurface';
import { GLASSES_PROFILE, getSdkResolutionOptions, normalizeSdkResolution, type DeviceProfile } from '@/features/recording/device/deviceProfile';

const FACIAL_CONFIDENCE_ORDER = ['中性', '高兴', '惊讶', '悲伤', '愤怒', '恐惧', '厌恶', '轻蔑'] as const;

interface RecordingPageProps {
  playbackIndex: number | null;
  stimuli: ExtendedStimulus[];
  wsConnected: boolean;
  imageCanvasRef: React.RefObject<HTMLImageElement | null>;
  videoCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  videoPreviewMode?: 'image' | 'webcodecs';
  glassesPreviewSuspended?: boolean;
  videoPreviewStatus?: EncodedVideoPreviewStatus | null;
  videoFrameSize?: { width: number; height: number } | null;
  cardDetectionFrameRef?: CardDetectionFrameProviderRef;
  isCameraOn: boolean;
  lastImageAt: number | null;
  wsIp: string;
  wsImagePort: string;
  subjects: Subject[];
  recordingSettings: RecordingSettings;
  setRecordingSettings: React.Dispatch<React.SetStateAction<RecordingSettings>>;
  eyeDataStore: EyeDataStore;
  calibrationScores: CalibrationScores | null;
  playbackSequence?: string[] | null;
  isRecording?: boolean;
  isPreviewing?: boolean;
  recordingStartTime?: number;
  sendWebSocketCommand?: (command: string, data: Record<string, unknown>) => Promise<unknown>;
  onStartCalibrationTest?: () => void;
  onStartCalibration?: () => void;
  hasSavedCalibration?: boolean;
  stimulusEnabled?: boolean;
  deviceProfile?: DeviceProfile;
  calibrationTypes?: string[];
  calibrationMode?: 'auto' | 'click';
  calibrationState?: 'none' | 'calibrating' | 'finished';
  isCalibrationStarting?: boolean;
  calibPointIndex?: number;
  calibScale?: number;
  onInlineCalibrationPoint?: (point: { x: number; y: number }) => void;
  cardCalibrationActive?: boolean;
  allowManualCardPoint?: boolean;
  isPupilCardCalibration?: boolean;
  isCalibrationTrackerReady?: boolean;
  cardDetectedPoint?: { x: number; y: number } | null;
  cardCompletedPoints?: Array<{ x: number; y: number }>;
  cardDetectionStatus?: 'idle' | 'detecting' | 'ready' | 'submitting' | 'error';
  cardDetectionMessage?: string;
  onCardDetectionUpdate?: (payload: {
    point: { x: number; y: number } | null;
    status: 'idle' | 'detecting' | 'ready' | 'submitting' | 'error';
    message: string;
  }) => void;
  onCardCalibrationTrigger?: () => void;
  isCalibrationTestMode?: boolean;
  language?: 'zh-CN' | 'en-US';
  onBeforeSwitchMode?: () => Promise<void>;
  monitorLayout?: MonitorLayoutMode;
  monitorLayoutResetToken?: number;
  hiddenMonitorTileIds?: MonitorTileId[];
  onHiddenMonitorTileIdsChange?: (ids: MonitorTileId[]) => void;
  facialCameraId?: string;
  facialCameras?: Array<{ id: string; index: number; name: string; width: number; height: number }>;
  isFacialCapturing?: boolean;
  facialCaptureNotice?: string;
  onRefreshFacialCameras?: () => void;
  onFacialCameraChange?: (cameraId: string) => void;
  facialPreviewDataUrl?: string | null;
  facialPreviewStream?: MediaStream | null;
  facialFaceBox?: { x: number; y: number; w: number; h: number } | null;
  facialExpression?: string | null;
  facialEmotionScores?: Record<string, number>;
  facialLandmarks?: Array<{ x: number; y: number }>;
  facialSessionStatus?: FacialSessionStatus | null;
  facialSettings?: FacialRecordingSettings;
  onFacialSettingsChange?: (patch: Partial<FacialRecordingSettings>) => void;
  /** 当前工程启用的数据模态。未提供时不做模态门控（向后兼容）。 */
  enabledModalities?: ModalityId[];
}

type RecordingViewMode = 'local' | 'monitor' | 'remote';
type MonitorLayoutMode = 'single' | '2x2' | '3x3';
const CARD_DETECTION_MIN_CONFIDENCE = 0.55;
const CARD_DETECTION_CAPTURE_MAX_WIDTH = 1440;
const CARD_DETECTION_DEBUG_EVENT_PREFIX = 'card-detection';
const CARD_DETECTION_SWITCH_DISTANCE = 0.08;
const CARD_DETECTION_SWITCH_CONFIRM_FRAMES = 3;
const CARD_DETECTION_SWITCH_CLUSTER_DISTANCE = 0.025;

type CardDetectionWorkerMessage = {
  type?: unknown;
  point?: { x?: unknown; y?: unknown; confidence?: unknown } | null;
  diagnostics?: {
    config?: unknown;
    minArea?: unknown;
    selectedCandidate?: {
      correctedCenter?: { x: number; y: number };
      rawCenters?: {
        outer: { x: number; y: number };
        hole: { x: number; y: number };
        dot: { x: number; y: number };
      };
      rect: { x: number; y: number; width: number; height: number };
      [key: string]: unknown;
    } | null;
    [key: string]: unknown;
  } | null;
  message?: unknown;
  error?: unknown;
};

function emitCardDetectionDebug(event: string, details?: Record<string, unknown>) {
  void ipcClient.videoDebugLog({
    event: `${CARD_DETECTION_DEBUG_EVENT_PREFIX}:${event}`,
    details,
  });
}

const RecordingPage: React.FC<RecordingPageProps> = ({
  playbackIndex,
  stimuli,
  wsConnected,
  imageCanvasRef,
  videoCanvasRef,
  videoPreviewMode = 'image',
  glassesPreviewSuspended = false,
  videoPreviewStatus = null,
  videoFrameSize = null,
  cardDetectionFrameRef,
  isCameraOn,
  lastImageAt,
  wsIp,
  wsImagePort,
  subjects,
  recordingSettings,
  setRecordingSettings,
  eyeDataStore,
  calibrationScores,
  playbackSequence,
  isRecording = false,
  isPreviewing = false,
  recordingStartTime = 0,
  sendWebSocketCommand,
  onStartCalibrationTest,
  onStartCalibration,
  hasSavedCalibration = false,
  stimulusEnabled = true,
  deviceProfile = GLASSES_PROFILE,
  calibrationTypes = ['三点校准', '五点校准', '九点校准'],
  calibrationMode = 'auto',
  calibrationState = 'none',
  isCalibrationStarting = false,
  calibPointIndex = 4,
  calibScale = 1,
  onInlineCalibrationPoint,
  cardCalibrationActive = false,
  allowManualCardPoint = false,
  isPupilCardCalibration = false,
  isCalibrationTrackerReady = true,
  cardDetectedPoint = null,
  cardCompletedPoints = [],
  cardDetectionStatus = 'idle',
  cardDetectionMessage = '',
  onCardDetectionUpdate,
  onCardCalibrationTrigger,
  isCalibrationTestMode = false,
  language = 'zh-CN',
  onBeforeSwitchMode,
  monitorLayout = 'single',
  monitorLayoutResetToken = 0,
  hiddenMonitorTileIds = [],
  onHiddenMonitorTileIdsChange,
  facialCameraId = '',
  facialCameras = [],
  isFacialCapturing = false,
  facialCaptureNotice = '',
  onRefreshFacialCameras,
  onFacialCameraChange,
  facialPreviewDataUrl = null,
  facialPreviewStream = null,
  facialFaceBox = null,
  facialExpression = null,
  facialEmotionScores = {},
  facialLandmarks = [],
  facialSessionStatus = null,
  facialSettings,
  onFacialSettingsChange,
  enabledModalities,
}) => {
  const isEn = language === 'en-US';
  const calibrationResult = calibrationScorePresentation(calibrationScores, isPupilCardCalibration, isEn);
  const isGlassesMode = calibrationMode === 'click';
  const hasFacialPreview = Boolean(facialPreviewStream || facialPreviewDataUrl);
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  const imageStreamState = getImageStreamState({ connected: wsConnected, lastFrameAt: lastImageAt, now: nowMs });
  // 设备未启动时，图像流 WebSocket 通道可能已建立（进入录制页即自动连接），
  // 此时若按连接状态显示"连接成功/等待首帧"会误导用户以为设备已就绪。
  // 设备未启动应优先提示"请先启动设备"。
  const deviceNotStarted = !isCameraOn;
  const isGlassesPreviewSafetyActive = glassesPreviewSuspended && isCameraOn;
  const placeholderTitle = isGlassesPreviewSafetyActive
    ? '组合采集安全模式'
    : deviceNotStarted
      ? '设备未启动'
      : IMAGE_STREAM_LABELS[imageStreamState];
  const placeholderDesc = isGlassesPreviewSafetyActive
    ? '已关闭眼镜实时画面解码；眼动数据、表情预览和原始视频录制不受影响。如需校准，请先切换到仅眼动模式'
    : deviceNotStarted
      ? '请先启动设备'
      : imageStreamState === 'disconnected'
        ? '请在顶部连接图像流'
        : imageStreamState === 'waiting'
          ? (isEn ? 'Connected, waiting for the first frame' : '连接成功，正在等待首帧画面')
          : imageStreamState === 'stale'
            ? '图像流已超时，请检查设备状态'
            : '设备已启动，正在接收数据';
  const PlaceholderIcon = !deviceNotStarted && imageStreamState === 'disconnected' ? WifiOff : Camera;
  const [maximizedMonitorTile, setMaximizedMonitorTile] = React.useState<MonitorTileId | null>(null);
  const hiddenMonitorTiles = React.useMemo(() => new Set(hiddenMonitorTileIds), [hiddenMonitorTileIds]);
  // 模态门控：enabledModalities 未提供时不门控（兼容旧调用）；否则仅保留已启用模态。
  const enabledModalitySet = React.useMemo(() => (enabledModalities ? new Set(enabledModalities) : null), [enabledModalities]);
  const isTileModalityEnabled = (tileId: MonitorTileId): boolean => {
    if (!enabledModalitySet) return true;
    return enabledModalitySet.has(MONITOR_TILE_MODALITY[tileId]);
  };
  const facialMeshEdges = React.useMemo(
    () => buildFacialMeshEdges(facialLandmarks),
    [facialLandmarks.length],
  );
  const [monitorSnapshots, setMonitorSnapshots] = React.useState<{
    participant: string | null;
    hasParticipantWindow: boolean;
  }>({ participant: null, hasParticipantWindow: false });
  const remoteIp = String(recordingSettings.remoteIp || '127.0.0.1');
  const {
    remoteVideoRef,
    remoteSignalConnected,
    remoteMediaConnected,
    remoteFrameLastAt,
    remoteRecordingActive,
    remoteCommandBusy,
    connectRemotePreview: handleConnectRemotePreview,
    sendRemoteRecordingCommand,
  } = useRemoteRecording({ remoteIp, recordingViewMode: recordingSettings.recordingViewMode });
  const eyeImageRef = React.useRef<HTMLImageElement | null>(null);
  const leftEyeImageRef = React.useRef<HTMLImageElement | null>(null);
  const rightEyeImageRef = React.useRef<HTMLImageElement | null>(null);
  const [eyeImageLastAt, setEyeImageLastAt] = React.useState<number | null>(null);
  const [leftEyeImageLastAt, setLeftEyeImageLastAt] = React.useState<number | null>(null);
  const [rightEyeImageLastAt, setRightEyeImageLastAt] = React.useState<number | null>(null);
  const eyeImageWsRef = React.useRef<WebSocket | null>(null);
  const eyeImageRafIdRef = React.useRef<number | null>(null);
  const eyeImageRafRunningRef = React.useRef(false);
  const eyeImageLatestFrameRef = React.useRef<{
    single: { buf: ArrayBuffer; mime?: string } | null;
    left: { buf: ArrayBuffer; mime?: string } | null;
    right: { buf: ArrayBuffer; mime?: string } | null;
  }>({ single: null, left: null, right: null });
  const eyeImageLastUrlRef = React.useRef<{ single: string | null; left: string | null; right: string | null }>({
    single: null,
    left: null,
    right: null,
  });
  
  // 标记状态
  const [markers, setMarkers] = React.useState<RecordingMarker[]>([]);
  const [customMarkerConfigs, setCustomMarkerConfigs] = React.useState<CustomMarkerConfig[]>([]);

  // 表情检测模块可见时自动加载摄像头（需表情模态启用且 tile 未被隐藏）
  React.useEffect(() => {
    const isFacialVisible = isTileModalityEnabled('facial') && !hiddenMonitorTileIds.includes('facial');
    if (isFacialVisible && facialCameras.length === 0 && onRefreshFacialCameras) {
      onRefreshFacialCameras();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenMonitorTileIds, facialCameras.length, onRefreshFacialCameras, enabledModalitySet]);

  React.useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => {
      window.clearInterval(id);
    };
  }, []);

  React.useEffect(() => {
    setMaximizedMonitorTile(null);
  }, [monitorLayout]);

  React.useEffect(() => {
    setMaximizedMonitorTile(null);
  }, [monitorLayoutResetToken]);

  React.useEffect(() => {
    if (!ipcClient.isAvailable()) return;
    let cancelled = false;
    let polling = false;
    const refresh = async () => {
      if (polling || cancelled) return;
      polling = true;
      try {
        const result = await ipcClient.getRecordingMonitorSnapshots();
        if (!cancelled && result.ok) {
          setMonitorSnapshots({
            participant: result.participant,
            hasParticipantWindow: result.hasParticipantWindow,
          });
        }
      } finally {
        polling = false;
      }
    };
    const participantTileVisible = !hiddenMonitorTileIds.includes('participant');
    if (!participantTileVisible) return;
    void refresh();
    // This endpoint is intentionally status-only. The preview below renders from
    // the same state as the participant window and therefore stays current without
    // repeatedly reading pixels back from the Windows compositor.
    const timerId = window.setInterval(() => void refresh(), 750);
    return () => {
      cancelled = true;
      window.clearInterval(timerId);
    };
  }, [hiddenMonitorTileIds]);

  React.useEffect(() => {
    if (!ipcClient.isAvailable()) return;
    if (!isGlassesMode) return;
    if (recordingSettings?.recordingViewMode !== 'monitor' && recordingSettings?.recordingViewMode !== 'remote') return;
    const currentLocalIp = String(recordingSettings.localIp || '').trim();
    if (currentLocalIp && currentLocalIp !== '127.0.0.1') return;

    let cancelled = false;
    void ipcClient.getLocalIpAddresses().then((result) => {
      if (cancelled || !result.ok || !result.primary) return;
      setRecordingSettings((prev) => {
        const prevLocalIp = String(prev?.localIp || '').trim();
        if (prevLocalIp && prevLocalIp !== '127.0.0.1') return prev;
        return { ...prev, localIp: result.primary };
      });
    });
    return () => {
      cancelled = true;
    };
  }, [isGlassesMode, recordingSettings?.recordingViewMode, recordingSettings?.localIp, setRecordingSettings]);

  // 加载自定义标记配置
  React.useEffect(() => {
    const loadCustomMarkers = async () => {
      try {
        const stored = localStorage.getItem('customMarkers');
        if (stored) {
          const configs = JSON.parse(stored) as CustomMarkerConfig[];
          setCustomMarkerConfigs(configs);
        }
      } catch (error) {
        console.error('[RecordingPage] Failed to load custom markers:', error);
      }
    };
    loadCustomMarkers();
  }, []);

  // 键盘事件处理 - 自定义标记快捷键
  React.useEffect(() => {
    if (!isRecording || !sendWebSocketCommand) {
      return;
    }

    const handleKeyDown = async (event: KeyboardEvent) => {
      // 查找匹配的自定义标记配置
      const matchedConfig = customMarkerConfigs.find((config) => {
        const keyMatch = event.key.toLowerCase() === config.key.toLowerCase();
        const ctrlMatch = config.ctrl ? event.ctrlKey || event.metaKey : !event.ctrlKey && !event.metaKey;
        const altMatch = config.alt ? event.altKey : !event.altKey;
        const shiftMatch = config.shift ? event.shiftKey : !event.shiftKey;
        return keyMatch && ctrlMatch && altMatch && shiftMatch;
      });

      if (matchedConfig) {
        event.preventDefault();
        
        const currentTime = Date.now() - recordingStartTime;
        const marker: RecordingMarker = {
          type: 'custom',
          name: matchedConfig.name,
          timestamp: currentTime,
          videoTime: currentTime,
        };

        try {
          // 发送到后端
          await sendWebSocketCommand('add_custom_marker', {
            name: matchedConfig.name,
            timestamp: currentTime,
          });

          // 更新本地状态
          setMarkers((prev) => [...prev, marker]);
          console.log('[RecordingPage] Custom marker added:', marker);
        } catch (error) {
          console.error('[RecordingPage] Failed to add custom marker:', error);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isRecording, customMarkerConfigs, recordingStartTime, sendWebSocketCommand]);

  // 清除标记当录制停止时
  React.useEffect(() => {
    if (!isRecording) {
      setMarkers([]);
    }
  }, [isRecording]);

  React.useEffect(() => {
    // Combined acquisition suspends live glasses decoding; the eye-image panel
    // reuses the same image WS, so opening it would re-arm the H.265 decode path.
    const shouldRun = !!recordingSettings?.showEyeImage && !glassesPreviewSuspended;
    const clearEyeImages = () => {
      eyeImageLatestFrameRef.current = { single: null, left: null, right: null };
      try {
        (['single', 'left', 'right'] as const).forEach((key) => {
          const prev = eyeImageLastUrlRef.current[key];
          eyeImageLastUrlRef.current[key] = null;
          if (prev) URL.revokeObjectURL(prev);
        });
      } catch {}
      try {
        if (eyeImageRef.current) eyeImageRef.current.src = '';
        if (leftEyeImageRef.current) leftEyeImageRef.current.src = '';
        if (rightEyeImageRef.current) rightEyeImageRef.current.src = '';
      } catch {}
      setEyeImageLastAt(null);
      setLeftEyeImageLastAt(null);
      setRightEyeImageLastAt(null);
    };

    if (!shouldRun) {
      try {
        if (eyeImageWsRef.current) {
          eyeImageWsRef.current.close();
        }
      } catch {}
      eyeImageWsRef.current = null;
      try {
        if (eyeImageRafRunningRef.current) {
          eyeImageRafRunningRef.current = false;
          if (eyeImageRafIdRef.current !== null) {
            window.cancelAnimationFrame(eyeImageRafIdRef.current);
            eyeImageRafIdRef.current = null;
          }
        }
      } catch {}
      clearEyeImages();
      return;
    }
    if (!wsIp || !wsImagePort) {
      clearEyeImages();
      return;
    }
    let socket: WebSocket | null = null;
    try {
      const ws = new WebSocket(`ws://${wsIp}:${wsImagePort}/`);
      socket = ws;
      ws.binaryType = 'arraybuffer';
      const base64ToArrayBuffer = (value: string): ArrayBuffer => {
        const binary = window.atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
      };
      const detectImageMime = (buf: ArrayBuffer): string => {
        try {
          const view = new Uint8Array(buf);
          if (
            view.length >= 8 &&
            view[0] === 0x89 &&
            view[1] === 0x50 &&
            view[2] === 0x4e &&
            view[3] === 0x47 &&
            view[4] === 0x0d &&
            view[5] === 0x0a &&
            view[6] === 0x1a &&
            view[7] === 0x0a
          ) {
            return 'image/png';
          }
          if (view.length >= 2 && view[0] === 0xff && view[1] === 0xd8) {
            return 'image/jpeg';
          }
        } catch {}
        return 'image/jpeg';
      };
      ws.onopen = () => {
        if (eyeImageWsRef.current !== ws) return;
        if (!eyeImageRafRunningRef.current) {
          // Track each eye independently so the second image does not get starved
          // by the first one during the same animation frame.
          const lastStatusUpdateByKey: Record<'single' | 'left' | 'right', number> = {
            single: 0,
            left: 0,
            right: 0,
          };
          const STATUS_UPDATE_INTERVAL_MS = 500;

          const renderFrame = (
            key: 'single' | 'left' | 'right',
            imageRef: React.RefObject<HTMLImageElement | null>,
            setLastAt: React.Dispatch<React.SetStateAction<number | null>>,
          ) => {
            const el = imageRef.current;
            const frame = eyeImageLatestFrameRef.current[key];
            if (!el || !frame) return;
            try {
              const blob = new Blob([frame.buf], { type: frame.mime || detectImageMime(frame.buf) });
              const url = URL.createObjectURL(blob);
              const prev = eyeImageLastUrlRef.current[key];
              eyeImageLastUrlRef.current[key] = url;
              el.src = url;
              eyeImageLatestFrameRef.current[key] = null;
              // Throttle status updates per eye, but always publish the first frame.
              const now = Date.now();
              if (
                lastStatusUpdateByKey[key] === 0 ||
                now - lastStatusUpdateByKey[key] >= STATUS_UPDATE_INTERVAL_MS
              ) {
                lastStatusUpdateByKey[key] = now;
                setLastAt(now);
              }
              if (prev) {
                URL.revokeObjectURL(prev);
              }
            } catch {}
          };
          const rafLoop = () => {
            if (!eyeImageRafRunningRef.current) return;
            if (isGlassesMode) {
              renderFrame('left', leftEyeImageRef, setLeftEyeImageLastAt);
              renderFrame('right', rightEyeImageRef, setRightEyeImageLastAt);
            } else {
              renderFrame('single', eyeImageRef, setEyeImageLastAt);
            }
            eyeImageRafIdRef.current = window.requestAnimationFrame(rafLoop);
          };
          eyeImageRafRunningRef.current = true;
          eyeImageRafIdRef.current = window.requestAnimationFrame(rafLoop);
        }
      };
      ws.onmessage = (event) => {
        if (eyeImageWsRef.current !== ws) return;
        try {
          if (typeof event.data === 'string') {
            const msg = JSON.parse(event.data);
            if (msg?.type !== 'image_frame' || typeof msg?.data !== 'string') {
              return;
            }
            const frame = {
              buf: base64ToArrayBuffer(msg.data),
              mime: typeof msg?.mime === 'string' ? msg.mime : undefined,
            };
            const kind = normalizeEyeImageMessageKind(msg.kind);
            if (kind === 'left') {
              eyeImageLatestFrameRef.current.left = frame;
            } else if (kind === 'right') {
              eyeImageLatestFrameRef.current.right = frame;
            } else if (!isGlassesMode && kind === 'single') {
              eyeImageLatestFrameRef.current.single = frame;
            }
            return;
          }
          if (!isGlassesMode) {
            eyeImageLatestFrameRef.current.single = { buf: event.data as ArrayBuffer };
          }
        } catch {}
      };
      ws.onclose = () => {
        if (eyeImageWsRef.current !== ws) return;
        eyeImageWsRef.current = null;
        try {
          if (eyeImageRafRunningRef.current) {
            eyeImageRafRunningRef.current = false;
            if (eyeImageRafIdRef.current !== null) {
              window.cancelAnimationFrame(eyeImageRafIdRef.current);
              eyeImageRafIdRef.current = null;
            }
          }
        } catch {}
        clearEyeImages();
      };
      ws.onerror = () => {
        if (eyeImageWsRef.current !== ws) return;
        try {
          ws.close();
        } catch {}
      };
      eyeImageWsRef.current = ws;
    } catch {
      clearEyeImages();
    }
    return () => {
      if (!socket || eyeImageWsRef.current !== socket) return;
      // Closing a prior socket can complete after the next device connects.
      // Invalidate it before close so late callbacks cannot touch new images.
      eyeImageWsRef.current = null;
      try {
        socket.close();
      } catch {}
      try {
        if (eyeImageRafRunningRef.current) {
          eyeImageRafRunningRef.current = false;
          if (eyeImageRafIdRef.current !== null) {
            window.cancelAnimationFrame(eyeImageRafIdRef.current);
            eyeImageRafIdRef.current = null;
          }
        }
      } catch {}
      eyeImageRafRunningRef.current = false;
      clearEyeImages();
    };
  }, [Boolean(recordingSettings?.showEyeImage), glassesPreviewSuspended, isGlassesMode, wsImagePort, wsIp]);

  const statusDotClass = imageStreamState === 'active'
    ? 'bg-emerald-500 animate-pulse'
    : imageStreamState === 'waiting'
      ? 'bg-amber-500 animate-pulse'
      : 'bg-rose-500 animate-pulse';
  const statusText = IMAGE_STREAM_LABELS[imageStreamState];
  const remoteFrameAgeMs = remoteFrameLastAt === null ? null : Math.max(0, nowMs - remoteFrameLastAt);
  const remoteFrameOk = remoteMediaConnected && remoteFrameAgeMs !== null && remoteFrameAgeMs < 2000;
  const remoteStatusText = !remoteSignalConnected
    ? '远程信令未连接'
    : !remoteMediaConnected
      ? '等待远程画面'
      : remoteFrameOk
        ? '远程画面正常'
        : '远程画面等待中';
  const eyeImageAgeMs = eyeImageLastAt === null ? null : Math.max(0, nowMs - eyeImageLastAt);
  const leftEyeImageAgeMs = leftEyeImageLastAt === null ? null : Math.max(0, nowMs - leftEyeImageLastAt);
  const rightEyeImageAgeMs = rightEyeImageLastAt === null ? null : Math.max(0, nowMs - rightEyeImageLastAt);
  const eyeImageOk = eyeImageAgeMs !== null && eyeImageAgeMs < 2000;
  const leftEyeImageOk = leftEyeImageAgeMs !== null && leftEyeImageAgeMs < 2000;
  const rightEyeImageOk = rightEyeImageAgeMs !== null && rightEyeImageAgeMs < 2000;
  const splitEyeImageAnyConnected = leftEyeImageLastAt !== null || rightEyeImageLastAt !== null;
  const splitEyeImageOk = leftEyeImageOk && rightEyeImageOk;
  const eyeImageStatusDotClass = isGlassesMode
    ? !splitEyeImageAnyConnected
      ? 'bg-rose-500 animate-pulse'
      : splitEyeImageOk
        ? 'bg-emerald-500 animate-pulse'
        : 'bg-amber-500 animate-pulse'
    : eyeImageLastAt === null
      ? 'bg-rose-500 animate-pulse'
      : eyeImageOk
        ? 'bg-emerald-500 animate-pulse'
        : 'bg-amber-500 animate-pulse';
  const eyeImageStatusText = !wsIp || !wsImagePort
    ? '未配置图像流地址'
    : isGlassesMode
      ? !splitEyeImageAnyConnected
        ? '等待左右眼图'
        : splitEyeImageOk
          ? '左右眼图正常'
          : '眼图数据超时'
      : eyeImageLastAt === null
        ? '未连接图像流'
        : eyeImageOk
          ? '数据正常'
          : '数据超时';
  const formatEyeImageAge = (age: number | null) =>
    age === null || !Number.isFinite(age) ? '-' : `${Math.round(age)}ms`;
  const showEyeImageEnabled = !!recordingSettings?.showEyeImage;
  const bgColor =
    typeof recordingSettings.bgColor === 'string' && /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(recordingSettings.bgColor)
      ? recordingSettings.bgColor
      : '#000000';
  const splitScreenModeEnabled = Boolean(recordingSettings?.splitScreenMode);
  const showStimulusInMonitor = playbackIndex !== null && !splitScreenModeEnabled;
  const stimulusPlaybackControlsEnabled = stimulusEnabled && (!isGlassesMode || splitScreenModeEnabled);
  const hidePreviewGaze = Boolean(recordingSettings?.hideGaze);
  const glassesEnvironmentOptions = React.useMemo(
    () => [
      { label: 'indoor', value: 301 },
      { label: 'outdoor', value: 302 },
      { label: 'darkness', value: 303 },
    ],
    [],
  );
  const glassesResolutionOptions = getSdkResolutionOptions(deviceProfile);
  const sdkEnvironmentValue = (() => {
    const n = Number(recordingSettings.sdkEnvironment);
    if (n === 302 || n === 303) return n;
    return 301;
  })();
  const sdkResolutionValue = normalizeSdkResolution(recordingSettings.sdkResolution, deviceProfile);
  const effectiveCalibrationTypes = React.useMemo(() => {
    return calibrationTypes.length > 0 ? calibrationTypes : ['三点校准', '五点校准', '九点校准'];
  }, [calibrationTypes]);
  const recordingOptionItems = React.useMemo(
    () =>
      [
        ...(stimulusPlaybackControlsEnabled ? [{ id: 'randomOrder', label: '随机播放', desc: '随机打乱刺激物播放顺序' }] : []),
        { id: 'splitScreenMode', label: '分屏观察', desc: '启用后在被试屏显示刺激，主试屏保留监控界面' },
        { id: 'externalMarkers', label: '外发标记', desc: '录制时发送UDP触发标记到外部设备' },
        { id: 'hideGaze', label: '预览隐藏注视点', desc: '仅控制画面标记显示，不影响底层注视点跟踪' },
        ...(!isGlassesMode ? [{ id: 'recordMouse', label: '记录鼠标', desc: '同时记录鼠标位置数据' }] : []),
      ],
    [isGlassesMode, stimulusPlaybackControlsEnabled],
  );
  const calibrationTypeValue = effectiveCalibrationTypes.includes(String(recordingSettings.calibrationType || ''))
    ? recordingSettings.calibrationType
    : (effectiveCalibrationTypes[0] || '三点校准');
  const calibrationPointStyleValue = normalizeCalibrationPointStyle(recordingSettings.calibrationPointStyle);
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const [loadedImageSize, setLoadedImageSize] = React.useState({ width: 0, height: 0 });
  const activeFrameWidth = Math.max(
    1,
    Number(videoPreviewMode === 'webcodecs' ? videoFrameSize?.width || 0 : loadedImageSize.width || imageCanvasRef.current?.naturalWidth || 0) || 1280,
  );
  const activeFrameHeight = Math.max(
    1,
    Number(videoPreviewMode === 'webcodecs' ? videoFrameSize?.height || 0 : loadedImageSize.height || imageCanvasRef.current?.naturalHeight || 0) || 720,
  );
  const mapPointerToNormalizedPoint = React.useCallback(
    (clientX: number, clientY: number, fallbackTarget?: HTMLElement | null) => {
      const mediaEl = videoPreviewMode === 'webcodecs'
        ? videoCanvasRef?.current || fallbackTarget
        : imageCanvasRef.current || fallbackTarget;
      if (!mediaEl) return null;
      const rect = mediaEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;

      // Read the loaded image at click time as well: React may not have committed its onLoad update yet.
      const sourceWidth = videoPreviewMode === 'webcodecs' ? activeFrameWidth : imageCanvasRef.current?.naturalWidth || 0;
      const sourceHeight = videoPreviewMode === 'webcodecs' ? activeFrameHeight : imageCanvasRef.current?.naturalHeight || 0;
      return pointerToImagePoint(clientX, clientY, rect, sourceWidth, sourceHeight);
    },
    [activeFrameHeight, activeFrameWidth, imageCanvasRef, videoCanvasRef, videoPreviewMode],
  );
  const [inlineCalibCursorPoint, setInlineCalibCursorPoint] = React.useState<{ x: number; y: number } | null>(null);
  const cardDetectionWorkerRef = React.useRef<Worker | null>(null);
  const cardDetectionBusyRef = React.useRef(false);
  const cardDetectionMissesRef = React.useRef(0);
  const cardDetectionLastPointRef = React.useRef<{ x: number; y: number } | null>(null);
  const cardDetectionSwitchCandidateRef = React.useRef<{
    point: { x: number; y: number };
    count: number;
  } | null>(null);
  const cardDetectionScratchRef = React.useRef<HTMLCanvasElement | null>(null);
  const cardDetectionLastLogRef = React.useRef(0);
  const cardDetectionOverlayLastLogRef = React.useRef(0);
  const cardDetectionCaptureSeqRef = React.useRef(0);
  const cardDetectionLastCaptureMetaRef = React.useRef<Record<string, unknown> | null>(null);
  const cardDetectionDebugFrameRef = React.useRef<{
    activeFrameWidth: number;
    activeFrameHeight: number;
    videoFrameSize: { width: number; height: number } | null;
  }>({
    activeFrameWidth: 0,
    activeFrameHeight: 0,
    videoFrameSize: null,
  });
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [containerElement, setContainerElement] = React.useState<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = React.useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const syncContainerSize = React.useCallback((element?: HTMLDivElement | null) => {
    const target = element ?? containerRef.current;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const nextWidth = target.clientWidth || rect.width;
    const nextHeight = target.clientHeight || rect.height;
    setContainerSize((prev) => {
      if (Math.abs(prev.w - nextWidth) < 0.5 && Math.abs(prev.h - nextHeight) < 0.5) {
        return prev;
      }
      return { w: nextWidth, h: nextHeight };
    });
  }, []);
  const handleContainerRef = React.useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    setContainerElement(node);
    if (node) {
      const rect = node.getBoundingClientRect();
      const nextWidth = node.clientWidth || rect.width;
      const nextHeight = node.clientHeight || rect.height;
      setContainerSize((prev) => {
        if (Math.abs(prev.w - nextWidth) < 0.5 && Math.abs(prev.h - nextHeight) < 0.5) {
          return prev;
        }
        return { w: nextWidth, h: nextHeight };
      });
    }
  }, []);
  React.useLayoutEffect(() => {
    if (!containerElement) return;
    syncContainerSize(containerElement);
    const handleWindowResize = () => {
      syncContainerSize(containerElement);
    };
    const observer = new ResizeObserver(() => {
      syncContainerSize(containerElement);
    });
    observer.observe(containerElement);
    window.addEventListener('resize', handleWindowResize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', handleWindowResize);
    };
  }, [containerElement, syncContainerSize]);

  const frameWidth = activeFrameWidth;
  const frameHeight = activeFrameHeight;
  React.useEffect(() => {
    cardDetectionLastPointRef.current = null;
    cardDetectionSwitchCandidateRef.current = null;
    cardDetectionMissesRef.current = 0;
    emitCardDetectionDebug('lock-reset', { reason: 'calibration-point-changed', calibPointIndex });
  }, [calibPointIndex]);
  React.useEffect(() => {
    cardDetectionDebugFrameRef.current = {
      activeFrameWidth,
      activeFrameHeight,
      videoFrameSize: videoFrameSize ?? null,
    };
  }, [activeFrameHeight, activeFrameWidth, videoFrameSize]);
  const selectedRecordingViewMode: RecordingViewMode | null = ['local', 'monitor', 'remote'].includes(String(recordingSettings.recordingViewMode))
    ? (recordingSettings.recordingViewMode as RecordingViewMode)
    : null;
  const modeSelectionEnabled = isGlassesMode && isTileModalityEnabled('device');
  const recordingViewMode: RecordingViewMode | null = modeSelectionEnabled ? selectedRecordingViewMode : 'local';
  const isRemoteSurface = recordingViewMode !== 'local';
  const isFixedRemoteEyeMonitor = isGlassesMode && (recordingViewMode === 'monitor' || recordingViewMode === 'remote');
  const cardDetectionSubmitting = cardDetectionStatus === 'submitting';

  React.useEffect(() => {
    const active =
      cardCalibrationActive &&
      calibrationMode === 'click' &&
      calibrationState === 'calibrating' &&
      !isRemoteSurface &&
      wsConnected;
    if (!active) {
      if (cardDetectionWorkerRef.current || cardDetectionLastPointRef.current || cardDetectionMissesRef.current > 0) {
        emitCardDetectionDebug('stop', {
          reason: 'inactive',
          cardCalibrationActive,
          calibrationMode,
          calibrationState,
          isRemoteSurface,
          wsConnected,
          misses: cardDetectionMissesRef.current,
          lastPoint: cardDetectionLastPointRef.current,
        });
      }
      cardDetectionBusyRef.current = false;
      cardDetectionMissesRef.current = 0;
      cardDetectionLastPointRef.current = null;
      cardDetectionSwitchCandidateRef.current = null;
      cardDetectionLastCaptureMetaRef.current = null;
      try {
        cardDetectionWorkerRef.current?.postMessage({ type: 'close' });
        cardDetectionWorkerRef.current?.terminate();
      } catch {}
      cardDetectionWorkerRef.current = null;
      if (cardCalibrationActive && calibrationState !== 'calibrating') {
        onCardDetectionUpdate?.({ point: null, status: 'idle', message: '' });
      }
      return undefined;
    }

    if (!cardDetectionWorkerRef.current) {
      cardDetectionWorkerRef.current = new Worker(new URL('./domain/cardCalibrationWorker.ts', import.meta.url), { type: 'module' });
    }
    emitCardDetectionDebug('start', {
      calibrationMode,
      calibrationState,
      videoPreviewMode,
      ...cardDetectionDebugFrameRef.current,
      wsConnected,
    });
    const worker = cardDetectionWorkerRef.current;
    let stopped = false;
    const maxCaptureWidth = CARD_DETECTION_CAPTURE_MAX_WIDTH;

    worker.onmessage = (event: MessageEvent) => {
      if (stopped) return;
      cardDetectionBusyRef.current = false;
      const msg = event.data as CardDetectionWorkerMessage;
      if (msg?.type === 'result') {
        const raw = msg.point;
        const captureMeta = cardDetectionLastCaptureMetaRef.current;
        const diagnostics = msg.diagnostics ?? null;
        if (
          raw &&
          Number.isFinite(raw.x) &&
          Number.isFinite(raw.y) &&
          Number(raw.confidence) >= CARD_DETECTION_MIN_CONFIDENCE
        ) {
          let x = clamp01(Number(raw.x));
          let y = clamp01(Number(raw.y));
          const prev = cardDetectionLastPointRef.current;
          let previousForSmoothing = prev;
          if (prev) {
            const distanceFromPrevious = Math.hypot(x - prev.x, y - prev.y);
            if (distanceFromPrevious > CARD_DETECTION_SWITCH_DISTANCE) {
              const existing = cardDetectionSwitchCandidateRef.current;
              const candidateDistance = existing ? Math.hypot(x - existing.point.x, y - existing.point.y) : Infinity;
              const nextCandidate =
                existing && candidateDistance <= CARD_DETECTION_SWITCH_CLUSTER_DISTANCE
                  ? { point: { x: existing.point.x * 0.35 + x * 0.65, y: existing.point.y * 0.35 + y * 0.65 }, count: existing.count + 1 }
                  : { point: { x, y }, count: 1 };
              cardDetectionSwitchCandidateRef.current = nextCandidate;
              emitCardDetectionDebug('result-switch-deferred', {
                capture: captureMeta,
                rawPoint: raw,
                diagnostics,
                previousPoint: prev,
                distanceFromPrevious,
                switchCandidate: nextCandidate,
                requiredFrames: CARD_DETECTION_SWITCH_CONFIRM_FRAMES,
              });
              if (nextCandidate.count < CARD_DETECTION_SWITCH_CONFIRM_FRAMES) {
                cardDetectionMissesRef.current = 0;
                onCardDetectionUpdate?.({
                  point: prev,
                  status: 'ready',
                  message: '已锁定靶心中心，等待新位置稳定…',
                });
                return;
              }
              x = nextCandidate.point.x;
              y = nextCandidate.point.y;
              previousForSmoothing = null;
              cardDetectionSwitchCandidateRef.current = null;
            } else {
              cardDetectionSwitchCandidateRef.current = null;
            }
          }
          const point = previousForSmoothing
            ? {
                x: previousForSmoothing.x * 0.28 + x * 0.72,
                y: previousForSmoothing.y * 0.28 + y * 0.72,
              }
            : { x, y };
          cardDetectionLastPointRef.current = point;
          cardDetectionMissesRef.current = 0;
          // #region debug-point B:result-geometry
          const selectedCandidate = diagnostics?.selectedCandidate ?? null;
          const rawX = Number(raw.x);
          const rawY = Number(raw.y);
          const correctedCenter = selectedCandidate?.correctedCenter ?? null;
          const rawCenters = selectedCandidate?.rawCenters ?? null;
          emitCardDetectionDebug('result-geometry', {
            capture: captureMeta,
            rawPoint: raw,
            smoothedPoint: point,
            selectedCandidate,
            config: diagnostics?.config ?? null,
            minArea: diagnostics?.minArea ?? null,
            positionMetrics: {
              rawOffsetFromFrameCenter: {
                dx: rawX - 0.5,
                dy: rawY - 0.5,
                radius: Math.hypot(rawX - 0.5, rawY - 0.5),
              },
              smoothedOffsetFromFrameCenter: {
                dx: point.x - 0.5,
                dy: point.y - 0.5,
                radius: Math.hypot(point.x - 0.5, point.y - 0.5),
              },
              smoothingDelta: {
                dx: point.x - x,
                dy: point.y - y,
                radius: Math.hypot(point.x - x, point.y - y),
              },
              selectedCandidate: selectedCandidate && correctedCenter && rawCenters
                ? {
                    correctedVsDotPx: {
                      dx: correctedCenter.x - rawCenters.dot.x,
                      dy: correctedCenter.y - rawCenters.dot.y,
                      radius: Math.hypot(correctedCenter.x - rawCenters.dot.x, correctedCenter.y - rawCenters.dot.y),
                    },
                    outerToHolePx: {
                      dx: rawCenters.hole.x - rawCenters.outer.x,
                      dy: rawCenters.hole.y - rawCenters.outer.y,
                      radius: Math.hypot(rawCenters.hole.x - rawCenters.outer.x, rawCenters.hole.y - rawCenters.outer.y),
                    },
                    holeToDotPx: {
                      dx: rawCenters.dot.x - rawCenters.hole.x,
                      dy: rawCenters.dot.y - rawCenters.hole.y,
                      radius: Math.hypot(rawCenters.dot.x - rawCenters.hole.x, rawCenters.dot.y - rawCenters.hole.y),
                    },
                    outerToDotPx: {
                      dx: rawCenters.dot.x - rawCenters.outer.x,
                      dy: rawCenters.dot.y - rawCenters.outer.y,
                      radius: Math.hypot(rawCenters.dot.x - rawCenters.outer.x, rawCenters.dot.y - rawCenters.outer.y),
                    },
                    rectCenterVsCorrectedPx: {
                      dx: selectedCandidate.rect.x + selectedCandidate.rect.width / 2 - correctedCenter.x,
                      dy: selectedCandidate.rect.y + selectedCandidate.rect.height / 2 - correctedCenter.y,
                      radius: Math.hypot(
                        selectedCandidate.rect.x + selectedCandidate.rect.width / 2 - correctedCenter.x,
                        selectedCandidate.rect.y + selectedCandidate.rect.height / 2 - correctedCenter.y,
                      ),
                    },
                  }
                : null,
            },
          });
          // #endregion
          emitCardDetectionDebug('result-accepted', {
            capture: captureMeta,
            rawPoint: raw,
            diagnostics,
            smoothedPoint: point,
            previousPoint: prev,
            minConfidence: CARD_DETECTION_MIN_CONFIDENCE,
          });
          onCardDetectionUpdate?.({
            point,
            status: 'ready',
            message: '已检测到靶心中心，确认位置后点击校准',
          });
          return;
        }

        cardDetectionMissesRef.current += 1;
        emitCardDetectionDebug('result-rejected', {
          capture: captureMeta,
          rawPoint: raw ?? null,
          diagnostics,
          misses: cardDetectionMissesRef.current,
          lastPoint: cardDetectionLastPointRef.current,
          minConfidence: CARD_DETECTION_MIN_CONFIDENCE,
        });
        if (cardDetectionMissesRef.current >= 4) {
          cardDetectionLastPointRef.current = null;
          onCardDetectionUpdate?.({
            point: null,
            status: 'detecting',
            message: '正在检测卡片圆点中心…',
          });
        } else {
          onCardDetectionUpdate?.({
            point: cardDetectionLastPointRef.current,
            status: cardDetectionLastPointRef.current ? 'ready' : 'detecting',
            message: cardDetectionLastPointRef.current ? '已检测到靶心中心，确认位置后点击校准' : '正在检测卡片圆点中心…',
          });
        }
        return;
      }
      if (msg?.type === 'error') {
        cardDetectionMissesRef.current += 1;
        emitCardDetectionDebug('worker-error', {
          capture: cardDetectionLastCaptureMetaRef.current,
          message: typeof msg.message === 'string' ? msg.message : null,
          error: msg.error ?? null,
          misses: cardDetectionMissesRef.current,
          lastPoint: cardDetectionLastPointRef.current,
        });
        onCardDetectionUpdate?.({
          point: cardDetectionLastPointRef.current,
          status: cardDetectionLastPointRef.current ? 'ready' : 'error',
          message: cardDetectionLastPointRef.current ? '已检测到靶心中心，确认位置后点击校准' : '卡片检测失败',
        });
      }
    };

    const capture = () => {
      if (stopped || cardDetectionBusyRef.current) return;
      const providerFrame = videoPreviewMode === 'webcodecs' ? cardDetectionFrameRef?.current : null;
      const providerFresh = !!providerFrame && Date.now() - providerFrame.updatedAt <= 500;
      const source = providerFresh
        ? providerFrame.canvas
        : videoPreviewMode === 'webcodecs'
          ? videoCanvasRef?.current
          : imageCanvasRef.current;
      const sourceName = providerFresh
        ? 'webcodecs-frame-provider'
        : videoPreviewMode === 'webcodecs'
          ? 'preview-canvas-fallback'
          : 'image-element';
      const sourceWidth =
        providerFresh
          ? providerFrame.width
          : source instanceof HTMLCanvasElement
          ? source.width
          : source instanceof HTMLImageElement
            ? source.naturalWidth
            : 0;
      const sourceHeight =
        providerFresh
          ? providerFrame.height
          : source instanceof HTMLCanvasElement
          ? source.height
          : source instanceof HTMLImageElement
            ? source.naturalHeight
            : 0;
      if (!source || sourceWidth <= 0 || sourceHeight <= 0) {
        const now = Date.now();
        if (now - cardDetectionLastLogRef.current >= 1000) {
          cardDetectionLastLogRef.current = now;
          emitCardDetectionDebug('capture-wait-source', {
            videoPreviewMode,
            providerFresh,
            providerAgeMs: providerFrame ? now - providerFrame.updatedAt : null,
            hasProviderFrame: !!providerFrame,
            hasVideoCanvas: !!videoCanvasRef?.current,
            hasImageElement: !!imageCanvasRef.current,
            sourceWidth,
            sourceHeight,
          });
        }
        onCardDetectionUpdate?.({ point: cardDetectionLastPointRef.current, status: 'detecting', message: '等待视频画面用于卡片检测…' });
        return;
      }

      const scale = Math.min(1, maxCaptureWidth / Math.max(sourceWidth, 1));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const canvas = cardDetectionScratchRef.current || document.createElement('canvas');
      cardDetectionScratchRef.current = canvas;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      try {
        ctx.drawImage(source, 0, 0, width, height);
        const imageData = ctx.getImageData(0, 0, width, height);
        const buffer = imageData.data.buffer;
        const now = Date.now();
        const captureSeq = cardDetectionCaptureSeqRef.current + 1;
        cardDetectionCaptureSeqRef.current = captureSeq;
        const captureMeta = {
          captureSeq,
          source: sourceName,
          sourceWidth,
          sourceHeight,
          detectionWidth: width,
          detectionHeight: height,
          scale,
          providerFresh,
          providerAgeMs: providerFrame ? now - providerFrame.updatedAt : null,
          providerSequence: providerFrame?.sequence ?? null,
          providerFrameWidth: providerFrame?.sourceFrameWidth ?? null,
          providerFrameHeight: providerFrame?.sourceFrameHeight ?? null,
          videoPreviewMode,
          ...cardDetectionDebugFrameRef.current,
        };
        cardDetectionLastCaptureMetaRef.current = captureMeta;
        if (now - cardDetectionLastLogRef.current >= 500) {
          cardDetectionLastLogRef.current = now;
          console.log('[card-detection] capture', {
            source: sourceName,
            sourceWidth,
            sourceHeight,
            detectionWidth: width,
            detectionHeight: height,
            providerAgeMs: providerFrame ? now - providerFrame.updatedAt : null,
            providerFrameWidth: providerFrame?.sourceFrameWidth ?? null,
            providerFrameHeight: providerFrame?.sourceFrameHeight ?? null,
          });
          emitCardDetectionDebug('capture', captureMeta);
        }
        cardDetectionBusyRef.current = true;
        worker.postMessage({ type: 'detect', width, height, buffer }, [buffer]);
      } catch (error) {
        cardDetectionBusyRef.current = false;
        emitCardDetectionDebug('capture-error', {
          capture: cardDetectionLastCaptureMetaRef.current,
          message: error instanceof Error ? error.message : String(error),
        });
        onCardDetectionUpdate?.({ point: cardDetectionLastPointRef.current, status: 'error', message: '无法读取当前视频画面进行检测' });
      }
    };

    onCardDetectionUpdate?.({
      point: cardDetectionLastPointRef.current,
      status: cardDetectionLastPointRef.current ? 'ready' : 'detecting',
      message: cardDetectionLastPointRef.current ? '已检测到靶心中心，确认位置后点击校准' : '正在检测卡片圆点中心…',
    });
    const intervalId = window.setInterval(capture, 90);
    capture();
    return () => {
      stopped = true;
      window.clearInterval(intervalId);
      emitCardDetectionDebug('interval-cleanup', {
        misses: cardDetectionMissesRef.current,
        lastPoint: cardDetectionLastPointRef.current,
      });
    };
  }, [
    cardCalibrationActive,
    calibrationMode,
    calibrationState,
    imageCanvasRef,
    isRemoteSurface,
    onCardDetectionUpdate,
    videoCanvasRef,
    videoPreviewMode,
    cardDetectionFrameRef,
    wsConnected,
  ]);

  const effectiveContainerSize = React.useMemo(() => {
    if (containerSize.w > 0 && containerSize.h > 0) {
      return containerSize;
    }
    if (!containerElement) {
      return { w: 0, h: 0 };
    }
    const rect = containerElement.getBoundingClientRect();
    return {
      w: containerElement.clientWidth || rect.width,
      h: containerElement.clientHeight || rect.height,
    };
  }, [containerElement, containerSize.h, containerSize.w]);

  const sceneBox = React.useMemo(() => {
    return containedImageBox(effectiveContainerSize.w, effectiveContainerSize.h, frameWidth, frameHeight);
  }, [effectiveContainerSize.h, effectiveContainerSize.w, frameHeight, frameWidth]);

  const isLivePreviewSurfaceReady = wsConnected && isCameraOn && lastImageAt !== null;
  const shouldAllowLivePreviewGaze =
    isRecording ||
    isPreviewing ||
    calibrationState === 'finished' ||
    hasSavedCalibration ||
    isGlassesMode;
  const showCalibrationTestHint = isCalibrationTestMode;
  const shouldAllowPreviewGazeDot =
    !hidePreviewGaze &&
    (!splitScreenModeEnabled || isGlassesMode) &&
    calibrationState !== 'calibrating' &&
    isLivePreviewSurfaceReady &&
    shouldAllowLivePreviewGaze;
  const isLightPreviewBackground = React.useMemo(() => {
    const raw = String(bgColor || '').trim().replace(/^#/, '');
    const hex = raw.length === 3
      ? raw.split('').map((ch) => `${ch}${ch}`).join('')
      : raw;
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return false;
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return luminance > 0.62;
  }, [bgColor]);
  const calibrationTestHintStyle = React.useMemo<React.CSSProperties>(() => (
    isLightPreviewBackground
      ? {
          background: 'rgba(15, 23, 42, 0.84)',
          color: '#ffffff',
          border: '1px solid rgba(255, 255, 255, 0.2)',
          boxShadow: '0 12px 28px rgba(15, 23, 42, 0.18)',
        }
      : {
          background: 'rgba(255, 255, 255, 0.9)',
          color: '#0f172a',
          border: '1px solid rgba(15, 23, 42, 0.12)',
          boxShadow: '0 12px 28px rgba(0, 0, 0, 0.28)',
        }
  ), [isLightPreviewBackground]);
  const calibrationPointsCount = isPupilCardCalibration && isCalibrationTestMode ? 3 : getCalibrationPointsCount(String(recordingSettings.calibrationType || ''));
  const calibrationProgressSequence = React.useMemo(() => {
    if (isPupilCardCalibration) return getPupilCalibrationSequence(calibrationPointsCount);
    if (calibrationPointsCount === 1) return [4];
    if (calibrationPointsCount === 3) return [4, 0, 8];
    if (calibrationPointsCount === 5) return [4, 0, 2, 6, 8];
    return [0, 1, 2, 3, 4, 5, 6, 7, 8];
  }, [calibrationPointsCount, isPupilCardCalibration, isCalibrationTestMode]);
  const normalCalibrationCompletedCount = Math.max(
    0,
    calibrationProgressSequence.indexOf(
      Number.isFinite(calibPointIndex) ? Math.round(calibPointIndex) : calibrationProgressSequence[0],
    ),
  );
  const calibrationProgressCompletedCount = cardCalibrationActive
    ? cardCompletedPoints.length
    : normalCalibrationCompletedCount;
  const showCalibrationProgress = calibrationState === 'calibrating' && calibrationMode === 'click';
  const isInlineClickCalibrationActive =
    calibrationMode === 'click' &&
    (!cardCalibrationActive || allowManualCardPoint) &&
    calibrationState === 'calibrating' &&
    playbackIndex === null &&
    wsConnected;
  const cardDetectedPointStyle = React.useMemo<React.CSSProperties>(() => {
    if (!cardDetectedPoint) return {};
    if (sceneBox) {
      return {
        left: `${sceneBox.left + cardDetectedPoint.x * sceneBox.width}px`,
        top: `${sceneBox.top + cardDetectedPoint.y * sceneBox.height}px`,
      };
    }
    return {
      left: `${cardDetectedPoint.x * 100}%`,
      top: `${cardDetectedPoint.y * 100}%`,
    };
  }, [cardDetectedPoint, sceneBox]);
  React.useEffect(() => {
    if (!cardCalibrationActive || calibrationState !== 'calibrating' || !cardDetectedPoint) return;
    const now = Date.now();
    if (now - cardDetectionOverlayLastLogRef.current < 300) return;
    cardDetectionOverlayLastLogRef.current = now;
    const containerRect = containerRef.current?.getBoundingClientRect?.();
    const previewSurfaceRect = (
      videoPreviewMode === 'webcodecs' ? videoCanvasRef?.current : imageCanvasRef.current
    )?.getBoundingClientRect?.();
    const overlayDiagnostics = {
      hasSceneBox: !!sceneBox,
      hasContainerElement: !!containerRef.current,
      containerRect: containerRect
        ? {
            width: containerRect.width,
            height: containerRect.height,
            top: containerRect.top,
            left: containerRect.left,
          }
        : null,
      previewSurfaceRect: previewSurfaceRect
        ? {
            width: previewSurfaceRect.width,
            height: previewSurfaceRect.height,
            top: previewSurfaceRect.top,
            left: previewSurfaceRect.left,
          }
        : null,
      sceneBoxInputs: {
        containerWidth: containerSize.w,
        containerHeight: containerSize.h,
        frameWidth,
        frameHeight,
      },
      previewState: {
        wsConnected,
        isCameraOn,
        isRemoteSurface,
        lastImageAt,
        videoPreviewMode,
      },
      pointOffsetFromFrameCenter: {
        dx: cardDetectedPoint.x - 0.5,
        dy: cardDetectedPoint.y - 0.5,
        radius: Math.hypot(cardDetectedPoint.x - 0.5, cardDetectedPoint.y - 0.5),
      },
    };
    // #region debug-point D:overlay-mapping
    emitCardDetectionDebug('overlay-mapping', {
      point: cardDetectedPoint,
      sceneBox: sceneBox
        ? {
            left: sceneBox.left,
            top: sceneBox.top,
            width: sceneBox.width,
            height: sceneBox.height,
            pixelLeft: sceneBox.left + cardDetectedPoint.x * sceneBox.width,
            pixelTop: sceneBox.top + cardDetectedPoint.y * sceneBox.height,
          }
        : null,
      overlayDiagnostics,
      containerSize,
      activeFrameWidth,
      activeFrameHeight,
      videoPreviewMode,
    });
    // #endregion
  }, [
    activeFrameHeight,
    activeFrameWidth,
    calibrationState,
    cardCalibrationActive,
    cardDetectedPoint,
    containerSize,
    frameHeight,
    frameWidth,
    imageCanvasRef,
    isCameraOn,
    isRemoteSurface,
    lastImageAt,
    sceneBox,
    videoCanvasRef,
    videoPreviewMode,
    wsConnected,
  ]);
  const inlineCalibCursorPointStyle = React.useMemo<React.CSSProperties>(() => {
    if (!inlineCalibCursorPoint) return {};
    if (sceneBox) {
      return {
        left: `${sceneBox.left + inlineCalibCursorPoint.x * sceneBox.width}px`,
        top: `${sceneBox.top + inlineCalibCursorPoint.y * sceneBox.height}px`,
      };
    }
    return {
      left: `${inlineCalibCursorPoint.x * 100}%`,
      top: `${inlineCalibCursorPoint.y * 100}%`,
    };
  }, [inlineCalibCursorPoint, sceneBox]);
  React.useEffect(() => {
    if (!isInlineClickCalibrationActive) {
      setInlineCalibCursorPoint(null);
    }
  }, [isInlineClickCalibrationActive]);
  const handleInlineCalibrationClick = React.useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (!isInlineClickCalibrationActive) return;
      const mapped = mapPointerToNormalizedPoint(event.clientX, event.clientY, event.currentTarget);
      if (!mapped) return;
      setInlineCalibCursorPoint(mapped);
      onInlineCalibrationPoint?.(mapped);
    },
    [isInlineClickCalibrationActive, mapPointerToNormalizedPoint, onInlineCalibrationPoint],
  );
  const localIp = String(recordingSettings.localIp || '127.0.0.1');
  const previewFrameClass = 'border-slate-200';
  const panelClass = 'bg-white border-[var(--app-border)] text-[var(--app-text)]';
  const panelHeaderClass = 'border-[var(--app-border)] bg-[var(--app-surface-2)]';
  const mutedTextClass = 'text-[var(--app-muted)]';
  const labelTextClass = 'text-slate-700';
  const sectionTitleClass = 'text-xs font-semibold text-[var(--app-text)]';
  const inputClass = 'w-full rounded-lg border border-[var(--app-border)] bg-white px-2.5 py-1.5 text-xs font-mono text-slate-800 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15';
  const selectClass = 'w-full rounded-lg border border-[var(--app-border)] bg-white pl-2.5 pr-0 py-1.5 text-xs text-slate-800 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400';
  const modeItems: Array<{ id: RecordingViewMode; label: string; desc: string; Icon: typeof Monitor }> = [
    { id: 'local', label: '本地模式', desc: '使用当前录制链路', Icon: Monitor },
    { id: 'monitor', label: '监测模式', desc: '远程画面监测', Icon: RadioTower },
    { id: 'remote', label: '远程模式', desc: '远程画面与录制', Icon: Wifi },
  ];
  const setRecordingViewMode = (mode: RecordingViewMode) => {
    setRecordingSettings({ ...recordingSettings, recordingViewMode: mode });
    if (mode === 'monitor' || mode === 'remote') {
      onHiddenMonitorTileIdsChange?.(['participant', 'facial']);
      setMaximizedMonitorTile('device');
      setActiveDataModule('eye-tracking');
    }
  };
  const clearRecordingViewMode = async () => {
    if (onBeforeSwitchMode) {
      await onBeforeSwitchMode();
    }
    setRecordingSettings({ ...recordingSettings, recordingViewMode: null });
  };
  const setLocalIp = (value: string) => {
    setRecordingSettings({ ...recordingSettings, localIp: value });
  };
  const setRemoteIp = (value: string) => {
    setRecordingSettings({ ...recordingSettings, remoteIp: value });
  };
  const monitorTileDefinitions: Array<{ id: MonitorTileId; title: string }> = isFixedRemoteEyeMonitor ? [
    { id: 'device', title: '眼动检测' },
  ] : [
    ...(isTileModalityEnabled('device') ? [{ id: 'device' as const, title: '眼动检测' }] : []),
    ...(isTileModalityEnabled('participant') && (splitScreenModeEnabled || monitorSnapshots.hasParticipantWindow)
      ? [{ id: 'participant' as const, title: '被试屏幕' }]
      : []),
    ...(isTileModalityEnabled('facial') ? [{ id: 'facial' as const, title: '表情检测' }] : []),
  ];
  const availableMonitorTiles = monitorTileDefinitions.filter(
    (tile) => (isFixedRemoteEyeMonitor || !hiddenMonitorTiles.has(tile.id)) && (!maximizedMonitorTile || maximizedMonitorTile === tile.id),
  );
  const visibleMonitorTiles = (isFixedRemoteEyeMonitor || monitorLayout === 'single') && !maximizedMonitorTile
    ? availableMonitorTiles.slice(0, 1)
    : availableMonitorTiles;
  const monitorGridClass = isFixedRemoteEyeMonitor || maximizedMonitorTile || monitorLayout === 'single'
    ? 'grid-cols-1 grid-rows-1'
    : monitorLayout === '3x3'
      ? 'grid-cols-3 grid-rows-3'
      : 'grid-cols-2 grid-rows-2';
  const showMonitorTile = (id: MonitorTileId) => visibleMonitorTiles.some((tile) => tile.id === id);
  // Keep the local eye-video surface mounted while it is temporarily hidden or
  // another tile is maximized.
  // The WebCodecs renderer owns the canvas identity; unmounting it would leave
  // the decoder rendering into a detached canvas and the restored tile black.
  const shouldMountMonitorTile = (id: MonitorTileId) => {
    if (id !== 'device') return showMonitorTile(id);
    return monitorTileDefinitions.some((tile) => tile.id === id);
  };
  const hideMonitorTile = (id: MonitorTileId) => {
    if (isFixedRemoteEyeMonitor && id === 'device') return;
    if (!hiddenMonitorTiles.has(id)) {
      onHiddenMonitorTileIdsChange?.([...hiddenMonitorTileIds, id]);
    }
    setMaximizedMonitorTile((current) => current === id ? null : current);
  };
  const monitorTileControls = (id: MonitorTileId, title: string, connected: boolean) => (
    <div className={`mrt-monitor-tile-header absolute inset-x-0 top-0 z-[110] flex h-8 items-center justify-between border-b px-2.5 text-slate-700 ${panelHeaderClass}`}>
      <div className="flex min-w-0 items-center gap-2">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${connected ? 'bg-emerald-400' : 'bg-slate-400'}`} />
        <span className="truncate text-[11px] font-bold">{title}</span>
      </div>
      {!isFixedRemoteEyeMonitor && <div className="flex items-center gap-1">
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md border-0 bg-transparent text-white/70 transition-colors hover:bg-white/15 hover:text-white"
          title={maximizedMonitorTile === id ? '还原' : '最大化'}
          aria-label={maximizedMonitorTile === id ? `还原${title}` : `最大化${title}`}
          onClick={() => setMaximizedMonitorTile((current) => current === id ? null : id)}
        >
          {maximizedMonitorTile === id ? <Minimize2 size={15} strokeWidth={2.5} /> : <Maximize2 size={15} strokeWidth={2.5} />}
        </button>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md border-0 bg-transparent text-white/70 transition-colors hover:bg-white/15 hover:text-white"
          title="最小化"
          aria-label={`最小化${title}`}
          onClick={() => hideMonitorTile(id)}
        >
          <Minus size={15} strokeWidth={3} />
        </button>
      </div>}
    </div>
  );

  // 多模块侧边栏 tab 切换
  const visibleDataModules = React.useMemo(() => {
    if (isFixedRemoteEyeMonitor) return RECORDING_MODULES.filter(m => m.id === 'eye-tracking')
    return RECORDING_MODULES.filter(m =>
      !hiddenMonitorTileIds.includes(m.tileId)
      && (!enabledModalitySet || enabledModalitySet.has(m.modality)),
    )
  }, [hiddenMonitorTileIds, isFixedRemoteEyeMonitor, enabledModalitySet])
  const [activeDataModule, setActiveDataModule] = React.useState<RecordingModuleId>(visibleDataModules[0]?.id || 'eye-tracking')
  React.useEffect(() => {
    if (visibleDataModules.length > 0 && !visibleDataModules.find(m => m.id === activeDataModule)) {
      setActiveDataModule(visibleDataModules[0].id)
    }
  }, [visibleDataModules, activeDataModule])

  if (modeSelectionEnabled && !recordingViewMode) {
    return (
      <div className="h-full rounded-xl border border-slate-200 bg-slate-50 p-6">
        <div className="mx-auto flex h-full max-w-5xl flex-col justify-center">
          <div className="mb-6">
            <div className="text-xs font-bold tracking-[0.2em] text-slate-400">实验录制</div>
            <h2 className="mt-2 text-2xl font-black text-slate-900">选择录制模式</h2>
          </div>
          <div className="grid grid-cols-3 gap-4">
            {modeItems.map(({ id, label, desc, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setRecordingViewMode(id)}
                className="group flex min-h-[220px] flex-col justify-between rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-sky-300 hover:shadow-lg"
              >
                <div>
                  <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-lg bg-sky-50 text-sky-600 transition-colors group-hover:bg-sky-600 group-hover:text-white">
                    <Icon size={24} />
                  </div>
                  <div className="text-lg font-black text-slate-900">{label}</div>
                  <div className="mt-2 text-sm leading-6 text-slate-500">{desc}</div>
                </div>
                <div className="mt-8 text-xs font-bold text-sky-600">进入模式</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full">
      <div className="h-full flex gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className={`grid min-h-0 flex-1 gap-2 ${monitorGridClass}`}>
          {shouldMountMonitorTile('device') && (
            <div
              ref={handleContainerRef}
              data-i18n-skip={isCalibrationTestMode && isEn ? 'true' : undefined}
              className={`min-h-0 rounded-xl overflow-hidden relative shadow-inner items-center justify-center border ${previewFrameClass} ${showMonitorTile('device') ? 'flex' : 'hidden'}`}
              style={{ backgroundColor: bgColor }}
              onMouseDown={() => setActiveDataModule('eye-tracking')}
            >
              {monitorTileControls('device', '眼动检测', wsConnected && lastImageAt !== null)}
          {/* 标记实时显示 */}
          {!isRemoteSurface && isRecording && <MarkerIndicators markers={markers} recordingStartTime={recordingStartTime} />}
          {!isRemoteSurface && sceneBox && (
            <div
              className="absolute"
              onClick={isInlineClickCalibrationActive ? handleInlineCalibrationClick : undefined}
              style={{
                left: `${sceneBox.left}px`,
                top: `${sceneBox.top}px`,
                width: `${sceneBox.width}px`,
                height: `${sceneBox.height}px`,
                zIndex: 51,
                pointerEvents: isInlineClickCalibrationActive ? 'auto' : 'none',
                cursor: isInlineClickCalibrationActive ? 'pointer' : 'default',
              }}
            >
              {showCalibrationTestHint && (
                <div
                  className="absolute left-1/2 top-4 -translate-x-1/2 rounded-full px-4 py-2 text-xs font-semibold tracking-wide pointer-events-none"
                  style={{
                    ...calibrationTestHintStyle,
                    zIndex: 60,
                    backdropFilter: 'blur(12px)',
                  }}
                >
                  {isEn ? 'Calibration test · Press Esc to exit' : '校准测试中 · 按 Esc 退出'}
                </div>
              )}
            </div>
          )}
          <RecordingPreviewGazeDot
            store={eyeDataStore}
            visible={!isRemoteSurface && shouldAllowPreviewGazeDot}
            isGlassesMode={isGlassesMode}
            frameWidth={frameWidth}
            frameHeight={frameHeight}
            sceneBox={sceneBox}
            pointStyle={calibrationPointStyleValue}
          />
          {!isRemoteSurface && showCalibrationProgress && (
            <>
              <div className="absolute bottom-3 left-1/2 z-[95] flex -translate-x-1/2 items-center gap-2">
                <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white/90 px-3 py-2 shadow-sm">
                  {Array.from({
                    length: calibrationPointsCount,
                  }).map((_, index) => (
                    <span
                      key={index}
                      className="block h-3 w-3 rounded-full border border-white shadow-sm"
                      style={{
                        backgroundColor: index < calibrationProgressCompletedCount ? '#22c55e' : '#ef4444',
                      }}
                    />
                  ))}
                </div>
                {cardCalibrationActive && (
                  <button
                    type="button"
                    className="whitespace-nowrap rounded-full bg-green-500 px-4 py-2 text-xs font-semibold text-white shadow-lg transition-colors hover:bg-green-600 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:hover:bg-slate-300"
                    style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                    onClick={(event) => {
                      event.stopPropagation();
                      onCardCalibrationTrigger?.();
                    }}
                    disabled={isPupilCardCalibration && (!isCalibrationTrackerReady || !cardDetectedPoint || cardDetectionStatus !== 'ready' || cardDetectionSubmitting)}
                  >
                    {isPupilCardCalibration && !isCalibrationTrackerReady
                      ? (isEn ? 'Preparing tracker…' : '正在准备追踪…')
                      : isPupilCardCalibration && isCalibrationTestMode ? (isEn ? 'Measure target' : '采样验证点') : (isEn ? 'Calibrate point' : '校准')}
                  </button>
                )}
              </div>
              {cardCalibrationActive && calibrationState === 'calibrating' && cardDetectedPoint && (
                <div
                  className="absolute z-[90] flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center pointer-events-none"
                  style={cardDetectedPointStyle}
                >
                  {renderCalibrationPointVisual(calibrationPointStyleValue, true)}
                </div>
              )}
              {isInlineClickCalibrationActive && inlineCalibCursorPoint && (
                <div
                  className="absolute z-[90] flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center pointer-events-none"
                  style={inlineCalibCursorPointStyle}
                >
                  {renderCalibrationPointVisual(calibrationPointStyleValue, true)}
                </div>
              )}
              {cardCalibrationActive && calibrationState === 'calibrating' && (
                <div className="absolute left-3 top-10 z-[95] max-w-[60%] rounded-md border border-slate-200 bg-white/90 px-3 py-2 text-[11px] text-slate-700 shadow-sm">
                  {isPupilCardCalibration && !isCalibrationTrackerReady
                    ? (isEn ? 'Preparing scene tracker. Video stays connected; please wait before sampling.' : '正在准备场景追踪，请等待就绪后采样；视频连接保持开启。')
                    : isPupilCardCalibration && isCalibrationTestMode
                    ? (cardDetectionStatus === 'error' ? cardDetectionMessage : (isEn ? 'Independent validation: fixate the physical card center and sample three spread-out targets different from training positions. Hold still for one second per target.' : '独立验证：持续注视实体卡片中心，点击采样验证点；三个位置应分散且不同于训练位置，每点保持稳定约1秒。'))
                    : allowManualCardPoint
                    ? `${cardDetectionStatus === 'error' || cardDetectionStatus === 'submitting' ? cardDetectionMessage + ' ' : ''}卡片式${calibrationPointsCount}点校准：请注视实体卡片中心，在场景画面中点击中心点；采样约1秒，请保持头部和卡片稳定。完成后移动卡片再采下一点。`
                    : isPupilCardCalibration
                    ? (cardDetectionStatus === 'error' ? cardDetectionMessage : (isEn ? `Point ${Math.min(cardCompletedPoints.length + 1, calibrationPointsCount)}/${calibrationPointsCount}: freely position the physical card in the scene. Fixate its detected center and hold still, then click Calibrate point. Choose spread-out positions between samples.` : `第 ${Math.min(cardCompletedPoints.length + 1, calibrationPointsCount)}/${calibrationPointsCount} 点：实体卡片可放在场景画面内任意位置，注视自动识别中心并保持稳定后点击校准。各次采样请选择分散的位置。`))
                    : cardDetectionMessage || `卡片式${calibrationPointsCount}点校准：请将校准卡片放入视频画面，检测到圆点后点击校准`}
                </div>
              )}
            </>
          )}
          
          {isRemoteSurface ? (
            <>
              <video
                ref={remoteVideoRef}
                className="w-full h-full object-contain"
                autoPlay
                playsInline
                muted
                style={{
                  display: remoteMediaConnected ? 'block' : 'none',
                }}
              />
              <div
                className="absolute inset-0 flex items-center justify-center"
                style={{ display: !remoteMediaConnected ? 'flex' : 'none' }}
              >
                <div className="flex flex-col items-center gap-2 text-slate-500">
                  <WifiOff size={36} className="text-slate-300" />
                  <div className="text-xs font-semibold">未连接远程画面</div>
                  <div className="text-[11px]">请在右侧输入远程 IP 后连接</div>
                </div>
              </div>
            </>
          ) : showStimulusInMonitor && playbackIndex !== null && playbackSequence && playbackSequence.length > 0 && playbackIndex < playbackSequence.length ? (
            <RecordingStimulusPreview
              playbackIndex={playbackIndex}
              playbackSequence={playbackSequence}
              stimuli={stimuli}
            />
          ) : (
            <>
              <img
                ref={imageCanvasRef}
                onLoad={(event) => {
                  const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
                  if (width > 0 && height > 0) {
                    setLoadedImageSize((prev) => prev.width === width && prev.height === height ? prev : { width, height });
                  }
                }}
                className={`w-full h-full object-contain ${isInlineClickCalibrationActive ? 'cursor-pointer' : ''}`}
                alt=""
                style={{
                  display: wsConnected && videoPreviewMode !== 'webcodecs' ? 'block' : 'none',
                  opacity: lastImageAt === null || videoPreviewMode === 'webcodecs' ? 0 : 1,
                }}
                onClick={handleInlineCalibrationClick}
              />
              <canvas
                ref={videoCanvasRef}
                className={`w-full h-full object-contain ${isInlineClickCalibrationActive ? 'cursor-pointer' : ''}`}
                style={{
                  display: wsConnected && videoPreviewMode === 'webcodecs' ? 'block' : 'none',
                  opacity: lastImageAt === null ? 0 : 1,
                }}
                onClick={handleInlineCalibrationClick}
              />
              <div
                className="absolute inset-0 flex items-center justify-center"
                style={{ display: !wsConnected || lastImageAt === null ? 'flex' : 'none', pointerEvents: 'none' }}
              >
                <div className="flex flex-col items-center gap-2 text-slate-500">
                  <PlaceholderIcon size={36} className="text-slate-300" />
                  <div className="text-xs font-semibold">{placeholderTitle}</div>
                  <div className="text-[11px]">{placeholderDesc}</div>
                </div>
              </div>
              {isInlineClickCalibrationActive && !cardCalibrationActive && (
                <div className="absolute left-3 top-10 z-40 rounded-md border border-sky-200 bg-white/90 px-3 py-2 text-[11px] text-slate-700 shadow-sm">
                  眼镜式校准中：请注视目标位置并在视频画面上点击
                </div>
              )}
            </>
          )}
            </div>
          )}

          {showMonitorTile('participant') && (
            <div className="relative min-h-0 overflow-hidden rounded-xl border border-slate-200 bg-black shadow-inner">
              {monitorTileControls('participant', '被试屏幕', monitorSnapshots.hasParticipantWindow)}
              {monitorSnapshots.hasParticipantWindow ? (
                <div className="absolute inset-x-0 bottom-0 top-8 overflow-hidden" style={{ backgroundColor: recordingSettings.bgColor || '#000000' }}>
                  {calibrationState === 'calibrating' && !isPupilCardCalibration ? (
                    <div
                      className="relative h-full w-full"
                      style={{
                        background:
                          'radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--app-primary) 12%, var(--app-bg)) 0%, var(--app-bg) 66%)',
                      }}
                    >
                      {CALIB_POINTS.map((point, index) => {
                        const active = index === Math.max(0, Math.min(CALIB_POINTS.length - 1, calibPointIndex));
                        const targetSize = Math.round(24 + Math.max(0.12, Math.min(1, calibScale)) * 34);
                        return (
                          <div
                            key={`${point.x}-${point.y}`}
                            className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full"
                            style={{
                              left: `${point.x * 100}%`,
                              top: `${point.y * 100}%`,
                              width: active ? `${targetSize}px` : '8px',
                              height: active ? `${targetSize}px` : '8px',
                              background: active ? 'transparent' : 'rgba(148, 163, 184, 0.55)',
                              border: active ? '2px solid rgba(239, 68, 68, 0.72)' : '1px solid rgba(255, 255, 255, 0.55)',
                            }}
                          >
                            {active && renderCalibrationPointVisual(
                              normalizeCalibrationPointStyle(recordingSettings.calibrationPointStyle),
                              true,
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : calibrationState === 'finished' && isCalibrationTestMode ? (
                    <CalibrationTestSurface language={language} compact>
                      <RecordingPreviewGazeDot
                        store={eyeDataStore}
                        visible
                        isGlassesMode={isGlassesMode}
                        frameWidth={frameWidth}
                        frameHeight={frameHeight}
                        sceneBox={null}
                        pointStyle={calibrationPointStyleValue}
                      />
                    </CalibrationTestSurface>
                  ) : (isRecording || isPreviewing) && playbackIndex !== null && playbackSequence && playbackSequence.length > playbackIndex ? (
                    <RecordingStimulusPreview
                      playbackIndex={playbackIndex}
                      playbackSequence={playbackSequence}
                      stimuli={stimuli}
                      passive
                    />
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-300">
                      <Monitor size={30} className="text-slate-500" />
                      <div className="text-xs font-bold">{isEn ? 'Participant screen ready' : '被试屏已就绪'}</div>
                    </div>
                  )}
                  <RecordingPreviewGazeDot
                    store={eyeDataStore}
                    visible={isRecording && !isCalibrationTestMode && !isGlassesMode}
                    isGlassesMode={isGlassesMode}
                    frameWidth={frameWidth}
                    frameHeight={frameHeight}
                    sceneBox={null}
                    pointStyle={calibrationPointStyleValue}
                  />
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 pt-8 text-center text-slate-400">
                  <Monitor size={34} className="text-slate-600" />
                  <div className="text-xs font-bold">被试屏幕未打开</div>
                  <div className="text-[11px] text-slate-500">开启“分屏观察”并开始预览或录制后显示</div>
                </div>
              )}
              <div className="absolute bottom-2 left-2 rounded bg-slate-950/75 px-2 py-1 text-[10px] font-semibold text-white/80">
                {isRecording && monitorSnapshots.hasParticipantWindow ? '● 录制监控中' : monitorSnapshots.hasParticipantWindow ? '实时预览' : '等待被试屏'}
              </div>
            </div>
          )}

          {showMonitorTile('facial') && (
            <div onMouseDown={() => setActiveDataModule('facial')} className="relative min-h-0 overflow-hidden rounded-xl border border-slate-200 bg-black shadow-inner">
              {monitorTileControls('facial', '表情检测', Boolean(facialSessionStatus?.running))}
              <div className="flex h-full flex-col items-center justify-center gap-2 px-4 pt-8 text-center text-slate-500">
                <ScanFace size={36} className={isFacialCapturing ? 'text-emerald-500' : 'text-slate-300'} />
                {facialPreviewStream ? (
                  <video
                    ref={(element) => {
                      if (element && element.srcObject !== facialPreviewStream) {
                        element.srcObject = facialPreviewStream;
                        void element.play().catch(() => {});
                      }
                    }}
                    autoPlay
                    muted
                    playsInline
                    className="absolute inset-0 h-full w-full object-contain pt-8"
                  />
                ) : facialPreviewDataUrl ? (
                   <img
                     src={facialPreviewDataUrl}
                     className="absolute inset-0 h-full w-full object-contain pt-8"
                     alt="表情摄像头预览"
                   />
                 ) : null}
                 {hasFacialPreview && facialFaceBox && facialSettings?.showFaceBox && (
                   <>
                     {/* L 形绿色四角表情框 */}
                     <div
                       className="absolute pt-8 pointer-events-none"
                       style={{
                         left: `${facialFaceBox.x * 100}%`,
                         top: `${facialFaceBox.y * 100}%`,
                         width: `${facialFaceBox.w * 100}%`,
                         height: `${facialFaceBox.h * 100}%`,
                       }}
                     >
                       <span className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-emerald-400 rounded-tl-sm" />
                       <span className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-emerald-400 rounded-tr-sm" />
                       <span className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-emerald-400 rounded-bl-sm" />
                       <span className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-emerald-400 rounded-br-sm" />
                     </div>
                   </>
                 )}
                 {hasFacialPreview && facialLandmarks.length > 0 && facialSettings?.showFaceMask && (
                   <svg
                     className="pointer-events-none absolute inset-0 h-full w-full pt-8"
                     viewBox={`0 0 ${facialSessionStatus?.actual?.width || 640} ${facialSessionStatus?.actual?.height || 480}`}
                     preserveAspectRatio="xMidYMid meet"
                   >
                     {facialMeshEdges.map(([a, b]) => {
                       const start = facialLandmarks[a];
                       const end = facialLandmarks[b];
                       const width = facialSessionStatus?.actual?.width || 640;
                       const height = facialSessionStatus?.actual?.height || 480;
                       if (!isRenderableFacialLandmark(start) || !isRenderableFacialLandmark(end)) return null;
                       return <line key={`${a}-${b}`} x1={start.x * width} y1={start.y * height} x2={end.x * width} y2={end.y * height} stroke="rgba(255,255,255,0.72)" strokeWidth="0.65" />;
                     })}
                     {[
                       { points: FACE_OVAL, color: '#22d3ee', width: 2.1 },
                       { points: LEFT_EYE, color: '#3b82f6', width: 1.8 },
                       { points: RIGHT_EYE, color: '#d946ef', width: 1.8 },
                       { points: OUTER_LIPS, color: '#22d3ee', width: 2.1 },
                       { points: INNER_LIPS, color: '#22d3ee', width: 1.5 },
                     ].map((contour, contourIndex) => (
                       <polyline
                         key={contourIndex}
                         points={contour.points.map((index) => {
                           const point = facialLandmarks[index];
                           return isRenderableFacialLandmark(point) ? `${point.x * (facialSessionStatus?.actual?.width || 640)},${point.y * (facialSessionStatus?.actual?.height || 480)}` : '';
                         }).filter(Boolean).join(' ')}
                         fill="none"
                         stroke={contour.color}
                         strokeWidth={contour.width}
                         strokeLinejoin="round"
                         strokeLinecap="round"
                       />
                     ))}
                   </svg>
                 )}
                 {hasFacialPreview && facialExpression && (
                   <div className="pointer-events-none absolute bottom-4 left-1/2 min-w-20 -translate-x-1/2 rounded-full border border-white/10 bg-slate-900/75 px-3 py-1 text-center text-[10px] font-semibold text-emerald-400 backdrop-blur">
                     {facialExpression}
                   </div>
                 )}
                 {hasFacialPreview && facialSettings?.showConfidence && Object.keys(facialEmotionScores).length > 0 && (
                   <div className="pointer-events-none absolute bottom-3 right-3 w-36 space-y-1 rounded-lg border border-white/10 bg-slate-950/80 p-2 text-left backdrop-blur">
                     {FACIAL_CONFIDENCE_ORDER.map((label) => {
                       const score = Number(facialEmotionScores[label] || 0);
                       return (
                       <div key={label} className="grid grid-cols-[34px_1fr_28px] items-center gap-1 text-[8px] text-white/75">
                         <span>{label}</span><span className="h-1 overflow-hidden rounded bg-white/15"><span className="block h-full bg-cyan-400" style={{ width: `${Math.max(0, Math.min(1, score)) * 100}%` }} /></span><span className="text-right font-mono">{Math.round(score * 100)}%</span>
                       </div>
                       );
                     })}
                   </div>
                 )}
                {isFacialCapturing ? (
                  <>
                    <div className="text-xs font-bold text-emerald-600">表情采集进行中</div>
                    <div className="text-[11px] text-slate-400">
                      {facialCameraId ? facialCameras.find(c => c.id === facialCameraId)?.name || '已连接摄像头' : '已连接摄像头'}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full animate-pulse bg-emerald-500" />
                      <span className="text-[10px] text-emerald-500">● 同步录制中</span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-xs font-semibold">表情检测</div>
                    <div className="text-[11px]">
                      {facialCameraId
                        ? '摄像头已就绪，开始录制时自动同步采集'
                        : '请在右侧表情设置中选择摄像头'}
                    </div>
                  </>
                )}
                {facialCaptureNotice && (
                  <div className="max-w-[90%] rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] leading-4 text-amber-700">{facialCaptureNotice}</div>
                )}
              </div>
            </div>
          )}

          {!maximizedMonitorTile && (() => {
            const totalSlots = monitorLayout === '3x3' ? 9 : monitorLayout === '2x2' ? 4 : 1;
            const emptyCount = Math.max(0, totalSlots - visibleMonitorTiles.length);
            if (emptyCount <= 0) return null;
            return Array.from({ length: emptyCount }).map((_, index) => (
              <div key={`empty-monitor-${index}`} className="flex min-h-0 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 text-[11px] font-semibold text-slate-400">
                未分配画面
              </div>
            ));
          })()}
          </div>
        </div>

        <div className={`w-[320px] rounded-xl border flex flex-col overflow-hidden shadow-sm ${panelClass}`}>
          <div className={`p-3 border-b ${panelHeaderClass}`}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">录制面板</h3>
                <div className={`mt-0.5 text-[11px] ${mutedTextClass}`}>
                  {recordingViewMode === 'local' ? '本地模式' : recordingViewMode === 'monitor' ? '监测模式' : '远程模式'}
                </div>
              </div>
              {modeSelectionEnabled && (
                <button
                  type="button"
                  onClick={clearRecordingViewMode}
                  className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-slate-700 transition-colors hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700"
                >
                  切换模式
                </button>
              )}
            </div>
          </div>

          {/* 模块数据 tab 切换 — 仅在多模块可见时显示 */}
          {visibleDataModules.length > 1 && (
            <div className="flex gap-1 border-b border-slate-200 bg-slate-50/50 px-3 py-1.5">
              {visibleDataModules.map(m => (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={activeDataModule === m.id}
                  onClick={() => setActiveDataModule(m.id)}
                  className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                    activeDataModule === m.id
                      ? 'bg-sky-100 text-sky-700 ring-1 ring-inset ring-sky-200'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-3 space-y-4">
          {activeDataModule === 'facial' ? (
            <RecordingFacialPanel
              cameraId={facialCameraId}
              cameras={facialCameras}
              isCapturing={isFacialCapturing}
              captureNotice={facialCaptureNotice}
              sessionStatus={facialSessionStatus}
              settings={facialSettings}
              onRefreshCameras={onRefreshFacialCameras}
              onCameraChange={onFacialCameraChange}
              onSettingsChange={onFacialSettingsChange}
            />
          ) : recordingViewMode === 'local' ? (
            <>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className={sectionTitleClass}>受试者</label>
            </div>
            {subjects.length === 0 ? (
              <div className={`text-[11px] leading-5 ${mutedTextClass}`}>暂无受试者，请先在受试者模块中新建</div>
            ) : (
              <CustomSelect
                value={recordingSettings.subjectId || subjects[0]?.id}
                onChange={(e) => setRecordingSettings({ ...recordingSettings, subjectId: e.target.value })}
                className={selectClass}
              >
                {subjects.map((s) => (
                  <option key={s.id} value={s.id} data-i18n-skip="true">
                    {s.name}
                  </option>
                ))}
              </CustomSelect>
            )}
          </div>

          <div className="space-y-3 pt-3 border-t border-slate-200">
            <div className="flex items-center justify-between gap-3">
              <label className={sectionTitleClass}>校准</label>
              <div className="w-40 shrink-0">
                <CustomSelect
                  value={calibrationTypeValue}
                  onChange={(e) => setRecordingSettings({ ...recordingSettings, calibrationType: e.target.value })}
                  disabled={isRecording || isCalibrationStarting || isCalibrationTestMode || calibrationState === 'calibrating'}
                  title={isRecording || isCalibrationStarting || isCalibrationTestMode || calibrationState === 'calibrating'
                    ? (isEn ? 'Finish the current recording or calibration before changing the calibration type.' : '请先结束当前录制或校准，再切换校准类型。')
                    : undefined}
                  className={selectClass}
                >
                  {effectiveCalibrationTypes.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </CustomSelect>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <label className="text-xs text-slate-700">注视点样式</label>
              <div className="w-40 shrink-0">
                <CustomSelect
                  value={calibrationPointStyleValue}
                  onChange={(e) =>
                    setRecordingSettings({
                      ...recordingSettings,
                      calibrationPointStyle: normalizeCalibrationPointStyle(e.target.value),
                    })
                  }
                  className={selectClass}
                >
                  {CALIBRATION_POINT_STYLE_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </CustomSelect>
              </div>
            </div>
            {isGlassesMode && !isPupilCardCalibration && (
              <>
                <div className="flex items-center justify-between gap-3">
                  <label className="text-xs text-slate-700">环境</label>
                  <div className="w-40 shrink-0">
                    <CustomSelect
                      value={String(sdkEnvironmentValue)}
                      onChange={(e) =>
                        setRecordingSettings({
                          ...recordingSettings,
                          sdkEnvironment: Number(e.target.value) || 301,
                        })
                      }
                      className={selectClass}
                    >
                      {glassesEnvironmentOptions.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </CustomSelect>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <label className="text-xs text-slate-700">分辨率</label>
                  <div className="w-40 shrink-0">
                    <CustomSelect
                      value={String(sdkResolutionValue)}
                      onChange={(e) =>
                        setRecordingSettings({
                          ...recordingSettings,
                          sdkResolution: normalizeSdkResolution(e.target.value, deviceProfile),
                        })
                      }
                      className={selectClass}
                    >
                      {glassesResolutionOptions.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </CustomSelect>
                  </div>
                </div>
              </>
            )}

            <div className="space-y-1.5">
              <div className="text-[11px] font-medium text-[var(--app-muted)]">{calibrationResult.title}</div>
              <div className="grid grid-cols-2 gap-3 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2">
                <div className="text-[11px] text-slate-600">
                  {isEn ? 'Left' : '左眼'}: <span className="font-mono font-semibold tabular-nums text-slate-800" title={calibrationResult.left.tooltip}>{calibrationResult.left.value}</span>
                </div>
                <div className="text-[11px] text-slate-600">
                  {isEn ? 'Right' : '右眼'}: <span className="font-mono font-semibold tabular-nums text-slate-800" title={calibrationResult.right.tooltip}>{calibrationResult.right.value}</span>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <button
                onClick={() => onStartCalibration?.()}
                disabled={!onStartCalibration || !isCameraOn || isRecording || isCalibrationStarting || calibrationState === 'calibrating'}
                title={!isCameraOn ? (isEn ? 'Start the device first' : '请先启动设备') : undefined}
                className={`${btnPrimary} w-full`}
              >
                {isCalibrationStarting
                  ? (isEn ? 'Starting calibration…' : '正在启动校准…')
                  : calibrationState === 'calibrating'
                  ? (isEn ? 'Calibrating…' : '校准中…')
                  : (isEn ? 'Start calibration' : '开始校准')}
              </button>
              <button
                onClick={() => onStartCalibrationTest?.()}
                disabled={!onStartCalibrationTest || isRecording || calibrationState === 'calibrating'}
                className={`${btnSecondary} w-full`}
              >
                {isEn ? 'Calibration test' : '校准测试'}
              </button>
              <div className={`text-[11px] leading-5 ${mutedTextClass}`}>
                {isPupilCardCalibration
                  ? (isEn ? `Freely position the physical card in the scene and sample ${calibrationPointsCount} spread-out, non-collinear positions. Fixate its detected center and hold still during each sample. If eye data is poor, move the card to a comfortable viewing position and retry the current point. Then run Calibration test.` : `实体卡片可在场景画面内自由摆放，采样 ${calibrationPointsCount} 个分散且不共线的位置。每次注视自动识别中心并保持稳定；眼动数据不足时，可移到舒适注视的位置重试当前点。完成后进行校准测试。`)
                  : hasSavedCalibration
                  ? '已检测到可复用校准数据，可直接进入测试界面验证当前精度。'
                  : '当前未检测到可复用校准数据，请先完成一次校准。'}
              </div>
              <div className={`text-[11px] leading-5 ${mutedTextClass}`}>
                受试者离开后重新就位时，可先进行校准测试判断是否需要重新校准。测试界面可按 Esc 退出。
              </div>
            </div>

            <div className="space-y-2.5 pt-3 border-t border-slate-200">
              <h4 className={sectionTitleClass}>{isEn ? 'Eye images & capture' : '眼图与采集'}</h4>
              {[
                { id: 'showEyeImage', label: '眼图显示' },
                { id: 'saveRawData', label: '保存眼图数据' }, 
                { id: 'saveEyeCalibration', label: '保存眼图校准' },
              ].map((opt) => (
                <label key={opt.id} className="flex items-center gap-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={recordingSettings[opt.id]}
                    onChange={(e) => setRecordingSettings({ ...recordingSettings, [opt.id]: e.target.checked })}
                    className="w-4 h-4 rounded bg-white border-slate-300 text-sky-500 focus:ring-sky-500 accent-sky-500"
                  />
                  <span className="text-xs text-slate-700 group-hover:text-slate-900">{opt.label}</span>
                </label>
              ))}
            </div>

            <RecordingEyeDataPanel store={eyeDataStore} />

            {showEyeImageEnabled && (
              <div className="space-y-2 pt-3 border-t border-slate-200">
                <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-slate-700">
                  <span>眼图</span>
                  <span className={`font-mono font-normal tabular-nums ${mutedTextClass}`}>
                    {isGlassesMode
                      ? `L ${formatEyeImageAge(leftEyeImageAgeMs)} / R ${formatEyeImageAge(rightEyeImageAgeMs)}`
                      : formatEyeImageAge(eyeImageAgeMs)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <div className="flex items-center gap-2">
                    <div className={`w-1.5 h-1.5 rounded-full ${eyeImageStatusDotClass}`} />
                    <span className="text-slate-600">{eyeImageStatusText}</span>
                  </div>
                </div>
                {isGlassesMode ? (
                  <div className="w-full aspect-video grid grid-cols-2 gap-2">
                    {[
                      { label: '左眼', ref: leftEyeImageRef, lastAt: leftEyeImageLastAt },
                      { label: '右眼', ref: rightEyeImageRef, lastAt: rightEyeImageLastAt },
                    ].map((item) => (
                      <div
                        key={item.label}
                        className="min-w-0 bg-slate-950 rounded-lg border border-slate-200 overflow-hidden flex items-center justify-center relative"
                      >
                        <div className="absolute left-2 top-2 z-10 rounded bg-slate-900/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                          {item.label}
                        </div>
                        <img
                          ref={item.ref}
                          className="w-full h-full object-contain"
                          alt=""
                          style={{ display: item.lastAt === null ? 'none' : 'block' }}
                        />
                        <div
                          className="absolute inset-0 flex items-center justify-center"
                          style={{ display: item.lastAt === null ? 'flex' : 'none' }}
                        >
                          <div className="flex flex-col items-center gap-1.5 text-slate-500">
                            <WifiOff size={22} className="text-slate-300" />
                            <div className="text-[10px] font-semibold">等待{item.label}图</div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="w-full aspect-video bg-slate-950 rounded-lg border border-slate-200 overflow-hidden flex items-center justify-center relative">
                    <img
                      ref={eyeImageRef}
                      className="w-full h-full object-contain"
                      alt=""
                      style={{ display: eyeImageLastAt === null ? 'none' : 'block' }}
                    />
                    <div
                      className="absolute inset-0 flex items-center justify-center"
                      style={{ display: eyeImageLastAt === null ? 'flex' : 'none' }}
                    >
                      <div className="flex flex-col items-center gap-2 text-slate-500">
                        <WifiOff size={28} className="text-slate-300" />
                        <div className="text-xs font-semibold">未连接图像流</div>
                        <div className="text-[11px]">请在顶部连接图像流</div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="space-y-3 pt-3 border-t border-slate-200">
          <h4 className={sectionTitleClass}>{isEn ? 'Display & recording' : '显示与录制'}</h4>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-slate-700">背景颜色选择</span>
            <label className="relative cursor-pointer rounded p-1 focus-within:ring-2 focus-within:ring-sky-400 focus-within:ring-offset-1">
              <span
                className="block h-5 w-5 rounded border border-slate-300 shadow-sm"
                style={{ backgroundColor: bgColor }}
              />
              <input
                type="color"
                value={bgColor}
                aria-label="打开背景颜色选择器"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setRecordingSettings({ ...recordingSettings, bgColor: e.target.value })
                }
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
            </label>
          </div>

          <div className="space-y-2.5">
            {recordingOptionItems.map((opt) => (
              <label key={opt.id} className="flex items-start gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={recordingSettings[opt.id]}
                  onChange={(e) => setRecordingSettings({ ...recordingSettings, [opt.id]: e.target.checked })}
                  className="w-4 h-4 rounded bg-white border-slate-300 text-sky-500 focus:ring-sky-500 accent-sky-500 mt-0.5"
                />
                <div className="flex-1">
                  <span className="text-xs text-slate-700 group-hover:text-slate-900 block">{opt.label}</span>
                  <span className={`text-[11px] leading-4 block mt-0.5 ${mutedTextClass}`}>{opt.desc}</span>
                </div>
              </label>
            ))}
          </div>
          </div>

          <div className="space-y-2.5 pt-3 border-t border-slate-200">
            <h4 className={sectionTitleClass}>{isEn ? 'Playback & stop' : '播放与结束'}</h4>
            {[
              ...(stimulusPlaybackControlsEnabled ? [{ id: 'endOnClick', label: '点击播放下一个素材' }] : []),
              { id: 'endOnKey', label: '按键ESC结束' },
            ].map((opt) => (
              <label key={opt.id} className="flex items-center gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={recordingSettings[opt.id]}
                  onChange={(e) => setRecordingSettings({ ...recordingSettings, [opt.id]: e.target.checked })}
                  className="w-4 h-4 rounded bg-white border-slate-300 text-sky-500 focus:ring-sky-500 accent-sky-500"
                />
                <span className="text-xs text-slate-700 group-hover:text-slate-900">{opt.label}</span>
              </label>
            ))}
          </div>
            </>
          ) : (
            <div className="space-y-4">
              <div className="space-y-3">
                <h4 className={sectionTitleClass}>{isEn ? 'Connection settings' : '连接设置'}</h4>
                <label className="block space-y-1.5">
                  <span className={`text-[11px] font-bold ${labelTextClass}`}>本地IP</span>
                  <input
                    type="text"
                    value={localIp}
                    onChange={(event) => setLocalIp(event.target.value)}
                    className={inputClass}
                    placeholder="例如 192.168.1.10"
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className={`text-[11px] font-bold ${labelTextClass}`}>远程IP</span>
                  <input
                    type="text"
                    value={remoteIp}
                    onChange={(event) => setRemoteIp(event.target.value)}
                    className={inputClass}
                    placeholder="例如 192.168.1.20"
                  />
                </label>
                <button
                  type="button"
                  onClick={handleConnectRemotePreview}
                  disabled={!remoteIp.trim()}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-sky-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Wifi size={14} />
                  {remoteSignalConnected ? '重新连接' : '连接'}
                </button>
              </div>

              {recordingViewMode === 'remote' && (
                <div className="space-y-2 pt-3 border-t border-slate-200">
                  <h4 className={sectionTitleClass}>{isEn ? 'Remote recording' : '远程录制'}</h4>
                  <button
                    type="button"
                    onClick={() => void sendRemoteRecordingCommand('recording.start')}
                    disabled={remoteCommandBusy || remoteRecordingActive}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Video size={14} />
                    启动远程录制
                  </button>
                  <button
                    type="button"
                    onClick={() => void sendRemoteRecordingCommand('recording.stop')}
                    disabled={remoteCommandBusy || !remoteRecordingActive}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-rose-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <VideoOff size={14} />
                    结束远程录制
                  </button>
                </div>
              )}

              <div className="space-y-2 pt-3 border-t border-slate-200">
                <h4 className={sectionTitleClass}>连接信息</h4>
                <div className="space-y-1.5 text-[11px]">
                  <div className="flex items-center justify-between">
                    <span className={mutedTextClass}>视频状态</span>
                    <span className="font-mono">{remoteStatusText}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className={mutedTextClass}>最近帧</span>
                    <span className="font-mono">{remoteFrameAgeMs === null ? '-' : `${Math.round(remoteFrameAgeMs)}ms`}</span>
                  </div>
                  {recordingViewMode === 'remote' && (
                    <div className="flex items-center justify-between">
                      <span className={mutedTextClass}>远程录制</span>
                      <span className="font-mono">{remoteRecordingActive ? '进行中' : '未启动'}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          
        </div>
      </div>
    </div>
    </div>
  );
};

export default RecordingPage;
