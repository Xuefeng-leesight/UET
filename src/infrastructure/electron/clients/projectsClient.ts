import { invokeSafe, invokeSafeNoPayload } from '@/infrastructure/electron/ipcCore';
import type { SelectProjectRootResult, InitProjectStructureResult, LoadProjectsResult, LoadSubjectsResult, SaveOkResult, LoadSubjectFieldsResult, SaveProjectMetaResult, BackupProjectResult, ExportProjectResult, DeleteProjectResult, SelectExistingProjectResult, LoadProjectMetaResult, SetActiveProjectDeviceTypeResult, ListExperimentsResult, CreateExperimentResult, DeleteExperimentResult } from '@/infrastructure/electron/ipcTypes';

export const projectsIpcClient = {
  selectProjectRoot: async (): Promise<SelectProjectRootResult> => {
    return invokeSafeNoPayload<SelectProjectRootResult>('select-project-root', { canceled: true });
  },

  initProjectStructure: async (payload: {
    rootPath: string;
    project: unknown;
  }): Promise<InitProjectStructureResult> => {
    return invokeSafe<InitProjectStructureResult>('init-project-structure', payload, { ok: false });
  },

  loadProjects: async (payload: {
    rootPath: string;
  }): Promise<LoadProjectsResult> => {
    return invokeSafe<LoadProjectsResult>('load-projects', payload, { ok: false, projects: [], projectDirs: {} });
  },

  saveProjectMeta: async (payload: { projectDir: string; project: unknown }): Promise<SaveProjectMetaResult> => {
    return invokeSafe<SaveProjectMetaResult>('save-project-meta', payload, { ok: false });
  },

  backupProject: async (payload: { projectDir: string }): Promise<BackupProjectResult> => {
    return invokeSafe<BackupProjectResult>('backup-project', payload, { ok: false });
  },

  exportProject: async (payload: { projectDir: string }): Promise<ExportProjectResult> => {
    return invokeSafe<ExportProjectResult>('export-project', payload, { ok: false });
  },

  deleteProject: async (payload: { projectDir: string }): Promise<DeleteProjectResult> => {
    return invokeSafe<DeleteProjectResult>('delete-project', payload, { ok: false });
  },

  selectExistingProject: async (): Promise<SelectExistingProjectResult> => {
    return invokeSafeNoPayload<SelectExistingProjectResult>('select-existing-project', { ok: false });
  },

  loadProjectMeta: async (payload: { projectDir: string }): Promise<LoadProjectMetaResult> => {
    return invokeSafe<LoadProjectMetaResult>('load-project-meta', payload, { ok: false });
  },

  setActiveProjectDeviceType: async (payload: { deviceType: '桌面式' | '眼镜式'; deviceModel?: 'Pro' | 'A8' | 'aSeeGlassesPlus' | 'PupilCore' | 'HH_ET10C' | 'HH_ET28'; projectDir?: string }): Promise<SetActiveProjectDeviceTypeResult> => {
    return invokeSafe<SetActiveProjectDeviceTypeResult>('set-active-project-device-type', payload, { ok: false });
  },

  listExperiments: async (payload: { projectDir: string }): Promise<ListExperimentsResult> => {
    return invokeSafe<ListExperimentsResult>('list-experiments', payload, { ok: false, experiments: [] });
  },

  createExperiment: async (payload: { projectDir: string; name: string }): Promise<CreateExperimentResult> => {
    return invokeSafe<CreateExperimentResult>('create-experiment', payload, { ok: false });
  },

  deleteExperiment: async (payload: { projectDir: string; experimentId: string }): Promise<DeleteExperimentResult> => {
    return invokeSafe<DeleteExperimentResult>('delete-experiment', payload, { ok: false });
  },

  loadSubjects: async (payload: { projectDir: string }): Promise<LoadSubjectsResult> => {
    return invokeSafe<LoadSubjectsResult>('load-subjects', payload, { ok: false, subjects: [] });
  },

  saveSubjects: async (payload: { projectDir: string; subjects: unknown[] }): Promise<SaveOkResult> => {
    return invokeSafe<SaveOkResult>('save-subjects', payload, { ok: false });
  },

  loadSubjectFields: async (
    payload: { projectDir: string }
  ): Promise<LoadSubjectFieldsResult> => {
    return invokeSafe<LoadSubjectFieldsResult>('load-subject-fields', payload, { ok: false, fields: [] });
  },

  saveSubjectFields: async (
    payload: { projectDir: string; fields: unknown[] }
  ): Promise<SaveOkResult> => {
    return invokeSafe<SaveOkResult>('save-subject-fields', payload, { ok: false });
  }
};
