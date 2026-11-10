import { ipcClient } from '@/infrastructure/electron/ipcClient';
import type { RecordingRecord } from '@shared/contracts/domain/models';

export function detailVideoUrlEffect(params: {
  selectedRecordId: string | null;
  projectDir: string | null;
  records: RecordingRecord[];
  setDetailVideoUrl: (url: string | null) => void;
}): void {
  const { selectedRecordId, projectDir, records, setDetailVideoUrl } = params;
  console.log('[renderer] detail video effect start', {
    selectedRecordId,
    projectDir,
  });
  if (!selectedRecordId) {
    console.log('[renderer] detail video effect: missing selection or project');
    setDetailVideoUrl(null);
    return;
  }
  const record = records.find((r) => r.id === selectedRecordId);
  if (!record) {
    console.log('[renderer] detail video effect: record not found', {
      selectedRecordId,
      recordsLength: records.length,
    });
    setDetailVideoUrl(null);
    return;
  }
  const fallbackUrl = typeof record.mp4Url === 'string' && record.mp4Url ? record.mp4Url : null;
  const recordPath = typeof record.mp4Path === 'string' && record.mp4Path ? record.mp4Path : undefined;
  if (fallbackUrl) {
    console.log('[renderer] detail video effect: using optimistic record.mp4Url before refresh', {
      recordId: record.id,
      name: record.name,
      mp4Url: fallbackUrl,
      recordPath,
    });
    setDetailVideoUrl(fallbackUrl);
  }
  if (!projectDir) {
    console.log('[renderer] detail video effect: missing projectDir or ipcRenderer', {
      projectDir,
      hasInvoke: false,
    });
    setDetailVideoUrl(fallbackUrl);
    return;
  }
  if (!recordPath && !record.name) {
    console.log('[renderer] detail video effect: missing record name and path');
    setDetailVideoUrl(fallbackUrl);
    return;
  }
  console.log('[renderer] detail video effect: invoking get-record-video-url', {
    projectDir,
    name: record.name,
    recordPath,
  });
  ipcClient
    .getRecordVideoUrl({
      projectDir,
      name: record.name,
      recordPath,
    })
    .then((res) => {
      if (res && res.ok && typeof res.url === 'string' && res.url) {
        console.log('[renderer] detail video effect: got url from main', res);
        setDetailVideoUrl(res.url);
      } else {
        console.log('[renderer] detail video effect: no url from main', res);
        setDetailVideoUrl(fallbackUrl);
      }
    })
    .catch(() => {
      console.log('[renderer] detail video effect: invoke error');
      setDetailVideoUrl(fallbackUrl);
    });
}
