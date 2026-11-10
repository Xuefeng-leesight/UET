export {};

type IpcListener = (event: unknown, ...args: unknown[]) => void;

declare global {
  const __APP_VERSION__: string;

  interface Window {
    ipcRenderer?: {
      send: (channel: string, ...args: unknown[]) => void;
      invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>;
      on: (channel: string, listener: IpcListener) => void;
      off: (channel: string, listener: IpcListener) => void;
    };
  }
}
