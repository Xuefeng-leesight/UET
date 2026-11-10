export type ProjectImportPhase = 'preparing' | 'transcoding' | 'refreshing' | 'done' | 'failed';

export interface ProjectImportStatus {
  taskId: string;
  projectDir: string;
  projectName: string;
  phase: ProjectImportPhase;
  progress: number;
  label: string;
  detail?: string;
  currentFile?: string;
  total?: number;
  completed?: number;
  compatible?: number;
  transcoded?: number;
  failed?: number;
  updatedAt: number;
}
