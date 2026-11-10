import type { RecordingRecord } from '../contracts/domain/models';

/** A read-only analysis source, separate from experiment materials and user segments. */
export interface RecordingVideoStimulus {
  id: string;
  name: string;
  stimulusType: 'video';
  startTime: number;
  endTime: number;
}

/**
 * Every glasses adapter uses its complete recording video as the analysis
 * stimulus. Times are seconds on the video timeline, independent of gaze
 * validity, CSV stimulus labels, presentation materials and user selections.
 * Only pass a loaded media duration when it belongs to this record's video.
 */
export function resolveRecordingVideoStimulus(
  record: RecordingRecord | null | undefined,
  videoDuration?: number,
): RecordingVideoStimulus | null {
  if (!record || record.deviceType !== '眼镜式' || !record.id.trim()) return null;
  if (record.modalities && Object.keys(record.modalities).length > 0 && !record.modalities['eye-tracking']) return null;
  if (!record.mp4Path?.trim() && !record.mp4Url?.trim()) return null;

  const positiveDuration = (value: number | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;
  const duration = positiveDuration(videoDuration) ? videoDuration : record.durationSeconds;
  if (!positiveDuration(duration)) return null;

  return {
    // Existing glasses AOIs are already persisted in this record scope.
    id: `record:${record.id}`,
    name: record.name.trim() || record.id,
    stimulusType: 'video',
    startTime: 0,
    endTime: duration,
  };
}
