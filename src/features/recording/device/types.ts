/**
 * 设备相关类型定义
 */

import { DeviceStatus, determineDeviceStatus, getDeviceStatusText } from '@/shared/constants/terminology';

// 重新导出以便其他模块使用
export { DeviceStatus, determineDeviceStatus, getDeviceStatusText };

/**
 * 设备状态接口
 */
export interface DeviceState {
  status: DeviceStatus;
  isConnected: boolean;
  isStarted: boolean;
  isStarting: boolean;
  error: string | null;
  lastUpdate: number;
}

/**
 * 设备信息接口
 */
export interface DeviceInfo {
  name: string;
  type: 'desktop' | 'glasses';
  serialNumber?: string;
  firmwareVersion?: string;
}

/**
 * 校准结果接口
 */
export interface CalibrationResult {
  leftEyeScore: number;
  rightEyeScore: number;
  timestamp: number;
  success: boolean;
}
