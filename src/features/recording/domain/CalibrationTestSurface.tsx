import React from 'react';
import { CALIB_POINTS } from '@/features/recording/domain/calibrationConstants';

interface CalibrationTestSurfaceProps {
  language?: 'zh-CN' | 'en-US';
  compact?: boolean;
  children?: React.ReactNode;
}

/**
 * Shared calibration-test reference surface.
 *
 * The participant window and the operator monitor intentionally render the
 * same reference field. Live gaze is supplied only as operator-side children,
 * so it can never leak onto the participant display.
 */
const CalibrationTestSurface: React.FC<CalibrationTestSurfaceProps> = ({
  language = 'zh-CN',
  compact = false,
  children,
}) => {
  const isEn = language === 'en-US';
  return (
    <div
      className="relative h-full w-full cursor-none overflow-hidden"
      style={{
        background:
          'radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--app-primary, #0ea5e9) 12%, var(--app-bg, #0f172a)) 0%, var(--app-bg, #0f172a) 66%)',
      }}
    >
      {CALIB_POINTS.map((point, index) => (
        <div
          key={`${point.x}-${point.y}`}
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            left: `${point.x * 100}%`,
            top: `${point.y * 100}%`,
            width: compact ? '8px' : '12px',
            height: compact ? '8px' : '12px',
            background: index === 4 ? '#ef4444' : '#94a3b8',
            border: '1px solid rgba(255, 255, 255, 0.86)',
            boxShadow: index === 4
              ? '0 0 0 5px rgba(239, 68, 68, 0.16)'
              : '0 2px 8px rgba(15, 23, 42, 0.3)',
            opacity: index === 4 ? 1 : 0.82,
          }}
        />
      ))}
      <div
        className={`absolute left-1/2 top-3 z-40 -translate-x-1/2 rounded-full bg-slate-950/90 font-semibold tracking-wide text-white shadow-lg ${compact ? 'px-3 py-1 text-[10px]' : 'px-5 py-2 text-sm'}`}
      >
        {isEn ? 'Calibration test · Press Esc to exit' : '校准测试中 · 按 Esc 退出'}
      </div>
      {children}
    </div>
  );
};

export default CalibrationTestSurface;
