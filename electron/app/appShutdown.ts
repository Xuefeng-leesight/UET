import type { App } from 'electron';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

type AppShutdownDependencies = {
  app: App;
  pythonWaitTimeoutMs: number;
  getPythonProcess: () => ChildProcessWithoutNullStreams | null;
  isProcessAlive: (pid: number) => boolean;
  stopPythonServer: () => void;
  cleanupOrphanedProcesses: () => Promise<void>;
  closeParticipantWindow: () => void;
  stopFacialDomain: () => void;
  abortRecordingAudio: () => void;
  stopStimulusScreenRecordings: () => void;
  closeUdpTriggerSockets: () => void;
  stopTriggerTcpEyeServer: () => void;
  logEvent: (event: string) => void;
};

function runCleanup(label: string, cleanup: () => void) {
  try {
    cleanup();
  } catch (error) {
    console.error(`[app] Error during ${label}:`, error);
  }
}

export function registerAppShutdownHandlers(dependencies: AppShutdownDependencies): void {
  const {
    app,
    pythonWaitTimeoutMs,
    getPythonProcess,
    isProcessAlive,
    stopPythonServer,
    cleanupOrphanedProcesses,
    closeParticipantWindow,
    stopFacialDomain,
    abortRecordingAudio,
    stopStimulusScreenRecordings,
    closeUdpTriggerSockets,
    stopTriggerTcpEyeServer,
    logEvent,
  } = dependencies;

  app.on('will-quit', (event) => {
    console.log('[app] will-quit event');
    logEvent('app-will-quit');
    closeParticipantWindow();
    stopFacialDomain();
    abortRecordingAudio();
    stopStimulusScreenRecordings();

    const runningProcess = getPythonProcess();
    if (!runningProcess || runningProcess.exitCode !== null || runningProcess.signalCode !== null) {
      void cleanupOrphanedProcesses().catch((error) => console.error('[app] Error during cleanup:', error));
      closeUdpTriggerSockets();
      return;
    }

    event.preventDefault();
    console.log('[app] Waiting for Python server to stop...');
    runCleanup('stopping Python server', stopPythonServer);
    const startedAt = Date.now();
    const checkInterval = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const currentProcess = getPythonProcess();
      const hasExited = !currentProcess
        || currentProcess.exitCode !== null
        || currentProcess.signalCode !== null
        || (typeof currentProcess.pid === 'number' && currentProcess.pid > 0 && !isProcessAlive(currentProcess.pid));
      if (!hasExited && elapsed < pythonWaitTimeoutMs) return;

      clearInterval(checkInterval);
      console.log(elapsed >= pythonWaitTimeoutMs
        ? '[app] Timeout waiting for Python server, forcing quit'
        : '[app] Python server stopped, quitting');
      void cleanupOrphanedProcesses()
        .catch((error) => console.error('[app] Error during cleanup:', error))
        .finally(() => {
          closeUdpTriggerSockets();
          app.quit();
        });
    }, 100);
  });

  app.on('before-quit', () => {
    console.log('[app] before-quit event');
    logEvent('app-before-quit');
    closeParticipantWindow();
    stopTriggerTcpEyeServer();
    stopFacialDomain();
    abortRecordingAudio();
    stopStimulusScreenRecordings();
    stopPythonServer();
  });
}
