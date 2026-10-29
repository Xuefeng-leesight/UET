import React from 'react';
import { buildDerivedExportRows, buildNumericExportMetadata, formatExportVideoTime, resolveExportTimeOfDay, resolveExportMeasurement } from '@shared/domain/eyeExportData';
import { ChevronDown, ChevronRight, Download, Loader2, SlidersHorizontal } from 'lucide-react';
import type { ModalityId, RecordingRecord, Subject } from '@shared/contracts/domain/models';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import { getDisplayRecordName } from '@/features/records/domain/recordDisplayName';
import type { SubjectFieldDef } from '@/shared/types/mrt';
import { useLanguage } from '@/app/i18n/useLanguage';
import CustomSelect from '@/shared/ui/CustomSelect';
import { Modal } from '@/shared/ui/Modal';
import { btnGhost, btnPrimary, btnSecondary } from '@/shared/ui/buttonClasses';
import { tableCellClass, tableHeadClass, tableNumericCellClass, tableRowClass, tableSelectedRowClass } from '@/shared/ui/tableClasses';
import { describeExportOutcome, runEyeTrackingExport, runFacialExport, type ExportFeedback } from '@/features/export/recordExportWorkflow';
import { localizeFacialAnalysisLabel, localizeFacialExpressionLabel } from '@/features/facial/domain/facialLabels';
import {
  EXPORT_MODALITY_REGISTRY,
  FACIAL_EXPORT_ARTIFACTS,
  getAvailableExportModalities,
  type FacialExportArtifactId,
} from '@/features/export/domain/modalityExportRegistry';

interface ExportPageProps {
  records: RecordingRecord[];
  subjects: Subject[];
  subjectFields: SubjectFieldDef[];
  primaryButtonClassName: string;
  projectDir: string | null;
}

type ExportColumnCategory = 'basic' | 'pupil' | 'eyeTracking' | 'aggregate' | 'blink' | 'gyroscope' | 'attributes' | 'aoi' | 'custom';
type ExportFieldDef = {
  key: string;
  label: string;
  labelEn?: string;
  description: string;
  sources?: string[];
  joinSources?: string[][];
  header?: string;
};
type ExportCategoryDef = { key: ExportColumnCategory; label: string; labelEn?: string; fields: ExportFieldDef[] };

const toEnglishHeader = (key: string): string =>
  String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_:]+/g, ' ')
    .trim();

const capitalizeEnglishHeader = (value: string): string =>
  String(value || '')
    .toLowerCase()
    .replace(/[a-z]/, (letter) => letter.toUpperCase());

const EXPORT_CATEGORY_DEFS: ExportCategoryDef[] = [
  {
    key: 'basic',
    label: '基础数据 Basic Data',
    labelEn: 'Basic Data',
    fields: [
      { key: 'record_name', label: '记录名称', labelEn: 'Record Name', description: '当前导出记录名称（来自记录元数据）' },
      { key: 'user', label: '受试者', labelEn: 'Subject', header: 'User', description: '受试者名称（来自记录元数据）' },
      { key: 'eye_data_record', label: '眼动数据记录', labelEn: 'Eye Tracking Data Record', description: '记录ID（来自记录元数据）' },
      {
        key: 'time_of_day',
        label: '可读时间（时:分:秒.毫秒）',
        labelEn: 'Readable Time (HH:mm:ss.ms)',
        header: 'Time of Day[HH:mm:ss.ms]',
        description: '由有效录制起始时刻与视频时间计算；缺少时间依据时留空。',
        sources: ['video_time_ms', 'timestamp'],
      },
      {
        key: 'video_time_ms',
        label: '视频时间轴（可读时间）',
        labelEn: 'Video Timeline (Readable Time)',
        header: 'Video Time[HH:mm:ss.ms]',
        description: '视频时间轴（可读时间）',
        sources: ['video_time_ms'],
      },
      { key: 'timestamp', label: '时间戳(ms)', labelEn: 'Timestamp (ms)', header: 'Timestamp[ms]', description: '视频当前播放时间戳（毫秒）', sources: ['video_time_ms', 'timestamp'] },
      {
        key: 'tracking_ratio_pct',
        label: '跟踪有效率(%)',
        labelEn: 'Tracking Validity (%)',
        header: 'Tracking Ratio[%]',
        description: '跟踪有效率（来自记录元数据）',
        sources: ['tracking_ratio_pct'],
      },
      { key: 'sampling_rate_hz', label: '实际采样率(Hz)', labelEn: 'Actual Sampling Rate (Hz)', description: '实际采样率（来自记录元数据）', sources: ['sampling_rate_hz'] },
      {
        key: 'configured_sampling_rate_hz',
        label: '数据采样率(Hz)',
        labelEn: 'Data Sampling Rate (Hz)',
        description: '数据采样率（自动时来自设备实际采样率）',
        sources: ['configured_sampling_rate_hz'],
      },
      { key: 'record_duration_s', label: '时长(s)', labelEn: 'Duration (s)', description: '记录时长（来自记录元数据）', sources: ['record_duration_s'] },
    ],
  },
  {
    key: 'pupil',
    label: '瞳孔数据 Pupil Data',
    labelEn: 'Pupil Data',
    fields: [
      { key: 'left_pupil_bit_mask', label: '左眼瞳孔BitMask', labelEn: 'Left Pupil BitMask', description: '左眼瞳孔数据有效性标志位', sources: ['left_pupil_bit_mask'] },
      { key: 'left_pupil_center_x', label: '左眼瞳孔中心X', labelEn: 'Left Pupil Center X', description: '左眼瞳孔中心 x（眼图归一化坐标）', sources: ['left_pupil_center_x', 'leftPupilCenterX'] },
      { key: 'left_pupil_center_y', label: '左眼瞳孔中心Y', labelEn: 'Left Pupil Center Y', description: '左眼瞳孔中心 y（眼图归一化坐标）', sources: ['left_pupil_center_y', 'leftPupilCenterY'] },
      { key: 'left_pupil_minor_axis', label: '左眼瞳孔短轴', labelEn: 'Left Pupil Minor Axis', description: '左眼瞳孔短轴（像素短轴/眼图宽度）', sources: ['left_pupil_minor_axis'] },
      { key: 'left_pupil_minor_axis_mm', label: '左眼瞳孔短轴(mm)', labelEn: 'Left Pupil Minor Axis (mm)', description: '左眼瞳孔短轴（毫米）', sources: ['left_pupil_minor_axis_mm'] },
      { key: 'right_pupil_bit_mask', label: '右眼瞳孔BitMask', labelEn: 'Right Pupil BitMask', description: '右眼瞳孔数据有效性标志位', sources: ['right_pupil_bit_mask'] },
      { key: 'right_pupil_center_x', label: '右眼瞳孔中心X', labelEn: 'Right Pupil Center X', description: '右眼瞳孔中心 x（眼图归一化坐标）', sources: ['right_pupil_center_x', 'rightPupilCenterX'] },
      { key: 'right_pupil_center_y', label: '右眼瞳孔中心Y', labelEn: 'Right Pupil Center Y', description: '右眼瞳孔中心 y（眼图归一化坐标）', sources: ['right_pupil_center_y', 'rightPupilCenterY'] },
      { key: 'right_pupil_minor_axis', label: '右眼瞳孔短轴', labelEn: 'Right Pupil Minor Axis', description: '右眼瞳孔短轴（像素短轴/眼图宽度）', sources: ['right_pupil_minor_axis'] },
      { key: 'right_pupil_minor_axis_mm', label: '右眼瞳孔短轴(mm)', labelEn: 'Right Pupil Minor Axis (mm)', description: '右眼瞳孔短轴（毫米）', sources: ['right_pupil_minor_axis_mm'] },
      { key: 'left_pupil_diameter', label: '左眼瞳孔直径', labelEn: 'Left Pupil Diameter', description: '左眼瞳孔直径（像素直径/眼图宽度）', sources: ['left_pupil_diameter', 'leftPupilDiameter'] },
      { key: 'right_pupil_diameter', label: '右眼瞳孔直径', labelEn: 'Right Pupil Diameter', description: '右眼瞳孔直径（像素直径/眼图宽度）', sources: ['right_pupil_diameter', 'rightPupilDiameter'] },
      { key: 'left_pupil_diameter_mm', label: '左眼瞳孔直径(mm)', labelEn: 'Left Pupil Diameter (mm)', description: '左眼瞳孔直径（毫米）', sources: ['left_pupil_diameter_mm', 'leftPupilDiameterMm'] },
      { key: 'right_pupil_diameter_mm', label: '右眼瞳孔直径(mm)', labelEn: 'Right Pupil Diameter (mm)', description: '右眼瞳孔直径（毫米）', sources: ['right_pupil_diameter_mm', 'rightPupilDiameterMm'] },
      { key: 'left_pupil_distance', label: '左眼瞳孔距离', labelEn: 'Left Pupil Distance', description: '左眼瞳孔距离/深度；Pupil 未获得同义来源时留空', sources: ['left_pupil_distance'] },
      { key: 'right_pupil_distance', label: '右眼瞳孔距离', labelEn: 'Right Pupil Distance', description: '右眼瞳孔距离/深度；Pupil 未获得同义来源时留空', sources: ['right_pupil_distance'] },
    ],
  },
  {
    key: 'eyeTracking',
    label: '眼动数据 Eye Tracking Data',
    labelEn: 'Eye Tracking Data',
    fields: [
      { key: 'recommend', label: '推荐注视', labelEn: 'Recommended Fixation', description: '是否使用推荐注视', sources: ['recommend'] },
      { key: 'recom_gaze_x', label: '推荐注视X', labelEn: 'Recommended Fixation X', description: '推荐注视坐标 x', sources: ['recom_gaze_x', 'recomGazeX'] },
      { key: 'recom_gaze_y', label: '推荐注视Y', labelEn: 'Recommended Fixation Y', description: '推荐注视坐标 y', sources: ['recom_gaze_y', 'recomGazeY'] },
      { key: 'recom_gaze_bit_mask', label: '推荐注视BitMask', labelEn: 'Recommended Fixation BitMask', description: '推荐注视数据有效性标志位', sources: ['recom_gaze_bit_mask'] },
      { key: 'recom_gaze_point_x', label: '推荐注视点X', labelEn: 'Recommended Fixation Point X', description: '推荐注视点（3D）x', sources: ['recom_gaze_point_x'] },
      { key: 'recom_gaze_point_y', label: '推荐注视点Y', labelEn: 'Recommended Fixation Point Y', description: '推荐注视点（3D）y', sources: ['recom_gaze_point_y'] },
      { key: 'recom_gaze_point_z', label: '推荐注视点Z', labelEn: 'Recommended Fixation Point Z', description: '推荐注视点（3D）z', sources: ['recom_gaze_point_z'] },
      { key: 'recom_raw_point_x', label: '推荐原始点X', labelEn: 'Recommended Raw Point X', description: '推荐注视原始点（3D）x', sources: ['recom_raw_point_x'] },
      { key: 'recom_raw_point_y', label: '推荐原始点Y', labelEn: 'Recommended Raw Point Y', description: '推荐注视原始点（3D）y', sources: ['recom_raw_point_y'] },
      { key: 'recom_raw_point_z', label: '推荐原始点Z', labelEn: 'Recommended Raw Point Z', description: '推荐注视原始点（3D）z', sources: ['recom_raw_point_z'] },
      { key: 'recom_smooth_point_x', label: '推荐平滑点X', labelEn: 'Recommended Smoothed Point X', description: '推荐平滑点x；Pupil为MRT因果低通v1（τ=25ms，场景相机毫米），需连续合格三维样本；其他设备保留源算法', sources: ['recom_smooth_point_x'] },
      { key: 'recom_smooth_point_y', label: '推荐平滑点Y', labelEn: 'Recommended Smoothed Point Y', description: '推荐平滑点y；Pupil为MRT因果低通v1（τ=25ms，场景相机毫米），需连续合格三维样本；其他设备保留源算法', sources: ['recom_smooth_point_y'] },
      { key: 'recom_smooth_point_z', label: '推荐平滑点Z', labelEn: 'Recommended Smoothed Point Z', description: '推荐平滑点z；Pupil为MRT因果低通v1（τ=25ms，场景相机毫米），需连续合格三维样本；其他设备保留源算法', sources: ['recom_smooth_point_z'] },
      { key: 'recom_origin_x', label: '推荐射线起点X', labelEn: 'Recommended Ray Origin X', description: '推荐注视射线起点（3D）x', sources: ['recom_origin_x'] },
      { key: 'recom_origin_y', label: '推荐射线起点Y', labelEn: 'Recommended Ray Origin Y', description: '推荐注视射线起点（3D）y', sources: ['recom_origin_y'] },
      { key: 'recom_origin_z', label: '推荐射线起点Z', labelEn: 'Recommended Ray Origin Z', description: '推荐注视射线起点（3D）z', sources: ['recom_origin_z'] },
      { key: 'recom_direction_x', label: '推荐射线方向X', labelEn: 'Recommended Ray Direction X', description: '推荐注视射线方向（3D）x', sources: ['recom_direction_x'] },
      { key: 'recom_direction_y', label: '推荐射线方向Y', labelEn: 'Recommended Ray Direction Y', description: '推荐注视射线方向（3D）y', sources: ['recom_direction_y'] },
      { key: 'recom_direction_z', label: '推荐射线方向Z', labelEn: 'Recommended Ray Direction Z', description: '推荐注视射线方向（3D）z', sources: ['recom_direction_z'] },
      { key: 'recom_re', label: '推荐注视置信度', labelEn: 'Recommended Fixation Confidence', description: 'SDK推荐注视点置信度（re）', sources: ['recom_re'] },
      { key: 'left_gaze_x', label: '左眼注视X', labelEn: 'Left Gaze X', description: '左眼注视坐标 x', sources: ['left_gaze_x', 'leftGazeX'] },
      { key: 'left_gaze_y', label: '左眼注视Y', labelEn: 'Left Gaze Y', description: '左眼注视坐标 y', sources: ['left_gaze_y', 'leftGazeY'] },
      { key: 'left_gaze_bit_mask', label: '左眼注视BitMask', labelEn: 'Left Gaze BitMask', description: '左眼注视数据有效性标志位', sources: ['left_gaze_bit_mask'] },
      { key: 'left_gaze_point_x', label: '左眼注视点X', labelEn: 'Left Gaze Point X', description: '左眼注视点（3D）x', sources: ['left_gaze_point_x'] },
      { key: 'left_gaze_point_y', label: '左眼注视点Y', labelEn: 'Left Gaze Point Y', description: '左眼注视点（3D）y', sources: ['left_gaze_point_y'] },
      { key: 'left_gaze_point_z', label: '左眼注视点Z', labelEn: 'Left Gaze Point Z', description: '左眼注视点（3D）z', sources: ['left_gaze_point_z'] },
      { key: 'left_raw_point_x', label: '左眼原始点X', labelEn: 'Left Raw Point X', description: '左眼注视原始点（3D）x', sources: ['left_raw_point_x'] },
      { key: 'left_raw_point_y', label: '左眼原始点Y', labelEn: 'Left Raw Point Y', description: '左眼注视原始点（3D）y', sources: ['left_raw_point_y'] },
      { key: 'left_raw_point_z', label: '左眼原始点Z', labelEn: 'Left Raw Point Z', description: '左眼注视原始点（3D）z', sources: ['left_raw_point_z'] },
      { key: 'left_smooth_point_x', label: '左眼平滑点X', labelEn: 'Left Smoothed Point X', description: '左眼平滑点x；Pupil为MRT因果低通v1（τ=25ms，场景相机毫米），需连续合格三维样本；其他设备保留源算法', sources: ['left_smooth_point_x'] },
      { key: 'left_smooth_point_y', label: '左眼平滑点Y', labelEn: 'Left Smoothed Point Y', description: '左眼平滑点y；Pupil为MRT因果低通v1（τ=25ms，场景相机毫米），需连续合格三维样本；其他设备保留源算法', sources: ['left_smooth_point_y'] },
      { key: 'left_smooth_point_z', label: '左眼平滑点Z', labelEn: 'Left Smoothed Point Z', description: '左眼平滑点z；Pupil为MRT因果低通v1（τ=25ms，场景相机毫米），需连续合格三维样本；其他设备保留源算法', sources: ['left_smooth_point_z'] },
      { key: 'left_origin_x', label: '左眼射线起点X', labelEn: 'Left Ray Origin X', description: '左眼注视射线起点（3D）x', sources: ['left_origin_x'] },
      { key: 'left_origin_y', label: '左眼射线起点Y', labelEn: 'Left Ray Origin Y', description: '左眼注视射线起点（3D）y', sources: ['left_origin_y'] },
      { key: 'left_origin_z', label: '左眼射线起点Z', labelEn: 'Left Ray Origin Z', description: '左眼注视射线起点（3D）z', sources: ['left_origin_z'] },
      { key: 'left_direction_x', label: '左眼射线方向X', labelEn: 'Left Ray Direction X', description: '左眼注视射线方向（3D）x', sources: ['left_direction_x'] },
      { key: 'left_direction_y', label: '左眼射线方向Y', labelEn: 'Left Ray Direction Y', description: '左眼注视射线方向（3D）y', sources: ['left_direction_y'] },
      { key: 'left_direction_z', label: '左眼射线方向Z', labelEn: 'Left Ray Direction Z', description: '左眼注视射线方向（3D）z', sources: ['left_direction_z'] },
      { key: 'left_re', label: '左眼注视置信度', labelEn: 'Left Fixation Confidence', description: '左眼注视置信度/拟合误差（re）', sources: ['left_re'] },
      { key: 'right_gaze_x', label: '右眼注视X', labelEn: 'Right Gaze X', description: '右眼注视坐标 x', sources: ['right_gaze_x', 'rightGazeX'] },
      { key: 'right_gaze_y', label: '右眼注视Y', labelEn: 'Right Gaze Y', description: '右眼注视坐标 y', sources: ['right_gaze_y', 'rightGazeY'] },
      { key: 'right_gaze_bit_mask', label: '右眼注视BitMask', labelEn: 'Right Gaze BitMask', description: '右眼注视数据有效性标志位', sources: ['right_gaze_bit_mask'] },
      { key: 'right_gaze_point_x', label: '右眼注视点X', labelEn: 'Right Gaze Point X', description: '右眼注视点（3D）x', sources: ['right_gaze_point_x'] },
      { key: 'right_gaze_point_y', label: '右眼注视点Y', labelEn: 'Right Gaze Point Y', description: '右眼注视点（3D）y', sources: ['right_gaze_point_y'] },
      { key: 'right_gaze_point_z', label: '右眼注视点Z', labelEn: 'Right Gaze Point Z', description: '右眼注视点（3D）z', sources: ['right_gaze_point_z'] },
      { key: 'right_raw_point_x', label: '右眼原始点X', labelEn: 'Right Raw Point X', description: '右眼注视原始点（3D）x', sources: ['right_raw_point_x'] },
      { key: 'right_raw_point_y', label: '右眼原始点Y', labelEn: 'Right Raw Point Y', description: '右眼注视原始点（3D）y', sources: ['right_raw_point_y'] },
      { key: 'right_raw_point_z', label: '右眼原始点Z', labelEn: 'Right Raw Point Z', description: '右眼注视原始点（3D）z', sources: ['right_raw_point_z'] },
      { key: 'right_smooth_point_x', label: '右眼平滑点X', labelEn: 'Right Smoothed Point X', description: '右眼平滑点x；Pupil为MRT因果低通v1（τ=25ms，场景相机毫米），需连续合格三维样本；其他设备保留源算法', sources: ['right_smooth_point_x'] },
      { key: 'right_smooth_point_y', label: '右眼平滑点Y', labelEn: 'Right Smoothed Point Y', description: '右眼平滑点y；Pupil为MRT因果低通v1（τ=25ms，场景相机毫米），需连续合格三维样本；其他设备保留源算法', sources: ['right_smooth_point_y'] },
      { key: 'right_smooth_point_z', label: '右眼平滑点Z', labelEn: 'Right Smoothed Point Z', description: '右眼平滑点z；Pupil为MRT因果低通v1（τ=25ms，场景相机毫米），需连续合格三维样本；其他设备保留源算法', sources: ['right_smooth_point_z'] },
      { key: 'right_origin_x', label: '右眼射线起点X', labelEn: 'Right Ray Origin X', description: '右眼注视射线起点（3D）x', sources: ['right_origin_x'] },
      { key: 'right_origin_y', label: '右眼射线起点Y', labelEn: 'Right Ray Origin Y', description: '右眼注视射线起点（3D）y', sources: ['right_origin_y'] },
      { key: 'right_origin_z', label: '右眼射线起点Z', labelEn: 'Right Ray Origin Z', description: '右眼注视射线起点（3D）z', sources: ['right_origin_z'] },
      { key: 'right_direction_x', label: '右眼射线方向X', labelEn: 'Right Ray Direction X', description: '右眼注视射线方向（3D）x', sources: ['right_direction_x'] },
      { key: 'right_direction_y', label: '右眼射线方向Y', labelEn: 'Right Ray Direction Y', description: '右眼注视射线方向（3D）y', sources: ['right_direction_y'] },
      { key: 'right_direction_z', label: '右眼射线方向Z', labelEn: 'Right Ray Direction Z', description: '右眼注视射线方向（3D）z', sources: ['right_direction_z'] },
      { key: 'right_re', label: '右眼注视置信度', labelEn: 'Right Fixation Confidence', description: '右眼注视置信度/拟合误差（re）', sources: ['right_re'] },
    ],
  },
  {
    key: 'aggregate',
    label: '聚合数据 Aggregate Data',
    labelEn: 'Aggregate Data',
    fields: [
      { key: 'fixation_timestamp', label: '注视时间戳(ms)', labelEn: 'Fixation Timestamp (ms)', header: 'Fixation Timestamp[ms]', description: '注视事件开始时间（毫秒）', sources: ['fixation_timestamp_ms', 'fixation_timestamp', 'fixationTimestampMs'] },
      { key: 'fixation_duration', label: '注视持续时长', labelEn: 'Fixation Duration', header: 'Fixation Duration[ms]', description: '完成后的注视事件持续时间（毫秒）', sources: ['fixation_duration_ms', 'fixation_duration', 'fixationDurationMs'] },
      { key: 'fixation_count', label: '注视序号', labelEn: 'Fixation Index', header: 'Fixation Index', description: '从 1 开始的注视事件序号', sources: ['fixation_index', 'fixation_count', 'fixationCount'] },
      { key: 'fixation_state', label: '注视状态', labelEn: 'Fixation Status', description: '注视状态字段', sources: ['fixation_state', 'fixationState'] },
      { key: 'fixation_center_x', label: '注视中心X', labelEn: 'Fixation Center X', header: 'Fixation Point X[px]', description: '注视事件中心的绝对像素坐标 x', sources: ['fixation_point_x_px', 'fixation_center_x', 'fixationCenterX'] },
      { key: 'fixation_center_y', label: '注视中心Y', labelEn: 'Fixation Center Y', header: 'Fixation Point Y[px]', description: '注视事件中心的绝对像素坐标 y', sources: ['fixation_point_y_px', 'fixation_center_y', 'fixationCenterY'] },
      { key: 'invalid_gaze_index', label: '无效眼动序号', labelEn: 'Invalid Gaze Index', header: 'Invalid Gaze Index', description: '连续无效采样段；独立事件和缺失状态不算无效采样', sources: ['invalid_gaze_index'] },
      { key: 'invalid_gaze_duration_ms', label: '无效眼动时长(ms)', labelEn: 'Invalid Gaze Duration (ms)', header: 'Invalid Gaze Duration[ms]', description: '连续无效采样段的可观测时长；不跨越断档、重连或刺激物切换', sources: ['invalid_gaze_duration_ms'] },
      { key: 'saccade_index', label: '眼跳序号', labelEn: 'Saccade Index', header: 'Saccade Index', description: '从 1 开始的眼跳事件序号', sources: ['saccade_index'] },
      { key: 'saccade_duration_ms', label: '眼跳持续时长', labelEn: 'Saccade Duration', header: 'Saccade Duration[ms]', description: '眼跳事件持续时间（毫秒）', sources: ['saccade_duration_ms', 'saccade_duration', 'saccadeDurationMs'] },
      { key: 'saccade_amplitude_px', label: '眼跳幅度(px)', labelEn: 'Saccade Amplitude (px)', header: 'Saccade Amplitude[px]', description: '相邻注视中心之间的像素距离', sources: ['saccade_distance_px', 'saccade_amplitude_px'] },
      { key: 'average_saccade_velocity_px_ms', label: '平均眼跳速度', labelEn: 'Average Saccade Velocity', header: 'Average Saccade Velocity[px/ms]', description: '眼跳期间逐采样像素速度的平均值', sources: ['average_saccade_velocity_px_ms', 'saccade_velocity', 'saccadeVelocity'] },
      { key: 'peak_saccade_velocity_px_ms', label: '最大眼跳速度(px/ms)', labelEn: 'Peak Saccade Velocity (px/ms)', header: 'Peak Saccade Velocity[px/ms]', description: '眼跳期间逐采样像素速度的最大值', sources: ['peak_saccade_velocity_px_ms', 'saccade_peak_velocity', 'saccadePeakVelocity'] },
      { key: 'gaze_velocity_px_ms', label: '注视速度(px/ms)', labelEn: 'Gaze Velocity (px/ms)', header: 'Gaze Velocity[px/ms]', description: '相邻采样点的像素速度', sources: ['gaze_velocity_px_ms'] },
      { key: 'gaze_velocity_deg_ms', label: '注视角速度(deg/ms)', labelEn: 'Gaze Angular Velocity (deg/ms)', header: 'Gaze Velocity[deg/ms]', description: '相邻视线方向的角速度', sources: ['gaze_velocity_deg_ms'] },
      { key: 'saccade_distance_deg', label: '眼跳角距离', labelEn: 'Saccade Angular Distance', header: 'Saccade Distance[deg]', description: '相邻注视视线方向之间的角距离', sources: ['saccade_distance_deg'] },
      { key: 'average_saccade_velocity_deg_ms', label: '平均眼跳角速度', labelEn: 'Average Saccade Angular Velocity', header: 'Average Saccade Velocity[deg/ms]', description: '眼跳期间逐采样角速度的平均值', sources: ['average_saccade_velocity_deg_ms'] },
      { key: 'peak_saccade_velocity_deg_ms', label: '眼跳峰值角速度', labelEn: 'Peak Saccade Angular Velocity', header: 'Peak Saccade Velocity[deg/ms]', description: '眼跳期间逐采样角速度的最大值', sources: ['peak_saccade_velocity_deg_ms'] },
      { key: 'gaze_velocity_ms', label: '眼动速度（原坐标/ms）', labelEn: 'Eye Movement Velocity (source coordinate/ms)', description: '原二维坐标差/毫秒；不是px/ms', sources: ['gaze_velocity_ms', 'gazeVelocityMs'] },
    ],
  },
  {
    key: 'blink',
    label: '眨眼数据 Blink Data',
    labelEn: 'Blink Data',
    fields: [
      { key: 'blink_index', label: '眨眼序号', labelEn: 'Blink Index', header: 'Blink index', description: '连续眨眼事件序号', sources: ['blink_index'] },
      { key: 'blink_duration_ms', label: '眨眼时长(ms)', labelEn: 'Blink Duration (ms)', header: 'Blink duration[ms]', description: '连续眨眼事件时长', sources: ['blink_duration_ms'] },
      { key: 'blink_marker', label: '眨眼标记', labelEn: 'Blink Marker', header: 'Blink marker', description: '1左眼，2右眼，3双眼', sources: ['blink_marker'] },
      { key: 'left_blink', label: '左眼眨眼', labelEn: 'Left Blink', description: '左眼眨眼状态', sources: ['left_blink', 'leftBlink'] },
      { key: 'left_openness', label: '左眼睁眼程度', labelEn: 'Left Eye Openness', description: '左眼睁眼程度', sources: ['left_openness', 'leftOpenness'] },
      { key: 'left_eyelid_up', label: '左上眼睑', labelEn: 'Left Upper Eyelid', description: '左上眼睑位置', sources: ['left_eyelid_up', 'leftEyelidUp'] },
      { key: 'left_eyelid_down', label: '左下眼睑', labelEn: 'Left Lower Eyelid', description: '左下眼睑位置', sources: ['left_eyelid_down', 'leftEyelidDown'] },
      { key: 'right_blink', label: '右眼眨眼', labelEn: 'Right Blink', description: '右眼眨眼状态', sources: ['right_blink', 'rightBlink'] },
      { key: 'right_openness', label: '右眼睁眼程度', labelEn: 'Right Eye Openness', description: '右眼睁眼程度', sources: ['right_openness', 'rightOpenness'] },
      { key: 'right_eyelid_up', label: '右上眼睑', labelEn: 'Right Upper Eyelid', description: '右上眼睑位置', sources: ['right_eyelid_up', 'rightEyelidUp'] },
      { key: 'right_eyelid_down', label: '右下眼睑', labelEn: 'Right Lower Eyelid', description: '右下眼睑位置', sources: ['right_eyelid_down', 'rightEyelidDown'] },
    ],
  },
  {
    key: 'gyroscope',
    label: '陀螺仪数据（仅眼镜式） Gyroscope Data (Glasses Only)',
    labelEn: 'Gyroscope Data (Glasses Only)',
    fields: [
      { key: 'gyro_timestamp', label: '陀螺仪时间戳', labelEn: 'Gyroscope Timestamp', header: 'Gyroscope timestamp', description: '眼镜式陀螺仪时间戳', sources: ['gyro_timestamp'] },
      {
        key: 'gyro_quaternion',
        label: '四元数',
        labelEn: 'Quaternion',
        header: 'Quat_data',
        description: '四元数4个分量，按0,1,2,3顺序以逗号合并',
        joinSources: [
          ['quat_data[0]', 'gyro_quaternion_0'],
          ['quat_data[1]', 'gyro_quaternion_1'],
          ['quat_data[2]', 'gyro_quaternion_2'],
          ['quat_data[3]', 'gyro_quaternion_3'],
        ],
      },
      {
        key: 'gyroscope',
        label: '角速度',
        labelEn: 'Angular Velocity',
        header: 'Gyro',
        description: '角速度3个分量，按0,1,2顺序以逗号合并',
        joinSources: [
          ['gyro[0]', 'gyroscope_x'],
          ['gyro[1]', 'gyroscope_y'],
          ['gyro[2]', 'gyroscope_z'],
        ],
      },
      {
        key: 'acceleration',
        label: '加速度',
        labelEn: 'Acceleration',
        header: 'Accel',
        description: '加速度3个分量，按0,1,2顺序以逗号合并',
        joinSources: [
          ['accel[0]', 'acceleration_x'],
          ['accel[1]', 'acceleration_y'],
          ['accel[2]', 'acceleration_z'],
        ],
      },
      {
        key: 'magnetometer',
        label: '磁强度',
        labelEn: 'Magnetic Intensity',
        header: 'Mag',
        description: '磁强度3个分量，按0,1,2顺序以逗号合并',
        joinSources: [
          ['mag[0]', 'magnetometer_x'],
          ['mag[1]', 'magnetometer_y'],
          ['mag[2]', 'magnetometer_z'],
        ],
      },
    ],
  },
  {
    key: 'attributes',
    label: '属性数据 Subject Attributes',
    labelEn: 'Subject Attributes',
    fields: [],
  },
  {
    key: 'aoi',
    label: 'AOI数据 AOI Data',
    labelEn: 'AOI Data',
    fields: [
      { key: 'aoi_id', label: 'AOI编号', labelEn: 'AOI ID', description: '原记录AOI标识；多个AOI按存储顺序输出同序JSON数组', sources: ['aoi_id'] },
      { key: 'aoi_name', label: 'AOI名称', labelEn: 'AOI Name', description: '原记录AOI名称；与AOI编号同序', sources: ['aoi_name'] },
      { key: 'aoi_hit', label: 'AOI命中', labelEn: 'AOI Hit', description: '可信采样区域内为1、区域外为0；未知位置或停用范围留空', sources: ['aoi_hit'] },
      { key: 'aoi_enter_time_ms', label: 'AOI进入时间(ms)', labelEn: 'AOI Enter Time (ms)', description: '本次连续访问首次观测到区域内采样的视频时间', sources: ['aoi_enter_time_ms'] },
      { key: 'aoi_exit_time_ms', label: 'AOI离开时间(ms)', labelEn: 'AOI Exit Time (ms)', description: '仅在连续可信的首个区域外采样行写入；断档和末尾不补造', sources: ['aoi_exit_time_ms'] },
      { key: 'aoi_dwell_time_ms', label: 'AOI停留时长(ms)', labelEn: 'AOI Dwell Time (ms)', description: '本次访问已观测的区域内首末采样跨度，不跨无效采样或断档', sources: ['aoi_dwell_time_ms'] },
      { key: 'aoi_fixation_count', label: 'AOI注视次数', labelEn: 'AOI Fixation Count', description: '本次访问内截至当前行已结束且去重的完整注视；缺事件依据留空', sources: ['aoi_fixation_count'] },
    ],
  },
  {
    key: 'custom',
    label: '自定义数据 Custom Data',
    labelEn: 'Custom Data',
    fields: [
      { key: 'stimulus', label: '刺激物', labelEn: 'Stimulus', description: '当前刺激物名称/标识', sources: ['stimulus'] },
      { key: 'triggerMark', label: '触发标记', labelEn: 'Trigger Marker', description: '触发标记', sources: ['triggerMark'] },
      { key: 'customMarker', label: '自定义标记', labelEn: 'Custom Marker', description: '自定义标记', sources: ['customMarker'] },
      { key: 'udp_send', label: 'UDP发送', labelEn: 'UDP Send', description: 'UDP发送数据', sources: ['udp_send'] },
      { key: 'udp_receive', label: 'UDP接收', labelEn: 'UDP Receive', description: 'UDP接收数据', sources: ['udp_receive'] },
      { key: 'trigger_send', label: '触发发送', labelEn: 'Trigger Send', description: '串口发送数据', sources: ['trigger_send'] },
      { key: 'trigger_receive', label: '触发接收', labelEn: 'Trigger Receive', description: '串口接收数据', sources: ['trigger_receive'] },
    ],
  },
];

const ExportPage: React.FC<ExportPageProps> = ({ records, subjects, subjectFields, projectDir }) => {
  const { language } = useLanguage();
  const isEn = language === 'en-US';
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [durationById, setDurationById] = React.useState<Record<string, number>>({});
  const [isSettingsOpen, setIsSettingsOpen] = React.useState(false);
  const [selectedColumns, setSelectedColumns] = React.useState<Set<string>>(new Set());
  const [includeSubjectAttributes, setIncludeSubjectAttributes] = React.useState(false);
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<ExportColumnCategory>>(new Set());
  const [exporting, setExporting] = React.useState(false);
  const [feedback, setFeedback] = React.useState<ExportFeedback | null>(null);
  const exportBusyRef = React.useRef(false);
  const operationRef = React.useRef(0);
  const previewOperationRef = React.useRef(0);
  const [previewRecord, setPreviewRecord] = React.useState<RecordingRecord | null>(null);
  const [previewData, setPreviewData] = React.useState<string[][]>([]);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [exportModality, setExportModality] = React.useState<ModalityId>('eye-tracking');
  const [selectedFacialArtifacts, setSelectedFacialArtifacts] = React.useState<Set<FacialExportArtifactId>>(
    new Set(FACIAL_EXPORT_ARTIFACTS.map((artifact) => artifact.id)),
  );
  const availableModalities = React.useMemo(() => getAvailableExportModalities(records), [records]);
  const modalityRecords = React.useMemo(
    () => records.filter(EXPORT_MODALITY_REGISTRY[exportModality].matchesRecord),
    [records, exportModality],
  );
  const resolveRecordDisplayName = (record: RecordingRecord): string => getDisplayRecordName(record);
  const resolveRecordExportName = (record: RecordingRecord): string => {
    const displayName = resolveRecordDisplayName(record).trim();
    if (displayName && displayName !== '—') return displayName;
    const rawName = typeof record.name === 'string' ? record.name.trim() : '';
    if (rawName) return rawName;
    return record.id;
  };

  const formatDuration = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '--';
    const mm = Math.floor(seconds / 60);
    const ss = seconds - mm * 60;
    const ssInt = Math.floor(ss);
    const tenth = Math.floor((ss - ssInt) * 10);
    return `${String(mm).padStart(2, '0')}:${String(ssInt).padStart(2, '0')}.${tenth}`;
  };

  const fmt = (v: unknown, digits = 1): string => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    if (digits <= 0) return String(Math.round(v));
    return v.toFixed(digits);
  };

  const fmtInt = (v: unknown): string => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    if (v <= 0) return '—';
    return String(Math.round(v));
  };

  const fmtScore = (left: unknown, right: unknown): string => {
    const l = typeof left === 'number' && Number.isFinite(left) ? left : null;
    const r = typeof right === 'number' && Number.isFinite(right) ? right : null;
    if (l === null && r === null) return '—';
    return `${l !== null ? l.toFixed(2) : '—'} : ${r !== null ? r.toFixed(2) : '—'}`;
  };

  const normalizeName = React.useCallback(
    (value: unknown): string =>
      String(value ?? '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLocaleLowerCase(),
    [],
  );

  const subjectNameToSubject = React.useMemo(() => {
    const map = new Map<string, Subject>();
    for (const s of subjects) {
      const name = String(s['姓名'] ?? s.name ?? '').trim();
      if (!name) continue;
      const key = normalizeName(name);
      if (!map.has(key)) map.set(key, s);
    }
    return map;
  }, [subjects, normalizeName]);

  const builtinSubjectFieldLabels = React.useMemo(
    () =>
      new Set(
        (subjectFields || [])
          .filter((field) => Boolean(field?.builtin))
          .map((field) => String(field?.label || '').trim())
          .filter((label) => label.length > 0),
      ),
    [subjectFields],
  );

  const makeSubjectFieldKey = React.useCallback((label: string): string => `subject_info::${encodeURIComponent(label)}`, []);

  const subjectAttributeFields = React.useMemo<ExportFieldDef[]>(
    () =>
      (subjectFields || [])
        .map((field) => String(field?.label || '').trim())
        .filter((label) => label.length > 0)
        .map((label) => ({
          key: makeSubjectFieldKey(label),
          label,
          description: `受试者字段：${label}`,
          sources: [],
        })),
    [subjectFields, makeSubjectFieldKey],
  );

  const groupedColumns = React.useMemo(
    () =>
      EXPORT_CATEGORY_DEFS.map((group) =>
        group.key === 'attributes'
          ? {
              ...group,
              fields: subjectAttributeFields,
            }
          : group,
      ),
    [subjectAttributeFields],
  );

  const allFieldDefs = React.useMemo(() => groupedColumns.flatMap((group) => group.fields), [groupedColumns]);
  const availableColumns = React.useMemo(() => allFieldDefs.map((field) => field.key), [allFieldDefs]);
  const subjectAttributeFieldKeys = React.useMemo(() => subjectAttributeFields.map((field) => field.key), [subjectAttributeFields]);

  const fieldByKey = React.useMemo(() => {
    const map: Record<string, ExportFieldDef> = {};
    for (const field of allFieldDefs) map[field.key] = field;
    return map;
  }, [allFieldDefs]);

  const columnHeaderMap = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const field of allFieldDefs) {
      map[field.key] = capitalizeEnglishHeader(field.header ?? toEnglishHeader(field.key));
    }
    return map;
  }, [allFieldDefs]);

  const columnSourceMap = React.useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const field of allFieldDefs) {
      map[field.key] = Array.isArray(field.sources) && field.sources.length > 0 ? field.sources : [field.key];
    }
    return map;
  }, [allFieldDefs]);

  const columnJoinSourceMap = React.useMemo(() => {
    const map: Record<string, string[][]> = {};
    for (const field of allFieldDefs) {
      if (Array.isArray(field.joinSources) && field.joinSources.length > 0) {
        map[field.key] = field.joinSources;
      }
    }
    return map;
  }, [allFieldDefs]);

  const getColumnLabel = (key: string): string => {
    const field = fieldByKey[key];
    if (!field) return key;
    return isEn ? (field.labelEn || field.label) : field.label;
  };
  const getColumnHeader = (key: string): string =>
    capitalizeEnglishHeader(fieldByKey[key]?.header ?? toEnglishHeader(key));

  const buildSubjectInfoForRecord = React.useCallback(
    (record: RecordingRecord): Record<string, string> => {
      const key = normalizeName(record.subjectName);
      const subject = key ? subjectNameToSubject.get(key) : undefined;
      if (!subject) return {};

      const out: Record<string, string> = {};
      for (const field of subjectFields) {
        const label = String(field?.label || '').trim();
        if (!label) continue;
        let value = subject[label];
        if (typeof value === 'undefined' || value === null || value === '') {
          if (label === '姓名') value = subject['姓名'] ?? subject.name ?? '';
          else if (label === '性别') value = subject['性别'] ?? subject.gender ?? '';
          else if (label === '年龄') value = subject['年龄'] ?? subject.age ?? '';
        }
        out[label] = value === null || typeof value === 'undefined' ? '' : String(value);
      }
      return out;
    },
    [normalizeName, subjectFields, subjectNameToSubject],
  );

  const buildRecordMetadataValues = React.useCallback(
    (record: RecordingRecord): Record<string, string> => ({
      record_name: resolveRecordExportName(record),
      user: typeof record.subjectName === 'string' ? record.subjectName : '',
      eye_data_record: record.id || '',
      ...buildNumericExportMetadata(record),
    }),
    [],
  );

  React.useEffect(() => {
    if (availableModalities.length > 0 && !availableModalities.includes(exportModality)) {
      setExportModality(availableModalities[0]);
    }
  }, [availableModalities, exportModality]);

  React.useEffect(() => {
    operationRef.current += 1;
    previewOperationRef.current += 1;
    exportBusyRef.current = false;
    setExporting(false);
    setFeedback(null);
    setSelectedIds(new Set());
    setPreviewRecord(null);
    setPreviewData([]);
    setPreviewLoading(false);
    setPreviewError(null);
    return () => {
      operationRef.current += 1;
      previewOperationRef.current += 1;
      exportBusyRef.current = false;
    };
  }, [exportModality, projectDir]);

  React.useEffect(() => {
    const next = new Set<string>();
    for (const r of modalityRecords) {
      if (selectedIds.has(r.id)) {
        next.add(r.id);
      }
    }
    if (next.size !== selectedIds.size) {
      setSelectedIds(next);
    }
  }, [modalityRecords]);

  React.useEffect(() => {
    setSelectedColumns((prev) => {
      const valid = new Set(availableColumns);
      const next = new Set<string>();
      prev.forEach((key) => {
        if (valid.has(key)) next.add(key);
      });
      if (prev.size === 0) {
        for (const key of availableColumns) {
          if (!subjectAttributeFieldKeys.includes(key)) {
            next.add(key);
          }
        }
      }
      return next;
    });
  }, [availableColumns, subjectAttributeFieldKeys]);

  React.useEffect(() => {
    if (subjectAttributeFieldKeys.length === 0) return;
    setSelectedColumns((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const key of subjectAttributeFieldKeys) {
        if (includeSubjectAttributes) {
          if (!next.has(key)) {
            next.add(key);
            changed = true;
          }
        } else if (next.has(key)) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [includeSubjectAttributes, subjectAttributeFieldKeys]);

  React.useEffect(() => {
    if (subjectAttributeFieldKeys.length === 0 && includeSubjectAttributes) {
      setIncludeSubjectAttributes(false);
    }
  }, [subjectAttributeFieldKeys, includeSubjectAttributes]);

  React.useEffect(() => {
    let cancelled = false;
    for (const r of records) {
      if (!r.mp4Url || durationById[r.id] !== undefined) continue;
      const el = document.createElement('video');
      el.preload = 'metadata';
      el.src = r.mp4Url;
      el.onloadedmetadata = () => {
        if (cancelled) return;
        const d = el.duration;
        if (Number.isFinite(d) && d > 0) {
          setDurationById((prev) => (prev[r.id] !== undefined ? prev : { ...prev, [r.id]: d }));
        }
      };
      el.onerror = () => {};
    }
    return () => {
      cancelled = true;
    };
  }, [records, durationById]);

  const openSettings = () => {
    setCollapsedGroups(new Set(groupedColumns.map((group) => group.key)));
    setIsSettingsOpen(true);
  };

  const toggleAll = (checked: boolean) => {
    if (!checked) {
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds(new Set(modalityRecords.map((r) => r.id)));
  };

  const toggleOne = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const exportRecords = async (ids: string[]) => {
    if (exportBusyRef.current) return;
    if (!ipcClient.isAvailable()) {
      setFeedback({ kind: 'error', message: isEn ? 'Export is only available in the desktop app.' : '请在桌面应用中导出数据。' });
      return;
    }
    const targets = modalityRecords
      .filter((r) => ids.includes(r.id))
      .filter((r) => typeof r.csvPath === 'string' && r.csvPath.length > 0)
      .map((r) => ({
        id: r.id,
        name: resolveRecordExportName(r),
        csvPath: r.csvPath as string,
        projectDir: projectDir || undefined,
        deviceType: r.deviceType,
        subjectName: typeof r.subjectName === 'string' ? r.subjectName : '',
        subjectInfo: buildSubjectInfoForRecord(r),
        metadataValues: buildRecordMetadataValues(r),
        timestamp: typeof r.timestamp === 'string' ? r.timestamp : '',
        videoWidth: typeof r.videoWidth === 'number' && Number.isFinite(r.videoWidth) ? r.videoWidth : undefined,
        videoHeight: typeof r.videoHeight === 'number' && Number.isFinite(r.videoHeight) ? r.videoHeight : undefined,
        validityPercent: typeof r.validityPercent === 'number' && Number.isFinite(r.validityPercent) ? r.validityPercent : undefined,
        samplingRateHz: typeof r.samplingRateHz === 'number' && Number.isFinite(r.samplingRateHz) ? r.samplingRateHz : undefined,
        configuredSamplingRateHz:
          typeof r.configuredSamplingRateHz === 'number' && Number.isFinite(r.configuredSamplingRateHz) ? r.configuredSamplingRateHz : undefined,
        durationSeconds: typeof r.durationSeconds === 'number' && Number.isFinite(r.durationSeconds) ? r.durationSeconds : undefined,
      }));
    const facialTargets = modalityRecords.filter((record) => ids.includes(record.id));
    if (exportModality === 'eye-tracking' && targets.length === 0) {
      setFeedback({ kind: 'error', message: isEn ? 'The selected records have no eye-tracking CSV data.' : '所选记录没有可导出的眼动 CSV 数据。' });
      return;
    }
    if (exportModality === 'facial-expression' && facialTargets.length === 0) {
      setFeedback({ kind: 'error', message: isEn ? 'The selected records have no facial data.' : '所选记录没有可导出的表情模块数据。' });
      return;
    }
    const cols = availableColumns.filter((column) => selectedColumns.has(column));
    if (exportModality === 'eye-tracking' && cols.length === 0) {
      setFeedback({ kind: 'error', message: isEn ? 'Select at least one field in Export settings.' : '请在导出参数中至少选择一个字段。' });
      return;
    }
    if (exportModality === 'facial-expression' && selectedFacialArtifacts.size === 0) {
      setFeedback({ kind: 'error', message: isEn ? 'Select at least one export item in Export settings.' : '请在导出参数中至少选择一个表情模块导出项。' });
      return;
    }
    if (exportModality === 'facial-expression' && !projectDir && (selectedFacialArtifacts.has('analysis-json') || selectedFacialArtifacts.has('emotion-events-csv'))) {
      setFeedback({ kind: 'error', message: isEn ? 'Open the project before exporting analysis data.' : '请先打开工程，再导出表情分析数据。' });
      return;
    }
    exportBusyRef.current = true;
    const operation = ++operationRef.current;
    const isCurrent = () => operationRef.current === operation;
    setExporting(true);
    setFeedback({ kind: 'progress', message: isEn ? 'Exporting… Choose a destination in the save dialog.' : '正在导出，请在保存窗口中选择位置…' });
    try {
      const outcome = exportModality === 'eye-tracking'
        ? await runEyeTrackingExport({ records: targets, columns: cols, headerMap: columnHeaderMap, columnSourceMap, columnJoinSourceMap })
        : await runFacialExport({ records: facialTargets, artifacts: new Set(selectedFacialArtifacts), projectDir, resolveName: resolveRecordExportName, isCurrent });
      if (!isCurrent()) return;
      if (exportModality === 'eye-tracking') {
        const missingCount = facialTargets.length - targets.length;
        outcome.total += missingCount;
        if (!outcome.canceled) outcome.failed += missingCount;
      }
      setFeedback(describeExportOutcome(outcome, isEn));
    } catch (error) {
      if (isCurrent()) setFeedback({ kind: 'error', message: error instanceof Error ? error.message : (isEn ? 'Export failed. Try again.' : '导出失败，请重试。') });
    } finally {
      if (isCurrent()) {
        exportBusyRef.current = false;
        setExporting(false);
      }
    }
  };

  const closePreview = () => {
    previewOperationRef.current += 1;
    setPreviewRecord(null);
    setPreviewLoading(false);
    setPreviewError(null);
  };

  const previewRecordData = async (record: RecordingRecord) => {
    if (!ipcClient.isAvailable()) {
      setFeedback({ kind: 'error', message: isEn ? 'Data preview is only available in the desktop app.' : '请在桌面应用中预览数据。' });
      return;
    }
    const operation = ++previewOperationRef.current;
    const isCurrent = () => previewOperationRef.current === operation;
    setPreviewError(null);
    if (exportModality === 'facial-expression') {
      if (!projectDir) {
        setFeedback({ kind: 'error', message: isEn ? 'Open the project before previewing analysis data.' : '请先打开工程，再预览分析数据。' });
        return;
      }
      setPreviewRecord(record);
      setPreviewLoading(true);
      setPreviewData([]);
      try {
        const loaded = await ipcClient.loadFacialAnalysis({ projectDir, recordId: record.name || record.id });
        if (!isCurrent()) return;
        if (!loaded.ok || !loaded.result) {
          setPreviewError(isEn ? 'Could not load facial analysis. Generate the analysis and try again.' : '无法读取表情分析，请生成分析结果后重试。');
          return;
        }
        const headers = ['Time[ms]', 'Basic Emotion', 'Neutral', 'Happy', 'Sad', 'Angry', 'Surprise', 'Fear', 'Disgust', 'Contempt', 'Top Expression', 'Intensity'];
        const rows = loaded.result.samples.slice(0, 100).map((sample) => {
          const scores = sample.basicEmotionScores || sample.emotionScores || {};
          const expressionEntries = Object.entries(sample.expressions || {}).sort((a, b) => b[1] - a[1]);
          const topExpression = expressionEntries[0];
          const score = (keys: string[]) => {
            const matched = keys.map((key) => scores[key]).find((value) => typeof value === 'number');
            return typeof matched === 'number' ? matched.toFixed(4) : '';
          };
          return [
            String(sample.timestampMs), localizeFacialAnalysisLabel(sample.basicEmotionLabel || sample.emotion || '', isEn),
            score(['neutral', '中性']), score(['happy', 'happiness', '高兴']), score(['sad', 'sadness', '悲伤']),
            score(['angry', 'anger', '愤怒']), score(['surprise', '惊讶']), score(['fear', '恐惧']),
            score(['disgust', '厌恶']), score(['contempt', '轻蔑']), localizeFacialExpressionLabel(topExpression?.[0] || '', isEn),
            typeof topExpression?.[1] === 'number' ? topExpression[1].toFixed(4) : '',
          ];
        });
        setPreviewData([headers, ...rows]);
      } catch {
        if (isCurrent()) setPreviewError(isEn ? 'Could not load facial analysis. Try again.' : '读取表情分析失败，请重试。');
      } finally {
        if (isCurrent()) setPreviewLoading(false);
      }
      return;
    }
    if (!record.csvPath) {
      setFeedback({ kind: 'error', message: isEn ? 'This record has no CSV data to preview.' : '该记录没有可供预览的 CSV 数据。' });
      return;
    }
    setPreviewRecord(record);
    setPreviewLoading(true);
    setPreviewData([]);
    try {
      const res = await ipcClient.previewRecordCsv({ csvPath: record.csvPath, maxRows: 100,
        aoiContext: projectDir && availableColumns.some((key) => key.startsWith('aoi_') && selectedColumns.has(key))
          ? { projectDir, recordId: record.id, deviceType: record.deviceType,
            videoWidth: record.videoWidth, videoHeight: record.videoHeight, coordinateSpace: 'original-video' }
          : undefined });
      if (!isCurrent()) return;
      if (res.ok) {
        if (res.headers.length === 0) {
          setPreviewData([]);
          return;
        }

        const selectedKeys = availableColumns.filter((k) => selectedColumns.has(k));
        if (selectedKeys.length === 0) {
          setPreviewData([]);
          return;
        }

        const headers = res.headers || [];
        const headerIndexMap = new Map<string, number>();
        headers.forEach((h, idx) => headerIndexMap.set(h.toLowerCase().trim(), idx));
        const derivedExportRows = buildDerivedExportRows(res.rows || [], headerIndexMap, !res.truncated, record);
        const subjectInfo = buildSubjectInfoForRecord(record);
        const metadataValues = buildRecordMetadataValues(record);

        const pickFromRow = (row: string[], key: string): string => {
          const sources = columnSourceMap[key] || [key];
          for (const src of sources) {
            const idx = headerIndexMap.get(String(src).toLowerCase().trim());
            if (idx !== undefined && idx >= 0 && idx < row.length) {
              if (row[idx]) return row[idx];
            }
          }
          return '';
        };

        const pickJoinedFromRow = (row: string[], key: string): string | null => {
          const sourceGroups = columnJoinSourceMap[key];
          if (!sourceGroups) return null;
          let matchedSource = false;
          const values = sourceGroups.map((sources) => {
            for (const source of sources) {
              const idx = headerIndexMap.get(String(source).toLowerCase().trim());
              if (idx !== undefined && idx >= 0 && idx < row.length) {
                matchedSource = true;
                return row[idx] || '';
              }
            }
            return '';
          });
          return matchedSource ? values.join(',') : '';
        };

        const resolvePreviewValue = (row: string[], key: string, rowIndex: number): string => {
          if (key.startsWith('aoi_') && res.derivedAoiRows) return res.derivedAoiRows[rowIndex]?.[key] ?? '';
          if (key.startsWith('subject_info::')) {
            const encoded = key.slice('subject_info::'.length);
            let label = encoded;
            try {
              label = decodeURIComponent(encoded);
            } catch {}
            return subjectInfo[label] ?? '';
          }
          if (Object.prototype.hasOwnProperty.call(metadataValues, key)) return metadataValues[key];
          if (key === 'time_of_day') {
            return resolveExportTimeOfDay(record.timestamp, row, headerIndexMap);
          }
          if (key === 'recording_timestamp_ms') {
            return pickFromRow(row, key);
          }
          if (key === 'video_time_ms') {
            return formatExportVideoTime(pickFromRow(row, key));
          }
          const joined = pickJoinedFromRow(row, key);
          if (joined !== null) return joined;
          const raw = pickFromRow(row, key);
          return resolveExportMeasurement(key, raw || derivedExportRows[rowIndex]?.[key] || '', row, headerIndexMap,
            { ...record, derivedValues: derivedExportRows[rowIndex] });
        };

        const previewRows: string[][] = [];
        previewRows.push(selectedKeys.map((key) => getColumnHeader(key)));
        for (let i = 0; i < res.rows.length && i < 100; i += 1) {
          const row = res.rows[i] || [];
          previewRows.push(selectedKeys.map((key) => resolvePreviewValue(row, key, i)));
        }
        setPreviewData(previewRows);
      } else {
        setPreviewError(('message' in res && res.message) || (isEn ? 'Could not read the CSV file. Check that the source file is available.' : '读取 CSV 失败，请检查源文件是否可用。'));
      }
    } catch {
      if (isCurrent()) setPreviewError(isEn ? 'Could not load the preview. Try again.' : '加载预览失败，请重试。');
    } finally {
      if (isCurrent()) setPreviewLoading(false);
    }
  };

  const allSelected = modalityRecords.length > 0 && selectedIds.size === modalityRecords.length;
  const exportSettingsReason = exportModality === 'eye-tracking'
    ? selectedColumns.size === 0 ? (isEn ? 'Select export fields in Export settings.' : '请在导出参数中选择字段。') : ''
    : selectedFacialArtifacts.size === 0
      ? (isEn ? 'Select content in Export settings.' : '请在导出参数中选择内容。')
      : !projectDir && (selectedFacialArtifacts.has('analysis-json') || selectedFacialArtifacts.has('emotion-events-csv'))
        ? (isEn ? 'Open a project to export analysis data.' : '请先打开工程，再导出分析数据。') : '';
  const recordExportReason = (record: RecordingRecord): string => {
    if (exporting) return isEn ? 'Wait for the current export to finish.' : '请等待当前导出完成。';
    if (!ipcClient.isAvailable()) return isEn ? 'Export is only available in the desktop app.' : '请在桌面应用中导出数据。';
    if (exportSettingsReason) return exportSettingsReason;
    if (exportModality === 'eye-tracking' && !record.csvPath) return isEn ? 'No eye-tracking CSV file.' : '该记录缺少眼动 CSV 文件。';
    if (exportModality === 'facial-expression' && !record.modalities?.['facial-expression']) return isEn ? 'No facial data.' : '该记录没有表情模块数据。';
    return '';
  };
  const batchExportReason = exporting ? (isEn ? 'Wait for the current export to finish.' : '请等待当前导出完成。')
    : selectedIds.size === 0 ? (isEn ? 'Select records to export.' : '请先勾选需要导出的记录。')
      : exportSettingsReason || (!ipcClient.isAvailable() ? (isEn ? 'Export is only available in the desktop app.' : '请在桌面应用中导出数据。') : '');
  const previewReason = (record: RecordingRecord): string => exportModality === 'eye-tracking'
    ? !record.csvPath ? (isEn ? 'No CSV data to preview.' : '该记录没有可预览的 CSV 数据。') : ''
    : !record.modalities?.['facial-expression']?.analysisPath ? (isEn ? 'Generate facial analysis before previewing.' : '请先生成表情分析结果，再预览数据。') : '';

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden flex flex-col h-full">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50/60 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-bold text-slate-800">数据导出中心</h2>
          <div
            className="flex items-center gap-2 border-l border-slate-200 pl-4"
            title={exporting ? (isEn ? 'Wait for the current export to finish before switching modality.' : '请等待当前导出完成后再切换数据模态。') : undefined}
          >
            <span className="text-xs font-medium text-slate-600">数据模态</span>
            <CustomSelect
              value={exportModality}
              disabled={exporting}
              onChange={(event) => {
                if (!exportBusyRef.current) setExportModality(event.target.value as ModalityId);
              }}
              className="min-w-36 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 outline-none"
            >
              {(availableModalities.length > 0 ? availableModalities : (Object.keys(EXPORT_MODALITY_REGISTRY) as ModalityId[])).map((id) => (
                <option key={id} value={id}>{EXPORT_MODALITY_REGISTRY[id].recordLabel}</option>
              ))}
            </CustomSelect>
          </div>
          <span className="text-xs tabular-nums text-slate-600" data-i18n-skip="true">
            {isEn ? `${selectedIds.size} / ${modalityRecords.length} selected` : `已选 ${selectedIds.size} / ${modalityRecords.length} 条`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            className={btnSecondary}
            onClick={openSettings}
          >
            <SlidersHorizontal size={16} /> 导出参数
          </button>
          <span title={batchExportReason || undefined}>
            <button
              className={btnPrimary}
              disabled={!!batchExportReason}
              aria-busy={exporting}
              onClick={() => exportRecords(Array.from(selectedIds))}
            >
              {exporting ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
              {exporting ? (isEn ? 'Exporting…' : '导出中…') : (isEn ? 'Export' : '导出')}
            </button>
          </span>
        </div>
      </div>
      {feedback && (
        <div
          role={feedback.kind === 'error' || feedback.kind === 'partial' ? 'alert' : 'status'}
          className={`flex items-start gap-2 border-b px-4 py-2 text-xs leading-5 ${feedback.kind === 'error' || feedback.kind === 'partial' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-slate-200 bg-slate-50/60 text-slate-700'}`}
          data-i18n-skip="true"
        >
          {feedback.kind === 'progress' && <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin" />}
          <span>{feedback.message}</span>
        </div>
      )}
      {!feedback && (selectedIds.size === 0 || exportSettingsReason) && (
        <p className="border-b border-slate-100 px-4 py-1.5 text-xs text-slate-500" data-i18n-skip="true">
          {exportSettingsReason || (isEn ? 'Select records, then choose Export. Click a record name to preview data.' : '勾选记录后点击导出；点击记录名可预览数据。')}
        </p>
      )}
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr>
              <th className={`${tableHeadClass} w-10`}>
                <input
                  type="checkbox"
                  className="accent-sky-500 rounded"
                  aria-label={isEn ? 'Select all records' : '选择全部记录'}
                  checked={allSelected}
                  onChange={(e) => toggleAll(e.target.checked)}
                />
              </th>
              <th className={tableHeadClass}>
                记录名
              </th>
              <th className={tableHeadClass}>
                受试者
              </th>
              <th className={tableHeadClass}>
                录制时间
              </th>
              <th className={`${tableHeadClass} ${exportModality === 'eye-tracking' ? 'text-right' : ''}`}>
                {exportModality === 'eye-tracking' ? '校准得分(左:右)' : '表情视频'}
              </th>
              <th className={`${tableHeadClass} ${exportModality === 'eye-tracking' ? 'text-right' : ''}`}>
                {exportModality === 'eye-tracking' ? '实际采样率(Hz)' : '分析结果'}
              </th>
              <th className={`${tableHeadClass} ${exportModality === 'eye-tracking' ? 'text-right' : ''}`}>
                {exportModality === 'eye-tracking' ? '数据采样率(Hz)' : '数据格式'}
              </th>
              <th className={`${tableHeadClass} ${exportModality === 'eye-tracking' ? 'text-right' : ''}`}>
                {exportModality === 'eye-tracking' ? '有效率(%)' : '记录状态'}
              </th>
              <th className={`${tableHeadClass} text-right`}>
                时长(s)
              </th>
              <th className={`${tableHeadClass} text-right`}>
                操作
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {modalityRecords.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-6 py-10 text-center text-sm text-slate-400">
                  {EXPORT_MODALITY_REGISTRY[exportModality].emptyLabel}
                </td>
              </tr>
            ) : (
              modalityRecords.map((r) => (
                <tr key={r.id} className={selectedIds.has(r.id) ? tableSelectedRowClass : tableRowClass}>
                  <td className={tableCellClass}>
                    <input
                      type="checkbox"
                      className="accent-sky-500 rounded"
                      aria-label={isEn ? `Select ${resolveRecordDisplayName(r)}` : `选择 ${resolveRecordDisplayName(r)}`}
                      checked={selectedIds.has(r.id)}
                      onChange={(e) => toggleOne(r.id, e.target.checked)}
                    />
                  </td>
                  <td className={`${tableCellClass} max-w-56`}>
                    <button
                      data-i18n-skip="true"
                      className="mrt-button-text block max-w-56 truncate text-left text-sky-600 hover:text-sky-700 hover:underline disabled:cursor-not-allowed disabled:text-slate-500"
                      title={previewReason(r) ? `${resolveRecordDisplayName(r)} · ${previewReason(r)}` : resolveRecordDisplayName(r)}
                      onClick={() => previewRecordData(r)}
                      disabled={!!previewReason(r)}
                    >
                      {resolveRecordDisplayName(r)}
                    </button>
                  </td>
                  <td data-i18n-skip="true" className={`${tableCellClass} max-w-32 truncate`} title={r.subjectName}>{r.subjectName}</td>
                  <td className={`${tableCellClass} whitespace-nowrap text-xs tabular-nums`} title={r.timestamp}>{r.timestamp}</td>
                  {exportModality === 'eye-tracking' ? (
                    <>
                      <td className={tableNumericCellClass}>{fmtScore(r.calibrationLeftScore, r.calibrationRightScore)}</td>
                      <td className={tableNumericCellClass}>{fmtInt(r.samplingRateHz)}</td>
                      <td className={tableNumericCellClass}>{fmtInt(r.configuredSamplingRateHz)}</td>
                      <td className={tableNumericCellClass}>{fmt(r.validityPercent, 1)}</td>
                    </>
                  ) : (
                    <>
                      <td className={`${tableCellClass} text-xs whitespace-nowrap`}>{r.modalities?.['facial-expression']?.sourcePath ? '可导出' : '—'}</td>
                      <td className={`${tableCellClass} text-xs whitespace-nowrap`}>{r.modalities?.['facial-expression']?.analysisPath ? '已生成' : '未生成'}</td>
                      <td className={`${tableCellClass} text-xs whitespace-nowrap`}>视频 / JSON / CSV</td>
                      <td className={`${tableCellClass} text-xs whitespace-nowrap`}>{r.modalities?.['facial-expression']?.status === 'complete' ? '完整' : '部分数据'}</td>
                    </>
                  )}
                  <td className={tableNumericCellClass}>{fmt(r.durationSeconds, 1)}</td>
                  <td className={`${tableCellClass} text-right`}>
                    <span title={recordExportReason(r) || (isEn ? `Export ${resolveRecordDisplayName(r)}` : `导出 ${resolveRecordDisplayName(r)}`)}>
                      <button
                        className={btnSecondary}
                        onClick={() => exportRecords([r.id])}
                        disabled={!!recordExportReason(r)}
                      >
                        {isEn ? 'Export' : '导出'}
                      </button>
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {isSettingsOpen && exportModality === 'facial-expression' && (
        <Modal
          isOpen
          onClose={() => setIsSettingsOpen(false)}
          onBackdropClick={() => setIsSettingsOpen(false)}
          title="导出参数 · 表情模块"
          description="选择与当前模态关联的导出内容"
          maxWidthClassName="max-w-[640px]"
        >
          <div className="mb-4 text-[11px] text-slate-500">已选 <span className="mrt-number">{selectedFacialArtifacts.size} / {FACIAL_EXPORT_ARTIFACTS.length}</span></div>
          <div className="space-y-3">
            {FACIAL_EXPORT_ARTIFACTS.map((artifact) => (
              <label key={artifact.id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 hover:bg-slate-50">
                <input
                  type="checkbox"
                  className="mt-0.5 rounded accent-sky-500"
                  checked={selectedFacialArtifacts.has(artifact.id)}
                  onChange={(event) => setSelectedFacialArtifacts((previous) => {
                    const next = new Set(previous);
                    if (event.target.checked) next.add(artifact.id); else next.delete(artifact.id);
                    return next;
                  })}
                />
                <span>
                  <span className="block text-xs font-bold text-slate-700">{artifact.label}</span>
                  <span className="mt-1 block text-[11px] text-slate-500">{artifact.description}</span>
                </span>
              </label>
            ))}
          </div>
        </Modal>
      )}

      {isSettingsOpen && exportModality === 'eye-tracking' && (
        <Modal
          isOpen
          onClose={() => setIsSettingsOpen(false)}
          onBackdropClick={() => setIsSettingsOpen(false)}
          title="导出参数"
          description={isEn ? 'Select CSV Fields' : '选择导出 CSV 字段'}
          maxWidthClassName="max-w-[720px]"
        >
          <p className="mb-2 text-[11px] leading-relaxed text-slate-500">{isEn
            ? 'Export uses the original 133 standard fields and their defined units. Missing or unsupported measurements stay blank.'
            : '按原有 133 个标准字段及其定义的单位导出。缺失或不支持的数据保持空白。'}</p>
          {availableColumns.length === 0 ? (
            <div className="text-sm text-slate-500">未读取到 CSV 字段，请确保存在记录 CSV。</div>
          ) : (
            <div className="mb-2 flex items-center justify-between gap-3 px-3 py-1">
              <div className="text-[11px] text-slate-500">
                {isEn ? 'Selected' : '已选'} <span className="mrt-number inline-block min-w-[9ch] text-right">{selectedColumns.size} / {availableColumns.length}</span>
              </div>
              <div className="grid shrink-0 grid-cols-[auto_auto] items-center gap-2">
                <button
                  className={btnGhost}
                  onClick={() => {
                    setSelectedColumns(new Set(availableColumns));
                    setIncludeSubjectAttributes(subjectAttributeFieldKeys.length > 0);
                  }}
                >
                  全选
                </button>
                <button
                  className={btnGhost}
                  onClick={() => {
                    setSelectedColumns(new Set());
                    setIncludeSubjectAttributes(false);
                  }}
                >
                  全不选
                </button>
              </div>
            </div>
          )}

          {availableColumns.length > 0 && (
            <div className="space-y-2">
              {groupedColumns.map((group) => {
                const groupKeys = group.fields.map((f) => f.key);
                const isAttributesGroup = group.key === 'attributes';
                const selectedCount = isAttributesGroup
                  ? includeSubjectAttributes
                    ? groupKeys.length
                    : 0
                  : groupKeys.filter((key) => selectedColumns.has(key)).length;
                const allChecked = isAttributesGroup ? includeSubjectAttributes : groupKeys.length > 0 && selectedCount === groupKeys.length;
                const groupDisabled = groupKeys.length === 0;
                const collapsed = collapsedGroups.has(group.key);
                return (
                  <div key={group.key} className="rounded-xl bg-slate-50/30 px-3 py-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <button
                          className="mrt-button-text inline-flex shrink-0 min-h-7 min-w-7 items-center justify-center rounded-md text-slate-600"
                          title={collapsed ? (isEn ? 'Expand group' : '展开分组') : (isEn ? 'Collapse group' : '收起分组')}
                          aria-label={`${collapsed ? (isEn ? 'Expand group' : '展开分组') : (isEn ? 'Collapse group' : '收起分组')}: ${isEn ? (group.labelEn || group.label) : group.label}`}
                          aria-expanded={!collapsed}
                          onClick={() =>
                            setCollapsedGroups((prev) => {
                              const next = new Set(prev);
                              if (next.has(group.key)) next.delete(group.key);
                              else next.add(group.key);
                              return next;
                            })
                          }
                        >
                          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                        </button>
                        <label className="inline-flex min-w-0 items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            className="accent-sky-500 rounded"
                            checked={allChecked}
                            disabled={groupDisabled}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              if (isAttributesGroup) {
                                setIncludeSubjectAttributes(checked);
                                return;
                              }
                              setSelectedColumns((prev) => {
                                const next = new Set(prev);
                                for (const key of groupKeys) {
                                  if (checked) next.add(key);
                                  else next.delete(key);
                                }
                                return next;
                              });
                            }}
                          />
                          <span className="mrt-title min-w-0 text-[12px] font-bold text-slate-700">{isEn ? (group.labelEn || group.label) : group.label}</span>
                          <span className="mrt-number min-w-[5ch] shrink-0 text-right text-[11px] text-slate-500">
                            {selectedCount}/{groupKeys.length}
                          </span>
                        </label>
                      </div>
                      <div className="grid shrink-0 grid-cols-[auto_auto] items-center gap-2">
                        <button
                          className={btnGhost}
                          disabled={groupDisabled}
                          onClick={() => {
                            if (isAttributesGroup) {
                              setIncludeSubjectAttributes(true);
                              return;
                            }
                            setSelectedColumns((prev) => {
                              const next = new Set(prev);
                              for (const key of groupKeys) next.add(key);
                              return next;
                            });
                          }}
                        >
                          全选
                        </button>
                        <button
                          className={btnGhost}
                          disabled={groupDisabled}
                          onClick={() => {
                            if (isAttributesGroup) {
                              setIncludeSubjectAttributes(false);
                              return;
                            }
                            setSelectedColumns((prev) => {
                              const next = new Set(prev);
                              for (const key of groupKeys) next.delete(key);
                              return next;
                            });
                          }}
                        >
                          全不选
                        </button>
                      </div>
                    </div>
                    {collapsed ? null : group.fields.length === 0 ? (
                      <div className="mt-1 px-2 py-1.5 text-[11px] text-slate-400">
                        {isAttributesGroup ? '暂无受试者字段，请先在受试管理中配置字段' : '当前记录中暂无该分类字段'}
                      </div>
                    ) : isAttributesGroup ? (
                      <div className="mt-1 space-y-1 pb-1">
                        <label className="flex min-h-8 items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5">
                          <input
                            type="checkbox"
                            className="accent-sky-500 rounded"
                            checked={includeSubjectAttributes}
                            onChange={(e) => setIncludeSubjectAttributes(e.target.checked)}
                          />
                          <span className="text-[12px] font-semibold text-slate-700">自动写入受试者全部信息</span>
                        </label>
                        <div className="rounded-lg border border-slate-200 bg-white px-2 py-1.5">
                          <div className="text-[11px] text-slate-500">当前将按受试者字段动态写入：</div>
                          <div className="mt-1 flex flex-wrap gap-2">
                            {group.fields.map((field) => (
                              <span
                                key={field.key}
                                className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600"
                                data-i18n-skip={builtinSubjectFieldLabels.has(field.label) ? undefined : 'true'}
                              >
                                {field.label}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-1 space-y-1 pb-1">
                        {group.fields.map((field) => (
                          <label
                            key={field.key}
                            className="flex min-h-8 items-start gap-2 px-2 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              className="accent-sky-500 rounded mt-0.5"
                              checked={selectedColumns.has(field.key)}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setSelectedColumns((prev) => {
                                  const next = new Set(prev);
                                  if (checked) next.add(field.key);
                                  else next.delete(field.key);
                                  return next;
                                });
                              }}
                            />
                            <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] items-baseline gap-x-3 text-[12px]">
                              <span className="min-w-0 break-words font-semibold text-slate-700">{getColumnLabel(field.key)}</span>
                              <span className="min-w-0 break-words font-normal text-slate-500">{getColumnHeader(field.key)}</span>
                            </div>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Modal>
      )}

      {previewRecord && (
        <Modal
          isOpen
          onClose={closePreview}
          onBackdropClick={closePreview}
          title={`${isEn ? 'Data preview: ' : '数据预览：'}${resolveRecordDisplayName(previewRecord)}`}
          maxWidthClassName="max-w-[1200px] h-[85vh]"
          contentClassName="!p-0 flex flex-col overflow-hidden"
          description={
            <>
              {previewData.length > 0
                ? isEn
                  ? `Show first ${Math.min(100, previewData.length - 1)} rows`
                  : `显示前 ${Math.min(100, previewData.length - 1)} 行数据`
                : previewLoading
                  ? (isEn ? 'Loading…' : '加载中…')
                  : (isEn ? 'No preview data' : '无预览数据')}
              {exportModality === 'eye-tracking' && <span className="block">{isEn ? 'An unfinished derived segment at the preview boundary stays blank; export the full record for its duration.' : '预览边界处尚未结束的派生片段保持空白，完整时长以整份记录导出为准。'}</span>}
              {exportModality === 'eye-tracking' && selectedColumns.size > 0 &&
                availableColumns.length > 0 &&
                (isEn ? ` · Selected ${selectedColumns.size} columns` : ` · 已选 ${selectedColumns.size} 列`)}
            </>
          }
        >
          <div className="min-h-0 flex-1 overflow-hidden flex flex-col">
            {previewLoading ? (
              <div role="status" className="flex items-center justify-center gap-2 text-sm text-slate-600 py-10"><Loader2 size={16} className="animate-spin" />{isEn ? 'Loading data…' : '正在加载数据…'}</div>
            ) : previewError ? (
              <div role="alert" className="m-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{previewError}</div>
            ) : previewData.length === 0 ? (
              <div className="text-sm text-slate-600 text-center px-4 py-10">{isEn ? 'No rows to preview. Check the source data and selected export fields.' : '暂无可预览的数据，请检查源数据和已选导出字段。'}</div>
            ) : (
              <div className="flex-1 min-h-0 p-[var(--app-dialog-padding)]">
                <div className="h-full overflow-auto [&::-webkit-scrollbar]:w-[5px] [&::-webkit-scrollbar]:h-[5px] [&::-webkit-scrollbar-corner]:bg-transparent [&::-webkit-scrollbar-track]:bg-[var(--app-scrollbar-track)] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[var(--app-scrollbar-thumb)] hover:[&::-webkit-scrollbar-thumb]:bg-[var(--app-scrollbar-thumb-hover)]">
                  <table className="w-full text-left border-collapse border border-slate-200">
                  <thead>
                    <tr className="bg-slate-100">
                      {previewData[0].map((header, i) => (
                        <th
                          key={i}
                          className="sticky top-0 z-20 bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700 border border-slate-200 whitespace-nowrap"
                        >
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewData.slice(1).map((row, rowIdx) => (
                      <tr key={rowIdx} className="hover:bg-slate-50">
                        {row.map((cell, cellIdx) => (
                          <td key={cellIdx} className="px-3 py-1.5 text-xs tabular-nums text-slate-600 border border-slate-200 whitespace-nowrap">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
};

export default ExportPage;
