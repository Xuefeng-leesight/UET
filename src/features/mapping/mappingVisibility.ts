// Mapping has already applied its feature-matching checks. Additional display
// filtering is opt-in and never changes the saved coordinates or confidence.
export const DEFAULT_MAPPING_CONFIDENCE_THRESHOLD = 0;

type MappingConfidencePoint = { confidence: number; deleted?: boolean };

export function isMappingPointVisible(point: MappingConfidencePoint, thresholdPercent: number): boolean {
  return point.deleted !== true && Number.isFinite(point.confidence)
    && point.confidence >= 0 && point.confidence <= 1 && point.confidence * 100 >= thresholdPercent;
}

export function mappingVisibilityMessage(points: MappingConfidencePoint[], thresholdPercent: number, isEn: boolean): string {
  const total = points.filter((point) => point.deleted !== true).length;
  const visible = points.filter((point) => isMappingPointVisible(point, thresholdPercent)).length;
  const counts = isEn
    ? `${visible}/${total} mapped points visible at ${thresholdPercent}% confidence.`
    : `筛选后可见 ${visible}/${total} 个映射点（阈值 ${thresholdPercent}%）。`;
  return total > 0 && visible === 0
    ? `${counts} ${isEn ? 'All points are hidden; lower the confidence threshold.' : '全部映射点已被隐藏，请降低置信度阈值。'}`
    : counts;
}
