import * as fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SDK_MODEL = 'Pro';
export const GLASSES_SDK_MODEL = 'aSeeGlassesPlus';
export const DESKTOP_SDK_MODELS = new Set(['Pro', 'A8']);
export const SUPPORTED_SDK_MODELS = new Set([...DESKTOP_SDK_MODELS, GLASSES_SDK_MODEL]);

const SDK_RUNTIME_FALLBACK_SUBDIR = path.join('bin', 'windows', 'x64', 'Pro200_Release');
const SDK_TYPES_FALLBACK_SUBDIR = path.join('samples', 'Pro200', 'python3');

export type SdkRuntimeContext = {
  isPackaged: boolean;
  resourcesPath: string;
  appDir: string;
};

export type ResolvedSdkPaths = {
  model: string;
  sdkRoot: string;
  typesDir: string;
  source: 'env' | 'model-dir' | 'legacy-layout' | 'fallback';
};

export function getSdkContainerPath(context: SdkRuntimeContext): string {
  const sdkBase = context.isPackaged
    ? path.join(context.resourcesPath, 'SDK')
    : path.resolve(context.appDir, '../SDK');
  return path.join(sdkBase, 'invensun_7');
}

export function isSdkRootPathValid(targetPath: string): boolean {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) return false;
    const iniCandidates = [
      path.join(targetPath, 'config.ini'),
      path.join(targetPath, 'config', 'config.ini'),
    ];
    return fs.existsSync(path.join(targetPath, 'aSeeX.dll'))
      && iniCandidates.some((iniPath) => fs.existsSync(iniPath));
  } catch {
    return false;
  }
}

export function isSdkTypesPathValid(targetPath: string): boolean {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) return false;
    return fs.existsSync(path.join(targetPath, '_7i_types.py'))
      || fs.existsSync(path.join(targetPath, 'sdk_types.py'));
  } catch {
    return false;
  }
}

function pushUniquePath(out: string[], candidate: string): void {
  const next = String(candidate || '').trim();
  if (next && !out.includes(next)) out.push(next);
}

export function collectRuntimePathCandidates(modelBase: string): string[] {
  const out: string[] = [];
  pushUniquePath(out, path.join(modelBase, 'bin'));
  pushUniquePath(out, path.join(modelBase, SDK_RUNTIME_FALLBACK_SUBDIR));
  const x64Base = path.join(modelBase, 'bin', 'windows', 'x64');
  const modelDigits = path.basename(modelBase).match(/(\d+)/)?.[1] || '';
  if (modelDigits) pushUniquePath(out, path.join(x64Base, `Pro${modelDigits}_Release`));

  try {
    const entries = fs.readdirSync(x64Base, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && /release/i.test(entry.name)) {
        pushUniquePath(out, path.join(x64Base, entry.name));
      }
    }
  } catch {}
  return out;
}

export function collectTypesPathCandidates(modelBase: string): string[] {
  const out: string[] = [];
  pushUniquePath(out, path.join(modelBase, 'samples', 'python3'));
  pushUniquePath(out, path.join(modelBase, SDK_TYPES_FALLBACK_SUBDIR));
  const samplesBase = path.join(modelBase, 'samples');
  const modelDigits = path.basename(modelBase).match(/(\d+)/)?.[1] || '';
  if (modelDigits) pushUniquePath(out, path.join(samplesBase, `Pro${modelDigits}`, 'python3'));
  pushUniquePath(out, path.join(samplesBase, 'python3'));

  try {
    const entries = fs.readdirSync(samplesBase, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) pushUniquePath(out, path.join(samplesBase, entry.name, 'python3'));
    }
  } catch {}
  return out;
}

function resolveModelSdkPaths(modelBase: string): { sdkRoot: string; typesDir: string } | null {
  const sdkRoot = collectRuntimePathCandidates(modelBase).find(isSdkRootPathValid);
  if (!sdkRoot) return null;
  const typesDir = collectTypesPathCandidates(modelBase).find(isSdkTypesPathValid);
  return typesDir ? { sdkRoot, typesDir } : null;
}

function buildSdkModelCandidates(
  context: SdkRuntimeContext,
  preferredModel: string | undefined,
  env: NodeJS.ProcessEnv,
): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    const next = String(value || '').trim();
    if (next && !out.includes(next)) out.push(next);
  };
  push(preferredModel);
  push(env.MRT_SDK_MODEL);
  push(DEFAULT_SDK_MODEL);
  try {
    const entries = fs.readdirSync(getSdkContainerPath(context), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && SUPPORTED_SDK_MODELS.has(entry.name)) push(entry.name);
    }
  } catch {}
  return out;
}

export function resolveSdkPaths(
  context: SdkRuntimeContext,
  preferredModel?: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSdkPaths {
  if (['HH_ET10C', 'HH_ET28'].includes(String(preferredModel || env.MRT_SDK_MODEL))) {
    throw new Error('Huahong SDK paths are owned by the isolated Huahong launcher');
  }
  const envSdkRoot = String(env.MRT_SDK_ROOT || '').trim();
  const envTypesDir = String(env.MRT_TYPES_DIR || '').trim();
  const envModel = String(env.MRT_SDK_MODEL || '').trim() || DEFAULT_SDK_MODEL;
  if (envSdkRoot && envTypesDir && isSdkRootPathValid(envSdkRoot) && isSdkTypesPathValid(envTypesDir)) {
    return { model: envModel, sdkRoot: envSdkRoot, typesDir: envTypesDir, source: 'env' };
  }

  const sdkContainer = getSdkContainerPath(context);
  const modelCandidates = buildSdkModelCandidates(context, preferredModel, env);
  for (const model of modelCandidates) {
    const resolved = resolveModelSdkPaths(path.join(sdkContainer, model));
    if (resolved) return { model, ...resolved, source: 'model-dir' };
  }

  const resolvedLegacy = resolveModelSdkPaths(sdkContainer);
  if (resolvedLegacy) {
    return { model: DEFAULT_SDK_MODEL, ...resolvedLegacy, source: 'legacy-layout' };
  }

  const fallbackModel = modelCandidates[0] || DEFAULT_SDK_MODEL;
  const fallbackBase = path.join(sdkContainer, fallbackModel);
  return {
    model: fallbackModel,
    sdkRoot: path.join(fallbackBase, SDK_RUNTIME_FALLBACK_SUBDIR),
    typesDir: path.join(fallbackBase, SDK_TYPES_FALLBACK_SUBDIR),
    source: 'fallback',
  };
}
