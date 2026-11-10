import type { ModalityId, RecordingRecord } from '@shared/contracts/domain/models';
import { recordHasModality } from '@shared/domain/recordModalities';
import { isModalityAvailable } from '@shared/domain/modalityAvailability';

export type FacialExportArtifactId = 'video' | 'analysis-json' | 'emotion-events-csv';

export type ExportModalityDefinition = {
  id: ModalityId;
  label: string;
  recordLabel: string;
  emptyLabel: string;
  matchesRecord: (record: RecordingRecord) => boolean;
};

export const EXPORT_MODALITY_REGISTRY: Record<ModalityId, ExportModalityDefinition> = {
  'eye-tracking': {
    id: 'eye-tracking',
    label: '眼动模块数据',
    recordLabel: '眼动模块数据记录',
    emptyLabel: '暂无眼动记录可导出，请先在录制模块生成数据',
    matchesRecord: (record) => recordHasModality(record, 'eye-tracking'),
  },
  'facial-expression': {
    id: 'facial-expression',
    label: '表情模块数据',
    recordLabel: '表情模块数据记录',
    emptyLabel: '暂无表情模块记录可导出，请先完成表情录制或分析',
    matchesRecord: (record) => recordHasModality(record, 'facial-expression'),
  },
  behavior: {
    id: 'behavior',
    label: '行为模块数据',
    recordLabel: '行为模块数据记录',
    emptyLabel: '暂无行为模块记录可导出',
    matchesRecord: (record) => recordHasModality(record, 'behavior'),
  },
  eeg: {
    id: 'eeg',
    label: '脑电模块数据',
    recordLabel: '脑电模块数据记录',
    emptyLabel: '暂无脑电模块记录可导出',
    matchesRecord: (record) => recordHasModality(record, 'eeg'),
  },
  physiology: {
    id: 'physiology',
    label: '生理模块数据',
    recordLabel: '生理模块数据记录',
    emptyLabel: '暂无生理模块记录可导出',
    matchesRecord: (record) => recordHasModality(record, 'physiology'),
  },
  fnirs: {
    id: 'fnirs',
    label: '近红外模块数据',
    recordLabel: '近红外模块数据记录',
    emptyLabel: '暂无近红外模块记录可导出',
    matchesRecord: (record) => recordHasModality(record, 'fnirs'),
  },
  'finger-trajectory': {
    id: 'finger-trajectory',
    label: '手指轨迹模块数据',
    recordLabel: '手指轨迹模块数据记录',
    emptyLabel: '暂无手指轨迹模块记录可导出',
    matchesRecord: (record) => recordHasModality(record, 'finger-trajectory'),
  },
};

export const FACIAL_EXPORT_ARTIFACTS: Array<{
  id: FacialExportArtifactId;
  label: string;
  description: string;
}> = [
  { id: 'video', label: '表情模块源视频', description: '导出与记录详情一致的 MP4 视频文件' },
  { id: 'analysis-json', label: '完整分析 JSON', description: '包含采样点、表情轨道、质量和源视频信息' },
  { id: 'emotion-events-csv', label: '基础表情事件 CSV', description: '导出表情类型、起点、峰值点、终点和峰值强度' },
];

export function getAvailableExportModalities(records: RecordingRecord[]): ModalityId[] {
  return (Object.keys(EXPORT_MODALITY_REGISTRY) as ModalityId[]).filter((id) =>
    isModalityAvailable(id) && records.some(EXPORT_MODALITY_REGISTRY[id].matchesRecord),
  );
}
