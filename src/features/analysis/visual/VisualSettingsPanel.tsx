import Switch from '@/shared/ui/Switch';
import type React from 'react';
import { RotateCcw, Settings } from 'lucide-react';

import CustomSelect from '@/shared/ui/CustomSelect';
import { btnSecondary } from '@/shared/ui/buttonClasses';
import type { ExtendedStimulus } from '@/shared/types/mrt';
import type { MountainChartSettings } from '@/features/analysis/visual/mountainChartContract';

type VisualSubTab = 'heatmap' | 'gaze' | 'honeycomb' | 'mountain';
type HeatmapSettings = { radius: number; opacity: number; intensity: number };
type GazeSettings = { maxRadius: number; borderWidth: number; opacity: number; showLines: boolean; showBorder: boolean };
type HoneycombSettings = { cursorStyle: 'solid' | 'hollow' | 'cross'; radius: number; borderWidth: number; opacity: number };

type VisualSettingsPanelProps = {
  stimuli: ExtendedStimulus[];
  selectedStimulusId: string | null;
  isGlassesMode: boolean;
  recordingVideoName?: string;
  isMappingMode?: boolean;
  visualSubTab: VisualSubTab;
  showMarkTrack: boolean;
  showTriggerTrack: boolean;
  gazeSettings: GazeSettings;
  honeycombSettings: HoneycombSettings;
  mountainSettings: MountainChartSettings;
  heatmapSettings: HeatmapSettings;
  heatmapPerspectiveEnabled: boolean;
  isEn: boolean;
  onSelectedStimulusIdChange: (id: string | null) => void;
  onShowMarkTrackChange: React.Dispatch<React.SetStateAction<boolean>>;
  onShowTriggerTrackChange: React.Dispatch<React.SetStateAction<boolean>>;
  onGazeSettingsChange: React.Dispatch<React.SetStateAction<GazeSettings>>;
  onHoneycombSettingsChange: React.Dispatch<React.SetStateAction<HoneycombSettings>>;
  onMountainSettingsChange: React.Dispatch<React.SetStateAction<MountainChartSettings>>;
  onHeatmapSettingsChange: React.Dispatch<React.SetStateAction<HeatmapSettings>>;
  onHeatmapPerspectiveEnabledChange: React.Dispatch<React.SetStateAction<boolean>>;
  onResetMountainCamera: () => void;
};

function Toggle({ checked, onClick, label, compact = false }: { checked: boolean; onClick: () => void; label: string; compact?: boolean }) {
  return <Switch checked={checked} onClick={onClick} aria-label={label} title={label} size={compact ? "compact" : "normal"} />;
}

function RangeControl({ label, rangeLabel, valueLabel, min, max, step, value, onChange }: {
  label: string;
  rangeLabel: string;
  valueLabel: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1" title={`${label} · ${rangeLabel}`}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 text-xs text-slate-600"><span>{label}</span><span className="min-w-[7ch] text-right font-mono font-medium tabular-nums text-slate-800">{valueLabel}</span></div>
      <input type="range" aria-label={label} aria-valuetext={valueLabel} min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="mrt-slider cursor-pointer" />
    </div>
  );
}

export function VisualSettingsPanel(props: VisualSettingsPanelProps) {
  const {
    stimuli, selectedStimulusId, isGlassesMode, recordingVideoName, isMappingMode = false, visualSubTab, showMarkTrack, showTriggerTrack,
    gazeSettings, honeycombSettings, mountainSettings, heatmapSettings, heatmapPerspectiveEnabled, isEn,
    onSelectedStimulusIdChange, onShowMarkTrackChange, onShowTriggerTrackChange, onGazeSettingsChange,
    onHoneycombSettingsChange, onMountainSettingsChange, onHeatmapSettingsChange,
    onHeatmapPerspectiveEnabledChange, onResetMountainCamera,
  } = props;

  return (
    <div className="shrink-0 border-b border-slate-200 bg-slate-50/60 p-3">
      <div className="mb-3 space-y-2">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-slate-700"><Settings size={14} /> {isEn ? 'Stimulus filter' : '刺激材料筛选'}</h3>
        <div title={isGlassesMode && !isMappingMode ? recordingVideoName : stimuli.find((stimulus) => stimulus.id === selectedStimulusId)?.name}>
        {isGlassesMode && !isMappingMode ? (
          <CustomSelect aria-label={isEn ? 'Stimulus filter' : '刺激材料筛选'} value="" onChange={() => onSelectedStimulusIdChange(null)} dataI18nSkip className="w-full cursor-pointer appearance-none rounded-lg border border-slate-200 bg-white py-1.5 pl-2 pr-1 text-xs outline-none focus:ring-2 focus:ring-sky-500/10">
            <option value="">{isEn ? 'Full recording video' : '整段录制视频'}{recordingVideoName ? ` · ${recordingVideoName}` : ''}</option>
          </CustomSelect>
        ) : (
          <CustomSelect aria-label={isEn ? 'Stimulus filter' : '刺激材料筛选'} value={selectedStimulusId || ''} onChange={(event) => onSelectedStimulusIdChange(event.target.value || null)} disabled={isGlassesMode} className="w-full cursor-pointer appearance-none rounded-lg border border-slate-200 bg-white py-1.5 pl-2 pr-1 text-xs outline-none focus:ring-2 focus:ring-sky-500/10">
            <option value="">{isEn ? 'Show all stimuli' : '显示所有刺激材料'}</option>
            {stimuli.map((stimulus) => <option key={stimulus.id} value={stimulus.id} data-i18n-skip="true">{stimulus.name}</option>)}
          </CustomSelect>
        )}
        </div>
        {isGlassesMode && <div className="mt-1 text-[11px] leading-relaxed text-slate-500">{isEn ? 'Glasses analysis uses the full recording video; stimulus filters do not affect calculations.' : '眼镜式按整段视频分析，刺激物筛选不参与数据计算。'}</div>}
      </div>

      <div className="mb-3 space-y-2 border-t border-slate-200 pt-3">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-slate-700"><Settings size={14} /> {isEn ? 'Timeline display' : '时间轴显示'}</h3>
        <div className="space-y-1">
          <div className="flex min-h-7 items-center justify-between gap-2 text-xs"><label className="text-slate-600">{isEn ? 'Show markers' : '显示标记'}</label><Toggle compact checked={showMarkTrack} label={isEn ? 'Show markers' : '显示标记'} onClick={() => onShowMarkTrackChange((value) => !value)} /></div>
          <div className="flex min-h-7 items-center justify-between gap-2 text-xs"><label className="text-slate-600">{isEn ? 'Show triggers' : '显示触发'}</label><Toggle compact checked={showTriggerTrack} label={isEn ? 'Show triggers' : '显示触发'} onClick={() => onShowTriggerTrackChange((value) => !value)} /></div>
        </div>
      </div>

      <h3 className="mb-3 flex items-center gap-2 border-t border-slate-200 pt-3 text-xs font-semibold text-slate-700"><Settings size={14} /> {visualSubTab === 'gaze' ? (isEn ? 'Gaze plot settings' : '注视轨迹设置') : visualSubTab === 'honeycomb' ? (isEn ? 'Honeycomb settings' : '蜂窝图设置') : visualSubTab === 'mountain' ? (isEn ? 'Mountain settings' : '山峰图设置') : (isEn ? 'Heatmap settings' : '热图设置')}</h3>

      {visualSubTab === 'gaze' ? (
        <div className="space-y-3">
          <RangeControl label={isEn ? 'Maximum radius' : '最大半径'} rangeLabel="10–200 px" valueLabel={`${Math.round(gazeSettings.maxRadius)} px`} min={10} max={200} value={gazeSettings.maxRadius} onChange={(maxRadius) => onGazeSettingsChange((value) => ({ ...value, maxRadius }))} />
          <RangeControl label={isEn ? 'Border width' : '边框宽度'} rangeLabel="1–10 px" valueLabel={`${Math.round(gazeSettings.borderWidth)} px`} min={1} max={10} value={gazeSettings.borderWidth} onChange={(borderWidth) => onGazeSettingsChange((value) => ({ ...value, borderWidth }))} />
          <RangeControl label={isEn ? 'Opacity' : '透明度'} rangeLabel="0–100%" valueLabel={`${Math.round(gazeSettings.opacity * 100)}%`} min={0} max={100} value={gazeSettings.opacity * 100} onChange={(opacity) => onGazeSettingsChange((value) => ({ ...value, opacity: opacity / 100 }))} />
          <div className="flex min-h-7 items-center justify-between gap-2 text-xs"><label className="text-slate-600">{isEn ? 'Show lines' : '显示连线'}</label><Toggle checked={gazeSettings.showLines} label={isEn ? 'Show lines' : '显示连线'} onClick={() => onGazeSettingsChange((value) => ({ ...value, showLines: !value.showLines }))} /></div>
          <div className="flex min-h-7 items-center justify-between gap-2 text-xs"><label className="text-slate-600">{isEn ? 'Show border' : '显示边框'}</label><Toggle checked={gazeSettings.showBorder} label={isEn ? 'Show border' : '显示边框'} onClick={() => onGazeSettingsChange((value) => ({ ...value, showBorder: !value.showBorder }))} /></div>
        </div>
      ) : visualSubTab === 'honeycomb' ? (
        <div className="space-y-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-600">{isEn ? 'Cursor style' : '光标样式'}</label>
            <CustomSelect aria-label={isEn ? 'Cursor style' : '光标样式'} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-sky-500/10" value={honeycombSettings.cursorStyle} onChange={(event) => onHoneycombSettingsChange((value) => ({ ...value, cursorStyle: event.target.value as HoneycombSettings['cursorStyle'] }))}>
              <option value="solid">{isEn ? 'Solid circle' : '实心圆'}</option><option value="hollow">{isEn ? 'Hollow circle' : '空心圆'}</option><option value="cross">{isEn ? 'Cross' : '十字'}</option>
            </CustomSelect>
          </div>
          <RangeControl label={isEn ? 'Cursor radius' : '光标半径'} rangeLabel="5–120 px" valueLabel={`${Math.round(honeycombSettings.radius)} px`} min={5} max={120} value={honeycombSettings.radius} onChange={(radius) => onHoneycombSettingsChange((value) => ({ ...value, radius }))} />
          <RangeControl label={isEn ? 'Border width' : '边框宽度'} rangeLabel="1–10 px" valueLabel={`${Math.round(honeycombSettings.borderWidth)} px`} min={1} max={10} value={honeycombSettings.borderWidth} onChange={(borderWidth) => onHoneycombSettingsChange((value) => ({ ...value, borderWidth }))} />
          <RangeControl label={isEn ? 'Opacity' : '透明度'} rangeLabel="0–100%" valueLabel={`${Math.round(honeycombSettings.opacity * 100)}%`} min={0} max={100} value={honeycombSettings.opacity * 100} onChange={(opacity) => onHoneycombSettingsChange((value) => ({ ...value, opacity: opacity / 100 }))} />
        </div>
      ) : visualSubTab === 'mountain' ? (
        <div className="space-y-3">
          <div className="flex min-h-7 items-center justify-between gap-2 text-xs"><label className="text-slate-600">{isEn ? 'Show video' : '显示视频背景'}</label><Toggle checked={mountainSettings.showVideo} label={isEn ? 'Show video' : '显示视频背景'} onClick={() => onMountainSettingsChange((value) => ({ ...value, showVideo: !value.showVideo }))} /></div>
          <div className="flex min-h-7 items-center justify-between gap-2 text-xs"><label className="text-slate-600">{isEn ? 'Show grid' : '显示网格'}</label><Toggle checked={mountainSettings.showGrid} label={isEn ? 'Show grid' : '显示网格'} onClick={() => onMountainSettingsChange((value) => ({ ...value, showGrid: !value.showGrid }))} /></div>
          <div className="flex min-h-7 items-center justify-between gap-2 text-xs"><label className="text-slate-600">{isEn ? 'Wireframe' : '线框模式'}</label><Toggle checked={mountainSettings.wireframe} label={isEn ? 'Wireframe' : '线框模式'} onClick={() => onMountainSettingsChange((value) => ({ ...value, wireframe: !value.wireframe }))} /></div>
          <RangeControl label={isEn ? 'Peak height' : '山峰高度'} rangeLabel="0.1–3.0" valueLabel={mountainSettings.heightScale.toFixed(1)} min={10} max={300} value={Math.round(mountainSettings.heightScale * 100)} onChange={(heightScale) => onMountainSettingsChange((value) => ({ ...value, heightScale: heightScale / 100 }))} />
          <RangeControl label={isEn ? 'Opacity' : '透明度'} rangeLabel="0–100%" valueLabel={`${Math.round(mountainSettings.opacity * 100)}%`} min={0} max={100} value={Math.round(mountainSettings.opacity * 100)} onChange={(opacity) => onMountainSettingsChange((value) => ({ ...value, opacity: opacity / 100 }))} />
          <RangeControl label={isEn ? 'Grid resolution' : '网格分辨率'} rangeLabel="32–256" valueLabel={String(mountainSettings.gridResolution)} min={32} max={256} step={16} value={mountainSettings.gridResolution} onChange={(gridResolution) => onMountainSettingsChange((value) => ({ ...value, gridResolution }))} />
          <RangeControl label={isEn ? 'Peak smoothing' : '峰值平滑'} rangeLabel="0–1" valueLabel={mountainSettings.peakSmoothing.toFixed(1)} min={0} max={100} value={Math.round(mountainSettings.peakSmoothing * 100)} onChange={(peakSmoothing) => onMountainSettingsChange((value) => ({ ...value, peakSmoothing: peakSmoothing / 100 }))} />
          <button type="button" onClick={onResetMountainCamera} className={`${btnSecondary} w-full`}><RotateCcw size={12} />{isEn ? 'Reset view' : '重置视角'}</button>
        </div>
      ) : (
        <div className="space-y-3">
          <RangeControl label={isEn ? 'Heatmap radius' : '热图半径'} rangeLabel="10–200 px" valueLabel={`${heatmapSettings.radius} px`} min={10} max={200} value={heatmapSettings.radius} onChange={(radius) => onHeatmapSettingsChange((value) => ({ ...value, radius }))} />
          <RangeControl label={isEn ? 'Opacity' : '透明度'} rangeLabel="0–100%" valueLabel={`${Math.round(heatmapSettings.opacity * 100)}%`} min={0} max={100} value={heatmapSettings.opacity * 100} onChange={(opacity) => onHeatmapSettingsChange((value) => ({ ...value, opacity: opacity / 100 }))} />
          <RangeControl label={isEn ? 'Intensity' : '强度'} rangeLabel="1–100" valueLabel={String(Math.round(heatmapSettings.intensity * 100))} min={1} max={100} value={heatmapSettings.intensity * 100} onChange={(intensity) => onHeatmapSettingsChange((value) => ({ ...value, intensity: intensity / 100 }))} />
          <div className="border-t border-slate-200 pt-2"><div className="flex min-h-7 items-center justify-between gap-2 text-xs text-slate-600"><span>{isEn ? 'Perspective' : '透视图'}</span><Toggle checked={heatmapPerspectiveEnabled} label={isEn ? 'Perspective' : '透视图'} onClick={() => onHeatmapPerspectiveEnabledChange((value) => !value)} /></div></div>
        </div>
      )}
    </div>
  );
}
