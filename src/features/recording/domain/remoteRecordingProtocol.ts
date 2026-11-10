type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | null =>
  value !== null && typeof value === 'object' ? value as UnknownRecord : null;

export function parseRemoteRecordingStateValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['true', '1', 'active', 'recording', 'started', 'running', 'on'].includes(normalized)) return true;
  if (['false', '0', 'idle', 'inactive', 'stopped', 'stopping', 'stopped_success', 'off'].includes(normalized)) return false;
  return undefined;
}

export function extractRemoteRecordingState(value: unknown): boolean | undefined {
  const message = asRecord(value);
  if (!message) return undefined;
  const explicitState =
    parseRemoteRecordingStateValue(message.active)
    ?? parseRemoteRecordingStateValue(message.isRecording)
    ?? parseRemoteRecordingStateValue(message.recordingActive);
  if (typeof explicitState === 'boolean') return explicitState;

  const type = typeof message.type === 'string' ? message.type.trim().toLowerCase() : '';
  if (type === 'recording.result' && message.ok === true) {
    if (message.command === 'recording.start') return true;
    if (message.command === 'recording.stop') return false;
  }
  if (type === 'recording.started' || type === 'recording.start') return true;
  if (type === 'recording.stopped' || type === 'recording.stop') return false;
  if (type === 'recording.status' || type === 'recording.state' || type === 'recording.changed' || type === 'recording.update') {
    return parseRemoteRecordingStateValue(message.status) ?? parseRemoteRecordingStateValue(message.state);
  }
  return undefined;
}

export function normalizeEyeImageMessageKind(value: unknown): 'single' | 'left' | 'right' | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
  if (!normalized) return null;
  if (['left', 'left_eye', 'l_eye', 'lefteye'].includes(normalized)) return 'left';
  if (['right', 'right_eye', 'r_eye', 'righteye'].includes(normalized)) return 'right';
  if (['scene', 'single', 'single_eye', 'mono'].includes(normalized)) return 'single';
  return null;
}
