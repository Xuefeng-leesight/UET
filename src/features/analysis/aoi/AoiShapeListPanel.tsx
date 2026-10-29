import React from 'react';
import { ChevronDown, Eye, EyeOff, Pipette, X } from 'lucide-react';
import { normalizeAoiAnalysisTimeRanges } from '@/features/analysis/aoi/aoiAnalysisModel';
import type { AoiShape } from '@shared/domain/aoi/aoiTypes';

type AoiShapeListPanelProps = {
  isEnglish: boolean;
  shapes: AoiShape[];
  selectedId: string | null;
  drawing: boolean;
  colorDefinitions: Record<string, { border: string }>;
  expandedRangeIds: Set<string>;
  formatTime: (seconds: number) => string;
  onSelect: (id: string | null) => void;
  onRename: (id: string, name: string) => void;
  onShapesChange: React.Dispatch<React.SetStateAction<AoiShape[]>>;
  onExpandedRangeIdsChange: React.Dispatch<React.SetStateAction<Set<string>>>;
  onRangeEnabledChange: (shapeId: string, rangeId: string, enabled: boolean) => void;
  onRemoveRange: (shapeId: string, rangeId: string) => void;
};

function resolveBorderColor(
  colorDefinitions: AoiShapeListPanelProps['colorDefinitions'],
  color: string | undefined,
) {
  return /^#[0-9a-f]{6}$/iu.test(String(color || ''))
    ? String(color)
    : colorDefinitions[color || '']?.border || '#38bdf8';
}

const PRESET_COLORS = [
  { id: 'sky', label: '蓝', labelEn: 'Blue' },
  { id: 'emerald', label: '绿', labelEn: 'Green' },
  { id: 'amber', label: '黄', labelEn: 'Yellow' },
  { id: 'violet', label: '紫', labelEn: 'Purple' },
];

export function AoiShapeListPanel({
  isEnglish,
  shapes,
  selectedId,
  drawing,
  colorDefinitions,
  expandedRangeIds,
  formatTime,
  onSelect,
  onRename,
  onShapesChange,
  onExpandedRangeIdsChange,
  onRangeEnabledChange,
  onRemoveRange,
}: AoiShapeListPanelProps) {
  // The AOI whose colour palette is open; closes on an outside press or Escape.
  const [paletteFor, setPaletteFor] = React.useState<string | null>(null);
  const paletteRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!paletteFor) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !paletteRef.current?.contains(event.target as Node)) {
        setPaletteFor(null);
      }
    };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', close);
    };
  }, [paletteFor]);

  const setShapeColor = (shapeId: string, color: string) => onShapesChange((current) => current.map((item) => (
    item.id === shapeId ? { ...item, color } : item
  )));

  return (
    <>
      <h3 className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold text-slate-700">
        <span>AOIs</span><span className="min-w-[3ch] text-right font-mono font-normal tabular-nums text-slate-500">{shapes.length}</span>
      </h3>
      <div className="space-y-2">
        {shapes.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 px-3 py-3 text-[11px] leading-relaxed text-slate-500">
            {isEnglish ? 'No AOI. Click draw above to create one.' : '暂无AOI，点击上方绘制按钮进行创建'}
          </div>
        ) : (
          shapes.map((shape) => {
            const ranges = normalizeAoiAnalysisTimeRanges(shape.analysisTimeRanges, shape.analysisTimeRange);
            const isExpanded = expandedRangeIds.has(shape.id);
            const borderColor = resolveBorderColor(colorDefinitions, shape.color);
            return (
              <div
                key={shape.id}
                // A floating card: soft shadow at rest, lifted on hover; the selected AOI
                // stays lifted instead of drawing a ring.
                className={`grid grid-cols-[28px_minmax(0,1fr)_28px_28px] items-center gap-1 py-1 pl-1.5 pr-1 bg-white rounded-lg transition-shadow cursor-pointer hover:shadow-[0_4px_14px_rgba(23,32,51,0.12)] ${
                  selectedId === shape.id ? 'shadow-[0_4px_14px_rgba(23,32,51,0.12)]' : 'shadow-[0_1px_2px_rgba(23,32,51,0.05),0_2px_6px_rgba(23,32,51,0.07)]'
                }`}
                onClick={() => {
                  if (!drawing) onSelect(shape.id);
                }}
              >
                <div className="relative" ref={paletteFor === shape.id ? paletteRef : undefined}>
                  <button
                    type="button"
                    data-visual-control
                    aria-haspopup="true"
                    aria-expanded={paletteFor === shape.id}
                    aria-label={isEnglish ? `Color for ${shape.name}` : `${shape.name} 的颜色`}
                    title={isEnglish ? 'Set AOI color' : '设置 AOI 颜色'}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(shape.id);
                      setPaletteFor((current) => current === shape.id ? null : shape.id);
                    }}
                    className="flex h-7 w-7 items-center justify-center rounded-md bg-transparent transition-colors hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-sky-400"
                  >
                    <span className="block h-3.5 w-3.5 rounded-full border border-black/10" style={{ backgroundColor: borderColor }} />
                  </button>
                  {paletteFor === shape.id && (
                    <div
                      className="mrt-action-menu absolute left-0 top-full z-[130] mt-1 flex items-center gap-1 p-1.5 shadow-lg"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {PRESET_COLORS.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          data-visual-control
                          aria-label={isEnglish ? preset.labelEn : preset.label}
                          aria-pressed={shape.color === preset.id}
                          title={isEnglish ? preset.labelEn : preset.label}
                          onClick={() => {
                            setShapeColor(shape.id, preset.id);
                            setPaletteFor(null);
                          }}
                          className={`flex h-7 w-7 items-center justify-center rounded-md bg-transparent hover:bg-slate-100 ${shape.color === preset.id ? 'ring-2 ring-sky-400' : ''}`}
                        >
                          <span className="block h-4 w-4 rounded-full border border-black/10" style={{ backgroundColor: colorDefinitions[preset.id]?.border }} />
                        </button>
                      ))}
                      <label
                        title={isEnglish ? 'Custom color' : '自定义颜色'}
                        className={`relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 focus-within:ring-2 focus-within:ring-sky-400 ${colorDefinitions[shape.color] ? '' : 'ring-2 ring-sky-400'}`}
                      >
                        <Pipette size={14} />
                        <input
                          type="color"
                          value={borderColor}
                          aria-label={isEnglish ? `Custom color for ${shape.name}` : `${shape.name} 的自定义颜色`}
                          onChange={(event) => setShapeColor(shape.id, event.target.value)}
                          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                        />
                      </label>
                    </div>
                  )}
                </div>
                <input
                  value={shape.name}
                  title={shape.name}
                  aria-label={isEnglish ? 'AOI name' : 'AOI 名称'}
                  onChange={(event) => onRename(shape.id, event.target.value)}
                  className="mrt-input-plain min-w-0 w-full min-h-7 bg-white border border-transparent hover:border-slate-200 focus:border-slate-200 rounded-md px-1.5 py-1 text-xs outline-none text-slate-700"
                />
                <button
                  type="button"
                  aria-pressed={!!shape.showStats}
                  aria-label={isEnglish ? `${shape.showStats ? 'Hide' : 'Show'} statistics for ${shape.name}` : `${shape.showStats ? '隐藏' : '显示'} ${shape.name} 的统计`}
                  title={isEnglish ? (shape.showStats ? 'Hide AOI statistics' : 'Show AOI statistics') : (shape.showStats ? '隐藏 AOI 统计' : '显示 AOI 统计')}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(shape.id);
                    onShapesChange((current) => current.map((item) => {
                      if (item.id !== shape.id) return item;
                      const showStats = !item.showStats;
                      return { ...item, showStats, visible: showStats ? true : item.visible };
                    }));
                  }}
                  className={`mrt-button-text col-start-3 row-start-1 flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-slate-100 ${shape.showStats ? 'text-sky-600' : 'text-slate-500'}`}
                >
                  {shape.showStats ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
                <button
                  type="button"
                  aria-label={isEnglish ? `Delete ${shape.name}` : `删除 ${shape.name}`}
                  title={isEnglish ? 'Delete AOI' : '删除 AOI'}
                  onClick={(event) => {
                    event.stopPropagation();
                    onShapesChange((current) => current.filter((item) => item.id !== shape.id));
                    if (selectedId === shape.id) onSelect(null);
                  }}
                  className="mrt-button-text col-start-4 row-start-1 flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-rose-600"
                >
                  <X size={14} />
                </button>
                {ranges && ranges.length > 0 && (
                  <div className="col-span-4 min-w-0 border-t border-slate-200 pt-1 text-xs text-slate-600">
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      onClick={() => {
                        onSelect(shape.id);
                        onExpandedRangeIdsChange((current) => {
                          const next = new Set(current);
                          if (next.has(shape.id)) next.delete(shape.id);
                          else next.add(shape.id);
                          return next;
                        });
                      }}
                      className="flex min-h-7 w-full items-center gap-1 text-left font-medium hover:text-sky-600"
                    >
                      <ChevronDown size={14} className={`shrink-0 transition-transform ${isExpanded ? 'rotate-0' : '-rotate-90'}`} />
                      <span>{isEnglish ? 'AOI analysis ranges' : 'AOI 统计范围'}（<span className="font-mono tabular-nums">{ranges.length}</span>）</span>
                    </button>
                    {isExpanded && (
                      <div className="mt-1 space-y-1">
                        {ranges.map((range) => {
                          const enabled = range.enabled !== false;
                          const rangeId = range.id || '';
                          return (
                            <div
                              key={rangeId || `${range.startTimeMs}-${range.endTimeMs}`}
                              className={`flex flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-md px-1.5 py-1 ${
                                enabled ? 'bg-sky-50' : 'bg-slate-100 text-slate-500'
                              }`}
                            >
                              <span className="whitespace-nowrap font-mono tabular-nums text-[11px]">{formatTime(range.startTimeMs / 1000)} – {formatTime(range.endTimeMs / 1000)}</span>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  aria-pressed={enabled}
                                  title={isEnglish ? (enabled ? 'Deactivate this range' : 'Activate this range') : (enabled ? '停用此时间范围' : '激活此时间范围')}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    onSelect(shape.id);
                                    onRangeEnabledChange(shape.id, rangeId, !enabled);
                                  }}
                                  className={`min-h-7 rounded-md border px-1.5 py-1 text-[11px] font-medium transition-colors ${
                                    enabled ? 'border-sky-200 bg-sky-100 text-sky-600 hover:bg-sky-50' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                                  }`}
                                >
                                  {enabled ? (isEnglish ? 'Active' : '激活') : (isEnglish ? 'Inactive' : '未激活')}
                                </button>
                                <button
                                  type="button"
                                  aria-label={isEnglish ? 'Delete range' : '删除时间范围'}
                                  title={isEnglish ? 'Delete range' : '删除时间范围'}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    onSelect(shape.id);
                                    onRemoveRange(shape.id, rangeId);
                                  }}
                                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-rose-600"
                                >
                                  <X size={12} />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
