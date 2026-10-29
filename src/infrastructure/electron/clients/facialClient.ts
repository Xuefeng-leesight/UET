import { invokeSafe, invokeSafeNoPayload } from '@/infrastructure/electron/ipcCore';
import type { ListFacialRecordsResult, LoadFacialAnalysisResult, ImportFacialVideoResult } from '@/infrastructure/electron/ipcTypes';

export const facialIpcClient = {
  // --- Facial Analysis ---

  listFacialAnalysisRecords: async (payload: { projectDir: string }): Promise<ListFacialRecordsResult> => {
    return invokeSafe<ListFacialRecordsResult>('list-facial-analysis-records', payload, { ok: false, records: [] });
  },

  loadFacialAnalysis: async (payload: { projectDir: string; recordId: string }): Promise<LoadFacialAnalysisResult> => {
    return invokeSafe<LoadFacialAnalysisResult>('load-facial-analysis', payload, { ok: false, manifest: {}, result: null, videoUrl: null });
  },

  importFacialVideo: async (payload: { projectDir: string; recordId: string; recordName?: string; subjectName?: string }): Promise<ImportFacialVideoResult> => {
    return invokeSafe<ImportFacialVideoResult>('import-facial-video', payload, { ok: false, manifest: null, videoUrl: null });
  },

  startFacialServer: async (): Promise<{ ok: boolean; message?: string; ports?: { image: number; data: number; cmd: number } }> => {
    return invokeSafeNoPayload<{ ok: boolean; message?: string; ports?: { image: number; data: number; cmd: number } }>('start-facial-server', { ok: false });
  },

  stopFacialServer: async (): Promise<{ ok: boolean }> => {
    return invokeSafeNoPayload<{ ok: boolean }>('stop-facial-server', { ok: false });
  },

  facialServerStatus: async (): Promise<{ ok: boolean; running: boolean; ports: { image: number; data: number; cmd: number }; buildId?: string | null }> => {
    return invokeSafeNoPayload<{ ok: boolean; running: boolean; ports: { image: number; data: number; cmd: number }; buildId?: string | null }>('facial-server-status', { ok: false, running: false, ports: { image: 9011, data: 9012, cmd: 9013 }, buildId: null });
  },

  finalizeFacialBrowserVideo: async (payload: { projectDir: string; recordId: string }): Promise<{ ok: boolean; path?: string; message?: string }> => {
    return invokeSafe<{ ok: boolean; path?: string; message?: string }>('finalize-facial-browser-video', payload, { ok: false, message: '视频收尾失败' });
  }
};
