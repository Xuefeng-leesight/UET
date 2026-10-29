import React from 'react';
import { createRoot } from 'react-dom/client';
import RecordingPage from '../../../src/features/recording/RecordingPage';
import FullscreenCalibrationOverlay from '../../../src/features/recording/FullscreenCalibrationOverlay';
import { createEyeDataStore } from '../../../src/features/recording/domain/recordingEyeDataStore';
import type { RecordingSettings } from '../../../src/features/recording/domain/recordingContracts';
import { useDomTranslation } from '../../../src/app/i18n/useDomTranslation';
import { getPupilCalibrationSequence } from '../../../src/features/recording/domain/calibrationFlow';
import { getDeviceProfile } from '../../../src/features/recording/device/deviceProfile';
import '../../../index.css';

// UI-only harness: actual shared recording component, synthetic camera image.
function Check() {
  const query = new URLSearchParams(window.location.search);
  const legacy = query.has('legacy');
  const validation = query.has('validation');
  const english = query.has('en');
  const count = [3, 5, 9].includes(Number(query.get('points'))) ? Number(query.get('points')) : 9;
  const offset = Math.max(0, Math.min(count - 1, Number(query.get('step') || 1) - 1));
  const calibrationTypes = getDeviceProfile('眼镜式', 'PupilCore').calibrationTypes;
  const sequence = getPupilCalibrationSequence(validation ? 3 : count);
  const boundary = query.has('boundary');
  useDomTranslation(english ? 'en-US' : 'zh-CN');
  const [eyeDataStore] = React.useState(() => createEyeDataStore({}));
  const imageRef = React.useRef<HTMLImageElement>(null);
  const [lastImageAt, setLastImageAt] = React.useState(Date.now());
  const [points, setPoints] = React.useState<Array<{ x: number; y: number }>>([]);
  const [detection, setDetection] = React.useState<{
    point: { x: number; y: number } | null; status: 'idle' | 'detecting' | 'ready' | 'submitting' | 'error'; message: string;
  }>({ point: null, status: 'idle', message: '' });
  const [settings, setSettings] = React.useState<RecordingSettings>({
    subjectId: '', bgColor: '#fff', randomOrder: false, externalMarkers: false,
    endOnClick: false, endOnKey: false, calibrationType: calibrationTypes[[3, 5, 9].indexOf(count)],
    showEyeImage: false, saveRawData: true, saveEyeCalibration: false,
    calibrationPointStyle: 'spread', hideGaze: true, recordMouse: false,
    splitScreenMode: false, sdkEnvironment: 301, sdkResolution: 202, recordingViewMode: 'local',
  });
  React.useEffect(() => {
    if (legacy) return;
    const image = imageRef.current;
    const cx = boundary ? 832 : 320;
    const cy = boundary ? 173 : 360;
    if (image) image.src = 'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#334155"/><rect x="${cx - 100}" y="${cy - 150}" width="200" height="300" rx="10" fill="white"/><circle cx="${cx}" cy="${cy}" r="60" fill="black"/><circle cx="${cx}" cy="${cy}" r="35" fill="white"/><circle cx="${cx}" cy="${cy}" r="8" fill="black"/></svg>`);
    const timer = window.setInterval(() => setLastImageAt(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [legacy, boundary]);
  return <>
    <output data-testid="selected-points">UI回归模拟相机（非真实设备）：{JSON.stringify(points)}</output>
    {legacy ? <FullscreenCalibrationOverlay language="zh-CN" calibrationState="calibrating"
      calibPointIndex={4} calibScale={1} eyeDataStore={eyeDataStore} />
      : <div style={{ height: 'calc(100vh - 30px)' }}><RecordingPage playbackIndex={null} stimuli={[]}
          wsConnected imageCanvasRef={imageRef} isCameraOn lastImageAt={lastImageAt}
          wsIp="127.0.0.1" wsImagePort="9001" subjects={[]} recordingSettings={settings}
          setRecordingSettings={setSettings} eyeDataStore={eyeDataStore} calibrationScores={null}
          calibrationMode="click" calibrationState="calibrating" cardCalibrationActive
          isPupilCardCalibration isCalibrationTrackerReady isCalibrationTestMode={validation}
          language={english ? 'en-US' : 'zh-CN'}
          cardDetectedPoint={detection.point} cardDetectionStatus={detection.status} cardDetectionMessage={detection.message}
          onCardDetectionUpdate={setDetection}
          onCardCalibrationTrigger={() => { if (detection.point) setPoints(prev => [...prev, detection.point!]); }}
          calibPointIndex={sequence[Math.min(sequence.length - 1, offset + points.length)]}
          cardCompletedPoints={[...Array.from({ length: offset }, () => ({ x: 0, y: 0 })), ...points]}
          onInlineCalibrationPoint={(point) => setPoints((prev) => [...prev, point])}
          calibrationTypes={calibrationTypes} stimulusEnabled={false} />
        </div>}
  </>;
}
createRoot(document.getElementById('root')!).render(<Check />);
