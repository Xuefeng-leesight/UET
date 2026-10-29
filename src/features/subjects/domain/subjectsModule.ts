import type React from 'react';
import type { Subject } from '@shared/contracts/domain/models';
import type { ConfirmState, SubjectFieldDef } from '@/shared/types/mrt';
import type { SubjectDraft } from '@/app/workspace/useMrtEditorState';

const normalizeNameForCompare = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();

export function createSubject(params: {
  newSubjectData: SubjectDraft;
  subjectFields: SubjectFieldDef[];
  subjects: Subject[];
  setSubjects: React.Dispatch<React.SetStateAction<Subject[]>>;
  setIsNewSubjectModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setNewSubjectData: React.Dispatch<React.SetStateAction<SubjectDraft>>;
  onNotify?: (message: string) => void;
}): void {
  const { newSubjectData, subjectFields, subjects, setSubjects, setIsNewSubjectModalOpen, setNewSubjectData, onNotify } = params;
  const nextName = String(newSubjectData.name || '').trim();
  const nextAge = String(newSubjectData.age || '').trim();
  if (!nextName || !nextAge) {
    if (onNotify) onNotify('请填写完整的受试者信息');
    else alert('请填写完整的受试者信息');
    return;
  }
  const normalizedNextName = normalizeNameForCompare(nextName);
  if (normalizedNextName && subjects.some((subject) => normalizeNameForCompare(subject.name ?? subject.姓名) === normalizedNextName)) {
    if (onNotify) onNotify(`受试者名称「${nextName}」已存在，请使用其他名称`);
    else alert(`受试者名称「${nextName}」已存在，请使用其他名称`);
    return;
  }
  const newSub: Subject = {
    id: `s${Date.now()}`,
    name: nextName,
    gender: newSubjectData.gender,
    age: nextAge,
    姓名: nextName,
    性别: newSubjectData.gender,
    年龄: nextAge,
  };
  subjectFields
    .filter((field) => !field.builtin)
    .forEach((field) => {
      const value = newSubjectData[field.label];
      if (typeof value === 'undefined') {
        return;
      }
      newSub[field.label] = value;
    });
  setSubjects([newSub, ...subjects]);
  setIsNewSubjectModalOpen(false);
  setNewSubjectData({ name: '', gender: '男', age: '' });
}

export function openEditSubject(params: {
  subject: Subject;
  subjectFields: SubjectFieldDef[];
  setEditingSubjectId: React.Dispatch<React.SetStateAction<string | null>>;
  setEditSubjectData: React.Dispatch<React.SetStateAction<SubjectDraft>>;
  setIsEditSubjectModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
}): void {
  const { subject, subjectFields, setEditingSubjectId, setEditSubjectData, setIsEditSubjectModalOpen } = params;
  setEditingSubjectId(subject.id);
  const data: SubjectDraft = {
    name: subject.name ?? '',
    gender: subject.gender ?? '男',
    age: subject.age ?? '',
  };
  subjectFields
    .filter((field) => !field.builtin)
    .forEach((field) => {
      data[field.label] = subject[field.label] ?? '';
    });
  setEditSubjectData(data);
  setIsEditSubjectModalOpen(true);
}

export function saveEditedSubject(params: {
  editSubjectData: SubjectDraft;
  editingSubjectId: string | null;
  subjects: Subject[];
  subjectFields: SubjectFieldDef[];
  setSubjects: React.Dispatch<React.SetStateAction<Subject[]>>;
  setIsEditSubjectModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setEditingSubjectId: React.Dispatch<React.SetStateAction<string | null>>;
  onNotify?: (message: string) => void;
}): void {
  const { editSubjectData, editingSubjectId, subjects, subjectFields, setSubjects, setIsEditSubjectModalOpen, setEditingSubjectId, onNotify } = params;
  const nextName = String(editSubjectData.name || '').trim();
  const nextAge = String(editSubjectData.age || '').trim();
  if (!nextName || !nextAge) {
    if (onNotify) onNotify('请填写完整的受试者信息');
    else alert('请填写完整的受试者信息');
    return;
  }
  const normalizedNextName = normalizeNameForCompare(nextName);
  if (
    normalizedNextName &&
    subjects.some(
      (subject) =>
        subject.id !== editingSubjectId &&
        normalizeNameForCompare(subject.name ?? subject.姓名) === normalizedNextName,
    )
  ) {
    if (onNotify) onNotify(`受试者名称「${nextName}」已存在，请使用其他名称`);
    else alert(`受试者名称「${nextName}」已存在，请使用其他名称`);
    return;
  }
  setSubjects((prev) =>
    prev.map((s) => {
      if (!editingSubjectId || s.id !== editingSubjectId) {
        return s;
      }
      const updated: Subject = {
        ...s,
        name: nextName,
        gender: editSubjectData.gender,
        age: nextAge,
        姓名: nextName,
        性别: editSubjectData.gender,
        年龄: nextAge,
      };
      subjectFields
        .filter((field) => !field.builtin)
        .forEach((field) => {
          const value = editSubjectData[field.label];
          if (typeof value === 'undefined') {
            delete updated[field.label];
          } else {
            updated[field.label] = value;
          }
        });
      return updated;
    }),
  );
  setIsEditSubjectModalOpen(false);
  setEditingSubjectId(null);
}

export function requestDeleteSubject(params: {
  subject: Subject;
  setConfirmState: React.Dispatch<React.SetStateAction<ConfirmState>>;
  setSubjects: React.Dispatch<React.SetStateAction<Subject[]>>;
}): void {
  const { subject, setConfirmState, setSubjects } = params;
  const name = subject.name || subject.姓名 || '';
  setConfirmState({
    open: true,
    title: '删除受试者',
    message: name ? `确定要删除受试者「${name}」吗？此操作不可撤销。` : '确定要删除该受试者吗？此操作不可撤销。',
    onConfirm: () => {
      setSubjects((prev) => prev.filter((item) => item.id !== subject.id));
    },
  });
}
