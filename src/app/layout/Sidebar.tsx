import React from 'react';
import { ChevronDown, Home, PanelLeftClose, Settings } from 'lucide-react';
import ThemeSettingsModal from '@/app/settings/ThemeSettingsModal';
import type { MultiplayerPageProps } from '@/features/multiplayer/MultiplayerPage';
import { useTheme } from '@/app/theme/useTheme';
import { useLanguage } from '@/app/i18n/useLanguage';
import { localizeText, translateTextForLanguage } from '@/app/i18n/useDomTranslation';
import type { ModalityId, Project } from '@shared/contracts/domain/models';
import { COMMON_MODULE_PAGES, getProjectModalityPageGroups } from '@/modalities/registry';
import { isLicenseModuleAuthorized, moduleForModality, useLicenseState } from '@/features/licensing/licenseContext';
import { LiquidGlassLens } from '@/app/layout/LiquidGlassLens';

interface SidebarProps {
  onBack: () => void;
  activeTab: string;
  onTabChange: (tab: string) => void;
  projectDir?: string;  // 新增：用于Trigger配置
  hiddenTabs?: string[];
  multiplayerProps?: Omit<MultiplayerPageProps, 'embedded'>;
  project?: Project | null;
}

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'mrt-sidebar-collapsed';

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export const Sidebar: React.FC<SidebarProps> = ({
  onBack,
  activeTab,
  onTabChange,
  projectDir,
  hiddenTabs = [],
  multiplayerProps,
  project,
}) => {
  const [isSettingsOpen, setIsSettingsOpen] = React.useState(false);
  const [isCollapsed, setIsCollapsed] = React.useState(readSidebarCollapsed);
  const toggleCollapsed = () => {
    const next = !isCollapsed;
    setIsCollapsed(next);
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, next ? '1' : '0');
    } catch {
    }
  };
  const navigationId = React.useId();
  const licenseState = useLicenseState();
  const modalityGroups = React.useMemo(
    () => getProjectModalityPageGroups(project).filter((group) => {
      const required = moduleForModality(group.id);
      return !required || isLicenseModuleAuthorized(licenseState, required);
    }),
    [project, licenseState],
  );
  const [expandedGroups, setExpandedGroups] = React.useState<Set<ModalityId>>(
    () => new Set(getProjectModalityPageGroups(project).map((group) => group.id)),
  );
  const { theme, setTheme } = useTheme();
  const { language } = useLanguage();
  const tr = (label: string) => translateTextForLanguage(label, language);
  const collapseLabel = isCollapsed
    ? localizeText(language, '展开导航', 'Expand navigation')
    : localizeText(language, '收起导航', 'Collapse navigation');
  const sidebarStyle = { '--mrt-sidebar-expanded-width': language === 'zh-CN' ? '144px' : '176px' } as React.CSSProperties;
  const navListRef = React.useRef<HTMLDivElement>(null);

  const visibleCommonItems = COMMON_MODULE_PAGES.filter((item) => !hiddenTabs.includes(item.id));
  const visibleModalityGroups = modalityGroups
    .map((group) => ({ ...group, pages: group.pages.filter((page) => !hiddenTabs.includes(page.id)) }))
    .filter((group) => group.pages.length > 0);

  React.useEffect(() => {
    setExpandedGroups(new Set(modalityGroups.map((group) => group.id)));
  }, [project]);

  React.useEffect(() => {
    setExpandedGroups((previous) => {
      const next = new Set(previous);
      visibleModalityGroups.forEach((group) => {
        if (group.pages.some((page) => page.id === activeTab)) next.add(group.id);
      });
      return next;
    });
  }, [activeTab, project]);

  React.useEffect(() => {
    if (!multiplayerProps?.localStatus.recording && !multiplayerProps?.localStatus.finalizing) return;
    setIsSettingsOpen(false);
  }, [multiplayerProps?.localStatus.finalizing, multiplayerProps?.localStatus.recording]);

  return (
    <>
      <aside
        id={navigationId}
        className="mrt-navigation mrt-sidebar relative z-50 h-full shrink-0 flex flex-col py-4 px-2 bg-[var(--app-surface)]"
        style={sidebarStyle}
        data-collapsed={isCollapsed}
        data-i18n-skip="true"
        aria-label={localizeText(language, '主导航', 'Main navigation')}
      >
        <button
          type="button"
          onClick={onBack}
          className="mrt-sidebar-item mb-8 w-full flex items-center gap-2.5 px-2 py-2 text-sky-700 hover:bg-sky-50 rounded-lg transition-colors min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/30"
          aria-label={tr('主页')}
          title={tr('主页')}
        >
          <Home size={18} className="shrink-0" />
          <span className="mrt-sidebar-label truncate text-sm font-semibold flex-1 text-left">{tr('主页')}</span>
        </button>

        <div ref={navListRef} className="relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {theme === 'glass' && <LiquidGlassLens containerRef={navListRef} activeKey={activeTab} onSelect={onTabChange} />}
          {visibleCommonItems.map((item) => (
            <button
              key={item.id}
              type="button"
              data-nav-id={item.id}
              onClick={() => onTabChange(item.id)}
              className={`mrt-sidebar-item w-full flex items-center justify-start gap-2.5 px-2 py-2 rounded-lg transition-colors min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/30 ${
                activeTab === item.id
                  ? 'bg-sky-100 text-sky-700'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              }`}
              aria-label={tr(item.label)}
              title={tr(item.label)}
              aria-current={activeTab === item.id ? 'page' : undefined}
            >
              <item.icon size={18} className="shrink-0" />
              <span className={`mrt-sidebar-label truncate text-sm flex-1 text-left ${activeTab === item.id ? 'font-semibold' : 'font-medium'}`}>{tr(item.label)}</span>
            </button>
          ))}
          {visibleModalityGroups.map((group) => {
            const expanded = expandedGroups.has(group.id);
            const groupActive = group.pages.some((page) => page.id === activeTab);
            return (
              <div key={group.id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => setExpandedGroups((previous) => {
                    const next = new Set(previous);
                    if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
                    return next;
                  })}
                  className={`mrt-sidebar-item flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/30 ${groupActive ? 'text-sky-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}
                  aria-expanded={expanded}
                  aria-label={tr(group.label)}
                  title={tr(group.label)}
                >
                  <group.icon size={18} className="shrink-0" />
                  <span className="mrt-sidebar-label flex-1 truncate text-left text-sm font-semibold">{tr(group.label)}</span>
                  <ChevronDown size={14} className={`mrt-sidebar-chevron shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                </button>
                {expanded && (
                  <div className="mrt-sidebar-subnav mt-1 flex flex-col gap-1 pl-2 ml-4">
                    {group.pages.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        data-nav-id={item.id}
                        onClick={() => onTabChange(item.id)}
                        className={`mrt-sidebar-item mrt-sidebar-subitem flex w-full min-w-0 items-center justify-start gap-2 rounded-lg px-2 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/30 ${activeTab === item.id ? 'bg-sky-100 text-sky-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}
                        aria-label={tr(item.label)}
                        title={tr(item.label)}
                        aria-current={activeTab === item.id ? 'page' : undefined}
                      >
                        <item.icon size={15} className="shrink-0" />
                        <span className={`mrt-sidebar-label flex-1 truncate text-left text-xs ${activeTab === item.id ? 'font-semibold' : 'font-medium'}`}>{tr(item.label)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex shrink-0 flex-col gap-1 pt-3">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!isCollapsed}
            aria-controls={navigationId}
            aria-label={collapseLabel}
            title={collapseLabel}
            className="mrt-sidebar-item w-full flex items-center gap-2.5 px-2 py-2 rounded-lg transition-colors text-slate-600 min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/30"
          >
            <span className="mrt-sidebar-collapse-icon inline-flex shrink-0" aria-hidden="true">
              <PanelLeftClose size={18} />
            </span>
            <span className="mrt-sidebar-label truncate text-sm font-medium flex-1 text-left">{collapseLabel}</span>
          </button>
          <button
            type="button"
            onClick={() => setIsSettingsOpen(true)}
            aria-pressed={isSettingsOpen}
            aria-label={tr('设置')}
            title={tr('设置')}
            className="mrt-sidebar-item w-full flex items-center gap-2.5 px-2 py-2 rounded-lg transition-colors text-slate-600 hover:bg-slate-50 hover:text-slate-900 min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/30"
          >
            <Settings size={18} className="shrink-0" />
            <span className="mrt-sidebar-label truncate text-sm font-medium flex-1 text-left">{tr('设置')}</span>
          </button>
        </div>
      </aside>

      <ThemeSettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        theme={theme}
        onChangeTheme={(next) => setTheme(next)}
        projectDir={projectDir}
        multiplayerProps={multiplayerProps}
      />
    </>
  );
};
