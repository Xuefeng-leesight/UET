import { ipcMain } from 'electron';
import type { UpdateService } from './updateService';

export function registerUpdateHandlers(service: UpdateService): void {
  ipcMain.handle('update-download-install', (_event, payload: unknown) => {
    const channel = payload && typeof payload === 'object' && (payload as { channel?: unknown }).channel === 'beta'
      ? 'beta'
      : 'stable';
    return service.downloadAndInstall(channel);
  });
}
