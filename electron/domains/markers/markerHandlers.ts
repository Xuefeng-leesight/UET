import { ipcMain } from 'electron'
import { recordingCommunicationService } from '../trigger/recordingCommunicationService'
import * as fs from 'node:fs'
import path from 'node:path'

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' ? value as UnknownRecord : {}
}

export function closeUdpTriggerSockets(): void {
  void recordingCommunicationService.shutdown()
}

export function registerMarkerHandlers(): void {
  ipcMain.handle('save-custom-markers', async (_event, payload: unknown) => {
    const { projectDir, markers } = asRecord(payload)
    if (!projectDir || typeof projectDir !== 'string' || !Array.isArray(markers)) {
      return { ok: false, message: '参数无效' }
    }

    try {
      const configDir = path.join(projectDir, 'config')
      await fs.promises.mkdir(configDir, { recursive: true })
      const markersPath = path.join(configDir, 'custom-markers.json')
      const data = JSON.stringify({ version: '1.0', markers }, null, 2)
      await fs.promises.writeFile(markersPath, data, 'utf-8')
      return { ok: true }
    } catch (error) {
      console.error('保存自定义标记失败:', error)
      return { ok: false, message: '保存失败' }
    }
  })

  ipcMain.handle('load-custom-markers', async (_event, payload: unknown) => {
    const { projectDir } = asRecord(payload)
    if (!projectDir || typeof projectDir !== 'string') {
      return { ok: false, markers: [] }
    }

    try {
      const markersPath = path.join(projectDir, 'config', 'custom-markers.json')
      if (!fs.existsSync(markersPath)) {
        return { ok: true, markers: [] }
      }
      const data = await fs.promises.readFile(markersPath, 'utf-8')
      const parsed = asRecord(JSON.parse(data))
      return {
        ok: true,
        markers: Array.isArray(parsed.markers) ? parsed.markers : [],
      }
    } catch (error) {
      console.error('加载自定义标记失败:', error)
      return { ok: false, markers: [] }
    }
  })

  ipcMain.handle('send-udp-trigger', (_event, payload) => recordingCommunicationService.sendUdp(payload))
}
