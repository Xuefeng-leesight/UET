import type { IpcInvokeChannel } from '@shared/contracts/ipc/channels';

type IpcRendererLike = NonNullable<Window['ipcRenderer']>;

const getIpcRenderer = (): IpcRendererLike => {
  const ipc = window.ipcRenderer;
  if (!ipc || typeof ipc.invoke !== 'function') {
    throw new Error('ipcRenderer is not available. Check preload exposure and contextIsolation settings.');
  }
  return ipc;
};

export async function invokeSafe<T>(channel: IpcInvokeChannel, payload: unknown, fallback: T): Promise<T> {
  try {
    const ipc = getIpcRenderer();
    return (await ipc.invoke(channel, payload)) as T;
  } catch (error) {
    console.error(`[ipcClient] invoke failed: ${channel}`, error);
    return fallback;
  }
}

export async function invokeSafeNoPayload<T>(channel: IpcInvokeChannel, fallback: T): Promise<T> {
  try {
    const ipc = getIpcRenderer();
    return (await ipc.invoke(channel)) as T;
  } catch (error) {
    console.error(`[ipcClient] invoke failed: ${channel}`, error);
    return fallback;
  }
}
