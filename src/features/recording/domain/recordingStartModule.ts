import type { Dispatch, SetStateAction } from 'react';
import type { Subject } from '@shared/contracts/domain/models';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import type { ExtendedStimulus } from '@/shared/types/mrt';
import type { RecordingCaptureDisplay } from '@/infrastructure/electron/ipcTypes';
import { sendCmdWithResponse } from '@/features/recording/domain/recordingWsModule';
import { translateTextForLanguage } from '@/app/i18n/useDomTranslation';
import { getStoredLanguage } from '@/app/i18n/language';
import {
  cancelPreparedAudioRecording,
  prepareSelectedAudioRecording,
  startPreparedAudioRecording,
  stopPreparedAudioRecording,
} from '@/features/recording/domain/audioRecording';
import type { ParticipantWindowState } from '@/features/recording/domain/participantWindowState';
import type { PupilClockSample } from '@shared/domain/pupilAudioSync';
import { startRecordingCommunication } from '@/features/recording/domain/recordingCommunication';

export function getSubjectName(params: { subjects: Subject[]; subjectId: string }): string {
  const { subjects, subjectId } = params;
  if (subjects.length === 0) return '';
  const selected = subjects.find((s) => s.id === subjectId) || subjects[0];
  const legacyName = selected['姓名'];
  return (typeof legacyName === 'string' && legacyName) || selected.name || '';
}

const waitNextFrame = () =>
  new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });

const waitStimulusRendered = async (extraDelayMs: number) => {
  await waitNextFrame();
  await waitNextFrame();
  if (extraDelayMs > 0) {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, extraDelayMs);
    });
  }
};

export async function startRecording(params: {
  stimuli: ExtendedStimulus[];
  subjects: Subject[];
  subjectId: string;
  projectDir: string | null;
  wsCmdRef: { current: WebSocket | null };
  onPreparing: () => void;
  onConfirmed: (result: { recordingId: string; videoPath: string }) => void;
  onFailed: (error: string) => void;
  onCommunicationError?: (message: string) => void;
  isRecordingCurrent?: () => boolean;
  isPreparationCurrent?: () => boolean;
  setIsRecordingCaptureReady: Dispatch<SetStateAction<boolean>>;
  setPlaybackIndex: Dispatch<SetStateAction<number | null>>;
  initialPlaybackIndex?: number | null;
  requireStimuli?: boolean;
  enableSplitScreen?: boolean;
  captureReadyDelayMs?: number;
  enableFullscreen?: boolean;
  videoSamplingRateHz?: number;
  deviceType?: '桌面式' | '眼镜式';
  initialParticipantState?: ParticipantWindowState;
}): Promise<{ recordingId: string; videoPath: string } | null> {
  const {
    stimuli,
    subjects,
    subjectId,
    projectDir,
    wsCmdRef,
    onPreparing,
    onConfirmed,
    onFailed,
    isRecordingCurrent = () => true,
    setIsRecordingCaptureReady,
    setPlaybackIndex,
    initialPlaybackIndex,
    requireStimuli = true,
    enableSplitScreen = false,
    captureReadyDelayMs = 160,
    enableFullscreen = true,
    videoSamplingRateHz = 30,
    deviceType,
    initialParticipantState,
  } = params;

  const licenseCheck = await ipcClient.requireLicenseModule('eye_tracking');
  if (!licenseCheck.ok) {
    const reason = licenseCheck.message || '当前 License 未授权眼动模块。';
    onFailed(reason);
    window.alert(reason);
    return null;
  }

  if (requireStimuli && stimuli.length === 0) {
    alert('没有刺激物可播放');
    return null;
  }

  if (!subjectId && subjects.length === 0) {
    alert(translateTextForLanguage('请先在受试者模块中新建并选择受试者', getStoredLanguage()));
    return null;
  }

  const subjectName = subjectId ? getSubjectName({ subjects, subjectId }) : getSubjectName({ subjects, subjectId: subjects[0]?.id || '' });

  console.log('[startRecording] Starting recording with:', {
    projectDir,
    subjectName,
  });

  if (!projectDir) {
    console.warn('[startRecording] No project directory found! Files will be saved to SDK server directory.');
    alert(
      '警告：未找到关联的项目目录，录制文件将保存在眼动服务默认目录下 (services/eye_tracking/application/recordings)。请先进入项目再进行录制。',
    );
  }

  let captureDisplay: RecordingCaptureDisplay | undefined;
  if (ipcClient.isAvailable()) {
    if (enableSplitScreen) {
      const res = await ipcClient.createRecordingWindow({
        projectDir: projectDir || undefined,
        forceEnable: true,
        initialState: initialParticipantState,
      });
      captureDisplay = res.captureDisplay;
      if (!res.ok || !res.hasParticipantWindow || res.participantReady === false || !captureDisplay) {
        console.warn('[startRecording] participant capture display unavailable:', 'message' in res ? res.message : 'unknown');
        const warningText = Array.isArray(res.warnings) && res.warnings.length > 0
          ? `\n原因：${res.warnings.join('；')}`
          : '';
        const reason = ('message' in res && res.message) || (res.participantReady === false
          ? `被试屏未完成首帧显示，已取消录制。请重新打开分屏后重试。${warningText}`
          : `分屏观察已启用，但无法确定被试屏录制目标。请检查第二显示器。${warningText}`);
        onFailed(reason);
        window.alert(reason);
        return null;
      }
    } else {
      await ipcClient.closeRecordingWindow();
    }
  }

  setIsRecordingCaptureReady(false);
  onPreparing();
  const hasInitial = typeof initialPlaybackIndex === 'number' && Number.isFinite(initialPlaybackIndex);
  setPlaybackIndex(hasInitial ? (initialPlaybackIndex as number) : (requireStimuli ? 0 : null));
  if (enableFullscreen) {
    ipcClient.setWindowFullScreen({ fullscreen: true });
    document.documentElement.requestFullscreen().catch(() => {});
  }

  const readyDelayMs = Number.isFinite(captureReadyDelayMs) && captureReadyDelayMs > 0
    ? Math.round(captureReadyDelayMs)
    : 0;
  await waitStimulusRendered(readyDelayMs);

  let preparedAudio: Awaited<ReturnType<typeof prepareSelectedAudioRecording>> = null;
  try {
    preparedAudio = await prepareSelectedAudioRecording();
  } catch (error: unknown) {
    preparedAudio = null;
    console.warn('[startRecording] audio recording unavailable, continuing without audio:', error);
  }

  const startRsp = await sendCmdWithResponse({
    wsCmdRef,
    id: 'start_recording',
    args: {
      project_path: projectDir,
      subject_name: subjectName,
      video_sampling_rate_hz: videoSamplingRateHz,
      device_type: deviceType,
      split_screen: enableSplitScreen,
      capture_display: captureDisplay,
    },
    timeoutMs: 6000,
  });
  if (!startRsp.ok) {
    cancelPreparedAudioRecording(preparedAudio);
    const reason = startRsp.error || 'start_recording 执行失败';
    setIsRecordingCaptureReady(false);
    onFailed(reason);
    setPlaybackIndex(null);
    if (enableFullscreen) {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
      void ipcClient.setWindowFullScreen({ fullscreen: false });
    }
    if (ipcClient.isAvailable()) {
      void ipcClient.closeRecordingWindow();
    }
    alert(`开始录制失败：${reason}`);
    return null;
  }

  const response = startRsp.response || {};
  const recordingResult = {
    recordingId: String(response.recording_id || '').trim(),
    videoPath: String(response.video_path || '').trim(),
  };
  if (response.source_model === 'PupilCore' && projectDir) {
    try {
      const configResult = await ipcClient.loadTriggerConfig({ projectDir });
      if (!configResult.ok || !configResult.config) throw new Error('通信配置读取失败');
      const config = configResult.config;
      if (config.enabled || config.serialEnabled) {
        await startRecordingCommunication({
          recordingId: recordingResult.recordingId,
          journalPath: String(response.communication_journal_path || ''),
          config,
          command: (id, args, timeoutMs) => sendCmdWithResponse({ wsCmdRef, id, args, timeoutMs }),
          isCurrent: params.isPreparationCurrent,
          onError: params.onCommunicationError || (message => window.alert(message)),
        });
      }
    } catch (error) {
      // An enabled I/O channel must be ready before stimulus playback begins.
      const stopped = await sendCmdWithResponse({ wsCmdRef, id: 'stop_recording', timeoutMs: 3000 });
      cancelPreparedAudioRecording(preparedAudio);
      const reason = error instanceof Error ? error.message : '通信初始化失败';
      if (stopped.ok) onFailed(reason);
      else onConfirmed(recordingResult); // Keep Stop available while the backend outcome is unknown.
      setIsRecordingCaptureReady(false);
      setPlaybackIndex(null);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      void ipcClient.setWindowFullScreen({ fullscreen: false });
      void ipcClient.closeRecordingWindow();
      window.alert(stopped.ok ? `开始录制失败：${reason}`
        : `通信初始化失败：${reason}。停止命令尚未确认，请点击“停止录制”重试。${stopped.error || ''}`);
      return null;
    }
  }
  onConfirmed(recordingResult);
  if (!isRecordingCurrent()) {
    cancelPreparedAudioRecording(preparedAudio);
    return null;
  }

  if (preparedAudio) {
    const videoPath = recordingResult.videoPath;
    try {
      if (!videoPath) {
        throw new Error('录制服务未返回视频保存路径');
      }
      const pupilClock = response.source_model === 'PupilCore' ? async (): Promise<PupilClockSample> => {
        const candidates: PupilClockSample[] = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const before = performance.now();
          const clock = await sendCmdWithResponse({ wsCmdRef, id: 'get_source_clock', timeoutMs: 1500 });
          const after = performance.now();
          const value = clock.response;
          if (!clock.ok || !value || value.recording_id !== recordingResult.recordingId) {
            throw new Error(clock.error || 'Pupil 音频时钟会话不匹配');
          }
          candidates.push({ sourceTimeS: Number(value.source_time_s), midpointMs: (before + after) / 2,
            roundTripMs: after - before, generation: Number(value.generation), recordingId: value.recording_id,
            sourceTimeOriginS: Number(value.source_time_origin_s) });
        }
        return candidates.sort((a, b) => a.roundTripMs - b.roundTripMs)[0];
      } : undefined;
      await startPreparedAudioRecording(preparedAudio, videoPath, pupilClock, isRecordingCurrent);
    } catch (error: unknown) {
      cancelPreparedAudioRecording(preparedAudio);
      console.warn('[startRecording] microphone audio start failed, continuing without audio:', error);
    }
  }

  if (!isRecordingCurrent()) {
    await stopPreparedAudioRecording(preparedAudio);
    return null;
  }
  setIsRecordingCaptureReady(true);
  return recordingResult;
}
