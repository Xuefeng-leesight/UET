import { ipcClient } from '@/infrastructure/electron/ipcClient';
import type { HeatmapPoint } from '@/shared/types/mrt';
import type { GazeDisplayPath } from '@/features/recording/domain/gazeDisplayPath';
import { getRecordingFrameSizeOptions } from '@/features/records/domain/recordFrameSize';
import { HEATMAP_POINT_PARSE_VERSION } from '@/features/analysis/visual/heatmapRendering';
import { recordDataService } from '@/features/records/RecordDataService';
import type { RecordingRecord } from '@shared/contracts/domain/models';

const currentEmptyResultKeys = new Set<string>();
let visualLoadRunSeq = 0;

// All devices use the same completed events as mapping and AOI. The main
// process derives missing events without changing the original recording.
const pointMode = 'fixation' as const;

const makeEmptyResultKey = (
  recordId: string,
  record: { csvPath?: string | null } | undefined,
  pointSource: GazeDisplayPath,
  pointMode: 'fixation',
): string => `${recordId}|${record?.csvPath || 'no-csv'}|${pointMode}|${pointSource}|v${HEATMAP_POINT_PARSE_VERSION}`;

const hasCurrentRenderablePoints = (points: HeatmapPoint[]): boolean =>
  points.some(
    (point) =>
      point.parseVersion === HEATMAP_POINT_PARSE_VERSION &&
      !point.markerOnly &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y),
  );

const summarizePointsForDebug = (points: HeatmapPoint[]) => {
  let renderable = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minTs = Infinity;
  let maxTs = -Infinity;
  const versions = new Set<number>();
  for (const point of points) {
    if (typeof point.parseVersion === 'number') versions.add(point.parseVersion);
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
    versions: Array.from(versions).sort((a, b) => a - b),
    xRange: renderable > 0 ? [Number(minX.toFixed(4)), Number(maxX.toFixed(4))] : null,
    yRange: renderable > 0 ? [Number(minY.toFixed(4)), Number(maxY.toFixed(4))] : null,
    timestampRange: Number.isFinite(minTs) && Number.isFinite(maxTs) ? [Math.round(minTs), Math.round(maxTs)] : null,
    sample: points
      .filter((point) => !point.markerOnly && Number.isFinite(point.x) && Number.isFinite(point.y))
      .slice(0, 3)
      .map((point) => ({
        x: Number(Number(point.x).toFixed(4)),
        y: Number(Number(point.y).toFixed(4)),
        ts: typeof point.timestamp === 'number' && Number.isFinite(point.timestamp) ? Math.round(point.timestamp) : null,
        version: point.parseVersion ?? null,
      })),
  };
};

const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timerId: number | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timerId = window.setTimeout(() => {
          reject(new Error(`${label} timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timerId !== null) window.clearTimeout(timerId);
  }
};

export function visualHeatmapEffect(params: {
  activeTab: string;
  visibleRecordIds: Set<string>;
  selectedRecordId: string | null;
  heatmapPointsByRecord: Record<string, HeatmapPoint[] | undefined>;
  records: RecordingRecord[];
  setHeatmapLoadingRecordId: (id: string | null) => void;
  setHeatmapError: (updater: (prev: string | null) => string | null) => void;
  setHeatmapPointsByRecord: (updater: (prev: Record<string, HeatmapPoint[]>) => Record<string, HeatmapPoint[]>) => void;
  pointSource?: GazeDisplayPath;
}): (() => void) | void {
  const {
    activeTab,
    visibleRecordIds,
    selectedRecordId,
    heatmapPointsByRecord,
    records,
    setHeatmapLoadingRecordId,
    setHeatmapError,
    setHeatmapPointsByRecord,
    pointSource = 'smooth',
  } = params;

  if (activeTab !== 'visual') {
    return;
  }

  const runId = visualLoadRunSeq + 1;
  const targetIds = new Set<string>(Array.from(visibleRecordIds) as string[]);
  if (selectedRecordId) {
    targetIds.add(selectedRecordId);
  }
  const idsToLoad = Array.from(targetIds).filter((id) => {
    const record = records.find((r) => r.id === id);
    const emptyResultKey = makeEmptyResultKey(id, record, pointSource, pointMode);
    const cached = heatmapPointsByRecord[id];
    if (typeof cached === 'undefined') return true;
    if (!Array.isArray(cached)) return true;
    if (cached.length === 0) {
      return !currentEmptyResultKeys.has(emptyResultKey);
    }
    if (!cached.some((p) => p.parseVersion === HEATMAP_POINT_PARSE_VERSION)) {
      return true;
    }
    if (!cached.some((p) => p.gazeDisplayPath === pointSource)) {
      return true;
    }
    if (!cached.some((p) => p.visualPointMode === pointMode)) return true;
    if (!hasCurrentRenderablePoints(cached)) {
      return !currentEmptyResultKeys.has(emptyResultKey);
    }
    return false;
  });
  const loadEvaluateDebug = {
    runId,
    activeTab,
    selectedRecordId,
    targetIds: Array.from(targetIds),
    idsToLoad,
    cacheKeys: Object.keys(heatmapPointsByRecord),
    cache: Array.from(targetIds).map((id) => {
      const record = records.find((r) => r.id === id);
      const cached = heatmapPointsByRecord[id];
      const emptyResultKey = makeEmptyResultKey(id, record, pointSource, pointMode);
      return {
        id,
        recordName: record?.name || null,
        deviceType: record?.deviceType || null,
        csvPath: record?.csvPath || null,
        state: typeof cached === 'undefined' ? 'missing' : Array.isArray(cached) ? 'array' : typeof cached,
        summary: Array.isArray(cached) ? summarizePointsForDebug(cached) : null,
        emptyResultKey,
        knownEmptyCurrentResult: currentEmptyResultKeys.has(emptyResultKey),
      };
    }),
  };
  console.log('[VisualDebug] load-evaluate', loadEvaluateDebug);
  console.log('[VisualDebug] load-evaluate-json', JSON.stringify(loadEvaluateDebug));
  if (idsToLoad.length === 0) {
    setHeatmapLoadingRecordId(null);
    return;
  }
  if (!ipcClient.isAvailable()) {
    console.warn('[VisualDebug] ipc-unavailable', { runId, idsToLoad });
    setHeatmapLoadingRecordId(null);
    return;
  }

  visualLoadRunSeq = runId;
  let cancelled = false;
  setHeatmapLoadingRecordId(idsToLoad[0] || 'loading');
  setHeatmapError(() => null);
  console.log('[VisualDebug] load-start', { runId, idsToLoad });

  const loadDataForRecord = async (recordId: string) => {
    const record = records.find((r) => r.id === recordId);
    if (!record) {
      console.warn('[VisualDebug] record-not-found', { runId, recordId });
      return null;
    }

    const csvPath = record.csvPath;
    const frameSize = getRecordingFrameSizeOptions(record);
    console.log('[VisualDebug] record-load-start', {
      runId,
      recordId,
      recordName: record.name,
      deviceType: record.deviceType || null,
      frameSize,
      csvPath,
    });

    try {
      if (csvPath) {
        const res = await withTimeout(
          recordDataService.loadPoints({
            csvPath,
            includeMarkerOnlyRows: true,
            pointMode,
            pointSource,
            isGlassesMode: record.deviceType === '眼镜式',
            // These points also drive numbered scanpaths and video export:
            // spatial heatmap bins would merge visits and destroy their order.
            maxPoints: 250_000,
            ...frameSize,
          }),
          600000,
          `loadRecordPoints ${record.name || recordId}`,
        );
        if (res && res.ok && Array.isArray(res.points)) {
          const points = (res.points as HeatmapPoint[]).map((point) => ({
            ...point,
            gazeDisplayPath: pointSource,
            visualPointMode: pointMode,
          }));
          const csvParsedDebug = {
            runId,
            recordId,
            recordName: record.name,
            fileSizeBytes: res.fileSizeBytes,
            totalRows: res.totalRows,
            parsedPoints: res.parsedPoints,
            truncated: res.truncated,
            forcedGlassesMode: record.deviceType === '眼镜式',
            frameSize,
            summary: summarizePointsForDebug(points),
          };
          console.log('[VisualDebug] csv-parsed', csvParsedDebug);
          console.log('[VisualDebug] csv-parsed-json', JSON.stringify(csvParsedDebug));
          return points;
        } else {
          const msg = `[VisualDebug] CSV load failed: "${record.name}"`;
          console.warn('[VisualDebug] csv-load-failed', { runId, recordId, csvPath, res });
          setHeatmapError((prev) => prev ?? msg);
        }
      } else {
        const msg = `[VisualDebug] No CSV path found: "${record.name}"`;
        console.warn('[VisualDebug] no-csv-path', { runId, recordId, recordName: record.name });
        setHeatmapError((prev) => prev ?? msg);
      }
    } catch (err) {
      const msg = `[VisualDebug] Error loading data: "${record.name}"`;
      console.error('[VisualDebug] record-load-error', {
        runId,
        recordId,
        recordName: record.name,
        message: err instanceof Error ? err.message : String(err),
        err,
      });
      setHeatmapError((prev) => prev ?? msg);
    }
    return null;
  };

  (async () => {
    const newPoints: Record<string, HeatmapPoint[]> = {};

    for (const id of idsToLoad) {
      if (cancelled) break;
      setHeatmapLoadingRecordId(id);
      console.log('[VisualDebug] record-load-dispatch', { runId, recordId: id });
      const points = await loadDataForRecord(id);
      const record = records.find((r) => r.id === id);
      const emptyResultKey = makeEmptyResultKey(id, record, pointSource, pointMode);
      if (points) {
        newPoints[id] = points;
        if (hasCurrentRenderablePoints(points)) {
          currentEmptyResultKeys.delete(emptyResultKey);
        } else {
          currentEmptyResultKeys.add(emptyResultKey);
        }
      } else {
        newPoints[id] = [];
        currentEmptyResultKeys.add(emptyResultKey);
      }
    }

    if (cancelled) {
      console.log('[VisualDebug] load-cancelled-before-commit', { runId, idsToLoad });
      return;
    }

    if (Object.keys(newPoints).length > 0) {
      setHeatmapPointsByRecord((prev) => {
        const next = { ...prev };
        for (const id of idsToLoad) {
          delete next[id];
        }
        return {
          ...next,
          ...newPoints,
        };
      });
    }
    const loadCompleteDebug = {
      runId,
      idsToLoad,
      results: Object.fromEntries(Object.entries(newPoints).map(([id, points]) => [id, summarizePointsForDebug(points)])),
    };
    console.log('[VisualDebug] load-complete', loadCompleteDebug);
    console.log('[VisualDebug] load-complete-json', JSON.stringify(loadCompleteDebug));
    setHeatmapLoadingRecordId(null);
  })();

  return () => {
    cancelled = true;
    console.log('[VisualDebug] load-cleanup', { runId, idsToLoad });
    setHeatmapLoadingRecordId(null);
  };
}
