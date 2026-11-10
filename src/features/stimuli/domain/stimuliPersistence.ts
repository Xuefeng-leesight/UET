import { ipcClient } from '@/infrastructure/electron/ipcClient';
import type { ExtendedStimulus } from '@/shared/types/mrt';

export function persistStimuli(params: {
  activeProjectId: string | null;
  projectDirs: Record<string, string>;
  stimuli: ExtendedStimulus[];
}): void {
  const { activeProjectId, projectDirs, stimuli } = params;
  if (!activeProjectId) {
    return;
  }
  const projectDir = projectDirs[activeProjectId];
  if (!projectDir) {
    return;
  }
  try {
    ipcClient.saveStimuli({ projectDir, stimuli }).catch((error: unknown) => {
      console.error(error);
    });
  } catch (error) {
    console.error(error);
  }
}
