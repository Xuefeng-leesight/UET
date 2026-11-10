import { MousePointer2, Pencil } from 'lucide-react'

type AoiTool = 'ellipse' | 'rect' | 'polygon' | null

type AoiCanvasToolbarProps = {
  activeTool: AoiTool
  drawing: boolean
  gridEnabled: boolean
  canDraw: boolean
  hasShapes: boolean
  editMode: boolean
  unavailableMessage: string
  editHint: string
  onBeginDraw: (tool: Exclude<AoiTool, null>) => void
  onToggleEdit: () => void
  onToggleGrid: () => void
}

const DRAW_TOOLS: Array<{ tool: Exclude<AoiTool, null>; label: string; activeClass: string }> = [
  { tool: 'rect', label: '矩形', activeClass: 'bg-sky-100 text-sky-600 border border-sky-200' },
  { tool: 'ellipse', label: '椭圆', activeClass: 'bg-emerald-100 text-emerald-600 border border-emerald-200' },
  { tool: 'polygon', label: '多边形', activeClass: 'bg-amber-100 text-amber-600 border border-amber-200' },
]

export function AoiCanvasToolbar({
  activeTool,
  drawing,
  gridEnabled,
  canDraw,
  hasShapes,
  editMode,
  unavailableMessage,
  editHint,
  onBeginDraw,
  onToggleEdit,
  onToggleGrid,
}: AoiCanvasToolbarProps) {
  return (
    <div className="h-10 bg-slate-50 flex items-center px-4 gap-4 text-[10px] text-slate-600 font-bold">
      <div className="flex-1" />
      <div className="flex items-center gap-2">
        {!gridEnabled && (
          <>
            <span className="text-slate-500 flex items-center gap-1">
              <MousePointer2 size={12} /> 绘制
            </span>
            {DRAW_TOOLS.map(({ tool, label, activeClass }) => (
              <button
                key={tool}
                aria-pressed={activeTool === tool && drawing}
                onClick={() => onBeginDraw(tool)}
                disabled={!canDraw}
                className={`px-2 py-1 rounded ${
                  activeTool === tool && drawing
                    ? activeClass
                    : canDraw
                      ? 'hover:bg-slate-100'
                      : 'text-slate-300 cursor-not-allowed'
                }`}
              >
                {label}
              </button>
            ))}
            <button
              onClick={onToggleEdit}
              disabled={!canDraw || drawing || !hasShapes}
              className={`px-2 py-1 rounded border flex items-center gap-1 ${
                editMode
                  ? 'bg-indigo-100 text-indigo-700 border-indigo-200'
                  : 'hover:bg-slate-100 border-transparent'
              } ${!canDraw || drawing || !hasShapes ? 'opacity-45 cursor-not-allowed' : ''}`}
            >
              <Pencil size={12} />
              {editMode ? '完成编辑' : '编辑'}
            </button>
            {!canDraw && <span className="text-slate-400">{unavailableMessage}</span>}
            {editMode && <span className="text-indigo-600">{editHint}</span>}
          </>
        )}
        <button
          onClick={onToggleGrid}
          className={`px-2 py-1 rounded ${gridEnabled ? 'bg-violet-100 text-violet-700 border border-violet-200' : 'hover:bg-slate-100'}`}
        >
          网格 AOI
        </button>
      </div>
    </div>
  )
}
