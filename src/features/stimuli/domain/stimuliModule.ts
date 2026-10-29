import type React from 'react';
import type { ComboStimulusItem, ConfirmState, ExtendedStimulus } from '@/shared/types/mrt';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import { isStimulusAudioExtension, isStimulusVideoExtension } from '@/features/stimuli/domain/mediaTypes';

const normalizePlayToEnd = (stimulus: Partial<ExtendedStimulus>): boolean => {
  if (stimulus.stimulusType !== 'video' && stimulus.stimulusType !== 'audio') return false;
  const raw = (stimulus as unknown as Record<string, unknown>).playToEnd;
  if (raw == null) return true;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw === 1;
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes' || v === 'on';
  }
  return true;
};

export async function uploadStimuli(params: {
  event: React.ChangeEvent<HTMLInputElement>;
  projectDir: string | null;
  setStimuli: React.Dispatch<React.SetStateAction<ExtendedStimulus[]>>;
  group?: string | null;
}): Promise<void> {
  const { event, projectDir, setStimuli, group } = params;
  try {
    const files = event.target.files;
    if (!files || files.length === 0) {
      return;
    }
    if (!projectDir) {
      alert('请先打开一个工程，然后再上传刺激物');
      event.target.value = '';
      return;
    }
    if (!projectDir || !ipcClient.isAvailable()) {
      const now = new Date();
      const dateLabel = now.toISOString().slice(0, 10);
      setStimuli((prev) => {
        const maxOrder = prev.reduce((acc, s) => {
          const o = typeof s.order === 'number' && Number.isFinite(s.order) ? s.order : 0;
          return Math.max(acc, o);
        }, 0);
        const next: ExtendedStimulus[] = [...prev];
        let order = maxOrder;
        for (let i = 0; i < files.length; i += 1) {
          const file = files.item(i);
          if (!file) {
            continue;
          }
          const objectUrl = URL.createObjectURL(file);
          const sizeBytes = file.size;
          const kb = sizeBytes / 1024;
          let sizeLabel = '';
          if (kb < 1024) {
            sizeLabel = `${kb.toFixed(1)} KB`;
          } else {
            sizeLabel = `${(kb / 1024).toFixed(1)} MB`;
          }
          order += 1;
          const lowerName = String(file.name || '').toLowerCase();
          const ext = lowerName.includes('.') ? lowerName.slice(lowerName.lastIndexOf('.')) : '';
          const stimulusType = isStimulusVideoExtension(ext) ? 'video' : isStimulusAudioExtension(ext) ? 'audio' : 'image';
          next.push({
            id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: file.name.replace(/\.[^/.]+$/, ''),
            url: objectUrl,
            size: sizeLabel,
            date: dateLabel,
            order,
            active: true,
            randomPlay: false,
            endOnClick: false,
            endOnKey: false,
            playToEnd: stimulusType === 'video' || stimulusType === 'audio',
            stimulusType,
            group: group || '',
          });
        }
        next.sort((a, b) => (a.order || 0) - (b.order || 0));
        return next.map((stimulus, index) => ({ ...stimulus, order: index + 1 }));
      });
      event.target.value = '';
      return;
    }
    const payloadFiles: { path: string; name: string }[] = [];
    for (let i = 0; i < files.length; i += 1) {
      const file = files.item(i);
      if (!file) {
        continue;
      }
      const fileWithPath = file as File & { path?: string };
      if (!fileWithPath.path || typeof fileWithPath.path !== 'string') {
        continue;
      }
      payloadFiles.push({ path: fileWithPath.path, name: file.name });
    }

    let result: Awaited<ReturnType<typeof ipcClient.importStimuli>> | Awaited<ReturnType<typeof ipcClient.importStimuliBuffer>>;
    if (payloadFiles.length > 0) {
      result = await ipcClient.importStimuli({
        projectDir,
        files: payloadFiles,
        group: group || undefined,
      });
    } else {
      const bufferFiles: { name: string; data: Uint8Array }[] = [];
      for (let i = 0; i < files.length; i += 1) {
        const file = files.item(i);
        if (!file) {
          continue;
        }
        const arrayBuffer = await file.arrayBuffer();
        bufferFiles.push({
          name: file.name,
          data: new Uint8Array(arrayBuffer),
        });
      }
      if (bufferFiles.length === 0) {
        event.target.value = '';
        return;
      }
      result = await ipcClient.importStimuliBuffer({
        projectDir,
        files: bufferFiles,
        group: group || undefined,
      });
    }
    if (result && result.ok && Array.isArray(result.stimuli)) {
      console.log('import stimuli result', result.stimuli);
      setStimuli(() => {
        const next = (result.stimuli as unknown[]).map((item, idx) => {
          const stimulus = item && typeof item === 'object' ? item as Partial<ExtendedStimulus> : {};
          return {
            ...stimulus,
            randomPlay: stimulus.randomPlay === true,
            endOnClick: stimulus.endOnClick === true,
            endOnKey: stimulus.endOnKey === true,
            playToEnd: normalizePlayToEnd(stimulus),
            order: typeof stimulus.order === 'number' ? stimulus.order : idx + 1,
          } as ExtendedStimulus;
        });
        next.sort((a, b) => (a.order || 0) - (b.order || 0));
        return next.map((s, idx) => ({ ...s, order: idx + 1 })) as ExtendedStimulus[];
      });
    } else {
      const message = typeof result?.message === 'string' && result.message.trim()
        ? result.message.trim()
        : '刺激物上传失败，请稍后重试';
      alert(message);
    }
  } catch (error) {
    console.error(error);
    alert('刺激物上传过程中发生错误，请稍后重试');
  } finally {
    event.target.value = '';
  }
}

export function beginEditStimulusName(params: {
  id: string;
  stimuli: ExtendedStimulus[];
  setEditingStimulusId: React.Dispatch<React.SetStateAction<string | null>>;
  setEditStimulusName: React.Dispatch<React.SetStateAction<string>>;
  setEditStimulusFixedTimeSec: React.Dispatch<React.SetStateAction<string>>;
  setEditStimulusActive: React.Dispatch<React.SetStateAction<boolean>>;
  setIsEditStimulusModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setBgColor: React.Dispatch<React.SetStateAction<string>>;
  setFontSize: React.Dispatch<React.SetStateAction<number>>;
  setFontColor?: React.Dispatch<React.SetStateAction<string>>;
  setTextValue?: React.Dispatch<React.SetStateAction<string>>;
  setWebUrl?: React.Dispatch<React.SetStateAction<string>>;
  setExternalMarker: React.Dispatch<React.SetStateAction<boolean>>;
  setEndOnClick: React.Dispatch<React.SetStateAction<boolean>>;
  setEndOnKey: React.Dispatch<React.SetStateAction<boolean>>;
  setGroup: React.Dispatch<React.SetStateAction<string>>;
  setRandomPlay?: React.Dispatch<React.SetStateAction<boolean>>;
  setTriggerEnabled?: React.Dispatch<React.SetStateAction<boolean>>;
  setTriggerMark?: React.Dispatch<React.SetStateAction<number | null>>;
  setGroupPlayMode?: React.Dispatch<React.SetStateAction<string>>;
  setGroupRandomCount?: React.Dispatch<React.SetStateAction<number>>;
  setGroupRepeatCount?: React.Dispatch<React.SetStateAction<number>>;
  setPlayToEnd?: React.Dispatch<React.SetStateAction<boolean>>;
  setComboItems?: React.Dispatch<React.SetStateAction<ComboStimulusItem[]>>;
  setComboCanvasStyle?: React.Dispatch<React.SetStateAction<'fullscreen' | 'landscape' | 'classic' | 'square' | 'portrait'>>;
}): void {
  const {
    id,
    stimuli,
    setEditingStimulusId,
    setEditStimulusName,
    setEditStimulusFixedTimeSec,
    setEditStimulusActive,
    setIsEditStimulusModalOpen,
    setBgColor,
    setFontSize,
    setFontColor,
    setTextValue,
    setWebUrl,
    setExternalMarker,
    setEndOnClick,
    setEndOnKey,
    setGroup,
    setRandomPlay,
    setTriggerEnabled,
    setTriggerMark,
    setGroupPlayMode,
    setGroupRandomCount,
    setGroupRepeatCount,
    setPlayToEnd,
    setComboItems,
    setComboCanvasStyle,
  } = params;
  const target = stimuli.find((item) => item.id === id);
  if (!target) {
    return;
  }
  setEditingStimulusId(id);
  setEditStimulusName(target.name || '');
  const ms = Number(target.fixedTimeMs);
  if (Number.isFinite(ms) && ms > 0) {
    setEditStimulusFixedTimeSec(String(Math.round((ms / 1000) * 10) / 10));
  } else {
    setEditStimulusFixedTimeSec(target.stimulusType === 'combo' ? '' : '5');
  }
  setEditStimulusActive(target.active !== false);
  setBgColor(target.bgColor || '#000000');
  setFontSize(target.fontSize || 48);
  if (setFontColor) {
    setFontColor(target.fontColor || '#ffffff');
  }
  if (setTextValue) {
    setTextValue(target.text || '');
  }
  if (setWebUrl) {
    setWebUrl(target.stimulusType === 'web' ? String(target.url || '') : '');
  }
  setExternalMarker(target.externalMarker !== false);
  setEndOnClick(target.endOnClick === true);
  setEndOnKey(target.endOnKey === true);
  setGroup(target.group || '');
  
  // 设置新增字段
  if (setRandomPlay) {
    setRandomPlay(target.randomPlay === true);
  }
  if (setTriggerEnabled) {
    setTriggerEnabled(target.triggerEnabled === true);
  }
  if (setTriggerMark) {
    const mark = target.triggerMark;
    setTriggerMark(typeof mark === 'number' ? mark : null);
  }
  if (setGroupPlayMode) {
    setGroupPlayMode(target.groupPlayMode || 'all-sequential');
  }
  if (setGroupRandomCount) {
    const count = target.groupRandomCount;
    setGroupRandomCount(typeof count === 'number' && count > 0 ? count : 1);
  }
  if (setGroupRepeatCount) {
    const count = target.groupRepeatCount;
    setGroupRepeatCount(typeof count === 'number' && count > 0 ? count : 1);
  }
  if (setPlayToEnd) {
    setPlayToEnd(normalizePlayToEnd(target));
  }
  if (setComboItems) {
    setComboItems(
      Array.isArray(target.comboItems)
        ? target.comboItems.map((item) => ({ ...item }))
        : [],
    );
  }
  if (setComboCanvasStyle) {
    const style = target.comboCanvasStyle;
    setComboCanvasStyle(style === 'landscape' || style === 'classic' || style === 'square' || style === 'portrait' ? style : 'landscape');
  }

  setIsEditStimulusModalOpen(true);
}

export function saveEditedStimulusName(params: {
  editStimulusName: string;
  editingStimulusId: string | null;
  setStimuli: React.Dispatch<React.SetStateAction<ExtendedStimulus[]>>;
  setIsEditStimulusModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setEditingStimulusId: React.Dispatch<React.SetStateAction<string | null>>;
}): void {
  const { editStimulusName, editingStimulusId, setStimuli, setIsEditStimulusModalOpen, setEditingStimulusId } = params;
  const name = editStimulusName.trim();
  if (!name) {
    alert('请输入名称');
    return;
  }
  if (!editingStimulusId) {
    setIsEditStimulusModalOpen(false);
    return;
  }
  setStimuli((prev) => prev.map((item) => (item.id === editingStimulusId ? { ...item, name } : item)));
  setIsEditStimulusModalOpen(false);
  setEditingStimulusId(null);
}

export function requestDeleteStimulus(params: {
  id: string;
  stimuli: ExtendedStimulus[];
  setConfirmState: React.Dispatch<React.SetStateAction<ConfirmState>>;
  setStimuli: React.Dispatch<React.SetStateAction<ExtendedStimulus[]>>;
}): void {
  const { id, stimuli, setConfirmState, setStimuli } = params;
  const target = stimuli.find((item) => item.id === id);
  const name = target ? target.name : '';
  setConfirmState({
    open: true,
    title: '删除刺激物',
    message: name ? `确定要删除刺激物「${name}」吗？此操作不可撤销。` : '确定要删除该刺激物吗？此操作不可撤销。',
    onConfirm: () => {
      setStimuli((prev) => {
        const next = prev.filter((item) => item.id !== id);
        next.sort((a, b) => (a.order || 0) - (b.order || 0));
        return next.map((s, idx) => ({ ...s, order: idx + 1 })) as ExtendedStimulus[];
      });
    },
  });
}

/**
 * Generate a unique name for copied stimulus
 * Format: originalName_copy or originalName_copy_N
 */
export function generateUniqueName(baseName: string, existingNames: string[]): string {
  const nameSet = new Set(existingNames);
  
  // Try baseName_copy first
  let candidateName = `${baseName}_copy`;
  if (!nameSet.has(candidateName)) {
    return candidateName;
  }
  
  // Try baseName_copy_2, baseName_copy_3, etc.
  let counter = 2;
  while (nameSet.has(`${baseName}_copy_${counter}`)) {
    counter++;
  }
  
  return `${baseName}_copy_${counter}`;
}

/**
 * Copy a stimulus
 */
export async function copyStimulus(params: {
  stimulus: ExtendedStimulus;
  projectDir: string | null;
  stimuli: ExtendedStimulus[];
  setStimuli: React.Dispatch<React.SetStateAction<ExtendedStimulus[]>>;
}): Promise<void> {
  const { stimulus, projectDir, stimuli, setStimuli } = params;
  
  if (!projectDir) {
    alert('请先打开一个工程');
    return;
  }
  
  if (!ipcClient.isAvailable()) {
    alert('Electron IPC 不可用');
    return;
  }
  
  try {
    // Call Electron IPC to copy stimulus
    const result = await ipcClient.copyStimulus({
      projectDir,
      stimulusId: stimulus.id,
    });
    
    if (result && result.ok && Array.isArray(result.stimuli)) {
      // Update stimuli list with the result from backend
      setStimuli(() => {
        const next = (result.stimuli as unknown[]).map((item, idx) => {
          const stimulus = item && typeof item === 'object' ? item as Partial<ExtendedStimulus> : {};
          return {
            ...stimulus,
            order: typeof stimulus.order === 'number' ? stimulus.order : idx + 1,
          } as ExtendedStimulus;
        });
        next.sort((a, b) => (a.order || 0) - (b.order || 0));
        return next.map((s, idx) => ({ ...s, order: idx + 1 })) as ExtendedStimulus[];
      });
    } else {
      alert('素材复制失败，请稍后重试');
    }
  } catch (error) {
    console.error('Copy stimulus error:', error);
    alert('素材复制过程中发生错误，请稍后重试');
  }
}
