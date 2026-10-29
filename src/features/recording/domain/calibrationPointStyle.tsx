import React from 'react';

export type CalibrationPointStyle = 'cross' | 'spread' | 'dot';

export const DEFAULT_CALIBRATION_POINT_STYLE: CalibrationPointStyle = 'spread';

export const CALIBRATION_POINT_STYLE_OPTIONS: Array<{ value: CalibrationPointStyle; label: string }> = [
  { value: 'cross', label: '十字' },
  { value: 'spread', label: '扩散圆' },
  { value: 'dot', label: '点状' },
];

export const normalizeCalibrationPointStyle = (value: unknown): CalibrationPointStyle => {
  if (value === 'cross' || value === 'spread' || value === 'dot') return value;
  return DEFAULT_CALIBRATION_POINT_STYLE;
};

export function renderCalibrationPointVisual(style: CalibrationPointStyle, active: boolean = true): React.ReactNode {
  const color = active ? '#ef4444' : 'color-mix(in srgb, var(--app-muted) 72%, var(--app-surface))';

  if (style === 'cross') {
    return (
      <>
        <div
          className="absolute left-1/2 top-1/2 h-7 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ background: color }}
        />
        <div
          className="absolute left-1/2 top-1/2 h-0.5 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ background: color }}
        />
      </>
    );
  }

  if (style === 'dot') {
    return (
      <div
        className="rounded-full"
        style={{
          width: '14px',
          height: '14px',
          borderRadius: '9999px',
          background: color,
        }}
      />
    );
  }

  return (
    <div
      className="rounded-full"
      style={{
        width: '20px',
        height: '20px',
        borderRadius: '9999px',
        background: color,
        boxShadow: active ? '0 0 12px rgba(239, 68, 68, 0.6)' : undefined,
      }}
    />
  );
}
