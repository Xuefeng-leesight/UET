import React from 'react';
import { Modal } from '@/shared/ui/Modal';
import { btnDanger, btnSecondary } from '@/shared/ui/buttonClasses';
import {
  Camera,
  Database,
  Download,
  Eye,
  FastForward,
  ImagePlus,
  LoaderCircle,
  Monitor,
  Pause,
  Play,
  Rewind,
  RotateCcw,
  Route,
  Settings,
  SkipBack,
  SkipForward,
  Trash2,
  Video,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { RecordingRecord } from '@shared/contracts/domain/models';
import { ipcClient, type GazeMappingResultData } from '@/infrastructure/electron/ipcClient';
import { recordDataService } from '@/features/records/RecordDataService';
import type { HeatmapPoint } from '@/shared/types/mrt';
import { TimelineAnalysis } from '@/features/records/TimelineAnalysis';
import { getDisplayRecordName } from '@/features/records/domain/recordDisplayName';
import { useLanguage } from '@/app/i18n/useLanguage';
import { translateTextForLanguage } from '@/app/i18n/useDomTranslation';
import { DEFAULT_MAPPING_CONFIDENCE_THRESHOLD, isMappingPointVisible, mappingVisibilityMessage } from '@/features/mapping/mappingVisibility';
import { loadCompleteMappingRecord, type MappingRecordEntry } from '@/features/mapping/mappingRecordData';

type SelectedFile = { path: string; url: string | null; name: string };

interface MappingPageProps {
  records: RecordingRecord[];
  projectDir: string;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const GAZE_WINDOW_DURATION_MS = 30_000;
const GAZE_WINDOW_STEP_MS = 10_000;
const GAZE_WINDOW_LOOK_BEHIND_MS = 5_000;
const MAX_WINDOW_GAZE_POINTS = 50_000;
const MAX_MAPPING_GAZE_POINTS = 500_000;
const MAPPING_KEYFRAME_INTERVAL_FRAMES = 15;
const MIN_IMAGE_ZOOM = 0.5;
const MAX_IMAGE_ZOOM = 4;
const IMAGE_ZOOM_STEP = 0.25;
const UNCALIBRATED_POINT_COLOR = '#0ea5e9';
const MANUALLY_CALIBRATED_POINT_COLOR = '#f59e0b';
const DELETED_POINT_COLOR = '#94a3b8';

const formatTime = (seconds: number) => {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(safeSeconds % 60).padStart(2, '0')}`;
};

const findClosestPointByTime = (points: HeatmapPoint[], timestampMs: number): HeatmapPoint | null => {
  if (points.length === 0) return null;
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(points[middle].timestamp || 0) < timestampMs) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return points[0];
  const before = points[low - 1];
  const after = points[low];
  return Math.abs(Number(before.timestamp || 0) - timestampMs) <= Math.abs(Number(after.timestamp || 0) - timestampMs)
    ? before
    : after;
};

const getMappedPointDistance = (
  point: GazeMappingResultData['gazeData'][number],
  timestampMs: number,
): number => {
  const end = Number(point.timestampMs);
  const start = end - Math.max(0, Number(point.durationMs || 0));
  return timestampMs < start ? start - timestampMs : timestampMs > end ? timestampMs - end : 0;
};

const findClosestMappedPointByTime = (
  points: GazeMappingResultData['gazeData'],
  timestampMs: number,
): GazeMappingResultData['gazeData'][number] | null => {
  if (points.length === 0) return null;
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(points[middle].timestampMs) < timestampMs) low = middle + 1;
    else high = middle;
  }
  const after = low < points.length ? points[low] : null;
  const before = low > 0 ? points[low - 1] : null;
  if (!before) return after;
  if (!after) return before;
  return getMappedPointDistance(before, timestampMs) <= getMappedPointDistance(after, timestampMs)
    ? before
    : after;
};

const getGazeWindow = (timestampMs: number) => {
  const startTimeMs = Math.floor(Math.max(0, timestampMs - GAZE_WINDOW_LOOK_BEHIND_MS) / GAZE_WINDOW_STEP_MS)
    * GAZE_WINDOW_STEP_MS;
  return {
    startTimeMs,
    endTimeMs: startTimeMs + GAZE_WINDOW_DURATION_MS,
  };
};

const drawMappedTrajectory = (
  context: CanvasRenderingContext2D,
  points: GazeMappingResultData['gazeData'],
  options: {
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
    scale: number;
    color: string;
    lineWidth: number;
    pointRadius: number;
  },
) => {
  const { width, height, offsetX, offsetY, scale, color, lineWidth, pointRadius } = options;
  if (points.length === 0) return;
  context.save();
  context.beginPath();
  context.rect(offsetX, offsetY, width, height);
  context.clip();
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.globalAlpha = 0.68;
  context.beginPath();
  points.forEach((point, index) => {
    const x = offsetX + point.x * scale;
    const y = offsetY + point.y * scale;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();

  const stride = Math.max(1, Math.ceil(points.length / 1200));
  context.globalAlpha = 0.86;
  context.strokeStyle = color;
  context.lineWidth = Math.max(1.5, Math.min(3, lineWidth * 0.75));
  context.shadowColor = color;
  context.shadowBlur = 10;
  for (let index = 0; index < points.length; index += stride) {
    const point = points[index];
    context.beginPath();
    context.arc(offsetX + point.x * scale, offsetY + point.y * scale, pointRadius, 0, Math.PI * 2);
    context.stroke();
  }
  context.shadowColor = 'transparent';
  context.shadowBlur = 0;
  context.restore();
};

const dedupeFixationEvents = (points: HeatmapPoint[]): HeatmapPoint[] => {
  const events = new Map<string, HeatmapPoint>();
  points.forEach((point, index) => {
    const fixationTimestamp = Number(point.fixationTimestampMs);
    const eventId = Number(point.id);
    const duration = Number(point.fixationDurationMs ?? point.weight ?? 0);
    const key = Number.isFinite(fixationTimestamp)
      ? `timestamp:${fixationTimestamp.toFixed(3)}`
      : Number.isFinite(eventId)
        ? `id:${eventId}`
        : `point:${Math.round(Number(point.timestamp || 0) - Math.max(0, duration))}:${point.x.toFixed(4)}:${point.y.toFixed(4)}:${index}`;
    const current = events.get(key);
    const currentDuration = Number(current?.fixationDurationMs ?? current?.weight ?? 0);
    const shouldReplace = !current
      || point.fixationState === 4 && current.fixationState !== 4
      || point.fixationState === current.fixationState && duration >= currentDuration;
    if (shouldReplace) {
      events.set(key, {
        ...point,
        weight: Number.isFinite(duration) && duration > 0 ? duration : point.weight,
        fixationDurationMs: Number.isFinite(duration) && duration > 0 ? duration : undefined,
      });
    }
  });
  return Array.from(events.values()).sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
};

const MappingPage: React.FC<MappingPageProps> = ({ records, projectDir }) => {
  const { language } = useLanguage();
  const isEn = language === 'en-US';
  const tr = React.useCallback((zh: string, en: string) => (isEn ? en : zh), [isEn]);
  const translateBackendMessage = React.useCallback(
    (value: string | undefined, fallbackZh: string, fallbackEn: string) => {
      if (!value) return tr(fallbackZh, fallbackEn);
      return isEn ? translateTextForLanguage(value, language) : value;
    },
    [isEn, language, tr],
  );
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const videoStageRef = React.useRef<HTMLDivElement | null>(null);
  const imageRef = React.useRef<HTMLImageElement | null>(null);
  const imageStageRef = React.useRef<HTMLDivElement | null>(null);
  const trajectoryCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const lastReviewPointIdRef = React.useRef<string | null>(null);
  const gazeWindowRequestKeyRef = React.useRef('');
  const gazeWindowRangeRef = React.useRef<{ startTimeMs: number; endTimeMs: number } | null>(null);
  const recordSelectionRequestRef = React.useRef(0);
  React.useEffect(() => {
    recordSelectionRequestRef.current += 1;
    return () => { recordSelectionRequestRef.current += 1; };
  }, [projectDir]);
  const pipDragRef = React.useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const [selectedRecordId, setSelectedRecordId] = React.useState('');
  const [videoFile, setVideoFile] = React.useState<SelectedFile | null>(null);
  const [gazeFile, setGazeFile] = React.useState<SelectedFile | null>(null);
  const [imageFile, setImageFile] = React.useState<SelectedFile | null>(null);
  const [videoSize, setVideoSize] = React.useState({ width: 1280, height: 720 });
  const [videoStageSize, setVideoStageSize] = React.useState({ width: 0, height: 0 });
  const [imageStageSize, setImageStageSize] = React.useState({ width: 0, height: 0 });
  const [imageNaturalSize, setImageNaturalSize] = React.useState({ width: 0, height: 0 });
  const [imageZoom, setImageZoom] = React.useState(1);
  const [gazePoints, setGazePoints] = React.useState<HeatmapPoint[]>([]);
  const [result, setResult] = React.useState<GazeMappingResultData | null>(null);
  const [outputPath, setOutputPath] = React.useState('');
  const [isLoadingPoints, setIsLoadingPoints] = React.useState(false);
  const [isMapping, setIsMapping] = React.useState(false);
  const [isExportingImage, setIsExportingImage] = React.useState(false);
  const [exportingRecordPath, setExportingRecordPath] = React.useState('');
  const [deletingRecordPath, setDeletingRecordPath] = React.useState('');
  const [pendingDeleteRecord, setPendingDeleteRecord] = React.useState<{ outputPath: string; result: GazeMappingResultData } | null>(null);
  const [message, setMessage] = React.useState('');
  const [currentTimeMs, setCurrentTimeMs] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [activeViewTab, setActiveViewTab] = React.useState<'video' | 'mapped' | 'records'>('video');
  const [lineWidth, setLineWidth] = React.useState(2.5);
  const [pointRadius, setPointRadius] = React.useState(10);
  const [trajectoryColor, setTrajectoryColor] = React.useState('#ef4444');
  const [selectedPointId, setSelectedPointId] = React.useState<string | null>(null);
  const [isManualCalibrating, setIsManualCalibrating] = React.useState(false);
  const [isUpdatingPoint, setIsUpdatingPoint] = React.useState(false);
  const [isTrajectoryPlaybackMode, setIsTrajectoryPlaybackMode] = React.useState(false);
  const [isPointReviewMode, setIsPointReviewMode] = React.useState(false);
  const [confidenceThreshold, setConfidenceThreshold] = React.useState(DEFAULT_MAPPING_CONFIDENCE_THRESHOLD);
  const [pipPosition, setPipPosition] = React.useState({ x: 16, y: 16 });
  const [mappingRecords, setMappingRecords] = React.useState<Array<{ outputPath: string; result: GazeMappingResultData }>>([]);
  const [, forceCanvasLayout] = React.useReducer((value) => value + 1, 0);

  const resetImageView = React.useCallback(() => {
    setImageZoom(1);
    const stage = imageStageRef.current;
    if (stage) {
      stage.scrollLeft = 0;
      stage.scrollTop = 0;
    }
  }, []);

  const selectedRecord = records.find((record) => record.id === selectedRecordId) || null;
  const currentTime = currentTimeMs / 1000;
  const fps = Number(selectedRecord?.fps || result?.video.fps || 25);
  const frameStep = Number.isFinite(fps) && fps > 0 ? 1 / fps : 0.04;
  const pointKey = React.useCallback((point: GazeMappingResultData['gazeData'][number], index: number) => String(point.sourceId ?? index), []);
  const availableMappedPoints = React.useMemo(
    () => (result?.gazeData.filter(
      (point) => isMappingPointVisible(point, confidenceThreshold),
    ) || []).sort((left, right) => left.timestampMs - right.timestampMs),
    [confidenceThreshold, result],
  );
  const deletedPointCount = React.useMemo(
    () => result?.gazeData.reduce((count, point) => count + (point.deleted === true ? 1 : 0), 0) || 0,
    [result],
  );
  const currentMappedPoint = React.useMemo(
    () => findClosestMappedPointByTime(availableMappedPoints, currentTimeMs),
    [availableMappedPoints, currentTimeMs],
  );
  const mappedResultDuration = React.useMemo(() => {
    if (!result?.gazeData.length) return 0;
    return result.gazeData.reduce((maximum, point) => (
      Math.max(maximum, Number(point.timestampMs || 0))
    ), 0) / 1000;
  }, [result]);

  React.useEffect(() => {
    if (!isPointReviewMode || !isPlaying || !currentMappedPoint || !result) return;
    const index = result.gazeData.indexOf(currentMappedPoint);
    const key = pointKey(currentMappedPoint, index);
    if (key === lastReviewPointIdRef.current) return;
    lastReviewPointIdRef.current = key;
    setSelectedPointId(key);
    videoRef.current?.pause();
  }, [currentMappedPoint, isPlaying, isPointReviewMode, pointKey, result]);

  const loadGazePoints = React.useCallback(async (
    csvPath: string,
    record: RecordingRecord | null | undefined,
    timestampMs: number,
  ) => {
    const windowRange = getGazeWindow(timestampMs);
    const requestKey = [
      csvPath,
      windowRange.startTimeMs,
      windowRange.endTimeMs,
      record?.deviceType === '眼镜式' ? 'glasses' : 'desktop',
      record?.videoWidth || videoSize.width,
      record?.videoHeight || videoSize.height,
    ].join('|');
    if (gazeWindowRequestKeyRef.current === requestKey) return gazePoints;
    gazeWindowRequestKeyRef.current = requestKey;
    gazeWindowRangeRef.current = windowRange;
    setIsLoadingPoints(true);
    setMessage(tr('正在解析注视点数据…', 'Parsing fixation data…'));
    try {
      const response = await recordDataService.loadPoints({
        csvPath,
        pointMode: 'fixation',
        isGlassesMode: record?.deviceType === '眼镜式',
        frameWidth: record?.videoWidth || videoSize.width,
        frameHeight: record?.videoHeight || videoSize.height,
        maxPoints: MAX_WINDOW_GAZE_POINTS,
        startTimeMs: windowRange.startTimeMs,
        endTimeMs: windowRange.endTimeMs,
      });
      if (gazeWindowRequestKeyRef.current !== requestKey) return [];
      if (!response.ok) {
        setGazePoints([]);
        setMessage(translateBackendMessage(
          'message' in response ? response.message : undefined,
          '注视点解析失败',
          'Failed to parse fixation data',
        ));
        return [];
      }
      const points = dedupeFixationEvents((response.points as HeatmapPoint[]).filter(
        (point) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1,
      ));
      setGazePoints(points);
      setMessage(tr(
        `已载入当前 30 秒窗口的 ${points.length.toLocaleString()} 个有效注视点`,
        `${points.length.toLocaleString()} valid fixation points loaded for the current 30-second window`,
      ));
      return points;
    } finally {
      if (gazeWindowRequestKeyRef.current === requestKey) setIsLoadingPoints(false);
    }
  }, [gazePoints, tr, translateBackendMessage, videoSize.height, videoSize.width]);

  const loadAllGazePoints = React.useCallback(async (
    csvPath: string,
    record?: RecordingRecord | null,
  ): Promise<HeatmapPoint[]> => {
    const response = await recordDataService.loadPoints({
      csvPath,
      pointMode: 'fixation',
      isGlassesMode: record?.deviceType === '眼镜式',
      frameWidth: record?.videoWidth || videoSize.width,
      frameHeight: record?.videoHeight || videoSize.height,
      maxPoints: MAX_MAPPING_GAZE_POINTS,
    });
    if (!response.ok) {
      setMessage(translateBackendMessage(
        'message' in response ? response.message : undefined,
        '注视点解析失败',
        'Failed to parse fixation data',
      ));
      return [];
    }
    return dedupeFixationEvents((response.points as HeatmapPoint[]).filter(
      (point) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1,
    ));
  }, [translateBackendMessage, videoSize.height, videoSize.width]);

  React.useEffect(() => {
    if (!gazeFile?.path) return;
    const range = gazeWindowRangeRef.current;
    const desired = getGazeWindow(currentTimeMs);
    if (range?.startTimeMs === desired.startTimeMs && range.endTimeMs === desired.endTimeMs) return;
    void loadGazePoints(gazeFile.path, selectedRecord, currentTimeMs);
  }, [currentTimeMs, gazeFile?.path, loadGazePoints, selectedRecord]);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!videoFile?.url || !video) {
      if (mappedResultDuration > 0) setDuration(mappedResultDuration);
      return;
    }
    const syncDuration = () => {
      const mediaDuration = Number(video.duration);
      if (Number.isFinite(mediaDuration) && mediaDuration > 0) {
        setDuration(mediaDuration);
      } else if (mappedResultDuration > 0) {
        setDuration(mappedResultDuration);
      }
    };
    video.addEventListener('loadedmetadata', syncDuration);
    video.addEventListener('durationchange', syncDuration);
    syncDuration();
    return () => {
      video.removeEventListener('loadedmetadata', syncDuration);
      video.removeEventListener('durationchange', syncDuration);
    };
  }, [mappedResultDuration, videoFile?.url]);

  const refreshMappingRecords = React.useCallback(async () => {
    if (!projectDir) return;
    const response = await ipcClient.listGazeMappingRecords({ projectDir });
    if (response.ok) setMappingRecords(response.records);
  }, [projectDir]);

  React.useEffect(() => {
    void refreshMappingRecords();
  }, [refreshMappingRecords]);

  const chooseImage = React.useCallback(async () => {
    const picked = await ipcClient.selectGazeMappingImage();
    if (picked.canceled) return;
    const file = { path: picked.path, url: picked.url, name: picked.name };
    setResult(null);
    setOutputPath('');
    resetImageView();
    setImageFile(file);
    setMessage(tr('静态图片已加载，可以开始映射', 'Reference image loaded. Ready to map.'));
  }, [resetImageView, tr]);

  const captureVideoFrame = React.useCallback(async () => {
    const video = videoRef.current;
    if (!video || !projectDir || !video.videoWidth || !video.videoHeight) return;
    setActiveViewTab('mapped');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const response = await ipcClient.saveGazeMappingScreenshot({ projectDir, dataUrl: canvas.toDataURL('image/png') });
    if (!response.ok || !response.path) {
      setMessage(translateBackendMessage(response.message, '视频截图保存失败', 'Failed to save video snapshot'));
      return;
    }
    setResult(null);
    setOutputPath('');
    setImageFile({ path: response.path, url: response.url || null, name: response.name || tr('视频截图.png', 'Video snapshot.png') });
    setMessage(tr('当前视频画面已保存为静态图片', 'Current video frame saved as a reference image'));
  }, [projectDir, tr, translateBackendMessage]);

  const handleRecordChange = React.useCallback(async (recordId: string, request = ++recordSelectionRequestRef.current) => {
    setSelectedRecordId(recordId);
    setResult(null);
    setOutputPath('');
    setVideoFile(null);
    setGazeFile(null);
    setGazePoints([]);
    gazeWindowRequestKeyRef.current = '';
    gazeWindowRangeRef.current = null;
    setCurrentTimeMs(0);
    setDuration(0);
    setIsPlaying(false);
    setActiveViewTab('video');
    setSelectedPointId(null);
    setIsManualCalibrating(false);
    setIsTrajectoryPlaybackMode(false);
    setIsPointReviewMode(false);
    lastReviewPointIdRef.current = null;
    setMessage('');
    const record = records.find((item) => item.id === recordId) || null;
    if (!record) return;
    let videoUrl = record.mp4Url || null;
    if (!videoUrl && record.mp4Path && projectDir) {
      const response = await ipcClient.getRecordVideoUrl({
        projectDir,
        name: record.name,
        recordPath: record.mp4Path,
      });
      if (response.ok) videoUrl = response.url;
    }
    if (request !== recordSelectionRequestRef.current) return;
    setVideoFile(record.mp4Path ? { path: record.mp4Path, url: videoUrl, name: record.name } : null);
    setGazeFile(record.csvPath ? { path: record.csvPath, url: null, name: record.csvPath.split(/[\\/]/).pop() || tr('记录数据.csv', 'Record data.csv') } : null);
    if (record.videoWidth && record.videoHeight) {
      setVideoSize({ width: record.videoWidth, height: record.videoHeight });
    }
    if (record.csvPath) await loadGazePoints(record.csvPath, record, 0);
  }, [loadGazePoints, projectDir, records, tr]);

  const loadMappingRecord = React.useCallback(async (summary: MappingRecordEntry) => {
    const request = ++recordSelectionRequestRef.current;
    setMessage(tr('正在加载映射记录...', 'Loading mapping record…'));
    let entry: MappingRecordEntry;
    try {
      entry = await loadCompleteMappingRecord(projectDir, summary);
    } catch (error) {
      if (request === recordSelectionRequestRef.current) {
        setMessage(translateBackendMessage(error instanceof Error ? error.message : undefined, '加载映射记录失败', 'Failed to load mapping record'));
      }
      return;
    }
    if (request !== recordSelectionRequestRef.current) return;
    const sourceRecord = records.find((record) => record.id === entry.result.recordId)
      || records.find((record) => record.mp4Path && record.mp4Path.split(/[\\/]/).pop() === entry.result.video.name)
      || records.find((record) => getDisplayRecordName(record) === entry.result.recordName)
      || records.find((record) => record.name === entry.result.video.name.replace(/\.[^.]+$/, ''));
    if (sourceRecord) {
      await handleRecordChange(sourceRecord.id, request);
      if (request !== recordSelectionRequestRef.current) return;
    } else {
      setSelectedRecordId('');
      setVideoFile(null);
      setGazeFile(null);
      setGazePoints([]);
      gazeWindowRequestKeyRef.current = '';
      gazeWindowRangeRef.current = null;
      if (entry.result.videoPath && entry.result.videoUrl) {
        setVideoFile({
          path: entry.result.videoPath,
          url: entry.result.videoUrl,
          name: entry.result.video.name || entry.result.videoPath.split(/[\\/]/).pop() || tr('记录视频', 'Record video'),
        });
      }
      setVideoSize({ width: entry.result.video.width || 1280, height: entry.result.video.height || 720 });
      setCurrentTimeMs(0);
      setDuration(0);
      setIsPlaying(false);
    }
    setMappingRecords((current) => current.map((item) => item.outputPath === entry.outputPath ? entry : item));
    setResult(entry.result);
    setOutputPath(entry.outputPath);
    if (entry.result.imagePath) {
      setImageFile({
        path: entry.result.imagePath,
        url: entry.result.imageUrl || null,
        name: entry.result.imageRef || entry.result.imagePath.split(/[\\/]/).pop() || tr('映射图片', 'Mapping image'),
      });
    }
    setSelectedPointId(null);
    setIsManualCalibrating(false);
    setActiveViewTab('mapped');
    setMessage(tr('映射记录已加载', 'Mapping record loaded'));
  }, [handleRecordChange, projectDir, records, tr, translateBackendMessage]);

  const runMapping = React.useCallback(async () => {
    if (!videoFile?.path || !imageFile?.path || !gazeFile?.path) {
      setMessage(tr('请选择包含视频和眼动数据的记录，并上传静态图片', 'Select a record containing video and eye-tracking data, then upload a reference image'));
      return;
    }
    if (!projectDir) {
      setMessage(tr('当前工程目录不可用', 'The current project directory is unavailable'));
      return;
    }
    setIsMapping(true);
    setResult(null);
    setOutputPath('');
    setMessage(tr('正在提取关键帧特征并计算单应性矩阵…', 'Extracting keyframe features and calculating homography…'));
    try {
      const points = await loadAllGazePoints(gazeFile.path, selectedRecord);
      if (points.length === 0) {
        setMessage(tr('没有可用于映射的有效注视点', 'No valid fixation points are available for mapping'));
        return;
      }
      const response = await ipcClient.runGazeMapping({
        projectDir,
        videoPath: videoFile.path,
        imagePath: imageFile.path,
        gazePoints: points.map((point, index) => ({
          x: point.x,
          y: point.y,
          timestamp: point.timestamp,
          weight: point.weight,
          durationMs: point.fixationDurationMs ?? point.weight,
          id: point.id ?? index,
        })),
        keyframeIntervalFrames: MAPPING_KEYFRAME_INTERVAL_FRAMES,
        recordId: selectedRecord?.id,
        recordName: selectedRecord ? getDisplayRecordName(selectedRecord) : videoFile.name,
      });
      if (!response.ok) {
        setMessage(translateBackendMessage(response.message, '映射处理失败', 'Mapping failed'));
        return;
      }
      setResult(response.result);
      setSelectedPointId(null);
      setIsManualCalibrating(false);
      setIsTrajectoryPlaybackMode(false);
      setIsPointReviewMode(false);
      lastReviewPointIdRef.current = null;
      setOutputPath(response.outputPath);
      setActiveViewTab('mapped');
      const rate = Math.round(response.result.summary.mappingRate * 100);
      setMessage(tr(`映射完成：${response.result.summary.mappedPoints.toLocaleString()} 个点，成功率 ${rate}%`, `Mapping complete: ${response.result.summary.mappedPoints.toLocaleString()} points, ${rate}% success rate`));
      void refreshMappingRecords();
    } finally {
      setIsMapping(false);
    }
  }, [gazeFile?.path, imageFile?.path, loadAllGazePoints, projectDir, refreshMappingRecords, selectedRecord, tr, translateBackendMessage, videoFile?.name, videoFile?.path]);

  const handleExportImage = React.useCallback(async () => {
    if (isExportingImage || !result) return;
    const image = imageRef.current;
    if (!image) {
      window.alert(tr('静态图片尚未准备完成', 'The reference image is not ready yet'));
      return;
    }
    setIsExportingImage(true);
    try {
      if (!image.complete || !image.naturalWidth) await image.decode();
      const width = Math.max(1, Math.round(result.resolution.width));
      const height = Math.max(1, Math.round(result.resolution.height));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error(tr('无法创建图片画布', 'Unable to create the image canvas'));
      context.drawImage(image, 0, 0, width, height);
      const exportPoints = result.gazeData.filter((point) => isMappingPointVisible(point, confidenceThreshold));
      drawMappedTrajectory(context, exportPoints, {
        width,
        height,
        offsetX: 0,
        offsetY: 0,
        scale: 1,
        color: trajectoryColor,
        lineWidth,
        pointRadius,
      });
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error(tr('无法生成 PNG 图片', 'Unable to generate the PNG image'));
      const safeRecordName = (selectedRecord?.name || tr('映射轨迹', 'Mapped gaze path')).replace(/[\\/:*?"<>|]/g, '-');
      const defaultName = `${safeRecordName}-${tr('映射轨迹', 'mapped-gaze-path')}-${Date.now()}.png`;
      if (ipcClient.isAvailable()) {
        const content = new Uint8Array(await blob.arrayBuffer());
        const response = await ipcClient.exportImageFast({ content, defaultName });
        if (!response.ok) {
          const detail = 'message' in response ? response.message : '';
          if (!detail?.includes('已取消') && !detail?.toLowerCase().includes('cancel')) window.alert(translateBackendMessage(detail, '导出图片失败', 'Failed to export image'));
          return;
        }
        window.alert(tr('导出成功', 'Export successful'));
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = defaultName;
      link.click();
      URL.revokeObjectURL(url);
      window.alert(tr('导出成功', 'Export successful'));
    } catch (error) {
      console.error('[MappingPage] Export mapped image failed:', error);
      window.alert(error instanceof Error ? tr(`导出图片失败：${error.message}`, `Failed to export image: ${error.message}`) : tr('导出图片失败', 'Failed to export image'));
    } finally {
      setIsExportingImage(false);
    }
  }, [confidenceThreshold, isExportingImage, lineWidth, pointRadius, result, selectedRecord?.name, tr, trajectoryColor, translateBackendMessage]);

  const downloadMappingRecord = React.useCallback(async (summary: MappingRecordEntry) => {
    if (exportingRecordPath) return;
    setExportingRecordPath(summary.outputPath);
    try {
      const entry = await loadCompleteMappingRecord(projectDir, summary);
      if (!entry.result.imageUrl) throw new Error(tr('静态图片尚未准备完成', 'The reference image is not ready yet'));
      const image = new Image();
      image.src = entry.result.imageUrl;
      await image.decode();
      const width = Math.max(1, Math.round(entry.result.resolution.width));
      const height = Math.max(1, Math.round(entry.result.resolution.height));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error(tr('无法创建图片画布', 'Unable to create the image canvas'));
      context.drawImage(image, 0, 0, width, height);
      const filteredPoints = entry.result.gazeData.filter((point) => isMappingPointVisible(point, confidenceThreshold));
      drawMappedTrajectory(context, filteredPoints, {
        width,
        height,
        offsetX: 0,
        offsetY: 0,
        scale: 1,
        color: trajectoryColor,
        lineWidth,
        pointRadius,
      });
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error(tr('无法生成 PNG 图片', 'Unable to generate the PNG image'));
      const safeName = (entry.result.recordName || entry.result.video.name || tr('映射轨迹', 'Mapped gaze path')).replace(/[\\/:*?"<>|]/g, '-');
      const content = new Uint8Array(await blob.arrayBuffer());
      const response = await ipcClient.exportImageFast({ content, defaultName: `${safeName}-${tr('映射轨迹', 'mapped-gaze-path')}.png` });
      if (!response.ok) {
        const detail = 'message' in response ? response.message : '';
        if (!detail?.includes('已取消') && !detail?.toLowerCase().includes('cancel')) window.alert(translateBackendMessage(detail, '下载图片失败', 'Failed to download image'));
      }
    } catch (error) {
      window.alert(error instanceof Error ? tr(`下载图片失败：${error.message}`, `Failed to download image: ${error.message}`) : tr('下载图片失败', 'Failed to download image'));
    } finally {
      setExportingRecordPath('');
    }
  }, [confidenceThreshold, exportingRecordPath, lineWidth, pointRadius, projectDir, tr, trajectoryColor, translateBackendMessage]);

  const deleteMappingRecord = React.useCallback(async (entry: { outputPath: string; result: GazeMappingResultData }) => {
    if (!projectDir || deletingRecordPath) return;
    setPendingDeleteRecord(null);
    setDeletingRecordPath(entry.outputPath);
    try {
      const response = await ipcClient.deleteGazeMappingRecord({ projectDir, outputPath: entry.outputPath });
      if (!response.ok) {
        window.alert(translateBackendMessage(response.message, '删除映射记录失败', 'Failed to delete mapping record'));
        return;
      }
      if (outputPath === entry.outputPath) {
        setResult(null);
        setOutputPath('');
      }
      await refreshMappingRecords();
    } finally {
      setDeletingRecordPath('');
    }
  }, [deletingRecordPath, outputPath, projectDir, refreshMappingRecords, tr, translateBackendMessage]);

  const seekTo = React.useCallback((seconds: number) => {
    const video = videoRef.current;
    const safeTime = clamp(seconds, 0, Math.max(0, duration));
    if (video) {
      try {
        video.currentTime = safeTime;
      } catch {
      }
    }
    setCurrentTimeMs(safeTime * 1000);
  }, [duration]);

  const seekBy = React.useCallback((seconds: number) => {
    seekTo((videoRef.current?.currentTime || currentTime) + seconds);
  }, [currentTime, seekTo]);

  const togglePlay = React.useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) {
      if (video.ended) seekTo(0);
      setIsTrajectoryPlaybackMode(true);
      if (isPointReviewMode && currentMappedPoint && result) {
        lastReviewPointIdRef.current = pointKey(currentMappedPoint, result.gazeData.indexOf(currentMappedPoint));
      }
      void video.play().catch(() => setIsPlaying(false));
      return;
    }
    video.pause();
  }, [currentMappedPoint, isPointReviewMode, pointKey, result, seekTo]);

  const handleProgressClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    seekTo(((event.clientX - rect.left) / Math.max(1, rect.width)) * duration);
  }, [duration, seekTo]);

  React.useEffect(() => {
    const imageStage = imageStageRef.current;
    const videoStage = videoStageRef.current;
    if (!imageStage && !videoStage) return;
    const observer = new ResizeObserver(() => {
      forceCanvasLayout();
      if (videoStage) setVideoStageSize({ width: videoStage.clientWidth, height: videoStage.clientHeight });
      if (imageStage) setImageStageSize({ width: imageStage.clientWidth, height: imageStage.clientHeight });
    });
    if (imageStage) observer.observe(imageStage);
    if (videoStage) observer.observe(videoStage);
    return () => observer.disconnect();
  }, []);

  React.useLayoutEffect(() => {
    const canvas = trajectoryCanvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image || !result || !image.naturalWidth || !image.naturalHeight) return;
    const width = Math.max(1, image.clientWidth);
    const height = Math.max(1, image.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const scale = Math.min(width / result.resolution.width, height / result.resolution.height);
    const drawWidth = result.resolution.width * scale;
    const drawHeight = result.resolution.height * scale;
    const offsetX = (width - drawWidth) / 2;
    const offsetY = (height - drawHeight) / 2;
    const visiblePoints = result.gazeData.filter((point) => {
      if (!isMappingPointVisible(point, confidenceThreshold)) return false;
      return !isTrajectoryPlaybackMode || point.timestampMs <= currentTimeMs;
    });
    drawMappedTrajectory(context, visiblePoints, {
      width: drawWidth,
      height: drawHeight,
      offsetX,
      offsetY,
      scale,
      color: trajectoryColor,
      lineWidth,
      pointRadius,
    });
    const playbackPoint = isTrajectoryPlaybackMode ? currentMappedPoint : null;
    const selectedIndex = playbackPoint
      ? result.gazeData.indexOf(playbackPoint)
      : result.gazeData.findIndex((point, index) => pointKey(point, index) === selectedPointId);
    const selected = selectedIndex >= 0 ? result.gazeData[selectedIndex] : null;
    if (selected && visiblePoints.includes(selected)) {
      context.save();
      context.beginPath();
      context.arc(offsetX + selected.x * scale, offsetY + selected.y * scale, Math.max(7, pointRadius + 5), 0, Math.PI * 2);
      context.strokeStyle = getComputedStyle(image).getPropertyValue('--app-text').trim() || '#111827';
      context.lineWidth = 2.5;
      context.stroke();
      context.restore();
    }
  }, [confidenceThreshold, currentMappedPoint, currentTimeMs, imageStageSize, imageZoom, isTrajectoryPlaybackMode, lineWidth, pointKey, pointRadius, result, selectedPointId, trajectoryColor]);

  const imageDisplaySize = React.useMemo(() => {
    if (!imageNaturalSize.width || !imageNaturalSize.height || !imageStageSize.width || !imageStageSize.height) return null;
    const fitScale = Math.min(
      imageStageSize.width / imageNaturalSize.width,
      imageStageSize.height / imageNaturalSize.height,
    );
    return {
      width: Math.max(1, imageNaturalSize.width * fitScale * imageZoom),
      height: Math.max(1, imageNaturalSize.height * fitScale * imageZoom),
    };
  }, [imageNaturalSize.height, imageNaturalSize.width, imageStageSize.height, imageStageSize.width, imageZoom]);

  const sourcePoint = React.useMemo(() => {
    return findClosestPointByTime(gazePoints, currentTimeMs);
  }, [currentTimeMs, gazePoints]);
  const sourcePointPosition = React.useMemo(() => {
    if (!sourcePoint || videoStageSize.width <= 0 || videoStageSize.height <= 0) return null;
    const scale = Math.min(videoStageSize.width / videoSize.width, videoStageSize.height / videoSize.height);
    const width = videoSize.width * scale;
    const height = videoSize.height * scale;
    return {
      left: (videoStageSize.width - width) / 2 + sourcePoint.x * width,
      top: (videoStageSize.height - height) / 2 + sourcePoint.y * height,
    };
  }, [sourcePoint, videoSize.height, videoSize.width, videoStageSize.height, videoStageSize.width]);

  const mappedPointTrack = React.useMemo(() => {
    if (!result) return null;
    const points = availableMappedPoints;
    const selectedPoint = result.gazeData.find((point, index) => pointKey(point, index) === selectedPointId);
    return {
      label: tr('映射注视点', 'Mapped fixation points'),
      timestamps: points.map((point) => Math.max(0, point.timestampMs - Math.max(0, Number(point.durationMs || 0))) / 1000),
      durations: points.map((point) => Math.max(0, Number(point.durationMs || 0)) / 1000),
      color: trajectoryColor,
      colors: points.map((point) => point.manualCalibrated === true
        ? MANUALLY_CALIBRATED_POINT_COLOR
        : UNCALIBRATED_POINT_COLOR),
      selectedTimestamp: selectedPoint ? selectedPoint.timestampMs / 1000 : null,
      onPointClick: (clickedTime: number) => {
        if (points.length === 0) return;
        const clickedMs = clickedTime * 1000;
        const nearest = findClosestMappedPointByTime(points, clickedMs);
        if (!nearest) return;
        const index = result.gazeData.indexOf(nearest);
        setSelectedPointId(pointKey(nearest, index));
        setActiveViewTab('mapped');
        seekTo(nearest.timestampMs / 1000);
      },
    };
  }, [availableMappedPoints, pointKey, result, seekTo, selectedPointId, tr, trajectoryColor]);

  const selectedMappedPoint = React.useMemo(() => {
    if (!result || selectedPointId === null) return null;
    return result.gazeData.find((point, index) => pointKey(point, index) === selectedPointId) || null;
  }, [pointKey, result, selectedPointId]);

  const stepMappedPoint = React.useCallback((direction: -1 | 1) => {
    if (!result || availableMappedPoints.length === 0) return;
    const selectedIndex = selectedMappedPoint
      ? availableMappedPoints.indexOf(selectedMappedPoint)
      : availableMappedPoints.findIndex((point) => point.timestampMs >= currentTimeMs);
    const baseIndex = selectedIndex >= 0 ? selectedIndex : direction > 0 ? -1 : availableMappedPoints.length;
    const nextIndex = clamp(baseIndex + direction, 0, availableMappedPoints.length - 1);
    const point = availableMappedPoints[nextIndex];
    const sourceIndex = result.gazeData.indexOf(point);
    const key = pointKey(point, sourceIndex);
    videoRef.current?.pause();
    setSelectedPointId(key);
    setActiveViewTab('mapped');
    setIsTrajectoryPlaybackMode(true);
    lastReviewPointIdRef.current = key;
    seekTo(point.timestampMs / 1000);
  }, [availableMappedPoints, currentTimeMs, pointKey, result, seekTo, selectedMappedPoint]);

  const calibrateSelectedPoint = React.useCallback(async (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isManualCalibrating || selectedPointId === null || !result) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = Math.min(rect.width / result.resolution.width, rect.height / result.resolution.height);
    const drawWidth = result.resolution.width * scale;
    const drawHeight = result.resolution.height * scale;
    const offsetX = (rect.width - drawWidth) / 2;
    const offsetY = (rect.height - drawHeight) / 2;
    const localX = event.clientX - rect.left - offsetX;
    const localY = event.clientY - rect.top - offsetY;
    if (localX < 0 || localY < 0 || localX > drawWidth || localY > drawHeight) return;
    const calibratedX = localX / scale;
    const calibratedY = localY / scale;
    const selectedIndex = result.gazeData.findIndex((point, index) => pointKey(point, index) === selectedPointId);
    if (selectedIndex < 0) return;
    const selectedPoint = result.gazeData[selectedIndex];
    setIsUpdatingPoint(true);
    if (projectDir && outputPath) {
      const response = await ipcClient.updateGazeMappingPoint({
        projectDir,
        outputPath,
        action: 'calibrate',
        pointIndex: selectedIndex,
        sourceId: selectedPoint.sourceId,
        x: calibratedX,
        y: calibratedY,
      });
      if (!response.ok) {
        setIsUpdatingPoint(false);
        setMessage(translateBackendMessage(response.message, '手动校准保存失败', 'Manual calibration could not be saved'));
        return;
      }
    }
    const calibratedAt = new Date().toISOString();
    const applyCalibration = (point: GazeMappingResultData['gazeData'][number]) => ({
      ...point,
      originalX: Number.isFinite(Number(point.originalX)) ? point.originalX : point.x,
      originalY: Number.isFinite(Number(point.originalY)) ? point.originalY : point.y,
      x: calibratedX,
      y: calibratedY,
      manualCalibrated: true,
      calibratedAt,
    });
    setResult((current) => current ? {
      ...current,
      gazeData: current.gazeData.map((point, index) => (
        pointKey(point, index) === selectedPointId ? applyCalibration(point) : point
      )),
    } : current);
    setMappingRecords((current) => current.map((entry) => entry.outputPath === outputPath
      ? {
          ...entry,
          result: {
            ...entry.result,
            gazeData: entry.result.gazeData.map((point, index) => (
              pointKey(point, index) === selectedPointId ? applyCalibration(point) : point
            )),
          },
        }
      : entry));
    setIsManualCalibrating(false);
    setIsUpdatingPoint(false);
    setMessage(tr('已完成并保存当前映射点的手动校准', 'The current mapped point has been manually calibrated and saved'));
  }, [isManualCalibrating, outputPath, pointKey, projectDir, result, selectedPointId, tr, translateBackendMessage]);

  const setPointDeleted = React.useCallback(async (
    pointId: string,
    deleted: boolean,
  ) => {
    if (!result || !projectDir || !outputPath || isUpdatingPoint) return;
    const pointIndex = result.gazeData.findIndex((point, index) => pointKey(point, index) === pointId);
    if (pointIndex < 0) return;
    const point = result.gazeData[pointIndex];
    setIsUpdatingPoint(true);
    try {
      const response = await ipcClient.updateGazeMappingPoint({
        projectDir,
        outputPath,
        action: 'set-deleted',
        pointIndex,
        sourceId: point.sourceId,
        deleted,
      });
      if (!response.ok) {
        setMessage(translateBackendMessage(
          response.message,
          deleted ? '移除映射点失败' : '恢复映射点失败',
          deleted ? 'Failed to remove the mapped point' : 'Failed to restore the mapped point',
        ));
        return;
      }
      const deletedAt = deleted ? new Date().toISOString() : undefined;
      const updatePoints = (points: GazeMappingResultData['gazeData']) => points.map((item, index) => {
        if (pointKey(item, index) !== pointId) return item;
        const updated = { ...item, deleted, deletedAt };
        if (!deleted) delete updated.deletedAt;
        return updated;
      });
      setResult((current) => current ? { ...current, gazeData: updatePoints(current.gazeData) } : current);
      setMappingRecords((current) => current.map((entry) => entry.outputPath === outputPath
        ? { ...entry, result: { ...entry.result, gazeData: updatePoints(entry.result.gazeData) } }
        : entry));
      setIsManualCalibrating(false);
      if (deleted) setSelectedPointId(null);
      setMessage(deleted
        ? tr('已移除并保存当前映射点', 'The mapped point was removed and saved')
        : tr('已恢复并保存当前映射点', 'The mapped point was restored and saved'));
    } finally {
      setIsUpdatingPoint(false);
    }
  }, [isUpdatingPoint, outputPath, pointKey, projectDir, result, tr, translateBackendMessage]);

  const removeSelectedPoint = React.useCallback(() => {
    if (selectedPointId === null) return;
    void setPointDeleted(selectedPointId, true);
  }, [selectedPointId, setPointDeleted]);

  const restoreAllDeletedPoints = React.useCallback(async () => {
    if (!result || !projectDir || !outputPath || deletedPointCount === 0 || isUpdatingPoint) return;
    setIsUpdatingPoint(true);
    try {
      const response = await ipcClient.updateGazeMappingPoint({
        projectDir,
        outputPath,
        action: 'restore-all-deleted',
      });
      if (!response.ok) {
        setMessage(translateBackendMessage(response.message, '恢复全部映射点失败', 'Failed to restore all mapped points'));
        return;
      }
      const restorePoints = (points: GazeMappingResultData['gazeData']) => points.map((point) => {
        const restored = { ...point, deleted: false };
        delete restored.deletedAt;
        return restored;
      });
      setResult((current) => current ? { ...current, gazeData: restorePoints(current.gazeData) } : current);
      setMappingRecords((current) => current.map((entry) => entry.outputPath === outputPath
        ? { ...entry, result: { ...entry.result, gazeData: restorePoints(entry.result.gazeData) } }
        : entry));
      setMessage(tr(`已恢复 ${response.restoredCount ?? deletedPointCount} 个映射点`, `Restored ${response.restoredCount ?? deletedPointCount} mapped points`));
    } finally {
      setIsUpdatingPoint(false);
    }
  }, [deletedPointCount, isUpdatingPoint, outputPath, projectDir, result, tr, translateBackendMessage]);

  const ready = Boolean(videoFile?.path && imageFile?.path && gazeFile?.path && gazePoints.length > 0);

  return (
    <div data-i18n-skip="true" className="flex h-full gap-3 overflow-hidden">
      <div className="flex-1 min-w-0 min-h-0 flex flex-col rounded-2xl overflow-hidden border" style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface)' }}>
        <div className="h-12 shrink-0 border-b flex items-center justify-center gap-8 text-xs font-bold" style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface-2)', color: 'var(--app-muted)' }}>
          <button
            type="button"
            onClick={() => {
              setActiveViewTab('video');
              setIsPointReviewMode(false);
              lastReviewPointIdRef.current = null;
              const video = videoRef.current;
              if (video) {
                setDuration(Number.isFinite(video.duration) ? video.duration : 0);
                setCurrentTimeMs((video.currentTime || 0) * 1000);
              }
            }}
            className="mrt-button-tab px-4 h-full flex items-center gap-2 border-b-2 transition-colors"
            style={{ borderColor: activeViewTab === 'video' ? 'var(--app-primary)' : 'transparent', color: activeViewTab === 'video' ? 'var(--app-primary)' : undefined }}
          >
            <Video size={14} />{tr('记录视频', 'Record video')}
          </button>
          <button
            type="button"
            onClick={() => setActiveViewTab('mapped')}
            className="mrt-button-tab px-4 h-full flex items-center gap-2 border-b-2 transition-colors"
            style={{ borderColor: activeViewTab === 'mapped' ? 'var(--app-primary)' : 'transparent', color: activeViewTab === 'mapped' ? 'var(--app-primary)' : undefined }}
          >
            <Route size={14} />{tr('映射轨迹', 'Mapped gaze path')}
          </button>
          <button
            type="button"
            onClick={() => { videoRef.current?.pause(); setActiveViewTab('records'); void refreshMappingRecords(); }}
            className="mrt-button-tab px-4 h-full flex items-center gap-2 border-b-2 transition-colors"
            style={{ borderColor: activeViewTab === 'records' ? 'var(--app-primary)' : 'transparent', color: activeViewTab === 'records' ? 'var(--app-primary)' : undefined }}
          >
            <Database size={14} />{tr('映射记录', 'Mapping records')}
          </button>
        </div>

        <div className="flex-1 min-h-0 relative overflow-hidden" style={{ backgroundColor: 'var(--app-bg)' }}>
          <div
            ref={videoStageRef}
            className={`absolute grid place-items-center overflow-hidden transition-[opacity,width,height] duration-200 ${
              activeViewTab === 'video'
                ? 'inset-0 z-20'
                : activeViewTab === 'mapped'
                  ? 'left-0 top-0 z-40 w-[32%] min-w-[220px] max-w-[360px] aspect-video border shadow-xl cursor-move touch-none'
                  : 'inset-0 opacity-0 pointer-events-none'
            }`}
            style={activeViewTab === 'mapped' ? { borderColor: 'var(--app-border)', backgroundColor: '#000', transform: `translate(${pipPosition.x}px, ${pipPosition.y}px)` } : undefined}
            onPointerDown={(event) => {
              if (activeViewTab !== 'mapped') return;
              const rect = event.currentTarget.getBoundingClientRect();
              pipDragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const drag = pipDragRef.current;
              if (!drag || drag.pointerId !== event.pointerId || activeViewTab !== 'mapped') return;
              const container = event.currentTarget.parentElement?.getBoundingClientRect();
              if (!container) return;
              setPipPosition({
                x: clamp(event.clientX - container.left - drag.offsetX, 0, Math.max(0, container.width - event.currentTarget.offsetWidth)),
                y: clamp(event.clientY - container.top - drag.offsetY, 0, Math.max(0, container.height - event.currentTarget.offsetHeight)),
              });
            }}
            onPointerUp={(event) => {
              if (pipDragRef.current?.pointerId === event.pointerId) pipDragRef.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
          >
            {videoFile?.url ? (
              <video
                ref={videoRef}
                src={videoFile.url}
                className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                onLoadedMetadata={(event) => {
                  const video = event.currentTarget;
                  setVideoSize({ width: video.videoWidth || 1280, height: video.videoHeight || 720 });
                  setDuration(Number.isFinite(video.duration) ? video.duration : 0);
                  setCurrentTimeMs((video.currentTime || 0) * 1000);
                }}
                onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
                onTimeUpdate={(event) => setCurrentTimeMs(event.currentTarget.currentTime * 1000)}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
              />
            ) : (
              <div className="text-center" style={{ color: 'var(--app-muted)' }}><Video size={36} className="mx-auto mb-3 opacity-40" /><p className="text-xs">{tr('请在右侧选择一条记录', 'Select a record on the right')}</p></div>
            )}
            {videoFile?.url && sourcePointPosition && (
              <div
                className="absolute w-5 h-5 rounded-full pointer-events-none -translate-x-1/2 -translate-y-1/2"
                style={{
                  left: sourcePointPosition.left,
                  top: sourcePointPosition.top,
                  backgroundColor: 'transparent',
                  border: `2px solid ${trajectoryColor}`,
                  boxShadow: `0 0 12px ${trajectoryColor}`,
                  opacity: 0.9,
                }}
              />
            )}
            {activeViewTab === 'mapped' && videoFile?.url && (
              <div className="absolute left-2 top-2 rounded px-2 py-1 text-[9px] font-bold text-white bg-black/65">{tr('原始视频 · 注视点', 'Source video · Fixation point')}</div>
            )}
          </div>

          <div
            ref={imageStageRef}
            className={`absolute inset-0 overflow-auto overscroll-contain transition-opacity ${activeViewTab === 'mapped' ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          >
            {imageFile?.url ? (
              <>
                <div className="min-w-full min-h-full flex items-center justify-center">
                  <div
                    className={`relative shrink-0 ${isManualCalibrating ? 'cursor-crosshair' : ''}`}
                    style={imageDisplaySize ? { width: imageDisplaySize.width, height: imageDisplaySize.height } : undefined}
                    onClick={calibrateSelectedPoint}
                  >
                    <img
                      ref={imageRef}
                      src={imageFile.url}
                      onLoad={(event) => {
                        setImageNaturalSize({
                          width: event.currentTarget.naturalWidth,
                          height: event.currentTarget.naturalHeight,
                        });
                        forceCanvasLayout();
                      }}
                      alt={tr('静态映射底图', 'Mapping reference image')}
                      className="block w-full h-full object-contain select-none"
                      draggable={false}
                    />
                    <canvas ref={trajectoryCanvasRef} className="absolute inset-0 pointer-events-none" />
                    {isManualCalibrating && (
                      <div className="absolute left-1/2 top-4 z-20 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1.5 text-[10px] font-bold text-white pointer-events-none">
                        {tr('请点击图片设置当前映射点', 'Click the image to set the current mapped point')}
                      </div>
                    )}
                  </div>
                </div>
                <div className="sticky bottom-4 z-30 ml-auto mr-4 flex w-fit items-center gap-1 rounded-full border p-1 shadow-lg" style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface)', color: 'var(--app-text)' }}>
                  <button
                    type="button"
                    title={tr('缩小图片', 'Zoom out')}
                    aria-label={tr('缩小图片', 'Zoom out')}
                    disabled={imageZoom <= MIN_IMAGE_ZOOM}
                    onClick={() => setImageZoom((value) => clamp(value - IMAGE_ZOOM_STEP, MIN_IMAGE_ZOOM, MAX_IMAGE_ZOOM))}
                    className="grid h-8 w-8 place-items-center rounded-full transition-colors hover:bg-black/5 disabled:opacity-35"
                  >
                    <ZoomOut size={15} />
                  </button>
                  <button
                    type="button"
                    title={tr('重置图片大小和位置', 'Reset image size and position')}
                    onClick={resetImageView}
                    className="h-8 min-w-14 rounded-full px-2 text-[10px] font-bold transition-colors hover:bg-black/5"
                  >
                    {Math.round(imageZoom * 100)}%
                  </button>
                  <button
                    type="button"
                    title={tr('放大图片', 'Zoom in')}
                    aria-label={tr('放大图片', 'Zoom in')}
                    disabled={imageZoom >= MAX_IMAGE_ZOOM}
                    onClick={() => setImageZoom((value) => clamp(value + IMAGE_ZOOM_STEP, MIN_IMAGE_ZOOM, MAX_IMAGE_ZOOM))}
                    className="grid h-8 w-8 place-items-center rounded-full transition-colors hover:bg-black/5 disabled:opacity-35"
                  >
                    <ZoomIn size={15} />
                  </button>
                </div>
                {!result && <div className="absolute bottom-4 rounded-full border px-3 py-1.5 text-[10px]" style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface)', color: 'var(--app-muted)' }}>{tr('开始映射后将在此显示轨迹', 'The mapped gaze path will appear here')}</div>}
              </>
            ) : (
              <div className="absolute inset-0 grid place-items-center">
                <div className="text-center" style={{ color: 'var(--app-muted)' }}>
                  <ImagePlus size={36} className="mx-auto mb-3 opacity-40" />
                  <p className="text-xs">{tr('请在右侧上传静态图片', 'Upload a reference image on the right')}</p>
                </div>
              </div>
            )}
          </div>

          <div className={`absolute inset-0 overflow-y-auto p-5 ${activeViewTab === 'records' ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
            {mappingRecords.length === 0 ? (
              <div className="h-full grid place-items-center text-xs" style={{ color: 'var(--app-muted)' }}>{tr('暂无映射记录', 'No mapping records')}</div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-6">
                {mappingRecords.map((entry) => (
                  <div
                    key={entry.outputPath}
                    onClick={() => void loadMappingRecord(entry)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') void loadMappingRecord(entry);
                    }}
                    className="group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border text-left transition-all"
                    style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface)' }}
                  >
                    <div className="aspect-video relative overflow-hidden rounded-t-xl" style={{ backgroundColor: 'var(--app-bg)' }}>
                      {entry.result.imageUrl && <img src={entry.result.imageUrl} alt={tr('映射记录底图', 'Mapping record image')} className="w-full h-full object-cover" />}
                      <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/40 opacity-0 transition-opacity pointer-events-none group-hover:opacity-100 group-focus-within:opacity-100">
                        <button
                          type="button"
                          title={tr('查看', 'View')}
                          onClick={(event) => { event.stopPropagation(); void loadMappingRecord(entry); }}
                          className="grid h-8 w-8 place-items-center rounded-full bg-white text-slate-700 transition-colors hover:bg-sky-50 hover:text-sky-600 pointer-events-auto"
                        >
                          <Eye size={14} />
                        </button>
                        <button
                          type="button"
                          title={tr('下载', 'Download')}
                          disabled={!!exportingRecordPath}
                          onClick={(event) => { event.stopPropagation(); void downloadMappingRecord(entry); }}
                          className="grid h-8 w-8 place-items-center rounded-full bg-white text-slate-700 transition-colors hover:bg-sky-50 hover:text-sky-600 disabled:opacity-50 pointer-events-auto"
                        >
                          {exportingRecordPath === entry.outputPath ? <LoaderCircle size={14} className="animate-spin" /> : <Download size={14} />}
                        </button>
                        <button
                          type="button"
                          title={tr('删除', 'Delete')}
                          disabled={!!deletingRecordPath}
                          onClick={(event) => { event.stopPropagation(); setPendingDeleteRecord(entry); }}
                          className="grid h-8 w-8 place-items-center rounded-full bg-white text-slate-700 transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 pointer-events-auto"
                        >
                          {deletingRecordPath === entry.outputPath ? <LoaderCircle size={14} className="animate-spin" /> : <Trash2 size={14} />}
                        </button>
                      </div>
                    </div>
                    <div className="p-3 space-y-1">
                      <div data-i18n-skip="true" className="text-sm font-medium truncate" style={{ color: 'var(--app-text)' }}>{entry.result.recordName || entry.result.video.name}</div>
                      <div className="flex items-center justify-between gap-2 text-[10px]" style={{ color: 'var(--app-muted)' }}>
                        <span className="truncate">{tr(`${entry.result.summary.mappedPoints.toLocaleString()} 个点`, `${entry.result.summary.mappedPoints.toLocaleString()} points`)} · {Math.round(entry.result.summary.mappingRate * 100)}%</span>
                        <span className="shrink-0">{entry.result.createdAt ? new Date(entry.result.createdAt).toLocaleDateString(language) : tr('历史映射', 'Previous mapping')}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {activeViewTab !== 'records' && (
        <div className="shrink-0 border-t px-4 py-3 text-[10px] flex flex-col gap-3" style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface)', color: 'var(--app-muted)' }}>
          <div className="relative h-4 w-full cursor-pointer group flex items-center" onClick={handleProgressClick}>
            <div className="absolute w-full h-1 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--app-track)' }}>
              <div className="h-full" style={{ width: `${duration > 0 ? clamp((currentTime / duration) * 100, 0, 100) : 0}%`, backgroundColor: 'var(--app-primary)' }} />
            </div>
            <div
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 shadow-sm z-20 group-hover:scale-125 transition-transform pointer-events-none"
              style={{ left: `${duration > 0 ? clamp((currentTime / duration) * 100, 0, 100) : 0}%`, borderColor: 'var(--app-primary)', backgroundColor: 'var(--app-surface)' }}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex-1 flex items-center justify-start gap-2">
              <button
                type="button"
                onClick={() => void handleExportImage()}
                disabled={!result || isExportingImage}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[10px] font-medium transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
                style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface-2)', color: 'var(--app-text)' }}
              >
                {isExportingImage ? <LoaderCircle size={12} className="animate-spin" /> : <Download size={12} />}
                <span>{isExportingImage ? tr('导出中...', 'Exporting…') : tr('导出图片', 'Export image')}</span>
              </button>
              {activeViewTab === 'video' && (
                <button
                  type="button"
                  onClick={() => void captureVideoFrame()}
                  disabled={!videoFile?.url}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[10px] font-medium transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
                  style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface-2)', color: 'var(--app-text)' }}
                >
                  <Camera size={12} />
                  <span>{tr('截取画面', 'Capture frame')}</span>
                </button>
              )}
              {result && (
                <>
                  <button
                    type="button"
                    onClick={() => stepMappedPoint(-1)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[10px] font-medium transition-colors"
                    style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface-2)', color: 'var(--app-text)' }}
                  >
                    {tr('上一个注视点', 'Previous fixation')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      lastReviewPointIdRef.current = null;
                      if (isPointReviewMode) setIsManualCalibrating(false);
                      setIsPointReviewMode(!isPointReviewMode);
                      setActiveViewTab('mapped');
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[10px] font-medium transition-colors"
                    style={{
                      borderColor: isPointReviewMode ? trajectoryColor : 'var(--app-border)',
                      backgroundColor: isPointReviewMode ? `color-mix(in srgb, ${trajectoryColor} 12%, var(--app-surface))` : 'var(--app-surface-2)',
                      color: 'var(--app-text)',
                    }}
                  >
                    {isPointReviewMode ? tr('逐点校验已开启', 'Point review on') : tr('开启逐点校验', 'Start point review')}
                  </button>
                  <button
                    type="button"
                    onClick={() => stepMappedPoint(1)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[10px] font-medium transition-colors"
                    style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface-2)', color: 'var(--app-text)' }}
                  >
                    {tr('下一个注视点', 'Next fixation')}
                  </button>
                </>
              )}
            </div>
            <div className="flex items-center justify-center gap-3">
              {[
                { title: tr('跳到开始', 'Jump to start'), icon: <SkipBack size={14} />, action: () => seekTo(0) },
                { title: tr('上一帧', 'Previous frame'), icon: <Rewind size={14} />, action: () => seekBy(-frameStep) },
                { title: isPlaying ? tr('暂停', 'Pause') : tr('播放', 'Play'), icon: isPlaying ? <Pause size={14} /> : <Play size={14} />, action: togglePlay },
                { title: tr('下一帧', 'Next frame'), icon: <FastForward size={14} />, action: () => seekBy(frameStep) },
                { title: tr('跳到结尾', 'Jump to end'), icon: <SkipForward size={14} />, action: () => seekTo(duration) },
              ].map((control) => (
                <button
                  key={control.title}
                  type="button"
                  title={control.title}
                  disabled={!videoFile?.url}
                  onClick={control.action}
                  className="w-8 h-8 rounded-full border flex items-center justify-center shadow-sm transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
                  style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface-2)', color: 'var(--app-text)' }}
                >
                  {control.icon}
                </button>
              ))}
            </div>
            <div className="flex-1 flex items-center justify-end gap-3 min-w-0">
              {result && currentMappedPoint && (
                <div className="min-w-0 rounded-full border px-3 py-1.5 text-[10px] truncate" style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface-2)', color: 'var(--app-text)' }}>
                  <span className="font-bold">
                    {tr('映射点', 'Mapped point')} {pointKey(currentMappedPoint, result.gazeData.indexOf(currentMappedPoint))}
                    {' · '}{tr('时长', 'Duration')} {Math.round(Number(currentMappedPoint.durationMs || 0))} ms
                  </span>
                </div>
              )}
              <div className="shrink-0 font-mono">{formatTime(currentTime)} / {formatTime(duration)}</div>
            </div>
          </div>
        </div>
        )}

        {activeViewTab !== 'records' && videoFile?.url && duration > 0 && mappedPointTrack && (
          <div data-i18n-skip="true">
            <TimelineAnalysis
              language={language}
              duration={duration}
              currentTime={currentTime}
              stimuli={[]}
              points={[]}
              showMarkTrack={false}
              showTriggerTrack={false}
              pointTrack={mappedPointTrack}
              allowRangeSelection={false}
              onSeek={seekTo}
            />
          </div>
        )}
      </div>

      <aside className="w-[300px] shrink-0 rounded-2xl border flex flex-col overflow-hidden" style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface)', color: 'var(--app-muted)' }}>
        <div className="p-4 border-b" style={{ borderColor: 'var(--app-border)' }}>
          <h2 className="text-xs font-bold tracking-wider flex items-center gap-2"><Settings size={15} />{tr('映射设置', 'Mapping settings')}</h2>
          <p className="text-[10px] mt-1" role="status" style={{ color: 'var(--app-muted)' }}>{message || tr('视频与眼动数据来自工程记录', 'Video and eye-tracking data come from project records')}</p>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="mb-3 space-y-3">
            <h3 className="text-xs font-bold tracking-widest">{tr('轨迹设置', 'Gaze path settings')}</h3>
            <label className="block space-y-1.5">
              <span className="flex justify-between text-[10px]" style={{ color: 'var(--app-muted)' }}><span>{tr('置信度阈值', 'Confidence threshold')}</span><span style={{ color: 'var(--app-primary)' }}>{confidenceThreshold}%</span></span>
              <input type="range" min={0} max={100} step={1} value={confidenceThreshold} onChange={(event) => setConfidenceThreshold(Number(event.target.value))} className="mrt-slider cursor-pointer" />
              <span className="block text-[9px]" role="status" style={{ color: 'var(--app-muted)' }}>{result
                ? mappingVisibilityMessage(result.gazeData, confidenceThreshold, isEn)
                : tr('低于阈值的映射点不会显示或导出', 'Points below the threshold are hidden and excluded from export')}</span>
            </label>
            <label className="block space-y-1.5">
              <span className="flex justify-between text-[10px]" style={{ color: 'var(--app-muted)' }}><span>{tr('轨迹线宽', 'Path line width')}</span><span style={{ color: 'var(--app-primary)' }}>{lineWidth}px</span></span>
              <input type="range" min={1} max={8} step={0.5} value={lineWidth} onChange={(event) => setLineWidth(Number(event.target.value))} className="mrt-slider cursor-pointer" />
            </label>
            <label className="block space-y-1.5">
              <span className="flex justify-between text-[10px]" style={{ color: 'var(--app-muted)' }}><span>{tr('轨迹点大小', 'Point size')}</span><span style={{ color: 'var(--app-primary)' }}>{pointRadius}px</span></span>
              <input type="range" min={2} max={12} value={pointRadius} onChange={(event) => setPointRadius(Number(event.target.value))} className="mrt-slider cursor-pointer" />
            </label>
            <div className="flex items-center justify-between">
              <span className="text-[10px]" style={{ color: 'var(--app-muted)' }}>{tr('轨迹颜色', 'Path color')}</span>
              <div className="flex items-center gap-2">
                <input type="color" value={trajectoryColor} onChange={(event) => setTrajectoryColor(event.target.value)} className="w-7 h-7 rounded border-0 bg-transparent" />
                <button onClick={() => setTrajectoryColor('#ef4444')} title={tr('恢复默认红色', 'Restore default red')} aria-label={tr('恢复默认红色', 'Restore default red')} className="p-1.5 rounded-md border hover:text-sky-500" style={{ borderColor: 'var(--app-border)' }}><RotateCcw size={12} /></button>
              </div>
            </div>
            <div className="rounded-lg border px-3 py-2 text-[9px]" style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface-2)' }}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: UNCALIBRATED_POINT_COLOR }} />
                  {tr('未人工校准', 'Not manually calibrated')}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: MANUALLY_CALIBRATED_POINT_COLOR }} />
                  {tr('已人工校准', 'Manually calibrated')}
                </span>
              </div>
            </div>
          </div>

          <button
            onClick={() => void runMapping()}
            disabled={!ready || isMapping}
            className="w-full rounded-lg px-4 py-2.5 text-xs font-bold flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
            style={{ backgroundColor: 'var(--app-primary)', color: 'var(--app-primary-foreground)' }}
          >
            {isMapping ? <LoaderCircle size={15} className="animate-spin" /> : <Play size={14} fill="currentColor" />}
            {isMapping ? tr('正在映射', 'Mapping…') : tr('开始映射', 'Start mapping')}
          </button>

          <div className="mt-4 border-t pt-4 space-y-3" style={{ borderColor: 'var(--app-border)' }}>
            <h3 className="text-xs font-bold flex items-center gap-2 tracking-widest"><Database size={14} />{tr('数据源', 'Data source')}</h3>
            <button
              type="button"
              onClick={() => void chooseImage()}
              className="w-full rounded-lg border px-3 py-2 text-xs font-bold flex items-center justify-center gap-2 transition-colors hover:border-sky-500 hover:text-sky-500"
              style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface-2)' }}
            >
              <ImagePlus size={14} />{imageFile ? tr('更换静态图片', 'Replace reference image') : tr('上传静态图片', 'Upload reference image')}
            </button>
            {imageFile && <div className="truncate text-[10px]" style={{ color: 'var(--app-muted)' }}>{tr('底图：', 'Image: ')}{imageFile.name}</div>}

            {isPointReviewMode && selectedMappedPoint && selectedPointId !== null && (
              <div className="rounded-lg border p-3 space-y-3 text-[10px]" style={{ borderColor: trajectoryColor, backgroundColor: 'var(--app-surface-2)', color: 'var(--app-muted)' }}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold" style={{ color: 'var(--app-text)' }}>{tr('映射点校验', 'Mapped point review')}</span>
                  <span>{formatTime(selectedMappedPoint.timestampMs / 1000)}</span>
                </div>
                <div className="flex justify-between"><span>{tr('持续时间', 'Duration')}</span><span>{Math.round(Number(selectedMappedPoint.durationMs || 0))} ms</span></div>
                <div className="flex justify-between"><span>{tr('映射置信度', 'Mapping confidence')}</span><span>{Math.round(selectedMappedPoint.confidence * 100)}%</span></div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setIsManualCalibrating((value) => !value)}
                    disabled={isUpdatingPoint}
                    className="rounded-md border px-2 py-2 font-bold"
                    style={{
                      borderColor: isManualCalibrating ? trajectoryColor : 'var(--app-border)',
                      color: isManualCalibrating ? trajectoryColor : 'var(--app-text)',
                    }}
                  >
                    {isManualCalibrating ? tr('取消校准', 'Cancel calibration') : tr('手动校准', 'Manual calibration')}
                  </button>
                  <button
                    type="button"
                    onClick={removeSelectedPoint}
                    disabled={isUpdatingPoint}
                    className="rounded-md border px-2 py-2 font-bold text-red-500"
                    style={{ borderColor: 'color-mix(in srgb, #ef4444 45%, var(--app-border))' }}
                  >
                    {tr('移除此点', 'Remove point')}
                  </button>
                </div>
              </div>
            )}

            {result && deletedPointCount > 0 && (
              <div className="rounded-lg border p-3 space-y-2 text-[10px]" style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface-2)' }}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold" style={{ color: 'var(--app-text)' }}>
                    {tr(`已移除点（${deletedPointCount}）`, `Removed points (${deletedPointCount})`)}
                  </span>
                  <button
                    type="button"
                    disabled={isUpdatingPoint}
                    onClick={() => void restoreAllDeletedPoints()}
                    className="rounded-md border px-2 py-1 font-bold disabled:opacity-50"
                    style={{ borderColor: DELETED_POINT_COLOR, color: 'var(--app-text)' }}
                  >
                    {tr('全部恢复', 'Restore all')}
                  </button>
                </div>
                <div className="max-h-28 space-y-1 overflow-y-auto pr-1">
                  {result.gazeData.map((point, index) => {
                    if (point.deleted !== true) return null;
                    const id = pointKey(point, index);
                    return (
                      <div key={id} className="flex items-center justify-between gap-2 rounded border px-2 py-1.5" style={{ borderColor: 'var(--app-border)' }}>
                        <span className="min-w-0 truncate" style={{ color: 'var(--app-muted)' }}>
                          {tr('映射点', 'Mapped point')} {id} · {formatTime(point.timestampMs / 1000)}
                        </span>
                        <button
                          type="button"
                          disabled={isUpdatingPoint}
                          onClick={() => void setPointDeleted(id, false)}
                          className="shrink-0 font-bold disabled:opacity-50"
                          style={{ color: 'var(--app-primary)' }}
                        >
                          {tr('恢复', 'Restore')}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="pt-1 space-y-2">
              <h4 className="text-xs font-bold flex items-center gap-1.5"><Monitor size={14} />{tr('记录列表', 'Record list')}</h4>
              {records.length === 0 ? (
                <div className="text-[11px]" style={{ color: 'var(--app-muted)' }}>{tr('暂无记录，请先在录制模块生成数据', 'No records yet. Create data in the Recording module first.')}</div>
              ) : (
                <div
                  className="max-h-64 overflow-y-auto overscroll-contain pr-1"
                  onWheel={(event) => event.stopPropagation()}
                >
                  <div className="space-y-1">
                  {records.map((record) => {
                    const active = selectedRecordId === record.id;
                    return (
                      <button
                        key={record.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => {
                          if (!active) void handleRecordChange(record.id);
                        }}
                        className="w-full flex items-center gap-3 p-2 rounded-lg border text-left transition-all"
                        style={{
                          borderColor: active ? 'color-mix(in srgb, var(--app-primary) 34%, var(--app-border))' : 'transparent',
                          backgroundColor: active ? 'color-mix(in srgb, var(--app-primary) 10%, var(--app-surface))' : 'var(--app-surface)',
                        }}
                      >
                        <span className={`w-3 h-3 shrink-0 rounded bg-emerald-500 transition-opacity ${active ? 'opacity-100' : 'opacity-30'}`} />
                        <span className="flex-1 min-w-0">
                          <span data-i18n-skip="true" className="block text-[11px] font-medium truncate" style={{ color: 'var(--app-text)' }}>{getDisplayRecordName(record)}</span>
                          <span className="block text-[9px]" style={{ color: 'var(--app-muted)' }}>{record.duration}</span>
                        </span>
                        <input
                          type="checkbox"
                          checked={active}
                          readOnly
                          tabIndex={-1}
                          className="w-4 h-4 rounded pointer-events-none"
                          style={{ accentColor: 'var(--app-primary)' }}
                        />
                      </button>
                    );
                  })}
                  </div>
                </div>
              )}
            </div>

          </div>
        </div>
      </aside>
      <Modal
        isOpen={Boolean(pendingDeleteRecord)}
        onClose={() => setPendingDeleteRecord(null)}
        title={tr('删除映射记录', 'Delete mapping record')}
        maxWidthClassName="max-w-md"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => setPendingDeleteRecord(null)}
              className={btnSecondary}
            >
              {tr('取消', 'Cancel')}
            </button>
            <button
              type="button"
              onClick={() => {
                if (pendingDeleteRecord) void deleteMappingRecord(pendingDeleteRecord);
              }}
              className={btnDanger}
            >
              {tr('删除', 'Delete')}
            </button>
          </div>
        }
      >
        <div className="text-sm leading-relaxed text-slate-600 break-words">
          {pendingDeleteRecord
            ? tr(
              `确认删除映射记录“${pendingDeleteRecord.result.recordName || pendingDeleteRecord.result.video.name}”及其映射图片吗？原始视频不会被删除。`,
              `Delete mapping record "${pendingDeleteRecord.result.recordName || pendingDeleteRecord.result.video.name}" and its mapping image? The source video will not be deleted.`,
            )
            : ''}
        </div>
      </Modal>
    </div>
  );
};

export default MappingPage;
