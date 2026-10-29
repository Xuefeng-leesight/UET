import { useEffect, useRef } from 'react';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import { ipcEvents } from '@/infrastructure/electron/ipcEvents';

type SubjectWindowUserInput =
  | { type: 'mouse'; button: number }
  | { type: 'mouse-double'; button: number }
  | { type: 'playback-done'; stimulusId: string; eventName: 'mrt:recording-video-ended' | 'mrt:recording-video-error' }
  | { type: 'key'; key: 'Escape' };

export type AppNotice = {
  title: string;
  message: string;
  variant: 'danger' | 'primary';
};

const asRecord = (value: unknown): Record<string, unknown> => {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
};

export function normalizeSubjectWindowUserInput(payload: unknown): SubjectWindowUserInput | null {
  const data = asRecord(payload);
  const type = String(data.type || '');
  if (type === 'mouse' || type === 'mouse-double') {
    const buttonRaw = Number(data.button);
    return { type, button: Number.isFinite(buttonRaw) ? buttonRaw : 0 };
  }
  if (type === 'playback-done') {
    const stimulusId = String(data.stimulusId || '');
    if (!stimulusId) return null;
    return {
      type,
      stimulusId,
      eventName: String(data.eventName || '') === 'mrt:recording-video-error'
        ? 'mrt:recording-video-error'
        : 'mrt:recording-video-ended',
    };
  }
  if (type === 'key' && String(data.key || '') === 'Escape') {
    return { type, key: 'Escape' };
  }
  return null;
}

export function normalizeAppNotice(payload: unknown, isEnglish: boolean): AppNotice {
  const data = asRecord(payload);
  return {
    title: String(data.title || (isEnglish ? 'Notice' : '提示')),
    message: String(data.message || ''),
    variant: String(data.variant || '').toLowerCase() === 'danger' ? 'danger' : 'primary',
  };
}

export function useMrtAppEvents(params: {
  isRecording: boolean;
  isPreviewing: boolean;
  isRecordingCaptureReady: boolean;
  calibrationState: 'none' | 'calibrating' | 'finished';
  isEnglish: boolean;
  showNotice: (message: string, title?: string, variant?: 'danger' | 'primary') => void;
  stopDeviceGracefully: (reason: string, timeoutMs?: number) => Promise<void>;
}): void {
  const {
    isRecording,
    isPreviewing,
    isRecordingCaptureReady,
    calibrationState,
    isEnglish,
    showNotice,
    stopDeviceGracefully,
  } = params;
  const shutdownInProgressRef = useRef(false);

  useEffect(() => {
    const onSubjectWindowUserInput = (_event: unknown, payload: unknown) => {
      const calibrationOverlayActive = calibrationState !== 'none';
      const overlayActive = isRecording || isPreviewing || calibrationOverlayActive;
      const captureReady = calibrationOverlayActive || isPreviewing || isRecordingCaptureReady;
      if (!overlayActive || !captureReady) return;
      const input = normalizeSubjectWindowUserInput(payload);
      if (!input) return;
      if (input.type === 'mouse') {
        window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: input.button }));
      } else if (input.type === 'mouse-double') {
        window.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: input.button }));
      } else if (input.type === 'playback-done') {
        window.dispatchEvent(new CustomEvent(input.eventName, { detail: { stimulusId: input.stimulusId } }));
      } else {
        window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: input.key }));
      }
    };
    return ipcEvents.on('subject-window:user-input', onSubjectWindowUserInput);
  }, [calibrationState, isPreviewing, isRecording, isRecordingCaptureReady]);

  useEffect(() => {
    const onAppNotice = (_event: unknown, payload: unknown) => {
      const notice = normalizeAppNotice(payload, isEnglish);
      showNotice(notice.message, notice.title, notice.variant);
    };
    return ipcEvents.on('app-notice', onAppNotice);
  }, [isEnglish, showNotice]);

  useEffect(() => {
    const onAppShutdownRequest = () => {
      if (shutdownInProgressRef.current) return;
      shutdownInProgressRef.current = true;
      void (async () => {
        try {
          await stopDeviceGracefully('app-close', 2200);
        } catch (error) {
          console.error('[MrtApp] stopDeviceGracefully failed during app-close:', error);
        } finally {
          const result = await ipcClient.rendererShutdownComplete();
          if (!result.ok) console.error('[MrtApp] renderer-shutdown-complete invoke failed');
        }
      })();
    };
    return ipcEvents.on('app-shutdown-request', onAppShutdownRequest);
  }, [stopDeviceGracefully]);
}
