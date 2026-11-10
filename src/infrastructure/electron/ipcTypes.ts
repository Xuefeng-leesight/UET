import type { Project, RecordingRecord, Subject } from '@shared/contracts/domain/models';
import type {
  MultiplayerCommand,
  MultiplayerCommandType,
  MultiplayerSnapshot,
} from '@shared/contracts/domain/multiplayer';
import type {
  AiAnalysisMode,
  AiAnalysisResult,
  AiCompressionMeta,
  AiSettings,
  AiSettingsUpdate,
  AiTokenUsage,
  CompareResult,
  InsightReport,
  ReportExportArtifact,
  SingleRecordAiReport,
} from '@shared/contracts/domain/reporting';
export type {
  LicenseActionResult,
  LicenseEnvelope,
  LicenseModuleGrant,
  LicenseStateSummary,
  TestToolInfo,
  TestToolListResult,
  UpdateCheckResult,
} from '@shared/contracts/licensing';

export type { Project, RecordingRecord, Subject } from '@shared/contracts/domain/models';
export type { MultiplayerCommand, MultiplayerCommandType, MultiplayerSnapshot } from '@shared/contracts/domain/multiplayer';
export type { AiAnalysisMode, AiAnalysisResult, AiCompressionMeta, AiSettings, AiSettingsUpdate, AiTokenUsage, CompareResult, InsightReport, ReportExportArtifact, SingleRecordAiReport } from '@shared/contracts/domain/reporting';

type IpcRendererLike = NonNullable<Window['ipcRenderer']>;

export type SelectProjectRootResult = { canceled: true } | { canceled: false; rootPath: string };

export type InitProjectStructureResult =
  | { ok: false; message?: string }
  | { ok: true; projectDir: string; createdDirs: string[]; message?: never };

export type LoadProjectsResult = { ok: false; projects: Project[]; projectDirs?: Record<string, string> } | { ok: true; projects: Project[]; projectDirs: Record<string, string> };

export type LoadRecordingsResult = { ok: false; records: RecordingRecord[] } | { ok: true; records: RecordingRecord[] };

export type LoadSubjectsResult = { ok: false; subjects: Subject[] } | { ok: true; subjects: Subject[] };

export type SaveOkResult = { ok: false; message?: string } | { ok: true };

export type SaveStimuliResult =
  | { ok: false; message?: string; code?: 'STIMULUS_NAME_LOCKED'; records?: string[] }
  | { ok: true; path: string; count: number; message?: never; code?: never };

export type LoadSubjectFieldsResult = { ok: false; fields: unknown[] } | { ok: true; fields: unknown[] };

export type LoadStimuliResult = { ok: false; stimuli: unknown[] } | { ok: true; stimuli: unknown[] };

export type ImportStimuliResult =
  | { ok: false; stimuli: unknown[]; message?: string; asset?: unknown }
  | { ok: true; stimuli: unknown[]; message?: string; asset?: unknown };

export type StartStimulusScreenRecordingResult =
  | { ok: false; message?: string }
  | { ok: true; sessionId: string };

export type ImportComboAssetsResult =
  | { ok: false; assets: unknown[]; message?: string }
  | { ok: true; assets: unknown[] };

export type GetRecordVideoUrlResult = { ok: false; url: null } | { ok: true; url: string };

export type GetStimulusMediaUrlResult = { ok: false; url: null } | { ok: true; url: string };

export type CsvPreviewResult =
  | { ok: false; headers: string[]; rows: string[][]; message?: string }
  | { ok: true; headers: string[]; rows: string[][]; fileSizeBytes: number; truncated: boolean; derivedAoiRows?: Record<string, string>[] };

export type LoadRecordPointsResult =
  | { ok: false; points: []; message?: string }
  | {
      ok: true;
      points: unknown[];
      pupilSamples?: unknown[];
      blinkData?: import('@shared/contracts/domain/analysis').BlinkIntervalData;
      fileSizeBytes: number;
      totalRows: number;
      parsedPoints: number;
      truncated: boolean;
      indexUsed?: boolean;
      indexPath?: string;
      indexCreatedAt?: string;
    };

export type ComputeAoiStatsResult =
  | { ok: false; rowsByRecordId: Record<string, unknown[]>; message?: string }
  | { ok: true; rowsByRecordId: Record<string, unknown[]> };

export type SaveRecordMetaResult = { ok: false; message?: string } | { ok: true; path: string };

export type SetWindowFullScreenResult = { ok: false } | { ok: true };

export type ShowInFinderResult = { ok: false; message?: string } | { ok: true };

export type SaveEyeDataCsvResult = { ok: false; message?: string } | { ok: true; path: string };

export type SaveCalibrationResultResult = { ok: false; message?: string } | { ok: true; path: string };

export type LoadCalibrationResultResult =
  | { ok: false; result: null; message?: string }
  | { ok: true; result: unknown | null };

export type LoadTriggerConfigResult =
  | { ok: false; config: null }
  | { ok: true; config: import('@shared/contracts/ipc/communication').TriggerNetworkConfig };

export type TcpStreamingStatusResult =
  | { ok: false; listening: false; clientCount: 0; message?: string }
  | { ok: true; listening: boolean; clientCount: number; address: string; port: number; message?: string };

export type ScreenInfo = {
  id: number;
  label: string;
  isPrimary: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
};

export type ScreenConfig = {
  enabled: boolean;
  experimenterDisplayId: number | null;
  participantDisplayId: number | null;
};

export type RecordingCaptureDisplay = Pick<ScreenInfo, 'id' | 'isPrimary' | 'bounds' | 'scaleFactor'>;

export type GetScreensResult =
  | { ok: false; screens: ScreenInfo[]; message?: string }
  | { ok: true; screens: ScreenInfo[] };

export type LoadScreenConfigResult =
  | { ok: false; config: ScreenConfig; warnings: string[]; message?: string }
  | { ok: true; config: ScreenConfig; warnings: string[] };

export type SaveScreenConfigResult =
  | { ok: false; message?: string }
  | { ok: true; path?: string; config: ScreenConfig; warnings: string[] };

export type ValidateScreenConfigResult = { ok: true; config: ScreenConfig; warnings: string[] };

export type CreateRecordingWindowResult =
  | { ok: false; message?: string; config?: ScreenConfig; warnings?: string[]; hasParticipantWindow?: boolean; participantReady?: boolean; captureDisplay?: RecordingCaptureDisplay }
  | { ok: true; config?: ScreenConfig; warnings?: string[]; hasParticipantWindow?: boolean; participantReady?: boolean; captureDisplay?: RecordingCaptureDisplay };

export type RecordingMonitorSnapshotsResult =
  | { ok: false; participant: null; message?: string }
  | { ok: true; participant: string | null; hasParticipantWindow: boolean };

export type SaveFileResult =
  | { ok: false; error?: string }
  | { ok: true; path: string };

export type LoadFileResult =
  | { ok: false; error?: string }
  | { ok: true; path: string; content?: string; contentBase64?: string };

export type CreateDirectoryResult =
  | { ok: false; error?: string }
  | { ok: true; path: string };

export type SendTriggerResult = 
  | { ok: false; message?: string }
  | { ok: true };

export type MultiplayerSnapshotResult =
  | { ok: false; message?: string }
  | { ok: true; snapshot: MultiplayerSnapshot };

export type MultiplayerCommandResult =
  | { ok: false; message?: string }
  | { ok: true; command: MultiplayerCommand; snapshot: MultiplayerSnapshot };

export type MultiplayerPackageSyncResult =
  | { ok: false; message?: string }
  | { ok: true; version: string; packageRoot: string; fileCount: number; totalBytes: number };

export type ExportRecordsCsvResult =
  | { ok: false; message?: string; exportDir?: '' }
  | { ok: true; exportDir: string; files: string[] };

export type DeleteStimulusResult =
  | { ok: false; message?: string; code?: 'STIMULUS_IN_USE'; records?: string[]; stimuli?: string[] }
  | { ok: true; stimuli: unknown[]; deletedFiles?: string[]; fileDeleteErrors?: string[]; message?: never; code?: never };

export type CheckStimulusUsageResult =
  | { ok: false; message?: string }
  | { ok: true; inUse: boolean; records: string[]; stimuli: string[]; message?: never };

export type DeleteRecordingResult =
  | { ok: false; message?: string; deleted?: string[]; missing?: string[] }
  | { ok: true; deleted: string[]; missing: string[] };

export type LoadAoiResult = { ok: false; data: null; message?: string } | { ok: true; data: unknown };

export type SaveAoiResult = { ok: false; message?: string } | { ok: true; path: string };

export type SaveProjectMetaResult = { ok: false; message?: string } | { ok: true; path: string };

export type BackupProjectResult = { ok: false; message?: string } | { ok: true; destDir: string };

export type ExportProjectResult = { ok: false; message?: string } | { ok: true; destDir: string };

export type DeleteProjectResult = { ok: false; message?: string } | { ok: true; deletedDir: string };

export type ExportVideoFastResult =
  | { ok: false; message?: string; reason?: string }
  | { ok: true; path: string };

export type ExportImageFastResult =
  | { ok: false; message?: string; reason?: string }
  | { ok: true; path: string };

export type ExportTextFastResult =
  | { ok: false; message?: string; reason?: string }
  | { ok: true; path: string };

export type ExportChartReportBundleResult =
  | { ok: false; message?: string; reason?: string; exportDir?: string; files?: string[]; failed?: string[] }
  | { ok: true; exportDir: string; files: string[]; failed: string[] };

export type SelectExistingProjectResult =
  | { ok: false; message?: string }
  | { ok: true; projectDir: string; project: unknown };

export type LoadProjectMetaResult =
  | { ok: false; message?: string }
  | { ok: true; projectDir: string; project: unknown };

export type SetActiveProjectDeviceTypeResult =
  | { ok: false; message?: string }
  | { ok: true; deviceType: '桌面式' | '眼镜式'; model: string };

export type ListExperimentsResult =
  | { ok: false; message?: string; experiments: unknown[] }
  | { ok: true; experiments: unknown[] };

export type CreateExperimentResult =
  | { ok: false; message?: string }
  | { ok: true; experiment: unknown };

export type DeleteExperimentResult =
  | { ok: false; message?: string }
  | { ok: true; deletedDir: string; deletedId: string };

export type RepairRecordVideoResult =
  | { ok: false; url: null; message?: string }
  | { ok: true; url: string };

export type NormalizeProjectRecordVideosResult =
  | {
      ok: false;
      message?: string;
      scanned: number;
      compatible: number;
      transcoded: number;
      failed: number;
      results: Array<{
        path: string;
        status: 'compatible' | 'transcoded' | 'failed';
        codecBefore: string | null;
        codecAfter: string | null;
        message?: string;
      }>;
    }
  | {
      ok: true;
      message?: never;
      scanned: number;
      compatible: number;
      transcoded: number;
      failed: number;
      results: Array<{
        path: string;
        status: 'compatible' | 'transcoded' | 'failed';
        codecBefore: string | null;
        codecAfter: string | null;
        message?: string;
      }>;
    };

export type VideoDebugLogResult =
  | { ok: false; message?: string; logFilePath?: string | null }
  | { ok: true; logFilePath?: string | null };

export type GetVideoDebugLogPathResult =
  | { ok: false; logFilePath: null }
  | { ok: true; logFilePath: string | null };

export type GetLocalIpAddressesResult =
  | { ok: false; addresses: string[]; primary: string; message?: string }
  | { ok: true; addresses: string[]; primary: string };

export type SelectGazeMappingFileResult =
  | { canceled: true; message?: string; path?: never; url?: never; name?: never }
  | { canceled: false; path: string; url: string | null; name: string };

export type GazeMappingPoint = {
  timestampMs: number;
  x: number;
  y: number;
  weight?: number;
  durationMs?: number;
  sourceId?: number | string;
  confidence: number;
  inherited: boolean;
  manualCalibrated?: boolean;
  calibratedAt?: string;
  originalX?: number;
  originalY?: number;
  deleted?: boolean;
  deletedAt?: string;
};

export type GazeMappingResultData = {
  version: number;
  imageRef: string;
  resolution: { width: number; height: number };
  video: { name: string; fps: number; width: number; height: number };
  settings: { algorithm: string; keyframeIntervalFrames: number };
  summary: {
    inputPoints: number;
    mappedPoints: number;
    mappingRate: number;
    keyframes: number;
    matchedKeyframes: number;
    inheritedKeyframes: number;
  };
  gazeData: GazeMappingPoint[];
  recordId?: string;
  recordName?: string;
  createdAt?: string;
  imagePath?: string;
  imageUrl?: string | null;
  videoPath?: string;
  videoUrl?: string | null;
};

export type RunGazeMappingResult =
  | { ok: false; message?: string }
  | { ok: true; outputPath: string; result: GazeMappingResultData; message?: never };

export type SaveCompareResultResult =
  | { ok: false; message?: string }
  | { ok: true; path: string; compareId: string };

export type LoadCompareResultResult =
  | { ok: false; message?: string; compareResult: null; path?: string | null }
  | { ok: true; compareResult: CompareResult | null; path?: string | null };

export type SaveInsightReportResult =
  | { ok: false; message?: string }
  | { ok: true; path: string; reportId: string };

export type LoadInsightReportResult =
  | { ok: false; message?: string; report: null; path?: string | null }
  | { ok: true; report: InsightReport | null; path?: string | null };

export type ExportInsightReportBundleResult =
  | { ok: false; message?: string; exportDir?: string; artifacts?: ReportExportArtifact[] }
  | { ok: true; exportDir: string; artifacts: ReportExportArtifact[] };

export type LoadAiSettingsResult =
  | { ok: false; message?: string; settings: null }
  | { ok: true; settings: AiSettings };

export type SaveAiSettingsResult =
  | { ok: false; message?: string; settings?: AiSettings | null }
  | { ok: true; settings: AiSettings };

export type TestAiConnectionResult =
  | { ok: false; message?: string; model?: string; provider?: string; latencyMs?: number }
  | { ok: true; model: string; provider: string; latencyMs: number };

export type RunAiAnalysisResult =
  | { ok: false; message?: string; code?: string }
  | {
      ok: true;
      mode: AiAnalysisMode;
      result: AiAnalysisResult;
      compression: AiCompressionMeta;
      usage?: AiTokenUsage;
      provider: string;
      model: string;
      report?: SingleRecordAiReport;
      path?: string;
      retriedByAggressiveCompression?: boolean;
    };

export type LoadSingleRecordAiReportResult =
  | { ok: false; message?: string; report: null }
  | { ok: true; report: SingleRecordAiReport | null };

export type StartRecordingAudioResult =
  | { ok: false; message?: string }
  | { ok: true; sessionId: string; message?: never };

export type RecordingAudioWriteResult =
  | { ok: false; message?: string }
  | { ok: true; message?: never };

export type FinishRecordingAudioResult =
  | { ok: false; message?: string }
  | { ok: true; videoPath: string; message?: never };

// --- Facial Analysis types ---

export interface FacialRecordingRecord {
  id: string;
  name: string;
  subjectName?: string;
}

export interface FacialCamera {
  id: string;
  index: number;
  name: string;
  width: number;
  height: number;
  backend?: string;
}

export interface FacialTimelineEvent {
  label: string;
  startMs: number;
  apexMs: number;
  endMs: number;
  peak: number;
}

export interface FacialAnalysisManifest {
  alignment?: {
    timeBase: string;
    sourceOffsetMs: number;
    method: string;
    confirmed?: boolean;
  };
}

export interface FacialAnalysisResultData {
  source: { durationMs: number; width?: number; height?: number; fps?: number };
  quality: { validFaceRatio: number };
  tracks: {
    emotion?: { available: boolean; events: FacialTimelineEvent[]; reason?: string };
    microExpression: { available: boolean; events: FacialTimelineEvent[]; reason?: string };
    expression: { available: boolean; events: FacialTimelineEvent[]; reason?: string };
  };
  samples: Array<{ timestampMs: number; t?: number; faceCount?: number; quality?: number; expressions: Record<string, number>; emotion?: string; emotionScores?: Record<string, number>; basicEmotionLabel?: string; basicEmotionScores?: Record<string, number>; faceBox?: { x: number; y: number; w: number; h: number } | null; landmarks?: Array<{ x: number; y: number }> }>;
}

export type ListFacialRecordsResult =
  | { ok: false; records: FacialRecordingRecord[]; message?: string }
  | { ok: true; records: FacialRecordingRecord[]; message?: string };

export type LoadFacialAnalysisResult =
  | { ok: false; manifest: FacialAnalysisManifest; result: null; videoUrl: null; message?: string }
  | { ok: true; manifest: FacialAnalysisManifest; result: FacialAnalysisResultData; videoUrl: string | null; message?: string };

export type ImportFacialVideoResult =
  | { ok: false; manifest: null; videoUrl: null; message?: string; canceled?: boolean }
  | { ok: true; manifest: FacialAnalysisManifest; videoUrl: string | null; message?: string };

export type ListFacialCamerasResult =
  | { ok: false; cameras: FacialCamera[]; message?: string }
  | { ok: true; cameras: FacialCamera[] };

export type StartFacialCaptureResult =
  | { ok: false; message?: string }
  | { ok: true; message?: string };

export type StopFacialCaptureResult =
  | { ok: false; message?: string }
  | { ok: true; message?: string };

export type RunFacialAnalysisResult =
  | { ok: false; result: null; message?: string }
  | { ok: true; result: FacialAnalysisResultData; message?: string };
