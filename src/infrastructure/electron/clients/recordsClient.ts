import { invokeSafe, invokeSafeNoPayload } from '@/infrastructure/electron/ipcCore';
import type { AoiExportContext } from '@shared/contracts/domain/aoiExport';
import type { LoadRecordingsResult, GetRecordVideoUrlResult, CsvPreviewResult, LoadRecordPointsResult, ComputeAoiStatsResult, SaveRecordMetaResult, SaveEyeDataCsvResult, SaveCalibrationResultResult, LoadCalibrationResultResult, ExportRecordsCsvResult, DeleteRecordingResult, LoadAoiResult, SaveAoiResult, RepairRecordVideoResult, NormalizeProjectRecordVideosResult } from '@/infrastructure/electron/ipcTypes';

export const recordsIpcClient = {
  loadRecordings: async (payload: {
    projectDir: string;
  }): Promise<LoadRecordingsResult> => {
    return invokeSafe<LoadRecordingsResult>('load-recordings', payload, { ok: false, records: [] });
  },

  loadAoi: async (payload: { projectDir: string }): Promise<LoadAoiResult> => {
    return invokeSafe<LoadAoiResult>('load-aoi', payload, { ok: false, data: null });
  },

  saveAoi: async (payload: { projectDir: string; recordId: string; shapes: unknown[] }): Promise<SaveAoiResult> => {
    return invokeSafe<SaveAoiResult>('save-aoi', payload, { ok: false });
  },

  getRecordVideoUrl: async (payload: {
    projectDir: string;
    name: string;
    recordPath?: string;
  }): Promise<GetRecordVideoUrlResult> => {
    return invokeSafe<GetRecordVideoUrlResult>('get-record-video-url', payload, { ok: false, url: null });
  },

  repairRecordVideo: async (payload: { mp4Path: string }): Promise<RepairRecordVideoResult> => {
    return invokeSafe<RepairRecordVideoResult>('repair-record-video', payload, { ok: false, url: null });
  },

  normalizeProjectRecordVideos: async (payload: { projectDir: string; taskId?: string; deviceType?: '桌面式' | '眼镜式' }): Promise<NormalizeProjectRecordVideosResult> => {
    return invokeSafe<NormalizeProjectRecordVideosResult>('normalize-project-record-videos', payload, {
      ok: false,
      scanned: 0,
      compatible: 0,
      transcoded: 0,
      failed: 0,
      results: [],
    });
  },

  previewRecordCsv: async (payload: { csvPath: string; maxRows?: number; aoiContext?: AoiExportContext }): Promise<CsvPreviewResult> => {
    return invokeSafe<CsvPreviewResult>('preview-record-csv', payload, { ok: false, headers: [], rows: [] });
  },

  loadRecordPoints: async (payload: {
    csvPath: string;
    pointMode?: 'auto' | 'fixation' | 'gaze';
    pointSource?: 'recommended' | 'raw' | 'smooth';
    includeSdkSaccades?: boolean;
    /** Exact event data plus separate actual pupil samples for statistical analysis. */
    includePupilSamples?: boolean;
    includeMarkerOnlyRows?: boolean;
    isGlassesMode?: boolean;
    frameWidth?: number;
    frameHeight?: number;
    maxPoints?: number;
    startTimeMs?: number;
    endTimeMs?: number;
    aggregateForHeatmap?: boolean;
    viewportWidth?: number;
    viewportHeight?: number;
  }): Promise<LoadRecordPointsResult> => {
    return invokeSafe<LoadRecordPointsResult>('load-record-points', payload, { ok: false, points: [] });
  },

  computeAoiStats: async (payload: {
    jobs: Array<{
      recordId: string;
      participantKey: string;
      shapes: unknown[];
      points: unknown[];
      recordDurationMs: number;
      blinkData?: import('@shared/contracts/domain/analysis').BlinkIntervalData;
    }>;
  }): Promise<ComputeAoiStatsResult> => {
    return invokeSafe<ComputeAoiStatsResult>('compute-aoi-stats', payload, {
      ok: false,
      rowsByRecordId: {},
    });
  },

  saveRecordMeta: async (payload: { projectDir: string; recordName: string; meta: unknown }): Promise<SaveRecordMetaResult> => {
    return invokeSafe<SaveRecordMetaResult>('save-record-meta', payload, { ok: false });
  },

  deleteRecording: async (payload: {
    projectDir: string;
    recordName: string;
    recordPaths?: string[];
  }): Promise<DeleteRecordingResult> => {
    return invokeSafe<DeleteRecordingResult>('delete-recording', payload, { ok: false, deleted: [], missing: [] });
  },

  exportRecordsCsv: async (payload: {
    records: {
      id: string;
      name: string;
      csvPath: string;
      projectDir?: string;
      deviceType?: string;
      subjectName?: string;
      subjectInfo?: Record<string, string>;
      metadataValues?: Record<string, string>;
      timestamp?: string;
      validityPercent?: number;
      samplingRateHz?: number;
      configuredSamplingRateHz?: number;
      durationSeconds?: number;
      videoWidth?: number;
      videoHeight?: number;
    }[];
    columns: string[];
    headerMap?: Record<string, string>;
    columnSourceMap?: Record<string, string[]>;
    columnJoinSourceMap?: Record<string, string[][]>;
  }): Promise<ExportRecordsCsvResult> => {
    return invokeSafe<ExportRecordsCsvResult>('export-records-csv', payload, { ok: false });
  },

  saveEyeDataCsv: async (payload: { projectDir: string; recordName: string; rows: unknown[] }): Promise<SaveEyeDataCsvResult> => {
    return invokeSafe<SaveEyeDataCsvResult>('save-eye-data-csv', payload, { ok: false });
  },

  saveCalibrationResult: async (payload: { experimentDir: string; subjectId?: string; result: unknown }): Promise<SaveCalibrationResultResult> => {
    return invokeSafe<SaveCalibrationResultResult>('save-calibration-result', payload, { ok: false });
  },

  loadCalibrationResult: async (payload: { experimentDir: string; subjectId?: string }): Promise<LoadCalibrationResultResult> => {
    return invokeSafe<LoadCalibrationResultResult>('load-calibration-result', payload, { ok: false, result: null });
  }
};
