import type { RecordingRecord } from '@shared/contracts/domain/models';

export const FINALIZATION_IDLE_RECOVERY_ATTEMPTS = 3;
export const FINALIZATION_IDLE_FAILURE_ATTEMPTS = 15;

function normalizePath(value: string | null | undefined): string {
  return String(value || '').trim().replace(/\\/g, '/').toLocaleLowerCase();
}

function pathStem(value: string | null | undefined): string {
  const normalized = normalizePath(value);
  const fileName = normalized.split('/').pop() || '';
  return fileName.replace(/\.[^.]+$/u, '');
}

export function findFinalizedRecordingOnDisk(
  records: RecordingRecord[],
  expectedRecordingId: string | null | undefined,
  expectedVideoPath: string | null | undefined,
): RecordingRecord | null {
  const normalizedId = String(expectedRecordingId || '').trim().toLocaleLowerCase();
  const normalizedVideoPath = normalizePath(expectedVideoPath);
  const expectedStem = pathStem(expectedVideoPath) || normalizedId;
  if (!normalizedId && !normalizedVideoPath && !expectedStem) return null;

  return records.find((record) => {
    if (!record.mp4Path || !record.csvPath) return false;
    const recordName = String(record.name || '').trim().toLocaleLowerCase();
    const recordVideoPath = normalizePath(record.mp4Path);
    const recordStem = pathStem(record.mp4Path);
    return Boolean(
      (normalizedId && (recordName === normalizedId || recordStem === normalizedId))
      || (normalizedVideoPath && recordVideoPath === normalizedVideoPath)
      || (expectedStem && (recordName === expectedStem || recordStem === expectedStem)),
    );
  }) || null;
}
