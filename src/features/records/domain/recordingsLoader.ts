import type React from 'react';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import { mapLoadedRecordings } from '@/features/records/domain/recordingsMapping';
import type { RecordingRecord } from '@shared/contracts/domain/models';

export async function loadRecordsForProject(params: {
  projectDir: string;
  setRecords: React.Dispatch<React.SetStateAction<RecordingRecord[]>>;
}): Promise<void> {
  const { projectDir, setRecords } = params;
  try {
    const result = await ipcClient.loadRecordings({ projectDir });
    console.log('[renderer] load-recordings result raw', result);
    if (result && result.ok && Array.isArray(result.records)) {
      const mapped = mapLoadedRecordings(result.records);
      console.log('[renderer] load-recordings mapped', { count: mapped.length, sample: mapped.slice(0, 5) });
      setRecords(mapped);
    } else {
      console.log('[renderer] load-recordings no records', result);
      setRecords([]);
    }
  } catch (error) {
    console.error('[renderer] load-recordings error', error);
    setRecords([]);
  }
}
