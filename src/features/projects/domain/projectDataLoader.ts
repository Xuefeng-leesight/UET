import type React from 'react';
import type { Project, RecordingRecord, Subject } from '@shared/contracts/domain/models';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import type { ExtendedStimulus, SubjectFieldDef, CustomMarker } from '@/shared/types/mrt';
import { loadRecordsForProject } from '@/features/records/domain/recordingsLoader';

const asEnabledFlag = (value: unknown): boolean => {
  if (value === true) return true;
  if (value === false || value == null) return false;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes' || v === 'on';
  }
  return false;
};

const normalizePlayToEnd = (stimulus: Partial<ExtendedStimulus>): boolean => {
  if (stimulus.stimulusType !== 'video' && stimulus.stimulusType !== 'audio') return false;
  const raw = stimulus.playToEnd;
  if (raw == null) return true;
  return asEnabledFlag(raw);
};

const idLikeNamePattern = /^(?:stim|combo)_\d+_[a-z0-9]+$/i;

const extractBaseName = (value: string): string => {
  const normalized = value.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
};

const canonicalStimulusUrlKey = (value: unknown): string => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;

  const clean = raw.replace(/^local-resource:/i, 'file:').split('?')[0].split('#')[0];
  try {
    const parsed = new URL(clean);
    if (parsed.protocol === 'file:') {
      const base = extractBaseName(decodeURIComponent(parsed.pathname || '')).toLowerCase();
      if (base) return `file:${base}`;
    }
  } catch {
  }

  const normalized = clean.replace(/\\/g, '/');
  const base = extractBaseName(decodeURIComponent(normalized)).toLowerCase();
  return base ? `file:${base}` : raw;
};

const isComboInternalUrl = (value: unknown): boolean => {
  const key = canonicalStimulusUrlKey(value);
  if (!key || key.startsWith('http://') || key.startsWith('https://')) return false;
  const base = extractBaseName(key.replace(/^file:/i, '')).replace(/\.[^/.]+$/, '').toLowerCase();
  return /^combo_\d+_[a-z0-9]+$/i.test(base);
};

const buildStimulusRepeatFingerprint = (stimulus: ExtendedStimulus): string => {
  const comboItems = Array.isArray(stimulus.comboItems)
    ? stimulus.comboItems.map((item) => {
      const legacyItem = item as unknown as Record<string, unknown>;
      return {
        kind: String(legacyItem.kind ?? ''),
        type: String(item.type ?? ''),
        label: String(legacyItem.label ?? '').trim(),
        text: String(item.text ?? ''),
        url: canonicalStimulusUrlKey(item.url),
        width: legacyItem.width ?? item.widthPct ?? null,
        height: legacyItem.height ?? item.heightPct ?? null,
        x: legacyItem.x ?? item.centerXPct ?? null,
        y: legacyItem.y ?? item.centerYPct ?? null,
        zIndex: legacyItem.zIndex ?? null,
      };
    })
    : [];
  return JSON.stringify({
    name: String(stimulus?.name ?? '').trim(),
    stimulusType: String(stimulus?.stimulusType ?? ''),
    url: canonicalStimulusUrlKey(stimulus.url),
    text: String(stimulus.text ?? ''),
    bgColor: String(stimulus.bgColor ?? ''),
    fontSize: stimulus.fontSize ?? null,
    fontColor: String(stimulus.fontColor ?? ''),
    group: String(stimulus.group ?? '').trim(),
    fixedTimeMs: stimulus.fixedTimeMs ?? null,
    active: stimulus.active !== false,
    randomPlay: asEnabledFlag(stimulus.randomPlay),
    endOnClick: asEnabledFlag(stimulus.endOnClick),
    endOnKey: asEnabledFlag(stimulus.endOnKey),
    playToEnd: normalizePlayToEnd(stimulus),
    triggerEnabled: asEnabledFlag(stimulus.triggerEnabled),
    triggerMark: stimulus.triggerMark ?? null,
    groupPlayMode: stimulus.groupPlayMode ?? null,
    groupRandomCount: stimulus.groupRandomCount ?? null,
    groupRepeatCount: stimulus.groupRepeatCount ?? null,
    groupInternalOrder: stimulus.groupInternalOrder ?? null,
    externalMarker: stimulus.externalMarker ?? null,
    comboCanvasStyle: stimulus.comboCanvasStyle ?? null,
    comboItems,
  });
};

const collapseRepeatedStimulusBlocks = (stimuli: ExtendedStimulus[]): ExtendedStimulus[] => {
  if (stimuli.length < 2) return stimuli;
  let current = stimuli.slice();
  while (true) {
    const fingerprints = current.map((item) => buildStimulusRepeatFingerprint(item));
    let next: ExtendedStimulus[] | null = null;
    outer: for (let start = 0; start < current.length - 1; start += 1) {
      const maxBlockSize = Math.floor((current.length - start) / 2);
      for (let blockSize = 1; blockSize <= maxBlockSize; blockSize += 1) {
        let repeatCount = 1;
        while (start + (repeatCount + 1) * blockSize <= current.length) {
          let matched = true;
          for (let offset = 0; offset < blockSize; offset += 1) {
            if (fingerprints[start + offset] !== fingerprints[start + repeatCount * blockSize + offset]) {
              matched = false;
              break;
            }
          }
          if (!matched) break;
          repeatCount += 1;
        }
        if (repeatCount > 1) {
          next = [
            ...current.slice(0, start),
            ...current.slice(start, start + blockSize),
            ...current.slice(start + repeatCount * blockSize),
          ];
          break outer;
        }
      }
    }
    if (!next) break;
    current = next;
  }
  return current;
};

const removeIdLikeStimulusDuplicates = (stimuli: ExtendedStimulus[]): ExtendedStimulus[] => {
  const grouped = new Map<string, ExtendedStimulus[]>();
  for (const stimulus of stimuli) {
    const urls = [
      stimulus.url,
      ...(Array.isArray(stimulus.comboItems)
        ? stimulus.comboItems.map((item) => item.url)
        : []),
    ];
    for (const url of urls) {
      const key = canonicalStimulusUrlKey(url);
      if (!key || key.startsWith('http://') || key.startsWith('https://')) continue;
      const list = grouped.get(key) || [];
      list.push(stimulus);
      grouped.set(key, list);
    }
  }

  const removeIds = new Set<string>();
  grouped.forEach((list) => {
    if (list.length <= 1) return;
    const idLikeItems = list.filter((item) => idLikeNamePattern.test(String(item?.name || '').trim()));
    const namedItems = list.filter((item) => !idLikeNamePattern.test(String(item?.name || '').trim()));
    if (idLikeItems.length > 0 && namedItems.length > 0) {
      idLikeItems.forEach((item) => {
        if (item?.id) removeIds.add(item.id);
      });
    }
  });

  for (const stimulus of stimuli) {
    if (stimulus?.stimulusType === 'combo') continue;
    if (!isComboInternalUrl(stimulus.url)) continue;
    const id = typeof stimulus?.id === 'string' ? stimulus.id : '';
    if (id) removeIds.add(id);
  }

  if (removeIds.size === 0) return stimuli;
  return stimuli.filter((item) => !removeIds.has(item.id));
};

export async function loadProjectsFromRoot(params: {
  rootPath: string;
  setProjects: React.Dispatch<React.SetStateAction<Project[]>>;
  setProjectDirs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}): Promise<void> {
  const { rootPath, setProjects, setProjectDirs } = params;
  try {
    const result = await ipcClient.loadProjects({ rootPath });
    if (result && result.ok && Array.isArray(result.projects)) {
      setProjects(result.projects);
      if (result.projectDirs && typeof result.projectDirs === 'object') {
        setProjectDirs(result.projectDirs);
      }
    }
  } catch (error) {
    console.error(error);
  }
}

export async function loadProjectDetailData(params: {
  projectDir: string;
  setSubjects: React.Dispatch<React.SetStateAction<Subject[]>>;
  setSubjectFields: React.Dispatch<React.SetStateAction<SubjectFieldDef[]>>;
  setStimuli: React.Dispatch<React.SetStateAction<ExtendedStimulus[]>>;
  setRecords: React.Dispatch<React.SetStateAction<RecordingRecord[]>>;
  setCustomMarkers?: React.Dispatch<React.SetStateAction<CustomMarker[]>>;
}): Promise<void> {
  const { projectDir, setSubjects, setSubjectFields, setStimuli, setRecords, setCustomMarkers } = params;
  // #region debug-point C:renderer-load-project-detail-enter
  void ipcClient.videoDebugLog({
    event: 'stimuli-duplicate:renderer-load-project-detail-enter',
    details: { projectDir },
  });
  // #endregion

  const subjectsResult = await ipcClient.loadSubjects({ projectDir });
  if (subjectsResult && subjectsResult.ok && Array.isArray(subjectsResult.subjects)) {
    setSubjects(subjectsResult.subjects);
  } else {
    setSubjects([]);
  }

  const fieldsResult = await ipcClient.loadSubjectFields({ projectDir });
  if (fieldsResult && fieldsResult.ok && Array.isArray(fieldsResult.fields) && fieldsResult.fields.length > 0) {
    setSubjectFields(fieldsResult.fields);
  }

  try {
    const stimuliResult = await ipcClient.loadStimuli({ projectDir });
    // #region debug-point C:renderer-load-stimuli-result
    void ipcClient.videoDebugLog({
      event: 'stimuli-duplicate:renderer-load-stimuli-result',
      details: {
        projectDir,
        ok: !!stimuliResult?.ok,
        count: Array.isArray(stimuliResult?.stimuli) ? stimuliResult.stimuli.length : -1,
        names: Array.isArray(stimuliResult?.stimuli)
          ? stimuliResult.stimuli.slice(0, 20).map((item) => {
            const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
            return String(record.name ?? '');
          })
          : [],
      },
    });
    // #endregion
    if (stimuliResult && stimuliResult.ok && Array.isArray(stimuliResult.stimuli)) {
      const normalizedFlags = (stimuliResult.stimuli as ExtendedStimulus[]).map((s) => ({
        ...s,
        randomPlay: asEnabledFlag(s.randomPlay),
        endOnClick: asEnabledFlag(s.endOnClick),
        endOnKey: asEnabledFlag(s.endOnKey),
        playToEnd: normalizePlayToEnd(s),
      }));
      // Ensure all group members have groupInternalOrder set
      const stimuliWithOrder = ensureGroupInternalOrder(normalizedFlags);
      const dedupedStimuli = removeIdLikeStimulusDuplicates(stimuliWithOrder);
      const collapsedStimuli = collapseRepeatedStimulusBlocks(dedupedStimuli).map((item, idx) => ({
        ...item,
        order: idx + 1,
      }));
      // #region debug-point C:renderer-set-stimuli
      void ipcClient.videoDebugLog({
        event: 'stimuli-duplicate:renderer-set-stimuli',
        details: {
          projectDir,
          count: collapsedStimuli.length,
          names: collapsedStimuli.slice(0, 20).map((item) => String(item?.name ?? '')),
        },
      });
      // #endregion
      setStimuli(collapsedStimuli);
    } else {
      setStimuli([]);
      console.error('Failed to load stimuli:', stimuliResult);
    }
  } catch (error) {
    console.error('Error invoking load-stimuli IPC:', error);
    setStimuli([]);
  }

  await loadRecordsForProject({ projectDir, setRecords });

  // 加载自定义标记
  if (setCustomMarkers) {
    try {
      const markersResult = await ipcClient.loadCustomMarkers({ projectDir });
      if (markersResult && markersResult.ok && Array.isArray(markersResult.markers)) {
        setCustomMarkers(markersResult.markers as CustomMarker[]);
      } else {
        setCustomMarkers([]);
      }
    } catch (error) {
      console.error('Error loading custom markers:', error);
      setCustomMarkers([]);
    }
  }
}

/**
 * 确保所有组成员都有groupInternalOrder
 * 如果没有设置，则按照order字段排序后分配
 */
function ensureGroupInternalOrder(stimuli: ExtendedStimulus[]): ExtendedStimulus[] {
  // 找出所有组
  const groups = new Set<string>();
  stimuli.forEach(s => {
    if (s.group) {
      groups.add(s.group);
    }
  });

  // 为每个组的成员分配groupInternalOrder
  const result = [...stimuli];
  groups.forEach(groupName => {
    const members = result.filter(s => s.group === groupName);
    
    // 按order排序（如果有的话），否则保持原顺序
    members.sort((a, b) => {
      if (a.order !== undefined && b.order !== undefined) {
        return a.order - b.order;
      }
      return 0;
    });
    
    // 为没有groupInternalOrder的成员分配
    members.forEach((member, index) => {
      const stimIndex = result.findIndex(s => s.id === member.id);
      if (stimIndex >= 0 && result[stimIndex].groupInternalOrder === undefined) {
        result[stimIndex] = {
          ...result[stimIndex],
          groupInternalOrder: index + 1
        };
      }
    });
  });

  return result;
}
