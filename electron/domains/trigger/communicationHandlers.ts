import { ipcMain } from 'electron'
import type { ConfigureCommunicationPayload, ReadCommunicationPayload, SendRecordingTriggerPayload } from '../../../shared/contracts/ipc/communication'
import { recordingCommunicationService as service } from './recordingCommunicationService'

export function registerRecordingCommunicationHandlers(): void {
  ipcMain.handle('read-recording-communication-clock', () => service.clock())
  ipcMain.handle('list-serial-ports', () => service.listSerialPorts())
  ipcMain.handle('configure-recording-communication', (_event, payload: ConfigureCommunicationPayload) => service.configure(payload))
  ipcMain.handle('read-recording-communication', (_event, payload: ReadCommunicationPayload) => service.read(payload))
  ipcMain.handle('flush-stop-recording-communication', (_event, payload: ReadCommunicationPayload) => service.flushStop(payload))
  ipcMain.handle('send-recording-trigger', (_event, payload: SendRecordingTriggerPayload) => service.sendTrigger(payload))
}
