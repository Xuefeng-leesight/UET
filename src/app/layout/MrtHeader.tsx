import React from 'react';
import { Eye, FolderPlus, Plus, Search, Settings, Upload } from 'lucide-react';
import type { TabType } from '@shared/contracts/domain/models';
import { btnDanger, btnPrimary, btnSecondary } from '@/shared/ui/buttonClasses';
import { TERMINOLOGY } from '@/shared/constants/terminology';
import { useLanguage } from '@/app/i18n/useLanguage';
import appIcon from '@/assets/icon.png';
import CustomSelect from '@/shared/ui/CustomSelect';

interface MrtHeaderProps {
  currentView: 'dashboard' | 'detail';
  activeTab: TabType;
  dashboardSearchQuery: string;
  setDashboardSearchQuery: (value: string) => void;

  handleSetupProjectLibrary: () => void;
  handleAddExistingProject: () => void;
  setIsNewProjectModalOpen: (open: boolean) => void;
  projectRootPath?: string | null;

  setIsNewSubjectModalOpen: (open: boolean) => void;
  setIsFieldManagerOpen: (open: boolean) => void;

  onOpenAddStimulus: () => void;
  onStartPreview?: () => void;

  wsIp: string;
  setWsIp: (v: string) => void;
  wsImagePort: string;
  setWsImagePort: (v: string) => void;
  wsEyePort: string;
  setWsEyePort: (v: string) => void;
  wsConnected: boolean;
  toggleScreenRecorder: () => void;
  isCameraOn: boolean;
  toggleCamera: () => void;
  isDeviceToggling?: boolean;
  /** A device stop is still finishing in the background; starting waits for it. */
  isDeviceStopping?: boolean;
  handleStartRecording: () => void;
  handleStopRecording?: () => void;
  isRecording: boolean;
  isRecordingFinalizing?: boolean;
  isPreviewing?: boolean;
  recordingViewMode?: 'local' | 'monitor' | 'remote' | null;
  requiresRecordingModeSelection?: boolean;
  recordingMonitorLayout?: 'single' | '2x2' | '3x3';
  onRecordingMonitorLayoutChange?: (layout: 'single' | '2x2' | '3x3') => void;
  onResetRecordingMonitorLayout?: () => void;
  hiddenRecordingMonitorTiles?: Array<{ id: string; title: string }>;
  onRestoreRecordingMonitorTile?: (id: string) => void;
}

/** Shows `active` while reserving the width of the longest of `labels`. */
const StableLabel: React.FC<{ labels: string[]; active: string }> = ({ labels, active }) => (
  <span className="inline-grid justify-items-center">
    {labels.map((label) => (
      <span
        key={label}
        className="col-start-1 row-start-1 whitespace-nowrap"
        style={label === active ? undefined : { visibility: 'hidden' }}
        aria-hidden={label === active ? undefined : true}
      >
        {label}
      </span>
    ))}
  </span>
);

const MrtHeader: React.FC<MrtHeaderProps> = ({
  currentView,
  activeTab,
  dashboardSearchQuery,
  setDashboardSearchQuery,
  handleSetupProjectLibrary,
  handleAddExistingProject,
  setIsNewProjectModalOpen,
  projectRootPath,
  setIsNewSubjectModalOpen,
  setIsFieldManagerOpen,
  onOpenAddStimulus,
  onStartPreview,
  wsIp,
  setWsIp,
  wsImagePort,
  setWsImagePort,
  wsEyePort,
  setWsEyePort,
  wsConnected,
  toggleScreenRecorder,
  isCameraOn,
  toggleCamera,
  isDeviceToggling = false,
  isDeviceStopping = false,
  handleStartRecording,
  handleStopRecording,
  isRecording,
  isRecordingFinalizing = false,
  isPreviewing = false,
  recordingViewMode = null,
  requiresRecordingModeSelection = false,
  recordingMonitorLayout = 'single',
  onRecordingMonitorLayoutChange,
  onResetRecordingMonitorLayout,
  hiddenRecordingMonitorTiles = [],
  onRestoreRecordingMonitorTile,
}) => {
  const { language } = useLanguage();
  const isEn = language === 'en-US';
  const dragRegionStyle: React.CSSProperties = { WebkitAppRegion: 'drag' };
  const noDragRegionStyle: React.CSSProperties = { WebkitAppRegion: 'no-drag' };
  const safeRowStyle: React.CSSProperties = {
    marginTop: 'env(titlebar-area-height, 0px)',
  };
  const canCreateProject = Boolean(projectRootPath && projectRootPath.trim());

  const showRecordingMonitorControls =
    currentView === 'detail' &&
    activeTab === 'video' &&
    !(requiresRecordingModeSelection && recordingViewMode !== 'local') &&
    Boolean(onRecordingMonitorLayoutChange);

  const renderRecordingMonitorControls = () => {
    if (!showRecordingMonitorControls || !onRecordingMonitorLayoutChange) return null;
    return (
      <div className="flex shrink-0 flex-nowrap items-center gap-1 whitespace-nowrap" style={noDragRegionStyle}>
        <CustomSelect
          value={recordingMonitorLayout}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'reset') {
              onResetRecordingMonitorLayout?.();
              return;
            }
            onRecordingMonitorLayoutChange(value as 'single' | '2x2' | '3x3');
          }}
          aria-label="监控画面布局"
          className="min-w-32 rounded-lg px-3 py-1.5 text-[11px] font-medium text-slate-700 outline-none"
          menuClassName="flex min-w-32 flex-col"
        >
          <option value="single">单画面</option>
          <option value="2x2">2×2</option>
          <option value="3x3">3×3</option>
          <option value="reset">恢复默认</option>
        </CustomSelect>
        {hiddenRecordingMonitorTiles.map((tile) => (
          <button
            key={tile.id}
            type="button"
            onClick={() => onRestoreRecordingMonitorTile?.(tile.id)}
            className="ml-1 flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-slate-100 px-2.5 py-1.5 text-[11px] font-medium text-slate-700 transition-colors hover:bg-slate-200"
            title={`重新添加${tile.title}`}
          >
            <Plus size={13} /> {tile.title}
          </button>
        ))}
      </div>
    );
  };

  const renderHeaderButtons = () => {
    if (currentView === 'dashboard') {
      return (
        <div className="flex gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
            <input
              type="text"
              value={dashboardSearchQuery}
              onChange={(e) => setDashboardSearchQuery(e.target.value)}
              placeholder="搜索..."
              className="pl-9 pr-4 py-2 bg-[var(--app-control)] text-slate-700 rounded-lg text-xs w-52 focus:ring-2 focus:ring-sky-500/10 outline-none transition-colors"
            />
          </div>
          <button onClick={handleSetupProjectLibrary} className={btnSecondary}>
            <Settings size={14} /> {TERMINOLOGY.PROJECT_STORAGE_PATH_SETTINGS}
          </button>
          <button onClick={handleAddExistingProject} className={btnSecondary}>
            <FolderPlus size={14} /> 导入工程
          </button>
          <button
            onClick={() => {
              if (!canCreateProject) return;
              setIsNewProjectModalOpen(true);
            }}
            className={btnPrimary}
            disabled={!canCreateProject}
            title={canCreateProject ? undefined : '请先选择“项目存储路径”'}
          >
            <Plus size={14} /> 新建工程
          </button>
        </div>
      );
    }

    switch (activeTab) {
      case 'subject':
        return (
          <div className="flex gap-2">
            <button onClick={() => setIsNewSubjectModalOpen(true)} className={btnPrimary}>
              <Plus size={14} /> 新建受试者
            </button>
            <button onClick={() => setIsFieldManagerOpen(true)} className={btnSecondary}>
              <Settings size={14} /> 字段管理
            </button>
          </div>
        );
      case 'images':
        return (
          <div className="flex gap-2 items-center">
            <button
              onClick={onStartPreview}
              className={isPreviewing ? btnDanger : btnSecondary}
              disabled={isPreviewing}
            >
              <Eye size={14} />
              {isPreviewing ? (isEn ? 'Previewing...' : '预览中...') : (isEn ? 'Preview' : '预览')}
            </button>
            <button onClick={onOpenAddStimulus} className={btnPrimary}>
              <Upload size={14} /> 添加刺激物
            </button>
          </div>
        );
      case 'video':
        if (requiresRecordingModeSelection && recordingViewMode !== 'local') {
          return null;
        }
        return (
          <div className="flex gap-2 items-center">
            <button
              onClick={toggleCamera}
              disabled={isDeviceToggling || isDeviceStopping}
              className={isCameraOn ? btnSecondary : btnPrimary}
            >
              {/* All four labels share one grid cell, so the button keeps the width of
                  the longest one and its neighbours do not shift when it changes. */}
              <StableLabel
                labels={[isEn ? 'Stopping' : '停止中', isEn ? 'Starting' : '启动中', '停止设备', '启动设备']}
                active={isDeviceToggling
                  ? (isCameraOn ? (isEn ? 'Stopping' : '停止中') : (isEn ? 'Starting' : '启动中'))
                  : isDeviceStopping
                    ? (isEn ? 'Stopping' : '停止中')
                    : (isCameraOn ? '停止设备' : '启动设备')}
              />
            </button>
            <button
              onClick={isRecordingFinalizing
                ? undefined
                : isRecording
                  ? (handleStopRecording || handleStartRecording)
                  : handleStartRecording}
              className={isRecording ? btnDanger : btnPrimary}
              disabled={isRecordingFinalizing || (isRecording ? !handleStopRecording : !isCameraOn)}
              title={!isRecording && !isRecordingFinalizing && !isCameraOn ? (isEn ? 'Start the device first' : '请先启动设备') : undefined}
            >
              {isRecordingFinalizing
                ? (isEn ? 'Saving…' : '正在保存…')
                : isRecording
                  ? (isEn ? 'Stop recording' : '停止录制')
                  : (isEn ? 'Start recording' : '开始录制')}
            </button>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <header className="px-4 py-3" style={dragRegionStyle}>
      <div className="flex items-center gap-3" style={safeRowStyle}>
        {currentView === 'dashboard' ? (
          <div className="select-none whitespace-nowrap flex items-center gap-3 relative -top-5">
            <img
              src={appIcon}
              alt={isEn ? 'HRT Human Research Tool' : 'HRT人因研究工具平台'}
              className="block h-8 w-auto"
              draggable={false}
            />
            <div className="flex flex-col leading-none">
              <span className="text-lg font-black tracking-[0.18em] text-slate-700">
                HRT
              </span>
              <span className="text-[13px] font-semibold text-slate-500">
                {isEn ? 'Human Research Tool' : '人因研究工具平台'}
              </span>
            </div>
          </div>
        ) : null}
        {renderRecordingMonitorControls()}
        <div className="flex-1 flex justify-end" style={noDragRegionStyle}>{renderHeaderButtons()}</div>
      </div>
    </header>
  );
};

export default MrtHeader;
