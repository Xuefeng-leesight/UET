import Switch from '@/shared/ui/Switch';
import React from 'react';
import { ChevronDown, Download, FastForward, Maximize, Monitor, MousePointer2, Pause, Play, Rewind, SkipBack, SkipForward, X } from 'lucide-react';
import { Modal } from '@/shared/ui/Modal';
import { btnDanger, btnSecondary } from '@/shared/ui/buttonClasses';
import type { RecordingRecord } from '@shared/contracts/domain/models';
import type { TimeSegment } from '@shared/domain/timeline';
import { normalizeTimeSegments, removeTimeSegment } from '@shared/domain/timeline';
import { resolveRecordingVideoStimulus } from '@shared/domain/recordingStimulus';
import type { ExtendedStimulus, HeatmapPoint, CustomMarker } from '@/shared/types/mrt';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import { computeAoiStatsRows, type AoiStatsRow, type NormalizedAoiShape } from '@shared/domain/aoi/aoiReport';
import { recordDataService } from '@/features/records/RecordDataService';
import type { AoiAnalysisTimeRange, AoiShape } from '@shared/domain/aoi/aoiTypes';
import {
  findNearbyKeyframeTime,
  getAoiGeometrySnapshot,
  removeAoiKeyframe,
  resolveAoiShapeAtTime,
  sortAoiKeyframes,
  upsertAoiKeyframe,
} from '@shared/domain/aoi/aoiMotion';
import { useTimeOffsetMs } from '@/features/analysis/time-offset/useTimeOffset';
import {
  KEYFRAME_EDIT_TOLERANCE_MS,
  RECORD_POINT_ID_SHIFT,
  aggregateAoiStatsRows,
  extractStimulusTimelinePointsFromHeatmapPoints,
  isEditableElement,
  normalizeAoiAnalysisTimeRanges,
  normalizePointsToDurationMs,
  normalizeStimulusKey,
  normalizeStimulusTimelineRowsToDurationMs,
  resolveRecordDurationMs,
  resolveAoiPlaybackStimulusSpan,
  type LoadedAoiRecordData,
  type RecordScopedHeatmapPoint,
  type StimulusPlaybackSpan,
  type StimulusTimelinePoint,
} from '@/features/analysis/aoi/aoiAnalysisModel';
import { TimelineAnalysis } from '@/features/records/TimelineAnalysis';
import WebStimulusFrame, { isWebStimulusUrl } from '@/features/stimuli/WebStimulusFrame';
import { filterBySegments, useFilteredData } from '@/features/records/useFilteredData';
import { getDisplayRecordName } from '@/features/records/domain/recordDisplayName';
import { getRecordingFrameSizeOptions } from '@/features/records/domain/recordFrameSize';
import { useLanguage } from '@/app/i18n/useLanguage';
import { isStimulusAudioUrl, isStimulusVideoUrl } from '@/features/stimuli/domain/mediaTypes';
import { AoiCanvasToolbar } from '@/features/analysis/aoi/AoiCanvasToolbar';
import type { GridMetric, GridMetricOption } from '@/features/analysis/aoi/aoiMetrics';
import { AoiBasicSettingsPanel } from '@/features/analysis/aoi/AoiBasicSettingsPanel';
import { parseAoiStore } from '@/features/analysis/aoi/aoiPersistence';
import { AoiKeyframePanel } from '@/features/analysis/aoi/AoiKeyframePanel';
import { AoiStatisticsMetricPicker, AoiStatisticsPanel } from '@/features/analysis/aoi/AoiStatisticsPanel';
import { AoiShapeListPanel } from '@/features/analysis/aoi/AoiShapeListPanel';

interface AoiPageProps {
  aoiTool: 'ellipse' | 'rect' | 'polygon' | null;
  aoiDrawing: boolean;
  aoiSelectedId: string | null;
  setAoiSelectedId: (next: string | null) => void;
  aoiShapes: AoiShape[];
  setAoiShapes: React.Dispatch<React.SetStateAction<AoiShape[]>>;
  aoiDraft: AoiShape | null;
  aoiCursor: { x: number; y: number } | null;
  aoiCanvasRef: React.RefObject<HTMLDivElement | null>;
  aoiVideoRef: React.RefObject<HTMLVideoElement | null>;
  aoiSelectedStimulusId: string | null;
  setAoiSelectedStimulusId: (next: string | null) => void;
  aoiSelectedRecordId: string | null;
  setAoiSelectedRecordId: (next: string | null) => void;
  aoiVideoUrl: string | null;
  aoiSyncVideoMeta: (meta: { w: number; h: number; durationMs?: number | null }) => void;
  aoiClearVideoMeta: () => void;
  stimuli: ExtendedStimulus[];
  records: RecordingRecord[];
  aoiStartDraw: (tool: 'ellipse' | 'rect' | 'polygon') => void;
  aoiOnMouseDown: React.MouseEventHandler<HTMLDivElement>;
  aoiOnMouseMove: React.MouseEventHandler<HTMLDivElement>;
  aoiOnMouseUp: React.MouseEventHandler<HTMLDivElement>;
  aoiRename: (id: string, name: string) => void;
  aoiOpacity: number;
  setAoiOpacity: (v: number) => void;
  aoiBorderWidth: number;
  setAoiBorderWidth: (v: number) => void;
  aoiFontSize: number;
  setAoiFontSize: (v: number) => void;
  aoiShowName: boolean;
  setAoiShowName: React.Dispatch<React.SetStateAction<boolean>>;
  aoiColorDefs: Record<string, { border: string; fill: (alpha: number) => string; dot: string }>;
  selectedAoi: AoiShape | null;
  aoiOnContextMenu?: React.MouseEventHandler<HTMLDivElement>;
  customMarkers?: CustomMarker[];
  projectDir?: string;
  onRecordTimelineSegmentsChange?: (recordId: string, segments: TimeSegment[]) => void;
}

type AoiEditHandle =
  | { shapeId: string; targetTimeMs: number; shapeType: 'rect'; rectCorner: 'nw' | 'ne' | 'se' | 'sw' }
  | { shapeId: string; targetTimeMs: number; shapeType: 'ellipse'; ellipseAxis: 'n' | 'e' | 's' | 'w' }
  | { shapeId: string; targetTimeMs: number; shapeType: 'polygon'; pointIndex: number };

type AoiEditHandlePoint = AoiEditHandle & {
  key: string;
  x: number;
  y: number;
  color: string;
};

type StatsPanelDrag = {
  panelId: string;
  offsetX: number;
  offsetY: number;
  panelSize: { w: number; h: number };
};

type AoiDragState = {
  shapeId: string;
  targetTimeMs: number;
  startPointer: { x: number; y: number };
  originShape: AoiShape;
};

const AoiPage: React.FC<AoiPageProps> = ({
  aoiTool,
  aoiDrawing,
  aoiSelectedId,
  setAoiSelectedId,
  aoiShapes,
  setAoiShapes,
  aoiDraft,
  aoiCursor,
  aoiCanvasRef,
  aoiVideoRef,
  aoiSelectedStimulusId,
  setAoiSelectedStimulusId,
  aoiSelectedRecordId,
  setAoiSelectedRecordId,
  aoiVideoUrl,
  aoiSyncVideoMeta,
  aoiClearVideoMeta,
  stimuli,
  records,
  aoiStartDraw,
  aoiOnMouseDown,
  aoiOnMouseMove,
  aoiOnMouseUp,
  aoiRename,
  aoiOpacity,
  setAoiOpacity,
  aoiBorderWidth,
  setAoiBorderWidth,
  aoiFontSize,
  setAoiFontSize,
  aoiShowName,
  setAoiShowName,
  aoiColorDefs,
  selectedAoi,
  aoiOnContextMenu,
  customMarkers = [],
  projectDir,
  onRecordTimelineSegmentsChange,
}) => {
  const { language } = useLanguage();
  const isEn = language === 'en-US';
  const selectedRecord = records.find((r) => r.id === aoiSelectedRecordId) || null;
  const isGlassesMode = selectedRecord?.deviceType === '眼镜式';
  const recordVideoKey = JSON.stringify([projectDir, aoiSelectedRecordId, selectedRecord?.mp4Path, selectedRecord?.mp4Url]);
  const recordsById = React.useMemo(() => new Map(records.map((record) => [record.id, record])), [records]);
  const [aoiStatsMultiSelectEnabled, setAoiStatsMultiSelectEnabled] = React.useState(false);
  const [aoiStatsSelectedRecordIds, setAoiStatsSelectedRecordIds] = React.useState<Set<string>>(new Set());
  const [timelineSegments, setTimelineSegments] = React.useState<TimeSegment[]>([]);
  const [selectedSegmentId, setSelectedSegmentId] = React.useState<string | null>(null);
  const [playbackSegmentId, setPlaybackSegmentId] = React.useState<string | null>(null);
  const [pendingDeleteSegment, setPendingDeleteSegment] = React.useState<TimeSegment | null>(null);
  const [customTimeRange, setCustomTimeRange] = React.useState<{ startTime: number; endTime: number } | null>(null);
  const [timelineRangeMode, setTimelineRangeMode] = React.useState<'segment' | 'scoped'>('segment');
  const lastSavedTimelineSegmentsRef = React.useRef<string>('[]');
  const lastManualSeekRef = React.useRef<{ time: number; requestedAtMs: number } | null>(null);
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [isExportingImage, setIsExportingImage] = React.useState(false);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [visualCurrentTime, setVisualCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [resolvedRecordVideoUrl, setResolvedRecordVideoUrl] = React.useState<string | null>(null);
  const recordVideoOwnerRef = React.useRef<{ recordKey: string; url: string | null } | null>(null);
  const [loadedRecordVideo, setLoadedRecordVideo] = React.useState<{ recordKey: string; url: string; duration: number } | null>(null);
  const recordingVideoStimulus = React.useMemo(() => resolveRecordingVideoStimulus(
    selectedRecord,
    loadedRecordVideo?.recordKey === recordVideoKey && loadedRecordVideo.url === resolvedRecordVideoUrl
      ? loadedRecordVideo.duration
      : undefined,
  ), [selectedRecord, loadedRecordVideo, recordVideoKey, resolvedRecordVideoUrl]);
  const { timeOffsetMs } = useTimeOffsetMs();
  const [aoiCanvasSize, setAoiCanvasSize] = React.useState({ w: 0, h: 0 });
  const [aoiVideoNaturalSize, setAoiVideoNaturalSize] = React.useState({ w: 0, h: 0 });
  const [aoiStoreByStimulusId, setAoiStoreByStimulusId] = React.useState<Record<string, NormalizedAoiShape[]>>({});
  const [loadedRecordDataById, setLoadedRecordDataById] = React.useState<Record<string, LoadedAoiRecordData>>({});
  const lastStimulusAutoSeekKeyRef = React.useRef<string>('');
  const layoutSettleTimerRef = React.useRef<number | null>(null);
  const [isContainLayoutSettled, setIsContainLayoutSettled] = React.useState<boolean>(false);
  const fallbackRenderReferenceSize = React.useMemo(() => {
    if (typeof window === 'undefined') return { w: 1920, h: 1080 };
    // Text stimulus uses CSS pixels in participant window, so we keep the same CSS-pixel baseline here.
    const screenW = Math.max(0, Math.round(Number(window.screen?.width || 0)));
    const screenH = Math.max(0, Math.round(Number(window.screen?.height || 0)));
    return {
      w: screenW > 0 ? screenW : 1920,
      h: screenH > 0 ? screenH : 1080,
    };
  }, []);
  
  const [showMarkTrack, setShowMarkTrack] = React.useState(true);
  const [showTriggerTrack, setShowTriggerTrack] = React.useState(true);

  const handleTimeRangeChange = React.useCallback((startTime: number, endTime: number) => {
    setCustomTimeRange((prev) => {
      if (prev && prev.startTime === startTime && prev.endTime === endTime) return prev;
      return { startTime, endTime };
    });
  }, []);

  const handleClearGlobalTimeRange = React.useCallback(() => {
    setCustomTimeRange(null);
  }, []);

  React.useEffect(() => {
    const validRecordIds = new Set(records.map((record) => record.id));
    setAoiStatsSelectedRecordIds((prev) => {
      const next = new Set<string>();
      prev.forEach((recordId) => {
        if (validRecordIds.has(recordId)) next.add(recordId);
      });
      if (aoiSelectedRecordId && validRecordIds.has(aoiSelectedRecordId)) {
        next.add(aoiSelectedRecordId);
      }
      if (next.size === prev.size && Array.from(next).every((recordId) => prev.has(recordId))) {
        return prev;
      }
      return next;
    });
  }, [records, aoiSelectedRecordId]);

  React.useEffect(() => {
    if (!aoiSelectedRecordId) {
      setAoiStatsMultiSelectEnabled(false);
      setAoiStatsSelectedRecordIds(new Set());
      return;
    }
    setAoiStatsSelectedRecordIds((prev) => {
      if (prev.has(aoiSelectedRecordId)) return prev;
      const next = new Set(prev);
      next.add(aoiSelectedRecordId);
      return next;
    });
  }, [aoiSelectedRecordId]);
  
  const selectedStimulus = aoiSelectedStimulusId ? stimuli.find((s) => s.id === aoiSelectedStimulusId) || null : null;
  const selectedStimulusForAnalysis = isGlassesMode ? null : selectedStimulus;
  const selectedStimulusKind = React.useMemo<'image' | 'video' | 'audio' | 'text' | 'web' | 'group' | null>(() => {
    if (!selectedStimulus) return null;
    const type = String(selectedStimulus.stimulusType || '').toLowerCase();
    if (type === 'group') return 'group';
    if (type === 'image' || type === 'video' || type === 'audio' || type === 'text' || type === 'web') {
      return type as 'image' | 'video' | 'audio' | 'text' | 'web';
    }
    const rawUrl = String(selectedStimulus.url || '').trim();
    if (isStimulusVideoUrl(rawUrl)) {
      return 'video';
    }
    if (isStimulusAudioUrl(rawUrl)) return 'audio';
    if (isWebStimulusUrl(rawUrl)) return 'web';
    if (rawUrl) return 'image';
    if (selectedStimulus.text) return 'text';
    return 'image';
  }, [selectedStimulus]);
  const selectedStimulusIsVideo = selectedStimulusKind === 'video';
  const canUseRecordVideo = Boolean(resolvedRecordVideoUrl || aoiVideoUrl);
  const dynamicAoiAllowed = isGlassesMode ? canUseRecordVideo : selectedStimulusKind === 'video';
  const canDrawAoi = isGlassesMode ? canUseRecordVideo : Boolean(selectedStimulus);
  const canEnableMultiRecordStats = Boolean(aoiSelectedRecordId && (isGlassesMode || aoiSelectedStimulusId));

  React.useEffect(() => {
    setCustomTimeRange(null);
  }, [aoiSelectedStimulusId]);

  React.useEffect(() => {
    if (!isGlassesMode) return;
    if (!aoiSelectedStimulusId) return;
    setAoiSelectedStimulusId(null);
  }, [isGlassesMode, aoiSelectedStimulusId, setAoiSelectedStimulusId]);
  const selectedStatsRecordIds = React.useMemo(() => {
    if (!aoiSelectedRecordId || !records.some((record) => record.id === aoiSelectedRecordId)) return [] as string[];
    if (!aoiStatsMultiSelectEnabled || (!isGlassesMode && !aoiSelectedStimulusId)) return [aoiSelectedRecordId];
    const next: string[] = [];
    records.forEach((record) => {
      if (record.id === aoiSelectedRecordId || aoiStatsSelectedRecordIds.has(record.id)) {
        next.push(record.id);
      }
    });
    if (!next.includes(aoiSelectedRecordId)) next.unshift(aoiSelectedRecordId);
    return next;
  }, [aoiSelectedRecordId, aoiSelectedStimulusId, aoiStatsMultiSelectEnabled, aoiStatsSelectedRecordIds, isGlassesMode, records]);
  const canComputeAoiStats = selectedStatsRecordIds.length > 0;
  const showPerRecordStatsInSidebar = Boolean(
    aoiStatsMultiSelectEnabled && (isGlassesMode || aoiSelectedStimulusId) && selectedStatsRecordIds.length > 1,
  );

  React.useEffect(() => {
    if (!canEnableMultiRecordStats && aoiStatsMultiSelectEnabled) {
      setAoiStatsMultiSelectEnabled(false);
    }
  }, [canEnableMultiRecordStats, aoiStatsMultiSelectEnabled]);

  const stimulusVideoUrl = selectedStimulusIsVideo ? aoiVideoUrl : null;
  const activeVideoUrl = resolvedRecordVideoUrl || stimulusVideoUrl;
  const shouldUsePlaybackTimeForStats = Boolean(activeVideoUrl);
  const orderedSegments = React.useMemo(
    () => normalizeTimeSegments(timelineSegments, { duration }),
    [timelineSegments, duration],
  );

  React.useEffect(() => {
    if (customTimeRange) setPlaybackSegmentId(null);
  }, [customTimeRange]);

  React.useEffect(() => {
    const normalized = normalizeTimeSegments(selectedRecord?.timelineSegments ?? []);
    setTimelineSegments(normalized);
    setSelectedSegmentId((prev) => (prev && normalized.some((segment) => segment.id === prev) ? prev : null));
    setPlaybackSegmentId((prev) => (prev && normalized.some((segment) => segment.id === prev) ? prev : null));
    lastSavedTimelineSegmentsRef.current = JSON.stringify(normalized);
  }, [aoiSelectedRecordId, selectedRecord?.timelineSegments]);

  const handleTimelineSegmentsChange = React.useCallback(
    (nextSegments: TimeSegment[]) => {
      const normalized = normalizeTimeSegments(nextSegments);
      setTimelineSegments(normalized);
      if (aoiSelectedRecordId && onRecordTimelineSegmentsChange) {
        onRecordTimelineSegmentsChange(aoiSelectedRecordId, normalized);
      }
    },
    [aoiSelectedRecordId, onRecordTimelineSegmentsChange],
  );

  React.useEffect(() => {
    if (!aoiSelectedRecordId || !selectedRecord || !projectDir) return;
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
  }, [timelineSegments, aoiSelectedRecordId, selectedRecord, projectDir]);

  React.useEffect(() => {
    const publishRecordVideoUrl = (url: string | null) => {
      recordVideoOwnerRef.current = { recordKey: recordVideoKey, url };
      setResolvedRecordVideoUrl(url);
    };
    if (!aoiSelectedRecordId || !selectedRecord) {
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
  }, [aoiSelectedRecordId, selectedRecord, projectDir, recordVideoKey]);

  React.useEffect(() => {
    lastManualSeekRef.current = null;
    setDuration(0);
    setCurrentTime(0);
    setVisualCurrentTime(0);
    setIsPlaying(false);
    setAoiVideoNaturalSize({ w: 0, h: 0 });
    aoiClearVideoMeta();
    const el = aoiVideoRef.current;
    if (el) {
      try {
        el.pause();
      } catch {
      }
      try {
        el.currentTime = 0;
      } catch {
      }
    }
  }, [activeVideoUrl, aoiClearVideoMeta, aoiVideoRef]);

  React.useEffect(() => {
    if (activeVideoUrl) return;
    if (!selectedStimulus) {
      setAoiVideoNaturalSize({ w: 0, h: 0 });
      aoiClearVideoMeta();
      return;
    }
    if (selectedStimulusKind === 'text') {
      const w = Math.max(1, fallbackRenderReferenceSize.w);
      const h = Math.max(1, fallbackRenderReferenceSize.h);
      setAoiVideoNaturalSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
      aoiSyncVideoMeta({ w, h, durationMs: 0 });
      return;
    }
    // For non-video stimuli we reset baseline first, then let image onLoad provide natural size.
    setAoiVideoNaturalSize({ w: 0, h: 0 });
    aoiClearVideoMeta();
  }, [
    activeVideoUrl,
    selectedStimulus,
    selectedStimulusKind,
    fallbackRenderReferenceSize.w,
    fallbackRenderReferenceSize.h,
    aoiSyncVideoMeta,
    aoiClearVideoMeta,
  ]);

  React.useEffect(() => {
    const el = aoiCanvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const cr = entry.contentRect;
      const w = Math.max(0, Math.round(cr.width));
      const h = Math.max(0, Math.round(cr.height));
      setAoiCanvasSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [aoiCanvasRef]);

  React.useEffect(() => {
    const baseDir = String(projectDir || '').trim();
    if (!baseDir || !ipcClient.isAvailable()) {
      setAoiStoreByStimulusId({});
      return;
    }
    let cancelled = false;
    void ipcClient
      .loadAoi({ projectDir: baseDir })
      .then((res) => {
        if (cancelled) return;
        const store = res?.ok ? parseAoiStore(res.data) : null;
        setAoiStoreByStimulusId(store?.byRecordId ?? {});
      })
      .catch(() => {
        if (!cancelled) setAoiStoreByStimulusId({});
      });
    return () => {
      cancelled = true;
    };
  }, [projectDir]);

  const gridMetricOptions: GridMetricOption[] = [
    { id: 'fixationCount', label: '注视次数' },
    { id: 'firstEnterTimeS', label: '首次注视前时长(ms)', summaryLabel: '平均首次注视前时长(ms)' },
    { id: 'fixationCountPreEntry', label: '首次注视前次数', summaryLabel: '平均首次注视前次数' },
    { id: 'firstFixationDurationS', label: '首次注视时长(ms)', summaryLabel: '平均首次注视时长(ms)' },
    { id: 'totalFixationDurationS', label: '总注视时长(ms)' },
    { id: 'avgFixationDurationS', label: '平均注视时长(ms)' },
    { id: 'visitorCount', label: '注视人数' },
    { id: 'maxFixationDurationS', label: '最大注视时长(ms)' },
    { id: 'minFixationDuration', label: '最短浏览时间(ms)' },
    { id: 'secondFixationDuration', label: '第二次注视时间(ms)' },
    { id: 'regressionDuration', label: '回视时间(ms)' },
    { id: 'longFixationCount', label: '长注视次数' },
    { id: 'totalVisitDurationS', label: '总停留时长(ms)' },
    { id: 'firstVisitDurationS', label: '首次停留时长(ms)', summaryLabel: '平均首次停留时长(ms)' },
    { id: 'firstVisitFixationDurationS', label: '首次停留注视时长(ms)', summaryLabel: '平均首次停留注视时长(ms)' },
    { id: 'firstVisitFixationCount', label: '首次停留注视次数', summaryLabel: '平均首次停留注视次数' },
    { id: 'avgVisitDurationS', label: '平均停留时长(ms)' },
    { id: 'visits', label: '访问次数' },
    { id: 'reVisitorCount', label: '回看人数' },
    { id: 'revisitCount', label: '回看次数' },
    { id: 'totalSaccadeDurationS', label: '总眼跳时长(ms)' },
    { id: 'saccadeCount', label: '眼跳次数' },
    { id: 'avgSaccadeDurationS', label: '平均眼跳时长(ms)' },
    { id: 'avgSaccadeVelocity', label: '平均眼跳速度(px/ms)' },
    { id: 'peakSaccadeVelocity', label: '眼跳速度峰值(px/ms)' },
    { id: 'avgSaccadeAmplitude', label: '平均眼跳幅度(px)' },
    { id: 'avgPupilDiameterMm', label: '平均瞳孔直径(mm)' },
  ];

  const [gridEnabled, setGridEnabled] = React.useState(false);
  const [gridMetric, setGridMetric] = React.useState<GridMetric>('fixationCount');
  const [gridRows, setGridRows] = React.useState(6);
  const [gridCols, setGridCols] = React.useState(10);
  const [gridShowValues, setGridShowValues] = React.useState(true);
  const [gridShowScale, setGridShowScale] = React.useState(true);
  const [gridOpacity, setGridOpacity] = React.useState(0.55);
  const [gridFontSize, setGridFontSize] = React.useState(14);
  const [gridLoading, setGridLoading] = React.useState(false);
  const [gridError, setGridError] = React.useState<string | null>(null);
  const [aoiEditMode, setAoiEditMode] = React.useState(false);
  const [activeEditHandle, setActiveEditHandle] = React.useState<AoiEditHandle | null>(null);
  const [activeShapeDrag, setActiveShapeDrag] = React.useState<AoiDragState | null>(null);
  const [expandedAoiRangeIds, setExpandedAoiRangeIds] = React.useState<Set<string>>(new Set());
  const [statsPanelPositions, setStatsPanelPositions] = React.useState<Record<string, { x: number; y: number }>>({});
  const [collapsedStatsPanelIds, setCollapsedStatsPanelIds] = React.useState<Set<string>>(new Set());
  const [statsPanelDrag, setStatsPanelDrag] = React.useState<StatsPanelDrag | null>(null);
  const [aoiSettingsTab, setAoiSettingsTab] = React.useState<'basic' | 'aoi'>('basic');
  const resolveAoiBorderColor = React.useCallback(
    (color: string | undefined, fallback = '#38bdf8') =>
      /^#[0-9a-f]{6}$/iu.test(String(color || ''))
        ? String(color)
        : aoiColorDefs[color || '']?.border || fallback,
    [aoiColorDefs],
  );
  const resolveAoiFillColor = React.useCallback(
    (color: string | undefined, alpha: number, fallback = '#38bdf8') => {
      const resolved = resolveAoiBorderColor(color, fallback);
      if (!/^#[0-9a-f]{6}$/iu.test(resolved)) return resolved;
      const red = Number.parseInt(resolved.slice(1, 3), 16);
      const green = Number.parseInt(resolved.slice(3, 5), 16);
      const blue = Number.parseInt(resolved.slice(5, 7), 16);
      return `rgba(${red},${green},${blue},${alpha})`;
    },
    [resolveAoiBorderColor],
  );
  const [aoiSidebarTab, setAoiSidebarTab] = React.useState<'aois' | 'dynamic'>('aois');
  React.useEffect(() => {
    if (aoiSidebarTab === 'dynamic' && !dynamicAoiAllowed) {
      setAoiSidebarTab('aois');
    }
  }, [aoiSidebarTab, dynamicAoiAllowed]);
  const currentTimeMs = React.useMemo(
    () => Math.max(0, Math.round((visualCurrentTime || 0) * 1000)),
    [visualCurrentTime],
  );
  const aoiShapeList = React.useMemo(() => (Array.isArray(aoiShapes) ? (aoiShapes as AoiShape[]) : []), [aoiShapes]);
  const aoiShapesById = React.useMemo(
    () => Object.fromEntries(aoiShapeList.map((shape) => [shape.id, shape])),
    [aoiShapeList],
  );
  const selectedBaseAoi = React.useMemo(
    () => aoiShapeList.find((shape) => shape?.id === aoiSelectedId) || null,
    [aoiSelectedId, aoiShapeList],
  );
  const selectedAoiKeyframes = React.useMemo(
    () => sortAoiKeyframes(selectedBaseAoi?.keyframes),
    [selectedBaseAoi],
  );

  const aoiContainLayout = React.useMemo(() => {
    const containerW = aoiCanvasSize.w;
    const containerH = aoiCanvasSize.h;
    const videoW = aoiVideoNaturalSize.w;
    const videoH = aoiVideoNaturalSize.h;
    if (containerW <= 0 || containerH <= 0) {
      return { drawLeft: 0, drawTop: 0, drawW: 0, drawH: 0, containerW: 0, containerH: 0 };
    }
    if (videoW <= 0 || videoH <= 0) {
      return { drawLeft: 0, drawTop: 0, drawW: containerW, drawH: containerH, containerW, containerH };
    }
    const scale = Math.min(containerW / videoW, containerH / videoH);
    const drawW = videoW * scale;
    const drawH = videoH * scale;
    const drawLeft = (containerW - drawW) / 2;
    const drawTop = (containerH - drawH) / 2;
    return { drawLeft, drawTop, drawW, drawH, containerW, containerH };
  }, [aoiCanvasSize.h, aoiCanvasSize.w, aoiVideoNaturalSize.h, aoiVideoNaturalSize.w]);

  const isContainLayoutReady = React.useMemo(() => {
    if (aoiCanvasSize.w <= 0 || aoiCanvasSize.h <= 0) return false;
    if (aoiContainLayout.drawW <= 0 || aoiContainLayout.drawH <= 0) return false;
    if (activeVideoUrl && (aoiVideoNaturalSize.w <= 0 || aoiVideoNaturalSize.h <= 0)) return false;
    return true;
  }, [
    aoiCanvasSize.h,
    aoiCanvasSize.w,
    aoiContainLayout.drawH,
    aoiContainLayout.drawW,
    aoiVideoNaturalSize.h,
    aoiVideoNaturalSize.w,
    activeVideoUrl,
  ]);

  React.useEffect(() => {
    setIsContainLayoutSettled(false);
    if (layoutSettleTimerRef.current) {
      window.clearTimeout(layoutSettleTimerRef.current);
      layoutSettleTimerRef.current = null;
    }
    if (!isContainLayoutReady) return;

    layoutSettleTimerRef.current = window.setTimeout(() => {
      setIsContainLayoutSettled(true);
      layoutSettleTimerRef.current = null;
    }, 180);

    return () => {
      if (layoutSettleTimerRef.current) {
        window.clearTimeout(layoutSettleTimerRef.current);
        layoutSettleTimerRef.current = null;
      }
    };
  }, [isContainLayoutReady]);

  const textPreviewReferenceSize = React.useMemo(() => {
    const w = aoiVideoNaturalSize.w > 0 ? aoiVideoNaturalSize.w : fallbackRenderReferenceSize.w;
    const h = aoiVideoNaturalSize.h > 0 ? aoiVideoNaturalSize.h : fallbackRenderReferenceSize.h;
    return { w: Math.max(1, w), h: Math.max(1, h) };
  }, [aoiVideoNaturalSize.h, aoiVideoNaturalSize.w, fallbackRenderReferenceSize.h, fallbackRenderReferenceSize.w]);

  const textPreviewStageStyle = React.useMemo(() => {
    const refW = Math.max(1, textPreviewReferenceSize.w);
    const refH = Math.max(1, textPreviewReferenceSize.h);
    const drawW = aoiContainLayout.drawW > 0 ? aoiContainLayout.drawW : Math.max(1, aoiCanvasSize.w);
    const drawH = aoiContainLayout.drawH > 0 ? aoiContainLayout.drawH : Math.max(1, aoiCanvasSize.h);
    const scale = Math.min(drawW / refW, drawH / refH);
    const drawLeft = Number.isFinite(aoiContainLayout.drawLeft) ? aoiContainLayout.drawLeft : 0;
    const drawTop = Number.isFinite(aoiContainLayout.drawTop) ? aoiContainLayout.drawTop : 0;
    return {
      left: `${drawLeft}px`,
      top: `${drawTop}px`,
      width: `${refW}px`,
      height: `${refH}px`,
      transform: `scale(${Number.isFinite(scale) && scale > 0 ? scale : 1})`,
      transformOrigin: 'top left',
    } as React.CSSProperties;
  }, [
    textPreviewReferenceSize.w,
    textPreviewReferenceSize.h,
    aoiContainLayout.drawW,
    aoiContainLayout.drawH,
    aoiContainLayout.drawLeft,
    aoiContainLayout.drawTop,
    aoiCanvasSize.w,
    aoiCanvasSize.h,
  ]);

  const denormalizeAoiShapeWithLayout = React.useCallback(
    (shape: NormalizedAoiShape): AoiShape => {
      const safeW = aoiContainLayout.drawW > 0 ? aoiContainLayout.drawW : Math.max(1, aoiContainLayout.containerW);
      const safeH = aoiContainLayout.drawH > 0 ? aoiContainLayout.drawH : Math.max(1, aoiContainLayout.containerH);
      const ox = Number.isFinite(aoiContainLayout.drawLeft) ? aoiContainLayout.drawLeft : 0;
      const oy = Number.isFinite(aoiContainLayout.drawTop) ? aoiContainLayout.drawTop : 0;
      const base: AoiShape = {
        id: String(shape.id || ''),
        name: String(shape.name || ''),
        type: shape.type === 'polygon' ? 'polygon' : shape.type === 'ellipse' ? 'ellipse' : 'rect',
        visible: !!shape.visible,
        showStats: !!shape.showStats,
        color: String(shape.color || 'sky'),
        metric: typeof shape.metric === 'number' && Number.isFinite(shape.metric) ? shape.metric : 0,
        activationTimeMs:
          typeof shape.activationTimeMs === 'number' && Number.isFinite(shape.activationTimeMs)
            ? Math.max(0, Math.round(shape.activationTimeMs))
            : 0,
        analysisTimeRanges: normalizeAoiAnalysisTimeRanges(shape.analysisTimeRanges, shape.analysisTimeRange),
      };
      if (base.type === 'polygon') {
        const points = (shape.points || []).map((point) => ({
          x: ox + Number(point?.x || 0) * safeW,
          y: oy + Number(point?.y || 0) * safeH,
        }));
        const keyframes = (shape.keyframes || []).map((keyframe) => ({
          timeMs: Math.max(0, Math.round(Number(keyframe?.timeMs || 0))),
          metric: typeof keyframe?.metric === 'number' && Number.isFinite(keyframe.metric) ? keyframe.metric : 0,
          points: (keyframe.points || []).map((point) => ({
            x: ox + Number(point?.x || 0) * safeW,
            y: oy + Number(point?.y || 0) * safeH,
          })),
        }));
        return { ...base, points, keyframes };
      }
      const keyframes = (shape.keyframes || []).map((keyframe) => ({
        timeMs: Math.max(0, Math.round(Number(keyframe?.timeMs || 0))),
        metric: typeof keyframe?.metric === 'number' && Number.isFinite(keyframe.metric) ? keyframe.metric : 0,
        x: ox + Number(keyframe?.x || 0) * safeW,
        y: oy + Number(keyframe?.y || 0) * safeH,
        w: Number(keyframe?.w || 0) * safeW,
        h: Number(keyframe?.h || 0) * safeH,
      }));
      return {
        ...base,
        x: ox + Number(shape.x || 0) * safeW,
        y: oy + Number(shape.y || 0) * safeH,
        w: Number(shape.w || 0) * safeW,
        h: Number(shape.h || 0) * safeH,
        keyframes,
      };
    },
    [
      aoiContainLayout.containerH,
      aoiContainLayout.containerW,
      aoiContainLayout.drawH,
      aoiContainLayout.drawLeft,
      aoiContainLayout.drawTop,
      aoiContainLayout.drawW,
    ],
  );

  const aoiEditBounds = React.useMemo(() => {
    const fallbackW = Math.max(1, aoiCanvasSize.w || aoiContainLayout.containerW || 0);
    const fallbackH = Math.max(1, aoiCanvasSize.h || aoiContainLayout.containerH || 0);
    const drawW = aoiContainLayout.drawW > 0 ? aoiContainLayout.drawW : fallbackW;
    const drawH = aoiContainLayout.drawH > 0 ? aoiContainLayout.drawH : fallbackH;
    const drawLeft = Number.isFinite(aoiContainLayout.drawLeft) ? aoiContainLayout.drawLeft : 0;
    const drawTop = Number.isFinite(aoiContainLayout.drawTop) ? aoiContainLayout.drawTop : 0;
    return {
      minX: drawLeft,
      maxX: drawLeft + drawW,
      minY: drawTop,
      maxY: drawTop + drawH,
    };
  }, [
    aoiCanvasSize.h,
    aoiCanvasSize.w,
    aoiContainLayout.containerH,
    aoiContainLayout.containerW,
    aoiContainLayout.drawH,
    aoiContainLayout.drawLeft,
    aoiContainLayout.drawTop,
    aoiContainLayout.drawW,
  ]);

  const clampEditPoint = React.useCallback(
    (x: number, y: number) => ({
      x: Math.max(aoiEditBounds.minX, Math.min(aoiEditBounds.maxX, x)),
      y: Math.max(aoiEditBounds.minY, Math.min(aoiEditBounds.maxY, y)),
    }),
    [aoiEditBounds.maxX, aoiEditBounds.maxY, aoiEditBounds.minX, aoiEditBounds.minY],
  );

  const getCanvasPointFromClient = React.useCallback(
    (clientX: number, clientY: number) => {
      const rect = aoiCanvasRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      return clampEditPoint(x, y);
    },
    [aoiCanvasRef, clampEditPoint],
  );

  const cloneAoiShape = React.useCallback((shape: AoiShape): AoiShape => {
    return {
      ...shape,
      points: Array.isArray(shape.points) ? shape.points.map((point) => ({ x: point.x, y: point.y })) : undefined,
      keyframes: Array.isArray(shape.keyframes)
        ? shape.keyframes.map((keyframe) => ({
            ...keyframe,
            points: Array.isArray(keyframe.points)
              ? keyframe.points.map((point) => ({ x: point.x, y: point.y }))
              : undefined,
          }))
        : undefined,
    };
  }, []);

  const updateShapeAtTimelineTime = React.useCallback(
    (shape: AoiShape, targetTimeMs: number, geometryShape: AoiShape): AoiShape => {
      const snapshot = getAoiGeometrySnapshot(geometryShape);
      return upsertAoiKeyframe(shape, targetTimeMs, snapshot);
    },
    [],
  );

  const computePolygonArea = React.useCallback((points: Array<{ x: number; y: number }>): number => {
    if (!Array.isArray(points) || points.length < 3) return 0;
    let area = 0;
    for (let i = 0; i < points.length; i += 1) {
      const j = (i + 1) % points.length;
      area += points[i].x * points[j].y - points[j].x * points[i].y;
    }
    return Math.abs(area / 2);
  }, []);

  const getShapeBoundingBox = React.useCallback((shape: AoiShape) => {
    if (shape.type === 'polygon') {
      const pts = Array.isArray(shape.points)
        ? shape.points.filter(
            (point): point is { x: number; y: number } =>
              typeof point?.x === 'number' &&
              Number.isFinite(point.x) &&
              typeof point?.y === 'number' &&
              Number.isFinite(point.y),
          )
        : [];
      if (pts.length === 0) {
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, centerX: 0, centerY: 0 };
      }
      let minX = pts[0].x;
      let maxX = pts[0].x;
      let minY = pts[0].y;
      let maxY = pts[0].y;
      pts.forEach((point) => {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y);
      });
      return {
        left: minX,
        top: minY,
        right: maxX,
        bottom: maxY,
        width: Math.max(0, maxX - minX),
        height: Math.max(0, maxY - minY),
        centerX: (minX + maxX) / 2,
        centerY: (minY + maxY) / 2,
      };
    }

    const left = typeof shape.x === 'number' && Number.isFinite(shape.x) ? shape.x : 0;
    const top = typeof shape.y === 'number' && Number.isFinite(shape.y) ? shape.y : 0;
    const width = typeof shape.w === 'number' && Number.isFinite(shape.w) ? shape.w : 0;
    const height = typeof shape.h === 'number' && Number.isFinite(shape.h) ? shape.h : 0;
    return {
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      centerX: left + width / 2,
      centerY: top + height / 2,
    };
  }, []);

  const getShapeMotionBounds = React.useCallback(
    (shape: AoiShape) => {
      const base = getShapeBoundingBox(shape);
      let left = base.left;
      let top = base.top;
      let right = base.right;
      let bottom = base.bottom;

      const absorbBounds = (bounds: { left: number; top: number; right: number; bottom: number }) => {
        left = Math.min(left, bounds.left);
        top = Math.min(top, bounds.top);
        right = Math.max(right, bounds.right);
        bottom = Math.max(bottom, bounds.bottom);
      };

      const absorbPointList = (points: Array<{ x: number; y: number }>) => {
        if (!Array.isArray(points) || points.length === 0) return;
        let minX = points[0].x;
        let maxX = points[0].x;
        let minY = points[0].y;
        let maxY = points[0].y;
        for (let i = 1; i < points.length; i += 1) {
          minX = Math.min(minX, points[i].x);
          maxX = Math.max(maxX, points[i].x);
          minY = Math.min(minY, points[i].y);
          maxY = Math.max(maxY, points[i].y);
        }
        absorbBounds({ left: minX, top: minY, right: maxX, bottom: maxY });
      };

      if (Array.isArray(shape.keyframes)) {
        shape.keyframes.forEach((keyframe) => {
          if (Array.isArray(keyframe.points) && keyframe.points.length > 0) {
            absorbPointList(keyframe.points);
            return;
          }
          const x = typeof keyframe.x === 'number' && Number.isFinite(keyframe.x) ? keyframe.x : null;
          const y = typeof keyframe.y === 'number' && Number.isFinite(keyframe.y) ? keyframe.y : null;
          if (x === null || y === null) return;
          const w = typeof keyframe.w === 'number' && Number.isFinite(keyframe.w) ? keyframe.w : 0;
          const h = typeof keyframe.h === 'number' && Number.isFinite(keyframe.h) ? keyframe.h : 0;
          absorbBounds({
            left: x,
            top: y,
            right: x + Math.max(0, w),
            bottom: y + Math.max(0, h),
          });
        });
      }

      return {
        left,
        top,
        right,
        bottom,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      };
    },
    [getShapeBoundingBox],
  );

  const getStatsPanelSize = React.useCallback((itemsCount: number) => {
    const rowCount = Math.max(1, itemsCount);
    return {
      w: 224,
      h: Math.max(104, 56 + rowCount * 23),
    };
  }, []);

  const clampStatsPanelPos = React.useCallback(
    (x: number, y: number, panelSize: { w: number; h: number }) => {
      const canvasW = Math.max(1, aoiCanvasSize.w || aoiContainLayout.containerW || 0);
      const canvasH = Math.max(1, aoiCanvasSize.h || aoiContainLayout.containerH || 0);
      const panelW = Math.max(1, panelSize.w || 224);
      const panelH = Math.max(1, panelSize.h || 112);
      const maxX = Math.max(0, canvasW - panelW);
      const maxY = Math.max(0, canvasH - panelH);
      return {
        x: Math.max(0, Math.min(maxX, x)),
        y: Math.max(0, Math.min(maxY, y)),
      };
    },
    [aoiCanvasSize.h, aoiCanvasSize.w, aoiContainLayout.containerH, aoiContainLayout.containerW],
  );

  const getDefaultStatsPanelPos = React.useCallback(
    (shape: AoiShape, panelSize: { w: number; h: number }) => {
      const box = getShapeBoundingBox(shape);
      const margin = 18;
      const preferredX = box.centerX + margin;
      const fallbackX = box.centerX - panelSize.w - margin;
      const preferredY = box.centerY - panelSize.h / 2;
      const canvasW = Math.max(1, aoiCanvasSize.w || aoiContainLayout.containerW || 0);
      const safeX = preferredX + panelSize.w <= canvasW ? preferredX : fallbackX;
      return clampStatsPanelPos(safeX, preferredY, panelSize);
    },
    [
      aoiCanvasSize.w,
      aoiContainLayout.containerW,
      clampStatsPanelPos,
      getShapeBoundingBox,
    ],
  );

  const translateShapeByDelta = React.useCallback(
    (shape: AoiShape, deltaX: number, deltaY: number): AoiShape => {
      if (shape.type === 'polygon') {
        const pts = Array.isArray(shape.points) ? shape.points : [];
        if (pts.length === 0) return shape;
        const box = getShapeBoundingBox(shape);
        const minDx = aoiEditBounds.minX - box.left;
        const maxDx = aoiEditBounds.maxX - box.right;
        const minDy = aoiEditBounds.minY - box.top;
        const maxDy = aoiEditBounds.maxY - box.bottom;
        const clampedDx = Math.max(minDx, Math.min(maxDx, deltaX));
        const clampedDy = Math.max(minDy, Math.min(maxDy, deltaY));
        return {
          ...shape,
          points: pts.map((point) => ({
            x: point.x + clampedDx,
            y: point.y + clampedDy,
          })),
        };
      }

      const width = typeof shape.w === 'number' && Number.isFinite(shape.w) ? shape.w : 0;
      const height = typeof shape.h === 'number' && Number.isFinite(shape.h) ? shape.h : 0;
      const startX = typeof shape.x === 'number' && Number.isFinite(shape.x) ? shape.x : 0;
      const startY = typeof shape.y === 'number' && Number.isFinite(shape.y) ? shape.y : 0;
      const maxLeft = Math.max(aoiEditBounds.minX, aoiEditBounds.maxX - width);
      const maxTop = Math.max(aoiEditBounds.minY, aoiEditBounds.maxY - height);
      return {
        ...shape,
        x: Math.max(aoiEditBounds.minX, Math.min(maxLeft, startX + deltaX)),
        y: Math.max(aoiEditBounds.minY, Math.min(maxTop, startY + deltaY)),
      };
    },
    [
      aoiEditBounds.maxX,
      aoiEditBounds.maxY,
      aoiEditBounds.minX,
      aoiEditBounds.minY,
      getShapeBoundingBox,
    ],
  );

  const duplicateAoiShape = React.useCallback(
    (sourceShape: AoiShape) => {
      const nextShape = cloneAoiShape(sourceShape);
      const motionBounds = getShapeMotionBounds(nextShape);
      const defaultOffset = 16;
      const minDx = aoiEditBounds.minX - motionBounds.left;
      const maxDx = aoiEditBounds.maxX - motionBounds.right;
      const minDy = aoiEditBounds.minY - motionBounds.top;
      const maxDy = aoiEditBounds.maxY - motionBounds.bottom;
      const deltaX = Math.max(minDx, Math.min(maxDx, defaultOffset));
      const deltaY = Math.max(minDy, Math.min(maxDy, defaultOffset));

      if (nextShape.type === 'polygon') {
        const points = Array.isArray(nextShape.points) ? nextShape.points : [];
        nextShape.points = points.map((point) => ({ x: point.x + deltaX, y: point.y + deltaY }));
      } else {
        if (typeof nextShape.x === 'number' && Number.isFinite(nextShape.x)) {
          nextShape.x += deltaX;
        }
        if (typeof nextShape.y === 'number' && Number.isFinite(nextShape.y)) {
          nextShape.y += deltaY;
        }
      }

      if (Array.isArray(nextShape.keyframes)) {
        nextShape.keyframes = nextShape.keyframes.map((keyframe) => {
          const shifted = { ...keyframe };
          if (typeof shifted.x === 'number' && Number.isFinite(shifted.x)) shifted.x += deltaX;
          if (typeof shifted.y === 'number' && Number.isFinite(shifted.y)) shifted.y += deltaY;
          if (Array.isArray(shifted.points)) {
            shifted.points = shifted.points.map((point) => ({ x: point.x + deltaX, y: point.y + deltaY }));
          }
          return shifted;
        });
      }

      return nextShape;
    },
    [
      aoiEditBounds.maxX,
      aoiEditBounds.maxY,
      aoiEditBounds.minX,
      aoiEditBounds.minY,
      cloneAoiShape,
      getShapeMotionBounds,
    ],
  );

  const handleDuplicateSelectedAoi = React.useCallback(() => {
    if (!aoiSelectedId) return;

    let nextSelectedId: string | null = null;
    setAoiShapes((prev) => {
      const currentShapes = prev as AoiShape[];
      const selectedIndex = currentShapes.findIndex((shape) => shape?.id === aoiSelectedId);
      if (selectedIndex < 0) return prev;

      const sourceShape = currentShapes[selectedIndex];
      const duplicated = duplicateAoiShape(sourceShape);
      nextSelectedId = `aoi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      duplicated.id = nextSelectedId;
      const suffix = isEn ? ' Copy' : ' 副本';
      const baseName = String(sourceShape?.name || '').trim();
      duplicated.name = baseName ? `${baseName}${suffix}` : isEn ? 'AOI Copy' : 'AOI副本';

      const nextShapes = [...currentShapes];
      nextShapes.splice(selectedIndex + 1, 0, duplicated);
      return nextShapes;
    });

    if (nextSelectedId) {
      setAoiSelectedId(nextSelectedId);
    }
  }, [aoiSelectedId, duplicateAoiShape, isEn, setAoiSelectedId, setAoiShapes]);

  const updateShapeByEditHandle = React.useCallback(
    (shape: AoiShape, handle: AoiEditHandle, point: { x: number; y: number }): AoiShape => {
      if (shape.id !== handle.shapeId) return shape;
      if (handle.shapeType === 'rect' && shape.type === 'rect') {
        const left = typeof shape.x === 'number' && Number.isFinite(shape.x) ? shape.x : 0;
        const top = typeof shape.y === 'number' && Number.isFinite(shape.y) ? shape.y : 0;
        const width = typeof shape.w === 'number' && Number.isFinite(shape.w) ? shape.w : 0;
        const height = typeof shape.h === 'number' && Number.isFinite(shape.h) ? shape.h : 0;
        const right = left + width;
        const bottom = top + height;
        let oppositeX = right;
        let oppositeY = bottom;
        if (handle.rectCorner === 'ne') {
          oppositeX = left;
          oppositeY = bottom;
        } else if (handle.rectCorner === 'se') {
          oppositeX = left;
          oppositeY = top;
        } else if (handle.rectCorner === 'sw') {
          oppositeX = right;
          oppositeY = top;
        }
        const nextLeft = Math.min(point.x, oppositeX);
        const nextTop = Math.min(point.y, oppositeY);
        const nextWidth = Math.max(0, Math.abs(oppositeX - point.x));
        const nextHeight = Math.max(0, Math.abs(oppositeY - point.y));
        return {
          ...shape,
          x: nextLeft,
          y: nextTop,
          w: nextWidth,
          h: nextHeight,
          metric: Math.round(nextWidth * nextHeight),
        };
      }

      if (handle.shapeType === 'ellipse' && shape.type === 'ellipse') {
        const left = typeof shape.x === 'number' && Number.isFinite(shape.x) ? shape.x : 0;
        const top = typeof shape.y === 'number' && Number.isFinite(shape.y) ? shape.y : 0;
        const width = typeof shape.w === 'number' && Number.isFinite(shape.w) ? shape.w : 0;
        const height = typeof shape.h === 'number' && Number.isFinite(shape.h) ? shape.h : 0;
        const right = left + width;
        const bottom = top + height;
        let nextLeft = left;
        let nextRight = right;
        let nextTop = top;
        let nextBottom = bottom;
        if (handle.ellipseAxis === 'n') nextTop = point.y;
        if (handle.ellipseAxis === 's') nextBottom = point.y;
        if (handle.ellipseAxis === 'w') nextLeft = point.x;
        if (handle.ellipseAxis === 'e') nextRight = point.x;
        const finalLeft = Math.min(nextLeft, nextRight);
        const finalTop = Math.min(nextTop, nextBottom);
        const finalWidth = Math.max(0, Math.abs(nextRight - nextLeft));
        const finalHeight = Math.max(0, Math.abs(nextBottom - nextTop));
        return {
          ...shape,
          x: finalLeft,
          y: finalTop,
          w: finalWidth,
          h: finalHeight,
          metric: Math.round(Math.PI * (finalWidth / 2) * (finalHeight / 2)),
        };
      }

      if (handle.shapeType === 'polygon' && shape.type === 'polygon') {
        const pts = Array.isArray(shape.points) ? [...shape.points] : [];
        if (handle.pointIndex < 0 || handle.pointIndex >= pts.length) return shape;
        pts[handle.pointIndex] = { x: point.x, y: point.y };
        return {
          ...shape,
          points: pts,
          metric: Math.round(computePolygonArea(pts)),
        };
      }

      return shape;
    },
    [computePolygonArea],
  );

  const applyHandleDragFromClient = React.useCallback(
    (clientX: number, clientY: number) => {
      if (!activeEditHandle) return;
      const point = getCanvasPointFromClient(clientX, clientY);
      if (!point) return;
      setAoiShapes((prev) =>
        (prev as AoiShape[]).map((shape) => {
          if (shape.id !== activeEditHandle.shapeId) return shape;
          const editableShape =
            activeEditHandle.targetTimeMs > 0 ? resolveAoiShapeAtTime(shape, activeEditHandle.targetTimeMs) : shape;
          const nextGeometry = updateShapeByEditHandle(editableShape, activeEditHandle, point);
          return updateShapeAtTimelineTime(shape, activeEditHandle.targetTimeMs, nextGeometry);
        }),
      );
    },
    [activeEditHandle, getCanvasPointFromClient, setAoiShapes, updateShapeAtTimelineTime, updateShapeByEditHandle],
  );

  const beginHandleDrag = React.useCallback(
    (event: React.MouseEvent, handle: AoiEditHandle) => {
      if (!aoiEditMode) return;
      event.preventDefault();
      event.stopPropagation();
      setAoiSelectedId(handle.shapeId);
      setActiveEditHandle(handle);
    },
    [aoiEditMode, setAoiSelectedId],
  );

  const beginShapeDrag = (event: React.MouseEvent, shape: AoiShape) => {
    if (!aoiEditMode || activeEditHandle) return;
    const point = getCanvasPointFromClient(event.clientX, event.clientY);
    if (!point) return;
    const sourceShape = aoiShapesById[shape.id] || shape;
    const targetTimeMs =
      aoiEditTargetTimeById[sourceShape.id] ?? getShapeEditTargetTimeMsAtPlayback(sourceShape);
    event.preventDefault();
    event.stopPropagation();
    setAoiSelectedId(sourceShape.id);
    if (targetTimeMs === null) return;
    setActiveShapeDrag({
      shapeId: sourceShape.id,
      targetTimeMs,
      startPointer: point,
      originShape: cloneAoiShape(shape),
    });
  };

  const beginAoiDraw = React.useCallback(
    (tool: 'ellipse' | 'rect' | 'polygon') => {
      if (!canDrawAoi) return;
      setAoiEditMode(false);
      setActiveEditHandle(null);
      setActiveShapeDrag(null);
      aoiStartDraw(tool);
    },
    [aoiStartDraw, canDrawAoi],
  );

  const toggleAoiEditMode = React.useCallback(() => {
    if (aoiDrawing) return;
    if (!aoiEditMode) {
      if (!aoiSelectedId && aoiShapes.length > 0) {
        const firstVisible = aoiShapes.find((shape) => shape && shape.visible !== false) || aoiShapes[0];
        if (firstVisible?.id) {
          setAoiSelectedId(firstVisible.id);
        }
      }
      setAoiEditMode(true);
      return;
    }
    setActiveEditHandle(null);
    setActiveShapeDrag(null);
    setAoiEditMode(false);
  }, [aoiDrawing, aoiEditMode, aoiSelectedId, aoiShapes, setAoiSelectedId]);

  React.useEffect(() => {
    if (gridEnabled && aoiEditMode) {
      setAoiEditMode(false);
    }
  }, [aoiEditMode, gridEnabled]);

  React.useEffect(() => {
    if (aoiDrawing && aoiEditMode) {
      setAoiEditMode(false);
    }
  }, [aoiDrawing, aoiEditMode]);

  React.useEffect(() => {
    if (!aoiEditMode && activeEditHandle) {
      setActiveEditHandle(null);
    }
  }, [aoiEditMode, activeEditHandle]);

  React.useEffect(() => {
    if (!aoiEditMode && activeShapeDrag) {
      setActiveShapeDrag(null);
    }
  }, [aoiEditMode, activeShapeDrag]);

  React.useEffect(() => {
    if (!activeEditHandle) return;
    const exists = aoiShapes.some((shape) => shape?.id === activeEditHandle.shapeId);
    if (!exists) {
      setActiveEditHandle(null);
    }
  }, [activeEditHandle, aoiShapes]);

  React.useEffect(() => {
    if (!activeShapeDrag) return;
    const exists = aoiShapes.some((shape) => shape?.id === activeShapeDrag.shapeId);
    if (!exists) {
      setActiveShapeDrag(null);
    }
  }, [activeShapeDrag, aoiShapes]);

  React.useEffect(() => {
    if (!activeEditHandle) return;
    const onMouseMove = (event: MouseEvent) => {
      event.preventDefault();
      applyHandleDragFromClient(event.clientX, event.clientY);
    };
    const onMouseUp = () => {
      setActiveEditHandle(null);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [activeEditHandle, applyHandleDragFromClient]);

  React.useEffect(() => {
    if (!activeShapeDrag) return;
    const onMouseMove = (event: MouseEvent) => {
      event.preventDefault();
      const point = getCanvasPointFromClient(event.clientX, event.clientY);
      if (!point) return;
      const deltaX = point.x - activeShapeDrag.startPointer.x;
      const deltaY = point.y - activeShapeDrag.startPointer.y;
      setAoiShapes((prev) =>
        (prev as AoiShape[]).map((shape) => {
          if (shape.id !== activeShapeDrag.shapeId) return shape;
          const nextGeometry = translateShapeByDelta(activeShapeDrag.originShape, deltaX, deltaY);
          return updateShapeAtTimelineTime(shape, activeShapeDrag.targetTimeMs, nextGeometry);
        }),
      );
    };
    const onMouseUp = () => {
      setActiveShapeDrag(null);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [activeShapeDrag, getCanvasPointFromClient, setAoiShapes, translateShapeByDelta, updateShapeAtTimelineTime]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'v') return;
      if (!aoiEditMode || gridEnabled || aoiDrawing) return;
      if (!aoiSelectedId) return;
      if (isEditableElement(event.target)) return;

      event.preventDefault();
      event.stopPropagation();
      handleDuplicateSelectedAoi();
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [aoiDrawing, aoiEditMode, aoiSelectedId, gridEnabled, handleDuplicateSelectedAoi]);

  React.useEffect(() => {
    if (gridEnabled) {
      setStatsPanelDrag(null);
      setStatsPanelPositions({});
    }
  }, [gridEnabled]);

  React.useEffect(() => {
    setStatsPanelPositions((prev) => {
      const visibleShapeIds = new Set(
        aoiShapes
          .filter((shape) => shape?.showStats && shape?.visible !== false)
          .map((shape) => shape.id),
      );
      const nextEntries = Object.entries(prev).filter(([panelId]) => {
        const shapeId = panelId.includes('::') ? panelId.split('::')[0] : panelId;
        return visibleShapeIds.has(shapeId);
      });
      if (nextEntries.length === Object.keys(prev).length) return prev;
      return Object.fromEntries(nextEntries);
    });
  }, [aoiShapes]);

  React.useEffect(() => {
    if (!statsPanelDrag) return;
    const onMouseMove = (event: MouseEvent) => {
      event.preventDefault();
      const rect = aoiCanvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const next = clampStatsPanelPos(
        pointerX - statsPanelDrag.offsetX,
        pointerY - statsPanelDrag.offsetY,
        statsPanelDrag.panelSize,
      );
      setStatsPanelPositions((prev) => ({
        ...prev,
        [statsPanelDrag.panelId]: next,
      }));
    };
    const onMouseUp = () => {
      setStatsPanelDrag(null);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [aoiCanvasRef, clampStatsPanelPos, statsPanelDrag]);

  const startStatsPanelDrag = React.useCallback(
    (
      event: React.MouseEvent<HTMLDivElement>,
      panelId: string,
      currentPos: { x: number; y: number },
      panelSize: { w: number; h: number },
    ) => {
      if (gridEnabled) return;
      const rect = aoiCanvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      event.preventDefault();
      event.stopPropagation();
      setStatsPanelDrag({
        panelId,
        offsetX: pointerX - currentPos.x,
        offsetY: pointerY - currentPos.y,
        panelSize,
      });
    },
    [aoiCanvasRef, gridEnabled],
  );

  const [isAoiStatsPickerOpen, setIsAoiStatsPickerOpen] = React.useState(false);
  const AOI_STATS_SELECTED_METRICS_KEY = 'mrt.aoiStats.selectedMetrics';
  const AOI_STATS_SELECTED_LABELS_KEY = 'mrt.aoiStats.selectedLabels';
  const allowedMetricIds = React.useMemo(() => new Set<GridMetric>(gridMetricOptions.map((o) => o.id)), [gridMetricOptions]);
  const loadStoredSelectedAoiStatsMetrics = (): GridMetric[] | null => {
    try {
      const raw = localStorage.getItem(AOI_STATS_SELECTED_METRICS_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (!Array.isArray(v)) return null;
      const out = v.filter((x) => typeof x === 'string' && allowedMetricIds.has(x as GridMetric)) as GridMetric[];
      return out.length > 0 ? out : [];
    } catch {
      return null;
    }
  };
  const loadStoredLegacyLabels = (): string[] | null => {
    try {
      const raw = localStorage.getItem(AOI_STATS_SELECTED_LABELS_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (!Array.isArray(v)) return null;
      const out = v.filter((x) => typeof x === 'string');
      return out.length > 0 ? out : [];
    } catch {
      return null;
    }
  };
  const storeSelectedAoiStatsMetrics = (metrics: GridMetric[] | null) => {
    try {
      if (!metrics) localStorage.removeItem(AOI_STATS_SELECTED_METRICS_KEY);
      else localStorage.setItem(AOI_STATS_SELECTED_METRICS_KEY, JSON.stringify(metrics));
    } catch {
    }
  };

  const [aoiStatsSelectedMetrics, setAoiStatsSelectedMetrics] = React.useState<Set<GridMetric> | null>(() => {
    const stored = loadStoredSelectedAoiStatsMetrics();
    if (stored !== null) return new Set(stored);
    const legacy = loadStoredLegacyLabels();
    if (legacy === null) return null;
    const legacyMap: Record<string, GridMetric> = {
      注视次数: 'fixationCount',
      '总注视时长(ms)': 'totalFixationDurationS',
      '平均注视时长(ms)': 'avgFixationDurationS',
      '首次进入时间(ms)': 'firstEnterTimeS',
      '首次注视前时长(ms)': 'firstEnterTimeS',
      '访问次数(打开统计)': 'visits',
      '回看次数(从0播完)': 'revisitCount',
    };
    const mapped = legacy.map((l) => legacyMap[l]).filter((x): x is GridMetric => typeof x === 'string' && allowedMetricIds.has(x));
    return new Set(mapped);
  });

  React.useEffect(() => {
    if (aoiStatsSelectedMetrics === null) {
      storeSelectedAoiStatsMetrics(null);
      return;
    }
    storeSelectedAoiStatsMetrics(Array.from(aoiStatsSelectedMetrics.values()));
  }, [aoiStatsSelectedMetrics]);

  const fpsValue = selectedRecord ? Number(selectedRecord.fps) : NaN;
  const frameStep = Number.isFinite(fpsValue) && fpsValue > 0 ? 1 / fpsValue : 0.04;

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

  React.useEffect(() => {
    if (!canComputeAoiStats) {
      setLoadedRecordDataById({});
      setGridLoading(false);
      setGridError(null);
      return;
    }

    if (!ipcClient.isAvailable()) {
      const emptyData: Record<string, LoadedAoiRecordData> = {};
      selectedStatsRecordIds.forEach((recordId) => {
        emptyData[recordId] = { points: [], stimulusTimelinePoints: [] };
      });
      setLoadedRecordDataById(emptyData);
      setGridLoading(false);
      setGridError(null);
      return;
    }

    let cancelled = false;
    setGridLoading(true);
    setGridError(null);
    (async () => {
      const loadResults = await Promise.all(
        selectedStatsRecordIds.map(async (recordId) => {
          const record = recordsById.get(recordId) || null;
          const csvPath = record?.csvPath;
          if (!csvPath) {
            return {
              recordId,
              points: [] as HeatmapPoint[],
              stimulusTimelinePoints: [] as StimulusTimelinePoint[],
              failed: true,
              message: '未找到 CSV 数据路径',
            };
          }
          try {
            const res = await recordDataService.loadPoints({
              csvPath,
              includeMarkerOnlyRows: true,
              includeSdkSaccades: true,
              pointMode: 'fixation',
              includePupilSamples: true,
              isGlassesMode: record?.deviceType === '眼镜式',
              ...getRecordingFrameSizeOptions(record),
            });
            if (res && res.ok && Array.isArray(res.points)) {
              const points = [...res.points, ...(res.pupilSamples || [])] as HeatmapPoint[];
              return {
                recordId,
                points,
                stimulusTimelinePoints: extractStimulusTimelinePointsFromHeatmapPoints(points.filter((point) => !point.sampleOnly)),
                blinkData: res.blinkData,
                failed: false,
                message: '',
              };
            }
            return {
              recordId,
              points: [] as HeatmapPoint[],
              stimulusTimelinePoints: [] as StimulusTimelinePoint[],
              failed: true,
              message: 'message' in res && res.message ? res.message : '完整统计数据加载失败',
            };
          } catch (error) {
            return {
              recordId,
              points: [] as HeatmapPoint[],
              stimulusTimelinePoints: [] as StimulusTimelinePoint[],
              failed: true,
              message: error instanceof Error ? error.message : '完整统计数据读取异常',
            };
          }
        }),
      );
      if (cancelled) return;

      const nextData: Record<string, LoadedAoiRecordData> = {};
      let failedCount = 0;
      loadResults.forEach((result) => {
        nextData[result.recordId] = {
          points: result.points,
          stimulusTimelinePoints: result.stimulusTimelinePoints,
          blinkData: 'blinkData' in result ? result.blinkData : undefined,
        };
        if (result.failed) failedCount += 1;
      });

      try {
        setLoadedRecordDataById(nextData);
        if (failedCount > 0) {
          if (failedCount === selectedStatsRecordIds.length) {
            setGridError(loadResults.find((result) => result.failed)?.message || 'CSV 加载失败');
          } else {
            setGridError(`部分记录 CSV 加载失败（${failedCount}/${selectedStatsRecordIds.length}）：${loadResults.find((result) => result.failed)?.message || ''}`);
          }
        } else {
          setGridError(null);
        }
      } catch {
        if (!cancelled) setGridError('CSV 读取异常');
      } finally {
        if (!cancelled) setGridLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canComputeAoiStats, selectedStatsRecordIds, recordsById]);

  const primaryRecordDurationMs = React.useMemo(
    () => resolveRecordDurationMs(selectedRecord, Math.max(0, Math.round((duration || 0) * 1000))),
    [duration, selectedRecord],
  );

  const primaryRecordData = React.useMemo(
    () => (aoiSelectedRecordId ? loadedRecordDataById[aoiSelectedRecordId] || null : null),
    [aoiSelectedRecordId, loadedRecordDataById],
  );

  const normalizedGridPoints = React.useMemo(() => {
    return normalizePointsToDurationMs((primaryRecordData?.points || []).filter((point) => !point.sampleOnly), primaryRecordDurationMs);
  }, [primaryRecordData?.points, primaryRecordDurationMs]);

  const normalizedStimulusTimelinePoints = React.useMemo(() => {
    return normalizeStimulusTimelineRowsToDurationMs(
      primaryRecordData?.stimulusTimelinePoints || [],
      primaryRecordDurationMs,
    );
  }, [primaryRecordData?.stimulusTimelinePoints, primaryRecordDurationMs]);

  const normalizedStatsPoints = React.useMemo<RecordScopedHeatmapPoint[]>(() => {
    const list: RecordScopedHeatmapPoint[] = [];
    selectedStatsRecordIds.forEach((recordId, index) => {
      const record = recordsById.get(recordId) || null;
      const fallbackDurationMs = recordId === aoiSelectedRecordId ? primaryRecordDurationMs : 0;
      const recordDurationMs = resolveRecordDurationMs(record, fallbackDurationMs);
      const recordData = loadedRecordDataById[recordId];
      const normalized = normalizePointsToDurationMs(recordData?.points || [], recordDurationMs);
      normalized.forEach((point) => {
        const normalizedId =
          typeof point.id === 'number' && Number.isFinite(point.id)
            ? Math.round(point.id + (index + 1) * RECORD_POINT_ID_SHIFT)
            : point.id;
        list.push({
          ...point,
          id: normalizedId,
          __recordId: recordId,
        });
      });
    });
    list.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    return list;
  }, [selectedStatsRecordIds, recordsById, aoiSelectedRecordId, primaryRecordDurationMs, loadedRecordDataById]);

  const statsRecordDurationMsById = React.useMemo(() => {
    const next: Record<string, number> = {};
    selectedStatsRecordIds.forEach((recordId) => {
      const record = recordsById.get(recordId) || null;
      const fallbackDurationMs = recordId === aoiSelectedRecordId ? primaryRecordDurationMs : 0;
      next[recordId] = resolveRecordDurationMs(record, fallbackDurationMs);
    });
    return next;
  }, [selectedStatsRecordIds, recordsById, aoiSelectedRecordId, primaryRecordDurationMs]);

  const stimulusNameById = React.useMemo(() => {
    const map = new Map<string, string>();
    stimuli.forEach((stimulus) => {
      const id = String(stimulus?.id || '').trim();
      const name = String(stimulus?.name || '').trim();
      if (id && name) map.set(id, name);
    });
    return map;
  }, [stimuli]);

  const stimulusIdByName = React.useMemo(() => {
    const map = new Map<string, string>();
    stimuli.forEach((stimulus) => {
      const id = String(stimulus?.id || '').trim();
      const name = String(stimulus?.name || '').trim();
      if (id && name && !map.has(name)) map.set(name, id);
    });
    return map;
  }, [stimuli]);

  const stimulusIdByNormalizedName = React.useMemo(() => {
    const map = new Map<string, string>();
    stimuli.forEach((stimulus) => {
      const id = String(stimulus?.id || '').trim();
      const name = String(stimulus?.name || '').trim();
      const normalizedName = normalizeStimulusKey(name);
      if (id && normalizedName && !map.has(normalizedName)) {
        map.set(normalizedName, id);
      }
    });
    return map;
  }, [stimuli]);

  const resolveStimulusIdToken = React.useCallback(
    (tokenRaw: string): string => {
      const token = String(tokenRaw || '').trim();
      if (!token) return '';
      if (stimulusNameById.has(token)) return token;
      const byName = stimulusIdByName.get(token);
      if (byName) return byName;

      const normalizedToken = normalizeStimulusKey(token);
      const byNormalizedName = stimulusIdByNormalizedName.get(normalizedToken);
      if (byNormalizedName) return byNormalizedName;

      const stimIdByPattern = /^stimulus_(.+)$/i.exec(token)?.[1]?.trim();
      if (stimIdByPattern && stimulusNameById.has(stimIdByPattern)) {
        return stimIdByPattern;
      }

      return '';
    },
    [stimulusIdByName, stimulusIdByNormalizedName, stimulusNameById],
  );

  const resolveStimulusId = React.useCallback(
    (raw: unknown): string => {
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value) return '';
      const direct = resolveStimulusIdToken(value);
      if (direct) return direct;

      const splitCandidates = value.split(/[|,;]+/g).map((item) => item.trim()).filter(Boolean);
      for (const token of splitCandidates) {
        const id = resolveStimulusIdToken(token);
        if (id) return id;
      }

      const pairCandidates = value
        .split('::')
        .map((item) => item.trim())
        .filter(Boolean);
      for (const token of pairCandidates) {
        const id = resolveStimulusIdToken(token);
        if (id) return id;
      }

      const normalizedValue = normalizeStimulusKey(value);
      if (normalizedValue) {
        for (const [normalizedName, id] of stimulusIdByNormalizedName.entries()) {
          if (!normalizedName || normalizedName.length < 2) continue;
          if (normalizedValue.includes(normalizedName)) return id;
        }
      }

      return '';
    },
    [resolveStimulusIdToken, stimulusIdByNormalizedName],
  );

  const playbackStimulusSpans = React.useMemo<StimulusPlaybackSpan[]>(() => {
    const timelineSourcePoints = normalizedStimulusTimelinePoints
      .map((point) => {
        const stimulusId = resolveStimulusId(point.stimulusRaw);
        const ts = typeof point.timestamp === 'number' && Number.isFinite(point.timestamp) ? point.timestamp : NaN;
        if (!stimulusId || !Number.isFinite(ts)) return null;
        return { stimulusId, timeMs: Math.max(0, ts) };
      })
      .filter(Boolean) as Array<{ stimulusId: string; timeMs: number }>;
    const gazeSourcePoints = normalizedGridPoints
      .filter((point) => !point.markerOnly)
      .map((point) => {
        const stimulusId = resolveStimulusId(point.stimulusName);
        const ts = typeof point.timestamp === 'number' && Number.isFinite(point.timestamp) ? (point.timestamp as number) : NaN;
        if (!stimulusId || !Number.isFinite(ts)) return null;
        return { stimulusId, timeMs: Math.max(0, ts) };
      })
      .filter(Boolean) as Array<{ stimulusId: string; timeMs: number }>;
    const points = timelineSourcePoints.length > 0 ? timelineSourcePoints : gazeSourcePoints;
    if (points.length === 0) return [];
    points.sort((a, b) => a.timeMs - b.timeMs);
    const spans: StimulusPlaybackSpan[] = [];
    let current: StimulusPlaybackSpan = {
      stimulusId: points[0].stimulusId,
      startMs: points[0].timeMs,
      endMs: points[0].timeMs,
    };
    for (let i = 1; i < points.length; i += 1) {
      const next = points[i];
      if (next.stimulusId === current.stimulusId) {
        current.endMs = Math.max(current.endMs, next.timeMs);
        continue;
      }
      spans.push(current);
      current = { stimulusId: next.stimulusId, startMs: next.timeMs, endMs: next.timeMs };
    }
    spans.push(current);

    const durationMs = Math.max(0, Math.round((duration || 0) * 1000));
    spans[0].startMs = 0;
    spans[spans.length - 1].endMs = Math.max(spans[spans.length - 1].endMs, durationMs);
    for (let i = 0; i < spans.length - 1; i += 1) {
      const left = spans[i];
      const right = spans[i + 1];
      const mid = (left.endMs + right.startMs) / 2;
      left.endMs = Math.max(left.startMs, mid);
      right.startMs = Math.min(right.endMs, mid);
    }
    return spans;
  }, [duration, normalizedGridPoints, normalizedStimulusTimelinePoints, resolveStimulusId]);

  const currentPlaybackStimulusSpan = React.useMemo<StimulusPlaybackSpan | null>(() => {
    if (!activeVideoUrl) return null;
    if (playbackStimulusSpans.length === 0) return null;
    const tMs = Math.max(0, (visualCurrentTime || 0) * 1000);
    return resolveAoiPlaybackStimulusSpan(playbackStimulusSpans, tMs, aoiSelectedStimulusId);
  }, [activeVideoUrl, playbackStimulusSpans, visualCurrentTime, aoiSelectedStimulusId]);

  const currentPlaybackStimulusId = React.useMemo(() => {
    const targetId = String(currentPlaybackStimulusSpan?.stimulusId || '').trim();
    return targetId || null;
  }, [currentPlaybackStimulusSpan]);

  const selectedStimulusStartTime = React.useMemo(() => {
    if (!aoiSelectedStimulusId) return null;
    const starts = playbackStimulusSpans
      .filter((span) => span.stimulusId === aoiSelectedStimulusId)
      .map((span) => span.startMs);
    if (starts.length === 0) return null;
    return Math.min(...starts) / 1000;
  }, [aoiSelectedStimulusId, playbackStimulusSpans]);

  const selectedStimulusStartTimeMs = React.useMemo(() => {
    if (selectedStimulusStartTime === null) return 0;
    return Math.max(0, Math.round(selectedStimulusStartTime * 1000));
  }, [selectedStimulusStartTime]);

  const useStimulusRelativeAoiTimeline = React.useMemo(() => {
    if (isGlassesMode) return false;
    if (!aoiSelectedStimulusId) return false;
    if (selectedStimulusKind !== 'video') return false;
    if (!resolvedRecordVideoUrl || activeVideoUrl !== resolvedRecordVideoUrl) return false;
    return selectedStimulusStartTime !== null;
  }, [
    activeVideoUrl,
    aoiSelectedStimulusId,
    isGlassesMode,
    resolvedRecordVideoUrl,
    selectedStimulusKind,
    selectedStimulusStartTime,
  ]);

  const selectedStimulusSpans = React.useMemo(() => {
    if (!aoiSelectedStimulusId) return [] as StimulusPlaybackSpan[];
    return playbackStimulusSpans.filter((span) => span.stimulusId === aoiSelectedStimulusId);
  }, [aoiSelectedStimulusId, playbackStimulusSpans]);

  const toStimulusLocalTimeMs = React.useCallback(
    (timeMs: number): number => {
      if (!useStimulusRelativeAoiTimeline) return Math.max(0, Math.round(timeMs));
      const safeTs = Math.max(0, Math.round(Number(timeMs) || 0));
      if (selectedStimulusSpans.length === 0) {
        return Math.max(0, safeTs - selectedStimulusStartTimeMs);
      }
      const matchedSpan = selectedStimulusSpans.find((span, index) => {
        const isLast = index === selectedStimulusSpans.length - 1;
        return safeTs >= span.startMs && (safeTs < span.endMs || isLast);
      });
      const spanStart = matchedSpan ? matchedSpan.startMs : selectedStimulusStartTimeMs;
      return Math.max(0, safeTs - spanStart);
    },
    [selectedStimulusSpans, selectedStimulusStartTimeMs, useStimulusRelativeAoiTimeline],
  );

  const playbackAoiTimeMs = React.useMemo(() => {
    if (!useStimulusRelativeAoiTimeline) return currentTimeMs;
    if (
      currentPlaybackStimulusSpan &&
      aoiSelectedStimulusId &&
      currentPlaybackStimulusSpan.stimulusId === aoiSelectedStimulusId
    ) {
      return Math.max(0, currentTimeMs - currentPlaybackStimulusSpan.startMs);
    }
    return toStimulusLocalTimeMs(currentTimeMs);
  }, [
    aoiSelectedStimulusId,
    currentPlaybackStimulusSpan,
    currentTimeMs,
    toStimulusLocalTimeMs,
    useStimulusRelativeAoiTimeline,
  ]);

  const toPlaybackGlobalSecondsFromAoiLocal = React.useCallback(
    (localTimeMs: number): number => {
      const safeLocalMs = Math.max(0, Math.round(Number(localTimeMs) || 0));
      if (!useStimulusRelativeAoiTimeline) return safeLocalMs / 1000;
      const activeSpanStartMs =
        currentPlaybackStimulusSpan && aoiSelectedStimulusId && currentPlaybackStimulusSpan.stimulusId === aoiSelectedStimulusId
          ? currentPlaybackStimulusSpan.startMs
          : selectedStimulusStartTimeMs;
      return Math.max(0, activeSpanStartMs + safeLocalMs) / 1000;
    },
    [
      aoiSelectedStimulusId,
      currentPlaybackStimulusSpan,
      selectedStimulusStartTimeMs,
      useStimulusRelativeAoiTimeline,
    ],
  );

  const selectedAoiAnalysisTimeRanges = React.useMemo(
    () => normalizeAoiAnalysisTimeRanges(selectedBaseAoi?.analysisTimeRanges, selectedBaseAoi?.analysisTimeRange) || [],
    [selectedBaseAoi?.analysisTimeRange, selectedBaseAoi?.analysisTimeRanges],
  );

  const selectedAoiTimelineRanges = React.useMemo(
    () =>
      selectedAoiAnalysisTimeRanges
        .map((range, index) => {
          const startTime = toPlaybackGlobalSecondsFromAoiLocal(range.startTimeMs);
          const endTime = toPlaybackGlobalSecondsFromAoiLocal(range.endTimeMs);
          if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) return null;
          return { id: range.id || `aoi_range_${index}`, startTime, endTime, enabled: range.enabled !== false };
        })
        .filter((range): range is { id: string; startTime: number; endTime: number; enabled: boolean } => range !== null),
    [selectedAoiAnalysisTimeRanges, toPlaybackGlobalSecondsFromAoiLocal],
  );

  // AOI mode plays the union of every active AOI range.  The generated segments
  // are playback-only: per-AOI statistics continue to use each shape's own
  // analysisTimeRanges in computeAoiStatsRows.
  const activeAoiPlaybackSegments = React.useMemo<TimeSegment[]>(() => {
    const sourceRanges: Array<{ startTime: number; endTime: number }> = [];

    aoiShapeList.forEach((shape) => {
      const ranges = normalizeAoiAnalysisTimeRanges(shape.analysisTimeRanges, shape.analysisTimeRange) || [];
      ranges.forEach((range) => {
        if (range.enabled === false) return;
        const rawStart = toPlaybackGlobalSecondsFromAoiLocal(range.startTimeMs);
        const rawEnd = toPlaybackGlobalSecondsFromAoiLocal(range.endTimeMs);
        if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return;
        const startTime = Math.max(0, Math.min(rawStart, rawEnd));
        const endTime = duration > 0 ? Math.min(duration, Math.max(rawStart, rawEnd)) : Math.max(rawStart, rawEnd);
        if (endTime <= startTime) return;
        sourceRanges.push({ startTime, endTime });
      });
    });

    sourceRanges.sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime);
    const mergedRanges: Array<{ startTime: number; endTime: number }> = [];
    sourceRanges.forEach((range) => {
      const previous = mergedRanges[mergedRanges.length - 1];
      if (previous && range.startTime <= previous.endTime + 1e-6) {
        previous.endTime = Math.max(previous.endTime, range.endTime);
        return;
      }
      mergedRanges.push({ ...range });
    });

    return mergedRanges.map((range) => {
      const startMs = Math.round(range.startTime * 1000);
      const endMs = Math.round(range.endTime * 1000);
      return {
        id: `aoi_playback_${startMs}_${endMs}`,
        name: 'AOI 统计播放范围',
        startTime: range.startTime,
        endTime: range.endTime,
        color: '#0ea5e9',
        enabled: true,
        createdAt: '',
        updatedAt: '',
      };
    });
  }, [aoiShapeList, duration, toPlaybackGlobalSecondsFromAoiLocal]);

  const playbackSegments = React.useMemo(
    () => (timelineRangeMode === 'scoped' ? activeAoiPlaybackSegments : orderedSegments),
    [activeAoiPlaybackSegments, orderedSegments, timelineRangeMode],
  );
  const selectedSegment = React.useMemo(
    () =>
      timelineRangeMode === 'segment'
        ? orderedSegments.find((segment) => segment.id === selectedSegmentId) || null
        : null,
    [orderedSegments, selectedSegmentId, timelineRangeMode],
  );
  const playbackSegment = React.useMemo(
    () => playbackSegments.find((segment) => segment.id === playbackSegmentId) || null,
    [playbackSegmentId, playbackSegments],
  );
  const shouldPlayBySegments = playbackSegments.length > 0 && !selectedSegment && customTimeRange === null;
  const effectiveSegment = React.useMemo(
    () => (customTimeRange ? null : selectedSegment || playbackSegment),
    [customTimeRange, selectedSegment, playbackSegment],
  );

  const handleSelectedAoiTimeRangeChange = React.useCallback(
    (startTime: number, endTime: number) => {
      if (!selectedBaseAoi) return;
      const globalStartMs = Math.max(0, Math.round(Math.min(startTime, endTime) * 1000));
      const globalEndMs = Math.max(0, Math.round(Math.max(startTime, endTime) * 1000));
      const startTimeMs = toStimulusLocalTimeMs(globalStartMs);
      const endTimeMs = toStimulusLocalTimeMs(globalEndMs);
      if (endTimeMs <= startTimeMs) return;
      const nextRange = {
        id: `aoi_range_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        startTimeMs,
        endTimeMs,
        enabled: true,
      } satisfies AoiAnalysisTimeRange;
      setAoiShapes((prev) =>
        (prev as AoiShape[]).map((shape) => {
          if (shape.id !== selectedBaseAoi.id) return shape;
          const currentRanges = normalizeAoiAnalysisTimeRanges(shape.analysisTimeRanges, shape.analysisTimeRange) || [];
          const overlapsExistingRange = currentRanges.some(
            (range) => nextRange.startTimeMs < range.endTimeMs && range.startTimeMs < nextRange.endTimeMs,
          );
          if (overlapsExistingRange) return shape;
          const analysisTimeRanges = [...currentRanges, nextRange].sort(
            (left, right) => left.startTimeMs - right.startTimeMs || left.endTimeMs - right.endTimeMs,
          );
          const nextShape = { ...shape, analysisTimeRanges };
          delete nextShape.analysisTimeRange;
          return nextShape;
        }),
      );
    },
    [selectedBaseAoi, setAoiShapes, toStimulusLocalTimeMs],
  );

  const handleRemoveAoiTimeRange = React.useCallback(
    (aoiId: string, rangeId: string) => {
      setAoiShapes((prev) =>
        (prev as AoiShape[]).map((shape) => {
          if (shape.id !== aoiId) return shape;
          const currentRanges = normalizeAoiAnalysisTimeRanges(shape.analysisTimeRanges, shape.analysisTimeRange) || [];
          const analysisTimeRanges = currentRanges.filter((range) => range.id !== rangeId);
          if (analysisTimeRanges.length === currentRanges.length) return shape;
          const nextShape = { ...shape };
          delete nextShape.analysisTimeRange;
          if (analysisTimeRanges.length > 0) nextShape.analysisTimeRanges = analysisTimeRanges;
          else delete nextShape.analysisTimeRanges;
          return nextShape;
        }),
      );
    },
    [setAoiShapes],
  );

  const handleRemoveSelectedAoiTimeRange = React.useCallback(
    (rangeId: string) => {
      if (!selectedBaseAoi) return;
      handleRemoveAoiTimeRange(selectedBaseAoi.id, rangeId);
    },
    [handleRemoveAoiTimeRange, selectedBaseAoi],
  );

  const handleAoiTimeRangeEnabledChange = React.useCallback(
    (aoiId: string, rangeId: string, enabled: boolean) => {
      setAoiShapes((prev) =>
        (prev as AoiShape[]).map((shape) => {
          if (shape.id !== aoiId) return shape;
          const currentRanges = normalizeAoiAnalysisTimeRanges(shape.analysisTimeRanges, shape.analysisTimeRange) || [];
          const analysisTimeRanges = currentRanges.map((range) =>
            range.id === rangeId ? { ...range, enabled } : range,
          );
          if (analysisTimeRanges.every((range, index) => range === currentRanges[index])) return shape;
          const nextShape = { ...shape, analysisTimeRanges };
          delete nextShape.analysisTimeRange;
          return nextShape;
        }),
      );
    },
    [setAoiShapes],
  );

  const handleSelectedAoiTimeRangeEnabledChange = React.useCallback(
    (rangeId: string, enabled: boolean) => {
      if (!selectedBaseAoi) return;
      handleAoiTimeRangeEnabledChange(selectedBaseAoi.id, rangeId, enabled);
    },
    [handleAoiTimeRangeEnabledChange, selectedBaseAoi],
  );

  const handleClearSelectedAoiTimeRange = React.useCallback(() => {
    if (!selectedBaseAoi) return;
    setAoiShapes((prev) =>
      (prev as AoiShape[]).map((shape) => {
        if (shape.id !== selectedBaseAoi.id || (!shape.analysisTimeRanges && !shape.analysisTimeRange)) return shape;
        const nextShape = { ...shape };
        delete nextShape.analysisTimeRange;
        delete nextShape.analysisTimeRanges;
        return nextShape;
      }),
    );
  }, [selectedBaseAoi, setAoiShapes]);

  const safePause = () => {
    const el = aoiVideoRef.current;
    if (!el) return;
    try {
      el.pause();
    } catch {
    }
  };

  const resolveSegmentIndexByTime = React.useCallback(
    (timeSeconds: number): number => {
      if (playbackSegments.length === 0) return -1;
      const inRange = playbackSegments.findIndex(
        (segment) => timeSeconds >= segment.startTime && timeSeconds <= segment.endTime,
      );
      if (inRange >= 0) return inRange;
      const next = playbackSegments.findIndex((segment) => timeSeconds < segment.startTime);
      if (next >= 0) return next;
      return playbackSegments.length - 1;
    },
    [playbackSegments],
  );

  const togglePlay = () => {
    const el = aoiVideoRef.current;
    if (!el) return;
    if (el.paused || el.ended) {
      if (shouldPlayBySegments) {
        const firstSegment = playbackSegments[0];
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
        if (el.currentTime >= stimulusTimeRange.endTime || el.currentTime < stimulusTimeRange.startTime) {
          try {
            el.currentTime = stimulusTimeRange.startTime;
            setCurrentTime(stimulusTimeRange.startTime);
            setVisualCurrentTime(stimulusTimeRange.startTime);
          } catch {
          }
        }
      } else if (el.ended) {
        try {
          el.currentTime = 0;
          setCurrentTime(0);
          setVisualCurrentTime(0);
        } catch {
        }
      }
      try {
        void el.play();
      } catch {
      }
      return;
    }
    safePause();
  };

  const getShapeEditTargetTimeMsAtPlayback = React.useCallback(
    (shape: AoiShape): number | null => {
      const keyframes = sortAoiKeyframes(shape.keyframes);
      if (keyframes.length === 0) return 0;
      if (playbackAoiTimeMs <= KEYFRAME_EDIT_TOLERANCE_MS) return 0;
      return findNearbyKeyframeTime(shape, playbackAoiTimeMs, KEYFRAME_EDIT_TOLERANCE_MS);
    },
    [playbackAoiTimeMs],
  );

  const aoiEditTargetTimeById = React.useMemo(() => {
    const next: Record<string, number | null> = {};
    aoiShapeList.forEach((shape) => {
      next[shape.id] = getShapeEditTargetTimeMsAtPlayback(shape);
    });
    return next;
  }, [aoiShapeList, getShapeEditTargetTimeMsAtPlayback]);

  const selectedShapeEditTargetTimeForPlaybackMs = React.useMemo(
    () => (selectedBaseAoi ? getShapeEditTargetTimeMsAtPlayback(selectedBaseAoi) : null),
    [getShapeEditTargetTimeMsAtPlayback, selectedBaseAoi],
  );

  const selectedCurrentKeyframeTimeForPlayback = React.useMemo(
    () =>
      selectedBaseAoi
        ? findNearbyKeyframeTime(selectedBaseAoi, playbackAoiTimeMs, KEYFRAME_EDIT_TOLERANCE_MS)
        : null,
    [playbackAoiTimeMs, selectedBaseAoi],
  );

  const autoDisplayStimulusId = React.useMemo(() => {
    if (aoiSelectedStimulusId) return null;
    return currentPlaybackStimulusId;
  }, [aoiSelectedStimulusId, currentPlaybackStimulusId]);

  const autoDisplayAoiShapes = React.useMemo(() => {
    if (aoiSelectedStimulusId) return [];
    if (!autoDisplayStimulusId) return [];
    const list = aoiStoreByStimulusId[autoDisplayStimulusId];
    if (!Array.isArray(list) || list.length === 0) return [];
    return list.map((shape) => denormalizeAoiShapeWithLayout(shape));
  }, [aoiSelectedStimulusId, autoDisplayStimulusId, aoiStoreByStimulusId, denormalizeAoiShapeWithLayout]);

  const selectedStimulusAoiVisible = React.useMemo(() => {
    if (!aoiSelectedStimulusId) return false;
    if (!activeVideoUrl) return true;
    if (!canComputeAoiStats) return true;
    if (playbackStimulusSpans.length === 0) return false;
    if (!currentPlaybackStimulusId) return false;
    return currentPlaybackStimulusId === aoiSelectedStimulusId;
  }, [activeVideoUrl, aoiSelectedStimulusId, canComputeAoiStats, currentPlaybackStimulusId, playbackStimulusSpans.length]);

  const canvasShapeList = React.useMemo(
    () => {
      if (isGlassesMode) {
        return aoiShapeList;
      }
      if (aoiSelectedStimulusId) {
        return selectedStimulusAoiVisible ? aoiShapeList : [];
      }
      return autoDisplayAoiShapes;
    },
    [aoiSelectedStimulusId, aoiShapeList, autoDisplayAoiShapes, isGlassesMode, selectedStimulusAoiVisible],
  );
  const canvasRenderedAoiShapes = React.useMemo(
    () => canvasShapeList.map((shape) => resolveAoiShapeAtTime(shape, playbackAoiTimeMs)),
    [canvasShapeList, playbackAoiTimeMs],
  );
  const visibleCanvasRenderedAoiShapes = React.useMemo(
    () => canvasRenderedAoiShapes.filter((shape) => shape?.visible !== false),
    [canvasRenderedAoiShapes],
  );
  const selectedRenderedAoi = React.useMemo(
    () => canvasRenderedAoiShapes.find((shape) => shape?.id === aoiSelectedId) || null,
    [aoiSelectedId, canvasRenderedAoiShapes],
  );

  const alignedGridPoints = React.useMemo(() => {
    const renderable = normalizedGridPoints.filter((p) => !p.markerOnly);
    if (!isGlassesMode && aoiSelectedStimulusId) {
      return renderable.filter((p) => resolveStimulusId(p.stimulusName) === aoiSelectedStimulusId);
    }
    return renderable;
  }, [aoiSelectedStimulusId, isGlassesMode, normalizedGridPoints, resolveStimulusId]);

  const alignedGridPointsSingleFiltered = useFilteredData(alignedGridPoints, effectiveSegment);
  const alignedGridPointsSequenceFiltered = React.useMemo(
    () => filterBySegments(alignedGridPoints, orderedSegments),
    [alignedGridPoints, orderedSegments],
  );
  const alignedGridPointsFiltered = timelineRangeMode === 'scoped'
    ? alignedGridPoints
    : shouldPlayBySegments
      ? alignedGridPointsSequenceFiltered
      : alignedGridPointsSingleFiltered;

  const statsStimulusId = React.useMemo(() => {
    if (isGlassesMode) return null;
    if (aoiSelectedStimulusId) return aoiSelectedStimulusId;
    if (!activeVideoUrl) return null;
    return currentPlaybackStimulusId;
  }, [activeVideoUrl, aoiSelectedStimulusId, currentPlaybackStimulusId, isGlassesMode]);

  const alignedGridPointsForStats = React.useMemo(() => {
    const renderable = normalizedStatsPoints.filter((p) => !p.markerOnly);
    if (!statsStimulusId) return renderable;
    return renderable.filter((p) => resolveStimulusId(p.stimulusName) === statsStimulusId);
  }, [normalizedStatsPoints, resolveStimulusId, statsStimulusId]);

  const alignedGridPointsForStatsSequenceFiltered = React.useMemo(
    () => filterBySegments(alignedGridPointsForStats, orderedSegments) as RecordScopedHeatmapPoint[],
    [alignedGridPointsForStats, orderedSegments],
  );
  // Statistic scopes are independent from playback selection. In global mode,
  // all active global ranges constrain every AOI. In AOI mode, each shape's
  // own ranges are applied later by computeAoiStatsRows.
  const analysisPointsForStats = React.useMemo(
    () =>
      timelineRangeMode === 'segment'
        ? alignedGridPointsForStatsSequenceFiltered
        : alignedGridPointsForStats,
    [alignedGridPointsForStats, alignedGridPointsForStatsSequenceFiltered, timelineRangeMode],
  );
  const alignedGridPointsForStatsFiltered = analysisPointsForStats;

  const timelinePoints = React.useMemo(
    () => normalizedGridPoints,
    [normalizedGridPoints],
  );

  // Calculate stimulus time range for video playback restriction
  const stimulusTimeRange = React.useMemo(() => {
    if (customTimeRange) {
      return customTimeRange;
    }

    if (shouldPlayBySegments && playbackSegments.length > 0) {
      return {
        startTime: playbackSegments[0].startTime,
        endTime: playbackSegments[playbackSegments.length - 1].endTime,
      };
    }

    // Selected segment has second priority
    if (effectiveSegment) {
      return {
        startTime: effectiveSegment.startTime,
        endTime: effectiveSegment.endTime,
      };
    }

    if (isGlassesMode) {
      return null;
    }

    if (stimulusVideoUrl && activeVideoUrl === stimulusVideoUrl) {
      return duration > 0
        ? {
            startTime: 0,
            endTime: duration,
          }
        : null;
    }

    if (aoiSelectedStimulusId && selectedStimulusSpans.length > 0) {
      return {
        startTime: selectedStimulusSpans[0].startMs / 1000,
        endTime: selectedStimulusSpans[selectedStimulusSpans.length - 1].endMs / 1000,
      };
    }
    
    if (!activeVideoUrl || alignedGridPointsFiltered.length === 0) {
      return null;
    }
    
    const timestamps = alignedGridPointsFiltered
      .map(p => p.timestamp)
      .filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
    
    if (timestamps.length === 0) return null;
    
    const minTs = Math.min(...timestamps);
    const maxTs = Math.max(...timestamps);
    
    // Convert to seconds
    return {
      startTime: minTs / 1000,
      endTime: maxTs / 1000,
    };
  }, [
    activeVideoUrl,
    alignedGridPointsFiltered,
    customTimeRange,
    duration,
    effectiveSegment,
    isGlassesMode,
    playbackSegments,
    aoiSelectedStimulusId,
    selectedStimulusSpans,
    shouldPlayBySegments,
    stimulusVideoUrl,
  ]);

  const aoiPointsAtTime = React.useMemo(() => {
    if (!shouldUsePlaybackTimeForStats) {
      return alignedGridPointsForStatsFiltered;
    }
    const offsetMs = typeof timeOffsetMs === 'number' && Number.isFinite(timeOffsetMs) ? timeOffsetMs : 0;
    const tMs = Math.max(0, currentTimeMs + offsetMs);
    // 视频帧率与注视点采样率不同步：播放停止时 currentTimeMs 可能比最后一帧注视点
    // timestamp 略小（Math.round 舍入 + 帧间隔），导致最后一帧数据被 ts<=tMs 过滤掉。
    // 加一帧容差，确保停止瞬间能包含最后一帧数据（对播放中的显示影响可忽略）。
    const FRAME_TOLERANCE_MS = 100;
    const filtered = alignedGridPointsForStatsFiltered.filter((p) => {
      const ts = typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? (p.timestamp as number) : 0;
      return ts <= tMs + FRAME_TOLERANCE_MS;
    });
    if (filtered.length < alignedGridPointsForStatsFiltered.length) {
      void ipcClient.videoDebugLog({
        event: 'aoi:points-filtered',
        details: {
          tMs,
          currentTimeMs,
          primaryRecordDurationMs,
          before: alignedGridPointsForStatsFiltered.length,
          after: filtered.length,
          dropped: alignedGridPointsForStatsFiltered.length - filtered.length,
        },
      });
    }
    return filtered;
  }, [
    alignedGridPointsForStatsFiltered,
    currentTimeMs,
    primaryRecordDurationMs,
    shouldUsePlaybackTimeForStats,
    timeOffsetMs,
  ]);

  const mapPointsToAoiTimeline = React.useCallback(
    (points: HeatmapPoint[]): HeatmapPoint[] => {
      if (!useStimulusRelativeAoiTimeline || !Array.isArray(points) || points.length === 0) {
        return points;
      }
      return points.map((point) => {
        const ts =
          typeof point.timestamp === 'number' && Number.isFinite(point.timestamp)
            ? (point.timestamp as number)
            : 0;
        return {
          ...point,
          timestamp: toStimulusLocalTimeMs(ts),
        };
      });
    },
    [toStimulusLocalTimeMs, useStimulusRelativeAoiTimeline],
  );

  const buildStatsRowsByRecordForPoints = React.useCallback(
    (
      shapes: NormalizedAoiShape[],
      points: RecordScopedHeatmapPoint[],
      completeRangePoints: RecordScopedHeatmapPoint[] = points,
    ): Record<string, AoiStatsRow[]> => {
      if (!Array.isArray(shapes) || shapes.length === 0) return {};
      const groupPointsByRecordId = (source: RecordScopedHeatmapPoint[]): Map<string, HeatmapPoint[]> => {
        const grouped = new Map<string, HeatmapPoint[]>();
        selectedStatsRecordIds.forEach((recordId) => grouped.set(recordId, []));
        source.forEach((point) => {
          const { __recordId, ...rest } = point;
          const list = grouped.get(__recordId);
          if (list) list.push(rest);
        });
        return grouped;
      };
      const pointsByRecordId = groupPointsByRecordId(points);
      const completeRangePointsByRecordId = groupPointsByRecordId(completeRangePoints);

      const rowsByRecordId: Record<string, AoiStatsRow[]> = {};
      selectedStatsRecordIds.forEach((recordId) => {
        const record = recordsById.get(recordId) || null;
        const participantKey = String(record?.subjectName || recordId).trim() || recordId;
        const pointsForRecord = mapPointsToAoiTimeline(pointsByRecordId.get(recordId) || []);
        const completeRangePointsForRecord = mapPointsToAoiTimeline(completeRangePointsByRecordId.get(recordId) || []);
        const rows = timelineRangeMode === 'scoped'
          ? shapes.flatMap((shape) => {
              const sourcePoints = normalizeAoiAnalysisTimeRanges(shape.analysisTimeRanges, shape.analysisTimeRange)
                ? completeRangePointsForRecord
                : pointsForRecord;
              return computeAoiStatsRows({
                shapes: [shape],
                points: sourcePoints,
                recordDurationMs: statsRecordDurationMsById[recordId] || 0,
                timeOffsetMs: 0,
                frameWidth: record?.videoWidth,
                blinkData: loadedRecordDataById[recordId]?.blinkData,
              });
            })
          : computeAoiStatsRows({
              // Global statistics deliberately ignore AOI-owned ranges. The
              // common global timeline is the sole time filter in this mode.
              shapes: shapes.map(({ analysisTimeRange, analysisTimeRanges, ...shape }) => shape),
              points: pointsForRecord,
              recordDurationMs: statsRecordDurationMsById[recordId] || 0,
              timeOffsetMs: 0,
              frameWidth: record?.videoWidth,
              blinkData: loadedRecordDataById[recordId]?.blinkData,
            });
        rowsByRecordId[recordId] = rows.map((row) => ({ ...row, recordId, participantKey }));
      });
      return rowsByRecordId;
    },
    [mapPointsToAoiTimeline, recordsById, selectedStatsRecordIds, statsRecordDurationMsById, timelineRangeMode, loadedRecordDataById],
  );

  const buildStatsRowsForPoints = React.useCallback(
    (
      shapes: NormalizedAoiShape[],
      points: RecordScopedHeatmapPoint[],
      completeRangePoints: RecordScopedHeatmapPoint[] = points,
    ): AoiStatsRow[] => {
      if (!Array.isArray(shapes) || shapes.length === 0) return [];
      const rowsByRecordId = buildStatsRowsByRecordForPoints(shapes, points, completeRangePoints);
      if (selectedStatsRecordIds.length <= 1) {
        const recordId = selectedStatsRecordIds[0] || '';
        return rowsByRecordId[recordId] || [];
      }
      const mergedRows: AoiStatsRow[] = [];
      selectedStatsRecordIds.forEach((recordId) => {
        mergedRows.push(...(rowsByRecordId[recordId] || []));
      });
      return aggregateAoiStatsRows(
        mergedRows,
        shapes.map((shape) => shape.id),
      );
    },
    [buildStatsRowsByRecordForPoints, selectedStatsRecordIds],
  );

  const gridPointsAtTime = React.useMemo(() => {
    if (!gridEnabled) return [];
    return aoiPointsAtTime;
  }, [aoiPointsAtTime, gridEnabled]);

  const gridShapes = React.useMemo(() => {
    const rows = Math.max(1, Math.min(20, Math.round(gridRows)));
    const cols = Math.max(1, Math.min(20, Math.round(gridCols)));
    const list: NormalizedAoiShape[] = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        list.push({
          id: `grid_${r}_${c}`,
          name: `${r + 1}-${c + 1}`,
          type: 'rect',
          visible: true,
          showStats: false,
          color: 'sky',
          x: c / cols,
          y: r / rows,
          w: 1 / cols,
          h: 1 / rows,
        });
      }
    }
    return list;
  }, [gridRows, gridCols]);

  const [gridStatsRows, setGridStatsRows] = React.useState<AoiStatsRow[]>([]);
  const gridStatsRequestSeqRef = React.useRef(0);
  const gridStatsAppliedSeqRef = React.useRef(0);
  React.useEffect(() => {
    const requestSeq = gridStatsRequestSeqRef.current + 1;
    gridStatsRequestSeqRef.current = requestSeq;
    if (!gridEnabled || gridShapes.length === 0 || selectedStatsRecordIds.length === 0) {
      setGridStatsRows([]);
      return;
    }
    void (async () => {
      const grouped = new Map<string, HeatmapPoint[]>();
      selectedStatsRecordIds.forEach((recordId) => grouped.set(recordId, []));
      (gridPointsAtTime as RecordScopedHeatmapPoint[]).forEach((point) => {
        const { __recordId, ...rest } = point;
        grouped.get(__recordId)?.push(rest);
      });
      const jobs = selectedStatsRecordIds.map((recordId) => {
        const record = recordsById.get(recordId) || null;
        return {
          recordId,
          participantKey: String(record?.subjectName || recordId).trim() || recordId,
          shapes: gridShapes,
          points: mapPointsToAoiTimeline(grouped.get(recordId) || []),
          recordDurationMs: statsRecordDurationMsById[recordId] || 0,
          frameWidth: record?.videoWidth,
          blinkData: loadedRecordDataById[recordId]?.blinkData,
        };
      });
      const result = await ipcClient.computeAoiStats({ jobs });
        if (requestSeq < gridStatsAppliedSeqRef.current || !result.ok) return;
        gridStatsAppliedSeqRef.current = requestSeq;
        const rowsByRecordId = result.rowsByRecordId as Record<string, AoiStatsRow[]>;
        const rows = selectedStatsRecordIds.flatMap((recordId) => rowsByRecordId[recordId] || []);
        setGridStatsRows(
          selectedStatsRecordIds.length <= 1
            ? rows
            : aggregateAoiStatsRows(rows, gridShapes.map((shape) => shape.id)),
        );
    })();
  }, [
    gridEnabled,
    gridPointsAtTime,
    loadedRecordDataById,
    gridShapes,
    mapPointsToAoiTimeline,
    recordsById,
    selectedStatsRecordIds,
    statsRecordDurationMsById,
  ]);

  const gridValuesById = React.useMemo(() => {
    const values: Record<string, number | null> = {};
    if (!gridEnabled) return values;
    const asMs = (ms: number | null) => (ms === null ? null : Number.isFinite(ms) ? ms : null);
    for (const row of gridStatsRows) {
      let v: number | null = null;
      if (gridMetric === 'fixationCount') {
        v = row.fixationCount;
      } else if (gridMetric === 'firstEnterTimeS') {
        v = asMs(row.firstEnterTimeMs);
      } else if (gridMetric === 'fixationCountPreEntry') {
        v = row.fixationCountPreEntry;
      } else if (gridMetric === 'firstFixationDurationS') {
        v = asMs(row.firstFixationDurationMs);
      } else if (gridMetric === 'totalFixationDurationS') {
        v = asMs(row.totalDurationMs);
      } else if (gridMetric === 'avgFixationDurationS') {
        v = asMs(row.avgDurationMs);
      } else if (gridMetric === 'visitorCount') {
        v = row.visitorCount;
      } else if (gridMetric === 'maxFixationDurationS') {
        v = asMs(row.maxFixationDurationMs);
      } else if (gridMetric === 'totalVisitDurationS') {
        v = asMs(row.totalVisitDurationMs);
      } else if (gridMetric === 'firstVisitDurationS') {
        v = asMs(row.firstVisitDurationMs);
      } else if (gridMetric === 'firstVisitFixationDurationS') {
        v = asMs(row.firstVisitFixationDurationMs);
      } else if (gridMetric === 'firstVisitFixationCount') {
        v = row.firstVisitFixationCount;
      } else if (gridMetric === 'avgVisitDurationS') {
        v = asMs(row.avgVisitDurationMs);
      } else if (gridMetric === 'visits') {
        v = row.visits;
      } else if (gridMetric === 'reVisitorCount') {
        v = row.reVisitorCount;
      } else if (gridMetric === 'revisitCount') {
        v = row.revisitCount;
      } else if (gridMetric === 'totalSaccadeDurationS') {
        v = asMs(row.totalSaccadeDurationMs);
      } else if (gridMetric === 'saccadeCount') {
        v = row.saccadeCount;
      } else if (gridMetric === 'avgSaccadeDurationS') {
        v = asMs(row.avgSaccadeDurationMs);
      } else if (gridMetric === 'avgSaccadeVelocity') {
        v = row.avgSaccadeVelocity;
      } else if (gridMetric === 'avgSaccadeAmplitude') {
        v = row.avgSaccadeAmplitude;
      } else if (gridMetric === 'peakSaccadeVelocity') {
        v = row.peakSaccadeVelocity;
      } else if (gridMetric === 'avgPupilDiameterMm') {
        v = row.avgPupilDiameter;
      }
      values[row.aoiId] = typeof v === 'number' && Number.isFinite(v) ? v : null;
    }
    return values;
  }, [gridEnabled, gridMetric, gridStatsRows]);

  const gridScale = React.useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const v of Object.values(gridValuesById)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (min === max) return { min, max: min + 1 };
    return { min, max };
  }, [gridValuesById]);

  const valueToRgba = React.useCallback((value: number, min: number, max: number, alpha: number): string => {
    const t = max <= min ? 1 : Math.max(0, Math.min(1, (value - min) / (max - min)));
    const hue = 220 - 220 * t;
    const sat = 90;
    const light = 55;
    return `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`;
  }, []);

  const formatGridValue = React.useCallback((v: number | null) => {
    if (v === null || !Number.isFinite(v)) return '-';
    if (gridMetric === 'fixationCount' || gridMetric === 'fixationCountPreEntry' || gridMetric === 'visitorCount' || gridMetric === 'firstVisitFixationCount' || gridMetric === 'visits' || gridMetric === 'reVisitorCount' || gridMetric === 'revisitCount' || gridMetric === 'saccadeCount') {
      return String(Math.round(v));
    }
    if (gridMetric === 'avgPupilDiameterMm') return v.toFixed(2);
    return v.toFixed(3);
  }, [gridMetric]);

  const normalizedAoiShapes = React.useMemo(() => {
    if (gridEnabled) return [];
    const safeW = aoiContainLayout.drawW > 0 ? aoiContainLayout.drawW : Math.max(1, aoiContainLayout.containerW);
    const safeH = aoiContainLayout.drawH > 0 ? aoiContainLayout.drawH : Math.max(1, aoiContainLayout.containerH);
    const ox = Number.isFinite(aoiContainLayout.drawLeft) ? aoiContainLayout.drawLeft : 0;
    const oy = Number.isFinite(aoiContainLayout.drawTop) ? aoiContainLayout.drawTop : 0;
    return aoiShapeList.map((shape) => {
      const base: NormalizedAoiShape = {
        id: String(shape.id || ''),
        name: String(shape.name || ''),
        type: shape.type === 'polygon' ? 'polygon' : shape.type === 'ellipse' ? 'ellipse' : 'rect',
        visible: !!shape.visible,
        showStats: !!shape.showStats,
        color: String(shape.color || 'sky'),
        metric: typeof shape.metric === 'number' && Number.isFinite(shape.metric) ? shape.metric : 0,
        activationTimeMs:
          typeof shape.activationTimeMs === 'number' && Number.isFinite(shape.activationTimeMs)
            ? Math.max(0, Math.round(shape.activationTimeMs))
            : 0,
        analysisTimeRanges: normalizeAoiAnalysisTimeRanges(shape.analysisTimeRanges, shape.analysisTimeRange),
      };
      if (base.type === 'polygon') {
        const pts = (shape.points || []).map((p) => ({
          x: Math.max(0, Math.min(1, ((p.x || 0) - ox) / safeW)),
          y: Math.max(0, Math.min(1, ((p.y || 0) - oy) / safeH)),
        }));
        const keyframes = sortAoiKeyframes(shape.keyframes).map((keyframe) => ({
          timeMs: Math.max(0, Math.round(keyframe.timeMs || 0)),
          metric: typeof keyframe.metric === 'number' && Number.isFinite(keyframe.metric) ? keyframe.metric : 0,
          points: (keyframe.points || []).map((point) => ({
            x: Math.max(0, Math.min(1, ((point.x || 0) - ox) / safeW)),
            y: Math.max(0, Math.min(1, ((point.y || 0) - oy) / safeH)),
          })),
        }));
        return { ...base, points: pts, keyframes };
      }
      const x = typeof shape.x === 'number' && Number.isFinite(shape.x) ? shape.x : 0;
      const y = typeof shape.y === 'number' && Number.isFinite(shape.y) ? shape.y : 0;
      const w = typeof shape.w === 'number' && Number.isFinite(shape.w) ? shape.w : 0;
      const h = typeof shape.h === 'number' && Number.isFinite(shape.h) ? shape.h : 0;
      const keyframes = sortAoiKeyframes(shape.keyframes).map((keyframe) => ({
        timeMs: Math.max(0, Math.round(keyframe.timeMs || 0)),
        metric: typeof keyframe.metric === 'number' && Number.isFinite(keyframe.metric) ? keyframe.metric : 0,
        x: Math.max(0, Math.min(1, ((keyframe.x || 0) - ox) / safeW)),
        y: Math.max(0, Math.min(1, ((keyframe.y || 0) - oy) / safeH)),
        w: Math.max(0, Math.min(1, (keyframe.w || 0) / safeW)),
        h: Math.max(0, Math.min(1, (keyframe.h || 0) / safeH)),
      }));
      return {
        ...base,
        x: Math.max(0, Math.min(1, (x - ox) / safeW)),
        y: Math.max(0, Math.min(1, (y - oy) / safeH)),
        w: Math.max(0, Math.min(1, w / safeW)),
        h: Math.max(0, Math.min(1, h / safeH)),
        keyframes,
      };
    });
  }, [aoiContainLayout.containerH, aoiContainLayout.containerW, aoiContainLayout.drawH, aoiContainLayout.drawLeft, aoiContainLayout.drawTop, aoiContainLayout.drawW, aoiShapeList, gridEnabled]);

  React.useEffect(() => {
    const storageKey = isGlassesMode && aoiSelectedRecordId ? `record:${aoiSelectedRecordId}` : aoiSelectedStimulusId;
    if (!storageKey) return;
    if (gridEnabled) return;
    if (!isContainLayoutSettled) return;
    setAoiStoreByStimulusId((prev) => ({
      ...prev,
      [storageKey]: normalizedAoiShapes,
    }));
  }, [aoiSelectedRecordId, aoiSelectedStimulusId, gridEnabled, isContainLayoutSettled, isGlassesMode, normalizedAoiShapes]);

  const activeNormalizedAoiShapes = React.useMemo(() => {
    if (gridEnabled) return [];
    if (isGlassesMode) return normalizedAoiShapes;
    if (aoiSelectedStimulusId) return normalizedAoiShapes;
    if (!autoDisplayStimulusId) return [];
    const list = aoiStoreByStimulusId[autoDisplayStimulusId];
    return Array.isArray(list) ? list : [];
  }, [aoiSelectedStimulusId, aoiStoreByStimulusId, autoDisplayStimulusId, gridEnabled, isGlassesMode, normalizedAoiShapes]);

  const [aoiStatsRowsByRecordId, setAoiStatsRowsByRecordId] = React.useState<Record<string, AoiStatsRow[]>>({});
  const aoiStatsRequestSeqRef = React.useRef(0);
  const aoiStatsAppliedSeqRef = React.useRef(0);
  const aoiStatsDebugRef = React.useRef('');

  React.useEffect(() => {
    const requestSeq = aoiStatsRequestSeqRef.current + 1;
    aoiStatsRequestSeqRef.current = requestSeq;
    if (gridEnabled || activeNormalizedAoiShapes.length === 0 || selectedStatsRecordIds.length === 0) {
      setAoiStatsRowsByRecordId({});
      return;
    }

    void (async () => {
      const grouped = new Map<string, HeatmapPoint[]>();
      selectedStatsRecordIds.forEach((recordId) => grouped.set(recordId, []));
      (aoiPointsAtTime as RecordScopedHeatmapPoint[]).forEach((point) => {
        const { __recordId, ...rest } = point;
        grouped.get(__recordId)?.push(rest);
      });
      const shapes = timelineRangeMode === 'scoped'
        ? activeNormalizedAoiShapes
        : activeNormalizedAoiShapes.map(({ analysisTimeRange, analysisTimeRanges, ...shape }) => shape);
      const jobs = selectedStatsRecordIds.map((recordId) => {
        const record = recordsById.get(recordId) || null;
        return {
          recordId,
          participantKey: String(record?.subjectName || recordId).trim() || recordId,
          shapes,
          points: mapPointsToAoiTimeline(grouped.get(recordId) || []),
          recordDurationMs: statsRecordDurationMsById[recordId] || 0,
          frameWidth: record?.videoWidth,
          blinkData: loadedRecordDataById[recordId]?.blinkData,
        };
      });
      // debug: 记录映射后点的范围 + shape 时间范围，定位「最后一帧」丢失环节（去重）
      const debugKey = jobs
        .map((job) => {
          let minTs = Infinity;
          let maxTs = -Infinity;
          for (const p of job.points) {
            const ts = typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? (p.timestamp as number) : NaN;
            if (Number.isFinite(ts)) {
              minTs = Math.min(minTs, ts);
              maxTs = Math.max(maxTs, ts);
            }
          }
          return `${job.recordId}:${Number.isFinite(minTs) ? Math.round(minTs) : 'nan'}:${Number.isFinite(maxTs) ? Math.round(maxTs) : 'nan'}:${job.points.length}:${job.recordDurationMs}`;
        })
        .join('|');
      if (debugKey !== aoiStatsDebugRef.current) {
        aoiStatsDebugRef.current = debugKey;
        void ipcClient.videoDebugLog({
          event: 'aoi:stats-jobs-built',
          details: {
            useStimulusRelativeAoiTimeline,
            selectedStimulusStartTimeMs,
            selectedStimulusSpansStartEnd: selectedStimulusSpans.map((s) => [s.startMs, s.endMs]),
            aoiPointsAtTimeCount: aoiPointsAtTime.length,
            jobs: jobs.map((job) => {
              let minTs = Infinity;
              let maxTs = -Infinity;
              for (const p of job.points) {
                const ts = typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? (p.timestamp as number) : NaN;
                if (Number.isFinite(ts)) {
                  minTs = Math.min(minTs, ts);
                  maxTs = Math.max(maxTs, ts);
                }
              }
              return {
                recordId: job.recordId,
                count: job.points.length,
                minTs: Number.isFinite(minTs) ? Math.round(minTs) : 0,
                maxTs: Number.isFinite(maxTs) ? Math.round(maxTs) : 0,
                recordDurationMs: job.recordDurationMs,
                shapeTimeRanges: job.shapes.map((s: any) => ({
                  activationTimeMs: typeof s.activationTimeMs === 'number' ? s.activationTimeMs : null,
                  analysisTimeRanges: Array.isArray(s.analysisTimeRanges) ? s.analysisTimeRanges.map((r: any) => ({ startTimeMs: r.startTimeMs, endTimeMs: r.endTimeMs, enabled: r.enabled })) : [],
                })),
              };
            }),
          },
        });
      }
      const result = await ipcClient.computeAoiStats({ jobs });
        if (requestSeq < aoiStatsAppliedSeqRef.current) return;
        if (!result.ok) return;
        aoiStatsAppliedSeqRef.current = requestSeq;
        setAoiStatsRowsByRecordId(result.rowsByRecordId as Record<string, AoiStatsRow[]>);
    })();
  }, [
    activeNormalizedAoiShapes,
    aoiPointsAtTime,
    loadedRecordDataById,
    gridEnabled,
    mapPointsToAoiTimeline,
    recordsById,
    selectedStatsRecordIds,
    statsRecordDurationMsById,
    timelineRangeMode,
  ]);

  const aoiStatsRows = React.useMemo(() => {
    if (gridEnabled) return [];
    const rows = selectedStatsRecordIds.flatMap((recordId) => aoiStatsRowsByRecordId[recordId] || []);
    if (selectedStatsRecordIds.length <= 1) return rows;
    return aggregateAoiStatsRows(rows, activeNormalizedAoiShapes.map((shape) => shape.id));
  }, [activeNormalizedAoiShapes, aoiStatsRowsByRecordId, gridEnabled, selectedStatsRecordIds]);


  const aoiStatsRowsByRecordAndAoiId = React.useMemo(() => {
    const next: Record<string, Record<string, AoiStatsRow>> = {};
    selectedStatsRecordIds.forEach((recordId) => {
      const rows = aoiStatsRowsByRecordId[recordId] || [];
      const rowMap: Record<string, AoiStatsRow> = {};
      rows.forEach((row) => {
        rowMap[row.aoiId] = row;
      });
      next[recordId] = rowMap;
    });
    return next;
  }, [aoiStatsRowsByRecordId, selectedStatsRecordIds]);

  const selectedStatsRecordSummaries = React.useMemo(() => {
    return selectedStatsRecordIds.map((recordId) => {
      const record = recordsById.get(recordId);
      const name = record ? getDisplayRecordName(record) : recordId;
      return { id: recordId, name };
    });
  }, [recordsById, selectedStatsRecordIds]);

  const aoiStatsRowsById = React.useMemo(() => {
    const next: Record<string, AoiStatsRow> = {};
    aoiStatsRows.forEach((row) => {
      next[row.aoiId] = row;
    });
    return next;
  }, [aoiStatsRows]);

  const getAoiMetricValue = React.useCallback(
    (metric: GridMetric, row: AoiStatsRow): number | null => {
      const asMs = (ms: number | null) => (ms === null ? null : Number.isFinite(ms) ? ms : null);
      if (metric === 'fixationCount') return row.fixationCount;
      if (metric === 'firstEnterTimeS') return asMs(row.firstEnterTimeMs);
      if (metric === 'fixationCountPreEntry') return row.fixationCountPreEntry;
      if (metric === 'firstFixationDurationS') return asMs(row.firstFixationDurationMs);
      if (metric === 'totalFixationDurationS') return asMs(row.totalDurationMs);
      if (metric === 'avgFixationDurationS') return asMs(row.avgDurationMs);
      if (metric === 'visitorCount') return row.visitorCount;
      if (metric === 'maxFixationDurationS') return asMs(row.maxFixationDurationMs);
      if (metric === 'totalVisitDurationS') return asMs(row.totalVisitDurationMs);
      if (metric === 'firstVisitDurationS') return asMs(row.firstVisitDurationMs);
      if (metric === 'firstVisitFixationDurationS') return asMs(row.firstVisitFixationDurationMs);
      if (metric === 'firstVisitFixationCount') return row.firstVisitFixationCount;
      if (metric === 'avgVisitDurationS') return asMs(row.avgVisitDurationMs);
      if (metric === 'visits') return row.visits;
      if (metric === 'reVisitorCount') return row.reVisitorCount;
      if (metric === 'revisitCount') return row.revisitCount;
      if (metric === 'totalSaccadeDurationS') return asMs(row.totalSaccadeDurationMs);
      if (metric === 'saccadeCount') return row.saccadeCount;
      if (metric === 'avgSaccadeDurationS') return asMs(row.avgSaccadeDurationMs);
      if (metric === 'avgSaccadeVelocity') return row.avgSaccadeVelocity;
      if (metric === 'avgSaccadeAmplitude') return row.avgSaccadeAmplitude;
      if (metric === 'peakSaccadeVelocity') return row.peakSaccadeVelocity;
      if (metric === 'avgPupilDiameterMm') return row.avgPupilDiameter;
      if (metric === 'minFixationDuration') return asMs(row.minFixationDurationMs);
      if (metric === 'secondFixationDuration') return asMs(row.secondFixationDurationMs);
      if (metric === 'regressionDuration') return asMs(row.regressionDurationMs);
      if (metric === 'longFixationCount') return row.longFixationCount;
      return null;
    },
    [],
  );

  const formatAoiMetricValue = React.useCallback((metric: GridMetric, v: number | null) => {
    if (v === null || !Number.isFinite(v)) return '-';
    if (metric === 'fixationCount' || metric === 'fixationCountPreEntry' || metric === 'visitorCount' || metric === 'firstVisitFixationCount' || metric === 'visits' || metric === 'reVisitorCount' || metric === 'revisitCount' || metric === 'saccadeCount' || metric === 'minFixationDuration' || metric === 'secondFixationDuration' || metric === 'regressionDuration' || metric === 'longFixationCount') {
      return String(Math.round(v));
    }
    if (metric === 'avgPupilDiameterMm') return v.toFixed(2);
    return v.toFixed(3);
  }, []);

  const selectedAoiMetricIds = React.useMemo(() => {
    if (gridEnabled) return [];
    return aoiStatsSelectedMetrics === null
      ? gridMetricOptions.map((o) => o.id)
      : gridMetricOptions.filter((o) => aoiStatsSelectedMetrics.has(o.id)).map((o) => o.id);
  }, [aoiStatsSelectedMetrics, gridEnabled, gridMetricOptions]);

  const buildAoiStatsDisplayItems = React.useCallback(
    (row: AoiStatsRow | null, options?: { summary?: boolean }) => {
      if (gridEnabled || selectedAoiMetricIds.length === 0) return [];
      const items = selectedAoiMetricIds.map((metricId) => {
        const opt = gridMetricOptions.find((o) => o.id === metricId);
        const label = opt ? (options?.summary && opt.summaryLabel ? opt.summaryLabel : opt.label) : metricId;
        const v = row ? getAoiMetricValue(metricId, row) : null;
        return { l: label, v: formatAoiMetricValue(metricId, v) };
      });
      if (row?.blinkDataStatus) items.push({
        l: isEn ? 'Blink spatial assignment' : '眨眼空间归属',
        v: row.blinkDataStatus === 'unlocalized_intervals'
          ? isEn ? 'Unassigned (source intervals have no position)' : '未分配（源区间无位置）'
          : isEn ? 'No complete pairs observed' : '未观察到完整配对',
      });
      return items;
    },
    [formatAoiMetricValue, getAoiMetricValue, gridEnabled, gridMetricOptions, selectedAoiMetricIds, isEn],
  );

  const selectedAoiStatsVisible = React.useMemo(() => {
    if (!selectedAoi?.id) return false;
    const fromCanvas = canvasRenderedAoiShapes.find((shape) => shape?.id === selectedAoi.id) || null;
    if (!fromCanvas) return false;
    return Boolean(fromCanvas?.showStats && fromCanvas?.visible !== false);
  }, [canvasRenderedAoiShapes, selectedAoi]);

  const aoiStatsDisplayItems = React.useMemo(() => {
    const row = selectedAoi?.id && selectedAoiStatsVisible ? aoiStatsRowsById[selectedAoi.id] || null : null;
    return buildAoiStatsDisplayItems(row, { summary: showPerRecordStatsInSidebar });
  }, [aoiStatsRowsById, buildAoiStatsDisplayItems, selectedAoi?.id, selectedAoiStatsVisible, showPerRecordStatsInSidebar]);

  const statsPanelCards = React.useMemo(() => {
    if (gridEnabled) return [];
    return visibleCanvasRenderedAoiShapes
      .filter((shape) => shape?.showStats && shape?.visible !== false)
      .flatMap((shape) => {
        const totalItems = buildAoiStatsDisplayItems(aoiStatsRowsById[shape.id] || null, { summary: showPerRecordStatsInSidebar });
        const perRecordCards = selectedStatsRecordSummaries.map((recordSummary) => {
          const row = aoiStatsRowsByRecordAndAoiId[recordSummary.id]?.[shape.id] || null;
          return {
            key: `record::${recordSummary.id}`,
            title: `${shape.name} · ${recordSummary.name}`,
            items: buildAoiStatsDisplayItems(row, { summary: false }),
          };
        });
        const cardDefs = showPerRecordStatsInSidebar
          ? [
              ...perRecordCards,
              { key: 'summary', title: `${shape.name} · 汇总`, items: totalItems },
            ]
          : [{ key: 'summary', title: `${shape.name} 注视指标`, items: totalItems }];

        return cardDefs.map((cardDef, index) => {
          const panelId = `${shape.id}::${cardDef.key}`;
          const collapsed = collapsedStatsPanelIds.has(panelId);
          const visibleRowCount = collapsed ? Math.min(4, cardDef.items.length) : cardDef.items.length;
          const rawPanelSize = getStatsPanelSize(visibleRowCount);
          const panelSize = rawPanelSize;
          const defaultBasePos = getDefaultStatsPanelPos(shape, panelSize);
          const stackedDefaultPos = showPerRecordStatsInSidebar
            ? {
                x: defaultBasePos.x + (index % 2) * 12,
                y: defaultBasePos.y + index * (panelSize.h + 10),
              }
            : defaultBasePos;
          const storedPos = statsPanelPositions[panelId];
          const pos = storedPos
            ? clampStatsPanelPos(storedPos.x, storedPos.y, panelSize)
            : clampStatsPanelPos(stackedDefaultPos.x, stackedDefaultPos.y, panelSize);
          const box = getShapeBoundingBox(shape);
          const panelCenterX = pos.x + panelSize.w / 2;
          const targetX = box.centerX <= panelCenterX ? pos.x : pos.x + panelSize.w;
          const targetY = Math.max(pos.y + 8, Math.min(pos.y + panelSize.h - 8, box.centerY));
          return {
            panelId,
            shape,
            title: cardDef.title,
            items: cardDef.items,
            collapsed,
            canCollapse: cardDef.items.length > 4,
            pos,
            panelSize,
            line: {
              x1: box.centerX,
              y1: box.centerY,
              x2: targetX,
              y2: targetY,
            },
          };
        });
      });
  }, [
    aoiStatsRowsById,
    aoiStatsRowsByRecordAndAoiId,
    buildAoiStatsDisplayItems,
    clampStatsPanelPos,
    collapsedStatsPanelIds,
    getDefaultStatsPanelPos,
    getShapeBoundingBox,
    getStatsPanelSize,
    gridEnabled,
    selectedStatsRecordSummaries,
    showPerRecordStatsInSidebar,
    visibleCanvasRenderedAoiShapes,
    statsPanelPositions,
  ]);

  const sidebarStatsCards = React.useMemo(() => {
    if (gridEnabled) return [];
    return visibleCanvasRenderedAoiShapes
      .filter((shape) => shape?.showStats && shape?.visible !== false)
      .flatMap((shape) => {
        const totalItems = buildAoiStatsDisplayItems(aoiStatsRowsById[shape.id] || null, { summary: showPerRecordStatsInSidebar });
        if (!showPerRecordStatsInSidebar) {
          return [
            {
              cardId: `${shape.id}::summary`,
              title: `${shape.name} 注视指标`,
              items: totalItems,
            },
          ];
        }
        const perRecordCards = selectedStatsRecordSummaries.map((recordSummary) => {
          const row = aoiStatsRowsByRecordAndAoiId[recordSummary.id]?.[shape.id] || null;
          return {
            cardId: `${shape.id}::record::${recordSummary.id}`,
            title: `${shape.name} · ${recordSummary.name}`,
            items: buildAoiStatsDisplayItems(row, { summary: false }),
          };
        });
        return [
          ...perRecordCards,
          {
            cardId: `${shape.id}::summary`,
            title: `${shape.name} · 汇总`,
            items: totalItems,
          },
        ];
      });
  }, [
    aoiStatsRowsById,
    aoiStatsRowsByRecordAndAoiId,
    buildAoiStatsDisplayItems,
    gridEnabled,
    selectedStatsRecordSummaries,
    showPerRecordStatsInSidebar,
    visibleCanvasRenderedAoiShapes,
  ]);

  const seekBy = (deltaSeconds: number) => {
    const el = aoiVideoRef.current;
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
        setPlaybackSegmentId(idx >= 0 ? playbackSegments[idx].id : null);
      }
    } catch {
    }
  };

  const seekTo = (nextTime: number, force: boolean = false) => {
    const el = aoiVideoRef.current;
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
        setPlaybackSegmentId(idx >= 0 ? playbackSegments[idx].id : null);
      }
    } catch {
    }
  };

  // Monitor video playback and pause when exceeding stimulus range
  React.useEffect(() => {
    if (shouldPlayBySegments) return;
    if (!activeVideoUrl || !stimulusTimeRange || !isPlaying) return;
    
    const el = aoiVideoRef.current;
    if (!el) return;
    
    const checkTime = () => {
      const ct = el.currentTime;
      if (ct >= stimulusTimeRange.endTime) {
        try {
          el.currentTime = stimulusTimeRange.endTime;
        } catch {}
        safePause();
        setCurrentTime(el.currentTime);
        setVisualCurrentTime(el.currentTime);
        setIsPlaying(false);
      }
    };
    
    const intervalId = setInterval(checkTime, 100);
    return () => clearInterval(intervalId);
  }, [activeVideoUrl, stimulusTimeRange, isPlaying, shouldPlayBySegments]);

  React.useEffect(() => {
    if (!shouldPlayBySegments || !isPlaying || !activeVideoUrl) return;
    const el = aoiVideoRef.current;
    if (!el) return;
    if (playbackSegments.length === 0) return;

    const tick = () => {
      const ct = el.currentTime || 0;
      let idx = playbackSegmentId
        ? playbackSegments.findIndex((segment) => segment.id === playbackSegmentId)
        : -1;
      if (idx < 0) {
        idx = resolveSegmentIndexByTime(ct);
      }
      if (idx < 0) {
        setPlaybackSegmentId(null);
        return;
      }
      const segment = playbackSegments[idx];
      if (playbackSegmentId !== segment.id) {
        setPlaybackSegmentId(segment.id);
      }

      if (ct < segment.startTime) {
        try {
          el.currentTime = segment.startTime;
        } catch {
        }
        return;
      }

      if (ct >= segment.endTime) {
        const next = playbackSegments[idx + 1];
        if (next) {
          setPlaybackSegmentId(next.id);
          try {
            el.currentTime = next.startTime;
          } catch {
          }
          return;
        }
        setPlaybackSegmentId(null);
        try {
          el.currentTime = segment.endTime;
        } catch {
        }
        safePause();
        setCurrentTime(el.currentTime);
        setVisualCurrentTime(el.currentTime);
        setIsPlaying(false);
      }
    };

    const timer = window.setInterval(tick, 60);
    return () => window.clearInterval(timer);
  }, [
    isPlaying,
    activeVideoUrl,
    playbackSegments,
    playbackSegmentId,
    resolveSegmentIndexByTime,
    shouldPlayBySegments,
  ]);

  // Seek to selected stimulus start time (from record timeline) once when selection changes.
  React.useEffect(() => {
    if (isGlassesMode) {
      lastStimulusAutoSeekKeyRef.current = '';
      return;
    }
    if (!aoiSelectedStimulusId) {
      lastStimulusAutoSeekKeyRef.current = '';
      return;
    }
    if (!activeVideoUrl) return;
    if (selectedStimulusStartTime === null) return;
    const el = aoiVideoRef.current;
    if (!el) return;

    const seekKey = `${activeVideoUrl}::${aoiSelectedStimulusId}::${selectedStimulusStartTime.toFixed(3)}`;
    if (lastStimulusAutoSeekKeyRef.current === seekKey) return;
    lastStimulusAutoSeekKeyRef.current = seekKey;

    const seekToStart = () => {
      const targetTime = Math.max(0, selectedStimulusStartTime);
      try {
        el.pause();
      } catch {
      }
      try {
        el.currentTime = targetTime;
      } catch {
      }
      setCurrentTime(targetTime);
      setVisualCurrentTime(targetTime);
      setIsPlaying(false);
      if (shouldPlayBySegments) {
        const idx = resolveSegmentIndexByTime(targetTime);
        setPlaybackSegmentId(idx >= 0 ? playbackSegments[idx].id : null);
      }
    };

    if (el.readyState >= 1) {
      seekToStart();
      return;
    }
    el.addEventListener('loadedmetadata', seekToStart, { once: true });
    return () => {
      el.removeEventListener('loadedmetadata', seekToStart);
    };
  }, [
    activeVideoUrl,
    aoiSelectedStimulusId,
    aoiVideoRef,
    isGlassesMode,
    playbackSegments,
    resolveSegmentIndexByTime,
    selectedStimulusStartTime,
    shouldPlayBySegments,
  ]);

  React.useEffect(() => {
    if (!isPlaying) return;
    let rafId = 0;

    const tick = () => {
      const el = aoiVideoRef.current;
      if (!el) return;
      const nextTime = Number.isFinite(el.currentTime) ? el.currentTime : 0;
      setVisualCurrentTime((prev) => (Math.abs(prev - nextTime) < 0.001 ? prev : nextTime));
      if (!el.paused && !el.ended) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [isPlaying, aoiVideoRef]);

  const hasVideo = Boolean(activeVideoUrl);
  const contentBgClass = hasVideo || selectedStimulus ? 'bg-black' : 'bg-slate-50';
  const canAddDynamicKeyframe =
    !gridEnabled &&
    !aoiDrawing &&
    !!selectedBaseAoi &&
    dynamicAoiAllowed &&
    hasVideo &&
    playbackAoiTimeMs > KEYFRAME_EDIT_TOLERANCE_MS;

  const handleAddKeyframe = React.useCallback(() => {
    if (!selectedBaseAoi || !dynamicAoiAllowed || !hasVideo || playbackAoiTimeMs <= KEYFRAME_EDIT_TOLERANCE_MS) return;
    const nearbyKeyframeTime = findNearbyKeyframeTime(
      selectedBaseAoi,
      playbackAoiTimeMs,
      KEYFRAME_EDIT_TOLERANCE_MS,
    );
    const targetTimeMs = nearbyKeyframeTime ?? playbackAoiTimeMs;
    setAoiSelectedId(selectedBaseAoi.id);
    setAoiEditMode(true);
    setAoiShapes((prev) =>
      (prev as AoiShape[]).map((shape) =>
        shape.id === selectedBaseAoi.id ? upsertAoiKeyframe(shape, targetTimeMs) : shape,
      ),
    );
  }, [
    dynamicAoiAllowed,
    hasVideo,
    playbackAoiTimeMs,
    selectedBaseAoi,
    setAoiSelectedId,
    setAoiShapes,
  ]);

  const handleRemoveSelectedKeyframe = React.useCallback(
    (timeMs: number) => {
      if (!selectedBaseAoi) return;
      setAoiShapes((prev) =>
        (prev as AoiShape[]).map((shape) =>
          shape.id === selectedBaseAoi.id ? removeAoiKeyframe(shape, timeMs) : shape,
        ),
      );
      if (
        activeEditHandle &&
        activeEditHandle.shapeId === selectedBaseAoi.id &&
        activeEditHandle.targetTimeMs === timeMs
      ) {
        setActiveEditHandle(null);
      }
      if (
        activeShapeDrag &&
        activeShapeDrag.shapeId === selectedBaseAoi.id &&
        activeShapeDrag.targetTimeMs === timeMs
      ) {
        setActiveShapeDrag(null);
      }
    },
    [activeEditHandle, activeShapeDrag, selectedBaseAoi, setAoiShapes],
  );

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

  const visiblePlaybackRanges = React.useMemo(() => {
    const normalizeRange = (startTime: number, endTime: number, id: string) => {
      const start = Math.max(0, Math.min(duration, Math.min(startTime, endTime)));
      const end = Math.max(0, Math.min(duration, Math.max(startTime, endTime)));
      if (end <= start) return null;
      return { id, startTime: start, endTime: end };
    };

    if (duration <= 0) return [];

    if (customTimeRange) {
      const range = normalizeRange(customTimeRange.startTime, customTimeRange.endTime, 'custom-range');
      return range ? [range] : [];
    }

    if (shouldPlayBySegments && playbackSegments.length > 0) {
      return playbackSegments
        .map((segment) => normalizeRange(segment.startTime, segment.endTime, segment.id))
        .filter(Boolean) as Array<{ id: string; startTime: number; endTime: number }>;
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
  }, [customTimeRange, duration, effectiveSegment, playbackSegments, shouldPlayBySegments, stimulusTimeRange]);

  const hideOutOfRangeTimeline = isPlaying && visiblePlaybackRanges.length > 0;

  const visibleSegmentIdsForTimeline = React.useMemo(() => {
    if (!hideOutOfRangeTimeline) return null;
    if (shouldPlayBySegments) {
      return new Set(playbackSegments.map((segment) => segment.id));
    }
    if (effectiveSegment) {
      return new Set([effectiveSegment.id]);
    }
    return new Set<string>();
  }, [effectiveSegment, hideOutOfRangeTimeline, playbackSegments, shouldPlayBySegments]);

  const editHandlePoints = React.useMemo<AoiEditHandlePoint[]>(() => {
    if (gridEnabled || !aoiEditMode || !selectedBaseAoi || selectedBaseAoi.visible === false) return [];
    const selectedShape = selectedRenderedAoi;
    if (!selectedShape) return [];
    const targetTimeMs = selectedShapeEditTargetTimeForPlaybackMs;
    if (targetTimeMs === null) return [];
    const color = resolveAoiBorderColor(selectedShape.color);
    if (selectedShape.type === 'rect') {
      const left = typeof selectedShape.x === 'number' && Number.isFinite(selectedShape.x) ? selectedShape.x : 0;
      const top = typeof selectedShape.y === 'number' && Number.isFinite(selectedShape.y) ? selectedShape.y : 0;
      const width = typeof selectedShape.w === 'number' && Number.isFinite(selectedShape.w) ? selectedShape.w : 0;
      const height = typeof selectedShape.h === 'number' && Number.isFinite(selectedShape.h) ? selectedShape.h : 0;
      const right = left + width;
      const bottom = top + height;
      return [
        { key: `${selectedShape.id}:nw`, shapeId: selectedShape.id, targetTimeMs, shapeType: 'rect', rectCorner: 'nw', x: left, y: top, color },
        { key: `${selectedShape.id}:ne`, shapeId: selectedShape.id, targetTimeMs, shapeType: 'rect', rectCorner: 'ne', x: right, y: top, color },
        { key: `${selectedShape.id}:se`, shapeId: selectedShape.id, targetTimeMs, shapeType: 'rect', rectCorner: 'se', x: right, y: bottom, color },
        { key: `${selectedShape.id}:sw`, shapeId: selectedShape.id, targetTimeMs, shapeType: 'rect', rectCorner: 'sw', x: left, y: bottom, color },
      ];
    }
    if (selectedShape.type === 'ellipse') {
      const left = typeof selectedShape.x === 'number' && Number.isFinite(selectedShape.x) ? selectedShape.x : 0;
      const top = typeof selectedShape.y === 'number' && Number.isFinite(selectedShape.y) ? selectedShape.y : 0;
      const width = typeof selectedShape.w === 'number' && Number.isFinite(selectedShape.w) ? selectedShape.w : 0;
      const height = typeof selectedShape.h === 'number' && Number.isFinite(selectedShape.h) ? selectedShape.h : 0;
      const right = left + width;
      const bottom = top + height;
      const centerX = left + width / 2;
      const centerY = top + height / 2;
      return [
        { key: `${selectedShape.id}:n`, shapeId: selectedShape.id, targetTimeMs, shapeType: 'ellipse', ellipseAxis: 'n', x: centerX, y: top, color },
        { key: `${selectedShape.id}:e`, shapeId: selectedShape.id, targetTimeMs, shapeType: 'ellipse', ellipseAxis: 'e', x: right, y: centerY, color },
        { key: `${selectedShape.id}:s`, shapeId: selectedShape.id, targetTimeMs, shapeType: 'ellipse', ellipseAxis: 's', x: centerX, y: bottom, color },
        { key: `${selectedShape.id}:w`, shapeId: selectedShape.id, targetTimeMs, shapeType: 'ellipse', ellipseAxis: 'w', x: left, y: centerY, color },
      ];
    }
    if (selectedShape.type === 'polygon') {
      const pts = Array.isArray(selectedShape.points) ? selectedShape.points : [];
      return pts.map((p, index) => ({
        key: `${selectedShape.id}:p:${index}`,
        shapeId: selectedShape.id,
        targetTimeMs,
        shapeType: 'polygon',
        pointIndex: index,
        x: typeof p?.x === 'number' && Number.isFinite(p.x) ? p.x : 0,
        y: typeof p?.y === 'number' && Number.isFinite(p.y) ? p.y : 0,
        color,
      }));
    }
    return [];
  }, [
    aoiColorDefs,
    aoiEditMode,
    gridEnabled,
    selectedBaseAoi,
    selectedRenderedAoi,
    selectedShapeEditTargetTimeForPlaybackMs,
  ]);

  const handleTimelineReset = React.useCallback(() => {
    setCustomTimeRange(null);
    setAoiSelectedStimulusId(null);
    setSelectedSegmentId(null);
    setPlaybackSegmentId(null);
    setTimeout(() => {
      const el = aoiVideoRef.current;
      if (el) {
        try {
          el.currentTime = 0;
          setCurrentTime(0);
          setVisualCurrentTime(0);
        } catch {}
      }
    }, 50);
  }, [aoiVideoRef]);

  const handleTimelineRangeModeChange = React.useCallback(
    (nextMode: 'segment' | 'scoped') => {
      if (nextMode === timelineRangeMode) return;
      setTimelineRangeMode(nextMode);
      setCustomTimeRange(null);
      setSelectedSegmentId(null);
      setPlaybackSegmentId(null);

      // AOI statistics are independent from global segments.  Restarting at the
      // video beginning makes that switch explicit before playback enters the
      // merged AOI ranges.
      if (nextMode !== 'scoped') return;
      const el = aoiVideoRef.current;
      try {
        el?.pause();
      } catch {
      }
      try {
        if (el) el.currentTime = 0;
      } catch {
      }
      setIsPlaying(false);
      setCurrentTime(0);
      setVisualCurrentTime(0);
    },
    [aoiVideoRef, timelineRangeMode],
  );

  const timelineAnalysisNode = React.useMemo(() => {
    const timelineDuration = isGlassesMode ? recordingVideoStimulus?.endTime ?? 0 : duration;
    if (!(canComputeAoiStats && timelineDuration > 0)) return null;
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
        customTimeRangeKey={`${timelineRangeMode}:${timelineRangeMode === 'scoped' ? selectedBaseAoi?.id || 'none' : 'global'}`}
        customTimeRangeMode={timelineRangeMode}
        customTimeRangeTargetLabel={selectedBaseAoi?.name || null}
        scopedRangeColor={resolveAoiBorderColor(selectedBaseAoi?.color, '#0ea5e9')}
        scopedTimeRanges={selectedAoiTimelineRanges}
        onTimeRangeChange={timelineRangeMode === 'scoped' ? handleSelectedAoiTimeRangeChange : handleTimeRangeChange}
        onScopedTimeRangeRemove={handleRemoveSelectedAoiTimeRange}
        onScopedTimeRangeEnabledChange={handleSelectedAoiTimeRangeEnabledChange}
        onCustomTimeRangeModeChange={handleTimelineRangeModeChange}
        onClearTimeRange={timelineRangeMode === 'scoped' ? handleClearSelectedAoiTimeRange : handleClearGlobalTimeRange}
        onReset={handleTimelineReset}
      />
    );
  }, [
    aoiColorDefs,
    canComputeAoiStats,
    currentTime,
    customMarkers,
    duration,
    isGlassesMode,
    recordingVideoStimulus,
    handleClearGlobalTimeRange,
    handleClearSelectedAoiTimeRange,
    handleRemoveSelectedAoiTimeRange,
    handleSelectedAoiTimeRangeEnabledChange,
    handleSelectedAoiTimeRangeChange,
    handleTimelineRangeModeChange,
    handleTimeRangeChange,
    handleTimelineReset,
    handleTimelineSegmentsChange,
    seekTo,
    selectedSegmentId,
    selectedAoiTimelineRanges,
    selectedBaseAoi?.color,
    selectedBaseAoi?.id,
    selectedBaseAoi?.name,
    selectedStimulusForAnalysis?.name,
    showMarkTrack,
    showTriggerTrack,
    stimuli,
    timelineRangeMode,
    timelinePoints,
    timelineSegments,
  ]);

  const sanitizeExportName = React.useCallback((value: string): string => {
    const cleaned = String(value || '')
      .trim()
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_');
    return cleaned || 'aoi';
  }, []);

  const handleExportAoiImage = React.useCallback(async () => {
    if (isExportingImage) return;
    const target = aoiCanvasRef.current;
    if (!target) return;
    if (!ipcClient.isAvailable()) {
      window.alert('当前环境不支持导出图片');
      return;
    }
    const rect = target.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) {
      window.alert('AOI 画布尚未准备完成，请稍后重试');
      return;
    }
    const recordName = selectedRecord ? getDisplayRecordName(selectedRecord) : 'aoi';
    const stimulusName = selectedStimulus?.name || (gridEnabled ? 'grid-aoi' : 'aoi');
    const timeSuffix = `${Math.max(0, visualCurrentTime || 0).toFixed(2)}s`;
    const defaultName = `${sanitizeExportName(`export-${recordName}-${stimulusName}-${timeSuffix}-${Date.now()}`)}.png`;

    setIsExportingImage(true);
    try {
      const res = await ipcClient.exportImageFast({
        captureRect: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        },
        defaultName,
      });
      if (res.ok) {
        window.alert('导出成功');
      } else {
        const msg = 'message' in res ? res.message : undefined;
        if (!msg || !msg.includes('已取消')) {
          window.alert(msg || '导出图片失败');
        }
      }
    } catch (error) {
      console.error('[AoiExportImage] Export image failed:', error);
      window.alert('导出图片失败');
    } finally {
      setIsExportingImage(false);
    }
  }, [
    aoiCanvasRef,
    gridEnabled,
    isExportingImage,
    sanitizeExportName,
    selectedRecord,
    selectedStimulus?.name,
    visualCurrentTime,
  ]);

  const canExportAoiImage = Boolean(hasVideo || selectedStimulus || gridEnabled || visibleCanvasRenderedAoiShapes.length > 0);

  return (
    <>
      <div className="flex h-full gap-3 overflow-hidden">
      <div className="flex-1 flex flex-col bg-white rounded-2xl overflow-hidden border border-slate-200">
        <AoiCanvasToolbar
          activeTool={aoiTool}
          drawing={aoiDrawing}
          gridEnabled={gridEnabled}
          canDraw={canDrawAoi}
          hasShapes={aoiShapes.length > 0}
          editMode={aoiEditMode}
          unavailableMessage={
            isGlassesMode
              ? '眼镜式按整段视频分析；若当前不可绘制，请先检查记录视频是否可用。'
              : '请先选择刺激物后再绘制 AOI'
          }
          editHint={
            !selectedBaseAoi || (selectedBaseAoi.keyframes?.length || 0) === 0 || selectedShapeEditTargetTimeForPlaybackMs === 0
              ? '当前编辑起始位置，拖动 AOI 区域或控制点可二次编辑'
              : selectedShapeEditTargetTimeForPlaybackMs !== null
                ? `当前编辑关键帧 ${formatTime(selectedShapeEditTargetTimeForPlaybackMs / 1000)}，拖动可调整动态 AOI`
                : '当前位于关键帧之间，请先添加关键帧后再拖动 AOI'
          }
          onBeginDraw={beginAoiDraw}
          onToggleEdit={toggleAoiEditMode}
          onToggleGrid={() => setGridEnabled((value) => !value)}
        />
        <div className={`flex-1 relative ${contentBgClass} overflow-hidden`}>
          <div
            ref={aoiCanvasRef}
            onMouseDown={gridEnabled || aoiEditMode || !canDrawAoi ? undefined : aoiOnMouseDown}
            onMouseMove={gridEnabled || aoiEditMode || !canDrawAoi ? undefined : aoiOnMouseMove}
            onMouseUp={gridEnabled || aoiEditMode || !canDrawAoi ? undefined : aoiOnMouseUp}
            onContextMenu={gridEnabled || !canDrawAoi ? undefined : aoiOnContextMenu}
            className="absolute inset-0 w-full h-full"
          >
            {hasVideo && activeVideoUrl ? (
              <video
                ref={aoiVideoRef}
                src={activeVideoUrl}
                onLoadedMetadata={(e) => {
                  const el = e.currentTarget;
                  if (resolvedRecordVideoUrl && activeVideoUrl === resolvedRecordVideoUrl
                    && recordVideoOwnerRef.current?.recordKey === recordVideoKey
                    && recordVideoOwnerRef.current.url === resolvedRecordVideoUrl
                    && el.getAttribute('src') === resolvedRecordVideoUrl) {
                    setLoadedRecordVideo({ recordKey: recordVideoKey, url: resolvedRecordVideoUrl, duration: el.duration });
                  }
                  if (Number.isFinite(el.duration)) {
                    setDuration(el.duration);
                  }
                  const vw = Math.max(0, Math.round(el.videoWidth || 0));
                  const vh = Math.max(0, Math.round(el.videoHeight || 0));
                  const durationMs = Number.isFinite(el.duration) ? Math.max(0, Math.round(el.duration * 1000)) : 0;
                  setAoiVideoNaturalSize((prev) => (prev.w === vw && prev.h === vh ? prev : { w: vw, h: vh }));
                  aoiSyncVideoMeta({ w: vw, h: vh, durationMs });
                  setCurrentTime(el.currentTime || 0);
                  setVisualCurrentTime(el.currentTime || 0);
                  setIsPlaying(!el.paused && !el.ended);
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
                onPlay={(e) => {
                  setCurrentTime(e.currentTarget.currentTime || 0);
                  setVisualCurrentTime(e.currentTarget.currentTime || 0);
                  setIsPlaying(!e.currentTarget.paused && !e.currentTarget.ended);
                }}
                onPause={(e) => {
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
                  setIsPlaying(false);
                  void ipcClient.videoDebugLog({
                    event: 'aoi:playback-stopped',
                    details: {
                      reason: 'pause',
                      mediaTime,
                      elDuration: el.duration,
                      durationState: duration,
                      visualCurrentTime,
                      currentTimeMs,
                      primaryRecordDurationMs,
                      offsetMs: timeOffsetMs,
                      shouldUsePlaybackTimeForStats,
                      useStimulusRelativeAoiTimeline,
                      selectedStimulusStartTimeMs,
                      selectedStimulusSpansStartEnd: selectedStimulusSpans.map((s) => [s.startMs, s.endMs]),
                      pointsTotal: alignedGridPointsForStatsFiltered.length,
                      pointsMaxTs: alignedGridPointsForStatsFiltered.reduce((m, p) => {
                        const ts = typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? (p.timestamp as number) : 0;
                        return Math.max(m, ts);
                      }, 0),
                      mappedPointsMaxTs: alignedGridPointsForStatsFiltered.reduce((m, p) => {
                        const ts = typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? (p.timestamp as number) : 0;
                        return Math.max(m, toStimulusLocalTimeMs(ts));
                      }, 0),
                      aoiPointsAtTimeCount: aoiPointsAtTime.length,
                    },
                  });
                }}
                onEnded={(e) => {
                  const el = e.currentTarget;
                  const recentSeek = lastManualSeekRef.current;
                  if (
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
                  const endedTime = Number.isFinite(el.duration) && el.duration > 0
                    ? el.duration
                    : duration;
                  setCurrentTime(endedTime || 0);
                  setVisualCurrentTime(endedTime || 0);
                  setIsPlaying(false);
                  void ipcClient.videoDebugLog({
                    event: 'aoi:playback-stopped',
                    details: {
                      reason: 'ended',
                      mediaTime: endedTime || 0,
                      elDuration: el.duration,
                      durationState: duration,
                      visualCurrentTime,
                      currentTimeMs,
                      primaryRecordDurationMs,
                      offsetMs: timeOffsetMs,
                      shouldUsePlaybackTimeForStats,
                      useStimulusRelativeAoiTimeline,
                      selectedStimulusStartTimeMs,
                      selectedStimulusSpansStartEnd: selectedStimulusSpans.map((s) => [s.startMs, s.endMs]),
                      pointsTotal: alignedGridPointsForStatsFiltered.length,
                      pointsMaxTs: alignedGridPointsForStatsFiltered.reduce((m, p) => {
                        const ts = typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? (p.timestamp as number) : 0;
                        return Math.max(m, ts);
                      }, 0),
                      mappedPointsMaxTs: alignedGridPointsForStatsFiltered.reduce((m, p) => {
                        const ts = typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? (p.timestamp as number) : 0;
                        return Math.max(m, toStimulusLocalTimeMs(ts));
                      }, 0),
                      aoiPointsAtTimeCount: aoiPointsAtTime.length,
                    },
                  });
                }}
                className={`absolute inset-0 w-full h-full object-contain ${
                  aoiDrawing ? 'pointer-events-none' : ''
                }`}
              />
            ) : !selectedStimulus ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="flex flex-col items-center gap-2 text-slate-500">
                  <MousePointer2 size={36} className="text-slate-300" />
                  <div className="text-xs">
                    {isGlassesMode ? '未检测到记录视频，请先检查当前记录的视频文件。' : '未选择刺激物，请先在右侧选择刺激物'}
                  </div>
                </div>
              </div>
            ) : selectedStimulusKind === 'image' && String(selectedStimulus?.url || '').trim() ? (
              <img
                src={String(selectedStimulus?.url || '')}
                onLoad={(e) => {
                  const el = e.currentTarget;
                  const w = Math.max(0, Math.round(el.naturalWidth || 0));
                  const h = Math.max(0, Math.round(el.naturalHeight || 0));
                  setAoiVideoNaturalSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
                  aoiSyncVideoMeta({ w, h, durationMs: 0 });
                }}
                className={`absolute inset-0 w-full h-full object-contain ${
                  aoiDrawing ? 'pointer-events-none' : ''
                }`}
                alt="AOI Stimulus"
              />
            ) : selectedStimulusKind === 'audio' ? (
              <div className="w-full h-full flex items-center justify-center bg-slate-900 text-white text-sm">
                音频刺激物无可绘制画面
              </div>
            ) : selectedStimulusKind === 'text' ? (
              <div
                className="absolute inset-0 overflow-hidden"
              >
                <div
                  className="absolute flex items-center justify-center p-16 overflow-hidden"
                  style={{
                    ...textPreviewStageStyle,
                    backgroundColor: selectedStimulus?.bgColor || '#000000',
                  }}
                >
                  <div
                    className="max-w-[80%] text-center whitespace-pre-wrap break-words"
                    style={{
                      fontSize: selectedStimulus?.fontSize ? `${selectedStimulus.fontSize}px` : '48px',
                      fontWeight: 400,
                      color: selectedStimulus?.fontColor || '#ffffff',
                    }}
                  >
                    {String(selectedStimulus?.text || selectedStimulus?.name || '')}
                  </div>
                </div>
              </div>
            ) : selectedStimulusKind === 'web' && String(selectedStimulus?.url || '').trim() ? (
              <WebStimulusFrame
                url={selectedStimulus?.url || ''}
                title={selectedStimulus.name || 'Web stimulus'}
                containerClassName={`absolute inset-0 bg-white ${aoiDrawing ? 'pointer-events-none' : ''}`}
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="flex flex-col items-center gap-2 text-slate-500">
                  <Maximize size={36} className="text-slate-300" />
                  <div className="text-xs">该刺激物暂无可显示内容</div>
                </div>
              </div>
            )}

            {(gridEnabled || visibleCanvasRenderedAoiShapes.length > 0 || (canDrawAoi && !!aoiDraft)) && (
              <div className="absolute inset-0 pointer-events-none">
                {gridEnabled && (
                  <div className="absolute inset-0">
                    {(() => {
                      const rows = Math.max(1, Math.min(20, Math.round(gridRows)));
                      const cols = Math.max(1, Math.min(20, Math.round(gridCols)));
                      const min = gridScale?.min ?? 0;
                      const max = gridScale?.max ?? 1;
                      const alpha = Math.max(0, Math.min(1, gridOpacity));
                      const cells: React.ReactNode[] = [];
                      for (let r = 0; r < rows; r += 1) {
                        for (let c = 0; c < cols; c += 1) {
                          const id = `grid_${r}_${c}`;
                          const v = gridValuesById[id] ?? null;
                          const bg =
                            typeof v === 'number' && Number.isFinite(v) && gridScale
                              ? valueToRgba(v, min, max, alpha)
                              : 'transparent';
                          cells.push(
                            <div
                              key={id}
                              className="absolute"
                              style={{
                                left: `${(c / cols) * 100}%`,
                                top: `${(r / rows) * 100}%`,
                                width: `${(1 / cols) * 100}%`,
                                height: `${(1 / rows) * 100}%`,
                                backgroundColor: bg,
                                border: '1px solid rgba(255,255,255,0.12)',
                                boxSizing: 'border-box',
                              }}
                            >
                              {gridShowValues && (
                                <div
                                  className="w-full h-full flex items-center justify-center font-mono"
                                  style={{
                                    fontSize: `${Math.max(12, Math.min(24, Math.round(gridFontSize)))}px`,
                                    color: 'rgba(255,255,255,0.92)',
                                    textShadow: '0 1px 2px rgba(0,0,0,0.45)',
                                  }}
                                >
                                  {formatGridValue(v)}
                                </div>
                              )}
                            </div>,
                          );
                        }
                      }
                      return cells;
                    })()}
                    {gridShowScale && gridScale && (
                      <div className="absolute left-3 bottom-3 bg-black/40 rounded-lg px-3 py-2 text-[10px] text-white backdrop-blur-sm">
                        <div className="flex items-center gap-2">
                          <div className="w-24 h-2 rounded-full" style={{ background: 'linear-gradient(90deg, hsl(220, 90%, 55%), hsl(0, 90%, 55%))' }} />
                          <div className="font-mono">
                            {gridMetric === 'avgPupilDiameterMm'
                              ? `${gridScale.min.toFixed(2)} ~ ${gridScale.max.toFixed(2)}`
                              : `${gridScale.min.toFixed(3)} ~ ${gridScale.max.toFixed(3)}`}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {!gridEnabled &&
                  visibleCanvasRenderedAoiShapes.map((s) => {
                    const canEditAtCurrentTime = aoiEditTargetTimeById[s.id] !== null;
                    if (s.type === 'rect') {
                      return (
                        <div
                          key={s.id}
                          className={`absolute ${
                            aoiSelectedId === s.id ? 'shadow-[0_0_0_2px_rgba(56,189,248,0.3)]' : ''
                          }`}
                          onMouseDown={aoiEditMode ? (event) => beginShapeDrag(event, s) : undefined}
                          title={
                            aoiEditMode && !canEditAtCurrentTime
                              ? '当前位于关键帧之间，请先添加关键帧后再拖动 AOI'
                              : undefined
                          }
                          style={{
                            left: s.x || 0,
                            top: s.y || 0,
                            width: s.w || 0,
                            height: s.h || 0,
                            borderStyle: 'solid',
                            borderWidth: aoiBorderWidth,
                            borderColor: resolveAoiBorderColor(s.color),
                            backgroundColor: resolveAoiFillColor(s.color, aoiOpacity),
                            pointerEvents: aoiEditMode ? 'auto' : 'none',
                            cursor: aoiEditMode ? (canEditAtCurrentTime ? 'move' : 'not-allowed') : 'default',
                          }}
                        >
                          {aoiShowName && (
                            <div
                              data-i18n-skip="true"
                              className="absolute -top-6 left-0 bg-white text-slate-700 px-2 py-1 rounded border border-slate-200 backdrop-blur-sm pointer-events-none"
                              style={{ backgroundColor: 'color-mix(in srgb, var(--app-surface) 88%, transparent)', fontSize: aoiFontSize }}
                            >
                              {s.name}
                            </div>
                          )}
                        </div>
                      );
                    }
                    if (s.type === 'ellipse') {
                      return (
                        <div
                          key={s.id}
                          className={`absolute ${
                            aoiSelectedId === s.id ? 'shadow-[0_0_0_2px_rgba(16,185,129,0.3)]' : ''
                          }`}
                          onMouseDown={aoiEditMode ? (event) => beginShapeDrag(event, s) : undefined}
                          title={
                            aoiEditMode && !canEditAtCurrentTime
                              ? '当前位于关键帧之间，请先添加关键帧后再拖动 AOI'
                              : undefined
                          }
                          style={{
                            left: s.x || 0,
                            top: s.y || 0,
                            width: s.w || 0,
                            height: s.h || 0,
                            borderRadius: '50%',
                            borderStyle: 'solid',
                            borderWidth: aoiBorderWidth,
                            borderColor: resolveAoiBorderColor(s.color, '#34d399'),
                            backgroundColor: resolveAoiFillColor(s.color, aoiOpacity, '#34d399'),
                            pointerEvents: aoiEditMode ? 'auto' : 'none',
                            cursor: aoiEditMode ? (canEditAtCurrentTime ? 'move' : 'not-allowed') : 'default',
                          }}
                        >
                          {aoiShowName && (
                            <div
                              data-i18n-skip="true"
                              className="absolute -top-6 left-0 bg-white text-slate-700 px-2 py-1 rounded border border-slate-200 backdrop-blur-sm pointer-events-none"
                              style={{ backgroundColor: 'color-mix(in srgb, var(--app-surface) 88%, transparent)', fontSize: aoiFontSize }}
                            >
                              {s.name}
                            </div>
                          )}
                        </div>
                      );
                    }
                    return (
                      <svg
                        key={s.id}
                        className="absolute inset-0 w-full h-full"
                        preserveAspectRatio="none"
                        style={{ pointerEvents: 'none' }}
                      >
                        <polygon
                          points={(s.points || []).map((point) => `${point.x},${point.y}`).join(' ')}
                          fill={resolveAoiFillColor(s.color, aoiOpacity, '#f59e0b')}
                          stroke={resolveAoiBorderColor(s.color, '#f59e0b')}
                          strokeWidth={aoiBorderWidth}
                          onMouseDown={aoiEditMode ? (event) => beginShapeDrag(event, s) : undefined}
                          style={{
                            cursor: aoiEditMode ? (canEditAtCurrentTime ? 'move' : 'not-allowed') : 'default',
                            pointerEvents: aoiEditMode ? 'auto' : 'none',
                          }}
                        />
                        {aoiShowName && s.points && s.points[0] && (
                          <text
                            data-i18n-skip="true"
                            x={(s.points || []).reduce((accumulator, point) => accumulator + point.x, 0) / (s.points?.length || 1)}
                            y={Math.max(
                              0,
                              (s.points || []).reduce((accumulator, point) => accumulator + point.y, 0) / (s.points?.length || 1) - 8,
                            )}
                            fontSize={aoiFontSize}
                            fill="var(--app-text)"
                            dominantBaseline="ideographic"
                            style={{ pointerEvents: 'none' }}
                          >
                            {s.name}
                          </text>
                        )}
                      </svg>
                    );
                  })}

                {!gridEnabled && aoiDraft && aoiTool !== 'polygon' && (
                  <div
                    className="absolute"
                    style={{
                      left: Math.min(aoiDraft.x || 0, (aoiDraft.x || 0) + (aoiDraft.w || 0)),
                      top: Math.min(aoiDraft.y || 0, (aoiDraft.y || 0) + (aoiDraft.h || 0)),
                      width: Math.abs(aoiDraft.w || 0),
                      height: Math.abs(aoiDraft.h || 0),
                      borderRadius: aoiTool === 'rect' ? undefined : '50%',
                      borderStyle: 'solid',
                      borderWidth: aoiBorderWidth,
                      borderColor: aoiTool === 'rect' ? aoiColorDefs.sky.border : aoiColorDefs.emerald.border,
                      backgroundColor:
                        aoiTool === 'rect' ? aoiColorDefs.sky.fill(aoiOpacity) : aoiColorDefs.emerald.fill(aoiOpacity),
                    }}
                  />
                )}
                {!gridEnabled && aoiDraft && aoiTool === 'polygon' && (
                  <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
                    <polyline
                      points={[...(aoiDraft.points || []), ...(aoiCursor ? [aoiCursor] : [])]
                        .map((point) => `${point.x},${point.y}`)
                        .join(' ')}
                      fill="none"
                      stroke={aoiColorDefs.amber.border}
                      strokeWidth={aoiBorderWidth}
                    />
                  </svg>
                )}
              </div>
            )}

            {canDrawAoi && !gridEnabled && aoiEditMode && editHandlePoints.length > 0 && (
              <div className="absolute inset-0 pointer-events-none">
                {editHandlePoints.map((handle) => (
                  <button
                    key={handle.key}
                    type="button"
                    data-visual-control="aoi-handle"
                    onMouseDown={(event) => beginHandleDrag(event, handle)}
                    className="absolute w-3 h-3 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(15,23,42,0.25)] pointer-events-auto -translate-x-1/2 -translate-y-1/2"
                    style={{ left: handle.x, top: handle.y, backgroundColor: handle.color }}
                    title="拖动编辑控制点"
                  />
                ))}
              </div>
            )}

            {!gridEnabled &&
              statsPanelCards.map((panel) => (
                <React.Fragment key={`stats-panel-${panel.panelId}`}>
                  <svg className="absolute inset-0 w-full h-full pointer-events-none">
                    <line
                      x1={panel.line.x1}
                      y1={panel.line.y1}
                      x2={panel.line.x2}
                      y2={panel.line.y2}
                      stroke={resolveAoiBorderColor(panel.shape.color, '#cbd5e1')}
                      strokeWidth={2}
                      strokeDasharray="6 4"
                    />
                    <circle
                      cx={panel.line.x2}
                      cy={panel.line.y2}
                      r={3}
                      fill={resolveAoiBorderColor(panel.shape.color, '#cbd5e1')}
                    />
                  </svg>
                  <div
                    className="absolute overflow-hidden bg-white border border-slate-200 rounded-xl shadow-lg backdrop-blur-sm text-slate-700 pointer-events-auto z-20"
                    onMouseDown={(event) => event.stopPropagation()}
                    style={{
                      left: panel.pos.x,
                      top: panel.pos.y,
                      width: panel.panelSize.w,
                      height: panel.panelSize.h,
                      backgroundColor: 'color-mix(in srgb, var(--app-surface) 88%, transparent)',
                    }}
                  >
                    <div
                      className="flex items-center justify-between px-4 py-3 border-b border-slate-200 cursor-move select-none"
                      onMouseDown={(event) => startStatsPanelDrag(event, panel.panelId, panel.pos, panel.panelSize)}
                      title="拖动移动指标面板"
                    >
                      <div className="text-[11px] font-semibold text-sky-600">{panel.title}</div>
                      {panel.canCollapse && (
                        <button
                          type="button"
                          className="-mr-1 flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-sky-600"
                          onMouseDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            setCollapsedStatsPanelIds((previous) => {
                              const next = new Set(previous);
                              if (next.has(panel.panelId)) next.delete(panel.panelId);
                              else next.add(panel.panelId);
                              return next;
                            });
                          }}
                          aria-label={panel.collapsed ? '展开全部注视指标' : '收起注视指标'}
                          title={panel.collapsed ? '展开全部指标' : '收起为4行滚动视图'}
                        >
                          <ChevronDown
                            size={14}
                            className={`transition-transform duration-200 ${panel.collapsed ? '-rotate-90' : 'rotate-0'}`}
                          />
                        </button>
                      )}
                    </div>
                    <div className="h-[calc(100%_-_43px)] overflow-y-auto px-4 py-2.5 space-y-1.5 text-[11px]">
                      {panel.items.length > 0 ? (
                        panel.items.map((item) => (
                          <div key={`${panel.panelId}-${item.l}`} className="flex items-center justify-between gap-3">
                            <span className="text-slate-500">{item.l}</span>
                            <span className="font-mono text-slate-700">{item.v}</span>
                          </div>
                        ))
                      ) : (
                        <div className="flex items-center justify-between">
                          <span className="text-slate-500">未选择指标</span>
                          <span className="font-mono text-slate-700">-</span>
                        </div>
                      )}
                    </div>
                  </div>
                </React.Fragment>
              ))}
          </div>
        </div>

        <div className="border-t border-slate-200 bg-white px-4 py-3 text-[10px] text-slate-500">
          {duration > 0 && hasVideo && (
            <div
              className="relative h-4 w-full cursor-pointer group flex items-center mb-3"
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
                {timelineRangeMode === 'segment' && orderedSegments.map((segment) => {
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
            <div className="flex-1 flex items-center justify-start">
              <button
                type="button"
                onClick={handleExportAoiImage}
                disabled={!canExportAoiImage || isExportingImage}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[10px] font-medium transition-colors ${
                  canExportAoiImage && !isExportingImage
                    ? 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-sky-600'
                    : 'bg-slate-50 border-slate-100 text-slate-300 cursor-not-allowed'
                }`}
              >
                <Download size={12} />
                <span>{isExportingImage ? '导出中...' : '导出图片'}</span>
              </button>
            </div>
            <div className="flex items-center justify-center gap-3">
              <button
                disabled={!hasVideo}
                onClick={() => seekTo(stimulusTimeRange ? snapTimelineDisplaySecond(stimulusTimeRange.startTime) : 0)}
                className={`w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center shadow-sm ${
                  hasVideo ? 'text-slate-600 hover:bg-slate-50' : 'text-slate-300'
                }`}
                title={stimulusTimeRange ? '跳到刺激物开始' : '跳到开始'}
              >
                <SkipBack size={14} />
              </button>
              <button
                disabled={!hasVideo}
                onClick={() => seekBy(-frameStep)}
                className={`w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center shadow-sm ${
                  hasVideo ? 'text-slate-600 hover:bg-slate-50' : 'text-slate-300'
                }`}
              >
                <Rewind size={14} />
              </button>
              <button
                disabled={!hasVideo}
                onClick={togglePlay}
                className={`w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center shadow-sm ${
                  hasVideo ? 'text-slate-700 hover:bg-slate-50' : 'text-slate-300'
                }`}
              >
                {isPlaying ? <Pause size={14} /> : <Play size={14} />}
              </button>
              <button
                disabled={!hasVideo}
                onClick={() => seekBy(frameStep)}
                className={`w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center shadow-sm ${
                  hasVideo ? 'text-slate-600 hover:bg-slate-50' : 'text-slate-300'
                }`}
              >
                <FastForward size={14} />
              </button>
              <button
                disabled={!hasVideo}
                onClick={() => seekTo(snapTimelineDisplaySecond(stimulusTimeRange ? stimulusTimeRange.endTime : (duration || 0)))}
                className={`w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center shadow-sm ${
                  hasVideo ? 'text-slate-600 hover:bg-slate-50' : 'text-slate-300'
                }`}
                title={stimulusTimeRange ? '跳到刺激物结束' : '跳到结束'}
              >
                <SkipForward size={14} />
              </button>
            </div>
            <div className="flex-1 flex items-center justify-end gap-4 text-slate-500">
              <span className="font-mono">
                {formatTime(visualCurrentTime)} / {formatTime(duration)}
              </span>
            </div>
          </div>
        </div>
        
        {/* Timeline Analysis - Always show when there's a selected record */}
        {timelineAnalysisNode}
      </div>

      <div className="w-[300px] bg-white border border-slate-200 rounded-2xl flex flex-col overflow-hidden text-slate-600">
        <div className="p-3 border-b border-slate-200">
          <div className="flex w-full gap-2">
            <button
              type="button"
              aria-pressed={aoiSettingsTab === 'basic'}
              onClick={() => setAoiSettingsTab('basic')}
              className={`mrt-button-tab flex-1 border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
                aoiSettingsTab === 'basic'
                  ? 'border-sky-500 text-sky-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              基础设置
            </button>
            <button
              type="button"
              aria-pressed={aoiSettingsTab === 'aoi'}
              onClick={() => setAoiSettingsTab('aoi')}
              className={`mrt-button-tab flex-1 border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
                aoiSettingsTab === 'aoi'
                  ? 'border-sky-500 text-sky-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              AOI设置
            </button>
          </div>
        </div>
        {aoiSettingsTab === 'basic' ? (
        <div className="flex-1 overflow-y-auto p-3">
          <AoiBasicSettingsPanel
            stimuli={stimuli}
            selectedStimulusId={aoiSelectedStimulusId}
            isGlassesMode={isGlassesMode}
            recordingVideoName={recordingVideoStimulus?.name || selectedRecord?.name}
            isEn={isEn}
            showMarkTrack={showMarkTrack}
            showTriggerTrack={showTriggerTrack}
            aoiFontSize={aoiFontSize}
            gridFontSize={gridFontSize}
            gridEnabled={gridEnabled}
            gridLoading={gridLoading}
            gridError={gridError}
            gridMetric={gridMetric}
            gridMetricOptions={gridMetricOptions}
            gridShowValues={gridShowValues}
            gridShowScale={gridShowScale}
            gridRows={gridRows}
            gridCols={gridCols}
            gridOpacity={gridOpacity}
            aoiShowName={aoiShowName}
            aoiOpacity={aoiOpacity}
            aoiBorderWidth={aoiBorderWidth}
            onSelectedStimulusIdChange={setAoiSelectedStimulusId}
            onShowMarkTrackChange={setShowMarkTrack}
            onShowTriggerTrackChange={setShowTriggerTrack}
            onAoiFontSizeChange={setAoiFontSize}
            onGridFontSizeChange={setGridFontSize}
            onGridEnabledChange={setGridEnabled}
            onGridMetricChange={setGridMetric}
            onGridShowValuesChange={setGridShowValues}
            onGridShowScaleChange={setGridShowScale}
            onGridRowsChange={setGridRows}
            onGridColsChange={setGridCols}
            onGridOpacityChange={setGridOpacity}
            onAoiShowNameChange={setAoiShowName}
            onAoiOpacityChange={setAoiOpacity}
            onAoiBorderWidthChange={setAoiBorderWidth}
          />
          <div className="mt-3 border-t border-slate-200 pt-3">
            <div className="mb-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xs font-semibold text-slate-700 flex items-center gap-1">
                  <Monitor size={14} /> 记录列表
                </h3>
                <div className="flex items-center gap-2 text-[11px] text-slate-600">
                  <span>开启多选</span>
                  <Switch
                    checked={aoiStatsMultiSelectEnabled}
                    aria-label={isEn ? 'Enable multi-select' : '开启多选'}
                    disabled={!canEnableMultiRecordStats}
                    onClick={() => setAoiStatsMultiSelectEnabled((prev) => !prev)}
                    title={isEn ? 'Enable multi-select' : '开启多选'}
                  />
                </div>
              </div>
              <div className="text-[11px] leading-relaxed text-slate-500">
                {isGlassesMode
                  ? !aoiSelectedRecordId
                    ? '请先在下方选择主记录。主记录用于视频播放与时间轴基准。'
                    : aoiStatsMultiSelectEnabled
                      ? `当前参与统计 ${selectedStatsRecordIds.length} 条记录；主记录不可取消。`
                      : '关闭多选时仅统计主记录。'
                  : !aoiSelectedStimulusId
                  ? '请先选择刺激物材料，再开启多选并勾选参与统计的记录。'
                  : !aoiSelectedRecordId
                    ? '请先在下方选择主记录。主记录用于视频播放与时间轴基准。'
                    : aoiStatsMultiSelectEnabled
                      ? `当前参与统计 ${selectedStatsRecordIds.length} 条记录；主记录不可取消。`
                      : '关闭多选时仅统计主记录。'}
              </div>
            </div>
            {records.length === 0 ? (
              <div className="text-[11px] text-slate-400">暂无记录，请先在录制模块生成数据</div>
            ) : (
              <div
                className="max-h-64 overflow-y-auto overscroll-contain pr-1"
                onWheel={(event) => event.stopPropagation()}
              >
                <div className="space-y-1">
                  {records.map((record) => {
                    const isPrimary = record.id === aoiSelectedRecordId;
                    const checked = isPrimary || (aoiStatsMultiSelectEnabled && aoiStatsSelectedRecordIds.has(record.id));
                    const canToggle = aoiStatsMultiSelectEnabled && canEnableMultiRecordStats && !isPrimary;
                    return (
                      <div
                        key={record.id}
                        style={{ contentVisibility: 'auto', containIntrinsicSize: '52px' }}
                        className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-all border ${
                          isPrimary
                            ? 'bg-sky-50 border-sky-200'
                            : 'hover:bg-slate-50 border-transparent hover:border-slate-200'
                        }`}
                        onClick={() => setAoiSelectedRecordId(record.id)}
                      >
                        <div
                          className={`w-2.5 h-2.5 shrink-0 rounded bg-emerald-500 ${checked ? 'opacity-100' : 'opacity-30'} transition-opacity`}
                        />
                        <div className="min-w-0 flex-1 overflow-hidden">
                          <div className="text-xs font-medium truncate text-slate-700" title={getDisplayRecordName(record)}>{getDisplayRecordName(record)}</div>
                          <div className="text-[11px] tabular-nums text-slate-500">{record.duration}</div>
                        </div>
                        <input
                          type="checkbox"
                          className={`accent-sky-500 rounded w-4 h-4 ${
                            canToggle ? 'cursor-pointer' : 'cursor-not-allowed'
                          }`}
                          checked={checked}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => {
                            event.stopPropagation();
                            if (!canToggle) return;
                            const nextChecked = event.target.checked;
                            setAoiStatsSelectedRecordIds((prev) => {
                              const next = new Set(prev);
                              if (nextChecked) next.add(record.id);
                              else next.delete(record.id);
                              if (aoiSelectedRecordId) next.add(aoiSelectedRecordId);
                              return next;
                            });
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
        <div className="flex-1 overflow-y-auto p-3">
          {!gridEnabled && (
            <div className="mb-6">
              <div className="mb-3 flex w-full gap-2">
                <button
                  type="button"
                  aria-pressed={aoiSidebarTab === 'aois'}
                  onClick={() => setAoiSidebarTab('aois')}
                  className={`mrt-button-tab flex-1 border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
                    aoiSidebarTab === 'aois'
                      ? 'border-sky-500 text-sky-700'
                      : 'border-transparent text-slate-500 hover:text-slate-700'
                  }`}
                >
                  AOIs
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!dynamicAoiAllowed) return;
                    setAoiSidebarTab('dynamic');
                  }}
                  aria-pressed={aoiSidebarTab === 'dynamic'}
                  disabled={!dynamicAoiAllowed}
                  className={`mrt-button-tab flex-1 border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
                    aoiSidebarTab === 'dynamic'
                      ? 'border-sky-500 text-sky-700'
                      : dynamicAoiAllowed
                        ? 'border-transparent text-slate-500 hover:text-slate-700'
                        : 'border-transparent text-slate-300 cursor-not-allowed'
                  }`}
                >
                  {isEn ? 'Dynamic AOI' : '动态AOI'}
                </button>
              </div>

              {aoiSidebarTab === 'aois' ? (
                <AoiShapeListPanel
                  isEnglish={isEn}
                  shapes={aoiShapes}
                  selectedId={aoiSelectedId}
                  drawing={aoiDrawing}
                  colorDefinitions={aoiColorDefs}
                  expandedRangeIds={expandedAoiRangeIds}
                  formatTime={formatTime}
                  onSelect={setAoiSelectedId}
                  onRename={aoiRename}
                  onShapesChange={setAoiShapes}
                  onExpandedRangeIdsChange={setExpandedAoiRangeIds}
                  onRangeEnabledChange={handleAoiTimeRangeEnabledChange}
                  onRemoveRange={handleRemoveAoiTimeRange}
                />
              ) : (
                <AoiKeyframePanel
                  isEnglish={isEn}
                  playbackTimeMs={playbackAoiTimeMs}
                  selectedAoi={selectedBaseAoi}
                  keyframes={selectedAoiKeyframes}
                  currentKeyframeTimeMs={selectedCurrentKeyframeTimeForPlayback}
                  editTargetTimeMs={selectedShapeEditTargetTimeForPlaybackMs}
                  dynamicAoiAllowed={dynamicAoiAllowed}
                  hasVideo={hasVideo}
                  canAddKeyframe={canAddDynamicKeyframe}
                  formatTime={formatTime}
                  onAddKeyframe={handleAddKeyframe}
                  onSeekLocalTime={(timeMs) => seekTo(toPlaybackGlobalSecondsFromAoiLocal(timeMs), true)}
                  onRemoveKeyframe={handleRemoveSelectedKeyframe}
                />
              )}
            </div>
          )}

          {!gridEnabled && (
            <AoiStatisticsPanel
              isEnglish={isEn}
              cards={sidebarStatsCards}
              onOpenMetricPicker={() => setIsAoiStatsPickerOpen(true)}
            />
          )}
        </div>
        </>
      )}
      </div>
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
    <AoiStatisticsMetricPicker
      isOpen={isAoiStatsPickerOpen}
      options={gridMetricOptions}
      selectedMetrics={aoiStatsSelectedMetrics}
      onSelectedMetricsChange={setAoiStatsSelectedMetrics}
      onClose={() => setIsAoiStatsPickerOpen(false)}
    />
    </>
  );
};

export default AoiPage;
