import type { GazeMappingResultData } from '@/infrastructure/electron/ipcClient';
import type { HeatmapPoint } from '@/shared/types/mrt';

export type MappingRecordEntry = {
  outputPath: string;
  result: GazeMappingResultData;
};

export function adaptMappingResultToHeatmapPoints(
  result: GazeMappingResultData,
): HeatmapPoint[] {
  const width = Number(result.resolution?.width);
  const height = Number(result.resolution?.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return [];

  return result.gazeData
    .map<HeatmapPoint | null>((point, index) => {
      const x = Number(point.x) / width;
      const y = Number(point.y) / height;
      const timestamp = Number(point.timestampMs);
      if (
        !Number.isFinite(x) || x < 0 || x > 1 ||
        !Number.isFinite(y) || y < 0 || y > 1 ||
        !Number.isFinite(timestamp) || timestamp < 0
      ) return null;

      const duration = Number(point.durationMs ?? point.weight);
      const numericSourceId = Number(point.sourceId);
      return {
        id: Number.isFinite(numericSourceId) ? numericSourceId : index,
        x,
        y,
        timestamp,
        weight: Number.isFinite(duration) && duration > 0 ? duration : 1,
        fixationDurationMs: Number.isFinite(duration) && duration > 0 ? duration : undefined,
      } satisfies HeatmapPoint;
    })
    .filter((point): point is HeatmapPoint => point !== null)
    .sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0));
}
