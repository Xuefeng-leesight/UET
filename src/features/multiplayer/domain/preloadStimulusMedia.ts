import type { ExtendedStimulus } from '@/shared/types/mrt';
import { isStimulusAudioUrl, isStimulusVideoUrl } from '@/features/stimuli/domain/mediaTypes';

type MediaKind = 'image' | 'video' | 'audio';

export function collectPreloadTargets(stimuli: ExtendedStimulus[], limit = 8): Array<{ url: string; kind: MediaKind }> {
  const targets: Array<{ url: string; kind: MediaKind }> = [];
  const seen = new Set<string>();
  const append = (urlValue: unknown, typeValue: unknown) => {
    const url = String(urlValue || '').trim();
    if (!url || seen.has(url) || targets.length >= limit) return;
    const type = String(typeValue || '');
    const kind: MediaKind | null = type === 'video' || isStimulusVideoUrl(url)
      ? 'video'
      : type === 'audio' || isStimulusAudioUrl(url)
        ? 'audio'
        : type === 'image' || (!type && url)
          ? 'image'
          : null;
    if (!kind) return;
    seen.add(url);
    targets.push({ url, kind });
  };

  const ordered = stimuli
    .filter((stimulus) => stimulus.active !== false && stimulus.stimulusType !== 'group')
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
  for (const stimulus of ordered) {
    if (stimulus.stimulusType === 'combo') {
      for (const item of stimulus.comboItems || []) append(item.url, item.type);
    } else {
      append(stimulus.url, stimulus.stimulusType);
    }
    if (targets.length >= limit) break;
  }
  return targets;
}

function preloadTarget(target: { url: string; kind: MediaKind }, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let element: HTMLImageElement | HTMLMediaElement | null = target.kind === 'image'
      ? new Image()
      : document.createElement(target.kind);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (element) {
        element.onload = null;
        element.onerror = null;
        if (element instanceof HTMLMediaElement) {
          element.onloadeddata = null;
          element.onerror = null;
          element.removeAttribute('src');
          element.load();
        }
      }
      element = null;
      resolve();
    };
    const timeout = window.setTimeout(finish, timeoutMs);
    if (element instanceof HTMLMediaElement) {
      element.preload = 'auto';
      element.muted = true;
      element.onloadeddata = finish;
      element.onerror = finish;
      element.src = target.url;
      element.load();
    } else {
      element.onload = finish;
      element.onerror = finish;
      element.src = target.url;
    }
  });
}

export async function preloadStimulusMedia(stimuli: ExtendedStimulus[], timeoutMs = 8000): Promise<void> {
  const targets = collectPreloadTargets(stimuli);
  if (targets.length === 0 || typeof document === 'undefined') return;
  await Promise.all(targets.map((target) => preloadTarget(target, timeoutMs)));
}
