export interface MountainChartSettings {
  heightScale: number;
  opacity: number;
  gridResolution: number;
  wireframe: boolean;
  showVideo: boolean;
  showGrid: boolean;
  peakSmoothing: number;
}

export const DEFAULT_MOUNTAIN_SETTINGS: MountainChartSettings = {
  heightScale: 0.6,
  opacity: 0.5,
  gridResolution: 100,
  wireframe: false,
  showVideo: true,
  showGrid: false,
  peakSmoothing: 0.3,
};

export interface MountainChartHandle {
  resetCamera: () => void;
  getCanvas: () => HTMLCanvasElement | null;
}
