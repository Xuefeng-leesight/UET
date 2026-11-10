import { invokeSafe, invokeSafeNoPayload } from '@/infrastructure/electron/ipcCore';
import type { SelectGazeMappingFileResult, GazeMappingResultData, RunGazeMappingResult } from '@/infrastructure/electron/ipcTypes';

export const mappingIpcClient = {
  selectGazeMappingImage: async (): Promise<SelectGazeMappingFileResult> => {
    return invokeSafeNoPayload<SelectGazeMappingFileResult>('select-gaze-mapping-image', { canceled: true });
  },

  runGazeMapping: async (payload: {
    projectDir: string;
    videoPath: string;
    imagePath: string;
    gazePoints: Array<{ x: number; y: number; timestamp?: number; weight?: number; durationMs?: number; id?: number | string }>;
    keyframeIntervalFrames: number;
    recordId?: string;
    recordName?: string;
  }): Promise<RunGazeMappingResult> => {
    return invokeSafe<RunGazeMappingResult>('run-gaze-mapping', payload, { ok: false });
  },

  listGazeMappingRecords: async (payload: { projectDir: string }): Promise<{ ok: boolean; records: Array<{ outputPath: string; result: GazeMappingResultData }>; message?: string }> => {
    return invokeSafe('list-gaze-mapping-records', payload, { ok: false, records: [] });
  },

  loadGazeMappingRecord: async (payload: { projectDir: string; outputPath: string }): Promise<{ ok: boolean; record?: { outputPath: string; result: GazeMappingResultData }; message?: string }> => {
    return invokeSafe('load-gaze-mapping-record', payload, { ok: false });
  },

  deleteGazeMappingRecord: async (payload: { projectDir: string; outputPath: string }): Promise<{ ok: boolean; message?: string }> => {
    return invokeSafe('delete-gaze-mapping-record', payload, { ok: false });
  },

  updateGazeMappingPoint: async (payload: {
    projectDir: string;
    outputPath: string;
    action?: 'calibrate' | 'set-deleted' | 'restore-all-deleted';
    pointIndex?: number;
    sourceId?: number | string;
    x?: number;
    y?: number;
    deleted?: boolean;
  }): Promise<{ ok: boolean; message?: string; restoredCount?: number }> => {
    return invokeSafe('update-gaze-mapping-point', payload, { ok: false });
  },

  saveGazeMappingScreenshot: async (payload: { projectDir: string; dataUrl: string }): Promise<{ ok: boolean; path?: string; url?: string | null; name?: string; message?: string }> => {
    return invokeSafe('save-gaze-mapping-screenshot', payload, { ok: false });
  }
};
