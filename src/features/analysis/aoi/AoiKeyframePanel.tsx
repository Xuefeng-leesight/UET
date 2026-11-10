import React from 'react';
import type { AoiKeyframe, AoiShape } from '@shared/domain/aoi/aoiTypes';
import { KEYFRAME_EDIT_TOLERANCE_MS } from '@/features/analysis/aoi/aoiAnalysisModel';

export function AoiKeyframePanel(props: {
  isEnglish: boolean;
  playbackTimeMs: number;
  selectedAoi: AoiShape | null;
  keyframes: AoiKeyframe[];
  currentKeyframeTimeMs: number | null;
  editTargetTimeMs: number | null;
  dynamicAoiAllowed: boolean;
  hasVideo: boolean;
  canAddKeyframe: boolean;
  formatTime: (seconds: number) => string;
  onAddKeyframe: () => void;
  onSeekLocalTime: (timeMs: number) => void;
  onRemoveKeyframe: (timeMs: number) => void;
}) {
  const {
    isEnglish,
    playbackTimeMs,
    selectedAoi,
    keyframes,
    currentKeyframeTimeMs,
    editTargetTimeMs,
    dynamicAoiAllowed,
    hasVideo,
    canAddKeyframe,
    formatTime,
    onAddKeyframe,
    onSeekLocalTime,
    onRemoveKeyframe,
  } = props;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-bold text-slate-500 tracking-widest">
          {isEnglish ? 'Dynamic AOI keyframes' : '动态AOI关键帧'}
        </div>
        <div className="text-[10px] text-slate-400">{formatTime(playbackTimeMs / 1000)}</div>
      </div>
      <button
        type="button"
        onClick={onAddKeyframe}
        disabled={!canAddKeyframe}
        className={`w-full px-3 py-2 rounded-lg border text-[11px] font-bold transition-colors ${
          canAddKeyframe
            ? 'border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100'
            : 'border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed'
        }`}
      >
        {currentKeyframeTimeMs !== null
          ? isEnglish ? 'Update Current Keyframe' : '更新当前关键帧'
          : isEnglish ? 'Add Keyframe' : '添加关键帧'}
      </button>
      <div className="text-[10px] leading-5 text-slate-500">
        {!selectedAoi
          ? '先选择一个 AOI，再在视频时间轴的目标时刻添加关键帧。'
          : !dynamicAoiAllowed
            ? '动态 AOI 仅在视频刺激物中可用。'
            : !hasVideo
              ? '未检测到可播放的视频，请先确认刺激物视频资源。'
              : playbackTimeMs <= KEYFRAME_EDIT_TOLERANCE_MS
                ? '起始位置由当前 AOI 初始区域定义，无需在 0 秒附近添加关键帧。'
                : editTargetTimeMs === null
                  ? '当前位于关键帧之间，可先添加关键帧，再拖动 AOI 到新的位置。'
                  : editTargetTimeMs > 0
                    ? `当前可直接编辑关键帧 ${formatTime(editTargetTimeMs / 1000)}。`
                    : '当前正在编辑 AOI 起始位置。'}
      </div>
      {selectedAoi ? (
        <div className="space-y-2">
          <button
            type="button"
            aria-pressed={playbackTimeMs <= KEYFRAME_EDIT_TOLERANCE_MS}
            onClick={() => onSeekLocalTime(0)}
            className={`w-full flex items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
              playbackTimeMs <= KEYFRAME_EDIT_TOLERANCE_MS
                ? 'border-sky-300 bg-sky-50'
                : 'border-slate-200 bg-white hover:bg-slate-50'
            }`}
          >
            <span className="text-[11px] font-semibold text-slate-700">起始位置</span>
            <span className="text-[10px] font-mono text-slate-500">00:00.0</span>
          </button>
          {keyframes.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-[10px] text-slate-400">
              {isEnglish
                ? 'No keyframes yet. Add one to smoothly move AOI over time in playback and statistics.'
                : '暂无关键帧，添加后可在视频播放和统计中按时间平滑移动 AOI。'}
            </div>
          ) : keyframes.map((keyframe) => (
            <div
              key={`${selectedAoi.id}-keyframe-${keyframe.timeMs}`}
              className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 ${
                currentKeyframeTimeMs === keyframe.timeMs ? 'border-sky-300 bg-sky-50' : 'border-slate-200 bg-white'
              }`}
            >
              <button type="button" onClick={() => onSeekLocalTime(keyframe.timeMs)} className="mrt-button-text flex-1 text-left">
                <div className="text-[11px] font-semibold text-slate-700">关键帧 {formatTime(keyframe.timeMs / 1000)}</div>
                <div className="text-[10px] text-slate-400">
                  {currentKeyframeTimeMs === keyframe.timeMs ? '当前关键帧' : '点击跳转并编辑'}
                </div>
              </button>
              <button
                type="button"
                onClick={() => onRemoveKeyframe(keyframe.timeMs)}
                className="px-2 py-1 rounded-md text-[10px] font-bold text-rose-500 hover:bg-rose-50"
              >
                删除
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-[10px] text-slate-400">
          {isEnglish
            ? 'No AOI selected. Switch to the AOIs tab above and select one AOI first.'
            : '当前未选择 AOI，请先切换到 `AOIs` 标签并选中一个 AOI。'}
        </div>
      )}
    </div>
  );
}
