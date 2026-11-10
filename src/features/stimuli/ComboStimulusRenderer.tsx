import React from 'react';
import type { ComboStimulusItem, ExtendedStimulus } from '@/shared/types/mrt';
import { registerPlaybackAudioElement } from '@/features/recording/domain/audioRecording';
import WebStimulusFrame from '@/features/stimuli/WebStimulusFrame';

const clampPct = (value: unknown, fallback: number, min = 0, max = 100): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

export const normalizeComboItems = (items: unknown): ComboStimulusItem[] => {
  if (!Array.isArray(items)) return [];
  return items
    .map((item, index) => {
      const raw: Record<string, unknown> = item && typeof item === 'object'
        ? item as Record<string, unknown>
        : {};
      const type: ComboStimulusItem['type'] =
        raw.type === 'video' || raw.type === 'text' || raw.type === 'image' || raw.type === 'audio' || raw.type === 'web'
          ? raw.type
          : 'image';
      return {
        id: String(raw.id || `combo_item_${index}`),
        name: String(
          raw.name || (type === 'text' ? 'Text' : type === 'video' ? 'Video' : type === 'audio' ? 'Audio' : type === 'web' ? 'Web' : 'Image'),
        ),
        type,
        url: typeof raw.url === 'string' ? raw.url : '',
        text: typeof raw.text === 'string' ? raw.text : '',
        widthPct: clampPct(raw.widthPct, type === 'text' ? 60 : 50, 1, 100),
        heightPct: clampPct(raw.heightPct, type === 'text' ? 20 : 50, 1, 100),
        centerXPct: clampPct(raw.centerXPct, 50),
        centerYPct: clampPct(raw.centerYPct, 50),
        loop: raw.loop === true,
        fontSize: Math.max(8, Number(raw.fontSize) || 48),
        fontColor: typeof raw.fontColor === 'string' ? raw.fontColor : '#ffffff',
        bgColor: typeof raw.bgColor === 'string' ? raw.bgColor : 'transparent',
      };
    })
    .filter((item) => item.type === 'text' || Boolean(item.url));
};

export const getComboMediaSrc = (url: unknown): string => {
  const raw = typeof url === 'string' ? url : '';
  if (!raw) return '';
  if (/^file:/i.test(raw)) return raw.replace(/^file:/i, 'local-resource:');
  return raw;
};

export const getComboCanvasStyle = (value: unknown): 'fullscreen' | 'landscape' | 'classic' | 'square' | 'portrait' => {
  return value === 'fullscreen' || value === 'landscape' || value === 'classic' || value === 'square' || value === 'portrait' ? value : 'landscape';
};

const comboCanvasAspect: Record<ReturnType<typeof getComboCanvasStyle>, string | null> = {
  fullscreen: null,
  landscape: '16 / 9',
  classic: '4 / 3',
  square: '1 / 1',
  portrait: '9 / 16',
};

interface ComboStimulusRendererProps {
  stimulus: ExtendedStimulus;
  className?: string;
  dispatchLastVideoDuration?: boolean;
  muted?: boolean;
  registerAudio?: boolean;
}

const ComboStimulusRenderer: React.FC<ComboStimulusRendererProps> = ({
  stimulus,
  className = 'w-full h-full',
  dispatchLastVideoDuration = false,
  muted = false,
  registerAudio = true,
}) => {
  const comboItems = stimulus.comboItems;
  const items = React.useMemo(() => normalizeComboItems(comboItems), [stimulus.id, comboItems]);
  const canvasStyle = getComboCanvasStyle(stimulus.comboCanvasStyle);
  const durationTimerRef = React.useRef<number | null>(null);
  const longestVideoIdRef = React.useRef<string | null>(null);
  const longestVideoDurationRef = React.useRef<number>(0);

  React.useEffect(() => {
    longestVideoIdRef.current = null;
    longestVideoDurationRef.current = 0;
    if (durationTimerRef.current !== null) {
      window.clearTimeout(durationTimerRef.current);
      durationTimerRef.current = null;
    }
    return () => {
      if (durationTimerRef.current !== null) {
        window.clearTimeout(durationTimerRef.current);
        durationTimerRef.current = null;
      }
      longestVideoIdRef.current = null;
      longestVideoDurationRef.current = 0;
    };
  }, [stimulus.id, items]);

  const dispatchDone = React.useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('mrt:recording-video-ended', {
        detail: { stimulusId: stimulus.id },
      }),
    );
  }, [stimulus.id]);

  if (items.length === 0) {
    return (
      <div className={`${className} flex items-center justify-center text-white/60`}>
        {stimulus.name}
      </div>
    );
  }

  return (
    <div className={`${className} flex items-center justify-center overflow-hidden`}>
      <div
        className="relative overflow-hidden"
        style={{
          width: canvasStyle === 'fullscreen' ? '100%' : undefined,
          height: canvasStyle === 'fullscreen' ? '100%' : undefined,
          maxWidth: '100%',
          maxHeight: '100%',
          aspectRatio: comboCanvasAspect[canvasStyle] || undefined,
          ...(canvasStyle !== 'fullscreen' ? { width: '100%', height: 'auto' } : {}),
        }}
      >
      {items.map((item) => {
        const style: React.CSSProperties = {
          position: 'absolute',
          left: `${item.centerXPct}%`,
          top: `${item.centerYPct}%`,
          width: `${item.widthPct}%`,
          height: `${item.heightPct}%`,
          transform: 'translate(-50%, -50%)',
        };

        if (item.type === 'video') {
          return (
            <video
              key={`${stimulus.id}_${item.id}`}
              ref={registerAudio ? registerPlaybackAudioElement : undefined}
              src={getComboMediaSrc(item.url)}
              className="h-full w-full object-contain"
              style={style}
              autoPlay
              loop={item.loop}
              muted={muted}
              playsInline
              onLoadedMetadata={(event) => {
                const durationSec = event.currentTarget.duration;
                if (!dispatchLastVideoDuration || !Number.isFinite(durationSec) || durationSec <= 0) return;
                if (durationSec < longestVideoDurationRef.current) return;
                longestVideoDurationRef.current = durationSec;
                longestVideoIdRef.current = item.id;
                if (durationTimerRef.current !== null) window.clearTimeout(durationTimerRef.current);
                const remainingMs = Math.max(0, Math.round((durationSec - event.currentTarget.currentTime) * 1000));
                durationTimerRef.current = window.setTimeout(() => {
                  durationTimerRef.current = null;
                  dispatchDone();
                }, remainingMs);
              }}
              onEnded={() => {
                if (dispatchLastVideoDuration && item.id === longestVideoIdRef.current && durationTimerRef.current === null) {
                  dispatchDone();
                }
              }}
              onError={() => {
                if (dispatchLastVideoDuration && item.id === longestVideoIdRef.current) dispatchDone();
              }}
            />
          );
        }

        if (item.type === 'audio') {
          return (
            <div
              key={`${stimulus.id}_${item.id}`}
              className="flex h-full w-full items-center justify-center text-center text-white"
              style={{
                ...style,
                backgroundColor: item.bgColor || 'transparent',
              }}
            >
              <div className="px-3">
                <div className="text-sm font-semibold">音频</div>
              </div>
              <audio
                ref={registerAudio ? registerPlaybackAudioElement : undefined}
                src={getComboMediaSrc(item.url)}
                autoPlay
                loop={item.loop}
              />
            </div>
          );
        }

        if (item.type === 'web') {
          return (
            <div key={`${stimulus.id}_${item.id}`} style={style}>
              <WebStimulusFrame url={item.url || ''} title={item.name || 'Web'} />
            </div>
          );
        }

        if (item.type === 'text') {
          return (
            <div
              key={`${stimulus.id}_${item.id}`}
              className="flex h-full w-full items-center justify-center whitespace-pre-wrap break-words text-center"
              data-i18n-skip="true"
              style={{
                ...style,
                color: item.fontColor || '#ffffff',
                fontSize: `${item.fontSize || 48}px`,
                backgroundColor: item.bgColor || 'transparent',
              }}
            >
              {item.text || item.name}
            </div>
          );
        }

        return (
          <img
            key={`${stimulus.id}_${item.id}`}
            src={getComboMediaSrc(item.url)}
            className="h-full w-full object-contain"
            style={style}
            alt={item.name}
          />
        );
      })}
      </div>
    </div>
  );
};

export default ComboStimulusRenderer;
