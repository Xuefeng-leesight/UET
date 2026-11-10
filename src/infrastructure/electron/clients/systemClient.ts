import { invokeSafe, invokeSafeNoPayload } from '@/infrastructure/electron/ipcCore';
import type { SaveOkResult, SetWindowFullScreenResult, ShowInFinderResult, ScreenConfig, GetScreensResult, LoadScreenConfigResult, SaveScreenConfigResult, ValidateScreenConfigResult, SaveFileResult, LoadFileResult, CreateDirectoryResult, VideoDebugLogResult, GetVideoDebugLogPathResult, GetLocalIpAddressesResult } from '@/infrastructure/electron/ipcTypes';

export const systemIpcClient = {
  isAvailable: (): boolean => {
    const ipc = window.ipcRenderer;
    return !!ipc && typeof ipc.invoke === 'function';
  },

  videoDebugLog: async (payload: {
    event: string;
    details?: unknown;
  }): Promise<VideoDebugLogResult> => {
    return invokeSafe<VideoDebugLogResult>('video-debug-log', payload, { ok: false });
  },

  getVideoDebugLogPath: async (): Promise<GetVideoDebugLogPathResult> => {
    return invokeSafeNoPayload<GetVideoDebugLogPathResult>('get-video-debug-log-path', { ok: false, logFilePath: null });
  },

  getLocalIpAddresses: async (): Promise<GetLocalIpAddressesResult> => {
    return invokeSafeNoPayload<GetLocalIpAddressesResult>('get-local-ip-addresses', { ok: false, addresses: [], primary: '' });
  },

  setWindowFullScreen: async (payload: { fullscreen: boolean }): Promise<SetWindowFullScreenResult> => {
    return invokeSafe<SetWindowFullScreenResult>('set-window-fullscreen', payload, { ok: false });
  },

  minimizeMainWindow: async (): Promise<SaveOkResult> => {
    return invokeSafeNoPayload<SaveOkResult>('minimize-main-window', { ok: false });
  },

  rendererShutdownComplete: async (): Promise<SaveOkResult> => {
    return invokeSafeNoPayload<SaveOkResult>('renderer-shutdown-complete', { ok: false });
  },

  getScreens: async (): Promise<GetScreensResult> => {
    return invokeSafeNoPayload<GetScreensResult>('get-screens', { ok: false, screens: [] });
  },

  loadScreenConfig: async (payload: { projectDir: string }): Promise<LoadScreenConfigResult> => {
    return invokeSafe<LoadScreenConfigResult>('load-screen-config', payload, {
      ok: false,
      config: { enabled: false, experimenterDisplayId: null, participantDisplayId: null },
      warnings: [],
    });
  },

  saveScreenConfig: async (payload: { projectDir: string; config: ScreenConfig }): Promise<SaveScreenConfigResult> => {
    return invokeSafe<SaveScreenConfigResult>('save-screen-config', payload, { ok: false });
  },

  validateScreenConfig: async (payload: { config: ScreenConfig }): Promise<ValidateScreenConfigResult> => {
    return invokeSafe<ValidateScreenConfigResult>('validate-screen-config', payload, {
      ok: true,
      config: { enabled: false, experimenterDisplayId: null, participantDisplayId: null },
      warnings: [],
    });
  },

  showInFinder: async (payload: { path: string }): Promise<ShowInFinderResult> => {
    return invokeSafe<ShowInFinderResult>('show-in-finder', payload, { ok: false });
  },

  saveFile: async (payload: {
    filePath: string;
    content: unknown;
    encoding?: BufferEncoding;
    ensureDir?: boolean;
  }): Promise<SaveFileResult> => {
    return invokeSafe<SaveFileResult>('save-file', payload, { ok: false });
  },

  appendFile: async (payload: {
    filePath: string;
    content: Uint8Array;
  }): Promise<SaveFileResult> => {
    return invokeSafe<SaveFileResult>('append-file', payload, { ok: false });
  },

  loadFile: async (payload: {
    filePath: string;
    encoding?: BufferEncoding;
    asBuffer?: boolean;
  }): Promise<LoadFileResult> => {
    return invokeSafe<LoadFileResult>('load-file', payload, { ok: false });
  },

  createDirectory: async (payload: { dirPath: string; recursive?: boolean }): Promise<CreateDirectoryResult> => {
    return invokeSafe<CreateDirectoryResult>('create-directory', payload, { ok: false });
  },

  // ============ Python服务器控制 ============
  
  stopPyServer: async (): Promise<SaveOkResult> => {
    return invokeSafeNoPayload<SaveOkResult>('stop-py-server', { ok: false });
  },

  restartPyServer: async (): Promise<SaveOkResult> => {
    return invokeSafeNoPayload<SaveOkResult>('restart-py-server', { ok: false });
  }
};
