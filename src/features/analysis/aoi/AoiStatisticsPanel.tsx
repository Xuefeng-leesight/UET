import React from 'react';
import { FileText } from 'lucide-react';
import { Modal } from '@/shared/ui/Modal';
import type { GridMetric, GridMetricOption } from '@/features/analysis/aoi/aoiMetrics';

export type AoiSidebarStatsCard = {
  cardId: string;
  title: string;
  items: Array<{ l: string; v: string }>;
};

export function AoiStatisticsPanel(props: {
  isEnglish: boolean;
  cards: AoiSidebarStatsCard[];
  onOpenMetricPicker: () => void;
}) {
  const { isEnglish, cards, onOpenMetricPicker } = props;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold text-slate-500 flex items-center gap-2 tracking-widest">
          <FileText size={14} /> {isEnglish ? 'Statistics data' : '统计数据'}
        </h3>
        <button onClick={onOpenMetricPicker} className="mrt-button-text text-[10px] font-bold text-slate-500 hover:text-slate-700">
          {isEnglish ? 'Select metric' : '选择指标'}
        </button>
      </div>
      {cards.length > 0 ? (
        <div className="space-y-2">
          {cards.map((card) => (
            <div key={`sidebar-stats-${card.cardId}`} className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
              <div className="text-[11px] font-bold text-slate-700">{card.title}</div>
              {card.items.length > 0 ? card.items.map((item) => (
                <div key={`${card.cardId}-${item.l}`} className="flex items-center justify-between text-[11px]">
                  <span className="text-slate-500">{item.l}</span>
                  <span className="text-slate-700 font-mono">{item.v}</span>
                </div>
              )) : (
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-slate-500">{isEnglish ? 'No metric selected' : '未选择指标'}</span>
                  <span className="text-slate-700 font-mono">-</span>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-slate-500">
          {isEnglish
            ? 'After clicking the eye icon on the right of AOI, you can view statistics for multiple AOIs at the same time.'
            : '点击 AOI 右侧小眼睛后，可同时查看多个 AOI 的统计数据'}
        </div>
      )}
    </div>
  );
}

export function AoiStatisticsMetricPicker(props: {
  isOpen: boolean;
  options: GridMetricOption[];
  selectedMetrics: Set<GridMetric> | null;
  onSelectedMetricsChange: React.Dispatch<React.SetStateAction<Set<GridMetric> | null>>;
  onClose: () => void;
}) {
  const { isOpen, options, selectedMetrics, onSelectedMetricsChange, onClose } = props;
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="选择指标" footer={null} maxWidthClassName="max-w-md">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <button onClick={() => onSelectedMetricsChange(null)} className="mrt-button-text text-[10px] font-bold text-slate-500 hover:text-slate-700">全部显示</button>
          <div className="ml-auto flex items-center gap-4">
            <button onClick={() => onSelectedMetricsChange(new Set(options.map((option) => option.id)))} className="mrt-button-text text-[10px] font-bold text-slate-500 hover:text-slate-700">全选</button>
            <button onClick={() => onSelectedMetricsChange(new Set())} className="mrt-button-text text-[10px] font-bold text-slate-500 hover:text-slate-700">清空</button>
          </div>
        </div>
        <div className="space-y-2">
          {options.map((item) => {
            const checked = selectedMetrics === null || selectedMetrics.has(item.id);
            return (
              <label key={item.id} className="flex items-center justify-between gap-4 p-2 rounded-lg border border-slate-200 bg-white">
                <div className="text-xs text-slate-700">{item.label}</div>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => {
                    const nextEnabled = event.target.checked;
                    onSelectedMetricsChange((previous) => {
                      const next = previous === null ? new Set(options.map((option) => option.id)) : new Set(previous);
                      if (nextEnabled) next.add(item.id);
                      else next.delete(item.id);
                      return next;
                    });
                  }}
                  className="w-4 h-4 rounded bg-white border-slate-300 text-sky-500 focus:ring-sky-500 accent-sky-500"
                />
              </label>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
