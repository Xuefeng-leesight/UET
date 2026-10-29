import React from 'react';
import { playbackProgressPercent } from '@/features/records/domain/playback/playbackMediaModel';

export type PlaybackTimelineMarker = { key: string; left: number; title: string };

export const RecordPlaybackTimeline: React.FC<{
  durationSeconds: number;
  currentTimeSeconds: number;
  ready: boolean;
  markers: PlaybackTimelineMarker[];
  onSeek: (seconds: number) => void;
}> = ({ durationSeconds, currentTimeSeconds, ready: mediaReady, markers, onSeek }) => {
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const ready = mediaReady && Number.isFinite(durationSeconds) && durationSeconds > 0;
  const progress = playbackProgressPercent(currentTimeSeconds, durationSeconds);

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!ready) return;
    const rect = (trackRef.current || event.currentTarget).getBoundingClientRect();
    if (!Number.isFinite(rect.width) || rect.width < 2) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    onSeek(ratio * durationSeconds);
  };

  return (
    <div
      ref={trackRef}
      className={`relative h-4 w-full group flex items-center ${ready ? 'cursor-pointer' : 'cursor-wait opacity-60'}`}
      onClick={handleClick}
      aria-disabled={!ready}
      aria-label={ready ? '回放进度条' : '正在读取视频时长'}
    >
      <div className="absolute w-full h-1 bg-slate-200 rounded-full overflow-hidden">
        <div className="h-full bg-sky-500" style={{ width: `${progress}%` }} />
      </div>
      {ready && markers.map((marker) => (
        <div
          key={marker.key}
          className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-amber-400 border border-white z-10 shadow-sm transform hover:scale-150 transition-transform"
          style={{ left: `${marker.left}%` }}
          title={marker.title}
        />
      ))}
      <div
        className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white border-2 border-sky-500 rounded-full shadow-sm z-20 group-hover:scale-125 transition-transform pointer-events-none"
        style={{ left: `${progress}%` }}
      />
    </div>
  );
};
