export * from '@/infrastructure/electron/ipcTypes';
import { projectsIpcClient } from '@/infrastructure/electron/clients/projectsClient';
import { stimuliIpcClient } from '@/infrastructure/electron/clients/stimuliClient';
import { recordsIpcClient } from '@/infrastructure/electron/clients/recordsClient';
import { exportsIpcClient } from '@/infrastructure/electron/clients/exportsClient';
import { mappingIpcClient } from '@/infrastructure/electron/clients/mappingClient';
import { reportsIpcClient } from '@/infrastructure/electron/clients/reportsClient';
import { recordingIpcClient } from '@/infrastructure/electron/clients/recordingClient';
import { triggerIpcClient } from '@/infrastructure/electron/clients/triggerClient';
import { multiplayerIpcClient } from '@/infrastructure/electron/clients/multiplayerClient';
import { facialIpcClient } from '@/infrastructure/electron/clients/facialClient';
import { systemIpcClient } from '@/infrastructure/electron/clients/systemClient';
import { licensingIpcClient } from '@/infrastructure/electron/clients/licensingClient';

export const ipcClient = {
  ...projectsIpcClient,
  ...stimuliIpcClient,
  ...recordsIpcClient,
  ...exportsIpcClient,
  ...mappingIpcClient,
  ...reportsIpcClient,
  ...recordingIpcClient,
  ...triggerIpcClient,
  ...multiplayerIpcClient,
  ...facialIpcClient,
  ...systemIpcClient,
  ...licensingIpcClient,
};
