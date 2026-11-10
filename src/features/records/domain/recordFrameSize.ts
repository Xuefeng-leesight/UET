import type { RecordingRecord } from '@shared/contracts/domain/models';

export function getRecordingFrameSizeOptions(
  record?: Pick<RecordingRecord, 'videoWidth' | 'videoHeight'> | null,
): { frameWidth?: number; frameHeight?: number } {
  const videoWidth = Number(record?.videoWidth);
  const videoHeight = Number(record?.videoHeight);
  return {
    frameWidth: Number.isFinite(videoWidth) && videoWidth > 0 ? videoWidth : undefined,
    frameHeight: Number.isFinite(videoHeight) && videoHeight > 0 ? videoHeight : undefined,
  };
}
