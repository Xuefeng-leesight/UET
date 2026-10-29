import { ipcClient } from '@/infrastructure/electron/ipcClient';
import type { SendTriggerResult } from '@/infrastructure/electron/ipcTypes';
import { alignCommunicationClock, type MainClockObservation, type SourceClockObservation } from '@shared/domain/communicationClock';
import type { CommunicationBatchResult, RecordingCommunicationContext, TriggerNetworkConfig } from '@shared/contracts/ipc/communication';

type CommandResult = { ok: boolean; error?: string; response?: Record<string, unknown> };
type Command = (id: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<CommandResult>;
type CommunicationPort = Pick<typeof ipcClient,
  'readRecordingCommunicationClock' | 'configureRecordingCommunication' | 'readRecordingCommunication' | 'flushStopRecordingCommunication'>;
type Session = {
  context: RecordingCommunicationContext;
  command: Command;
  port: CommunicationPort;
  onError: (message: string) => void;
  pending: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  errorMessages: Set<string>;
  finish: Promise<void> | null;
};

/** One owner per renderer. Actual bytes are durably journalled in the main process before delivery here. */
export function createRecordingCommunicationBridge(port: CommunicationPort, now = () => performance.now()) {
  let session: Session | null = null;
  let starting: { cancelled: boolean; done: Promise<void> } | null = null;
  const report = (current: Session, message: string) => {
    if (!message || current.errorMessages.has(message)) return;
    current.errorMessages.add(message);
    current.onError(message);
  };
  const deliver = async (current: Session, batch: CommunicationBatchResult): Promise<void> => {
    while (true) {
      if (batch.ok === false) throw new Error(batch.message);
      for (const error of batch.errors) report(current, error);
      if (!batch.events.length) return;
      const ackEventIds: string[] = [];
      for (const event of batch.events) {
        if (event.recordingId !== current.context.recordingId || event.generation !== current.context.generation) {
          throw new Error('通信事件会话不匹配，已停止写入');
        }
        const result = await current.command('record_communication', {
          recording_id: event.recordingId, generation: event.generation,
          event_id: event.eventId, channel: event.channel,
          text: event.payloadEnvelope, video_time_ms: event.videoTimeMs,
        }, 1500);
        if (!result.ok) throw new Error(result.error || '通信日志确认失败');
        ackEventIds.push(event.eventId);
      }
      batch = await port.readRecordingCommunication({ context: current.context, ackEventIds, maxEvents: 100 });
      // Do not monopolize the command queue while a continuous receive stream is active.
      if (!current.stopped) return;
    }
  };
  const poll = (current: Session) => {
    current.pending = current.pending.then(async () => {
      if (current.stopped || session !== current) return;
      await deliver(current, await port.readRecordingCommunication({ context: current.context, maxEvents: 100 }));
    }).catch(error => report(current, `通信日志转交暂未确认；本地日志已保留。${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        if (!current.stopped && session === current) current.timer = setTimeout(() => poll(current), 100);
      });
  };
  const finishSession = async (current: Session): Promise<void> => {
    if (current.finish) return current.finish;
    current.stopped = true;
    if (current.timer !== null) clearTimeout(current.timer);
    current.finish = (async () => {
      // Close actual I/O before stopping the backend. Finalization/recovery also
      // reads the capture journal if the command channel has disappeared.
      const batch = await port.flushStopRecordingCommunication({ context: current.context });
      if (batch.ok === false) throw new Error(batch.message);
      await current.pending;
      try { await deliver(current, batch); }
      catch (error) {
        report(current, `通信转交未确认；录制保存时将从本地通信日志恢复。${error instanceof Error ? error.message : String(error)}`);
      }
      if (session === current) session = null;
    })();
    try { await current.finish; }
    catch (error) {
      current.finish = null;
      throw error;
    }
  };

  return {
    isActive: () => session !== null && !session.stopped,
    hasSession: () => session !== null || starting !== null,
    async start(options: {
      recordingId: string; journalPath: string; config: TriggerNetworkConfig;
      command: Command; isCurrent?: () => boolean; onError: (message: string) => void;
    }) {
      if (session || starting) throw new Error('上一次通信记录尚未停止');
      let resolveStart!: () => void;
      const token = { cancelled: false, done: new Promise<void>(resolve => { resolveStart = resolve; }) };
      starting = token;
      try {
      const sources: SourceClockObservation[] = [];
      const mains: MainClockObservation[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (token.cancelled) throw new Error('录制已取消，通信未启动');
        const beforeMs = now();
        const result = await options.command('get_source_clock', {}, 1500);
        const afterMs = now();
        if (!result.ok || !result.response) throw new Error(result.error || '无法读取录制源时钟');
        const value = result.response;
        sources.push({ beforeMs, afterMs, sourceTimeS: Number(value.source_time_s),
          sourceTimeOriginS: Number(value.source_time_origin_s), recordingId: String(value.recording_id || ''),
          generation: Number(value.generation) });
        const mainBefore = now();
        const clock = await port.readRecordingCommunicationClock();
        const mainAfter = now();
        if (clock.ok === false) throw new Error(clock.message);
        mains.push({ beforeMs: mainBefore, afterMs: mainAfter, mainMonotonicMs: clock.mainMonotonicMs });
      }
      if (token.cancelled || (options.isCurrent && !options.isCurrent())) throw new Error('录制已取消，通信未启动');
      const alignment = alignCommunicationClock(options.recordingId, sources, mains);
      const context = { recordingId: options.recordingId, journalPath: options.journalPath, ...alignment };
      const current: Session = { context, command: options.command, port, onError: options.onError,
        pending: Promise.resolve(), timer: null, stopped: false, errorMessages: new Set(), finish: null };
      let configured: Awaited<ReturnType<CommunicationPort['configureRecordingCommunication']>>;
      try { configured = await port.configureRecordingCommunication({ context, config: options.config }); }
      catch (error) { session = current; throw error; } // Unknown IPC outcome may have opened actual ports.
      if (configured.ok === false) {
        if (configured.cleanupPending !== false) session = current;
        throw new Error(configured.message);
      }
      session = current;
      if (token.cancelled || (options.isCurrent && !options.isCurrent())) {
        // Do not call public finish here: it waits for this start operation.
        await finishSession(current);
        throw new Error('录制已取消，通信已停止');
      }
      poll(current);
      } finally {
        if (starting === token) starting = null;
        resolveStart();
      }
    },
    async finish(): Promise<void> {
      const pendingStart = starting;
      if (pendingStart) {
        pendingStart.cancelled = true;
        await pendingStart.done;
      }
      const current = session;
      if (!current) return;
      await finishSession(current);
    },
  };
}

const bridge = createRecordingCommunicationBridge(ipcClient);
export const startRecordingCommunication = bridge.start.bind(bridge);
export const finishRecordingCommunication = bridge.finish.bind(bridge);
export const isRecordingCommunicationActive = bridge.isActive;

export async function sendRecordingTriggerMark(config: TriggerNetworkConfig, mark: number): Promise<SendTriggerResult> {
  if (bridge.isActive()) return ipcClient.sendRecordingTrigger({ mark });
  if (bridge.hasSession()) return { ok: false, message: '录制通信正在停止，未发送新的触发数据' };
  // Preserve the established SDK UDP path. Serial journalling requires the
  // recording context/clock established above, so never pretend it was sent.
  if (config.enabled) return ipcClient.sendUdpTrigger({ targetIp: config.targetIp, port: config.udpSendPort, mark });
  return { ok: false, message: '当前录制尚未建立串口通信会话' };
}
