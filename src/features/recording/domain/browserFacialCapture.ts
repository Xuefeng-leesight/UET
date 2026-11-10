export type BrowserFacialCamera = {
  id: string;
  index: number;
  name: string;
  width: number;
  height: number;
};

export type BrowserFacialSample = {
  dataUrl: string;
  capturedAtMs: number;
  sequence: number;
  width: number;
  height: number;
};

export type BrowserFacialPreviewController = {
  stream: MediaStream;
  settings: MediaTrackSettings;
  stop: () => void;
};

export async function enumerateBrowserFacialCameras(
  fallbackWidth: number,
  fallbackHeight: number,
): Promise<BrowserFacialCamera[]> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    throw new Error('当前环境不支持浏览器摄像头采集');
  }
  const devices = (await navigator.mediaDevices.enumerateDevices())
    .filter((device) => device.kind === 'videoinput');
  return devices.map((device, index) => ({
    id: device.deviceId,
    index,
    name: device.label || `摄像头 ${index + 1}`,
    width: fallbackWidth,
    height: fallbackHeight,
  }));
}

function canvasToJpegDataUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('表情帧 JPEG 编码失败'));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('表情帧读取失败'));
      reader.readAsDataURL(blob);
    }, 'image/jpeg', 0.68);
  });
}

export async function startBrowserFacialPreview(params: {
  deviceId: string;
  width: number;
  height: number;
  fps: number;
  inferenceFps?: number;
  inferenceWidth?: number;
  onSample: (sample: BrowserFacialSample) => Promise<void>;
  onError?: (error: Error) => void;
}): Promise<BrowserFacialPreviewController> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前环境不支持浏览器摄像头采集');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      deviceId: params.deviceId ? { exact: params.deviceId } : undefined,
      width: { ideal: Math.max(1, params.width), max: Math.max(1, params.width) },
      height: { ideal: Math.max(1, params.height), max: Math.max(1, params.height) },
      frameRate: { ideal: Math.max(1, params.fps), max: Math.max(1, params.fps) },
    },
  });
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('无法创建表情帧采样画布');
  }

  const sampleIntervalMs = Math.round(1000 / Math.max(1, Math.min(8, params.inferenceFps || 8)));
  const maxWidth = Math.max(320, Math.min(960, params.inferenceWidth || 480));
  let stopped = false;
  let inferenceInFlight = false;
  let latestSampleRequested = false;
  let sequence = 0;
  let timerId: number | null = null;

  const drainLatestSample = async () => {
    if (stopped || inferenceInFlight || !latestSampleRequested) return;
    latestSampleRequested = false;
    inferenceInFlight = true;
    try {
      const sourceWidth = Math.max(1, video.videoWidth || params.width);
      const sourceHeight = Math.max(1, video.videoHeight || params.height);
      const scale = Math.min(1, maxWidth / sourceWidth);
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.drawImage(video, 0, 0, width, height);
      const dataUrl = await canvasToJpegDataUrl(canvas);
      if (!stopped) {
        sequence += 1;
        await params.onSample({ dataUrl, capturedAtMs: performance.now(), sequence, width, height });
      }
    } catch (error) {
      if (!stopped) params.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      inferenceInFlight = false;
      if (!stopped && latestSampleRequested) void drainLatestSample();
    }
  };

  timerId = window.setInterval(() => {
    // A boolean is the entire queue: while inference is busy, every new tick
    // replaces the previous pending request with the newest camera frame.
    latestSampleRequested = true;
    void drainLatestSample();
  }, sampleIntervalMs);
  latestSampleRequested = true;
  void drainLatestSample();

  return {
    stream,
    settings: stream.getVideoTracks()[0]?.getSettings() || {},
    stop() {
      if (stopped) return;
      stopped = true;
      latestSampleRequested = false;
      if (timerId !== null) window.clearInterval(timerId);
      timerId = null;
      video.pause();
      video.srcObject = null;
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}
