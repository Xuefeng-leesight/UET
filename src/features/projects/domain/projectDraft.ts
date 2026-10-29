import type { ModalityId } from '@shared/contracts/domain/models';
import type { DeviceModel, DeviceType } from '@/features/recording/device/deviceProfile';

export type NewProjectData = {
  name: string;
  code: string;
  manager: string;
  selectedModalities: ModalityId[];
  deviceType: DeviceType;
  deviceModel: DeviceModel;
  facialWidth: number;
  facialHeight: number;
  facialFps: number;
};

export const createEmptyProjectDraft = (): NewProjectData => ({
  name: '',
  code: '',
  manager: '',
  selectedModalities: ['eye-tracking'],
  deviceType: '桌面式',
  deviceModel: 'Pro',
  facialWidth: 1280,
  facialHeight: 720,
  facialFps: 30,
});

