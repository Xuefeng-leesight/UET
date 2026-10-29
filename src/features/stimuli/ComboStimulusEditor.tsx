import React from 'react';
import { Globe, Image as ImageIcon, MonitorUp, Square, Trash2, Type, Upload, Video, Volume2 } from 'lucide-react';
import CustomSelect from '@/shared/ui/CustomSelect';
import AutoResizeTextarea from '@/shared/ui/AutoResizeTextarea';
import { Modal } from '@/shared/ui/Modal';
import { btnPrimary, btnSecondary } from '@/shared/ui/buttonClasses';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import type { ComboStimulusItem } from '@/shared/types/mrt';
import { getComboCanvasStyle, getComboMediaSrc } from '@/features/stimuli/ComboStimulusRenderer';
import { STIMULUS_AUDIO_ACCEPT, STIMULUS_IMAGE_ACCEPT, STIMULUS_VIDEO_ACCEPT } from '@/features/stimuli/domain/mediaTypes';

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

interface ComboStimulusEditorProps {
  isOpen: boolean;
  isEn: boolean;
  items: ComboStimulusItem[];
  setItems: React.Dispatch<React.SetStateAction<ComboStimulusItem[]>>;
  bgColor: string;
  canvasStyle: 'fullscreen' | 'landscape' | 'classic' | 'square' | 'portrait';
  setCanvasStyle: React.Dispatch<React.SetStateAction<'fullscreen' | 'landscape' | 'classic' | 'square' | 'portrait'>>;
  onClose: () => void;
  onUploadFiles?: (event: React.ChangeEvent<HTMLInputElement>) => void | Promise<void>;
  onStartScreenRecording?: (name: string) => Promise<{ ok: true; sessionId: string } | { ok: false; message?: string }>;
  onStopScreenRecording?: (sessionId: string) => Promise<{ ok: true; asset?: unknown } | { ok: false; message?: string }>;
}

type ComboAddKind = 'image' | 'video' | 'text' | 'web' | 'audio' | 'screen';

type DragState =
  | { mode: 'move'; id: string; startX: number; startY: number; item: ComboStimulusItem }
  | { mode: 'resize'; id: string; startX: number; startY: number; item: ComboStimulusItem };

const ComboStimulusEditor: React.FC<ComboStimulusEditorProps> = ({
  isOpen,
  isEn,
  items,
  setItems,
  bgColor,
  canvasStyle,
  setCanvasStyle,
  onClose,
  onUploadFiles,
  onStartScreenRecording,
  onStopScreenRecording,
}) => {
  const canvasRef = React.useRef<HTMLDivElement | null>(null);
  const uploadInputRef = React.useRef<HTMLInputElement | null>(null);
  const screenSessionIdRef = React.useRef<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [draggingLayerId, setDraggingLayerId] = React.useState<string | null>(null);
  const [overLayerId, setOverLayerId] = React.useState<string | null>(null);
  const [uploadKind, setUploadKind] = React.useState<ComboAddKind>('image');
  const [isAddModalOpen, setIsAddModalOpen] = React.useState(false);
  const [comboAddName, setComboAddName] = React.useState('');
  const [comboAddText, setComboAddText] = React.useState('');
  const [webUrlInput, setWebUrlInput] = React.useState('');
  const [screenStatus, setScreenStatus] = React.useState('');
  const [isScreenRecording, setIsScreenRecording] = React.useState(false);
  const noFileText = isEn ? 'No file selected' : '未选择任何文件';
  const [selectedFileText, setSelectedFileText] = React.useState(noFileText);
  const dragStateRef = React.useRef<DragState | null>(null);

  React.useEffect(() => {
    if (!isOpen) return;
    if (selectedId && items.some((item) => item.id === selectedId)) return;
    setSelectedId(items[0]?.id || null);
  }, [isOpen, items, selectedId]);

  React.useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isAddModalOpen) {
        setIsAddModalOpen(false);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isAddModalOpen, isOpen, onClose]);

  React.useEffect(() => {
    if (!isOpen || !ipcClient.isAvailable()) return;
    void ipcClient.setWindowFullScreen({ fullscreen: true });
    return () => {
      void ipcClient.setWindowFullScreen({ fullscreen: false });
    };
  }, [isOpen]);

  React.useEffect(() => {
    if (isOpen || !screenSessionIdRef.current) return;
    const sessionId = screenSessionIdRef.current;
    screenSessionIdRef.current = null;
    setIsScreenRecording(false);
    void onStopScreenRecording?.(sessionId).catch(() => {});
  }, [isOpen, onStopScreenRecording]);

  const selectedItem = items.find((item) => item.id === selectedId) || null;

  const updateItem = (id: string, patch: Partial<ComboStimulusItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const resetAddModal = () => {
    setComboAddName('');
    setComboAddText('');
    setWebUrlInput('');
    setScreenStatus('');
    setSelectedFileText(noFileText);
  };

  const openAddModal = () => {
    resetAddModal();
    setUploadKind('image');
    setIsAddModalOpen(true);
  };

  const closeAddModal = () => {
    if (screenSessionIdRef.current && isScreenRecording) {
      void stopScreenRecording();
      return;
    }
    setIsAddModalOpen(false);
    resetAddModal();
  };

  const addTextItem = () => {
    const text = comboAddText.trim();
    if (!text) return;
    const id = `combo_text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const name = comboAddName.trim() || text.split(/\r?\n/)[0]?.slice(0, 20) || (isEn ? 'Text' : '文字');
    setItems((prev) => [
      ...prev,
      {
        id,
        name,
        type: 'text',
        text,
        widthPct: 42,
        heightPct: 16,
        centerXPct: 50,
        centerYPct: 50,
        fontSize: 48,
        fontColor: '#ffffff',
        bgColor: 'transparent',
      },
    ]);
    setSelectedId(id);
    closeAddModal();
  };

  const addWebItem = () => {
    const raw = webUrlInput.trim();
    if (!raw) return;
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const id = `combo_web_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const name = comboAddName.trim() || url.replace(/^https?:\/\//i, '').slice(0, 40) || 'Web';
    setItems((prev) => [
      ...prev,
      {
        id,
        name,
        type: 'web',
        url,
        widthPct: 70,
        heightPct: 58,
        centerXPct: 50,
        centerYPct: 50,
      },
    ]);
    setSelectedId(id);
    closeAddModal();
  };

  const startScreenRecording = async () => {
    if (!onStartScreenRecording || isScreenRecording) return;
    setScreenStatus(isEn ? 'Starting screen recording...' : '正在启动录屏...');
    const result = await onStartScreenRecording(comboAddName.trim());
    if (!result.ok) {
      setScreenStatus(result.message || (isEn ? 'Failed to start screen recording.' : '录屏启动失败。'));
      return;
    }
    screenSessionIdRef.current = result.sessionId;
    setIsScreenRecording(true);
    setScreenStatus(isEn ? 'Recording screen...' : '正在录制屏幕...');
  };

  const stopScreenRecording = async () => {
    const sessionId = screenSessionIdRef.current;
    if (!sessionId || !onStopScreenRecording) return;
    screenSessionIdRef.current = null;
    setScreenStatus(isEn ? 'Stopping and saving recording...' : '正在停止并保存录屏...');
    const result = await onStopScreenRecording(sessionId);
    setIsScreenRecording(false);
    if (!result.ok) {
      setScreenStatus(result.message || (isEn ? 'Failed to save screen recording.' : '录屏保存失败。'));
      return;
    }
    const asset = result.asset && typeof result.asset === 'object'
      ? result.asset as Record<string, unknown>
      : {};
    const id = String(asset.id || `combo_screen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    setItems((prev) => [
      ...prev,
      {
        id,
        name: String(asset.name || (isEn ? 'Screen recording' : '录屏')),
        type: 'video',
        url: String(asset.url || ''),
        fileName: String(asset.fileName || ''),
        widthPct: 70,
        heightPct: 58,
        centerXPct: 50,
        centerYPct: 50,
        loop: false,
      },
    ]);
    setSelectedId(id);
    setScreenStatus(isEn ? 'Screen recording added.' : '录屏已加入 Combo。');
    closeAddModal();
  };

  const chooseFileKind = (kind: ComboAddKind) => {
    setUploadKind(kind);
    window.setTimeout(() => uploadInputRef.current?.click(), 0);
  };

  const handleUploadChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) {
      setSelectedFileText(noFileText);
    } else if (files.length === 1) {
      setSelectedFileText(files[0]?.name || noFileText);
    } else {
      setSelectedFileText(isEn ? `${files.length} files selected` : `已选择 ${files.length} 个文件`);
    }
    void Promise.resolve(onUploadFiles?.(event)).finally(() => {
      event.target.value = '';
      closeAddModal();
    });
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    setItems((prev) => prev.filter((item) => item.id !== selectedId));
    setSelectedId(null);
  };

  const moveLayerBefore = (dragId: string, dropId: string) => {
    if (!dragId || !dropId || dragId === dropId) return;
    setItems((prev) => {
      const fromIndex = prev.findIndex((item) => item.id === dragId);
      const toIndex = prev.findIndex((item) => item.id === dropId);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      const insertIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
      next.splice(insertIndex, 0, moved);
      return next;
    });
  };

  const moveLayerToEnd = (dragId: string) => {
    if (!dragId) return;
    setItems((prev) => {
      const fromIndex = prev.findIndex((item) => item.id === dragId);
      if (fromIndex < 0 || fromIndex === prev.length - 1) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.push(moved);
      return next;
    });
  };

  const getCanvasRect = () => canvasRef.current?.getBoundingClientRect() || null;

  const beginDrag = (event: React.PointerEvent, item: ComboStimulusItem, mode: DragState['mode']) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(item.id);
    dragStateRef.current = { mode, id: item.id, startX: event.clientX, startY: event.clientY, item };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    const drag = dragStateRef.current;
    const rect = getCanvasRect();
    if (!drag || !rect) return;

    const dxPct = ((event.clientX - drag.startX) / rect.width) * 100;
    const dyPct = ((event.clientY - drag.startY) / rect.height) * 100;
    if (drag.mode === 'move') {
      updateItem(drag.id, {
        centerXPct: clamp(drag.item.centerXPct + dxPct, 0, 100),
        centerYPct: clamp(drag.item.centerYPct + dyPct, 0, 100),
      });
      return;
    }

    updateItem(drag.id, {
      widthPct: clamp(drag.item.widthPct + dxPct, 3, 100),
      heightPct: clamp(drag.item.heightPct + dyPct, 3, 100),
      centerXPct: clamp(drag.item.centerXPct + dxPct / 2, 0, 100),
      centerYPct: clamp(drag.item.centerYPct + dyPct / 2, 0, 100),
    });
  };

  const endDrag = (event: React.PointerEvent) => {
    if (!dragStateRef.current) return;
    dragStateRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
    }
  };

  if (!isOpen) return null;

  const label = {
    title: isEn ? 'Combo editor' : 'Combo 编辑器',
    upload: isEn ? 'Add stimulus' : '添加刺激物',
    image: isEn ? 'Image' : '图片',
    video: isEn ? 'Video' : '视频',
    addText: isEn ? 'Text' : '文字',
    web: isEn ? 'Web URL' : '网址',
    audio: isEn ? 'Audio' : '音频',
    screen: isEn ? 'Screen' : '录屏',
    done: isEn ? 'Done' : '完成',
    layers: isEn ? 'Layers' : '图层',
    style: isEn ? 'Style' : '风格',
    fullscreen: isEn ? 'Fullscreen' : '全屏',
    landscape: '16:9',
    classic: '4:3',
    square: '1:1',
    portrait: '9:16',
    properties: isEn ? 'Properties' : '属性',
    depthHint: isEn ? 'Drag layers to change stacking order; lower items appear on top.' : '拖动图层可改变深度；越靠下越显示在上层。',
    name: isEn ? 'Name' : '名称',
    content: isEn ? 'Content' : '内容',
    width: isEn ? 'Width' : '宽度',
    height: isEn ? 'Height' : '高度',
    centerX: isEn ? 'Center X' : '中心 X',
    centerY: isEn ? 'Center Y' : '中心 Y',
    loop: isEn ? 'Loop video' : '循环播放',
    fontSize: isEn ? 'Text size' : '文字大小',
    fontColor: isEn ? 'Font color' : '字体颜色',
    bg: isEn ? 'Background' : '背景色',
    noSelection: isEn ? 'Select a layer on the canvas.' : '请在画布中选择一个图层。',
    empty: isEn ? 'Upload media or add a text layer.' : '请上传素材或添加文字图层。',
    webPlaceholder: isEn ? 'https://example.com' : '输入网址',
    addWeb: isEn ? 'Add web layer' : '添加网址图层',
  };
  const uploadAccept =
    uploadKind === 'video'
      ? STIMULUS_VIDEO_ACCEPT
      : uploadKind === 'audio'
        ? STIMULUS_AUDIO_ACCEPT
        : STIMULUS_IMAGE_ACCEPT;
  const tabBtn = (kind: ComboAddKind) =>
    `mrt-button-tab min-h-8 border-b-2 px-3 py-1.5 text-xs font-medium transition-colors ${
      uploadKind === kind ? 'border-sky-500 text-slate-800' : 'border-transparent text-slate-500 hover:text-slate-700'
    }`;
  const uploadHint =
    uploadKind === 'video'
      ? isEn
        ? 'Select video files to upload (multi-select supported).'
        : '选择视频文件上传（支持多选）。'
      : uploadKind === 'audio'
        ? isEn
          ? 'Select MP3 or WAV audio files to upload (multi-select supported).'
          : '选择 MP3 或 WAV 音频文件上传（支持多选）。'
        : isEn
          ? 'Select image files to upload (multi-select supported).'
          : '选择图片文件上传（支持多选）。';
  const resolvedCanvasStyle = getComboCanvasStyle(canvasStyle);
  const canvasAspect: Record<typeof resolvedCanvasStyle, string | undefined> = {
    fullscreen: undefined,
    landscape: '16 / 9',
    classic: '4 / 3',
    square: '1 / 1',
    portrait: '9 / 16',
  };
  const canvasStyleOptions: Array<{ value: typeof resolvedCanvasStyle; label: string }> = [
    { value: 'fullscreen', label: label.fullscreen },
    { value: 'landscape', label: label.landscape },
    { value: 'classic', label: label.classic },
  ];

  return (
    <div
      className="mrt-combo-editor fixed inset-0 z-[80] flex"
      style={{ backgroundColor: 'var(--app-bg)', color: 'var(--app-text)' }}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className="mrt-combo-editor-controls flex h-14 shrink-0 items-center justify-between border-b px-5"
          style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface)' }}
        >
          <div className="text-sm font-bold">{label.title}</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-xs font-bold transition-colors"
            style={{
              backgroundColor: 'var(--app-primary)',
              color: 'var(--app-primary-foreground)',
            }}
          >
            {label.done}
          </button>
        </div>

        <div
          className="flex min-h-0 flex-1 items-center justify-center p-8"
          style={{
            background:
              'radial-gradient(circle at center, color-mix(in srgb, var(--app-primary) 14%, transparent), transparent 48%)',
          }}
        >
          <div
            ref={canvasRef}
            className="relative overflow-hidden border shadow-2xl"
            style={{
              backgroundColor: bgColor || '#000000',
              borderColor: 'color-mix(in srgb, var(--app-border) 78%, transparent)',
              width: resolvedCanvasStyle === 'fullscreen' ? '100%' : undefined,
              height: resolvedCanvasStyle === 'fullscreen' ? '100%' : undefined,
              maxWidth: '100%',
              maxHeight: '100%',
              aspectRatio: canvasAspect[resolvedCanvasStyle],
              ...(resolvedCanvasStyle !== 'fullscreen' ? { width: '100%' } : {}),
            }}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={endDrag}
            onPointerDown={() => setSelectedId(null)}
          >
            {items.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-white/45">{label.empty}</div>
            )}
            {items.map((item) => {
              const selected = item.id === selectedId;
              const style: React.CSSProperties = {
                left: `${item.centerXPct}%`,
                top: `${item.centerYPct}%`,
                width: `${item.widthPct}%`,
                height: `${item.heightPct}%`,
                transform: 'translate(-50%, -50%)',
              };
              return (
                <div
                  key={item.id}
                  className="absolute cursor-move select-none outline-offset-2"
                  style={{
                    ...style,
                    outline: selected
                      ? '2px solid var(--app-primary)'
                      : '1px solid color-mix(in srgb, var(--app-border) 70%, transparent)',
                  }}
                  onPointerDown={(event) => beginDrag(event, item, 'move')}
                >
                  {item.type === 'video' ? (
                    <video src={getComboMediaSrc(item.url)} className="h-full w-full object-contain" muted loop={item.loop} autoPlay playsInline />
                  ) : item.type === 'audio' ? (
                    <div
                      className="flex h-full w-full items-center justify-center text-center text-white"
                      style={{ backgroundColor: item.bgColor || 'transparent' }}
                    >
                      <div className="px-2 text-xs font-semibold">{isEn ? 'Audio' : '音频'}</div>
                      <audio src={getComboMediaSrc(item.url)} autoPlay loop={item.loop} />
                    </div>
                  ) : item.type === 'web' ? (
                    <div className="flex h-full w-full items-center justify-center bg-white text-slate-700">
                      <div className="max-w-full px-3 text-center">
                        <Globe size={24} className="mx-auto mb-2" />
                        <div className="truncate text-xs font-semibold" data-i18n-skip="true">{item.name}</div>
                      </div>
                    </div>
                  ) : item.type === 'text' ? (
                    <div
                      className="flex h-full w-full items-center justify-center whitespace-pre-wrap break-words text-center"
                      data-i18n-skip="true"
                      style={{
                        fontSize: `${item.fontSize || 48}px`,
                        color: item.fontColor || '#ffffff',
                        backgroundColor: item.bgColor || 'transparent',
                      }}
                    >
                      {item.text || item.name}
                    </div>
                  ) : (
                    <img src={getComboMediaSrc(item.url)} alt={item.name} className="h-full w-full object-contain" draggable={false} />
                  )}
                  {selected && (
                    <button
                      type="button"
                      aria-label="resize"
                      data-visual-control="resize-handle"
                      className="absolute -bottom-2 -right-2 h-4 w-4 cursor-se-resize rounded shadow"
                      style={{
                        backgroundColor: 'var(--app-primary)',
                        boxShadow: '0 0 0 2px var(--app-bg)',
                      }}
                      onPointerDown={(event) => beginDrag(event, item, 'resize')}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <aside
        className="mrt-combo-editor-controls flex w-[360px] shrink-0 flex-col border-l"
        style={{
          borderColor: 'var(--app-border)',
          backgroundColor: 'var(--app-surface)',
          color: 'var(--app-text)',
        }}
      >
        <div className="border-b p-4" style={{ borderColor: 'var(--app-border)' }}>
          <button
            type="button"
            onClick={openAddModal}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-bold transition-colors"
            style={{
              backgroundColor: 'var(--app-primary)',
              color: 'var(--app-primary-foreground)',
            }}
          >
            <Upload size={16} />
            {label.upload}
          </button>
        </div>

        <div className="border-b p-4" style={{ borderColor: 'var(--app-border)' }}>
          <div className="mb-2 text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--app-muted)' }}>{label.style}</div>
          <CustomSelect
            value={resolvedCanvasStyle}
            onChange={(event) => setCanvasStyle(getComboCanvasStyle(event.target.value))}
            className="px-3 py-2 text-sm font-bold rounded-lg"
            menuClassName="text-sm"
          >
            {canvasStyleOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </CustomSelect>
        </div>

        <div className="border-b p-4" style={{ borderColor: 'var(--app-border)' }}>
          <div className="mb-2 text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--app-muted)' }}>{label.layers}</div>
          <div className="mb-2 text-[11px]" style={{ color: 'var(--app-muted)' }}>{label.depthHint}</div>
          <div
            className="max-h-44 space-y-2 overflow-y-auto pr-1"
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(event) => {
              event.preventDefault();
              const dragId = event.dataTransfer.getData('text/plain') || draggingLayerId;
              if (dragId) moveLayerToEnd(dragId);
              setDraggingLayerId(null);
              setOverLayerId(null);
            }}
          >
            {items.map((item, idx) => (
              <button
                key={item.id}
                type="button"
                draggable
                aria-pressed={item.id === selectedId}
                onClick={() => setSelectedId(item.id)}
                onDragStart={(event) => {
                  setDraggingLayerId(item.id);
                  setSelectedId(item.id);
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', item.id);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (draggingLayerId && draggingLayerId !== item.id) {
                    setOverLayerId(item.id);
                    event.dataTransfer.dropEffect = 'move';
                  }
                }}
                onDragLeave={() => {
                  setOverLayerId((current) => (current === item.id ? null : current));
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const dragId = event.dataTransfer.getData('text/plain') || draggingLayerId;
                  if (dragId) moveLayerBefore(dragId, item.id);
                  setDraggingLayerId(null);
                  setOverLayerId(null);
                }}
                onDragEnd={() => {
                  setDraggingLayerId(null);
                  setOverLayerId(null);
                }}
                className="flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors"
                style={{
                  borderColor:
                    overLayerId === item.id
                      ? 'var(--app-primary)'
                      : item.id === selectedId
                        ? 'var(--app-primary)'
                        : 'var(--app-border)',
                  backgroundColor: item.id === selectedId ? 'var(--app-primary-soft-50)' : 'var(--app-surface)',
                  color: item.id === selectedId ? 'var(--app-primary)' : 'var(--app-text)',
                  opacity: draggingLayerId === item.id ? 0.45 : 1,
                }}
              >
                {item.type === 'video' ? (
                  <Video size={15} />
                ) : item.type === 'audio' ? (
                  <Volume2 size={15} />
                ) : item.type === 'web' ? (
                  <Globe size={15} />
                ) : item.type === 'text' ? (
                  <Type size={15} />
                ) : (
                  <ImageIcon size={15} />
                )}
                <span className="text-xs font-bold" style={{ color: 'var(--app-muted)' }}>#{idx + 1}</span>
                <span className="min-w-0 flex-1 truncate" data-i18n-skip="true">{item.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--app-muted)' }}>{label.properties}</div>
            {selectedItem && (
              <button
                type="button"
                onClick={deleteSelected}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
                style={{ color: 'var(--app-muted)' }}
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>

          {!selectedItem ? (
            <div
              className="rounded-lg border border-dashed p-5 text-center text-sm"
              style={{
                borderColor: 'var(--app-border)',
                backgroundColor: 'var(--app-surface-2)',
                color: 'var(--app-muted)',
              }}
            >
              {label.noSelection}
            </div>
          ) : (
            <div className="space-y-4">
              <label className="block space-y-1 text-xs font-bold" style={{ color: 'var(--app-muted)' }}>
                <span>{label.name}</span>
                <input value={selectedItem.name} onChange={(e) => updateItem(selectedItem.id, { name: e.target.value })} className="w-full rounded-lg border px-3 py-2 text-sm font-normal outline-none focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10" style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface-2)', color: 'var(--app-text)' }} />
              </label>

              {selectedItem.type === 'text' && (
                <label className="block space-y-1 text-xs font-bold" style={{ color: 'var(--app-muted)' }}>
                  <span>{label.content}</span>
                  <AutoResizeTextarea value={selectedItem.text || ''} onChange={(e) => updateItem(selectedItem.id, { text: e.target.value })} rows={4} className="w-full rounded-xl border px-3 py-2 text-sm font-normal outline-none focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10" style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface-2)', color: 'var(--app-text)' }} />
                </label>
              )}

              {selectedItem.type === 'web' && (
                <label className="block space-y-1 text-xs font-bold" style={{ color: 'var(--app-muted)' }}>
                  <span>URL</span>
                  <input value={selectedItem.url || ''} onChange={(e) => updateItem(selectedItem.id, { url: e.target.value })} className="w-full rounded-lg border px-3 py-2 text-sm font-normal outline-none focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10" style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface-2)', color: 'var(--app-text)' }} />
                </label>
              )}

              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1 text-xs font-bold" style={{ color: 'var(--app-muted)' }}>
                  <span>{label.width}</span>
                  <input type="number" min="3" max="100" value={Math.round(selectedItem.widthPct * 10) / 10} onChange={(e) => updateItem(selectedItem.id, { widthPct: clamp(Number(e.target.value), 3, 100) })} className="w-full rounded-lg border px-3 py-2 text-sm font-normal outline-none focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10" style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface-2)', color: 'var(--app-text)' }} />
                </label>
                <label className="space-y-1 text-xs font-bold" style={{ color: 'var(--app-muted)' }}>
                  <span>{label.height}</span>
                  <input type="number" min="3" max="100" value={Math.round(selectedItem.heightPct * 10) / 10} onChange={(e) => updateItem(selectedItem.id, { heightPct: clamp(Number(e.target.value), 3, 100) })} className="w-full rounded-lg border px-3 py-2 text-sm font-normal outline-none focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10" style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface-2)', color: 'var(--app-text)' }} />
                </label>
                <label className="space-y-1 text-xs font-bold" style={{ color: 'var(--app-muted)' }}>
                  <span>{label.centerX}</span>
                  <input type="number" min="0" max="100" value={Math.round(selectedItem.centerXPct * 10) / 10} onChange={(e) => updateItem(selectedItem.id, { centerXPct: clamp(Number(e.target.value), 0, 100) })} className="w-full rounded-lg border px-3 py-2 text-sm font-normal outline-none focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10" style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface-2)', color: 'var(--app-text)' }} />
                </label>
                <label className="space-y-1 text-xs font-bold" style={{ color: 'var(--app-muted)' }}>
                  <span>{label.centerY}</span>
                  <input type="number" min="0" max="100" value={Math.round(selectedItem.centerYPct * 10) / 10} onChange={(e) => updateItem(selectedItem.id, { centerYPct: clamp(Number(e.target.value), 0, 100) })} className="w-full rounded-lg border px-3 py-2 text-sm font-normal outline-none focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10" style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface-2)', color: 'var(--app-text)' }} />
                </label>
              </div>

              {(selectedItem.type === 'video' || selectedItem.type === 'audio') && (
                <label className="inline-flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--app-text)' }}>
                  <input type="checkbox" checked={selectedItem.loop === true} onChange={(e) => updateItem(selectedItem.id, { loop: e.target.checked })} className="accent-sky-500" />
                  {selectedItem.type === 'audio' ? (isEn ? 'Loop audio' : '循环播放') : label.loop}
                </label>
              )}

              {selectedItem.type === 'audio' && (
                <label className="block space-y-1 text-xs font-bold" style={{ color: 'var(--app-muted)' }}>
                  <span>{label.bg}</span>
                  <input type="color" value={selectedItem.bgColor && selectedItem.bgColor !== 'transparent' ? selectedItem.bgColor : '#000000'} onChange={(e) => updateItem(selectedItem.id, { bgColor: e.target.value })} className="h-10 w-full cursor-pointer rounded-lg border border-slate-200 bg-slate-50" />
                </label>
              )}

              {selectedItem.type === 'text' && (
                <div className="space-y-3">
                  <label className="block space-y-1 text-xs font-bold" style={{ color: 'var(--app-muted)' }}>
                    <span>{label.fontSize}</span>
                    <input type="number" min="8" max="240" value={selectedItem.fontSize || 48} onChange={(e) => updateItem(selectedItem.id, { fontSize: clamp(Number(e.target.value), 8, 240) })} className="w-full rounded-lg border px-3 py-2 text-sm font-normal outline-none focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10" style={{ borderColor: 'var(--app-border)', backgroundColor: 'var(--app-surface-2)', color: 'var(--app-text)' }} />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="space-y-1 text-xs font-bold" style={{ color: 'var(--app-muted)' }}>
                      <span>{label.fontColor}</span>
                      <input type="color" value={selectedItem.fontColor || '#ffffff'} onChange={(e) => updateItem(selectedItem.id, { fontColor: e.target.value })} className="h-10 w-full cursor-pointer rounded-lg border border-slate-200 bg-slate-50" />
                    </label>
                    <label className="space-y-1 text-xs font-bold" style={{ color: 'var(--app-muted)' }}>
                      <span>{label.bg}</span>
                      <input type="color" value={selectedItem.bgColor && selectedItem.bgColor !== 'transparent' ? selectedItem.bgColor : '#000000'} onChange={(e) => updateItem(selectedItem.id, { bgColor: e.target.value })} className="h-10 w-full cursor-pointer rounded-lg border border-slate-200 bg-slate-50" />
                    </label>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      <Modal
        isOpen={isAddModalOpen}
        onClose={closeAddModal}
        title={isEn ? 'Add stimulus' : '添加刺激物'}
        maxWidthClassName="max-w-2xl"
        contentClassName="space-y-5"
        footer={(
          <>
            <button type="button" onClick={closeAddModal} className={btnSecondary}>
              {isEn ? 'Cancel' : '取消'}
            </button>
            {uploadKind === 'text' && (
              <button type="button" onClick={addTextItem} className={btnPrimary}>
                {isEn ? 'Add' : '添加'}
              </button>
            )}
            {uploadKind === 'web' && (
              <button type="button" onClick={addWebItem} className={btnPrimary}>
                {isEn ? 'Add' : '添加'}
              </button>
            )}
          </>
        )}
      >
        <div className="flex flex-wrap gap-2">
          <button type="button" aria-pressed={uploadKind === 'image'} onClick={() => setUploadKind('image')} className={tabBtn('image')}>{label.image}</button>
          <button type="button" aria-pressed={uploadKind === 'video'} onClick={() => setUploadKind('video')} className={tabBtn('video')}>{label.video}</button>
          <button type="button" aria-pressed={uploadKind === 'audio'} onClick={() => setUploadKind('audio')} className={tabBtn('audio')}>{label.audio}</button>
          <button type="button" aria-pressed={uploadKind === 'screen'} onClick={() => setUploadKind('screen')} className={tabBtn('screen')}>{label.screen}</button>
          <button type="button" aria-pressed={uploadKind === 'text'} onClick={() => setUploadKind('text')} className={tabBtn('text')}>{label.addText}</button>
          <button type="button" aria-pressed={uploadKind === 'web'} onClick={() => setUploadKind('web')} className={tabBtn('web')}>{label.web}</button>
        </div>

        {(uploadKind === 'image' || uploadKind === 'video' || uploadKind === 'audio') && (
          <div className="space-y-3">
            <div className="text-sm text-slate-600">{uploadHint}</div>
            <input
              ref={uploadInputRef}
              type="file"
              multiple
              accept={uploadAccept}
              onChange={handleUploadChange}
              className="hidden"
            />
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={() => uploadInputRef.current?.click()}
                className={`${btnSecondary} shrink-0`}
              >
                {isEn ? 'Select file' : '选择文件'}
              </button>
              <span className="min-w-0 truncate text-sm text-slate-500" title={selectedFileText}>{selectedFileText}</span>
            </div>
          </div>
        )}

        {uploadKind === 'screen' && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[100px_minmax(0,1fr)] sm:gap-4">
              <label className="text-xs font-medium text-slate-600">{isEn ? 'Name (optional)' : '名称(可选)'}</label>
              <input
                type="text"
                value={comboAddName}
                onChange={(event) => setComboAddName(event.target.value)}
                placeholder={isEn ? 'Auto-generate if empty' : '不填则自动生成'}
                className="rounded-xl border border-slate-200 bg-slate-50 min-w-0 px-3 py-2 text-sm outline-none transition-all focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10"
              />
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white">
                    {isScreenRecording ? <Square size={18} /> : <MonitorUp size={18} />}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-slate-800">{isEn ? 'Screen recording layer' : '录屏图层'}</div>
                    <div className="mt-1 text-xs text-slate-500">
                      {isEn ? 'Record the computer screen and add it to this Combo.' : '录制电脑屏幕并加入当前 Combo。'}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void (isScreenRecording ? stopScreenRecording() : startScreenRecording())}
                  className={`${btnPrimary} shrink-0`}
                >
                  {isScreenRecording ? (isEn ? 'Stop' : '停止录制') : (isEn ? 'Start' : '开始录屏')}
                </button>
              </div>
              {screenStatus && <div className="mt-3 text-xs text-slate-500" data-i18n-skip="true">{screenStatus}</div>}
            </div>
          </div>
        )}

        {uploadKind === 'text' && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[100px_minmax(0,1fr)] sm:gap-4">
              <label className="text-xs font-medium text-slate-600">{isEn ? 'Name (optional)' : '名称(可选)'}</label>
              <input
                type="text"
                value={comboAddName}
                onChange={(event) => setComboAddName(event.target.value)}
                placeholder={isEn ? 'Auto-generate if empty' : '不填则自动生成'}
                className="rounded-xl border border-slate-200 bg-slate-50 min-w-0 px-3 py-2 text-sm outline-none transition-all focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10"
              />
            </div>
            <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[100px_minmax(0,1fr)] sm:gap-4">
              <label className="mt-2 text-xs font-medium text-slate-600">{isEn ? 'Text content' : '文字内容'}</label>
              <AutoResizeTextarea
                rows={5}
                value={comboAddText}
                onChange={(event) => setComboAddText(event.target.value)}
                placeholder={isEn ? 'Please enter display text' : '请输入要展示的文字'}
                className="resize-none rounded-xl border border-slate-200 bg-slate-50 min-w-0 px-3 py-2 text-sm outline-none transition-all focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10"
              />
            </div>
          </div>
        )}

        {uploadKind === 'web' && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[100px_minmax(0,1fr)] sm:gap-4">
              <label className="text-xs font-medium text-slate-600">{isEn ? 'Name (optional)' : '名称(可选)'}</label>
              <input
                type="text"
                value={comboAddName}
                onChange={(event) => setComboAddName(event.target.value)}
                placeholder={isEn ? 'Auto-generate if empty' : '不填则自动生成'}
                className="rounded-xl border border-slate-200 bg-slate-50 min-w-0 px-3 py-2 text-sm outline-none transition-all focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10"
              />
            </div>
            <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[100px_minmax(0,1fr)] sm:gap-4">
              <label className="text-xs font-medium text-slate-600">{isEn ? 'URL' : '网址'}</label>
              <input
                type="text"
                value={webUrlInput}
                onChange={(event) => setWebUrlInput(event.target.value)}
                placeholder="https://example.com"
                className="rounded-xl border border-slate-200 bg-slate-50 min-w-0 px-3 py-2 text-sm outline-none transition-all focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10"
              />
            </div>
            <div className="text-[11px] text-slate-500">
              {isEn
                ? 'Note: Some websites may block embedding (X-Frame-Options).'
                : '注意：部分网站可能禁止被嵌入（X-Frame-Options）。'}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default ComboStimulusEditor;
