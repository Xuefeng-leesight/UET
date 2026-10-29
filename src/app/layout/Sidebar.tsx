import React from 'react';
import { ChevronDown, Home, Settings } from 'lucide-react';
import ThemeSettingsModal from '@/app/settings/ThemeSettingsModal';
import type { MultiplayerPageProps } from '@/features/multiplayer/MultiplayerPage';
import { useTheme } from '@/app/theme/useTheme';
import { useLanguage } from '@/app/i18n/useLanguage';
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
  const sidebarWidthClass = language === 'en-US' ? 'w-44' : 'w-36';
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
      <div className={`mrt-navigation relative z-50 ${sidebarWidthClass} h-full flex flex-col py-4 px-2 bg-[var(--app-surface)]`}>
        <button
          onClick={onBack}
          className="mb-8 w-full flex items-center gap-2.5 px-2 py-2 text-sky-700 hover:bg-sky-50 rounded-lg transition-colors min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/30"
        >
          <Home size={18} className="shrink-0" />
          <span className="truncate text-sm font-semibold flex-1 text-left">主页</span>
        </button>

        <div ref={navListRef} className="relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {theme === 'glass' && <LiquidGlassLens containerRef={navListRef} activeKey={activeTab} onSelect={onTabChange} />}
          {visibleCommonItems.map((item) => (
            <button
              key={item.id}
              data-nav-id={item.id}
              onClick={() => onTabChange(item.id)}
              className={`w-full flex items-center justify-start gap-2.5 px-2 py-2 rounded-lg transition-colors min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/30 ${
                activeTab === item.id
                  ? 'bg-sky-100 text-sky-700'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              }`}
              aria-label={item.label}
              title={item.label}
              aria-current={activeTab === item.id ? 'page' : undefined}
            >
              <item.icon size={18} className="shrink-0" />
              <span className={`truncate text-sm flex-1 text-left ${activeTab === item.id ? 'font-semibold' : 'font-medium'}`}>{item.label}</span>
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
                  className={`flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/30 ${groupActive ? 'text-sky-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}
                  aria-expanded={expanded}
                  title={group.label}
                >
                  <group.icon size={18} className="shrink-0" />
                  <span className="flex-1 truncate text-left text-sm font-semibold">{group.label}</span>
                  <ChevronDown size={14} className={`shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                </button>
                {expanded && (
                  <div className="mt-1 flex flex-col gap-1 pl-2 ml-4">
                    {group.pages.map((item) => (
                      <button
                        key={item.id}
                        data-nav-id={item.id}
                        onClick={() => onTabChange(item.id)}
                        className={`flex w-full min-w-0 items-center justify-start gap-2 rounded-lg px-2 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/30 ${activeTab === item.id ? 'bg-sky-100 text-sky-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}
                        aria-label={item.label}
                        title={item.label}
                        aria-current={activeTab === item.id ? 'page' : undefined}
                      >
                        <item.icon size={15} className="shrink-0" />
                        <span className={`flex-1 truncate text-left text-xs ${activeTab === item.id ? 'font-semibold' : 'font-medium'}`}>{item.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <button
          onClick={() => setIsSettingsOpen(true)}
          aria-pressed={isSettingsOpen}
          className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg transition-colors text-slate-600 hover:bg-slate-50 hover:text-slate-900 min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/30"
        >
          <Settings size={18} className="shrink-0" />
          <span className="truncate text-sm font-medium flex-1 text-left">设置</span>
        </button>
      </div>

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
