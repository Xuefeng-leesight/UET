import React from 'react';
import {
  createEmptyPlaybackMediaSnapshot,
  mergePlaybackMediaSnapshot,
  readPlaybackMediaSnapshot,
  type PlaybackMediaSnapshot,
} from '@/features/records/domain/playback/playbackMediaModel';

type DebugEmitter = (event: string, details?: Record<string, unknown>) => void;

type UseRecordPlaybackControllerOptions = {
  recordId: string;
  sourceUrl: string | null;
  externalVideoRef: React.RefObject<HTMLVideoElement | null>;
  emitDebug?: DebugEmitter;
};

const MEDIA_SYNC_EVENTS = [
  'loadedmetadata',
  'loadeddata',
  'durationchange',
  'canplay',
  'timeupdate',
  'seeked',
  'play',
  'pause',
  'ended',
  'emptied',
] as const;

export const useRecordPlaybackController = ({
  recordId,
  sourceUrl,
  externalVideoRef,
  emitDebug,
}: UseRecordPlaybackControllerOptions) => {
  const [media, setMedia] = React.useState<PlaybackMediaSnapshot>(() =>
    createEmptyPlaybackMediaSnapshot(recordId, sourceUrl),
  );
  const [visualCurrentTime, setVisualCurrentTime] = React.useState(0);
  const elementRef = React.useRef<HTMLVideoElement | null>(null);
  const detachListenersRef = React.useRef<(() => void) | null>(null);
  const latestIdentityRef = React.useRef({ recordId, sourceUrl });
  const emitDebugRef = React.useRef(emitDebug);
  const lastManualSeekRef = React.useRef<{ time: number; requestedAtMs: number } | null>(null);
  latestIdentityRef.current = { recordId, sourceUrl };
  emitDebugRef.current = emitDebug;

  const syncFromElement = React.useCallback((element: HTMLVideoElement, source: string) => {
    const identity = latestIdentityRef.current;
    const recentSeek = lastManualSeekRef.current;
    const mediaDuration = Number.isFinite(element.duration) ? element.duration : 0;
    const mediaTime = Number.isFinite(element.currentTime) ? element.currentTime : 0;
    if (
      recentSeek
      && mediaDuration > 0
      && recentSeek.time < mediaDuration - 0.75
      && mediaTime >= mediaDuration - 0.25
      && performance.now() - recentSeek.requestedAtMs < 2_500
    ) {
      element.pause();
      element.currentTime = recentSeek.time;
      emitDebugRef.current?.('playback-tail-jump-corrected', {
        source,
        requestedTime: recentSeek.time,
        mediaTime,
        duration: mediaDuration,
      });
    } else if (
      recentSeek
      && (Math.abs(mediaTime - recentSeek.time) < 0.25 || performance.now() - recentSeek.requestedAtMs >= 2_500)
    ) {
      lastManualSeekRef.current = null;
    }
    const next = readPlaybackMediaSnapshot(identity.recordId, identity.sourceUrl, element);
    setMedia((previous) => {
      return mergePlaybackMediaSnapshot(previous, next);
    });
    setVisualCurrentTime(next.currentTimeSeconds);
    emitDebugRef.current?.('playback-media-snapshot', {
      source,
      duration: next.durationSeconds || null,
      currentTime: next.currentTimeSeconds,
      videoWidth: next.intrinsicWidth || null,
      videoHeight: next.intrinsicHeight || null,
      readyState: next.readyState,
      isPlaying: next.isPlaying,
    });
  }, []);

  const attachVideo = React.useCallback((element: HTMLVideoElement | null) => {
    detachListenersRef.current?.();
    detachListenersRef.current = null;
    elementRef.current = element;
    externalVideoRef.current = element;
    if (!element) return;

    const listeners = MEDIA_SYNC_EVENTS.map((eventName) => {
      const listener = () => syncFromElement(element, eventName);
      element.addEventListener(eventName, listener);
      return { eventName, listener };
    });
    detachListenersRef.current = () => {
      listeners.forEach(({ eventName, listener }) => element.removeEventListener(eventName, listener));
    };

    // The media can already be ready before React receives loadedmetadata.
    syncFromElement(element, 'callback-ref');
    queueMicrotask(() => {
      if (elementRef.current === element) syncFromElement(element, 'callback-ref-microtask');
    });
    window.requestAnimationFrame(() => {
      if (elementRef.current === element) syncFromElement(element, 'callback-ref-animation-frame');
    });
  }, [externalVideoRef, syncFromElement]);

  React.useEffect(() => {
    setMedia(createEmptyPlaybackMediaSnapshot(recordId, sourceUrl));
    setVisualCurrentTime(0);
    lastManualSeekRef.current = null;
    const element = elementRef.current;
    if (element) syncFromElement(element, 'record-identity-change');
  }, [recordId, syncFromElement]);

  React.useEffect(() => {
    setMedia((previous) => ({ ...previous, sourceUrl }));
    const element = elementRef.current;
    if (element) syncFromElement(element, 'source-url-change');
  }, [sourceUrl, syncFromElement]);

  React.useEffect(() => {
    if (!media.isPlaying) return;
    let rafId = 0;
    let lastUpdateMs = 0;
    const tick = (nowMs: number) => {
      const element = elementRef.current;
      if (!element) return;
      if (nowMs - lastUpdateMs >= 100) {
        lastUpdateMs = nowMs;
        const current = Number.isFinite(element.currentTime) ? element.currentTime : 0;
        setVisualCurrentTime(current);
      }
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [media.isPlaying]);

  const seekTo = React.useCallback((nextTime: number) => {
    const element = elementRef.current;
    if (!element) return;
    const duration = Number.isFinite(element.duration) && element.duration > 0
      ? element.duration
      : media.durationSeconds;
    const target = Math.max(0, Math.min(Number.isFinite(nextTime) ? nextTime : 0, duration || 0));
    lastManualSeekRef.current = { time: target, requestedAtMs: performance.now() };
    element.currentTime = target;
    setMedia((previous) => ({ ...previous, currentTimeSeconds: target }));
    setVisualCurrentTime(target);
  }, [media.durationSeconds]);

  const seekBy = React.useCallback((deltaSeconds: number) => {
    const current = elementRef.current?.currentTime ?? media.currentTimeSeconds;
    seekTo(current + deltaSeconds);
  }, [media.currentTimeSeconds, seekTo]);

  const togglePlay = React.useCallback((play: () => void) => {
    const element = elementRef.current;
    if (!element) return;
    if (element.paused || element.ended) {
      play();
    } else {
      element.pause();
    }
  }, []);

  return {
    media,
    visualCurrentTime,
    attachVideo,
    elementRef,
    seekTo,
    seekBy,
    togglePlay,
    syncFromElement,
  };
};
