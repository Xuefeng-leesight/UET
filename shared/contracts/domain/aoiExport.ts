/** Explicit source-record context; mapping-image coordinates must never use video AOIs. */
export interface AoiExportContext {
  projectDir: string;
  recordId: string;
  deviceType?: string;
  videoWidth?: number;
  videoHeight?: number;
  coordinateSpace: 'original-video' | 'mapping';
  /**
   * Gaze columns are top-left 0–1 of the video (a Pupil/Huahong file in the
   * 7invensun layout), even for a 眼镜式 record whose 7invensun files are centred.
   */
  gazeFrame?: 'top-left-normalized';
}
