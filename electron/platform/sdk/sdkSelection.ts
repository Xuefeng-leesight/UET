import {
  DEFAULT_SDK_MODEL,
  DESKTOP_SDK_MODELS,
  GLASSES_SDK_MODEL,
  getSdkContainerPath as resolveSdkContainerPath,
  resolveSdkPaths as resolveSdkRuntimePaths,
  type SdkRuntimeContext,
} from './sdkRuntime'

export function createSdkSelection(context: SdkRuntimeContext) {
  const getSdkContainerPath = (): string => resolveSdkContainerPath(context)
  const resolveSdkPaths = (preferredModel?: string) => resolveSdkRuntimePaths(context, preferredModel)
  const getSdkRootPath = (): string => resolveSdkPaths(process.env.MRT_SDK_MODEL || DEFAULT_SDK_MODEL).sdkRoot
  const getSdkTypesPath = (): string => resolveSdkPaths(process.env.MRT_SDK_MODEL || DEFAULT_SDK_MODEL).typesDir

  const normalizeProjectDeviceType = (value: unknown): '桌面式' | '眼镜式' =>
    String(value ?? '').trim() === '眼镜式' ? '眼镜式' : '桌面式'

  const normalizeSdkModelName = (value: unknown): string => {
    const normalized = String(value ?? '').trim().toLowerCase()
    if (normalized === 'hh_et10c') return 'HH_ET10C'
    if (normalized === 'hh_et28') return 'HH_ET28'
    if (normalized === 'pupilcore' || normalized === 'pupil-core') return 'PupilCore'
    if (normalized === 'a8' || normalized === 'asee_a8' || normalized === 'asee-a8') return 'A8'
    if (normalized === 'pro' || normalized === 'pro200' || normalized === 'desktop') return 'Pro'
    if (
      normalized === 'aseeglassesplus' ||
      normalized === 'asee_glasses_plus' ||
      normalized === 'asee-glasses-plus' ||
      normalized === 'glassesplus'
    ) return GLASSES_SDK_MODEL
    return DEFAULT_SDK_MODEL
  }

  const normalizeProjectDeviceModel = (value: unknown, deviceType?: unknown): string => {
    const model = normalizeSdkModelName(value)
    if (['PupilCore', 'HH_ET10C', 'HH_ET28'].includes(model)) return model
    if (normalizeProjectDeviceType(deviceType) === '眼镜式') return GLASSES_SDK_MODEL
    return DESKTOP_SDK_MODELS.has(model) ? model : DEFAULT_SDK_MODEL
  }

  let preferredDesktopSdkModel = DESKTOP_SDK_MODELS.has(normalizeSdkModelName(process.env.MRT_SDK_MODEL))
    ? normalizeSdkModelName(process.env.MRT_SDK_MODEL)
    : DEFAULT_SDK_MODEL

  const modelFromDeviceType = (value: unknown, requestedModel?: unknown): string => {
    const explicit = normalizeSdkModelName(requestedModel)
    if (['PupilCore', 'HH_ET10C', 'HH_ET28'].includes(explicit)) return explicit
    if (normalizeProjectDeviceType(value) === '眼镜式') return GLASSES_SDK_MODEL
    const normalizedRequestedModel = normalizeSdkModelName(requestedModel)
    if (DESKTOP_SDK_MODELS.has(normalizedRequestedModel)) {
      preferredDesktopSdkModel = normalizedRequestedModel
      return normalizedRequestedModel
    }
    const currentModel = normalizeSdkModelName(process.env.MRT_SDK_MODEL)
    if (DESKTOP_SDK_MODELS.has(currentModel)) preferredDesktopSdkModel = currentModel
    return preferredDesktopSdkModel
  }

  const applyPreferredSdkModelForProject = (value: unknown, requestedModel?: unknown): void => {
    const nextModel = modelFromDeviceType(value, requestedModel)
    const previousModel = normalizeSdkModelName(process.env.MRT_SDK_MODEL)
    if (previousModel !== nextModel) {
      delete process.env.MRT_SDK_ROOT
      delete process.env.MRT_TYPES_DIR
    }
    process.env.MRT_SDK_MODEL = nextModel
    console.log('[sdk] preferred model updated from project', {
      deviceType: normalizeProjectDeviceType(value),
      model: nextModel,
      clearedStalePathOverrides: previousModel !== nextModel,
    })
  }

  return {
    getSdkContainerPath,
    resolveSdkPaths,
    getSdkRootPath,
    getSdkTypesPath,
    normalizeProjectDeviceType,
    normalizeSdkModelName,
    normalizeProjectDeviceModel,
    modelFromDeviceType,
    applyPreferredSdkModelForProject,
  }
}
