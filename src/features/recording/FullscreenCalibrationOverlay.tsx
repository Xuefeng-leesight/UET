import React from 'react';
import { createPortal } from 'react-dom';
import { CALIB_POINTS } from '@/features/recording/domain/calibrationConstants';
import {
  DEFAULT_CALIBRATION_POINT_STYLE,
  normalizeCalibrationPointStyle,
  renderCalibrationPointVisual,
  type CalibrationPointStyle,
} from '@/features/recording/domain/calibrationPointStyle';
import { containedImageBox, pointerToImagePoint, normalizeGazePoint, type GlassesGazeSpace } from '@/features/recording/domain/gazeMapping';
import { selectGazeDisplayPoint, useGazeDisplayPath } from '@/features/recording/domain/gazeDisplayPath';
import { useEyeDataSnapshot, type EyeDataStore } from '@/features/recording/domain/recordingEyeDataStore';

interface FullscreenCalibrationOverlayProps {
  calibrationState: 'none' | 'calibrating' | 'finished';
  calibPointIndex: number;
  calibScale: number;
  eyeDataStore: EyeDataStore;
  calibrationMode?: 'auto' | 'click';
  onConfirmPoint?: (point?: { x: number; y: number }) => void;
  onExit?: () => void;
  sceneImageSrc?: string | null;
  hideGaze?: boolean;
  isCalibrationTestMode?: boolean;
  calibrationPointStyle?: CalibrationPointStyle;
  language?: 'zh-CN' | 'en-US';
}

const FullscreenCalibrationOverlay: React.FC<FullscreenCalibrationOverlayProps> = ({
  calibrationState,
  calibPointIndex,
  calibScale,
  eyeDataStore,
  calibrationMode = 'auto',
  onConfirmPoint,
  onExit,
  sceneImageSrc = null,
  hideGaze = false,
  isCalibrationTestMode = false,
  calibrationPointStyle = DEFAULT_CALIBRATION_POINT_STYLE,
  language = 'zh-CN',
}) => {
  const eyeData = useEyeDataSnapshot(eyeDataStore, calibrationState !== 'none');
  const isEn = language === 'en-US';
  const { gazeDisplayPath } = useGazeDisplayPath();
  const getViewportSize = () => {
    if (typeof window === 'undefined') {
      return { w: 1920, h: 1080 };
    }
    return {
      w: Math.max(1, Math.floor(window.innerWidth || 1)),
      h: Math.max(1, Math.floor(window.innerHeight || 1)),
    };
  };
  const [viewportSize, setViewportSize] = React.useState<{ w: number; h: number }>(() => getViewportSize());
  const [sceneNaturalSize, setSceneNaturalSize] = React.useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [clickedPoint, setClickedPoint] = React.useState<{ x: number; y: number } | null>(null);
  const glassesGazeSpaceRef = React.useRef<GlassesGazeSpace | null>(null);
  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onResize = () => setViewportSize(getViewportSize());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  React.useEffect(() => {
    if (calibrationState !== 'calibrating' || calibrationMode !== 'click') {
      setClickedPoint(null);
    }
  }, [calibrationMode, calibrationState, calibPointIndex]);

  const hasSceneBackground = calibrationMode === 'click' && Boolean(sceneImageSrc);
  const sceneBox = React.useMemo(() => {
    const vw = Math.max(1, viewportSize.w);
    const vh = Math.max(1, viewportSize.h);
    if (!hasSceneBackground) {
      return { left: 0, top: 0, width: vw, height: vh };
    }

    const iw = Math.max(1, Math.floor(sceneNaturalSize.w || 16));
    const ih = Math.max(1, Math.floor(sceneNaturalSize.h || 9));
    return containedImageBox(vw, vh, iw, ih)!;
  }, [viewportSize.w, viewportSize.h, sceneNaturalSize.w, sceneNaturalSize.h, hasSceneBackground]);

  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const activeIndex = Number.isFinite(calibPointIndex)
    ? Math.max(0, Math.min(CALIB_POINTS.length - 1, Math.round(calibPointIndex)))
    : 4;
  const activePoint = CALIB_POINTS[activeIndex] || CALIB_POINTS[4];
  const normalizedScale = Number.isFinite(calibScale) ? Math.max(0.12, Math.min(1, calibScale)) : 1;
  const targetSize = Math.round(44 + normalizedScale * 58);
  const targetStyle = normalizeCalibrationPointStyle(calibrationPointStyle);
  const normalizedGaze = React.useMemo(() => {
    const isGlassesMode = calibrationMode === 'click';
    const selected = selectGazeDisplayPoint(eyeData, gazeDisplayPath, { isGlassesMode });
    if (!selected) return null;
    const { point, glassesSpace } = normalizeGazePoint({
      rawX: selected.x,
      rawY: selected.y,
      isGlassesMode,
      frameWidth: sceneNaturalSize.w || sceneBox.width,
      frameHeight: sceneNaturalSize.h || sceneBox.height,
      glassesSpaceHint: glassesGazeSpaceRef.current,
    });
    glassesGazeSpaceRef.current = isGlassesMode ? glassesSpace : null;
    return point;
  }, [eyeData, gazeDisplayPath, calibrationMode, sceneBox.width, sceneBox.height, sceneNaturalSize.w, sceneNaturalSize.h]);
  const shouldShowFinishedGaze =
    calibrationState === 'finished' &&
    !!normalizedGaze &&
    (calibrationMode !== 'click' || isCalibrationTestMode || !hideGaze);
  const shouldShowGlassesLiveGaze =
    calibrationMode === 'click' &&
    calibrationState === 'finished' &&
    !!normalizedGaze &&
    (isCalibrationTestMode || !hideGaze);

  if (calibrationState === 'none') {
    return null;
  }

  const renderGazeDot = () => {
    if (!normalizedGaze) return null;
    const x = clamp01(normalizedGaze.x);
    const y = clamp01(normalizedGaze.y);
    const left = `${x * 100}%`;
    const top = `${y * 100}%`;
    return (
      <div
        className="absolute pointer-events-none flex items-center justify-center"
        style={{
          left,
          top,
          width: '44px',
          height: '44px',
          transform: 'translate(-50%, -50%)',
          transition: 'left 100ms ease-out, top 100ms ease-out',
          zIndex: 70,
        }}
      >
        {renderCalibrationPointVisual(targetStyle, true)}
      </div>
    );
  };

  const renderClickedPoint = () => {
    if (!clickedPoint) return null;
    return (
      <div
        className="absolute pointer-events-none flex items-center justify-center"
        style={{
          left: `${clamp01(clickedPoint.x) * 100}%`,
          top: `${clamp01(clickedPoint.y) * 100}%`,
          width: '44px',
          height: '44px',
          transform: 'translate(-50%, -50%)',
          zIndex: 80,
        }}
      >
        {renderCalibrationPointVisual(targetStyle, true)}
      </div>
    );
  };

  const renderReferencePoints = () => {
    if (calibrationMode === 'click') {
      return null;
    }
    return CALIB_POINTS.map((pt, idx) => {
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
              : '#64748b',
            border: active
              ? '1px solid rgba(255, 255, 255, 0.92)'
              : '1px solid rgba(255, 255, 255, 0.82)',
            opacity: active ? 1 : 0.72,
            transition: 'all 240ms ease',
          }}
        />
      );
    });
  };

  const renderStatusCard = () => {
    const statusText = isCalibrationTestMode
      ? (isEn ? 'Calibration test' : '校准测试中')
      : calibrationState === 'calibrating'
        ? (isEn ? 'Calibrating' : '正在校准')
        : (isEn ? 'Calibration complete' : '校准完成');
    const hintText = isCalibrationTestMode
      ? (isEn ? 'Press Esc to exit calibration test' : '按 Esc 退出校准测试')
      : (calibrationState === 'calibrating'
          ? calibrationMode === 'click'
            ? (isEn ? 'Look at the highlighted point and click it to complete this sample' : '请注视高亮点并点击它完成当前采样')
            : (isEn ? 'Keep your head steady and look at the highlighted point' : '请保持头部稳定并注视高亮点')
          : (isEn ? 'Press Esc or double-click the screen to exit calibration' : '请按 Esc 或双击屏幕退出校准界面'));
    return (
      <div
        className="absolute top-6 left-1/2 -translate-x-1/2 px-5 py-3 rounded-xl pointer-events-none"
        style={{
          zIndex: 60,
          background: 'rgba(15, 23, 42, 0.94)',
          border: '1px solid rgba(255, 255, 255, 0.22)',
          boxShadow: '0 10px 30px rgba(2, 6, 23, 0.42)',
          backdropFilter: 'blur(6px)',
          color: '#ffffff',
        }}
      >
        <div className="text-sm font-semibold tracking-wide">{statusText}</div>
        <div className="text-[12px] mt-1" style={{ color: '#cbd5e1' }}>
          {hintText}
        </div>
      </div>
    );
  };

  const renderPoints = () => {
    if (calibrationState === 'calibrating') {
      return (
        <>
          {renderReferencePoints()}
          {shouldShowGlassesLiveGaze ? renderGazeDot() : null}
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
              boxShadow: 'none',
              transition:
                'left 340ms cubic-bezier(0.22, 1, 0.36, 1), top 340ms cubic-bezier(0.22, 1, 0.36, 1), width 120ms linear, height 120ms linear',
              pointerEvents: calibrationMode === 'click' ? 'auto' : 'none',
              cursor: calibrationMode === 'click' ? 'pointer' : 'default',
            }}
            onClick={
              calibrationMode === 'click'
                ? (event) => {
                    event.stopPropagation();
                    const point = { x: activePoint.x, y: activePoint.y };
                    setClickedPoint(point);
                    onConfirmPoint?.(point);
                  }
                : undefined
            }
          >
            {calibrationMode !== 'click' && (
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
          {renderClickedPoint()}
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
                background: 'rgba(100, 116, 139, 0.36)',
                border: '1px solid rgba(148, 163, 184, 0.92)',
                transition: 'all 260ms ease',
              }}
            >
              {renderCalibrationPointVisual('spread', false)}
            </div>
          );
        })}
        {renderClickedPoint()}
        {shouldShowFinishedGaze ? renderGazeDot() : null}
      </>
    );
  };

  const handleSceneClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (calibrationMode !== 'click' || calibrationState !== 'calibrating') return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    if (hasSceneBackground && (!sceneNaturalSize.w || !sceneNaturalSize.h)) return;
    const point = pointerToImagePoint(event.clientX, event.clientY, rect,
      hasSceneBackground ? sceneNaturalSize.w : rect.width,
      hasSceneBackground ? sceneNaturalSize.h : rect.height);
    if (!point) return;
    setClickedPoint(point);
    onConfirmPoint?.(point);
  };

  const overlay = (
    <div
      data-i18n-skip="true"
      className={`fixed inset-0 flex items-center justify-center ${calibrationMode === 'click' ? 'cursor-default' : 'cursor-none'}`}
      onDoubleClick={onExit}
      style={{
        zIndex: 2_147_483_600,
        isolation: 'isolate',
        background: 'var(--app-bg, #0f172a)',
      }}
    >
      {hasSceneBackground ? (
        <img
          src={sceneImageSrc || undefined}
          alt=""
          className="absolute"
          style={{
            left: `${sceneBox.left}px`,
            top: `${sceneBox.top}px`,
            width: `${sceneBox.width}px`,
            height: `${sceneBox.height}px`,
            objectFit: 'contain',
            objectPosition: 'center',
          }}
          onLoad={(event) => {
            const img = event.currentTarget;
            const w = Math.max(0, Math.floor(img.naturalWidth || 0));
            const h = Math.max(0, Math.floor(img.naturalHeight || 0));
            if (w > 0 && h > 0) {
              setSceneNaturalSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
            }
          }}
        />
      ) : (
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--app-primary) 12%, var(--app-bg)) 0%, var(--app-bg) 66%)',
          }}
        />
      )}
      {renderStatusCard()}
      <div
        className="absolute"
        style={{
          left: `${sceneBox.left}px`,
          top: `${sceneBox.top}px`,
          width: `${sceneBox.width}px`,
          height: `${sceneBox.height}px`,
          cursor: calibrationMode === 'click' && calibrationState === 'calibrating' ? 'pointer' : 'default',
        }}
        onClick={handleSceneClick}
      >
        {renderPoints()}
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(overlay, document.body) : overlay;
};

export default FullscreenCalibrationOverlay;
