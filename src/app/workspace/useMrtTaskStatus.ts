import { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoExportStatus } from '@/features/export/domain/videoExportStatus';
import type { ProjectImportStatus } from '@/features/projects/domain/projectImportStatus';
import { ipcEvents } from '@/infrastructure/electron/ipcEvents';

export function useMrtTaskStatus() {
  const [videoExportStatus, setVideoExportStatus] = useState<VideoExportStatus | null>(null);
  const videoExportStatusTimerRef = useRef<number | null>(null);
  const [projectImportStatus, setProjectImportStatus] = useState<ProjectImportStatus | null>(null);
  const projectImportStatusTimerRef = useRef<number | null>(null);
  const projectImportStatusRef = useRef<ProjectImportStatus | null>(null);

  const handleVideoExportStatusChange = useCallback((next: VideoExportStatus | null) => {
    setVideoExportStatus(next);
    if (videoExportStatusTimerRef.current !== null) window.clearTimeout(videoExportStatusTimerRef.current);
    videoExportStatusTimerRef.current = null;
    if (!next || (next.phase !== 'done' && next.phase !== 'failed')) return;
    const taskId = next.taskId;
    videoExportStatusTimerRef.current = window.setTimeout(() => {
      setVideoExportStatus((previous) => previous?.taskId === taskId ? null : previous);
      videoExportStatusTimerRef.current = null;
    }, next.phase === 'done' ? 8000 : 12000);
  }, []);

  const handleProjectImportStatusChange = useCallback((next: ProjectImportStatus | null) => {
    setProjectImportStatus(next);
    projectImportStatusRef.current = next;
    if (projectImportStatusTimerRef.current !== null) window.clearTimeout(projectImportStatusTimerRef.current);
    projectImportStatusTimerRef.current = null;
    if (!next || (next.phase !== 'done' && next.phase !== 'failed')) return;
    const taskId = next.taskId;
    projectImportStatusTimerRef.current = window.setTimeout(() => {
      setProjectImportStatus((previous) => previous?.taskId === taskId ? null : previous);
      projectImportStatusTimerRef.current = null;
    }, next.phase === 'done' ? 8000 : 12000);
  }, []);

  useEffect(() => () => {
    if (videoExportStatusTimerRef.current !== null) window.clearTimeout(videoExportStatusTimerRef.current);
    if (projectImportStatusTimerRef.current !== null) window.clearTimeout(projectImportStatusTimerRef.current);
  }, []);

  useEffect(() => {
    const listener = (_event: unknown, payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const next = payload as Record<string, unknown>;
      const projectDir = typeof next.projectDir === 'string' ? next.projectDir : '';
      if (!projectDir) return;
      const numberValue = (key: string): number | undefined => typeof next[key] === 'number' ? next[key] : undefined;
      const total = numberValue('total');
      const completed = numberValue('completed');
      const compatible = numberValue('compatible');
      const transcoded = numberValue('transcoded');
      const failed = numberValue('failed');
      handleProjectImportStatusChange({
        taskId: typeof next.taskId === 'string' && next.taskId.trim() ? next.taskId : `project-import:${projectDir}`,
        projectDir,
        projectName: projectImportStatusRef.current?.projectDir === projectDir
          ? projectImportStatusRef.current.projectName
          : projectDir.split(/[\\/]/).filter(Boolean).pop() || '工程',
        phase: next.phase === 'preparing' || next.phase === 'transcoding' ? next.phase : 'preparing',
        progress: typeof next.progress === 'number' ? Math.max(0, Math.min(1, next.progress)) : 0,
        label: typeof next.label === 'string' && next.label.trim() ? next.label : '正在导入工程',
        detail: typeof completed === 'number' && typeof total === 'number'
          ? `${completed}/${total} · 已转码 ${transcoded || 0} · 兼容 ${compatible || 0} · 失败 ${failed || 0}`
          : undefined,
        currentFile: typeof next.currentFile === 'string' ? next.currentFile : undefined,
        total, completed, compatible, transcoded, failed,
        updatedAt: typeof next.updatedAt === 'number' ? next.updatedAt : Date.now(),
      });
    };
    return ipcEvents.on('project-import-progress', listener);
  }, [handleProjectImportStatusChange]);

  return {
    videoExportStatus,
    projectImportStatus,
    handleVideoExportStatusChange,
    handleProjectImportStatusChange,
  };
}
