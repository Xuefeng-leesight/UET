import React from 'react';
import type { ExtendedStimulus } from '@/shared/types/mrt';
import ComboStimulusRenderer from '@/features/stimuli/ComboStimulusRenderer';
import WebStimulusFrame, { isWebStimulusUrl } from '@/features/stimuli/WebStimulusFrame';
import type { LanguageCode } from '@/app/i18n/i18nConfig';
import {
  DEFAULT_CALIBRATION_POINT_STYLE,
  normalizeCalibrationPointStyle,
  renderCalibrationPointVisual,
  type CalibrationPointStyle,
} from '@/features/recording/domain/calibrationPointStyle';
import { normalizeGazePoint, type GlassesGazeSpace } from '@/features/recording/domain/gazeMapping';
import { selectGazeDisplayPoint, useGazeDisplayPath } from '@/features/recording/domain/gazeDisplayPath';
import { registerPlaybackAudioElement } from '@/features/recording/domain/audioRecording';
import { isStimulusAudioUrl, isStimulusVideoUrl } from '@/features/stimuli/domain/mediaTypes';
import { useEyeDataSnapshot, type EyeDataStore } from '@/features/recording/domain/recordingEyeDataStore';

interface FullscreenRecordingOverlayProps {
  isRecording: boolean;
  playbackIndex: number | null;
  stimuli: ExtendedStimulus[];
  bgColor: string;
  eyeDataStore: EyeDataStore;
  hideGaze: boolean;
  playbackSequence?: string[] | null;
  isPreviewing?: boolean;
  calibrationMode?: 'auto' | 'click';
  calibrationState?: 'none' | 'calibrating' | 'finished';
  calibrationPointStyle?: CalibrationPointStyle;
  language?: LanguageCode;
}

const FullscreenRecordingOverlay: React.FC<FullscreenRecordingOverlayProps> = ({
  isRecording,
  playbackIndex,
  stimuli,
  bgColor,
  eyeDataStore,
  hideGaze,
  playbackSequence,
  isPreviewing = false,
  calibrationMode = 'auto',
  calibrationState = 'none',
  calibrationPointStyle = DEFAULT_CALIBRATION_POINT_STYLE,
  language = 'zh-CN',
}) => {
  const eyeData = useEyeDataSnapshot(eyeDataStore, isRecording && playbackIndex !== null);
  const { gazeDisplayPath } = useGazeDisplayPath();
  const glassesGazeSpaceRef = React.useRef<GlassesGazeSpace | null>(null);
  const selectedPreviewGaze = React.useMemo(() => {
    return selectGazeDisplayPoint(eyeData, gazeDisplayPath, { isGlassesMode: calibrationMode === 'click' });
  }, [eyeData, gazeDisplayPath, calibrationMode]);
  const normalizedGaze = React.useMemo(() => {
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth || 1280 : 1280;
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight || 720 : 720;
    const { point, glassesSpace } = normalizeGazePoint({
      rawX: selectedPreviewGaze?.x ?? '',
      rawY: selectedPreviewGaze?.y ?? '',
      isGlassesMode: calibrationMode === 'click',
      frameWidth: viewportWidth,
      frameHeight: viewportHeight,
      glassesSpaceHint: glassesGazeSpaceRef.current,
    });
    glassesGazeSpaceRef.current = calibrationMode === 'click' ? glassesSpace : null;
    return point;
  }, [selectedPreviewGaze, calibrationMode]);
  const hasGazeInput = !!selectedPreviewGaze;

  if (!isRecording || playbackIndex === null) {
    return null;
  }

  // Use playback sequence to find the correct stimulus
  const stimulus = (() => {
    if (playbackSequence && playbackSequence.length > 0 && playbackIndex < playbackSequence.length) {
      const stimulusId = playbackSequence[playbackIndex];
      return stimuli.find(s => s.id === stimulusId);
    }
    // Fallback to legacy index-based lookup
    return stimuli[playbackIndex];
  })();

  if (!stimulus) {
    console.error('[FullscreenRecordingOverlay] Stimulus not found for playbackIndex:', playbackIndex);
    return null;
  }
  const kind = (() => {
    const t = stimulus.stimulusType;
    if (t === 'image' || t === 'video' || t === 'audio' || t === 'text' || t === 'web' || t === 'combo') return t;
    const url = String(stimulus.url || '');
    if (isStimulusVideoUrl(url)) return 'video';
    if (isStimulusAudioUrl(url)) return 'audio';
    if (isWebStimulusUrl(url)) return 'web';
    if (url) return 'image';
    if (stimulus.text) return 'text';
    return 'image';
  })();

  const resolvePlayToEnd = (value: unknown): boolean => {
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

  const isVideoPlayToEnd = kind === 'video' && resolvePlayToEnd(stimulus.playToEnd);
  const isAudioPlayToEnd = kind === 'audio' && resolvePlayToEnd(stimulus.playToEnd);
  const showPreviewExitHint = isPreviewing;
  const isEn = language === 'en-US';
  const gazePointStyle = normalizeCalibrationPointStyle(calibrationPointStyle);
  const stimulusBgColor = kind === 'text' || kind === 'audio' || kind === 'combo'
    ? (stimulus.bgColor || bgColor || '#000000')
    : (bgColor || '#000000');

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center cursor-none"
      style={{ backgroundColor: stimulusBgColor }}
    >
      {kind === 'combo' ? (
        <ComboStimulusRenderer
          key={stimulus.id}
          stimulus={stimulus}
          dispatchLastVideoDuration
          muted={isPreviewing}
          registerAudio={!isPreviewing}
        />
      ) : kind === 'video' ? (
        <video
          key={stimulus.id}
          ref={registerPlaybackAudioElement}
          src={stimulus.url}
          className="w-full h-full object-contain"
          autoPlay
          loop={!isVideoPlayToEnd}
          playsInline
          onEnded={() => {
            window.dispatchEvent(
              new CustomEvent('mrt:recording-video-ended', {
                detail: { stimulusId: stimulus.id },
              }),
            );
          }}
          onError={() => {
            window.dispatchEvent(
              new CustomEvent('mrt:recording-video-error', {
                detail: { stimulusId: stimulus.id },
              }),
            );
          }}
        />
      ) : kind === 'audio' ? (
        <div className="w-full h-full flex items-center justify-center p-16">
          <div className="text-center text-white">
            <div className="text-2xl font-semibold" data-i18n-skip="true">{stimulus.name}</div>
            <div className="mt-3 text-sm text-white/60">{isEn ? 'Audio stimulus playing' : '音频刺激物播放中'}</div>
          </div>
          <audio
            key={stimulus.id}
            ref={registerPlaybackAudioElement}
            src={stimulus.url}
            autoPlay
            loop={!isAudioPlayToEnd}
            onEnded={() => {
              window.dispatchEvent(
                new CustomEvent('mrt:recording-video-ended', {
                  detail: { stimulusId: stimulus.id },
                }),
              );
            }}
            onError={() => {
              window.dispatchEvent(
                new CustomEvent('mrt:recording-video-error', {
                  detail: { stimulusId: stimulus.id },
                }),
              );
            }}
          />
        </div>
      ) : kind === 'web' ? (
        <WebStimulusFrame url={stimulus.url} title={stimulus.name || 'Web stimulus'} />
      ) : kind === 'text' ? (
        <div 
          className="w-full h-full flex items-center justify-center p-16"
          style={{ backgroundColor: stimulusBgColor }}
        >
          <div 
            className="max-w-[80%] text-center whitespace-pre-wrap break-words"
            data-i18n-skip="true"
            style={{
              fontSize: stimulus.fontSize ? `${stimulus.fontSize}px` : '48px',
              fontWeight: 400,
              color: stimulus.fontColor || '#ffffff',
            }}
          >
            {stimulus.text || stimulus.name}
          </div>
        </div>
      ) : (
        <img src={stimulus.url} className="w-full h-full object-contain" alt="Stimulus" />
      )}
      {showPreviewExitHint && (
        <div
          className="absolute top-6 left-1/2 -translate-x-1/2 px-5 py-3 rounded-xl pointer-events-none"
          style={{
            zIndex: 60,
            background: 'color-mix(in srgb, var(--app-surface) 78%, transparent)',
            border: '1px solid color-mix(in srgb, var(--app-border) 85%, transparent)',
            boxShadow: '0 10px 30px color-mix(in srgb, var(--app-bg) 55%, transparent)',
            backdropFilter: 'blur(6px)',
            color: 'var(--app-text)',
          }}
        >
          <div className="text-sm font-semibold tracking-wide">{isEn ? 'Previewing' : '预览中'}</div>
          <div className="text-[12px] mt-1" style={{ color: 'var(--app-muted)' }}>
            {isEn ? 'Press Esc or double-click the left mouse button to exit' : '按 Esc 退出，或双击鼠标左键退出'}
          </div>
        </div>
      )}
      {!hideGaze &&
        calibrationState !== 'calibrating' &&
        hasGazeInput &&
        normalizedGaze &&
        (isRecording || calibrationState === 'finished') && (
        <div
          className="flex items-center justify-center"
          style={{
            position: 'absolute',
            left: `${normalizedGaze.x * 100}%`,
            top: `${normalizedGaze.y * 100}%`,
            width: '44px',
            height: '44px',
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
            zIndex: 50,
          }}
        >
          {renderCalibrationPointVisual(gazePointStyle, true)}
        </div>
      )}
    </div>
  );
};

export default FullscreenRecordingOverlay;
