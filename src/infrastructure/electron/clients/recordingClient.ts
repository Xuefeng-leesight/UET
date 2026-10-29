import { invokeSafe, invokeSafeNoPayload } from '@/infrastructure/electron/ipcCore';
import type { SaveOkResult, CreateRecordingWindowResult, RecordingMonitorSnapshotsResult, StartRecordingAudioResult, RecordingAudioWriteResult, FinishRecordingAudioResult } from '@/infrastructure/electron/ipcTypes';
import type { ParticipantWindowState } from '@/features/recording/domain/participantWindowState';
import type { PupilAudioSync } from '@shared/domain/pupilAudioSync';

export const recordingIpcClient = {
  createRecordingWindow: async (payload: {
    projectDir?: string;
    forceEnable?: boolean;
    initialState?: ParticipantWindowState;
  }): Promise<CreateRecordingWindowResult> => {
    return invokeSafe<CreateRecordingWindowResult>('create-recording-window', payload, { ok: false });
  },

  closeRecordingWindow: async (): Promise<SaveOkResult> => {
    return invokeSafeNoPayload<SaveOkResult>('close-recording-window', { ok: false });
  },

  getRecordingMonitorSnapshots: async (): Promise<RecordingMonitorSnapshotsResult> => {
    return invokeSafeNoPayload<RecordingMonitorSnapshotsResult>('get-recording-monitor-snapshots', {
      ok: false,
      participant: null,
    });
  },

  startRecordingAudio: async (payload: {
    videoPath: string;
    mimeType: string;
    deviceLabel?: string;
  }): Promise<StartRecordingAudioResult> => {
    return invokeSafe<StartRecordingAudioResult>('start-recording-audio', payload, { ok: false });
  },

  appendRecordingAudio: async (payload: {
    sessionId: string;
    chunk: Uint8Array;
  }): Promise<RecordingAudioWriteResult> => {
    return invokeSafe<RecordingAudioWriteResult>('append-recording-audio', payload, { ok: false });
  },

  finishRecordingAudio: async (payload: {
    sessionId: string;
    pupilSync?: PupilAudioSync;
    synchronizationError?: string;
  }): Promise<FinishRecordingAudioResult> => {
    return invokeSafe<FinishRecordingAudioResult>('finish-recording-audio', payload, { ok: false });
  },

  abortRecordingAudio: async (payload: {
    sessionId: string;
  }): Promise<RecordingAudioWriteResult> => {
    return invokeSafe<RecordingAudioWriteResult>('abort-recording-audio', payload, { ok: false });
  },

  updateSubjectWindow: async (payload: ParticipantWindowState): Promise<SaveOkResult> => {
    return invokeSafe<SaveOkResult>('update-subject-window', payload, { ok: false });
  }
};
