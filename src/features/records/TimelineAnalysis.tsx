import Switch from '@/shared/ui/Switch';
import React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { TimeSegment } from '@shared/domain/timeline';
import type { RecordingVideoStimulus } from '@shared/domain/recordingStimulus';
import { addTimeSegment, normalizeTimeSegments, removeTimeSegment } from '@shared/domain/timeline';
import type { ExtendedStimulus, HeatmapPoint, CustomMarker } from '@/shared/types/mrt';

const EMPTY_CUSTOM_MARKERS: CustomMarker[] = [];
const EMPTY_TIME_SEGMENTS: TimeSegment[] = [];
const EMPTY_SCOPED_TIME_RANGES: TimelineScopedTimeRange[] = [];

interface TimelineEvent {
  id: string;
  type: 'stimulus' | 'trigger' | 'customMarker';
  name: string;
  startTime: number;
  endTime?: number;
  color: string;
}

interface TimelineTimeRange {
  startTime: number;
  endTime: number;
}

interface TimelineScopedTimeRange extends TimelineTimeRange {
  id: string;
  enabled: boolean;
}

interface TimelinePointTrack {
  label: string;
  timestamps: number[];
  durations?: number[];
  color?: string;
  colors?: string[];
  selectedTimestamp?: number | null;
  onPointClick?: (time: number) => void;
}

interface TimelineAnalysisProps {
  language?: 'zh-CN' | 'en-US';
  duration: number;
  currentTime: number;
  stimuli: ExtendedStimulus[];
  points: HeatmapPoint[];
  /** Full glasses recording video, independent of CSV stimulus names or gaze availability. */
  recordingVideoStimulus?: RecordingVideoStimulus | null;
  customMarkers?: CustomMarker[];
  showMarkTrack?: boolean;
  showTriggerTrack?: boolean;
  showPlaybackTrack?: boolean;
  playbackTrackLabel?: string;
  pointTrack?: TimelinePointTrack | null;
  defaultExpanded?: boolean;
  allowRangeSelection?: boolean;
  segments?: TimeSegment[];
  selectedSegmentId?: string | null;
  onSegmentsChange?: (segments: TimeSegment[]) => void;
  onSegmentSelect?: (segmentId: string | null) => void;
  onSeek: (time: number) => void;
  selectedStimulusName?: string | null;
  onTimeRangeChange?: (startTime: number, endTime: number) => void;
  onClearTimeRange?: () => void;
  /** Makes the custom range controlled by the parent when provided (including null). */
  customTimeRange?: TimelineTimeRange | null;
  /** Resets the controlled range UI when its owner changes, such as when another AOI is selected. */
  customTimeRangeKey?: string | null;
  /** Default creates a record timeline segment; scoped keeps the range as a caller-owned filter. */
  customTimeRangeMode?: 'segment' | 'scoped';
  customTimeRangeTargetLabel?: string | null;
  /** Visual color inherited from the selected AOI for its time ranges. */
  scopedRangeColor?: string;
  /** Persisted, caller-owned AOI ranges shown on the timeline. */
  scopedTimeRanges?: TimelineScopedTimeRange[];
  onScopedTimeRangeRemove?: (rangeId: string) => void;
  onScopedTimeRangeEnabledChange?: (rangeId: string, enabled: boolean) => void;
  onCustomTimeRangeModeChange?: (mode: 'segment' | 'scoped') => void;
  onReset?: () => void;
}

export const TimelineAnalysis: React.FC<TimelineAnalysisProps> = ({
  language = 'zh-CN',
  duration,
  currentTime,
  stimuli,
  points,
  recordingVideoStimulus = null,
  customMarkers = EMPTY_CUSTOM_MARKERS,
  showMarkTrack = true,
  showTriggerTrack = true,
  showPlaybackTrack = false,
  playbackTrackLabel = '播放轴',
  pointTrack = null,
  defaultExpanded = false,
  allowRangeSelection = true,
  segments = EMPTY_TIME_SEGMENTS,
  selectedSegmentId,
  onSegmentsChange,
  onSegmentSelect,
  onSeek,
  selectedStimulusName = null,
  onTimeRangeChange,
  onClearTimeRange,
  customTimeRange,
  customTimeRangeKey = null,
  customTimeRangeMode = 'segment',
  customTimeRangeTargetLabel = null,
  scopedRangeColor = '#0ea5e9',
  scopedTimeRanges = EMPTY_SCOPED_TIME_RANGES,
  onScopedTimeRangeRemove,
  onScopedTimeRangeEnabledChange,
  onCustomTimeRangeModeChange,
  onReset,
}) => {
  const isEn = language === 'en-US';
  const timelineDuration = recordingVideoStimulus?.endTime ?? duration;
  const durationSafe = Math.max(0.001, timelineDuration);
  const pointTrackRenderData = React.useMemo(() => {
    if (!pointTrack || pointTrack.timestamps.length === 0) return null;
    const resolution = 1200;
    const segmentsByColor = new Map<string, Set<string>>();
    let count = 0;
    pointTrack.timestamps.forEach((timestamp, index) => {
      if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > durationSafe) return;
      count += 1;
      const start = Math.max(0, Math.min(resolution - 1, Math.floor((timestamp / durationSafe) * resolution)));
      const duration = Math.max(0, Number(pointTrack.durations?.[index] || 0));
      const endTime = Math.min(durationSafe, timestamp + duration);
      const end = Math.max(start, Math.min(resolution, Math.ceil((endTime / durationSafe) * resolution)));
      const color = pointTrack.colors?.[index] || pointTrack.color || '#0ea5e9';
      const segments = segmentsByColor.get(color) || new Set<string>();
      segments.add(end > start ? `M ${start + 0.5} 15 H ${Math.max(start + 1, end)}` : `M ${start + 0.5} 3 V 27`);
      segmentsByColor.set(color, segments);
    });
    if (count === 0) return null;
    return {
      count,
      label: pointTrack.label,
      paths: Array.from(segmentsByColor, ([color, segments]) => ({
        color,
        path: Array.from(segments).join(' '),
      })),
      resolution,
    };
  }, [durationSafe, pointTrack]);
  const stimulusNameById = React.useMemo(() => {
    const map = new Map<string, string>();
    stimuli.forEach((s) => {
      const id = typeof s.id === 'string' ? s.id.trim() : '';
      const name = typeof s.name === 'string' ? s.name.trim() : '';
      if (id && name) map.set(id, name);
    });
    return map;
  }, [stimuli]);

  const resolveStimulusName = React.useCallback(
    (raw: unknown): string => {
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value) return '';
      return stimulusNameById.get(value) || value;
    },
    [stimulusNameById],
  );

  const isFiniteTimestamp = React.useCallback((value: unknown): value is number => {
    return typeof value === 'number' && Number.isFinite(value);
  }, []);

  const pointMatchesSelectedStimulus = React.useCallback(
    (point: HeatmapPoint): boolean => {
      if (!selectedStimulusName) return true;
      const raw = typeof point.stimulusName === 'string' ? point.stimulusName.trim() : '';
      if (!raw) return false;
      const resolved = resolveStimulusName(raw);
      return raw === selectedStimulusName || resolved === selectedStimulusName;
    },
    [resolveStimulusName, selectedStimulusName],
  );

  const [isExpanded, setIsExpanded] = React.useState(defaultExpanded);
  const [timelineSegments, setTimelineSegments] = React.useState<TimeSegment[]>(() =>
    normalizeTimeSegments(segments, { duration: timelineDuration }),
  );

  const [customRangeStart, setCustomRangeStart] = React.useState<number | null>(null);
  const [customRangeEnd, setCustomRangeEnd] = React.useState<number | null>(null);
  const [isDraggingStart, setIsDraggingStart] = React.useState(false);
  const [isDraggingEnd, setIsDraggingEnd] = React.useState(false);
  const [isSelectingRange, setIsSelectingRange] = React.useState(false);
  const [showRangeClearButton, setShowRangeClearButton] = React.useState(false);
  const [rangeClearTrackId, setRangeClearTrackId] = React.useState<string | null>(null);
  const [rangeClearSegmentId, setRangeClearSegmentId] = React.useState<string | null>(null);
  const [scopedRangeClearId, setScopedRangeClearId] = React.useState<string | null>(null);
  const isCustomRangeControlled = customTimeRange !== undefined;
  const canSelectCustomRange = customTimeRangeMode !== 'scoped' || Boolean(customTimeRangeTargetLabel);
  const canSwitchRangeMode = Boolean(onCustomTimeRangeModeChange);
  const canSwitchToScopedMode = Boolean(customTimeRangeTargetLabel);
  const enabledTimelineSegmentCount = timelineSegments.filter((segment) => segment.enabled !== false).length;
  const enabledScopedTimeRangeCount = scopedTimeRanges.filter((range) => range.enabled !== false).length;

  React.useEffect(() => {
    setTimelineSegments(normalizeTimeSegments(segments, { duration: timelineDuration }));
  }, [segments, timelineDuration]);

  React.useEffect(() => {
    setIsExpanded(defaultExpanded);
  }, [defaultExpanded]);

  React.useEffect(() => {
    if (!isCustomRangeControlled) return;
    const start = Number(customTimeRange?.startTime);
    const end = Number(customTimeRange?.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      setCustomRangeStart(null);
      setCustomRangeEnd(null);
    } else {
      setCustomRangeStart(Math.min(start, end));
      setCustomRangeEnd(Math.max(start, end));
    }
    setShowRangeClearButton(false);
    setRangeClearTrackId(null);
    setRangeClearSegmentId(null);
  }, [customTimeRange?.endTime, customTimeRange?.startTime, customTimeRangeKey, isCustomRangeControlled]);

  React.useEffect(() => {
    setIsSelectingRange(false);
    setCustomRangeStart(null);
    setCustomRangeEnd(null);
    setShowRangeClearButton(false);
    setRangeClearTrackId(null);
    setRangeClearSegmentId(null);
    setScopedRangeClearId(null);
  }, [customTimeRangeKey]);

  const displayDurationSeconds = React.useMemo(() => {
    const floored = Math.floor(durationSafe);
    return durationSafe >= 1 ? Math.max(1, floored) : durationSafe;
  }, [durationSafe]);

  const clampDisplaySecond = React.useCallback(
    (seconds: number) => {
      if (!Number.isFinite(seconds) || seconds < 0) return 0;
      const snapped = Math.floor(seconds);
      return Math.max(0, Math.min(displayDurationSeconds, snapped));
    },
    [displayDurationSeconds],
  );

  const makeDisplaySecondRange = React.useCallback(
    (a: number, b: number) => {
      let startTime = clampDisplaySecond(Math.min(a, b));
      let endTime = clampDisplaySecond(Math.max(a, b));
      if (endTime <= startTime) {
        endTime = Math.min(displayDurationSeconds, startTime + 1);
        if (endTime <= startTime) {
          startTime = Math.max(0, endTime - 1);
        }
      }
      return { startTime, endTime };
    },
    [clampDisplaySecond, displayDurationSeconds],
  );

  const formatTime = React.useCallback((seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
    const totalSeconds = Math.max(0, Math.floor(seconds));
    const mm = Math.floor(totalSeconds / 60);
    const ss = totalSeconds - mm * 60;
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }, []);

  const formatTickTime = React.useCallback(
    (seconds: number) => {
      if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
      return formatTime(seconds);
    },
    [formatTime],
  );

  React.useEffect(() => {
    if (customTimeRangeMode !== 'scoped' && onTimeRangeChange && customRangeStart !== null && customRangeEnd !== null) {
      onTimeRangeChange(Math.min(customRangeStart, customRangeEnd), Math.max(customRangeStart, customRangeEnd));
    }
  }, [customRangeStart, customRangeEnd, customTimeRangeMode, onTimeRangeChange]);

  React.useEffect(() => {
    if (isCustomRangeControlled) return;
    setCustomRangeStart(null);
    setCustomRangeEnd(null);
    setShowRangeClearButton(false);
    setRangeClearTrackId(null);
    setRangeClearSegmentId(null);
    setScopedRangeClearId(null);
  }, [isCustomRangeControlled, selectedStimulusName]);

  React.useEffect(() => {
    if (customRangeStart === null || customRangeEnd === null) {
      if (!rangeClearSegmentId) {
        setShowRangeClearButton(false);
        setRangeClearTrackId(null);
      }
    }
  }, [customRangeStart, customRangeEnd, rangeClearSegmentId]);

  const clearCustomRange = React.useCallback(() => {
    setCustomRangeStart(null);
    setCustomRangeEnd(null);
    setShowRangeClearButton(false);
    setRangeClearTrackId(null);
    setRangeClearSegmentId(null);
    setScopedRangeClearId(null);
    if (customTimeRangeMode !== 'scoped' && onClearTimeRange) onClearTimeRange();
  }, [customTimeRangeMode, onClearTimeRange]);

  const setTimelineSegmentEnabled = React.useCallback(
    (segmentId: string, enabled: boolean) => {
      const next = timelineSegments.map((segment) =>
        segment.id === segmentId ? { ...segment, enabled, updatedAt: new Date().toISOString() } : segment,
      );
      setTimelineSegments(next);
      onSegmentsChange?.(next);
    },
    [onSegmentsChange, timelineSegments],
  );

  const toggleRangeSelection = React.useCallback(() => {
    if (!canSelectCustomRange) return;
    setIsExpanded(true);
    setIsSelectingRange((prev) => {
      const next = !prev;
      if (next) {
        setCustomRangeStart(null);
        setCustomRangeEnd(null);
        if (onSegmentSelect) onSegmentSelect(null);
        setShowRangeClearButton(false);
        setRangeClearTrackId(null);
        setRangeClearSegmentId(null);
        setScopedRangeClearId(null);
      }
      return next;
    });
  }, [canSelectCustomRange, onSegmentSelect]);

  const toggleCustomTimeRangeMode = React.useCallback(() => {
    if (!onCustomTimeRangeModeChange) return;
    if (customTimeRangeMode === 'scoped') {
      onCustomTimeRangeModeChange('segment');
      return;
    }
    if (canSwitchToScopedMode) onCustomTimeRangeModeChange('scoped');
  }, [canSwitchToScopedMode, customTimeRangeMode, onCustomTimeRangeModeChange]);

  React.useEffect(() => {
    if (!isDraggingStart && !isDraggingEnd) return;
    const handleMouseMove = (e: MouseEvent) => {
      const track = document.querySelector('[data-timeline-track]') as HTMLElement | null;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const t = (rect.width > 0 ? x / rect.width : 0) * durationSafe;
      if (isDraggingStart) setCustomRangeStart(clampDisplaySecond(t));
      if (isDraggingEnd) setCustomRangeEnd(clampDisplaySecond(t));
    };
    const handleMouseUp = () => {
      setIsDraggingStart(false);
      setIsDraggingEnd(false);
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [clampDisplaySecond, durationSafe, isDraggingEnd, isDraggingStart]);

  const timelineEvents = React.useMemo(() => {
    const events: TimelineEvent[] = [];
    const pointsForStimuli = recordingVideoStimulus ? [] : points;
    const markerSourcePoints = !recordingVideoStimulus && selectedStimulusName
      ? points.filter(pointMatchesSelectedStimulus)
      : points;
    if (recordingVideoStimulus) {
      events.push({
        id: recordingVideoStimulus.id,
        type: 'stimulus',
        name: recordingVideoStimulus.name,
        startTime: recordingVideoStimulus.startTime,
        endTime: recordingVideoStimulus.endTime,
        color: '#94a3b8',
      });
    }
    const dedupeNearbyTimes = (inputTimes: number[], minGapSeconds: number): number[] => {
      if (!Array.isArray(inputTimes) || inputTimes.length === 0) return [];
      const sorted = inputTimes
        .filter((time) => typeof time === 'number' && Number.isFinite(time))
        .sort((a, b) => a - b);
      if (sorted.length <= 1) return sorted;
      const out: number[] = [sorted[0]];
      for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i] - out[out.length - 1] > minGapSeconds) {
          out.push(sorted[i]);
        }
      }
      return out;
    };

    const stimulusPoints = pointsForStimuli
      .map((point) => {
        const name = resolveStimulusName(point.stimulusName);
        const ts = isFiniteTimestamp(point.timestamp) ? point.timestamp / 1000 : NaN;
        if (!name || !Number.isFinite(ts)) return null;
        return { name, time: ts };
      })
      .filter(Boolean) as Array<{ name: string; time: number }>;

    stimulusPoints.sort((a, b) => a.time - b.time);
    const stimulusSpans: Array<{ name: string; start: number; end: number }> = [];
    if (stimulusPoints.length > 0) {
      let cursor = {
        name: stimulusPoints[0].name,
        start: stimulusPoints[0].time,
        end: stimulusPoints[0].time,
      };
      for (let i = 1; i < stimulusPoints.length; i += 1) {
        const item = stimulusPoints[i];
        const isSameStimulus = item.name === cursor.name;
        // Keep same stimulus continuous even when sampling has sparse gaps.
        if (isSameStimulus) {
          cursor.end = Math.max(cursor.end, item.time);
        } else {
          stimulusSpans.push(cursor);
          cursor = { name: item.name, start: item.time, end: item.time };
        }
      }
      stimulusSpans.push(cursor);

      stimulusSpans[0].start = 0;
      stimulusSpans[stimulusSpans.length - 1].end = durationSafe;
      for (let i = 0; i < stimulusSpans.length - 1; i += 1) {
        const left = stimulusSpans[i];
        const right = stimulusSpans[i + 1];
        const mid = (left.end + right.start) / 2;
        left.end = Math.max(left.start, Math.min(durationSafe, mid));
        right.start = Math.min(durationSafe, Math.max(0, mid));
      }
    }

    stimulusSpans.forEach((range, index) => {
      const name = range.name;
      const stimulus = stimuli.find((s) => s.name === name);
      events.push({
        id: `stimulus-${index}-${name}`,
        type: 'stimulus',
        name,
        startTime: range.start,
        endTime: range.end,
        color:
          stimulus?.stimulusType === 'video'
            ? '#94a3b8'
            : stimulus?.stimulusType === 'audio'
              ? '#8b5cf6'
            : stimulus?.stimulusType === 'image'
              ? '#10b981'
              : stimulus?.stimulusType === 'text'
                ? '#f59e0b'
                : '#6366f1',
      });
    });

    const triggerEvents = new Map<number, number[]>();
    markerSourcePoints.forEach((point) => {
      const mark = Number(point.triggerMark);
      if (!Number.isFinite(mark) || !isFiniteTimestamp(point.timestamp)) return;
      if (!triggerEvents.has(mark)) triggerEvents.set(mark, []);
      triggerEvents.get(mark)!.push(point.timestamp / 1000);
    });
    triggerEvents.forEach((times, triggerValue) => {
      dedupeNearbyTimes(times, 0.08).forEach((time, idx) => {
        events.push({
          id: `trigger-${triggerValue}-${idx}`,
          type: 'trigger',
          name: `触发 ${triggerValue}`,
          startTime: time,
          color: '#ef4444',
        });
      });
    });

    const markerEvents = new Map<string, { times: number[]; type: string; color: string }>();
    markerSourcePoints.forEach((point) => {
      const marker = point.customMarker;
      if (!marker || !isFiniteTimestamp(point.timestamp)) return;
      const timeInSeconds = point.timestamp / 1000;
      marker
        .split(',')
        .map((m: string) => m.trim())
        .filter(Boolean)
        .forEach((name: string) => {
          if (!markerEvents.has(name)) {
            const markerDef = customMarkers.find((cm) => cm.name === name);
            const color = typeof markerDef?.color === 'string' && markerDef.color.trim() ? markerDef.color : '#8b5cf6';
            markerEvents.set(name, { times: [], type: markerDef?.type || 'instant', color });
          }
          markerEvents.get(name)!.times.push(timeInSeconds);
        });
    });
    markerEvents.forEach((data, name) => {
      if (data.type === 'instant') {
        dedupeNearbyTimes(data.times, 0.08).forEach((time, idx) => {
          events.push({ id: `marker-${name}-${idx}`, type: 'customMarker', name, startTime: time, color: data.color });
        });
      } else {
        const sorted = [...data.times].sort((a, b) => a - b);
        if (sorted.length === 0) return;
        let start = sorted[0];
        let end = sorted[0];
        for (let i = 1; i < sorted.length; i += 1) {
          if (sorted[i] - end < 0.2) end = sorted[i];
          else {
            events.push({ id: `marker-${name}-${start}`, type: 'customMarker', name, startTime: start, endTime: end, color: data.color });
            start = sorted[i];
            end = sorted[i];
          }
        }
        events.push({ id: `marker-${name}-${start}`, type: 'customMarker', name, startTime: start, endTime: end, color: data.color });
      }
    });

    return events.sort((a, b) => a.startTime - b.startTime);
  }, [customMarkers, durationSafe, isFiniteTimestamp, pointMatchesSelectedStimulus, points, recordingVideoStimulus, resolveStimulusName, selectedStimulusName, stimuli]);

  const tracks = React.useMemo(() => {
    const stimulusEvents = timelineEvents.filter((event) => event.type === 'stimulus');
    const triggerEvents = timelineEvents.filter((event) => event.type === 'trigger');
    const customMarkerEvents = timelineEvents.filter((event) => event.type === 'customMarker');
    const trackDefs: Array<{
      id: string;
      name: string;
      events: TimelineEvent[];
      height: number;
      pointPaths?: Array<{ color: string; path: string }>;
      pointResolution?: number;
    }> = [{ id: 'stimulus', name: '刺激物', events: stimulusEvents, height: 40 }];
    if (showTriggerTrack) {
      trackDefs.push({ id: 'trigger', name: '触发', events: triggerEvents, height: 30 });
    }
    if (showMarkTrack) {
      trackDefs.push({ id: 'custom-marker', name: '标记', events: customMarkerEvents, height: 30 });
    }
    if (pointTrackRenderData) {
      trackDefs.push({
        id: 'point-track',
        name: pointTrackRenderData.label,
        events: [],
        height: 42,
        pointPaths: pointTrackRenderData.paths,
        pointResolution: pointTrackRenderData.resolution,
      });
    }
    const hasStatisticsRanges = timelineSegments.length > 0 || scopedTimeRanges.length > 0;
    const visibleTracks = trackDefs.filter(
      (track) => track.events.length > 0 || track.id === 'point-track' || (track.id === 'stimulus' && hasStatisticsRanges),
    );
    const eventTracks = showPlaybackTrack
      ? [{ id: 'playback', name: playbackTrackLabel, events: [], height: 30 }, ...visibleTracks]
      : visibleTracks;
    return eventTracks;
  }, [
    playbackTrackLabel,
    pointTrackRenderData,
    scopedTimeRanges.length,
    showMarkTrack,
    showPlaybackTrack,
    showTriggerTrack,
    timelineEvents,
    timelineSegments.length,
  ]);

  const instantEventLaneById = React.useMemo(() => {
    const lanes = new Map<string, number>();
    const denseThresholdSeconds = 0.25;
    tracks.forEach((track) => {
      const instants = [...track.events]
        .filter((event) => event.endTime === undefined)
        .sort((a, b) => a.startTime - b.startTime);
      let prevTime = Number.NEGATIVE_INFINITY;
      let lane = 0;
      instants.forEach((event) => {
        if (event.startTime - prevTime <= denseThresholdSeconds) {
          lane = (lane + 1) % 3;
        } else {
          lane = 0;
        }
        lanes.set(event.id, lane);
        prevTime = event.startTime;
      });
    });
    return lanes;
  }, [tracks]);

  const stimulusCount = React.useMemo(() => {
    const names = new Set<string>();
    timelineEvents.forEach((event) => {
      if (event.type === 'stimulus') {
        names.add(event.name);
      }
    });
    return names.size;
  }, [timelineEvents]);

  const markerEventCount = React.useMemo(
    () => timelineEvents.filter((event) => event.type !== 'stimulus').length,
    [timelineEvents],
  );

  const handleFullReset = () => {
    clearCustomRange();
    if (customTimeRangeMode === 'scoped' && onClearTimeRange) onClearTimeRange();
    setIsSelectingRange(false);
    if (timelineSegments.length > 0) {
      setTimelineSegments([]);
      if (onSegmentsChange) onSegmentsChange([]);
    }
    if (onSegmentSelect) onSegmentSelect(null);
    if (onReset) onReset();
    else onSeek(0);
  };

  const trackSummary = React.useMemo(() => {
    if (pointTrackRenderData) {
      return isEn
        ? `(${pointTrackRenderData.count.toLocaleString()} mapped fixation points)`
        : `(${pointTrackRenderData.count.toLocaleString()} 个映射注视点)`;
    }
    if (stimulusCount > 0 || markerEventCount > 0) {
      return `(${stimulusCount} 个刺激物${markerEventCount > 0 ? `，${markerEventCount} 个标记` : ''})`;
    }
    if (showPlaybackTrack) {
      return '(基础播放时间轴)';
    }
    return '(暂无事件)';
  }, [isEn, markerEventCount, pointTrackRenderData, showPlaybackTrack, stimulusCount]);

  return (
    <div className="border-t border-slate-200 bg-slate-50">
      <div className="w-full px-4 py-2 flex items-center justify-between">
        <button
          onClick={() => setIsExpanded((prev) => !prev)}
          aria-expanded={isExpanded}
          className="mrt-button-text flex items-center gap-2 text-xs font-bold text-slate-600 hover:text-slate-800 transition-colors"
        >
          {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          <span>{isEn ? 'Timeline analysis' : '时间轴分析'}</span>
          <span className="text-slate-400 font-normal">{trackSummary}</span>
          {(customRangeStart !== null || customRangeEnd !== null) && <span className="text-red-500 font-normal">· 自定义范围</span>}
          {customTimeRangeMode === 'segment' && timelineSegments.length > 0 && (
            <span className="text-emerald-700 font-normal">
              · 全局统计范围（{enabledTimelineSegmentCount}/{timelineSegments.length} 段激活）
            </span>
          )}
          {customTimeRangeMode === 'scoped' && customTimeRangeTargetLabel && scopedTimeRanges.length > 0 && (
            <span className="text-sky-600 font-normal">
              · {customTimeRangeTargetLabel} 的 AOI 统计范围（{enabledScopedTimeRangeCount}/{scopedTimeRanges.length} 段已激活）
            </span>
          )}
          {selectedSegmentId && <span className="text-emerald-600 font-normal">· 已选择分段</span>}
        </button>
        <div className="flex items-center gap-2 text-[10px]">
          {canSwitchRangeMode && (
            <div className="flex items-center gap-1.5 text-slate-500">
              <span>拖选用途</span>
              <span className={customTimeRangeMode === 'segment' ? 'text-emerald-700' : 'text-slate-400'}>全局</span>
              <Switch
                checked={customTimeRangeMode === 'scoped'}
                aria-label="切换拖选用途"
                disabled={customTimeRangeMode !== 'scoped' && !canSwitchToScopedMode}
                onClick={toggleCustomTimeRangeMode}
                size="timeline"
                activeClass="bg-sky-600"
                inactiveClass={canSwitchToScopedMode ? 'bg-emerald-600' : 'bg-slate-300'}
              />
              <span className={customTimeRangeMode === 'scoped' ? 'text-sky-700' : 'text-slate-400'}>AOI 统计</span>
            </div>
          )}
          <button
            onClick={handleFullReset}
            className="mrt-button-text px-1 py-1 font-medium text-slate-700 underline underline-offset-2 transition-colors hover:text-slate-950"
          >
            {isEn ? 'Reset all' : '全部重置'}
          </button>
          {allowRangeSelection && (
            <button
              type="button"
              disabled={!canSelectCustomRange}
              onClick={toggleRangeSelection}
              aria-pressed={isSelectingRange}
              className={`mrt-button-text px-1 py-1 font-medium underline underline-offset-2 transition-colors ${
                isSelectingRange
                  ? 'text-red-600'
                  : canSelectCustomRange
                    ? 'text-slate-700 hover:text-slate-950'
                    : 'text-slate-400 cursor-not-allowed'
              }`}
            >
              {isSelectingRange ? '✓ 选择时间范围' : '选择时间范围'}
            </button>
          )}
        </div>
      </div>

      {isExpanded && (
        <div className="px-4 pb-4">
          {allowRangeSelection && (
            <div className="mb-3 text-[10px] text-slate-500">
              {customTimeRangeMode === 'scoped'
                ? customTimeRangeTargetLabel
                  ? `可重复选择多段；每段默认激活，并严格用于「${customTimeRangeTargetLabel}」的 AOI 统计。`
                  : '请先选择一个 AOI，再设置其统计范围。'
                : '点击起点和终点后，会保留原有的全局时间轴分段、播放和统计行为。'}
            </div>
          )}

          <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
            <div className="relative">
              {tracks.map((track, trackIdx) => (
                <div
                  key={track.id}
                  className={`border-b border-slate-100 ${trackIdx === tracks.length - 1 ? 'border-b-0' : ''}`}
                >
                  <div className="px-2 py-1 text-[9px] font-medium text-slate-400 border-b border-slate-100 bg-slate-50/60">
                    {track.name}
                  </div>
                  <div
                    data-timeline-track
                    className="relative cursor-pointer"
                    style={{ height: `${track.height}px` }}
                    onClick={(e) => {
                      setShowRangeClearButton(false);
                      const rect = e.currentTarget.getBoundingClientRect();
                      const x = e.clientX - rect.left;
                      const clickedTime = clampDisplaySecond((rect.width > 0 ? x / rect.width : 0) * durationSafe);
                      if (allowRangeSelection && canSelectCustomRange && isSelectingRange) {
                        if (customRangeStart === null) {
                          setCustomRangeStart(clickedTime);
                          setCustomRangeEnd(null);
                        } else {
                          const { startTime, endTime } = makeDisplaySecondRange(customRangeStart, clickedTime);
                          if (customTimeRangeMode === 'scoped') {
                            const overlapsExistingRange = scopedTimeRanges.some(
                              (range) => startTime < range.endTime && range.startTime < endTime,
                            );
                            if (overlapsExistingRange) {
                              setCustomRangeStart(null);
                              setCustomRangeEnd(null);
                              setIsSelectingRange(true);
                              window.alert('创建时间段失败，时间范围不能重叠');
                              return;
                            }
                            onTimeRangeChange?.(startTime, endTime);
                            setCustomRangeStart(null);
                            setCustomRangeEnd(null);
                            setIsSelectingRange(true);
                          } else {
                            setCustomRangeStart(startTime);
                            setCustomRangeEnd(endTime);
                            setIsSelectingRange(false);
                            if (onSegmentsChange) {
                              const defaultName = `分段 ${formatTime(startTime)} - ${formatTime(endTime)}`;
                              const result = addTimeSegment(
                                timelineSegments,
                                { name: defaultName, startTime, endTime, color: '#22c55e' },
                                { duration: timelineDuration },
                              );
                              if (!result.ok || !result.segment) {
                                window.alert(result.error || '创建时间段失败，时间范围不能重叠');
                              } else {
                                setTimelineSegments(result.segments);
                                onSegmentsChange(result.segments);
                                setCustomRangeStart(null);
                                setCustomRangeEnd(null);
                                if (onClearTimeRange) onClearTimeRange();
                              }
                            }
                          }
                        }
                        return;
                      }
                      if (track.id === 'point-track' && pointTrack?.onPointClick) {
                        pointTrack.onPointClick(clickedTime);
                      } else {
                        onSeek(clickedTime);
                      }
                    }}
                    onContextMenu={(e) => {
                      if (!allowRangeSelection) return;
                      setRangeClearSegmentId(null);
                      setScopedRangeClearId(null);
                      if (customRangeStart === null || customRangeEnd === null) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                      const clickedTime = clampDisplaySecond((rect.width > 0 ? x / rect.width : 0) * durationSafe);
                      const rangeStart = Math.min(customRangeStart, customRangeEnd);
                      const rangeEnd = Math.max(customRangeStart, customRangeEnd);
                      if (clickedTime < rangeStart || clickedTime > rangeEnd) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setShowRangeClearButton(true);
                      setRangeClearTrackId(track.id);
                    }}
                  >
                    {Array.from({ length: 11 }).map((_, i) => (
                      <div key={i} className="absolute top-0 bottom-0 border-l border-slate-100" style={{ left: `${i * 10}%` }} />
                    ))}

                    {track.pointPaths && track.pointResolution && (
                      <svg
                        className="absolute inset-0 h-full w-full pointer-events-none z-[12]"
                        viewBox={`0 0 ${track.pointResolution} 30`}
                        preserveAspectRatio="none"
                        aria-hidden="true"
                      >
                        {track.pointPaths.map((pointPath) => (
                          <path
                            key={pointPath.color}
                            d={pointPath.path}
                            fill="none"
                            stroke={pointPath.color}
                            strokeWidth="7"
                            strokeLinecap="butt"
                            opacity="0.72"
                          />
                        ))}
                      </svg>
                    )}

                    {track.id === 'point-track' && Number.isFinite(pointTrack?.selectedTimestamp) && (
                      <div
                        className="absolute top-0 bottom-0 z-[18] w-0.5 -translate-x-1/2 pointer-events-none"
                        style={{
                          left: `${Math.max(0, Math.min(100, (Number(pointTrack?.selectedTimestamp) / durationSafe) * 100))}%`,
                          backgroundColor: 'var(--app-text)',
                          boxShadow: '0 0 0 2px var(--app-surface)',
                        }}
                      />
                    )}

                    {track.id === 'stimulus' && customTimeRangeMode === 'segment' && timelineSegments.map((segment) => {
                      const start = Math.min(segment.startTime, segment.endTime);
                      const end = Math.max(segment.startTime, segment.endTime);
                      const left = (start / durationSafe) * 100;
                      const width = Math.max(0.2, ((end - start) / durationSafe) * 100);
                      const enabled = segment.enabled !== false;
                      return (
                        <div
                          key={`range-${track.id}-${segment.id}`}
                          className={`absolute top-[14%] h-[72%] rounded-sm border-2 z-[22] ${
                            enabled
                              ? 'bg-emerald-500/25 border-emerald-500/90'
                              : 'bg-slate-300/40 border-slate-400/90 border-dashed'
                          }`}
                          style={{ left: `${left}%`, width: `${width}%` }}
                          title={`全局统计范围 ${formatTime(start)} - ${formatTime(end)}（${enabled ? '激活，参与统计' : '未激活，不参与统计'}）`}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setShowRangeClearButton(true);
                            setRangeClearTrackId(track.id);
                            setRangeClearSegmentId(segment.id);
                            setScopedRangeClearId(null);
                          }}
                        >
                          <button
                            type="button"
                            aria-pressed={enabled}
                            className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded px-1.5 py-0.5 text-[9px] font-medium shadow-sm transition-colors z-[25] ${
                              enabled
                                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                                : 'bg-slate-600 text-white hover:bg-slate-700'
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setTimelineSegmentEnabled(segment.id, !enabled);
                            }}
                          >
                            {enabled ? '激活' : '未激活'}
                          </button>
                        </div>
                      );
                    })}

                    {track.id === 'stimulus' && customTimeRangeMode === 'scoped' && scopedTimeRanges.map((range) => {
                        const start = Math.min(range.startTime, range.endTime);
                        const end = Math.max(range.startTime, range.endTime);
                        const left = (start / durationSafe) * 100;
                        const width = Math.max(0.2, ((end - start) / durationSafe) * 100);
                        const enabled = range.enabled !== false;
                        return (
                          <div
                            key={`scoped-range-${track.id}-${range.id}`}
                            className={`absolute top-[14%] h-[72%] rounded-sm border-2 z-[22] ${
                              enabled ? 'bg-sky-500/25' : 'bg-slate-300/40 border-dashed'
                            }`}
                            style={{
                              left: `${left}%`,
                              width: `${width}%`,
                              borderColor: scopedRangeColor,
                            }}
                            title={`AOI 统计范围 ${formatTime(start)} - ${formatTime(end)}（${enabled ? '激活，参与统计' : '未激活，不参与统计'}）`}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setShowRangeClearButton(true);
                              setRangeClearTrackId(track.id);
                              setRangeClearSegmentId(null);
                              setScopedRangeClearId(range.id);
                            }}
                          >
                            <button
                              type="button"
                              aria-pressed={enabled}
                              className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded px-1.5 py-0.5 text-[9px] font-medium text-white shadow-sm transition-colors z-[25] ${
                                enabled ? 'bg-sky-600 hover:bg-sky-700' : 'bg-slate-600 hover:bg-slate-700'
                              }`}
                              onClick={(e) => {
                                e.stopPropagation();
                                onScopedTimeRangeEnabledChange?.(range.id, !enabled);
                              }}
                            >
                              {enabled ? '激活' : '未激活'}
                            </button>
                          </div>
                        );
                      })}

                    {track.events.map((event: TimelineEvent) => {
                      const startPercent = (event.startTime / durationSafe) * 100;
                      const endPercent = event.endTime ? (event.endTime / durationSafe) * 100 : startPercent;
                      const width = event.endTime ? endPercent - startPercent : 0;
                      const isInstant = event.endTime === undefined;
                      const isContinuousCustomMarker = event.type === 'customMarker' && event.endTime !== undefined;
                      const lane = instantEventLaneById.get(event.id) ?? 0;
                      const top = isInstant ? `calc(50% + ${(lane - 1) * 6}px)` : '50%';
                      const left = isInstant
                        ? `${Math.max(0.2, Math.min(99.8, startPercent))}%`
                        : `${startPercent}%`;
                      const eventWidth = isInstant ? '3px' : `${Math.max(width, 0.15)}%`;
                      const transform = isInstant ? 'translate(-50%, -50%)' : 'translateY(-50%)';
                      const eventZIndex = event.type === 'stimulus' ? 8 : 24;
                      return (
                        <div
                          key={event.id}
                          className="absolute group"
                          data-i18n-skip="true"
                          style={{
                            top,
                            left,
                            width: eventWidth,
                            height: event.endTime ? (isContinuousCustomMarker ? '64%' : '70%') : '60%',
                            transform,
                            zIndex: eventZIndex,
                          }}
                          title={`${event.name} - ${formatTime(event.startTime)}${event.endTime ? ` ~ ${formatTime(event.endTime)}` : ''}`}
                          onClick={(e) => {
                            if (isSelectingRange) return;
                            e.stopPropagation();
                            onSeek(clampDisplaySecond(event.startTime));
                          }}
                        >
                          {isContinuousCustomMarker ? (
                            <div className="relative w-full h-full">
                              <div
                                className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[2px] rounded-full"
                                style={{ backgroundColor: event.color, opacity: 0.95 }}
                              />
                              <div
                                className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[3px] h-[88%] rounded-sm"
                                style={{ backgroundColor: event.color, opacity: 1 }}
                              />
                              <div
                                className="absolute right-0 top-1/2 translate-x-1/2 -translate-y-1/2 w-[3px] h-[88%] rounded-sm"
                                style={{ backgroundColor: event.color, opacity: 1 }}
                              />
                            </div>
                          ) : (
                            <div className="w-full h-full rounded-sm" style={{ backgroundColor: event.color, opacity: 0.82 }} />
                          )}
                          {track.id === 'stimulus' && width > 8 && (
                            <div className="absolute inset-0 px-1 flex items-center justify-center text-[9px] font-medium text-white truncate pointer-events-none">
                              {event.name}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    <div className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-[26] pointer-events-none" style={{ left: `${(currentTime / durationSafe) * 100}%` }}>
                      <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-red-500 rounded-full" />
                    </div>

                    {track.id === 'stimulus' && customRangeStart !== null && (
                      <div
                        className="absolute top-0 bottom-0 w-[6px] bg-red-500 z-20 cursor-ew-resize"
                        style={{ left: `${(customRangeStart / durationSafe) * 100}%` }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setIsDraggingStart(true);
                        }}
                      />
                    )}
                    {track.id === 'stimulus' && customRangeEnd !== null && (
                      <div
                        className="absolute top-0 bottom-0 w-[6px] bg-red-500 z-20 cursor-ew-resize"
                        style={{ left: `${(customRangeEnd / durationSafe) * 100}%` }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setIsDraggingEnd(true);
                        }}
                      />
                    )}
                    {track.id === 'stimulus' && customRangeStart !== null && customRangeEnd !== null && (
                      <div
                        className="absolute top-0 bottom-0 bg-red-500/30 border-y-2 border-red-500/90 z-[23] pointer-events-none"
                        style={{
                          left: `${(Math.min(customRangeStart, customRangeEnd) / durationSafe) * 100}%`,
                          width: `${(Math.abs(customRangeEnd - customRangeStart) / durationSafe) * 100}%`,
                        }}
                      />
                    )}
                    {track.id === 'stimulus' && customRangeStart !== null &&
                      customRangeEnd !== null &&
                      showRangeClearButton &&
                      rangeClearTrackId === track.id && (
                        <button
                          type="button"
                          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 text-[9px] px-2 py-0.5 rounded bg-rose-500 text-white hover:bg-rose-600 z-[25]"
                          style={{
                            left: `${(((customRangeStart + customRangeEnd) / 2) / durationSafe) * 100}%`,
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            clearCustomRange();
                          }}
                        >
                          清除
                        </button>
                      )}
                    {showRangeClearButton &&
                      rangeClearTrackId === track.id &&
                      rangeClearSegmentId &&
                      (() => {
                        const segment = timelineSegments.find((item) => item.id === rangeClearSegmentId);
                        if (!segment) return null;
                        const center = ((segment.startTime + segment.endTime) / 2 / durationSafe) * 100;
                        return (
                          <button
                            type="button"
                            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 text-[9px] px-2 py-0.5 rounded bg-rose-500 text-white hover:bg-rose-600 z-[25]"
                            style={{ left: `${center}%` }}
                            onClick={(e) => {
                              e.stopPropagation();
                              const next = removeTimeSegment(timelineSegments, segment.id, { duration: timelineDuration });
                              setTimelineSegments(next);
                              if (onSegmentsChange) onSegmentsChange(next);
                              if (selectedSegmentId === segment.id && onSegmentSelect) onSegmentSelect(null);
                              setShowRangeClearButton(false);
                              setRangeClearTrackId(null);
                              setRangeClearSegmentId(null);
                            }}
                          >
                            清除
                          </button>
                        );
                      })()}
                    {showRangeClearButton &&
                      rangeClearTrackId === track.id &&
                      scopedRangeClearId &&
                      (() => {
                        const range = scopedTimeRanges.find((item) => item.id === scopedRangeClearId);
                        if (!range) return null;
                        const center = ((range.startTime + range.endTime) / 2 / durationSafe) * 100;
                        return (
                          <button
                            type="button"
                            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 text-[9px] px-2 py-0.5 rounded bg-sky-600 text-white hover:bg-sky-700 z-[25]"
                            style={{ left: `${center}%` }}
                            onClick={(e) => {
                              e.stopPropagation();
                              onScopedTimeRangeRemove?.(range.id);
                              setShowRangeClearButton(false);
                              setRangeClearTrackId(null);
                              setScopedRangeClearId(null);
                            }}
                          >
                            清除
                          </button>
                        );
                      })()}
                  </div>
                </div>
              ))}
            </div>
            <div
              className="border-t border-slate-100 px-2 py-1"
              style={{
                borderTopColor: 'var(--app-border)',
                backgroundColor: 'color-mix(in srgb, var(--app-surface-2) 65%, transparent)',
              }}
            >
              <div className="relative h-4">
                {Array.from({ length: 11 }).map((_, i) => {
                  const time = (durationSafe * i) / 10;
                  const baseStyle = { color: 'var(--app-muted)' } as const;
                  const baseClass = 'absolute top-0 text-[9px]';
                  if (i === 0) {
                    return (
                      <span
                        key={`tick-label-${i}`}
                        className={baseClass}
                        style={{ ...baseStyle, left: '0%' }}
                      >
                        {formatTickTime(time)}
                      </span>
                    );
                  }
                  if (i === 10) {
                    return (
                      <span
                        key={`tick-label-${i}`}
                        className={baseClass}
                        style={{ ...baseStyle, left: '100%', transform: 'translateX(-100%)' }}
                      >
                        {formatTickTime(time)}
                      </span>
                    );
                  }
                  return (
                    <span
                      key={`tick-label-${i}`}
                      className={baseClass}
                      style={{ ...baseStyle, left: `${i * 10}%`, transform: 'translateX(-50%)' }}
                    >
                      {formatTickTime(time)}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
