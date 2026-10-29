import React from 'react';
import { ArrowLeft, FastForward, Pause, Play, Rewind, SkipBack, SkipForward, Download } from 'lucide-react';
import type { RecordingRecord } from '@shared/contracts/domain/models';
import CustomSelect from '@/shared/ui/CustomSelect';
import { Modal } from '@/shared/ui/Modal';
import SpinnerRing from '@/shared/ui/SpinnerRing';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import type { HeatmapPoint } from '@/shared/types/mrt';
import { useTimeOffsetMs } from '@/features/analysis/time-offset/useTimeOffset';
import { getDisplayRecordName } from '@/features/records/domain/recordDisplayName';
import { useGazeDisplayPath } from '@/features/recording/domain/gazeDisplayPath';
import type { VideoExportStatus } from '@/features/export/domain/videoExportStatus';
import {
  computeContainedMediaLayout,
  resolveEffectiveFrameSize,
  type ContainedMediaLayout,
} from '@/features/records/domain/playback/playbackMediaModel';
import { useRecordPlaybackController } from '@/features/records/domain/playback/useRecordPlaybackController';
import { useRecordGazePlayback } from '@/features/records/domain/playback/useRecordGazePlayback';
import { RecordPlaybackTimeline } from '@/features/records/domain/playback/RecordPlaybackTimeline';
import { drawPlaybackGazeCursor, findPlaybackGazePoint } from '@/features/records/domain/playback/playbackGazeRendering';

interface RecordDetailPageProps {
  records: RecordingRecord[];
  selectedRecordId: string | null;
  projectDir: string | null;
  detailVideoUrl: string | null;
  detailVideoRef: React.RefObject<HTMLVideoElement | null>;
  onPlay: () => void;
  onBackToList: () => void;
  detailProps: { style: string; radius: number; opacity: number; color: string };
  setDetailProps: React.Dispatch<React.SetStateAction<{ style: string; radius: number; opacity: number; color: string }>>;
  onVideoExportStatusChange?: (status: VideoExportStatus | null) => void;
}

type RecordDetailPageContentProps = Omit<RecordDetailPageProps, 'records'> & {
  record: RecordingRecord;
};

type OverlayLayout = ContainedMediaLayout;

const MAX_TIMELINE_MARKERS = 1000;

function formatSecondsTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00.0';
  const mm = Math.floor(seconds / 60);
  const ss = seconds - mm * 60;
  const ssInt = Math.floor(ss);
  const tenth = Math.floor((ss - ssInt) * 10);
  return `${String(mm).padStart(2, '0')}:${String(ssInt).padStart(2, '0')}.${tenth}`;
}

const RecordDetailPageContent: React.FC<RecordDetailPageContentProps> = ({
  record,
  selectedRecordId,
  projectDir,
  detailVideoUrl,
  detailVideoRef,
  onPlay,
  onBackToList,
  detailProps,
  setDetailProps,
  onVideoExportStatusChange,
}) => {
  const { gazeDisplayPath } = useGazeDisplayPath();
  const { timeOffsetMs } = useTimeOffsetMs();
  const [overlayLayout, setOverlayLayout] = React.useState<OverlayLayout | null>(null);
  const videoWrapRef = React.useRef<HTMLDivElement | null>(null);
  const overlayCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [isExporting, setIsExporting] = React.useState(false);
  const [exportProgressPercent, setExportProgressPercent] = React.useState(0);
  const [exportPreviewUrl, setExportPreviewUrl] = React.useState<string | null>(null);
  const [repairedVideoUrl, setRepairedVideoUrl] = React.useState<string | null>(null);
  const [isRepairingVideo, setIsRepairingVideo] = React.useState(false);
  const [videoLoadAlert, setVideoLoadAlert] = React.useState<string | null>(null);
  const isMountedRef = React.useRef(true);
  const repairTriedByPathRef = React.useRef<Record<string, boolean>>({});
  const metadataTimeoutCountByPathRef = React.useRef<Record<string, number>>({});
  const ffmpegMissingByPathRef = React.useRef<Record<string, boolean>>({});
  const urlRetryStateRef = React.useRef<{ active: boolean; attempts: number; timerId: number | null }>({
    active: false,
    attempts: 0,
    timerId: null,
  });
  const EXPORT_FPS = 30;
  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const emitVideoDebug = React.useCallback((event: string, details?: Record<string, unknown>) => {
    if (!ipcClient.isAvailable()) return;
    void ipcClient.videoDebugLog({
      event: `record-detail/${event}`,
      details: {
        selectedRecordId: selectedRecordId || null,
        activeRecordId: record.id,
        activeRecordName: record.name,
        projectDir: projectDir || null,
        mp4Path: record.mp4Path || null,
        ...details,
      },
    });
  }, [projectDir, record.id, record.mp4Path, record.name, selectedRecordId]);

  const videoUrl = repairedVideoUrl || detailVideoUrl || record.mp4Url || null;
  const hasVideo = Boolean(videoUrl);
  const playback = useRecordPlaybackController({
    recordId: record.id,
    sourceUrl: videoUrl,
    externalVideoRef: detailVideoRef,
    emitDebug: emitVideoDebug,
  });
  const { media, visualCurrentTime } = playback;
  const duration = media.durationSeconds;
  const currentTime = media.currentTimeSeconds;
  const isPlaying = media.isPlaying;
  const videoSize = { w: media.intrinsicWidth, h: media.intrinsicHeight };
  const effectiveFrameSize = resolveEffectiveFrameSize({
    intrinsicWidth: media.intrinsicWidth,
    intrinsicHeight: media.intrinsicHeight,
    recordWidth: record.videoWidth,
    recordHeight: record.videoHeight,
  });
  const fixationPoints = useRecordGazePlayback({
    record,
    pointSource: gazeDisplayPath,
    currentTimeSeconds: currentTime,
    frameWidth: effectiveFrameSize.width,
    frameHeight: effectiveFrameSize.height,
    frameSizeSource: effectiveFrameSize.source,
    emitDebug: emitVideoDebug,
  });
  const appendUrlNonce = React.useCallback((url: string, key: string): string => {
    const suffix = url.includes('?') ? '&' : '?';
    return `${url}${suffix}${key}=${Date.now()}`;
  }, []);

  const stopUrlResolveRetry = React.useCallback(() => {
    const state = urlRetryStateRef.current;
    if (state.active || state.attempts > 0 || state.timerId !== null) {
      emitVideoDebug('url-retry-stop', {
        attempts: state.attempts,
        hadTimer: state.timerId !== null,
      });
    }
    state.active = false;
    state.attempts = 0;
    if (state.timerId !== null) {
      window.clearTimeout(state.timerId);
      state.timerId = null;
    }
  }, [emitVideoDebug]);

  const getRepairKey = React.useCallback((): string => {
    if (typeof record.mp4Path === 'string' && record.mp4Path.trim().length > 0) {
      return record.mp4Path.trim();
    }
    return `record:${record.id}`;
  }, [record.id, record.mp4Path]);

  const isFfmpegMissingMessage = React.useCallback((message: string): boolean => {
    const text = String(message || '').trim();
    if (!text) return false;
    const lower = text.toLowerCase();
    if (!lower.includes('ffmpeg')) return false;
    return (
      lower.includes('not found')
      || text.includes('未找到')
      || text.includes('找不到')
      || text.includes('无法修复')
    );
  }, []);

  const markFfmpegMissing = React.useCallback((params: { key: string; reason: string; message: string }) => {
    const { key, reason, message } = params;
    ffmpegMissingByPathRef.current[key] = true;
    stopUrlResolveRetry();
    setVideoLoadAlert('当前环境未找到 ffmpeg，录制视频未转成 H264，播放器暂时无法加载。请安装或打包 ffmpeg 后重试。');
    emitVideoDebug('repair-ffmpeg-missing', {
      key,
      reason,
      message,
    });
  }, [emitVideoDebug, stopUrlResolveRetry]);

  const triggerVideoRepair = React.useCallback((reason: string): boolean => {
    const key = getRepairKey();
    if (!key || !ipcClient.isAvailable()) return false;
    if (ffmpegMissingByPathRef.current[key]) {
      emitVideoDebug('repair-skip-ffmpeg-missing', { reason, key });
      return false;
    }
    if (isRepairingVideo) {
      emitVideoDebug('repair-skip-in-progress', { reason, key });
      return false;
    }
    if (repairTriedByPathRef.current[key]) {
      emitVideoDebug('repair-skip-already-tried', { reason, key });
      return false;
    }
    repairTriedByPathRef.current[key] = true;
    setIsRepairingVideo(true);
    emitVideoDebug('repair-triggered', { reason, key });
    void ipcClient
      .repairRecordVideo({ mp4Path: key })
      .then((res) => {
        if (res && res.ok && typeof res.url === 'string' && res.url) {
          ffmpegMissingByPathRef.current[key] = false;
          setVideoLoadAlert(null);
          metadataTimeoutCountByPathRef.current[key] = 0;
          setRepairedVideoUrl(appendUrlNonce(res.url, 'repair_ts'));
          stopUrlResolveRetry();
          emitVideoDebug('repair-success', {
            reason,
            key,
            resolvedUrl: res.url,
          });
        } else {
          console.warn('[renderer] repair-record-video failed', res);
          const message = res && 'message' in res && typeof res.message === 'string' ? res.message : '';
          if (isFfmpegMissingMessage(message)) {
            markFfmpegMissing({
              key,
              reason,
              message,
            });
            return;
          }
          emitVideoDebug('repair-failed-response', {
            reason,
            key,
            response: res as unknown as Record<string, unknown>,
          });
        }
      })
      .catch((repairErr) => {
        console.warn('[renderer] repair-record-video exception', repairErr);
        const errObj = repairErr as Error;
        emitVideoDebug('repair-exception', {
          reason,
          key,
          message: errObj?.message || String(repairErr),
          name: errObj?.name || null,
        });
      })
      .finally(() => {
        setIsRepairingVideo(false);
        emitVideoDebug('repair-finished', { reason, key });
      });
    return true;
  }, [appendUrlNonce, emitVideoDebug, getRepairKey, isFfmpegMissingMessage, isRepairingVideo, markFfmpegMissing, stopUrlResolveRetry]);

  const startUrlResolveRetry = React.useCallback(() => {
    const mp4Path = typeof record.mp4Path === 'string' ? record.mp4Path.trim() : '';
    const project = typeof projectDir === 'string' ? projectDir.trim() : '';
    if (!mp4Path || !project || !ipcClient.isAvailable()) {
      emitVideoDebug('url-retry-skip', {
        reason: 'missing-context-or-ipc',
        hasMp4Path: Boolean(mp4Path),
        hasProjectDir: Boolean(project),
        ipcAvailable: ipcClient.isAvailable(),
      });
      return;
    }
    const repairKey = getRepairKey();
    if (ffmpegMissingByPathRef.current[repairKey]) {
      emitVideoDebug('url-retry-skip-ffmpeg-missing', {
        repairKey,
      });
      return;
    }

    const state = urlRetryStateRef.current;
    if (state.active) {
      emitVideoDebug('url-retry-already-active', {
        attempts: state.attempts,
      });
      return;
    }
    state.active = true;
    state.attempts = 0;
    emitVideoDebug('url-retry-start', {
      mp4Path,
      projectDir: project,
    });

    const run = () => {
      const current = urlRetryStateRef.current;
      if (!current.active) return;
      if (current.attempts >= 10) {
        emitVideoDebug('url-retry-give-up', {
          attempts: current.attempts,
          maxAttempts: 10,
        });
        current.active = false;
        return;
      }
      const delayMs = Math.min(8000, 500 + current.attempts * 900);
      emitVideoDebug('url-retry-schedule', {
        attempts: current.attempts,
        delayMs,
      });
      current.timerId = window.setTimeout(() => {
        const latest = urlRetryStateRef.current;
        latest.timerId = null;
        if (!latest.active) return;
        latest.attempts += 1;
        const attempt = latest.attempts;
        emitVideoDebug('url-retry-attempt', {
          attempt,
          mp4Path,
          projectDir: project,
        });
        void ipcClient
          .getRecordVideoUrl({
            projectDir: project,
            name: record.name,
            recordPath: mp4Path,
          })
          .then((res) => {
            if (res && res.ok && typeof res.url === 'string' && res.url) {
              setRepairedVideoUrl(appendUrlNonce(res.url, 'reload_ts'));
              emitVideoDebug('url-retry-success', {
                attempt,
                resolvedUrl: res.url,
              });
              stopUrlResolveRetry();
              return;
            }
            emitVideoDebug('url-retry-response-not-ok', {
              attempt,
              response: res as unknown as Record<string, unknown>,
            });
            run();
          })
          .catch((error) => {
            const err = error as Error;
            emitVideoDebug('url-retry-exception', {
              attempt,
              message: err?.message || String(error),
              name: err?.name || null,
            });
            run();
          });
      }, delayMs);
    };

    run();
  }, [appendUrlNonce, emitVideoDebug, getRepairKey, projectDir, record.mp4Path, record.name, stopUrlResolveRetry]);
  const displayVideoPath = React.useMemo(() => {
    if (record.mp4Path) return record.mp4Path;
    if (!videoUrl) return '---';
    const raw = String(videoUrl);
    try {
      if (raw.startsWith('local-resource:')) {
        const u = new URL(raw.replace(/^local-resource:/, 'file:'));
        return decodeURIComponent(u.pathname);
      }
      if (raw.startsWith('file:')) {
        const u = new URL(raw);
        return decodeURIComponent(u.pathname);
      }
    } catch {
    }
    return raw;
  }, [record.mp4Path, videoUrl]);
  const fpsValue = Number(record.fps);
  const frameStep = Number.isFinite(fpsValue) && fpsValue > 0 ? 1 / fpsValue : 0.04;

  React.useEffect(() => {
    setRepairedVideoUrl(null);
    setIsRepairingVideo(false);
    setVideoLoadAlert(null);
    stopUrlResolveRetry();
    const key = typeof record.mp4Path === 'string' && record.mp4Path.trim()
      ? record.mp4Path.trim()
      : `record:${record.id}`;
    delete repairTriedByPathRef.current[key];
    delete metadataTimeoutCountByPathRef.current[key];
    delete ffmpegMissingByPathRef.current[key];
  }, [record.id]);

  const unmountDebugRef = React.useRef(emitVideoDebug);
  const unmountStopRetryRef = React.useRef(stopUrlResolveRetry);
  unmountDebugRef.current = emitVideoDebug;
  unmountStopRetryRef.current = stopUrlResolveRetry;
  React.useEffect(() => () => {
    unmountDebugRef.current('component-unmount-stop-retry');
    unmountStopRetryRef.current();
  }, []);

  React.useEffect(() => {
    if (!videoUrl) return;
    const repairKey = getRepairKey();
    emitVideoDebug('watch-video-metadata', {
      videoUrl,
    });
    const timerId = window.setTimeout(() => {
      const el = detailVideoRef.current;
      const hasMetadata =
        !!el &&
        Number.isFinite(el.duration) &&
        el.duration > 0 &&
        (el.videoWidth > 0 || el.videoHeight > 0);
      if (!hasMetadata) {
        if (ffmpegMissingByPathRef.current[repairKey]) {
          emitVideoDebug('metadata-watchdog-skip-ffmpeg-missing', {
            repairKey,
          });
          return;
        }
        const timeoutCount = ((metadataTimeoutCountByPathRef.current[repairKey] || 0) + 1);
        metadataTimeoutCountByPathRef.current[repairKey] = timeoutCount;
        emitVideoDebug('metadata-watchdog-timeout', {
          videoUrl,
          repairKey,
          timeoutCount,
          duration: el?.duration ?? null,
          videoWidth: el?.videoWidth ?? null,
          videoHeight: el?.videoHeight ?? null,
          readyState: el?.readyState ?? null,
          networkState: el?.networkState ?? null,
          currentSrc: el?.currentSrc ?? null,
        });
        if (timeoutCount >= 3) {
          const repaired = triggerVideoRepair('metadata-watchdog-timeout');
          if (!repaired) {
            startUrlResolveRetry();
          }
        } else {
          startUrlResolveRetry();
        }
      } else {
        playback.syncFromElement(el, 'metadata-watchdog');
        ffmpegMissingByPathRef.current[repairKey] = false;
        setVideoLoadAlert(null);
        metadataTimeoutCountByPathRef.current[repairKey] = 0;
        emitVideoDebug('metadata-watchdog-ok', {
          videoUrl,
          repairKey,
          duration: el?.duration ?? null,
          videoWidth: el?.videoWidth ?? null,
          videoHeight: el?.videoHeight ?? null,
        });
      }
    }, 5200);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [detailVideoRef, emitVideoDebug, getRepairKey, playback.syncFromElement, startUrlResolveRetry, triggerVideoRepair, videoUrl]);

  React.useEffect(() => {
    const canvas = overlayCanvasRef.current;
    const wrap = videoWrapRef.current;
    if (!canvas || !wrap) return;

    const update = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const layout = computeContainedMediaLayout({
        containerWidth: rect.width,
        containerHeight: rect.height,
        mediaWidth: videoSize.w,
        mediaHeight: videoSize.h,
        devicePixelRatio: dpr,
      });
      if (!layout) {
        const context = canvas.getContext('2d');
        context?.clearRect(0, 0, canvas.width, canvas.height);
        setOverlayLayout(null);
        return;
      }
      const nextW = Math.max(1, Math.floor(layout.canvasCssWidth * layout.devicePixelRatio));
      const nextH = Math.max(1, Math.floor(layout.canvasCssHeight * layout.devicePixelRatio));
      if (canvas.width !== nextW) canvas.width = nextW;
      if (canvas.height !== nextH) canvas.height = nextH;
      canvas.style.width = `${layout.canvasCssWidth}px`;
      canvas.style.height = `${layout.canvasCssHeight}px`;
      setOverlayLayout(layout);
    };

    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(wrap);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [videoSize.w, videoSize.h]);

  const alignedFixationPoints = React.useMemo(() => {
    if (!fixationPoints || fixationPoints.length === 0) return [];
    // Windowed points are already filtered by absolute video time in the main process.
    // Rebasing them to the window's first timestamp would make long-video playback
    // compare (for example) 1,248,000ms against a false 0-30,000ms range.
    return [...fixationPoints].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }, [fixationPoints]);

  const timelineMarkerPoints = React.useMemo(() => {
    if (!alignedFixationPoints || alignedFixationPoints.length === 0 || !(duration > 0)) return [];
    const markers: Array<{ key: string; left: number; title: string }> = [];
    const stride = Math.max(1, Math.ceil(alignedFixationPoints.length / MAX_TIMELINE_MARKERS));
    for (let i = 0; i < alignedFixationPoints.length; i += 1) {
      const p = alignedFixationPoints[i];
      if (!p.marker) continue;
      if (markers.length >= MAX_TIMELINE_MARKERS && i % stride !== 0) continue;
      const t = p.timestamp || 0;
      const pSec = t / 1000;
      if (pSec < 0 || pSec > duration) continue;
      markers.push({
        key: `${i}-${Math.round(t)}`,
        left: (pSec / duration) * 100,
        title: `标记: ${p.marker} @ ${formatSecondsTime(pSec)}`,
      });
    }
    return markers;
  }, [alignedFixationPoints, duration]);

  const currentFixationPoint = React.useMemo(() => {
    if (!alignedFixationPoints || alignedFixationPoints.length === 0) return null;
    const t = Math.max(0, currentTime * 1000 + timeOffsetMs);
    return findPlaybackGazePoint(alignedFixationPoints, t);
  }, [alignedFixationPoints, currentTime, timeOffsetMs]);

  React.useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || !overlayLayout) return;
    if (isPlaying) return;
    drawPlaybackGazeCursor({
      canvas,
      point: currentFixationPoint,
      layout: overlayLayout,
      style: detailProps.style,
      radius: detailProps.radius,
      opacity: detailProps.opacity,
      color: detailProps.color,
    });
  }, [currentFixationPoint, overlayLayout, detailProps.style, detailProps.radius, detailProps.opacity, detailProps.color, isPlaying]);

  React.useEffect(() => {
    const video = detailVideoRef.current;
    const canvas = overlayCanvasRef.current;
    if (!video || !canvas || !overlayLayout) return;
    if (!isPlaying) return;

    let rafId = 0;
    let videoFrameCallbackId = 0;
    let cancelled = false;
    let lastDrawnPoint: HeatmapPoint | null = null;

    const drawAt = (mediaTimeSeconds: number) => {
      if (cancelled) return;
      const t = Math.max(0, mediaTimeSeconds * 1000 + timeOffsetMs);
      const point = findPlaybackGazePoint(alignedFixationPoints, t);
      if (point === lastDrawnPoint) return;
      lastDrawnPoint = point;
      drawPlaybackGazeCursor({
        canvas,
        point,
        layout: overlayLayout,
        style: detailProps.style,
        radius: detailProps.radius,
        opacity: detailProps.opacity,
        color: detailProps.color,
      });
    };

    // Draw the gaze cursor only when Chromium presents a decoded video frame.
    // A free-running RAF clock can advance while a slow Windows decoder is
    // still showing the previous frame, which makes the cursor flicker or look
    // duplicated. Frame callbacks bind the overlay to the actual media frame.
    if (typeof video.requestVideoFrameCallback === 'function') {
      const onVideoFrame: VideoFrameRequestCallback = (_now, metadata) => {
        if (cancelled) return;
        const mediaTime = Number.isFinite(metadata.mediaTime)
          ? metadata.mediaTime
          : Number.isFinite(video.currentTime)
            ? video.currentTime
            : 0;
        drawAt(mediaTime);
        videoFrameCallbackId = video.requestVideoFrameCallback(onVideoFrame);
      };
      videoFrameCallbackId = video.requestVideoFrameCallback(onVideoFrame);
    } else {
      const tick = () => {
        if (cancelled) return;
        drawAt(Number.isFinite(video.currentTime) ? video.currentTime : 0);
        rafId = window.requestAnimationFrame(tick);
      };
      rafId = window.requestAnimationFrame(tick);
    }

    return () => {
      cancelled = true;
      if (videoFrameCallbackId && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(videoFrameCallbackId);
      }
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [
    isPlaying,
    detailVideoRef,
    overlayLayout,
    alignedFixationPoints,
    detailProps.style,
    detailProps.radius,
    detailProps.opacity,
    detailProps.color,
    timeOffsetMs,
  ]);

  React.useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssSize = 200;
    const pxSize = Math.max(1, Math.floor(cssSize * dpr));
    if (canvas.width !== pxSize) canvas.width = pxSize;
    if (canvas.height !== pxSize) canvas.height = pxSize;
    canvas.style.width = `${cssSize}px`;
    canvas.style.height = `${cssSize}px`;
    const layout: OverlayLayout = {
      canvasCssWidth: cssSize,
      canvasCssHeight: cssSize,
      drawLeft: 0,
      drawTop: 0,
      drawWidth: cssSize,
      drawHeight: cssSize,
      devicePixelRatio: dpr,
    };
    drawPlaybackGazeCursor({
      canvas,
      point: currentFixationPoint,
      layout,
      style: detailProps.style,
      radius: detailProps.radius,
      opacity: detailProps.opacity,
      color: detailProps.color,
    });
  }, [currentFixationPoint, detailProps.style, detailProps.radius, detailProps.opacity, detailProps.color]);

  const formatTime = formatSecondsTime;

  const togglePlay = () => playback.togglePlay(onPlay);
  const seekBy = (deltaSeconds: number) => playback.seekBy(deltaSeconds);
  const seekTo = (nextTime: number) => playback.seekTo(nextTime);

  const isExportingRef = React.useRef(false);
  React.useEffect(() => {
    isExportingRef.current = isExporting;
  }, [isExporting]);

  const sanitizeExportName = React.useCallback((value: string): string => {
    const cleaned = String(value || '')
      .trim()
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_');
    return cleaned || 'export';
  }, []);

  const buildTempWebmPath = React.useCallback(
    (sourcePath: string, name: string): string => {
      const raw = String(sourcePath || '');
      const lastSep = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
      const dir = lastSep >= 0 ? raw.slice(0, lastSep) : '.';
      const isWin = /^[a-zA-Z]:\\/.test(raw) || raw.includes('\\');
      const sep = isWin ? '\\' : '/';
      return `${dir}${sep}.mrt_export_tmp${sep}${sanitizeExportName(name)}_${Date.now()}.webm`;
    },
    [sanitizeExportName],
  );

  const toLocalFileUrl = React.useCallback((filePath: string): string => {
    const normalized = String(filePath || '').trim();
    if (!normalized) return '';
    const slashPath = normalized.replace(/\\/g, '/');
    if (/^[a-zA-Z]:\//.test(slashPath)) {
      return encodeURI(`file:///${slashPath}`);
    }
    if (slashPath.startsWith('/')) {
      return encodeURI(`file://${slashPath}`);
    }
    return encodeURI(`file://${slashPath}`);
  }, []);

  const handleExport = async () => {
    if (isExporting) return;
    if (!videoUrl || !duration) return;

    setIsExporting(true);
    setExportProgressPercent(0);
    const exportBaseName = `export-${record.name}-${Date.now()}`;
    const taskId = `record-detail-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const exportDuration = Math.max(0.001, duration);
    let detachExportVideo: (() => void) | null = null;

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
        source: 'record-detail',
        phase: params.phase,
        progress,
        label: params.label,
        recordName: record.name || 'record',
        outputPath: params.outputPath,
        updatedAt: Date.now(),
      });
    };
    reportStatus({ phase: 'rendering', progress: 0, label: '视频导出准备中' });

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
      exportVideoEl.src = videoUrl;
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
          reject(new Error('视频加载失败'));
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
        exportVideoEl.currentTime = 0;
      });

      const width = Math.max(1, Math.round(exportVideoEl.videoWidth || detailVideoRef.current?.videoWidth || videoSize.w || 1920));
      const height = Math.max(1, Math.round(exportVideoEl.videoHeight || detailVideoRef.current?.videoHeight || videoSize.h || 1080));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas context not available');

      const stream = canvas.captureStream(EXPORT_FPS);
      try {
        const compatibleVideo = exportVideoEl as HTMLVideoElement & {
          captureStream?: () => MediaStream;
          mozCaptureStream?: () => MediaStream;
        };
        const vStream = compatibleVideo.captureStream
          ? compatibleVideo.captureStream()
          : compatibleVideo.mozCaptureStream
            ? compatibleVideo.mozCaptureStream()
            : null;
        if (vStream) {
          const audioTracks = vStream.getAudioTracks();
          if (audioTracks.length > 0) stream.addTrack(audioTracks[0]);
        }
      } catch (e) {
        console.warn('Audio capture not supported', e);
      }

      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5000000 });
      const chunks: Blob[] = [];
      let rafId = 0;
      let lastProgressReportAt = 0;
      const frameIntervalMs = 1000 / EXPORT_FPS;
      let lastRenderAt = 0;

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
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
        if (ipcClient.isAvailable() && record.mp4Path) {
          try {
            const buffer = new Uint8Array(await blob.arrayBuffer());
            const tempWebmPath = buildTempWebmPath(record.mp4Path, exportBaseName);
            const saveRes = await ipcClient.saveFile({
              filePath: tempWebmPath,
              content: buffer,
              ensureDir: true,
            });
            if (saveRes.ok) {
              const fastRes = await ipcClient.exportVideoFast({
                sourcePath: tempWebmPath,
                defaultName: `${exportBaseName}.mp4`,
                preserveAudio: true,
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
                const previewUrl = toLocalFileUrl(fastRes.path);
                if (previewUrl && isMountedRef.current) {
                  setExportPreviewUrl(previewUrl);
                }
                window.alert('导出成功，已生成回放');
              } else {
                const msg = 'message' in fastRes ? fastRes.message : undefined;
                if (msg && msg.includes('已取消')) {
                  handled = true;
                  reportStatus({ phase: 'failed', progress: 1, label: '导出已取消' });
                } else {
                  if (msg) failedMessage = msg;
                  console.warn('[RecordDetail] Fast overlay export failed:', fastRes);
                }
              }
            } else {
              failedMessage = '临时视频写入失败';
            }
          } catch (error) {
            failedMessage = error instanceof Error ? error.message : failedMessage;
            console.error('[RecordDetail] Fast overlay export exception:', error);
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

        const currentSec = Number.isFinite(exportVideoEl.currentTime) ? exportVideoEl.currentTime : 0;
        const clampedSec = Math.max(0, Math.min(duration, currentSec));
        ctx.drawImage(exportVideoEl, 0, 0, canvas.width, canvas.height);
        const t = Math.max(0, clampedSec * 1000 + timeOffsetMs);
        const point = findPlaybackGazePoint(alignedFixationPoints, t);
        if (point) {
          drawPlaybackGazeCursor({
            canvas,
            point,
            layout: {
              canvasCssWidth: canvas.width,
              canvasCssHeight: canvas.height,
              drawLeft: 0,
              drawTop: 0,
              drawWidth: canvas.width,
              drawHeight: canvas.height,
              devicePixelRatio: 1
            },
            style: detailProps.style,
            radius: detailProps.radius,
            opacity: detailProps.opacity,
            color: detailProps.color,
            clearCanvas: false
          });
        }

        const rawProgress = Math.max(0, Math.min(1, clampedSec / exportDuration));
        const now = Date.now();
        if (rawProgress >= 1 || now - lastProgressReportAt > 120) {
          lastProgressReportAt = now;
          reportStatus({
            phase: 'rendering',
            progress: rawProgress * 0.9,
            label: `正在渲染帧 ${Math.round(rawProgress * 100)}%`,
          });
        }

        if (exportVideoEl.paused || exportVideoEl.ended || clampedSec >= duration) {
          stopRecording();
          return;
        }

        rafId = window.requestAnimationFrame(draw);
      };
      rafId = window.requestAnimationFrame(draw);
    } catch (err) {
      console.error(err);
      detachExportVideo?.();
      const message = err instanceof Error ? err.message : '未知错误';
      reportStatus({ phase: 'failed', progress: 1, label: `导出失败：${message}` });
      if (isMountedRef.current) {
        setIsExporting(false);
        setExportProgressPercent(0);
      }
      window.alert(`导出失败：${message}`);
    }
  };

  React.useEffect(() => {
    emitVideoDebug('video-source-selected', {
      detailVideoUrl: detailVideoUrl || null,
      repairedVideoUrl: repairedVideoUrl || null,
      recordMp4Url: record.mp4Url || null,
      effectiveVideoUrl: videoUrl || null,
      hasVideo,
    });
  }, [detailVideoUrl, emitVideoDebug, hasVideo, record.mp4Url, repairedVideoUrl, videoUrl]);

  React.useEffect(() => {
    if (!ipcClient.isAvailable()) return;
    void ipcClient
      .getVideoDebugLogPath()
      .then((res) => {
        if (res?.ok && res.logFilePath) {
          emitVideoDebug('video-debug-log-path', {
            logFilePath: res.logFilePath,
          });
        }
      })
      .catch(() => {
      });
  }, [emitVideoDebug]);

  return (
    <div className="h-full flex gap-3 overflow-hidden">
      <div className="flex-1 flex flex-col bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        <div ref={videoWrapRef} className="flex-1 bg-black relative flex items-center justify-center min-h-0">
          {videoUrl ? (
            <video
              key={videoUrl || record.id}
              ref={playback.attachVideo}
              src={videoUrl}
              onLoadedMetadata={(e) => {
                try {
                  const el = e.currentTarget;
                  ffmpegMissingByPathRef.current[getRepairKey()] = false;
                  setVideoLoadAlert(null);
                  metadataTimeoutCountByPathRef.current[getRepairKey()] = 0;
                  stopUrlResolveRetry();
                  console.log('[renderer] video loaded metadata', {
                    src: el.currentSrc,
                    duration: el.duration,
                    videoWidth: el.videoWidth,
                    videoHeight: el.videoHeight,
                  });
                  emitVideoDebug('video-loaded-metadata', {
                    src: el.currentSrc || null,
                    duration: Number.isFinite(el.duration) ? el.duration : null,
                    videoWidth: el.videoWidth || null,
                    videoHeight: el.videoHeight || null,
                    readyState: el.readyState,
                    networkState: el.networkState,
                  });
                } catch {
                }
              }}
              onCanPlay={(e) => {
                try {
                  const el = e.currentTarget;
                  ffmpegMissingByPathRef.current[getRepairKey()] = false;
                  setVideoLoadAlert(null);
                  metadataTimeoutCountByPathRef.current[getRepairKey()] = 0;
                  stopUrlResolveRetry();
                  console.log('[renderer] video can play', {
                    src: el.currentSrc,
                  });
                  emitVideoDebug('video-can-play', {
                    src: el.currentSrc || null,
                    duration: Number.isFinite(el.duration) ? el.duration : null,
                    readyState: el.readyState,
                    networkState: el.networkState,
                  });
                } catch {
                }
              }}
              onLoadedData={(e) => {
                try {
                  const el = e.currentTarget;
                  emitVideoDebug('video-loaded-data', {
                    src: el.currentSrc || null,
                    readyState: el.readyState,
                    networkState: el.networkState,
                    currentTime: Number.isFinite(el.currentTime) ? el.currentTime : null,
                    duration: Number.isFinite(el.duration) ? el.duration : null,
                  });
                } catch {
                }
              }}
              onWaiting={(e) => {
                try {
                  const el = e.currentTarget;
                  emitVideoDebug('video-waiting', {
                    src: el.currentSrc || null,
                    readyState: el.readyState,
                    networkState: el.networkState,
                    currentTime: Number.isFinite(el.currentTime) ? el.currentTime : null,
                    duration: Number.isFinite(el.duration) ? el.duration : null,
                  });
                } catch {
                }
              }}
              onStalled={(e) => {
                try {
                  const el = e.currentTarget;
                  emitVideoDebug('video-stalled', {
                    src: el.currentSrc || null,
                    readyState: el.readyState,
                    networkState: el.networkState,
                    currentTime: Number.isFinite(el.currentTime) ? el.currentTime : null,
                    duration: Number.isFinite(el.duration) ? el.duration : null,
                  });
                } catch {
                }
              }}
              onSuspend={(e) => {
                try {
                  const el = e.currentTarget;
                  emitVideoDebug('video-suspend', {
                    src: el.currentSrc || null,
                    readyState: el.readyState,
                    networkState: el.networkState,
                    currentTime: Number.isFinite(el.currentTime) ? el.currentTime : null,
                    duration: Number.isFinite(el.duration) ? el.duration : null,
                  });
                } catch {
                }
              }}
              onEmptied={(e) => {
                try {
                  const el = e.currentTarget;
                  emitVideoDebug('video-emptied', {
                    src: el.currentSrc || null,
                    readyState: el.readyState,
                    networkState: el.networkState,
                    currentTime: Number.isFinite(el.currentTime) ? el.currentTime : null,
                    duration: Number.isFinite(el.duration) ? el.duration : null,
                  });
                } catch {
                }
              }}
              onError={(e) => {
                try {
                  const el: HTMLVideoElement = e.currentTarget as HTMLVideoElement;
                  const err = el.error;
                  console.log('[renderer] video error', {
                    src: el.currentSrc,
                    errorCode: err ? err.code : null,
                    errorMessage: err ? err.message : null,
                  });
                  emitVideoDebug('video-error', {
                    src: el.currentSrc || null,
                    errorCode: err ? err.code : null,
                    errorMessage: err ? err.message : null,
                    readyState: el.readyState,
                    networkState: el.networkState,
                    currentTime: Number.isFinite(el.currentTime) ? el.currentTime : null,
                    duration: Number.isFinite(el.duration) ? el.duration : null,
                    videoWidth: el.videoWidth || null,
                    videoHeight: el.videoHeight || null,
                  });
                  const repairKey = getRepairKey();
                  if (ffmpegMissingByPathRef.current[repairKey]) {
                    emitVideoDebug('video-error-skip-retry-ffmpeg-missing', {
                      repairKey,
                    });
                    return;
                  }
                  const errorCode = err ? err.code : null;
                  const repaired = errorCode === 4 ? triggerVideoRepair('media-error-code-4') : false;
                  if (!repaired) {
                    startUrlResolveRetry();
                  }
                } catch {
                }
              }}
              className="w-full h-full object-contain bg-black"
            />
          ) : (
            <div className="text-slate-200 text-sm">当前记录没有可用视频文件</div>
          )}
          <canvas ref={overlayCanvasRef} className="absolute inset-0 pointer-events-none" />
          {videoLoadAlert && (
            <div className="absolute left-3 right-3 bottom-3 rounded-md bg-rose-500/90 text-white text-xs px-3 py-2 shadow">
              {videoLoadAlert}
            </div>
          )}
        </div>

        <div className="border-t border-slate-200 bg-white px-4 py-3 text-[10px] text-slate-500 flex flex-col gap-3">
          <RecordPlaybackTimeline
            durationSeconds={duration}
            currentTimeSeconds={visualCurrentTime}
            ready={media.readyState >= 1}
            markers={timelineMarkerPoints}
            onSeek={seekTo}
          />

          <div className="flex items-center justify-between">
            <div className="flex-1 flex items-center justify-start">
              <button
                onClick={handleExport}
                disabled={isExporting || !hasVideo}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[10px] font-medium transition-colors ${
                  hasVideo && !isExporting
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
                <span>{isExporting ? `导出中 ${exportProgressPercent}%` : '导出视频'}</span>
              </button>
            </div>
            <div className="flex items-center justify-center gap-3">
              <button
                disabled={!hasVideo}
                onClick={() => seekTo(0)}
                className={`w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center shadow-sm ${
                  hasVideo ? 'text-slate-600 hover:bg-slate-50' : 'text-slate-300'
                }`}
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
                onClick={() => seekTo(duration || 0)}
                className={`w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center shadow-sm ${
                  hasVideo ? 'text-slate-600 hover:bg-slate-50' : 'text-slate-300'
                }`}
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
      </div>

      <Modal
        isOpen={Boolean(exportPreviewUrl)}
        onClose={() => setExportPreviewUrl(null)}
        title="导出回放"
        maxWidthClassName="max-w-4xl"
      >
        {exportPreviewUrl ? (
          <div className="space-y-3">
            <div className="text-xs text-slate-500">导出文件已生成，可直接回放检查流畅度。</div>
            <video
              src={exportPreviewUrl}
              controls
              preload="metadata"
              className="w-full rounded-lg border border-slate-200 bg-black"
            />
          </div>
        ) : null}
      </Modal>

      <div className="w-[300px] bg-white rounded-xl border border-slate-200 flex flex-col overflow-hidden shadow-sm">
        <div className="p-3 border-b border-slate-100 bg-slate-50/50 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={onBackToList}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-[11px] font-bold text-slate-600 hover:bg-slate-50 hover:text-sky-600 transition-colors whitespace-nowrap"
            >
              <ArrowLeft size={13} />
              返回记录列表
            </button>
            <h3 className="text-xs font-bold text-slate-800 tracking-widest">属性面板</h3>
            
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          <div className="space-y-2.5">
            {[
              { label: '记录名称', value: getDisplayRecordName(record) },
              { label: '受试者信息', value: record.subjectName },
              { label: '录制时间', value: record.timestamp },
              { label: '视频文件', value: displayVideoPath },
            ].map((item) => (
              <div key={item.label} className="grid grid-cols-[100px_1fr] gap-2">
                <span className="text-[10px] font-bold text-slate-400 ">{item.label}</span>
                <span data-i18n-skip="true" className="text-[11px] text-slate-700 break-all">{item.value}</span>
              </div>
            ))}
          </div>

          <div className="space-y-4 pt-4 border-t border-slate-100">
            <div className="space-y-1.5">
              <label className="text-[10px] font-bold text-slate-400 ">样式</label>
              <CustomSelect
                value={detailProps.style}
                onChange={(e) => setDetailProps({ ...detailProps, style: e.target.value })}
                className="w-full pl-3 pr-10 py-1.5 bg-white border border-slate-200 rounded text-xs focus:ring-2 focus:ring-sky-500/10 outline-none appearance-none cursor-pointer"
              >
                <option>扩散圆</option>
                <option>十字架</option>
                <option>点状</option>
              </CustomSelect>
            </div>

            <div className="space-y-1.5">
              <div className="flex justify-between text-[10px] font-bold text-slate-400 ">
                <span>半径</span>
                <span className="text-slate-900">{detailProps.radius}</span>
              </div>
              <input
                type="range"
                min="1"
                max="50"
                value={detailProps.radius}
                onChange={(e) => setDetailProps({ ...detailProps, radius: parseInt(e.target.value) })}
                className="w-full h-1 bg-slate-100 accent-sky-500 appearance-none rounded-full cursor-pointer"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex justify-between text-[10px] font-bold text-slate-400 ">
                <span>透明度</span>
                <span className="text-slate-900">{detailProps.opacity.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={detailProps.opacity}
                onChange={(e) => setDetailProps({ ...detailProps, opacity: parseFloat(e.target.value) })}
                className="w-full h-1 bg-slate-100 accent-sky-500 appearance-none rounded-full cursor-pointer"
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] font-bold text-slate-400">颜色选择</span>
              <label className="relative cursor-pointer rounded p-1 focus-within:ring-2 focus-within:ring-sky-400 focus-within:ring-offset-1">
                <span
                  className="block h-5 w-5 rounded border border-slate-100 shadow-sm"
                  style={{ backgroundColor: detailProps.color }}
                />
                <input
                  type="color"
                  value={detailProps.color}
                  aria-label="打开颜色选择器"
                  onChange={(e) => setDetailProps({ ...detailProps, color: e.target.value })}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                />
              </label>
            </div>

            <div className="pt-2">
              <div className="aspect-square bg-white border border-slate-100 rounded flex items-center justify-center relative shadow-inner overflow-hidden">
                <canvas ref={previewCanvasRef} className="w-full h-full" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const RecordDetailPage: React.FC<RecordDetailPageProps> = (props) => {
  const record = props.records.find((item) => item.id === props.selectedRecordId) || props.records[0];
  if (!record) {
    return (
      <div className="h-full flex items-center justify-center bg-white rounded-2xl border border-slate-200 text-slate-400 text-sm">
        暂无记录，请先在录制模块生成数据
      </div>
    );
  }
  const { records: _records, ...contentProps } = props;
  return <RecordDetailPageContent key={record.id} {...contentProps} record={record} />;
};

export default RecordDetailPage;
