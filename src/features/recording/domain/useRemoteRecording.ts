import React from 'react';
import { closeWebSocketRef } from '@/features/recording/domain/recordingWsModule';
import { extractRemoteRecordingState } from '@/features/recording/domain/remoteRecordingProtocol';

export type RemoteRecordingCommand = 'recording.start' | 'recording.stop';

const REMOTE_SYNC_WS_PORT = '9004';
const REMOTE_RECORDING_COMMAND_TIMEOUT_MS = 4000;

type UseRemoteRecordingOptions = {
  remoteIp: string;
  recordingViewMode: 'local' | 'monitor' | 'remote' | null | undefined;
};

type PendingRemoteCommand = {
  type: RemoteRecordingCommand;
  timerId: number;
  resolve: () => void;
  reject: (error: Error) => void;
};

function asMessageRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseSignalMessage(data: unknown): Record<string, unknown> | null {
  if (typeof data !== 'string') return null;
  return asMessageRecord(JSON.parse(data));
}

function getRemoteResultMessage(message: Record<string, unknown>): string | undefined {
  for (const key of ['message', 'error'] as const) {
    const value = message[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function getRemoteCommandFallback(type: RemoteRecordingCommand): string {
  return type === 'recording.start'
    ? '远程录制未收到移动端确认，请检查移动端'
    : '远程停止录制未收到移动端确认，请检查移动端';
}

function preferH264(transceiver: RTCRtpTransceiver) {
  try {
    const codecs = RTCRtpSender.getCapabilities?.('video')?.codecs || [];
    const h264 = codecs.filter((codec) => /H264/i.test(codec.mimeType));
    const rest = codecs.filter((codec) => !/H264/i.test(codec.mimeType));
    if (h264.length > 0) transceiver.setCodecPreferences([...h264, ...rest]);
  } catch (error) {
    console.warn('[RecordingPage] set H264 preference failed:', error);
  }
}

export function useRemoteRecording({ remoteIp, recordingViewMode }: UseRemoteRecordingOptions) {
  const remoteVideoRef = React.useRef<HTMLVideoElement | null>(null);
  const remoteSignalWsRef = React.useRef<WebSocket | null>(null);
  const remotePeerRef = React.useRef<RTCPeerConnection | null>(null);
  const remoteFrameRafRef = React.useRef<number | null>(null);
  const remoteLastVideoTimeRef = React.useRef(0);
  const remoteCommandPendingRef = React.useRef<PendingRemoteCommand | null>(null);
  const [remoteSignalConnected, setRemoteSignalConnected] = React.useState(false);
  const [remoteMediaConnected, setRemoteMediaConnected] = React.useState(false);
  const [remoteFrameLastAt, setRemoteFrameLastAt] = React.useState<number | null>(null);
  const [remoteRecordingActive, setRemoteRecordingActive] = React.useState(false);
  const [remoteCommandBusy, setRemoteCommandBusy] = React.useState(false);

  const resolvePendingRemoteCommand = React.useCallback(
    (type: RemoteRecordingCommand, ok: boolean, message?: string) => {
      const pending = remoteCommandPendingRef.current;
      if (!pending || pending.type !== type) return false;
      window.clearTimeout(pending.timerId);
      remoteCommandPendingRef.current = null;
      if (ok) pending.resolve();
      else pending.reject(new Error(message || '远程录制未收到移动端确认，请检查移动端'));
      return true;
    },
    [],
  );

  const rejectPendingRemoteCommand = React.useCallback((message: string) => {
    const pending = remoteCommandPendingRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timerId);
    remoteCommandPendingRef.current = null;
    pending.reject(new Error(message));
  }, []);

  const syncRemoteRecordingState = React.useCallback((message: unknown) => {
    const nextState = extractRemoteRecordingState(message);
    if (typeof nextState === 'boolean') setRemoteRecordingActive(nextState);
    return nextState;
  }, []);

  const waitForRemoteCommandResult = React.useCallback((type: RemoteRecordingCommand) => {
    if (remoteCommandPendingRef.current) {
      return Promise.reject(new Error('远程命令正在处理中，请稍后重试'));
    }
    return new Promise<void>((resolve, reject) => {
      const timerId = window.setTimeout(() => {
        if (remoteCommandPendingRef.current?.type !== type) return;
        remoteCommandPendingRef.current = null;
        reject(new Error(getRemoteCommandFallback(type)));
      }, REMOTE_RECORDING_COMMAND_TIMEOUT_MS);
      remoteCommandPendingRef.current = { type, timerId, resolve, reject };
    });
  }, []);

  const stopRemoteFrameWatch = React.useCallback(() => {
    if (remoteFrameRafRef.current === null) return;
    window.cancelAnimationFrame(remoteFrameRafRef.current);
    remoteFrameRafRef.current = null;
  }, []);

  const closeRemoteWebRtc = React.useCallback(() => {
    rejectPendingRemoteCommand('远程连接已断开，请检查移动端');
    closeWebSocketRef(remoteSignalWsRef);
    try {
      remotePeerRef.current?.close();
    } catch {}
    remotePeerRef.current = null;
    stopRemoteFrameWatch();
    setRemoteSignalConnected(false);
    setRemoteMediaConnected(false);
    setRemoteFrameLastAt(null);
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
  }, [rejectPendingRemoteCommand, stopRemoteFrameWatch]);

  const startRemoteFrameWatch = React.useCallback(() => {
    stopRemoteFrameWatch();
    remoteLastVideoTimeRef.current = remoteVideoRef.current?.currentTime || 0;
    const tick = () => {
      const current = remoteVideoRef.current;
      if (current && !current.paused && !current.ended && current.readyState >= 2) {
        const nextTime = current.currentTime || 0;
        if (Math.abs(nextTime - remoteLastVideoTimeRef.current) > 0.001) {
          remoteLastVideoTimeRef.current = nextTime;
          setRemoteFrameLastAt(Date.now());
        }
      }
      remoteFrameRafRef.current = window.requestAnimationFrame(tick);
    };
    remoteFrameRafRef.current = window.requestAnimationFrame(tick);
  }, [stopRemoteFrameWatch]);

  const connectRemotePreview = React.useCallback(async () => {
    const targetIp = remoteIp.trim();
    if (!targetIp) return;
    closeRemoteWebRtc();

    try {
      const ws = new WebSocket(`ws://${targetIp}:${REMOTE_SYNC_WS_PORT}/`);
      remoteSignalWsRef.current = ws;
      const pendingRemoteIce: RTCIceCandidateInit[] = [];
      const pc = new RTCPeerConnection({ iceServers: [] });
      const flushRemoteIce = async () => {
        while (pendingRemoteIce.length > 0) {
          const candidate = pendingRemoteIce.shift();
          if (candidate) await pc.addIceCandidate(candidate);
        }
      };

      remotePeerRef.current = pc;
      preferH264(pc.addTransceiver('video', { direction: 'recvonly' }));

      const sendSignal = (payload: Record<string, unknown>) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) sendSignal({ type: 'webrtc.ice', candidate: event.candidate.toJSON() });
      };
      pc.ontrack = (event) => {
        const stream = event.streams[0] || new MediaStream([event.track]);
        const video = remoteVideoRef.current;
        if (video) {
          video.srcObject = stream;
          void video.play().catch(() => {});
        }
        setRemoteMediaConnected(true);
        setRemoteFrameLastAt(Date.now());
        startRemoteFrameWatch();
      };
      pc.onconnectionstatechange = () => {
        if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
          setRemoteMediaConnected(false);
        }
      };

      ws.onopen = async () => {
        setRemoteSignalConnected(true);
        sendSignal({ type: 'client.hello', mode: recordingViewMode, role: 'viewer' });
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal({ type: 'webrtc.offer', sdp: offer.sdp });
      };
      ws.onmessage = async (event) => {
        try {
          const message = parseSignalMessage(event.data);
          if (!message) return;
          if (message.type === 'webrtc.answer' && typeof message.sdp === 'string') {
            await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
            await flushRemoteIce();
            return;
          }
          if (message.type === 'webrtc.offer' && typeof message.sdp === 'string') {
            await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
            await flushRemoteIce();
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendSignal({ type: 'webrtc.answer', sdp: answer.sdp });
            return;
          }
          if (message.type === 'webrtc.ice' && message.candidate) {
            const candidate = message.candidate as RTCIceCandidateInit;
            if (pc.remoteDescription) await pc.addIceCandidate(candidate);
            else pendingRemoteIce.push(candidate);
            return;
          }
          if (message.type === 'recording.result') {
            const command = message.command;
            syncRemoteRecordingState(message);
            if (command === 'recording.start' || command === 'recording.stop') {
              resolvePendingRemoteCommand(command, message.ok === true, getRemoteResultMessage(message));
            }
            return;
          }
          syncRemoteRecordingState(message);
        } catch (error) {
          console.warn('[RecordingPage] remote signaling message failed:', error);
        }
      };
      ws.onclose = () => {
        setRemoteSignalConnected(false);
        setRemoteMediaConnected(false);
        rejectPendingRemoteCommand('远程连接已断开，请检查移动端');
      };
      ws.onerror = () => {
        setRemoteSignalConnected(false);
        rejectPendingRemoteCommand('远程连接异常，请检查移动端');
      };
    } catch (error) {
      console.warn('[RecordingPage] remote media connect failed:', error);
      closeRemoteWebRtc();
    }
  }, [closeRemoteWebRtc, recordingViewMode, remoteIp, startRemoteFrameWatch, resolvePendingRemoteCommand, rejectPendingRemoteCommand, syncRemoteRecordingState]);

  const sendRemoteRecordingCommand = React.useCallback(
    async (type: RemoteRecordingCommand) => {
      if (!remoteIp.trim() || remoteCommandBusy) return;
      setRemoteCommandBusy(true);
      try {
        const ws = remoteSignalWsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type }));
          await waitForRemoteCommandResult(type);
        } else {
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            const transientWs = new WebSocket(`ws://${remoteIp}:${REMOTE_SYNC_WS_PORT}/`);
            const timer = window.setTimeout(() => finish(new Error(getRemoteCommandFallback(type))), REMOTE_RECORDING_COMMAND_TIMEOUT_MS);
            const finish = (error?: Error) => {
              if (settled) return;
              settled = true;
              window.clearTimeout(timer);
              try {
                transientWs.close();
              } catch {}
              if (error) reject(error);
              else resolve();
            };
            transientWs.onopen = () => transientWs.send(JSON.stringify({ type }));
            transientWs.onmessage = (event) => {
              try {
                const message = parseSignalMessage(event.data);
                if (!message) return;
                if (message.type !== 'recording.result' || message.command !== type) {
                  syncRemoteRecordingState(message);
                  return;
                }
                if (message.ok === true) {
                  setRemoteRecordingActive(type === 'recording.start');
                  finish();
                  return;
                }
                finish(new Error(getRemoteResultMessage(message) || getRemoteCommandFallback(type)));
              } catch (error) {
                finish(error instanceof Error ? error : new Error('远程命令响应解析失败'));
              }
            };
            transientWs.onerror = () => finish(new Error('远程命令连接失败'));
            transientWs.onclose = () => finish(new Error(getRemoteCommandFallback(type)));
          });
        }
      } catch (error) {
        console.warn('[RecordingPage] remote recording command failed:', error);
        window.alert(error instanceof Error && error.message ? error.message : '远程录制未收到移动端确认，请检查移动端');
      } finally {
        setRemoteCommandBusy(false);
      }
    },
    [remoteCommandBusy, remoteIp, syncRemoteRecordingState, waitForRemoteCommandResult],
  );

  React.useEffect(() => {
    if (recordingViewMode === 'monitor' || recordingViewMode === 'remote') return;
    closeRemoteWebRtc();
    setRemoteRecordingActive(false);
  }, [closeRemoteWebRtc, recordingViewMode]);

  React.useEffect(() => () => {
    closeWebSocketRef(remoteSignalWsRef);
    try {
      remotePeerRef.current?.close();
    } catch {}
    stopRemoteFrameWatch();
  }, [stopRemoteFrameWatch]);

  return {
    remoteVideoRef,
    remoteSignalConnected,
    remoteMediaConnected,
    remoteFrameLastAt,
    remoteRecordingActive,
    remoteCommandBusy,
    connectRemotePreview,
    sendRemoteRecordingCommand,
  };
}
