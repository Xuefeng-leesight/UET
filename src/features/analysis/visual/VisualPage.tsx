import Switch from '@/shared/ui/Switch';
import React from 'react';
import { BarChart2, FastForward, LoaderCircle, Monitor, Mountain, Pause, Play, RefreshCw, Rewind, Route, SkipBack, SkipForward, Download } from 'lucide-react';
import type { RecordingRecord } from '@shared/contracts/domain/models';
import CustomSelect from '@/shared/ui/CustomSelect';
import { Modal } from '@/shared/ui/Modal';
import { btnDanger, btnSecondary } from '@/shared/ui/buttonClasses';
import SpinnerRing from '@/shared/ui/SpinnerRing';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import type { TimeSegment } from '@shared/domain/timeline';
import { normalizeTimeSegments, removeTimeSegment } from '@shared/domain/timeline';
import { resolveRecordingVideoStimulus } from '@shared/domain/recordingStimulus';
import {
  drawGazePaths,
  drawHeatmap,
  drawHeatmapPerspective,
  drawHoneycombCursor,
} from '@/features/analysis/visual/heatmapRendering';
import {
  DEFAULT_MOUNTAIN_SETTINGS,
  type MountainChartSettings,
  type MountainChartHandle,
} from '@/features/analysis/visual/mountainChartContract';
import { useTimeOffsetMs } from '@/features/analysis/time-offset/useTimeOffset';
import { filterBySegments, useFilteredData } from '@/features/records/useFilteredData';
import type { ExtendedStimulus, HeatmapPoint, CustomMarker } from '@/shared/types/mrt';
import { TimelineAnalysis } from '@/features/records/TimelineAnalysis';
import { getDisplayRecordName } from '@/features/records/domain/recordDisplayName';
import type { VideoExportStatus } from '@/features/export/domain/videoExportStatus';
import { useLanguage } from '@/app/i18n/useLanguage';
import { useTheme } from '@/app/theme/useTheme';
import { THEME_PREVIEWS } from '@/app/theme/theme';
import {
  adaptMappingResultToHeatmapPoints,
  type MappingRecordEntry,
} from '@/features/analysis/visual/mappingVisualization';
import {
  buildVisualTempWebmPath,
  normalizeVisualTimestampsToVideo,
  prepareVisualRecordPoints,
  resolveVisualRecordDurationSeconds,
  sanitizeVisualExportName,
} from '@/features/analysis/visual/visualDataModel';
import { VisualSettingsPanel } from '@/features/analysis/visual/VisualSettingsPanel';

const MountainChart = React.lazy(() => import('@/features/analysis/visual/MountainChart'));

const MULTI_RECORD_COLORS = ['#0ea5e9', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6'];

// 根据系统主题映射 Three.js 场景背景色
function getMountainBgColor(theme: string): string {
  return theme === 'dark' ? THEME_PREVIEWS.dark.bg : THEME_PREVIEWS['modern-light'].bg;
}

interface VisualPageProps {
  stimuli: ExtendedStimulus[];
  visualSelectedStimulusId: string | null;
  setVisualSelectedStimulusId: (id: string | null) => void;
  records: RecordingRecord[];
  selectedRecordId: string | null;
  setSelectedRecordId: (id: string | null) => void;
  visibleRecordIds: Set<string>;
  setVisibleRecordIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  toggleRecordVisibility: (id: string) => void;
  visualSubTab: 'heatmap' | 'gaze' | 'honeycomb' | 'mountain';
  setVisualSubTab: (tab: 'heatmap' | 'gaze' | 'honeycomb' | 'mountain') => void;
  heatmapLoadingRecordId: string | null;
  heatmapError: string | null;
  heatmapCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  gazeCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  currentHeatmapPoints: HeatmapPoint[];
  heatmapPointsByRecord: Record<string, HeatmapPoint[]>;
  heatmapSettings: { radius: number; opacity: number; intensity: number };
  setHeatmapSettings: React.Dispatch<React.SetStateAction<{ radius: number; opacity: number; intensity: number }>>;
  customMarkers?: CustomMarker[];
  projectDir?: string;
  projectDeviceType?: RecordingRecord['deviceType'];
  onRecordTimelineSegmentsChange?: (recordId: string, segments: TimeSegment[]) => void;
  onVideoExportStatusChange?: (status: VideoExportStatus | null) => void;
}

const VisualPage: React.FC<VisualPageProps> = ({
  stimuli,
  visualSelectedStimulusId,
  setVisualSelectedStimulusId,
  records,
  selectedRecordId,
  setSelectedRecordId,
  visibleRecordIds,
  setVisibleRecordIds,
  toggleRecordVisibility,
  visualSubTab,
  setVisualSubTab,
  heatmapLoadingRecordId,
  heatmapError,
  heatmapCanvasRef,
  gazeCanvasRef,
  currentHeatmapPoints,
  heatmapPointsByRecord,
  heatmapSettings,
  setHeatmapSettings,
  customMarkers = [],
  projectDir,
  projectDeviceType,
  onRecordTimelineSegmentsChange,
  onVideoExportStatusChange,
}) => {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const videoWrapRef = React.useRef<HTMLDivElement | null>(null);
  const mountainChartRef = React.useRef<MountainChartHandle | null>(null);
  const prevSubTabRef = React.useRef<'heatmap' | 'gaze' | 'honeycomb' | 'mountain'>(visualSubTab);
  const lastManualSeekRef = React.useRef<{ time: number; requestedAtMs: number } | null>(null);
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [visualCurrentTime, setVisualCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [videoSize, setVideoSize] = React.useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const { timeOffsetMs } = useTimeOffsetMs();
  const { language } = useLanguage();
  const { theme } = useTheme();
  const mountainBgColor = React.useMemo(() => getMountainBgColor(theme), [theme]);
  const isEn = language === 'en-US';
  const [heatmapPerspectiveEnabled, setHeatmapPerspectiveEnabled] = React.useState(false);
  
  // Custom time range from timeline
  const [customTimeRange, setCustomTimeRange] = React.useState<{ startTime: number; endTime: number } | null>(null);
  const [showMarkTrack, setShowMarkTrack] = React.useState(true);
  const [showTriggerTrack, setShowTriggerTrack] = React.useState(true);
  const [multiSelectEnabled, setMultiSelectEnabled] = React.useState(false);
  
  const handleTimeRangeChange = React.useCallback((startTime: number, endTime: number) => {
    setCustomTimeRange(prev => {
      // Avoid unnecessary updates if values haven't changed
      if (prev && prev.startTime === startTime && prev.endTime === endTime) {
        return prev;
      }
      return { startTime, endTime };
    });
  }, []);
  
  const [tabPlayback, setTabPlayback] = React.useState<
    Record<'heatmap' | 'gaze' | 'honeycomb' | 'mountain', { currentTime: number; isPlaying: boolean }>
  >({
    heatmap: { currentTime: 0, isPlaying: false },
    gaze: { currentTime: 0, isPlaying: false },
    honeycomb: { currentTime: 0, isPlaying: false },
    mountain: { currentTime: 0, isPlaying: false },
  });
  const tabPlaybackRef = React.useRef(tabPlayback);
  React.useEffect(() => {
    tabPlaybackRef.current = tabPlayback;
  }, [tabPlayback]);
  const [gazeSettings, setGazeSettings] = React.useState({
    maxRadius: 22,
    borderWidth: 2,
    opacity: 0.9,
    showLines: true,
    showBorder: true,
  });
  const [honeycombSettings, setHoneycombSettings] = React.useState({
    cursorStyle: 'solid' as 'solid' | 'hollow' | 'cross',
    radius: 24,
    borderWidth: 2,
    opacity: 1,
  });
  const [mountainSettings, setMountainSettings] = React.useState<MountainChartSettings>(DEFAULT_MOUNTAIN_SETTINGS);
  const [resolvedRecordVideoUrl, setResolvedRecordVideoUrl] = React.useState<string | null>(null);
  const recordVideoOwnerRef = React.useRef<{ recordKey: string; url: string | null } | null>(null);
  const [loadedRecordVideo, setLoadedRecordVideo] = React.useState<{ recordKey: string; url: string; duration: number } | null>(null);
  const [recordListMode, setRecordListMode] = React.useState<'records' | 'mapping'>('records');
  const [mappingRecords, setMappingRecords] = React.useState<MappingRecordEntry[]>([]);
  const [mappingRecordsLoaded, setMappingRecordsLoaded] = React.useState(false);
  const [mappingRecordsLoading, setMappingRecordsLoading] = React.useState(false);
  const [mappingRecordsError, setMappingRecordsError] = React.useState<string | null>(null);
  const [selectedMappingPath, setSelectedMappingPath] = React.useState<string | null>(null);
  const recordSelectionBeforeMappingRef = React.useRef<string | null>(null);

  const selectedMappingEntry = React.useMemo(
    () => mappingRecords.find((entry) => entry.outputPath === selectedMappingPath) || null,
    [mappingRecords, selectedMappingPath],
  );
  const isMappingMode = recordListMode === 'mapping' && Boolean(selectedMappingEntry);

  const selectedRecord = selectedRecordId ? records.find((r) => r.id === selectedRecordId) || null : null;
  const recordVideoKey = JSON.stringify([projectDir, selectedRecordId, selectedRecord?.mp4Path, selectedRecord?.mp4Url]);
  const recordingVideoStimulus = React.useMemo(() => isMappingMode ? null : resolveRecordingVideoStimulus(
    selectedRecord,
    loadedRecordVideo?.recordKey === recordVideoKey && loadedRecordVideo.url === resolvedRecordVideoUrl
      ? loadedRecordVideo.duration
      : undefined,
  ), [isMappingMode, selectedRecord, loadedRecordVideo, recordVideoKey, resolvedRecordVideoUrl]);
  const isGlassesMode = (selectedRecord?.deviceType ?? (recordListMode === 'records' ? projectDeviceType : undefined)) === '眼镜式';
  const selectedStimulus = visualSelectedStimulusId ? stimuli.find((s) => s.id === visualSelectedStimulusId) : null;
  const selectedStimulusForAnalysis = isMappingMode || isGlassesMode ? null : selectedStimulus;
  React.useEffect(() => {
    if (!isGlassesMode) return;
    if (!visualSelectedStimulusId) return;
    setVisualSelectedStimulusId(null);
  }, [isGlassesMode, visualSelectedStimulusId, setVisualSelectedStimulusId]);
  const recordsById = React.useMemo(() => new Map(records.map((record) => [record.id, record])), [records]);
  const [timelineSegments, setTimelineSegments] = React.useState<TimeSegment[]>([]);
  const [selectedSegmentId, setSelectedSegmentId] = React.useState<string | null>(null);
  const [playbackSegmentId, setPlaybackSegmentId] = React.useState<string | null>(null);
  const [pendingDeleteSegment, setPendingDeleteSegment] = React.useState<TimeSegment | null>(null);
  const lastSavedTimelineSegmentsRef = React.useRef<string>('[]');

  React.useEffect(() => {
    const selectedRecordExists = Boolean(selectedRecordId && records.some((record) => record.id === selectedRecordId));
    if (selectedRecordExists) return;

    const fallbackVisibleRecordId = Array.from(visibleRecordIds).find((id) => records.some((record) => record.id === id)) || null;
    if (fallbackVisibleRecordId) {
      if (selectedRecordId !== fallbackVisibleRecordId) {
        setSelectedRecordId(fallbackVisibleRecordId);
      }
      return;
    }

    if (selectedRecordId) {
      setSelectedRecordId(null);
    }
  }, [selectedRecordId, records, visibleRecordIds, setSelectedRecordId]);

  React.useEffect(() => {
    const normalized = normalizeTimeSegments(selectedRecord?.timelineSegments ?? []);
    setTimelineSegments(normalized);
    setSelectedSegmentId((prev) => (prev && normalized.some((segment) => segment.id === prev) ? prev : null));
    setPlaybackSegmentId((prev) => (prev && normalized.some((segment) => segment.id === prev) ? prev : null));
    lastSavedTimelineSegmentsRef.current = JSON.stringify(normalized);
  }, [selectedRecordId, selectedRecord?.timelineSegments]);

  const handleTimelineSegmentsChange = React.useCallback(
    (nextSegments: TimeSegment[]) => {
      const normalized = normalizeTimeSegments(nextSegments);
      setTimelineSegments(normalized);
      if (selectedRecordId && onRecordTimelineSegmentsChange) {
        onRecordTimelineSegmentsChange(selectedRecordId, normalized);
      }
    },
    [selectedRecordId, onRecordTimelineSegmentsChange],
  );

  const orderedSegments = React.useMemo(
    () => normalizeTimeSegments(timelineSegments, { duration }),
    [timelineSegments, duration],
  );

  const selectedSegment = React.useMemo(
    () => orderedSegments.find((segment) => segment.id === selectedSegmentId) || null,
    [orderedSegments, selectedSegmentId],
  );

  const playbackSegment = React.useMemo(
    () => orderedSegments.find((segment) => segment.id === playbackSegmentId) || null,
    [orderedSegments, playbackSegmentId],
  );

  const shouldPlayBySegments = orderedSegments.length > 0 && !selectedSegmentId && customTimeRange === null;

  const effectiveSegment = React.useMemo(() => {
    if (customTimeRange) return null;
    return selectedSegment || playbackSegment;
  }, [customTimeRange, selectedSegment, playbackSegment]);

  React.useEffect(() => {
    if (customTimeRange) {
      setPlaybackSegmentId(null);
    }
  }, [customTimeRange]);

  React.useEffect(() => {
    if (!selectedRecordId || !selectedRecord || !projectDir) return;
    if (!ipcClient.isAvailable()) return;
    const recordName = String(selectedRecord.name || '').trim();
    if (!recordName) return;

    const serialized = JSON.stringify(timelineSegments);
    if (serialized === lastSavedTimelineSegmentsRef.current) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void ipcClient
        .saveRecordMeta({
          projectDir,
          recordName,
          meta: { segments: timelineSegments },
        })
        .then((res) => {
          if (!cancelled && res && res.ok) {
            lastSavedTimelineSegmentsRef.current = serialized;
          }
        })
        .catch(() => {
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [timelineSegments, selectedRecordId, selectedRecord, projectDir]);

  React.useEffect(() => {
    if (isPlaying) return;
    setVisualCurrentTime((prev) => (Math.abs(prev - currentTime) < 0.001 ? prev : currentTime));
  }, [currentTime, isPlaying]);

  React.useEffect(() => {
    const publishRecordVideoUrl = (url: string | null) => {
      recordVideoOwnerRef.current = { recordKey: recordVideoKey, url };
      setResolvedRecordVideoUrl(url);
    };
    if (!selectedRecordId || !selectedRecord) {
      publishRecordVideoUrl(null);
      return;
    }

    const fallbackUrl =
      typeof selectedRecord.mp4Url === 'string' && selectedRecord.mp4Url ? selectedRecord.mp4Url : null;
    const recordPath =
      typeof selectedRecord.mp4Path === 'string' && selectedRecord.mp4Path ? selectedRecord.mp4Path : undefined;
    if (fallbackUrl) {
      publishRecordVideoUrl(fallbackUrl);
    }

    if (!projectDir || !ipcClient.isAvailable()) {
      publishRecordVideoUrl(fallbackUrl);
      return;
    }

    const recordName = String(selectedRecord.name || '').trim();
    if (!recordName && !recordPath) {
      publishRecordVideoUrl(fallbackUrl);
      return;
    }

    let cancelled = false;
    void ipcClient
      .getRecordVideoUrl({
        projectDir,
        name: recordName,
        recordPath,
      })
      .then((res) => {
        if (cancelled) return;
        if (res && res.ok && typeof res.url === 'string' && res.url) {
          publishRecordVideoUrl(res.url);
        } else {
          publishRecordVideoUrl(fallbackUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          publishRecordVideoUrl(fallbackUrl);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedRecordId, selectedRecord, projectDir, recordVideoKey]);
  
  const mappingImageUrl = isMappingMode ? selectedMappingEntry?.result.imageUrl || null : null;
  // The linked source video remains the playback clock in mapping mode, while
  // the mapped static image is shown as the visual background.
  const backgroundUrl = isMappingMode
    ? selectedMappingEntry?.result.videoUrl || resolvedRecordVideoUrl
    : resolvedRecordVideoUrl;
  const hasBackground = Boolean(mappingImageUrl || backgroundUrl);
  const isVideoBackground = Boolean(backgroundUrl);
  const activeSourceId = isMappingMode ? selectedMappingEntry?.outputPath || null : selectedRecordId;
  const activeFrameSize = React.useMemo(() => {
    if (isMappingMode && selectedMappingEntry) {
      return {
        w: Number(selectedMappingEntry.result.resolution.width) || 0,
        h: Number(selectedMappingEntry.result.resolution.height) || 0,
      };
    }
    return videoSize;
  }, [isMappingMode, selectedMappingEntry, videoSize]);

  const selectedRecordPoints = React.useMemo(() => {
    if (isMappingMode && selectedMappingEntry) {
      return adaptMappingResultToHeatmapPoints(selectedMappingEntry.result);
    }
    return selectedRecordId ? heatmapPointsByRecord[selectedRecordId] || [] : [];
  }, [heatmapPointsByRecord, isMappingMode, selectedMappingEntry, selectedRecordId]);

  const isHeatmapLoading = visualSubTab === 'heatmap' && heatmapLoadingRecordId !== null;
  const isGazeLoading = visualSubTab === 'gaze' && heatmapLoadingRecordId !== null;

  const fpsValue = Number(selectedRecord?.fps);
  const frameStep = Number.isFinite(fpsValue) && fpsValue > 0 ? 1 / fpsValue : 0.04;
  const EXPORT_FPS = 30;
  
  const [isExporting, setIsExporting] = React.useState(false);
  const [isExportingImage, setIsExportingImage] = React.useState(false);
  const [exportProgressPercent, setExportProgressPercent] = React.useState(0);
  const isExportingRef = React.useRef(false);
  const isMountedRef = React.useRef(true);
  React.useEffect(() => {
    isExportingRef.current = isExporting;
  }, [isExporting]);
  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const sanitizeExportName = sanitizeVisualExportName;
  const buildTempWebmPath = React.useCallback(
    (sourcePath: string, name: string) => buildVisualTempWebmPath(sourcePath, name),
    [],
  );
  const resolveRecordDurationSeconds = React.useCallback(
    (recordId: string, fallbackSeconds?: number) =>
      resolveVisualRecordDurationSeconds(recordsById, recordId, fallbackSeconds),
    [recordsById],
  );
  const prepareRecordPoints = prepareVisualRecordPoints;
  const normalizeTimestampsToVideo = React.useCallback(
    (points: HeatmapPoint[], targetDurationSeconds?: number) =>
      normalizeVisualTimestampsToVideo(
        points,
        typeof targetDurationSeconds === 'number' && targetDurationSeconds > 0
          ? targetDurationSeconds
          : duration,
      ),
    [duration],
  );

  // First normalize ALL points (without filtering), then filter by stimulus
  // This ensures timestamps are aligned to the full video timeline
  const selectedRecordPointsSorted = React.useMemo(() => {
    return prepareRecordPoints(selectedRecordPoints);
  }, [prepareRecordPoints, selectedRecordPoints]);

  const selectedRecordPointsAligned = React.useMemo(() => {
    // Mapping results already store timestamps in milliseconds on the source
    // video timeline; raw CSV points still need the existing normalization.
    const normalized = isMappingMode
      ? selectedRecordPointsSorted.map((point) => ({ ...point }))
      : normalizeTimestampsToVideo(
          selectedRecordPointsSorted,
          selectedRecordId ? resolveRecordDurationSeconds(selectedRecordId, duration) : duration,
        );
    normalized.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const renderable = normalized.filter((p) => !p.markerOnly);
    
    // Then filter by stimulus if selected
    if (selectedStimulusForAnalysis) {
      return renderable.filter((p) => p.stimulusName === selectedStimulusForAnalysis.name);
    }
    
    return renderable;
  }, [
    duration,
    isGlassesMode,
    isMappingMode,
    normalizeTimestampsToVideo,
    resolveRecordDurationSeconds,
    selectedRecordId,
    selectedRecordPointsSorted,
    selectedStimulusForAnalysis,
  ]);

  const selectedRecordRenderablePointsCount = React.useMemo(
    () => selectedRecordPointsSorted.filter((p) => !p.markerOnly).length,
    [selectedRecordPointsSorted],
  );
  const lastVisualStateDebugAtRef = React.useRef(0);
  React.useEffect(() => {
    const now = Date.now();
    if (now - lastVisualStateDebugAtRef.current < 1000) return;
    lastVisualStateDebugAtRef.current = now;
    const summarize = (points: HeatmapPoint[]) => {
      let renderable = 0;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let minTs = Infinity;
      let maxTs = -Infinity;
      for (const point of points) {
        if (point.markerOnly) continue;
        const x = Number(point.x);
        const y = Number(point.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        renderable += 1;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        const ts = typeof point.timestamp === 'number' && Number.isFinite(point.timestamp) ? point.timestamp : NaN;
        if (Number.isFinite(ts)) {
          minTs = Math.min(minTs, ts);
          maxTs = Math.max(maxTs, ts);
        }
      }
      return {
        total: points.length,
        renderable,
        xRange: renderable > 0 ? [Number(minX.toFixed(4)), Number(maxX.toFixed(4))] : null,
        yRange: renderable > 0 ? [Number(minY.toFixed(4)), Number(maxY.toFixed(4))] : null,
        timestampRange: Number.isFinite(minTs) && Number.isFinite(maxTs) ? [Math.round(minTs), Math.round(maxTs)] : null,
      };
    };
    const pageStateDebug = {
      selectedRecordId,
      selectedRecordName: selectedRecord?.name || null,
      deviceType: selectedRecord?.deviceType || null,
      visualSubTab,
      heatmapLoadingRecordId,
      isHeatmapLoading,
      isGazeLoading,
      duration,
      currentTime,
      backgroundUrl: backgroundUrl || null,
      selectedStimulusName: selectedStimulusForAnalysis?.name || null,
      raw: summarize(selectedRecordPoints),
      sorted: summarize(selectedRecordPointsSorted),
      aligned: summarize(selectedRecordPointsAligned),
      selectedRecordRenderablePointsCount,
    };
    console.log('[VisualDebug] page-state', pageStateDebug);
    console.log('[VisualDebug] page-state-json', JSON.stringify(pageStateDebug));
  }, [
    backgroundUrl,
    currentTime,
    duration,
    heatmapLoadingRecordId,
    isGazeLoading,
    isHeatmapLoading,
    selectedRecord?.deviceType,
    selectedRecord?.name,
    selectedRecordId,
    selectedRecordPoints,
    selectedRecordPointsAligned,
    selectedRecordPointsSorted,
    selectedRecordRenderablePointsCount,
    selectedStimulusForAnalysis?.name,
    visualSubTab,
  ]);

  const canEnableMultiRecordPlayback = Boolean(
    selectedRecordId && (isGlassesMode || selectedStimulusForAnalysis),
  );

  React.useEffect(() => {
    if (!multiSelectEnabled || canEnableMultiRecordPlayback) return;
    setMultiSelectEnabled(false);
    setVisibleRecordIds(() => (selectedRecordId ? new Set([selectedRecordId]) : new Set()));
  }, [canEnableMultiRecordPlayback, multiSelectEnabled, selectedRecordId, setVisibleRecordIds]);

  const isMultiRecordPlayback = multiSelectEnabled && canEnableMultiRecordPlayback;

  const multiPlaybackRecordIds = React.useMemo(() => {
    if (!isMultiRecordPlayback) return [] as string[];
    const ids: string[] = [];
    if (selectedRecordId && recordsById.has(selectedRecordId)) {
      ids.push(selectedRecordId);
    }
    visibleRecordIds.forEach((id) => {
      if (!recordsById.has(id)) return;
      if (ids.includes(id)) return;
      ids.push(id);
    });
    return ids;
  }, [isMultiRecordPlayback, recordsById, selectedRecordId, visibleRecordIds]);

  const multiPlaybackEntries = React.useMemo(() => {
    if (!isMultiRecordPlayback) return [] as Array<{
      id: string;
      name: string;
      color: string;
      points: HeatmapPoint[];
      startTimeMs: number;
      endTimeMs: number;
    }>;

    return multiPlaybackRecordIds
      .map((recordId, index) => {
        const record = recordsById.get(recordId);
        if (!record) return null;
        const prepared = prepareRecordPoints(heatmapPointsByRecord[recordId] || []);
        const normalized = normalizeTimestampsToVideo(
          prepared,
          resolveRecordDurationSeconds(recordId, recordId === selectedRecordId ? duration : undefined),
        );
        normalized.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        const filtered = normalized.filter((point) =>
          !point.markerOnly &&
          (!selectedStimulusForAnalysis || point.stimulusName === selectedStimulusForAnalysis.name),
        );
        if (filtered.length === 0) return null;
        const timestamps = filtered
          .map((point) => point.timestamp)
          .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
        if (timestamps.length === 0) return null;
        return {
          id: recordId,
          name: getDisplayRecordName(record),
          color: MULTI_RECORD_COLORS[index % MULTI_RECORD_COLORS.length],
          points: filtered,
          startTimeMs: Math.min(...timestamps),
          endTimeMs: Math.max(...timestamps),
        };
      })
      .filter(Boolean) as Array<{
      id: string;
      name: string;
      color: string;
      points: HeatmapPoint[];
      startTimeMs: number;
      endTimeMs: number;
    }>;
  }, [
    duration,
    heatmapPointsByRecord,
    isMultiRecordPlayback,
    multiPlaybackRecordIds,
    normalizeTimestampsToVideo,
    prepareRecordPoints,
    recordsById,
    resolveRecordDurationSeconds,
    selectedRecordId,
    selectedStimulusForAnalysis,
  ]);

  const multiPlaybackPrimaryEntry = React.useMemo(
    () => multiPlaybackEntries.find((entry) => entry.id === selectedRecordId) || multiPlaybackEntries[0] || null,
    [multiPlaybackEntries, selectedRecordId],
  );

  const multiRecordRenderablePointsCount = React.useMemo(
    () => multiPlaybackEntries.reduce((sum, entry) => sum + entry.points.length, 0),
    [multiPlaybackEntries],
  );

  const selectedRecordPointsSingleFiltered = useFilteredData(selectedRecordPointsAligned, effectiveSegment);
  const selectedRecordPointsSequenceFiltered = React.useMemo(
    () => filterBySegments(selectedRecordPointsAligned, orderedSegments),
    [selectedRecordPointsAligned, orderedSegments],
  );
  const selectedRecordPointsFiltered = shouldPlayBySegments
    ? selectedRecordPointsSequenceFiltered
    : selectedRecordPointsSingleFiltered;

  // For timeline analysis, always use all points (not filtered by stimulus)
  // TimelineAnalysis will handle the filtering internally
  const timelinePoints = React.useMemo(() => {
    const normalized = normalizeTimestampsToVideo(
      selectedRecordPointsSorted,
      selectedRecordId ? resolveRecordDurationSeconds(selectedRecordId, duration) : duration,
    );
    normalized.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    return normalized;
  }, [duration, normalizeTimestampsToVideo, resolveRecordDurationSeconds, selectedRecordId, selectedRecordPointsSorted]);

  // Clear custom time range and seek to stimulus start when stimulus selection changes
  React.useEffect(() => {
    setCustomTimeRange(null);
    
    // If a stimulus is selected, we need to seek to its start time
    // This will be handled by the stimulusTimeRange effect below
  }, [visualSelectedStimulusId]);

  // Calculate stimulus time range for video playback restriction
  const stimulusTimeRange = React.useMemo(() => {
    // Custom time range takes priority to ensure exact alignment with user selection.
    if (customTimeRange) {
      return customTimeRange;
    }

    if (shouldPlayBySegments && orderedSegments.length > 0) {
      return {
        startTime: orderedSegments[0].startTime,
        endTime: orderedSegments[orderedSegments.length - 1].endTime,
      };
    }

    if (effectiveSegment) {
      return {
        startTime: effectiveSegment.startTime,
        endTime: effectiveSegment.endTime,
      };
    }
    
    if (isGlassesMode) {
      return null;
    }

    if (!selectedStimulusForAnalysis || !selectedRecord?.mp4Url) {
      return null;
    }
    
    // 刺激物边界由索引阶段写入的 markerOnly 点提供，不能再用首尾注视点估算。
    const timestamps = timelinePoints
      .filter((point) => String(point.stimulusName || '').trim() === selectedStimulusForAnalysis.name)
      .map(p => p.timestamp)
      .filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
    
    if (timestamps.length === 0) return null;
    
    const minTs = Math.min(...timestamps);
    const maxTs = Math.max(...timestamps);
    // The index writes the outgoing and incoming stimulus marker at the same
    // timestamp. Only shared transition boundaries are end-exclusive; the final
    // stimulus keeps its real endpoint instead of losing its last frame.
    const frameGuardSeconds = Math.max(1 / 120, frameStep);
    const startTime = minTs / 1000;
    const endBoundaryTime = maxTs / 1000;
    const hasIncomingStimulusAtBoundary = timelinePoints.some((point) => {
      const pointName = String(point.stimulusName || '').trim();
      return point.markerOnly === true
        && typeof point.timestamp === 'number'
        && Math.abs(point.timestamp - maxTs) < 0.5
        && pointName.length > 0
        && pointName !== selectedStimulusForAnalysis.name;
    });
    
    // Convert to seconds
    return {
      startTime,
      endTime: hasIncomingStimulusAtBoundary
        ? Math.max(startTime, endBoundaryTime - frameGuardSeconds)
        : endBoundaryTime,
    };
  }, [
    customTimeRange,
    effectiveSegment,
    isGlassesMode,
    orderedSegments,
    selectedRecord,
    selectedStimulusForAnalysis,
    shouldPlayBySegments,
    timelinePoints,
    frameStep,
  ]);

  const upperBoundByTimestamp = (points: HeatmapPoint[], timeMs: number) => {
    let lo = 0;
    let hi = points.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const ts = points[mid]?.timestamp ?? 0;
      if (ts <= timeMs) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  };

  const lowerBoundByTimestamp = (points: HeatmapPoint[], timeMs: number) => {
    let lo = 0;
    let hi = points.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const ts = points[mid]?.timestamp ?? 0;
      if (ts < timeMs) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  };

  type ContainLayout = {
    containerW: number;
    containerH: number;
    drawLeft: number;
    drawTop: number;
    drawW: number;
    drawH: number;
  };

  const computeContainLayout = (params: {
    containerW: number;
    containerH: number;
    videoW: number;
    videoH: number;
  }): ContainLayout => {
    const cw = Math.max(1, Math.round(params.containerW));
    const ch = Math.max(1, Math.round(params.containerH));
    const vw = Math.max(1, Math.round(params.videoW));
    const vh = Math.max(1, Math.round(params.videoH));
    const scale = Math.min(cw / vw, ch / vh);
    const drawW = vw * scale;
    const drawH = vh * scale;
    const drawLeft = (cw - drawW) / 2;
    const drawTop = (ch - drawH) / 2;
    return { containerW: cw, containerH: ch, drawLeft, drawTop, drawW, drawH };
  };

  const containLayoutRef = React.useRef<ContainLayout | null>(null);

  const ensureCanvasSize = (canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    const nextW = Math.max(1, Math.round(rect.width));
    const nextH = Math.max(1, Math.round(rect.height));
    if (canvas.width !== nextW) canvas.width = nextW;
    if (canvas.height !== nextH) canvas.height = nextH;
  };

  const updateContainLayout = React.useCallback(() => {
    const wrap = videoWrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    containLayoutRef.current = computeContainLayout({
      containerW: rect.width,
      containerH: rect.height,
      videoW: activeFrameSize.w || 1,
      videoH: activeFrameSize.h || 1,
    });
  }, [activeFrameSize.w, activeFrameSize.h]);

  React.useEffect(() => {
    updateContainLayout();
    const wrap = videoWrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => updateContainLayout());
    ro.observe(wrap);
    window.addEventListener('resize', updateContainLayout);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateContainLayout);
    };
  }, [updateContainLayout]);

  const mapPointsToContainer = React.useCallback((points: HeatmapPoint[]): HeatmapPoint[] => {
    const layout = containLayoutRef.current;
    if (!layout) return points;
    const { containerW, containerH, drawLeft, drawTop, drawW, drawH } = layout;
    if (containerW <= 0 || containerH <= 0) return points;
    if (drawW <= 0 || drawH <= 0) return points;
    return points.map((p) => {
      const nx = (drawLeft + p.x * drawW) / containerW;
      const ny = (drawTop + p.y * drawH) / containerH;
      return { ...p, x: Math.max(0, Math.min(1, nx)), y: Math.max(0, Math.min(1, ny)) };
    });
  }, []);

  const clearOverlay = React.useCallback(() => {
    const heatmapCanvas = heatmapCanvasRef.current;
    const gazeCanvas = gazeCanvasRef.current;

    if (heatmapCanvas) {
      ensureCanvasSize(heatmapCanvas);
      const ctx = heatmapCanvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, heatmapCanvas.width, heatmapCanvas.height);
    }

    if (gazeCanvas) {
      ensureCanvasSize(gazeCanvas);
      const ctx = gazeCanvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, gazeCanvas.width, gazeCanvas.height);
    }
  }, [heatmapCanvasRef, gazeCanvasRef]);

  const renderOverlayAt = React.useCallback(
    (timeMs: number) => {
      const isHeatmap = visualSubTab === 'heatmap';
      const isGaze = visualSubTab === 'gaze';
      const isHoneycomb = visualSubTab === 'honeycomb';

      const heatmapCanvas = heatmapCanvasRef.current;
      const gazeCanvas = gazeCanvasRef.current;

      if (!activeSourceId || (!isMultiRecordPlayback && selectedRecordPointsFiltered.length === 0)) {
        clearOverlay();
        return;
      }

      // Don't render any points if time is at the very beginning (< 10ms)
      // This prevents showing the first point before playback starts
      if (timeMs < 10) {
        clearOverlay();
        return;
      }

      if (isMultiRecordPlayback) {
        if (!multiPlaybackPrimaryEntry || multiPlaybackEntries.length === 0) {
          clearOverlay();
          return;
        }

        if (timeMs < multiPlaybackPrimaryEntry.startTimeMs) {
          clearOverlay();
          return;
        }

        const elapsedFromPrimaryStartMs = Math.max(
          0,
          Math.min(timeMs, multiPlaybackPrimaryEntry.endTimeMs) - multiPlaybackPrimaryEntry.startTimeMs,
        );

        const combinedPoints: HeatmapPoint[] = [];
        const pathsByRecord: Record<string, HeatmapPoint[]> = {};
        const colorsByRecord: Record<string, string> = {};
        const currentPoints: Array<{ id: string; point: HeatmapPoint; color: string }> = [];
        let maxWeight = 1;

        multiPlaybackEntries.forEach((entry) => {
          const recordEndTimeMs = Math.min(entry.endTimeMs, entry.startTimeMs + elapsedFromPrimaryStartMs);
          if (recordEndTimeMs < entry.startTimeMs) return;

          const start = lowerBoundByTimestamp(entry.points, entry.startTimeMs);
          const end = upperBoundByTimestamp(entry.points, recordEndTimeMs);
          const slice = entry.points.slice(start, end);
          if (slice.length === 0) return;

          const mappedSlice = mapPointsToContainer(slice);
          pathsByRecord[entry.id] = mappedSlice;
          colorsByRecord[entry.id] = entry.color;
          combinedPoints.push(...mappedSlice);

          const currentPoint = mappedSlice[mappedSlice.length - 1];
          if (currentPoint) {
            currentPoints.push({ id: entry.id, point: currentPoint, color: entry.color });
          }

          mappedSlice.forEach((point) => {
            const weight = typeof point.weight === 'number' && Number.isFinite(point.weight) ? point.weight : 0;
            if (weight > maxWeight) maxWeight = weight;
          });
        });

        if (isHeatmap && heatmapCanvas) {
          ensureCanvasSize(heatmapCanvas);
          if (heatmapPerspectiveEnabled) {
            drawHeatmapPerspective(heatmapCanvas, combinedPoints, heatmapSettings);
          } else {
            drawHeatmap(heatmapCanvas, combinedPoints, heatmapSettings);
          }
        } else if (heatmapCanvas) {
          ensureCanvasSize(heatmapCanvas);
          const ctx = heatmapCanvas.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, heatmapCanvas.width, heatmapCanvas.height);
        }

        if (isGaze && gazeCanvas) {
          ensureCanvasSize(gazeCanvas);
          drawGazePaths(
            gazeCanvas,
            pathsByRecord,
            colorsByRecord,
            1,
            maxWeight,
            gazeSettings,
          );
        } else if (isHoneycomb && gazeCanvas) {
          ensureCanvasSize(gazeCanvas);
          if (currentPoints.length === 0) {
            const ctx = gazeCanvas.getContext('2d');
            if (ctx) ctx.clearRect(0, 0, gazeCanvas.width, gazeCanvas.height);
          } else {
            currentPoints.forEach((entry, index) => {
              drawHoneycombCursor(gazeCanvas, entry.point, honeycombSettings, index === 0, entry.color);
            });
          }
        } else if (gazeCanvas) {
          ensureCanvasSize(gazeCanvas);
          const ctx = gazeCanvas.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, gazeCanvas.width, gazeCanvas.height);
        }
        return;
      }

      // Calculate the time range to display
      let startTimeMs = 0;
      let endTimeMs = timeMs;
      
      // If there's a stimulus or custom time range, adjust the display logic
      if (stimulusTimeRange) {
        const rangeStartMs = stimulusTimeRange.startTime * 1000;
        const rangeEndMs = stimulusTimeRange.endTime * 1000;

        // If current time is before the range, don't show anything
        if (timeMs < rangeStartMs) {
          clearOverlay();
          return;
        }
        
        // Show points from range start to current time (cumulative from range start)
        startTimeMs = rangeStartMs;
        endTimeMs = Math.min(timeMs, rangeEndMs);
      }

      const start = lowerBoundByTimestamp(selectedRecordPointsFiltered, startTimeMs);
      const end = upperBoundByTimestamp(selectedRecordPointsFiltered, endTimeMs);
      const slice = selectedRecordPointsFiltered.slice(start, end);
      const mappedSlice = mapPointsToContainer(slice);

      if (isHeatmap && heatmapCanvas) {
        ensureCanvasSize(heatmapCanvas);
        if (heatmapPerspectiveEnabled) {
          drawHeatmapPerspective(heatmapCanvas, mappedSlice, heatmapSettings);
        } else {
          drawHeatmap(heatmapCanvas, mappedSlice, heatmapSettings);
        }
      } else if (heatmapCanvas) {
        ensureCanvasSize(heatmapCanvas);
        const ctx = heatmapCanvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, heatmapCanvas.width, heatmapCanvas.height);
      }

      if (isGaze && gazeCanvas) {
        ensureCanvasSize(gazeCanvas);
        let maxWeight = 0;
        for (const p of mappedSlice) {
          const w = typeof p.weight === 'number' && Number.isFinite(p.weight) ? p.weight : 0;
          if (w > maxWeight) maxWeight = w;
        }
        if (maxWeight <= 0) maxWeight = 1;
        drawGazePaths(
          gazeCanvas,
          { [activeSourceId]: mappedSlice },
          { [activeSourceId]: '#0ea5e9' },
          1,
          maxWeight,
          gazeSettings,
        );
      } else if (isHoneycomb && gazeCanvas) {
        ensureCanvasSize(gazeCanvas);
        const currentPoint = mappedSlice.length > 0 ? mappedSlice[mappedSlice.length - 1] : null;
        drawHoneycombCursor(gazeCanvas, currentPoint, honeycombSettings);
      } else if (gazeCanvas) {
        ensureCanvasSize(gazeCanvas);
        const ctx = gazeCanvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, gazeCanvas.width, gazeCanvas.height);
      }
    },
    [
      visualSubTab,
      heatmapCanvasRef,
      gazeCanvasRef,
      isMultiRecordPlayback,
      multiPlaybackEntries,
      multiPlaybackPrimaryEntry,
      heatmapPerspectiveEnabled,
      activeSourceId,
      selectedRecordId,
      selectedRecordPointsFiltered,
      heatmapSettings,
      gazeSettings,
      honeycombSettings,
      clearOverlay,
      mapPointsToContainer,
      stimulusTimeRange,
    ],
  );

  const formatTime = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
    const totalSeconds = Math.max(0, Math.floor(seconds));
    const mm = Math.floor(totalSeconds / 60);
    const ss = totalSeconds - mm * 60;
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  };

  const snapTimelineDisplaySecond = React.useCallback(
    (seconds: number) => {
      if (!Number.isFinite(seconds) || seconds < 0) return 0;
      const max = duration > 0 ? Math.max(0, Math.floor(duration)) : seconds;
      return Math.max(0, Math.min(max, Math.floor(seconds)));
    },
    [duration],
  );

  const safePause = () => {
    const el = videoRef.current;
    if (!el) return;
    try {
      el.pause();
    } catch {
    }
  };

  const resolveSegmentIndexByTime = React.useCallback(
    (timeSeconds: number): number => {
      if (orderedSegments.length === 0) return -1;
      const inRange = orderedSegments.findIndex(
        (segment) => timeSeconds >= segment.startTime && timeSeconds <= segment.endTime,
      );
      if (inRange >= 0) return inRange;
      const next = orderedSegments.findIndex((segment) => timeSeconds < segment.startTime);
      if (next >= 0) return next;
      return orderedSegments.length - 1;
    },
    [orderedSegments],
  );

  const togglePlay = () => {
    // Handle video playback
    const el = videoRef.current;
    if (!el) return;
    if (el.paused || el.ended) {
      if (shouldPlayBySegments) {
        const firstSegment = orderedSegments[0];
        if (firstSegment) {
          setPlaybackSegmentId(firstSegment.id);
          try {
            el.currentTime = firstSegment.startTime;
            setCurrentTime(firstSegment.startTime);
            setVisualCurrentTime(firstSegment.startTime);
          } catch {
          }
        }
      } else if (stimulusTimeRange) {
        // If at end or beyond range, reset to range start
        if (el.currentTime >= stimulusTimeRange.endTime || el.currentTime < stimulusTimeRange.startTime) {
          try {
            el.currentTime = stimulusTimeRange.startTime;
            setCurrentTime(stimulusTimeRange.startTime);
            setVisualCurrentTime(stimulusTimeRange.startTime);
          } catch {}
        }
      } else if (el.ended) {
        try {
          el.currentTime = 0;
          setCurrentTime(0);
          setVisualCurrentTime(0);
        } catch {}
      }
      
      try {
        void el.play();
      } catch {
      }
      return;
    }
    safePause();
  };

  const seekBy = React.useCallback((deltaSeconds: number) => {
    const el = videoRef.current;
    if (!el) return;
    try {
      let next = Math.max(0, el.currentTime + deltaSeconds);
      const max = Number.isFinite(el.duration) ? el.duration : next;
      
      // Restrict to stimulus time range if selected
      if (stimulusTimeRange) {
        next = Math.max(stimulusTimeRange.startTime, Math.min(stimulusTimeRange.endTime, next));
      }
      
      const targetTime = Math.min(next, max);
      lastManualSeekRef.current = { time: targetTime, requestedAtMs: performance.now() };
      el.currentTime = targetTime;
      setCurrentTime(targetTime);
      setVisualCurrentTime(targetTime);
      if (shouldPlayBySegments) {
        const idx = resolveSegmentIndexByTime(targetTime);
        setPlaybackSegmentId(idx >= 0 ? orderedSegments[idx].id : null);
      }
    } catch {
    }
  }, [orderedSegments, resolveSegmentIndexByTime, shouldPlayBySegments, stimulusTimeRange]);

  const seekTo = React.useCallback((nextTime: number, force: boolean = false) => {
    const el = videoRef.current;
    if (!el) return;
    try {
      const max = Number.isFinite(el.duration) ? el.duration : nextTime;
      let clampedTime = Math.min(Math.max(0, nextTime), max);
      
      // Restrict to stimulus time range if selected (unless force is true)
      if (stimulusTimeRange && !force) {
        clampedTime = Math.max(stimulusTimeRange.startTime, Math.min(stimulusTimeRange.endTime, clampedTime));
      }
      
      lastManualSeekRef.current = { time: clampedTime, requestedAtMs: performance.now() };
      el.currentTime = clampedTime;
      setCurrentTime(clampedTime);
      setVisualCurrentTime(clampedTime);
      if (shouldPlayBySegments) {
        const idx = resolveSegmentIndexByTime(clampedTime);
        setPlaybackSegmentId(idx >= 0 ? orderedSegments[idx].id : null);
      }
    } catch {
    }
  }, [orderedSegments, resolveSegmentIndexByTime, shouldPlayBySegments, stimulusTimeRange]);

  React.useEffect(() => {
    lastManualSeekRef.current = null;
    setIsPlaying(false);
    setCurrentTime(0);
    setVisualCurrentTime(0);
    setDuration(0);
    setPlaybackSegmentId(null);
    setTabPlayback({
      heatmap: { currentTime: 0, isPlaying: false },
      gaze: { currentTime: 0, isPlaying: false },
      honeycomb: { currentTime: 0, isPlaying: false },
    });
    prevSubTabRef.current = visualSubTab;
  }, [backgroundUrl, mappingImageUrl]);

  // Seek to the stimulus start only when the range or background changes.
  // Playback state must not be a dependency here: pausing the video changes
  // isPlaying to false, but should preserve the current frame.
  React.useEffect(() => {
    if (stimulusTimeRange && videoRef.current) {
      const el = videoRef.current;
      const seekToStart = () => {
        // Pause video first to ensure clean seek
        try {
          el.pause();
        } catch {}
        
        try {
          el.currentTime = stimulusTimeRange.startTime;
          setCurrentTime(stimulusTimeRange.startTime);
          setVisualCurrentTime(stimulusTimeRange.startTime);
          setIsPlaying(false);
        } catch {}
      };
      
      if (el.readyState >= 2) {
        seekToStart();
      } else {
        el.addEventListener('loadedmetadata', seekToStart, { once: true });
      }
    }
  }, [backgroundUrl, stimulusTimeRange?.startTime, stimulusTimeRange?.endTime]);

  // Monitor video playback and pause when exceeding stimulus range
  React.useEffect(() => {
    if (shouldPlayBySegments) return;
    if (!isVideoBackground || !stimulusTimeRange || !isPlaying) return;

    const el = videoRef.current;
    if (!el) return;
    
    const checkTime = () => {
      const ct = el.currentTime;
      if (ct >= stimulusTimeRange.endTime) {
        safePause();
        try {
          el.currentTime = stimulusTimeRange.endTime;
          setCurrentTime(stimulusTimeRange.endTime);
          setVisualCurrentTime(stimulusTimeRange.endTime);
        } catch {}
      }
    };
    
    const intervalId = window.setInterval(checkTime, Math.max(8, Math.min(20, frameStep * 500)));
    return () => clearInterval(intervalId);
  }, [frameStep, isVideoBackground, stimulusTimeRange, isPlaying, shouldPlayBySegments]);

  React.useEffect(() => {
    if (!shouldPlayBySegments || !isPlaying || !isVideoBackground) return;
    const el = videoRef.current;
    if (!el) return;
    if (orderedSegments.length === 0) return;

    const tick = () => {
      const ct = el.currentTime || 0;
      let idx = playbackSegmentId
        ? orderedSegments.findIndex((segment) => segment.id === playbackSegmentId)
        : -1;
      if (idx < 0) {
        idx = resolveSegmentIndexByTime(ct);
      }
      if (idx < 0) {
        setPlaybackSegmentId(null);
        return;
      }
      const segment = orderedSegments[idx];
      if (playbackSegmentId !== segment.id) {
        setPlaybackSegmentId(segment.id);
      }

      // Snap back into segment start if current time falls into a gap.
      if (ct < segment.startTime) {
        try {
          el.currentTime = segment.startTime;
          setCurrentTime(segment.startTime);
          setVisualCurrentTime(segment.startTime);
        } catch {
        }
        return;
      }

      if (ct >= segment.endTime) {
        const next = orderedSegments[idx + 1];
        if (next) {
          setPlaybackSegmentId(next.id);
          try {
            el.currentTime = next.startTime;
            setCurrentTime(next.startTime);
            setVisualCurrentTime(next.startTime);
          } catch {
          }
          return;
        }
        safePause();
        setPlaybackSegmentId(null);
        try {
          el.currentTime = segment.endTime;
          setCurrentTime(segment.endTime);
          setVisualCurrentTime(segment.endTime);
        } catch {
        }
      }
    };

    const timer = window.setInterval(tick, 60);
    return () => window.clearInterval(timer);
  }, [
    isPlaying,
    isVideoBackground,
    orderedSegments,
    playbackSegmentId,
    resolveSegmentIndexByTime,
    shouldPlayBySegments,
  ]);


  React.useEffect(() => {
    const prevTab = prevSubTabRef.current;
    if (prevTab === visualSubTab) return;
    setTabPlayback((map) => ({
      ...map,
      [prevTab]: { ...map[prevTab], currentTime, isPlaying },
    }));

    const next = tabPlaybackRef.current[visualSubTab] || { currentTime: 0, isPlaying: false };
    const el = videoRef.current;
    if (el) {
      try {
        el.pause();
      } catch {
      }
      try {
        el.currentTime = Math.max(0, next.currentTime || 0);
      } catch {
      }
      if (next.isPlaying) {
        try {
          void el.play();
        } catch {
        }
      }
    }
    setCurrentTime(next.currentTime || 0);
    setVisualCurrentTime(next.currentTime || 0);
    setIsPlaying(Boolean(next.isPlaying));
    prevSubTabRef.current = visualSubTab;
  }, [visualSubTab]);

  React.useEffect(() => {
    if (!hasBackground || (!activeSourceId && !selectedStimulus)) {
      clearOverlay();
      return;
    }
    if (visualSubTab !== 'heatmap' && visualSubTab !== 'gaze' && visualSubTab !== 'honeycomb') {
      clearOverlay();
      return;
    }
    if (isPlaying && isVideoBackground) {
      return;
    }
    if (!Number.isFinite(currentTime) || currentTime < 0) {
      clearOverlay();
      return;
    }
    // Don't render if at the very beginning (< 0.01 seconds)
    if (currentTime < 0.01) {
      clearOverlay();
      return;
    }
    // If there's a time range and not playing, only clear if we're at the start
    // This allows data to remain visible after playback ends
    if (stimulusTimeRange && !isPlaying) {
      const rangeStart = stimulusTimeRange.startTime;
      const threshold = 0.1; // 100ms threshold

      // If we're at or very close to the range start, don't render (waiting to play)
      if (Math.abs(currentTime - rangeStart) < threshold) {
        clearOverlay();
        return;
      }
    }
    renderOverlayAt(currentTime * 1000 + timeOffsetMs);
  }, [activeSourceId, hasBackground, selectedStimulus, visualSubTab, isPlaying, currentTime, timeOffsetMs, renderOverlayAt, clearOverlay, isVideoBackground, stimulusTimeRange]);

  React.useEffect(() => {
    if (!hasBackground || (!activeSourceId && !selectedStimulus)) {
      return;
    }
    if (visualSubTab !== 'heatmap' && visualSubTab !== 'gaze' && visualSubTab !== 'honeycomb') {
      return;
    }
    if (!isPlaying || !isVideoBackground) {
      return;
    }
    const el = videoRef.current;
    if (!el) return;

    let rafId = 0;
    let vfcId = 0;

    const drawAt = (mediaTimeSeconds: number) => {
      setVisualCurrentTime((prev) => (Math.abs(prev - mediaTimeSeconds) < 0.001 ? prev : mediaTimeSeconds));
      renderOverlayAt(mediaTimeSeconds * 1000 + timeOffsetMs);
    };

    if (typeof el.requestVideoFrameCallback === 'function') {
      const cb: VideoFrameRequestCallback = (_now, metadata) => {
        const mt = typeof metadata?.mediaTime === 'number' && Number.isFinite(metadata.mediaTime) ? metadata.mediaTime : el.currentTime;
        drawAt(mt || 0);
        vfcId = el.requestVideoFrameCallback(cb);
      };
      vfcId = el.requestVideoFrameCallback(cb);
      return () => {
        if (typeof el.cancelVideoFrameCallback === 'function' && vfcId) {
          el.cancelVideoFrameCallback(vfcId);
        }
      };
    }

    const loop = () => {
      drawAt(el.currentTime || 0);
      rafId = window.requestAnimationFrame(loop);
    };
    rafId = window.requestAnimationFrame(loop);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [activeSourceId, hasBackground, selectedStimulus, visualSubTab, isPlaying, renderOverlayAt, timeOffsetMs, isVideoBackground]);

  const resolveExportTimeRange = React.useCallback(() => {
    if (!duration) return null;
    let exportStartTime = 0;
    let exportEndTime = duration;

    if (stimulusTimeRange) {
      exportStartTime = stimulusTimeRange.startTime;
      exportEndTime = stimulusTimeRange.endTime;
      console.log('[Export] Using time range:', { start: exportStartTime, end: exportEndTime });
    }

    if (exportStartTime >= exportEndTime || exportStartTime < 0 || exportEndTime > duration) {
      console.error('[Export] Invalid time range:', { exportStartTime, exportEndTime, duration });
      return null;
    }

    return { exportStartTime, exportEndTime };
  }, [duration, stimulusTimeRange]);

  const resolveExportCanvasSize = React.useCallback(() => {
    let width = 1920;
    let height = 1080;

    if (isVideoBackground && videoRef.current) {
      const videoWidth = videoRef.current.videoWidth;
      const videoHeight = videoRef.current.videoHeight;
      if (Number.isFinite(videoWidth) && videoWidth > 0) width = videoWidth;
      if (Number.isFinite(videoHeight) && videoHeight > 0) height = videoHeight;
    }

    return {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    };
  }, [isVideoBackground]);

  const getExportSliceByTime = React.useCallback(
    (timeMs: number): HeatmapPoint[] => {
      if (!selectedRecordId || selectedRecordPointsFiltered.length === 0) {
        return [];
      }
      if (!Number.isFinite(timeMs) || timeMs < 10) {
        return [];
      }

      let startTimeMs = 0;
      let endTimeMs = timeMs;
      if (stimulusTimeRange) {
        const rangeStartMs = stimulusTimeRange.startTime * 1000;
        const rangeEndMs = stimulusTimeRange.endTime * 1000;
        if (timeMs < rangeStartMs) {
          return [];
        }
        startTimeMs = rangeStartMs;
        endTimeMs = Math.min(timeMs, rangeEndMs);
      }

      const start = lowerBoundByTimestamp(selectedRecordPointsFiltered, startTimeMs);
      const end = upperBoundByTimestamp(selectedRecordPointsFiltered, endTimeMs);
      return selectedRecordPointsFiltered.slice(start, end);
    },
    [selectedRecordId, selectedRecordPointsFiltered, stimulusTimeRange],
  );

  const drawExportOverlay = React.useCallback(
    (ctx: CanvasRenderingContext2D, width: number, height: number, slice: HeatmapPoint[]) => {
      if (slice.length === 0) return;

      const overlayCanvas = document.createElement('canvas');
      overlayCanvas.width = width;
      overlayCanvas.height = height;

      if (visualSubTab === 'heatmap') {
        if (heatmapPerspectiveEnabled) {
          drawHeatmapPerspective(overlayCanvas, slice, heatmapSettings, 'standard', true);
        } else {
          drawHeatmap(overlayCanvas, slice, heatmapSettings, true);
        }
      } else if (visualSubTab === 'gaze') {
        let maxWeight = 0;
        for (const p of slice) {
          const w = typeof p.weight === 'number' && Number.isFinite(p.weight) ? p.weight : 0;
          if (w > maxWeight) maxWeight = w;
        }
        if (maxWeight <= 0) maxWeight = 1;
        drawGazePaths(
          overlayCanvas,
          { [selectedRecordId || 'export']: slice },
          { [selectedRecordId || 'export']: '#0ea5e9' },
          1,
          maxWeight,
          gazeSettings,
          true,
        );
      } else if (visualSubTab === 'honeycomb') {
        const currentPoint = slice[slice.length - 1] || null;
        drawHoneycombCursor(overlayCanvas, currentPoint, honeycombSettings, true);
      }

      ctx.drawImage(overlayCanvas, 0, 0);
    },
    [gazeSettings, heatmapPerspectiveEnabled, heatmapSettings, honeycombSettings, selectedRecordId, visualSubTab],
  );

  const renderExportFrame = React.useCallback(
    (ctx: CanvasRenderingContext2D, width: number, height: number, videoEl: HTMLVideoElement, timeSeconds: number) => {
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(videoEl, 0, 0, width, height);
      const slice = getExportSliceByTime(timeSeconds * 1000 + timeOffsetMs);
      drawExportOverlay(ctx, width, height, slice);
    },
    [drawExportOverlay, getExportSliceByTime, timeOffsetMs],
  );

  const exportMountainCanvasVideo = async (range: { exportStartTime: number; exportEndTime: number }) => {
    const videoEl = videoRef.current;
    const mountainChart = mountainChartRef.current;
    const chartCanvas = mountainChart?.getCanvas() || null;
    if (!videoEl || !mountainChart || !chartCanvas) {
      window.alert('未找到可导出的山峰图画布');
      return;
    }
    const { exportStartTime, exportEndTime } = range;
    const exportDuration = Math.max(0.001, exportEndTime - exportStartTime);
    const taskId = `visual-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const recordName = selectedRecord?.name || 'visualization';
    const timeRangeSuffix = stimulusTimeRange
      ? `_${exportStartTime.toFixed(1)}s-${exportEndTime.toFixed(1)}s`
      : '';
    const exportBaseName = `export-${selectedRecord?.name || 'visualization'}${timeRangeSuffix}-${Date.now()}`;
    const wasPaused = videoEl.paused;
    const previousTime = Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : 0;
    let rafId = 0;
    let stream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;
    let lastProgressReportAt = 0;
    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = Math.max(1, chartCanvas.width || chartCanvas.clientWidth || 1);
    outputCanvas.height = Math.max(1, chartCanvas.height || chartCanvas.clientHeight || 1);
    const outputCtx = outputCanvas.getContext('2d');
    if (!outputCtx) {
      window.alert('山峰图视频导出初始化失败');
      return;
    }
    if (!outputCanvas.captureStream) {
      window.alert('当前环境不支持山峰图视频导出');
      return;
    }

    const reportStatus = (params: {
      phase: VideoExportStatus['phase'];
      progress: number;
      label: string;
      outputPath?: string;
    }) => {
      const progress = Math.max(0, Math.min(1, params.progress));
      if (isMountedRef.current) {
        setExportProgressPercent(Math.round(progress * 100));
      }
      onVideoExportStatusChange?.({
        taskId,
        source: 'visual',
        phase: params.phase,
        progress,
        label: params.label,
        recordName,
        outputPath: params.outputPath,
        updatedAt: Date.now(),
      });
    };

    const finishExportUi = () => {
      isExportingRef.current = false;
      if (isMountedRef.current) {
        setIsExporting(false);
        setExportProgressPercent(0);
      }
    };

    const cleanup = () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
      stream?.getTracks().forEach((track) => track.stop());
    };

    const seekVideo = (timeSeconds: number) =>
      new Promise<void>((resolve, reject) => {
        const targetTime = Math.max(0, timeSeconds);
        if (Math.abs((videoEl.currentTime || 0) - targetTime) < 0.01) {
          resolve();
          return;
        }
        let settled = false;
        const cleanupSeek = () => {
          window.clearTimeout(timeoutId);
          videoEl.removeEventListener('seeked', onSeeked);
          videoEl.removeEventListener('error', onError);
        };
        const settle = (handler: () => void) => {
          if (settled) return;
          settled = true;
          cleanupSeek();
          handler();
        };
        const onSeeked = () => {
          settle(resolve);
        };
        const onError = () => {
          settle(() => reject(new Error('导出起始位置定位失败')));
        };
        const timeoutId = window.setTimeout(() => {
          settle(resolve);
        }, 1500);
        videoEl.addEventListener('seeked', onSeeked);
        videoEl.addEventListener('error', onError);
        videoEl.currentTime = targetTime;
      });

    isExportingRef.current = true;
    setIsExporting(true);
    reportStatus({ phase: 'rendering', progress: 0, label: '视频导出准备中' });

    try {
      await seekVideo(exportStartTime);
      setCurrentTime(exportStartTime);
      setVisualCurrentTime(exportStartTime);

      outputCtx.drawImage(chartCanvas, 0, 0, outputCanvas.width, outputCanvas.height);
      stream = outputCanvas.captureStream(EXPORT_FPS);
      const videoTrack = stream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5000000 });
      const chunks: Blob[] = [];

      const stopped = new Promise<void>((resolve) => {
        if (!recorder) {
          resolve();
          return;
        }
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };
        recorder.onstop = () => resolve();
      });

      recorder.start();
      await videoEl.play();

      const stopRecording = () => {
        if (recorder && recorder.state === 'recording') {
          recorder.stop();
        }
      };

      const tick = () => {
        if (!isExportingRef.current) {
          stopRecording();
          return;
        }
        outputCtx.drawImage(chartCanvas, 0, 0, outputCanvas.width, outputCanvas.height);
        videoTrack?.requestFrame?.();
        const currentSec = Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : exportStartTime;
        const clampedSec = Math.max(exportStartTime, Math.min(exportEndTime, currentSec));
        const rawProgress = Math.max(0, Math.min(1, (clampedSec - exportStartTime) / exportDuration));
        const now = Date.now();
        if (rawProgress >= 1 || now - lastProgressReportAt > 120) {
          lastProgressReportAt = now;
          reportStatus({
            phase: 'rendering',
            progress: rawProgress * 0.9,
            label: `正在渲染帧 ${Math.round(rawProgress * 100)}%`,
          });
        }
        if (videoEl.paused || videoEl.ended || clampedSec >= exportEndTime) {
          stopRecording();
          return;
        }
        rafId = window.requestAnimationFrame(tick);
      };
      rafId = window.requestAnimationFrame(tick);

      await stopped;
      videoEl.pause();
      cleanup();
      reportStatus({ phase: 'encoding', progress: 0.92, label: '正在编码 MP4' });

      const blob = new Blob(chunks, { type: 'video/webm' });
      if (blob.size <= 0) {
        reportStatus({ phase: 'failed', progress: 1, label: '导出失败：未生成有效视频帧' });
        window.alert('导出失败：未生成有效视频帧');
        return;
      }
      let handled = false;
      let failedMessage = '快速导出失败，请检查 ffmpeg 配置后重试';
      if (ipcClient.isAvailable() && selectedRecord?.mp4Path) {
        try {
          const buffer = new Uint8Array(await blob.arrayBuffer());
          const tempWebmPath = buildTempWebmPath(selectedRecord.mp4Path, exportBaseName);
          const saveRes = await ipcClient.saveFile({
            filePath: tempWebmPath,
            content: buffer,
            ensureDir: true,
          });
          if (saveRes.ok) {
            const fastRes = await ipcClient.exportVideoFast({
              sourcePath: tempWebmPath,
              defaultName: `${exportBaseName}.mp4`,
              preserveAudio: false,
              cleanupSource: true,
              outputFps: EXPORT_FPS,
            });
            if (fastRes.ok) {
              handled = true;
              reportStatus({
                phase: 'done',
                progress: 1,
                label: '导出成功',
                outputPath: fastRes.path,
              });
              window.alert('导出成功');
            } else {
              const msg = 'message' in fastRes ? fastRes.message : undefined;
              if (msg && msg.includes('已取消')) {
                handled = true;
                reportStatus({ phase: 'failed', progress: 1, label: '导出已取消' });
              } else if (msg) {
                failedMessage = msg;
              }
            }
          } else {
            failedMessage = '临时视频写入失败';
          }
        } catch (error) {
          failedMessage = error instanceof Error ? error.message : failedMessage;
          console.error('[MountainExport] Fast export exception:', error);
        }
      } else {
        failedMessage = '当前环境不支持快速导出';
      }

      if (!handled) {
        reportStatus({ phase: 'failed', progress: 1, label: `导出失败：${failedMessage}` });
        window.alert(`导出失败：${failedMessage}`);
      }
    } catch (error) {
      console.error('[MountainExport] Export failed:', error);
      cleanup();
      const message = error instanceof Error ? error.message : '未知错误';
      reportStatus({ phase: 'failed', progress: 1, label: `导出失败：${message}` });
      window.alert(`导出失败：${message}`);
    } finally {
      videoEl.pause();
      await seekVideo(previousTime).catch(() => undefined);
      if (!wasPaused) {
        videoEl.play().catch(() => undefined);
      }
      finishExportUi();
    }
  };

  const handleExport = async () => {
    if (isExporting) return;
    if (!backgroundUrl) {
      window.alert('未找到可导出的背景视频');
      return;
    }

    const range = resolveExportTimeRange();
    if (!range) {
      window.alert('导出时间范围无效');
      return;
    }
    const { exportStartTime, exportEndTime } = range;

    if (visualSubTab === 'mountain') {
      await exportMountainCanvasVideo(range);
      return;
    }

    const { width, height } = resolveExportCanvasSize();

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const taskId = `visual-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const recordName = selectedRecord?.name || 'visualization';
    const reportStatus = (params: {
      phase: VideoExportStatus['phase'];
      progress: number;
      label: string;
      outputPath?: string;
    }) => {
      const progress = Math.max(0, Math.min(1, params.progress));
      if (isMountedRef.current) {
        setExportProgressPercent(Math.round(progress * 100));
      }
      onVideoExportStatusChange?.({
        taskId,
        source: 'visual',
        phase: params.phase,
        progress,
        label: params.label,
        recordName,
        outputPath: params.outputPath,
        updatedAt: Date.now(),
      });
    };

    setIsExporting(true);
    reportStatus({ phase: 'rendering', progress: 0, label: '视频导出准备中' });

    const timeRangeSuffix = stimulusTimeRange
      ? `_${exportStartTime.toFixed(1)}s-${exportEndTime.toFixed(1)}s`
      : '';
    const exportBaseName = `export-${selectedRecord?.name || 'visualization'}${timeRangeSuffix}-${Date.now()}`;
    const exportDuration = Math.max(0.001, exportEndTime - exportStartTime);
    let detachExportVideo: (() => void) | null = null;

    try {
      const exportVideoEl = document.createElement('video');
      exportVideoEl.preload = 'auto';
      exportVideoEl.muted = true;
      exportVideoEl.playsInline = true;
      exportVideoEl.style.position = 'fixed';
      exportVideoEl.style.left = '-99999px';
      exportVideoEl.style.top = '-99999px';
      exportVideoEl.style.width = '1px';
      exportVideoEl.style.height = '1px';
      exportVideoEl.style.opacity = '0';
      exportVideoEl.style.pointerEvents = 'none';
      document.body.appendChild(exportVideoEl);
      detachExportVideo = () => {
        if (exportVideoEl.parentNode) {
          exportVideoEl.parentNode.removeChild(exportVideoEl);
        }
      };
      exportVideoEl.src = backgroundUrl;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          exportVideoEl.removeEventListener('loadedmetadata', onLoaded);
          exportVideoEl.removeEventListener('error', onError);
        };
        const onLoaded = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error('背景视频加载失败'));
        };
        exportVideoEl.addEventListener('loadedmetadata', onLoaded);
        exportVideoEl.addEventListener('error', onError);
      });
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          exportVideoEl.removeEventListener('seeked', onSeeked);
          exportVideoEl.removeEventListener('error', onError);
        };
        const onSeeked = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error('导出起始位置定位失败'));
        };
        exportVideoEl.addEventListener('seeked', onSeeked);
        exportVideoEl.addEventListener('error', onError);
        exportVideoEl.currentTime = exportStartTime;
      });

      const stream = canvas.captureStream(EXPORT_FPS);
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5000000 });
      const chunks: Blob[] = [];
      let rafId = 0;
      let lastProgressReportAt = 0;
      const frameIntervalMs = 1000 / EXPORT_FPS;
      let lastRenderAt = 0;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = async () => {
        const finishExportUi = () => {
          if (isMountedRef.current) {
            setIsExporting(false);
            setExportProgressPercent(0);
          }
        };

        if (rafId) {
          window.cancelAnimationFrame(rafId);
          rafId = 0;
        }
        exportVideoEl.pause();
        stream.getTracks().forEach((track) => track.stop());
        detachExportVideo?.();
        reportStatus({ phase: 'encoding', progress: 0.92, label: '正在编码 MP4' });

        const blob = new Blob(chunks, { type: 'video/webm' });
        let handled = false;
        let failedMessage = '快速导出失败，请检查 ffmpeg 配置后重试';
        if (ipcClient.isAvailable() && selectedRecord?.mp4Path) {
          try {
            const buffer = new Uint8Array(await blob.arrayBuffer());
            const tempWebmPath = buildTempWebmPath(selectedRecord.mp4Path, exportBaseName);
            const saveRes = await ipcClient.saveFile({
              filePath: tempWebmPath,
              content: buffer,
              ensureDir: true,
            });
            if (saveRes.ok) {
              const fastRes = await ipcClient.exportVideoFast({
                sourcePath: tempWebmPath,
                defaultName: `${exportBaseName}.mp4`,
                preserveAudio: false,
                cleanupSource: true,
                outputFps: EXPORT_FPS,
              });
              if (fastRes.ok) {
                handled = true;
                reportStatus({
                  phase: 'done',
                  progress: 1,
                  label: '导出成功',
                  outputPath: fastRes.path,
                });
                finishExportUi();
                window.alert('导出成功');
              } else {
                const msg = 'message' in fastRes ? fastRes.message : undefined;
                if (msg && msg.includes('已取消')) {
                  handled = true;
                  reportStatus({ phase: 'failed', progress: 1, label: '导出已取消' });
                } else {
                  if (msg) failedMessage = msg;
                  console.warn('[Export] Fast overlay export failed:', fastRes);
                }
              }
            } else {
              failedMessage = '临时视频写入失败';
            }
          } catch (error) {
            failedMessage = error instanceof Error ? error.message : failedMessage;
            console.error('[Export] Fast overlay export exception:', error);
          }
        } else {
          failedMessage = '当前环境不支持快速导出';
        }

        if (!handled) {
          reportStatus({ phase: 'failed', progress: 1, label: `导出失败：${failedMessage}` });
          finishExportUi();
          window.alert(`导出失败：${failedMessage}`);
          return;
        }
        finishExportUi();
      };

      await exportVideoEl.play();
      recorder.start();

      const stopRecording = () => {
        if (recorder.state === 'recording') {
          recorder.stop();
        }
      };

      const draw = () => {
        if (!isExportingRef.current) {
          stopRecording();
          return;
        }

        const nowPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (nowPerf - lastRenderAt < frameIntervalMs) {
          rafId = window.requestAnimationFrame(draw);
          return;
        }
        lastRenderAt = nowPerf;

        const currentSec = Number.isFinite(exportVideoEl.currentTime) ? exportVideoEl.currentTime : exportStartTime;
        const clampedSec = Math.max(exportStartTime, Math.min(exportEndTime, currentSec));
        renderExportFrame(ctx, width, height, exportVideoEl, clampedSec);

        const rawProgress = Math.max(0, Math.min(1, (clampedSec - exportStartTime) / exportDuration));
        const now = Date.now();
        if (rawProgress >= 1 || now - lastProgressReportAt > 120) {
          lastProgressReportAt = now;
          reportStatus({
            phase: 'rendering',
            progress: rawProgress * 0.9,
            label: `正在渲染帧 ${Math.round(rawProgress * 100)}%`,
          });
        }

        if (exportVideoEl.paused || exportVideoEl.ended || clampedSec >= exportEndTime) {
          stopRecording();
          return;
        }

        rafId = window.requestAnimationFrame(draw);
      };

      rafId = window.requestAnimationFrame(draw);
    } catch (e) {
      console.error(e);
      detachExportVideo?.();
      const message = e instanceof Error ? e.message : '未知错误';
      reportStatus({ phase: 'failed', progress: 1, label: `导出失败：${message}` });
      if (isMountedRef.current) {
        setIsExporting(false);
        setExportProgressPercent(0);
      }
      window.alert(`导出失败：${message}`);
    }
  };

  const handleExportImage = async () => {
    if (isExporting || isExportingImage) return;
    const videoEl = videoRef.current;
    if (!videoEl) return;
    if (videoEl.readyState < 2) {
      window.alert('视频尚未准备完成，请稍后重试');
      return;
    }

    const { width, height } = resolveExportCanvasSize();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const captureTime = Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : currentTime;
    const clampedCaptureTime = Math.max(0, captureTime);
    const range = resolveExportTimeRange();
    const timeRangeSuffix = range
      ? `_${range.exportStartTime.toFixed(1)}s-${range.exportEndTime.toFixed(1)}s`
      : '';
    const captureTimeSuffix = `${clampedCaptureTime.toFixed(2)}s`;
    const exportBaseName = `export-${selectedRecord?.name || 'visualization'}${timeRangeSuffix}-${captureTimeSuffix}-${Date.now()}`;

    setIsExportingImage(true);
    try {
      if (visualSubTab === 'mountain') {
        const chartCanvas = mountainChartRef.current?.getCanvas() || null;
        if (!chartCanvas) {
          window.alert('未找到可导出的山峰图画布');
          return;
        }
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(chartCanvas, 0, 0, width, height);
      } else {
        renderExportFrame(ctx, width, height, videoEl, clampedCaptureTime);
      }
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) {
        window.alert('导出图片失败');
        return;
      }

      if (ipcClient.isAvailable()) {
        const buffer = new Uint8Array(await blob.arrayBuffer());
        const saveRes = await ipcClient.exportImageFast({
          content: buffer,
          defaultName: `${exportBaseName}.png`,
        });
        if (saveRes.ok) {
          window.alert('导出成功');
        } else {
          const msg = 'message' in saveRes ? saveRes.message : undefined;
          if (!msg || !msg.includes('已取消')) {
            window.alert(msg || '导出图片失败');
          }
        }
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${sanitizeExportName(exportBaseName)}.png`;
        link.click();
        URL.revokeObjectURL(url);
        window.alert('导出成功');
      }
    } catch (error) {
      console.error('[ExportImage] Export image failed:', error);
      window.alert('导出图片失败');
    } finally {
      setIsExportingImage(false);
    }
  };

  const handleTimelineBarClick = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!duration) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const p = Math.max(0, Math.min(1, x / rect.width));
      const clickedTime = snapTimelineDisplaySecond(p * duration);
      setSelectedSegmentId(null);
      setPlaybackSegmentId(null);
      seekTo(clickedTime);
    },
    [duration, seekTo, snapTimelineDisplaySecond],
  );

  const handleDeleteSelectedSegment = React.useCallback(() => {
    if (!selectedSegmentId) return;
    const target = orderedSegments.find((segment) => segment.id === selectedSegmentId);
    if (!target) return;
    setPendingDeleteSegment(target);
  }, [
    orderedSegments,
    selectedSegmentId,
  ]);

  const confirmDeleteSegment = React.useCallback(() => {
    if (!pendingDeleteSegment) return;
    const targetId = pendingDeleteSegment.id;
    const next = removeTimeSegment(orderedSegments, targetId, { duration });
    handleTimelineSegmentsChange(next);
    setPendingDeleteSegment(null);
    setSelectedSegmentId((prev) => (prev === targetId ? null : prev));
    if (playbackSegmentId === targetId) {
      setPlaybackSegmentId(null);
    }
  }, [duration, handleTimelineSegmentsChange, orderedSegments, pendingDeleteSegment, playbackSegmentId]);

  const handleToggleMultiSelect = React.useCallback(() => {
    if (!multiSelectEnabled) {
      if (!canEnableMultiRecordPlayback || !selectedRecordId) return;
      setVisibleRecordIds((prev) => {
        const next = new Set(prev);
        next.add(selectedRecordId);
        return next;
      });
      setMultiSelectEnabled(true);
      return;
    }

    setMultiSelectEnabled(false);
    setVisibleRecordIds(() => (selectedRecordId ? new Set([selectedRecordId]) : new Set()));
  }, [
    canEnableMultiRecordPlayback,
    multiSelectEnabled,
    selectedRecordId,
    setVisibleRecordIds,
  ]);

  const handleRecordRowClick = React.useCallback((recordId: string) => {
    setSelectedRecordId(recordId);
    if (isMultiRecordPlayback) {
      setVisibleRecordIds((prev) => {
        const next = new Set(prev);
        next.add(recordId);
        return next;
      });
      return;
    }
    setVisibleRecordIds(new Set([recordId]));
  }, [isMultiRecordPlayback, setSelectedRecordId, setVisibleRecordIds]);

  const loadMappingRecords = React.useCallback(async () => {
    if (!projectDir || !ipcClient.isAvailable()) {
      setMappingRecords([]);
      setMappingRecordsLoaded(true);
      setMappingRecordsError('当前工程目录不可用');
      return;
    }
    setMappingRecordsLoading(true);
    setMappingRecordsError(null);
    try {
      const response = await ipcClient.listGazeMappingRecords({ projectDir });
      if (!response.ok) {
        setMappingRecords([]);
        setMappingRecordsError(response.message || '加载映射记录失败');
        return;
      }
      setMappingRecords(response.records);
      setSelectedMappingPath((current) => (
        current && response.records.some((entry) => entry.outputPath === current) ? current : null
      ));
    } catch (error) {
      setMappingRecords([]);
      setMappingRecordsError(error instanceof Error ? error.message : '加载映射记录失败');
    } finally {
      setMappingRecordsLoaded(true);
      setMappingRecordsLoading(false);
    }
  }, [projectDir]);

  React.useEffect(() => {
    setRecordListMode('records');
    setMappingRecords([]);
    setMappingRecordsLoaded(false);
    setMappingRecordsError(null);
    setSelectedMappingPath(null);
  }, [projectDir]);

  const handleToggleRecordListMode = React.useCallback(() => {
    if (recordListMode === 'records') {
      recordSelectionBeforeMappingRef.current = selectedRecordId;
      setMultiSelectEnabled(false);
      setRecordListMode('mapping');
      if (!mappingRecordsLoaded) void loadMappingRecords();
      return;
    }

    setRecordListMode('records');
    const previousRecordId = recordSelectionBeforeMappingRef.current;
    if (previousRecordId && recordsById.has(previousRecordId)) {
      setSelectedRecordId(previousRecordId);
      setVisibleRecordIds(new Set([previousRecordId]));
    }
  }, [loadMappingRecords, mappingRecordsLoaded, recordListMode, recordsById, selectedRecordId, setSelectedRecordId, setVisibleRecordIds]);

  const handleMappingRecordClick = React.useCallback(async (entry: MappingRecordEntry) => {
    setSelectedMappingPath(entry.outputPath);
    setMultiSelectEnabled(false);
    const linkedRecord = records.find((record) => record.id === entry.result.recordId)
      || records.find((record) => record.mp4Path && record.mp4Path === entry.result.videoPath)
      || records.find((record) => getDisplayRecordName(record) === entry.result.recordName);
    if (linkedRecord) {
      setSelectedRecordId(linkedRecord.id);
      setVisibleRecordIds(new Set([linkedRecord.id]));
    }
    if (!projectDir || entry.result.gazeData.length > 0) return;
    setMappingRecordsLoading(true);
    setMappingRecordsError(null);
    try {
      const response = await ipcClient.loadGazeMappingRecord({ projectDir, outputPath: entry.outputPath });
      if (!response.ok || !response.record) {
        setMappingRecordsError(response.message || '加载映射记录失败');
        return;
      }
      setMappingRecords((current) => current.map((item) => (
        item.outputPath === response.record?.outputPath ? response.record : item
      )));
    } catch (error) {
      setMappingRecordsError(error instanceof Error ? error.message : '加载映射记录失败');
    } finally {
      setMappingRecordsLoading(false);
    }
  }, [projectDir, records, setSelectedRecordId, setVisibleRecordIds]);

  const handleRecordVisibilityChange = React.useCallback((recordId: string, nextChecked: boolean) => {
    if (!isMultiRecordPlayback) {
      setSelectedRecordId(recordId);
      setVisibleRecordIds(nextChecked ? new Set([recordId]) : new Set());
      return;
    }

    if (nextChecked) {
      setVisibleRecordIds((prev) => {
        const next = new Set(prev);
        next.add(recordId);
        return next;
      });
      return;
    }

    let fallbackSelectedId: string | null = null;
    setVisibleRecordIds((prev) => {
      const next = new Set(prev);
      if (!next.has(recordId)) return prev;
      if (selectedRecordId === recordId && next.size <= 1) {
        return prev;
      }
      next.delete(recordId);
      if (selectedRecordId === recordId) {
        const fallback = next.values().next();
        fallbackSelectedId = fallback.done ? null : String(fallback.value);
      }
      return next;
    });
    if (fallbackSelectedId) {
      setSelectedRecordId(fallbackSelectedId);
    }
  }, [isMultiRecordPlayback, selectedRecordId, setSelectedRecordId, setVisibleRecordIds]);

  const handleClearTimelineTimeRange = React.useCallback(() => {
    setCustomTimeRange(null);
  }, []);

  const handleTimelineReset = React.useCallback(() => {
    setCustomTimeRange(null);
    setVisualSelectedStimulusId(null);
    setSelectedSegmentId(null);
    setTimeout(() => {
      const el = videoRef.current;
      if (el) {
        try {
          el.currentTime = 0;
          setCurrentTime(0);
          setVisualCurrentTime(0);
        } catch {}
      }
    }, 50);
  }, [setVisualSelectedStimulusId]);

  const visiblePlaybackRanges = React.useMemo(() => {
    const normalizeRange = (startTime: number, endTime: number, id: string) => {
      const start = Math.max(0, Math.min(duration, Math.min(startTime, endTime)));
      const end = Math.max(0, Math.min(duration, Math.max(startTime, endTime)));
      if (end <= start) return null;
      return { id, startTime: start, endTime: end };
    };

    if (duration <= 0) return [];

    if (shouldPlayBySegments && orderedSegments.length > 0) {
      return orderedSegments
        .map((segment) => normalizeRange(segment.startTime, segment.endTime, segment.id))
        .filter(Boolean) as Array<{ id: string; startTime: number; endTime: number }>;
    }

    if (customTimeRange) {
      const range = normalizeRange(customTimeRange.startTime, customTimeRange.endTime, 'custom-range');
      return range ? [range] : [];
    }

    if (effectiveSegment) {
      const range = normalizeRange(effectiveSegment.startTime, effectiveSegment.endTime, effectiveSegment.id);
      return range ? [range] : [];
    }

    if (stimulusTimeRange) {
      const range = normalizeRange(stimulusTimeRange.startTime, stimulusTimeRange.endTime, 'stimulus-range');
      return range ? [range] : [];
    }

    return [];
  }, [customTimeRange, duration, effectiveSegment, orderedSegments, shouldPlayBySegments, stimulusTimeRange]);

  const hideOutOfRangeTimeline = isPlaying && visiblePlaybackRanges.length > 0;

  const visibleSegmentIdsForTimeline = React.useMemo(() => {
    if (!hideOutOfRangeTimeline) return null;
    if (shouldPlayBySegments) {
      return new Set(orderedSegments.map((segment) => segment.id));
    }
    if (effectiveSegment) {
      return new Set([effectiveSegment.id]);
    }
    return new Set<string>();
  }, [hideOutOfRangeTimeline, shouldPlayBySegments, orderedSegments, effectiveSegment]);

  const timelineAnalysisNode = React.useMemo(() => {
    const timelineDuration = isGlassesMode && !isMappingMode ? recordingVideoStimulus?.endTime ?? 0 : duration;
    if (!(selectedRecordId && timelineDuration > 0)) return null;
    return (
      <TimelineAnalysis
        duration={timelineDuration}
        currentTime={currentTime}
        stimuli={stimuli}
        recordingVideoStimulus={recordingVideoStimulus}
        points={timelinePoints}
        customMarkers={customMarkers}
        showMarkTrack={showMarkTrack}
        showTriggerTrack={showTriggerTrack}
        segments={timelineSegments}
        selectedSegmentId={selectedSegmentId}
        onSegmentsChange={handleTimelineSegmentsChange}
        onSegmentSelect={setSelectedSegmentId}
        onSeek={seekTo}
        selectedStimulusName={selectedStimulusForAnalysis?.name || null}
        onTimeRangeChange={handleTimeRangeChange}
        onClearTimeRange={handleClearTimelineTimeRange}
        onReset={handleTimelineReset}
      />
    );
  }, [
    currentTime,
    customMarkers,
    duration,
    isGlassesMode,
    isMappingMode,
    recordingVideoStimulus,
    handleClearTimelineTimeRange,
    handleTimeRangeChange,
    handleTimelineReset,
    handleTimelineSegmentsChange,
    seekTo,
    selectedRecordId,
    selectedSegmentId,
    selectedStimulusForAnalysis?.name,
    showMarkTrack,
    showTriggerTrack,
    stimuli,
    timelinePoints,
    timelineSegments,
  ]);

  return (
    <div className="h-full flex gap-3 overflow-hidden">
      <div className="flex-1 flex flex-col bg-white rounded-2xl overflow-hidden border border-slate-200">
        <div className="h-12 border-b border-slate-100 flex items-center justify-center gap-8 text-xs font-bold text-slate-500 bg-slate-50/80">
          {(['heatmap', 'gaze', 'honeycomb', 'mountain'] as const).map((tab) => (
            <button
              key={tab}
              aria-pressed={visualSubTab === tab}
              onClick={() => setVisualSubTab(tab)}
              className={`mrt-button-tab px-4 h-full relative border-b-2 transition-all ${
                visualSubTab === tab ? 'border-sky-500 text-sky-600' : 'border-transparent hover:text-slate-600'
              }`}
            >
              {tab === 'heatmap' ? '热图' : tab === 'gaze' ? '注视轨迹' : tab === 'honeycomb' ? '蜂窝图' : '山峰图'}
            </button>
          ))}
        </div>

        <div
          className={
            hasBackground ? 'flex-1 relative bg-black overflow-hidden' : 'flex-1 relative flex items-center justify-center p-8 bg-slate-50 overflow-hidden'
          }
        >
          {hasBackground ? (
            <div className="absolute inset-0 w-full h-full flex items-center justify-center">
              <div ref={videoWrapRef} className="relative w-full h-full bg-black">
                <video
                  key={`${backgroundUrl || ''}|${activeSourceId || ''}`}
                  ref={videoRef}
                  src={backgroundUrl || undefined}
                  onLoadedMetadata={(e) => {
                    const el = e.currentTarget;
                    if (!isMappingMode && resolvedRecordVideoUrl
                      && recordVideoOwnerRef.current?.recordKey === recordVideoKey
                      && recordVideoOwnerRef.current.url === resolvedRecordVideoUrl
                      && el.getAttribute('src') === resolvedRecordVideoUrl) {
                      setLoadedRecordVideo({ recordKey: recordVideoKey, url: resolvedRecordVideoUrl, duration: el.duration });
                    }
                    setDuration(Number.isFinite(el.duration) ? el.duration : 0);
                    setCurrentTime(el.currentTime || 0);
                    setVisualCurrentTime(el.currentTime || 0);
                    setIsPlaying(!el.paused && !el.ended);
                    if (!isMappingMode) {
                      setVideoSize({ w: el.videoWidth || 0, h: el.videoHeight || 0 });
                    }
                  }}
                  onTimeUpdate={(e) => {
                    const el = e.currentTarget;
                    const mediaTime = el.currentTime || 0;
                    const recentSeek = lastManualSeekRef.current;
                    if (
                      recentSeek &&
                      duration > 0 &&
                      recentSeek.time < duration - 0.75 &&
                      mediaTime >= duration - 0.25 &&
                      performance.now() - recentSeek.requestedAtMs < 2500
                    ) {
                      try {
                        el.currentTime = recentSeek.time;
                      } catch {
                      }
                      setCurrentTime(recentSeek.time);
                      setVisualCurrentTime(recentSeek.time);
                      setIsPlaying(false);
                      return;
                    }
                    setCurrentTime(mediaTime);
                    setVisualCurrentTime(mediaTime);
                  }}
                  onSeeked={(e) => {
                    const el = e.currentTarget;
                    const mediaTime = el.currentTime || 0;
                    const recentSeek = lastManualSeekRef.current;
                    if (
                      recentSeek &&
                      duration > 0 &&
                      recentSeek.time < duration - 0.75 &&
                      mediaTime >= duration - 0.25 &&
                      performance.now() - recentSeek.requestedAtMs < 2500
                    ) {
                      try {
                        el.currentTime = recentSeek.time;
                      } catch {
                      }
                      setCurrentTime(recentSeek.time);
                      setVisualCurrentTime(recentSeek.time);
                      setIsPlaying(false);
                      return;
                    }
                    setCurrentTime(mediaTime);
                    setVisualCurrentTime(mediaTime);
                  }}
                  onPlay={(e) => {
                    setVisualCurrentTime(e.currentTarget.currentTime || 0);
                    setIsPlaying(!e.currentTarget.paused && !e.currentTarget.ended);
                  }}
                  onPause={() => {
                    const el = videoRef.current;
                    if (el) {
                      setVisualCurrentTime(el.currentTime || 0);
                    }
                    setIsPlaying(false);
                  }}
                  onEnded={() => {
                    const el = videoRef.current;
                    const recentSeek = lastManualSeekRef.current;
                    if (
                      el &&
                      recentSeek &&
                      duration > 0 &&
                      recentSeek.time < duration - 0.75 &&
                      performance.now() - recentSeek.requestedAtMs < 2500
                    ) {
                      try {
                        el.currentTime = recentSeek.time;
                      } catch {
                      }
                      setCurrentTime(recentSeek.time);
                      setVisualCurrentTime(recentSeek.time);
                      setIsPlaying(false);
                      return;
                    }
                    const endedTime = el && Number.isFinite(el.duration) && el.duration > 0
                      ? el.duration
                      : duration;
                    setCurrentTime(endedTime || 0);
                    setVisualCurrentTime(endedTime || 0);
                    setIsPlaying(false);
                  }}
                  className={`absolute inset-0 w-full h-full object-contain ${mappingImageUrl ? 'opacity-0' : ''}`}
                />

                {mappingImageUrl && (
                  <img
                    src={mappingImageUrl}
                    alt="映射底图"
                    className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                  />
                )}
                
                {visualSubTab === 'heatmap' && <canvas ref={heatmapCanvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />}
                {(visualSubTab === 'gaze' || visualSubTab === 'honeycomb') && (
                  <canvas ref={gazeCanvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
                )}
                {visualSubTab === 'mountain' && hasBackground && (
                  <div className="absolute inset-0 w-full h-full">
                    <React.Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-slate-400">正在加载 3D 山峰图…</div>}>
                      <MountainChart
                        ref={mountainChartRef}
                        videoElement={videoRef.current}
                        imageUrl={mappingImageUrl}
                        videoSize={activeFrameSize.w > 0 ? activeFrameSize : null}
                        points={selectedRecordPointsAligned}
                        currentTime={visualCurrentTime * 1000}
                        settings={mountainSettings}
                        backgroundColor={mountainBgColor}
                      />
                    </React.Suspense>
                  </div>
                )}
              </div>
              
              {/* Overlays for loading/error/empty */}
              {visualSubTab === 'heatmap' && (
                <>
                  {isHeatmapLoading && (
                    <div className="absolute top-4 right-4 px-2 py-1 rounded bg-black/60 text-[11px] text-white">
                      正在加载热图数据...
                    </div>
                  )}
                  {heatmapError && (
                    <div className="absolute top-4 left-4 px-2 py-1 rounded bg-rose-500/80 text-[11px] text-white">
                      {heatmapError}
                    </div>
                  )}
                  {activeSourceId &&
                    (isMultiRecordPlayback ? multiRecordRenderablePointsCount === 0 : selectedRecordRenderablePointsCount === 0) &&
                    !isHeatmapLoading &&
                    !heatmapError && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="flex flex-col items-center gap-2 text-slate-500">
                        <BarChart2 size={36} className="text-slate-300" />
                        <div className="text-xs">
                          {isMultiRecordPlayback
                            ? (isGlassesMode ? '当前已选记录暂无热图数据' : '当前已选记录在该刺激物下暂无热图数据')
                            : isMappingMode ? '当前映射记录暂无可视化数据' : '当前选择记录暂无热图数据'}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
              {visualSubTab === 'gaze' && (
                <>
                  {isGazeLoading && (
                    <div className="absolute top-4 right-4 px-2 py-1 rounded bg-black/60 text-[11px] text-white">
                      正在加载轨迹数据...
                    </div>
                  )}
                  {heatmapError && (
                    <div className="absolute top-4 left-4 px-2 py-1 rounded bg-rose-500/80 text-[11px] text-white">
                      {heatmapError}
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <div className="flex flex-col items-center gap-2 text-slate-500">
                <BarChart2 size={36} className="text-slate-300" />
                <div className="text-xs">
                  点击右侧记录可预览视频
                </div>
              </div>
            </div>
          )}
        </div>

        {hasBackground && (
          <div className="border-t border-slate-200 bg-white px-4 py-3 text-[10px] text-slate-500 flex flex-col gap-3">
            {duration > 0 && (
            <div
              className="relative h-4 w-full cursor-pointer group flex items-center"
              onClick={handleTimelineBarClick}
            >
              <div
                className={`absolute w-full h-1 rounded-full overflow-hidden ${
                  hideOutOfRangeTimeline ? '' : 'bg-slate-200'
                }`}
              >
                {!hideOutOfRangeTimeline && stimulusTimeRange && (
                  <>
                    {/* Show inactive regions in darker color */}
                    <div
                      className="absolute h-full bg-slate-300"
                      style={{ 
                        left: 0, 
                        width: `${(stimulusTimeRange.startTime / duration) * 100}%` 
                      }}
                    />
                    <div
                      className="absolute h-full bg-slate-300"
                      style={{ 
                        left: `${(stimulusTimeRange.endTime / duration) * 100}%`, 
                        width: `${((duration - stimulusTimeRange.endTime) / duration) * 100}%` 
                      }}
                    />
                  </>
                )}
                {hideOutOfRangeTimeline &&
                  visiblePlaybackRanges.map((range) => {
                    const left = duration > 0 ? (range.startTime / duration) * 100 : 0;
                    const width = duration > 0 ? ((range.endTime - range.startTime) / duration) * 100 : 0;
                    const safeSpan = Math.max(0.001, range.endTime - range.startTime);
                    const progressRatio = Math.max(0, Math.min(1, (visualCurrentTime - range.startTime) / safeSpan));
                    return (
                      <div
                        key={`play-range-${range.id}`}
                        className="absolute h-full rounded-full bg-slate-200 overflow-hidden"
                        style={{ left: `${left}%`, width: `${Math.max(width, 0.2)}%` }}
                      >
                        <div
                          className="h-full bg-sky-500"
                          style={{ width: `${progressRatio * 100}%` }}
                        />
                      </div>
                    );
                  })}
                {orderedSegments.map((segment) => {
                  if (visibleSegmentIdsForTimeline && !visibleSegmentIdsForTimeline.has(segment.id)) {
                    return null;
                  }
                  const left = duration > 0 ? (segment.startTime / duration) * 100 : 0;
                  const width = duration > 0 ? ((segment.endTime - segment.startTime) / duration) * 100 : 0;
                  const selected = selectedSegmentId === segment.id;
                  return (
                    <button
                      key={segment.id}
                      type="button"
                      data-visual-control="timeline-segment"
                      data-i18n-skip="true"
                      className={`absolute h-full rounded border ${
                        selected ? 'border-emerald-600 bg-emerald-400/70' : 'border-emerald-400 bg-emerald-300/55'
                      }`}
                      style={{ left: `${left}%`, width: `${Math.max(width, 0.2)}%` }}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedSegmentId(segment.id);
                        setPlaybackSegmentId(null);
                        seekTo(snapTimelineDisplaySecond(segment.startTime), true);
                      }}
                      title={`${segment.name} (${formatTime(segment.startTime)} - ${formatTime(segment.endTime)})`}
                    />
                  );
                })}
                {!hideOutOfRangeTimeline && (
                  <div
                    className="h-full bg-sky-500"
                    style={{ width: `${Math.min(100, Math.max(0, (visualCurrentTime / duration) * 100))}%` }}
                  />
                )}
              </div>
              <div
                className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white border-2 border-sky-500 rounded-full shadow-sm z-20 group-hover:scale-125 transition-transform pointer-events-none"
                style={{ left: `${Math.min(100, Math.max(0, (visualCurrentTime / duration) * 100))}%` }}
              />
              {selectedSegment && (
                <button
                  type="button"
                  className="absolute -top-5 text-[9px] px-2 py-0.5 rounded bg-rose-500 text-white hover:bg-rose-600 shadow"
                  style={{ left: `${Math.min(96, (selectedSegment.endTime / duration) * 100)}%` }}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleDeleteSelectedSegment();
                  }}
                >
                  删除
                </button>
              )}
            </div>
            )}
            
            <div className="flex items-center justify-between">
              <div className="flex-1 flex items-center justify-start gap-2">
                {visualSubTab !== 'mountain' && (
                <button
                  onClick={handleExport}
                  disabled={isExporting || isExportingImage || !hasBackground}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[10px] font-medium transition-colors ${
                    hasBackground && !isExporting && !isExportingImage
                      ? 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-sky-600'
                      : 'bg-slate-50 border-slate-100 text-slate-300 cursor-not-allowed'
                  }`}
                >
                  {isExporting ? (
                    <SpinnerRing
                      className="w-3 h-3 border-2 border-slate-300 border-t-sky-500 rounded-full mrt-spinner"
                      style={{ animation: 'mrt-spin 0.8s linear infinite' }}
                    />
                  ) : (
                    <Download size={12} />
                  )}
                  <span>{isExporting ? <>导出中 <span className="inline-block min-w-[4ch] text-right font-mono tabular-nums">{exportProgressPercent}%</span></> : '导出视频'}</span>
                </button>
                )}
                <button
                  onClick={handleExportImage}
                  disabled={isExporting || isExportingImage || !hasBackground}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[10px] font-medium transition-colors ${
                    hasBackground && !isExporting && !isExportingImage
                      ? 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-sky-600'
                      : 'bg-slate-50 border-slate-100 text-slate-300 cursor-not-allowed'
                  }`}
                >
                  {isExportingImage ? (
                    <SpinnerRing
                      className="w-3 h-3 border-2 border-slate-300 border-t-sky-500 rounded-full mrt-spinner"
                      style={{ animation: 'mrt-spin 0.8s linear infinite' }}
                    />
                  ) : (
                    <Download size={12} />
                  )}
                  <span>{isExportingImage ? '导出中...' : '导出图片'}</span>
                </button>
              </div>
              
              <div className="flex items-center justify-center gap-3">
                <button
                  disabled={!hasBackground}
                  onClick={() => seekTo(stimulusTimeRange ? snapTimelineDisplaySecond(stimulusTimeRange.startTime) : 0)}
                  className={`w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center shadow-sm ${
                    hasBackground ? 'text-slate-600 hover:bg-slate-50' : 'text-slate-300'
                  }`}
                  title={stimulusTimeRange ? '跳到刺激物开始' : '跳到开始'}
                >
                  <SkipBack size={14} />
                </button>
                <button
                  disabled={!hasBackground}
                  onClick={() => seekBy(-frameStep)}
                  className={`w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center shadow-sm ${
                    hasBackground ? 'text-slate-600 hover:bg-slate-50' : 'text-slate-300'
                  }`}
                >
                  <Rewind size={14} />
                </button>
                <button
                  disabled={!hasBackground}
                  onClick={togglePlay}
                  className={`w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center shadow-sm ${
                    hasBackground ? 'text-slate-700 hover:bg-slate-50' : 'text-slate-300'
                  }`}
                >
                  {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <button
                  disabled={!hasBackground}
                  onClick={() => seekBy(frameStep)}
                  className={`w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center shadow-sm ${
                    hasBackground ? 'text-slate-600 hover:bg-slate-50' : 'text-slate-300'
                  }`}
                >
                  <FastForward size={14} />
                </button>
                <button
                  disabled={!hasBackground}
                  onClick={() => seekTo(snapTimelineDisplaySecond(stimulusTimeRange ? stimulusTimeRange.endTime : (duration || 0)))}
                  className={`w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center shadow-sm ${
                    hasBackground ? 'text-slate-600 hover:bg-slate-50' : 'text-slate-300'
                  }`}
                  title={stimulusTimeRange ? '跳到刺激物结束' : '跳到结束'}
                >
                  <SkipForward size={14} />
                </button>
              </div>
              <div className="flex-1 flex items-center justify-end gap-4 text-slate-500">
                <span className="whitespace-nowrap font-mono tabular-nums">
                  {formatTime(visualCurrentTime)} / {formatTime(duration)}
                </span>
              </div>
            </div>
          </div>
        )}
        
        {/* Timeline Analysis - Always show when there's a selected record */}
        {timelineAnalysisNode}
      </div>

      <Modal
        isOpen={Boolean(pendingDeleteSegment)}
        onClose={() => setPendingDeleteSegment(null)}
        title="删除分段"
        maxWidthClassName="max-w-md"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <button
              onClick={() => setPendingDeleteSegment(null)}
              className={btnSecondary}
            >
              取消
            </button>
            <button
              onClick={confirmDeleteSegment}
              className={btnDanger}
            >
              删除
            </button>
          </div>
        }
      >
        <div className="text-sm leading-relaxed text-slate-600 break-words">
          {pendingDeleteSegment
            ? `确认删除分段“${pendingDeleteSegment.name}”吗？`
            : '确认删除该分段吗？'}
        </div>
      </Modal>

      <div className="w-[300px] bg-white rounded-xl border border-slate-200 flex flex-col overflow-y-auto shadow-sm">
        <VisualSettingsPanel
          stimuli={stimuli}
          selectedStimulusId={visualSelectedStimulusId}
          isGlassesMode={isGlassesMode}
          recordingVideoName={isMappingMode ? undefined : recordingVideoStimulus?.name || selectedRecord?.name}
          isMappingMode={isMappingMode}
          visualSubTab={visualSubTab}
          showMarkTrack={showMarkTrack}
          showTriggerTrack={showTriggerTrack}
          gazeSettings={gazeSettings}
          honeycombSettings={honeycombSettings}
          mountainSettings={mountainSettings}
          heatmapSettings={heatmapSettings}
          heatmapPerspectiveEnabled={heatmapPerspectiveEnabled}
          isEn={isEn}
          onSelectedStimulusIdChange={setVisualSelectedStimulusId}
          onShowMarkTrackChange={setShowMarkTrack}
          onShowTriggerTrackChange={setShowTriggerTrack}
          onGazeSettingsChange={setGazeSettings}
          onHoneycombSettingsChange={setHoneycombSettings}
          onMountainSettingsChange={setMountainSettings}
          onHeatmapSettingsChange={setHeatmapSettings}
          onHeatmapPerspectiveEnabledChange={setHeatmapPerspectiveEnabled}
          onResetMountainCamera={() => mountainChartRef.current?.resetCamera()}
        />

        <div className="shrink-0 p-3 space-y-3">
          <div>
            <div className="mb-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xs font-semibold text-slate-700 flex items-center gap-1">
                  {recordListMode === 'mapping' ? <Route size={14} /> : <Monitor size={14} />}
                  {recordListMode === 'mapping' ? '映射记录' : '记录列表'}
                </h3>
                <button
                  type="button"
                  onClick={handleToggleRecordListMode}
                  className="inline-flex min-h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:border-sky-300 hover:text-sky-600"
                >
                  {recordListMode === 'mapping' ? <Monitor size={12} /> : <Route size={12} />}
                  {recordListMode === 'mapping' ? '返回记录' : '映射描点'}
                </button>
              </div>
              {recordListMode === 'records' ? (
                <>
                  <div className="flex items-center justify-between gap-2 text-[11px] text-slate-600">
                    <span>开启多选</span>
                    <Switch
                      checked={multiSelectEnabled}
                      aria-label={isEn ? 'Enable multi-select' : '开启多选'}
                      disabled={!canEnableMultiRecordPlayback}
                      onClick={handleToggleMultiSelect}
                      title={isEn ? 'Enable multi-select' : '开启多选'}
                    />
                  </div>
                  <div className="text-[11px] leading-relaxed text-slate-500">
                    {isGlassesMode
                      ? '开启后可叠加多条记录，按整段视频进行对比。'
                      : '开启后可叠加多条记录，但需先在上方选择一条刺激物材料。'}
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-between text-[11px] leading-relaxed text-slate-500">
                  <span>选择映射记录后加载四类可视化</span>
                  <button
                    type="button"
                    onClick={() => void loadMappingRecords()}
                    disabled={mappingRecordsLoading}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-slate-100 disabled:opacity-50"
                    title={isEn ? 'Refresh mapping records' : '刷新映射记录'}
                    aria-label={isEn ? 'Refresh mapping records' : '刷新映射记录'}
                  >
                    <RefreshCw size={12} className={mappingRecordsLoading ? 'animate-spin' : ''} />
                  </button>
                </div>
              )}
            </div>
            {recordListMode === 'mapping' ? (
              mappingRecordsLoading ? (
                <div className="flex items-center justify-center gap-2 py-8 text-[11px] text-slate-400">
                  <LoaderCircle size={14} className="animate-spin" /> 正在加载映射记录...
                </div>
              ) : mappingRecordsError ? (
                <div className="rounded-lg bg-rose-50 p-3 text-[11px] text-rose-500">{mappingRecordsError}</div>
              ) : mappingRecords.length === 0 ? (
                <div className="text-[11px] text-slate-400">暂无映射记录，请先在映射描点模块生成数据</div>
              ) : (
                <div className="space-y-1">
                  {mappingRecords.map((entry) => {
                    const active = selectedMappingPath === entry.outputPath;
                    const rate = Math.round(Number(entry.result.summary?.mappingRate || 0) * 100);
                    return (
                      <button
                        key={entry.outputPath}
                        type="button"
                        aria-pressed={active}
                        onClick={() => void handleMappingRecordClick(entry)}
                        className={`w-full flex items-center gap-3 rounded-lg border p-2 text-left transition-all ${
                          active ? 'bg-sky-50 border-sky-200' : 'border-transparent hover:border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <div className="h-10 w-14 shrink-0 overflow-hidden rounded bg-slate-100">
                          {entry.result.imageUrl ? (
                            <img src={entry.result.imageUrl} alt="映射底图" className="h-full w-full object-cover" />
                          ) : (
                            <div className="grid h-full w-full place-items-center text-slate-300"><Route size={16} /></div>
                          )}
                        </div>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium text-slate-700" title={entry.result.recordName || entry.result.video?.name || (isEn ? 'Unnamed mapping record' : '未命名映射记录')}>
                            {entry.result.recordName || entry.result.video?.name || '未命名映射记录'}
                          </span>
                          <span className="block text-[11px] text-slate-500">
                            <span className="font-mono tabular-nums">{entry.result.summary?.mappedPoints?.toLocaleString() || 0}</span> 点 · 成功率 <span className="font-mono tabular-nums">{rate}%</span>
                          </span>
                        </span>
                        <input type="radio" readOnly tabIndex={-1} checked={active} className="pointer-events-none h-4 w-4 accent-sky-500" />
                      </button>
                    );
                  })}
                </div>
              )
            ) : records.length === 0 ? (
              <div className="text-[11px] text-slate-400">暂无记录，请先在录制模块生成数据</div>
            ) : (
              <div className="space-y-1">
                {records.map((r) => {
                  const isPrimary = selectedRecordId === r.id;
                  const checked = isPrimary || (isMultiRecordPlayback && visibleRecordIds.has(r.id));
                  const canToggle = isMultiRecordPlayback && !isPrimary;
                  return (
                    <div
                      key={r.id}
                      style={{ contentVisibility: 'auto', containIntrinsicSize: '52px' }}
                      className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-all border ${
                        isPrimary
                          ? 'bg-sky-50 border-sky-200'
                          : 'hover:bg-slate-50 border-transparent hover:border-slate-200'
                      }`}
                      onClick={() => handleRecordRowClick(r.id)}
                    >
                      <div
                        className={`w-2.5 h-2.5 shrink-0 rounded bg-emerald-500 ${checked ? 'opacity-100' : 'opacity-30'} transition-opacity`}
                      />
                      <div className="min-w-0 flex-1 overflow-hidden">
                        <div className="text-xs font-medium truncate text-slate-700" title={getDisplayRecordName(r)}>{getDisplayRecordName(r)}</div>
                        <div className="text-[11px] font-mono tabular-nums text-slate-500">{r.duration}</div>
                      </div>
                      <input
                        type="checkbox"
                        className={`accent-sky-500 rounded w-4 h-4 ${
                          canToggle ? 'cursor-pointer' : 'cursor-not-allowed'
                        }`}
                        checked={checked}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          e.stopPropagation();
                          if (!canToggle) return;
                          handleRecordVisibilityChange(r.id, e.target.checked);
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default VisualPage;
