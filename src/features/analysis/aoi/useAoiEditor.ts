import React, { useMemo, useRef, useState } from 'react';
import type { RecordingRecord } from '@shared/contracts/domain/models';
import type { AoiAnalysisTimeRange, AoiKeyframe, AoiShape } from '@shared/domain/aoi/aoiTypes';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import type { ExtendedStimulus, HeatmapPoint } from '@/shared/types/mrt';
import { getRecordingFrameSizeOptions } from '@/features/records/domain/recordFrameSize';
import { useTimeOffsetMs } from '@/features/analysis/time-offset/useTimeOffset';
import { isStimulusVideoUrl } from '@/features/stimuli/domain/mediaTypes';
import { parseAoiStore } from '@/features/analysis/aoi/aoiPersistence';

type NormalizedAoiShape = {
  id: string;
  name: string;
  type: 'ellipse' | 'rect' | 'polygon';
  visible: boolean;
  showStats: boolean;
  color: string;
  metric: number;
  activationTimeMs?: number;
  analysisTimeRanges?: AoiAnalysisTimeRange[];
  analysisTimeRange?: AoiAnalysisTimeRange;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  points?: { x: number; y: number }[];
  keyframes?: AoiKeyframe[];
};

type AoiContainLayout = {
  drawLeft: number;
  drawTop: number;
  drawW: number;
  drawH: number;
  containerW: number;
  containerH: number;
};

const normalizeAoiAnalysisTimeRanges = (
  value: unknown,
  legacyValue?: unknown,
): AoiAnalysisTimeRange[] | undefined => {
  const candidates = [
    ...(Array.isArray(value) ? value : []),
    ...(legacyValue && typeof legacyValue === 'object' ? [legacyValue] : []),
  ];
  const normalized = candidates
    .map<AoiAnalysisTimeRange | null>((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const start = Number((item as AoiAnalysisTimeRange).startTimeMs);
      const end = Number((item as AoiAnalysisTimeRange).endTimeMs);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      const startTimeMs = Math.max(0, Math.round(start));
      const endTimeMs = Math.max(0, Math.round(end));
      if (endTimeMs <= startTimeMs) return null;
      const rawId = String((item as AoiAnalysisTimeRange).id || '').trim();
      return {
        id: rawId || `aoi_range_${startTimeMs}_${endTimeMs}_${index}`,
        startTimeMs,
        endTimeMs,
        enabled: (item as AoiAnalysisTimeRange).enabled !== false,
      } satisfies AoiAnalysisTimeRange;
    })
    .filter((item): item is AoiAnalysisTimeRange => item !== null)
    .sort((left, right) => left.startTimeMs - right.startTimeMs || left.endTimeMs - right.endTimeMs);
  const nonOverlapping: AoiAnalysisTimeRange[] = [];
  normalized.forEach((range) => {
    const previous = nonOverlapping[nonOverlapping.length - 1];
    if (!previous || range.startTimeMs >= previous.endTimeMs) nonOverlapping.push(range);
  });
  return nonOverlapping.length > 0 ? nonOverlapping : undefined;
};

export function useAoiEditor(params: {
  stimuli: ExtendedStimulus[];
  records: RecordingRecord[];
  projectDir: string | null;
  isActive?: boolean;
}) {
  const { stimuli, records, projectDir, isActive = true } = params;

  const { timeOffsetMs } = useTimeOffsetMs();
  const [aoiShapes, setAoiShapes] = useState<AoiShape[]>([]);
  const aoiShapesRef = useRef<AoiShape[]>([]);
  const [aoiTool, setAoiTool] = useState<'ellipse' | 'rect' | 'polygon' | null>(null);
  const [aoiDrawing, setAoiDrawing] = useState<boolean>(false);
  const [aoiSelectedId, setAoiSelectedId] = useState<string | null>(null);
  const [aoiDraft, setAoiDraft] = useState<AoiShape | null>(null);
  const aoiCanvasRef = useRef<HTMLDivElement | null>(null);
  const aoiVideoRef = useRef<HTMLVideoElement | null>(null);
  const [aoiSelectedStimulusId, setAoiSelectedStimulusId] = useState<string | null>(null);
  const [aoiSelectedRecordId, setAoiSelectedRecordId] = useState<string | null>(null);
  const [aoiVideoUrl, setAoiVideoUrl] = useState<string | null>(null);
  const [aoiVideoTimeMs, setAoiVideoTimeMs] = useState<number>(0);
  const [aoiVideoIsPlaying, setAoiVideoIsPlaying] = useState<boolean>(false);
  const [aoiVideoSize, setAoiVideoSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [aoiVideoDurationMs, setAoiVideoDurationMs] = useState<number>(0);
  const [aoiPointsByRecord, setAoiPointsByRecord] = useState<Record<string, HeatmapPoint[]>>({});
  const [aoiPointsLoading, setAoiPointsLoading] = useState<boolean>(false);
  const [aoiPointsError, setAoiPointsError] = useState<string | null>(null);
  const [aoiOpacity, setAoiOpacity] = useState<number>(0.06);
  const [aoiBorderWidth, setAoiBorderWidth] = useState<number>(2);
  const [aoiFontSize, setAoiFontSize] = useState<number>(12);
  const [aoiShowName, setAoiShowName] = useState<boolean>(true);
  const [aoiCursor, setAoiCursor] = useState<{ x: number; y: number } | null>(null);
  const [aoiCanvasSize, setAoiCanvasSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const observedCanvasElRef = useRef<HTMLDivElement | null>(null);
  const canvasResizeObserverRef = useRef<ResizeObserver | null>(null);
  const loadedAoiKeyRef = useRef<string | null>(null);
  const prevContainLayoutRef = useRef<AoiContainLayout | null>(null);
  const latestContainLayoutRef = useRef<AoiContainLayout>({
    drawLeft: 0,
    drawTop: 0,
    drawW: 0,
    drawH: 0,
    containerW: 0,
    containerH: 0,
  });
  const saveDebounceRef = useRef<number | null>(null);
  const layoutSettleTimerRef = useRef<number | null>(null);
  const [isContainLayoutSettled, setIsContainLayoutSettled] = useState<boolean>(false);
  const aoiLoadedReadyKeyRef = useRef<string | null>(null);

  const aoiColorDefs: Record<string, { border: string; fill: (alpha: number) => string; dot: string }> = {
    sky: { border: '#38bdf8', fill: (alpha: number) => `rgba(56,189,248,${alpha})`, dot: 'bg-sky-500' },
    emerald: { border: '#34d399', fill: (alpha: number) => `rgba(52,211,153,${alpha})`, dot: 'bg-emerald-400' },
    amber: { border: '#f59e0b', fill: (alpha: number) => `rgba(245,158,11,${alpha})`, dot: 'bg-amber-400' },
    violet: { border: '#a78bfa', fill: (alpha: number) => `rgba(167,139,250,${alpha})`, dot: 'bg-violet-400' },
  };

  const aoiSyncVideoMeta = React.useCallback(
    (meta: { w: number; h: number; durationMs?: number | null }) => {
      const w = Math.max(0, Math.round(Number(meta?.w) || 0));
      const h = Math.max(0, Math.round(Number(meta?.h) || 0));
      setAoiVideoSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
      if (meta && Object.prototype.hasOwnProperty.call(meta, 'durationMs')) {
        const d = Math.max(0, Math.round(Number(meta.durationMs) || 0));
        setAoiVideoDurationMs((prev) => (prev === d ? prev : d));
      }
    },
    [],
  );

  const aoiClearVideoMeta = React.useCallback(() => {
    setAoiVideoSize({ w: 0, h: 0 });
    setAoiVideoDurationMs(0);
  }, []);

  const aoiStartDraw = (type: 'ellipse' | 'rect' | 'polygon') => {
    setAoiTool(type);
    setAoiDrawing(true);
    setAoiSelectedId(null);
    setAoiCursor(null);
    if (type === 'polygon') {
      const id = `aoi_${Date.now()}`;
      setAoiDraft({ id, name: 'Polygon', type: 'polygon', visible: true, showStats: false, color: 'amber', metric: 0, points: [] });
    } else {
      setAoiDraft(null);
    }
  };

  const aoiOnCanvasClick = (e: React.MouseEvent) => {
    if (!aoiDrawing || aoiTool !== 'polygon') return;
    const rect = aoiCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const draft: AoiShape =
      aoiDraft ||
      ({ id: `aoi_${Date.now()}`, name: 'Polygon', type: 'polygon', visible: true, showStats: false, color: 'amber', metric: 0, points: [] } as AoiShape);
    setAoiCursor({ x, y });
    const pts = [...(draft.points || []), { x, y }];
    if (pts.length >= 3) {
      const first = pts[0];
      const dx = x - first.x;
      const dy = y - first.y;
      if (Math.hypot(dx, dy) < 12) {
        const closedPts = pts.slice(0, -1);
        let area = 0;
        for (let i = 0; i < closedPts.length; i += 1) {
          const j = (i + 1) % closedPts.length;
          area += closedPts[i].x * closedPts[j].y - closedPts[j].x * closedPts[i].y;
        }
        area = Math.abs(area / 2);
        const finalShape: AoiShape = { ...draft, points: closedPts, metric: Math.round(area) };
        setAoiShapes((s) => [...s, finalShape]);
        setAoiDraft(null);
        setAoiDrawing(false);
        setAoiCursor(null);
        setAoiSelectedId(finalShape.id);
        return;
      }
    }
    setAoiDraft({ ...draft, points: pts });
  };

  const aoiOnMouseDown = (e: React.MouseEvent) => {
    if (!aoiDrawing || !aoiTool) return;
    if (aoiTool === 'polygon') {
      aoiOnCanvasClick(e);
      return;
    }
    const rect = aoiCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const id = `aoi_${Date.now()}`;
    const base: AoiShape = {
      id,
      name: aoiTool === 'rect' ? 'Rect' : 'Ellipse',
      type: aoiTool,
      visible: true,
      showStats: false,
      color: aoiTool === 'rect' ? 'sky' : 'emerald',
      metric: 0,
      x,
      y,
      w: 0,
      h: 0,
    };
    setAoiDraft(base);
  };

  const aoiOnMouseMove = (e: React.MouseEvent) => {
    if (!aoiDrawing) return;
    const rect = aoiCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (aoiTool === 'polygon') {
      if (aoiDraft) {
        setAoiCursor({ x, y });
      }
      return;
    }
    if (!aoiDraft) return;
    const w = x - (aoiDraft.x || 0);
    const h = y - (aoiDraft.y || 0);
    setAoiDraft({ ...aoiDraft, w, h });
  };

  const aoiOnMouseUp = () => {
    if (!aoiDrawing || !aoiTool || aoiTool === 'polygon') return;
    if (!aoiDraft) {
      setAoiDrawing(false);
      return;
    }
    const nx = Math.min(aoiDraft.x || 0, (aoiDraft.x || 0) + (aoiDraft.w || 0));
    const ny = Math.min(aoiDraft.y || 0, (aoiDraft.y || 0) + (aoiDraft.h || 0));
    const nw = Math.abs(aoiDraft.w || 0);
    const nh = Math.abs(aoiDraft.h || 0);
    let metric = 0;
    if (aoiTool === 'rect') metric = Math.round(nw * nh);
    if (aoiTool === 'ellipse') metric = Math.round(Math.PI * (nw / 2) * (nh / 2));
    const finalShape: AoiShape = { ...aoiDraft, x: nx, y: ny, w: nw, h: nh, metric };
    setAoiShapes((s) => [...s, finalShape]);
    setAoiDraft(null);
    setAoiDrawing(false);
    setAoiSelectedId(finalShape.id);
  };

  const aoiRename = (id: string, name: string) => {
    setAoiShapes((s) => s.map((it) => (it.id === id ? { ...it, name } : it)));
  };

  const computeContainLayout = (params: {
    containerW: number;
    containerH: number;
    videoW: number;
    videoH: number;
  }): { drawLeft: number; drawTop: number; drawW: number; drawH: number; containerW: number; containerH: number } => {
    const cw = Math.max(1, Math.round(params.containerW));
    const ch = Math.max(1, Math.round(params.containerH));
    const vw = Math.max(1, Math.round(params.videoW));
    const vh = Math.max(1, Math.round(params.videoH));
    const scale = Math.min(cw / vw, ch / vh);
    const drawW = vw * scale;
    const drawH = vh * scale;
    const drawLeft = (cw - drawW) / 2;
    const drawTop = (ch - drawH) / 2;
    return { drawLeft, drawTop, drawW, drawH, containerW: cw, containerH: ch };
  };

  const aoiContainLayout = useMemo(() => {
    const { w: containerW, h: containerH } = aoiCanvasSize;
    const { w: videoW, h: videoH } = aoiVideoSize;
    if (containerW <= 0 || containerH <= 0) {
      return { drawLeft: 0, drawTop: 0, drawW: 0, drawH: 0, containerW: 0, containerH: 0 };
    }
    if (videoW <= 0 || videoH <= 0) {
      return { drawLeft: 0, drawTop: 0, drawW: containerW, drawH: containerH, containerW, containerH };
    }
    return computeContainLayout({ containerW, containerH, videoW, videoH });
  }, [aoiCanvasSize, aoiVideoSize]);
  const isAoiVideoLayoutReady = aoiVideoSize.w > 0 && aoiVideoSize.h > 0;

  React.useEffect(() => {
    aoiShapesRef.current = aoiShapes;
  }, [aoiShapes]);

  React.useEffect(() => {
    loadedAoiKeyRef.current = null;
    aoiLoadedReadyKeyRef.current = null;
    setAoiShapes([]);
    setAoiSelectedId(null);
    setAoiDraft(null);
    setAoiDrawing(false);
    setAoiTool(null);
    setAoiCursor(null);
    setAoiSelectedStimulusId(null);
    setAoiSelectedRecordId(null);
    setAoiVideoUrl(null);
  }, [projectDir]);

  const selectedStimulus = useMemo(
    () => (aoiSelectedStimulusId ? stimuli.find((s) => s.id === aoiSelectedStimulusId) || null : null),
    [aoiSelectedStimulusId, stimuli],
  );
  const selectedRecord = useMemo(
    () => (aoiSelectedRecordId ? records.find((r) => r && r.id === aoiSelectedRecordId) || null : null),
    [aoiSelectedRecordId, records],
  );
  const isGlassesMode = selectedRecord?.deviceType === '眼镜式';
  const aoiStorageScopeId = useMemo(() => {
    if (isGlassesMode && aoiSelectedRecordId) {
      return `record:${aoiSelectedRecordId}`;
    }
    if (aoiSelectedStimulusId) return aoiSelectedStimulusId;
    return null;
  }, [aoiSelectedStimulusId, isGlassesMode, aoiSelectedRecordId]);

  React.useEffect(() => {
    if (!selectedStimulus) {
      setAoiVideoUrl(null);
      return;
    }
    const stimulusType = String(selectedStimulus.stimulusType || '').toLowerCase();
    const rawUrl = String(selectedStimulus.url || '').trim();
    const isVideoStimulus = stimulusType === 'video' || isStimulusVideoUrl(rawUrl);
    if (!isVideoStimulus) {
      setAoiVideoUrl(null);
      return;
    }

    let cancelled = false;
    setAoiVideoUrl(rawUrl || null);
    const baseDir = projectDir || '';
    if (!baseDir || !ipcClient.isAvailable()) {
      return () => {
        cancelled = true;
      };
    }
    void ipcClient
      .getStimulusMediaUrl({
        projectDir: baseDir,
        stimulusId: String(selectedStimulus.id || ''),
        url: rawUrl || undefined,
        mediaType: 'video',
      })
      .then((res) => {
        if (cancelled) return;
        if (res && res.ok && typeof res.url === 'string' && res.url) {
          setAoiVideoUrl(res.url);
        } else {
          setAoiVideoUrl(rawUrl || null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAoiVideoUrl(rawUrl || null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedStimulus, projectDir]);

  React.useEffect(() => {
    loadedAoiKeyRef.current = null;
    aoiLoadedReadyKeyRef.current = null;
    setAoiShapes([]);
    setAoiSelectedId(null);
    setAoiDraft(null);
    setAoiDrawing(false);
    setAoiTool(null);
    setAoiCursor(null);
  }, [aoiStorageScopeId]);

  const toNormalizedWithLayout = (
    shape: AoiShape,
    layout: AoiContainLayout,
  ): NormalizedAoiShape => {
    const safeW = layout.drawW > 0 ? layout.drawW : Math.max(1, layout.containerW);
    const safeH = layout.drawH > 0 ? layout.drawH : Math.max(1, layout.containerH);
    const ox = Number.isFinite(layout.drawLeft) ? layout.drawLeft : 0;
    const oy = Number.isFinite(layout.drawTop) ? layout.drawTop : 0;
    const base: NormalizedAoiShape = {
      id: shape.id,
      name: shape.name,
      type: shape.type,
      visible: !!shape.visible,
      showStats: !!shape.showStats,
      color: shape.color,
      metric: typeof shape.metric === 'number' && Number.isFinite(shape.metric) ? shape.metric : 0,
      activationTimeMs:
        typeof shape.activationTimeMs === 'number' && Number.isFinite(shape.activationTimeMs)
          ? Math.max(0, Math.round(shape.activationTimeMs))
          : 0,
      analysisTimeRanges: normalizeAoiAnalysisTimeRanges(shape.analysisTimeRanges, shape.analysisTimeRange),
    };
    if (shape.type === 'polygon') {
      const pts = (shape.points || []).map((p) => ({
        x: Math.max(0, Math.min(1, ((p.x || 0) - ox) / safeW)),
        y: Math.max(0, Math.min(1, ((p.y || 0) - oy) / safeH)),
      }));
      const keyframes = (shape.keyframes || []).map((keyframe) => ({
        timeMs: Math.max(0, Math.round(keyframe.timeMs || 0)),
        metric: typeof keyframe.metric === 'number' && Number.isFinite(keyframe.metric) ? keyframe.metric : 0,
        points: (keyframe.points || []).map((point) => ({
          x: Math.max(0, Math.min(1, ((point.x || 0) - ox) / safeW)),
          y: Math.max(0, Math.min(1, ((point.y || 0) - oy) / safeH)),
        })),
      })) as AoiKeyframe[];
      return { ...base, points: pts, keyframes };
    }
    const x = typeof shape.x === 'number' && Number.isFinite(shape.x) ? shape.x : 0;
    const y = typeof shape.y === 'number' && Number.isFinite(shape.y) ? shape.y : 0;
    const w = typeof shape.w === 'number' && Number.isFinite(shape.w) ? shape.w : 0;
    const h = typeof shape.h === 'number' && Number.isFinite(shape.h) ? shape.h : 0;
    const keyframes = (shape.keyframes || []).map((keyframe) => ({
      timeMs: Math.max(0, Math.round(keyframe.timeMs || 0)),
      metric: typeof keyframe.metric === 'number' && Number.isFinite(keyframe.metric) ? keyframe.metric : 0,
      x: Math.max(0, Math.min(1, ((keyframe.x || 0) - ox) / safeW)),
      y: Math.max(0, Math.min(1, ((keyframe.y || 0) - oy) / safeH)),
      w: Math.max(0, Math.min(1, (keyframe.w || 0) / safeW)),
      h: Math.max(0, Math.min(1, (keyframe.h || 0) / safeH)),
    })) as AoiKeyframe[];
    return {
      ...base,
      x: Math.max(0, Math.min(1, (x - ox) / safeW)),
      y: Math.max(0, Math.min(1, (y - oy) / safeH)),
      w: Math.max(0, Math.min(1, w / safeW)),
      h: Math.max(0, Math.min(1, h / safeH)),
      keyframes,
    };
  };

  const fromNormalizedWithLayout = (
    shape: NormalizedAoiShape,
    layout: AoiContainLayout,
  ): AoiShape => {
    const safeW = layout.drawW > 0 ? layout.drawW : Math.max(1, layout.containerW);
    const safeH = layout.drawH > 0 ? layout.drawH : Math.max(1, layout.containerH);
    const ox = Number.isFinite(layout.drawLeft) ? layout.drawLeft : 0;
    const oy = Number.isFinite(layout.drawTop) ? layout.drawTop : 0;
    const base: AoiShape = {
      id: shape.id,
      name: shape.name,
      type: shape.type,
      visible: !!shape.visible,
      showStats: !!shape.showStats,
      color: shape.color,
      metric: typeof shape.metric === 'number' && Number.isFinite(shape.metric) ? shape.metric : 0,
      activationTimeMs:
        typeof shape.activationTimeMs === 'number' && Number.isFinite(shape.activationTimeMs)
          ? Math.max(0, Math.round(shape.activationTimeMs))
          : 0,
      analysisTimeRanges: normalizeAoiAnalysisTimeRanges(shape.analysisTimeRanges, shape.analysisTimeRange),
    };
    if (shape.type === 'polygon') {
      const pts = (shape.points || []).map((p) => ({
        x: ox + (p.x || 0) * safeW,
        y: oy + (p.y || 0) * safeH,
      }));
      const keyframes = (shape.keyframes || []).map((keyframe) => ({
        timeMs: Math.max(0, Math.round(keyframe.timeMs || 0)),
        metric: typeof keyframe.metric === 'number' && Number.isFinite(keyframe.metric) ? keyframe.metric : 0,
        points: (keyframe.points || []).map((point) => ({
          x: ox + (point.x || 0) * safeW,
          y: oy + (point.y || 0) * safeH,
        })),
      })) as AoiKeyframe[];
      return { ...base, points: pts, keyframes };
    }
    const keyframes = (shape.keyframes || []).map((keyframe) => ({
      timeMs: Math.max(0, Math.round(keyframe.timeMs || 0)),
      metric: typeof keyframe.metric === 'number' && Number.isFinite(keyframe.metric) ? keyframe.metric : 0,
      x: ox + (keyframe.x || 0) * safeW,
      y: oy + (keyframe.y || 0) * safeH,
      w: (keyframe.w || 0) * safeW,
      h: (keyframe.h || 0) * safeH,
    })) as AoiKeyframe[];
    return {
      ...base,
      x: ox + (shape.x || 0) * safeW,
      y: oy + (shape.y || 0) * safeH,
      w: (shape.w || 0) * safeW,
      h: (shape.h || 0) * safeH,
      keyframes,
    };
  };

  const toNormalized = (shape: AoiShape): NormalizedAoiShape => toNormalizedWithLayout(shape, aoiContainLayout);

  React.useEffect(() => {
    latestContainLayoutRef.current = aoiContainLayout;
  }, [aoiContainLayout]);

  const isContainLayoutReady = useMemo(() => {
    if (!isActive) return false;
    if (aoiCanvasSize.w <= 0 || aoiCanvasSize.h <= 0) return false;
    if (aoiContainLayout.drawW <= 0 || aoiContainLayout.drawH <= 0) return false;
    if (aoiVideoUrl && !isAoiVideoLayoutReady) return false;
    return true;
  }, [
    isActive,
    aoiCanvasSize.w,
    aoiCanvasSize.h,
    aoiContainLayout.drawW,
    aoiContainLayout.drawH,
    aoiVideoUrl,
    isAoiVideoLayoutReady,
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
  }, [
    isContainLayoutReady,
  ]);

  React.useEffect(() => {
    const prev = prevContainLayoutRef.current;
    const next = aoiContainLayout;
    if (!isActive) {
      return;
    }
    if (!isContainLayoutSettled) {
      return;
    }
    if (!prev) {
      prevContainLayoutRef.current = next;
      return;
    }
    if (
      prev.drawLeft === next.drawLeft &&
      prev.drawTop === next.drawTop &&
      prev.drawW === next.drawW &&
      prev.drawH === next.drawH &&
      prev.containerW === next.containerW &&
      prev.containerH === next.containerH
    ) {
      return;
    }
    prevContainLayoutRef.current = next;
    const current = aoiShapesRef.current;
    if (!current || current.length === 0) return;
    if (prev.drawW <= 0 || prev.drawH <= 0) return;
    if (next.drawW <= 0 || next.drawH <= 0) return;
    const normalized = current.map((s) => toNormalizedWithLayout(s, prev));
    const remapped = normalized.map((s) => fromNormalizedWithLayout(s, next));
    setAoiShapes(remapped);
  }, [
    isActive,
    isContainLayoutSettled,
    aoiContainLayout.drawLeft,
    aoiContainLayout.drawTop,
    aoiContainLayout.drawW,
    aoiContainLayout.drawH,
    aoiContainLayout.containerW,
    aoiContainLayout.containerH,
  ]);

  React.useEffect(() => {
    const el = aoiCanvasRef.current;
    if (!el) {
      if (canvasResizeObserverRef.current) {
        canvasResizeObserverRef.current.disconnect();
        canvasResizeObserverRef.current = null;
      }
      observedCanvasElRef.current = null;
      return;
    }
    if (observedCanvasElRef.current !== el) {
      observedCanvasElRef.current = el;
      if (canvasResizeObserverRef.current) {
        canvasResizeObserverRef.current.disconnect();
        canvasResizeObserverRef.current = null;
      }
      const updateFromRect = () => {
        const rect = el.getBoundingClientRect();
        const w = Math.max(0, Math.round(rect.width || 0));
        const h = Math.max(0, Math.round(rect.height || 0));
        setAoiCanvasSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
      };
      updateFromRect();
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => updateFromRect());
        ro.observe(el);
        canvasResizeObserverRef.current = ro;
      }
    }
  });

  React.useEffect(() => {
    return () => {
      if (layoutSettleTimerRef.current) {
        window.clearTimeout(layoutSettleTimerRef.current);
        layoutSettleTimerRef.current = null;
      }
      if (canvasResizeObserverRef.current) {
        canvasResizeObserverRef.current.disconnect();
        canvasResizeObserverRef.current = null;
      }
    };
  }, []);

  React.useEffect(() => {
    const baseDir = projectDir || '';
    if (!baseDir || !ipcClient.isAvailable()) return;
    if (!isActive) return;
    if (!aoiStorageScopeId) return;
    if (!isContainLayoutSettled) return;
    const key = `${baseDir}::scope::${aoiStorageScopeId}`;
    if (loadedAoiKeyRef.current === key) return;

    let cancelled = false;
    loadedAoiKeyRef.current = key;
    aoiLoadedReadyKeyRef.current = null;
    setAoiShapes([]);
    setAoiSelectedId(null);
    setAoiDraft(null);
    setAoiDrawing(false);
    setAoiTool(null);
    setAoiCursor(null);
    (async () => {
      const res = await ipcClient.loadAoi({ projectDir: baseDir });
      if (cancelled) return;
      const store = res?.ok ? parseAoiStore(res.data) : null;
      const normalizedList = store?.byRecordId[aoiStorageScopeId];
      if (!normalizedList) {
        setAoiShapes([]);
        aoiLoadedReadyKeyRef.current = key;
        return;
      }
      const layoutAtApply = latestContainLayoutRef.current;
      prevContainLayoutRef.current = layoutAtApply;
      const shapes = normalizedList.map((shape) => fromNormalizedWithLayout(shape, layoutAtApply));
      setAoiShapes(shapes);
      aoiLoadedReadyKeyRef.current = key;
    })();

    return () => {
      cancelled = true;
    };
  }, [isActive, aoiStorageScopeId, projectDir, isContainLayoutSettled]);

  React.useEffect(() => {
    const baseDir = projectDir || '';
    if (!baseDir || !ipcClient.isAvailable()) return;
    if (!isActive) return;
    if (!aoiStorageScopeId) return;
    if (!isContainLayoutSettled) return;
    const key = `${baseDir}::scope::${aoiStorageScopeId}`;
    if (aoiLoadedReadyKeyRef.current !== key) return;

    if (saveDebounceRef.current) {
      window.clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = null;
    }

    saveDebounceRef.current = window.setTimeout(() => {
      const normalized = aoiShapes.map((s) => toNormalized(s));
      void ipcClient.saveAoi({ projectDir: baseDir, recordId: aoiStorageScopeId, shapes: normalized });
    }, 250);

    return () => {
      if (saveDebounceRef.current) {
        window.clearTimeout(saveDebounceRef.current);
        saveDebounceRef.current = null;
      }
    };
  }, [isActive, aoiShapes, aoiStorageScopeId, projectDir, isContainLayoutSettled]);

  const selectedAoi = useMemo(() => aoiShapes.find((s) => s.id === aoiSelectedId) || null, [aoiShapes, aoiSelectedId]);

  React.useEffect(() => {
    if (!isActive) return;
    if (!prevContainLayoutRef.current) {
      prevContainLayoutRef.current = latestContainLayoutRef.current;
    }
  }, [isActive]);

  React.useEffect(() => {
    // Reset layout readiness on source switch; AOI load/save waits for real video metadata.
    setAoiVideoSize({ w: 0, h: 0 });
    setAoiVideoDurationMs(0);
    prevContainLayoutRef.current = null;
  }, [aoiStorageScopeId, aoiVideoUrl]);

  React.useEffect(() => {
    if (!isActive) return;
    const el = aoiVideoRef.current;
    if (!el) return;

    let cancelled = false;
    let frameId = 0;
    let playing = false;
    const updateTime = () => {
      if (cancelled) return;
      const next = Math.max(0, (el.currentTime || 0) * 1000 + timeOffsetMs);
      setAoiVideoTimeMs(next);
      if (playing) {
        frameId = window.requestAnimationFrame(updateTime);
      }
    };

    const onPlay = () => {
      playing = true;
      setAoiVideoIsPlaying(true);
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(updateTime);
    };

    const onPause = () => {
      playing = false;
      setAoiVideoIsPlaying(false);
      window.cancelAnimationFrame(frameId);
      updateTime();
    };

    const onSeeked = () => {
      updateTime();
    };

    const onEnded = () => {
      playing = false;
      setAoiVideoIsPlaying(false);
      window.cancelAnimationFrame(frameId);
      updateTime();
    };

    const onLoadedMetadata = () => {
      updateTime();
      playing = !el.paused && !el.ended;
      setAoiVideoIsPlaying(playing);
      const vw = Math.max(0, Math.round(el.videoWidth || 0));
      const vh = Math.max(0, Math.round(el.videoHeight || 0));
      if (vw > 0 && vh > 0) {
        setAoiVideoSize((prev) => (prev.w === vw && prev.h === vh ? prev : { w: vw, h: vh }));
      }
      const durMs = Number.isFinite(el.duration) ? Math.max(0, el.duration * 1000) : 0;
      setAoiVideoDurationMs(durMs);
      if (playing) {
        window.cancelAnimationFrame(frameId);
        frameId = window.requestAnimationFrame(updateTime);
      }
    };

    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('seeked', onSeeked);
    el.addEventListener('ended', onEnded);
    el.addEventListener('loadedmetadata', onLoadedMetadata);
    if (el.readyState >= 1 && (el.videoWidth || 0) > 0 && (el.videoHeight || 0) > 0) {
      onLoadedMetadata();
    } else {
      updateTime();
      playing = !el.paused && !el.ended;
      setAoiVideoIsPlaying(playing);
      if (playing) {
        window.cancelAnimationFrame(frameId);
        frameId = window.requestAnimationFrame(updateTime);
      }
    }

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('seeked', onSeeked);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('loadedmetadata', onLoadedMetadata);
    };
  }, [isActive, aoiStorageScopeId, aoiVideoUrl, timeOffsetMs]);

  React.useEffect(() => {
    if (!aoiSelectedRecordId) {
      setAoiPointsLoading(false);
      setAoiPointsError(null);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(aoiPointsByRecord, aoiSelectedRecordId)) {
      return;
    }
    if (!ipcClient.isAvailable()) {
      return;
    }

    const record = records.find((r) => r && r.id === aoiSelectedRecordId);
    const csvPath = record?.csvPath;
    if (!csvPath) {
      setAoiPointsByRecord((prev) => ({ ...prev, [aoiSelectedRecordId]: [] }));
      setAoiPointsError((prev) => prev ?? '未找到 CSV 数据路径');
      return;
    }

    let cancelled = false;
    setAoiPointsLoading(true);
    setAoiPointsError(null);

    (async () => {
      try {
        const res = await ipcClient.loadRecordPoints({
          csvPath,
          pointMode: 'fixation',
          includeSdkSaccades: true,
          isGlassesMode: record?.deviceType === '眼镜式',
          ...getRecordingFrameSizeOptions(record),
        });
        if (cancelled) return;
        if (res && res.ok && Array.isArray(res.points)) {
          const points = res.points as HeatmapPoint[];
          setAoiPointsByRecord((prev) => ({ ...prev, [aoiSelectedRecordId]: points }));
        } else {
          setAoiPointsByRecord((prev) => ({ ...prev, [aoiSelectedRecordId]: [] }));
          setAoiPointsError((prev) => prev ?? 'CSV 加载失败');
        }
      } catch {
        if (cancelled) return;
        setAoiPointsByRecord((prev) => ({ ...prev, [aoiSelectedRecordId]: [] }));
        setAoiPointsError((prev) => prev ?? 'CSV 读取异常');
      } finally {
        if (!cancelled) setAoiPointsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [aoiSelectedRecordId, records, aoiPointsByRecord]);

  return {
    aoiShapes,
    setAoiShapes,
    aoiTool,
    setAoiTool,
    aoiDrawing,
    setAoiDrawing,
    aoiSelectedId,
    setAoiSelectedId,
    aoiDraft,
    setAoiDraft,
    aoiCursor,
    setAoiCursor,
    aoiCanvasRef,
    aoiVideoRef,
    aoiSelectedStimulusId,
    setAoiSelectedStimulusId,
    aoiSelectedRecordId,
    setAoiSelectedRecordId,
    aoiVideoUrl,
    aoiSyncVideoMeta,
    aoiClearVideoMeta,
    aoiPointsLoading,
    aoiPointsError,
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
  };
}
