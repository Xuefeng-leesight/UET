import { invokeSafe, invokeSafeNoPayload } from '@/infrastructure/electron/ipcCore';
import type { ExportVideoFastResult, ExportImageFastResult, ExportTextFastResult, ExportChartReportBundleResult } from '@/infrastructure/electron/ipcTypes';

export const exportsIpcClient = {
  exportVideoFast: async (payload: {
    sourcePath: string;
    startTimeSec?: number;
    endTimeSec?: number;
    defaultName?: string;
    slowDownFactor?: number;
    outputFps?: number;
    preserveAudio?: boolean;
    cleanupSource?: boolean;
  }): Promise<ExportVideoFastResult> => {
    return invokeSafe<ExportVideoFastResult>('export-video-fast', payload, { ok: false });
  },

  exportImageFast: async (payload: {
    content?: unknown;
    captureRect?: { x: number; y: number; width: number; height: number };
    defaultName?: string;
  }): Promise<ExportImageFastResult> => {
    return invokeSafe<ExportImageFastResult>('export-image-fast', payload, { ok: false });
  },

  exportTextFast: async (payload: {
    content: string;
    defaultName?: string;
    title?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<ExportTextFastResult> => {
    return invokeSafe<ExportTextFastResult>('export-text-fast', payload, { ok: false });
  },

  exportChartReportBundle: async (payload: {
    baseName?: string;
    csvFileName?: string;
    csvContent: string;
    charts: Array<{
      fileName: string;
      rect: { x: number; y: number; width: number; height: number };
    }>;
  }): Promise<ExportChartReportBundleResult> => {
    return invokeSafe<ExportChartReportBundleResult>('export-chart-report-bundle', payload, { ok: false });
  }
};
