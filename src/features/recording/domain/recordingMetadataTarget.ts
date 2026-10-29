import type { RecordingRecord } from '@shared/contracts/domain/models';
import { normalizeRecordingPath } from './recordingLifecycle';

export type RecordingMetadataIdentity = {
  recordingId?: string | null;
  videoPath?: string | null;
  subjectName: string;
  startedAtMs: number;
};

/** UUID recordings have an end-time mtime, so only legacy replies without an
 * identity may use the historical start-time/subject lookup. */
export function findRecordingMetadataTarget(
  records: RecordingRecord[],
  pending: RecordingMetadataIdentity,
): RecordingRecord | null {
  const expectedId = String(pending.recordingId || '').trim();
  const expectedPath = normalizeRecordingPath(pending.videoPath);
  if (expectedId || expectedPath) {
    return records.find((record) => {
      const name = String(record.name || '').trim();
      const actualPath = normalizeRecordingPath(record.mp4Path);
      const idMatches = expectedId && (name === expectedId || record.id === expectedId);
      if (expectedId && !idMatches) return false;
      if (expectedPath && actualPath && expectedPath !== actualPath) return false;
      return Boolean(idMatches || (expectedPath && expectedPath === actualPath));
    }) || null;
  }

  if (!Number.isFinite(pending.startedAtMs)) return null;
  const minAcceptTs = pending.startedAtMs - 3_000;
  const maxAcceptTs = pending.startedAtMs + 15 * 60 * 1000;
  let bestSubjectMatch: { record: RecordingRecord; diff: number } | null = null;
  let bestAnyMatch: { record: RecordingRecord; diff: number } | null = null;
  for (const record of records) {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(record.timestamp || '').trim());
    if (!match) continue;
    const [, year, month, day, hour, minute, second] = match.map(Number);
    const timestamp = new Date(year, month - 1, day, hour, minute, second).getTime();
    if (!Number.isFinite(timestamp) || timestamp < minAcceptTs || timestamp > maxAcceptTs) continue;
    const diff = Math.abs(timestamp - pending.startedAtMs);
    if (!bestAnyMatch || diff < bestAnyMatch.diff) bestAnyMatch = { record, diff };
    if (String(record.subjectName || '') === String(pending.subjectName || '')
        && (!bestSubjectMatch || diff < bestSubjectMatch.diff)) {
      bestSubjectMatch = { record, diff };
    }
  }
  return (bestSubjectMatch || bestAnyMatch)?.record || null;
}
