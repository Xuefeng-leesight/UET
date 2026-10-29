import React from 'react';
import { ArrowLeft, Download, FastForward, Pause, Play, Rewind, SkipBack, SkipForward } from 'lucide-react';
import type { RecordingRecord } from '@shared/contracts/domain/models';
import type { FacialAnalysisResultData } from '@/infrastructure/electron/ipcTypes';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import SpinnerRing from '@/shared/ui/SpinnerRing';
import { getDisplayRecordName } from './domain/recordDisplayName';
import { useLanguage } from '@/app/i18n/useLanguage';
import { localizeFacialExpressionLabel } from '@/features/facial/domain/facialLabels';

const EMOTIONS = ['中性', '高兴', '悲伤', '愤怒', '惊讶', '恐惧', '厌恶', '轻蔑'] as const;
const EMOTION_COLORS: Record<string, string> = {
  中性: '#06b6d4', 高兴: '#f59e0b', 悲伤: '#3b82f6', 愤怒: '#ef4444',
  惊讶: '#f97316', 恐惧: '#8b5cf6', 厌恶: '#22c55e', 轻蔑: '#94a3b8',
};

const formatTime = (seconds: number): string => {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  const secs = safe - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${secs.toFixed(1).padStart(4, '0')}`;
};

interface FacialRecordDetailPageProps {
  record: RecordingRecord;
  projectDir: string | null;
  onBackToList: () => void;
}

const FacialRecordDetailPage: React.FC<FacialRecordDetailPageProps> = ({ record, projectDir, onBackToList }) => {
  const { language } = useLanguage();
  const isEn = language === 'en-US';
  const [result, setResult] = React.useState<FacialAnalysisResultData | null>(null);
  const [videoUrl, setVideoUrl] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [message, setMessage] = React.useState('');
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMessage('');
    setCurrentTime(0);
    if (!projectDir) {
      setLoading(false);
      setMessage('未找到实验目录');
      return;
    }
    void ipcClient.loadFacialAnalysis({ projectDir, recordId: record.name }).then((response) => {
      if (cancelled) return;
      setResult(response.result);
      setVideoUrl(response.videoUrl || record.mp4Url || null);
      if (!response.ok) setMessage(response.message || '读取表情模块记录失败');
      else if (!response.result) setMessage('该记录尚未生成表情分析结果，请先在“面部分析”页面执行分析');
      setLoading(false);
    }).catch((error) => {
      if (cancelled) return;
      setLoading(false);
      setMessage(error instanceof Error ? error.message : '读取表情模块记录失败');
    });
    return () => { cancelled = true; };
  }, [projectDir, record.id, record.mp4Url, record.name]);

  const currentSample = React.useMemo(() => {
    const samples = result?.samples || [];
    if (!samples.length) return null;
    const target = currentTime * 1000;
    let best = samples[0];
    let distance = Number.POSITIVE_INFINITY;
    for (const sample of samples) {
      const nextDistance = Math.abs((sample.t ?? sample.timestampMs ?? 0) - target);
      if (nextDistance >= distance) break;
      best = sample;
      distance = nextDistance;
    }
    return best;
  }, [currentTime, result]);

  const hasSavedBasicScores = Boolean(
    currentSample?.basicEmotionScores && Object.keys(currentSample.basicEmotionScores).length > 0,
  );
  const emotionScores = hasSavedBasicScores
    ? currentSample?.basicEmotionScores || {}
    : currentSample?.emotionScores || {};
  const activeEmotion = hasSavedBasicScores
    ? currentSample?.basicEmotionLabel || ''
    : currentSample?.emotion || currentSample?.basicEmotionLabel || '';
  const expressions = React.useMemo(() => Object.entries(currentSample?.expressions || {})
    .map(([label, value]) => ({ label: localizeFacialExpressionLabel(label, isEn), value: Math.max(0, Math.min(1, Number(value) || 0)) }))
    .sort((left, right) => right.value - left.value)
    .slice(0, 8), [currentSample, isEn]);
  const facialSourcePath = record.modalities?.['facial-expression']?.sourcePath || record.mp4Path;
  const handleExport = async () => {
    if (!facialSourcePath || !ipcClient.isAvailable() || exporting) return;
    setExporting(true);
    try {
      const response = await ipcClient.exportVideoFast({
        sourcePath: facialSourcePath,
        defaultName: `${getDisplayRecordName(record)}_表情模块.mp4`,
        preserveAudio: true,
      });
      if (!response.ok && (!('reason' in response) || response.reason !== 'canceled')) {
        window.alert(('message' in response && response.message) || '导出视频失败');
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '导出视频失败');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 gap-3 overflow-hidden">
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <section className="relative min-h-0 flex-1 bg-slate-950">
          {loading ? <div className="flex h-full items-center justify-center"><SpinnerRing className="h-8 w-8 rounded-full border-2 border-violet-400 border-t-transparent" /></div> : videoUrl ? (
            <video ref={videoRef} src={videoUrl} className="h-full w-full object-contain" onLoadedMetadata={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
          ) : <div className="flex h-full items-center justify-center text-sm text-slate-400">没有可播放的面部视频</div>}
        </section>

        <footer className="flex shrink-0 flex-col gap-3 border-t border-slate-200 bg-white px-4 py-3 text-[10px] text-slate-500">
          <div className="relative flex h-4 w-full items-center">
            <div className="absolute h-1 w-full overflow-hidden rounded-full bg-slate-200"><div className="h-full bg-sky-500" style={{ width: `${duration ? currentTime / duration * 100 : 0}%` }} /></div>
            <button type="button" className="absolute inset-0 w-full" aria-label="视频进度" onClick={(event) => { const video = videoRef.current; if (!video) return; const rect = event.currentTarget.getBoundingClientRect(); video.currentTime = duration * ((event.clientX - rect.left) / Math.max(1, rect.width)); }} />
            <div className="pointer-events-none absolute top-1/2 z-20 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-sky-500 bg-white shadow-sm" style={{ left: `${duration ? currentTime / duration * 100 : 0}%` }} />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex flex-1 items-center justify-start">
              <button
                type="button"
                onClick={() => { void handleExport(); }}
                disabled={exporting || !facialSourcePath}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[10px] font-medium transition-colors ${facialSourcePath && !exporting ? 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-sky-600' : 'cursor-not-allowed border-slate-100 bg-slate-50 text-slate-300'}`}
              >
                {exporting ? <SpinnerRing className="h-3 w-3 rounded-full border-2 border-slate-300 border-t-sky-500" /> : <Download size={12} />}
                <span>{exporting ? '导出中' : '导出视频'}</span>
              </button>
            </div>
            <div className="flex items-center justify-center gap-3">
              <button type="button" disabled={!videoUrl} onClick={() => { if (videoRef.current) videoRef.current.currentTime = 0; }} className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50 disabled:text-slate-300"><SkipBack size={14} /></button>
              <button type="button" disabled={!videoUrl} onClick={() => { if (videoRef.current) videoRef.current.currentTime = Math.max(0, currentTime - 1 / 30); }} className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50 disabled:text-slate-300"><Rewind size={14} /></button>
              <button type="button" disabled={!videoUrl} onClick={() => { const video = videoRef.current; if (!video) return; if (video.paused) void video.play(); else video.pause(); }} className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50 disabled:text-slate-300">{playing ? <Pause size={14} /> : <Play size={14} />}</button>
              <button type="button" disabled={!videoUrl} onClick={() => { if (videoRef.current) videoRef.current.currentTime = Math.min(duration, currentTime + 1 / 30); }} className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50 disabled:text-slate-300"><FastForward size={14} /></button>
              <button type="button" disabled={!videoUrl} onClick={() => { if (videoRef.current) videoRef.current.currentTime = duration; }} className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50 disabled:text-slate-300"><SkipForward size={14} /></button>
            </div>
            <div className="flex flex-1 items-center justify-end gap-4 text-slate-500"><span className="font-mono">{formatTime(currentTime)} / {formatTime(duration)}</span></div>
          </div>
        </footer>
      </main>

      <aside className="flex w-[310px] shrink-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="space-y-3 border-b border-slate-100 bg-slate-50/50 p-3">
          <div className="flex items-center justify-between gap-3">
            <button type="button" onClick={onBackToList} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-bold text-slate-600 transition-colors hover:bg-slate-50 hover:text-sky-600"><ArrowLeft size={13} />返回记录列表</button>
            <h3 className="text-xs font-bold tracking-widest text-slate-800">属性面板</h3>
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <div className="space-y-2.5">
            {[{ label: '记录名称', value: getDisplayRecordName(record) }, { label: '受试者信息', value: record.subjectName }, { label: '录制时间', value: record.timestamp }, { label: '视频文件', value: facialSourcePath }].map((item) => <div key={item.label} className="grid grid-cols-[100px_1fr] gap-2"><span className="text-[10px] font-bold text-slate-400">{item.label}</span><span data-i18n-skip="true" className="break-all text-[11px] text-slate-700">{item.value || '—'}</span></div>)}
          </div>
          {message && <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-700">{message}</div>}
          <section><div className="mb-3 text-[11px] font-bold tracking-widest text-slate-500">基础表情</div><div className="space-y-2.5">{EMOTIONS.map((label) => { const value = Math.max(0, Math.min(1, Number(emotionScores[label]) || 0)); return <div key={label} className="grid grid-cols-[42px_1fr_36px] items-center gap-2"><span className={`text-[10px] ${activeEmotion === label ? 'font-bold' : 'text-slate-500'}`} style={{ color: activeEmotion === label ? EMOTION_COLORS[label] : undefined }}>{label}</span><div className="h-2.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full transition-[width]" style={{ width: `${value * 100}%`, backgroundColor: EMOTION_COLORS[label] }} /></div><span className="text-right font-mono text-[10px] text-slate-500">{(value * 100).toFixed(0)}</span></div>; })}</div></section>
          <section className="border-t border-slate-100 pt-4"><div className="mb-3 text-[11px] font-bold tracking-widest text-slate-500">微表情强度 TOP 8</div>{expressions.length ? <div className="space-y-2.5">{expressions.map((item, index) => <div key={item.label} className="grid grid-cols-[78px_1fr_36px] items-center gap-2"><span className="truncate text-[10px] text-slate-500" title={item.label}>{item.label}</span><div className="h-2.5 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${index === 0 ? 'bg-fuchsia-500' : index === 1 ? 'bg-cyan-500' : 'bg-emerald-500'}`} style={{ width: `${item.value * 100}%` }} /></div><span className="text-right font-mono text-[10px] text-slate-500">{(item.value * 100).toFixed(0)}</span></div>)}</div> : <div className="rounded-lg bg-slate-50 px-3 py-6 text-center text-[11px] text-slate-400">当前时间点没有微表情数据</div>}</section>
        </div>
      </aside>
    </div>
  );
};

export default FacialRecordDetailPage;
