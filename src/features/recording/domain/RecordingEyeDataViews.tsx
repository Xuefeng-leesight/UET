import React from 'react';
import {
  renderCalibrationPointVisual,
  type CalibrationPointStyle,
} from '@/features/recording/domain/calibrationPointStyle';
import { normalizeGazePoint, type GlassesGazeSpace } from '@/features/recording/domain/gazeMapping';
import { selectGazeDisplayPoint, useGazeDisplayPath } from '@/features/recording/domain/gazeDisplayPath';
import { useEyeDataSnapshot, type EyeDataStore } from '@/features/recording/domain/recordingEyeDataStore';

type SceneBox = { left: number; top: number; width: number; height: number } | null;

const formatEyeDataValue = (value: unknown): string => {
  const raw = String(value ?? '').trim();
  if (!raw) return '---';
  const number = Number.parseFloat(raw);
  return Number.isFinite(number) ? number.toFixed(4) : raw;
};

const formatEyeDataPair = (x: unknown, y: unknown): string =>
  `${formatEyeDataValue(x)} , ${formatEyeDataValue(y)}`;

export const RecordingEyeDataPanel = React.memo(function RecordingEyeDataPanel({
  store,
}: {
  store: EyeDataStore;
}) {
  const eyeData = useEyeDataSnapshot(store);
  return (
    <div className="space-y-2 pt-3 border-t border-slate-200">
      <div className="text-xs font-semibold text-slate-800">眼动数据</div>
      <div className="space-y-1.5">
        <div className="grid grid-cols-[80px_minmax(0,1fr)] items-baseline gap-2">
          <span className="text-[11px] text-slate-600">时间戳</span>
          <span className="min-w-0 break-words text-right text-[11px] text-slate-700 font-mono tabular-nums">{eyeData.timestamp || '---'}</span>
        </div>
        <div className="grid grid-cols-[80px_minmax(0,1fr)] items-baseline gap-2">
          <span className="text-[11px] text-slate-600">推荐注视</span>
          <span className="min-w-0 break-words text-right text-[11px] text-slate-700 font-mono tabular-nums">{formatEyeDataPair(eyeData.recomGazeX, eyeData.recomGazeY)}</span>
        </div>
        <div className="grid grid-cols-[80px_minmax(0,1fr)] items-baseline gap-2">
          <span className="text-[11px] text-slate-600">左眼注视</span>
          <span className="min-w-0 break-words text-right text-[11px] text-slate-700 font-mono tabular-nums">{formatEyeDataPair(eyeData.leftGazeX, eyeData.leftGazeY)}</span>
        </div>
        <div className="grid grid-cols-[80px_minmax(0,1fr)] items-baseline gap-2">
          <span className="text-[11px] text-slate-600">右眼注视</span>
          <span className="min-w-0 break-words text-right text-[11px] text-slate-700 font-mono tabular-nums">{formatEyeDataPair(eyeData.rightGazeX, eyeData.rightGazeY)}</span>
        </div>
        <div className="grid grid-cols-[80px_minmax(0,1fr)] items-baseline gap-2">
          <span className="text-[11px] text-slate-600">左瞳中心</span>
          <span className="min-w-0 break-words text-right text-[11px] text-slate-700 font-mono tabular-nums">{formatEyeDataPair(eyeData.leftPupilCenterX, eyeData.leftPupilCenterY)}</span>
        </div>
        <div className="grid grid-cols-[80px_minmax(0,1fr)] items-baseline gap-2">
          <span className="text-[11px] text-slate-600">右瞳中心</span>
          <span className="min-w-0 break-words text-right text-[11px] text-slate-700 font-mono tabular-nums">{formatEyeDataPair(eyeData.rightPupilCenterX, eyeData.rightPupilCenterY)}</span>
        </div>
      </div>
    </div>
  );
});

export const RecordingPreviewGazeDot = React.memo(function RecordingPreviewGazeDot({
  store,
  visible,
  isGlassesMode,
  frameWidth,
  frameHeight,
  sceneBox,
  pointStyle,
}: {
  store: EyeDataStore;
  visible: boolean;
  isGlassesMode: boolean;
  frameWidth: number;
  frameHeight: number;
  sceneBox: SceneBox;
  pointStyle: CalibrationPointStyle;
}) {
  const eyeData = useEyeDataSnapshot(store, visible);
  const { gazeDisplayPath } = useGazeDisplayPath();
  const glassesGazeSpaceRef = React.useRef<GlassesGazeSpace | null>(null);
  const glassesGazeSpaceKeyRef = React.useRef('');
  const selected = React.useMemo(
    () => selectGazeDisplayPoint(eyeData, gazeDisplayPath, { isGlassesMode }),
    [eyeData, gazeDisplayPath, isGlassesMode],
  );
  const normalized = React.useMemo(() => {
    const spaceKey = `${eyeData.sourceModel || ''}:${isGlassesMode ? 'glasses' : 'desktop'}:${gazeDisplayPath}:${frameWidth}x${frameHeight}`;
    if (glassesGazeSpaceKeyRef.current !== spaceKey) {
      glassesGazeSpaceKeyRef.current = spaceKey;
      glassesGazeSpaceRef.current = null;
    }
    const result = normalizeGazePoint({
      rawX: selected?.x ?? '',
      rawY: selected?.y ?? '',
      isGlassesMode,
      frameWidth,
      frameHeight,
      glassesSpaceHint: glassesGazeSpaceRef.current,
    });
    glassesGazeSpaceRef.current = isGlassesMode ? result.glassesSpace : null;
    return result.point;
  }, [selected, eyeData.sourceModel, gazeDisplayPath, isGlassesMode, frameWidth, frameHeight]);

  if (!visible || !selected || !normalized) return null;
  const x = Math.max(0, Math.min(1, normalized.x));
  const y = Math.max(0, Math.min(1, normalized.y));
  const position = sceneBox
    ? {
        left: `${sceneBox.left + x * sceneBox.width}px`,
        top: `${sceneBox.top + y * sceneBox.height}px`,
      }
    : { left: `${x * 100}%`, top: `${y * 100}%` };

  return (
    <div
      className="absolute pointer-events-none flex items-center justify-center"
      style={{
        ...position,
        width: '44px',
        height: '44px',
        transform: 'translate(-50%, -50%)',
        zIndex: 92,
      }}
    >
      {renderCalibrationPointVisual(pointStyle, true)}
    </div>
  );
});
