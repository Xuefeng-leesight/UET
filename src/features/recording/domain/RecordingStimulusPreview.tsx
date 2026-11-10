import type { ExtendedStimulus } from '@/shared/types/mrt';
import ComboStimulusRenderer from '@/features/stimuli/ComboStimulusRenderer';
import WebStimulusFrame from '@/features/stimuli/WebStimulusFrame';
import { registerPlaybackAudioElement } from '@/features/recording/domain/audioRecording';
import { isStimulusAudioUrl, isStimulusVideoUrl } from '@/features/stimuli/domain/mediaTypes';

type PreviewStimulus = ExtendedStimulus & { playToEnd?: unknown; text?: unknown };

export function resolvePlayToEnd(value: unknown): boolean {
  if (value == null || value === true) return true;
  if (value === false) return false;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
  return true;
}

export function RecordingStimulusPreview({
  playbackIndex,
  playbackSequence,
  stimuli,
  passive = false,
}: {
  playbackIndex: number;
  playbackSequence: string[];
  stimuli: ExtendedStimulus[];
  /** Read-only monitor copy. It must not emit playback completion or audio. */
  passive?: boolean;
}) {
  const stimulusId = playbackSequence[playbackIndex];
  const stimulus = stimuli.find((item) => item.id === stimulusId) as PreviewStimulus | undefined;
  if (!stimulus) {
    return (
      <div className="flex flex-col items-center gap-2 text-slate-500">
        <div className="text-xs font-semibold">刺激物未找到</div>
        <div className="text-[11px]">编号: {stimulusId}</div>
      </div>
    );
  }
  if (stimulus.stimulusType === 'group') {
    console.error('[RecordingPage] ERROR: Group stimulus should not be in playback sequence!', stimulus);
    return (
      <div className="flex flex-col items-center gap-2 text-slate-500">
        <div className="text-xs font-semibold text-red-500">错误：分组类型不应直接播放</div>
        <div className="text-[11px]">分组: <span data-i18n-skip="true">{stimulus.name}</span></div>
      </div>
    );
  }

  const kind = stimulus.stimulusType
    || (isStimulusVideoUrl(stimulus.url) ? 'video' : isStimulusAudioUrl(stimulus.url) ? 'audio' : 'image');
  const dispatchPlaybackDone = (eventName: 'mrt:recording-video-ended' | 'mrt:recording-video-error') => {
    if (passive) return;
    window.dispatchEvent(new CustomEvent(eventName, { detail: { stimulusId: stimulus.id } }));
  };
  if (kind === 'video') {
    const playToEnd = resolvePlayToEnd(stimulus.playToEnd);
    return (
      <video
        ref={passive ? undefined : registerPlaybackAudioElement}
        src={stimulus.url}
        className="h-full w-full object-contain"
        autoPlay
        loop={!playToEnd}
        playsInline
        muted={passive}
        onEnded={() => dispatchPlaybackDone('mrt:recording-video-ended')}
        onError={() => dispatchPlaybackDone('mrt:recording-video-error')}
      />
    );
  }
  if (kind === 'audio') {
    const playToEnd = resolvePlayToEnd(stimulus.playToEnd);
    return (
      <div className="flex h-full w-full items-center justify-center p-8 text-white" style={{ backgroundColor: stimulus.bgColor || '#000000' }}>
        <div className="text-center">
          <div className="text-sm font-semibold" data-i18n-skip="true">{stimulus.name}</div>
          <div className="mt-2 text-xs text-white/60">音频刺激物播放中</div>
        </div>
        {!passive && (
          <audio
            ref={registerPlaybackAudioElement}
            src={stimulus.url}
            autoPlay
            loop={!playToEnd}
            onEnded={() => dispatchPlaybackDone('mrt:recording-video-ended')}
            onError={() => dispatchPlaybackDone('mrt:recording-video-error')}
          />
        )}
      </div>
    );
  }
  if (kind === 'text') {
    return (
      <div className="flex h-full w-full items-center justify-center overflow-hidden p-8" style={{ backgroundColor: stimulus.bgColor || '#000000' }}>
        <div
          data-i18n-skip="true"
          style={{
            fontSize: stimulus.fontSize ? `${stimulus.fontSize * 0.5}px` : '24px',
            fontWeight: 400,
            color: stimulus.fontColor || '#ffffff',
            textAlign: 'center',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {String(stimulus.text || '')}
        </div>
      </div>
    );
  }
  if (kind === 'web') return <WebStimulusFrame url={stimulus.url} title={stimulus.name || 'Web stimulus'} />;
  if (kind === 'combo') {
    return (
      <ComboStimulusRenderer
        key={stimulus.id}
        stimulus={stimulus}
        muted
        registerAudio={false}
        dispatchLastVideoDuration={!passive}
      />
    );
  }
  return <img src={stimulus.url} className="h-full w-full object-contain" alt="Stimulus" />;
}
