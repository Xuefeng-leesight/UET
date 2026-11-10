/** Explicit source-record context; mapping-image coordinates must never use video AOIs. */
export interface AoiExportContext {
  projectDir: string;
  recordId: string;
  deviceType?: string;
  videoWidth?: number;
  videoHeight?: number;
  coordinateSpace: 'original-video' | 'mapping';
}
