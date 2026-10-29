import { invokeSafe, invokeSafeNoPayload } from '@/infrastructure/electron/ipcCore';
import type { MultiplayerCommandType, MultiplayerSnapshotResult, MultiplayerCommandResult, MultiplayerPackageSyncResult } from '@/infrastructure/electron/ipcTypes';

export const multiplayerIpcClient = {
  // ============ 多人采集协调 ============

  startMultiplayerCoordinator: async (payload: { port: number }): Promise<MultiplayerSnapshotResult> => {
    return invokeSafe<MultiplayerSnapshotResult>('multiplayer-start-coordinator', payload, { ok: false });
  },

  stopMultiplayerCoordinator: async (): Promise<MultiplayerSnapshotResult> => {
    return invokeSafeNoPayload<MultiplayerSnapshotResult>('multiplayer-stop-coordinator', { ok: false });
  },

  getMultiplayerSnapshot: async (): Promise<MultiplayerSnapshotResult> => {
    return invokeSafeNoPayload<MultiplayerSnapshotResult>('multiplayer-get-snapshot', { ok: false });
  },

  updateMultiplayerLocalClient: async (payload: Record<string, unknown>): Promise<MultiplayerSnapshotResult> => {
    return invokeSafe<MultiplayerSnapshotResult>('multiplayer-update-local-client', payload, { ok: false });
  },

  updateMultiplayerClient: async (payload: {
    clientId: string;
    patch: Record<string, unknown>;
  }): Promise<MultiplayerSnapshotResult> => {
    return invokeSafe<MultiplayerSnapshotResult>('multiplayer-update-client', payload, { ok: false });
  },

  removeMultiplayerClient: async (payload: { clientId: string }): Promise<MultiplayerSnapshotResult> => {
    return invokeSafe<MultiplayerSnapshotResult>('multiplayer-remove-client', payload, { ok: false });
  },

  publishMultiplayerPackage: async (payload: { experimentDir: string }): Promise<MultiplayerSnapshotResult> => {
    return invokeSafe<MultiplayerSnapshotResult>('multiplayer-publish-package', payload, { ok: false });
  },

  createMultiplayerSession: async (payload: { name: string }): Promise<MultiplayerSnapshotResult> => {
    return invokeSafe<MultiplayerSnapshotResult>('multiplayer-create-session', payload, { ok: false });
  },

  ackMultiplayerCommand: async (payload: { clientId: string; commandId: string }): Promise<MultiplayerSnapshotResult> => {
    return invokeSafe<MultiplayerSnapshotResult>('multiplayer-ack-command', payload, { ok: false });
  },

  issueMultiplayerCommand: async (payload: {
    type: MultiplayerCommandType;
    delayMs?: number;
  }): Promise<MultiplayerCommandResult> => {
    return invokeSafe<MultiplayerCommandResult>('multiplayer-issue-command', payload, { ok: false });
  },

  syncMultiplayerPackage: async (payload: {
    coordinatorUrl: string;
    experimentDir: string;
  }): Promise<MultiplayerPackageSyncResult> => {
    return invokeSafe<MultiplayerPackageSyncResult>('multiplayer-sync-package', payload, { ok: false });
  }
};
