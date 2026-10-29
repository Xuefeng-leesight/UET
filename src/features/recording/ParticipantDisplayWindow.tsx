import React from 'react';
import { ipcEvents } from '@/infrastructure/electron/ipcEvents';
import ComboStimulusRenderer from '@/features/stimuli/ComboStimulusRenderer';
import WebStimulusFrame, { isWebStimulusUrl } from '@/features/stimuli/WebStimulusFrame';
import { CALIB_POINTS } from '@/features/recording/domain/calibrationConstants';
import {
  normalizeCalibrationPointStyle,
  renderCalibrationPointVisual,
} from '@/features/recording/domain/calibrationPointStyle';
import { normalizeGazePoint, type GlassesGazeSpace } from '@/features/recording/domain/gazeMapping';
import { selectGazeDisplayPoint, useGazeDisplayPath } from '@/features/recording/domain/gazeDisplayPath';
import { registerPlaybackAudioElement } from '@/features/recording/domain/audioRecording';
import { isStimulusAudioUrl, isStimulusVideoUrl } from '@/features/stimuli/domain/mediaTypes';
import {
  DEFAULT_PARTICIPANT_WINDOW_STATE,
  type ParticipantWindowState,
} from '@/features/recording/domain/participantWindowState';
import CalibrationTestSurface from '@/features/recording/domain/CalibrationTestSurface';

const ParticipantDisplayWindow: React.FC = () => {
  const { gazeDisplayPath } = useGazeDisplayPath();
  const [payload, setPayload] = React.useState<ParticipantWindowState>(DEFAULT_PARTICIPANT_WINDOW_STATE);
  const glassesGazeSpaceRef = React.useRef<GlassesGazeSpace | null>(null);

  React.useEffect(() => {
    const handler = (_event: unknown, data: unknown) => {
      const next = data && typeof data === 'object' ? (data as Partial<ParticipantWindowState>) : {};
      setPayload((prev) => ({
        ...prev,
        ...next,
        calibrationPointStyle: normalizeCalibrationPointStyle(next.calibrationPointStyle ?? prev.calibrationPointStyle),
        eyeData: {
          recomGazeX: next.eyeData?.recomGazeX ?? prev.eyeData.recomGazeX,
          recomGazeY: next.eyeData?.recomGazeY ?? prev.eyeData.recomGazeY,
          recomPointX: next.eyeData?.recomPointX ?? prev.eyeData.recomPointX,
          recomPointY: next.eyeData?.recomPointY ?? prev.eyeData.recomPointY,
          recomRawX: next.eyeData?.recomRawX ?? prev.eyeData.recomRawX,
          recomRawY: next.eyeData?.recomRawY ?? prev.eyeData.recomRawY,
          recomSmoothX: next.eyeData?.recomSmoothX ?? prev.eyeData.recomSmoothX,
          recomSmoothY: next.eyeData?.recomSmoothY ?? prev.eyeData.recomSmoothY,
          leftGazeX: next.eyeData?.leftGazeX ?? prev.eyeData.leftGazeX,
          leftGazeY: next.eyeData?.leftGazeY ?? prev.eyeData.leftGazeY,
          leftPointX: next.eyeData?.leftPointX ?? prev.eyeData.leftPointX,
          leftPointY: next.eyeData?.leftPointY ?? prev.eyeData.leftPointY,
          leftRawX: next.eyeData?.leftRawX ?? prev.eyeData.leftRawX,
          leftRawY: next.eyeData?.leftRawY ?? prev.eyeData.leftRawY,
          leftSmoothX: next.eyeData?.leftSmoothX ?? prev.eyeData.leftSmoothX,
          leftSmoothY: next.eyeData?.leftSmoothY ?? prev.eyeData.leftSmoothY,
          rightGazeX: next.eyeData?.rightGazeX ?? prev.eyeData.rightGazeX,
          rightGazeY: next.eyeData?.rightGazeY ?? prev.eyeData.rightGazeY,
          rightPointX: next.eyeData?.rightPointX ?? prev.eyeData.rightPointX,
          rightPointY: next.eyeData?.rightPointY ?? prev.eyeData.rightPointY,
          rightRawX: next.eyeData?.rightRawX ?? prev.eyeData.rightRawX,
          rightRawY: next.eyeData?.rightRawY ?? prev.eyeData.rightRawY,
          rightSmoothX: next.eyeData?.rightSmoothX ?? prev.eyeData.rightSmoothX,
          rightSmoothY: next.eyeData?.rightSmoothY ?? prev.eyeData.rightSmoothY,
        },
      }));
    };
    const unsubscribe = ipcEvents.on('subject-window:update', handler);
    ipcEvents.send('subject-window:ready');
    return unsubscribe;
  }, []);

  React.useEffect(() => {
    const revision = Number(payload.participantRenderRevision || 0);
    if (!Number.isFinite(revision) || revision <= 0) return;
    // This effect runs after React committed the calibration/stimulus surface.
    // The main process waits for it before revealing a newly-created window.
    ipcEvents.send('subject-window:rendered', { revision });
  }, [payload.participantRenderRevision]);

  React.useEffect(() => {
    const canForwardExit = payload.isRecording || Boolean(payload.isPreviewing) || payload.calibrationState !== 'none';
    const onPointerDown = (event: PointerEvent) => {
      if (!payload.isRecording) return;
      ipcEvents.send('subject-window:user-input', {
        type: 'mouse',
        button: event.button,
      });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!canForwardExit) return;
      if (event.key !== 'Escape') return;
      ipcEvents.send('subject-window:user-input', {
        type: 'key',
        key: 'Escape',
      });
    };
    const onDoubleClick = (event: MouseEvent) => {
      if (!canForwardExit) return;
      ipcEvents.send('subject-window:user-input', {
        type: 'mouse-double',
        button: event.button,
      });
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('dblclick', onDoubleClick, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('dblclick', onDoubleClick, true);
    };
  }, [payload.isRecording, payload.isPreviewing, payload.calibrationState]);

  React.useEffect(() => {
    const forwardPlaybackDone = (event: Event) => {
      const detail = (event as CustomEvent<{ stimulusId?: string }>).detail;
      const stimulusId = String(detail?.stimulusId || '');
      if (!stimulusId) return;
      ipcEvents.send('subject-window:user-input', {
        type: 'playback-done',
        eventName: event.type,
        stimulusId,
      });
    };
    window.addEventListener('mrt:recording-video-ended', forwardPlaybackDone);
    window.addEventListener('mrt:recording-video-error', forwardPlaybackDone);
    return () => {
      window.removeEventListener('mrt:recording-video-ended', forwardPlaybackDone);
      window.removeEventListener('mrt:recording-video-error', forwardPlaybackDone);
    };
  }, []);

  const stimulus = payload.stimulus;
  const kind = (() => {
    if (!stimulus) return 'none';
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
  const isVideoPlayToEnd = kind === 'video' && !!stimulus && resolvePlayToEnd(stimulus.playToEnd);
  const isAudioPlayToEnd = kind === 'audio' && !!stimulus && resolvePlayToEnd(stimulus.playToEnd);
  const showPreviewExitHint = Boolean(payload.isPreviewing);
  const isEn = payload.language === 'en-US';
  const dispatchPlaybackDone = React.useCallback(
    (eventName: 'mrt:recording-video-ended' | 'mrt:recording-video-error') => {
      if (!stimulus?.id) return;
      window.dispatchEvent(new CustomEvent(eventName, {
        detail: { stimulusId: stimulus.id },
      }));
    },
    [stimulus?.id],
  );
  const selectedPreviewGaze = React.useMemo(() => {
    return selectGazeDisplayPoint(payload.eyeData, gazeDisplayPath, { isGlassesMode: payload.calibrationMode === 'click' });
  }, [payload.eyeData, gazeDisplayPath, payload.calibrationMode]);
  const normalizedGaze = React.useMemo(() => {
    const isGlassesMode = payload.calibrationMode === 'click';
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth || 1280 : 1280;
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight || 720 : 720;
    const { point, glassesSpace } = normalizeGazePoint({
      rawX: selectedPreviewGaze?.x ?? '',
      rawY: selectedPreviewGaze?.y ?? '',
      isGlassesMode,
      frameWidth: viewportWidth,
      frameHeight: viewportHeight,
      glassesSpaceHint: glassesGazeSpaceRef.current,
    });
    glassesGazeSpaceRef.current = isGlassesMode ? glassesSpace : null;
    return point;
  }, [selectedPreviewGaze, payload.calibrationMode]);
  const hasGazeInput = !!selectedPreviewGaze;
  const shouldShowGlassesCalibrationGaze =
    payload.calibrationMode === 'click' &&
    payload.calibrationState === 'finished' &&
    !payload.hideGaze &&
    hasGazeInput &&
    !!normalizedGaze;
  const shouldShowPreviewGaze =
    !payload.hideGaze &&
    hasGazeInput &&
    !!normalizedGaze &&
    (payload.isRecording || payload.calibrationMode === 'click' || payload.calibrationState === 'finished');
  const showCalibrationTestScreen = payload.calibrationState === 'finished' && payload.isCalibrationTestMode === true;
  const stimulusBgColor = kind === 'text' || kind === 'combo'
    ? (stimulus?.bgColor || payload.bgColor || '#000000')
    : (payload.bgColor || '#000000');
  const gazePointStyle = normalizeCalibrationPointStyle(payload.calibrationPointStyle);
  const renderCalibrationStatusCard = () => {
    const statusText = payload.calibrationState === 'calibrating'
      ? (isEn ? 'Calibrating' : '正在校准')
      : (isEn ? 'Calibration complete' : '校准完成');
    const hintText = payload.calibrationState === 'calibrating'
      ? (isEn ? 'Keep your head steady and look at the highlighted point' : '请保持头部稳定并注视高亮点')
      : (isEn ? 'Please wait for the operator to continue' : '请等待主试屏继续操作');
    return (
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
        <div className="text-sm font-semibold tracking-wide">{statusText}</div>
        <div className="text-[12px] mt-1" style={{ color: 'var(--app-muted)' }}>
          {hintText}
        </div>
      </div>
    );
  };

  const renderCalibrationView = () => {
    if (payload.calibrationState === 'none') return null;
    const activeIndex = Number.isFinite(payload.calibPointIndex)
      ? Math.max(0, Math.min(CALIB_POINTS.length - 1, Math.round(payload.calibPointIndex)))
      : 4;
    const activePoint = CALIB_POINTS[activeIndex] || CALIB_POINTS[4];
    const normalizedScale = Number.isFinite(payload.calibScale) ? Math.max(0.12, Math.min(1, payload.calibScale)) : 1;
    const targetSize = Math.round(44 + normalizedScale * 58);
    const targetStyle = normalizeCalibrationPointStyle(payload.calibrationPointStyle);

    const renderReferencePoints = () => (
      <>
        {CALIB_POINTS.map((pt, idx) => {
          const left = `${pt.x * 100}%`;
          const top = `${pt.y * 100}%`;
          const active = idx === activeIndex;
          return (
            <div
              key={idx}
              className="absolute rounded-full"
              style={{
                left,
                top,
                width: active ? '16px' : '12px',
                height: active ? '16px' : '12px',
                transform: 'translate(-50%, -50%)',
                borderRadius: '9999px',
                background: active
                  ? '#ef4444'
              : 'color-mix(in srgb, var(--app-border) 70%, var(--app-surface))',
                border: active
                  ? '1px solid rgba(255, 255, 255, 0.92)'
                  : '1px solid color-mix(in srgb, var(--app-border) 90%, transparent)',
                opacity: active ? 0.95 : 0.45,
                transition: 'all 240ms ease',
              }}
            />
          );
        })}
      </>
    );

    if (payload.calibrationState === 'calibrating') {
      return (
        <>
          {renderReferencePoints()}
          <div
            className="absolute rounded-full flex items-center justify-center pointer-events-none"
            style={{
              left: `${activePoint.x * 100}%`,
              top: `${activePoint.y * 100}%`,
              width: `${targetSize}px`,
              height: `${targetSize}px`,
              transform: 'translate(-50%, -50%)',
              borderRadius: '9999px',
              background: 'transparent',
              border: 'none',
              boxShadow:
                'none',
              transition:
                'left 340ms cubic-bezier(0.22, 1, 0.36, 1), top 340ms cubic-bezier(0.22, 1, 0.36, 1), width 120ms linear, height 120ms linear',
            }}
          >
            {payload.calibrationMode !== 'click' && (
              <>
                <div
                  className="absolute inset-0 rounded-full"
                  style={{
                    border: '2px solid rgba(239, 68, 68, 0.72)',
                    animation: 'mrt-calib-breath 920ms ease-in-out infinite',
                  }}
                />
                <div
                  className="absolute inset-0 rounded-full animate-pulse"
                  style={{ background: 'rgba(239, 68, 68, 0.16)' }}
                />
              </>
            )}
            {renderCalibrationPointVisual(targetStyle, true)}
          </div>
        </>
      );
    }

    return (
      <>
        {CALIB_POINTS.map((pt, idx) => {
          const left = `${pt.x * 100}%`;
          const top = `${pt.y * 100}%`;
          const radiusMax = 40;
          const size = radiusMax * 2;
          return (
            <div
              key={idx}
              className="absolute rounded-full flex items-center justify-center pointer-events-none"
              style={{
                left,
                top,
                width: `${size}px`,
                height: `${size}px`,
                transform: 'translate(-50%, -50%)',
                borderRadius: '9999px',
                background: 'color-mix(in srgb, var(--app-border) 38%, transparent)',
                border: '1px solid color-mix(in srgb, var(--app-border) 95%, transparent)',
                transition: 'all 260ms ease',
              }}
            >
              {renderCalibrationPointVisual('spread', false)}
            </div>
          );
        })}
      </>
    );
  };

  if (payload.calibrationState === 'calibrating') {
    return (
      <div
        className="fixed inset-0 cursor-none"
        style={{
          background:
            'radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--app-primary) 12%, var(--app-bg)) 0%, var(--app-bg) 66%)',
        }}
      >
        {renderCalibrationStatusCard()}
        {renderCalibrationView()}
        {shouldShowGlassesCalibrationGaze && normalizedGaze && (
          <div
            className="absolute pointer-events-none flex items-center justify-center"
            style={{
              left: `${normalizedGaze.x * 100}%`,
              top: `${normalizedGaze.y * 100}%`,
              width: '44px',
              height: '44px',
              transform: 'translate(-50%, -50%)',
              zIndex: 50,
              transition: 'left 100ms ease-out, top 100ms ease-out',
            }}
          >
            {renderCalibrationPointVisual(gazePointStyle, true)}
          </div>
        )}
      </div>
    );
  }

  if (!payload.isRecording && payload.calibrationState === 'finished' && !payload.isCalibrationTestMode) {
    return (
      <div
        className="fixed inset-0 cursor-none"
        style={{
          background:
            'radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--app-primary) 12%, var(--app-bg)) 0%, var(--app-bg) 66%)',
        }}
      >
        {renderCalibrationStatusCard()}
        {renderCalibrationView()}
      </div>
    );
  }

  if (!payload.isRecording || !stimulus || kind === 'none') {
    if (showCalibrationTestScreen) {
      return (
        <div className="fixed inset-0">
          <CalibrationTestSurface language={payload.language} />
        </div>
      );
    }
    if (payload.isRecording && payload.calibrationMode === 'click') {
      return <div className="fixed inset-0 cursor-none bg-black" />;
    }
    return (
      <div
        className="h-screen w-screen text-white flex items-center justify-center"
        style={{ backgroundColor: payload.bgColor || '#000000' }}
      >
        <div className="text-center">
          <div className="text-lg font-bold">{isEn ? 'Participant screen standby' : '被试屏待机中'}</div>
          <div className="mt-2 text-sm text-white/60">
            {isEn ? 'Content will appear automatically after recording or calibration starts' : '开始录制或校准后将自动显示内容'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 cursor-none" style={{ backgroundColor: stimulusBgColor }}>
      {kind === 'combo' ? (
        <ComboStimulusRenderer stimulus={stimulus} />
      ) : kind === 'video' ? (
        <video
          ref={registerPlaybackAudioElement}
          src={stimulus.url}
          className="h-full w-full object-contain"
          autoPlay
          loop={!isVideoPlayToEnd}
          playsInline
          onEnded={() => dispatchPlaybackDone('mrt:recording-video-ended')}
          onError={() => dispatchPlaybackDone('mrt:recording-video-error')}
        />
      ) : kind === 'audio' ? (
        <div className="h-full w-full flex items-center justify-center p-16 text-white">
          <div className="text-center">
            <div className="text-2xl font-semibold" data-i18n-skip="true">{stimulus.name}</div>
            <div className="mt-3 text-sm text-white/60">{isEn ? 'Audio stimulus playing' : '音频刺激物播放中'}</div>
          </div>
          <audio
            ref={registerPlaybackAudioElement}
            src={stimulus.url}
            autoPlay
            loop={!isAudioPlayToEnd}
            onEnded={() => dispatchPlaybackDone('mrt:recording-video-ended')}
            onError={() => dispatchPlaybackDone('mrt:recording-video-error')}
          />
        </div>
      ) : kind === 'web' ? (
        <WebStimulusFrame url={stimulus.url} title={stimulus.name || 'Web stimulus'} />
      ) : kind === 'text' ? (
        <div
          className="h-full w-full flex items-center justify-center p-16"
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
        <img src={stimulus.url} className="h-full w-full object-contain" alt="Stimulus" />
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
      {shouldShowPreviewGaze && normalizedGaze && (
        <div
          className="absolute pointer-events-none flex items-center justify-center"
          style={{
            left: `${normalizedGaze.x * 100}%`,
            top: `${normalizedGaze.y * 100}%`,
            width: '44px',
            height: '44px',
            transform: 'translate(-50%, -50%)',
            zIndex: 50,
            transition: 'left 100ms ease-out, top 100ms ease-out',
          }}
        >
          {renderCalibrationPointVisual(gazePointStyle, true)}
        </div>
      )}
    </div>
  );
};

export default ParticipantDisplayWindow;
