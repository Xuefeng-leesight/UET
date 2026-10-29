
import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Experiment, Project, RecordingRecord, Subject, TabType, ViewType, type ModalityId } from '@shared/contracts/domain/models';
import { Sidebar } from '@/app/layout/Sidebar';
import { MODULE_PAGE_VISIBILITY, MODULE_TAB_ORDER } from '@/app/config';
import { getProjectHiddenTabs, getProjectModulePages } from '@/modalities/registry';
import { createEyeTrackingModality, createFacialExpressionModality, migrateProject, normalizeProjectModalities, projectHasModality } from '@shared/domain/projectModalities';
import { filterRecordsByModality } from '@shared/domain/recordModalities';
import type { ComboStimulusItem, ConfirmState, ExtendedStimulus, HeatmapPoint, SubjectFieldDef, CustomMarker } from '@/shared/types/mrt';
import { beginEditStimulusName, uploadStimuli } from '@/features/stimuli/domain/stimuliModule';
import { restoreSavedProjectLibrary, setupProjectLibrary } from '@/features/projects/domain/projectLibraryModule';
import { createProject } from '@/features/projects/domain/projectsModule';
import { persistSubjectFields, persistSubjects } from '@/features/subjects/domain/subjectsPersistence';
import { createSubject, openEditSubject, requestDeleteSubject, saveEditedSubject } from '@/features/subjects/domain/subjectsModule';
import { useVisualAnalysisData } from '@/features/analysis/visual/useVisualAnalysisData';
import { parseAoiStore } from '@/features/analysis/aoi/aoiPersistence';

const asUnknownRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {};

const getUnknownErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

type RendererHeartbeatSnapshot = {
  isCameraOn: boolean;
  isRecording: boolean;
  isFacialCapturing: boolean;
  wsConnected: boolean;
  videoPreviewMode: string | null;
  combinedImagePreview: boolean;
  hasEyeTrackingModality: boolean;
  hasFacialExpressionModality: boolean;
  lastImageAt: number | null;
};

type PerformanceWithOptionalMemory = Performance & {
  memory?: {
    usedJSHeapSize?: number;
    totalJSHeapSize?: number;
    jsHeapSizeLimit?: number;
  };
};
import MrtHeader from '@/app/layout/MrtHeader';
import MrtFooter from '@/app/layout/MrtFooter';
import { btnPrimary } from '@/shared/ui/buttonClasses';
import NewProjectModal from '@/features/projects/NewProjectModal';
import NewSubjectModal from '@/features/subjects/NewSubjectModal';
import EditSubjectModal from '@/features/subjects/EditSubjectModal';
import EditStimulusModal from '@/features/stimuli/EditStimulusModal';
import AddStimulusModal from '@/features/stimuli/AddStimulusModal';
import SubjectFieldsManagerModal from '@/features/subjects/SubjectFieldsManagerModal';
import ConfirmModal from '@/app/ConfirmModal';
import NewExperimentModal from '@/features/projects/NewExperimentModal';
import { normalizeWebStimulusUrl } from '@/features/stimuli/WebStimulusFrame';
import FullscreenRecordingOverlay from '@/features/recording/FullscreenRecordingOverlay';
import FullscreenCalibrationOverlay from '@/features/recording/FullscreenCalibrationOverlay';
import { CALIB_INTERVAL_MS, CALIB_POINTS } from '@/features/recording/domain/calibrationConstants';
import { normalizeCalibrationPointStyle } from '@/features/recording/domain/calibrationPointStyle';
import { parseCalibrationPayload, type CalibrationScores } from '@/features/recording/domain/calibrationScores';
import { MONITOR_TILE_MODALITY, normalizeFacialRecordingSettings, type MonitorTileId } from '@/features/recording/domain/recordingModules';
import { drawGazePaths, drawHeatmap } from '@/features/analysis/visual/heatmapRendering';
import { cancelCalibration, createCalibrationController, getCalibrationPointsCount, getPupilCalibrationSequence, isCardCalibrationType } from '@/features/recording/domain/calibrationFlow';
import {
  closeWebSocketRef,
  connectCmdWebSocket,
  connectEyeWebSocket,
  connectEncodedVideoWebSocket,
  connectImageWebSocket,
  sendCmdOverWs,
  sendCmdWithResponse,
  stopDeviceCommand,
} from '@/features/recording/domain/recordingWsModule';
import { useSimulateMode } from '@/features/recording/simulate/useSimulateMode';
import { useGazeDisplayPath } from '@/features/recording/domain/gazeDisplayPath';
import { recordingPlaybackEffect } from '@/features/recording/domain/recordingPlaybackEffect';
import { loadProjectDetailData, loadProjectsFromRoot as loadProjectsFromRootMod } from '@/features/projects/domain/projectDataLoader';
import { loadRecordsForProject } from '@/features/records/domain/recordingsLoader';
import { mapLoadedRecordings } from '@/features/records/domain/recordingsMapping';
import {
  FINALIZATION_IDLE_FAILURE_ATTEMPTS,
  FINALIZATION_IDLE_RECOVERY_ATTEMPTS,
  findFinalizedRecordingOnDisk,
} from '@/features/recording/domain/recordingFinalizationRecovery';
import { matchesRecordingFinalization } from '@/features/recording/domain/recordingLifecycle';
import { findRecordingMetadataTarget } from '@/features/recording/domain/recordingMetadataTarget';
import { useAoiEditor } from '@/features/analysis/aoi/useAoiEditor';
import { getHitAoiNames, type NormalizedAoiShape } from '@shared/domain/aoi/aoiReport';
import { toggleCamera as toggleCameraMod } from '@/features/recording/domain/cameraModule';
import { startRecording as startRecordingMod } from '@/features/recording/domain/recordingStartModule';
import { finishRecordingCommunication } from '@/features/recording/domain/recordingCommunication';
import type { RecordingSettings } from '@/features/recording/domain/recordingContracts';
import { useRecordingDeviceState, type RecordingMonitorLayout } from '@/features/recording/domain/useRecordingDeviceState';
import { useFacialCaptureState, type FacialCamera } from '@/features/recording/domain/useFacialCaptureState';
import {
  enumerateBrowserFacialCameras,
  startBrowserFacialPreview,
  type BrowserFacialPreviewController,
} from '@/features/recording/domain/browserFacialCapture';
import { useCalibrationUiState } from '@/features/recording/domain/useCalibrationUiState';
import { createParticipantWindowState } from '@/features/recording/domain/participantWindowState';
import { useMrtWorkspaceState } from '@/app/workspace/useMrtWorkspaceState';
import { useMrtEditorState } from '@/app/workspace/useMrtEditorState';
import { useMrtTaskStatus } from '@/app/workspace/useMrtTaskStatus';
import { useMrtAppEvents } from '@/app/workspace/useMrtAppEvents';
import { useProjectFacialSettings } from '@/app/workspace/useProjectFacialSettings';
import { stopActiveAudioCapture, stopActiveAudioRecording } from '@/features/recording/domain/audioRecording';
import { useLanguage } from '@/app/i18n/useLanguage';
import { translateTextForLanguage } from '@/app/i18n/useDomTranslation';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import { useMainWindowOverlayMask } from '@/infrastructure/electron/useMainWindowOverlayMask';
import { playbackEngine } from '@/features/stimuli/PlaybackEngine';
import { preloadStimulusMedia } from '@/features/multiplayer/domain/preloadStimulusMedia';
import type { TriggerConfig } from '@/shared/types/mrt';
import type { TimeSegment } from '@shared/domain/timeline';
import { useNavigationGuard } from '@/app/hooks/useNavigationGuard';
import type { CompareResult, InsightReport } from '@shared/contracts/domain/reporting';
import {
  deviceTypeFromModel,
  getDeviceProfile,
  normalizeSdkResolution,
  normalizeDeviceModel,
  type DeviceModel,
  type DeviceType,
} from '@/features/recording/device/deviceProfile';

const ProjectSettingsPage = lazy(() => import('@/features/projects/ProjectSettingsPage'));
const StimulusPage = lazy(() => import('@/features/stimuli/StimulusPage'));
const SubjectPage = lazy(() => import('@/features/subjects/SubjectPage'));
const ExportPage = lazy(() => import('@/features/export/ExportPage'));
const ChartPage = lazy(() => import('@/features/analysis/reports/ChartPage'));
const InsightPage = lazy(() => import('@/features/analysis/reports/InsightPage'));
const AoiPage = lazy(() => import('@/features/analysis/aoi/AoiPage'));
const DashboardPage = lazy(() => import('@/app/pages/DashboardPage'));
const RecordingPage = lazy(() => import('@/features/recording/RecordingPage'));
const RecordDetailPage = lazy(() => import('@/features/records/RecordDetailPage'));
const FacialRecordDetailPage = lazy(() => import('@/features/records/FacialRecordDetailPage'));
const RecordsListPage = lazy(() => import('@/features/records/RecordsListPage'));
const VisualPage = lazy(() => import('@/features/analysis/visual/VisualPage'));
const StableSidebar = React.memo(Sidebar);
const StableHeader = React.memo(MrtHeader);
const StableFooter = React.memo(MrtFooter);
const MappingPage = lazy(() => import('@/features/mapping/MappingPage'));
const FacialAnalysisPage = lazy(() => import('@/features/facial/FacialAnalysisPage'));

const PageLoadingFallback = () => (
  <div className="flex h-full w-full items-center justify-center text-sm text-[var(--app-text-muted)]">
    正在加载模块…
  </div>
);

const GAZE_COLORS = [
  '#ff4b4b',
  '#4b7bff',
  '#00b894',
  '#e17055',
  '#6c5ce7',
  '#fd79a8',
  '#0984e3',
  '#d63031',
];
const CARD_DETECTION_CAPTURE_MAX_WIDTH = 1440;

const DEFAULT_SUBJECT_FIELDS: SubjectFieldDef[] = [
  { id: 'builtin_name', label: '姓名', builtin: true },
  { id: 'builtin_gender', label: '性别', builtin: true },
  { id: 'builtin_age', label: '年龄', builtin: true },
];

const createEmptyEyeData = () => ({
  timestamp: '',
  recomGazeX: '',
  recomGazeY: '',
  recomGazeBitMask: '',
  recomPointX: '',
  recomPointY: '',
  recomRawX: '',
  recomRawY: '',
  recomSmoothX: '',
  recomSmoothY: '',
  leftGazeX: '',
  leftGazeY: '',
  leftGazeBitMask: '',
  leftPointX: '',
  leftPointY: '',
  leftRawX: '',
  leftRawY: '',
  leftSmoothX: '',
  leftSmoothY: '',
  rightGazeX: '',
  rightGazeY: '',
  rightGazeBitMask: '',
  rightPointX: '',
  rightPointY: '',
  rightRawX: '',
  rightRawY: '',
  rightSmoothX: '',
  rightSmoothY: '',
  leftPupilCenterX: '',
  leftPupilCenterY: '',
  leftPupilDiameter: '',
  leftPupilDiameterMm: '',
  rightPupilCenterX: '',
  rightPupilCenterY: '',
  rightPupilDiameter: '',
  rightPupilDiameterMm: '',
  leftBlink: '',
  leftOpenness: '',
  leftEyelidUp: '',
  leftEyelidDown: '',
  rightBlink: '',
  rightOpenness: '',
  rightEyelidUp: '',
  rightEyelidDown: '',
  fixationTimestampMs: '',
  fixationDurationMs: '',
  fixationTimestampUs: '',
  fixationDurationUs: '',
  fixationCount: '',
  fixationState: '',
  fixationCenterX: '',
  fixationCenterY: '',
  gazeVelocityMs: '',
  saccadeAmplitude: '',
  saccadeDurationMs: '',
  saccadeVelocity: '',
  saccadePeakVelocity: '',
});

const tcpBooleanString = (value: unknown): string => {
  if (typeof value === 'boolean') return value ? '1' : '0';
  const text = String(value ?? '').trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'blink' || text === 'closed' ? '1' : '0';
};

const tcpGazeValid = (mask: unknown, x: unknown, y: unknown): boolean => {
  const bitMask = Number(mask);
  return Number.isFinite(bitMask) && bitMask > 0 && Number.isFinite(Number(x)) && Number.isFinite(Number(y));
};

const normalizeNameForCompare = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();

const getCalibrationSequence = (points: number): number[] => {
  if (points === 1) return [4];
  if (points === 3) return [4, 0, 8];
  if (points === 5) return [4, 0, 2, 6, 8];
  return [0, 1, 2, 3, 4, 5, 6, 7, 8];
};

const MrtApp: React.FC = () => {
  const { simulateMode } = useSimulateMode();
  const { gazeDisplayPath } = useGazeDisplayPath();
  const { language } = useLanguage();
  const isEn = language === 'en-US';
  const {
    currentView, setCurrentView, activeProjectId, setActiveProjectId, activeTab, setActiveTab,
    selectedRecordId, setSelectedRecordId, visualSubTab, setVisualSubTab,
    visualSelectedStimulusId, setVisualSelectedStimulusId, visibleRecordIds, setVisibleRecordIds,
    heatmapSettings, setHeatmapSettings,
    projects, setProjects, projectDirs, setProjectDirs, dashboardSearchQuery, setDashboardSearchQuery,
    subjects, setSubjects, stimuli, setStimuli, records, setRecords,
    experiments, setExperiments, activeExperimentId, setActiveExperimentId, activeExperiment, activeProject,
    chartMode, setChartMode, chartPreselectedRecordIds, setChartPreselectedRecordIds,
    latestCompareResult, setLatestCompareResult, latestInsightReport, setLatestInsightReport,
    chartAiBusy, setChartAiBusy, chartAiBusyText, setChartAiBusyText, customMarkers, setCustomMarkers,
    editedProject, setEditedProject, hasProjectChanges, setHasProjectChanges, prevActiveProjectIdRef,
  } = useMrtWorkspaceState();
  const [recordDetailModality, setRecordDetailModality] = useState<ModalityId>('eye-tracking');

  const heatmapCanvasRef = useRef<HTMLCanvasElement>(null);
  const gazeCanvasRef = useRef<HTMLCanvasElement>(null);

  // --- Refs ---
  const fileInputRef = useRef<HTMLInputElement>(null);
  const detailVideoRef = useRef<HTMLVideoElement>(null);
  const previewAwaitingFrameSinceRef = useRef<number | null>(null);
  const deviceConnectionRequestedRef = useRef(false);
  const deviceConnectionGenerationRef = useRef(0);
  // Some Windows 10/WebView2 installations accept the encoded socket but never
  // decode a first frame. Once that happens, keep the image transport for the
  // current device session instead of repeatedly switching back to a black
  // WebCodecs canvas.
  const webCodecsImageFallbackRef = useRef(false);

  const {
    videoExportStatus,
    projectImportStatus,
    handleVideoExportStatusChange,
    handleProjectImportStatusChange,
  } = useMrtTaskStatus();

  const {
    recordingSettings, setRecordingSettings,
    isCameraOn, setIsCameraOn,
    wsConnected, setWsConnected, wsIp, setWsIp,
    wsImagePort, setWsImagePort, wsCmdPort, wsEyePort, setWsEyePort,
    wsImageRef, encodedVideoPreviewRef, wsCmdRef, wsEyeRef,
    imageCanvasRef, videoPreviewCanvasRef,
    lastImageAt, setLastImageAt, videoPreviewMode, setVideoPreviewMode,
    videoPreviewStatus, setVideoPreviewStatus, videoPreviewFrameSize, setVideoPreviewFrameSize,
    calibrationCoe, setCalibrationCoe, calibrationScores, setCalibrationScores, activeTrackingCoeRef,
    recordingLifecycle, isRecording, isRecordingFinalizing,
    recordingFinalizationResult, setRecordingFinalizationResult, recordingFinalizationHandlingRef,
    isPreviewing, setIsPreviewing,
    recordingMonitorLayout, setRecordingMonitorLayout,
    recordingMonitorLayoutResetToken, setRecordingMonitorLayoutResetToken,
    hiddenRecordingMonitorTileIds, setHiddenRecordingMonitorTileIds,
    isRecordingCaptureReady, setIsRecordingCaptureReady,
    samplingRateHz, videoSamplingRateHz,
    playbackIndex, setPlaybackIndex, eyeDataStore, setEyeData,
    customGroups, setCustomGroups, triggerConfig, setTriggerConfig,
  } = useRecordingDeviceState(createEmptyEyeData);

  const currentRecordingSubject = useMemo(() => {
    if (subjects.length === 0) return null;
    return subjects.find((s) => s.id === recordingSettings.subjectId) || subjects[0] || null;
  }, [subjects, recordingSettings.subjectId]);

  const currentRecordingSubjectId = currentRecordingSubject?.id || '';
  const currentRecordingSubjectName = String(currentRecordingSubject?.姓名 ?? currentRecordingSubject?.name ?? '').trim();

  useEffect(() => {
    if (subjects.length === 0) {
      setRecordingSettings((prev) => (prev.subjectId ? { ...prev, subjectId: '' } : prev));
      return;
    }
    const exists = subjects.some((s) => s.id === recordingSettings.subjectId);
    if (exists) return;
    const fallbackId = subjects[0]?.id || '';
    if (!fallbackId) return;
    setRecordingSettings((prev) => (prev.subjectId === fallbackId ? prev : { ...prev, subjectId: fallbackId }));
  }, [subjects, recordingSettings.subjectId]);

  // --- Detail View Properties State ---
  const [detailProps, setDetailProps] = useState({
    style: '扩散圆',
    radius: 10,
    opacity: 0.80,
    color: '#ef4444'
  });

  const activeDeviceModel = normalizeDeviceModel(editedProject?.deviceModel || activeProject?.deviceModel, editedProject?.deviceType || activeProject?.deviceType);
  const activeDeviceType = deviceTypeFromModel(activeDeviceModel);
  const activeDeviceProfile = useMemo(() => getDeviceProfile(activeDeviceType, activeDeviceModel), [activeDeviceType, activeDeviceModel]);
  const hasEyeTrackingModality = projectHasModality(activeProject, 'eye-tracking');
  const hasFacialExpressionModality = projectHasModality(activeProject, 'facial-expression');
  const eyeTrackingRecords = useMemo(() => filterRecordsByModality(records, 'eye-tracking'), [records]);
  const enabledRecordingModalities = useMemo(
    () => normalizeProjectModalities(activeProject).map((modality) => modality.id),
    [activeProject],
  );
  useEffect(() => {
    // 仅默认隐藏「被试屏幕」。采集模块（眼动/表情）的模态门控由 RecordingPage
    // 依据 enabledRecordingModalities 显式处理，避免模态未启用的 tile 混入用户
    // 手动隐藏列表、在顶部错误显示「重新添加」按钮。
    // 眼镜式（aSeeGlassesPlus）下眼动与表情采集互斥：vendor SDK 在多摄像头环境下
    // 会死锁，故默认只显示眼动 tile，表情不进入默认监控（需手动「重新添加」）。
    setHiddenRecordingMonitorTileIds(
      activeDeviceProfile.deviceType === '眼镜式' ? ['participant', 'facial'] : ['participant'],
    );
  }, [activeProjectId, activeDeviceProfile.deviceType, setHiddenRecordingMonitorTileIds]);
  const effectiveHiddenTabs = useMemo<TabType[]>(() => {
    const hiddenTabs = new Set<TabType>(getProjectHiddenTabs(activeProject));
    MODULE_TAB_ORDER.forEach((tab) => {
      if (!MODULE_PAGE_VISIBILITY[tab]) hiddenTabs.add(tab);
    });
    return Array.from(hiddenTabs);
  }, [activeProject]);
  const useFullscreenCalibration = activeDeviceProfile.calibrationMode !== 'click';
  const selectedRecordingViewMode = ['local', 'monitor', 'remote'].includes(String(recordingSettings.recordingViewMode || ''))
    ? (recordingSettings.recordingViewMode as 'local' | 'monitor' | 'remote')
    : null;
  const shouldUseLocalRecordingPipeline =
    hasEyeTrackingModality && (activeDeviceProfile.deviceType !== '眼镜式' || selectedRecordingViewMode === 'local');
  const isFixedRemoteEyeMonitor = hasEyeTrackingModality
    && activeDeviceProfile.deviceType === '眼镜式'
    && (selectedRecordingViewMode === 'monitor' || selectedRecordingViewMode === 'remote');
  const multiplayerRecordingEligibility = useMemo(() => {
    if (simulateMode) {
      return { eligible: false, reason: '模拟模式不支持多人录制' };
    }
    if (!hasEyeTrackingModality) {
      return { eligible: true, reason: '' };
    }
    if (activeDeviceProfile.deviceType !== '眼镜式') {
      return { eligible: true, reason: '' };
    }
    if (selectedRecordingViewMode === 'local') {
      return { eligible: true, reason: '' };
    }
    if (selectedRecordingViewMode === 'monitor') {
      return { eligible: false, reason: '眼镜式监测模式不支持多人录制，请切换到本地模式' };
    }
    if (selectedRecordingViewMode === 'remote') {
      return { eligible: false, reason: '眼镜式远程模式不支持多人录制，请切换到本地模式' };
    }
    return { eligible: false, reason: '请先选择眼镜式本地模式' };
  }, [activeDeviceProfile.deviceType, hasEyeTrackingModality, selectedRecordingViewMode, simulateMode]);
  const prevActiveDeviceModelRef = useRef<DeviceModel | null>(null);

  // Sync editedProject when activeProject changes or when entering the tab
  useEffect(() => {
    const prevId = prevActiveProjectIdRef.current;
    const activeChanged = prevId !== activeProjectId;
    prevActiveProjectIdRef.current = activeProjectId;

    if (!activeProject) {
      setEditedProject(null);
      if (activeChanged) {
        setHasProjectChanges(false);
        setVisibleRecordIds(new Set());
        setHeatmapPointsByRecord({});
      }
      return;
    }

    setEditedProject((prev) => {
      if (!activeChanged && hasProjectChanges && prev && prev.id === activeProject.id) {
        return prev;
      }
      return { ...activeProject };
    });
    if (activeChanged) {
      setHasProjectChanges(false);
      setVisibleRecordIds(new Set());
      setHeatmapPointsByRecord({});
    }
  }, [activeProjectId, activeProject, hasProjectChanges]);

  useEffect(() => {
    setRecordingSettings((prev) => {
      const next: Partial<RecordingSettings> = {};
      if (!activeDeviceProfile.calibrationTypes.includes(String(prev.calibrationType || ''))) {
        next.calibrationType = activeDeviceProfile.defaultCalibrationType;
      }
      if (!activeDeviceProfile.stimulusEnabled) {
        if (prev.randomOrder) next.randomOrder = false;
        if (prev.endOnClick) next.endOnClick = false;
      }
      if (activeDeviceProfile.deviceType === '眼镜式') {
        if (prev.recordMouse) next.recordMouse = false;
        if (prev.hideGaze) next.hideGaze = false;
      }
      const env = Number(prev.sdkEnvironment);
      if (env !== 301 && env !== 302 && env !== 303) {
        next.sdkEnvironment = 301;
      }
      const res = normalizeSdkResolution(prev.sdkResolution, activeDeviceProfile);
      if (Number(prev.sdkResolution) !== res) {
        next.sdkResolution = res;
      }
      if (activeDeviceProfile.deviceType !== '眼镜式' && prev.recordingViewMode) {
        next.recordingViewMode = null;
      }
      if (!hasEyeTrackingModality && prev.recordingViewMode) {
        next.recordingViewMode = null;
      }
      if (Object.keys(next).length === 0) return prev;
      return { ...prev, ...next };
    });
  }, [activeDeviceProfile, hasEyeTrackingModality, recordingSettings.sdkResolution]);

  useEffect(() => {
    const prevModel = prevActiveDeviceModelRef.current;
    prevActiveDeviceModelRef.current = activeDeviceModel;
    if (prevModel === null || prevModel === activeDeviceModel) return;
    setRecordingSettings((prev) => {
      if (!prev.recordingViewMode) return prev;
      return { ...prev, recordingViewMode: null };
    });
  }, [activeDeviceModel]);

  useEffect(() => {
    if (!ipcClient.isAvailable()) return;
    if (!hasEyeTrackingModality) return;
    if (isRecording || isRecordingFinalizing) return;
    const deviceModel = normalizeDeviceModel(activeProject?.deviceModel, activeProject?.deviceType);
    const deviceType = deviceTypeFromModel(deviceModel);
    void ipcClient.setActiveProjectDeviceType({ deviceType, deviceModel,
      projectDir: activeProjectId ? projectDirs[activeProjectId] : undefined }).catch((error) => {
      console.error('[project] sync device type to main failed', error);
    });
  }, [activeProject?.deviceType, activeProject?.deviceModel, hasEyeTrackingModality, activeProjectId, projectDirs, isRecording, isRecordingFinalizing]);

  useEffect(() => {
    if (currentView !== 'detail') return;
    if (!effectiveHiddenTabs.includes(activeTab)) return;
    setSelectedRecordId(null);
    const fallbackTab = getProjectModulePages(activeProject).find((page) => !effectiveHiddenTabs.includes(page.id))?.id;
    if (fallbackTab) {
      setActiveTab(fallbackTab);
      return;
    }
    setCurrentView('dashboard');
  }, [currentView, activeProject, activeTab, effectiveHiddenTabs]);

  const {
    isNewProjectModalOpen, setIsNewProjectModalOpen, newProjectData, setNewProjectData,
    isNewExperimentModalOpen, setIsNewExperimentModalOpen, newExperimentName, setNewExperimentName,
    isNewSubjectModalOpen, setIsNewSubjectModalOpen, newSubjectData, setNewSubjectData,
    isFieldManagerOpen, setIsFieldManagerOpen, isEditSubjectModalOpen, setIsEditSubjectModalOpen,
    editingSubjectId, setEditingSubjectId, editSubjectData, setEditSubjectData,
    isEditStimulusModalOpen, setIsEditStimulusModalOpen, editingStimulusId, setEditingStimulusId,
    editStimulusName, setEditStimulusName, editStimulusNameLocked, setEditStimulusNameLocked,
    editStimulusFixedTimeSec, setEditStimulusFixedTimeSec, editStimulusActive, setEditStimulusActive,
    editStimulusBgColor, setEditStimulusBgColor, editStimulusFontSize, setEditStimulusFontSize,
    editStimulusFontColor, setEditStimulusFontColor, editStimulusText, setEditStimulusText,
    editStimulusWebUrl, setEditStimulusWebUrl,
    editStimulusExternalMarker, setEditStimulusExternalMarker, editStimulusEndOnClick, setEditStimulusEndOnClick,
    editStimulusEndOnKey, setEditStimulusEndOnKey, editStimulusGroup, setEditStimulusGroup,
    editStimulusRandomPlay, setEditStimulusRandomPlay, editStimulusTriggerEnabled, setEditStimulusTriggerEnabled,
    editStimulusTriggerMark, setEditStimulusTriggerMark, editStimulusGroupPlayMode, setEditStimulusGroupPlayMode,
    editStimulusGroupRandomCount, setEditStimulusGroupRandomCount,
    editStimulusGroupRepeatCount, setEditStimulusGroupRepeatCount, editStimulusPlayToEnd, setEditStimulusPlayToEnd,
    editStimulusComboItems, setEditStimulusComboItems, editStimulusComboCanvasStyle, setEditStimulusComboCanvasStyle,
    isAddStimulusModalOpen, setIsAddStimulusModalOpen, addStimulusKind, setAddStimulusKind,
    addStimulusName, setAddStimulusName, addStimulusText, setAddStimulusText, addStimulusWebUrl, setAddStimulusWebUrl,
    stimuliSaveHint, setStimuliSaveHint, currentStimulusGroup, setCurrentStimulusGroup,
    hydratingProjectId, setHydratingProjectId, subjectFields, setSubjectFields,
    projectRootPath, setProjectRootPath, confirmState, setConfirmState,
  } = useMrtEditorState({ isEnglish: isEn, defaultSubjectFields: DEFAULT_SUBJECT_FIELDS });

  const activeProjectDir = useMemo(() => (activeProjectId ? projectDirs[activeProjectId] || '' : ''), [activeProjectId, projectDirs]);
  const activeDataDir = useMemo(() => activeExperiment?.dir || '', [activeExperiment]);

  const normalizeNoticeText = useCallback(
    (value: string): string => {
      const raw = String(value ?? '').trim();
      if (!raw) return raw;
      if (/codec can't decode|UnicodeDecodeError|illegal multibyte sequence|invalid continuation byte/iu.test(raw)) {
        return isEn
          ? 'A background service returned unreadable process output. Please reinstall the complete current build and retry.'
          : '后台服务返回了无法解码的进程信息，请重新安装当前版本的完整安装包后重试。';
      }
      if (isEn && (/Start failed\s*\(-(?:12|12015)\)/iu.test(raw) || /加密狗实例创建失败/u.test(raw) || /密钥无效/u.test(raw) || /_?7i_device_connect/iu.test(raw))) {
        return 'USB dongle error. Please replug the dongle and retry, or check its connection and permissions.';
      }
      const commandChannelNotConnected = isEn ? 'Command channel not connected' : '命令通道未连接';
      const commandChannelClosed = isEn ? 'Command channel closed' : '命令通道已关闭';
      let next = (isEn ? translateTextForLanguage(raw, 'en-US') : raw)
        .replace(/命令通道未\s*Connect/giu, commandChannelNotConnected)
        .replace(/命令通道未连接/gu, commandChannelNotConnected)
        .replace(/命令通道已关闭/gu, commandChannelClosed)
        .replace(/Command channel not connected/giu, commandChannelNotConnected)
        .replace(/Command channel closed/giu, commandChannelClosed);

      if (isEn) {
        next = next
          .replace(/^提示$/u, 'Notice')
          .replace(/^完成$/u, 'Done')
          .replace(/^校准启动失败[:：]\s*/u, 'Failed to start calibration: ')
          .replace(/^开始录制失败[:：]\s*/u, 'Failed to start recording: ')
          .replace(/^录制已结束$/u, 'Recording ended');
      } else {
        next = next
          .replace(/^Notice$/iu, '提示')
          .replace(/^Done$/iu, '完成')
          .replace(/^Failed to start calibration:\s*/iu, '校准启动失败：')
          .replace(/^Failed to start recording:\s*/iu, '开始录制失败：')
          .replace(/^Recording ended$/iu, '录制已结束');
      }
      return next;
    },
    [isEn],
  );

  const showNotice = useCallback((
    message: string,
    title = isEn ? 'Notice' : '提示',
    confirmVariant: 'danger' | 'primary' = 'primary',
  ) => {
    setConfirmState({
      open: true,
      title: normalizeNoticeText(title),
      message: normalizeNoticeText(message),
      onConfirm: null,
      showCancel: false,
      confirmText: isEn ? 'Done' : '完成',
      confirmVariant,
    });
  }, [isEn, normalizeNoticeText]);


  useEffect(() => {
    const originalAlert = window.alert.bind(window);
    window.alert = ((message?: unknown) => {
      showNotice(String(message ?? ''));
    }) as typeof window.alert;
    return () => {
      window.alert = originalAlert;
    };
  }, [showNotice]);

  // --- Facial Analysis State ---
  const {
    facialCameras, setFacialCameras, facialCameraId, setFacialCameraId,
    isFacialCapturing, setIsFacialCapturing, facialCaptureNotice, setFacialCaptureNotice,
    facialServerErrorRef, facialAutoCaptureRecordIdRef, facialAutoCaptureActiveRef,
    facialWsCmdRef, facialImageWsRef,
    facialPreviewStream, setFacialPreviewStream,
    facialPreviewDataUrl, setFacialPreviewDataUrl, facialFaceBox, setFacialFaceBox,
    facialExpression, setFacialExpression, facialEmotionScores, setFacialEmotionScores,
    facialLandmarks, setFacialLandmarks, facialSessionStatus, setFacialSessionStatus,
    facialSettings, setFacialSettings,
  } = useFacialCaptureState();
  const facialPreviewStopPromiseRef = useRef<Promise<void> | null>(null);
  const facialConnectPromiseRef = useRef<Promise<boolean> | null>(null);
  const facialCameraRefreshPromiseRef = useRef<Promise<FacialCamera[]> | null>(null);
  const facialPreviewStartPromiseRef = useRef<Promise<boolean> | null>(null);
  const facialBrowserPreviewRef = useRef<BrowserFacialPreviewController | null>(null);
  const facialPreviewGenerationRef = useRef(0);
  const facialBrowserRecordingRef = useRef<{
    recorder: MediaRecorder;
    recordId: string;
    projectDir: string;
    outputPath: string;
    startedAtMs: number;
    startedMonoMs: number;
    writeChain: Promise<void>;
    writeError: string;
    acceptSamples: boolean;
    samples: string[];
    sampleCount: number;
    width: number;
    height: number;
    fps: number;
  } | null>(null);
  const facialPageLifecycleGenerationRef = useRef(0);
  const rendererHeartbeatSnapshotRef = useRef<RendererHeartbeatSnapshot>({
    isCameraOn: false,
    isRecording: false,
    isFacialCapturing: false,
    wsConnected: false,
    videoPreviewMode: 'image',
    combinedImagePreview: false,
    hasEyeTrackingModality: false,
    hasFacialExpressionModality: false,
    lastImageAt: null,
  });
  const facialProjectDefaults = useMemo(() => {
    const modality = activeProject?.modalities?.find((item) => item.id === 'facial-expression');
    return modality?.id === 'facial-expression' ? modality.config : {};
  }, [activeProject]);
  useProjectFacialSettings({
    projectDir: activeDataDir,
    projectDefaults: facialProjectDefaults,
    enabled: hasFacialExpressionModality,
    settings: facialSettings,
    setSettings: setFacialSettings,
    setCameraId: setFacialCameraId,
  });

  const ensureFacialServerAndConnect = useCallback((): Promise<boolean> => {
    const openSocket = facialWsCmdRef.current;
    if (openSocket?.readyState === WebSocket.OPEN) return Promise.resolve(true);
    if (facialConnectPromiseRef.current) return facialConnectPromiseRef.current;

    const connectPromise = (async () => {
      const statusRes = await ipcClient.facialServerStatus();
      let ports = statusRes.ports;
      if (!statusRes.running) {
        const startRes = await ipcClient.startFacialServer();
        if (!startRes.ok) {
          const message = startRes.message || '无法启动表情服务';
          facialServerErrorRef.current = message;
          setFacialCaptureNotice(message);
          return false;
        }
        facialServerErrorRef.current = '';
        if (startRes.ports) ports = startRes.ports;
      }

      const host = wsIp || '127.0.0.1';
      for (let retry = 0; retry < 3; retry++) {
        let socket: WebSocket | null = null;
        try {
          socket = new WebSocket(`ws://${host}:${ports.cmd}/`);
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            const timeoutId = window.setTimeout(() => {
              if (settled) return;
              settled = true;
              reject(new Error('连接超时'));
            }, 3000);
            socket!.onopen = () => {
              if (settled) return;
              settled = true;
              window.clearTimeout(timeoutId);
              resolve();
            };
            socket!.onerror = () => {
              if (settled) return;
              settled = true;
              window.clearTimeout(timeoutId);
              reject(new Error('连接失败'));
            };
          });
          facialWsCmdRef.current = socket;
          facialServerErrorRef.current = '';
          socket.onclose = () => {
            if (facialWsCmdRef.current === socket) facialWsCmdRef.current = null;
          };
          return true;
        } catch {
          try { socket?.close(); } catch {}
          if (retry < 2) await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
        }
      }
      console.warn('[MrtApp] facial WS connection failed');
      facialServerErrorRef.current = '表情服务已启动，但命令通道连接失败';
      setFacialCaptureNotice(facialServerErrorRef.current);
      return false;
    })();
    facialConnectPromiseRef.current = connectPromise;
    const clearPromise = () => {
      if (facialConnectPromiseRef.current === connectPromise) facialConnectPromiseRef.current = null;
    };
    void connectPromise.then(clearPromise, clearPromise);
    return connectPromise;
  }, [wsIp]);

  const refreshFacialCameras = useCallback((): Promise<FacialCamera[]> => {
    if (facialCameraRefreshPromiseRef.current) return facialCameraRefreshPromiseRef.current;

    const refreshPromise = (async () => {
      let cameras: FacialCamera[] = [];
      try {
        cameras = await enumerateBrowserFacialCameras(facialSettings.width, facialSettings.height);
      } catch (error) {
        setFacialCaptureNotice(error instanceof Error ? error.message : '读取摄像头失败');
      }
      void ipcClient.videoDebugLog({
        event: 'facial:cameras-refreshed',
        details: {
          ok: cameras.length > 0,
          source: 'renderer-media-devices',
          cameraCount: cameras.length,
          cameraIds: cameras.map((camera) => camera.id),
          selectedCameraId: facialCameraId || null,
        },
      });
      setFacialCameras(cameras);
      setFacialCameraId((current) => {
        if (cameras.some((camera) => camera.id === current)) return current;
        const configuredById = cameras.find((camera) => camera.id === facialSettings.cameraId);
        if (configuredById) return configuredById.id;
        const configuredByIndex = Number.isInteger(facialSettings.cameraIndex)
          ? cameras.find((camera) => camera.index === Number(facialSettings.cameraIndex))
          : undefined;
        if (configuredByIndex) return configuredByIndex.id;
        return cameras.length === 1 ? cameras[0].id : '';
      });
      return cameras;
    })();
    facialCameraRefreshPromiseRef.current = refreshPromise;
    const clearPromise = () => {
      if (facialCameraRefreshPromiseRef.current === refreshPromise) facialCameraRefreshPromiseRef.current = null;
    };
    void refreshPromise.then(clearPromise, clearPromise);
    return refreshPromise;
  }, [facialCameraId, facialSettings.cameraId, facialSettings.cameraIndex, facialSettings.height, facialSettings.width]);

  const generateFacialRecordName = useCallback(() => {
    const now = new Date();
    const y = String(now.getFullYear());
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const namePart = currentRecordingSubjectName || 'subject';
    return `${namePart}_${y}${m}${d}_${hh}${mm}${ss}`;
  }, [currentRecordingSubjectName]);

  const startFacialAutoCapture = useCallback(async (recordId: string, isCurrent: () => boolean = () => true) => {
    if (!isCurrent()) return false;
    if (!activeDataDir) return false;
    const preview = facialBrowserPreviewRef.current;
    if (!preview || !facialSessionStatus?.inferenceReady) {
      setFacialCaptureNotice('表情摄像头或推理引擎尚未就绪');
      return false;
    }
    if (facialBrowserRecordingRef.current) return true;
    if (typeof MediaRecorder === 'undefined') {
      setFacialCaptureNotice('当前环境不支持浏览器视频录制');
      return false;
    }

    const mimeType = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ].find((candidate) => MediaRecorder.isTypeSupported(candidate)) || '';
    const outputPath = `${activeDataDir}/facial-analysis/${recordId}/source/face.capture.webm`;
    const initialized = await ipcClient.saveFile({ filePath: outputPath, content: new Uint8Array(), ensureDir: true });
    if (!isCurrent() || facialBrowserPreviewRef.current !== preview) return false;
    if (facialBrowserRecordingRef.current) return facialBrowserRecordingRef.current.recordId === recordId;
    if (!initialized.ok) {
      setFacialCaptureNotice(('error' in initialized && initialized.error) || '无法创建表情视频文件');
      return false;
    }

    try {
      const recorder = mimeType
        ? new MediaRecorder(preview.stream, { mimeType, videoBitsPerSecond: 2_500_000 })
        : new MediaRecorder(preview.stream, { videoBitsPerSecond: 2_500_000 });
      const settings = preview.settings;
      const recording = {
        recorder,
        recordId,
        projectDir: activeDataDir,
        outputPath,
        startedAtMs: Date.now(),
        startedMonoMs: performance.now(),
        writeChain: Promise.resolve(),
        writeError: '',
        acceptSamples: true,
        samples: [] as string[],
        sampleCount: 0,
        width: Number(settings.width || facialSettings.width),
        height: Number(settings.height || facialSettings.height),
        fps: Number(settings.frameRate || facialSettings.fps),
      };
      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size <= 0) return;
        recording.writeChain = recording.writeChain.then(async () => {
          const chunk = new Uint8Array(await event.data.arrayBuffer());
          const saved = await ipcClient.appendFile({ filePath: outputPath, content: chunk });
          if (!saved.ok) throw new Error(('error' in saved && saved.error) || '表情视频分片写入失败');
        }).catch((error) => {
          recording.writeError = error instanceof Error ? error.message : String(error);
        });
      };
      recorder.onerror = (event) => {
        recording.writeError = (event as Event & { error?: Error }).error?.message || '浏览器表情录制失败';
      };
      recorder.start(1000);
      facialBrowserRecordingRef.current = recording;
      setIsFacialCapturing(true);
      facialAutoCaptureRecordIdRef.current = recordId;
      facialAutoCaptureActiveRef.current = true;
      setFacialCaptureNotice('');
      return true;
    } catch (error) {
      setFacialCaptureNotice(error instanceof Error ? error.message : '启动浏览器表情录制失败');
      return false;
    }
  }, [activeDataDir, facialSessionStatus?.inferenceReady, facialSettings.fps, facialSettings.height, facialSettings.width]);

  const validateFacialCaptureReady = useCallback(async (): Promise<{ ok: boolean; message?: string }> => {
    const preview = facialBrowserPreviewRef.current;
    if (!preview) return { ok: false, message: '表情摄像头未启动' };
    if (!facialSessionStatus?.inferenceReady) return { ok: false, message: '表情检测引擎未就绪' };
    const track = preview.stream.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') return { ok: false, message: '表情摄像头轨道已中断' };
    return { ok: true };
  }, [facialSessionStatus?.inferenceReady]);

  const stopFacialAutoCapture = useCallback(async (): Promise<{ ok: boolean; message?: string }> => {
    const recording = facialBrowserRecordingRef.current;
    if (!recording) {
      facialAutoCaptureActiveRef.current = false;
      setIsFacialCapturing(false);
      return { ok: true };
    }
    facialAutoCaptureActiveRef.current = false;
    recording.acceptSamples = false;
    try {
      if (recording.recorder.state !== 'inactive') {
        await new Promise<void>((resolve, reject) => {
          recording.recorder.addEventListener('stop', () => resolve(), { once: true });
          recording.recorder.addEventListener('error', () => reject(new Error(recording.writeError || '浏览器表情录制停止失败')), { once: true });
          try {
            recording.recorder.requestData();
            recording.recorder.stop();
          } catch (error) {
            reject(error);
          }
        });
      }
      await recording.writeChain;
      if (recording.writeError) throw new Error(recording.writeError);

      const finalizedVideo = await ipcClient.finalizeFacialBrowserVideo({
        projectDir: recording.projectDir,
        recordId: recording.recordId,
      });
      if (!finalizedVideo.ok || !finalizedVideo.path) {
        throw new Error(finalizedVideo.message || '表情视频收尾失败');
      }

      const durationMs = Math.max(0, Date.now() - recording.startedAtMs);
      const frameCount = Math.max(0, Math.round(durationMs / 1000 * recording.fps));
      const manifestDir = `${recording.projectDir}/facial-analysis/${recording.recordId}`;
      const samplesSave = await ipcClient.saveFile({
        filePath: `${manifestDir}/samples.jsonl`,
        content: recording.samples.length > 0 ? `${recording.samples.join('\n')}\n` : '',
        ensureDir: true,
      });
      if (!samplesSave.ok) throw new Error(('error' in samplesSave && samplesSave.error) || '表情推理样本保存失败');
      const manifestSave = await ipcClient.saveFile({
        filePath: `${manifestDir}/facial-video.json`,
        content: JSON.stringify({
          schemaVersion: 1,
          recordId: recording.recordId,
          recordName: recording.recordId,
          videoPath: 'source/face.mp4',
          createdAt: new Date(recording.startedAtMs).toISOString(),
          capture: {
            owner: 'renderer',
            width: recording.width,
            height: recording.height,
            fps: recording.fps,
            measuredFps: recording.fps,
            frameCount,
            durationMs,
            finalDurationMs: durationMs,
            finalFrameCount: frameCount,
            finalFps: recording.fps,
            timingCorrectionApplied: false,
            timestampClock: 'renderer-performance',
            sampleCount: recording.sampleCount,
            container: 'mp4',
            sourceCaptureFormat: 'webm',
            finalization: 'ffmpeg-h264-faststart',
          },
          quality: {
            status: recording.sampleCount > 0 ? 'ok' : 'warning',
            capturedFrames: frameCount,
            sampleCount: recording.sampleCount,
            warnings: recording.sampleCount > 0 ? [] : ['NO_INFERENCE_SAMPLES'],
          },
        }, null, 2),
        ensureDir: true,
      });
      if (!manifestSave.ok) throw new Error(('error' in manifestSave && manifestSave.error) || '表情记录清单保存失败');
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : '表情视频保存失败';
      setFacialCaptureNotice(message);
      return { ok: false, message };
    } finally {
      if (facialBrowserRecordingRef.current === recording) facialBrowserRecordingRef.current = null;
      setIsFacialCapturing(false);
      facialAutoCaptureRecordIdRef.current = null;
    }
  }, []);

  // ---- 表情预览流：Chromium 独占摄像头，Python 只处理抽样帧 ----
  const startFacialPreview = useCallback((cameraIndex: number): Promise<boolean> => {
    if (facialPreviewStartPromiseRef.current) return facialPreviewStartPromiseRef.current;

    const startPromise = (async () => {
      const previewGeneration = facialPreviewGenerationRef.current + 1;
      facialPreviewGenerationRef.current = previewGeneration;
      if (facialPreviewStopPromiseRef.current) await facialPreviewStopPromiseRef.current;
      const camera = facialCameras.find((item) => item.index === cameraIndex);
      if (!camera) {
        setFacialCaptureNotice('已选择的表情摄像头不可用，请刷新后重新选择');
        return false;
      }
      const connected = await ensureFacialServerAndConnect();
      if (!connected) return false;

      const inferenceStart = await sendCmdWithResponse({
        wsCmdRef: facialWsCmdRef,
        id: 'start_preview',
        args: { owner: 'renderer' },
        timeoutMs: 12000,
      });
      if (!inferenceStart.ok) {
        setFacialCaptureNotice(inferenceStart.error || '表情推理引擎启动失败');
        return false;
      }

      facialBrowserPreviewRef.current?.stop();
      facialBrowserPreviewRef.current = null;
      setFacialPreviewStream(null);
      let lastInferenceErrorAt = 0;
      try {
        const combinedSafeProfile = activeDeviceType === '眼镜式' && hasEyeTrackingModality;
        const captureWidth = combinedSafeProfile ? Math.min(640, facialSettings.width) : facialSettings.width;
        const captureHeight = combinedSafeProfile ? Math.min(480, facialSettings.height) : facialSettings.height;
        const captureFps = combinedSafeProfile ? Math.min(15, facialSettings.fps) : facialSettings.fps;
        const inferenceFps = combinedSafeProfile ? 5 : 8;
        const inferenceWidth = combinedSafeProfile ? 360 : 480;
        void ipcClient.videoDebugLog({
          event: 'facial:renderer-get-user-media-begin',
          details: {
            cameraId: camera.id,
            cameraName: camera.name,
            combinedSafeProfile,
            captureWidth,
            captureHeight,
            captureFps,
            inferenceFps,
            inferenceWidth,
          },
        });
        const controller = await startBrowserFacialPreview({
          deviceId: camera.id,
          width: captureWidth,
          height: captureHeight,
          fps: captureFps,
          inferenceFps,
          inferenceWidth,
          onSample: async (sample) => {
            const result = await sendCmdWithResponse({
              wsCmdRef: facialWsCmdRef,
              id: 'infer_frame',
              args: {
                data_url: sample.dataUrl,
                captured_at_ms: sample.capturedAtMs,
                sequence: sample.sequence,
              },
              timeoutMs: 5000,
            });
            if (facialPreviewGenerationRef.current !== previewGeneration) return;
            if (!result.ok) throw new Error(result.error || '表情单帧推理失败');
            const response = result.response || {};
            setFacialFaceBox(response.faceBox && typeof response.faceBox === 'object'
              ? response.faceBox as { x: number; y: number; w: number; h: number }
              : null);
            setFacialLandmarks(Array.isArray(response.landmarks)
              ? response.landmarks as Array<{ x: number; y: number }>
              : []);
            setFacialExpression(typeof response.expression === 'string' ? response.expression : null);
            setFacialEmotionScores(response.emotionScores && typeof response.emotionScores === 'object'
              ? response.emotionScores as Record<string, number>
              : {});
            const recording = facialBrowserRecordingRef.current;
            if (recording?.acceptSamples) {
              recording.sampleCount += 1;
              recording.samples.push(JSON.stringify({
                t: Math.max(0, Math.round(sample.capturedAtMs - recording.startedMonoMs)),
                frameIndex: recording.sampleCount,
                faceBox: response.faceBox || null,
                landmarks: Array.isArray(response.landmarks) ? response.landmarks : [],
                expressions: response.expressions && typeof response.expressions === 'object' ? response.expressions : {},
                emotion: typeof response.expression === 'string' ? response.expression : null,
                emotionScore: Number(response.emotionScore || 0),
                emotionScores: response.emotionScores && typeof response.emotionScores === 'object' ? response.emotionScores : {},
              }));
            }
          },
          onError: (error) => {
            const now = Date.now();
            if (now - lastInferenceErrorAt < 5000) return;
            lastInferenceErrorAt = now;
            setFacialCaptureNotice(error.message);
            void ipcClient.videoDebugLog({
              event: 'facial:renderer-frame-inference-error',
              details: { message: error.message },
            });
          },
        });
        facialBrowserPreviewRef.current = controller;
        setFacialPreviewStream(controller.stream);
        setFacialPreviewDataUrl(null);
        setFacialSessionStatus({
          running: true,
          inferenceReady: true,
          actual: {
            width: Number(controller.settings.width || facialSettings.width),
            height: Number(controller.settings.height || facialSettings.height),
            fps: Number(controller.settings.frameRate || facialSettings.fps),
          },
        });
        setFacialCaptureNotice('');
        void ipcClient.videoDebugLog({
          event: 'facial:renderer-preview-started',
          details: {
            cameraId: camera.id,
            cameraName: camera.name,
            settings: controller.settings,
            inferenceFps,
            inferenceWidth,
            combinedSafeProfile,
            cameraOwnedBy: 'renderer',
          },
        });
        return true;
      } catch (error) {
        await sendCmdWithResponse({
          wsCmdRef: facialWsCmdRef,
          id: 'stop_preview',
          args: {},
          timeoutMs: 5000,
        });
        const message = error instanceof Error ? error.message : '打开表情摄像头失败';
        setFacialCaptureNotice(message);
        void ipcClient.videoDebugLog({
          event: 'facial:renderer-preview-start-failed',
          details: { cameraId: camera.id, message },
        });
        return false;
      }
    })();

    facialPreviewStartPromiseRef.current = startPromise;
    const clearStartPromise = () => {
      if (facialPreviewStartPromiseRef.current === startPromise) {
        facialPreviewStartPromiseRef.current = null;
      }
    };
    void startPromise.then(clearStartPromise, clearStartPromise);
    return startPromise;
  }, [
    ensureFacialServerAndConnect,
    activeDeviceType,
    facialCameras,
    facialSettings.fps,
    facialSettings.height,
    facialSettings.width,
    hasEyeTrackingModality,
    setFacialPreviewStream,
  ]);

  const stopFacialPreview = useCallback((): Promise<void> => {
    if (facialPreviewStopPromiseRef.current) return facialPreviewStopPromiseRef.current;
    facialPreviewGenerationRef.current += 1;

    const stopPromise = (async () => {
      if (facialBrowserRecordingRef.current) {
        await stopFacialAutoCapture();
      }
      facialBrowserPreviewRef.current?.stop();
      facialBrowserPreviewRef.current = null;
      setFacialPreviewStream(null);
      if (facialImageWsRef.current) {
        try { facialImageWsRef.current.close(); } catch {}
        facialImageWsRef.current = null;
      }
      setFacialPreviewDataUrl(null);
      setFacialFaceBox(null);
      setFacialExpression(null);
      setFacialEmotionScores({});
      setFacialLandmarks([]);
      setFacialSessionStatus(null);

      const commandSocket = facialWsCmdRef.current;
      if (!commandSocket || commandSocket.readyState !== WebSocket.OPEN) return;
      const result = await sendCmdWithResponse({
        wsCmdRef: facialWsCmdRef,
        id: 'stop_preview',
        args: {},
        timeoutMs: 15000,
      });
      void ipcClient.videoDebugLog({
        event: 'facial:renderer-preview-stopped',
        details: { ok: result.ok, error: result.error || null, cameraOwnedBy: 'renderer' },
      });
      if (!result.ok && result.error) setFacialCaptureNotice(result.error);
    })();

    facialPreviewStopPromiseRef.current = stopPromise;
    const clearStopPromise = () => {
      if (facialPreviewStopPromiseRef.current === stopPromise) {
        facialPreviewStopPromiseRef.current = null;
      }
    };
    void stopPromise.then(clearStopPromise, clearStopPromise);
    return stopPromise;
  }, [setFacialPreviewStream, stopFacialAutoCapture]);

  // --- Calibration State ---
  const {
    calibrationState, setCalibrationState, isCalibrationTestMode, setIsCalibrationTestMode,
    isCalibrationStarting, setIsCalibrationStarting,
    isCalibrationTrackerReady, setIsCalibrationTrackerReady,
    calibrationStartingRef, calibrationTestStartingRef, glassesCalibrationMonitorLayoutRef, previousCalibrationStateRef,
    calibPointIndex, setCalibPointIndex, calibScale, setCalibScale,
    cardDetectedPoint, setCardDetectedPoint, cardCompletedPoints, setCardCompletedPoints,
    cardDetectionStatus, setCardDetectionStatus, cardDetectionMessage, setCardDetectionMessage,
    cardSubmittedPointRef, cardDetectionStatusRef, cardDetectionFrameRef, cardDetectionFrameEnabledRef,
  } = useCalibrationUiState();
  const calibrationTestMonitorLayoutRef = useRef<{
    layout: RecordingMonitorLayout;
    hiddenTileIds: MonitorTileId[];
  } | null>(null);
  const isSplitCalibrationTest = Boolean(recordingSettings.splitScreenMode) && isCalibrationTestMode;
  const showFullscreenCalibrationOverlay = useFullscreenCalibration && !isSplitCalibrationTest;
  useMainWindowOverlayMask(showFullscreenCalibrationOverlay && calibrationState !== 'none');

  useEffect(() => {
    if (isCalibrationTestMode) return;
    const previousMonitorLayout = calibrationTestMonitorLayoutRef.current;
    if (!previousMonitorLayout) return;
    calibrationTestMonitorLayoutRef.current = null;
    setRecordingMonitorLayout(previousMonitorLayout.layout);
    setHiddenRecordingMonitorTileIds(previousMonitorLayout.hiddenTileIds);
    setRecordingMonitorLayoutResetToken((value) => value + 1);
  }, [isCalibrationTestMode, setHiddenRecordingMonitorTileIds, setRecordingMonitorLayout, setRecordingMonitorLayoutResetToken]);

  useEffect(() => {
    const previousState = previousCalibrationStateRef.current;
    previousCalibrationStateRef.current = calibrationState;
    if (previousState !== 'calibrating' || calibrationState === 'calibrating') return;
    const savedLayout = glassesCalibrationMonitorLayoutRef.current;
    if (!savedLayout) return;
    glassesCalibrationMonitorLayoutRef.current = null;
    setRecordingMonitorLayout(savedLayout.layout);
    setHiddenRecordingMonitorTileIds(savedLayout.hiddenTileIds);
    setRecordingMonitorLayoutResetToken((value) => value + 1);
  }, [calibrationState]);
  const calibStateRef = useRef({
    arrIndex: 4,
    pointIndex: 1,
    timerId: null as number | null,
    safetyTimerId: null as number | null,
    points: 9,
    pointAttempt: 0,
    pointCancelling: false,
    sequenceOverride: undefined as number[] | undefined,
  });
  const simulateCalibrationRef = useRef<{
    active: boolean;
    sequence: number[];
    step: number;
  }>({
    active: false,
    sequence: [],
    step: -1,
  });
  const simulateCalibAnimTimerRef = useRef<number | null>(null);
  const calibrationFullscreenTimerRef = useRef<number | null>(null);
  const overlayActiveRef = useRef(false);

  const clearSimulateCalibAnim = useCallback(() => {
    if (simulateCalibAnimTimerRef.current !== null) {
      window.clearInterval(simulateCalibAnimTimerRef.current);
      simulateCalibAnimTimerRef.current = null;
    }
  }, []);

  const clearCalibrationFullscreenTimer = useCallback(() => {
    if (calibrationFullscreenTimerRef.current !== null) {
      window.clearTimeout(calibrationFullscreenTimerRef.current);
      calibrationFullscreenTimerRef.current = null;
    }
  }, []);

  const sendCmd = useCallback(
    (id: string, args: Record<string, unknown> = {}) => {
      if (simulateMode) return true;
      return sendCmdOverWs({ wsCmdRef, id, args });
    },
    [simulateMode],
  );

  const { processPoint, triggerCurrentPoint, advanceCalibration } = useMemo(() => {
    return createCalibrationController({
      calibStateRef,
      setCalibPointIndex,
      setCalibScale,
      sendCmd,
      calibIntervalMs: CALIB_INTERVAL_MS,
      calibPoints: CALIB_POINTS,
      calibrationMode: activeDeviceProfile.calibrationMode,
      onPointCommandRejected: () => {
        cardSubmittedPointRef.current = null;
        setCardDetectionStatus('error');
        setCardDetectionMessage('命令通道未连接，未提交当前校准点，请重试');
      },
      onPointTimeout: () => {
        cardSubmittedPointRef.current = null;
        setCardDetectionStatus('submitting');
        setCardDetectionMessage('当前校准点采集超时，正在继续下一个校准点');
      },
    });
  }, [sendCmd, activeDeviceProfile.calibrationMode]);
  const handleInlineCalibrationPoint = useCallback(
    (point: { x: number; y: number }) => {
      if (activeDeviceProfile.calibrationMode !== 'click') return;
      if (calibrationState !== 'calibrating') return;
      if (activeDeviceModel === 'PupilCore') return; // Pupil samples only the automatically detected card center.
      triggerCurrentPoint(point);
    },
    [activeDeviceModel, activeDeviceProfile.calibrationMode, calibrationState, triggerCurrentPoint],
  );
  const isCardCalibration = isCardCalibrationType(String(recordingSettings.calibrationType || ''));

  useEffect(() => {
    const enabled =
      isCardCalibration &&
      activeDeviceProfile.calibrationMode === 'click' &&
      calibrationState === 'calibrating' &&
      activeDeviceProfile.deviceType === '眼镜式';
    cardDetectionFrameEnabledRef.current = enabled;
    if (!enabled) {
      cardDetectionFrameRef.current = null;
    }
  }, [isCardCalibration, activeDeviceProfile.calibrationMode, activeDeviceProfile.deviceType, calibrationState]);

  useEffect(() => {
    cardDetectionStatusRef.current = cardDetectionStatus;
  }, [cardDetectionStatus]);

  const handleCardDetectionUpdate = useCallback((payload: {
    point: { x: number; y: number } | null;
    status: 'idle' | 'detecting' | 'ready' | 'submitting' | 'error';
    message: string;
  }) => {
    if (cardDetectionStatusRef.current === 'submitting' && payload.status !== 'submitting') {
      setCardDetectedPoint(payload.point);
      return;
    }
    setCardDetectedPoint(payload.point);
    setCardDetectionStatus(payload.status);
    setCardDetectionMessage(payload.message);
  }, []);

  const handleCardCalibrationTrigger = useCallback(() => {
    if (!isCardCalibration || calibrationState !== 'calibrating' || !cardDetectedPoint ||
        (activeDeviceModel === 'PupilCore' && (!isCalibrationTrackerReady || cardDetectionStatusRef.current !== 'ready'))) {
      void ipcClient.videoDebugLog({
        event: 'card-detection:submit-ignored',
        details: {
          isCardCalibration,
          calibrationState,
          cardDetectedPoint,
          cardDetectionStatus: cardDetectionStatusRef.current,
          deviceType: activeDeviceProfile.deviceType,
          calibrationMode: activeDeviceProfile.calibrationMode,
        },
      });
      return;
    }
    if (calibStateRef.current.pointPending || calibStateRef.current.pointCancelling) {
      setCardDetectionStatus('submitting');
      setCardDetectionMessage(
        calibStateRef.current.pointCancelling
          ? '正在取消左右眼当前任务，请稍候…'
          : '当前校准点已提交，正在等待左右眼完成…',
      );
      void ipcClient.videoDebugLog({
        event: 'card-detection:submit-ignored',
        details: {
          reason: calibStateRef.current.pointCancelling ? 'point-cancelling' : 'point-pending',
          pointIndex: calibStateRef.current.pointIndex,
          arrayIndex: calibStateRef.current.arrIndex,
        },
      });
      return;
    }
    const providerFrame = cardDetectionFrameRef.current;
    void ipcClient.videoDebugLog({
      event: 'card-detection:submit',
      details: {
        point: cardDetectedPoint,
        status: cardDetectionStatusRef.current,
        calibrationPointIndex: calibStateRef.current.pointIndex,
        calibrationArrayIndex: calibStateRef.current.arrIndex,
        videoPreviewMode,
        videoPreviewFrameSize,
        providerFrame: providerFrame
          ? {
              source: providerFrame.source,
              width: providerFrame.width,
              height: providerFrame.height,
              sourceFrameWidth: providerFrame.sourceFrameWidth,
              sourceFrameHeight: providerFrame.sourceFrameHeight,
              ageMs: Date.now() - providerFrame.updatedAt,
              sequence: providerFrame.sequence,
            }
          : null,
        deviceType: activeDeviceProfile.deviceType,
        calibrationMode: activeDeviceProfile.calibrationMode,
      },
    });
    cardSubmittedPointRef.current = cardDetectedPoint;
    setCardDetectionStatus('submitting');
    setCardDetectionMessage('正在校准当前点…');
    triggerCurrentPoint(cardDetectedPoint);
  }, [
    isCardCalibration,
    calibrationState,
    cardDetectedPoint,
    triggerCurrentPoint,
    activeDeviceProfile.deviceType,
    activeDeviceProfile.calibrationMode,
    videoPreviewMode,
    videoPreviewFrameSize,
    recordingSettings.calibrationType,
    activeDeviceModel,
    isCalibrationTrackerReady,
  ]);

  const closeEncodedVideoPreview = useCallback(() => {
    try {
      encodedVideoPreviewRef.current?.close();
    } catch {}
    encodedVideoPreviewRef.current = null;
  }, []);

  const handleVideoPreviewFrameSize = useCallback((size: { width: number; height: number } | null) => {
    setVideoPreviewFrameSize((prev) => {
      if (!size) {
        return prev === null ? prev : null;
      }
      if (prev && prev.width === size.width && prev.height === size.height) {
        return prev;
      }
      return size;
    });
  }, []);

  // The glasses SDK's live scene preview feeds H.265 packets into the vendor
  // H265Decode.dll. In combined acquisition that native decode path can hang
  // the Windows host while Chromium is also capturing the facial camera.
  // Keep eye data and raw stream recording, but suspend live glasses decoding.
  // 眼镜式下眼动/表情采集互斥（vendor SDK 多摄像头死锁），故「组合模式」要求
  // 眼动与表情 tile 同时可见——互斥保证这一点永不成立，组合模式随之关闭。
  const shouldUseCombinedImagePreview = useMemo(
    () => activeDeviceModel === 'aSeeGlassesPlus' && activeDeviceProfile.deviceType === '眼镜式'
      && hasFacialExpressionModality
      && hasEyeTrackingModality
      && !isFixedRemoteEyeMonitor
      && !hiddenRecordingMonitorTileIds.includes('facial')
      && !hiddenRecordingMonitorTileIds.includes('device'),
    [activeDeviceModel, activeDeviceProfile.deviceType, hasFacialExpressionModality, hasEyeTrackingModality, isFixedRemoteEyeMonitor, hiddenRecordingMonitorTileIds],
  );

  // Attribute every flip of the combined-preview gate to the exact state that
  // changed underneath it, so a re-opened glasses scene stream is traceable.
  const shouldUseCombinedImagePreviewPrevRef = useRef<boolean | null>(null);
  useEffect(() => {
    const prev = shouldUseCombinedImagePreviewPrevRef.current;
    shouldUseCombinedImagePreviewPrevRef.current = shouldUseCombinedImagePreview;
    if (prev === null || prev === shouldUseCombinedImagePreview) return;
    void ipcClient.videoDebugLog({
      event: 'preview:combined-image-preview-flip',
      details: {
        from: prev,
        to: shouldUseCombinedImagePreview,
        deviceType: activeDeviceProfile.deviceType,
        hasFacialExpressionModality,
        isFixedRemoteEyeMonitor,
        recordingViewMode: recordingSettings.recordingViewMode ?? null,
        hiddenRecordingMonitorTileIds: [...hiddenRecordingMonitorTileIds],
      },
    });
  }, [
    shouldUseCombinedImagePreview,
    activeDeviceProfile.deviceType,
    hasFacialExpressionModality,
    isFixedRemoteEyeMonitor,
    recordingSettings.recordingViewMode,
    hiddenRecordingMonitorTileIds,
  ]);

  const connectFallbackImageWebSocket = useCallback(() => {
    setVideoPreviewMode('image');
    setVideoPreviewFrameSize(null);
    // #region debug-point transport-image-preview-selected
    void ipcClient.videoDebugLog({
      event: 'preview:transport-selected',
      details: {
        mode: 'image',
        deviceType: activeDeviceProfile.deviceType,
        combinedMode: shouldUseCombinedImagePreview,
        hasFacialExpressionModality,
      },
    });
    // #endregion debug-point transport-image-preview-selected
    connectImageWebSocket({ wsIp, wsImagePort, setWsConnected, wsImageRef, imageCanvasRef, setLastImageAt });
  }, [activeDeviceProfile.deviceType, hasFacialExpressionModality, shouldUseCombinedImagePreview, wsIp, wsImagePort]);

  const connectWebSocket = useCallback((reason = 'connection-maintenance') => {
    if (!deviceConnectionRequestedRef.current) return;
    void ipcClient.videoDebugLog({ event: 'preview:connect-request', details: { reason, hadEncodedPreview: Boolean(encodedVideoPreviewRef.current), imageSocketState: wsImageRef.current?.readyState, deviceType: activeDeviceProfile.deviceType } });
    closeEncodedVideoPreview();
    closeWebSocketRef(wsImageRef);
    setLastImageAt(null);
    setVideoPreviewStatus(null);
    setVideoPreviewFrameSize(null);

    if (shouldUseCombinedImagePreview) {
      setVideoPreviewMode('image');
      setWsConnected(true);
      void ipcClient.videoDebugLog({
        event: 'preview:transport-selected',
        details: {
          mode: 'suspended',
          reason: 'combined-mode-native-h265-decode-safety',
          deviceType: activeDeviceProfile.deviceType,
          hasFacialExpressionModality,
        },
      });
      return;
    }

    if (activeDeviceProfile.deviceType !== '眼镜式') {
      connectFallbackImageWebSocket();
      return;
    }

    if (['PupilCore', 'HH_ET28'].includes(activeDeviceModel) || webCodecsImageFallbackRef.current) {
      if (['PupilCore', 'HH_ET28'].includes(activeDeviceModel)) webCodecsImageFallbackRef.current = true;
      connectFallbackImageWebSocket();
      return;
    }

    let failureReported = false;
    const reportWebCodecsFailure = (reason?: string) => {
      if (failureReported) return;
      failureReported = true;
      const message = reason || 'WebCodecs preview failed';
      console.warn('[MrtApp] WebCodecs preview unavailable:', message);
      void ipcClient.videoDebugLog({
        event: 'webcodecs:preview-fallback',
        details: { reason: message },
      });
      webCodecsImageFallbackRef.current = true;
      encodedVideoPreviewRef.current = null;
      setWsConnected(false);
      setLastImageAt(null);
      setVideoPreviewMode('image');
      setVideoPreviewStatus({ mode: 'image', status: 'fallback', error: message });
      setVideoPreviewFrameSize(null);
      // Let the failed controller finish its own cleanup before attaching the
      // fallback socket to the same SDK image port.
      window.setTimeout(() => {
        if (webCodecsImageFallbackRef.current) {
          closeEncodedVideoPreview();
          closeWebSocketRef(wsImageRef);
          connectFallbackImageWebSocket();
        }
      }, 0);
    };

    const controller = connectEncodedVideoWebSocket({
      wsIp,
      wsImagePort,
      setWsConnected,
      canvasRef: videoPreviewCanvasRef,
      setLastImageAt,
      onStatus: (status) => {
        setVideoPreviewStatus(status);
        if (status.status !== 'frame') {
          console.log('[MrtApp] WebCodecs preview status:', status);
          void ipcClient.videoDebugLog({
            event: 'webcodecs:preview-status',
            details: status,
          });
        }
      },
      onFrameSize: handleVideoPreviewFrameSize,
      cardDetectionFrameRef,
      isCardDetectionFrameEnabled: () => cardDetectionFrameEnabledRef.current,
      cardDetectionFrameIntervalMs: 90,
      cardDetectionFrameMaxWidth: CARD_DETECTION_CAPTURE_MAX_WIDTH,
      onFallback: (reason) => {
        reportWebCodecsFailure(reason);
      },
    });
    if (!controller) {
      reportWebCodecsFailure('WebCodecs preview controller unavailable');
      return;
    }
    encodedVideoPreviewRef.current = controller;
    setVideoPreviewMode('webcodecs');
  }, [
    activeDeviceProfile.deviceType,
    activeDeviceModel,
    closeEncodedVideoPreview,
    connectFallbackImageWebSocket,
    handleVideoPreviewFrameSize,
    shouldUseCombinedImagePreview,
    wsImagePort,
    wsIp,
  ]);

  const connectEyeWs = useCallback(() => {
    connectEyeWebSocket({ wsIp, wsEyePort, wsEyeRef, setEyeData });
  }, [wsIp, wsEyePort]);

  const connectCmdWs = useCallback(() => {
    connectCmdWebSocket({
      wsIp,
      wsCmdPort,
      wsCmdRef,
      deviceModel: activeDeviceModel,
      calibrationMode: activeDeviceProfile.calibrationMode,
      setCalibrationState,
      setCalibScale,
      setCalibrationCoe,
      setCalibrationScores,
      onTrackingCoeActivated: (coe) => {
        activeTrackingCoeRef.current = String(coe || '').trim() || null;
      },
      onDeviceError: (message) => {
        deviceConnectionRequestedRef.current = false;
        activeTrackingCoeRef.current = null;
        setIsCameraOn(false);
        setLastImageAt(null);
        setCalibrationCoe(null);
        setCalibrationScores(null);
        setCalibrationState('none');
        showNotice(`Pupil Core：${message}`);
      },
      onRecordingFinalized: (result) => {
        if (!recordingFinalizationHandlingRef.current) {
          // A backend error may arrive before the start ACK. The effect below
          // waits for confirmation and checks the resulting recording identity.
          setRecordingFinalizationResult(result);
        }
      },
      onCalibrationTrackerReady: setIsCalibrationTrackerReady,
      onCalibrationPointFinished: (pointIndex) => {
        const completedPoint = cardSubmittedPointRef.current;
        if (!completedPoint) return;
        setCardCompletedPoints((prev) => [...prev, completedPoint]);
        cardSubmittedPointRef.current = null;
        if (pointIndex >= Number(calibStateRef.current.points || 0)) {
          setCardDetectionStatus('submitting');
          setCardDetectionMessage('正在计算校准结果…');
        } else {
          setCardDetectionStatus('idle');
          const nextPointIndex = pointIndex + 1;
          setCardDetectionMessage(
            Number(calibStateRef.current.points || 0) === 3
              ? `第${nextPointIndex}点：请移动卡片后再次确认`
              : '',
          );
        }
      },
      onCalibrationPointProgress: ({ error, message }) => {
        if (error === -2) {
          setCardDetectionStatus('error');
          setCardDetectionMessage('当前校准点已取消，请重新点击校准');
          return;
        }
        if (error !== null && error !== 0) {
          setCardDetectionStatus('error');
          setCardDetectionMessage(message || `当前校准点返回错误 ${error}，请重新点击校准`);
          return;
        }
        // Per-eye completion remains available in the debug log. Avoid exposing
        // transient SDK callback details as a user-facing calibration status.
      },
      calibStateRef,
      processPoint,
      advanceCalibration,
    });
  }, [wsIp, wsCmdPort, activeDeviceModel, activeDeviceProfile.calibrationMode, processPoint, advanceCalibration, showNotice]);

  const ensureCmdWsReady = useCallback(
    async (timeoutMs: number): Promise<boolean> => {
      const isOpen = () => {
        const ws = wsCmdRef.current;
        return !!ws && ws.readyState === WebSocket.OPEN;
      };
      if (isOpen()) return true;

      const current = wsCmdRef.current;
      const isConnecting = !!current && current.readyState === WebSocket.CONNECTING;
      if (!isConnecting) {
        connectCmdWs();
      }

      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        if (isOpen()) return true;
        await new Promise((resolve) => window.setTimeout(resolve, 80));
      }
      return isOpen();
    },
    [connectCmdWs],
  );

  // When the command channel is down, attempt one explicit service restart +
  // reconnect before giving up. The eye-tracking service is launched once at app
  // startup and (on crash) may need a nudge; restarting also clears a hung SDK
  // (dongle) lock that can otherwise wedge the whole service.
  const ensureCmdWsReadyWithRecovery = useCallback(
    async (timeoutMs: number): Promise<boolean> => {
      if (await ensureCmdWsReady(timeoutMs)) return true;
      if (!ipcClient.isAvailable()) return false;
      try {
        await ipcClient.restartPyServer();
      } catch (error) {
        console.warn('[MrtApp] restart-py-server failed:', error);
        return false;
      }
      // Wait for the restarted service to bind its ports, then retry once.
      return ensureCmdWsReady(15000);
    },
    [ensureCmdWsReady],
  );

  const disconnectWebSocket = useCallback(() => {
    closeEncodedVideoPreview();
    closeWebSocketRef(wsImageRef);
    webCodecsImageFallbackRef.current = false;
    setWsConnected(false);
    setVideoPreviewMode('image');
    setVideoPreviewStatus(null);
    setVideoPreviewFrameSize(null);
  }, [closeEncodedVideoPreview]);

  const toggleScreenRecorder = useCallback(() => {
    if (wsConnected) {
      disconnectWebSocket();
    } else {
      connectWebSocket();
    }
  }, [wsConnected, disconnectWebSocket, connectWebSocket]);

  const resetDeviceUiState = useCallback(() => {
    deviceConnectionRequestedRef.current = false;
    clearSimulateCalibAnim();
    clearCalibrationFullscreenTimer();
    if (calibStateRef.current.timerId) {
      clearTimeout(calibStateRef.current.timerId);
      calibStateRef.current.timerId = null;
    }
    if (calibStateRef.current.safetyTimerId) {
      clearTimeout(calibStateRef.current.safetyTimerId);
      calibStateRef.current.safetyTimerId = null;
    }
    simulateCalibrationRef.current = { active: false, sequence: [], step: -1 };
    setCalibrationState('none');
    setIsCalibrationTestMode(false);
    setCalibScale(1.0);
    playbackOrderRef.current = null;
    playbackSequenceRef.current = null;
    recordingLifecycle.reset();
    setIsRecordingCaptureReady(false);
    setPlaybackIndex(null);
    setIsCameraOn(false);
    setIsPreviewing(false);
    setEyeData(createEmptyEyeData());
    setLastImageAt(null);
    webCodecsImageFallbackRef.current = false;
    closeEncodedVideoPreview();
    closeWebSocketRef(wsImageRef);
    closeWebSocketRef(wsEyeRef);
    closeWebSocketRef(wsCmdRef);
    if (imageCanvasRef.current) {
      imageCanvasRef.current.src = '';
    }
    if (videoPreviewCanvasRef.current) {
      const ctx = videoPreviewCanvasRef.current.getContext('2d');
      ctx?.clearRect(0, 0, videoPreviewCanvasRef.current.width, videoPreviewCanvasRef.current.height);
    }
    setWsConnected(false);
    setVideoPreviewMode('image');
    setVideoPreviewStatus(null);
    setVideoPreviewFrameSize(null);
    // 表情模块清理
    if (facialWsCmdRef.current && facialWsCmdRef.current.readyState === WebSocket.OPEN) {
      try { facialWsCmdRef.current.send(JSON.stringify({ type: 'req_cmd', id: 'stop_preview', args: {} })); } catch {}
    }
    if (facialImageWsRef.current) {
      try { facialImageWsRef.current.close(); } catch {}
      facialImageWsRef.current = null;
    }
    void stopFacialAutoCapture();
    facialBrowserPreviewRef.current?.stop();
    facialBrowserPreviewRef.current = null;
    setFacialPreviewStream(null);
    closeWebSocketRef(facialWsCmdRef);
    setFacialPreviewDataUrl(null);
    setFacialFaceBox(null);
    setFacialExpression(null);
    setIsFacialCapturing(false);
    facialAutoCaptureActiveRef.current = false;
    facialAutoCaptureRecordIdRef.current = null;
  }, [clearSimulateCalibAnim, clearCalibrationFullscreenTimer, closeEncodedVideoPreview, recordingLifecycle.reset, setFacialPreviewStream, stopFacialAutoCapture]);

  const exitRecordingFullscreen = useCallback(async () => {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
      }
    }

    if (ipcClient.isAvailable()) {
      try {
        await ipcClient.setWindowFullScreen({ fullscreen: false });
      } catch {
      }
    }
  }, []);

  const enterCalibrationFullscreen = useCallback(() => {
    clearCalibrationFullscreenTimer();
    calibrationFullscreenTimerRef.current = window.setTimeout(() => {
      calibrationFullscreenTimerRef.current = null;
      if (ipcClient.isAvailable()) {
        void ipcClient.setWindowFullScreen({ fullscreen: true });
      }
      if (!document.fullscreenElement) {
        void document.documentElement.requestFullscreen().catch(() => {});
      }
    }, 0);
  }, [clearCalibrationFullscreenTimer]);

  const sendCmdThroughTransientSocket = useCallback(
    async (id: 'stop' | 'stop_recording', timeoutMs: number): Promise<boolean> => {
      try { await finishRecordingCommunication(); }
      catch (error) { console.error('[recording] communication stop failed:', error); return false; }
      const endpoint = `ws://${wsIp}:${wsCmdPort}/`;
      return new Promise<boolean>((resolve) => {
        let settled = false;
        let timerId: number | null = null;
        let transientWs: WebSocket | null = null;

        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          if (timerId !== null) {
            window.clearTimeout(timerId);
            timerId = null;
          }
          if (transientWs) {
            try {
              transientWs.close();
            } catch {
            }
          }
          resolve(ok);
        };

        try {
          transientWs = new WebSocket(endpoint);
        } catch (error) {
          console.warn(`[MrtApp] transient WS init failed (${id}):`, error);
          finish(false);
          return;
        }

        transientWs.onopen = () => {
          try {
            transientWs?.send(JSON.stringify({ type: 'req_cmd', id, args: {} }));
          } catch (error) {
            console.warn(`[MrtApp] transient WS send failed (${id}):`, error);
            finish(false);
          }
        };

        transientWs.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg?.type !== 'rsp_cmd' || msg?.id !== id) return;
            finish(msg?.error === 0);
          } catch {
          }
        };

        transientWs.onerror = () => {
          finish(false);
        };

        transientWs.onclose = () => {
          if (!settled) {
            finish(false);
          }
        };

        timerId = window.setTimeout(() => {
          console.warn(`[MrtApp] transient WS timeout (${id})`);
          finish(false);
        }, Math.max(300, timeoutMs));
      });
    },
    [wsCmdPort, wsIp],
  );

  const stopDeviceGracefully = useCallback(
    async (reason: string, timeoutMs = 2000) => {
      deviceConnectionRequestedRef.current = false;
      deviceConnectionGenerationRef.current += 1;
      const audioStopPromise =
        isRecording && reason !== 'recording-finalized'
          ? stopActiveAudioCapture()
          : stopActiveAudioRecording();
      const hasActiveDeviceState = isCameraOn || isRecording;
      const shouldForceShutdown = reason === 'app-close';
      const shouldEnsureStop =
        reason === 'navigate-away' ||
        reason === 'recording-complete' ||
        reason === 'recording-confirm' ||
        shouldForceShutdown;

      if (!simulateMode && (hasActiveDeviceState || shouldEnsureStop)) {
        const cmdWs = wsCmdRef.current;
        let stopSucceeded = false;
        let stopRecordingSucceeded = false;
        let recordingFinalizationDeferred = false;
        if (cmdWs && cmdWs.readyState === WebSocket.OPEN) {
          try {
            const stopRecordingRsp = await sendCmdWithResponse({
              wsCmdRef,
              id: 'stop_recording',
              args: {},
              timeoutMs: Math.min(1200, timeoutMs),
            });
            if (!stopRecordingRsp.ok) {
              console.warn(`[MrtApp] stop_recording failed (${reason}):`, stopRecordingRsp.error || 'unknown');
            } else {
              stopRecordingSucceeded = true;
              recordingFinalizationDeferred =
                !shouldForceShutdown && stopRecordingRsp.response?.status === 'finalizing';
            }
          } catch {
          }
          if (!recordingFinalizationDeferred) {
            try {
              const stopRsp = await stopDeviceCommand({ wsCmdRef, timeoutMs });
              if (!stopRsp.ok) {
                console.warn(`[MrtApp] stopDeviceCommand failed (${reason}):`, stopRsp.error || 'unknown');
              } else {
                stopSucceeded = true;
              }
            } catch (error) {
              console.error(`[MrtApp] stopDeviceCommand exception (${reason}):`, error);
            }
          }
        } else {
          console.warn(`[MrtApp] Command WebSocket is not ready while stopping device (${reason})`);
        }

        if (recordingFinalizationDeferred) {
          recordingFinalizingProjectDirRef.current = activeDataDir || null;
          const operationId = recordingLifecycle.state.operationId;
          if (operationId) {
            recordingLifecycle.requestStop(operationId);
            recordingLifecycle.acceptStop(operationId);
          }
          setIsRecordingCaptureReady(false);
          await audioStopPromise;
          await exitRecordingFullscreen();
          return;
        }

        if (!stopSucceeded) {
          const stopRecordingFallbackOk = stopRecordingSucceeded
            ? true
            : await sendCmdThroughTransientSocket('stop_recording', Math.min(1200, timeoutMs));
          if (!stopRecordingFallbackOk) {
            console.warn(`[MrtApp] transient stop_recording failed (${reason})`);
          }
          const stopFallbackOk = await sendCmdThroughTransientSocket('stop', timeoutMs);
          if (!stopFallbackOk) {
            console.warn(`[MrtApp] transient stop failed (${reason})`);
          }
        }
      }

      const audioStopResult = await audioStopPromise;
      if (!audioStopResult.ok) {
        console.error(`[MrtApp] audio recording finalize failed (${reason}):`, audioStopResult.message);
      }
      resetDeviceUiState();
      if (ipcClient.isAvailable()) {
        void ipcClient.closeRecordingWindow();
      }
      await exitRecordingFullscreen();
    },
    [activeDataDir, exitRecordingFullscreen, isCameraOn, isRecording, resetDeviceUiState, sendCmdThroughTransientSocket, simulateMode, recordingLifecycle.state.operationId, recordingLifecycle.requestStop, recordingLifecycle.acceptStop],
  );

  const stopDeviceBeforeNavigate = useCallback(async () => {
    deviceConnectionRequestedRef.current = false;
    deviceConnectionGenerationRef.current += 1;
    setIsCameraOn(false);
    if (isRecordingFinalizing) {
      showNotice(
        isEn ? 'The recording is still being saved. The save process will continue in the background.' : '录制文件仍在保存中，保存过程将在后台继续。',
        isEn ? 'Saving recording' : '正在保存录制',
      );
      return;
    }
    // Block navigation until shutdown finishes, so returning cannot race the
    // previous page's stop command or reuse its stream.
    await stopDeviceGracefully('navigate-away', 1600);
  }, [isRecordingFinalizing, isEn, showNotice, stopDeviceGracefully]);

  const prepareDataScopeSwitch = useCallback(async () => {
    if (isRecordingFinalizing) {
      showNotice(
        isEn ? 'Please wait for the current recording to finish saving before switching projects.' : '请等待当前录制保存完成后再切换工程。',
        isEn ? 'Saving recording' : '正在保存录制',
      );
      return;
    }
    if (
      currentView !== 'detail' &&
      !isCameraOn &&
      !isRecording &&
      !isPreviewing &&
      calibrationState === 'none' &&
      !wsImageRef.current &&
      !encodedVideoPreviewRef.current &&
      !wsCmdRef.current &&
      !wsEyeRef.current
    ) {
      return;
    }
    await stopDeviceGracefully('navigate-away', 1600);
  }, [calibrationState, currentView, isCameraOn, isPreviewing, isRecording, isRecordingFinalizing, isEn, showNotice, stopDeviceGracefully]);

  const isDeviceStopped = useCallback(() => {
    const cmdWs = wsCmdRef.current;
    const cmdClosed =
      !cmdWs ||
      cmdWs.readyState === WebSocket.CLOSED ||
      cmdWs.readyState === WebSocket.CLOSING;
    return cmdClosed;
  }, []);

  const { guardedNavigate } = useNavigationGuard({
    isRecordingPageActive: currentView === 'detail' && activeTab === 'video',
    stopDeviceBeforeNavigate,
    isDeviceStopped,
    timeoutMs: 2000,
    stopStrategy: 'blocking',
  });

  useEffect(() => {
    rendererHeartbeatSnapshotRef.current = {
      isCameraOn,
      isRecording,
      isFacialCapturing,
      wsConnected,
      videoPreviewMode,
      combinedImagePreview: shouldUseCombinedImagePreview,
      hasEyeTrackingModality,
      hasFacialExpressionModality,
      lastImageAt,
    };
  }, [
    hasEyeTrackingModality,
    hasFacialExpressionModality,
    isCameraOn,
    isFacialCapturing,
    isRecording,
    lastImageAt,
    shouldUseCombinedImagePreview,
    videoPreviewMode,
    wsConnected,
  ]);

  useEffect(() => {
    if (isCameraOn) return;
    closeEncodedVideoPreview();
    closeWebSocketRef(wsImageRef);
    closeWebSocketRef(wsEyeRef);
    setWsConnected(false);
    setLastImageAt(null);
    setVideoPreviewMode('image');
    setVideoPreviewStatus(null);
    setVideoPreviewFrameSize(null);
  }, [isCameraOn, closeEncodedVideoPreview]);

  useEffect(() => {
    void ipcClient.videoDebugLog({ event: 'renderer:view-state', details: { currentView, activeTab, rendererTimeOrigin: performance.timeOrigin } });
  }, [currentView, activeTab]);

  useEffect(() => {
    if (currentView !== 'detail' || activeTab !== 'video') {
      return;
    }

    let heartbeatIndex = 0;
    let lastHeartbeatAt = Date.now();
    const getReadyState = (ws: WebSocket | null | undefined): number | null => {
      return ws ? ws.readyState : null;
    };
    const emitHeartbeat = () => {
      const now = Date.now();
      const intervalDriftMs = heartbeatIndex === 0 ? 0 : Math.max(0, now - lastHeartbeatAt - 1000);
      lastHeartbeatAt = now;
      heartbeatIndex += 1;
      const snapshot = rendererHeartbeatSnapshotRef.current;
      const perf = performance as PerformanceWithOptionalMemory;
      void ipcClient.videoDebugLog({
        event: 'renderer:page-heartbeat',
        details: {
          heartbeatIndex,
          currentView,
          activeTab,
          intervalDriftMs,
          isCameraOn: snapshot.isCameraOn,
          isRecording: snapshot.isRecording,
          isFacialCapturing: snapshot.isFacialCapturing,
          wsConnected: snapshot.wsConnected,
          videoPreviewMode: snapshot.videoPreviewMode,
          sceneImageWsState: getReadyState(wsImageRef.current),
          cmdWsState: getReadyState(wsCmdRef.current),
          eyeWsState: getReadyState(wsEyeRef.current),
          facialImageWsState: getReadyState(facialImageWsRef.current),
          encodedPreviewActive: Boolean(encodedVideoPreviewRef.current),
          combinedImagePreview: snapshot.combinedImagePreview,
          hasEyeTrackingModality: snapshot.hasEyeTrackingModality,
          hasFacialExpressionModality: snapshot.hasFacialExpressionModality,
          lastImageAgeMs: snapshot.lastImageAt == null ? null : Math.max(0, now - snapshot.lastImageAt),
          jsHeapUsedMb: typeof perf.memory?.usedJSHeapSize === 'number' ? Math.round(perf.memory.usedJSHeapSize / (1024 * 1024)) : null,
          jsHeapTotalMb: typeof perf.memory?.totalJSHeapSize === 'number' ? Math.round(perf.memory.totalJSHeapSize / (1024 * 1024)) : null,
        },
      });
    };

    emitHeartbeat();
    const timer = window.setInterval(emitHeartbeat, 1000);
    return () => window.clearInterval(timer);
  }, [activeTab, currentView]);

  useEffect(() => {
    if (
      currentView !== 'detail' ||
      activeTab !== 'video' ||
      !shouldUseLocalRecordingPipeline ||
      !isCameraOn ||
      simulateMode
    ) {
      return;
    }

    const ensureRecordingConnections = () => {
      if (!deviceConnectionRequestedRef.current) return;
      const cmdState = wsCmdRef.current?.readyState;
      if (cmdState !== WebSocket.OPEN && cmdState !== WebSocket.CONNECTING) {
        connectCmdWs();
      }
      const eyeState = wsEyeRef.current?.readyState;
      if (eyeState !== WebSocket.OPEN && eyeState !== WebSocket.CONNECTING) {
        connectEyeWs();
      }

      if (shouldUseCombinedImagePreview) {
        closeEncodedVideoPreview();
        closeWebSocketRef(wsImageRef);
        setWsConnected(true);
        setLastImageAt(null);
        previewAwaitingFrameSinceRef.current = null;
        return;
      }

      const isGlassesPreview = activeDeviceProfile.deviceType === '眼镜式';
      const imageState = wsImageRef.current?.readyState;
      const useFallbackImageTransport = isGlassesPreview
        && (webCodecsImageFallbackRef.current || shouldUseCombinedImagePreview);
      const hasImageTransport = isGlassesPreview && !useFallbackImageTransport
        ? Boolean(encodedVideoPreviewRef.current)
        : imageState === WebSocket.OPEN || imageState === WebSocket.CONNECTING;
      if (!hasImageTransport) {
        previewAwaitingFrameSinceRef.current = Date.now();
        connectWebSocket();
        return;
      }

      if (!isCameraOn) {
        previewAwaitingFrameSinceRef.current = null;
        return;
      }
      if (lastImageAt !== null) {
        previewAwaitingFrameSinceRef.current = null;
        if (Date.now() - lastImageAt < 6000) return;
      } else if (isGlassesPreview && !useFallbackImageTransport && encodedVideoPreviewRef.current) {
        // The encoded preview owns its first-frame timeout and performs the
        // one-way fallback to the image stream. Recreating it here at 6s used
        // to cancel its 8s timeout forever, leaving the UI on “等待首帧”.
        previewAwaitingFrameSinceRef.current = null;
        return;
      } else if (previewAwaitingFrameSinceRef.current === null) {
        previewAwaitingFrameSinceRef.current = Date.now();
        return;
      } else if (Date.now() - previewAwaitingFrameSinceRef.current < 6000) {
        return;
      }

      console.warn('[MrtApp] preview frame watchdog reconnecting stale image stream');
      previewAwaitingFrameSinceRef.current = Date.now();
      connectWebSocket();
    };

    ensureRecordingConnections();
    const timer = window.setInterval(ensureRecordingConnections, 1500);
    return () => window.clearInterval(timer);
  }, [
    activeDeviceProfile.deviceType,
    activeTab,
    closeEncodedVideoPreview,
    connectCmdWs,
    connectEyeWs,
    connectWebSocket,
    currentView,
    isCameraOn,
    lastImageAt,
    shouldUseLocalRecordingPipeline,
    shouldUseCombinedImagePreview,
    simulateMode,
  ]);

  useEffect(() => {
    if (currentView !== 'detail' || activeTab !== 'video') return;
    if (!shouldUseLocalRecordingPipeline) {
      if (!isCameraOn && !isRecording && calibrationState === 'none') {
        closeEncodedVideoPreview();
        closeWebSocketRef(wsImageRef);
        closeWebSocketRef(wsCmdRef);
        closeWebSocketRef(wsEyeRef);
        setWsConnected(false);
        setVideoPreviewMode('image');
        setVideoPreviewStatus(null);
        setVideoPreviewFrameSize(null);
        setLastImageAt(null);
      }
      return;
    }
    if (!isCameraOn || !deviceConnectionRequestedRef.current || !wsIp || !wsImagePort) return;

    const wantsWebCodecs = activeDeviceProfile.deviceType === '眼镜式'
      && !shouldUseCombinedImagePreview
      && !webCodecsImageFallbackRef.current;
    const hasImageSocket = !!wsImageRef.current;
    const hasEncodedSocket = !!encodedVideoPreviewRef.current;
    const usingWebCodecs = videoPreviewMode === 'webcodecs' && hasEncodedSocket;

    if (wantsWebCodecs && hasImageSocket && !usingWebCodecs) {
      console.log('[MrtApp] switching preview transport to WebCodecs for glasses mode');
      closeWebSocketRef(wsImageRef);
      setWsConnected(false);
      setLastImageAt(null);
      const timer = window.setTimeout(() => {
        connectWebSocket();
      }, 80);
      return () => window.clearTimeout(timer);
    }

    if (!wantsWebCodecs && hasEncodedSocket) {
      console.log('[MrtApp] switching preview transport to image mode for desktop mode');
      closeEncodedVideoPreview();
      const timer = window.setTimeout(() => {
        connectWebSocket();
      }, 80);
      return () => window.clearTimeout(timer);
    }
  }, [
    activeDeviceProfile.deviceType,
    activeTab,
    closeEncodedVideoPreview,
    connectWebSocket,
    currentView,
    calibrationState,
    isCameraOn,
    isRecording,
    shouldUseLocalRecordingPipeline,
    shouldUseCombinedImagePreview,
    videoPreviewMode,
    wsImagePort,
    wsIp,
  ]);

  const recordingMetaPendingRef = useRef<{
    operationId: string;
    confirmed: boolean;
    saving: boolean;
    recordingId: string;
    videoPath: string;
    projectDir: string | null;
    subjectName: string;
    startedAtMs: number;
    calibrationLeftScore: number | null;
    calibrationRightScore: number | null;
    country: string | null;
    configuredSamplingRateHz: number | null;
    videoSamplingRateHz: number;
    stimuli: Array<{ id: string; name: string }>;
  } | null>(null);
  const recordingMetadataProjectRef = useRef(activeDataDir);
  recordingMetadataProjectRef.current = activeDataDir;

  const mousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      mousePosRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
    };
  }, []);

  const eyeSamplesRef = useRef<
    Array<{
      timestamp: string;
      recomGazeX: string;
      recomGazeY: string;
      leftGazeX: string;
      leftGazeY: string;
      rightGazeX: string;
      rightGazeY: string;
      leftPupilCenterX: string;
      leftPupilCenterY: string;
      rightPupilCenterX: string;
      rightPupilCenterY: string;
      mouseX?: string;
      mouseY?: string;
      stimulus?: string;          // 当前刺激物名称
      triggerMark?: string;       // Trigger标记
      customMarker?: string;      // 自定义标记
    }>
  >([]);
  const playbackOrderRef = useRef<number[] | null>(null);
  const playbackSequenceRef = useRef<string[] | null>(null);
  
  // 跟踪当前刺激物和事件
  const currentStimulusNameRef = useRef<string>('');
  const currentStimulusIdRef = useRef<string>('');
  const currentStimulusStartedAtRef = useRef<number>(0);
  const tcpAoiByScopeRef = useRef<Record<string, NormalizedAoiShape[]>>({});
  const currentTriggerMarkRef = useRef<string>('');
  const activeCustomMarkersRef = useRef<Set<string>>(new Set());
  const activeContinuousMarkersRef = useRef<Set<string>>(new Set());
  const pendingInstantMarkersRef = useRef<Set<string>>(new Set());
  const startRecordingInFlightRef = useRef(false);
  const stopRecordingInFlightRef = useRef(false);
  const pendingRecordRefreshTimersRef = useRef<number[]>([]);
  const isRecordingStateRef = useRef(false);
  const recordingCompletionDialogPendingRef = useRef(false);
  const recordingFinalizingProjectDirRef = useRef<string | null>(null);

  useEffect(() => {
    isRecordingStateRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    if (!isCameraOn) {
      activeTrackingCoeRef.current = null;
    }
  }, [isCameraOn]);

  useEffect(() => {
    activeTrackingCoeRef.current = null;
  }, [activeDataDir, currentRecordingSubjectId]);

  useEffect(() => {
    const currentCoe = typeof calibrationCoe === 'string' ? calibrationCoe.trim() : '';
    if (!currentCoe || activeTrackingCoeRef.current !== currentCoe) {
      activeTrackingCoeRef.current = null;
    }
  }, [calibrationCoe]);

  const clearPendingRecordRefreshTimers = useCallback(() => {
    if (pendingRecordRefreshTimersRef.current.length <= 0) return;
    pendingRecordRefreshTimersRef.current.forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    pendingRecordRefreshTimersRef.current = [];
  }, []);

  useEffect(() => {
    return () => {
      clearPendingRecordRefreshTimers();
    };
  }, [clearPendingRecordRefreshTimers]);

  const loadSavedCalibrationForCurrentSubject = useCallback(async (): Promise<{
    coe: string | null;
    scores: CalibrationScores | null;
  }> => {
    if (simulateMode || !ipcClient.isAvailable()) {
      return { coe: null, scores: null };
    }
    const experimentDir = activeDataDir || '';
    if (!experimentDir) {
      return { coe: null, scores: null };
    }

    try {
      const res = await ipcClient.loadCalibrationResult({
        experimentDir,
        subjectId: currentRecordingSubjectId || undefined,
      });
      if (!res || !res.ok) {
        return { coe: null, scores: null };
      }
      return parseCalibrationPayload(res.result);
    } catch {
      return { coe: null, scores: null };
    }
  }, [simulateMode, activeDataDir, currentRecordingSubjectId]);

  const startRecordingCore = useCallback(async (operationId: string) => {
    const isCurrentRecording = () => {
      const current = recordingLifecycle.stateRef.current;
      return current.operationId === operationId && current.status === 'recording';
    };
    const isGlassesRecording = activeDeviceProfile.deviceType === '眼镜式';
    const splitScreenMode = Boolean(recordingSettings.splitScreenMode);
    const shouldUseStimulusPlayback = activeDeviceProfile.stimulusEnabled && (!isGlassesRecording || splitScreenMode);
    if (shouldUseStimulusPlayback) {
      const randomOrder = Boolean(recordingSettings.randomOrder);
      const sequence = playbackEngine.generatePlaybackSequence(stimuli, randomOrder);
      playbackSequenceRef.current = sequence;

      const isActiveStim = (stimulus: ExtendedStimulus | undefined): boolean => Boolean(stimulus && stimulus.active !== false);
      const buildPlaybackOrder = (random: boolean): number[] => {
        const order: number[] = [];
        const groupsMap: Record<string, number[]> = {};
        const ungrouped: number[] = [];

        for (let i = 0; i < stimuli.length; i += 1) {
          if (isActiveStim(stimuli[i]) && stimuli[i].stimulusType !== 'group') {
            const g = stimuli[i].group;
            if (g) {
              if (!groupsMap[g]) groupsMap[g] = [];
              groupsMap[g].push(i);
            } else {
              ungrouped.push(i);
            }
          }
        }

        Object.keys(groupsMap).sort().forEach((g) => {
          order.push(...groupsMap[g]);
        });
        order.push(...ungrouped);

        if (!random) return order;

        const randomizablePositions: number[] = [];
        const randomizableItems: number[] = [];
        for (let i = 0; i < order.length; i += 1) {
          const stim = stimuli[order[i]];
          if (stim?.randomPlay === true) {
            randomizablePositions.push(i);
            randomizableItems.push(order[i]);
          }
        }
        if (randomizableItems.length <= 1) return order;

        for (let i = randomizableItems.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          const tmp = randomizableItems[i];
          randomizableItems[i] = randomizableItems[j];
          randomizableItems[j] = tmp;
        }
        randomizablePositions.forEach((pos, idx) => {
          order[pos] = randomizableItems[idx];
        });
        return order;
      };

      playbackOrderRef.current = buildPlaybackOrder(randomOrder);
    } else {
      playbackOrderRef.current = null;
      playbackSequenceRef.current = null;
      setPlaybackIndex(null);
      currentStimulusNameRef.current = '';
      currentTriggerMarkRef.current = '';
    }

    const firstStimulus = (playbackSequenceRef.current || [])
      .filter((stimulusId) => !stimulusId.startsWith('GROUP_TRIGGER:'))
      .map((stimulusId) => stimuli.find((stimulus) => stimulus.id === stimulusId) || null)
      .find((stimulus): stimulus is ExtendedStimulus => Boolean(stimulus));
    if (firstStimulus) {
      const stimulusName = firstStimulus.name || `Stimulus_${firstStimulus.id}`;
      sendCmd('set_stimulus', { name: stimulusName });
      currentStimulusNameRef.current = `${firstStimulus.id}::${stimulusName}`;
    } else {
      currentStimulusNameRef.current = '';
    }

    const subjectName = currentRecordingSubjectName;
    const selectedSubject = currentRecordingSubject;
    const country =
      selectedSubject?.国 ??
      selectedSubject?.国籍 ??
      selectedSubject?.country ??
      selectedSubject?.Country ??
      null;
    let metaLeftScore = calibrationScores && Number.isFinite(calibrationScores.left) ? calibrationScores.left : null;
    let metaRightScore = calibrationScores && Number.isFinite(calibrationScores.right) ? calibrationScores.right : null;
    if (metaLeftScore === null || metaRightScore === null) {
      const savedCalibration = await loadSavedCalibrationForCurrentSubject();
      const savedScores = savedCalibration.scores;
      if (savedScores) {
        if (metaLeftScore === null && Number.isFinite(savedScores.left)) {
          metaLeftScore = savedScores.left;
        }
        if (metaRightScore === null && Number.isFinite(savedScores.right)) {
          metaRightScore = savedScores.right;
        }
        if (!calibrationScores) {
          setCalibrationScores(savedScores);
        }
      }
    }
    recordingMetaPendingRef.current = {
      operationId,
      confirmed: false,
      saving: false,
      recordingId: '',
      videoPath: '',
      projectDir: activeDataDir || null,
      subjectName,
      startedAtMs: Date.now(),
      calibrationLeftScore: metaLeftScore,
      calibrationRightScore: metaRightScore,
      country: typeof country === 'string' && country.trim().length > 0 ? country : null,
      configuredSamplingRateHz: samplingRateHz > 0 ? samplingRateHz : null,
      videoSamplingRateHz,
      stimuli: Array.from(
        new Map(
          (playbackSequenceRef.current || [])
            .filter((stimulusId) => !stimulusId.startsWith('GROUP_TRIGGER:'))
            .map((stimulusId) => stimuli.find((stimulus) => stimulus.id === stimulusId))
            .filter((stimulus): stimulus is ExtendedStimulus => Boolean(stimulus))
            .map((stimulus) => [stimulus.id, { id: stimulus.id, name: stimulus.name }]),
        ).values(),
      ),
    };
    eyeSamplesRef.current = [];
    activeCustomMarkersRef.current.clear();
    activeContinuousMarkersRef.current.clear();
    pendingInstantMarkersRef.current.clear();

    const isFacialTileVisible = !hiddenRecordingMonitorTileIds.includes('facial');
    const shouldRecordFacial = hasFacialExpressionModality
      && !isFixedRemoteEyeMonitor
      && isFacialTileVisible
      && facialSettings.enabled
      && Boolean(activeDataDir);
    if (shouldRecordFacial) {
      const readiness = await validateFacialCaptureReady();
      if (!readiness.ok) throw new Error(readiness.message || '表情模块未就绪');
    }

    const eyeRecording = await startRecordingMod({
      stimuli,
      subjects,
      subjectId: currentRecordingSubjectId,
      projectDir: activeDataDir || null,
      wsCmdRef,
      onPreparing: () => recordingLifecycle.begin(operationId),
      onConfirmed: (result) => {
        recordingLifecycle.confirmStart(operationId, result.recordingId, result.videoPath);
        const pending = recordingMetaPendingRef.current;
        if (isCurrentRecording() && pending?.operationId === operationId) {
          pending.confirmed = true;
          pending.recordingId = recordingLifecycle.stateRef.current.recordingId || '';
          pending.videoPath = recordingLifecycle.stateRef.current.videoPath || '';
        }
        void ipcClient.videoDebugLog({
          event: 'recording:start-confirmed',
          details: {
            operationId,
            recordingId: result.recordingId || null,
            videoPath: result.videoPath || null,
            deviceType: activeDeviceProfile.deviceType,
          },
        });
      },
      onFailed: (error) => recordingLifecycle.failStart(operationId, error),
      onCommunicationError: (message) => showNotice(message, isEn ? 'Recording communication' : '录制通信'),
      isRecordingCurrent: isCurrentRecording,
      isPreparationCurrent: () => recordingLifecycle.stateRef.current.operationId === operationId
        && recordingLifecycle.stateRef.current.status === 'preparing',
      setIsRecordingCaptureReady,
      setPlaybackIndex,
      initialPlaybackIndex: shouldUseStimulusPlayback && (playbackSequenceRef.current?.length || 0) > 0 ? 0 : null,
      requireStimuli: shouldUseStimulusPlayback && !isGlassesRecording,
      enableSplitScreen: splitScreenMode,
      enableFullscreen: activeDeviceProfile.deviceType !== '眼镜式' && !splitScreenMode,
      videoSamplingRateHz,
      deviceType: activeDeviceProfile.deviceType,
      initialParticipantState: createParticipantWindowState({
        isRecording: true,
        isPreviewing: false,
        stimulus: firstStimulus || null,
        bgColor: String(recordingSettings.bgColor || '#000000'),
        hideGaze: true,
        calibrationState: 'none',
        calibrationMode: activeDeviceProfile.calibrationMode,
        calibrationPointStyle: normalizeCalibrationPointStyle(recordingSettings.calibrationPointStyle),
        language,
      }),
    });

    if (!eyeRecording || !isCurrentRecording()) return;
    // Attach the facial recorder to the already-running shared camera session.
    if (shouldRecordFacial) {
      const facialRecordId = eyeRecording?.recordingId || generateFacialRecordName();
      const started = await startFacialAutoCapture(facialRecordId, isCurrentRecording);
      if (!isCurrentRecording()) return;
      if (!started) {
        sendCmdOverWs({ wsCmdRef, id: 'stop_recording', args: {} });
        throw new Error('表情录制启动失败，眼动录制已停止');
      }
    }
  }, [
    activeDeviceProfile.stimulusEnabled,
    activeDeviceProfile.deviceType,
    activeDeviceProfile.calibrationMode,
    language,
    stimuli,
    subjects,
    recordingSettings,
    activeDataDir,
    calibrationScores,
    samplingRateHz,
    videoSamplingRateHz,
    currentRecordingSubject,
    currentRecordingSubjectId,
    currentRecordingSubjectName,
    loadSavedCalibrationForCurrentSubject,
    sendCmd,
    hiddenRecordingMonitorTileIds,
    facialSettings.enabled,
    hasFacialExpressionModality,
    isFixedRemoteEyeMonitor,
    validateFacialCaptureReady,
    startFacialAutoCapture,
    recordingLifecycle.begin,
    recordingLifecycle.confirmStart,
    recordingLifecycle.failStart,
    recordingLifecycle.stateRef,
  ]);

  useEffect(() => {
    if (isRecording || isRecordingFinalizing) return;
    setIsRecordingCaptureReady(false);
  }, [isRecording, isRecordingFinalizing]);

  useEffect(() => {
    if (isRecording || isRecordingFinalizing) return;
    let cancelled = false;
    void stopActiveAudioRecording().then((result) => {
      if (cancelled || result.ok) return;
      showNotice(
        isEn
          ? `Microphone audio could not be added to the video: ${result.message}`
          : `麦克风音频未能写入视频：${result.message}`,
        isEn ? 'Audio recording failed' : '音频录制失败',
      );
    });
    return () => {
      cancelled = true;
    };
  }, [isRecording, isRecordingFinalizing, isEn, showNotice]);

  useEffect(() => {
    if (!isRecording || !isRecordingCaptureReady) return;
    const pending = recordingMetaPendingRef.current;
    if (!pending) return;
    pending.startedAtMs = Date.now();
  }, [isRecording, isRecordingCaptureReady]);

  useEffect(() => {
    if (!isRecording || !isRecordingCaptureReady) return;
    if (!recordingSettings.saveRawData) return;
    return eyeDataStore.subscribe(() => {
      const eyeData = eyeDataStore.getSnapshot();
      const ts = String(eyeData?.timestamp || '');
      const sample: Record<string, string> = {
        timestamp: ts,
        recomGazeX: String(eyeData?.recomGazeX ?? ''),
        recomGazeY: String(eyeData?.recomGazeY ?? ''),
        leftGazeX: String(eyeData?.leftGazeX ?? ''),
        leftGazeY: String(eyeData?.leftGazeY ?? ''),
        rightGazeX: String(eyeData?.rightGazeX ?? ''),
        rightGazeY: String(eyeData?.rightGazeY ?? ''),
        leftPupilCenterX: String(eyeData?.leftPupilCenterX ?? ''),
        leftPupilCenterY: String(eyeData?.leftPupilCenterY ?? ''),
        leftPupilDiameter: String(eyeData?.leftPupilDiameter ?? ''),
        leftPupilDiameterMm: String(eyeData?.leftPupilDiameterMm ?? ''),
        rightPupilCenterX: String(eyeData?.rightPupilCenterX ?? ''),
        rightPupilCenterY: String(eyeData?.rightPupilCenterY ?? ''),
        rightPupilDiameter: String(eyeData?.rightPupilDiameter ?? ''),
        rightPupilDiameterMm: String(eyeData?.rightPupilDiameterMm ?? ''),
        leftBlink: String(eyeData?.leftBlink ?? ''),
        leftOpenness: String(eyeData?.leftOpenness ?? ''),
        leftEyelidUp: String(eyeData?.leftEyelidUp ?? ''),
        leftEyelidDown: String(eyeData?.leftEyelidDown ?? ''),
        rightBlink: String(eyeData?.rightBlink ?? ''),
        rightOpenness: String(eyeData?.rightOpenness ?? ''),
        rightEyelidUp: String(eyeData?.rightEyelidUp ?? ''),
        rightEyelidDown: String(eyeData?.rightEyelidDown ?? ''),
        fixationTimestampMs: String(eyeData?.fixationTimestampMs ?? ''),
        fixationDurationMs: String(eyeData?.fixationDurationMs ?? ''),
        fixationTimestampUs: String(eyeData?.fixationTimestampUs ?? ''),
        fixationDurationUs: String(eyeData?.fixationDurationUs ?? ''),
        fixationCount: String(eyeData?.fixationCount ?? ''),
        fixationState: String(eyeData?.fixationState ?? ''),
        fixationCenterX: String(eyeData?.fixationCenterX ?? ''),
        fixationCenterY: String(eyeData?.fixationCenterY ?? ''),
        gazeVelocityMs: String(eyeData?.gazeVelocityMs ?? ''),
        saccadeAmplitude: String(eyeData?.saccadeAmplitude ?? ''),
        saccadeDurationMs: String(eyeData?.saccadeDurationMs ?? ''),
        saccadeVelocity: String(eyeData?.saccadeVelocity ?? ''),
        saccadePeakVelocity: String(eyeData?.saccadePeakVelocity ?? ''),
      };
      if (recordingSettings.recordMouse) {
        sample.mouseX = String(mousePosRef.current.x);
        sample.mouseY = String(mousePosRef.current.y);
      }
      if (currentStimulusNameRef.current) sample.stimulus = currentStimulusNameRef.current;
      if (currentTriggerMarkRef.current) sample.triggerMark = currentTriggerMarkRef.current;
      const markerNames = new Set<string>();
      for (const name of activeCustomMarkersRef.current) {
        if (typeof name === 'string' && name.trim().length > 0) markerNames.add(name);
      }
      for (const name of pendingInstantMarkersRef.current) {
        if (typeof name === 'string' && name.trim().length > 0) markerNames.add(name);
      }
      if (markerNames.size > 0) sample.customMarker = Array.from(markerNames).join(',');
      if (pendingInstantMarkersRef.current.size > 0) pendingInstantMarkersRef.current.clear();
      eyeSamplesRef.current.push(sample);
    });
  }, [eyeDataStore, isRecording, isRecordingCaptureReady, recordingSettings.recordMouse, recordingSettings.saveRawData]);

  useEffect(() => {
    if (!recordingSettings.saveEyeCalibration) return;
    if (simulateMode) return;
    if (calibrationState !== 'finished') return;
    if (isCalibrationTestMode && !(activeDeviceModel === 'PupilCore' && calibrationScores?.pupilScores?.validation)) return;
    const experimentDir = activeDataDir || '';
    if (!experimentDir) return;
    if (!ipcClient.isAvailable()) return;
    const result = {
      savedAt: new Date().toISOString(),
      calibrationType: String(recordingSettings.calibrationType || ''),
      coe: calibrationCoe,
      scores: calibrationScores,
      subjectId: currentRecordingSubjectId || undefined,
      subjectName: currentRecordingSubjectName || undefined,
    };
    void ipcClient.saveCalibrationResult({
      experimentDir,
      subjectId: currentRecordingSubjectId || undefined,
      result,
    });
  }, [
    calibrationState,
    calibrationCoe,
    calibrationScores,
    recordingSettings,
    activeDataDir,
    simulateMode,
    isCalibrationTestMode,
    currentRecordingSubjectId,
    currentRecordingSubjectName,
    activeDeviceModel,
  ]);

  useEffect(() => {
    if (simulateMode) return;
    if (!ipcClient.isAvailable()) {
      setCalibrationCoe(null);
      setCalibrationScores(null);
      return;
    }
    const experimentDir = activeDataDir || '';
    if (!experimentDir) {
      setCalibrationCoe(null);
      setCalibrationScores(null);
      return;
    }

    let cancelled = false;

    setCalibrationCoe(null);
    setCalibrationScores(null);
    ipcClient
      .loadCalibrationResult({ experimentDir, subjectId: currentRecordingSubjectId || undefined })
      .then((res) => {
        if (cancelled) return;
        if (!res || !res.ok || !res.result || typeof res.result !== 'object') {
          setCalibrationCoe(null);
          setCalibrationScores(null);
          return;
        }

        const parsed = parseCalibrationPayload(res.result);
        setCalibrationCoe(parsed.coe);
        setCalibrationScores(parsed.scores);
      })
      .catch(() => {
        if (cancelled) return;
        setCalibrationCoe(null);
        setCalibrationScores(null);
      });

    return () => {
      cancelled = true;
    };
  }, [activeDataDir, simulateMode, currentRecordingSubjectId]);

  const handleStartCalibration = useCallback(async (validation = false) => {
    if (calibrationStartingRef.current || calibrationState === 'calibrating') return;
    calibrationStartingRef.current = true;
    setIsCalibrationStarting(true);
    try {
    if (!simulateMode) {
      const wsReady = await ensureCmdWsReady(activeDeviceType === '眼镜式' ? 5000 : 2500);
      if (!wsReady) {
        showNotice(
          isEn ? 'Failed to start calibration: command channel not connected' : '校准启动失败：命令通道未连接',
        );
        return;
      }
    }
    if (activeDeviceModel === 'PupilCore' && !validation) {
      setCalibrationCoe(null);
      setCalibrationScores(null);
    }
    if (activeDeviceType === '眼镜式' && !glassesCalibrationMonitorLayoutRef.current) {
      glassesCalibrationMonitorLayoutRef.current = {
        layout: recordingMonitorLayout,
        hiddenTileIds: [...hiddenRecordingMonitorTileIds],
      };
      setRecordingMonitorLayout('single');
      setHiddenRecordingMonitorTileIds((current) => current.filter((id) => id !== 'device'));
      setRecordingMonitorLayoutResetToken((value) => value + 1);
    }
    setIsCalibrationTestMode(validation);
    setCardDetectedPoint(null);
    setCardCompletedPoints([]);
    setCardDetectionStatus('idle');
    setCardDetectionMessage('');
    cardSubmittedPointRef.current = null;
    const points = validation ? 3 : getCalibrationPointsCount(recordingSettings.calibrationType);
    if (String(recordingSettings.calibrationType || '') === '卡片式三点校准') {
      setCardDetectionMessage('第1点：请将卡片移动到画面内并确认');
    } else if (String(recordingSettings.calibrationType || '') === '卡片式一点校准') {
      setCardDetectionMessage('请将卡片移动到画面内并确认');
    }
    calibStateRef.current.points = points;
    calibStateRef.current.sequenceOverride = activeDeviceModel === 'PupilCore' ? getPupilCalibrationSequence(points) : undefined;
    const sequence = calibStateRef.current.sequenceOverride || getCalibrationSequence(points);
    const firstIdx = sequence[0] ?? 4;
    calibStateRef.current.arrIndex = firstIdx;
    calibStateRef.current.pointIndex = 1;
    setCalibPointIndex(firstIdx);
    setCalibScale(1.0);
    setCalibrationState('calibrating');
    if (useFullscreenCalibration) {
      enterCalibrationFullscreen();
    }

    const splitScreenMode = activeDeviceModel !== 'PupilCore' && Boolean(recordingSettings.splitScreenMode);
    if (ipcClient.isAvailable()) {
      if (splitScreenMode) {
        const res = await ipcClient.createRecordingWindow({
          projectDir: activeDataDir || undefined,
          forceEnable: true,
          initialState: createParticipantWindowState({
            bgColor: String(recordingSettings.bgColor || '#000000'),
            hideGaze: true,
            calibrationState: 'calibrating',
            calibrationMode: activeDeviceProfile.calibrationMode,
            calibPointIndex: firstIdx,
            calibScale: 1,
            calibrationPointStyle: normalizeCalibrationPointStyle(recordingSettings.calibrationPointStyle),
            isCalibrationTestMode: false,
            language,
          }),
        });
        if (!res.ok) {
          console.warn('[startCalibration] create-recording-window failed:', 'message' in res ? res.message : 'unknown');
        }
        if (!res.ok || !res.hasParticipantWindow || res.participantReady === false) {
          const warningText = Array.isArray(res.warnings) && res.warnings.length > 0
            ? isEn
              ? `\nReason: ${res.warnings.map((warning) => translateTextForLanguage(warning, 'en-US')).join('; ')}`
              : `\n原因：${res.warnings.join('；')}`
            : '';
          clearCalibrationFullscreenTimer();
          setCalibrationState('none');
          setCalibScale(1);
          if (useFullscreenCalibration) {
            void exitRecordingFullscreen();
          }
          void ipcClient.closeRecordingWindow();
          showNotice(
            res.participantReady === false
              ? (isEn
                  ? `Split-screen calibration was cancelled because the participant screen did not render its first frame. Reopen split-screen and retry.${warningText}`
                  : `分屏校准已取消：被试屏未完成首帧显示，请重新打开分屏后重试。${warningText}`)
              : (isEn
                  ? `Split-screen calibration is enabled, but the participant window could not be opened. Check whether a second display is connected.${warningText}`
                  : `分屏校准已启用，但未能打开被试屏窗口。请检查是否连接了第二显示器。${warningText}`),
          );
          return;
        }
      }
    }

    if (simulateMode) {
      clearSimulateCalibAnim();
      if (calibStateRef.current.timerId) clearTimeout(calibStateRef.current.timerId);
      if (calibStateRef.current.safetyTimerId) clearTimeout(calibStateRef.current.safetyTimerId);
      calibStateRef.current.timerId = null;
      calibStateRef.current.safetyTimerId = null;
      simulateCalibrationRef.current = {
        active: true,
        sequence,
        step: 0,
      };
      calibStateRef.current.arrIndex = firstIdx;
      calibStateRef.current.pointIndex = 1;
      setCalibPointIndex(firstIdx);
      setCalibScale(1.0);
      setCalibrationState('calibrating');
      return;
    }

    // The SDK server stops the previous tracking session before calibration.
    // Clear the renderer-side cache too, so a failed calibration cannot leave
    // the old coefficient incorrectly marked as active.
    activeTrackingCoeRef.current = null;
    const started = sendCmd('start_calibration', { points, validation, coe: validation ? calibrationCoe : undefined });
    if (!started) {
      clearCalibrationFullscreenTimer();
      setCalibrationState('none');
      setCalibScale(1.0);
      if (useFullscreenCalibration) {
        void exitRecordingFullscreen();
      }
      showNotice(
        isEn ? 'Failed to start calibration: command channel not connected' : '校准启动失败：命令通道未连接',
      );
    }
    } finally {
      calibrationStartingRef.current = false;
      setIsCalibrationStarting(false);
    }
  }, [recordingSettings.calibrationType, recordingSettings.splitScreenMode, recordingSettings.bgColor, recordingSettings.calibrationPointStyle, activeDataDir, sendCmd, simulateMode, clearSimulateCalibAnim, showNotice, enterCalibrationFullscreen, clearCalibrationFullscreenTimer, exitRecordingFullscreen, isEn, useFullscreenCalibration, ensureCmdWsReady, activeDeviceModel, activeDeviceType, activeDeviceProfile.calibrationMode, language, recordingMonitorLayout, hiddenRecordingMonitorTileIds, calibrationState, calibrationCoe]);

  const handleCancelCalibration = useCallback(() => {
    setIsCalibrationTestMode(false);
    clearSimulateCalibAnim();
    clearCalibrationFullscreenTimer();
    simulateCalibrationRef.current = { active: false, sequence: [], step: -1 };
    if (activeDeviceModel === 'PupilCore') {
      calibStateRef.current.pointPending = false;
      calibStateRef.current.pointAttempt = (calibStateRef.current.pointAttempt ?? 0) + 1;
      cardSubmittedPointRef.current = null;
    }
    cancelCalibration({
      calibStateRef,
      setCalibrationState,
      setCalibScale,
      sendCmd,
      exitFullscreen: useFullscreenCalibration,
    });
  }, [sendCmd, clearSimulateCalibAnim, clearCalibrationFullscreenTimer, useFullscreenCalibration, activeDeviceModel]);

  const applyCalibrationBeforeRecording = useCallback(
    async (coe: string, options?: { force?: boolean }): Promise<{ ok: boolean; error?: string }> => {
      const nextCoe = String(coe || '').trim();
      if (!nextCoe) return { ok: false, error: '未检测到历史校准系数' };
      if (activeDeviceModel !== 'PupilCore' && !options?.force && isCameraOn && activeTrackingCoeRef.current === nextCoe) {
        return { ok: true };
      }

      const trackingRsp = await sendCmdWithResponse({
        wsCmdRef,
        id: 'start_tracking',
        args: { coe: nextCoe },
        timeoutMs: 2500,
      });
      if (!trackingRsp.ok) {
        return { ok: false, error: trackingRsp.error || '应用校准结果失败' };
      }
      activeTrackingCoeRef.current = nextCoe;
      return { ok: true };
    },
    [isCameraOn, activeDeviceModel],
  );

  const handleStartCalibrationTest = useCallback(() => {
    if (calibrationTestStartingRef.current || isCalibrationTestMode) {
      void ipcClient.videoDebugLog({
        event: 'calibration-test:start-ignored',
        details: { reason: calibrationTestStartingRef.current ? 'already-starting' : 'already-active', language },
      });
      return;
    }
    if (isRecording) {
      showNotice(
        isEn
          ? 'Calibration test cannot run during recording. Please stop recording first.'
          : '录制中无法进行校准测试，请先停止录制后再测试。',
      );
      return;
    }
    if (!isCameraOn) {
      showNotice(
        isEn ? 'Device is not started. Click "Start device" before calibration test.' : '设备未开启，请先点击“启动设备”后再进行校准测试。',
        isEn ? 'Start device first' : '请先开启设备',
      );
      return;
    }

    if (activeDeviceModel === 'PupilCore') {
      if (!calibrationCoe) {
        showNotice(isEn ? 'Complete calibration in this connection first.' : '请先完成当前连接的校准，再进行独立验证。');
        return;
      }
      void handleStartCalibration(true);
      return;
    }

    calibrationTestStartingRef.current = true;
    void ipcClient.videoDebugLog({
      event: 'calibration-test:start-enter',
      details: {
        language,
        calibrationState,
        calibrationMode: activeDeviceProfile.calibrationMode,
        deviceType: activeDeviceProfile.deviceType,
        hasCalibrationCoe: Boolean(String(calibrationCoe || '').trim()),
        hasCalibrationScores: Boolean(calibrationScores),
        splitScreenMode: Boolean(recordingSettings.splitScreenMode),
      },
    });
    void (async () => {
      try {
      let reusableCoe = typeof calibrationCoe === 'string' ? calibrationCoe.trim() : '';
      let reusableScores = calibrationScores;

      if (!reusableCoe || !reusableScores) {
        const savedCalibration = await loadSavedCalibrationForCurrentSubject();
        if (!reusableCoe && savedCalibration.coe) {
          reusableCoe = savedCalibration.coe;
          setCalibrationCoe(savedCalibration.coe);
        }
        if (!reusableScores && savedCalibration.scores) {
          reusableScores = savedCalibration.scores;
          setCalibrationScores(savedCalibration.scores);
        }
      }

      if (!reusableCoe) {
        showNotice(
          isEn
            ? 'No reusable calibration data for current subject. Please complete one calibration first.'
            : '当前受试者未检测到可复用校准数据，请先完成一次校准后再进行校准测试。',
          isEn ? 'Cannot start calibration test' : '无法开始校准测试',
        );
        return;
      }

      const trackingResult = await applyCalibrationBeforeRecording(reusableCoe, { force: true });
      if (!trackingResult.ok) {
        showNotice(
          isEn
            ? `Failed to start gaze tracking: ${trackingResult.error || 'unknown error'}`
            : `眼动追踪启动失败：${trackingResult.error || '未知错误'}`,
          isEn ? 'Cannot start calibration test' : '无法开始校准测试',
        );
        return;
      }

      const splitScreenMode = Boolean(recordingSettings.splitScreenMode);
      if (splitScreenMode && ipcClient.isAvailable()) {
        const res = await ipcClient.createRecordingWindow({
          projectDir: activeDataDir || undefined,
          forceEnable: true,
          initialState: createParticipantWindowState({
            bgColor: String(recordingSettings.bgColor || '#000000'),
            hideGaze: true,
            calibrationState: 'finished',
            calibrationMode: activeDeviceProfile.calibrationMode,
            calibPointIndex: 4,
            calibScale: 1,
            calibrationPointStyle: normalizeCalibrationPointStyle(recordingSettings.calibrationPointStyle),
            isCalibrationTestMode: true,
            language,
          }),
        });
        if (!res.ok) {
          console.warn('[startCalibrationTest] create-recording-window failed:', 'message' in res ? res.message : 'unknown');
        }
        if (!res.ok || !res.hasParticipantWindow || res.participantReady === false) {
          const warningText = Array.isArray(res.warnings) && res.warnings.length > 0
            ? isEn
              ? `\nReason: ${res.warnings.map((warning) => translateTextForLanguage(warning, 'en-US')).join('; ')}`
              : `\n原因：${res.warnings.join('；')}`
            : '';
          showNotice(
            res.participantReady === false
              ? (isEn
                  ? `The calibration test was cancelled because the participant screen did not render its first frame. Please reopen split-screen and retry.${warningText}`
                  : `分屏校准测试已取消：被试屏未完成首帧显示，请重新打开分屏后重试。${warningText}`)
              : (isEn
                  ? `Split-screen calibration test is enabled, but the participant window could not be opened. Please check whether a second display is connected.${warningText}`
                  : `分屏校准测试已启用，但未能打开被试屏窗口。请检查是否连接了第二显示器。${warningText}`),
          );
          void ipcClient.closeRecordingWindow();
          return;
        }
      }

      if (splitScreenMode) {
        clearCalibrationFullscreenTimer();
        await exitRecordingFullscreen();
        calibrationTestMonitorLayoutRef.current = {
          layout: recordingMonitorLayout,
          hiddenTileIds: [...hiddenRecordingMonitorTileIds],
        };
        // The operator-side gaze point is rendered inside the participant tile.
        // A single-panel layout only mounts the first (device) tile, so merely
        // unhiding participant is insufficient. Use the documented 2x2 layout
        // for the test and restore the user's layout when the test exits.
        setRecordingMonitorLayout('2x2');
        setHiddenRecordingMonitorTileIds((current) => current.filter((id) => id !== 'participant'));
        setRecordingMonitorLayoutResetToken((value) => value + 1);
      }
      setIsCalibrationTestMode(true);
      setCalibPointIndex(4);
      setCalibScale(1.0);
      setCalibrationState('finished');
      void ipcClient.videoDebugLog({
        event: 'calibration-test:state-applied',
        details: {
          language,
          useFullscreenCalibration,
          splitScreenMode,
          monitorLayoutBefore: recordingMonitorLayout,
          monitorLayoutApplied: splitScreenMode ? '2x2' : recordingMonitorLayout,
        },
      });
      window.setTimeout(() => {
        const eyeData = eyeDataStore.getSnapshot();
        void ipcClient.videoDebugLog({
          event: 'calibration-test:gaze-snapshot',
          details: {
            eyeWsReadyState: wsEyeRef.current?.readyState ?? null,
            recomGazeX: eyeData.recomGazeX,
            recomGazeY: eyeData.recomGazeY,
            recomGazeBitMask: eyeData.recomGazeBitMask,
            leftGazeX: eyeData.leftGazeX,
            leftGazeY: eyeData.leftGazeY,
            leftGazeBitMask: eyeData.leftGazeBitMask,
            rightGazeX: eyeData.rightGazeX,
            rightGazeY: eyeData.rightGazeY,
            rightGazeBitMask: eyeData.rightGazeBitMask,
          },
        });
      }, 600);
      if (useFullscreenCalibration && !splitScreenMode) {
        enterCalibrationFullscreen();
      }
      } catch (error) {
        void ipcClient.videoDebugLog({
          event: 'calibration-test:start-error',
          details: { message: error instanceof Error ? error.message : String(error), language },
        });
        showNotice(isEn ? 'Failed to start calibration test.' : '校准测试启动失败。');
      } finally {
        calibrationTestStartingRef.current = false;
      }
    })();
  }, [
    isRecording,
    isCameraOn,
    calibrationCoe,
    calibrationScores,
    loadSavedCalibrationForCurrentSubject,
    recordingSettings.splitScreenMode,
    recordingSettings.bgColor,
    recordingSettings.calibrationPointStyle,
    activeDataDir,
    isEn,
    showNotice,
    applyCalibrationBeforeRecording,
    enterCalibrationFullscreen,
    clearCalibrationFullscreenTimer,
    exitRecordingFullscreen,
    recordingMonitorLayout,
    setRecordingMonitorLayout,
    setRecordingMonitorLayoutResetToken,
    setHiddenRecordingMonitorTileIds,
    hiddenRecordingMonitorTileIds,
    eyeDataStore,
    useFullscreenCalibration,
    isCalibrationTestMode,
    language,
    calibrationState,
    activeDeviceProfile.calibrationMode,
    activeDeviceProfile.deviceType,
    activeDeviceModel,
    handleStartCalibration,
  ]);

  const exitCalibrationTest = useCallback((reason: 'escape' | 'double-click' | 'recording-start'): boolean => {
    if (!isCalibrationTestMode) return false;
    if (activeDeviceModel === 'PupilCore' && calibrationState === 'calibrating') {
      if (calibStateRef.current.timerId) clearTimeout(calibStateRef.current.timerId);
      calibStateRef.current.timerId = null;
      calibStateRef.current.pointPending = false;
      calibStateRef.current.pointAttempt += 1;
      sendCmd('cancel_calibration');
    }
    clearSimulateCalibAnim();
    simulateCalibrationRef.current = { active: false, sequence: [], step: -1 };
    setCalibrationState('none');
    setIsCalibrationTestMode(false);
    setCalibScale(1.0);
    clearCalibrationFullscreenTimer();
    if (useFullscreenCalibration) {
      void exitRecordingFullscreen();
    }
    void ipcClient.videoDebugLog({
      event: 'calibration-test:exit',
      details: { reason, splitScreenMode: Boolean(recordingSettings.splitScreenMode) },
    });
    return true;
  }, [
    isCalibrationTestMode,
    activeDeviceModel,
    calibrationState,
    sendCmd,
    clearSimulateCalibAnim,
    clearCalibrationFullscreenTimer,
    exitRecordingFullscreen,
    recordingSettings.splitScreenMode,
    useFullscreenCalibration,
  ]);

  const askGoCalibration = useCallback(
    (params: { title: string; message: string }): Promise<'calibrate' | 'cancel'> =>
      new Promise((resolve) => {
        let settled = false;
        const finish = (result: 'calibrate' | 'cancel') => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        setConfirmState({
          open: true,
          title: params.title,
          message: params.message,
          onConfirm: () => {
            finish('calibrate');
            void handleStartCalibration();
          },
          onCancel: () => {
            finish('cancel');
          },
          onClose: () => {
            finish('cancel');
          },
          showCancel: true,
          cancelText: isEn ? 'Cancel' : '取消',
          confirmText: isEn ? 'Go calibrate' : '去校准',
          confirmVariant: 'primary',
        });
      }),
    [handleStartCalibration, isEn],
  );

  const handleStartRecording = useCallback(() => {
    if (isRecording || isRecordingFinalizing || recordingFinalizationHandlingRef.current) {
      if (isRecordingFinalizing || recordingFinalizationHandlingRef.current) {
        showNotice(
          isEn ? 'The previous recording is still being saved. Please wait.' : '上一段录制仍在保存中，请等待保存完成。',
          isEn ? 'Saving recording' : '正在保存录制',
        );
      }
      return;
    }
    if (startRecordingInFlightRef.current) return;
    clearPendingRecordRefreshTimers();
    startRecordingInFlightRef.current = true;

    void (async () => {
      const operationId = recordingLifecycle.createOperationId();
      try {
        if (isCalibrationTestMode) {
          exitCalibrationTest('recording-start');
          // Let React commit the normal monitor/stimulus state before the
          // recording pipeline starts playback on the participant display.
          await new Promise<void>((resolve) => {
            window.requestAnimationFrame(() => resolve());
          });
        }
        const isFacialTileVisible = hasFacialExpressionModality && !hiddenRecordingMonitorTileIds.includes('facial');
        const isDeviceTileVisible = hasEyeTrackingModality && !hiddenRecordingMonitorTileIds.includes('device');

        // Facial-only mode: no eye tracking, just facial capture
        if (!isDeviceTileVisible && isFacialTileVisible) {
          if (!facialSettings.enabled) {
            showNotice(isEn ? 'The facial module is disabled.' : '表情模块已关闭，请先在右侧启用。');
            return;
          }
          if (!activeDataDir) {
            showNotice(
              isEn ? 'No project directory found. Please open a project first.' : '未找到项目目录，请先打开项目。',
            );
            return;
          }
          const facialRecordId = generateFacialRecordName();
          const started = await startFacialAutoCapture(facialRecordId);
          if (started) {
            recordingMetaPendingRef.current = null;
            recordingLifecycle.begin(operationId);
            recordingLifecycle.confirmStart(operationId, facialRecordId, '');
            showNotice(
              isEn ? 'Facial recording started.' : '表情录制已开始。',
              isEn ? 'Recording started' : '录制开始',
            );
          }
          return;
        }

        if (!isCameraOn) {
          showNotice(
            isEn ? 'Device is not started. Click "Start device" before recording.' : '设备未开启，请先点击“启动设备”后再开始录制。',
            isEn ? 'Start device first' : '请先开启设备',
          );
          return;
        }

        let reusableCoe = typeof calibrationCoe === 'string' ? calibrationCoe.trim() : '';
        if (!reusableCoe) {
          const savedCalibration = await loadSavedCalibrationForCurrentSubject();
          if (savedCalibration.coe) {
            reusableCoe = savedCalibration.coe;
            setCalibrationCoe(savedCalibration.coe);
          }
          if (savedCalibration.scores) {
            setCalibrationScores(savedCalibration.scores);
          }
        }
        if (!reusableCoe) {
          await askGoCalibration({
            title: isEn ? 'No saved calibration found' : '未检测到历史校准',
            message: isEn
              ? 'No reusable calibration data found in current experiment. Please calibrate before recording.'
              : '当前实验未发现可复用的校准数据，请先执行校准，再开始录制。',
          });
          return;
        }

        const ensureResult = await applyCalibrationBeforeRecording(reusableCoe);
        if (!ensureResult.ok) {
          await askGoCalibration({
            title: isEn ? 'Calibration is not active' : '校准结果未生效',
            message: isEn
              ? `Failed to apply saved calibration: ${ensureResult.error || 'Unknown error'}\n\nPlease recalibrate before recording.`
              : `历史校准应用失败：${ensureResult.error || '未知错误'}\n\n请重新校准后再开始录制。`,
          });
          return;
        }

        await startRecordingCore(operationId);

        window.setTimeout(() => {
          const eyeData = eyeDataStore.getSnapshot();
          void ipcClient.videoDebugLog({
            event: 'recording:gaze-snapshot',
            details: {
              eyeWsReadyState: wsEyeRef.current?.readyState ?? null,
              recomGazeX: eyeData.recomGazeX,
              recomGazeY: eyeData.recomGazeY,
              recomGazeBitMask: eyeData.recomGazeBitMask,
              leftGazeX: eyeData.leftGazeX,
              leftGazeY: eyeData.leftGazeY,
              leftGazeBitMask: eyeData.leftGazeBitMask,
              rightGazeX: eyeData.rightGazeX,
              rightGazeY: eyeData.rightGazeY,
              rightGazeBitMask: eyeData.rightGazeBitMask,
            },
          });
        }, 600);

        if (activeDeviceType !== '眼镜式') {
          const postStartEnsure = await applyCalibrationBeforeRecording(reusableCoe);
          if (!postStartEnsure.ok) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 220));
            const retryEnsure = await applyCalibrationBeforeRecording(reusableCoe);
            if (!retryEnsure.ok) {
              showNotice(
                isEn
                  ? `Recording has started, but saved calibration activation failed: ${retryEnsure.error || postStartEnsure.error || 'Unknown error'}.\nPlease stop this recording and recalibrate before recording again.`
                  : `录制已开始，但历史校准激活失败：${retryEnsure.error || postStartEnsure.error || '未知错误'}。\n请停止本次录制并重新校准后再录制。`,
                isEn ? 'Calibration tracking is not active' : '校准跟踪未生效',
              );
            }
          }
        }
      } catch (error: unknown) {
        const message = getUnknownErrorMessage(error, isEn ? 'Unknown error' : '未知错误');
        recordingLifecycle.abort(operationId, message);
        showNotice(isEn ? `Failed to start recording: ${message}` : `开始录制失败：${message}`);
      } finally {
        startRecordingInFlightRef.current = false;
      }
    })();
  }, [
    isRecording,
    isRecordingFinalizing,
    isCameraOn,
    calibrationCoe,
    loadSavedCalibrationForCurrentSubject,
    applyCalibrationBeforeRecording,
    isEn,
    askGoCalibration,
    startRecordingCore,
    showNotice,
    clearPendingRecordRefreshTimers,
    activeDeviceType,
    isCalibrationTestMode,
    exitCalibrationTest,
    eyeDataStore,
    hiddenRecordingMonitorTileIds,
    activeDataDir,
    startFacialAutoCapture,
    facialSettings.enabled,
    hasEyeTrackingModality,
    hasFacialExpressionModality,
    recordingLifecycle.createOperationId,
    recordingLifecycle.begin,
    recordingLifecycle.confirmStart,
    recordingLifecycle.abort,
  ]);

  const scheduleRefreshRecordsAfterStop = useCallback(() => {
    const projectDir = activeDataDir || '';
    if (!projectDir) return;
    clearPendingRecordRefreshTimers();
    const retryDelays = [250, 900, 1800, 3500, 7000, 12000, 20000, 30000];
    retryDelays.forEach((delay) => {
      const timerId = window.setTimeout(() => {
        if (isRecordingStateRef.current) return;
        loadRecordsForProject({ projectDir, setRecords }).catch(() => {});
      }, delay);
      pendingRecordRefreshTimersRef.current.push(timerId);
    });
  }, [activeDataDir, clearPendingRecordRefreshTimers]);

  const handleStopRecording = useCallback(() => {
    if (!isRecording || isRecordingFinalizing) return;
    if (stopRecordingInFlightRef.current) return;
    const operationId = recordingLifecycle.state.operationId;
    if (!operationId) return;
    stopRecordingInFlightRef.current = true;
    recordingLifecycle.requestStop(operationId);
    void (async () => {
      const isDeviceTileVisible = hasEyeTrackingModality && !hiddenRecordingMonitorTileIds.includes('device');

      // 同时发出表情和眼动的停止指令，不互相阻塞
      const hadFacialCapture = facialAutoCaptureActiveRef.current;
      const facialStopPromise = hadFacialCapture ? stopFacialAutoCapture() : Promise.resolve({ ok: true });

      // Facial-only mode: no eye tracking, just stop facial and reset states
      if (!isDeviceTileVisible && hadFacialCapture) {
        const facialStopResult = await facialStopPromise;
        // 同步关闭表情设备（预览 + 摄像头），与点击"停止设备"的行为一致
        await stopFacialPreview();
        setIsCameraOn(false);
        recordingLifecycle.acceptStop(operationId);
        setIsRecordingCaptureReady(false);
        setPlaybackIndex(null);
        playbackOrderRef.current = null;
        playbackSequenceRef.current = null;
        if (!facialStopResult.ok) {
          const message = facialStopResult.message || '表情视频保存失败';
          recordingLifecycle.failFinalize(operationId, message);
          showNotice(message, isEn ? 'Failed to save recording' : '录制保存失败');
          return;
        }
        recordingLifecycle.finalize(operationId);
        // The eye-tracking path refreshes the record list via the finalization
        // effect; facial-only recordings never reach it, so refresh here once
        // the facial manifest has been written to disk.
        scheduleRefreshRecordsAfterStop();
        return;
      }

      let stopCommandConfirmed = simulateMode;
      let stopCommandError = '';
      if (!simulateMode) {
        try {
          const stopRsp = await sendCmdWithResponse({
            wsCmdRef,
            id: 'stop_recording',
            args: {},
            timeoutMs: 3000,
          });
          if (!stopRsp.ok) {
            stopCommandError = stopRsp.error || '停止命令未返回确认';
          } else {
            stopCommandConfirmed = true;
            void ipcClient.videoDebugLog({
              event: 'recording:stop-accepted',
              details: {
                operationId,
                status: stopRsp.response?.status || null,
                message: stopRsp.response?.msg || null,
                recordingId: stopRsp.response?.recording_id || recordingLifecycle.state.recordingId || null,
                videoPath: stopRsp.response?.video_path || recordingLifecycle.state.videoPath || null,
              },
            });
          }
        } catch (error: unknown) {
          stopCommandError = getUnknownErrorMessage(error, isEn ? 'Unknown error' : '未知错误');
        }

        if (!stopCommandConfirmed) {
          stopCommandConfirmed = await sendCmdThroughTransientSocket('stop_recording', 1800);
          void ipcClient.videoDebugLog({
            event: 'recording:stop-response-unknown',
            details: {
              operationId,
              recoveredByTransientSocket: stopCommandConfirmed,
              error: stopCommandError || null,
            },
          });
        }

        // A missing response is an unknown outcome, not a rejected stop. Enter
        // finalization so status polling and disk reconciliation can recover
        // files that were saved after the response channel disappeared.
        recordingFinalizingProjectDirRef.current = activeDataDir || null;
        void stopActiveAudioCapture();
        showNotice(
          stopCommandConfirmed
            ? (isEn
                ? 'The recording has stopped. The video and eye-tracking data are being saved; please do not close the application.'
                : '录制已停止，正在保存视频和眼动数据，请勿关闭程序。')
            : (isEn
                ? 'The stop response was not received. The application is checking the service and saved files; please do not close it.'
                : '停止命令未返回确认，正在核对服务状态和已保存文件，请勿关闭程序。'),
          isEn ? 'Saving recording' : '正在保存录制',
        );
      }

      recordingLifecycle.acceptStop(operationId);
      // Both recorders are allowed to finalize in parallel, but the recording
      // lifecycle does not finish until the facial artifact is settled.
      const facialStopResult = await facialStopPromise;
      scheduleRefreshRecordsAfterStop();
      if (!facialStopResult.ok) {
        showNotice(
          facialStopResult.message || (isEn ? 'Failed to save the facial video.' : '表情视频保存失败。'),
          isEn ? 'Facial recording failed' : '表情录制失败',
        );
      }
      setIsRecordingCaptureReady(false);
      setPlaybackIndex(null);
      playbackOrderRef.current = null;
      playbackSequenceRef.current = null;

      const isGlasses = activeDeviceType === '眼镜式';
      if (simulateMode) setIsCameraOn(false);
      if (isGlasses) {
        setEyeData(createEmptyEyeData());
        setLastImageAt(null);
        closeEncodedVideoPreview();
        closeWebSocketRef(wsImageRef);
        if (imageCanvasRef.current) {
          imageCanvasRef.current.src = '';
        }
      }

      if (document.fullscreenElement) {
        try {
          await document.exitFullscreen();
        } catch {
        }
      }
      if (ipcClient.isAvailable()) {
        void ipcClient.setWindowFullScreen({ fullscreen: false });
      }
      if (simulateMode) {
        scheduleRefreshRecordsAfterStop();
      }
    })().finally(() => {
      stopRecordingInFlightRef.current = false;
    });
  }, [isRecording, isRecordingFinalizing, isEn, scheduleRefreshRecordsAfterStop, showNotice, simulateMode, activeDeviceType, wsCmdRef, wsImageRef, imageCanvasRef, closeEncodedVideoPreview, stopFacialAutoCapture, stopFacialPreview, sendCmdThroughTransientSocket, hiddenRecordingMonitorTileIds, hasEyeTrackingModality, recordingLifecycle.state.operationId, recordingLifecycle.requestStop, recordingLifecycle.acceptStop, recordingLifecycle.finalize, recordingLifecycle.failFinalize]);

  useEffect(() => {
    if (!recordingFinalizationResult || recordingFinalizationHandlingRef.current) return;
    // Transport event delivery can precede the successful start response. Keep
    // the result pending until confirmation supplies the identity to compare.
    if (recordingLifecycle.state.status === 'preparing') return;
    const result = recordingFinalizationResult;
    const operationId = recordingLifecycle.state.operationId;
    setRecordingFinalizationResult(null);
    if (!operationId || !matchesRecordingFinalization(recordingLifecycle.state, result)) {
      void ipcClient.videoDebugLog({ event: 'recording:finalization-ignored', details: {
        operationId, status: recordingLifecycle.state.status,
        expectedRecordingId: recordingLifecycle.state.recordingId,
        expectedVideoPath: recordingLifecycle.state.videoPath,
        receivedRecordingId: result.recordingId, receivedVideoPath: result.videoPath,
      } });
      return;
    }
    recordingFinalizationHandlingRef.current = true;
    recordingLifecycle.receiveFinalization(operationId, result);
    setIsRecordingCaptureReady(false);

    void (async () => {
      const audioResult = await stopActiveAudioRecording();
      if (!audioResult.ok) {
        showNotice(
          isEn
            ? `The video was saved, but microphone audio could not be merged: ${audioResult.message}`
            : `视频已保存，但麦克风音频合并失败：${audioResult.message}`,
          isEn ? 'Audio save failed' : '音频保存失败',
        );
      }

      setIsCameraOn(false);
      try {
        await stopDeviceGracefully('recording-finalized', 3000);
      } catch (error) {
        console.error('[MrtApp] device shutdown after recording finalization failed:', error);
      } finally {
        recordingFinalizationHandlingRef.current = false;
      }

      const shouldRefreshFinishedProject = recordingFinalizingProjectDirRef.current === (activeDataDir || null);
      recordingFinalizingProjectDirRef.current = null;
      if (!result.ok) {
        recordingCompletionDialogPendingRef.current = false;
        showNotice(
          isEn ? `Recording save failed: ${result.message}` : `录制文件保存失败：${result.message}`,
          isEn ? 'Save failed' : '保存失败',
        );
        return;
      }

      if (shouldRefreshFinishedProject) {
        scheduleRefreshRecordsAfterStop();
      }
      if (recordingCompletionDialogPendingRef.current) {
        recordingCompletionDialogPendingRef.current = false;
        setConfirmState({
          open: true,
          title: isEn ? 'Recording complete' : '录制完成',
          message: isEn ? 'The video and eye-tracking data have been saved.' : '视频和眼动数据已保存完成。',
          showCancel: false,
          confirmText: isEn ? 'Back' : '返回',
          onConfirm: () => {
            setSelectedRecordId(null);
            setActiveTab('monitor' as TabType);
          },
        });
      } else {
        showNotice(
          isEn ? 'The video and eye-tracking data have been saved.' : '视频和眼动数据已保存完成。',
          isEn ? 'Save complete' : '保存完成',
        );
      }
    })();
  }, [
    recordingFinalizationResult,
    activeDataDir,
    isEn,
    scheduleRefreshRecordsAfterStop,
    showNotice,
    stopDeviceGracefully,
    recordingLifecycle.state,
    recordingLifecycle.receiveFinalization,
  ]);

  useEffect(() => {
    if (!isRecordingFinalizing || simulateMode) return;
    let cancelled = false;
    let polling = false;
    let consecutiveIdleResponses = 0;
    const poll = async () => {
      if (cancelled || polling || recordingFinalizationHandlingRef.current) return;
      polling = true;
      try {
        const response = await sendCmdWithResponse({
          wsCmdRef,
          id: 'get_recording_status',
          args: {},
          timeoutMs: 2500,
        });
        const status = response.response?.status;
        const raw = response.response?.result;
        void ipcClient.videoDebugLog({
          event: 'recording:finalization-status',
          details: {
            ok: response.ok,
            error: response.error || null,
            status: status || null,
            hasResult: Boolean(raw && Object.keys(raw).length > 0),
            resultError: raw?.error ?? null,
            resultMessage: raw?.msg ?? null,
            resultRecordingId: raw?.recording_id ?? null,
            resultVideoPath: raw?.video_path ?? null,
            resultCsvPath: raw?.csv_path ?? null,
            idleResponses: consecutiveIdleResponses,
            operationId: recordingLifecycle.state.operationId,
            expectedRecordingId: recordingLifecycle.state.recordingId,
            expectedVideoPath: recordingLifecycle.state.videoPath,
          },
        });
        if (response.ok && status === 'finalized' && raw && !cancelled) {
          consecutiveIdleResponses = 0;
          const error = Number(raw.error ?? -1);
          setRecordingFinalizationResult({
            recordingId: String(raw.recording_id || ''),
            ok: error === 0,
            message: String(raw.msg || (error === 0 ? 'ok' : '录制文件保存失败')),
            videoPath: String(raw.video_path || ''),
            csvPath: String(raw.csv_path || ''),
            videoSize: Number(raw.video_size || 0),
            elapsedMs: Number(raw.elapsed_ms || 0),
          });
        } else if (response.ok && status === 'recording' && !cancelled) {
          consecutiveIdleResponses = 0;
          await sendCmdWithResponse({
            wsCmdRef,
            id: 'stop_recording',
            args: {},
            timeoutMs: 2500,
          });
        } else if (((response.ok && status === 'idle') || !response.ok) && !cancelled) {
          consecutiveIdleResponses += 1;
          if (consecutiveIdleResponses >= FINALIZATION_IDLE_RECOVERY_ATTEMPTS && activeDataDir) {
            const diskResult = await ipcClient.loadRecordings({ projectDir: activeDataDir });
            const diskRecords = diskResult.ok ? mapLoadedRecordings(diskResult.records) : [];
            const recovered = findFinalizedRecordingOnDisk(
              diskRecords,
              recordingLifecycle.state.recordingId,
              recordingLifecycle.state.videoPath,
            );
            if (recovered && !cancelled) {
              void ipcClient.videoDebugLog({
                event: 'recording:finalization-recovered-from-disk',
                details: {
                  idleResponses: consecutiveIdleResponses,
                  recordingId: recordingLifecycle.state.recordingId,
                  expectedVideoPath: recordingLifecycle.state.videoPath,
                  recoveredVideoPath: recovered.mp4Path,
                  recoveredCsvPath: recovered.csvPath,
                },
              });
              setRecordingFinalizationResult({
                recordingId: recordingLifecycle.state.recordingId || recovered.name,
                ok: true,
                message: 'ok',
                videoPath: recovered.mp4Path || recordingLifecycle.state.videoPath || '',
                csvPath: recovered.csvPath || '',
                videoSize: 0,
                elapsedMs: 0,
              });
              return;
            }
          }
          if (consecutiveIdleResponses >= FINALIZATION_IDLE_FAILURE_ATTEMPTS) {
            setRecordingFinalizationResult({
              recordingId: recordingLifecycle.state.recordingId || '',
              ok: false,
              message: isEn
                ? 'The recorder stopped without returning a save result, and no complete video/eye-data pair was found on disk.'
                : '录制服务已停止且未返回保存结果，项目目录中也未找到完整的视频和眼动数据文件。',
              videoPath: recordingLifecycle.state.videoPath || '',
              csvPath: '',
              videoSize: 0,
              elapsedMs: 0,
            });
          }
        } else if (response.ok && status === 'finalizing') {
          consecutiveIdleResponses = 0;
        }
      } finally {
        polling = false;
      }
    };
    void poll();
    const timerId = window.setInterval(() => {
      void poll();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timerId);
    };
  }, [
    activeDataDir,
    isRecordingFinalizing,
    simulateMode,
    isEn,
    recordingLifecycle.state.operationId,
    recordingLifecycle.state.recordingId,
    recordingLifecycle.state.videoPath,
  ]);

  const handleStartPreview = useCallback(async () => {
    if (isRecording || isRecordingFinalizing || isPreviewing) return;
    const randomOrder = Boolean(recordingSettings.randomOrder);
    const sequence = playbackEngine.generatePlaybackSequence(stimuli, randomOrder);
    if (!sequence || sequence.length === 0) {
      showNotice(isEn ? 'No stimuli available for preview.' : '没有刺激物可预览');
      return;
    }
    const initialStimulusId = sequence.find((id) => !String(id).startsWith('GROUP_TRIGGER:'));
    const initialStimulus = initialStimulusId
      ? stimuli.find((item) => item.id === initialStimulusId) || null
      : null;
    const splitScreenMode = Boolean(recordingSettings.splitScreenMode);
    if (ipcClient.isAvailable()) {
      if (splitScreenMode) {
        const result = await ipcClient.createRecordingWindow({
          projectDir: activeDataDir || undefined,
          forceEnable: true,
          initialState: createParticipantWindowState({
            isRecording: true,
            isPreviewing: true,
            stimulus: initialStimulus,
            bgColor: String(recordingSettings.bgColor || '#000000'),
            hideGaze: true,
            calibrationState: 'none',
            calibrationMode: activeDeviceProfile.calibrationMode,
            calibrationPointStyle: normalizeCalibrationPointStyle(recordingSettings.calibrationPointStyle),
            language,
          }),
        });
        if (!result.ok || !result.hasParticipantWindow || result.participantReady === false) {
          const message = !result.ok && 'message' in result ? result.message : undefined;
          showNotice(message || (result.participantReady === false
            ? (isEn ? 'The participant screen did not render its first frame.' : '被试屏未完成首帧显示，请重新打开分屏后重试。')
            : (isEn ? 'Participant screen could not be opened.' : '无法打开被试屏幕，请检查第二显示器连接。')));
          void ipcClient.closeRecordingWindow();
          return;
        }
        void ipcClient.setWindowFullScreen({ fullscreen: false });
      } else {
        void ipcClient.setWindowFullScreen({ fullscreen: true });
      }
    }
    if (!splitScreenMode && !document.fullscreenElement) {
      void document.documentElement.requestFullscreen().catch(() => {});
    }
    playbackSequenceRef.current = sequence;
    setPlaybackIndex(0);
    setIsPreviewing(true);
  }, [isRecording, isRecordingFinalizing, isPreviewing, recordingSettings, showNotice, stimuli, activeDataDir, activeDeviceProfile.calibrationMode, language, isEn]);

  useEffect(() => {
    if (!simulateMode) {
      clearSimulateCalibAnim();
      return;
    }
    if (calibrationState !== 'calibrating' || !simulateCalibrationRef.current.active) {
      clearSimulateCalibAnim();
      return;
    }

    clearSimulateCalibAnim();
    let current = 1.0;
    setCalibScale(1.0);
    const id = window.setInterval(() => {
      current = Math.max(0.14, current - 0.045);
      setCalibScale(current);
    }, 40);
    simulateCalibAnimTimerRef.current = id;

    return () => {
      if (simulateCalibAnimTimerRef.current === id) {
        window.clearInterval(id);
        simulateCalibAnimTimerRef.current = null;
      } else {
        window.clearInterval(id);
      }
    };
  }, [simulateMode, calibrationState, calibPointIndex, clearSimulateCalibAnim]);

  useEffect(() => {
    if (!isFixedRemoteEyeMonitor) return;
    setRecordingMonitorLayout('single');
    setHiddenRecordingMonitorTileIds(['participant', 'facial']);
    setRecordingMonitorLayoutResetToken((value) => value + 1);
    void (async () => {
      if (isFacialCapturing) await stopFacialAutoCapture();
      await stopFacialPreview();
    })();
  }, [isFacialCapturing, isFixedRemoteEyeMonitor, stopFacialAutoCapture, stopFacialPreview]);

  useEffect(() => {
    const lifecycleGeneration = facialPageLifecycleGenerationRef.current + 1;
    facialPageLifecycleGenerationRef.current = lifecycleGeneration;
    if (currentView === 'detail' && activeTab === 'video') {
      // Auto-load facial cameras when entering the monitor tab (only if the
      // facial-expression modality is enabled and the tile is not hidden).
      if (hasFacialExpressionModality && !isFixedRemoteEyeMonitor && !hiddenRecordingMonitorTileIds.includes('facial')) {
        void refreshFacialCameras();
      }
      if (!hasEyeTrackingModality) {
        // A project that has switched to facial-only must not retain the eye
        // sockets or the previous project's device-on state.
        closeEncodedVideoPreview();
        closeWebSocketRef(wsImageRef);
        closeWebSocketRef(wsCmdRef);
        closeWebSocketRef(wsEyeRef);
        setWsConnected(false);
        setVideoPreviewMode('image');
        setVideoPreviewStatus(null);
        setVideoPreviewFrameSize(null);
        setIsCameraOn(Boolean(facialBrowserPreviewRef.current));
      }
      if (!shouldUseLocalRecordingPipeline) {
        return;
      }
    } else {
      // Disconnect if not in video tab
      // 表情模块清理：离开录制页时停止预览和采集
      void (async () => {
        if (isFacialCapturing) {
          await stopFacialAutoCapture();
        }
        await stopFacialPreview();
        // The user may have returned to the recording page while the camera
        // backend was still stopping. Do not let the stale cleanup close the
        // command socket now owned by the new page lifecycle.
        if (facialPageLifecycleGenerationRef.current !== lifecycleGeneration) return;
        closeWebSocketRef(facialWsCmdRef);
      })();

      if (wsImageRef.current || encodedVideoPreviewRef.current || wsCmdRef.current || wsEyeRef.current) {
        closeEncodedVideoPreview();
        closeWebSocketRef(wsImageRef);
        if (!isRecordingFinalizing) {
          closeWebSocketRef(wsCmdRef);
        }
        closeWebSocketRef(wsEyeRef);
        setWsConnected(false);
        setVideoPreviewMode('image');
        setVideoPreviewStatus(null);
        setVideoPreviewFrameSize(null);
      }
    }
  }, [currentView, activeTab, connectWebSocket, connectCmdWs, connectEyeWs, simulateMode, closeEncodedVideoPreview, shouldUseLocalRecordingPipeline, isFixedRemoteEyeMonitor, isRecordingFinalizing, hasEyeTrackingModality, hasFacialExpressionModality, hiddenRecordingMonitorTileIds]);
 
  useEffect(() => {
    const exitActiveCalibrationOverlay = (reason: 'escape' | 'double-click') => {
      if (calibrationState !== 'calibrating' && calibrationState !== 'finished') return false;
      if (isCalibrationTestMode) {
        return exitCalibrationTest(reason);
      } else {
        handleCancelCalibration();
      }
      return true;
    };
     const onKeyDown = (e: KeyboardEvent) => {
      if (simulateMode && (e.code === 'Space' || e.key === ' ')) {
        if (calibrationState === 'calibrating' && simulateCalibrationRef.current.active) {
          e.preventDefault();
          const seq = simulateCalibrationRef.current.sequence;
          const nextStep = simulateCalibrationRef.current.step + 1;
          if (nextStep >= seq.length) {
            simulateCalibrationRef.current.step = seq.length;
            setCalibScale(1.0);
            setCalibrationState('finished');
            return;
          }
          simulateCalibrationRef.current.step = nextStep;
          const nextPointIndex = seq[nextStep] ?? 4;
          calibStateRef.current.arrIndex = nextPointIndex;
          calibStateRef.current.pointIndex = nextStep + 1;
          setCalibPointIndex(nextPointIndex);
          setCalibScale(1.0);
          return;
        }
      }

      if (e.key === 'Escape') {
        if (exitActiveCalibrationOverlay('escape')) {
          e.preventDefault();
          e.stopPropagation();
        }
       }
     };
    const onDoubleClick = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (exitActiveCalibrationOverlay('double-click')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onFullChange = () => {
      if (!useFullscreenCalibration) {
        return;
      }
      if (!document.fullscreenElement) {
        if (calibrationState === 'calibrating' || calibrationState === 'finished') {
          clearSimulateCalibAnim();
          simulateCalibrationRef.current = { active: false, sequence: [], step: -1 };
          setCalibrationState('none');
          setIsCalibrationTestMode(false);
          setCalibScale(1.0);
          clearCalibrationFullscreenTimer();
          if (ipcClient.isAvailable()) {
            void ipcClient.setWindowFullScreen({ fullscreen: false });
          }
        }
      }
    };
     window.addEventListener('keydown', onKeyDown);
     window.addEventListener('dblclick', onDoubleClick, true);
     document.addEventListener('fullscreenchange', onFullChange);
     return () => {
       window.removeEventListener('keydown', onKeyDown);
       window.removeEventListener('dblclick', onDoubleClick, true);
       document.removeEventListener('fullscreenchange', onFullChange);
     };
  }, [
    calibrationState,
    handleCancelCalibration,
    isCalibrationTestMode,
    exitCalibrationTest,
    simulateMode,
    clearSimulateCalibAnim,
    clearCalibrationFullscreenTimer,
    exitRecordingFullscreen,
    useFullscreenCalibration,
  ]);

  useEffect(() => {
    const overlayActiveNow = isRecording || isPreviewing || calibrationState !== 'none';
    const wasOverlayActive = overlayActiveRef.current;
    overlayActiveRef.current = overlayActiveNow;
    if (!wasOverlayActive || overlayActiveNow) return;

    const activeEl = document.activeElement;
    if (activeEl instanceof HTMLElement) {
      activeEl.blur();
    }
  }, [isRecording, isPreviewing, calibrationState]);

  useEffect(() => {
    if (!isRecording) return;
    if (isPreviewing) return;
    if (activeDeviceProfile.stimulusEnabled) return;
    if (!Boolean(recordingSettings.endOnKey)) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      handleStopRecording();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [isRecording, isPreviewing, activeDeviceProfile.stimulusEnabled, recordingSettings, handleStopRecording]);

  // Custom marker keyboard handler
  useEffect(() => {
    if (!isRecording || !isRecordingCaptureReady) return;

    const normalizeKeyToken = (value: string): string => {
      const raw = String(value || '').trim();
      if (!raw) return '';
      const lower = raw.toLowerCase();
      if (lower === ' ') return 'space';
      if (lower === 'spacebar') return 'space';
      if (lower === 'esc') return 'escape';
      if (lower === 'left') return 'arrowleft';
      if (lower === 'right') return 'arrowright';
      if (lower === 'up') return 'arrowup';
      if (lower === 'down') return 'arrowdown';
      return lower;
    };

    const keyFromCode = (code: string): string => {
      const raw = String(code || '').trim();
      if (!raw) return '';
      if (/^Key[A-Z]$/.test(raw)) return raw.slice(3).toLowerCase();
      if (/^Digit[0-9]$/.test(raw)) return raw.slice(5);
      if (/^Numpad[0-9]$/.test(raw)) return raw.slice(6);
      if (raw === 'Space') return 'space';
      return raw;
    };

    const markerMatches = (markerKey: string, event: KeyboardEvent): boolean => {
      const markerToken = normalizeKeyToken(markerKey);
      if (!markerToken) return false;
      const eventKeyToken = normalizeKeyToken(event.key);
      if (eventKeyToken && markerToken === eventKeyToken) return true;
      const eventCodeToken = normalizeKeyToken(keyFromCode(event.code));
      return !!eventCodeToken && markerToken === eventCodeToken;
    };

    const getRecordingElapsedMs = (): number => {
      const startedAt = recordingMetaPendingRef.current?.startedAtMs;
      if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return 0;
      return Math.max(0, Math.round(Date.now() - startedAt));
    };

    const activeMarkers = customMarkers.filter(
      (marker) =>
        marker &&
        marker.active === true &&
        typeof marker.name === 'string' &&
        marker.name.trim().length > 0 &&
        typeof marker.key === 'string' &&
        marker.key.trim().length > 0,
    );
    const activeMarkerNames = new Set(activeMarkers.map((marker) => marker.name));
    for (const name of Array.from(activeCustomMarkersRef.current)) {
      if (!activeMarkerNames.has(name)) {
        activeCustomMarkersRef.current.delete(name);
      }
    }
    for (const name of Array.from(activeContinuousMarkersRef.current)) {
      if (!activeMarkerNames.has(name)) {
        activeContinuousMarkersRef.current.delete(name);
      }
    }
    for (const name of Array.from(pendingInstantMarkersRef.current)) {
      if (!activeMarkerNames.has(name)) {
        pendingInstantMarkersRef.current.delete(name);
      }
    }
    if (activeMarkers.length === 0) {
      activeCustomMarkersRef.current.clear();
      activeContinuousMarkersRef.current.clear();
      pendingInstantMarkersRef.current.clear();
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      for (const marker of activeMarkers) {
        if (markerMatches(marker.key, e)) {
          if (marker.type === 'instant') {
            if (e.repeat) continue;
            // Instant marker: record once on the next sample row
            pendingInstantMarkersRef.current.add(marker.name);
            sendCmd('add_custom_marker', {
              name: marker.name,
              timestamp: getRecordingElapsedMs(),
            });
          } else if (marker.type === 'continuous') {
            if (e.repeat) continue;
            // Continuous marker: add on keydown
            const wasActive = activeCustomMarkersRef.current.has(marker.name);
            activeCustomMarkersRef.current.add(marker.name);
            activeContinuousMarkersRef.current.add(marker.name);
            if (!wasActive) {
              sendCmd('add_custom_marker', {
                name: marker.name,
                timestamp: getRecordingElapsedMs(),
              });
            }
          }
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      for (const marker of activeMarkers) {
        if (marker.type === 'continuous' && markerMatches(marker.key, e)) {
          // Continuous marker: remove on keyup
          activeCustomMarkersRef.current.delete(marker.name);
          activeContinuousMarkersRef.current.delete(marker.name);
        }
      }
    };

    const handleWindowBlur = () => {
      activeCustomMarkersRef.current.clear();
      activeContinuousMarkersRef.current.clear();
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [isRecording, isRecordingCaptureReady, customMarkers, sendCmd]);

  useEffect(() => {
    if (!isRecording || !isRecordingCaptureReady) return;
    const timerId = window.setInterval(() => {
      if (activeContinuousMarkersRef.current.size === 0) return;
      const startedAt = recordingMetaPendingRef.current?.startedAtMs;
      const timestamp =
        typeof startedAt === 'number' && Number.isFinite(startedAt)
          ? Math.max(0, Math.round(Date.now() - startedAt))
          : 0;
      for (const name of activeContinuousMarkersRef.current) {
        if (typeof name !== 'string' || name.trim().length === 0) continue;
        sendCmd('add_custom_marker', { name, timestamp });
      }
    }, 80);

    return () => {
      window.clearInterval(timerId);
    };
  }, [isRecording, isRecordingCaptureReady, sendCmd]);

  useEffect(() => {
    if (isRecording) return;
    activeCustomMarkersRef.current.clear();
    activeContinuousMarkersRef.current.clear();
    pendingInstantMarkersRef.current.clear();
  }, [isRecording]);

  useMrtAppEvents({
    isRecording,
    isPreviewing,
    isRecordingCaptureReady,
    calibrationState,
    isEnglish: isEn,
    showNotice,
    stopDeviceGracefully,
  });

  const beginRecordingFinalization = useCallback(() => {
    const operationId = recordingLifecycle.state.operationId;
    if (!operationId) return;
    recordingLifecycle.requestStop(operationId);
    recordingLifecycle.acceptStop(operationId);
  }, [recordingLifecycle.state.operationId, recordingLifecycle.requestStop, recordingLifecycle.acceptStop]);

  const setRecordingActiveFromPlayback = useCallback<React.Dispatch<React.SetStateAction<boolean>>>((value) => {
    const next = typeof value === 'function' ? value(isRecording) : value;
    if (!next) beginRecordingFinalization();
  }, [beginRecordingFinalization, isRecording]);

  useEffect(() => {
    return recordingPlaybackEffect({
      playbackIndex,
      isRecording: isRecording || isPreviewing,
      isCaptureReady: isPreviewing ? true : isRecordingCaptureReady,
      stimuli,
      projectDir: isPreviewing ? null : activeDataDir || null,
      sendCmd,
      setPlaybackIndex,
      setIsRecording: isPreviewing ? setIsPreviewing : setRecordingActiveFromPlayback,
      setRecords,
      playbackOrderRef,
      playbackSequenceRef,
      triggerConfig: isPreviewing ? null : triggerConfig,
      externalMarkers: isPreviewing ? false : recordingSettings.externalMarkers,
      globalEndOnClick: recordingSettings.endOnClick,
      globalEndOnKey: recordingSettings.endOnKey,
      previewMode: isPreviewing,
      requestRecordingStop: handleStopRecording,
      onStimulusChange: (stimulusName: string) => {
        currentStimulusNameRef.current = stimulusName;
        const separator = stimulusName.indexOf('::');
        currentStimulusIdRef.current = separator >= 0 ? stimulusName.slice(0, separator) : '';
        currentStimulusStartedAtRef.current = Date.now();
      },
      onTriggerSent: (triggerMark: number) => {
        currentTriggerMarkRef.current = String(triggerMark);
        const startedAt = recordingMetaPendingRef.current?.startedAtMs;
        const timestamp =
          typeof startedAt === 'number' && Number.isFinite(startedAt)
            ? Math.max(0, Math.round(Date.now() - startedAt))
            : 0;
        sendCmd('add_trigger_marker', {
          triggerValue: triggerMark,
          timestamp,
        });
        // Clear trigger mark after 100ms (trigger should only mark the moment)
        setTimeout(() => {
          currentTriggerMarkRef.current = '';
        }, 100);
      },
      onRecordingCompleted: () => {
        if (isPreviewing) return;
        recordingCompletionDialogPendingRef.current = true;
        recordingFinalizingProjectDirRef.current = activeDataDir || null;
        beginRecordingFinalization();
        void stopActiveAudioCapture();
        showNotice(
          isEn
            ? 'Recording has ended. The video and eye-tracking data are being saved; please do not close the application.'
            : '录制已结束，正在保存视频和眼动数据，请勿关闭程序。',
          isEn ? 'Saving recording' : '正在保存录制',
        );
      },
    });
  }, [
    playbackIndex,
    isRecording,
    isPreviewing,
    isRecordingCaptureReady,
    stimuli,
    activeDataDir,
    sendCmd,
    triggerConfig,
    recordingSettings.externalMarkers,
    recordingSettings.endOnClick,
    recordingSettings.endOnKey,
    isEn,
    showNotice,
    beginRecordingFinalization,
    setRecordingActiveFromPlayback,
    handleStopRecording,
  ]);

  const resolveCurrentStimulusForParticipant = useCallback((): ExtendedStimulus | null => {
    if ((!isRecording && !isPreviewing) || playbackIndex === null) return null;
    const sequence = playbackSequenceRef.current;
    if (sequence && sequence.length > 0 && playbackIndex < sequence.length) {
      const stimulusId = sequence[playbackIndex];
      if (typeof stimulusId === 'string' && stimulusId.startsWith('GROUP_TRIGGER:')) {
        return null;
      }
      return stimuli.find((s) => s.id === stimulusId) || null;
    }
    if (playbackIndex >= 0 && playbackIndex < stimuli.length) {
      return stimuli[playbackIndex] || null;
    }
    return null;
  }, [isRecording, isPreviewing, playbackIndex, stimuli]);

  useEffect(() => {
    if (!ipcClient.isAvailable()) return;
    const splitScreenMode = Boolean(recordingSettings.splitScreenMode);
    if (!splitScreenMode) return;
    const shouldSyncParticipant =
      isRecording ||
      isPreviewing ||
      calibrationState !== 'none';
    if (!shouldSyncParticipant) return;
    // The participant output must never contain the operator-only gaze monitor.
    // During calibration tests the external screen keeps the test surface while
    // the operator's participant card renders the live gaze point.
    const hidePreviewGaze = true;

    const syncOnce = async () => {
      const stimulus = resolveCurrentStimulusForParticipant();
      const bgColor = String(recordingSettings.bgColor || '#000000');
      await ipcClient.updateSubjectWindow(createParticipantWindowState({
        isRecording: isRecording || isPreviewing,
        isPreviewing,
        stimulus,
        bgColor,
        hideGaze: hidePreviewGaze,
        calibrationState,
        calibrationMode: activeDeviceProfile.calibrationMode,
        calibPointIndex,
        calibScale,
        calibrationPointStyle: normalizeCalibrationPointStyle(recordingSettings.calibrationPointStyle),
        isCalibrationTestMode,
        language,
      }));
    };

    void syncOnce();
  }, [
    isRecording,
    isPreviewing,
    calibrationState,
    isCalibrationTestMode,
    calibPointIndex,
    calibScale,
    recordingSettings.calibrationPointStyle,
    activeDeviceProfile.deviceType,
    activeDeviceProfile.calibrationMode,
    recordingSettings.bgColor,
    recordingSettings.hideGaze,
    recordingSettings.splitScreenMode,
    language,
    resolveCurrentStimulusForParticipant,
  ]);

  useEffect(() => {
    if (!ipcClient.isAvailable()) return;
    const splitScreenMode = Boolean(recordingSettings.splitScreenMode);
    const shouldKeepParticipantWindow =
      splitScreenMode &&
      (isRecording ||
        isPreviewing ||
        calibrationState !== 'none');
    if (!shouldKeepParticipantWindow) {
      void ipcClient.closeRecordingWindow();
    }
  }, [
    isRecording,
    isPreviewing,
    calibrationState,
    recordingSettings.splitScreenMode,
  ]);

  useEffect(() => {
    const pending = recordingMetaPendingRef.current;
    if (!pending?.confirmed || pending.saving) return;
    if (isRecording || isRecordingFinalizing) return;
    const activeOperation = recordingLifecycle.stateRef.current.operationId;
    if (activeOperation && pending.operationId !== activeOperation) return;
    if (!pending.projectDir || pending.projectDir !== activeDataDir) return;
    if (records.length === 0) return;

    const target = findRecordingMetadataTarget(records, pending);
    if (!target) {
      if (!pending.recordingId && !pending.videoPath && Date.now() - pending.startedAtMs > 30 * 60 * 1000) {
        recordingMetaPendingRef.current = null;
      }
      return;
    }

    const recordName = String(target.name || '').trim();
    if (!recordName) {
      return;
    }

    const detectedSamplingRateHz =
      typeof target.samplingRateHz === 'number' && Number.isFinite(target.samplingRateHz)
        ? target.deviceModel === 'PupilCore' ? target.samplingRateHz : Math.round(target.samplingRateHz)
        : null;
    const effectiveConfiguredSamplingRateHz = pending.configuredSamplingRateHz ?? detectedSamplingRateHz;
    const meta = {
      calibrationLeftScore: pending.calibrationLeftScore,
      calibrationRightScore: pending.calibrationRightScore,
      country: pending.country,
      samplingRateHz: detectedSamplingRateHz,
      configuredSamplingRateHz: effectiveConfiguredSamplingRateHz,
      videoSamplingRateHz: pending.videoSamplingRateHz,
      deviceType: activeDeviceType,
      deviceModel: activeDeviceModel,
      stimuli: pending.stimuli,
    };
    const rawEyeSamples = recordingSettings.saveRawData ? eyeSamplesRef.current : null;
    const isCurrentContext = () => recordingMetadataProjectRef.current === pending.projectDir
      && recordingMetaPendingRef.current === pending
      && (!recordingLifecycle.stateRef.current.operationId
        || recordingLifecycle.stateRef.current.operationId === pending.operationId);
    // Device shutdown resets its lifecycle before the post-save disk refresh.
    // The pending object owns this write until a new recording replaces it.
    pending.saving = true;

    ipcClient
      .saveRecordMeta({ projectDir: pending.projectDir, recordName, meta })
      .then(async (res) => {
        if (!res || !res.ok) return;
        // A delayed save from the previous recording must not consume the next
        // recording's pending metadata or raw sample buffer.
        if (!isCurrentContext()) return;
        setRecords((prev) =>
          !isCurrentContext() ? prev : prev.map((it) =>
            it && it.name === recordName
              ? {
                  ...it,
                  calibrationLeftScore: pending.calibrationLeftScore ?? undefined,
                  calibrationRightScore: pending.calibrationRightScore ?? undefined,
                  country: pending.country ?? undefined,
                  samplingRateHz: detectedSamplingRateHz ?? undefined,
                  configuredSamplingRateHz: effectiveConfiguredSamplingRateHz ?? undefined,
                  deviceType: activeDeviceType,
                  deviceModel: activeDeviceModel,
                }
              : it,
            ),
        );
        if (rawEyeSamples && ipcClient.isAvailable()) {
          const saveResult = await ipcClient.saveEyeDataCsv({
            projectDir: pending.projectDir as string,
            recordName,
            rows: rawEyeSamples,
          });
          if (!saveResult?.ok) {
            console.warn('[MrtApp] save-eye-data-csv failed:', 'message' in saveResult ? saveResult.message : 'unknown');
          }
        }
        // The initial post-recording refresh is also used to identify the new
        // record. Raw-data persistence may replace its CSV afterwards, so load
        // the finalized file once more to keep the in-memory metrics identical
        // to what a manual page refresh computes.
        if (isCurrentContext()) {
          await loadRecordsForProject({ projectDir: pending.projectDir, setRecords: (value) => {
            if (isCurrentContext()) setRecords(value);
          } });
        }
        if (isCurrentContext()) recordingMetaPendingRef.current = null;
      })
      .catch((error) => {
        console.error('[MrtApp] failed to finalize recording metadata:', error);
      })
      .finally(() => {
        pending.saving = false;
      });
  }, [activeDataDir, activeDeviceModel, activeDeviceType, records, isRecording, isRecordingFinalizing, setRecords, recordingSettings, recordingLifecycle.stateRef]);

  const readPinnedProjectDirsFromStorage = (): string[] => {
    try {
      const raw = localStorage.getItem('pinnedProjectDirs');
      if (!raw) return [];
      const arr = JSON.parse(raw) as unknown;
      if (!Array.isArray(arr)) return [];
      return Array.from(new Set(arr.filter((v) => typeof v === 'string' && v.trim().length > 0))) as string[];
    } catch {
      return [];
    }
  };

  const readHiddenProjectDirsFromStorage = (): string[] => {
    try {
      const raw = localStorage.getItem('hiddenProjectDirs');
      if (!raw) return [];
      const arr = JSON.parse(raw) as unknown;
      if (!Array.isArray(arr)) return [];
      return Array.from(new Set(arr.filter((v) => typeof v === 'string' && v.trim().length > 0))) as string[];
    } catch {
      return [];
    }
  };

  const refreshProjectLibrary = async (): Promise<void> => {
    if (!ipcClient.isAvailable()) return;
    const pinned = readPinnedProjectDirsFromStorage();
    const hidden = new Set(readHiddenProjectDirsFromStorage());

    const nextProjects: Project[] = [];
    const nextProjectDirs: Record<string, string> = {};
    const seenDirs = new Set<string>();
    const usedIds = new Set<string>();

    const hashId = (input: string): string => {
      let h = 2166136261;
      for (let i = 0; i < input.length; i += 1) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return Math.abs(h).toString(36);
    };

    const resolveId = (baseId: string, dir: string): string => {
      const cleaned = baseId && baseId.trim().length > 0 ? baseId.trim() : 'project';
      let candidate = cleaned;
      if (usedIds.has(candidate) || (nextProjectDirs[candidate] && nextProjectDirs[candidate] !== dir)) {
        candidate = `${cleaned}_${hashId(dir)}`;
      }
      let i = 2;
      while (usedIds.has(candidate) || (nextProjectDirs[candidate] && nextProjectDirs[candidate] !== dir)) {
        candidate = `${cleaned}_${hashId(dir)}_${i}`;
        i += 1;
      }
      return candidate;
    };

    for (const projectDir of pinned) {
      if (hidden.has(projectDir)) continue;
      if (seenDirs.has(projectDir)) continue;
      const res = await ipcClient.loadProjectMeta({ projectDir });
      if (!res.ok) continue;
      const proj = asUnknownRecord(res.project);
      const rawId = String(proj.id ?? '');
      if (!rawId) continue;
      const id = resolveId(rawId, projectDir);
      usedIds.add(id);
      nextProjectDirs[id] = projectDir;
      nextProjects.push(migrateProject({
        id,
        name: String(proj.name ?? ''),
        code: String(proj.code ?? ''),
        manager: String(proj.manager ?? ''),
        deviceType: proj.deviceType === '眼镜式' ? '眼镜式' : proj.deviceType === '桌面式' ? '桌面式' : undefined,
        deviceModel: proj.deviceModel === 'A8' || proj.deviceModel === 'Pro' || proj.deviceModel === 'aSeeGlassesPlus' || proj.deviceModel === 'PupilCore' || proj.deviceModel === 'HH_ET10C' || proj.deviceModel === 'HH_ET28' ? proj.deviceModel : undefined,
        updatedAt: String(proj.updatedAt ?? ''),
        notes: String(proj.notes ?? ''),
        schemaVersion: proj.schemaVersion === 2 ? 2 : undefined,
        modalities: Array.isArray(proj.modalities) ? proj.modalities as Project['modalities'] : undefined,
      }));
      seenDirs.add(projectDir);
    }

    nextProjects.sort((a, b) => {
      const parseToMs = (s: string): number | null => {
        const raw = String(s || '').trim();
        if (!raw) return null;
        const iso = Date.parse(raw);
        if (Number.isFinite(iso)) return iso;
        const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(raw);
        if (!m) return null;
        const y = Number(m[1]);
        const mo = Number(m[2]);
        const d = Number(m[3]);
        const hh = Number(m[4]);
        const mm = Number(m[5]);
        const ss = Number(m[6]);
        if (![y, mo, d, hh, mm, ss].every((n) => Number.isFinite(n))) return null;
        return new Date(y, mo - 1, d, hh, mm, ss).getTime();
      };
      const atMs = parseToMs(String(a.updatedAt || ''));
      const btMs = parseToMs(String(b.updatedAt || ''));
      if (atMs !== null && btMs !== null) return btMs - atMs;
      const at = String(a.updatedAt || '');
      const bt = String(b.updatedAt || '');
      return bt.localeCompare(at);
    });

    setProjects(nextProjects);
    setProjectDirs(nextProjectDirs);
  };

  const getExperimentStorageKey = (projectDir: string): string => {
    return `activeExperimentId:${projectDir}`;
  };

  const ensureExperimentsLoaded = async (projectDir: string): Promise<{ experiments: Experiment[]; activeId: string; dataDir: string }> => {
    if (!ipcClient.isAvailable()) {
      const exps = [{ id: 'local', name: '实验', dir: projectDir }] as Experiment[];
      return { experiments: exps, activeId: exps[0].id, dataDir: exps[0].dir };
    }
    const res = await ipcClient.listExperiments({ projectDir });
    const exps: Experiment[] = Array.isArray(res.experiments)
      ? (res.experiments as unknown[]).map((value) => {
        const experiment = asUnknownRecord(value);
        return {
          id: String(experiment.id ?? ''),
          name: String(experiment.name ?? ''),
          dir: String(experiment.dir ?? ''),
          createdAt: typeof experiment.createdAt === 'string' ? experiment.createdAt : undefined,
          updatedAt: typeof experiment.updatedAt === 'string' ? experiment.updatedAt : undefined,
          builtin: Boolean(experiment.builtin),
        };
      }).filter((experiment) => experiment.id && experiment.dir)
      : [];
    if (exps.length === 0) {
      return { experiments: [], activeId: '', dataDir: '' };
    }
    let desired = exps[0]?.id || '';
    const saved = localStorage.getItem(getExperimentStorageKey(projectDir));
    if (saved && exps.some((e) => e.id === saved)) desired = saved;
    const active = exps.find((e) => e.id === desired) || exps[0];
    return { experiments: exps, activeId: active.id, dataDir: active.dir };
  };

  // --- Handlers ---
  const handleOpenProject = async (id: string) => {
    const targetProject = projects.find((project) => project.id === id) || null;
    const preparePromise = prepareDataScopeSwitch();

    // Switch the visible project immediately. Device/connection cleanup can take
    // more than a second and must not leave the previous project's title/settings
    // on screen while it completes.
    setHydratingProjectId(id);
    setActiveProjectId(id);
    setEditedProject(targetProject ? { ...targetProject } : null);
    setHasProjectChanges(false);
    setCurrentView('detail');
    setActiveTab('project-settings');
    setExperiments([]);
    setActiveExperimentId('');
    setSelectedRecordId(null);
    setVisibleRecordIds(new Set());
    setHeatmapPointsByRecord({});
    setAoiSelectedRecordId(null);
    setSubjects([]);
    setStimuli([]);
    setRecords([]);
    setChartMode('single');
    setChartPreselectedRecordIds([]);
    setLatestCompareResult(null);
    setLatestInsightReport(null);
    setChartAiBusy(false);
    setChartAiBusyText('');
    setSubjectFields(DEFAULT_SUBJECT_FIELDS);

    await preparePromise;

    try {
      const projectDir = projectDirs[id];
      if (!projectDir) {
        setHydratingProjectId(null);
        return;
      }
      const { experiments: exps, activeId, dataDir } = await ensureExperimentsLoaded(projectDir);
      setExperiments(exps);
      setActiveExperimentId(activeId);
      if (activeId) {
        localStorage.setItem(getExperimentStorageKey(projectDir), activeId);
      } else {
        localStorage.removeItem(getExperimentStorageKey(projectDir));
      }
      if (!dataDir) {
        setNewExperimentName('');
        setIsNewExperimentModalOpen(true);
        return;
      }
      await loadProjectDetailData({ projectDir: dataDir, setSubjects, setSubjectFields, setStimuli, setRecords, setCustomMarkers });
    } catch (error) {
      console.error(error);
    } finally {
      setHydratingProjectId(null);
    }
  };

  const handleCreateProject = async () => {
    const result = await createProject({
      newProjectData,
      projects,
      setProjects,
      setIsNewProjectModalOpen,
      setNewProjectData,
      projectRootPath,
    });
    if (!result) {
      return;
    }
    if (result.projectDir) {
      const projectDir = result.projectDir as string;
      const pinnedProjectDirs = readPinnedProjectDirsFromStorage();
      if (!pinnedProjectDirs.includes(projectDir)) {
        localStorage.setItem('pinnedProjectDirs', JSON.stringify([projectDir, ...pinnedProjectDirs].slice(0, 200)));
      }
      await prepareDataScopeSwitch();
      setProjectDirs((prev) => ({ ...prev, [result.project.id]: projectDir }));
      setHydratingProjectId(result.project.id);
      setActiveProjectId(result.project.id);
      setCurrentView('detail');
      setActiveTab('project-settings');
      try {
        const { experiments: exps, activeId, dataDir } = await ensureExperimentsLoaded(result.projectDir as string);
        setExperiments(exps);
        setActiveExperimentId(activeId);
        if (activeId) {
          localStorage.setItem(getExperimentStorageKey(result.projectDir as string), activeId);
        } else {
          localStorage.removeItem(getExperimentStorageKey(result.projectDir as string));
        }
        setSelectedRecordId(null);
        setVisibleRecordIds(new Set());
        setHeatmapPointsByRecord({});
        setAoiSelectedRecordId(null);
        setSubjects([]);
        setStimuli([]);
        setRecords([]);
        setChartMode('single');
        setChartPreselectedRecordIds([]);
        setLatestCompareResult(null);
        setLatestInsightReport(null);
        setChartAiBusy(false);
        setChartAiBusyText('');
        setSubjectFields(DEFAULT_SUBJECT_FIELDS);
        if (!dataDir) {
          setNewExperimentName('');
          setIsNewExperimentModalOpen(true);
          return;
        }
        await loadProjectDetailData({ projectDir: dataDir, setSubjects, setSubjectFields, setStimuli, setRecords, setCustomMarkers });
      } catch (error) {
        console.error(error);
      } finally {
        setHydratingProjectId(null);
      }
    }
  };

  const handleCreateSubject = () => {
    return createSubject({
      newSubjectData,
      subjectFields,
      subjects,
      setSubjects,
      setIsNewSubjectModalOpen,
      setNewSubjectData,
      onNotify: showNotice,
    });
  };

  const handleOpenEditSubject = (subject: Subject) => {
    return openEditSubject({
      subject,
      subjectFields,
      setEditingSubjectId,
      setEditSubjectData,
      setIsEditSubjectModalOpen,
    });
  };

  const handleSaveEditedSubject = () => {
    return saveEditedSubject({
      editSubjectData,
      editingSubjectId,
      subjects,
      subjectFields,
      setSubjects,
      setIsEditSubjectModalOpen,
      setEditingSubjectId,
      onNotify: showNotice,
    });
  };

  const handleRequestDeleteSubject = (subject: Subject) => {
    return requestDeleteSubject({
      subject,
      setConfirmState,
      setSubjects,
    });
  };

  const handleUpdateProject = (updatedProj: Project) => {
    setProjects(projects.map(p => p.id === updatedProj.id ? { ...updatedProj, updatedAt: new Date().toLocaleString() } : p));
  };

  const handleProjectSettingChange = (field: keyof Project, value: string) => {
    if (editedProject) {
      if (field === 'deviceModel') {
        const deviceModel = normalizeDeviceModel(value, editedProject.deviceType);
        const deviceType = deviceTypeFromModel(deviceModel);
        setEditedProject({
          ...editedProject,
          deviceModel,
          deviceType,
          modalities: editedProject.modalities?.map((item) => item.id === 'eye-tracking'
            ? { ...item, config: { deviceModel, deviceType } }
            : item),
        });
      } else {
        setEditedProject({ ...editedProject, [field]: value });
      }
      setHasProjectChanges(true);
    }
  };

  const handleSaveProjectSettings = () => {
    if (editedProject) {
      const nextProject: Project = { ...editedProject, updatedAt: new Date().toLocaleString() };
      setEditedProject(nextProject);
      const projectDir = activeProjectId ? projectDirs[activeProjectId] : '';
      if (projectDir && ipcClient.isAvailable()) {
        void ipcClient.saveProjectMeta({ projectDir, project: nextProject }).then((res) => {
          if (res.ok) {
            handleUpdateProject(nextProject);
            setHasProjectChanges(false);
          } else {
            showNotice('保存工程信息失败');
          }
        });
      } else {
        handleUpdateProject(nextProject);
        setHasProjectChanges(false);
      }
    }
  };

  const [isDeviceToggling, setIsDeviceToggling] = useState(false);

  const resolveConfiguredFacialCamera = useCallback((cameras: FacialCamera[]): FacialCamera | null => {
    const selected = cameras.find((item) => item.id === facialCameraId);
    if (selected) return selected;
    if (Number.isInteger(facialSettings.cameraIndex)) {
      const configured = cameras.find((item) => item.index === Number(facialSettings.cameraIndex));
      if (configured) return configured;
    }
    return cameras.length === 1 ? cameras[0] : null;
  }, [facialCameraId, facialSettings.cameraIndex]);

  const toggleCamera = useCallback(async () => {
    const connectionGeneration = deviceConnectionGenerationRef.current;
    deviceConnectionRequestedRef.current = !isCameraOn;
    setIsDeviceToggling(true);
    let rollbackPrestartedFacial = false;
    try {
      const isDeviceTileVisible = hasEyeTrackingModality && !hiddenRecordingMonitorTileIds.includes('device');
      const isFacialTileVisible = hasFacialExpressionModality && !isFixedRemoteEyeMonitor && !hiddenRecordingMonitorTileIds.includes('facial');

      // 仅表情模式：跳过眼动设备，只管理表情服务
      if (!isDeviceTileVisible && isFacialTileVisible) {
        // 眼镜式（aSeeGlassesPlus）互斥：切到表情前，先停掉仍在运行的眼动设备，
        // 避免表情摄像头与眼镜场景摄像头同时占用触发 vendor SDK 多摄像头死锁。
        if (activeDeviceType === '眼镜式' && isCameraOn) {
          const stopResult = await toggleCameraMod({ isCameraOn: true, wsCmdRef, setIsCameraOn, timeoutMs: 8000 });
          if (!stopResult.ok) {
            showNotice(stopResult.error || '停止眼动设备失败');
            return;
          }
        }
        const facialDeviceActive = isFacialCapturing
          || facialSessionStatus?.running === true
          || Boolean(facialBrowserPreviewRef.current);
        if (facialDeviceActive) {
          await stopFacialAutoCapture();
          await stopFacialPreview();
          setIsCameraOn(false);
          return;
        }
        const connected = await ensureFacialServerAndConnect();
        if (!connected) {
          showNotice('表情分析服务未启动，请稍后重试');
          return;
        }
        const cameras = await refreshFacialCameras();
        if (cameras.length === 0) {
          showNotice('未检测到表情摄像头，请检查摄像头连接');
          return;
        }
        const camera = resolveConfiguredFacialCamera(cameras);
        if (!camera) {
          showNotice('检测到多个表情摄像头，请先在表情设置中明确选择一个摄像头');
          return;
        }
        const previewStarted = await startFacialPreview(camera.index);
        if (!previewStarted) return;
        setIsCameraOn(true);
        return;
      }

      // 眼动模式（device tile 可见）
      if (!isDeviceTileVisible && !isFacialTileVisible) {
        showNotice('监控面板中没有可用的录制模块，请至少添加眼动检测或表情检测');
        return;
      }

      // 眼镜式（aSeeGlassesPlus）互斥：启动眼动前，先停掉仍在运行的表情采集，
      // 避免表情摄像头与眼镜场景摄像头同时占用触发 vendor SDK 多摄像头死锁。
      if (activeDeviceType === '眼镜式' && (isFacialCapturing || facialSessionStatus?.running === true || Boolean(facialBrowserPreviewRef.current))) {
        await stopFacialAutoCapture();
        await stopFacialPreview();
      }

      // Resolve the independent facial camera before starting the glasses SDK.
      // DirectShow camera probing after the glasses owns its scene devices can
      // block inside the native driver and was observed to close the command WS.
      let facialCameraForStart: FacialCamera | null = null;
      if (!isCameraOn && isFacialTileVisible) {
        const connected = await ensureFacialServerAndConnect();
        if (!connected) {
          showNotice('表情分析服务未启动，请稍后重试');
          return;
        }
        let availableCameras = facialCameras;
        facialCameraForStart = resolveConfiguredFacialCamera(availableCameras);
        if (!facialCameraForStart) {
          availableCameras = await refreshFacialCameras();
          facialCameraForStart = resolveConfiguredFacialCamera(availableCameras);
        }
        if (!facialCameraForStart) {
          showNotice(availableCameras.length > 1
            ? '检测到多个表情摄像头，请先在表情设置中明确选择一个摄像头'
            : '未检测到表情摄像头，请检查摄像头连接');
          return;
        }
      }

      if (!simulateMode) {
        const wsReady = await ensureCmdWsReadyWithRecovery(isCameraOn ? 1200 : 4000);
        if (!wsReady) {
          showNotice(
            isEn
              ? 'Command channel not connected: the eye-tracking service is unresponsive. It has been restarted automatically; please retry shortly, or restart the software.'
              : '命令通道未连接：眼动服务未响应，已尝试自动重启。请稍后重试，若仍失败请重启软件。',
            isEn ? 'Notice' : '提示',
            'danger',
          );
          return;
        }
      }

      let calibrationCoeForStart = calibrationCoe;
      if (!isCameraOn && activeDeviceType === '眼镜式' && !String(calibrationCoeForStart || '').trim()) {
        const savedCalibration = await loadSavedCalibrationForCurrentSubject();
        if (savedCalibration.coe) {
          calibrationCoeForStart = savedCalibration.coe;
          setCalibrationCoe(savedCalibration.coe);
          if (savedCalibration.scores) {
            setCalibrationScores(savedCalibration.scores);
          }
        }
      }

      // On Windows, opening the UVC facial camera after the glasses SDK has
      // acquired its native devices can deadlock below the application layer.
      // Acquire and stabilize the facial camera first; if the glasses startup
      // then fails, the finally block releases it transactionally.
      if (!isCameraOn && facialCameraForStart) {
        const facialStarted = await startFacialPreview(facialCameraForStart.index);
        if (!facialStarted) {
          showNotice('表情预览启动失败，眼动设备未启动');
          return;
        }
        rollbackPrestartedFacial = true;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 400));
      }

      // Release the UVC camera before asking the glasses native SDK to tear
      // down, avoiding simultaneous driver shutdown on the same USB stack.
      if (isCameraOn && isFacialTileVisible) {
        if (isFacialCapturing) await stopFacialAutoCapture();
        await stopFacialPreview();
      }

      if (connectionGeneration !== deviceConnectionGenerationRef.current) return;
      const result = await toggleCameraMod({
        isCameraOn,
        wsCmdRef,
        setIsCameraOn,
        deviceType: activeDeviceType,
        deviceModel: activeDeviceModel,
        sdkEnvironment: recordingSettings.sdkEnvironment,
        sdkResolution: recordingSettings.sdkResolution,
        calibrationCoe: calibrationCoeForStart,
        timeoutMs: activeDeviceType === '眼镜式'
          ? (isCameraOn ? 8000 : 30000)
          : (isCameraOn ? 3000 : 12000),
        trackingTimeoutMs: activeDeviceType === '眼镜式' ? 15000 : 2000,
      });
      if (connectionGeneration !== deviceConnectionGenerationRef.current) {
        await stopDeviceGracefully('navigate-away', 1600);
        return;
      }
      if (!result.ok) {
        showNotice(result.error || (isCameraOn ? '停止设备失败' : '启动设备失败'));
        return;
      }
      rollbackPrestartedFacial = false;
      if (['PupilCore', 'HH_ET10C', 'HH_ET28'].includes(activeDeviceModel)) {
        activeTrackingCoeRef.current = null;
        setCalibrationCoe(null);
        setCalibrationScores(null);
        setCalibrationState('none');
      } else if (!isCameraOn && !result.trackingError) {
        const activatedCoe = typeof calibrationCoeForStart === 'string' ? calibrationCoeForStart.trim() : '';
        if (activatedCoe) {
          activeTrackingCoeRef.current = activatedCoe;
        }
      }
      if (result.trackingError) {
        showNotice(`设备已启动，但恢复上次校准结果失败：${result.trackingError}`);
      }

      // Re-evaluate the glasses preview after startup. Combined mode keeps the
      // live decoder suspended; eye-only mode may use WebCodecs when GPU safe
      // mode is explicitly disabled for validated hardware.
      if (!isCameraOn) {
        webCodecsImageFallbackRef.current = false;
        connectWebSocket('device-start-completed');
      }

    } finally {
      if (rollbackPrestartedFacial) await stopFacialPreview();
      setIsDeviceToggling(false);
    }
  }, [
    recordingSettings.sdkEnvironment,
    recordingSettings.sdkResolution,
    activeDeviceModel,
    activeDeviceType,
    calibrationCoe,
    facialCameras,
    ensureCmdWsReadyWithRecovery,
    isCameraOn,
    isEn,
    loadSavedCalibrationForCurrentSubject,
    showNotice,
    simulateMode,
    isFixedRemoteEyeMonitor,
    hiddenRecordingMonitorTileIds,
    hasEyeTrackingModality,
    hasFacialExpressionModality,
    isFacialCapturing,
    facialSessionStatus?.running,
    ensureFacialServerAndConnect,
    refreshFacialCameras,
    resolveConfiguredFacialCamera,
    stopFacialAutoCapture,
    setIsCameraOn,
    stopFacialPreview,
    startFacialPreview,
    connectWebSocket,
    stopDeviceGracefully,
  ]);

  const hasDuplicateStimulusName = useCallback(
    (name: string, excludeId?: string) => {
      const normalizedName = normalizeNameForCompare(name);
      if (!normalizedName) {
        return false;
      }
      return stimuli.some((item) => item.id !== excludeId && normalizeNameForCompare(item.name) === normalizedName);
    },
    [stimuli],
  );

  const findUploadDuplicateNames = useCallback(
    (files: FileList): string[] => {
      const existing = new Set(stimuli.map((item) => normalizeNameForCompare(item.name)));
      const selection = new Set<string>();
      const duplicates: string[] = [];
      for (let i = 0; i < files.length; i += 1) {
        const file = files.item(i);
        if (!file) continue;
        const baseName = String(file.name || '').replace(/\.[^/.]+$/, '').trim();
        const normalized = normalizeNameForCompare(baseName);
        if (!normalized) continue;
        if (existing.has(normalized) || selection.has(normalized)) {
          duplicates.push(baseName || file.name);
          continue;
        }
        selection.add(normalized);
      }
      return Array.from(new Set(duplicates));
    },
    [stimuli],
  );

  const handleUploadStimuli = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      const duplicatedNames = findUploadDuplicateNames(files);
      if (duplicatedNames.length > 0) {
        showNotice(`刺激物名称重复：${duplicatedNames.join('、')}。请修改后再上传。`);
        event.target.value = '';
        return;
      }
    }
    await uploadStimuli({ event, projectDir: activeDataDir || null, setStimuli, group: currentStimulusGroup });
    setStimuliSaveHint(isEn ? 'Saved' : '已保存');
    setIsAddStimulusModalOpen(false);
    setAddStimulusName('');
    setAddStimulusText('');
    setAddStimulusWebUrl('');
  };

  const handleStartScreenRecordingStimulus = async (nameValue: string) => {
    const projectDir = activeDataDir || '';
    if (!projectDir) {
      showNotice('请先打开一个工程，然后再录制屏幕刺激物');
      return { ok: false as const, message: '请先打开一个工程' };
    }
    const baseName = String(nameValue || '').trim();
    if (baseName && hasDuplicateStimulusName(baseName)) {
      showNotice(`刺激物名称「${baseName}」已存在，请使用其他名称`);
      return { ok: false as const, message: `刺激物名称「${baseName}」已存在` };
    }
    if (!ipcClient.isAvailable()) {
      showNotice('Electron IPC 不可用，无法保存录屏刺激物');
      return { ok: false as const, message: 'Electron IPC 不可用' };
    }
    const result = await ipcClient.startStimulusScreenRecording({
      projectDir,
      name: baseName,
      group: currentStimulusGroup || undefined,
    });
    if (!result.ok) {
      const msg = 'message' in result ? result.message : '';
      showNotice(isEn ? `Screen recording start failed: ${msg || 'unknown error'}` : `录屏启动失败：${msg || '未知错误'}`);
    }
    return result;
  };

  const handleStopScreenRecordingStimulus = async (sessionId: string) => {
    const result = await ipcClient.stopStimulusScreenRecording({ sessionId });
    if (result.ok && Array.isArray(result.stimuli)) {
      setStimuli(normalizeStimuliOrders(result.stimuli));
      setStimuliSaveHint(isEn ? 'Saved' : '已保存');
      setIsAddStimulusModalOpen(false);
      setAddStimulusName('');
      setAddStimulusText('');
      setAddStimulusWebUrl('');
      return { ok: true as const };
    } else {
      const msg = 'message' in result ? result.message : '';
      showNotice(isEn ? `Screen recording save failed: ${msg || 'unknown error'}` : `录屏保存失败：${msg || '未知错误'}`);
      return { ok: false as const, message: msg || '录屏保存失败' };
    }
  };

  const normalizeStimuliOrders = (items: unknown): ExtendedStimulus[] => {
    if (!Array.isArray(items)) return [];
    const next = items.map((value, index) => {
      const stimulus = asUnknownRecord(value);
      return {
        ...stimulus,
        randomPlay: stimulus.randomPlay === true,
        endOnClick: stimulus.endOnClick === true,
        endOnKey: stimulus.endOnKey === true,
        playToEnd: stimulus.stimulusType === 'video' || stimulus.stimulusType === 'audio' ? stimulus.playToEnd !== false : false,
        order: typeof stimulus.order === 'number' && Number.isFinite(stimulus.order) ? stimulus.order : index + 1,
      } as unknown as ExtendedStimulus;
    });
    next.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    return next.map((stimulus, index) => ({ ...stimulus, order: index + 1 }));
  };

  const persistStimuliList = async (nextStimuli: ExtendedStimulus[]) => {
    setStimuli(nextStimuli);
    try {
      const projectDir = activeDataDir || '';
      if (projectDir && ipcClient.isAvailable()) {
        const res = await ipcClient.saveStimuliDetailed({ projectDir, stimuli: nextStimuli });
        if (res.ok) {
          setStimuliSaveHint(isEn ? 'Saved' : '已保存');
        } else {
          const msg = 'message' in res ? res.message : undefined;
          setStimuliSaveHint(isEn ? `Save failed: ${msg || 'save-stimuli returned failure'}` : `保存失败：${msg || 'save-stimuli 返回失败'}`);
        }
      } else {
        setStimuliSaveHint(isEn ? 'Save failed: project directory not found or IPC unavailable' : '保存失败：未找到工程目录或 ipc 不可用');
      }
    } catch {
      setStimuliSaveHint(isEn ? 'Save failed: unexpected error' : '保存失败：发生异常');
    }
  };

  const handleAddTextStimulus = async () => {
    const text = (addStimulusText || '').trim();
    if (!text) {
      showNotice('请输入文字内容');
      return;
    }
    const now = new Date();
    const dateLabel = now.toISOString().slice(0, 10);
    const fallbackName = text.split(/\r?\n/)[0]?.slice(0, 20) || '文字刺激';
    const name = (addStimulusName || '').trim() || fallbackName;
    if (hasDuplicateStimulusName(name)) {
      showNotice(`刺激物名称「${name}」已存在，请使用其他名称`);
      return;
    }
    const id = `stim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const next = normalizeStimuliOrders([
      ...stimuli,
      {
        id,
        name,
        url: '',
        text,
        stimulusType: 'text',
        active: true,
        randomPlay: false,
        endOnClick: false,
        endOnKey: false,
        size: '',
        date: dateLabel,
        group: currentStimulusGroup || '',
      },
    ]);
    await persistStimuliList(next);
    setIsAddStimulusModalOpen(false);
    setAddStimulusName('');
    setAddStimulusText('');
    setAddStimulusWebUrl('');
  };

  const handleAddWebStimulus = async () => {
    const raw = (addStimulusWebUrl || '').trim();
    if (!raw) {
      showNotice('请输入网址');
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) {
      showNotice('网址只支持 http 或 https');
      return;
    }
    const url = normalizeWebStimulusUrl(raw);
    let fallbackName = 'Web 刺激';
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        showNotice('网址只支持 http 或 https');
        return;
      }
      fallbackName = u.hostname || fallbackName;
    } catch {
      showNotice('请输入有效的网址');
      return;
    }
    const name = (addStimulusName || '').trim() || fallbackName;
    if (hasDuplicateStimulusName(name)) {
      showNotice(`刺激物名称「${name}」已存在，请使用其他名称`);
      return;
    }
    const now = new Date();
    const dateLabel = now.toISOString().slice(0, 10);
    const id = `stim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const next = normalizeStimuliOrders([
      ...stimuli,
      {
        id,
        name,
        url,
        stimulusType: 'web',
        active: true,
        randomPlay: false,
        endOnClick: false,
        endOnKey: false,
        size: '',
        date: dateLabel,
        group: currentStimulusGroup || '',
      },
    ]);
    await persistStimuliList(next);
    setIsAddStimulusModalOpen(false);
    setAddStimulusName('');
    setAddStimulusText('');
    setAddStimulusWebUrl('');
  };

  const handleAddGroupStimulus = async () => {
    const name = (addStimulusName || '').trim();
    if (!name) {
      showNotice('请输入组合名称');
      return;
    }
    if (hasDuplicateStimulusName(name)) {
      showNotice(`组合名称「${name}」已存在，请使用其他名称`);
      return;
    }
    const now = new Date();
    const dateLabel = now.toISOString().slice(0, 10);
    const id = `group_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const next = normalizeStimuliOrders([
      ...stimuli,
      {
        id,
        name,
        url: '',
        stimulusType: 'group',
        active: true,
        randomPlay: false,
        endOnClick: false,
        endOnKey: false,
        size: '-',
        date: dateLabel,
        group: currentStimulusGroup || '',
      },
    ]);
    await persistStimuliList(next);
    setIsAddStimulusModalOpen(false);
    setAddStimulusName('');
    setAddStimulusText('');
    setAddStimulusWebUrl('');
  };

  const handleAddComboStimulus = async () => {
    const fallbackName = 'Combo';
    const name = (addStimulusName || '').trim() || fallbackName;
    if (hasDuplicateStimulusName(name)) {
      showNotice(`刺激物名称「${name}」已存在，请使用其他名称`);
      return;
    }
    const now = new Date();
    const dateLabel = now.toISOString().slice(0, 10);
    const id = `combo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const next = normalizeStimuliOrders([
      ...stimuli,
      {
        id,
        name,
        url: '',
        stimulusType: 'combo',
        comboItems: [],
        comboCanvasStyle: 'landscape',
        active: true,
        randomPlay: false,
        endOnClick: false,
        endOnKey: false,
        size: '-',
        date: dateLabel,
        group: currentStimulusGroup || '',
      },
    ]);
    await persistStimuliList(next);
    setIsAddStimulusModalOpen(false);
    setAddStimulusName('');
    setAddStimulusText('');
    setAddStimulusWebUrl('');
  };

  const handleUploadComboFiles = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    const projectDir = activeDataDir || '';
    if (!projectDir || !ipcClient.isAvailable()) {
      const localItems: ComboStimulusItem[] = [];
      for (let i = 0; i < files.length; i += 1) {
        const file = files.item(i);
        if (!file) continue;
        const isVideo = file.type.startsWith('video/');
        const isAudio = file.type.startsWith('audio/');
        localItems.push({
          id: `combo_local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: String(file.name || '').replace(/\.[^/.]+$/, '') || (isVideo ? 'Video' : isAudio ? 'Audio' : 'Image'),
          type: isVideo ? 'video' : isAudio ? 'audio' : 'image',
          url: URL.createObjectURL(file),
          widthPct: 50,
          heightPct: 50,
          centerXPct: 50,
          centerYPct: 50,
          loop: false,
        });
      }
      setEditStimulusComboItems((prev) => [...prev, ...localItems]);
      event.target.value = '';
      return;
    }

    try {
      const payloadFiles: { name: string; path?: string; data?: Uint8Array }[] = [];
      for (let i = 0; i < files.length; i += 1) {
        const file = files.item(i);
        if (!file) continue;
        const filePath = (file as File & { path?: string }).path;
        if (typeof filePath === 'string' && filePath) {
          payloadFiles.push({ name: file.name, path: filePath });
        } else {
          const arrayBuffer = await file.arrayBuffer();
          payloadFiles.push({ name: file.name, data: new Uint8Array(arrayBuffer) });
        }
      }
      const result = await ipcClient.importComboAssets({ projectDir, files: payloadFiles });
      if (!result.ok || !Array.isArray(result.assets)) {
        showNotice('Combo 素材上传失败，请稍后重试');
        return;
      }
      const importedItems = (result.assets as unknown[]).map((value): ComboStimulusItem => {
        const asset = asUnknownRecord(value);
        return {
          id: String(asset.id || `combo_asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
          name: String(asset.name || (asset.type === 'video' ? 'Video' : asset.type === 'audio' ? 'Audio' : 'Image')),
          type: asset.type === 'video' ? 'video' : asset.type === 'audio' ? 'audio' : 'image',
          url: String(asset.url || ''),
          fileName: String(asset.fileName || ''),
          widthPct: 50,
          heightPct: 50,
          centerXPct: 50,
          centerYPct: 50,
          loop: false,
        };
      });
      setEditStimulusComboItems((prev) => [...prev, ...importedItems]);
    } catch (error) {
      console.error('Upload combo files error:', error);
      showNotice('Combo 素材上传过程中发生错误，请稍后重试');
    } finally {
      event.target.value = '';
    }
  };

  const handleStartComboScreenRecording = async () => {
    const projectDir = activeDataDir || '';
    if (!projectDir) {
      showNotice('请先打开一个工程，然后再录制屏幕刺激物');
      return { ok: false as const, message: '请先打开一个工程' };
    }
    if (!ipcClient.isAvailable()) {
      showNotice('Electron IPC 不可用，无法保存录屏刺激物');
      return { ok: false as const, message: 'Electron IPC 不可用' };
    }
    const result = await ipcClient.startStimulusScreenRecording({
      projectDir,
      name: '',
      group: currentStimulusGroup || undefined,
    });
    if (!result.ok) {
      const msg = 'message' in result ? result.message : '';
      showNotice(isEn ? `Screen recording start failed: ${msg || 'unknown error'}` : `录屏启动失败：${msg || '未知错误'}`);
    }
    return result;
  };

  const handleStopComboScreenRecording = async (sessionId: string) => {
    const result = await ipcClient.stopStimulusScreenRecording({ sessionId, asComboAsset: true });
    if (!result.ok) {
      const msg = 'message' in result ? result.message : '';
      showNotice(isEn ? `Screen recording save failed: ${msg || 'unknown error'}` : `录屏保存失败：${msg || '未知错误'}`);
      return { ok: false as const, message: msg || '录屏保存失败' };
    }
    return { ok: true as const, asset: result.asset };
  };

  const handleSetupProjectLibrary = async () => {
    return setupProjectLibrary({
      setProjectRootPath,
    });
  };

  const handleAddExistingProject = async () => {
    let importTaskMeta: { taskId: string; projectDir: string; projectName: string } | null = null;
    try {
      if (!ipcClient.isAvailable()) {
        showNotice('ipc 不可用');
        return;
      }
      const res = await ipcClient.selectExistingProject();
      if (!res.ok) {
        const msg = 'message' in res ? res.message : undefined;
        if (msg && msg.includes('已取消')) return;
        showNotice(msg || '选择工程失败');
        return;
      }
      const projectDir = res.projectDir;
      const taskId = `project-import-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
      const fallbackProjectName = projectDir.split(/[\\/]/).filter(Boolean).pop() || '工程';
      const selectedProject = asUnknownRecord(res.project);
      const projectName = String(selectedProject.name || fallbackProjectName).trim() || fallbackProjectName;
      const projectDeviceType = selectedProject.deviceType === '眼镜式' ? '眼镜式' : '桌面式';
      importTaskMeta = { taskId, projectDir, projectName };
      handleProjectImportStatusChange({
        taskId,
        projectDir,
        projectName,
        phase: 'preparing',
        progress: 0.04,
        label: '正在接入工程',
        detail: projectDeviceType === '眼镜式' ? '准备桌面端转码检查' : '准备导入工程',
        updatedAt: Date.now(),
      });
      try {
        const raw = localStorage.getItem('pinnedProjectDirs');
        const arr = raw ? (JSON.parse(raw) as unknown) : [];
        const next = Array.isArray(arr) ? (arr as unknown[]).filter((v) => typeof v === 'string') : [];
        if (!next.includes(projectDir)) next.unshift(projectDir);
        localStorage.setItem('pinnedProjectDirs', JSON.stringify(next.slice(0, 200)));
      } catch {
        localStorage.setItem('pinnedProjectDirs', JSON.stringify([projectDir]));
      }
      try {
        const rawHidden = localStorage.getItem('hiddenProjectDirs');
        const arrHidden = rawHidden ? (JSON.parse(rawHidden) as unknown) : [];
        const nextHidden = Array.isArray(arrHidden) ? (arrHidden as unknown[]).filter((v) => typeof v === 'string') : [];
        const filtered = nextHidden.filter((v) => v !== projectDir);
        localStorage.setItem('hiddenProjectDirs', JSON.stringify(filtered));
      } catch {
      }
      const normalizeResult = await ipcClient.normalizeProjectRecordVideos({
        projectDir,
        taskId,
        deviceType: projectDeviceType,
      });
      void ipcClient.videoDebugLog({
        event: 'project-import-normalize-result',
        details: {
          projectDir,
          taskId,
          deviceType: projectDeviceType,
          ok: normalizeResult.ok,
          scanned: normalizeResult.scanned,
          compatible: normalizeResult.compatible,
          transcoded: normalizeResult.transcoded,
          failed: normalizeResult.failed,
          results: normalizeResult.results,
        },
      });
      if (!normalizeResult.ok) {
        const msg = normalizeResult.message || '未知错误';
        handleProjectImportStatusChange({
          taskId,
          projectDir,
          projectName,
          phase: 'failed',
          progress: 1,
          label: projectDeviceType === '眼镜式' ? '桌面端转码检查失败' : '工程导入失败',
          detail: msg,
          total: normalizeResult.scanned,
          completed: normalizeResult.scanned,
          compatible: normalizeResult.compatible,
          transcoded: normalizeResult.transcoded,
          failed: normalizeResult.failed,
          updatedAt: Date.now(),
        });
        showNotice(projectDeviceType === '眼镜式' ? `工程已添加，但桌面端转码检查失败：${msg}` : `工程已添加，但导入检查失败：${msg}`);
        await refreshProjectLibrary();
        setDashboardSearchQuery('');
        return;
      }
      handleProjectImportStatusChange({
        taskId,
        projectDir,
        projectName,
        phase: 'refreshing',
        progress: 0.94,
        label: '正在刷新工程列表',
        detail: projectDeviceType === '眼镜式' ? `共检查 ${normalizeResult.scanned} 个录制视频` : '当前设备类型无需执行导入转码',
        total: normalizeResult.scanned,
        completed: normalizeResult.scanned,
        compatible: normalizeResult.compatible,
        transcoded: normalizeResult.transcoded,
        failed: normalizeResult.failed,
        updatedAt: Date.now(),
      });
      await refreshProjectLibrary();
      setDashboardSearchQuery('');
      const summary =
        projectDeviceType === '眼镜式'
          ? `已转码 ${normalizeResult.transcoded} 个，兼容 ${normalizeResult.compatible} 个，失败 ${normalizeResult.failed} 个`
          : '当前设备类型未执行导入转码';
      handleProjectImportStatusChange({
        taskId,
        projectDir,
        projectName,
        phase: normalizeResult.failed > 0 ? 'failed' : 'done',
        progress: 1,
        label: normalizeResult.failed > 0 ? '工程导入完成，但仍有视频转码失败' : '工程导入完成',
        detail: summary,
        total: normalizeResult.scanned,
        completed: normalizeResult.scanned,
        compatible: normalizeResult.compatible,
        transcoded: normalizeResult.transcoded,
        failed: normalizeResult.failed,
        updatedAt: Date.now(),
      });
      if (projectDeviceType === '眼镜式' && (normalizeResult.transcoded > 0 || normalizeResult.failed > 0)) {
        const summary = `桌面端转码检查完成：已转码 ${normalizeResult.transcoded} 个，失败 ${normalizeResult.failed} 个`;
        showNotice(normalizeResult.failed > 0 ? `${summary}。可在记录回放页继续检查具体视频。` : summary);
      }
    } catch {
      handleProjectImportStatusChange({
        taskId: importTaskMeta?.taskId || `project-import-${Date.now()}`,
        projectDir: importTaskMeta?.projectDir || '',
        projectName: importTaskMeta?.projectName || '工程',
        phase: 'failed',
        progress: 1,
        label: '添加工程失败',
        detail: '发生异常，请重试',
        updatedAt: Date.now(),
      });
      showNotice('添加工程失败：发生异常');
      setHydratingProjectId(null);
    }
  };

  const handleChangeExperiment = async (experimentId: string) => {
    if (!activeProjectId) return;
    const projectDir = projectDirs[activeProjectId];
    if (!projectDir) return;
    await prepareDataScopeSwitch();
    let target = experiments.find((e) => e.id === experimentId) || null;
    if (!target) {
      const loaded = await ensureExperimentsLoaded(projectDir);
      setExperiments(loaded.experiments);
      target = loaded.experiments.find((e) => e.id === experimentId) || null;
    }
    if (!target) return;
    setHydratingProjectId(activeProjectId);
    setActiveExperimentId(experimentId);
    localStorage.setItem(getExperimentStorageKey(projectDir), experimentId);
    setSelectedRecordId(null);
    setVisibleRecordIds(new Set());
    setHeatmapPointsByRecord({});
    setAoiSelectedRecordId(null);
    setSubjects([]);
    setStimuli([]);
    setCustomGroups([]);
    setRecords([]);
    setSubjectFields(DEFAULT_SUBJECT_FIELDS);
    try {
      await loadProjectDetailData({ projectDir: target.dir, setSubjects, setSubjectFields, setStimuli, setRecords, setCustomMarkers });
    } finally {
      setHydratingProjectId(null);
    }
  };

  const handleCreateExperiment = () => {
    if (!activeProjectId) return;
    const projectDir = projectDirs[activeProjectId];
    if (!projectDir) return;
    const defaultName = `实验_${new Date().toISOString().slice(0, 10)}`;
    setNewExperimentName((prev) => (prev && prev.trim().length > 0 ? prev : defaultName));
    setIsNewExperimentModalOpen(true);
  };

  const handleConfirmCreateExperiment = async () => {
    if (!activeProjectId) return;
    const projectDir = projectDirs[activeProjectId];
    if (!projectDir) return;
    const name = (newExperimentName || '').trim();
    if (!name) {
      showNotice('请输入实验名称');
      return;
    }
    const normalizedName = normalizeNameForCompare(name);
    const hasDuplicateName = experiments.some((experiment) => normalizeNameForCompare(experiment.name) === normalizedName);
    if (hasDuplicateName) {
      showNotice(`实验名称「${name}」已存在，请使用其他名称`);
      return;
    }
    if (!ipcClient.isAvailable()) {
      showNotice('ipc 不可用');
      return;
    }
    const res = await ipcClient.createExperiment({ projectDir, name });
    if (!res.ok) {
      const msg = 'message' in res ? res.message : undefined;
      showNotice(msg || '新建实验失败');
      return;
    }
    const exp = asUnknownRecord(res.experiment);
    const nextExp: Experiment = { id: String(exp.id ?? ''), name: String(exp.name ?? ''), dir: String(exp.dir ?? '') };
    if (!nextExp.id || !nextExp.dir) {
      showNotice('新建实验失败：返回数据不完整');
      return;
    }
    setIsNewExperimentModalOpen(false);
    setExperiments((prev) => [...prev.filter((e) => e.id !== nextExp.id), nextExp]);
    await handleChangeExperiment(nextExp.id);
  };

  const handleDeleteExperiment = () => {
    if (!activeProjectId) {
      showNotice('请先选择工程');
      return;
    }
    const projectDir = projectDirs[activeProjectId];
    if (!projectDir) {
      showNotice('未找到工程目录');
      return;
    }
    if (!activeExperimentId || !activeExperiment) {
      showNotice('请先选择实验');
      return;
    }
    if (!ipcClient.isAvailable()) {
      showNotice('ipc 不可用');
      return;
    }

    const experimentName = String(activeExperiment.name || activeExperimentId).trim() || '当前实验';
    setConfirmState({
      open: true,
      title: '删除实验',
      message: `确定要删除实验「${experimentName}」吗？\n此操作会永久删除当前实验的全部数据，且不可恢复。`,
      confirmText: '删除',
      confirmVariant: 'danger',
      onConfirm: () => {
        void (async () => {
          const res = await ipcClient.deleteExperiment({ projectDir, experimentId: activeExperimentId });
          if (!res.ok) {
            const msg = 'message' in res ? res.message : undefined;
            showNotice(msg || '删除实验失败');
            return;
          }

          const { experiments: exps, activeId, dataDir } = await ensureExperimentsLoaded(projectDir);
          setExperiments(exps);
          setActiveExperimentId(activeId);
          if (activeId) {
            localStorage.setItem(getExperimentStorageKey(projectDir), activeId);
          } else {
            localStorage.removeItem(getExperimentStorageKey(projectDir));
          }

          setSelectedRecordId(null);
          setVisibleRecordIds(new Set());
          setHeatmapPointsByRecord({});
          setAoiSelectedRecordId(null);
          setSubjects([]);
          setStimuli([]);
          setCustomGroups([]);
          setRecords([]);
          setCustomMarkers([]);
          setSubjectFields(DEFAULT_SUBJECT_FIELDS);

          if (dataDir) {
            setHydratingProjectId(activeProjectId);
            try {
              await loadProjectDetailData({
                projectDir: dataDir,
                setSubjects,
                setSubjectFields,
                setStimuli,
                setRecords,
                setCustomMarkers,
              });
            } finally {
              setHydratingProjectId(null);
            }
          }

          showNotice('实验删除成功');
        })();
      },
    });
  };

  useEffect(() => {
    restoreSavedProjectLibrary({
      loadPinnedProjects: refreshProjectLibrary,
      setProjectRootPath,
    });
  }, []);

  const {
    detailVideoUrl,
    heatmapPointsByRecord,
    setHeatmapPointsByRecord,
    heatmapLoadingRecordId,
    heatmapError,
    currentHeatmapPoints,
  } = useVisualAnalysisData({
    activeTab,
    selectedRecordId,
    visibleRecordIds,
    projectDir: activeDataDir || null,
    records,
    pointSource: gazeDisplayPath,
  });
  const isAoiPageActive = currentView === 'detail' && activeTab === 'aoi';
  const {
    aoiShapes,
    setAoiShapes,
    aoiTool,
    setAoiTool,
    aoiDrawing,
    setAoiDrawing,
    aoiSelectedId,
    setAoiSelectedId,
    aoiDraft,
    setAoiDraft,
    aoiCursor,
    setAoiCursor,
    aoiCanvasRef,
    aoiVideoRef,
    aoiSelectedStimulusId,
    setAoiSelectedStimulusId,
    aoiSelectedRecordId,
    setAoiSelectedRecordId,
    aoiVideoUrl,
    aoiSyncVideoMeta,
    aoiClearVideoMeta,
    aoiStartDraw,
    aoiOnMouseDown,
    aoiOnMouseMove,
    aoiOnMouseUp,
    aoiRename,
    aoiOpacity,
    setAoiOpacity,
    aoiBorderWidth,
    setAoiBorderWidth,
    aoiFontSize,
    setAoiFontSize,
    aoiShowName,
    setAoiShowName,
    aoiColorDefs,
    selectedAoi,
  } = useAoiEditor({ stimuli, records, projectDir: activeDataDir || null, isActive: isAoiPageActive });


  const handleDeleteRecord = async (id: string) => {
    const target = records.find((record) => record.id === id);
    if (!target) return;
    setConfirmState({
      open: true,
      title: isEn ? 'Delete record' : '删除记录',
      message: isEn
        ? 'Are you sure you want to delete this record? This action will delete related recording files and cannot be undone.'
        : '确定要删除这条记录吗？此操作会删除对应录制文件且不可恢复。',
      showCancel: true,
      confirmText: isEn ? 'Delete' : '删除',
      confirmVariant: 'danger',
      onConfirm: async () => {
        if (!activeDataDir || !ipcClient.isAvailable()) {
          showNotice(isEn ? 'Delete failed: project directory not found or IPC unavailable' : '删除失败：未找到项目目录或 IPC 不可用');
          return;
        }

        const recordPaths = [target.mp4Path, target.csvPath, target.modalities?.['facial-expression']?.sourcePath, target.modalities?.['facial-expression']?.analysisPath].filter(
          (p): p is string => typeof p === 'string' && p.trim().length > 0,
        );

        try {
          const result = await ipcClient.deleteRecording({
            projectDir: activeDataDir,
            recordName: target.name,
            recordPaths,
          });
          if (!result.ok) {
            const msg = 'message' in result ? result.message : undefined;
            showNotice(isEn ? `Delete failed: ${msg || 'failed to delete recording files'}` : `删除失败：${msg || '未能删除录制文件'}`);
            return;
          }

          setSelectedRecordId((prev) => (prev === id ? null : prev));
          setVisibleRecordIds((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });

          await loadRecordsForProject({ projectDir: activeDataDir, setRecords });
        } catch (error) {
          console.error('Delete record error:', error);
          showNotice(isEn ? 'Delete failed: unexpected error' : '删除失败：发生异常');
        }
      },
    });
  };

  const handlePlayRecordVideo = () => {
    const el = detailVideoRef.current;
    if (!el) {
      return;
    }
    try {
      el.play().catch(() => {});
    } catch {
    }
  };

  const handleEditStimulusName = async (id: string) => {
    const projectDir = activeDataDir || '';
    let nameLocked = true;
    if (projectDir && ipcClient.isAvailable()) {
      const usage = await ipcClient.checkStimulusUsage({ projectDir, id });
      if (usage.ok) {
        nameLocked = usage.inUse;
      } else {
        showNotice(
          isEn
            ? 'Unable to check stimulus usage; its name will remain locked.'
            : `无法检查素材使用情况，名称将保持锁定：${usage.message || '未知错误'}`,
        );
      }
    } else {
      showNotice(isEn ? 'Unable to check stimulus usage; its name will remain locked.' : '无法检查素材使用情况，名称将保持锁定。');
    }
    setEditStimulusNameLocked(nameLocked);
    return beginEditStimulusName({
      id,
      stimuli,
      setEditingStimulusId,
      setEditStimulusName,
      setEditStimulusFixedTimeSec,
      setEditStimulusActive,
      setIsEditStimulusModalOpen,
      setBgColor: setEditStimulusBgColor,
      setFontSize: setEditStimulusFontSize,
      setFontColor: setEditStimulusFontColor,
      setTextValue: setEditStimulusText,
      setWebUrl: setEditStimulusWebUrl,
      setExternalMarker: setEditStimulusExternalMarker,
      setEndOnClick: setEditStimulusEndOnClick,
      setEndOnKey: setEditStimulusEndOnKey,
      setGroup: setEditStimulusGroup,
      setRandomPlay: setEditStimulusRandomPlay,
      setTriggerEnabled: setEditStimulusTriggerEnabled,
      setTriggerMark: setEditStimulusTriggerMark,
      setGroupPlayMode: setEditStimulusGroupPlayMode,
      setGroupRandomCount: setEditStimulusGroupRandomCount,
      setGroupRepeatCount: setEditStimulusGroupRepeatCount,
      setPlayToEnd: setEditStimulusPlayToEnd,
      setComboItems: setEditStimulusComboItems,
      setComboCanvasStyle: setEditStimulusComboCanvasStyle,
    });
  };

  const handleSaveEditedStimulus = async () => {
    const name = editStimulusName.trim();
    if (!name) {
      showNotice(isEn ? 'Please enter a name.' : '请输入名称。');
      return;
    }
    if (editingStimulusId && hasDuplicateStimulusName(name, editingStimulusId)) {
      showNotice(isEn ? `Stimulus name "${name}" already exists. Please use another name.` : `刺激物名称「${name}」已存在，请使用其他名称。`);
      return;
    }
    if (!editingStimulusId) {
      setIsEditStimulusModalOpen(false);
      return;
    }
    const editingStimulus = stimuli.find((item) => item.id === editingStimulusId) || null;
    if (editingStimulus && editingStimulus.name !== name) {
      const projectDir = activeDataDir || '';
      if (!projectDir || !ipcClient.isAvailable()) {
        showNotice(isEn ? 'Unable to verify stimulus usage, so the name cannot be changed.' : '无法验证素材使用情况，因此不能修改名称。');
        return;
      }
      const usage = await ipcClient.checkStimulusUsage({ projectDir, id: editingStimulusId });
      if (!usage.ok) {
        showNotice(
          isEn
            ? 'Unable to verify stimulus usage, so the name cannot be changed.'
            : `无法验证素材使用情况，因此不能修改名称：${usage.message || '未知错误'}`,
        );
        return;
      }
      if (usage.inUse) {
        setEditStimulusNameLocked(true);
        showNotice(
          isEn ? 'This stimulus is used by recorded data and cannot be renamed.' : '该素材已在记录中使用，不能修改名称。',
          isEn ? 'Cannot rename stimulus' : '无法修改素材名称',
        );
        return;
      }
    }
    if (editingStimulus?.stimulusType === 'text' && !editStimulusText.trim()) {
      showNotice(isEn ? 'Please enter the text content.' : '请输入文字内容。');
      return;
    }
    let normalizedEditedWebUrl = editingStimulus?.url || '';
    if (editingStimulus?.stimulusType === 'web') {
      const rawWebUrl = editStimulusWebUrl.trim();
      if (!rawWebUrl) {
        showNotice(isEn ? 'Please enter a URL.' : '请输入网址。');
        return;
      }
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawWebUrl) && !/^https?:\/\//i.test(rawWebUrl)) {
        showNotice(isEn ? 'Only HTTP and HTTPS URLs are supported.' : '网址只支持 http 或 https。');
        return;
      }
      normalizedEditedWebUrl = normalizeWebStimulusUrl(rawWebUrl);
      try {
        const parsedUrl = new URL(normalizedEditedWebUrl);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          showNotice(isEn ? 'Only HTTP and HTTPS URLs are supported.' : '网址只支持 http 或 https。');
          return;
        }
      } catch {
        showNotice(isEn ? 'Please enter a valid URL.' : '请输入有效的网址。');
        return;
      }
    }
    if (editingStimulus?.stimulusType === 'combo') {
      const invalidTextLayer = editStimulusComboItems.some((item) => item.type === 'text' && !String(item.text || '').trim());
      if (invalidTextLayer) {
        showNotice(isEn ? 'Text layers in the combo cannot be empty.' : 'Combo 中的文字图层不能为空。');
        return;
      }
    }
    const isEditingVideo = editingStimulus?.stimulusType === 'video' || editingStimulus?.stimulusType === 'audio';
    const isEditingCombo = editingStimulus?.stimulusType === 'combo';
    const sec = Number((editStimulusFixedTimeSec || '').trim());
    const parsedFixedTimeMs = Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : undefined;
    const fixedTimeMs = isEditingVideo
      ? (editStimulusPlayToEnd ? undefined : parsedFixedTimeMs)
      : parsedFixedTimeMs;
    const next = stimuli.map((item) =>
      item.id === editingStimulusId
        ? {
            ...item,
            name,
            fixedTimeMs,
            playToEnd: isEditingVideo ? editStimulusPlayToEnd : false,
            active: !!editStimulusActive,
            bgColor: editStimulusBgColor,
            text: item.stimulusType === 'text' ? editStimulusText : item.text,
            url: item.stimulusType === 'web' ? normalizedEditedWebUrl : item.url,
            comboItems: isEditingCombo ? editStimulusComboItems.map((comboItem: ComboStimulusItem) => ({ ...comboItem })) : item.comboItems,
            comboCanvasStyle: isEditingCombo ? editStimulusComboCanvasStyle : item.comboCanvasStyle,
            fontSize: editStimulusFontSize,
            fontColor: editStimulusFontColor,
            externalMarker: editStimulusExternalMarker,
            endOnClick: editStimulusEndOnClick,
            endOnKey: editStimulusEndOnKey,
            group: editStimulusGroup,
            randomPlay: editStimulusRandomPlay,
            triggerEnabled: editStimulusTriggerEnabled,
            triggerMark: editStimulusTriggerMark,
            groupPlayMode: editStimulusGroupPlayMode,
            groupRandomCount: editStimulusGroupRandomCount,
            groupRepeatCount: editStimulusGroupRepeatCount,
          }
        : item,
    );
    // 当 Group 重命名时，同步更新所有成员刺激物的 group 字段
    if (editingStimulus && editingStimulus.stimulusType === 'group' && editingStimulus.name !== name) {
      const oldGroupName = editingStimulus.name;
      for (let i = 0; i < next.length; i++) {
        if (next[i].group === oldGroupName) {
          next[i] = { ...next[i], group: name };
        }
      }
    }
    next.sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0));
    const normalized = next.map((s, idx) => ({ ...s, order: idx + 1 }));
    setStimuli(normalized);
    setIsEditStimulusModalOpen(false);
    setEditingStimulusId(null);
    setEditStimulusFixedTimeSec('5');
    setEditStimulusActive(true);
    setEditStimulusBgColor('#000000');
    setEditStimulusFontSize(48);
    setEditStimulusFontColor('#ffffff');
    setEditStimulusText('');
    setEditStimulusWebUrl('');
    setEditStimulusExternalMarker(true);
    setEditStimulusEndOnClick(false);
    setEditStimulusEndOnKey(false);
    setEditStimulusGroup('');
    setEditStimulusRandomPlay(false);
    setEditStimulusTriggerEnabled(false);
    setEditStimulusTriggerMark(null);
    setEditStimulusGroupPlayMode('all-sequential');
    setEditStimulusGroupRandomCount(1);
    setEditStimulusGroupRepeatCount(1);
    setEditStimulusPlayToEnd(false);
    setEditStimulusComboItems([]);
    setEditStimulusComboCanvasStyle('landscape');

    try {
      const projectDir = activeDataDir || '';
      if (projectDir && ipcClient.isAvailable()) {
        void ipcClient.saveStimuliDetailed({ projectDir, stimuli: normalized }).then((res) => {
          if (res.ok) {
            setStimuliSaveHint(isEn ? 'Updated' : '已更新');
          } else {
            const msg = 'message' in res ? res.message : undefined;
            const lockedMessage = isEn
              ? 'This stimulus is used by recorded data and cannot be renamed.'
              : '该素材已在记录中使用，不能修改名称。';
            setStimuliSaveHint(
              res.code === 'STIMULUS_NAME_LOCKED'
                ? lockedMessage
                : isEn
                  ? `Save failed: ${msg || 'save-stimuli returned failure'}`
                  : `保存失败：${msg || 'save-stimuli 返回失败'}`,
            );
            if (res.code === 'STIMULUS_NAME_LOCKED') {
              showNotice(lockedMessage, isEn ? 'Cannot rename stimulus' : '无法修改素材名称');
            }
          }
        });
      } else {
        setStimuliSaveHint(isEn ? 'Save failed: project directory not found or IPC unavailable' : '保存失败：未找到工程目录或 ipc 不可用');
      }
    } catch {
    }
  };

  const handleRequestDeleteStimulus = async (id: string) => {
    const target = stimuli.find((item) => item.id === id);
    const name = target ? target.name : '';
    const projectDir = activeDataDir || '';
    if (!projectDir || !ipcClient.isAvailable()) {
      showNotice(
        isEn ? 'Unable to check stimulus usage because the project directory or IPC is unavailable.' : '无法检查刺激物使用情况：未找到工程目录或 IPC 不可用。',
      );
      return;
    }

    const usage = await ipcClient.checkStimulusUsage({ projectDir, id });
    if (!usage.ok) {
      showNotice(
        isEn
          ? `Unable to check stimulus usage: ${usage.message || 'unknown error'}`
          : `检查刺激物使用情况失败：${usage.message || '未知错误'}`,
      );
      return;
    }
    if (usage.inUse) {
      const recordText = usage.records.slice(0, 3).join(isEn ? ', ' : '、');
      const remaining = Math.max(0, usage.records.length - 3);
      const moreText = remaining > 0 ? (isEn ? ` and ${remaining} more` : `等 ${usage.records.length} 条记录`) : '';
      showNotice(
        isEn
          ? `Stimulus "${name}" is used by recorded data (${recordText}${moreText}) and cannot be deleted. Delete the related recordings first.`
          : `刺激物「${name}」已在录制记录（${recordText}${moreText}）中使用，不能删除。请先删除相关录制记录。`,
        isEn ? 'Cannot delete stimulus' : '无法删除刺激物',
      );
      return;
    }

    setConfirmState({
      open: true,
      title: isEn ? 'Delete stimulus' : '删除刺激物',
      message: name
        ? isEn
          ? `Are you sure you want to delete stimulus "${name}"? This action cannot be undone.`
          : `确定要删除刺激物「${name}」吗？此操作不可撤销。`
        : isEn
          ? 'Are you sure you want to delete this stimulus? This action cannot be undone.'
          : '确定要删除该刺激物吗？此操作不可撤销。',
      onConfirm: () => {
        try {
          if (projectDir && ipcClient.isAvailable()) {
            void ipcClient.deleteStimulus({ projectDir, id, url: target?.url }).then((res) => {
              if (res.ok) {
                setStimuli(res.stimuli as ExtendedStimulus[]);
                if (Array.isArray(res.fileDeleteErrors) && res.fileDeleteErrors.length > 0) {
                  const detail = res.fileDeleteErrors.slice(0, 2).join(isEn ? '; ' : '；');
                  setStimuliSaveHint(isEn ? `Deleted from list; file cleanup failed: ${detail}` : `已从列表删除，但文件清理失败：${detail}`);
                  showNotice(
                    isEn ? `The item was removed, but its file could not be deleted: ${detail}` : `素材已从列表移除，但实际文件删除失败：${detail}`,
                    isEn ? 'File cleanup failed' : '文件清理失败',
                  );
                } else {
                  setStimuliSaveHint(isEn ? 'Deleted and saved' : '已删除并保存');
                }
              } else {
                const msg = 'message' in res ? res.message : undefined;
                if (res.code === 'STIMULUS_IN_USE') {
                  showNotice(
                    isEn ? msg || 'This stimulus is used by recorded data and cannot be deleted.' : msg || '该刺激物已在录制记录中使用，不能删除。',
                    isEn ? 'Cannot delete stimulus' : '无法删除刺激物',
                  );
                } else {
                  setStimuliSaveHint(isEn ? `Delete failed: ${msg || 'delete-stimulus returned failure'}` : `删除失败：${msg || 'delete-stimulus 返回失败'}`);
                }
              }
            });
          } else {
            setStimuliSaveHint(isEn ? 'Delete failed: project directory not found or IPC unavailable' : '删除失败：未找到工程目录或 ipc 不可用');
          }
        } catch {
          setStimuliSaveHint(isEn ? 'Delete failed: unexpected error' : '删除失败：发生异常');
        }
      },
    });
  };

  const handleCopyStimulus = async (id: string) => {
    const target = stimuli.find((item) => item.id === id);
    if (!target) {
      showNotice('未找到要复制的素材');
      return;
    }

    const projectDir = activeDataDir || '';
    if (!projectDir) {
      showNotice('请先打开一个工程');
      return;
    }

    if (!ipcClient.isAvailable()) {
      showNotice('Electron IPC 不可用');
      return;
    }

    try {
      const result = await ipcClient.copyStimulus({
        projectDir,
        stimulusId: id,
      });

      if (result && result.ok && Array.isArray(result.stimuli)) {
        const normalizePlayToEnd = (value: unknown, stimulusType: unknown): boolean => {
          if (stimulusType !== 'video' && stimulusType !== 'audio') return false;
          if (value == null) return true;
          if (value === true) return true;
          if (value === false) return false;
          if (typeof value === 'number') return value === 1;
          if (typeof value === 'string') {
            const v = value.trim().toLowerCase();
            return v === 'true' || v === '1' || v === 'yes' || v === 'on';
          }
          return true;
        };
        // Update stimuli list with the result from backend
        const normalized = normalizeStimuliOrders(result.stimuli).map((stimulus) => ({
          ...stimulus,
          playToEnd: normalizePlayToEnd(stimulus.playToEnd, stimulus.stimulusType),
        }));
        setStimuli(normalized);
        setStimuliSaveHint(isEn ? 'Copied' : '已复制');
      } else {
        const msg = 'message' in result ? result.message : undefined;
        setStimuliSaveHint(isEn ? `Copy failed: ${msg || 'copy-stimulus returned failure'}` : `复制失败：${msg || 'copy-stimulus 返回失败'}`);
        showNotice('素材复制失败，请稍后重试');
      }
    } catch (error) {
      console.error('Copy stimulus error:', error);
      setStimuliSaveHint(isEn ? 'Copy failed: unexpected error' : '复制失败：发生异常');
      showNotice('素材复制过程中发生错误，请稍后重试');
    }
  };

  useEffect(() => {
    if (hydratingProjectId && hydratingProjectId === activeProjectId) {
      return;
    }
    persistSubjects({ projectDir: activeDataDir || null, subjects });
  }, [subjects, activeDataDir, activeProjectId, hydratingProjectId]);

  useEffect(() => {
    if (hydratingProjectId && hydratingProjectId === activeProjectId) {
      return;
    }
    persistSubjectFields({ projectDir: activeDataDir || null, fields: subjectFields });
  }, [subjectFields, activeDataDir, activeProjectId, hydratingProjectId]);

  // Load trigger config when project changes
  useEffect(() => {
    if (!activeDataDir || !ipcClient.isAvailable()) {
      console.log('[MrtApp] Trigger config cleared - no activeDataDir or ipcClient unavailable');
      setTriggerConfig(null);
      if (ipcClient.isAvailable()) void ipcClient.stopTcpStreaming();
      return;
    }
    
    console.log('[MrtApp] Loading trigger config for project:', activeDataDir);
    ipcClient.loadTriggerConfig({ projectDir: activeDataDir })
      .then((res) => {
        if (res.ok && res.config) {
          console.log('[MrtApp] Trigger config loaded successfully:', res.config);
          setTriggerConfig(res.config);
        } else {
          console.log('[MrtApp] Trigger config not found or failed to load');
          setTriggerConfig(null);
        }
      })
      .catch((err) => {
        console.error('[MrtApp] Error loading trigger config:', err);
        setTriggerConfig(null);
      });
  }, [activeDataDir]);

  useEffect(() => {
    const handleTriggerConfigUpdated = (event: Event) => {
      const detail = (event as CustomEvent<TriggerConfig>).detail;
      if (detail) setTriggerConfig(detail);
    };
    window.addEventListener('mrt-trigger-config-updated', handleTriggerConfigUpdated);
    return () => window.removeEventListener('mrt-trigger-config-updated', handleTriggerConfigUpdated);
  }, []);

  useEffect(() => {
    tcpAoiByScopeRef.current = {};
    if (!activeDataDir || !ipcClient.isAvailable()) return;
    let cancelled = false;
    void ipcClient.loadAoi({ projectDir: activeDataDir }).then((result) => {
      if (cancelled || !result.ok) return;
      const store = parseAoiStore(result.data);
      if (store) tcpAoiByScopeRef.current = store.byRecordId;
    });
    return () => {
      cancelled = true;
    };
  }, [activeDataDir, isRecording]);

  useEffect(() => {
    if (!triggerConfig?.tcpStreamingEnabled || !ipcClient.isAvailable()) return;
    if (currentView !== 'detail' || activeTab !== 'video' || (!isCameraOn && !isRecording)) return;
    return eyeDataStore.subscribe(() => {
      const eyeData = eyeDataStore.getSnapshot();
      if (!eyeData?.timestamp) return;

      const recomValid = tcpGazeValid(eyeData.recomGazeBitMask, eyeData.recomGazeX, eyeData.recomGazeY);
      const leftValid = tcpGazeValid(eyeData.leftGazeBitMask, eyeData.leftGazeX, eyeData.leftGazeY);
      const rightValid = tcpGazeValid(eyeData.rightGazeBitMask, eyeData.rightGazeX, eyeData.rightGazeY);
      const aoiNames = isRecording && recomValid
        ? getHitAoiNames({
            shapes: tcpAoiByScopeRef.current[currentStimulusIdRef.current] || [],
            x: Number(eyeData.recomGazeX),
            y: Number(eyeData.recomGazeY),
            timeMs: Math.max(0, Date.now() - currentStimulusStartedAtRef.current),
          })
        : [];
      const value = (field: unknown, valid = true) => valid && field != null ? String(field) : '';
      void ipcClient.sendTcpEyeData({
        fields: [
          value(eyeData.timestamp),
          recomValid ? '1' : '0',
          value(eyeData.recomGazeX, recomValid),
          value(eyeData.recomGazeY, recomValid),
          leftValid ? '1' : '0',
          value(eyeData.leftGazeX, leftValid),
          value(eyeData.leftGazeY, leftValid),
          rightValid ? '1' : '0',
          value(eyeData.rightGazeX, rightValid),
          value(eyeData.rightGazeY, rightValid),
          value(eyeData.leftPupilDiameterMm),
          value(eyeData.rightPupilDiameterMm),
          tcpBooleanString(eyeData.leftBlink),
          tcpBooleanString(eyeData.rightBlink),
          aoiNames,
        ],
      });
    });
  }, [activeTab, currentView, eyeDataStore, isCameraOn, isRecording, triggerConfig?.tcpStreamingEnabled]);

  useEffect(() => {
    if (!activeDataDir || !ipcClient.isAvailable()) {
      setLatestInsightReport(null);
      return;
    }
    let cancelled = false;
    ipcClient
      .loadInsightReport({ projectDir: activeDataDir })
      .then((res) => {
        if (cancelled) return;
        if (res.ok && res.report) {
          setLatestInsightReport(res.report);
        } else {
          setLatestInsightReport(null);
        }
      })
      .catch(() => {
        if (!cancelled) setLatestInsightReport(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeDataDir]);

  useEffect(() => {
    if (!activeDataDir || !ipcClient.isAvailable()) {
      setLatestCompareResult(null);
      return;
    }
    let cancelled = false;
    ipcClient
      .loadCompareResult({ projectDir: activeDataDir })
      .then((res) => {
        if (cancelled) return;
        if (res.ok && res.compareResult) {
          setLatestCompareResult(res.compareResult);
        } else {
          setLatestCompareResult(null);
        }
      })
      .catch(() => {
        if (!cancelled) setLatestCompareResult(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeDataDir]);

  const renderSubjectView = () => (
    <SubjectPage
      subjectFields={subjectFields}
      subjects={subjects}
      onEditSubject={handleOpenEditSubject}
      onDeleteSubject={handleRequestDeleteSubject}
      customMarkers={customMarkers}
      onSaveCustomMarkers={async (markers) => {
        if (!activeDataDir) return;
        try {
          const result = await ipcClient.saveCustomMarkers({ projectDir: activeDataDir, markers });
          if (result.ok) {
            setCustomMarkers(markers);
          } else {
            showNotice('保存自定义标记失败');
          }
        } catch (error) {
          console.error('保存自定义标记失败:', error);
          showNotice('保存自定义标记失败');
        }
      }}
    />
  );

  const renderProjectSettingsView = () => (
    <ProjectSettingsPage
      editedProject={editedProject}
      hasProjectChanges={hasProjectChanges}
      onChange={handleProjectSettingChange}
      onModalitiesChange={(ids) => {
        if (!editedProject || ids.length === 0) return;
        const current = normalizeProjectModalities(editedProject);
        const modalities = ids.map((id) => current.find((item) => item.id === id)
          ?? (id === 'eye-tracking'
            ? createEyeTrackingModality(editedProject.deviceModel, editedProject.deviceType)
            : createFacialExpressionModality()));
        setEditedProject({ ...editedProject, schemaVersion: 2, modalities });
        setHasProjectChanges(true);
      }}
      onSave={handleSaveProjectSettings}
      experiments={experiments}
      activeExperimentId={activeExperimentId}
      onChangeExperiment={handleChangeExperiment}
      onCreateExperiment={handleCreateExperiment}
      onDeleteExperiment={handleDeleteExperiment}
      onDeleteProject={handleDeleteProject}
      onBackup={() => {
        const projectDir = activeProjectId ? projectDirs[activeProjectId] : '';
        if (!projectDir || !ipcClient.isAvailable()) {
          showNotice('未找到工程目录或 ipc 不可用');
          return;
        }
        void ipcClient.backupProject({ projectDir }).then((res) => {
          if (res.ok) {
            showNotice('工程备份成功');
          } else {
            const msg = 'message' in res ? res.message : undefined;
            if (msg && msg.includes('已取消')) return;
            showNotice(`工程备份失败：${msg || ''}`);
          }
        });
      }}
      onExport={() => {
        const projectDir = activeProjectId ? projectDirs[activeProjectId] : '';
        if (!projectDir || !ipcClient.isAvailable()) {
          showNotice('未找到工程目录或 ipc 不可用');
          return;
        }
        void ipcClient.exportProject({ projectDir }).then((res) => {
          if (res.ok) {
            showNotice('导出压缩工程成功');
          } else {
            const msg = 'message' in res ? res.message : undefined;
            if (msg && msg.includes('已取消')) return;
            showNotice(`导出压缩工程失败：${msg || ''}`);
          }
        });
      }}
    />
  );

  const renderStimulusView = () => (
    <StimulusPage
      stimuli={stimuli}
      onEditName={handleEditStimulusName}
      onDelete={handleRequestDeleteStimulus}
      onCopy={handleCopyStimulus}
      saveHint={stimuliSaveHint}
      currentGroup={currentStimulusGroup}
      onGroupChange={setCurrentStimulusGroup}
      customGroups={customGroups}
      onAddCustomGroup={(g) => {
        const name = String(g || '').trim();
        if (!name) return;
        const normalized = normalizeNameForCompare(name);
        const existsInCustom = customGroups.some((item) => normalizeNameForCompare(item) === normalized);
        const existsInStimulusGroup = stimuli.some(
          (item) => item.stimulusType === 'group' && normalizeNameForCompare(item.name) === normalized,
        );
        if (existsInCustom || existsInStimulusGroup) {
          showNotice(`组合名称「${name}」已存在，请使用其他名称`);
          return;
        }
        setCustomGroups((prev) => [...prev, name]);
      }}
      onReorder={async (next) => {
        const normalized = next.map((stimulus, index) => ({ ...stimulus, order: index + 1 }));
        setStimuli(normalized);
        try {
          const projectDir = activeDataDir || '';
          if (projectDir && ipcClient.isAvailable()) {
            const res = await ipcClient.saveStimuliDetailed({ projectDir, stimuli: normalized });
            if (res.ok) {
              setStimuliSaveHint(isEn ? 'Updated' : '已更新');
            } else {
              const msg = 'message' in res ? res.message : undefined;
              setStimuliSaveHint(isEn ? `Save failed: ${msg || 'save-stimuli returned failure'}` : `保存失败：${msg || 'save-stimuli 返回失败'}`);
            }
          } else {
            setStimuliSaveHint(isEn ? 'Save failed: project directory not found or IPC unavailable' : '保存失败：未找到工程目录或 ipc 不可用');
          }
        } catch {
          setStimuliSaveHint(isEn ? 'Save failed: write error' : '保存失败：写入发生异常');
        }
      }}
    />
  );

  const renderRecordingView = () => (
    <RecordingPage
      playbackIndex={playbackIndex}
      stimuli={stimuli}
      wsConnected={wsConnected}
      imageCanvasRef={imageCanvasRef}
      videoCanvasRef={videoPreviewCanvasRef}
      videoPreviewMode={videoPreviewMode}
      glassesPreviewSuspended={shouldUseCombinedImagePreview}
      videoPreviewStatus={videoPreviewStatus}
      videoFrameSize={videoPreviewFrameSize}
      cardDetectionFrameRef={cardDetectionFrameRef}
      isCameraOn={isCameraOn}
      lastImageAt={lastImageAt}
      wsIp={wsIp}
      wsImagePort={wsImagePort}
      subjects={subjects}
      recordingSettings={recordingSettings}
      setRecordingSettings={setRecordingSettings}
      eyeDataStore={eyeDataStore}
      calibrationScores={calibrationScores}
      playbackSequence={playbackSequenceRef.current}
      isRecording={isRecording}
      isPreviewing={isPreviewing}
      onStartCalibrationTest={handleStartCalibrationTest}
      onStartCalibration={handleStartCalibration}
      hasSavedCalibration={Boolean((calibrationCoe || '').trim() || calibrationScores)}
      stimulusEnabled={activeDeviceProfile.stimulusEnabled}
      deviceProfile={activeDeviceProfile}
      calibrationTypes={activeDeviceProfile.calibrationTypes}
      calibrationMode={activeDeviceProfile.calibrationMode}
      calibrationState={calibrationState}
      isCalibrationStarting={isCalibrationStarting}
      calibPointIndex={calibPointIndex}
      calibScale={calibScale}
      onInlineCalibrationPoint={handleInlineCalibrationPoint}
      cardCalibrationActive={isCardCalibration}
      isPupilCardCalibration={activeDeviceModel === 'PupilCore'}
      isCalibrationTrackerReady={isCalibrationTrackerReady}
      cardDetectedPoint={cardDetectedPoint}
      cardCompletedPoints={cardCompletedPoints}
      cardDetectionStatus={cardDetectionStatus}
      cardDetectionMessage={cardDetectionMessage}
      onCardDetectionUpdate={handleCardDetectionUpdate}
      onCardCalibrationTrigger={handleCardCalibrationTrigger}
      isCalibrationTestMode={isCalibrationTestMode}
      language={language}
      onBeforeSwitchMode={stopDeviceBeforeNavigate}
      monitorLayout={recordingMonitorLayout}
      monitorLayoutResetToken={recordingMonitorLayoutResetToken}
      hiddenMonitorTileIds={hiddenRecordingMonitorTileIds}
      onHiddenMonitorTileIdsChange={setHiddenRecordingMonitorTileIds}
      enabledModalities={enabledRecordingModalities}
      facialCameraId={facialCameraId}
      facialCameras={facialCameras}
      isFacialCapturing={isFacialCapturing}
      facialCaptureNotice={facialCaptureNotice}
      onRefreshFacialCameras={refreshFacialCameras}
      onFacialCameraChange={(cameraId: string) => {
        setFacialCameraId(cameraId);
        if (activeDataDir && cameraId) {
          const camera = facialCameras.find((item) => item.id === cameraId);
          const next = normalizeFacialRecordingSettings({ ...facialSettings, cameraId, cameraIndex: camera?.index ?? null });
          setFacialSettings(next);
          localStorage.setItem(`facial-analysis-settings:${activeDataDir}`, JSON.stringify(next));
        }
      }}
      facialPreviewDataUrl={facialPreviewDataUrl}
      facialPreviewStream={facialPreviewStream}
      facialFaceBox={facialFaceBox}
      facialExpression={facialExpression}
      facialEmotionScores={facialEmotionScores}
      facialLandmarks={facialLandmarks}
      facialSessionStatus={facialSessionStatus}
      facialSettings={facialSettings}
      onFacialSettingsChange={(patch) => {
        setFacialSettings((current) => {
          return normalizeFacialRecordingSettings({ ...current, ...patch });
        });
      }}
    />
  );

  const renderRecordDetailView = () => {
    const record = records.find((item) => item.id === selectedRecordId) || null;
    if (recordDetailModality === 'facial-expression' && record?.modalities?.['facial-expression']) {
      return <FacialRecordDetailPage record={record} projectDir={activeDataDir || null} onBackToList={() => setSelectedRecordId(null)} />;
    }
    return <RecordDetailPage
      records={records}
      selectedRecordId={selectedRecordId}
      projectDir={activeDataDir || null}
      detailVideoUrl={detailVideoUrl}
      detailVideoRef={detailVideoRef}
      onPlay={handlePlayRecordVideo}
      onBackToList={() => setSelectedRecordId(null)}
      detailProps={detailProps}
      setDetailProps={setDetailProps}
      onVideoExportStatusChange={handleVideoExportStatusChange}
    />;
  };

  const toggleRecordVisibility = (id: string) => {
    const next = new Set(visibleRecordIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setVisibleRecordIds(next);
  };

  const handleRecordTimelineSegmentsChange = useCallback((recordId: string, segments: TimeSegment[]) => {
    setRecords((prev) =>
      prev.map((record) =>
        record.id === recordId
          ? {
              ...record,
              timelineSegments: segments,
            }
          : record,
      ),
    );
  }, []);

  const renderVisualView = () => (
    <VisualPage
      stimuli={stimuli}
      projectDeviceType={activeDeviceType}
      visualSelectedStimulusId={visualSelectedStimulusId}
      setVisualSelectedStimulusId={setVisualSelectedStimulusId}
      records={eyeTrackingRecords}
      selectedRecordId={selectedRecordId}
      setSelectedRecordId={setSelectedRecordId}
      visibleRecordIds={visibleRecordIds}
      setVisibleRecordIds={setVisibleRecordIds}
      toggleRecordVisibility={toggleRecordVisibility}
      visualSubTab={visualSubTab}
      setVisualSubTab={setVisualSubTab}
      heatmapLoadingRecordId={heatmapLoadingRecordId}
      heatmapError={heatmapError}
      heatmapCanvasRef={heatmapCanvasRef}
      gazeCanvasRef={gazeCanvasRef}
      currentHeatmapPoints={currentHeatmapPoints}
      heatmapPointsByRecord={heatmapPointsByRecord}
      heatmapSettings={heatmapSettings}
      setHeatmapSettings={setHeatmapSettings}
      customMarkers={customMarkers}
      projectDir={activeDataDir || ''}
      onRecordTimelineSegmentsChange={handleRecordTimelineSegmentsChange}
      onVideoExportStatusChange={handleVideoExportStatusChange}
    />
  );

  const renderMappingView = () => (
    <MappingPage records={eyeTrackingRecords} projectDir={activeDataDir || ''} />
  );

  const renderChartView = () => (
    <ChartPage
      aoiColorDefs={aoiColorDefs}
      stimuli={stimuli}
      records={records}
      projectDir={activeDataDir || ''}
      preferredRecordId={selectedRecordId || aoiSelectedRecordId || null}
      chartMode={chartMode}
      onChartModeChange={setChartMode}
      chartPreselectedRecordIds={chartPreselectedRecordIds}
      onNotify={showNotice}
      onCompareResultChange={setLatestCompareResult}
      aiBusy={chartAiBusy}
      aiBusyText={chartAiBusyText}
      onAiBusyChange={(busy, text) => {
        setChartAiBusy(busy);
        setChartAiBusyText(text || '');
      }}
      onInsightGenerated={(report, compare) => {
        setLatestCompareResult(compare);
        setLatestInsightReport(report);
        setActiveTab('insight');
      }}
    />
  );

  const renderInsightView = () => (
    <InsightPage
      key={`${language}-${latestInsightReport?.id || 'no-report'}-${latestCompareResult?.id || 'no-compare'}`}
      projectDir={activeDataDir || ''}
      report={latestInsightReport}
      compareResult={latestCompareResult}
      onNotify={showNotice}
    />
  );

  const renderExportView = () => (
    <ExportPage
      records={records}
      subjects={subjects}
      subjectFields={subjectFields}
      primaryButtonClassName={btnPrimary}
      projectDir={activeDataDir || null}
    />
  );

  const handleAoiContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (aoiDrawing && aoiTool === 'polygon' && aoiDraft) {
      const pts = aoiDraft.points || [];
      if (pts.length >= 3) {
        let area = 0;
        for (let i = 0; i < pts.length; i += 1) {
          const j = (i + 1) % pts.length;
          area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
        }
        area = Math.abs(area / 2);
        const newId = `aoi_${Date.now()}`;
        const newName = `AOI ${aoiShapes.length + 1}`;
        const finalShape = {
          ...aoiDraft,
          id: newId,
          name: newName,
          metric: Math.round(area),
          points: pts,
        };
        setAoiShapes((prev) => [...prev, finalShape]);
        setAoiSelectedId(newId);
      }
      setAoiDraft(null);
      setAoiDrawing(false);
      setAoiCursor(null);
      setAoiTool(null);
    }
  };

  const renderAoiView = () => (
    <AoiPage
      aoiTool={aoiTool}
      aoiDrawing={aoiDrawing}
      aoiSelectedId={aoiSelectedId}
      setAoiSelectedId={setAoiSelectedId}
      aoiShapes={aoiShapes}
      setAoiShapes={setAoiShapes}
      aoiDraft={aoiDraft}
      aoiCursor={aoiCursor}
      aoiCanvasRef={aoiCanvasRef}
      aoiVideoRef={aoiVideoRef}
      aoiSelectedStimulusId={aoiSelectedStimulusId}
      setAoiSelectedStimulusId={setAoiSelectedStimulusId}
      aoiSelectedRecordId={aoiSelectedRecordId}
      setAoiSelectedRecordId={setAoiSelectedRecordId}
      aoiVideoUrl={aoiVideoUrl}
      aoiSyncVideoMeta={aoiSyncVideoMeta}
      aoiClearVideoMeta={aoiClearVideoMeta}
      stimuli={stimuli}
      records={eyeTrackingRecords}
      aoiStartDraw={aoiStartDraw}
      aoiOnMouseDown={aoiOnMouseDown}
      aoiOnMouseMove={aoiOnMouseMove}
      aoiOnMouseUp={aoiOnMouseUp}
      aoiRename={aoiRename}
      aoiOpacity={aoiOpacity}
      setAoiOpacity={setAoiOpacity}
      aoiBorderWidth={aoiBorderWidth}
      setAoiBorderWidth={setAoiBorderWidth}
      aoiFontSize={aoiFontSize}
      setAoiFontSize={setAoiFontSize}
      aoiShowName={aoiShowName}
      setAoiShowName={setAoiShowName}
      aoiColorDefs={aoiColorDefs}
      selectedAoi={selectedAoi}
      aoiOnContextMenu={handleAoiContextMenu}
      customMarkers={customMarkers}
      projectDir={activeDataDir || ''}
      onRecordTimelineSegmentsChange={handleRecordTimelineSegmentsChange}
    />
  );

  const renderFacialView = () => (
    <FacialAnalysisPage
      projectDir={activeDataDir || null}
      selectedRecordId={selectedRecordId}
      onSelectRecord={setSelectedRecordId}
      onListCameras={async () => {
        const cameras = await refreshFacialCameras();
        return { ok: cameras.length > 0, cameras, message: cameras.length > 0 ? undefined : '未检测到摄像头' };
      }}
      onStartCapture={async (params: { recordId: string; cameraIndex: number; width: number; height: number; fps: number }) => {
        if (!activeDataDir) return { ok: false, message: '未选择项目' };
        const previewStarted = facialBrowserPreviewRef.current
          ? true
          : await startFacialPreview(params.cameraIndex);
        if (!previewStarted) return { ok: false, message: '表情摄像头启动失败' };
        const captureStarted = await startFacialAutoCapture(params.recordId);
        return { ok: captureStarted, message: captureStarted ? undefined : '表情视频录制启动失败' };
      }}
      onStopCapture={async () => {
        return stopFacialAutoCapture();
      }}
      onRunAnalysis={async (params: { recordId: string }) => {
        if (!activeDataDir) return { ok: false, message: '未选择项目' };
        const connected = await ensureFacialServerAndConnect();
        if (!connected) return { ok: false, message: '表情分析暂不可用' };
        const videoPath = `${activeDataDir}/facial-analysis/${params.recordId}/source/face.mp4`;
        const outputPath = `${activeDataDir}/facial-analysis/${params.recordId}/analysis/result.json`;
        const result = await sendCmdWithResponse({
          wsCmdRef: facialWsCmdRef,
          id: 'run_analysis',
          args: { video: videoPath, output: outputPath, record_id: params.recordId },
          timeoutMs: 300000,
        });
        const resp = result.response || {};
        if (resp.error === 0 || resp.ok) {
          await loadRecordsForProject({ projectDir: activeDataDir, setRecords });
          return { ok: true, result: resp.result };
        }
        return { ok: false, message: resp.msg || '分析失败' };
      }}
    />
  );

  const handleShowProjectInFinder = async (projectId: string) => {
    const projectDir = projectDirs[projectId];
    if (!projectDir) return;
    if (!ipcClient.isAvailable()) return;
    const res = await ipcClient.showInFinder({ path: projectDir });
    if (!res.ok) {
      const msg = 'message' in res ? res.message : undefined;
      showNotice(msg || '在资源文件夹中显示失败');
    }
  };

  const handleRemoveProjectFromList = async (projectId: string) => {
    const projectDir = projectDirs[projectId];
    if (!projectDir) return;
    try {
      const rawHidden = localStorage.getItem('hiddenProjectDirs');
      const arrHidden = rawHidden ? (JSON.parse(rawHidden) as unknown) : [];
      const nextHidden = Array.isArray(arrHidden) ? (arrHidden as unknown[]).filter((v) => typeof v === 'string') : [];
      if (!nextHidden.includes(projectDir)) nextHidden.unshift(projectDir);
      localStorage.setItem('hiddenProjectDirs', JSON.stringify(nextHidden.slice(0, 500)));
    } catch {
      localStorage.setItem('hiddenProjectDirs', JSON.stringify([projectDir]));
    }
    try {
      const rawPinned = localStorage.getItem('pinnedProjectDirs');
      const arrPinned = rawPinned ? (JSON.parse(rawPinned) as unknown) : [];
      const nextPinned = Array.isArray(arrPinned) ? (arrPinned as unknown[]).filter((v) => typeof v === 'string') : [];
      const filtered = nextPinned.filter((v) => v !== projectDir);
      localStorage.setItem('pinnedProjectDirs', JSON.stringify(filtered));
    } catch {
    }
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
    setProjectDirs((prev) => {
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
    await refreshProjectLibrary();
  };

  const handleSetProjectDisplayName = async (projectId: string, displayName: string) => {
    const projectDir = projectDirs[projectId];
    if (!projectDir) return;
    if (!ipcClient.isAvailable()) return;
    const loadRes = await ipcClient.loadProjectMeta({ projectDir });
    if (!loadRes || !loadRes.ok) {
      const msg = 'message' in loadRes ? loadRes.message : undefined;
      showNotice(msg || '读取 project.json 失败');
      return;
    }
    const baseName = projectDir.split(/[\\/]/).filter(Boolean).pop() || 'project';
    const nextName = String(displayName || '').trim() || baseName;
    const nextProject = { ...asUnknownRecord(loadRes.project), name: nextName };
    const saveRes = await ipcClient.saveProjectMeta({ projectDir, project: nextProject });
    if (!saveRes || !saveRes.ok) {
      const msg = 'message' in saveRes ? saveRes.message : undefined;
      showNotice(msg || '写入 project.json 失败');
      return;
    }
    await refreshProjectLibrary();
  };

  const removeProjectDirFromStorageLists = (projectDir: string) => {
    const updateList = (key: string) => {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return;
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return;
        const next = parsed.filter((item) => typeof item === 'string' && item !== projectDir);
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
      }
    };
    updateList('hiddenProjectDirs');
    updateList('pinnedProjectDirs');
  };

  const handleDeleteProject = () => {
    if (!activeProjectId) {
      showNotice('请先选择工程');
      return;
    }
    const projectDir = projectDirs[activeProjectId];
    if (!projectDir) {
      showNotice('未找到工程目录');
      return;
    }
    if (!ipcClient.isAvailable()) {
      showNotice('ipc 不可用');
      return;
    }

    const projectName = String(activeProject?.name || activeProjectId || '').trim() || '当前工程';
    setConfirmState({
      open: true,
      title: '删除工程',
      message: `确定要删除工程「${projectName}」吗？\n此操作会永久删除工程目录及其全部数据，且不可恢复。`,
      confirmText: '删除',
      confirmVariant: 'danger',
      onConfirm: () => {
        void (async () => {
          const res = await ipcClient.deleteProject({ projectDir });
          if (!res.ok) {
            const msg = 'message' in res ? res.message : undefined;
            showNotice(msg || '删除工程失败');
            return;
          }

          localStorage.removeItem(getExperimentStorageKey(projectDir));
          removeProjectDirFromStorageLists(projectDir);

          setProjects((prev) => prev.filter((p) => p.id !== activeProjectId));
          setProjectDirs((prev) => {
            const next = { ...prev };
            delete next[activeProjectId];
            return next;
          });

          setCurrentView('dashboard');
          setActiveProjectId(null);
          setActiveTab('project-settings');
          setEditedProject(null);
          setHasProjectChanges(false);
          setExperiments([]);
          setActiveExperimentId('');
          setSubjects([]);
          setStimuli([]);
          setRecords([]);
          setChartMode('single');
          setChartPreselectedRecordIds([]);
          setLatestCompareResult(null);
          setLatestInsightReport(null);
          setCustomMarkers([]);
          setSelectedRecordId(null);
          setSubjectFields(DEFAULT_SUBJECT_FIELDS);
          setVisibleRecordIds(new Set());
          setHeatmapPointsByRecord({});
          setAoiSelectedRecordId(null);

          await refreshProjectLibrary();
          showNotice('工程删除成功');
        })();
      },
    });
  };

  const renderContent = () => {
    if (currentView === 'dashboard') {
      const fuzzyMatch = (name: string, query: string): boolean => {
        const q = String(query || '').trim();
        if (!q) return true;
        const normalize = (s: string) => String(s || '').toLowerCase().replace(/\s+/g, '');
        const hay = normalize(name);
        const tokens = q.split(/\s+/).map((t) => normalize(t)).filter(Boolean);
        const matchOne = (needle: string) => {
          if (!needle) return true;
          if (hay.includes(needle)) return true;
          let i = 0;
          for (let j = 0; j < hay.length && i < needle.length; j += 1) {
            if (hay[j] === needle[i]) i += 1;
          }
          return i === needle.length;
        };
        return tokens.every(matchOne);
      };
      const filtered = projects.filter((project) => fuzzyMatch(String(project.name || ''), dashboardSearchQuery));
      return (
        <DashboardPage
          projects={filtered}
          projectDirs={projectDirs}
          onOpenProject={handleOpenProject}
          onShowInFinder={handleShowProjectInFinder}
          onRemoveFromList={handleRemoveProjectFromList}
          onSetProjectDisplayName={handleSetProjectDisplayName}
        />
      );
    }

    if (effectiveHiddenTabs.includes(activeTab)) return null;
    switch (activeTab) {
      case 'project-settings': return renderProjectSettingsView();
      case 'subject': return renderSubjectView();
      case 'images': return renderStimulusView();
      case 'video': return renderRecordingView();
      case 'visual': return renderVisualView();
      case 'mapping': return renderMappingView();
      case 'aoi': return renderAoiView();
      case 'chart': return renderChartView();
      case 'insight': return renderInsightView();
      case 'facial': return renderFacialView();
      case 'export': return renderExportView();
      case 'monitor': return selectedRecordId ? renderRecordDetailView() : renderRecordsListView();
      default: return null;
    }
  };

  const handleStartCompareFromRecords = (recordIds: string[]) => {
    if (!Array.isArray(recordIds) || recordIds.length === 0) {
      showNotice('请先选择至少一条记录');
      return;
    }
    setChartPreselectedRecordIds(recordIds);
    setChartMode('compare');
    setActiveTab('chart');
    setSelectedRecordId(null);
  };

  const renderRecordsListView = () => (
    <RecordsListPage
      records={records}
      project={activeProject}
      onSelectRecord={(recordId, modality) => {
        setRecordDetailModality(modality);
        setSelectedRecordId(recordId);
      }}
      onDeleteRecord={handleDeleteRecord}
      onStartCompare={handleStartCompareFromRecords}
    />
  );

  // Cleanup effect: Close all connections when component unmounts or app closes
  useEffect(() => {
    return () => {
      console.log('[MrtApp] Cleanup: stopping device and closing all connections');
      if (!simulateMode) {
        const cmdWs = wsCmdRef.current;
        if (cmdWs && cmdWs.readyState === WebSocket.OPEN) {
          try {
            sendCmdOverWs({ wsCmdRef, id: 'stop_recording', args: {} });
          } catch {
          }
          void stopDeviceCommand({ wsCmdRef, timeoutMs: 1200 });
        }
      }
      void stopActiveAudioRecording();
      closeEncodedVideoPreview();
      closeWebSocketRef(wsImageRef);
      closeWebSocketRef(wsCmdRef);
      closeWebSocketRef(wsEyeRef);
      // 表情模块清理
      if (facialWsCmdRef.current && facialWsCmdRef.current.readyState === WebSocket.OPEN) {
        try { facialWsCmdRef.current.send(JSON.stringify({ type: 'req_cmd', id: 'stop_preview', args: {} })); } catch {}
      }
      void stopFacialAutoCapture();
      facialBrowserPreviewRef.current?.stop();
      facialBrowserPreviewRef.current = null;
      closeWebSocketRef(facialImageWsRef);
      closeWebSocketRef(facialWsCmdRef);
      if (ipcClient.isAvailable()) {
        void ipcClient.closeRecordingWindow();
      }
    };
  }, [simulateMode, closeEncodedVideoPreview, stopFacialAutoCapture]);

  return (
    <div className="mrt-app-shell flex h-screen w-full bg-[var(--app-bg)] overflow-hidden text-[var(--app-text)]">
      {currentView === 'detail' && (
        <StableSidebar
          onBack={() => {
            void guardedNavigate(() => {
              setCurrentView('dashboard');
              setSelectedRecordId(null);
            });
          }}
          activeTab={activeTab} 
          onTabChange={(t) => {
            if ((t as TabType) === activeTab) return;
            void guardedNavigate(() => {
              setActiveTab(t as TabType);
              setSelectedRecordId(null);
            });
          }}
          projectDir={activeDataDir}
          project={activeProject}
          hiddenTabs={effectiveHiddenTabs}
          multiplayerProps={{
            projectName: activeProject?.name || '',
            experimentName: activeExperiment?.name || '',
            localStatus: {
              deviceConnected: isCameraOn,
              recordingEligible: multiplayerRecordingEligibility.eligible,
              recordingEligibilityReason: multiplayerRecordingEligibility.reason,
              recording: isRecording,
              finalizing: isRecordingFinalizing,
              experimentDir: activeDataDir || '',
            },
            onStartLocalRecording: () => {
              if (isRecording || isRecordingFinalizing) return;
              void handleStartRecording();
            },
            onStopLocalRecording: () => {
              if (!isRecording) return;
              void handleStopRecording();
            },
            onPackageSynced: async () => {
              if (!activeDataDir) return;
              await loadProjectDetailData({
                projectDir: activeDataDir,
                setSubjects,
                setSubjectFields,
                setStimuli,
                setRecords,
                setCustomMarkers,
              });
            },
            onPrepareLocalRecording: async () => {
              await preloadStimulusMedia(stimuli);
              const requiresEyeCalibration = hasEyeTrackingModality
                && !hiddenRecordingMonitorTileIds.includes('device');
              if (!requiresEyeCalibration) return;
              if (!isCameraOn) throw new Error('设备未开启');
              let reusableCoe = typeof calibrationCoe === 'string' ? calibrationCoe.trim() : '';
              if (!reusableCoe) {
                const savedCalibration = await loadSavedCalibrationForCurrentSubject();
                reusableCoe = String(savedCalibration.coe || '').trim();
                if (reusableCoe) setCalibrationCoe(reusableCoe);
                if (savedCalibration.scores) setCalibrationScores(savedCalibration.scores);
              }
              if (!reusableCoe) throw new Error('当前受试者没有可复用的校准数据');
              const applied = await applyCalibrationBeforeRecording(reusableCoe);
              if (!applied.ok) throw new Error(`校准预应用失败：${applied.error || '未知错误'}`);
            },
            onNotify: showNotice,
          }}
        />
      )}

      <main className="flex-1 flex flex-col min-w-0">
        <StableHeader
          currentView={currentView}
          activeTab={activeTab}
          handleSetupProjectLibrary={handleSetupProjectLibrary}
          handleAddExistingProject={handleAddExistingProject}
          setIsNewProjectModalOpen={setIsNewProjectModalOpen}
          projectRootPath={projectRootPath}
          setIsNewSubjectModalOpen={setIsNewSubjectModalOpen}
          setIsFieldManagerOpen={setIsFieldManagerOpen}
          onOpenAddStimulus={() => setIsAddStimulusModalOpen(true)}
          onStartPreview={handleStartPreview}
          wsIp={wsIp}
          setWsIp={setWsIp}
          wsImagePort={wsImagePort}
          setWsImagePort={setWsImagePort}
          wsEyePort={wsEyePort}
          setWsEyePort={setWsEyePort}
          wsConnected={wsConnected}
          toggleScreenRecorder={toggleScreenRecorder}
          isCameraOn={isCameraOn}
          toggleCamera={toggleCamera}
          isDeviceToggling={isDeviceToggling}
          handleStartRecording={handleStartRecording}
          handleStopRecording={handleStopRecording}
          isRecording={isRecording}
          isRecordingFinalizing={isRecordingFinalizing}
          isPreviewing={isPreviewing}
          recordingViewMode={recordingSettings.recordingViewMode || null}
          requiresRecordingModeSelection={hasEyeTrackingModality && activeDeviceProfile.deviceType === '眼镜式'}
          recordingMonitorLayout={recordingMonitorLayout}
          onRecordingMonitorLayoutChange={isFixedRemoteEyeMonitor ? undefined : setRecordingMonitorLayout}
          onResetRecordingMonitorLayout={() => {
            setRecordingMonitorLayout('single');
            setHiddenRecordingMonitorTileIds(['participant', 'facial']);
            setRecordingMonitorLayoutResetToken((value) => value + 1);
          }}
          hiddenRecordingMonitorTiles={(isFixedRemoteEyeMonitor ? [] : hiddenRecordingMonitorTileIds)
            .filter((id) => {
              // 「重新添加」按钮只应列出用户手动隐藏、且模态仍启用的 tile；
              // 模态未启用的 tile 不在此列（它们并非被隐藏，而是不适用于当前工程）。
              return enabledRecordingModalities.includes(MONITOR_TILE_MODALITY[id as MonitorTileId]);
            })
            .map((id) => ({
              id,
              title: id === 'device'
                ? '眼动检测'
                : id === 'participant'
                  ? '被试屏幕'
                  : '表情检测',
            }))}
          onRestoreRecordingMonitorTile={(id) => {
            if (isFixedRemoteEyeMonitor) return;
            if (id === 'participant') {
              setRecordingSettings((current) => ({ ...current, splitScreenMode: true }));
            }
            if (id !== 'device') {
              setRecordingMonitorLayout((current) => current === 'single' ? '2x2' : current);
            }
            setHiddenRecordingMonitorTileIds((current) => {
              const next = current.filter((tileId) => tileId !== id);
              // 眼镜式（aSeeGlassesPlus）下眼动/表情采集互斥：恢复其中一个就隐藏另一个，
              // 避免两个摄像头同时存在触发 vendor SDK 多摄像头死锁。
              if (activeDeviceProfile.deviceType === '眼镜式' && (id === 'device' || id === 'facial')) {
                const exclusive = id === 'device' ? 'facial' : 'device';
                if (!next.includes(exclusive)) next.push(exclusive);
              }
              return next;
            });
          }}
          dashboardSearchQuery={dashboardSearchQuery}
          setDashboardSearchQuery={setDashboardSearchQuery}
        />

        <div className="px-4 pb-4 flex-1 overflow-hidden">
          <div className="h-full flex flex-col">
            <Suspense fallback={<PageLoadingFallback />}>{renderContent()}</Suspense>
          </div>
        </div>

        <StableFooter
          currentView={currentView}
          activeProject={activeProject}
          activeTab={activeTab}
          projectRootPath={projectRootPath}
          activeProjectDir={activeProjectDir}
          deviceConnected={isCameraOn}
          wsConnected={wsConnected}
          lastImageAt={lastImageAt}
          videoExportStatus={videoExportStatus}
          projectImportStatus={projectImportStatus}
        />
      </main>

      <NewProjectModal
        isOpen={isNewProjectModalOpen}
        onClose={() => setIsNewProjectModalOpen(false)}
        newProjectData={newProjectData}
        setNewProjectData={setNewProjectData}
        onCreate={handleCreateProject}
      />

      <NewExperimentModal
        isOpen={isNewExperimentModalOpen}
        onClose={() => setIsNewExperimentModalOpen(false)}
        name={newExperimentName}
        setName={setNewExperimentName}
        onCreate={() => {
          void handleConfirmCreateExperiment();
        }}
        />

      <NewSubjectModal
        isOpen={isNewSubjectModalOpen}
        onClose={() => setIsNewSubjectModalOpen(false)}
        onCreate={handleCreateSubject}
        newSubjectData={newSubjectData}
        setNewSubjectData={setNewSubjectData}
        subjectFields={subjectFields}
      />

      <EditSubjectModal
        isOpen={isEditSubjectModalOpen}
        onClose={() => setIsEditSubjectModalOpen(false)}
        onSave={handleSaveEditedSubject}
        editSubjectData={editSubjectData}
        setEditSubjectData={setEditSubjectData}
        subjectFields={subjectFields}
      />

      <EditStimulusModal
        isOpen={isEditStimulusModalOpen}
        onClose={() => setIsEditStimulusModalOpen(false)}
        onSave={handleSaveEditedStimulus}
        editStimulusName={editStimulusName}
        setEditStimulusName={setEditStimulusName}
        stimulusNameLocked={editStimulusNameLocked}
        editStimulusFixedTimeSec={editStimulusFixedTimeSec}
        setEditStimulusFixedTimeSec={setEditStimulusFixedTimeSec}
        editStimulusActive={editStimulusActive}
        setEditStimulusActive={setEditStimulusActive}
        bgColor={editStimulusBgColor}
        setBgColor={setEditStimulusBgColor}
        fontSize={editStimulusFontSize}
        setFontSize={setEditStimulusFontSize}
        fontColor={editStimulusFontColor}
        setFontColor={setEditStimulusFontColor}
        textValue={editStimulusText}
        setTextValue={setEditStimulusText}
        webUrl={editStimulusWebUrl}
        setWebUrl={setEditStimulusWebUrl}
        externalMarker={editStimulusExternalMarker}
        setExternalMarker={setEditStimulusExternalMarker}
        endOnClick={editStimulusEndOnClick}
        setEndOnClick={setEditStimulusEndOnClick}
        endOnKey={editStimulusEndOnKey}
        setEndOnKey={setEditStimulusEndOnKey}
        group={editStimulusGroup}
        setGroup={setEditStimulusGroup}
        stimulusType={stimuli.find((stimulus) => stimulus.id === editingStimulusId)?.stimulusType}
        randomPlay={editStimulusRandomPlay}
        setRandomPlay={setEditStimulusRandomPlay}
        triggerEnabled={editStimulusTriggerEnabled}
        setTriggerEnabled={setEditStimulusTriggerEnabled}
        triggerMark={editStimulusTriggerMark}
        setTriggerMark={setEditStimulusTriggerMark}
        groupPlayMode={editStimulusGroupPlayMode}
        setGroupPlayMode={setEditStimulusGroupPlayMode}
        groupRandomCount={editStimulusGroupRandomCount}
        setGroupRandomCount={setEditStimulusGroupRandomCount}
        groupRepeatCount={editStimulusGroupRepeatCount}
        setGroupRepeatCount={setEditStimulusGroupRepeatCount}
        editStimulusPlayToEnd={editStimulusPlayToEnd}
        setEditStimulusPlayToEnd={setEditStimulusPlayToEnd}
        comboItems={editStimulusComboItems}
        setComboItems={setEditStimulusComboItems}
        comboCanvasStyle={editStimulusComboCanvasStyle}
        setComboCanvasStyle={setEditStimulusComboCanvasStyle}
        onUploadComboFiles={handleUploadComboFiles}
        onStartComboScreenRecording={handleStartComboScreenRecording}
        onStopComboScreenRecording={handleStopComboScreenRecording}
      />

      <AddStimulusModal
        isOpen={isAddStimulusModalOpen}
        onClose={() => setIsAddStimulusModalOpen(false)}
        kind={addStimulusKind}
        setKind={setAddStimulusKind}
        name={addStimulusName}
        setName={setAddStimulusName}
        textValue={addStimulusText}
        setTextValue={setAddStimulusText}
        webUrl={addStimulusWebUrl}
        setWebUrl={setAddStimulusWebUrl}
        onUploadFiles={handleUploadStimuli}
        onStartScreenRecording={handleStartScreenRecordingStimulus}
        onStopScreenRecording={handleStopScreenRecordingStimulus}
        onAddText={handleAddTextStimulus}
        onAddWeb={handleAddWebStimulus}
        onAddGroup={handleAddGroupStimulus}
        onAddCombo={handleAddComboStimulus}
      />

      <SubjectFieldsManagerModal
        isOpen={isFieldManagerOpen}
        onClose={() => setIsFieldManagerOpen(false)}
        subjectFields={subjectFields}
        setSubjectFields={setSubjectFields}
      />

      <ConfirmModal confirmState={confirmState} setConfirmState={setConfirmState} />

      <FullscreenRecordingOverlay
        isRecording={
          (isRecording || isPreviewing) &&
          !Boolean(recordingSettings?.splitScreenMode)
        }
        isPreviewing={isPreviewing}
        playbackIndex={playbackIndex}
        stimuli={stimuli}
        bgColor={recordingSettings.bgColor || '#000000'}
        eyeDataStore={eyeDataStore}
        hideGaze={Boolean(recordingSettings?.hideGaze)}
        calibrationMode={activeDeviceProfile.calibrationMode}
        calibrationState={calibrationState}
        calibrationPointStyle={normalizeCalibrationPointStyle(recordingSettings.calibrationPointStyle)}
        playbackSequence={playbackSequenceRef.current}
        language={language}
      />
      {showFullscreenCalibrationOverlay && (
        <FullscreenCalibrationOverlay
          calibrationState={calibrationState}
          calibPointIndex={calibPointIndex}
          calibScale={calibScale}
          eyeDataStore={eyeDataStore}
          calibrationMode={activeDeviceProfile.calibrationMode}
          sceneImageSrc={null}
          hideGaze={Boolean(recordingSettings?.hideGaze)}
          isCalibrationTestMode={isCalibrationTestMode}
          calibrationPointStyle={normalizeCalibrationPointStyle(recordingSettings.calibrationPointStyle)}
          language={language}
          onConfirmPoint={(point) => triggerCurrentPoint(point)}
          onExit={handleCancelCalibration}
        />
      )}
    </div>
  );
};

export default MrtApp;
