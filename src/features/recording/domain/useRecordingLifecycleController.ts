import { useCallback, useMemo, useReducer, useRef } from 'react';
import {
  INITIAL_RECORDING_LIFECYCLE_STATE,
  recordingLifecycleReducer,
  selectRecordingLifecycleFlags,
  type BackendRecordingFinalization,
  type RecordingLifecycleEvent,
} from '@/features/recording/domain/recordingLifecycle';

const generateRecordingOperationId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `recording-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

export function useRecordingLifecycleController() {
  const [state, reactDispatch] = useReducer(recordingLifecycleReducer, INITIAL_RECORDING_LIFECYCLE_STATE);
  const stateRef = useRef(state);
  // Async continuations must observe stop/failure immediately, before React
  // commits the next render. Both views apply the same ordered reducer events.
  const dispatch = useCallback((event: RecordingLifecycleEvent) => {
    stateRef.current = recordingLifecycleReducer(stateRef.current, event);
    reactDispatch(event);
  }, []);
  const flags = useMemo(() => selectRecordingLifecycleFlags(state), [state]);

  const createOperationId = useCallback(() => generateRecordingOperationId(), []);
  const begin = useCallback((operationId = generateRecordingOperationId()) => {
    dispatch({ type: 'START_REQUESTED', operationId });
    return operationId;
  }, []);
  const confirmStart = useCallback((operationId: string, recordingId: string, videoPath: string) => {
    dispatch({ type: 'START_CONFIRMED', operationId, recordingId, videoPath });
  }, []);
  const failStart = useCallback((operationId: string, error: string) => {
    dispatch({ type: 'START_FAILED', operationId, error });
  }, []);
  const requestStop = useCallback((operationId: string) => dispatch({ type: 'STOP_REQUESTED', operationId }), []);
  const acceptStop = useCallback((operationId: string) => dispatch({ type: 'STOP_ACCEPTED', operationId }), []);
  const rejectStop = useCallback((operationId: string, error: string) => {
    dispatch({ type: 'STOP_REJECTED', operationId, error });
  }, []);
  const finalize = useCallback((operationId: string, recordingId?: string, videoPath?: string) => {
    dispatch({ type: 'FINALIZED', operationId, recordingId, videoPath });
  }, []);
  const failFinalize = useCallback((operationId: string, error: string) => {
    dispatch({ type: 'FINALIZE_FAILED', operationId, error });
  }, []);
  const receiveFinalization = useCallback((operationId: string, result: BackendRecordingFinalization) => {
    dispatch({ type: 'BACKEND_FINALIZED', operationId, result });
  }, []);
  const abort = useCallback((operationId: string, error?: string) => {
    dispatch({ type: 'ABORTED', operationId, error });
  }, []);
  const reset = useCallback(() => dispatch({ type: 'RESET' }), []);

  return {
    state,
    stateRef,
    ...flags,
    createOperationId,
    begin,
    confirmStart,
    failStart,
    requestStop,
    acceptStop,
    rejectStop,
    finalize,
    failFinalize,
    receiveFinalization,
    abort,
    reset,
  };
}
