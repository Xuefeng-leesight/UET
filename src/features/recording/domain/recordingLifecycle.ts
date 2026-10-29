export type RecordingLifecycleStatus =
  | 'idle'
  | 'preparing'
  | 'recording'
  | 'stopping'
  | 'finalizing'
  | 'completed'
  | 'failed';

export type RecordingLifecycleState = {
  status: RecordingLifecycleStatus;
  operationId: string | null;
  recordingId: string | null;
  videoPath: string | null;
  error: string | null;
};

export type BackendRecordingFinalization = {
  recordingId: string;
  videoPath: string;
  ok: boolean;
  message: string;
};

export type RecordingLifecycleEvent =
  | { type: 'START_REQUESTED'; operationId: string }
  | { type: 'START_CONFIRMED'; operationId: string; recordingId: string; videoPath: string }
  | { type: 'START_FAILED'; operationId: string; error: string }
  | { type: 'STOP_REQUESTED'; operationId: string }
  | { type: 'STOP_ACCEPTED'; operationId: string }
  | { type: 'STOP_REJECTED'; operationId: string; error: string }
  | { type: 'FINALIZED'; operationId: string; recordingId?: string; videoPath?: string }
  | { type: 'FINALIZE_FAILED'; operationId: string; error: string }
  | { type: 'BACKEND_FINALIZED'; operationId: string; result: BackendRecordingFinalization }
  | { type: 'ABORTED'; operationId: string; error?: string }
  | { type: 'RESET' };

export const INITIAL_RECORDING_LIFECYCLE_STATE: RecordingLifecycleState = {
  status: 'idle',
  operationId: null,
  recordingId: null,
  videoPath: null,
  error: null,
};

const belongsToCurrentOperation = (state: RecordingLifecycleState, operationId: string): boolean =>
  state.operationId === operationId;

export function normalizeRecordingPath(value: string | null | undefined): string {
  const path = String(value || '').trim().replace(/\\/g, '/');
  return /^[a-z]:\//i.test(path) || path.startsWith('//') ? path.toLowerCase() : path;
}

export function matchesRecordingFinalization(
  state: RecordingLifecycleState,
  result: Pick<BackendRecordingFinalization, 'recordingId' | 'videoPath'>,
): boolean {
  if (!state.operationId || !['recording', 'stopping', 'finalizing'].includes(state.status)) return false;
  const expectedId = String(state.recordingId || '').trim();
  const receivedId = String(result.recordingId || '').trim();
  const expectedPath = normalizeRecordingPath(state.videoPath);
  const receivedPath = normalizeRecordingPath(result.videoPath);
  if (expectedId && receivedId && expectedId !== receivedId) return false;
  if (expectedPath && receivedPath && expectedPath !== receivedPath) return false;
  return Boolean((expectedId && receivedId === expectedId) || (expectedPath && receivedPath === expectedPath));
}

export function recordingLifecycleReducer(
  state: RecordingLifecycleState,
  event: RecordingLifecycleEvent,
): RecordingLifecycleState {
  switch (event.type) {
    case 'START_REQUESTED':
      if (state.status !== 'idle' && state.status !== 'completed' && state.status !== 'failed') return state;
      return {
        status: 'preparing',
        operationId: event.operationId,
        recordingId: null,
        videoPath: null,
        error: null,
      };
    case 'START_CONFIRMED':
      if (state.status !== 'preparing' || !belongsToCurrentOperation(state, event.operationId)) return state;
      return {
        ...state,
        status: 'recording',
        recordingId: event.recordingId,
        videoPath: event.videoPath,
      };
    case 'START_FAILED':
      if (state.status !== 'preparing' || !belongsToCurrentOperation(state, event.operationId)) return state;
      return { ...state, status: 'failed', error: event.error };
    case 'STOP_REQUESTED':
      if (state.status !== 'recording' || !belongsToCurrentOperation(state, event.operationId)) return state;
      return { ...state, status: 'stopping', error: null };
    case 'STOP_ACCEPTED':
      if (state.status !== 'stopping' || !belongsToCurrentOperation(state, event.operationId)) return state;
      return { ...state, status: 'finalizing' };
    case 'STOP_REJECTED':
      if (state.status !== 'stopping' || !belongsToCurrentOperation(state, event.operationId)) return state;
      return { ...state, status: 'recording', error: event.error };
    case 'FINALIZED':
      if (
        (state.status !== 'stopping' && state.status !== 'finalizing') ||
        !belongsToCurrentOperation(state, event.operationId)
      ) return state;
      return {
        ...state,
        status: 'completed',
        recordingId: event.recordingId || state.recordingId,
        videoPath: event.videoPath || state.videoPath,
        error: null,
      };
    case 'FINALIZE_FAILED':
      if (
        (state.status !== 'stopping' && state.status !== 'finalizing') ||
        !belongsToCurrentOperation(state, event.operationId)
      ) return state;
      return { ...state, status: 'failed', error: event.error };
    case 'BACKEND_FINALIZED':
      // A recorder can fail and finish without receiving a user stop command.
      // Only a result identifying this confirmed recording may end it.
      if (!belongsToCurrentOperation(state, event.operationId) || !matchesRecordingFinalization(state, event.result)) return state;
      return {
        ...state,
        status: event.result.ok ? 'completed' : 'failed',
        recordingId: event.result.recordingId || state.recordingId,
        videoPath: event.result.videoPath || state.videoPath,
        error: event.result.ok ? null : event.result.message,
      };
    case 'ABORTED':
      if (!belongsToCurrentOperation(state, event.operationId)) return state;
      return event.error
        ? { ...state, status: 'failed', error: event.error }
        : INITIAL_RECORDING_LIFECYCLE_STATE;
    case 'RESET':
      return INITIAL_RECORDING_LIFECYCLE_STATE;
    default:
      return state;
  }
}

export const selectRecordingLifecycleFlags = (state: RecordingLifecycleState) => ({
  // Preparing stays active for the legacy surface so the first stimulus can
  // render before the recorder start command is acknowledged.
  isRecording: state.status === 'preparing' || state.status === 'recording',
  isFinalizing: state.status === 'stopping' || state.status === 'finalizing',
  canStart: state.status === 'idle' || state.status === 'completed' || state.status === 'failed',
  canStop: state.status === 'recording',
});
