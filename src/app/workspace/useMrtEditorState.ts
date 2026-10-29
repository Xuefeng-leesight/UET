import { useState } from 'react';
import type { ConfirmState, ComboStimulusItem, SubjectFieldDef } from '@/shared/types/mrt';
import { createEmptyProjectDraft, type NewProjectData } from '@/features/projects/domain/projectDraft';

export type SubjectDraft = { name: string; gender: string; age: string; [key: string]: unknown };
type StimulusKind = 'image' | 'video' | 'audio' | 'screen' | 'text' | 'web' | 'group' | 'combo';
type ComboCanvasStyle = 'fullscreen' | 'landscape' | 'classic' | 'square' | 'portrait';
type GroupPlayMode = 'all-sequential' | 'all-random' | 'random-sample' | 'repeat';

export function useMrtEditorState({
  isEnglish,
  defaultSubjectFields,
}: {
  isEnglish: boolean;
  defaultSubjectFields: SubjectFieldDef[];
}) {
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false);
  const [newProjectData, setNewProjectData] = useState<NewProjectData>(createEmptyProjectDraft);
  const [isNewExperimentModalOpen, setIsNewExperimentModalOpen] = useState(false);
  const [newExperimentName, setNewExperimentName] = useState('');
  const [isNewSubjectModalOpen, setIsNewSubjectModalOpen] = useState(false);
  const [newSubjectData, setNewSubjectData] = useState<SubjectDraft>({ name: '', gender: '男', age: '' });
  const [isFieldManagerOpen, setIsFieldManagerOpen] = useState(false);
  const [isEditSubjectModalOpen, setIsEditSubjectModalOpen] = useState(false);
  const [editingSubjectId, setEditingSubjectId] = useState<string | null>(null);
  const [editSubjectData, setEditSubjectData] = useState<SubjectDraft>({ name: '', gender: '男', age: '' });
  const [isEditStimulusModalOpen, setIsEditStimulusModalOpen] = useState(false);
  const [editingStimulusId, setEditingStimulusId] = useState<string | null>(null);
  const [editStimulusName, setEditStimulusName] = useState('');
  const [editStimulusNameLocked, setEditStimulusNameLocked] = useState(false);
  const [editStimulusFixedTimeSec, setEditStimulusFixedTimeSec] = useState('5');
  const [editStimulusActive, setEditStimulusActive] = useState(true);
  const [editStimulusBgColor, setEditStimulusBgColor] = useState('#000000');
  const [editStimulusFontSize, setEditStimulusFontSize] = useState(48);
  const [editStimulusFontColor, setEditStimulusFontColor] = useState('#ffffff');
  const [editStimulusText, setEditStimulusText] = useState('');
  const [editStimulusWebUrl, setEditStimulusWebUrl] = useState('');
  const [editStimulusExternalMarker, setEditStimulusExternalMarker] = useState(true);
  const [editStimulusEndOnClick, setEditStimulusEndOnClick] = useState(false);
  const [editStimulusEndOnKey, setEditStimulusEndOnKey] = useState(false);
  const [editStimulusGroup, setEditStimulusGroup] = useState('');
  const [editStimulusRandomPlay, setEditStimulusRandomPlay] = useState(false);
  const [editStimulusTriggerEnabled, setEditStimulusTriggerEnabled] = useState(false);
  const [editStimulusTriggerMark, setEditStimulusTriggerMark] = useState<number | null>(null);
  const [editStimulusGroupPlayMode, setEditStimulusGroupPlayMode] = useState<GroupPlayMode>('all-sequential');
  const [editStimulusGroupRandomCount, setEditStimulusGroupRandomCount] = useState(1);
  const [editStimulusGroupRepeatCount, setEditStimulusGroupRepeatCount] = useState(1);
  const [editStimulusPlayToEnd, setEditStimulusPlayToEnd] = useState(false);
  const [editStimulusComboItems, setEditStimulusComboItems] = useState<ComboStimulusItem[]>([]);
  const [editStimulusComboCanvasStyle, setEditStimulusComboCanvasStyle] = useState<ComboCanvasStyle>('landscape');
  const [isAddStimulusModalOpen, setIsAddStimulusModalOpen] = useState(false);
  const [addStimulusKind, setAddStimulusKind] = useState<StimulusKind>('image');
  const [addStimulusName, setAddStimulusName] = useState('');
  const [addStimulusText, setAddStimulusText] = useState('');
  const [addStimulusWebUrl, setAddStimulusWebUrl] = useState('');
  const [stimuliSaveHint, setStimuliSaveHint] = useState('');
  const [currentStimulusGroup, setCurrentStimulusGroup] = useState<string | null>(null);
  const [hydratingProjectId, setHydratingProjectId] = useState<string | null>(null);
  const [subjectFields, setSubjectFields] = useState<SubjectFieldDef[]>(defaultSubjectFields);
  const [projectRootPath, setProjectRootPath] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState>({
    open: false,
    title: '',
    message: '',
    onConfirm: null,
    showCancel: true,
    confirmText: isEnglish ? 'Confirm' : '确定',
  });

  return {
    isNewProjectModalOpen, setIsNewProjectModalOpen, newProjectData, setNewProjectData,
    isNewExperimentModalOpen, setIsNewExperimentModalOpen, newExperimentName, setNewExperimentName,
    isNewSubjectModalOpen, setIsNewSubjectModalOpen, newSubjectData, setNewSubjectData,
    isFieldManagerOpen, setIsFieldManagerOpen, isEditSubjectModalOpen, setIsEditSubjectModalOpen,
    editingSubjectId, setEditingSubjectId, editSubjectData, setEditSubjectData,
    isEditStimulusModalOpen, setIsEditStimulusModalOpen, editingStimulusId, setEditingStimulusId,
    editStimulusName, setEditStimulusName, editStimulusNameLocked, setEditStimulusNameLocked,
    editStimulusFixedTimeSec, setEditStimulusFixedTimeSec, editStimulusActive, setEditStimulusActive,
    editStimulusBgColor, setEditStimulusBgColor, editStimulusFontSize, setEditStimulusFontSize,
    editStimulusFontColor, setEditStimulusFontColor, editStimulusText, setEditStimulusText,
    editStimulusWebUrl, setEditStimulusWebUrl,
    editStimulusExternalMarker, setEditStimulusExternalMarker, editStimulusEndOnClick, setEditStimulusEndOnClick,
    editStimulusEndOnKey, setEditStimulusEndOnKey, editStimulusGroup, setEditStimulusGroup,
    editStimulusRandomPlay, setEditStimulusRandomPlay, editStimulusTriggerEnabled, setEditStimulusTriggerEnabled,
    editStimulusTriggerMark, setEditStimulusTriggerMark, editStimulusGroupPlayMode, setEditStimulusGroupPlayMode,
    editStimulusGroupRandomCount, setEditStimulusGroupRandomCount,
    editStimulusGroupRepeatCount, setEditStimulusGroupRepeatCount, editStimulusPlayToEnd, setEditStimulusPlayToEnd,
    editStimulusComboItems, setEditStimulusComboItems, editStimulusComboCanvasStyle, setEditStimulusComboCanvasStyle,
    isAddStimulusModalOpen, setIsAddStimulusModalOpen, addStimulusKind, setAddStimulusKind,
    addStimulusName, setAddStimulusName, addStimulusText, setAddStimulusText, addStimulusWebUrl, setAddStimulusWebUrl,
    stimuliSaveHint, setStimuliSaveHint, currentStimulusGroup, setCurrentStimulusGroup,
    hydratingProjectId, setHydratingProjectId, subjectFields, setSubjectFields,
    projectRootPath, setProjectRootPath, confirmState, setConfirmState,
  };
}
