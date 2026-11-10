import type React from 'react';
import type { RecordingRecord } from '@shared/contracts/domain/models';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import type { ExtendedStimulus } from '@/shared/types/mrt';
import { loadRecordsForProject } from '@/features/records/domain/recordingsLoader';
import { playbackEngine } from '@/features/stimuli/PlaybackEngine';
import type { TriggerConfig } from '@/shared/types/mrt';
import { sendRecordingTriggerMark } from '@/features/recording/domain/recordingCommunication';

const asEnabledFlag = (value: unknown): boolean => {
  if (value === true) return true;
  if (value === false || value == null) return false;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes' || v === 'on';
  }
  return false;
};

const RECORDING_VIDEO_ENDED_EVENT = 'mrt:recording-video-ended';
const RECORDING_VIDEO_ERROR_EVENT = 'mrt:recording-video-error';
let pendingRecordRefreshTimers: number[] = [];
let globalRecordingActive = false;

const clearPendingRecordRefreshTimers = () => {
  if (pendingRecordRefreshTimers.length <= 0) return;
  pendingRecordRefreshTimers.forEach((timerId) => {
    window.clearTimeout(timerId);
  });
  pendingRecordRefreshTimers = [];
};

const shouldPlayVideoToEnd = (stimulus: ExtendedStimulus | null | undefined): boolean => {
  if (stimulus?.stimulusType !== 'video' && stimulus?.stimulusType !== 'audio') return false;
  const raw = stimulus.playToEnd;
  if (raw == null) return true;
  return asEnabledFlag(raw);
};

const shouldWaitForComboLastVideo = (stimulus: ExtendedStimulus | null | undefined): boolean => {
  if (stimulus?.stimulusType !== 'combo') return false;
  const fixed = Number(stimulus.fixedTimeMs);
  if (Number.isFinite(fixed) && fixed > 0) return false;
  const items = Array.isArray(stimulus.comboItems) ? stimulus.comboItems : [];
  return items.some((item) => item.type === 'video' && typeof item.url === 'string' && Boolean(item.url));
};

export function recordingPlaybackEffect(params: {
  playbackIndex: number | null;
  isRecording: boolean;
  isCaptureReady?: boolean;
  stimuli: ExtendedStimulus[];
  projectDir: string | null;
  sendCmd: (id: string, args?: Record<string, unknown>) => boolean;
  setPlaybackIndex: React.Dispatch<React.SetStateAction<number | null>>;
  setIsRecording: React.Dispatch<React.SetStateAction<boolean>>;
  setRecords: React.Dispatch<React.SetStateAction<RecordingRecord[]>>;
  playbackOrderRef?: { current: number[] | null };
  playbackSequenceRef?: { current: string[] | null };
  triggerConfig?: TriggerConfig | null;
  externalMarkers?: boolean;
  globalEndOnClick?: boolean;
  globalEndOnKey?: boolean;
  previewMode?: boolean;
  requestRecordingStop?: () => void;
  onRecordingCompleted?: () => void;
  onStimulusChange?: (stimulusName: string) => void;
  onTriggerSent?: (triggerMark: number) => void;
}): void | (() => void) {
  const {
    playbackIndex,
    isRecording,
    isCaptureReady = true,
    stimuli,
    projectDir,
    sendCmd,
    setPlaybackIndex,
    setIsRecording,
    setRecords,
    playbackOrderRef,
    playbackSequenceRef,
    triggerConfig,
    externalMarkers = true,
    globalEndOnClick = false,
    globalEndOnKey = false,
    previewMode = false,
    requestRecordingStop,
    onRecordingCompleted,
    onStimulusChange,
    onTriggerSent,
  } = params;

  globalRecordingActive = Boolean(isRecording);
  if (globalRecordingActive) {
    clearPendingRecordRefreshTimers();
  }

  if (playbackIndex === null || !isRecording) return;
  if (!isCaptureReady) return;

  const refreshRecordsAfterStop = () => {
    // The recorder now finalizes video/CSV asynchronously. MrtApp refreshes the
    // list only after notify_recording_finalized, so an in-progress MP4 is never
    // copied into the media cache or opened by the player.
  };

  const exitPreviewFullscreen = () => {
    if (!previewMode) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch((err) => console.error(err));
    }
    void ipcClient.setWindowFullScreen({ fullscreen: false });
  };

  // Use PlaybackEngine sequence if available, otherwise fall back to legacy logic
  const playbackSequence = playbackSequenceRef?.current || null;
  
  if (playbackSequence && playbackSequence.length > 0) {
    // New PlaybackEngine-based logic
    if (playbackIndex >= playbackSequence.length) {
      // Recording complete - this is a safety check, should not normally reach here
      if (!previewMode) requestRecordingStop?.();
      if (playbackOrderRef) playbackOrderRef.current = null;
      if (playbackSequenceRef) playbackSequenceRef.current = null;
      
      setIsRecording(false);
      
      exitPreviewFullscreen();
      
      setTimeout(() => {
        setPlaybackIndex(null);
      }, 200);
      
      try {
        refreshRecordsAfterStop();
      } catch (e) {
        console.error(e);
      }
      
      if (onRecordingCompleted) {
        onRecordingCompleted();
      }
      return;
    }

    const stimulusId = playbackSequence[playbackIndex];
    const currentStim = stimuli.find(s => s.id === stimulusId);
    
    // Check if this is a Group trigger marker
    if (stimulusId.startsWith('GROUP_TRIGGER:')) {
      const groupId = stimulusId.replace('GROUP_TRIGGER:', '');
      const groupStim = stimuli.find(s => s.id === groupId);
      
      console.log(`[PlaybackEffect] Group trigger at index ${playbackIndex}:`, {
        groupId,
        groupName: groupStim?.name,
        triggerMark: groupStim?.triggerMark,
        triggerEnabled: groupStim?.triggerEnabled,
        triggerConfigExists: !!triggerConfig,
        triggerConfigEnabled: triggerConfig?.enabled,
        willSendTrigger: groupStim && groupStim.triggerEnabled && groupStim.triggerMark !== undefined && triggerConfig?.enabled
      });
      
      const shouldMarkGroupTrigger = Boolean(groupStim && groupStim.triggerEnabled && groupStim.triggerMark !== undefined);
      if (shouldMarkGroupTrigger && onTriggerSent) {
        onTriggerSent(groupStim!.triggerMark!);
      }

      // Send Group UDP trigger if enabled in config and recording settings
      if (groupStim && groupStim.triggerEnabled && groupStim.triggerMark !== undefined && triggerConfig && (triggerConfig.enabled || triggerConfig.serialEnabled) && externalMarkers) {
        console.log(`[PlaybackEffect] Sending Group UDP trigger: mark=${groupStim.triggerMark}, ip=${triggerConfig.targetIp}, port=${triggerConfig.udpSendPort}`);
        sendRecordingTriggerMark(triggerConfig, groupStim.triggerMark).then(result => {
          if (result.ok === false) throw new Error(result.message || 'Trigger发送失败');
          console.log(`[PlaybackEffect] Group UDP trigger sent successfully: mark=${groupStim.triggerMark}`);
        }).catch((err) => {
          console.error('[PlaybackEffect] Failed to send Group trigger:', err);
        });
      } else {
        console.log(`[PlaybackEffect] Group trigger NOT sent - conditions not met`, {
          hasTriggerEnabled: groupStim?.triggerEnabled,
          hasTriggerMark: groupStim?.triggerMark !== undefined,
          configEnabled: triggerConfig?.enabled,
          externalMarkersEnabled: externalMarkers
        });
      }
      
      // Immediately move to next stimulus (the first group member)
      setPlaybackIndex(playbackIndex + 1);
      return;
    }
    
    console.log(`[PlaybackEffect] Playing index ${playbackIndex}/${playbackSequence.length}:`, {
      stimulusId,
      name: currentStim?.name,
      type: currentStim?.stimulusType,
      found: !!currentStim
    });
    
    if (!currentStim) {
      console.error(`Stimulus not found: ${stimulusId}`);
      // Skip to next
      setPlaybackIndex(playbackIndex + 1);
      return;
    }

    // Debug: Log trigger configuration and stimulus trigger settings
    console.log(`[PlaybackEffect] Trigger check for "${currentStim.name}":`, {
      stimulusTriggerEnabled: currentStim.triggerEnabled,
      stimulusTriggerMark: currentStim.triggerMark,
      triggerConfigExists: !!triggerConfig,
      triggerConfigEnabled: triggerConfig?.enabled,
      triggerConfigTargetIp: triggerConfig?.targetIp,
      triggerConfigPort: triggerConfig?.udpSendPort,
      willSendTrigger: currentStim.triggerEnabled && currentStim.triggerMark !== undefined && triggerConfig?.enabled
    });

    const shouldMarkTrigger = currentStim.triggerEnabled && currentStim.triggerMark !== undefined;
    if (shouldMarkTrigger && onTriggerSent) {
      onTriggerSent(currentStim.triggerMark!);
    }

    // Send UDP trigger if enabled in config and recording settings
    if (currentStim.triggerEnabled && currentStim.triggerMark !== undefined && triggerConfig && (triggerConfig.enabled || triggerConfig.serialEnabled) && externalMarkers) {
      console.log(`[PlaybackEffect] Sending UDP trigger: mark=${currentStim.triggerMark}, ip=${triggerConfig.targetIp}, port=${triggerConfig.udpSendPort}`);
      sendRecordingTriggerMark(triggerConfig, currentStim.triggerMark).then(result => {
        if (result.ok === false) throw new Error(result.message || 'Trigger发送失败');
        console.log(`[PlaybackEffect] UDP trigger sent successfully: mark=${currentStim.triggerMark}`);
      }).catch((err) => {
        console.error('[PlaybackEffect] Failed to send trigger:', err);
      });
    } else {
      console.log(`[PlaybackEffect] Trigger NOT sent - conditions not met`, {
        stimulusTriggerEnabled: currentStim.triggerEnabled,
        hasTriggerMark: currentStim.triggerMark !== undefined,
        configEnabled: triggerConfig?.enabled,
        externalMarkersEnabled: externalMarkers
      });
    }

    // Set stimulus name for recording
    const sName = currentStim.name || `Stimulus_${stimulusId}`;
    sendCmd('set_stimulus', { name: sName });
    
    // 通知刺激物已切换
    if (onStimulusChange) {
      // Persist both id and display name for later AOI-to-stimulus alignment.
      onStimulusChange(`${currentStim.id}::${sName}`);
    }

    // Get playback duration
    const playbackMs = (() => {
      const v = Number(currentStim.fixedTimeMs);
      if (Number.isFinite(v) && v > 0) return Math.round(v);
      return 5000;
    })();
    const waitForVideoEnded = shouldPlayVideoToEnd(currentStim) || shouldWaitForComboLastVideo(currentStim);
    const allowAdvanceOnClick = asEnabledFlag(globalEndOnClick) && asEnabledFlag(currentStim.endOnClick);

    let advanced = false;

    const stopRecordingImmediately = () => {
      if (advanced) return;
      advanced = true;
      if (!previewMode) requestRecordingStop?.();
      if (playbackOrderRef) playbackOrderRef.current = null;
      if (playbackSequenceRef) playbackSequenceRef.current = null;

      setIsRecording(false);

      exitPreviewFullscreen();

      setTimeout(() => {
        setPlaybackIndex(null);
      }, 200);

      try {
        refreshRecordsAfterStop();
      } catch (e) {
        console.error(e);
      }

      if (onRecordingCompleted) {
        onRecordingCompleted();
      }
    };

    const advancePlayback = () => {
      if (advanced) return;
      advanced = true;
      if (playbackIndex + 1 < playbackSequence.length) {
        setPlaybackIndex(playbackIndex + 1);
      } else {
        // Recording complete - keep displaying last stimulus while exiting
        if (!previewMode) requestRecordingStop?.();
        if (playbackOrderRef) playbackOrderRef.current = null;
        if (playbackSequenceRef) playbackSequenceRef.current = null;
        
        setIsRecording(false);
        // Don't clear playbackIndex yet - keep showing last stimulus
        
        // Keep the recording surface stable until the recorder accepts stop.
        exitPreviewFullscreen();
        
        // Clear playbackIndex after a short delay to allow fullscreen transition
        setTimeout(() => {
          setPlaybackIndex(null);
        }, 200);
        
        try {
          refreshRecordsAfterStop();
        } catch (e) {
          console.error(e);
        }
        
        if (onRecordingCompleted) {
          onRecordingCompleted();
        }
      }
    };

    const handleMouseDown = (event: MouseEvent) => {
      // 只有录制页全局设置和当前刺激物都开启"点击播放下一个素材"时，才允许点击切换
      if (!allowAdvanceOnClick) return;
      // 任意鼠标按键（左/中/右）都作为“下一素材”
      event.preventDefault();
      event.stopPropagation();
      advancePlayback();
    };
    const handlePointerDown = (event: PointerEvent) => {
      handleMouseDown(event);
    };
    const handleDoubleClick = (event: MouseEvent) => {
      if (!previewMode) return;
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      stopRecordingImmediately();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (previewMode) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        stopRecordingImmediately();
        return;
      }
      // 录制页“按键ESC结束”未开启时，不拦截按键
      if (!asEnabledFlag(globalEndOnKey)) return;
      // 仅 Esc 作为“结束录制”
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      stopRecordingImmediately();
    };
    const handleVideoPlaybackDone = (event: Event) => {
      const detail = (event as CustomEvent<{ stimulusId?: string }>).detail;
      if (!detail || detail.stimulusId !== currentStim.id) return;
      advancePlayback();
    };

    const timer = waitForVideoEnded ? null : window.setTimeout(advancePlayback, playbackMs);
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('mousedown', handleMouseDown, true);
    window.addEventListener('dblclick', handleDoubleClick, true);
    window.addEventListener('keydown', handleKeyDown, true);
    if (waitForVideoEnded) {
      window.addEventListener(RECORDING_VIDEO_ENDED_EVENT, handleVideoPlaybackDone);
      window.addEventListener(RECORDING_VIDEO_ERROR_EVENT, handleVideoPlaybackDone);
    }

    return () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('mousedown', handleMouseDown, true);
      window.removeEventListener('dblclick', handleDoubleClick, true);
      window.removeEventListener('keydown', handleKeyDown, true);
      if (waitForVideoEnded) {
        window.removeEventListener(RECORDING_VIDEO_ENDED_EVENT, handleVideoPlaybackDone);
        window.removeEventListener(RECORDING_VIDEO_ERROR_EVENT, handleVideoPlaybackDone);
      }
    };
  }

  // Legacy playback logic (fallback)
  if (playbackIndex >= stimuli.length) return;

  const isActive = (stimulus: ExtendedStimulus | undefined): boolean => Boolean(stimulus && stimulus.active !== false);
  const findNextActive = (fromIndex: number): number | null => {
    for (let i = Math.max(0, fromIndex); i < stimuli.length; i += 1) {
      if (isActive(stimuli[i])) return i;
    }
    return null;
  };
  const buildActiveOrder = (): number[] => {
    const arr: number[] = [];
    const groupsMap: Record<string, number[]> = {};
    const ungrouped: number[] = [];
    
    for (let i = 0; i < stimuli.length; i += 1) {
      if (isActive(stimuli[i]) && stimuli[i].stimulusType !== 'group') {
        const g = stimuli[i].group;
        if (g) {
          if (!groupsMap[g]) groupsMap[g] = [];
          groupsMap[g].push(i);
        } else {
          ungrouped.push(i);
        }
      }
    }

    Object.keys(groupsMap).sort().forEach(g => {
      arr.push(...groupsMap[g]);
    });
    arr.push(...ungrouped);

    return arr;
  };

  const order = (() => {
    const raw = playbackOrderRef?.current || null;
    if (!raw || raw.length === 0) return buildActiveOrder();
    const filtered: number[] = [];
    for (const idx of raw) {
      if (typeof idx !== 'number' || !Number.isFinite(idx)) continue;
      if (idx < 0 || idx >= stimuli.length) continue;
      if (!isActive(stimuli[idx])) continue;
      filtered.push(idx);
    }
    return filtered.length > 0 ? filtered : buildActiveOrder();
  })();

  const ensureIndex = isActive(stimuli[playbackIndex]) ? playbackIndex : findNextActive(playbackIndex);
  if (ensureIndex === null) {
    // No more active stimuli - end immediately
    if (!previewMode) requestRecordingStop?.();
    if (playbackOrderRef) {
      playbackOrderRef.current = null;
    }
    
    setIsRecording(false);
    
    exitPreviewFullscreen();
    
    setTimeout(() => {
      setPlaybackIndex(null);
    }, 200);
    
    try {
      refreshRecordsAfterStop();
    } catch (e) {
      console.error(e);
    }
    
    if (onRecordingCompleted) {
      onRecordingCompleted();
    }
    return;
  }
  if (ensureIndex !== playbackIndex) {
    setPlaybackIndex(ensureIndex);
    return;
  }
  const orderPos = order.indexOf(ensureIndex);
  if (orderPos === -1 && order.length > 0) {
    setPlaybackIndex(order[0]);
    return;
  }

  const currentStim = stimuli[ensureIndex];
  if (currentStim) {
    const legacyStimulus = currentStim as unknown as Record<string, unknown>;
    const sName = currentStim.name || String(legacyStimulus['名称'] || '') || `Stimulus_${ensureIndex}`;
    sendCmd('set_stimulus', { name: sName });
    if (onStimulusChange) {
      onStimulusChange(`${currentStim.id}::${sName}`);
    }
  }

  const playbackMs = (() => {
    const v = Number(currentStim?.fixedTimeMs);
    if (Number.isFinite(v) && v > 0) return Math.round(v);
    return 5000;
  })();
  const waitForVideoEnded = shouldPlayVideoToEnd(currentStim) || shouldWaitForComboLastVideo(currentStim);
  const allowAdvanceOnClick = asEnabledFlag(globalEndOnClick) && asEnabledFlag(currentStim?.endOnClick);

  let advanced = false;

  const stopRecordingImmediately = () => {
    if (advanced) return;
    advanced = true;
    if (!previewMode) requestRecordingStop?.();
    if (playbackOrderRef) {
      playbackOrderRef.current = null;
    }
    
    setIsRecording(false);
    
    exitPreviewFullscreen();
    
    setTimeout(() => {
      setPlaybackIndex(null);
    }, 200);

    try {
      refreshRecordsAfterStop();
    } catch (e) {
      console.error(e);
    }
    
    if (onRecordingCompleted) {
      onRecordingCompleted();
    }
  };

  const advancePlayback = () => {
    if (advanced) return;
    advanced = true;
    if (orderPos !== -1 && orderPos + 1 < order.length) {
      setPlaybackIndex(order[orderPos + 1]);
      return;
    }

    // Recording complete - keep displaying last stimulus while exiting
    if (!previewMode) requestRecordingStop?.();
    if (playbackOrderRef) {
      playbackOrderRef.current = null;
    }
    
    setIsRecording(false);
    
    exitPreviewFullscreen();
    
    setTimeout(() => {
      setPlaybackIndex(null);
    }, 200);

    try {
      refreshRecordsAfterStop();
    } catch (e) {
      console.error(e);
    }
    
    if (onRecordingCompleted) {
      onRecordingCompleted();
    }
  };

  const handleMouseDown = (event: MouseEvent) => {
    // 只有录制页全局设置和当前刺激物都开启"点击播放下一个素材"时，才允许点击切换
    if (!allowAdvanceOnClick) return;
    // 任意鼠标按键（左/中/右）都作为“下一素材”
    event.preventDefault();
    event.stopPropagation();
    advancePlayback();
  };
  const handlePointerDown = (event: PointerEvent) => {
    handleMouseDown(event);
  };
  const handleDoubleClick = (event: MouseEvent) => {
    if (!previewMode) return;
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    stopRecordingImmediately();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (previewMode) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      stopRecordingImmediately();
      return;
    }
    // 录制页“按键ESC结束”未开启时，不拦截按键
    if (!asEnabledFlag(globalEndOnKey)) return;
    // 仅 Esc 作为“结束录制”
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    stopRecordingImmediately();
  };
  const handleVideoPlaybackDone = (event: Event) => {
    const detail = (event as CustomEvent<{ stimulusId?: string }>).detail;
    const currentStimulusId = currentStim?.id;
    if (!detail || !currentStimulusId || detail.stimulusId !== currentStimulusId) return;
    advancePlayback();
  };

  const timer = waitForVideoEnded ? null : window.setTimeout(advancePlayback, playbackMs);
  window.addEventListener('pointerdown', handlePointerDown, true);
  window.addEventListener('mousedown', handleMouseDown, true);
  window.addEventListener('dblclick', handleDoubleClick, true);
  window.addEventListener('keydown', handleKeyDown, true);
  if (waitForVideoEnded) {
    window.addEventListener(RECORDING_VIDEO_ENDED_EVENT, handleVideoPlaybackDone);
    window.addEventListener(RECORDING_VIDEO_ERROR_EVENT, handleVideoPlaybackDone);
  }

  return () => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    window.removeEventListener('pointerdown', handlePointerDown, true);
    window.removeEventListener('mousedown', handleMouseDown, true);
    window.removeEventListener('dblclick', handleDoubleClick, true);
    window.removeEventListener('keydown', handleKeyDown, true);
    if (waitForVideoEnded) {
      window.removeEventListener(RECORDING_VIDEO_ENDED_EVENT, handleVideoPlaybackDone);
      window.removeEventListener(RECORDING_VIDEO_ERROR_EVENT, handleVideoPlaybackDone);
    }
  };
}
