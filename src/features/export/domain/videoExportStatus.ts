export type VideoExportSource = 'visual' | 'record-detail';

export type VideoExportPhase = 'rendering' | 'encoding' | 'done' | 'failed';

export interface VideoExportStatus {
  taskId: string;
  source: VideoExportSource;
  phase: VideoExportPhase;
  progress: number;
  label: string;
  recordName: string;
  outputPath?: string;
  updatedAt: number;
}
