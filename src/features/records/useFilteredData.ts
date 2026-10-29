import React from 'react';
import type { TimeSegment } from '@shared/domain/timeline';
import type { HeatmapPoint } from '@/shared/types/mrt';

export const pointInSegment = (point: HeatmapPoint, segment: TimeSegment | null): boolean => {
  if (!segment) return true;
  if (segment.enabled === false) return false;
  const ts = typeof point.timestamp === 'number' && Number.isFinite(point.timestamp) ? point.timestamp : NaN;
  if (!Number.isFinite(ts)) return false;
  const tSec = ts / 1000;
  return tSec >= segment.startTime && tSec <= segment.endTime;
};

export const filterBySegment = (points: HeatmapPoint[], segment: TimeSegment | null): HeatmapPoint[] => {
  if (!segment) return points;
  return points.filter((point) => pointInSegment(point, segment));
};

export const pointInSegments = (point: HeatmapPoint, segments: TimeSegment[]): boolean => {
  if (!segments || segments.length === 0) return true;
  return segments.some((segment) => segment.enabled !== false && pointInSegment(point, segment));
};

export const filterBySegments = (points: HeatmapPoint[], segments: TimeSegment[]): HeatmapPoint[] => {
  if (!segments || segments.length === 0) return points;
  return points.filter((point) => pointInSegments(point, segments));
};

export const useFilteredData = (points: HeatmapPoint[], segment: TimeSegment | null): HeatmapPoint[] => {
  return React.useMemo(() => filterBySegment(points, segment), [points, segment]);
};
