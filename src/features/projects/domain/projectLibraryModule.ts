import { ipcClient } from '@/infrastructure/electron/ipcClient';
import { TERMINOLOGY } from '@/shared/constants/terminology';

export async function setupProjectLibrary(params: {
  setProjectRootPath: (path: string) => void;
}): Promise<void> {
  const { setProjectRootPath } = params;
  try {
    if (!ipcClient.isAvailable()) {
      alert(`当前环境不支持本地${TERMINOLOGY.PROJECT_STORAGE_PATH_SETTINGS.replace('设置', '')}，请在桌面版中使用`);
      return;
    }
    const result = await ipcClient.selectProjectRoot();
    if (!result || result.canceled || !('rootPath' in result)) {
      return;
    }
    const rootPath = result.rootPath;
    if (!rootPath) {
      return;
    }
    setProjectRootPath(rootPath);
    localStorage.setItem('projectRootPath', rootPath);
  } catch (error) {
    console.error(error);
    alert(`${TERMINOLOGY.PROJECT_STORAGE_PATH_SETTINGS}失败，请稍后重试`);
  }
}

export function restoreSavedProjectLibrary(params: {
  loadPinnedProjects: () => void;
  setProjectRootPath: (path: string) => void;
}): void {
  const { loadPinnedProjects, setProjectRootPath } = params;
  const savedPath = localStorage.getItem('projectRootPath');
  if (savedPath) {
    setProjectRootPath(savedPath);
    loadPinnedProjects();
  }
}
