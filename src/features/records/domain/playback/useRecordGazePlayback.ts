import React from 'react';
import type { RecordingRecord } from '@shared/contracts/domain/models';
import { recordDataService } from '@/features/records/RecordDataService';
import type { HeatmapPoint } from '@/shared/types/mrt';
import { buildPlaybackGazeRequestKey, getPlaybackGazeWindow } from '@/features/records/domain/playback/playbackGazeModel';

const MAX_WINDOW_POINTS = 2_000;
const LOAD_TIMEOUT_MS = 600_000;

type DebugEmitter = (event: string, details?: Record<string, unknown>) => void;

const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timerId: number | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timerId = window.setTimeout(() => reject(new Error(`load record gaze timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timerId !== null) window.clearTimeout(timerId);
  }
};

export const useRecordGazePlayback = (params: {
  record: RecordingRecord;
  pointSource: 'recommended' | 'raw' | 'smooth';
  currentTimeSeconds: number;
  frameWidth: number;
  frameHeight: number;
  frameSizeSource: 'media' | 'record' | 'pending';
  emitDebug?: DebugEmitter;
}) => {
  const {
    record,
    pointSource,
    currentTimeSeconds,
    frameWidth,
    frameHeight,
    frameSizeSource,
    emitDebug,
  } = params;
  const [points, setPoints] = React.useState<HeatmapPoint[]>([]);
  const requestSequenceRef = React.useRef(0);
  const loadedKeyRef = React.useRef('');
  const emitDebugRef = React.useRef(emitDebug);
  emitDebugRef.current = emitDebug;

  const windowRange = React.useMemo(
    () => getPlaybackGazeWindow(currentTimeSeconds * 1000),
    [currentTimeSeconds],
  );

  React.useEffect(() => {
    const csvPath = record.csvPath;
    if (!csvPath || frameWidth <= 0 || frameHeight <= 0) {
      requestSequenceRef.current += 1;
      loadedKeyRef.current = '';
      setPoints([]);
      emitDebugRef.current?.('gaze-window-waiting-for-frame-size', {
        csvPath: csvPath || null,
        frameWidth,
        frameHeight,
        frameSizeSource,
      });
      return;
    }

    const requestKey = buildPlaybackGazeRequestKey({
      recordId: record.id,
      csvPath,
      pointSource,
      deviceSpace: record.deviceType === '眼镜式' ? 'glasses' : 'desktop',
      frameWidth,
      frameHeight,
      startTimeMs: windowRange.startTimeMs,
      endTimeMs: windowRange.endTimeMs,
    });
    if (loadedKeyRef.current === requestKey) return;
    loadedKeyRef.current = requestKey;
    const requestSequence = ++requestSequenceRef.current;
    setPoints([]);
    emitDebugRef.current?.('gaze-window-load-start', {
      requestSequence,
      csvPath,
      pointSource,
      frameWidth,
      frameHeight,
      frameSizeSource,
      ...windowRange,
    });

    void withTimeout(recordDataService.loadPoints({
      csvPath,
      includeMarkerOnlyRows: true,
      pointMode: 'gaze',
      pointSource,
      isGlassesMode: record.deviceType === '眼镜式',
      maxPoints: MAX_WINDOW_POINTS,
      startTimeMs: windowRange.startTimeMs,
      endTimeMs: windowRange.endTimeMs,
      frameWidth,
      frameHeight,
    }), LOAD_TIMEOUT_MS).then((result) => {
      if (requestSequenceRef.current !== requestSequence) return;
      if (!result.ok || !Array.isArray(result.points)) {
        setPoints([]);
        emitDebugRef.current?.('gaze-window-load-failed', { requestSequence });
        return;
      }
      const nextPoints = [...result.points as HeatmapPoint[]]
        .sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));
      setPoints(nextPoints);
      emitDebugRef.current?.('gaze-window-load-success', {
        requestSequence,
        pointCount: nextPoints.length,
        firstPoint: nextPoints[0]
          ? { x: nextPoints[0].x, y: nextPoints[0].y, timestamp: nextPoints[0].timestamp || null }
          : null,
        lastPoint: nextPoints.length > 0
          ? {
              x: nextPoints[nextPoints.length - 1].x,
              y: nextPoints[nextPoints.length - 1].y,
              timestamp: nextPoints[nextPoints.length - 1].timestamp || null,
            }
          : null,
      });
    }).catch((error) => {
      if (requestSequenceRef.current !== requestSequence) return;
      setPoints([]);
      emitDebugRef.current?.('gaze-window-load-exception', {
        requestSequence,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, [
    frameHeight,
    frameSizeSource,
    frameWidth,
    pointSource,
    record.csvPath,
    record.deviceType,
    record.id,
    windowRange.endTimeMs,
    windowRange.startTimeMs,
  ]);

  return points;
};
