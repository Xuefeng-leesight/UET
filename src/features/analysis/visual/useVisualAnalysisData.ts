import { useEffect, useMemo, useState } from 'react';

import type { RecordingRecord } from '@shared/contracts/domain/models';
import type { HeatmapPoint } from '@/shared/types/mrt';
import type { GazeDisplayPath } from '@/features/recording/domain/gazeDisplayPath';
import { detailVideoUrlEffect } from '@/features/records/domain/detailVideoUrlEffect';
import { visualHeatmapEffect } from '@/features/analysis/visual/visualHeatmapEffect';

type UseVisualAnalysisDataParams = {
  activeTab: string;
  selectedRecordId: string | null;
  visibleRecordIds: Set<string>;
  projectDir: string | null;
  records: RecordingRecord[];
  pointSource: GazeDisplayPath;
};

function normalizeHeatmapPoint(point: HeatmapPoint): HeatmapPoint | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const weight = typeof point.weight === 'number' && Number.isFinite(point.weight) ? point.weight : 1;
  const timestamp = typeof point.timestamp === 'number' && Number.isFinite(point.timestamp) ? point.timestamp : undefined;
  const id = typeof point.id === 'number' && Number.isFinite(point.id) ? point.id : undefined;
  return {
    ...point,
    x: Math.max(0, Math.min(1, point.x)),
    y: Math.max(0, Math.min(1, point.y)),
    weight,
    timestamp,
    id,
  };
}

export function useVisualAnalysisData({
  activeTab,
  selectedRecordId,
  visibleRecordIds,
  projectDir,
  records,
  pointSource,
}: UseVisualAnalysisDataParams) {
  const [detailVideoUrl, setDetailVideoUrl] = useState<string | null>(null);
  const [heatmapPointsByRecord, setHeatmapPointsByRecord] = useState<Record<string, HeatmapPoint[]>>({});
  const [heatmapLoadingRecordId, setHeatmapLoadingRecordId] = useState<string | null>(null);
  const [heatmapError, setHeatmapError] = useState<string | null>(null);

  const currentHeatmapPoints = useMemo(() => {
    const points: HeatmapPoint[] = [];
    for (const id of visibleRecordIds) {
      for (const point of heatmapPointsByRecord[id] || []) {
        const normalized = normalizeHeatmapPoint(point);
        if (normalized) points.push(normalized);
      }
    }
    return points;
  }, [visibleRecordIds, heatmapPointsByRecord]);

  useEffect(() => {
    setHeatmapPointsByRecord((previous) => {
      const next: Record<string, HeatmapPoint[]> = {};
      for (const id of visibleRecordIds) {
        if (Object.prototype.hasOwnProperty.call(previous, id)) next[id] = previous[id] || [];
      }
      return Object.keys(previous).length === Object.keys(next).length ? previous : next;
    });
  }, [visibleRecordIds]);

  useEffect(() => {
    detailVideoUrlEffect({ selectedRecordId, projectDir, records, setDetailVideoUrl });
  }, [selectedRecordId, projectDir, records]);

  useEffect(() => visualHeatmapEffect({
    activeTab,
    visibleRecordIds,
    selectedRecordId,
    heatmapPointsByRecord,
    records,
    setHeatmapLoadingRecordId,
    setHeatmapError,
    setHeatmapPointsByRecord,
    pointSource,
  }), [activeTab, visibleRecordIds, selectedRecordId, records, heatmapPointsByRecord, pointSource]);

  return {
    detailVideoUrl,
    heatmapPointsByRecord,
    setHeatmapPointsByRecord,
    heatmapLoadingRecordId,
    heatmapError,
    currentHeatmapPoints,
  };
}
