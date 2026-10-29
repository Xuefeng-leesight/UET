import { ipcClient } from '@/infrastructure/electron/ipcClient';
import type { RecordingRecord } from '@shared/contracts/domain/models';

export function aoiVideoUrlEffect(params: {
  aoiSelectedRecordId: string | null;
  records: RecordingRecord[];
  projectDir: string | null;
  setAoiVideoUrl: (url: string | null) => void;
}): void {
  const { aoiSelectedRecordId, records, projectDir, setAoiVideoUrl } = params;
  if (!aoiSelectedRecordId || records.length === 0) {
    setAoiVideoUrl(null);
    return;
  }
  const record = records.find((r) => r.id === aoiSelectedRecordId);
  if (!record) {
    setAoiVideoUrl(null);
    return;
  }
  if (record.mp4Url) {
    setAoiVideoUrl(record.mp4Url);
    return;
  }
  if (!projectDir) {
    setAoiVideoUrl(null);
    return;
  }
  ipcClient
    .getRecordVideoUrl({
      projectDir,
      name: record.name,
      recordPath: typeof record.mp4Path === 'string' ? record.mp4Path : undefined,
    })
    .then((res) => {
      if (res && res.ok && typeof res.url === 'string') {
        setAoiVideoUrl(res.url);
      } else {
        setAoiVideoUrl(null);
      }
    })
    .catch(() => setAoiVideoUrl(null));
}
