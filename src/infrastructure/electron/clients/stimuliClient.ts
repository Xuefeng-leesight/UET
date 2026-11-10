import { invokeSafe, invokeSafeNoPayload } from '@/infrastructure/electron/ipcCore';
import type { SaveOkResult, SaveStimuliResult, LoadStimuliResult, ImportStimuliResult, StartStimulusScreenRecordingResult, ImportComboAssetsResult, GetStimulusMediaUrlResult, DeleteStimulusResult, CheckStimulusUsageResult } from '@/infrastructure/electron/ipcTypes';

export const stimuliIpcClient = {
  loadStimuli: async (payload: { projectDir: string }): Promise<LoadStimuliResult> => {
    return invokeSafe<LoadStimuliResult>('load-stimuli', payload, { ok: false, stimuli: [] });
  },

  saveStimuli: async (
    payload: { projectDir: string; stimuli: unknown[] }
  ): Promise<SaveOkResult> => {
    return invokeSafe<SaveOkResult>('save-stimuli', payload, { ok: false });
  },

  saveStimuliDetailed: async (payload: { projectDir: string; stimuli: unknown[] }): Promise<SaveStimuliResult> => {
    return invokeSafe<SaveStimuliResult>('save-stimuli', payload, { ok: false });
  },

  deleteStimulus: async (payload: { projectDir: string; id: string; url?: string }): Promise<DeleteStimulusResult> => {
    return invokeSafe<DeleteStimulusResult>('delete-stimulus', payload, { ok: false });
  },

  checkStimulusUsage: async (payload: { projectDir: string; id: string }): Promise<CheckStimulusUsageResult> => {
    return invokeSafe<CheckStimulusUsageResult>('check-stimulus-usage', payload, { ok: false });
  },

  copyStimulus: async (payload: { projectDir: string; stimulusId: string }): Promise<ImportStimuliResult> => {
    return invokeSafe<ImportStimuliResult>('copy-stimulus', payload, { ok: false, stimuli: [] });
  },

  importStimuli: async (payload: {
    projectDir: string;
    files: { name: string; path: string }[];
    group?: string;
  }): Promise<ImportStimuliResult> => {
    return invokeSafe<ImportStimuliResult>('import-stimuli', payload, { ok: false, stimuli: [] });
  },

  importStimuliBuffer: async (payload: {
    projectDir: string;
    files: { name: string; data: Uint8Array }[];
    group?: string;
    forceTranscodeVideo?: boolean;
    sourceKind?: 'screen-recording';
  }): Promise<ImportStimuliResult> => {
    return invokeSafe<ImportStimuliResult>('import-stimuli-buffer', payload, { ok: false, stimuli: [] });
  },

  startStimulusScreenRecording: async (payload: {
    projectDir: string;
    name?: string;
    group?: string;
  }): Promise<StartStimulusScreenRecordingResult> => {
    return invokeSafe<StartStimulusScreenRecordingResult>('start-stimulus-screen-recording', payload, { ok: false });
  },

  stopStimulusScreenRecording: async (payload: {
    sessionId: string;
    asComboAsset?: boolean;
  }): Promise<ImportStimuliResult> => {
    return invokeSafe<ImportStimuliResult>('stop-stimulus-screen-recording', payload, { ok: false, stimuli: [] });
  },

  importComboAssets: async (payload: {
    projectDir: string;
    files: { name: string; path?: string; data?: Uint8Array }[];
  }): Promise<ImportComboAssetsResult> => {
    return invokeSafe<ImportComboAssetsResult>('import-combo-assets', payload, { ok: false, assets: [] });
  },

  getStimulusMediaUrl: async (payload: {
    projectDir: string;
    stimulusId?: string;
    url?: string;
    mediaType?: 'video' | 'image' | 'audio' | 'unknown';
  }): Promise<GetStimulusMediaUrlResult> => {
    return invokeSafe<GetStimulusMediaUrlResult>('get-stimulus-media-url', payload, { ok: false, url: null });
  }
};
