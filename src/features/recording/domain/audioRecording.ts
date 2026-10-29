import { ipcClient } from '@/infrastructure/electron/ipcClient';
import { calculatePupilAudioSync, type PupilAudioSync, type PupilClockSample } from '@shared/domain/pupilAudioSync';

const AUDIO_INPUT_SETTING_KEY = 'mrt.audioInputSetting.v1';

export type AudioInputSetting = {
  deviceId: string;
  label: string;
};

export type AudioInputDevice = {
  deviceId: string;
  label: string;
};

type PreparedAudioRecording = {
  stream: MediaStream;
  recorder: MediaRecorder;
  setting: AudioInputSetting;
  cleanup: () => void;
  audioClock: () => number;
};

type ActiveAudioRecording = PreparedAudioRecording & {
  sessionId: string;
  appendChain: Promise<void>;
  appendError: string | null;
  captureStoppingPromise: Promise<AudioRecordingStopResult> | null;
  stoppingPromise: Promise<AudioRecordingStopResult> | null;
  pupilClock?: () => Promise<PupilClockSample>;
  firstClock?: PupilClockSample;
  startedMs?: number;
  audioStartedS?: number;
  pupilSync?: PupilAudioSync;
};

export type AudioRecordingStopResult =
  | { ok: true; skipped?: boolean; videoPath?: string; message?: never }
  | { ok: false; message: string };

let activeAudioRecording: ActiveAudioRecording | null = null;
let audioStartEpoch = 0;
let playbackAudioContext: AudioContext | null = null;
let playbackAudioDestination: MediaStreamAudioDestinationNode | null = null;
const playbackAudioSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

type WebkitAudioWindow = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

const getErrorMessage = (error: unknown, fallback: string): string => {
  return error instanceof Error && error.message ? error.message : fallback;
};

function getAudioContextCtor(): typeof AudioContext | null {
  return window.AudioContext || (window as WebkitAudioWindow).webkitAudioContext || null;
}

function ensurePlaybackAudioGraph(): {
  context: AudioContext;
  destination: MediaStreamAudioDestinationNode;
} | null {
  const AudioContextCtor = getAudioContextCtor();
  if (!AudioContextCtor) return null;
  if (!playbackAudioContext) {
    playbackAudioContext = new AudioContextCtor();
  }
  if (!playbackAudioDestination) {
    playbackAudioDestination = playbackAudioContext.createMediaStreamDestination();
  }
  return {
    context: playbackAudioContext,
    destination: playbackAudioDestination,
  };
}

export function registerPlaybackAudioElement(element: HTMLMediaElement | null): void {
  if (!element || playbackAudioSources.has(element)) return;
  const graph = ensurePlaybackAudioGraph();
  if (!graph) return;
  try {
    const source = graph.context.createMediaElementSource(element);
    source.connect(graph.destination);
    source.connect(graph.context.destination);
    playbackAudioSources.set(element, source);
    if (graph.context.state === 'suspended') {
      void graph.context.resume().catch(() => {});
    }
  } catch (error) {
    console.warn('[audio-recording] playback audio element registration failed', error);
  }
}

export function loadAudioInputSetting(): AudioInputSetting {
  try {
    const raw = window.localStorage.getItem(AUDIO_INPUT_SETTING_KEY);
    if (!raw) return { deviceId: '', label: '' };
    const parsed = JSON.parse(raw) as Partial<AudioInputSetting>;
    return {
      deviceId: typeof parsed.deviceId === 'string' ? parsed.deviceId : '',
      label: typeof parsed.label === 'string' ? parsed.label : '',
    };
  } catch {
    return { deviceId: '', label: '' };
  }
}

export function saveAudioInputSetting(setting: AudioInputSetting): void {
  const normalized = {
    deviceId: String(setting.deviceId || ''),
    label: String(setting.label || ''),
  };
  window.localStorage.setItem(AUDIO_INPUT_SETTING_KEY, JSON.stringify(normalized));
}

export async function listAudioInputDevices(requestPermission = false): Promise<AudioInputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    throw new Error('当前环境不支持麦克风检测');
  }

  if (requestPermission) {
    const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    permissionStream.getTracks().forEach((track) => track.stop());
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  let index = 0;
  return devices
    .filter((device) => device.kind === 'audioinput')
    .map((device) => {
      index += 1;
      return {
        deviceId: device.deviceId,
        label: device.label.trim() || `麦克风 ${index}`,
      };
    });
}

function selectAudioMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || '';
}

export async function prepareSelectedAudioRecording(): Promise<PreparedAudioRecording | null> {
  const setting = loadAudioInputSetting();
  if (!setting.deviceId) {
    return null;
  }

  if (!ipcClient.isAvailable()) {
    throw new Error('当前环境不支持将音频写入录制视频');
  }
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('当前环境不支持音频录制');
  }

  const graph = ensurePlaybackAudioGraph();
  if (!graph) {
    throw new Error('当前环境不支持采集素材播放声音');
  }

  if (graph.context.state === 'suspended') {
    await graph.context.resume().catch(() => {});
  }

  let microphoneStream: MediaStream | null = null;
  let microphoneSource: MediaStreamAudioSourceNode | null = null;
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前环境不支持麦克风录音');
  }
  microphoneStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: setting.deviceId },
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });
  microphoneSource = graph.context.createMediaStreamSource(microphoneStream);
  microphoneSource.connect(graph.destination);

  try {
    const mimeType = selectAudioMimeType();
    const recorder = mimeType
      ? new MediaRecorder(graph.destination.stream, { mimeType, audioBitsPerSecond: 128_000 })
      : new MediaRecorder(graph.destination.stream, { audioBitsPerSecond: 128_000 });
    return {
      stream: graph.destination.stream,
      recorder,
      audioClock: () => graph.context.currentTime,
      setting: {
        deviceId: setting.deviceId,
        label: setting.label || '麦克风 + 素材音频',
      },
      cleanup: () => {
        try {
          microphoneSource?.disconnect();
        } catch {
        }
        microphoneStream?.getTracks().forEach((track) => track.stop());
      },
    };
  } catch (error) {
    try {
      microphoneSource?.disconnect();
    } catch {
    }
    microphoneStream?.getTracks().forEach((track) => track.stop());
    throw error;
  }
}

export function cancelPreparedAudioRecording(prepared: PreparedAudioRecording | null): void {
  if (!prepared) return;
  prepared.cleanup();
}

export async function stopPreparedAudioRecording(prepared: PreparedAudioRecording | null): Promise<AudioRecordingStopResult> {
  if (!prepared || activeAudioRecording?.recorder !== prepared.recorder) {
    cancelPreparedAudioRecording(prepared);
    return { ok: true, skipped: true };
  }
  return stopActiveAudioRecording();
}

export async function startPreparedAudioRecording(
  prepared: PreparedAudioRecording | null,
  videoPath: string,
  pupilClock?: () => Promise<PupilClockSample>,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!prepared) return;
  if (!isCurrent()) {
    cancelPreparedAudioRecording(prepared);
    return;
  }
  if (activeAudioRecording) {
    cancelPreparedAudioRecording(prepared);
    throw new Error('上一段麦克风录音仍在收尾');
  }

  const startEpoch = ++audioStartEpoch;
  const startResult = await ipcClient.startRecordingAudio({
    videoPath,
    mimeType: prepared.recorder.mimeType,
    deviceLabel: prepared.setting.label,
  });
  if (!startResult.ok) {
    cancelPreparedAudioRecording(prepared);
    throw new Error(startResult.message || '无法创建音频临时文件');
  }
  if (startEpoch !== audioStartEpoch || !isCurrent() || activeAudioRecording) {
    cancelPreparedAudioRecording(prepared);
    await ipcClient.abortRecordingAudio({ sessionId: startResult.sessionId });
    throw new Error('录制已停止，取消尚未启动的音频采集');
  }

  const active: ActiveAudioRecording = {
    ...prepared,
    sessionId: startResult.sessionId,
    appendChain: Promise.resolve(),
    appendError: null,
    captureStoppingPromise: null,
    stoppingPromise: null,
    pupilClock,
  };

  prepared.recorder.addEventListener('dataavailable', (event) => {
    if (!event.data || event.data.size <= 0) return;
    active.appendChain = active.appendChain.then(async () => {
      const chunk = new Uint8Array(await event.data.arrayBuffer());
      const result = await ipcClient.appendRecordingAudio({
        sessionId: active.sessionId,
        chunk,
      });
      if (!result.ok) {
        active.appendError = result.message || '音频分片写入失败';
        throw new Error(active.appendError);
      }
    }).catch((error: unknown) => {
      active.appendError = getErrorMessage(error, active.appendError || '音频分片写入失败');
    });
  });

  prepared.recorder.addEventListener('error', (event: Event) => {
    const recorderError = (event as Event & { error?: DOMException }).error;
    active.appendError = recorderError?.message || '麦克风录音失败';
  });

  activeAudioRecording = active;
  try {
    if (pupilClock) active.firstClock = await pupilClock();
    if (startEpoch !== audioStartEpoch || !isCurrent() || active.captureStoppingPromise || active.stoppingPromise || activeAudioRecording !== active) {
      throw new Error('录制已停止，取消尚未启动的音频采集');
    }
    active.startedMs = performance.now();
    active.audioStartedS = prepared.audioClock();
    prepared.recorder.start(1000);
  } catch (error) {
    if (activeAudioRecording === active) activeAudioRecording = null;
    cancelPreparedAudioRecording(prepared);
    await ipcClient.abortRecordingAudio({ sessionId: active.sessionId });
    throw error;
  }
}

export async function stopActiveAudioRecording(): Promise<AudioRecordingStopResult> {
  audioStartEpoch += 1;
  const active = activeAudioRecording;
  if (!active) return { ok: true, skipped: true };
  if (active.stoppingPromise) return active.stoppingPromise;

  active.stoppingPromise = (async (): Promise<AudioRecordingStopResult> => {
    try {
      const captureResult = await stopActiveAudioCapture();
      if (!captureResult.ok) return captureResult;

      const result = await ipcClient.finishRecordingAudio({ sessionId: active.sessionId, pupilSync: active.pupilSync });
      if (!result.ok) {
        return { ok: false, message: result.message || '音频与视频合并失败' };
      }
      return { ok: true, videoPath: result.videoPath };
    } catch (error: unknown) {
      active.cleanup();
      await ipcClient.abortRecordingAudio({ sessionId: active.sessionId });
      return { ok: false, message: getErrorMessage(error, '麦克风录音收尾失败') };
    } finally {
      if (activeAudioRecording === active) {
        activeAudioRecording = null;
      }
    }
  })();

  return active.stoppingPromise;
}

export async function stopActiveAudioCapture(): Promise<AudioRecordingStopResult> {
  audioStartEpoch += 1;
  const active = activeAudioRecording;
  if (!active) return { ok: true, skipped: true };
  if (active.captureStoppingPromise) return active.captureStoppingPromise;

  active.captureStoppingPromise = (async (): Promise<AudioRecordingStopResult> => {
    try {
      const stoppedMs = performance.now();
      const audioStoppedS = active.audioClock();
      if (active.recorder.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          active.recorder.addEventListener('stop', () => resolve(), { once: true });
          active.recorder.stop();
        });
      }
      active.cleanup();
      await active.appendChain;
      if (active.pupilClock && active.firstClock && active.startedMs !== undefined && active.audioStartedS !== undefined) {
        try {
          active.pupilSync = calculatePupilAudioSync({ first: active.firstClock, last: await active.pupilClock(),
            startedMs: active.startedMs, stoppedMs, audioDurationS: audioStoppedS - active.audioStartedS });
        } catch (error) {
          // Finalize IPC retains the captured audio when alignment is unavailable.
          const result = await ipcClient.finishRecordingAudio({ sessionId: active.sessionId,
            synchronizationError: getErrorMessage(error, 'Pupil 音频时钟对齐失败') });
          // Keep the completed capture promise until the existing finalization
          // caller consumes the error and displays its retained-audio path.
          return { ok: false, message: result.ok ? 'Pupil 音频时钟对齐失败' : result.message || 'Pupil 音频时钟对齐失败' };
        }
      }
      if (active.appendError) {
        await ipcClient.abortRecordingAudio({ sessionId: active.sessionId });
        if (activeAudioRecording === active) activeAudioRecording = null;
        return { ok: false, message: active.appendError };
      }
      return { ok: true };
    } catch (error: unknown) {
      active.cleanup();
      await ipcClient.abortRecordingAudio({ sessionId: active.sessionId });
      if (activeAudioRecording === active) activeAudioRecording = null;
      return { ok: false, message: getErrorMessage(error, '麦克风录音停止失败') };
    }
  })();

  return active.captureStoppingPromise;
}
