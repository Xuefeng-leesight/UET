import {
  PROJECT_SCHEMA_VERSION,
  type ModalityId,
  type Project,
  type ProjectModality,
} from '../contracts/domain/models';

const EYE_MODELS = new Set(['Pro', 'A8', 'aSeeGlassesPlus', 'PupilCore', 'HH_ET10C', 'HH_ET28']);

export const createEyeTrackingModality = (
  deviceModel: unknown = 'Pro',
  deviceType: unknown = '桌面式',
): ProjectModality => {
  const model = EYE_MODELS.has(String(deviceModel))
    ? String(deviceModel) as 'Pro' | 'A8' | 'aSeeGlassesPlus' | 'PupilCore' | 'HH_ET10C' | 'HH_ET28'
    : deviceType === '眼镜式' ? 'aSeeGlassesPlus' : 'Pro';
  return {
    id: 'eye-tracking',
    enabled: true,
    config: {
      deviceModel: model,
      deviceType: model === 'aSeeGlassesPlus' || model === 'PupilCore' || model === 'HH_ET28' ? '眼镜式' : '桌面式',
    },
  };
};

export const createFacialExpressionModality = (config: Record<string, unknown> = {}): ProjectModality => ({
  id: 'facial-expression',
  enabled: true,
  config: {
    width: Number.isFinite(Number(config.width)) ? Number(config.width) : 1280,
    height: Number.isFinite(Number(config.height)) ? Number(config.height) : 720,
    fps: Number.isFinite(Number(config.fps)) ? Number(config.fps) : 30,
  },
});

export function normalizeProjectModalities(project: Partial<Project> | Record<string, unknown> | null | undefined): ProjectModality[] {
  // A missing project has no modalities; return empty rather than the
  // version-1 eye-tracking default (which only applies to real projects).
  if (!project) return [];
  const source = Array.isArray(project.modalities) ? project.modalities : [];
  const normalized: ProjectModality[] = [];
  for (const entry of source) {
    if (!entry || typeof entry !== 'object' || entry.enabled === false) continue;
    if (entry.id === 'eye-tracking') {
      normalized.push(createEyeTrackingModality(entry.config?.deviceModel, entry.config?.deviceType));
    } else if (entry.id === 'facial-expression') {
      normalized.push(createFacialExpressionModality(entry.config || {}));
    }
  }
  // Version 1 projects were all eye-tracking projects.
  if (normalized.length === 0) {
    normalized.push(createEyeTrackingModality(project.deviceModel, project.deviceType));
  }
  return normalized;
}

export function migrateProject(project: Project): Project {
  const modalities = normalizeProjectModalities(project);
  const eye = modalities.find((item) => item.id === 'eye-tracking');
  return {
    ...project,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    modalities,
    // Keep legacy fields during the compatibility window for SDK selection.
    deviceType: eye?.id === 'eye-tracking' ? eye.config.deviceType : project.deviceType,
    deviceModel: eye?.id === 'eye-tracking' ? eye.config.deviceModel : project.deviceModel,
  };
}

export const projectHasModality = (project: Partial<Project> | null | undefined, id: ModalityId): boolean =>
  project ? normalizeProjectModalities(project).some((item) => item.id === id) : false;
