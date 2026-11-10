import type { Stimulus } from '@shared/contracts/domain/models';
import type { SerialTriggerOptions } from '@shared/contracts/ipc/communication';
export type { HeatmapPoint } from '@shared/contracts/domain/analysis';

export interface ComboStimulusItem {
  id: string;
  name: string;
  type: 'image' | 'video' | 'audio' | 'text' | 'web';
  url?: string;
  fileName?: string;
  text?: string;
  widthPct: number;
  heightPct: number;
  centerXPct: number;
  centerYPct: number;
  loop?: boolean;
  fontSize?: number;
  fontColor?: string;
  bgColor?: string;
}

export interface ExtendedStimulus extends Stimulus {
  fileName?: string;
  size: string;
  date: string;
  bgColor?: string;
  fontSize?: number;
  fontColor?: string;               // 字体颜色
  externalMarker?: boolean;
  endOnClick?: boolean;
  endOnKey?: boolean;
  group?: string;
  
  // 新增字段 - 编号系统
  order: number;                    // 编号（从1开始）
  
  // 新增字段 - 播放控制
  randomPlay?: boolean;             // 随机播放标记
  playToEnd?: boolean;              // 视频是否播放完成后再切换

  // 新增字段 - Trigger配置
  triggerEnabled?: boolean;         // Trigger开关
  triggerMark?: number;             // Trigger标记值
  
  // 新增字段 - Group播放模式
  groupPlayMode?: 'all-sequential' | 'all-random' | 'random-sample' | 'repeat';
  groupRandomCount?: number;        // 随机抽样数量
  groupRepeatCount?: number;        // 重复次数
  groupInternalOrder?: number;      // 组内编号（从1开始）
  comboItems?: ComboStimulusItem[];  // Combo 内部素材图层
  comboCanvasStyle?: 'fullscreen' | 'landscape' | 'classic' | 'square' | 'portrait';
}

export interface TriggerConfig extends SerialTriggerOptions {
  enabled: boolean;                 // 全局Trigger开关
  udpSendPort: number;              // UDP发送端口
  udpReceivePort: number;           // UDP接收端口
  targetIp: string;                 // 目标IP地址
  tcpStreamingEnabled: boolean;     // 实时眼动TCP转发开关
  tcpListenIp: string;              // TCP监听地址
  tcpListenPort: number;            // TCP监听端口
}

export interface ValidationError {
  field: string;
  message: string;
  value: unknown;
}

export interface ErrorLog {
  timestamp: string;
  level: 'error' | 'warning' | 'info';
  module: string;
  message: string;
  details?: unknown;
}

export interface SubjectFieldDef {
  id: string;
  label: string;
  builtin?: boolean;
}

export interface ConfirmState {
  open: boolean;
  title: string;
  message: string;
  onConfirm: (() => void) | null;
  onCancel?: (() => void) | null;
  onClose?: (() => void) | null;
  showCancel?: boolean;
  cancelText?: string;
  confirmText?: string;
  confirmVariant?: 'danger' | 'primary';
}

export interface CustomMarker {
  id: string;                       // 唯一标识
  name: string;                     // 名称
  description: string;              // 描述
  color: string;                    // 颜色（hex格式）
  active: boolean;                  // 是否激活
  type: 'instant' | 'continuous';   // 类型：瞬时/持续
  key: string;                      // 按键（如 'a', 'Space', 'Enter'等）
  createdAt?: string;               // 创建时间
}
