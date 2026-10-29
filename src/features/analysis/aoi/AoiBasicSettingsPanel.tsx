import Switch from '@/shared/ui/Switch';
import type React from 'react';
import { FileText, Maximize } from 'lucide-react';

import CustomSelect from '@/shared/ui/CustomSelect';
import type { ExtendedStimulus } from '@/shared/types/mrt';
import type { GridMetric, GridMetricOption } from '@/features/analysis/aoi/aoiMetrics';

type AoiBasicSettingsPanelProps = {
  stimuli: ExtendedStimulus[];
  selectedStimulusId: string | null;
  isGlassesMode: boolean;
  recordingVideoName?: string;
  isEn?: boolean;
  showMarkTrack: boolean;
  showTriggerTrack: boolean;
  aoiFontSize: number;
  gridFontSize: number;
  gridEnabled: boolean;
  gridLoading: boolean;
  gridError: string | null;
  gridMetric: GridMetric;
  gridMetricOptions: GridMetricOption[];
  gridShowValues: boolean;
  gridShowScale: boolean;
  gridRows: number;
  gridCols: number;
  gridOpacity: number;
  aoiShowName: boolean;
  aoiOpacity: number;
  aoiBorderWidth: number;
  onSelectedStimulusIdChange: (id: string | null) => void;
  onShowMarkTrackChange: React.Dispatch<React.SetStateAction<boolean>>;
  onShowTriggerTrackChange: React.Dispatch<React.SetStateAction<boolean>>;
  onAoiFontSizeChange: (value: number) => void;
  onGridFontSizeChange: (value: number) => void;
  onGridEnabledChange: React.Dispatch<React.SetStateAction<boolean>>;
  onGridMetricChange: (value: GridMetric) => void;
  onGridShowValuesChange: React.Dispatch<React.SetStateAction<boolean>>;
  onGridShowScaleChange: React.Dispatch<React.SetStateAction<boolean>>;
  onGridRowsChange: (value: number) => void;
  onGridColsChange: (value: number) => void;
  onGridOpacityChange: (value: number) => void;
  onAoiShowNameChange: React.Dispatch<React.SetStateAction<boolean>>;
  onAoiOpacityChange: (value: number) => void;
  onAoiBorderWidthChange: (value: number) => void;
};

function SmallToggle({ checked, onClick, label, activeClass = 'border-sky-400 bg-sky-500' }: { checked: boolean; onClick: () => void; label: string; activeClass?: string }) {
  return <Switch checked={checked} onClick={onClick} aria-label={label} title={label} size="compact" activeClass={activeClass} />;
}

function Slider({ label, rangeLabel, min, max, value, displayValue, onChange }: { label: string; rangeLabel: string; min: number; max: number; value: number; displayValue: string | number; onChange: (value: number) => void }) {
  return (
    <div className="space-y-1" title={`${label} · ${rangeLabel}`}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 text-xs text-slate-600"><span>{label}</span><span className="min-w-[7ch] text-right font-mono tabular-nums font-medium text-slate-800">{displayValue}</span></div>
      <input type="range" aria-label={label} aria-valuetext={String(displayValue)} min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} className="mrt-slider cursor-pointer" />
    </div>
  );
}

export function AoiBasicSettingsPanel(props: AoiBasicSettingsPanelProps) {
  const {
    stimuli, selectedStimulusId, isGlassesMode, recordingVideoName, isEn = false, showMarkTrack, showTriggerTrack, aoiFontSize, gridFontSize,
    gridEnabled, gridLoading, gridError, gridMetric, gridMetricOptions, gridShowValues, gridShowScale,
    gridRows, gridCols, gridOpacity, aoiShowName, aoiOpacity, aoiBorderWidth, onSelectedStimulusIdChange,
    onShowMarkTrackChange, onShowTriggerTrackChange, onAoiFontSizeChange, onGridFontSizeChange,
    onGridEnabledChange, onGridMetricChange, onGridShowValuesChange, onGridShowScaleChange,
    onGridRowsChange, onGridColsChange, onGridOpacityChange, onAoiShowNameChange, onAoiOpacityChange,
    onAoiBorderWidthChange,
  } = props;
  const normalizedFontSize = Math.max(12, Math.min(24, Math.round(gridFontSize)));
  const normalizedRows = Math.max(1, Math.min(20, Math.round(gridRows)));
  const normalizedCols = Math.max(1, Math.min(20, Math.round(gridCols)));

  return (
    <>
      <div className="mb-3 space-y-2">
        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-700"><FileText size={14} /> {isEn ? 'Stimulus filter' : '刺激材料筛选'}</h3>
        <div title={isGlassesMode ? recordingVideoName : stimuli.find((stimulus) => stimulus.id === selectedStimulusId)?.name}>
        {isGlassesMode ? (
          <div className="w-full min-h-7 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700" data-i18n-skip="true">
            <span className="block text-[11px] text-slate-500">{isEn ? 'Full recording video' : '整段录制视频'}</span>
            <span className="block truncate" title={recordingVideoName}>{recordingVideoName || (isEn ? 'No recording selected' : '未选择记录')}</span>
          </div>
        ) : (
          <CustomSelect aria-label={isEn ? 'Stimulus filter' : '刺激材料筛选'} value={selectedStimulusId || ''} onChange={(event) => onSelectedStimulusIdChange(event.target.value || null)} className="w-full min-h-7 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 outline-none">
            <option value="">{isEn ? 'Select stimulus' : '请选择刺激材料'}</option>
            {stimuli.map((stimulus) => <option key={stimulus.id} value={stimulus.id} data-i18n-skip="true">{stimulus.name}</option>)}
          </CustomSelect>
        )}
        </div>
        {isGlassesMode && <div className="mt-1 text-[11px] leading-relaxed text-slate-500">{isEn ? 'Glasses AOI and statistics use the full recording video; stimulus filters do not affect calculations.' : '眼镜式 AOI/统计均基于整段记录视频，刺激物筛选不参与计算。'}</div>}
      </div>

      <div className="mb-3 border-t border-slate-200 pt-3">
        <h3 className="mb-2 text-xs font-semibold text-slate-700">{isEn ? 'Timeline display' : '时间轴显示'}</h3>
        <div className="space-y-1">
          <div className="flex min-h-7 items-center justify-between gap-2 text-xs"><label className="text-slate-600">{isEn ? 'Show markers' : '显示标记'}</label><SmallToggle label={isEn ? 'Show markers' : '显示标记'} checked={showMarkTrack} onClick={() => onShowMarkTrackChange((value) => !value)} /></div>
          <div className="flex min-h-7 items-center justify-between gap-2 text-xs"><label className="text-slate-600">{isEn ? 'Show triggers' : '显示触发'}</label><SmallToggle label={isEn ? 'Show triggers' : '显示触发'} checked={showTriggerTrack} onClick={() => onShowTriggerTrackChange((value) => !value)} /></div>
        </div>
      </div>

      <div className="mb-3 space-y-3 border-t border-slate-200 pt-3">
        <h3 className="text-xs font-semibold text-slate-700">{isEn ? 'Font settings' : '字体设置'}</h3>
        <div className="flex min-h-7 items-center justify-between gap-2 text-xs">
          <label className="text-slate-600">{isEn ? 'AOI name size' : 'AOI名称字体'}</label>
          <CustomSelect aria-label={isEn ? 'AOI name size' : 'AOI名称字体'} fullWidth={false} value={aoiFontSize} onChange={(event) => onAoiFontSizeChange(Number(event.target.value))} className="min-h-7 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-mono tabular-nums text-slate-700 outline-none">
            {[10, 12, 14, 16].map((value) => <option key={value} value={value}>{value} px</option>)}
          </CustomSelect>
        </div>
        <Slider label={isEn ? 'Grid font size' : 'Grid 字体大小'} rangeLabel="12–24 px" min={12} max={24} value={normalizedFontSize} displayValue={`${normalizedFontSize} px`} onChange={onGridFontSizeChange} />
      </div>

      <div className="mb-3 border-t border-slate-200 pt-3">
        <div className="mb-2 flex min-h-7 items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-xs font-semibold text-slate-700"><Maximize size={14} /> {isEn ? 'Grid AOI' : '网格 AOI'}</h3>
          <SmallToggle label={isEn ? 'Grid AOI' : '网格 AOI'} checked={gridEnabled} onClick={() => onGridEnabledChange((value) => !value)} />
        </div>
        {gridEnabled ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-xs text-slate-600"><span>{isEn ? 'Metric' : '指标选择'}</span><span role="status" title={gridError || undefined} className={gridError ? 'text-[11px] text-rose-600' : 'text-[11px] text-slate-500'}>{gridLoading ? (isEn ? 'Loading…' : '加载中…') : gridError ? (isEn ? 'Error' : '异常') : ''}</span></div>
              <CustomSelect aria-label={isEn ? 'Metric' : '指标选择'} value={gridMetric} onChange={(event) => onGridMetricChange(event.target.value as GridMetric)} className="w-full min-h-7 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 outline-none">
                {gridMetricOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </CustomSelect>
            </div>
            <div className="flex min-h-7 items-center justify-between gap-2 text-xs"><label className="text-slate-600">{isEn ? 'Show values' : '显示数据'}</label><SmallToggle label={isEn ? 'Show values' : '显示数据'} checked={gridShowValues} onClick={() => onGridShowValuesChange((value) => !value)} /></div>
            <div className="flex min-h-7 items-center justify-between gap-2 text-xs"><label className="text-slate-600">{isEn ? 'Show scale' : '显示标尺'}</label><SmallToggle label={isEn ? 'Show scale' : '显示标尺'} checked={gridShowScale} onClick={() => onGridShowScaleChange((value) => !value)} /></div>
            <Slider label={isEn ? 'Grid rows' : '栅格行数'} rangeLabel="1–20" min={1} max={20} value={normalizedRows} displayValue={normalizedRows} onChange={onGridRowsChange} />
            <Slider label={isEn ? 'Grid columns' : '栅格列数'} rangeLabel="1–20" min={1} max={20} value={normalizedCols} displayValue={normalizedCols} onChange={onGridColsChange} />
            <div className="flex flex-wrap gap-1.5">
              {[3, 4, 5, 8, 10].map((size) => <button key={size} type="button" title={isEn ? `Set grid to ${size} × ${size}` : `设为 ${size} × ${size} 网格`} className="min-h-7 rounded-md border border-slate-200 px-1.5 py-1 text-xs font-mono font-medium tabular-nums text-slate-600 hover:bg-slate-50" onClick={() => { onGridRowsChange(size); onGridColsChange(size); }}>{size}×{size}</button>)}
            </div>
            <Slider label={isEn ? 'Overlay opacity' : '蒙版透明度'} rangeLabel="0–100%" min={0} max={100} value={Math.round(gridOpacity * 100)} displayValue={`${Math.round(gridOpacity * 100)}%`} onChange={(value) => onGridOpacityChange(value / 100)} />
          </div>
        ) : (
          <>
            <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold text-slate-700"><Maximize size={14} /> {isEn ? 'AOI settings' : 'AOI设置'}</h3>
            <div className="space-y-3">
              <div className="flex min-h-7 items-center justify-between gap-2 text-xs"><label className="text-slate-600">{isEn ? 'Show AOI names' : '显示AOI名称'}</label><SmallToggle label={isEn ? 'Show AOI names' : '显示AOI名称'} checked={aoiShowName} onClick={() => onAoiShowNameChange((value) => !value)} /></div>
              <Slider label={isEn ? 'Opacity' : '透明度'} rangeLabel="5–100%" min={5} max={100} value={Math.round(aoiOpacity * 100)} displayValue={`${Math.round(aoiOpacity * 100)}%`} onChange={(value) => onAoiOpacityChange(value / 100)} />
              <Slider label={isEn ? 'Border width' : '边框粗细'} rangeLabel="1–10 px" min={1} max={10} value={aoiBorderWidth} displayValue={`${aoiBorderWidth} px`} onChange={onAoiBorderWidthChange} />
            </div>
          </>
        )}
      </div>
    </>
  );
}
