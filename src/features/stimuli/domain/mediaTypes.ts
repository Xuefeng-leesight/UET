export const STIMULUS_VIDEO_EXTENSIONS = [
  '.mp4',
  '.webm',
  '.mov',
  '.m4v',
  '.mkv',
  '.avi',
  '.wmv',
  '.flv',
  '.3gp',
] as const;

export const STIMULUS_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'] as const;
export const STIMULUS_AUDIO_EXTENSIONS = ['.mp3', '.wav'] as const;

export const STIMULUS_VIDEO_ACCEPT = ['video/*', ...STIMULUS_VIDEO_EXTENSIONS].join(',');
export const STIMULUS_IMAGE_ACCEPT = 'image/*';
export const STIMULUS_AUDIO_ACCEPT = ['audio/mpeg', 'audio/wav', '.mp3', '.wav'].join(',');
export const STIMULUS_MEDIA_ACCEPT = [STIMULUS_IMAGE_ACCEPT, STIMULUS_VIDEO_ACCEPT, STIMULUS_AUDIO_ACCEPT].join(',');

export function isStimulusVideoExtension(ext: string): boolean {
  const normalized = String(ext || '').trim().toLowerCase();
  return STIMULUS_VIDEO_EXTENSIONS.includes(normalized as (typeof STIMULUS_VIDEO_EXTENSIONS)[number]);
}

export function isStimulusVideoUrl(url: string): boolean {
  const lower = String(url || '').toLowerCase().split('?')[0].split('#')[0];
  return STIMULUS_VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isStimulusAudioExtension(ext: string): boolean {
  const normalized = String(ext || '').trim().toLowerCase();
  return STIMULUS_AUDIO_EXTENSIONS.includes(normalized as (typeof STIMULUS_AUDIO_EXTENSIONS)[number]);
}

export function isStimulusAudioUrl(url: string): boolean {
  const lower = String(url || '').toLowerCase().split('?')[0].split('#')[0];
  return STIMULUS_AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
