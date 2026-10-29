import type { ModalityId, RecordingRecord } from '../contracts/domain/models';

export function recordHasModality(record: RecordingRecord, modalityId: ModalityId): boolean {
  const declaredModalities = record.modalities ? Object.keys(record.modalities) : [];
  if (declaredModalities.length > 0) return Boolean(record.modalities?.[modalityId]);

  // Records created before the multimodal schema are eye-tracking records.
  return modalityId === 'eye-tracking' && Boolean(record.csvPath);
}

export function filterRecordsByModality(records: RecordingRecord[], modalityId: ModalityId): RecordingRecord[] {
  return records.filter((record) => recordHasModality(record, modalityId));
}
