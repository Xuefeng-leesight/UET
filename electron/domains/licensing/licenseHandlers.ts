import { clipboard, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import type { LicenseService } from './licenseService';

export function registerLicenseHandlers(
  service: LicenseService,
  apiOrigin: string,
  authorizationEnabled = true,
  onAuthorized?: () => void,
): void {
  ipcMain.handle('license-get-state', () => service.getState());
  ipcMain.handle('license-get-machine-code', () => ({ ok: true, machineCode: service.getMachineCode() }));
  ipcMain.handle('license-copy-machine-code', () => {
    clipboard.writeText(service.getMachineCode());
    return { ok: true };
  });
  ipcMain.handle('license-require-module', (_event, payload: unknown) => {
    const code = payload && typeof payload === 'object' && typeof (payload as { code?: unknown }).code === 'string'
      ? (payload as { code: string }).code
      : '';
    return !authorizationEnabled || service.hasModule(code)
      ? { ok: true }
      : { ok: false, code: 'MODULE_NOT_LICENSED', message: '当前 License 未授权此产品模块。' };
  });
  ipcMain.handle('license-activate-online', async (_event, payload: unknown) => {
    const licenseKey = payload && typeof payload === 'object' && typeof (payload as { licenseKey?: unknown }).licenseKey === 'string'
      ? (payload as { licenseKey: string }).licenseKey
      : '';
    const result = await service.activate(licenseKey);
    if (result.ok && result.state.canUseApp) onAuthorized?.();
    return result;
  });
  ipcMain.handle('license-refresh', () => service.refresh());
  ipcMain.handle('license-import-offline', async () => {
    const selection = await dialog.showOpenDialog({
      title: '导入离线 License',
      properties: ['openFile'],
      filters: [{ name: 'UST License', extensions: ['lic', 'json'] }],
    });
    if (selection.canceled || !selection.filePaths[0]) {
      return { ok: false, state: service.getState(), code: 'CANCELED', message: '已取消导入。' };
    }
    const stat = fs.statSync(selection.filePaths[0]);
    if (stat.size > 1024 * 1024) {
      return { ok: false, state: service.getState(), code: 'FILE_TOO_LARGE', message: '离线 License 文件不能超过 1 MB。' };
    }
    const result = await service.importOffline(fs.readFileSync(selection.filePaths[0], 'utf8'));
    if (result.ok && result.state.canUseApp) onAuthorized?.();
    return result;
  });
  ipcMain.handle('license-deactivate', () => service.deactivate());
  ipcMain.handle('update-check', (_event, payload: unknown) => {
    const channel = payload && typeof payload === 'object' && (payload as { channel?: unknown }).channel === 'beta'
      ? 'beta'
      : 'stable';
    return service.checkUpdate(channel);
  });
  ipcMain.handle('test-tools-list', () => service.getTestTools());
  ipcMain.handle('test-tool-open-download', async (_event, payload: unknown) => {
    const url = payload && typeof payload === 'object' && typeof (payload as { url?: unknown }).url === 'string'
      ? (payload as { url: string }).url
      : '';
    try {
      const target = new URL(url);
      const trusted = new URL(apiOrigin);
      if (
        target.origin !== trusted.origin
        || !target.pathname.startsWith('/api/v1/client/test-tools/')
        || !target.pathname.endsWith('/download')
      ) {
        return { ok: false, message: '下载地址不属于已配置的 UST 后台。' };
      }
    } catch {
      return { ok: false, message: '下载地址无效。' };
    }
    await shell.openExternal(url);
    return { ok: true };
  });
}
