import { ipcClient, type GazeMappingResultData } from '@/infrastructure/electron/ipcClient';

export type MappingRecordEntry = { outputPath: string; result: GazeMappingResultData };

/** Lists contain summary data only; opening/exporting needs the saved point array. */
export async function loadCompleteMappingRecord(projectDir: string, entry: MappingRecordEntry): Promise<MappingRecordEntry> {
  const response = await ipcClient.loadGazeMappingRecord({ projectDir, outputPath: entry.outputPath });
  if (!response.ok || !response.record || !Array.isArray(response.record.result.gazeData)) {
    throw new Error(response.message || '加载映射记录失败');
  }
  return response.record;
}
