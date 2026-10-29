import type { ModalityId, RecordingRecord } from '@shared/contracts/domain/models';
import { normalizeTimelineMarkers, normalizeTimeSegments } from '@shared/domain/timeline';
import { parseRecordingCalibrationScores } from '@shared/domain/calibrationScores';

type RecordingMarker = NonNullable<RecordingRecord['markers']>[number];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeMarkers(value: unknown): RecordingRecord['markers'] {
  if (!Array.isArray(value)) return undefined;
  const markers: RecordingMarker[] = [];
  for (const item of value) {
    const marker = asRecord(item);
    if (marker.type !== 'custom' && marker.type !== 'trigger') continue;
    const timestamp = optionalFiniteNumber(marker.timestamp);
    const videoTime = optionalFiniteNumber(marker.videoTime);
    if (timestamp === undefined || videoTime === undefined) continue;
    markers.push({
      type: marker.type,
      name: optionalString(marker.name),
      triggerValue: optionalFiniteNumber(marker.triggerValue),
      timestamp,
      videoTime,
    });
  }
  return markers;
}

function normalizeRecordModalities(value: unknown): RecordingRecord['modalities'] {
  const source = asRecord(value);
  const result: RecordingRecord['modalities'] = {};
  (['eye-tracking', 'facial-expression'] as ModalityId[]).forEach((id) => {
    const item = asRecord(source[id]);
    if (!['complete', 'partial', 'failed'].includes(String(item.status))) return;
    result[id] = {
      status: item.status as 'complete' | 'partial' | 'failed',
      sourcePath: optionalString(item.sourcePath),
      dataPath: optionalString(item.dataPath),
      analysisPath: optionalString(item.analysisPath),
      message: optionalString(item.message),
    };
  });
  return Object.keys(result).length > 0 ? result : undefined;
}

export function mapLoadedRecordings(records: unknown): RecordingRecord[] {
  if (!Array.isArray(records)) return [];
  return records.map((item, index) => {
    const record = asRecord(item);
    return {
      id: optionalString(record.id) ?? `rec_${index}`,
      name: optionalString(record.name) ?? `记录_${index + 1}`,
      subjectName: optionalString(record.subjectName) ?? '',
      timestamp: optionalString(record.timestamp) ?? '',
      duration: optionalString(record.duration) ?? '',
      fps: optionalString(record.fps) ?? '',
      calibrationLeftScore: optionalFiniteNumber(record.calibrationLeftScore),
      calibrationRightScore: optionalFiniteNumber(record.calibrationRightScore),
      calibrationScores: parseRecordingCalibrationScores(record, optionalString(record.deviceModel)) ?? undefined,
      country: optionalString(record.country),
      deviceType: record.deviceType === '眼镜式' || record.deviceType === '桌面式' ? record.deviceType : undefined,
      deviceModel: record.deviceModel === 'A8' || record.deviceModel === 'Pro' || record.deviceModel === 'aSeeGlassesPlus' || record.deviceModel === 'PupilCore' || record.deviceModel === 'HH_ET10C' || record.deviceModel === 'HH_ET28'
        ? record.deviceModel
        : undefined,
      samplingRateHz: optionalFiniteNumber(record.samplingRateHz),
      configuredSamplingRateHz: optionalFiniteNumber(record.configuredSamplingRateHz),
      validityPercent: optionalFiniteNumber(record.validityPercent),
      durationSeconds: optionalFiniteNumber(record.durationSeconds),
      videoWidth: optionalFiniteNumber(record.videoWidth),
      videoHeight: optionalFiniteNumber(record.videoHeight),
      mp4Path: optionalString(record.mp4Path),
      mp4Url: optionalString(record.mp4Url),
      csvPath: optionalString(record.csvPath),
      markers: normalizeMarkers(record.markers),
      timelineMarkers: normalizeTimelineMarkers(record.timelineMarkers ?? []),
      timelineSegments: normalizeTimeSegments(record.timelineSegments ?? []),
      modalities: normalizeRecordModalities(record.modalities),
    };
  });
}
