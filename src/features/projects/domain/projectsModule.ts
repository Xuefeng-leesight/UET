import type React from 'react';
import type { Project } from '@shared/contracts/domain/models';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import { deviceTypeFromModel, normalizeDeviceModel } from '@/features/recording/device/deviceProfile';
import { PROJECT_SCHEMA_VERSION, type ProjectModality } from '@shared/contracts/domain/models';
import { createEmptyProjectDraft, type NewProjectData } from './projectDraft';


export async function createProject(params: {
  newProjectData: NewProjectData;
  projects: Project[];
  setProjects: React.Dispatch<React.SetStateAction<Project[]>>;
  setIsNewProjectModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setNewProjectData: React.Dispatch<React.SetStateAction<NewProjectData>>;
  projectRootPath: string | null;
}): Promise<{ project: Project; projectDir?: string } | null> {
  const { newProjectData, projects, setProjects, setIsNewProjectModalOpen, setNewProjectData, projectRootPath } = params;
  if (!projectRootPath || !projectRootPath.trim()) {
    alert('请先选择“项目存储路径”');
    return null;
  }
  if (!newProjectData.name.trim() || !newProjectData.code.trim()) {
    alert('请填写完整的工程信息');
    return null;
  }
  if (newProjectData.selectedModalities.length === 0) {
    alert('请至少选择一种工程模态');
    return null;
  }
  const deviceModel = normalizeDeviceModel(newProjectData.deviceModel, newProjectData.deviceType);
  const modalities: ProjectModality[] = newProjectData.selectedModalities.map((id) => id === 'eye-tracking'
    ? { id, enabled: true, config: { deviceType: deviceTypeFromModel(deviceModel), deviceModel } }
    : { id, enabled: true, config: { width: newProjectData.facialWidth, height: newProjectData.facialHeight, fps: newProjectData.facialFps } });
  const hasEyeTracking = newProjectData.selectedModalities.includes('eye-tracking');
  const newProj: Project = {
    id: Date.now().toString(),
    name: newProjectData.name.trim(),
    code: newProjectData.code.trim(),
    manager: newProjectData.manager.trim() || '未指定',
    deviceType: hasEyeTracking ? deviceTypeFromModel(deviceModel) : undefined,
    deviceModel: hasEyeTracking ? deviceModel : undefined,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    modalities,
    updatedAt: new Date().toLocaleString(),
    notes: '',
  };
  try {
    const result = await ipcClient.initProjectStructure({ rootPath: projectRootPath, project: newProj });
    if (result && result.ok && result.projectDir) {
      setProjects([newProj, ...projects]);
      setIsNewProjectModalOpen(false);
      setNewProjectData(createEmptyProjectDraft());
      return { project: newProj, projectDir: result.projectDir };
    }
    alert(result?.message || '创建工程失败，请检查项目存储路径');
  } catch (error) {
    console.error(error);
    alert('创建工程失败，请稍后重试');
  }
  return null;
}
