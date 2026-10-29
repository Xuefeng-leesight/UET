import type { IpcReceiveChannel, IpcSendChannel } from '@shared/contracts/ipc/channels';

export type IpcEventListener = (event: unknown, ...args: unknown[]) => void;

export const ipcEvents = {
  isAvailable(): boolean {
    return Boolean(window.ipcRenderer);
  },

  send(channel: IpcSendChannel, ...args: unknown[]): void {
    window.ipcRenderer?.send(channel, ...args);
  },

  on(channel: IpcReceiveChannel, listener: IpcEventListener): (() => void) | undefined {
    const ipc = window.ipcRenderer;
    if (!ipc) return undefined;
    ipc.on(channel, listener);
    return () => ipc.off(channel, listener);
  },
};
