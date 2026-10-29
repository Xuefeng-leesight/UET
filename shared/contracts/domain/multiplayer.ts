export type MultiplayerRole = 'standalone' | 'coordinator' | 'client';
export type MultiplayerClientStatus =
  | 'offline'
  | 'connected'
  | 'syncing'
  | 'ready'
  | 'armed'
  | 'recording'
  | 'finalizing'
  | 'completed'
  | 'error';

export type MultiplayerCommandType = 'prepare' | 'start' | 'stop';

export interface MultiplayerCommand {
  id: string;
  sessionId: string;
  type: MultiplayerCommandType;
  executeAt?: number;
  createdAt: number;
}

export interface MultiplayerClient {
  id: string;
  name: string;
  local: boolean;
  included: boolean;
  status: MultiplayerClientStatus;
  deviceConnected: boolean;
  recordingEligible: boolean;
  recordingEligibilityReason?: string;
  packageVersion: string;
  packageProgress: number;
  lastSeenAt: number;
  /** 主控时间 - 客户端本机时间。调度时必须用该偏移修正 Date.now()。 */
  clockOffsetMs?: number;
  roundTripMs?: number;
  preparedSessionId?: string;
  preparedAt?: number;
  recordingStartedAt?: number;
  startDeviationMs?: number;
  error?: string;
}

export interface MultiplayerPackageInfo {
  experimentDir: string;
  version: string;
  fileCount: number;
  totalBytes: number;
  publishedAt: number;
}

export interface MultiplayerSession {
  id: string;
  name: string;
  packageVersion: string;
  state: 'draft' | 'preparing' | 'armed' | 'recording' | 'stopping' | 'completed';
  createdAt: number;
  plannedStartAt?: number;
  plannedStopAt?: number;
}

export interface MultiplayerSnapshot {
  running: boolean;
  role: MultiplayerRole;
  host: string;
  port: number;
  localClientId: string;
  localClientName: string;
  session: MultiplayerSession | null;
  packageInfo: MultiplayerPackageInfo | null;
  clients: MultiplayerClient[];
  error?: string;
}

export interface MultiplayerLocalStatus {
  deviceConnected: boolean;
  recordingEligible: boolean;
  recordingEligibilityReason?: string;
  recording: boolean;
  finalizing: boolean;
  experimentDir: string;
}
