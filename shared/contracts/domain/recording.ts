/**
 * 录制相关类型定义
 */

/**
 * 录制标记类型
 */
export interface RecordingMarker {
  type: 'custom' | 'trigger';
  name?: string;          // 自定义标记名称
  triggerValue?: number;  // Trigger 值
  timestamp: number;      // 录制时间戳（毫秒）
  videoTime: number;      // 视频时间（毫秒）
}

/**
 * 自定义标记配置
 */
export interface CustomMarkerConfig {
  id: string;
  name: string;
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  color: string;
}

/**
 * 录制会话信息
 */
export interface RecordingSession {
  id: string;
  startTime: number;
  markers: RecordingMarker[];
  subjectId: string;
  experimentId: string;
}
