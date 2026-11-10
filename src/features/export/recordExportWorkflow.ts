import type { RecordingRecord } from '@shared/contracts/domain/models';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import type { ExportTextFastResult, ExportVideoFastResult } from '@/infrastructure/electron/ipcTypes';
import type { FacialExportArtifactId } from '@/features/export/domain/modalityExportRegistry';

export type ExportOutcome = {
  total: number;
  exported: number;
  failed: number;
  canceled: boolean;
  firstError?: string;
};

export type ExportFeedback = {
  kind: 'progress' | 'success' | 'partial' | 'canceled' | 'error';
  message: string;
};

export function describeExportOutcome(outcome: ExportOutcome, isEn: boolean): ExportFeedback {
  const { total, exported, failed, canceled, firstError } = outcome;
  if (canceled) {
    return {
      kind: 'canceled',
      message: isEn
        ? `Export canceled. ${exported} file(s) saved; ${Math.max(0, total - exported)} item(s) not exported.`
        : `导出已取消，已保存 ${exported} 个文件，${Math.max(0, total - exported)} 项未导出。`,
    };
  }
  if (failed > 0 || exported === 0) {
    const summary = isEn
      ? `${exported > 0 ? 'Export partially completed' : 'Export failed'}: ${exported} file(s) saved, ${failed || total} item(s) failed or missing.`
      : `${exported > 0 ? '部分导出完成' : '导出失败'}：已保存 ${exported} 个文件，${failed || total} 项失败或缺少数据。`;
    return { kind: exported > 0 ? 'partial' : 'error', message: firstError ? `${summary} ${firstError}` : summary };
  }
  return {
    kind: 'success',
    message: isEn ? `Export complete: ${exported} file(s) saved.` : `导出完成，已保存 ${exported} 个文件。`,
  };
}

export async function runEyeTrackingExport(
  payload: Parameters<typeof ipcClient.exportRecordsCsv>[0],
): Promise<ExportOutcome> {
  const total = payload.records.length;
  try {
    const result = await ipcClient.exportRecordsCsv(payload);
    if (result.ok === true) {
      const exported = result.files.length;
      // The existing CSV handler omits failed records from files, even when ok is true.
      return { total, exported, failed: Math.max(0, total - exported), canceled: false };
    }
    // This legacy channel exposes cancellation only through this exact message.
    const canceled = result.message === '已取消导出';
    return { total, exported: 0, failed: canceled ? 0 : total, canceled, firstError: canceled ? undefined : result.message };
  } catch (error) {
    return { total, exported: 0, failed: total, canceled: false, firstError: error instanceof Error ? error.message : undefined };
  }
}

export async function runFacialExport({
  records, artifacts, projectDir, resolveName, isCurrent,
}: {
  records: RecordingRecord[];
  artifacts: Set<FacialExportArtifactId>;
  projectDir: string | null;
  resolveName: (record: RecordingRecord) => string;
  isCurrent: () => boolean;
}): Promise<ExportOutcome> {
  const outcome: ExportOutcome = { total: records.length * artifacts.size, exported: 0, failed: 0, canceled: false };
  const fail = (count: number, message?: string) => {
    outcome.failed += count;
    if (!outcome.firstError && message) outcome.firstError = message;
  };
  const save = async (operation: () => Promise<ExportVideoFastResult | ExportTextFastResult>): Promise<boolean> => {
    if (!isCurrent()) return false;
    try {
      const result = await operation();
      if (!isCurrent()) return false;
      if (result.ok === true) outcome.exported += 1;
      else if (result.reason === 'canceled') outcome.canceled = true;
      else fail(1, result.message);
    } catch (error) {
      if (!isCurrent()) return false;
      fail(1, error instanceof Error ? error.message : undefined);
    }
    return !outcome.canceled;
  };

  for (const record of records) {
    if (!isCurrent()) break;
    const sourcePath = record.modalities?.['facial-expression']?.sourcePath;
    const exportName = resolveName(record);
    if (artifacts.has('video')) {
      if (!sourcePath) fail(1);
      else if (!await save(() => ipcClient.exportVideoFast({ sourcePath, defaultName: `${exportName}_facial.mp4`, preserveAudio: true }))) break;
    }
    const analysisCount = Number(artifacts.has('analysis-json')) + Number(artifacts.has('emotion-events-csv'));
    if (analysisCount === 0 || !isCurrent()) continue;
    let pendingAnalysis = analysisCount;
    try {
      const loaded = await ipcClient.loadFacialAnalysis({ projectDir: projectDir as string, recordId: record.name || record.id });
      if (!isCurrent()) break;
      if (!loaded.ok || !loaded.result) {
        fail(analysisCount, !loaded.ok ? loaded.message : undefined);
        continue;
      }
      const result = loaded.result;
      if (artifacts.has('analysis-json')) {
        const shouldContinue = await save(() => ipcClient.exportTextFast({
          content: JSON.stringify(result, null, 2),
          defaultName: `${exportName}_表情模块分析.json`,
          title: '导出表情模块分析',
          filters: [{ name: 'JSON', extensions: ['json'] }],
        }));
        pendingAnalysis -= 1;
        if (!shouldContinue) break;
      }
      if (artifacts.has('emotion-events-csv')) {
        const escapeCsv = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
        const rows = [['Emotion', 'Start[ms]', 'Apex[ms]', 'End[ms]', 'Peak']]
          .concat((result.tracks.emotion?.events || []).map((event) => [
            event.label, String(event.startMs), String(event.apexMs), String(event.endMs), String(event.peak),
          ]));
        const shouldContinue = await save(() => ipcClient.exportTextFast({
          content: rows.map((row) => row.map(escapeCsv).join(',')).join('\n'),
          defaultName: `${exportName}_基础表情事件.csv`,
          title: '导出基础表情事件',
          filters: [{ name: 'CSV', extensions: ['csv'] }],
        }));
        pendingAnalysis -= 1;
        if (!shouldContinue) break;
      }
    } catch (error) {
      if (!isCurrent()) break;
      fail(pendingAnalysis, error instanceof Error ? error.message : undefined);
    }
  }
  return outcome;
}
