import {
  ipcClient,
  type LoadRecordPointsResult,
} from '@/infrastructure/electron/ipcClient';

export type RecordPointsRequest = Parameters<typeof ipcClient.loadRecordPoints>[0];

const MAX_CACHED_REQUESTS = 4;

class RecordDataService {
  private readonly inFlight = new Map<string, Promise<LoadRecordPointsResult>>();
  private readonly cache = new Map<string, LoadRecordPointsResult>();

  private makeKey(request: RecordPointsRequest): string {
    return JSON.stringify({
      csvPath: request.csvPath,
      pointMode: request.pointMode || 'auto',
      pointSource: request.pointSource || 'smooth',
      includeSdkSaccades: request.includeSdkSaccades === true,
      includePupilSamples: request.includePupilSamples === true,
      includeMarkerOnlyRows: request.includeMarkerOnlyRows === true,
      isGlassesMode: request.isGlassesMode === true,
      frameWidth: request.frameWidth || 0,
      frameHeight: request.frameHeight || 0,
      maxPoints: request.maxPoints || 0,
      startTimeMs: request.startTimeMs ?? null,
      endTimeMs: request.endTimeMs ?? null,
      aggregateForHeatmap: request.aggregateForHeatmap === true,
      viewportWidth: request.viewportWidth || 0,
      viewportHeight: request.viewportHeight || 0,
    });
  }

  async loadPoints(request: RecordPointsRequest): Promise<LoadRecordPointsResult> {
    const key = this.makeKey(request);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const running = this.inFlight.get(key);
    if (running) return running;

    const task = ipcClient.loadRecordPoints(request).then((result) => {
      if (result.ok) {
        this.cache.set(key, result);
        while (this.cache.size > MAX_CACHED_REQUESTS) {
          const oldestKey = this.cache.keys().next().value as string | undefined;
          if (!oldestKey) break;
          this.cache.delete(oldestKey);
        }
      }
      return result;
    }).finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, task);
    return task;
  }

  invalidateCsv(csvPath: string): void {
    for (const key of this.cache.keys()) {
      if (key.includes(JSON.stringify(csvPath))) this.cache.delete(key);
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

export const recordDataService = new RecordDataService();
