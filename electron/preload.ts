import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_INVOKE_CHANNELS,
  IPC_RECEIVE_CHANNELS,
  IPC_SEND_CHANNELS,
} from '../shared/contracts/ipc/channels'

const invokeChannels = new Set<string>(IPC_INVOKE_CHANNELS)
const sendChannels = new Set<string>(IPC_SEND_CHANNELS)
const receiveChannels = new Set<string>(IPC_RECEIVE_CHANNELS)

const assertAllowed = (channels: Set<string>, channel: string, operation: string) => {
  if (!channels.has(channel)) {
    throw new Error(`Blocked renderer IPC ${operation} channel: ${channel}`)
  }
}

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    assertAllowed(receiveChannels, channel, 'receive')
    return ipcRenderer.on(channel, listener)
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args
    assertAllowed(receiveChannels, channel, 'receive')
    return ipcRenderer.off(channel, ...omit)
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args
    assertAllowed(sendChannels, channel, 'send')
    return ipcRenderer.send(channel, ...omit)
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args
    assertAllowed(invokeChannels, channel, 'invoke')
    return ipcRenderer.invoke(channel, ...omit)
  },
})
