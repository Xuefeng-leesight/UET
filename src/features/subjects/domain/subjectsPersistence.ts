import { ipcClient } from '@/infrastructure/electron/ipcClient';
import type { Subject } from '@shared/contracts/domain/models';
import type { SubjectFieldDef } from '@/shared/types/mrt';

export function persistSubjects(params: {
  projectDir: string | null;
  subjects: Subject[];
}): void {
  const { projectDir, subjects } = params;
  if (!projectDir) {
    return;
  }
  try {
    ipcClient.saveSubjects({ projectDir, subjects }).catch((error: unknown) => {
      console.error(error);
    });
  } catch (error) {
    console.error(error);
  }
}

export function persistSubjectFields(params: {
  projectDir: string | null;
  fields: SubjectFieldDef[];
}): void {
  const { projectDir, fields } = params;
  if (!projectDir) {
    return;
  }
  try {
    ipcClient.saveSubjectFields({ projectDir, fields }).catch((error: unknown) => {
      console.error(error);
    });
  } catch (error) {
    console.error(error);
  }
}
