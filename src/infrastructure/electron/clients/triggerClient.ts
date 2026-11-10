import type { TriggerNetworkConfig, CommunicationClockResult, ConfigureCommunicationPayload, ConfigureCommunicationResult, ReadCommunicationPayload, CommunicationBatchResult, SendRecordingTriggerPayload, ListSerialPortsResult } from '@shared/contracts/ipc/communication';
import { invokeSafe, invokeSafeNoPayload } from '@/infrastructure/electron/ipcCore';
import type { SaveOkResult, LoadTriggerConfigResult, TcpStreamingStatusResult, SendTriggerResult } from '@/infrastructure/electron/ipcTypes';

export const triggerIpcClient = {
  // ============ Trigger配置相关方法 ============
  
  saveTriggerConfig: async (payload: { 
    projectDir: string; 
    config: TriggerNetworkConfig
  }): Promise<SaveOkResult> => {
    return invokeSafe<SaveOkResult>('save-trigger-config', payload, { ok: false });
  },

  loadTriggerConfig: async (payload: { projectDir: string }): Promise<LoadTriggerConfigResult> => {
    return invokeSafe<LoadTriggerConfigResult>('load-trigger-config', payload, { ok: false, config: null });
  },

  sendUdpTrigger: async (payload: { 
    targetIp: string; 
    port: number; 
    mark: number 
  }): Promise<SendTriggerResult> => {
    return invokeSafe<SendTriggerResult>('send-udp-trigger', payload, { ok: false });
  },

  readRecordingCommunicationClock: (): Promise<CommunicationClockResult> =>
    invokeSafeNoPayload('read-recording-communication-clock', { ok: false, message: '通信时钟不可用' }),

  configureRecordingCommunication: (payload: ConfigureCommunicationPayload): Promise<ConfigureCommunicationResult> =>
    invokeSafe('configure-recording-communication', payload, { ok: false, message: '通信配置失败', cleanupPending: true }),

  readRecordingCommunication: (payload: ReadCommunicationPayload): Promise<CommunicationBatchResult> =>
    invokeSafe('read-recording-communication', payload, { ok: false, message: '通信日志读取失败' }),

  flushStopRecordingCommunication: (payload: ReadCommunicationPayload): Promise<CommunicationBatchResult> =>
    invokeSafe('flush-stop-recording-communication', payload, { ok: false, message: '通信结束失败' }),

  listSerialPorts: (): Promise<ListSerialPortsResult> =>
    invokeSafeNoPayload('list-serial-ports', { ok: false, message: '串口列表读取失败' }),

  sendRecordingTrigger: (payload: SendRecordingTriggerPayload): Promise<SendTriggerResult> =>
    invokeSafe('send-recording-trigger', payload, { ok: false, message: 'Trigger发送失败' }),

  getTcpStreamingStatus: async (): Promise<TcpStreamingStatusResult> => {
    return invokeSafeNoPayload<TcpStreamingStatusResult>(
      'get-tcp-streaming-status',
      { ok: false, listening: false, clientCount: 0 },
    );
  },

  stopTcpStreaming: async (): Promise<SaveOkResult> => {
    return invokeSafeNoPayload<SaveOkResult>('stop-tcp-streaming', { ok: false });
  },

  sendTcpEyeData: async (payload: { fields: unknown[] }): Promise<SaveOkResult> => {
    return invokeSafe<SaveOkResult>('send-tcp-eye-data', payload, { ok: false });
  },

  // ============ 自定义标记相关方法 ============
  
  saveCustomMarkers: async (payload: { 
    projectDir: string; 
    markers: unknown[] 
  }): Promise<SaveOkResult> => {
    return invokeSafe<SaveOkResult>('save-custom-markers', payload, { ok: false });
  },

  loadCustomMarkers: async (payload: { projectDir: string }): Promise<{ ok: boolean; markers: unknown[] }> => {
    return invokeSafe<{ ok: boolean; markers: unknown[] }>('load-custom-markers', payload, { ok: false, markers: [] });
  }
};
