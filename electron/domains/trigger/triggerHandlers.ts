import { ipcMain } from 'electron';
import * as fs from 'node:fs';
import * as net from 'node:net';
import path from 'node:path';

import { DEFAULT_TRIGGER_NETWORK_CONFIG, normalizeTriggerNetworkConfig, type TriggerNetworkConfig } from './triggerConfiguration';
import { registerRecordingCommunicationHandlers } from './communicationHandlers';
export { DEFAULT_TRIGGER_NETWORK_CONFIG, normalizeTriggerNetworkConfig } from './triggerConfiguration';
export type { TriggerNetworkConfig } from './triggerConfiguration';

let tcpEyeServer: net.Server | null = null;
let tcpEyeServerAddress = '';
let tcpEyeServerPort = 0;
const tcpEyeClients = new Set<net.Socket>();
const tcpEyeBackpressuredClients = new Set<net.Socket>();

export function stopTriggerTcpEyeServer(): void {
  for (const socket of tcpEyeClients) {
    try { socket.destroy(); } catch {}
  }
  tcpEyeClients.clear();
  tcpEyeBackpressuredClients.clear();
  try { tcpEyeServer?.close(); } catch {}
  tcpEyeServer = null;
  tcpEyeServerAddress = '';
  tcpEyeServerPort = 0;
}

async function applyTcpEyeServerConfig(config: TriggerNetworkConfig): Promise<{ ok: true; message?: never } | { ok: false; message: string }> {
  if (!config.tcpStreamingEnabled) {
    stopTriggerTcpEyeServer();
    return { ok: true };
  }
  const address = config.tcpListenIp.trim();
  const port = config.tcpListenPort;
  if (!address || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, message: 'TCP监听配置无效' };
  if (tcpEyeServer?.listening && tcpEyeServerAddress === address && tcpEyeServerPort === port) return { ok: true };

  stopTriggerTcpEyeServer();
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    tcpEyeClients.add(socket);
    socket.on('drain', () => tcpEyeBackpressuredClients.delete(socket));
    const remove = () => {
      tcpEyeBackpressuredClients.delete(socket);
      tcpEyeClients.delete(socket);
    };
    socket.on('error', remove);
    socket.on('close', remove);
  });
  tcpEyeServer = server;
  return new Promise((resolve) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      if (tcpEyeServer === server) stopTriggerTcpEyeServer();
      resolve({ ok: false, message: error.message });
    };
    const onListening = () => {
      server.off('error', onError);
      tcpEyeServerAddress = address;
      tcpEyeServerPort = port;
      resolve({ ok: true });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, address);
  });
}

export function registerTriggerHandlers(): void {
  registerRecordingCommunicationHandlers();
  ipcMain.handle('save-trigger-config', async (_event, payload: unknown) => {
    const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const projectDir = typeof input.projectDir === 'string' ? input.projectDir : '';
    if (!projectDir || !input.config || typeof input.config !== 'object') return { ok: false, message: '参数无效' };
    try {
      const config = normalizeTriggerNetworkConfig(input.config);
      const tcpResult = await applyTcpEyeServerConfig(config);
      if (!tcpResult.ok) return { ok: false, message: `TCP服务启动失败：${tcpResult.message}` };
      const configDir = path.join(projectDir, 'config');
      await fs.promises.mkdir(configDir, { recursive: true });
      await fs.promises.writeFile(path.join(configDir, 'trigger.json'), JSON.stringify({ version: '1.1', ...config }, null, 2), 'utf-8');
      return { ok: true };
    } catch (error) {
      console.error('保存Trigger配置失败:', error);
      return { ok: false, message: '保存失败' };
    }
  });

  ipcMain.handle('load-trigger-config', async (_event, payload: unknown) => {
    const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const projectDir = typeof input.projectDir === 'string' ? input.projectDir : '';
    if (!projectDir) return { ok: false, config: null };
    try {
      const configPath = path.join(projectDir, 'config', 'trigger.json');
      if (!fs.existsSync(configPath)) {
        await applyTcpEyeServerConfig(DEFAULT_TRIGGER_NETWORK_CONFIG);
        return { ok: true, config: DEFAULT_TRIGGER_NETWORK_CONFIG };
      }
      const config = normalizeTriggerNetworkConfig(JSON.parse(await fs.promises.readFile(configPath, 'utf-8')));
      const tcpResult = await applyTcpEyeServerConfig(config);
      return { ok: true, config, ...(tcpResult.ok ? {} : { message: `TCP服务启动失败：${tcpResult.message}` }) };
    } catch (error) {
      console.error('加载Trigger配置失败:', error);
      return { ok: false, config: null };
    }
  });

  ipcMain.handle('get-tcp-streaming-status', async () => ({
    ok: true,
    listening: tcpEyeServer?.listening === true,
    clientCount: tcpEyeClients.size,
    address: tcpEyeServerAddress,
    port: tcpEyeServerPort,
  }));
  ipcMain.handle('stop-tcp-streaming', async () => {
    stopTriggerTcpEyeServer();
    return { ok: true };
  });
  ipcMain.handle('send-tcp-eye-data', async (_event, payload: unknown) => {
    const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    if (!Array.isArray(input.fields)) return { ok: false, message: '数据格式无效' };
    if (!tcpEyeServer?.listening || tcpEyeClients.size === 0) return { ok: true };
    const body = Buffer.from(JSON.stringify(input.fields), 'utf8');
    if (body.length > 999999) return { ok: false, message: '单条数据超过协议长度限制' };
    const frame = Buffer.concat([Buffer.from(`<|${String(body.length).padStart(6, '0')}`, 'ascii'), body]);
    for (const socket of tcpEyeClients) {
      if (socket.destroyed || tcpEyeBackpressuredClients.has(socket)) continue;
      try {
        if (!socket.write(frame)) tcpEyeBackpressuredClients.add(socket);
      } catch {
        socket.destroy();
      }
    }
    return { ok: true };
  });
}
