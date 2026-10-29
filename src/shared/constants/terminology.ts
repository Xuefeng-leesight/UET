/**
 * UI 术语常量定义
 * 用于统一整个应用的用户界面文本
 */

// 项目管理相关术语
export const PROJECT_STORAGE_PATH_SETTINGS = '项目存储路径';
export const PROJECT_LIBRARY_SETTINGS_OLD = '项目库设置'; // 旧术语，仅用于迁移

// 设备状态相关术语
export enum DeviceStatus {
  NOT_CONNECTED = 'not_connected',    // 硬件未连接
  NOT_STARTED = 'not_started',        // 设备未开启
  STARTING = 'starting',              // 设备启动中
  READY = 'ready',                    // 设备就绪
  ERROR = 'error'                     // 设备错误
}

export const DEVICE_STATUS_TEXT: Record<DeviceStatus, string> = {
  [DeviceStatus.NOT_CONNECTED]: '设备未连接',
  [DeviceStatus.NOT_STARTED]: '设备未开启',
  [DeviceStatus.STARTING]: '设备启动中',
  [DeviceStatus.READY]: '设备就绪',
  [DeviceStatus.ERROR]: '设备错误'
};

// 通用术语
export const TERMINOLOGY = {
  // 项目管理
  PROJECT_STORAGE_PATH_SETTINGS,
  
  // 设备状态
  DEVICE_NOT_CONNECTED: DEVICE_STATUS_TEXT[DeviceStatus.NOT_CONNECTED],
  DEVICE_NOT_STARTED: DEVICE_STATUS_TEXT[DeviceStatus.NOT_STARTED],
  DEVICE_STARTING: DEVICE_STATUS_TEXT[DeviceStatus.STARTING],
  DEVICE_READY: DEVICE_STATUS_TEXT[DeviceStatus.READY],
  DEVICE_ERROR: DEVICE_STATUS_TEXT[DeviceStatus.ERROR],
  
  // 实验设计
  COPY_STIMULUS: '复制素材',
  
  // 录制
  START_RECORDING: '开始录制',
  STOP_RECORDING: '停止录制',
  
  // 时间轴
  ADD_MARKER: '添加标记',
  CREATE_SEGMENT: '创建时间段',
} as const;

/**
 * 根据设备状态判断显示文本
 */
export function determineDeviceStatus(
  isConnected: boolean,
  isStarted: boolean,
  isStarting: boolean,
  hasError: boolean
): DeviceStatus {
  if (hasError) return DeviceStatus.ERROR;
  if (!isConnected) return DeviceStatus.NOT_CONNECTED;
  if (isStarting) return DeviceStatus.STARTING;
  if (isStarted) return DeviceStatus.READY;
  return DeviceStatus.NOT_STARTED;
}

/**
 * 获取设备状态的显示文本
 */
export function getDeviceStatusText(status: DeviceStatus): string {
  return DEVICE_STATUS_TEXT[status];
}
