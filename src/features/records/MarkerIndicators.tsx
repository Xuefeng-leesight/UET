import React from 'react';
import { Tag, Zap } from 'lucide-react';
import type { RecordingMarker } from '@shared/contracts/domain/recording';

interface MarkerIndicatorsProps {
  markers: RecordingMarker[];
  recordingStartTime: number;
}

/**
 * 录制标记实时显示组件
 * 在录制界面实时显示新添加的标记
 */
const MarkerIndicators: React.FC<MarkerIndicatorsProps> = ({ markers, recordingStartTime }) => {
  const [currentTime, setCurrentTime] = React.useState(Date.now());

  React.useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 100);
    return () => clearInterval(interval);
  }, []);

  // 只显示最近5秒内的标记
  const recentMarkers = markers.filter((marker) => {
    const age = currentTime - (recordingStartTime + marker.timestamp);
    return age < 5000 && age >= 0;
  });

  if (recentMarkers.length === 0) {
    return null;
  }

  return (
    <div className="absolute top-4 right-4 z-20 space-y-2 pointer-events-none">
      {recentMarkers.map((marker, index) => {
        const age = currentTime - (recordingStartTime + marker.timestamp);
        const opacity = Math.max(0, 1 - age / 5000);

        return (
          <div
            key={`${marker.timestamp}-${index}`}
            className="flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg backdrop-blur-sm transition-opacity duration-300"
            style={{
              backgroundColor: marker.type === 'custom' ? 'rgba(59, 130, 246, 0.9)' : 'rgba(234, 179, 8, 0.9)',
              opacity,
            }}
          >
            {marker.type === 'custom' ? (
              <Tag size={16} className="text-white" />
            ) : (
              <Zap size={16} className="text-white" />
            )}
            <div className="flex flex-col">
              <span className="text-xs font-semibold text-white">
                {marker.type === 'custom' ? <span data-i18n-skip="true">{marker.name}</span> : `触发 ${marker.triggerValue}`}
              </span>
              <span className="text-[10px] text-white/80">
                {(marker.timestamp / 1000).toFixed(2)}s
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default MarkerIndicators;
