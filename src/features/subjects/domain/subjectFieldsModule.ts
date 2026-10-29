import type { SubjectFieldDef } from '@/shared/types/mrt';

export function removeSubjectField(fields: SubjectFieldDef[], id: string): SubjectFieldDef[] {
  return fields.filter((f) => f.id !== id);
}

export function addSubjectField(fields: SubjectFieldDef[], labelRaw: string): { ok: boolean; next: SubjectFieldDef[]; error?: string } {
  const label = (labelRaw || '').trim();
  if (!label) {
    return { ok: false, next: fields, error: '请填写字段名称' };
  }
  if (fields.some((f) => f.label === label)) {
    return { ok: false, next: fields, error: '该字段名称已存在' };
  }
  const id = `custom_${Date.now()}`;
  return { ok: true, next: [...fields, { id, label }] };
}

