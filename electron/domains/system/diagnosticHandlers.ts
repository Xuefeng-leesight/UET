import { dialog, ipcMain, type BrowserWindow } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import { getVideoDebugLogFilePath, logVideoDebugEvent } from '../../platform/logging/videoDebugLogger'
import { logPerfEvent } from '../../platform/logging/performanceLogger'

type RendererPerfPayload = { event: string; sinceRendererStartMs?: number; details?: unknown }
type RendererVideoDebugPayload = { event: string; details?: unknown }

function errorDetails(error: unknown): { message: string; code: string } {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  return {
    message: error instanceof Error ? error.message : typeof value.message === 'string' ? value.message : '',
    code: typeof value.code === 'string' ? value.code : '',
  }
}

function parseRendererPerfPayload(payload: unknown): RendererPerfPayload | null {
  if (!payload || typeof payload !== 'object') return null
  const source = payload as Record<string, unknown>
  const event = typeof source.event === 'string' ? source.event.trim() : ''
  if (!event) return null
  const parsed: RendererPerfPayload = { event }
  if (typeof source.sinceRendererStartMs === 'number' && Number.isFinite(source.sinceRendererStartMs)) {
    parsed.sinceRendererStartMs = source.sinceRendererStartMs
  }
  if (source.details !== undefined) parsed.details = source.details
  return parsed
}

function parseRendererVideoDebugPayload(payload: unknown): RendererVideoDebugPayload | null {
  if (!payload || typeof payload !== 'object') return null
  const source = payload as Record<string, unknown>
  const event = typeof source.event === 'string' ? source.event.trim() : ''
  if (!event) return null
  return source.details === undefined ? { event } : { event, details: source.details }
}

export function registerDiagnosticHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.on('perf-log', (_event, payload) => {
    const parsed = parseRendererPerfPayload(payload)
    if (!parsed) return
    logPerfEvent({ processType: 'renderer', ...parsed })
  })

  ipcMain.handle('video-debug-log', async (_event, payload) => {
    const parsed = parseRendererVideoDebugPayload(payload)
    if (!parsed) return { ok: false, message: 'invalid payload', logFilePath: getVideoDebugLogFilePath() }
    logVideoDebugEvent({ source: 'renderer', event: parsed.event, details: parsed.details })
    return { ok: true, logFilePath: getVideoDebugLogFilePath() }
  })

  ipcMain.handle('get-video-debug-log-path', async () => ({ ok: true, logFilePath: getVideoDebugLogFilePath() }))

  ipcMain.handle('get-local-ip-addresses', async () => {
    try {
      const addresses: string[] = []
      for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries || []) {
          if (!entry || entry.family !== 'IPv4' || entry.internal || !entry.address || addresses.includes(entry.address)) continue
          addresses.push(entry.address)
        }
      }
      return { ok: true, addresses, primary: addresses[0] || '' }
    } catch (error) {
      return { ok: false, addresses: [], primary: '', message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('select-folder', async () => {
    const win = getMainWindow()
    if (!win) return { canceled: true, error: '窗口不可用' }
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    const folderPath = result.filePaths[0]
    try {
      await fs.promises.access(folderPath, fs.constants.R_OK | fs.constants.W_OK)
      if (!folderPath || folderPath.includes('\0')) return { canceled: true, error: '所选路径无效' }
      await fs.promises.readdir(folderPath)
      const testFilePath = path.join(folderPath, '.mrt_path_test')
      try {
        await fs.promises.writeFile(testFilePath, 'test', 'utf-8')
        await fs.promises.unlink(testFilePath)
      } catch (error) {
        return { canceled: true, error: `所选路径不可写入：${errorDetails(error).message || '未知错误'}` }
      }
      return { canceled: false, path: folderPath }
    } catch (error) {
      const details = errorDetails(error)
      let message = '所选路径无法访问'
      if (details.code === 'EACCES') message = '所选路径没有读写权限'
      else if (details.code === 'ENOENT') message = '所选路径不存在'
      else if (details.code === 'ENOTDIR') message = '所选路径不是有效的目录'
      else if (details.message) message = `路径验证失败：${details.message}`
      return { canceled: true, error: message }
    }
  })
}
