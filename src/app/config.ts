import type { TabType } from '@shared/contracts/domain/models';
export { ENABLE_DEBUG_TESTING } from '../../shared/constants/debug';

/**
 * License 授权总开关。
 * true：显示激活页面并校验产品模块；false：隐藏授权内容并开放全部模块。
 * 修改后需要重新启动开发环境或重新构建安装包。
 */
export const ENABLE_LICENSE_AUTHORIZATION = false;

/**
 * 生产后台服务地址。打包时若 .env 未配置 UST_API_ORIGIN，则回退使用这里的默认值，
 * 避免打包机器缺 .env 时软件报「尚未配置后台服务地址」。
 * 开发环境可在 .env 里用 UST_API_ORIGIN=http://127.0.0.1:8000 覆盖以连本地后台。
 */
export const DEFAULT_API_ORIGIN = 'http://39.105.174.254/';

/**
 * 生产 License 验签公钥（key_id → Ed25519 公钥 base64url）。
 * 公钥是公开的（仅用于验签、不能签发 License），可以进版本库。
 * 打包时若 .env 未配置 UST_TRUSTED_SIGNING_KEYS，则回退使用这里的默认值，
 * 避免打包机器缺 .env 时软件报「尚未配置公钥」。
 */
export const DEFAULT_TRUSTED_SIGNING_KEYS: Record<string, string> = {
  'ust-prod-01': 'rXCduYen_ODzkB2k8t89O-koUsPf7muEJaaubPlos5c',
};

/**
 * Enables verbose diagnostics across the renderer, Electron main process,
 * debug log files, and the Python eye-tracking service.
 * Keep disabled for normal use; warnings and errors are not suppressed.
 */
/** Sidebar module visibility switches. */
export const SHOW_PROJECT_SETTINGS_PAGE = true;
export const SHOW_SUBJECT_PAGE = true;
export const SHOW_IMAGES_PAGE = true;
export const SHOW_VIDEO_PAGE = true;
export const SHOW_MONITOR_PAGE = true;
export const SHOW_VISUAL_PAGE = true;
export const SHOW_MAPPING_PAGE = true;
export const SHOW_AOI_PAGE = true;
export const SHOW_CHART_PAGE = true;
export const SHOW_INSIGHT_PAGE = true;
export const SHOW_EXPORT_PAGE = true;
export const SHOW_FACIAL_PAGE = true;

export const MODULE_TAB_ORDER: TabType[] = [
  'project-settings',
  'subject',
  'images',
  'video',
  'monitor',
  'visual',
  'mapping',
  'aoi',
  'chart',
  'insight',
  'facial',
  'export',
];

export const MODULE_PAGE_VISIBILITY: Record<TabType, boolean> = {
  'project-settings': SHOW_PROJECT_SETTINGS_PAGE,
  subject: SHOW_SUBJECT_PAGE,
  images: SHOW_IMAGES_PAGE,
  video: SHOW_VIDEO_PAGE,
  monitor: SHOW_MONITOR_PAGE,
  visual: SHOW_VISUAL_PAGE,
  mapping: SHOW_MAPPING_PAGE,
  aoi: SHOW_AOI_PAGE,
  chart: SHOW_CHART_PAGE,
  insight: SHOW_INSIGHT_PAGE,
  facial: SHOW_FACIAL_PAGE,
  export: SHOW_EXPORT_PAGE,
};
