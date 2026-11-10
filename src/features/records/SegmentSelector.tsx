import React from 'react';
import { Download, Pencil, Trash2 } from 'lucide-react';
import type { TimeSegment } from '@shared/domain/timeline';

interface SegmentSelectorProps {
  segments: TimeSegment[];
  selectedSegmentId: string | null;
  onSelect: (segmentId: string | null) => void;
  onRename: (segmentId: string) => void;
  onDelete: (segmentId: string) => void;
  onColorChange?: (segmentId: string, color: string) => void;
  onExport?: (segmentId: string) => void;
}

const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00.000';
  const mm = Math.floor(seconds / 60);
  const ss = seconds - mm * 60;
  const ssInt = Math.floor(ss);
  const ms = Math.floor((ss - ssInt) * 1000);
  return `${String(mm).padStart(2, '0')}:${String(ssInt).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
};

export const SegmentSelector: React.FC<SegmentSelectorProps> = ({
  segments,
  selectedSegmentId,
  onSelect,
  onRename,
  onDelete,
  onColorChange,
  onExport,
}) => {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3 mt-2">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] font-semibold text-slate-700">时间分段</div>
        <button
          className="text-[10px] px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-600"
          onClick={() => onSelect(null)}
        >
          显示全部
        </button>
      </div>

      {segments.length === 0 ? (
        <div className="text-[10px] text-slate-400">暂无分段，可在时间轴中点击“创建分段”。</div>
      ) : (
        <div className="space-y-1 max-h-36 overflow-y-auto">
          {segments.map((segment) => {
            const selected = segment.id === selectedSegmentId;
            return (
              <div
                key={segment.id}
                className={`flex items-center gap-2 px-2 py-1 rounded border text-[10px] ${
                  selected
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                    : 'bg-white border-slate-200 text-slate-700'
                }`}
              >
                <button
                  className="w-2 h-2 rounded-full"
                  data-visual-control="segment-color"
                  style={{ backgroundColor: segment.color }}
                  onClick={() => onSelect(segment.id)}
                  title="选择分段"
                />

                <button className="mrt-button-text truncate text-left" onClick={() => onSelect(segment.id)} title="选择分段">
                  <span data-i18n-skip="true">{segment.name}</span>
                </button>

                <span className="ml-auto font-mono text-slate-500">
                  {formatTime(segment.startTime)} - {formatTime(segment.endTime)}
                </span>

                {onColorChange && (
                  <input
                    type="color"
                    value={segment.color}
                    onChange={(e) => onColorChange(segment.id, e.target.value)}
                    className="w-4 h-4 border-0 p-0 bg-transparent cursor-pointer"
                    title="修改颜色"
                  />
                )}

                {onExport && (
                  <button className="text-slate-500 hover:text-sky-600" onClick={() => onExport(segment.id)} title="导出分段数据">
                    <Download size={11} />
                  </button>
                )}

                <button className="text-slate-500 hover:text-sky-600" onClick={() => onRename(segment.id)} title="重命名">
                  <Pencil size={11} />
                </button>
                <button className="text-slate-500 hover:text-red-600" onClick={() => onDelete(segment.id)} title="删除">
                  <Trash2 size={11} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
