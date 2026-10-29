import React, { useMemo, useState } from 'react';
import { Folder, ArrowLeft, Trash2, Edit2, Play, Image as ImageIcon, FileText, Globe, Shuffle, Copy, Layers3, Volume2 } from 'lucide-react';
import { normalizeComboItems } from '@/features/stimuli/ComboStimulusRenderer';
import { isWebStimulusUrl } from '@/features/stimuli/WebStimulusFrame';
import { useLanguage } from '@/app/i18n/useLanguage';
import { isStimulusAudioUrl, isStimulusVideoUrl } from '@/features/stimuli/domain/mediaTypes';
import type { ExtendedStimulus } from '@/shared/types/mrt';

interface StimulusPageProps {
  stimuli: ExtendedStimulus[];
  onEditName: (id: string) => void;
  onDelete: (id: string) => void;
  onCopy?: (id: string) => void;  // 新增：复制素材
  onReorder: (next: ExtendedStimulus[]) => void | Promise<void>;
  saveHint?: string;
  currentGroup: string | null;
  onGroupChange: (group: string | null) => void;
  customGroups: string[];
  onAddCustomGroup: (group: string) => void;
}

const localizeStimuliSaveHint = (value: unknown, isEn: boolean): string => {
  const text = String(value ?? '').trim();
  if (!text) return '';

  const exact: Record<string, { zh: string; en: string }> = {
    已保存: { zh: '已保存', en: 'Saved' },
    Saved: { zh: '已保存', en: 'Saved' },
    已更新: { zh: '已更新', en: 'Updated' },
    Updated: { zh: '已更新', en: 'Updated' },
    已删除并保存: { zh: '已删除并保存', en: 'Deleted and saved' },
    'Deleted and saved': { zh: '已删除并保存', en: 'Deleted and saved' },
    已复制: { zh: '已复制', en: 'Copied' },
    Copied: { zh: '已复制', en: 'Copied' },
    '保存失败：未找到工程目录或 ipc 不可用': {
      zh: '保存失败：未找到工程目录或 ipc 不可用',
      en: 'Save failed: project directory not found or IPC unavailable',
    },
    'Save failed: project directory not found or IPC unavailable': {
      zh: '保存失败：未找到工程目录或 ipc 不可用',
      en: 'Save failed: project directory not found or IPC unavailable',
    },
    '删除失败：未找到工程目录或 ipc 不可用': {
      zh: '删除失败：未找到工程目录或 ipc 不可用',
      en: 'Delete failed: project directory not found or IPC unavailable',
    },
    'Delete failed: project directory not found or IPC unavailable': {
      zh: '删除失败：未找到工程目录或 ipc 不可用',
      en: 'Delete failed: project directory not found or IPC unavailable',
    },
    '保存失败：发生异常': { zh: '保存失败：发生异常', en: 'Save failed: unexpected error' },
    'Save failed: unexpected error': { zh: '保存失败：发生异常', en: 'Save failed: unexpected error' },
    '保存失败：写入发生异常': { zh: '保存失败：写入发生异常', en: 'Save failed: write error' },
    'Save failed: write error': { zh: '保存失败：写入发生异常', en: 'Save failed: write error' },
    '删除失败：发生异常': { zh: '删除失败：发生异常', en: 'Delete failed: unexpected error' },
    'Delete failed: unexpected error': { zh: '删除失败：发生异常', en: 'Delete failed: unexpected error' },
    '复制失败：发生异常': { zh: '复制失败：发生异常', en: 'Copy failed: unexpected error' },
    'Copy failed: unexpected error': { zh: '复制失败：发生异常', en: 'Copy failed: unexpected error' },
  };

  const hit = exact[text];
  if (hit) return isEn ? hit.en : hit.zh;

  const zhPrefix = text.match(/^(保存失败|删除失败|复制失败)：(.+)$/u);
  if (zhPrefix) {
    if (!isEn) return text;
    const prefixMap: Record<string, string> = {
      保存失败: 'Save failed',
      删除失败: 'Delete failed',
      复制失败: 'Copy failed',
    };
    return `${prefixMap[zhPrefix[1]] || zhPrefix[1]}: ${zhPrefix[2]}`;
  }

  const enPrefix = text.match(/^(Save failed|Delete failed|Copy failed):\s*(.+)$/u);
  if (enPrefix) {
    if (isEn) return text;
    const prefixMap: Record<string, string> = {
      'Save failed': '保存失败',
      'Delete failed': '删除失败',
      'Copy failed': '复制失败',
    };
    return `${prefixMap[enPrefix[1]] || enPrefix[1]}：${enPrefix[2]}`;
  }

  return text;
};

const StimulusPage: React.FC<StimulusPageProps> = ({
  stimuli,
  onEditName,
  onDelete,
  onCopy,
  onReorder,
  saveHint,
  currentGroup,
  onGroupChange,
  customGroups,
  onAddCustomGroup,
}) => {
  const { language } = useLanguage();
  const isEn = language === 'en-US';
  const labels = useMemo(() => ({
    stimulusLibrary: isEn ? 'Stimulus Library' : '素材库',
    allStimuli: isEn ? 'All stimuli' : '所有素材',
    noStimuli: isEn ? 'No stimuli' : '暂无素材',
    emptyGroup: isEn ? 'This combo is empty. Drag stimuli into it or upload them here.' : '组合为空，请将素材拖入或在此页面上传',
    stimuliInPrefix: isEn ? 'Stimuli in ' : '',
    stimuliInSuffix: isEn ? '' : ' 中的素材',
    open: isEn ? 'Open' : '打开',
    edit: isEn ? 'Edit' : '编辑',
    copy: isEn ? 'Copy' : '复制',
    delete: isEn ? 'Delete' : '删除',
    randomPlay: isEn ? 'Random play' : '随机播放',
    trigger: isEn ? 'Trigger' : '触发',
    playMode: isEn ? 'Play mode' : '播放模式',
    random: isEn ? 'Random' : '随机',
    sample: isEn ? 'Sample' : '抽样',
    repeat: isEn ? 'Repeat' : '重复',
    times: isEn ? 'x' : '次',
    group: isEn ? 'Group' : '组合',
    kind: {
      image: isEn ? 'Image' : '图片',
      video: isEn ? 'Video' : '视频',
      audio: isEn ? 'Audio' : '音频',
      text: isEn ? 'Text' : '文字',
      web: isEn ? 'Web' : '网页',
      combo: isEn ? 'Combo' : '组合',
      group: isEn ? 'Group' : '组合',
    },
  }), [isEn]);
  const formatItemCount = (count: number) => isEn ? `${count} item${count === 1 ? '' : 's'}` : `${count} 项`;
  const formatStimulusCount = (count: number) => isEn ? `${count} ${count === 1 ? 'stimulus' : 'stimuli'}` : `${count} 个素材`;
  const formatLayerCount = (count: number) => isEn ? `${count} layer${count === 1 ? '' : 's'}` : `${count} 个图层`;
  const displayedSaveHint = useMemo(() => localizeStimuliSaveHint(saveHint, isEn), [saveHint, isEn]);

  const getKind = (s: ExtendedStimulus): 'image' | 'video' | 'audio' | 'text' | 'web' | 'group' | 'combo' => {
    const t = s.stimulusType;
    if (t === 'group') return 'group';
    if (t === 'image' || t === 'video' || t === 'audio' || t === 'text' || t === 'web' || t === 'combo') return t;
    const url = String(s.url || '');
    if (isWebStimulusUrl(url)) return 'web';
    if (isStimulusVideoUrl(url)) return 'video';
    if (isStimulusAudioUrl(url)) return 'audio';
    if (url) return 'image';
    if (s.text) return 'text';
    return 'image';
  };

  // Sort by order
  const sortedStimuli = useMemo(() => {
    const withOrder = stimuli.map((s, idx) => ({ ...s, order: typeof s.order === 'number' ? s.order : idx + 1 }));
    withOrder.sort((a, b) => (a.order || 0) - (b.order || 0));
    return withOrder;
  }, [stimuli]);

  // Drag and Drop state
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  // Grouping logic
  const { groups, ungrouped, groupedMap } = useMemo(() => {
    const map: Record<string, ExtendedStimulus[]> = {};
    const ungroupedList: ExtendedStimulus[] = [];
    const groupNames = new Set<string>();

    sortedStimuli.forEach((s) => {
      if (s.stimulusType === 'group') {
        groupNames.add(s.name);
        if (s.group) {
          if (!map[s.group]) map[s.group] = [];
          map[s.group].push(s);
          groupNames.add(s.group);
        } else {
          ungroupedList.push(s);
        }
      } else if (s.group) {
        if (!map[s.group]) map[s.group] = [];
        map[s.group].push(s);
        groupNames.add(s.group);
      } else {
        ungroupedList.push(s);
      }
    });

    Object.values(map).forEach((list) => {
      list.sort((a, b) => {
        const aGroupOrder = typeof a.groupInternalOrder === 'number' ? a.groupInternalOrder : Number.MAX_SAFE_INTEGER;
        const bGroupOrder = typeof b.groupInternalOrder === 'number' ? b.groupInternalOrder : Number.MAX_SAFE_INTEGER;
        if (aGroupOrder !== bGroupOrder) return aGroupOrder - bGroupOrder;
        return (a.order || 0) - (b.order || 0);
      });
    });

    return {
      groups: Array.from(groupNames).sort((a, b) => a.localeCompare(b, 'zh-CN')),
      ungrouped: ungroupedList,
      groupedMap: map,
    };
  }, [sortedStimuli]);

  const reindexOrders = (items: ExtendedStimulus[]) => {
    const ordered = items.map((s, idx) => ({ ...s, order: idx + 1 }));
    const groupOrderMap = new Map<string, number>();
    return ordered.map((s) => {
      if (!s.group) return s;
      const nextGroupOrder = (groupOrderMap.get(s.group) || 0) + 1;
      groupOrderMap.set(s.group, nextGroupOrder);
      return { ...s, groupInternalOrder: nextGroupOrder };
    });
  };

  const reorderBefore = (list: ExtendedStimulus[], dragId: string, dropId: string) => {
    const fromIndex = list.findIndex((s) => s.id === dragId);
    const toIndex = list.findIndex((s) => s.id === dropId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return list;
    const next = [...list];
    const [moved] = next.splice(fromIndex, 1);
    const insertIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
    next.splice(insertIndex, 0, moved);
    return next;
  };

  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');

  const handleCreateGroup = () => {
    // No longer using this button, group creation is in AddStimulusModal
    setIsCreatingGroup(true);
  };

  const submitNewGroup = () => {
    if (newGroupName && newGroupName.trim()) {
      const trimmed = newGroupName.trim();
      onAddCustomGroup(trimmed);
      setIsCreatingGroup(false);
      setNewGroupName('');
    } else {
      setIsCreatingGroup(false);
    }
  };

  const handleDrop = async (e: React.DragEvent, dropTargetId: string) => {
    e.preventDefault();
    const dragId = e.dataTransfer.getData('text/plain') || draggingId;
    if (!dragId) {
      setDraggingId(null);
      setOverId(null);
      return;
    }

    if (dragId === dropTargetId) {
      setDraggingId(null);
      setOverId(null);
      return;
    }

    const reordered = reorderBefore(sortedStimuli, dragId, dropTargetId);
    if (reordered !== sortedStimuli) {
      await onReorder(reindexOrders(reordered));
    }
    
    setDraggingId(null);
    setOverId(null);
  };

  const renderItem = (s: ExtendedStimulus, indexInGroup?: number) => {
    const kind = getKind(s);
    
    // Determine the displayed index
    let displayIndex: string | number;
    if (indexInGroup !== undefined) {
      // 组内成员：显示为 "Group编号-组内序号"
      const groupStimulus = sortedStimuli.find(stim => stim.stimulusType === 'group' && stim.name === s.group);
      if (groupStimulus) {
        const groupOrder = groupStimulus.order || 0;
        displayIndex = `${groupOrder}-${indexInGroup + 1}`;
      } else {
        displayIndex = indexInGroup + 1;
      }
    } else {
      // 顶层刺激物：显示普通编号
      displayIndex = s.order || (sortedStimuli.findIndex(x => x.id === s.id) + 1);
    }
    
    if (kind === 'group') {
      return (
        <div
          key={s.id}
          draggable
          onDragStart={(e) => {
            setDraggingId(s.id);
            setOverId(null);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', s.id);
          }}
          onClick={() => onGroupChange(s.name)}
          onDragOver={(e) => {
            e.preventDefault();
            if (draggingId && draggingId !== s.id) {
               setOverId(s.id);
               e.dataTransfer.dropEffect = 'move';
            }
          }}
          onDragLeave={() => setOverId(null)}
          onDrop={(e) => handleDrop(e, s.id)}
          className={`group relative flex flex-col bg-white rounded-xl border transition-all ${
            overId === s.id ? 'border-sky-500 ring-2 ring-sky-500/20' : 'border-slate-200 hover:border-sky-300'
          } ${draggingId === s.id ? 'opacity-50' : ''}`}
        >
          <div className="aspect-video relative overflow-hidden bg-slate-100 rounded-t-xl flex items-center justify-center">
            <Folder size={65} className="text-sky-500 fill-sky-500/20" />
            
            <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/60 text-[10px] font-bold text-white flex items-center gap-1">
              <span className="text-white/80 mr-1">#{displayIndex}</span>
              <Folder size={10} />
              GROUP
            </div>
            
            {/* Group播放模式标记 */}
            {s.groupPlayMode && s.groupPlayMode !== 'all-sequential' && (
              <div className="absolute top-2 right-2 px-2 py-0.5 rounded bg-indigo-500/90 text-[10px] font-bold text-white" title={`${labels.playMode}: ${s.groupPlayMode}`}>
                {s.groupPlayMode === 'all-random' && labels.random}
                {s.groupPlayMode === 'random-sample' && `${labels.sample}${s.groupRandomCount || 1}`}
                {s.groupPlayMode === 'repeat' && `${labels.repeat}${s.groupRepeatCount || 1}${labels.times}`}
              </div>
            )}

            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 pointer-events-none">
              <button
                onClick={(e) => { e.stopPropagation(); onGroupChange(s.name); }}
                className="p-2 rounded-full bg-white text-slate-700 hover:bg-sky-50 hover:text-sky-600 transition-colors pointer-events-auto"
                title={labels.open}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-folder-open" aria-hidden="true"><path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"></path></svg>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onEditName(s.id); }}
                className="p-2 rounded-full bg-white text-slate-700 hover:bg-sky-50 hover:text-sky-600 transition-colors pointer-events-auto"
                title={labels.edit}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-pen" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"></path></svg>
              </button>
              {onCopy && (
                <button
                  onClick={(e) => { e.stopPropagation(); onCopy(s.id); }}
                  className="p-2 rounded-full bg-white text-slate-700 hover:bg-sky-50 hover:text-sky-600 transition-colors pointer-events-auto"
                  title={labels.copy}
                >
                  <Copy size={14} />
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
                className="p-2 rounded-full bg-white text-slate-700 hover:bg-rose-50 hover:text-rose-600 transition-colors pointer-events-auto"
                title={labels.delete}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          
          <div className="p-3 flex-1 min-w-0 flex flex-col justify-center">
            <h4 className="text-sm font-medium text-slate-800 truncate" title={s.name} data-i18n-skip="true">{s.name}</h4>
            <p className="text-[10px] text-slate-400 mt-1">
              {formatStimulusCount((groupedMap[s.name] || []).length)}
            </p>
          </div>
        </div>
      );
    }

    return (
      <div
        key={s.id}
        draggable
        onDragStart={(e) => {
          setDraggingId(s.id);
          setOverId(null);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', s.id);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (draggingId && draggingId !== s.id) {
             setOverId(s.id);
             e.dataTransfer.dropEffect = 'move';
          }
        }}
        onDragLeave={() => setOverId(null)}
        onDrop={(e) => handleDrop(e, s.id)}
        className={`group relative flex flex-col bg-white rounded-xl border transition-all ${
          overId === s.id ? 'border-sky-500 ring-2 ring-sky-500/20' : 'border-slate-200 hover:border-sky-300'
        } ${draggingId === s.id ? 'opacity-50' : ''}`}
      >
        <div className="aspect-video relative overflow-hidden bg-slate-100 rounded-t-xl">
          {kind === 'combo' ? (
            <div className="w-full h-full flex items-center justify-center bg-slate-900">
              <div className="relative h-20 w-24">
                <div className="absolute left-0 top-4 h-12 w-16 rounded-lg border border-cyan-200/70 bg-cyan-400/25" />
                <div className="absolute right-1 top-0 h-14 w-16 rounded-lg border border-sky-200/70 bg-sky-400/30" />
                <div className="absolute left-7 bottom-0 h-12 w-16 rounded-lg border border-white/70 bg-white/20 flex items-center justify-center">
                  <Layers3 size={22} className="text-white" />
                </div>
              </div>
            </div>
          ) : kind === 'video' ? (
            <video
              src={s.url}
              className="w-full h-full object-contain bg-black"
              muted
              preload="metadata"
            />
          ) : kind === 'audio' ? (
            <div className="w-full h-full flex flex-col items-center justify-center gap-3 bg-slate-900 text-white px-4">
              <div className="h-14 w-14 rounded-full bg-white/12 flex items-center justify-center">
                <Volume2 size={28} />
              </div>
              <div className="max-w-[80%] truncate text-xs font-semibold" data-i18n-skip="true">{s.name}</div>
            </div>
          ) : kind === 'image' ? (
            <img src={s.url} alt={s.name} className="w-full h-full object-cover" />
          ) : (
            <div
              className="w-full h-full flex items-center justify-center p-4 text-xs overflow-hidden"
              style={{
                backgroundColor: kind === 'text' ? (s.bgColor || '#000000') : '#1e293b',
                color: kind === 'text' ? (s.fontColor || '#ffffff') : '#ffffff',
              }}
            >
              {kind === 'text' ? (
                <div
                  style={{
                    fontSize: s.fontSize ? `${Math.max(8, s.fontSize / 4)}px` : undefined,
                    textAlign: 'center',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  <span data-i18n-skip="true">{s.text}</span>
                </div>
              ) : (
                'Web'
              )}
            </div>
          )}
          
          <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/60 text-[10px] font-bold text-white flex items-center gap-1">
            <span className="text-white/80 mr-1">#{displayIndex}</span>
            {kind === 'video' && <Play size={10} />}
            {kind === 'audio' && <Volume2 size={10} />}
            {kind === 'image' && <ImageIcon size={10} />}
            {kind === 'text' && <FileText size={10} />}
            {kind === 'web' && <Globe size={10} />}
            {kind === 'combo' && <Layers3 size={10} />}
            {labels.kind[kind]}
          </div>
          
          {/* 随机播放标记 */}
          {s.randomPlay && (
            <div className="absolute top-2 right-2 px-2 py-0.5 rounded bg-purple-500/90 text-[10px] font-bold text-white flex items-center gap-1" title={labels.randomPlay}>
              <Shuffle size={10} />
            </div>
          )}
          
          {/* Trigger标记 */}
          {s.triggerEnabled && s.triggerMark != null && (
            <div className="absolute top-10 right-2 px-2 py-0.5 rounded bg-orange-500/90 text-[10px] font-bold text-white" title={`${labels.trigger}: ${s.triggerMark}`}>
              T:{s.triggerMark}
            </div>
          )}

          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 pointer-events-none">
            <button
              onClick={(e) => { e.stopPropagation(); onEditName(s.id); }}
              className="p-2 rounded-full bg-white text-slate-700 hover:bg-sky-50 hover:text-sky-600 transition-colors pointer-events-auto"
              title={labels.edit}
            >
              <Edit2 size={14} />
            </button>
            {onCopy && (
              <button
                onClick={(e) => { e.stopPropagation(); onCopy(s.id); }}
                className="p-2 rounded-full bg-white text-slate-700 hover:bg-sky-50 hover:text-sky-600 transition-colors pointer-events-auto"
                title={labels.copy}
              >
                <Copy size={14} />
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
              className="p-2 rounded-full bg-white text-slate-700 hover:bg-rose-50 hover:text-rose-600 transition-colors pointer-events-auto"
              title={labels.delete}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
        <div className="p-3">
          <h4 className="text-sm font-medium text-slate-800 truncate" title={s.name} data-i18n-skip="true">{s.name}</h4>
          <div className="flex items-center justify-between mt-1 text-[10px] text-slate-400">
            <span className="">{kind === 'combo' ? formatLayerCount(normalizeComboItems(s.comboItems).length) : s.size}</span>
            <span>{s.date}</span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="bg-slate-50/50 rounded-2xl border border-slate-200 overflow-hidden h-full flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          {currentGroup ? (
            <>
              <button
                onClick={() => onGroupChange(null)}
                className="p-2 -ml-2 rounded-full hover:bg-slate-100 text-slate-600 transition-colors"
              >
                <ArrowLeft size={20} />
              </button>
              <div className="flex items-center gap-2">
                <Folder size={20} className="text-sky-500 fill-sky-500/20" />
                <h2 className="text-lg font-bold text-slate-800" data-i18n-skip="true">{currentGroup}</h2>
                <span className="text-sm text-slate-400 font-medium" data-i18n-skip="true">
                  {formatItemCount((groupedMap[currentGroup] || []).length)}
                </span>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-slate-800" data-i18n-skip="true">{labels.stimulusLibrary}</h2>
              {displayedSaveHint && (
                <span className="text-xs text-slate-400 ml-2" data-i18n-skip="true">
                  {displayedSaveHint}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {currentGroup ? (
          // Folder View
          <div className="space-y-4">
              <h3 className="text-xs font-bold text-slate-400 tracking-wider" data-i18n-skip="true">
                {labels.stimuliInPrefix}
                <span>{currentGroup}</span>
                {labels.stimuliInSuffix} ({(groupedMap[currentGroup] || []).length})
              </h3>
            {(groupedMap[currentGroup] || []).length === 0 ? (
              <div className="py-8 text-center text-sm text-slate-400 border-2 border-dashed border-slate-100 rounded-xl" data-i18n-skip="true">
                {labels.emptyGroup}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-6">
                {(groupedMap[currentGroup] || []).map((s, idx) => renderItem(s, idx))}
              </div>
            )}
          </div>
        ) : (
          // Root View
          <div className="space-y-8">
            {/* All items flat display to allow global reordering */}
            <div className="space-y-4">
              <h3 className="text-xs font-bold text-slate-400 tracking-wider" data-i18n-skip="true">
                {labels.allStimuli} ({ungrouped.length})
              </h3>
              {ungrouped.length === 0 ? (
                <div className="py-8 text-center text-sm text-slate-400 border-2 border-dashed border-slate-100 rounded-xl" data-i18n-skip="true">
                  {labels.noStimuli}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-6">
                  {ungrouped.map((s) => renderItem(s))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default StimulusPage;
