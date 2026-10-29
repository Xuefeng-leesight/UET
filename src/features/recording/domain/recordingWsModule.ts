import type React from 'react';
import { finishRecordingCommunication } from '@/features/recording/domain/recordingCommunication';
import { calibrationScoresFromCompletion, type CalibrationScores } from '@/features/recording/domain/calibrationScores';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import {
  createWebCodecsRenderer,
  type WebCodecsFrame,
  type WebCodecsRenderer,
} from '@/features/recording/domain/webcodecsVideoRenderer';
import type { EyeTrackingData } from '@/features/recording/domain/recordingContracts';
import type { EyeDataUpdater } from '@/features/recording/domain/recordingEyeDataStore';
import { acceptHuahongCalibrationMessage, invalidateCalibrationCommand, invalidateHuahongCalibrationSession,
  isCurrentCalibrationCommand, matchesCalibrationCommandResponse, prepareCalibrationCommand,
  registerHuahongCalibrationSession, type PreparedCalibrationCommand } from '@/features/recording/domain/huahongCalibrationSession';

type WsCommandResponse = Record<string, unknown> & {
  type?: string;
  id?: string;
  error?: number;
  msg?: string;
  running?: boolean;
  inferenceReady?: boolean;
  actual?: { width?: number; height?: number; fps?: number };
  status?: string;
  result?: WsCommandResponse;
  recording_id?: string;
  video_path?: string;
  csv_path?: string;
  video_size?: number;
  elapsed_ms?: number;
};

type WsCommandResult = { ok: boolean; error?: string; response?: WsCommandResponse };

// The service protocol currently uses the command name itself as the response
// id. Serializing requests per socket prevents two concurrent calls with the
// same id from both consuming the first response.
const wsCommandChains = new WeakMap<WebSocket, Promise<void>>();

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function asUnknownRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export type EncodedVideoPreviewController = {
  close: () => void;
};

export type CardDetectionFrameSnapshot = {
  source: 'webcodecs-frame-provider';
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  sourceFrameWidth: number;
  sourceFrameHeight: number;
  updatedAt: number;
  sequence: number;
};

export type CardDetectionFrameProviderRef = {
  current: CardDetectionFrameSnapshot | null;
};

export type EncodedVideoPreviewStatus = {
  mode: 'webcodecs' | 'image';
  status: string;
  width?: number;
  height?: number;
  codec?: string;
  seq?: number;
  expectedSeq?: number;
  packets?: number;
  keyframe?: boolean;
  keyframeWaitPackets?: number;
  streamGeneration?: number;
  previousStreamGeneration?: number | null;
  decodeQueueSize?: number;
  decoded?: number;
  dropped?: number;
  error?: string;
  probes?: unknown;
  reason?: string;
};

export function sendCmdOverWs(params: { wsCmdRef: { current: WebSocket | null }; id: string; args?: Record<string, unknown> }): boolean {
  const { wsCmdRef, id, args = {} } = params;
  if (id === 'stop_recording' || id === 'stop') {
    // Stopping must drain the actual I/O owner before the backend closes its journals.
    void sendCmdWithResponse(params).then(result => {
      if (!result.ok) window.alert(result.error || '停止录制失败');
    });
    return true;
  }
  const ws = wsCmdRef.current;
  if (ws && ws.readyState === WebSocket.OPEN) {
    const command = prepareCalibrationCommand(ws, id, args);
    if (!isCurrentCalibrationCommand(ws, command)) return false;
    try {
      const payload = { type: 'req_cmd', id, args: command.args };
      ws.send(JSON.stringify(payload));
      console.log('[sendCmd] sent', payload);
      return true;
    } catch {
      invalidateCalibrationCommand(ws, command, 'failure');
      return false;
    }
  }
  if (ws) invalidateHuahongCalibrationSession(ws);
  console.warn('Command WS not connected');
  return false;
}

async function sendCmdWithResponseNow(params: {
  wsCmdRef: { current: WebSocket | null };
  id: string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
  debugEventPrefix?: string;
  prepared: PreparedCalibrationCommand;
}): Promise<WsCommandResult> {
  const { wsCmdRef, id, timeoutMs = 5000, debugEventPrefix, prepared } = params;
  const args = prepared.args;
  const ws = wsCmdRef.current;

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return { ok: false, error: '命令通道未连接' };
  }
  if (!isCurrentCalibrationCommand(ws, prepared)) return { ok: false, error: '校准会话已失效' };

  return new Promise((resolve) => {
    let finished = false;
    let timeoutId: number | null = null;

    const finish = (result: WsCommandResult) => {
      if (finished) return;
      finished = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('close', onClose);
      resolve(result);
    };

    const onMessage = (event: MessageEvent) => {
      try {
        const msg = asUnknownRecord(JSON.parse(event.data)) as WsCommandResponse;
        if (msg?.type !== 'rsp_cmd' || msg?.id !== id) return;
        if (!matchesCalibrationCommandResponse(ws, prepared, msg)) return;
        if (debugEventPrefix) {
          void ipcClient.videoDebugLog({
            event: `${debugEventPrefix}:response-received`,
            details: {
              id,
              ok: msg?.error === 0,
              error: msg?.error ?? null,
              msg: typeof msg?.msg === 'string' ? msg.msg : null,
              running: msg?.running ?? null,
              inferenceReady: msg?.inferenceReady ?? null,
            },
          });
        }
        if (msg?.error === 0) {
          finish({ ok: true, response: msg });
          return;
        }
        finish({
          ok: false,
          error: typeof msg?.msg === 'string' && msg.msg.trim().length > 0 ? msg.msg : `${id} failed`,
          response: msg,
        });
      } catch {
      }
    };

    const onClose = () => {
      finish({ ok: false, error: '命令通道已关闭' });
    };

    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);

    try {
      ws.send(JSON.stringify({ type: 'req_cmd', id, args }));
      if (debugEventPrefix) {
        void ipcClient.videoDebugLog({
          event: `${debugEventPrefix}:request-sent`,
          details: {
            id,
            timeoutMs,
            wsReadyState: ws.readyState,
            argKeys: Object.keys(args),
          },
        });
      }
    } catch (error: unknown) {
      invalidateCalibrationCommand(ws, prepared, 'failure');
      finish({ ok: false, error: errorMessage(error, `${id} 发送失败`) });
      return;
    }

    timeoutId = window.setTimeout(() => {
      invalidateCalibrationCommand(ws, prepared, 'timeout');
      if (debugEventPrefix) {
        void ipcClient.videoDebugLog({
          event: `${debugEventPrefix}:response-timeout`,
          details: {
            id,
            timeoutMs,
          },
        });
      }
      finish({ ok: false, error: `等待 ${id} 响应超时` });
    }, timeoutMs);
  });
}

export async function sendCmdWithResponse(params: {
  wsCmdRef: { current: WebSocket | null };
  id: string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
  debugEventPrefix?: string;
}): Promise<WsCommandResult> {
  if (params.id === 'stop_recording' || params.id === 'stop') {
    try { await finishRecordingCommunication(); }
    catch (error) { return { ok: false, error: errorMessage(error, '通信收尾失败，请重试停止录制') }; }
  }
  const socket = params.wsCmdRef.current;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    if (socket) invalidateHuahongCalibrationSession(socket);
    if (params.debugEventPrefix) {
      void ipcClient.videoDebugLog({
        event: `${params.debugEventPrefix}:socket-not-open`,
        details: { id: params.id, readyState: socket ? socket.readyState : null },
      });
    }
    return { ok: false, error: '命令通道未连接' };
  }

  const prepared = prepareCalibrationCommand(socket, params.id, params.args || {});
  const previous = wsCommandChains.get(socket) || Promise.resolve();
  const pending = previous
    .catch(() => {})
    .then(async () => {
      if (params.wsCmdRef.current !== socket || socket.readyState !== WebSocket.OPEN) {
        if (params.debugEventPrefix) {
          void ipcClient.videoDebugLog({
            event: `${params.debugEventPrefix}:socket-closed-before-send`,
            details: { id: params.id },
          });
        }
        return { ok: false, error: '命令通道已关闭' } as WsCommandResult;
      }
      return sendCmdWithResponseNow({ ...params, prepared });
    });
  wsCommandChains.set(socket, pending.then(() => undefined, () => undefined));
  return pending;
}

export async function startDeviceCommand(params: {
  wsCmdRef: { current: WebSocket | null };
  args: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<WsCommandResult> {
  const { wsCmdRef, args, timeoutMs = 5000 } = params;
  return sendCmdWithResponse({ wsCmdRef, id: 'start', args, timeoutMs, debugEventPrefix: 'eye:start-device-command' });
}

export async function stopDeviceCommand(params: {
  wsCmdRef: { current: WebSocket | null };
  timeoutMs?: number;
}): Promise<WsCommandResult> {
  const { wsCmdRef, timeoutMs = 5000 } = params;
  return sendCmdWithResponse({ wsCmdRef, id: 'stop', args: {}, timeoutMs, debugEventPrefix: 'eye:stop-device-command' });
}

export async function waitForDeviceStop(params: {
  isStopped: () => boolean;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<boolean> {
  const { isStopped, timeoutMs = 5000, intervalMs = 100 } = params;
  if (isStopped()) return true;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timerId = window.setInterval(() => {
      if (isStopped()) {
        window.clearInterval(timerId);
        resolve(true);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        window.clearInterval(timerId);
        resolve(false);
      }
    }, Math.max(20, intervalMs));
  });
}

export function connectImageWebSocket(params: {
  wsIp: string;
  wsImagePort: string;
  setWsConnected: (v: boolean) => void;
  wsImageRef: { current: WebSocket | null };
  imageCanvasRef: { current: HTMLImageElement | null };
  setLastImageAt?: (ts: number | null) => void;
}): void {
  const { wsIp, wsImagePort, setWsConnected, wsImageRef, imageCanvasRef, setLastImageAt } = params;
  try {
    const ws = new WebSocket(`ws://${wsIp}:${wsImagePort}/`);
    ws.binaryType = 'arraybuffer';
    let lastObjectUrl: string | null = null;
    let latestFrame: { buf: ArrayBuffer; mime?: string } | null = null;
    let previewFrameCount = 0;
    let firstPreviewFrameAt: number | null = null;
    let rafId: number | null = null;
    let rafRunning = false;
    // Throttle setLastImageAt state updates – only push every 500ms to avoid
    // excessive React re-renders from the rAF loop (~60Hz).
    let lastImageAtUpdateTime = 0;
    const LAST_IMAGE_AT_UPDATE_INTERVAL_MS = 500;
    const shouldLogPreviewFrameMilestone = (frameCount: number) =>
      frameCount === 1 || frameCount === 2 || frameCount === 5 || frameCount === 10 || frameCount % 30 === 0;

    const base64ToArrayBuffer = (value: string): ArrayBuffer => {
      const binary = window.atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes.buffer;
    };

    const detectImageMime = (buf: ArrayBuffer): string => {
      try {
        const view = new Uint8Array(buf);
        if (
          view.length >= 8 &&
          view[0] === 0x89 &&
          view[1] === 0x50 &&
          view[2] === 0x4e &&
          view[3] === 0x47 &&
          view[4] === 0x0d &&
          view[5] === 0x0a &&
          view[6] === 0x1a &&
          view[7] === 0x0a
        ) {
          return 'image/png';
        }
        if (view.length >= 2 && view[0] === 0xff && view[1] === 0xd8) {
          return 'image/jpeg';
        }
      } catch {}
      return 'image/png';
    };

    const renderLatest = () => {
      const el = imageCanvasRef.current;
      if (!el || !latestFrame) {
        // No new frame to render – keep the rAF loop alive but skip work.
        if (rafRunning) {
          rafId = window.requestAnimationFrame(renderLatest);
        }
        return;
      }
      try {
        const { buf, mime: frameMime } = latestFrame;
        const mime = frameMime || detectImageMime(buf);
        const blob = new Blob([buf], { type: mime });
        const url = URL.createObjectURL(blob);
        if (lastObjectUrl) {
          URL.revokeObjectURL(lastObjectUrl);
        }
        lastObjectUrl = url;
        el.src = url;
        latestFrame = null;
        if (setLastImageAt) {
          const now = Date.now();
          if (now - lastImageAtUpdateTime >= LAST_IMAGE_AT_UPDATE_INTERVAL_MS) {
            lastImageAtUpdateTime = now;
            setLastImageAt(now);
          }
        }
      } catch (e) {
        console.error('Image render failed', e);
      }
      if (rafRunning) {
        rafId = window.requestAnimationFrame(renderLatest);
      }
    };
    ws.onopen = () => {
      if (wsImageRef.current !== ws) return;
      console.log('Image WebSocket Connected');
      void ipcClient.videoDebugLog({
        event: 'scene:preview-image-ws-open',
        details: { host: wsIp, port: wsImagePort },
      });
      setWsConnected(true);
      if (!rafRunning) {
        rafRunning = true;
        rafId = window.requestAnimationFrame(renderLatest);
      }
    };
    ws.onmessage = (event) => {
      if (wsImageRef.current !== ws) return;
      try {
        if (typeof event.data === 'string') {
          const msg = JSON.parse(event.data);
          if (msg?.type !== 'image_frame' || msg?.kind !== 'scene' || typeof msg?.data !== 'string') {
            return;
          }
          previewFrameCount += 1;
          if (firstPreviewFrameAt === null) firstPreviewFrameAt = Date.now();
          if (shouldLogPreviewFrameMilestone(previewFrameCount)) {
            void ipcClient.videoDebugLog({
              event: previewFrameCount === 1 ? 'scene:preview-first-frame' : 'scene:preview-frame-heartbeat',
              details: {
                frameCount: previewFrameCount,
                payloadLength: msg.data.length,
                mime: typeof msg?.mime === 'string' ? msg.mime : null,
              },
            });
          }
          latestFrame = { buf: base64ToArrayBuffer(msg.data), mime: typeof msg?.mime === 'string' ? msg.mime : undefined };
          return;
        }
        previewFrameCount += 1;
        if (firstPreviewFrameAt === null) firstPreviewFrameAt = Date.now();
        if (shouldLogPreviewFrameMilestone(previewFrameCount)) {
          void ipcClient.videoDebugLog({
            event: previewFrameCount === 1 ? 'scene:preview-first-frame' : 'scene:preview-frame-heartbeat',
            details: {
              frameCount: previewFrameCount,
              payloadLength: event.data instanceof ArrayBuffer ? event.data.byteLength : null,
              mime: null,
            },
          });
        }
        latestFrame = { buf: event.data as ArrayBuffer };
      } catch (e) {
        console.error('Image WebSocket message decode failed', e);
        void ipcClient.videoDebugLog({
          event: 'scene:preview-image-ws-message-decode-failed',
          details: { frameCount: previewFrameCount },
        });
      }
    };
    const stopRafLoop = () => {
      rafRunning = false;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
    ws.onclose = () => {
      if (wsImageRef.current !== ws) return;
      wsImageRef.current = null;
      console.log('Image WebSocket Closed');
      void ipcClient.videoDebugLog({
        event: 'scene:preview-image-ws-close',
        details: {
          frameCount: previewFrameCount,
          sawFirstFrame: firstPreviewFrameAt !== null,
        },
      });
      setWsConnected(false);
      stopRafLoop();
      latestFrame = null;
      if (lastObjectUrl) {
        URL.revokeObjectURL(lastObjectUrl);
        lastObjectUrl = null;
      }
      if (imageCanvasRef.current) {
        imageCanvasRef.current.src = '';
      }
      if (setLastImageAt) {
        setLastImageAt(null);
      }
    };
    ws.onerror = (err) => {
      if (wsImageRef.current !== ws) return;
      console.error('WebSocket Error:', err);
      void ipcClient.videoDebugLog({
        event: 'scene:preview-image-ws-error',
        details: {
          frameCount: previewFrameCount,
          sawFirstFrame: firstPreviewFrameAt !== null,
        },
      });
      setWsConnected(false);
      stopRafLoop();
      latestFrame = null;
      if (lastObjectUrl) {
        URL.revokeObjectURL(lastObjectUrl);
        lastObjectUrl = null;
      }
      if (setLastImageAt) {
        setLastImageAt(null);
      }
      try {
        ws.close();
      } catch {}
    };
    wsImageRef.current = ws;
  } catch (e) {
    console.error('Connection failed:', e);
    alert('连接失败');
  }
}

export function isWebCodecsPreviewAvailable(): boolean {
  return getWebCodecsPreviewUnavailableReason() === null;
}

export function getWebCodecsPreviewUnavailableReason(): string | null {
  if (window.isSecureContext === false) {
    return `WebCodecs requires a secure context (isSecureContext=false, origin=${window.location.origin})`;
  }
  if (typeof VideoDecoder === 'undefined') {
    return `VideoDecoder is not available (isSecureContext=${String(window.isSecureContext)}, userAgent=${navigator.userAgent})`;
  }
  if (typeof EncodedVideoChunk === 'undefined') return 'EncodedVideoChunk is not available';
  if (typeof VideoFrame === 'undefined') return 'VideoFrame is not available';
  if (typeof Worker === 'undefined') return 'Worker is not available';
  if (typeof WebGLRenderingContext === 'undefined') return 'WebGL is not available';
  return null;
}

export function connectEncodedVideoWebSocket(params: {
  wsIp: string;
  wsImagePort: string;
  setWsConnected: (v: boolean) => void;
  canvasRef: { current: HTMLCanvasElement | null };
  setLastImageAt?: (ts: number | null) => void;
  onStatus?: (status: EncodedVideoPreviewStatus) => void;
  onFallback?: (reason: string) => void;
  onFrameSize?: (size: { width: number; height: number } | null) => void;
  cardDetectionFrameRef?: CardDetectionFrameProviderRef;
  isCardDetectionFrameEnabled?: () => boolean;
  cardDetectionFrameIntervalMs?: number;
  cardDetectionFrameMaxWidth?: number;
}): EncodedVideoPreviewController | null {
  const {
    wsIp,
    wsImagePort,
    setWsConnected,
    canvasRef,
    setLastImageAt,
    onStatus,
    onFallback,
    onFrameSize,
    cardDetectionFrameRef,
    isCardDetectionFrameEnabled,
    cardDetectionFrameIntervalMs = 90,
    cardDetectionFrameMaxWidth = 960,
  } = params;
  const unavailableReason = getWebCodecsPreviewUnavailableReason();
  if (unavailableReason) {
    onFallback?.(unavailableReason);
    return null;
  }

  let worker: Worker | null = null;
  let renderer: WebCodecsRenderer | null = null;
  let closed = false;
  let retryTimer: number | null = null;
  let firstFrameTimer: number | null = null;
  const previewId = crypto.randomUUID();
  const previewStartedAt = performance.now();
  let renderCount = 0;
  let lastRenderAt = 0;
  let maxRenderGapMs = 0;
  let maxRenderSubmitMs = 0;
  let maxWorkerTransferMs = 0;
  let lastMetricAt = previewStartedAt;
  const diagnostic = (event: string, details: Record<string, unknown> = {}) => {
    void ipcClient.videoDebugLog({ event: `webcodecs:${event}`, details: { previewId, diagnosticVersion: 1, elapsedMs: performance.now() - previewStartedAt, ...details } });
  };
  diagnostic('preview-created');
  let canvasRetryCount = 0;
  let lastImageAtUpdateTime = 0;
  let lastCardDetectionFrameAt = 0;
  let cardDetectionFrameSequence = 0;
  let lastFrameStatusAt = 0;
  let cardDetectionCanvas: HTMLCanvasElement | null = null;
  let cardDetectionCtx: CanvasRenderingContext2D | null = null;
  const LAST_IMAGE_AT_UPDATE_INTERVAL_MS = 500;
  const MAX_CANVAS_RETRIES = 20;
  const FIRST_FRAME_TIMEOUT_MS = 8_000;

  const clearFirstFrameTimer = () => {
    if (firstFrameTimer !== null) {
      window.clearTimeout(firstFrameTimer);
      firstFrameTimer = null;
    }
  };

  const clearCardDetectionFrame = () => {
    if (cardDetectionFrameRef) {
      cardDetectionFrameRef.current = null;
    }
  };

  const offerCardDetectionFrame = (frame: CanvasImageSource & { displayWidth?: number; codedWidth?: number; displayHeight?: number; codedHeight?: number }, width: number, height: number) => {
    if (!cardDetectionFrameRef) return;
    if (typeof isCardDetectionFrameEnabled === 'function' && !isCardDetectionFrameEnabled()) return;
    const now = Date.now();
    if (now - lastCardDetectionFrameAt < Math.max(30, cardDetectionFrameIntervalMs)) return;
    const sourceWidth = Math.max(1, Number(width || frame?.displayWidth || frame?.codedWidth || 1));
    const sourceHeight = Math.max(1, Number(height || frame?.displayHeight || frame?.codedHeight || 1));
    const scale = Math.min(1, Math.max(1, cardDetectionFrameMaxWidth) / sourceWidth);
    const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
    const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
    try {
      if (!cardDetectionCanvas) {
        cardDetectionCanvas = document.createElement('canvas');
        cardDetectionCtx = cardDetectionCanvas.getContext('2d', { willReadFrequently: true });
      }
      if (!cardDetectionCanvas || !cardDetectionCtx) return;
      if (cardDetectionCanvas.width !== targetWidth) cardDetectionCanvas.width = targetWidth;
      if (cardDetectionCanvas.height !== targetHeight) cardDetectionCanvas.height = targetHeight;
      cardDetectionCtx.drawImage(frame, 0, 0, targetWidth, targetHeight);
      lastCardDetectionFrameAt = now;
      cardDetectionFrameSequence += 1;
      cardDetectionFrameRef.current = {
        source: 'webcodecs-frame-provider',
        canvas: cardDetectionCanvas,
        width: targetWidth,
        height: targetHeight,
        sourceFrameWidth: sourceWidth,
        sourceFrameHeight: sourceHeight,
        updatedAt: now,
        sequence: cardDetectionFrameSequence,
      };
    } catch (error) {
      console.warn('[WebCodecs] card detection frame copy failed', error);
    }
  };

  const fallback = (reason: string) => {
    if (closed) return;
    diagnostic('preview-closed', { reason });
    closed = true;
    clearFirstFrameTimer();
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
    try {
      worker?.postMessage({ type: 'close' });
    } catch {}
    try {
      worker?.terminate();
    } catch {}
    worker = null;
    try {
      renderer?.dispose();
    } catch {}
    renderer = null;
    clearCardDetectionFrame();
    setWsConnected(false);
    setLastImageAt?.(null);
    onFrameSize?.(null);
    onStatus?.({ mode: 'webcodecs', status: 'fallback', error: reason });
    onFallback?.(reason);
  };

  const start = () => {
    if (closed || worker) return;
    const canvas = canvasRef.current;
    if (!canvas) {
      if (canvasRetryCount < MAX_CANVAS_RETRIES) {
        canvasRetryCount += 1;
        onStatus?.({ mode: 'webcodecs', status: 'waiting-canvas' });
        retryTimer = window.setTimeout(start, 50);
        return;
      }
      fallback('video canvas is not ready');
      return;
    }

    try {
      renderer = createWebCodecsRenderer(canvas);
      diagnostic('webgl-device', renderer.diagnostics);
      worker = new Worker(new URL('./webcodecsVideoWorker.ts', import.meta.url), { type: 'module' });
    } catch (error: unknown) {
      fallback(errorMessage(error, 'WebCodecs preview init failed'));
      return;
    }

    worker.onmessage = (event: MessageEvent) => {
      const msg = asUnknownRecord(event.data);
      if (closed) return;

      if (msg.type === 'fallback') {
        fallback(String(msg.reason || 'WebCodecs preview failed'));
        return;
      }

      if (msg.type === 'status') {
        if (['pipeline-metrics', 'decoder-configured', 'decoder-reconfigure'].includes(String(msg.status))) diagnostic(String(msg.status), msg);
        if (msg.status === 'ws-open') {
          setWsConnected(true);
        } else if (msg.status === 'ws-closed') {
          fallback('encoded WebSocket closed');
          return;
        }
        onStatus?.({
          mode: 'webcodecs',
          status: String(msg.status || ''),
          width: typeof msg.width === 'number' ? msg.width : undefined,
          height: typeof msg.height === 'number' ? msg.height : undefined,
          codec: typeof msg.codec === 'string' ? msg.codec : undefined,
          seq: typeof msg.seq === 'number' ? msg.seq : undefined,
          expectedSeq: typeof msg.expectedSeq === 'number' ? msg.expectedSeq : undefined,
          packets: typeof msg.packets === 'number' ? msg.packets : undefined,
          keyframe: typeof msg.keyframe === 'boolean' ? msg.keyframe : undefined,
          keyframeWaitPackets: typeof msg.keyframeWaitPackets === 'number' ? msg.keyframeWaitPackets : undefined,
          streamGeneration: typeof msg.streamGeneration === 'number' ? msg.streamGeneration : undefined,
          previousStreamGeneration:
            typeof msg.previousStreamGeneration === 'number' ? msg.previousStreamGeneration : undefined,
          decodeQueueSize: typeof msg.decodeQueueSize === 'number' ? msg.decodeQueueSize : undefined,
          decoded: typeof msg.decoded === 'number' ? msg.decoded : undefined,
          dropped: typeof msg.dropped === 'number' ? msg.dropped : undefined,
          error: typeof msg.message === 'string' ? msg.message : undefined,
          probes: msg.probes,
          reason: typeof msg.reason === 'string' ? msg.reason : undefined,
        });
        return;
      }

      if (msg.type === 'frame' && msg.frame && typeof msg.frame === 'object') {
        const frame = msg.frame as WebCodecsFrame;
        try {
          clearFirstFrameTimer();
          const width = Math.max(1, Number(msg.width || canvas.width || 1280));
          const height = Math.max(1, Number(msg.height || canvas.height || 720));
          const renderStarted = performance.now();
          if (lastRenderAt) maxRenderGapMs = Math.max(maxRenderGapMs, renderStarted - lastRenderAt);
          lastRenderAt = renderStarted;
          if (typeof msg.outputEpochMs === 'number') maxWorkerTransferMs = Math.max(maxWorkerTransferMs, performance.timeOrigin + renderStarted - msg.outputEpochMs);
          offerCardDetectionFrame(frame, width, height);
          renderer?.renderFrame(frame);
          maxRenderSubmitMs = Math.max(maxRenderSubmitMs, performance.now() - renderStarted);
          renderCount += 1;
          if (lastMetricAt === previewStartedAt && renderCount === 1) diagnostic('first-render-submitted', { width, height });
          if (renderStarted - lastMetricAt >= 2000) {
            diagnostic('render-metrics', { windowMs: renderStarted - lastMetricAt, renderCount, maxRenderGapMs, maxRenderSubmitMs, maxWorkerTransferMs, visibility: document.visibilityState, hasFocus: document.hasFocus(), note: 'CPU submission timing; not GPU completion or display presentation' });
            lastMetricAt = renderStarted;
            renderCount = maxRenderGapMs = maxRenderSubmitMs = maxWorkerTransferMs = 0;
          }
          frame.close?.();
          onFrameSize?.({ width, height });
          const now = Date.now();
          if (setLastImageAt && now - lastImageAtUpdateTime >= LAST_IMAGE_AT_UPDATE_INTERVAL_MS) {
            lastImageAtUpdateTime = now;
            setLastImageAt(now);
          }
          // Rendering remains frame-rate driven, but React only needs periodic
          // health metrics. Updating top-level state for every 60 FPS frame made
          // the full recording page rerender continuously.
          if (lastFrameStatusAt === 0 || now - lastFrameStatusAt >= LAST_IMAGE_AT_UPDATE_INTERVAL_MS) {
            lastFrameStatusAt = now;
            onStatus?.({
              mode: 'webcodecs',
              status: 'frame',
              width,
              height,
              decoded: typeof msg.decoded === 'number' ? msg.decoded : undefined,
              dropped: typeof msg.dropped === 'number' ? msg.dropped : undefined,
            });
          }
        } catch (error: unknown) {
          try {
            frame.close?.();
          } catch {}
          fallback(errorMessage(error, 'WebGL render failed'));
        }
      }
    };

    worker.onerror = (event) => {
      fallback(event.message || 'WebCodecs worker failed');
    };

    const encodedUrl = `ws://${wsIp}:${wsImagePort}/?stream=encoded`;
    onStatus?.({ mode: 'webcodecs', status: 'connecting' });
    worker.postMessage({ type: 'init', url: encodedUrl });
    firstFrameTimer = window.setTimeout(() => {
      fallback(`encoded preview produced no frame within ${FIRST_FRAME_TIMEOUT_MS / 1000}s`);
    }, FIRST_FRAME_TIMEOUT_MS);
  };

  start();

  return {
    close() {
      if (closed) return;
      diagnostic('preview-closed', { reason: 'controller-close' });
      closed = true;
      clearFirstFrameTimer();
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      try {
        worker?.postMessage({ type: 'close' });
      } catch {}
      try {
        worker?.terminate();
      } catch {}
      worker = null;
      try {
        renderer?.dispose();
      } catch {}
      renderer = null;
      clearCardDetectionFrame();
      setWsConnected(false);
      setLastImageAt?.(null);
      onFrameSize?.(null);
    },
  };
}

export function connectEyeWebSocket(params: {
  wsIp: string;
  wsEyePort: string;
  wsEyeRef: { current: WebSocket | null };
  setEyeData: (updater: EyeDataUpdater) => void;
}): void {
  const { wsIp, wsEyePort, wsEyeRef, setEyeData } = params;
  try {
    const ws = new WebSocket(`ws://${wsIp}:${wsEyePort}/`);
    // Throttle UI state updates to ~20Hz to avoid excessive React re-renders.
    // The SDK fires gaze_callback at 60-120Hz, which would cause 200+ re-renders/sec.
    const EYE_UI_THROTTLE_MS = 50;
    let lastEyeUiUpdate = 0;
    let pendingEyeData: EyeDataUpdater | null = null;
    let eyeRafId: number | null = null;
    let prevMotionPoint: { x: number; y: number; ts: number } | null = null;

    const flushEyeData = () => {
      eyeRafId = null;
      if (pendingEyeData !== null) {
        const data = pendingEyeData;
        pendingEyeData = null;
        setEyeData(data);
      }
    };

    const scheduleEyeUiUpdate = (data: EyeDataUpdater) => {
      const now = performance.now();
      pendingEyeData = data;
      if (now - lastEyeUiUpdate >= EYE_UI_THROTTLE_MS) {
        lastEyeUiUpdate = now;
        flushEyeData();
      } else if (eyeRafId === null) {
        eyeRafId = window.requestAnimationFrame(() => {
          lastEyeUiUpdate = performance.now();
          flushEyeData();
        });
      }
    };

    ws.onmessage = (event) => {
      try {
        const jsonObj = JSON.parse(event.data);
        const tsRaw = jsonObj?.eye_data?.ts ?? jsonObj?.timestamp ?? '';
        const ts = tsRaw === '' || tsRaw == null ? '' : String(tsRaw);
        const tsNumRaw = Number(tsRaw);
        const tsNum = Number.isFinite(tsNumRaw) ? tsNumRaw : performance.now();
        const re = jsonObj?.eye_data?.re_gaze;
        const lg = jsonObj?.eye_data?.l_gaze;
        const rg = jsonObj?.eye_data?.r_gaze;
        const lp = jsonObj?.eye_data?.l_pupil;
        const rp = jsonObj?.eye_data?.r_pupil;
        const le = jsonObj?.eye_data?.l_ex;
        const reye = jsonObj?.eye_data?.r_ex;
        const stats = jsonObj?.eye_data?.stats;
        const v = (x: unknown) => (x === '' || x == null ? '' : String(x));
        const n = (x: unknown) => {
          const value = Number(x);
          return Number.isFinite(value) ? value : NaN;
        };
        const recomX = n(re?.gaze?.x);
        const recomY = n(re?.gaze?.y);
        let gazeVelocityMs = '';
        if (Number.isFinite(recomX) && Number.isFinite(recomY)) {
          if (prevMotionPoint) {
            let dt = tsNum - prevMotionPoint.ts;
            if (dt > 1000 && tsNum > 1_000_000_000) dt /= 1000;
            if (dt > 0) {
              const amplitude = Math.hypot(recomX - prevMotionPoint.x, recomY - prevMotionPoint.y);
              const velocity = amplitude / dt;
              gazeVelocityMs = String(velocity);
              prevMotionPoint = { x: recomX, y: recomY, ts: tsNum };
            } else {
              prevMotionPoint = { x: recomX, y: recomY, ts: tsNum };
            }
          } else {
            prevMotionPoint = { x: recomX, y: recomY, ts: tsNum };
          }
        }
        scheduleEyeUiUpdate((prev) => ({
          ...prev,
          timestamp: ts,
          sourceModel: v(jsonObj?.source),
          recomGazeX: v(re?.gaze?.x),
          recomGazeY: v(re?.gaze?.y),
          recomGazeBitMask: v(re?.gaze_bit_mask),
          recomPointX: v(re?.gaze_point?.x),
          recomPointY: v(re?.gaze_point?.y),
          recomRawX: v(re?.raw?.x),
          recomRawY: v(re?.raw?.y),
          recomSmoothX: v(re?.smooth?.x),
          recomSmoothY: v(re?.smooth?.y),
          leftGazeX: v(lg?.gaze?.x),
          leftGazeY: v(lg?.gaze?.y),
          leftGazeBitMask: v(lg?.gaze_bit_mask),
          leftPointX: v(lg?.gaze_point?.x),
          leftPointY: v(lg?.gaze_point?.y),
          leftRawX: v(lg?.raw?.x),
          leftRawY: v(lg?.raw?.y),
          leftSmoothX: v(lg?.smooth?.x),
          leftSmoothY: v(lg?.smooth?.y),
          rightGazeX: v(rg?.gaze?.x),
          rightGazeY: v(rg?.gaze?.y),
          rightGazeBitMask: v(rg?.gaze_bit_mask),
          rightPointX: v(rg?.gaze_point?.x),
          rightPointY: v(rg?.gaze_point?.y),
          rightRawX: v(rg?.raw?.x),
          rightRawY: v(rg?.raw?.y),
          rightSmoothX: v(rg?.smooth?.x),
          rightSmoothY: v(rg?.smooth?.y),
          leftPupilCenterX: v(lp?.center?.x),
          leftPupilCenterY: v(lp?.center?.y),
          leftPupilDiameter: v(lp?.dia),
          leftPupilDiameterMm: v(lp?.dia_mm),
          rightPupilCenterX: v(rp?.center?.x),
          rightPupilCenterY: v(rp?.center?.y),
          rightPupilDiameter: v(rp?.dia),
          rightPupilDiameterMm: v(rp?.dia_mm),
          leftBlink: v(le?.blink),
          leftOpenness: v(le?.openness),
          leftEyelidUp: v(le?.eyelid_up),
          leftEyelidDown: v(le?.eyelid_down),
          rightBlink: v(reye?.blink),
          rightOpenness: v(reye?.openness),
          rightEyelidUp: v(reye?.eyelid_up),
          rightEyelidDown: v(reye?.eyelid_down),
          fixationTimestampMs: v(stats?.timestamp_ms),
          fixationDurationMs: v(stats?.duration_ms),
          fixationTimestampUs: v(stats?.timestamp_us),
          fixationDurationUs: v(stats?.duration_us),
          fixationCount: v(stats?.count),
          fixationState: v(stats?.state),
          fixationCenterX: v(stats?.center?.x),
          fixationCenterY: v(stats?.center?.y),
          gazeVelocityMs,
          saccadeAmplitude: '',
          saccadeDurationMs: '',
          saccadeVelocity: '',
          saccadePeakVelocity: '',
        }));
      } catch {}
    };
    ws.onclose = () => {
      if (wsEyeRef.current !== ws) return;
      wsEyeRef.current = null;
      if (eyeRafId !== null) {
        window.cancelAnimationFrame(eyeRafId);
        eyeRafId = null;
      }
      pendingEyeData = null;
    };
    ws.onerror = () => {
      if (wsEyeRef.current !== ws) return;
      try {
        ws.close();
      } catch {}
    };
    wsEyeRef.current = ws;
  } catch (e) {
    console.error('Eye WS connection failed:', e);
  }
}

export function connectCmdWebSocket(params: {
  wsIp: string;
  wsCmdPort: string;
  wsCmdRef: { current: WebSocket | null };
  deviceModel?: string;
  calibrationMode?: 'auto' | 'click';

  setCalibrationState: (s: 'none' | 'calibrating' | 'finished') => void;
  setCalibScale: (v: number) => void;
  setCalibrationCoe: (v: string | null) => void;
  setCalibrationScores?: React.Dispatch<React.SetStateAction<CalibrationScores | null>>;
  onCalibrationTrackerReady?: (ready: boolean) => void;
  onTrackingCoeActivated?: (coe: string) => void;
  onDeviceError?: (message: string) => void;
  onRecordingFinalized?: (result: {
    recordingId: string;
    ok: boolean;
    message: string;
    videoPath: string;
    csvPath: string;
    videoSize: number;
    elapsedMs: number;
  }) => void;

  calibStateRef: { current: { arrIndex: number; pointIndex: number; points?: number; pointAttempt?: number; pointPending?: boolean; pointCancelling?: boolean;
      sequenceOverride?: number[]; timerId?: number | null; safetyTimerId?: number | null } };
  processPoint: (arrIdx: number, ptIdx: number) => void;
  advanceCalibration: () => void;
  onCalibrationPointFinished?: (pointIndex: number) => void;
  onCalibrationPointProgress?: (progress: { pointIndex: number; completedCallbacks: number; expectedCallbacks: number; error: number | null; message?: string }) => void;
}): void {
  const {
    wsIp,
    wsCmdPort,
    wsCmdRef,
    deviceModel,
    calibrationMode = 'auto',
    setCalibrationState,
    setCalibScale,
    setCalibrationCoe,
    setCalibrationScores,
    onTrackingCoeActivated,
    onCalibrationTrackerReady,
    onDeviceError,
    onRecordingFinalized,
    calibStateRef,
    processPoint,
    advanceCalibration,
    onCalibrationPointFinished,
    onCalibrationPointProgress,
  } = params;

  const getPhysicalDimensionsInMM = (width: number, height: number) => {
    const dpi = window.devicePixelRatio * 96;
    const physicalWidth = (width / window.devicePixelRatio) * (25.4 / dpi);
    const physicalHeight = (height / window.devicePixelRatio) * (25.4 / dpi);
    return { width: physicalWidth, height: physicalHeight };
  };

  try {
    const ws = new WebSocket(`ws://${wsIp}:${wsCmdPort}/`);
    registerHuahongCalibrationSession(ws, deviceModel, (reason) => {
      if (wsCmdRef.current !== ws) return;
      if (calibStateRef.current.timerId) window.clearTimeout(calibStateRef.current.timerId);
      if (calibStateRef.current.safetyTimerId) window.clearTimeout(calibStateRef.current.safetyTimerId);
      Object.assign(calibStateRef.current, { timerId: null, safetyTimerId: null, pointPending: false,
        pointCancelling: false, pointAttempt: (calibStateRef.current.pointAttempt || 0) + 1 });
      setCalibrationCoe(null);
      setCalibrationScores?.(null);
      onTrackingCoeActivated?.('');
      onCalibrationTrackerReady?.(false);
      if (reason !== 'start') { setCalibrationState('none'); setCalibScale(1); }
    });
    let finishCountForPoint = 0;
    let finishPointIndex: number | null = null;
    let finishPointAttempt: number | null = null;
    let finishedEyesForPoint = new Set<string>();
    let cancelledEyesForPoint = new Set<string>();
    let lastProgressLogKey = '';
    let pupilCalibrationSession: string | null = null;
    let pupilReadySession: string | null = null;
    ws.onopen = () => {
      if (wsCmdRef.current !== ws) return;
      console.log('Command WebSocket Connected');
    };
    ws.onmessage = (event) => {
      if (wsCmdRef.current !== ws) return;
      try {
        const msg = JSON.parse(event.data);
        if (!acceptHuahongCalibrationMessage(ws, msg)) return;
        if (msg?.type === 'rsp_cmd') {
          if (msg.id === 'start_calibration' || msg.id === 'finish_calibration' || msg.id === 'start_calibration_point' || msg.id === 'cancel_calibration' || msg.id === 'cancel_calibration_point' || msg.id === 'complete_calibration') {
            void ipcClient.videoDebugLog({
              event: 'calibration:command-response',
              details: {
                id: msg.id,
                error: msg.error,
                message: msg.msg || '',
                attempt: msg.attempt,
                source: msg.calibration_provider,
                calibrationSession: msg.calibration_session,
                pointPending: msg.point_pending,
                leftError: msg.left_error,
                rightError: msg.right_error,
                cancelError: msg.cancel_error,
                computeLeftError: msg.compute_left_error,
                computeRightError: msg.compute_right_error,
                stopTrackingError: msg.stop_tracking_error,
                completeSdkError: msg.complete_sdk_error,
                scoreError: msg.score_error,
                leftScore: msg.left_score,
                rightScore: msg.right_score ?? msg.right_scroe,
                pupilDiagnostics: msg.pupil_diagnostics,
              },
            });
          }
          console.log('CMD RSP:', msg);
          if (msg.calibration_provider === 'PupilCore' &&
              (msg.id === 'complete_calibration' || msg.id === 'start_calibration_point') &&
              typeof msg.calibration_session === 'string' && msg.calibration_session !== pupilCalibrationSession) return;
          if (msg.id === 'calibration_ready' && msg.calibration_provider === 'PupilCore') {
            const session = typeof msg.calibration_session === 'string' ? msg.calibration_session : null;
            if (msg.error === 0 && session) {
              pupilReadySession = session;
              if (session === pupilCalibrationSession) onCalibrationTrackerReady?.(true);
            }
          } else if (msg.id === 'start_calibration') {
            if (msg.error === 0) {
              if (msg.calibration_provider === 'PupilCore') {
                pupilCalibrationSession = typeof msg.calibration_session === 'string' ? msg.calibration_session : null;
                onCalibrationTrackerReady?.(!msg.tracker_initializing || Boolean(pupilCalibrationSession && pupilReadySession === pupilCalibrationSession));
              }
              setCalibrationState('calibrating');
              
              // Get the calibration sequence based on the number of points
              const totalPoints = calibStateRef.current.points ?? 9;
              const sequences: Record<number, number[]> = {
                1: [4],                 // 1-point: center
                3: [4, 0, 8],           // 3-point: center → top-left → bottom-right
                5: [4, 0, 2, 6, 8],     // 5-point: center → top-left → top-right → bottom-left → bottom-right
                9: [0, 1, 2, 3, 4, 5, 6, 7, 8], // 9-point: sequential order
              };
              const sequence = calibStateRef.current.sequenceOverride || sequences[totalPoints] || sequences[9];
              const firstArrIdx = sequence[0] ?? 4;
              
              calibStateRef.current.arrIndex = firstArrIdx;
              calibStateRef.current.pointIndex = 1;
              finishCountForPoint = 0;
              finishPointIndex = null;
              finishPointAttempt = null;
              finishedEyesForPoint = new Set();
              cancelledEyesForPoint = new Set();

              processPoint(firstArrIdx, 1);
            } else {
              setCalibrationState('none');
              setCalibScale(1.0);
              if (document.fullscreenElement) {
                document.exitFullscreen().catch((err) => console.error(err));
              }
              if (ipcClient.isAvailable()) {
                void ipcClient.setWindowFullScreen({ fullscreen: false });
              }
              alert('校准启动失败: ' + (msg.msg || '未知错误'));
            }
          } else if (msg.id === 'start_calibration_point') {
            if (msg.calibration_provider === 'PupilCore' && (
              !calibStateRef.current.pointPending ||
              Number(msg.index) !== calibStateRef.current.pointIndex ||
              Number(msg.attempt) !== calibStateRef.current.pointAttempt
            )) return;
            if (msg.error !== 0 && calibrationMode === 'click') {
              calibStateRef.current.pointPending = false;
              if (calibStateRef.current.safetyTimerId) {
                window.clearTimeout(calibStateRef.current.safetyTimerId);
                calibStateRef.current.safetyTimerId = null;
              }
              const responseErrorRaw = Number(msg.error);
              onCalibrationPointProgress?.({
                pointIndex: Number(calibStateRef.current.pointIndex || 0),
                completedCallbacks: 0,
                expectedCallbacks: calibrationMode === 'click' ? 2 : 1,
                error: Number.isFinite(responseErrorRaw) ? responseErrorRaw : -1,
                message: msg.calibration_provider === 'PupilCore' ? String(msg.msg || '') : undefined,
              });
            } else if (calibrationMode === 'click' && !msg.point_pending) {
              // Match the vendor sample: point selection drives the sequence.
              // Do not wait for left/right finish callbacks before accepting the
              // next point or scheduling the final three-second delay.
              onCalibrationPointFinished?.(Number(calibStateRef.current.pointIndex || 0));
              advanceCalibration();
            }
          } else if (msg.id === 'cancel_calibration_point') {
            const currentAttempt = Number(calibStateRef.current.pointAttempt ?? 0);
            const responseAttempt = Number(msg.attempt ?? currentAttempt);
            if (responseAttempt !== currentAttempt) {
              void ipcClient.videoDebugLog({
                event: 'calibration:stale-point-cancel-response-ignored',
                details: { responseAttempt, currentAttempt, error: msg.error },
              });
            } else {
              const responseErrorRaw = Number(msg.error);
              const responseError = Number.isFinite(responseErrorRaw) ? responseErrorRaw : -1;
              const leftError = Number(msg.left_error);
              const rightError = Number(msg.right_error);
              const bothEyesCancelled = responseError === 0 && leftError === 0 && rightError === 0;
              if (bothEyesCancelled) {
                if (!calibStateRef.current.pointCancelling) {
                  void ipcClient.videoDebugLog({
                    event: 'calibration:point-cancel-response-after-confirmation',
                    details: { pointAttempt: currentAttempt, leftError, rightError },
                  });
                  return;
                }
                calibStateRef.current.pointCancelling = false;
                calibStateRef.current.pointPending = false;
                finishCountForPoint = 0;
                finishPointIndex = null;
                finishPointAttempt = null;
                finishedEyesForPoint = new Set();
                cancelledEyesForPoint = new Set();
                void ipcClient.videoDebugLog({
                  event: 'calibration:point-cancel-confirmed',
                  details: { pointAttempt: currentAttempt, source: 'sdk-return', leftError, rightError },
                });
                onCalibrationPointProgress?.({
                  pointIndex: Number(calibStateRef.current.pointIndex || 0),
                  completedCallbacks: 0,
                  expectedCallbacks: calibrationMode === 'click' ? 2 : 1,
                  error: -2,
                });
              } else {
                calibStateRef.current.pointCancelling = false;
                calibStateRef.current.pointPending = false;
                onCalibrationPointProgress?.({
                  pointIndex: Number(calibStateRef.current.pointIndex || 0),
                  completedCallbacks: 0,
                  expectedCallbacks: calibrationMode === 'click' ? 2 : 1,
                  error: responseError !== 0 ? responseError : (leftError !== 0 ? leftError : rightError),
                });
              }
            }
          } else if (msg.id === 'cancel_calibration') {
            pupilCalibrationSession = null;
            pupilReadySession = null;
            onCalibrationTrackerReady?.(false);
          } else if (msg.id === 'complete_calibration') {
            if (msg.error === 0 && msg.calibration_provider === 'PupilCore' && !calibStateRef.current.pointPending) return;
            if (msg.error === 0 && msg.result_pending) return;
            if (msg.error === 0) {
              setCalibrationCoe(msg.coe || null);
              const trackingErrRaw = msg.tracking_error;
              const trackingErr = typeof trackingErrRaw === 'number' ? trackingErrRaw : Number(trackingErrRaw);
              const trackingOk = Number.isFinite(trackingErr) ? trackingErr === 0 : true;
              if (trackingOk && msg.coe) {
                onTrackingCoeActivated?.(String(msg.coe));
              }
              setCalibrationScores?.((previous) => calibrationScoresFromCompletion(previous, msg));
              setCalibrationState('finished');
              setCalibScale(1.0);
              if (!trackingOk) {
                alert(`校准成功，但追踪未启动（${msg.tracking_msg || trackingErr}）。请重试校准或重新启动设备。`);
              } else {
                alert(msg.calibration_provider === 'PupilCore'
                  ? msg.validation || msg.training_angular ? String(msg.msg) : `${msg.score_semantics === 'training_reprojection_error_px' ? '左右眼数值为校准训练平均重投影误差（像素，越小越好），不是独立精度得分。\n' : ''}校准拟合完成。请点击校准测试采样独立目标，验证实际偏差。`
                  : '校准成功');
              }
            } else {
              pupilCalibrationSession = null;
              pupilReadySession = null;
              onCalibrationTrackerReady?.(false);
              if (msg.calibration_provider === 'PupilCore') setCalibrationCoe(null);
              setCalibrationState('none');
              setCalibScale(1.0);
              if (document.fullscreenElement) {
                document.exitFullscreen().catch((err) => console.error(err));
              }
              if (ipcClient.isAvailable()) {
                void ipcClient.setWindowFullScreen({ fullscreen: false });
              }
              alert('校准失败: ' + (msg.msg || '未知错误'));
            }
          }
        } else if (msg?.type === 'notify_device_error' && ['PupilCore', 'HH_ET10C', 'HH_ET28'].includes(msg.source)) {
          void ipcClient.videoDebugLog({
            event: 'eye:device-error',
            details: { source: msg.source, message: msg.msg || '' },
          });
          onDeviceError?.(String(msg.msg || 'Pupil Capture connection failed'));
        } else if (msg?.type === 'notify_recording_finalized') {
          const error = Number(msg?.error ?? -1);
          const result = {
            recordingId: String(msg?.recording_id || ''),
            ok: error === 0,
            message: String(msg?.msg || (error === 0 ? 'ok' : '录制文件保存失败')),
            videoPath: String(msg?.video_path || ''),
            csvPath: String(msg?.csv_path || ''),
            videoSize: Number(msg?.video_size || 0),
            elapsedMs: Number(msg?.elapsed_ms || 0),
          };
          void ipcClient.videoDebugLog({
            event: 'recording:finalized',
            details: result,
          });
          onRecordingFinalized?.(result);
        } else if (msg?.type === 'notify_progress') {
          if (typeof msg.percent === 'number') {
            const progressPointIndex = Number(msg?.index ?? calibStateRef.current.pointIndex ?? -1);
            const progressAttempt = Number(calibStateRef.current.pointAttempt ?? 0);
            const progressBucket = Math.max(0, Math.min(100, Math.floor(msg.percent / 10) * 10));
            const progressLogKey = `${progressPointIndex}:${progressAttempt}:${progressBucket}`;
            if (progressLogKey !== lastProgressLogKey) {
              lastProgressLogKey = progressLogKey;
              void ipcClient.videoDebugLog({
                event: 'calibration:point-progress',
                details: {
                  pointIndex: progressPointIndex,
                  pointAttempt: progressAttempt,
                  percent: msg.percent,
                  calibrationMode,
                },
              });
            }
            const scale = (100 - msg.percent) * 0.01;
            setCalibScale(scale);
            // Desktop SDKs have two valid completion patterns: some points emit
            // notify_finish around 95%, while others only report 100% progress.
            // Accept either signal exactly once so 100%-complete points do not
            // wait for the eight-second safety timeout.
            if (
              calibrationMode === 'auto' &&
              msg.percent >= 100 &&
              Boolean(calibStateRef.current.pointPending)
            ) {
              void ipcClient.videoDebugLog({
                event: 'calibration:point-completed-by-progress',
                details: {
                  pointIndex: Number(calibStateRef.current.pointIndex ?? -1),
                  pointAttempt: Number(calibStateRef.current.pointAttempt ?? 0),
                  percent: msg.percent,
                },
              });
              onCalibrationPointFinished?.(Number(calibStateRef.current.pointIndex || 0));
              advanceCalibration();
            }
          }
        } else if (msg?.type === 'notify_finish') {
          void ipcClient.videoDebugLog({
            event: 'calibration:point-finish-received',
            details: {
              notifyIndex: Number(msg?.index ?? -1),
              notifyAttempt: msg?.attempt ?? null,
              currentPointIndex: Number(calibStateRef.current.pointIndex ?? -1),
              currentAttempt: Number(calibStateRef.current.pointAttempt ?? 0),
              error: Number(msg?.error ?? 0),
              message: msg.msg || '',
              source: msg.source || '',
              calibrationSession: msg.calibration_session,
              calibrationInvalidated: msg.calibration_invalidated === true,
              eye: msg?.eye || '',
              pending: Boolean(calibStateRef.current.pointPending),
              calibrationMode,
            },
          });
          if (msg.source === 'HH_ET10C' || msg.source === 'HH_ET28') {
            if (!calibStateRef.current.pointPending || Number(msg.attempt) !== Number(calibStateRef.current.pointAttempt)
              || Number(msg.index) !== Number(calibStateRef.current.pointIndex)) return;
            if (msg.error !== 0) {
              calibStateRef.current.pointPending = false;
              if (calibStateRef.current.safetyTimerId) {
                window.clearTimeout(calibStateRef.current.safetyTimerId);
                calibStateRef.current.safetyTimerId = null;
              }
              onCalibrationPointProgress?.({ pointIndex: Number(msg.index), completedCallbacks: 0, expectedCallbacks: 1, error: Number(msg.error) });
              alert('华弘单点校准失败：' + String(msg.msg || msg.error));
              if (msg.calibration_invalidated === true) invalidateHuahongCalibrationSession(ws, 'failure');
              return;
            }
            onCalibrationPointFinished?.(Number(msg.index));
            advanceCalibration();
            return;
          }
          const pending = Boolean(calibStateRef.current.pointPending);
          if (!pending) {
            if (Number(msg?.error) === -2) {
              void ipcClient.videoDebugLog({
                event: 'calibration:late-point-cancel-callback-ignored',
                details: {
                  notifyIndex: Number(msg?.index ?? -1),
                  notifyAttempt: Number(msg?.attempt ?? -1),
                  currentAttempt: Number(calibStateRef.current.pointAttempt ?? 0),
                  eye: msg?.eye || '',
                },
              });
            }
            finishCountForPoint = 0;
            finishPointIndex = null;
            finishPointAttempt = null;
            finishedEyesForPoint = new Set();
            cancelledEyesForPoint = new Set();
            return;
          }
          const expectedFinishCallbacks = calibrationMode === 'click' ? 2 : 1;
          if (expectedFinishCallbacks > 1) {
            const pointAttempt = Number(calibStateRef.current.pointAttempt ?? 0);
            const notifyAttemptRaw = Number(msg?.attempt ?? pointAttempt);
            const notifyAttempt = Number.isFinite(notifyAttemptRaw) ? notifyAttemptRaw : pointAttempt;
            const idxRaw = Number(msg?.index ?? NaN);
            const idx = Number.isFinite(idxRaw) ? idxRaw : -1;
            if (notifyAttempt !== pointAttempt) {
              void ipcClient.videoDebugLog({
                event: 'calibration:stale-point-finish-ignored',
                details: { notifyIndex: idx, notifyAttempt, pointAttempt, eye: msg?.eye || '' },
              });
              return;
            }
            if (finishPointIndex !== idx || finishPointAttempt !== pointAttempt) {
              finishPointIndex = idx;
              finishPointAttempt = pointAttempt;
              finishCountForPoint = 0;
              finishedEyesForPoint = new Set();
            }
            const eye = typeof msg?.eye === 'string' ? msg.eye : '';
            const finishErrorRaw = Number(msg?.error);
            const finishError = Number.isFinite(finishErrorRaw) ? finishErrorRaw : null;
            if (calibStateRef.current.pointCancelling) {
              if (finishError === -2 && eye) cancelledEyesForPoint.add(eye);
              void ipcClient.videoDebugLog({
                event: 'calibration:point-cancel-progress',
                details: {
                  notifyIndex: idx,
                  pointAttempt,
                  eye,
                  error: finishError,
                  cancelledEyes: Array.from(cancelledEyesForPoint),
                  expectedEyes: ['left', 'right'],
                },
              });
              if (!cancelledEyesForPoint.has('left') || !cancelledEyesForPoint.has('right')) return;
              calibStateRef.current.pointCancelling = false;
              calibStateRef.current.pointPending = false;
              finishCountForPoint = 0;
              finishPointIndex = null;
              finishPointAttempt = null;
              finishedEyesForPoint = new Set();
              cancelledEyesForPoint = new Set();
              onCalibrationPointProgress?.({
                pointIndex: Number(calibStateRef.current.pointIndex || 0),
                completedCallbacks: 0,
                expectedCallbacks: expectedFinishCallbacks,
                error: -2,
              });
              return;
            }
            if (eye && finishedEyesForPoint.has(eye)) {
              void ipcClient.videoDebugLog({
                event: 'calibration:duplicate-eye-finish-ignored',
                details: { notifyIndex: idx, pointAttempt, eye },
              });
              return;
            }
            if (eye) finishedEyesForPoint.add(eye);
            finishCountForPoint += 1;
            onCalibrationPointProgress?.({
              pointIndex: Number(calibStateRef.current.pointIndex || 0),
              completedCallbacks: finishCountForPoint,
              expectedCallbacks: expectedFinishCallbacks,
              error: finishError,
            });
            void ipcClient.videoDebugLog({
              event: 'calibration:point-finish-progress',
              details: {
                notifyIndex: idx,
                pointIndex: Number(calibStateRef.current.pointIndex || 0),
                pointAttempt,
                eye,
                completedCallbacks: finishCountForPoint,
                expectedCallbacks: expectedFinishCallbacks,
                error: finishError,
              },
            });
            if (finishError !== null && finishError !== 0 && calibrationMode !== 'click') {
              if (calibStateRef.current.safetyTimerId) {
                window.clearTimeout(calibStateRef.current.safetyTimerId);
                calibStateRef.current.safetyTimerId = null;
              }
              calibStateRef.current.pointCancelling = true;
              const cancelPayload = {
                type: 'req_cmd',
                id: 'cancel_calibration_point',
                args: { index: idx, attempt: pointAttempt },
              };
              try {
                ws.send(JSON.stringify(cancelPayload));
                void ipcClient.videoDebugLog({
                  event: 'calibration:point-error-cancel-command-sent',
                  details: { pointIndex: idx, pointAttempt, eye, error: finishError },
                });
              } catch {
                calibStateRef.current.pointCancelling = false;
                calibStateRef.current.pointPending = false;
              }
              finishCountForPoint = 0;
              finishPointIndex = null;
              finishPointAttempt = null;
              finishedEyesForPoint = new Set();
              cancelledEyesForPoint = new Set();
              return;
            }
            console.log('CALIB FINISH', {
              calibrationMode,
              pointIndex: idx,
              pointAttempt,
              finishCountForPoint,
              expectedFinishCallbacks,
            });
            if (finishCountForPoint < expectedFinishCallbacks || calibrationMode === 'click') {
              return;
            }
            finishCountForPoint = 0;
            finishPointIndex = null;
            finishPointAttempt = null;
            finishedEyesForPoint = new Set();
            cancelledEyesForPoint = new Set();
          }
          onCalibrationPointFinished?.(Number(calibStateRef.current.pointIndex || 0));
          advanceCalibration();
        }
      } catch (e) {
        console.log('CMD MSG:', event.data);
      }
    };
    ws.onclose = () => {
      if (wsCmdRef.current !== ws) return;
      invalidateHuahongCalibrationSession(ws);
      wsCmdRef.current = null;
      console.log('Command WebSocket Closed');
    };
    ws.onerror = (err) => {
      if (wsCmdRef.current !== ws) return;
      invalidateHuahongCalibrationSession(ws);
      console.error('Command WebSocket Error:', err);
      try {
        ws.close();
      } catch {}
    };
    wsCmdRef.current = ws;
  } catch (e) {
    console.error('Cmd connection failed:', e);
  }
}

export function closeWebSocketRef(ref: { current: WebSocket | null }): void {
  const ws = ref.current;
  if (!ws) return;
  // Invalidate first so late close/error events from this socket cannot mutate
  // the state or reference belonging to a newer connection.
  invalidateHuahongCalibrationSession(ws);
  ref.current = null;
  ws.close();
}
