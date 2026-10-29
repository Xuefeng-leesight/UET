import React from 'react';
import {
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  FileVideo,
  FastForward,
  Import,
  Pause,
  Play,
  Rewind,
  ScanFace,
  SkipBack,
  SkipForward,
  RefreshCw,
  Square,
} from 'lucide-react';
import CustomSelect from '@/shared/ui/CustomSelect';
import { ipcClient, type FacialAnalysisManifest, type FacialAnalysisResultData, type FacialCamera, type FacialRecordingRecord, type FacialTimelineEvent } from '@/infrastructure/electron/ipcClient';
import { DEFAULT_FACIAL_RECORDING_SETTINGS, normalizeFacialRecordingSettings } from '@/features/recording/domain/recordingModules';
import { buildFacialMeshEdges, FACE_OVAL, INNER_LIPS, isRenderableFacialLandmark, LEFT_EYE, OUTER_LIPS, RIGHT_EYE } from '@/features/recording/domain/facialOverlay';
import FacialSettingToggle from '@/features/recording/domain/FacialSettingToggle';
import { useLanguage } from '@/app/i18n/useLanguage';
import { localizeFacialAnalysisLabel, localizeFacialExpressionLabel } from '@/features/facial/domain/facialLabels';

interface FacialAnalysisPageProps {
  projectDir: string | null;
  selectedRecordId: string | null;
  onSelectRecord: (recordId: string) => void;
  onListCameras: () => Promise<{ ok: boolean; cameras: FacialCamera[]; message?: string }>;
  onStartCapture: (params: { recordId: string; cameraIndex: number; width: number; height: number; fps: number }) => Promise<{ ok: boolean; message?: string }>;
  onStopCapture: () => Promise<{ ok: boolean; message?: string }>;
  onRunAnalysis: (params: { recordId: string }) => Promise<{ ok: boolean; result?: FacialAnalysisResultData; message?: string }>;
}

type SideTab = 'results' | 'settings';

const EMOTION_COLORS: Record<string, string> = {
  '中性': '#06b6d4',
  '高兴': '#f59e0b',
  '悲伤': '#3b82f6',
  '愤怒': '#ef4444',
  '惊讶': '#f97316',
  '恐惧': '#8b5cf6',
  '厌恶': '#22c55e',
  '轻蔑': '#94a3b8',
};

const EMOTION_BG_CLASS: Record<string, string> = {
  '中性': 'bg-cyan-500',
  '高兴': 'bg-amber-500',
  '悲伤': 'bg-blue-500',
  '愤怒': 'bg-red-500',
  '惊讶': 'bg-orange-500',
  '恐惧': 'bg-purple-500',
  '厌恶': 'bg-green-500',
  '轻蔑': 'bg-slate-400',
};

const analysisTracks = [
  { id: 'emotion', label: '基础表情', hint: '8种表情事件，独立颜色', color: 'bg-sky-400' },
  { id: 'expression', label: '微表情 Top', hint: '按峰值取前6个最显著的微表情', color: 'bg-emerald-400' },
];

const timelineTicks = ['00:00', '00:10', '00:20', '00:30', '00:40', '00:50', '01:00'];

const FacialAnalysisPage: React.FC<FacialAnalysisPageProps> = ({
  projectDir,
  selectedRecordId,
  onSelectRecord,
  onListCameras,
  onStartCapture,
  onStopCapture,
  onRunAnalysis,
}) => {
  const { language } = useLanguage();
  const isEn = language === 'en-US';
  const [records, setRecords] = React.useState<FacialRecordingRecord[]>([]);
  const effectiveRecordId = records.some((record) => record.id === selectedRecordId)
    ? selectedRecordId
    : records[0]?.id || '';
  const selectedRecord = records.find((record) => record.id === effectiveRecordId) || null;
  const [sideTab, setSideTab] = React.useState<SideTab>('results');
  const [isTimelineExpanded, setIsTimelineExpanded] = React.useState(false);
  const [showAnalysisFaceBox, setShowAnalysisFaceBox] = React.useState(true);
  const [showAnalysisFaceMask, setShowAnalysisFaceMask] = React.useState(false);
  const [allowImport, setAllowImport] = React.useState(true);
  const [autoAlign, setAutoAlign] = React.useState(true);
  const [reportMode, setReportMode] = React.useState(true);
  const [manifest, setManifest] = React.useState<FacialAnalysisManifest | null>(null);
  const [analysisResult, setAnalysisResult] = React.useState<FacialAnalysisResultData | null>(null);
  const [videoUrl, setVideoUrl] = React.useState<string | null>(null);
  const [resourceLoading, setResourceLoading] = React.useState(false);
  const [analysisRunning, setAnalysisRunning] = React.useState(false);
  const [analysisExporting, setAnalysisExporting] = React.useState(false);
  const [cameras, setCameras] = React.useState<FacialCamera[]>([]);
  const [cameraId, setCameraId] = React.useState('');
  const [cameraLoading, setCameraLoading] = React.useState(false);
  const [isCapturing, setIsCapturing] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const [showAllMicros, setShowAllMicros] = React.useState(false);
  const [duration, setDuration] = React.useState(0);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [videoFrameSize, setVideoFrameSize] = React.useState({ width: 640, height: 480 });
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const loadResourceTokenRef = React.useRef(0);
  const currentSample = React.useMemo(() => {
    const samples = analysisResult?.samples || [];
    if (samples.length === 0) return null;
    const targetMs = currentTime * 1000;
    let low = 0;
    let high = samples.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const sampleT = samples[middle].t ?? samples[middle].timestampMs;
      if (sampleT < targetMs) low = middle + 1;
      else high = middle;
    }
    const right = samples[low];
    const left = samples[Math.max(0, low - 1)];
    const leftT = left.t ?? left.timestampMs ?? 0;
    const rightT = right.t ?? right.timestampMs ?? 0;
    return Math.abs(leftT - targetMs) <= Math.abs(rightT - targetMs) ? left : right;
  }, [analysisResult, currentTime]);
  const analysisLandmarks = currentSample?.landmarks || [];
  const hasCompleteAnalysisLandmarks = analysisLandmarks.length >= 468;
  const analysisMeshEdges = React.useMemo(
    () => hasCompleteAnalysisLandmarks ? buildFacialMeshEdges(analysisLandmarks) : [],
    [analysisLandmarks.length, hasCompleteAnalysisLandmarks],
  );
  const currentExpressionValues = React.useMemo(() => {
    return Object.entries(currentSample?.expressions || {})
      .map(([label, value]) => ({ label: localizeFacialExpressionLabel(label, isEn), value: Math.max(0, Math.min(1, Number(value) || 0)) }))
      .sort((a, b) => b.value - a.value);
  }, [currentSample, isEn]);

  const currentEmotionBars = React.useMemo(() => {
    if (!currentSample) return [] as Array<{ label: string; value: number; active: boolean; color: string }>;
    const hasSavedBasicScores = currentSample.basicEmotionScores
      && Object.keys(currentSample.basicEmotionScores).length > 0;
    const scores = hasSavedBasicScores
      ? currentSample.basicEmotionScores || {}
      : currentSample.emotionScores || {};
    const topEmotion = hasSavedBasicScores
      ? currentSample.basicEmotionLabel || ''
      : currentSample.emotion || currentSample.basicEmotionLabel || '';
    const emotionOrder = ['中性', '高兴', '悲伤', '愤怒', '惊讶', '恐惧', '厌恶', '轻蔑'];
    return emotionOrder.map(label => ({
      label,
      value: Math.max(0, Math.min(1, Number(scores[label]) || 0)),
      active: label === topEmotion,
      color: EMOTION_COLORS[label] || '#94a3b8',
    }));
  }, [currentSample]);

  const loadFacialRecords = React.useCallback(async () => {
    if (!projectDir) {
      setRecords([]);
      return;
    }
    const response = await ipcClient.listFacialAnalysisRecords({ projectDir });
    setRecords(response.ok ? response.records : []);
    if (!response.ok && response.message) setNotice(response.message);
  }, [projectDir]);

  React.useEffect(() => {
    void loadFacialRecords();
  }, [loadFacialRecords]);

  React.useEffect(() => {
    if (!projectDir) return;
    try {
      const stored = JSON.parse(localStorage.getItem(`facial-analysis-settings:${projectDir}`) || '{}');
      const normalized = normalizeFacialRecordingSettings(stored);
      if (normalized.cameraId) setCameraId(normalized.cameraId);
      const display = JSON.parse(localStorage.getItem(`facial-analysis-display-settings:${projectDir}`) || '{}');
      setShowAnalysisFaceBox(typeof display.showFaceBox === 'boolean' ? display.showFaceBox : true);
      setShowAnalysisFaceMask(typeof display.showFaceMask === 'boolean' ? display.showFaceMask : false);
    } catch {
    }
  }, [projectDir]);

  const loadResource = React.useCallback(async () => {
    if (!projectDir || !effectiveRecordId) {
      setManifest(null);
      setAnalysisResult(null);
      setVideoUrl(null);
      return;
    }
    // Cancellation token: if the record/project changes while a previous
    // load is still in flight, the stale response is ignored so it can't
    // overwrite the newly selected record's state.
    const token = ++loadResourceTokenRef.current;
    setResourceLoading(true);
    setNotice('');
    const response = await ipcClient.loadFacialAnalysis({ projectDir, recordId: effectiveRecordId });
    if (token !== loadResourceTokenRef.current) return;
    setManifest(response.manifest);
    setAnalysisResult(response.result);
    setVideoUrl(response.videoUrl);
    if (!response.ok && response.message) setNotice(response.message);
    setResourceLoading(false);
  }, [effectiveRecordId, projectDir]);

  React.useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    void loadResource();
  }, [loadResource]);

  const handleImportVideo = async () => {
    if (!projectDir || !effectiveRecordId) return;
    setResourceLoading(true);
    setNotice('');
    const response = await ipcClient.importFacialVideo({ projectDir, recordId: effectiveRecordId, recordName: selectedRecord?.name, subjectName: selectedRecord?.subjectName });
    if (response.ok) {
      setManifest(response.manifest);
      setAnalysisResult(null);
      setVideoUrl(response.videoUrl);
      await loadFacialRecords();
    } else {
      setNotice(response.message || '导入表情视频失败');
    }
    setResourceLoading(false);
  };

  const handleExportAnalysis = async () => {
    if (!analysisResult || analysisExporting || !ipcClient.isAvailable()) return;
    setAnalysisExporting(true);
    setNotice('');
    try {
      const exportName = String(selectedRecord?.name || effectiveRecordId || 'facial-analysis').trim();
      const response = await ipcClient.exportTextFast({
        content: JSON.stringify(analysisResult, null, 2),
        defaultName: `${exportName}_表情模块分析.json`,
        title: '导出表情模块分析',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!response.ok && (!('reason' in response) || response.reason !== 'canceled')) {
        setNotice(('message' in response && response.message) || '导出表情分析失败');
      } else if (response.ok) {
        setNotice(isEn ? `Analysis result exported to: ${response.path}` : `分析结果已导出到：${response.path}`);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '导出表情分析失败');
    } finally {
      setAnalysisExporting(false);
    }
  };

  const refreshCameras = async () => {
    setCameraLoading(true);
    setNotice('');
    const response = await onListCameras();
    setCameras(response.cameras || []);
    setCameraId((current) => {
      const next = current || String(response.cameras?.[0]?.id || '');
      if (projectDir && next) {
        const camera = response.cameras?.find((item) => item.id === next);
        const stored = JSON.parse(localStorage.getItem(`facial-analysis-settings:${projectDir}`) || '{}');
        const normalized = normalizeFacialRecordingSettings({ ...stored, cameraId: next, cameraIndex: camera?.index ?? null });
        localStorage.setItem(`facial-analysis-settings:${projectDir}`, JSON.stringify(normalized));
      }
      return next;
    });
    if (!response.ok) setNotice(response.message || '读取摄像头失败');
    setCameraLoading(false);
  };

  const toggleCapture = async () => {
    if (!projectDir || !effectiveRecordId) return;
    if (isCapturing) {
      const response = await onStopCapture();
      setIsCapturing(false);
      if (response.ok) await loadResource();
      else setNotice(response.message || '停止表情采集失败');
      return;
    }
    const camera = cameras.find((item) => item.id === cameraId);
    if (!camera) {
      setNotice('请先刷新并选择表情摄像头');
      return;
    }
    const profile = DEFAULT_FACIAL_RECORDING_SETTINGS;
    const response = await onStartCapture({ recordId: effectiveRecordId, cameraIndex: camera.index, width: profile.width, height: profile.height, fps: profile.fps });
    if (response.ok) setIsCapturing(true);
    else setNotice(response.message || '启动表情采集失败');
  };

  const runAnalysis = async () => {
    if (!projectDir || !effectiveRecordId || !videoUrl || analysisRunning) return;
    setAnalysisRunning(true);
    setNotice('');
    const response = await onRunAnalysis({ recordId: effectiveRecordId });
    if (response.ok && response.result) {
      setAnalysisResult(response.result);
      await Promise.all([loadResource(), loadFacialRecords()]);
    } else {
      const errMsg = response.message || '表情分析失败';
      setNotice(errMsg.includes('Traceback') ? '表情分析失败，请稍后重试' : errMsg);
    }
    setAnalysisRunning(false);
  };

  const seekTo = (seconds: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(seconds)) return;
    video.currentTime = Math.max(0, Math.min(duration || 0, seconds));
    setCurrentTime(video.currentTime);
  };

  const formatTime = (seconds: number) => {
    const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    const minutes = Math.floor(safe / 60);
    const secs = Math.floor(safe % 60);
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  return (
    <div className="flex h-full min-h-0 gap-3 overflow-hidden">
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="flex h-10 shrink-0 items-center gap-4 bg-slate-50 px-4 text-[10px] font-bold text-slate-600">
          <div className="flex min-w-0 items-center gap-3">
            <ScanFace size={13} className="text-sky-500" />
            <span>表情视频</span>
          </div>
          <div className="flex-1" />
          <button type="button" onClick={runAnalysis} disabled={!videoUrl || analysisRunning || isCapturing} className="flex items-center gap-1 rounded px-2 py-1 text-sky-600 hover:bg-sky-50 disabled:cursor-not-allowed disabled:text-slate-300">
            {analysisRunning ? <RefreshCw size={12} className="animate-spin" /> : <ScanFace size={12} />}
            {analysisRunning ? '分析中…' : analysisResult ? '重新分析' : '开始分析'}
          </button>
          {(isCapturing || analysisResult) && (
            <div className={`flex items-center gap-1.5 ${isCapturing ? 'text-rose-600' : 'text-emerald-600'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${isCapturing ? 'animate-pulse bg-rose-500' : 'bg-emerald-500'}`} />
              {isCapturing ? '正在采集' : '分析完成'}
            </div>
          )}
        </div>

        <section className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden ${videoUrl ? 'bg-black' : 'bg-slate-50'}`}>
          {videoUrl ? (
            <video
              key={videoUrl}
              ref={videoRef}
              src={videoUrl}
              className="absolute inset-0 h-full w-full object-contain"
              onLoadedMetadata={(event) => {
                setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0);
                setVideoFrameSize({ width: event.currentTarget.videoWidth || 640, height: event.currentTarget.videoHeight || 480 });
              }}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime || 0)}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => setIsPlaying(false)}
            />
          ) : <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex flex-col items-center gap-2 text-slate-500">
              <Camera size={36} className="text-slate-300" />
              <div className="text-xs">
                {resourceLoading ? '正在读取表情视频…' : selectedRecord ? '未检测到表情视频，请导入视频或在录制时开启同步采集' : '请先在右侧选择一条分析记录'}
              </div>
            </div>
          </div>}
          {videoUrl && currentSample && (showAnalysisFaceBox || showAnalysisFaceMask) && (
            <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${videoFrameSize.width} ${videoFrameSize.height}`} preserveAspectRatio="xMidYMid meet">
              {showAnalysisFaceBox && currentSample.faceBox && (
                (() => {
                  const x = currentSample.faceBox.x * videoFrameSize.width;
                  const y = currentSample.faceBox.y * videoFrameSize.height;
                  const width = currentSample.faceBox.w * videoFrameSize.width;
                  const height = currentSample.faceBox.h * videoFrameSize.height;
                  const corner = Math.max(8, Math.min(18, width / 4, height / 4));
                  return <path
                    d={`M ${x + corner} ${y} H ${x} V ${y + corner} M ${x + width - corner} ${y} H ${x + width} V ${y + corner} M ${x} ${y + height - corner} V ${y + height} H ${x + corner} M ${x + width} ${y + height - corner} V ${y + height} H ${x + width - corner}`}
                    fill="none"
                    stroke="#34d399"
                    strokeWidth="2"
                    strokeLinecap="square"
                    strokeLinejoin="miter"
                  />;
                })()
              )}
              {showAnalysisFaceMask && hasCompleteAnalysisLandmarks && (
                <>
                  {analysisMeshEdges.map(([a, b]) => {
                    const start = analysisLandmarks[a];
                    const end = analysisLandmarks[b];
                    if (!isRenderableFacialLandmark(start) || !isRenderableFacialLandmark(end)) return null;
                    return <line key={`${a}-${b}`} x1={start.x * videoFrameSize.width} y1={start.y * videoFrameSize.height} x2={end.x * videoFrameSize.width} y2={end.y * videoFrameSize.height} stroke="rgba(255,255,255,0.72)" strokeWidth="0.65" />;
                  })}
                  {[
                    { points: FACE_OVAL, color: '#22d3ee', width: 2.1 },
                    { points: LEFT_EYE, color: '#3b82f6', width: 1.8 },
                    { points: RIGHT_EYE, color: '#d946ef', width: 1.8 },
                    { points: OUTER_LIPS, color: '#22d3ee', width: 2.1 },
                    { points: INNER_LIPS, color: '#22d3ee', width: 1.5 },
                  ].map((contour, contourIndex) => (
                    <polyline key={contourIndex} points={contour.points.map((index) => { const point = analysisLandmarks[index]; return isRenderableFacialLandmark(point) ? `${point.x * videoFrameSize.width},${point.y * videoFrameSize.height}` : ''; }).filter(Boolean).join(' ')} fill="none" stroke={contour.color} strokeWidth={contour.width} strokeLinejoin="round" strokeLinecap="round" />
                  ))}
                </>
              )}
            </svg>
          )}
          {videoUrl && showAnalysisFaceMask && analysisLandmarks.length > 0 && !hasCompleteAnalysisLandmarks && (
            <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-md border border-amber-300/70 bg-slate-950/80 px-3 py-1.5 text-[10px] text-amber-200 shadow-lg">
              旧分析数据缺少完整人脸关键点，请点击“重新分析”更新
            </div>
          )}
        </section>

        <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-3 text-[10px] text-slate-500">
          <div className="relative mb-3 flex h-4 w-full items-center">
            <div className="absolute h-1 w-full overflow-hidden rounded-full bg-slate-200">
              <div className="h-full bg-sky-500" style={{ width: `${duration > 0 ? Math.min(100, Math.max(0, currentTime / duration * 100)) : 0}%` }} />
            </div>
            <button type="button" disabled={!videoUrl} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); seekTo(duration * ((event.clientX - rect.left) / Math.max(1, rect.width))); }} className="mrt-button-text absolute inset-0 w-full disabled:cursor-default" aria-label="视频进度" />
            <div className="pointer-events-none absolute top-1/2 z-20 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-sky-500 bg-white shadow-sm" style={{ left: `${duration > 0 ? Math.min(100, Math.max(0, currentTime / duration * 100)) : 0}%` }} />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex flex-1 items-center justify-start">
              <button
                type="button"
                disabled={!analysisResult || analysisExporting}
                onClick={() => void handleExportAnalysis()}
                className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[10px] font-medium text-slate-600 shadow-sm transition-colors hover:border-sky-300 hover:text-sky-600 disabled:cursor-not-allowed disabled:border-slate-100 disabled:bg-slate-50 disabled:text-slate-300"
              >
                <Download size={12} />{analysisExporting ? '导出中…' : '导出分析'}
              </button>
            </div>
            <div className="flex items-center justify-center gap-3">
              <button type="button" disabled={!videoUrl} onClick={() => seekTo(0)} className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm disabled:text-slate-300"><SkipBack size={14} /></button>
              <button type="button" disabled={!videoUrl} onClick={() => seekTo(currentTime - 1)} className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm disabled:text-slate-300"><Rewind size={14} /></button>
              <button type="button" disabled={!videoUrl} onClick={() => { const video = videoRef.current; if (!video) return; if (video.paused) void video.play(); else video.pause(); }} className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm disabled:text-slate-300">{isPlaying ? <Pause size={14} /> : <Play size={14} />}</button>
              <button type="button" disabled={!videoUrl} onClick={() => seekTo(currentTime + 1)} className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm disabled:text-slate-300"><FastForward size={14} /></button>
              <button type="button" disabled={!videoUrl} onClick={() => seekTo(duration)} className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm disabled:text-slate-300"><SkipForward size={14} /></button>
            </div>
            <div className="flex flex-1 items-center justify-end gap-4 text-slate-500">
              <span className="font-mono">{formatTime(currentTime)} / {formatTime(duration)}</span>
            </div>
          </div>
        </div>

        <section className="shrink-0 border-t border-slate-200 bg-slate-50">
          <div className="flex w-full items-center justify-between px-4 py-2">
            <button type="button" aria-expanded={isTimelineExpanded} onClick={() => setIsTimelineExpanded((value) => !value)} className="mrt-button-text flex items-center gap-2 text-xs font-bold text-slate-600 transition-colors hover:text-slate-800">
              {isTimelineExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              <span>时间轴分析</span>
              <span className="font-normal text-slate-400">({analysisResult ? `${(analysisResult.tracks.emotion?.events?.length || 0) + (analysisResult.tracks.expression?.events?.length || 0)} 个分析事件` : '暂无分析事件'})</span>
            </button>
            {isTimelineExpanded && <div className="text-[10px] text-slate-400">与眼动、刺激物和 AOI 共用时间基准</div>}
          </div>
          {isTimelineExpanded && <div className="px-4 pb-4">
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              <div className="flex h-6 border-b border-slate-100 bg-slate-50/60">
                <div className="w-24 shrink-0 border-r border-slate-100" />
                <div className="flex flex-1 items-center justify-between px-2 font-mono text-[8px] text-slate-400">
                  {timelineTicks.map((tick) => <span key={tick}>{tick}</span>)}
                </div>
              </div>
              <div className="relative">
                <div className="pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-sky-500" style={{ left: `calc(6rem + (100% - 6rem) * ${duration > 0 ? currentTime / duration : 0})` }} />
                {analysisTracks.map((track) => {
                  const trackMap: Record<string, string> = {
                    'emotion': 'emotion',
                    'expression': 'expression',
                  };
                  const trackKey = trackMap[track.id] || track.id;
                  const trackData = analysisResult?.tracks?.[trackKey as keyof typeof analysisResult.tracks];
                  const allEvents: FacialTimelineEvent[] = trackData?.events || [];
                  const events = track.id === 'expression'
                    ? [...allEvents].sort((a, b) => b.peak - a.peak).slice(0, 6)
                    : allEvents;
                  const timelineDurationMs = Math.max(1, analysisResult?.source.durationMs || duration * 1000 || 1);
                  return (
                  <div key={track.id} className="flex h-[46px] border-b border-slate-100 last:border-b-0">
                    <div className="flex w-24 shrink-0 items-center gap-2 border-r border-slate-100 bg-slate-50/60 px-2">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${track.color}`} />
                      <div className="min-w-0 leading-tight" data-i18n-skip="true" title={isEn ? (track.id === 'emotion' ? '8 emotion categories, each with its own color' : 'Top 6 micro-expressions ranked by peak intensity') : track.hint}>
                        <div className="truncate text-[9px] font-medium text-slate-500">{isEn ? (track.id === 'emotion' ? 'Emotions' : 'Micro-expr.') : track.label}</div>
                        <div className="mt-1 truncate text-[8px] text-slate-400">{isEn ? (track.id === 'emotion' ? '8 categories' : 'Top 6 peaks') : (track.id === 'emotion' ? '8种表情，独立颜色' : '峰值前6项')}</div>
                      </div>
                    </div>
                    <div className="relative flex flex-1 items-center overflow-hidden bg-[repeating-linear-gradient(to_right,transparent_0,transparent_calc(16.666%_-_1px),var(--app-track)_calc(16.666%_-_1px),var(--app-track)_16.666%)] px-3">
                      <div className="w-full border-t border-dashed border-slate-200" />
                      {events.length === 0 ? <span className="absolute left-3 text-[9px] text-slate-300">{trackData && !trackData.available ? ('reason' in trackData ? trackData.reason || '当前轨道不可用' : '当前轨道不可用') : '等待分析数据'}</span> : events.map((event, index) => {
                        const emotionColor = track.id === 'emotion' ? EMOTION_BG_CLASS[event.label] : undefined;
                        const barColor = emotionColor || track.color;
                        return (
                        <button
                          key={`${track.id}-${event.startMs}-${index}`}
                          type="button"
                          data-visual-control="timeline-event"
                          onClick={() => seekTo(event.apexMs / 1000)}
                          title={`${localizeFacialAnalysisLabel(event.label, isEn)} · ${(event.peak * 100).toFixed(0)}%`}
                          className={`absolute top-2 h-7 min-w-1 rounded border border-white/70 ${barColor} opacity-75 hover:opacity-100`}
                          style={{ left: `${event.startMs / timelineDurationMs * 100}%`, width: `${Math.max(0.35, (event.endMs - event.startMs) / timelineDurationMs * 100)}%` }}
                        />
                        );
                      })}
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          </div>}
        </section>
      </main>

      <aside className="flex w-[300px] shrink-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-600">
        <div className="border-b border-slate-200 p-4">
          <div className="flex w-full gap-2">
            <button type="button" aria-pressed={sideTab === 'results'} onClick={() => setSideTab('results')} className={`mrt-button-tab flex-1 border-b-2 px-3 py-2 text-[11px] font-bold transition-colors ${sideTab === 'results' ? 'border-sky-500 text-sky-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
              分析结果
            </button>
            <button type="button" aria-pressed={sideTab === 'settings'} onClick={() => setSideTab('settings')} className={`mrt-button-tab flex-1 border-b-2 px-3 py-2 text-[11px] font-bold transition-colors ${sideTab === 'settings' ? 'border-sky-500 text-sky-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
              分析设置
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mb-4">
            <h3 className="mb-2 flex items-center gap-2 text-xs font-bold tracking-widest text-slate-500">
              <FileVideo size={14} />分析记录
            </h3>
            <CustomSelect value={effectiveRecordId} disabled={records.length === 0} onChange={(event) => onSelectRecord(event.target.value)} className="w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 outline-none" dataI18nSkip>
              {records.length === 0 ? <option value="">{isEn ? 'No facial records' : '暂无表情记录'}</option> : records.map((record) => <option key={record.id} value={record.id}>{record.name}</option>)}
            </CustomSelect>
            <div className="mt-1.5 flex items-center gap-1 text-[10px] text-slate-400"><Check size={11} className="text-emerald-500" />同步录制时与眼动记录同名，数据分别保存</div>
          </div>
          {sideTab === 'results' ? (
            <div className="space-y-4 border-t border-slate-200 pt-4">
              {notice && <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] leading-4 text-amber-700">{notice}</div>}
              {currentEmotionBars.length > 0 && (
                <section className="border-t border-slate-200 pt-3">
                  <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2.5">
                    <div className="text-xs font-bold text-slate-700">基础表情</div>
                  </div>
                  <div className="space-y-2 px-3 py-3">
                    {currentEmotionBars.map((emotion) => (
                      <div key={emotion.label} className="grid grid-cols-[42px_minmax(0,1fr)_36px] items-center gap-2">
                        <span className={`truncate text-[10px] font-medium ${emotion.active ? 'font-bold' : ''}`} style={{ color: emotion.active ? emotion.color : '#94a3b8' }}>{emotion.label}</span>
                        <div className="h-3 overflow-hidden rounded-sm bg-slate-100">
                          <div
                            className="h-full rounded-sm transition-[width] duration-150"
                            style={{ width: `${emotion.value * 100}%`, backgroundColor: emotion.color }}
                          />
                        </div>
                        <span className="text-right font-mono text-[10px] font-semibold" style={{ color: emotion.active ? emotion.color : '#94a3b8' }}>{(emotion.value * 100).toFixed(0)}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              <section className="border-t border-slate-200 pt-3">
                <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-700">微表情</span>
                    {currentExpressionValues.length > 5 && (
                      <button
                        type="button"
                        aria-expanded={showAllMicros}
                        onClick={() => setShowAllMicros(v => !v)}
                        className="mrt-button-text text-[10px] text-slate-400 hover:text-slate-600"
                      >
                        {showAllMicros ? '收起' : `展开剩余 ${currentExpressionValues.length - 5} 项`}
                      </button>
                    )}
                  </div>
                </div>
                <div className="space-y-2 px-3 py-3">
                  {currentExpressionValues.length ? (
                    <>
                      {currentExpressionValues.slice(0, 5).map((expression, index) => (
                        <div key={expression.label} className="grid grid-cols-[42px_minmax(0,1fr)_36px] items-center gap-2">
                          <span className="truncate text-[10px] font-medium text-slate-600">{expression.label}</span>
                          <div className="h-3 overflow-hidden rounded-sm bg-slate-100">
                            <div
                              className={`h-full rounded-sm transition-[width] duration-150 ${index === 0 ? 'bg-fuchsia-500' : index === 1 ? 'bg-cyan-500' : 'bg-emerald-500'}`}
                              style={{ width: `${expression.value * 100}%` }}
                            />
                          </div>
                          <span className="text-right font-mono text-[10px] font-semibold text-slate-500">{(expression.value * 100).toFixed(0)}</span>
                        </div>
                      ))}
                      {showAllMicros && currentExpressionValues.length > 5 && (
                        <div className="space-y-2 pt-1">
                          {currentExpressionValues.slice(5).map((expression) => (
                            <div key={expression.label} className="grid grid-cols-[42px_minmax(0,1fr)_36px] items-center gap-2">
                              <span className="truncate text-[10px] font-medium text-slate-500">{expression.label}</span>
                              <div className="h-3 overflow-hidden rounded-sm bg-slate-100">
                                <div
                                  className="h-full rounded-sm bg-slate-400 transition-[width] duration-150"
                                  style={{ width: `${expression.value * 100}%` }}
                                />
                              </div>
                              <span className="text-right font-mono text-[10px] text-slate-400">{(expression.value * 100).toFixed(0)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  ) : <div className="py-3 text-center text-[11px] text-slate-400">当前画面未获得有效微表情数据</div>}
                </div>
              </section>
            </div>
          ) : (
            <div className="space-y-2 border-t border-slate-200 pt-4">
              <div className="rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 text-[10px] leading-4 text-sky-700">
                实验录制是否采集表情视频由监控区域中的“表情检测”模块决定；与眼动模块同时存在时同步录制，仅保留表情模块时只录制表情。
              </div>
              <div className="space-y-1">
                <FacialSettingToggle checked={showAnalysisFaceBox} onChange={(checked) => { setShowAnalysisFaceBox(checked); if (projectDir) localStorage.setItem(`facial-analysis-display-settings:${projectDir}`, JSON.stringify({ showFaceBox: checked, showFaceMask: showAnalysisFaceMask })); }} title="显示 Box 框" description="在分析视频上标出检测到的人脸范围" />
                <FacialSettingToggle checked={showAnalysisFaceMask} onChange={(checked) => { setShowAnalysisFaceMask(checked); if (projectDir) localStorage.setItem(`facial-analysis-display-settings:${projectDir}`, JSON.stringify({ showFaceBox: showAnalysisFaceBox, showFaceMask: checked })); }} title="显示人脸 Mask" description="在分析视频上显示彩色人脸关键点网格" />
              </div>
              {notice && <div className="mt-3 border-t border-slate-200 pt-3 text-[10px] leading-5 text-amber-600">{notice}</div>}
              {manifest?.alignment && <div className="mt-3 border-t border-slate-200 pt-3 text-[10px] leading-5 text-slate-400">时间基准：{manifest.alignment.timeBase}<br />偏移：{manifest.alignment.sourceOffsetMs} ms<br />方式：{manifest.alignment.method}</div>}
            </div>
          )}
        </div>

      </aside>
    </div>
  );
};

export default FacialAnalysisPage;
