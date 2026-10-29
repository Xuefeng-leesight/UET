import React from 'react';
import type { Project, TabType } from '@shared/contracts/domain/models';
import { TERMINOLOGY } from '@/shared/constants/terminology';
import { Modal } from '@/shared/ui/Modal';
import type { VideoExportStatus } from '@/features/export/domain/videoExportStatus';
import type { ProjectImportStatus } from '@/features/projects/domain/projectImportStatus';
import { useLanguage } from '@/app/i18n/useLanguage';
import { getImageStreamState, IMAGE_STREAM_LABELS } from '@/features/recording/domain/imageStreamState';

interface MrtFooterProps {
  currentView: 'dashboard' | 'detail';
  activeProject: Project | null;
  activeTab: TabType;
  projectRootPath: string;
  activeProjectDir?: string;
  deviceConnected: boolean;
  wsConnected?: boolean;
  lastImageAt?: number | null;
  videoExportStatus?: VideoExportStatus | null;
  projectImportStatus?: ProjectImportStatus | null;
}

const MrtFooter: React.FC<MrtFooterProps> = ({
  currentView,
  activeProject,
  activeTab,
  projectRootPath,
  activeProjectDir = '',
  deviceConnected,
  wsConnected = false,
  lastImageAt = null,
  videoExportStatus = null,
  projectImportStatus = null,
}) => {
  const { language } = useLanguage();
  const isDeviceOn = !!deviceConnected;
  const deviceStatusText = isDeviceOn ? '设备已开启' : '设备已关闭';
  const deviceDotClass = isDeviceOn
    ? 'w-2 h-2 rounded-full bg-emerald-500'
    : 'w-2 h-2 rounded-full bg-slate-400';
  const appVersion = __APP_VERSION__;
  const [isAboutOpen, setIsAboutOpen] = React.useState(false);
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (activeTab !== 'video' || !wsConnected) return undefined;
    setNowMs(Date.now());
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(intervalId);
  }, [activeTab, wsConnected]);
  const imageStreamState = getImageStreamState({ connected: wsConnected, lastFrameAt: lastImageAt, now: nowMs });
  const imageStreamDotClass = imageStreamState === 'active'
    ? 'bg-emerald-500 animate-pulse'
    : imageStreamState === 'waiting'
      ? 'bg-amber-500 animate-pulse'
      : 'bg-rose-500 animate-pulse';
  const imageStreamTextClass = imageStreamState === 'active'
    ? 'text-slate-600'
    : imageStreamState === 'waiting'
      ? 'text-slate-600'
      : 'text-rose-600';
  const footerTask = React.useMemo(() => {
    if (projectImportStatus) {
      return {
        label: projectImportStatus.label,
        summary: [
          projectImportStatus.projectName || null,
          projectImportStatus.currentFile || null,
          projectImportStatus.detail || null,
        ].filter(Boolean).join(' · '),
        progressPercent: Math.round(Math.max(0, Math.min(1, projectImportStatus.progress ?? 0)) * 100),
        phase: projectImportStatus.phase,
      };
    }
    if (videoExportStatus) {
      return {
        label: videoExportStatus.label,
        summary: videoExportStatus.recordName,
        progressPercent: Math.round(Math.max(0, Math.min(1, videoExportStatus.progress ?? 0)) * 100),
        phase: videoExportStatus.phase,
      };
    }
    return null;
  }, [projectImportStatus, videoExportStatus]);
  const footerTaskBarColor =
    footerTask?.phase === 'failed'
      ? 'bg-rose-500'
      : footerTask?.phase === 'done'
        ? 'bg-emerald-500'
        : 'bg-sky-500';
  const displayedProjectPath =
    currentView === 'detail'
      ? (activeProjectDir || projectRootPath || '')
      : (projectRootPath || '');
  
  return (
    <>
      <footer className="h-7 shrink-0 px-4 bg-[var(--app-surface-2)] text-[10px] font-medium text-slate-500 flex min-w-0 items-center justify-between gap-3 whitespace-nowrap">
        <div className="flex min-w-0 items-center gap-3">
          <span className="min-w-0 truncate text-sky-600 font-semibold" title={activeProject?.name}>
            {currentView === 'dashboard' ? (
              language === 'en-US' ? 'Ready' : '就绪'
            ) : (
              <>
                {language === 'en-US' ? 'Project: ' : '工程:'}{' '}
                <span data-i18n-skip="true">{activeProject?.name === '眼镜表情' ? (language === 'en-US' ? 'Facial analysis' : '表情分析') : activeProject?.name || '---'}</span>
              </>
            )}
          </span>
          {currentView === 'detail' && <span className="min-w-0 truncate" title={activeTab}>{language === 'en-US' ? 'Module: ' : '模块: '}{activeTab}</span>}
        </div>
        <div className="flex min-w-0 items-center justify-end gap-3">
          {footerTask && (
            <div className="flex min-w-0 items-center gap-2 normal-case">
              <span
                title={`${footerTask.label}${footerTask.summary ? ` · ${footerTask.summary}` : ''}`}
                className={`min-w-0 truncate text-[10px] font-semibold ${
                  footerTask.phase === 'failed'
                    ? 'text-rose-600'
                    : footerTask.phase === 'done'
                      ? 'text-emerald-600'
                      : 'text-sky-600'
                }`}
              >
                {footerTask.label}
                {footerTask.summary ? ` · ${footerTask.summary}` : ''}
              </span>
              <div className="w-16 h-1.5 shrink-0 rounded-full bg-slate-200 overflow-hidden">
                <div
                  className={`h-full transition-all duration-200 ${footerTaskBarColor}`}
                  style={{ width: `${footerTask.progressPercent}%` }}
                />
              </div>
              <span className="w-7 shrink-0 text-right text-slate-500 font-mono tabular-nums text-[10px]">{footerTask.progressPercent}%</span>
            </div>
          )}
          {displayedProjectPath && (
            <span className="min-w-0 normal-case text-[10px] text-slate-500 max-w-xs truncate" title={displayedProjectPath}>
              {TERMINOLOGY.PROJECT_STORAGE_PATH_SETTINGS.replace('设置', '')}:{' '}
              <span data-i18n-skip="true">{displayedProjectPath}</span>
            </span>
          )}
          <div className="flex shrink-0 items-center gap-1.5">
            <div className={deviceDotClass} />
            <span className="text-slate-600">
              {deviceStatusText}
            </span>
          </div>
          {activeTab === 'video' && (
            <div className="flex shrink-0 items-center gap-1.5">
              <div
                className={`w-2 h-2 rounded-full ${imageStreamDotClass}`}
              />
              <span className={imageStreamTextClass}>
                {IMAGE_STREAM_LABELS[imageStreamState]}
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={() => setIsAboutOpen(true)}
            className="mrt-button-text shrink-0 normal-case text-[10px] font-medium text-slate-500 hover:text-sky-600 transition-colors"
          >
            {language === 'en-US' ? 'About' : '关于我们'}
          </button>
        </div>
      </footer>
      <Modal
        isOpen={isAboutOpen}
        onClose={() => setIsAboutOpen(false)}
        title={language === 'en-US' ? 'About' : '关于我们'}
        maxWidthClassName="max-w-md"
      >
        <div className="space-y-4 text-sm text-slate-700">
          <div className="grid grid-cols-[88px_1fr] gap-3">
            <span className="font-bold text-slate-500">{language === 'en-US' ? 'Phone' : '联系电话'}</span>
            <span className="font-mono tabular-nums">15921347392</span>
          </div>
          <div className="grid grid-cols-[88px_1fr] gap-3">
            <span className="font-bold text-slate-500">{language === 'en-US' ? 'Email' : '电子邮件'}</span>
            <span>info@leesight.com</span>
          </div>
          <div className="grid grid-cols-[88px_1fr] gap-3">
            <span className="font-bold text-slate-500">{language === 'en-US' ? 'Version' : '软件版本'}</span>
            <span className="font-mono tabular-nums">{appVersion}</span>
          </div>
        </div>
      </Modal>
    </>
  );
};

export default MrtFooter;
