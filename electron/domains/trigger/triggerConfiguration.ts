import { isIP } from 'node:net'
import type { TriggerNetworkConfig } from '../../../shared/contracts/ipc/communication'
export type { TriggerNetworkConfig } from '../../../shared/contracts/ipc/communication'

export const DEFAULT_TRIGGER_NETWORK_CONFIG: Required<TriggerNetworkConfig> = {
  enabled: false, udpSendPort: 8888, udpReceivePort: 8889, targetIp: '127.0.0.1',
  tcpStreamingEnabled: false, tcpListenIp: '0.0.0.0', tcpListenPort: 7979,
  serialEnabled: false, serialPath: '', serialBaudRate: 115200,
  serialDataBits: 8, serialStopBits: 1, serialParity: 'none',
}

const integer = (value: unknown, fallback: number, max: number, label: string): number => {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw new Error(`${label}无效`)
  return value
}

export const validateUdpDestination = (targetIp: unknown, port: unknown): { targetIp: string; port: number } => {
  if (typeof targetIp !== 'string' || isIP(targetIp) !== 4) throw new Error('UDP目标必须为有效IPv4地址')
  if (port === undefined) throw new Error('缺少UDP端口')
  return { targetIp, port: integer(port, 0, 65535, 'UDP端口') }
}

export function normalizeTriggerNetworkConfig(value: unknown): Required<TriggerNetworkConfig> {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const defaults = DEFAULT_TRIGGER_NETWORK_CONFIG
  const path = input.serialPath === undefined ? '' : input.serialPath
  if (typeof path !== 'string' || path.length > 512 || /[\0\r\n]/.test(path)) throw new Error('串口路径无效')
  const serialEnabled = input.serialEnabled === true
  if (serialEnabled && !path.trim()) throw new Error('启用串口需要选择端口')
  const dataBits = input.serialDataBits ?? 8
  const stopBits = input.serialStopBits ?? 1
  const parity = input.serialParity ?? 'none'
  if (![5, 6, 7, 8].includes(dataBits as number) || ![1, 1.5, 2].includes(stopBits as number) ||
      !['none', 'even', 'odd', 'mark', 'space'].includes(parity as string)) throw new Error('串口数据位、停止位或校验配置无效')
  const targetIp = input.targetIp ?? defaults.targetIp
  if (typeof targetIp !== 'string' || isIP(targetIp) !== 4) throw new Error('UDP目标必须为有效IPv4地址')
  const tcpListenIp = input.tcpListenIp ?? defaults.tcpListenIp
  if (typeof tcpListenIp !== 'string' || !isIP(tcpListenIp)) throw new Error('TCP监听地址无效')
  return {
    enabled: input.enabled === true,
    udpSendPort: integer(input.udpSendPort, defaults.udpSendPort, 65535, 'UDP发送端口'),
    udpReceivePort: integer(input.udpReceivePort, defaults.udpReceivePort, 65535, 'UDP接收端口'), targetIp,
    tcpStreamingEnabled: input.tcpStreamingEnabled === true, tcpListenIp,
    tcpListenPort: integer(input.tcpListenPort, defaults.tcpListenPort, 65535, 'TCP监听端口'),
    serialEnabled, serialPath: path.trim(),
    serialBaudRate: integer(input.serialBaudRate, 115200, 4_000_000, '串口波特率'),
    serialDataBits: dataBits as 5 | 6 | 7 | 8, serialStopBits: stopBits as 1 | 1.5 | 2,
    serialParity: parity as Required<TriggerNetworkConfig>['serialParity'],
  }
}
