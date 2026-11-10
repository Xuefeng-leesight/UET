/** Actual application I/O, distinct from stimulus marker intent and device samples. */
export type SerialTriggerOptions = {
  serialEnabled?: boolean;
  serialPath?: string;
  serialBaudRate?: number;
  serialDataBits?: 5 | 6 | 7 | 8;
  serialStopBits?: 1 | 1.5 | 2;
  serialParity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
};

export type TriggerNetworkConfig = SerialTriggerOptions & {
  enabled: boolean;
  udpSendPort: number;
  udpReceivePort: number;
  targetIp: string;
  tcpStreamingEnabled: boolean;
  tcpListenIp: string;
  tcpListenPort: number;
};

export type RecordingCommunicationContext = { recordingId: string; generation: number };
export type RecordingCommunicationStartContext = RecordingCommunicationContext & {
  journalPath: string;
  videoTimeOffsetMs: number;
  clockUncertaintyMs: number;
};
export type CommunicationChannel = 'udp_send' | 'udp_receive' | 'trigger_send' | 'trigger_receive';
export type RecordingCommunicationEvent = RecordingCommunicationContext & {
  eventId: string;
  channel: CommunicationChannel;
  /** Main-process monotonic observation time, never a device or video timestamp. */
  mainMonotonicMs: number;
  capturedAtEpochMs: number;
  videoTimeMs: number;
  /** Reversible single-line JSON: {encoding:'utf-8'|'base64',data:string}. */
  payloadEnvelope: string;
};
export type CommunicationFailure = { ok: false; message: string };
export type CommunicationClockResult = CommunicationFailure | { ok: true; mainMonotonicMs: number };
export type ConfigureCommunicationPayload = {
  context: RecordingCommunicationStartContext;
  config: TriggerNetworkConfig;
};
export type ConfigureCommunicationResult = (CommunicationFailure & {
  /** Opening/closing may still be pending: keep the context and retry flush-stop before backend finalization. */
  cleanupPending?: boolean;
}) | {
  ok: true; mainMonotonicMs: number; mainEpochMs: number;
};
export type ReadCommunicationPayload = {
  context: RecordingCommunicationContext;
  /** ACK only after the recording backend has persisted these exact events. */
  ackEventIds?: string[];
  maxEvents?: number;
};
export type CommunicationBatchResult = CommunicationFailure | {
  ok: true;
  events: RecordingCommunicationEvent[];
  pendingCount: number;
  stopped: boolean;
  errors: string[];
};
export type SendRecordingTriggerPayload = {
  context?: RecordingCommunicationContext;
  mark: number;
};
export type SerialPortDescription = { path: string; manufacturer?: string; serialNumber?: string; vendorId?: string; productId?: string };
export type ListSerialPortsResult = CommunicationFailure | { ok: true; ports: SerialPortDescription[] };
