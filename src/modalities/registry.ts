import type { LucideIcon } from 'lucide-react';
import {
  Aperture, BarChart2, ClipboardList, Download, Eye, FileText, Folder,
  Image as ImageIcon, MapPinned, ScanFace, Target, User, Video,
} from 'lucide-react';
import type { ModalityId, Project, TabType } from '@shared/contracts/domain/models';
import { normalizeProjectModalities } from '@shared/domain/projectModalities';
import type { LanguageCode } from '@/app/i18n/i18nConfig';

export type ModulePageDefinition = {
  id: TabType;
  label: string;
  icon: LucideIcon;
  scope: 'common' | ModalityId;
};

export type ModalityPageGroup = {
  id: ModalityId;
  label: string;
  icon: LucideIcon;
  pages: ModulePageDefinition[];
};

export const COMMON_MODULE_PAGES: ModulePageDefinition[] = [
  { id: 'project-settings', icon: Folder, label: '工程管理', scope: 'common' },
  { id: 'subject', icon: User, label: '受试管理', scope: 'common' },
  { id: 'images', icon: ImageIcon, label: '实验设计', scope: 'common' },
  { id: 'video', icon: Video, label: '实验录制', scope: 'common' },
  { id: 'monitor', icon: ClipboardList, label: '实验记录', scope: 'common' },
  { id: 'export', icon: Download, label: '数据导出', scope: 'common' },
];

export const MODALITY_REGISTRY: Record<ModalityId, {
  id: ModalityId;
  label: string;
  labelEn: string;
  shortLabel: string;
  shortLabelEn: string;
  analysisLabel: string;
  icon: LucideIcon;
  description: string;
  pages: ModulePageDefinition[];
}> = {
  'eye-tracking': {
    id: 'eye-tracking',
    label: '眼动模块',
    labelEn: 'Eye Tracking Module',
    shortLabel: '眼动',
    shortLabelEn: 'Eye Tracking',
    analysisLabel: '眼动分析',
    icon: Eye,
    description: '注视采集、数据可视、映射、AOI 与洞察分析',
    pages: [
      { id: 'visual', icon: Aperture, label: '数据可视', scope: 'eye-tracking' },
      { id: 'mapping', icon: MapPinned, label: '映射描点', scope: 'eye-tracking' },
      { id: 'aoi', icon: Target, label: 'AOI分析', scope: 'eye-tracking' },
      { id: 'chart', icon: BarChart2, label: '统计报表', scope: 'eye-tracking' },
      { id: 'insight', icon: FileText, label: '洞察报告', scope: 'eye-tracking' },
    ],
  },
  'facial-expression': {
    id: 'facial-expression',
    label: '表情模块',
    labelEn: 'Facial Module',
    shortLabel: '表情',
    shortLabelEn: 'Facial',
    analysisLabel: '表情分析',
    icon: ScanFace,
    description: '摄像头采集与表情分析',
    pages: [
      { id: 'facial', icon: ScanFace, label: '面部分析', scope: 'facial-expression' },
    ],
  },
};

export const MODALITY_NAV_ORDER: ModalityId[] = ['eye-tracking', 'facial-expression'];

/**
 * 把选中的模态列表格式化为「X/Y模块」的共享后缀形式，并按语言返回中/英文。
 * 单个模态直接返回完整 label（如「眼动模块」/「Eye Tracking Module」），
 * 多个模态用 `/` 连接短名并共享后缀（如「眼动/表情模块」/「Eye Tracking/Facial Module」）。
 */
export function formatModalitySummary(ids: ModalityId[], language: LanguageCode): string {
  const isEn = language === 'en-US';
  if (ids.length === 0) return '';
  if (ids.length === 1) {
    const definition = MODALITY_REGISTRY[ids[0]];
    return definition ? (isEn ? definition.labelEn : definition.label) : '';
  }
  const shorts = ids
    .map((id) => {
      const definition = MODALITY_REGISTRY[id];
      return definition ? (isEn ? definition.shortLabelEn : definition.shortLabel) : '';
    })
    .filter((label) => Boolean(label));
  if (shorts.length === 0) return '';
  return isEn ? `${shorts.join('/')} Module` : `${shorts.join('/')}模块`;
}

function getOrderedProjectModalityIds(project?: Project | null): ModalityId[] {
  if (!project) return [];
  const enabled = new Set(normalizeProjectModalities(project).map((modality) => modality.id));
  return MODALITY_NAV_ORDER.filter((id) => enabled.has(id));
}

export function getProjectModalityPageGroups(project?: Project | null): ModalityPageGroup[] {
  if (!project) return [];
  return getOrderedProjectModalityIds(project).flatMap((id) => {
    const definition = MODALITY_REGISTRY[id];
    return definition ? [{
      id: definition.id,
      label: definition.analysisLabel,
      icon: definition.icon,
      pages: definition.pages,
    }] : [];
  });
}

export function getProjectModulePages(project?: Project | null): ModulePageDefinition[] {
  if (!project) return COMMON_MODULE_PAGES;
  const modalityPages = getOrderedProjectModalityIds(project)
    .flatMap((id) => MODALITY_REGISTRY[id]?.pages || []);
  return [...COMMON_MODULE_PAGES, ...modalityPages];
}

export function getProjectHiddenTabs(project?: Project | null): TabType[] {
  const visible = new Set(getProjectModulePages(project).map((page) => page.id));
  const all = [...COMMON_MODULE_PAGES, ...Object.values(MODALITY_REGISTRY).flatMap((item) => item.pages)];
  return all.map((item) => item.id).filter((id) => !visible.has(id));
}
