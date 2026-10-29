import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  CircleAlert,
  Download,
  HardDrive,
  Link2,
  Play,
  Radio,
  RefreshCw,
  Server,
  Square,
  UploadCloud,
  Users,
} from 'lucide-react';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import { useLanguage } from '@/app/i18n/useLanguage';
import { translateTextForLanguage } from '@/app/i18n/useDomTranslation';
import type {
  MultiplayerClient,
  MultiplayerCommand,
  MultiplayerLocalStatus,
  MultiplayerRole,
  MultiplayerSnapshot,
} from '@shared/contracts/domain/multiplayer';
import {
  adaptiveCommandLeadMs,
  estimateClock,
  scheduledDelayMs,
  selectBestClockEstimate,
  type ClockSyncEstimate,
} from './domain/clockSync';

export interface MultiplayerPageProps {
  projectName: string;
  experimentName: string;
  localStatus: MultiplayerLocalStatus;
  onStartLocalRecording: () => void;
  onStopLocalRecording: () => void;
  onPackageSynced: () => Promise<void>;
  onPrepareLocalRecording: () => Promise<void>;
  onNotify: (message: string) => void;
  embedded?: boolean;
}

const EMPTY_SNAPSHOT: MultiplayerSnapshot = {
  running: false,
  role: 'standalone',
  host: '127.0.0.1',
  port: 17860,
  localClientId: '',
  localClientName: '',
  session: null,
  packageInfo: null,
  clients: [],
};

const SETTINGS_KEY = 'mrt.multiplayer.settings.v1';
const runtimeClientId = `client-${crypto.randomUUID().slice(0, 8)}`;

function readSettings() {
  const defaults = {
    role: 'coordinator' as MultiplayerRole,
    clientId: runtimeClientId,
    clientName: '采集客户端',
    coordinatorUrl: 'http://127.0.0.1:17860',
    port: 17860,
  };
  try {
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || '{}') as Partial<typeof defaults>;
    return {
      role: saved.role === 'client' || saved.role === 'coordinator' ? saved.role : defaults.role,
      clientId: String(saved.clientId || defaults.clientId),
      clientName: String(saved.clientName || defaults.clientName),
      coordinatorUrl: String(saved.coordinatorUrl || defaults.coordinatorUrl),
      port: Number.isFinite(Number(saved.port)) ? Number(saved.port) : defaults.port,
    };
  } catch {
    return defaults;
  }
}

const statusLabel: Record<string, string> = {
  offline: '离线',
  connected: '已连接',
  syncing: '同步中',
  ready: '已就绪',
  armed: '等待开始',
  recording: '录制中',
  finalizing: '保存中',
  completed: '已完成',
  error: '异常',
};

const formatBytes = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(value / 1024)} KB`;
};

const clientStatusClass = (client: MultiplayerClient) => {
  if (client.status === 'error' || Date.now() - client.lastSeenAt > 10000) return 'bg-rose-100 text-rose-700';
  if (client.status === 'recording') return 'bg-emerald-100 text-emerald-700';
  if (client.status === 'ready' || client.status === 'completed') return 'bg-sky-100 text-sky-700';
  return 'bg-amber-100 text-amber-700';
};

const MultiplayerPage: React.FC<MultiplayerPageProps> = ({
  projectName,
  experimentName,
  localStatus,
  onStartLocalRecording,
  onStopLocalRecording,
  onPackageSynced,
  onPrepareLocalRecording,
  onNotify,
  embedded = false,
}) => {
  const { language } = useLanguage();
  const isEn = language === 'en-US';
  const tr = useCallback((value: string) => translateTextForLanguage(value, language), [language]);
  const initial = useMemo(readSettings, []);
  const [role, setRole] = useState<MultiplayerRole>(initial.role);
  const [clientId] = useState(initial.clientId);
  const [clientName, setClientName] = useState(initial.clientName);
  const [coordinatorUrl, setCoordinatorUrl] = useState(initial.coordinatorUrl);
  const [port, setPort] = useState(initial.port);
  const [snapshot, setSnapshot] = useState<MultiplayerSnapshot>(EMPTY_SNAPSHOT);
  const [busy, setBusy] = useState('');
  const [connected, setConnected] = useState(false);
  const [packageVersion, setPackageVersion] = useState('');
  const [completedCurrentRun, setCompletedCurrentRun] = useState(false);
  const [localParticipation, setLocalParticipation] = useState(false);
  const [clockEstimate, setClockEstimate] = useState<ClockSyncEstimate | null>(null);
  const [preparedSessionId, setPreparedSessionId] = useState('');
  const [preparedAt, setPreparedAt] = useState<number | undefined>();
  const [scheduledSessionId, setScheduledSessionId] = useState('');
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | undefined>();
  const [startDeviationMs, setStartDeviationMs] = useState<number | undefined>();
  const executedCommandsRef = useRef(new Set<string>());
  const executingCommandsRef = useRef(new Set<string>());
  const timersRef = useRef<number[]>([]);
  const clientPollInFlightRef = useRef(false);
  const clientPollGenerationRef = useRef(0);

  useEffect(() => {
    setClientName((current) => {
      if (isEn && current === '采集客户端') return 'Collection client';
      if (!isEn && current === 'Collection client') return '采集客户端';
      return current;
    });
  }, [isEn]);
  const clientPollFailuresRef = useRef(0);
  const clockEstimateRef = useRef<ClockSyncEstimate | null>(null);
  const runtimeRef = useRef({
    localStatus,
    onStartLocalRecording,
    onStopLocalRecording,
    onPackageSynced,
    onPrepareLocalRecording,
    onNotify,
  });
  runtimeRef.current = {
    localStatus,
    onStartLocalRecording,
    onStopLocalRecording,
    onPackageSynced,
    onPrepareLocalRecording,
    onNotify,
  };

  const debugMultiplayer = useCallback((event: string, details?: unknown) => {
    void ipcClient.videoDebugLog({ event: `multiplayer:${event}`, details });
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        role,
        clientId,
        clientName,
        coordinatorUrl,
        port,
      }));
    } catch {
    }
  }, [role, clientId, clientName, coordinatorUrl, port]);

  const clearCommandTimers = useCallback(() => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
  }, []);

  const synchronizeClock = useCallback(async (baseUrl: string) => {
    const samples: ClockSyncEstimate[] = [];
    for (let index = 0; index < 8; index += 1) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 1500);
      try {
        const clientSendAt = Date.now();
        const response = await fetch(`${baseUrl}/api/time`, { signal: controller.signal, cache: 'no-store' });
        const body = await response.json() as { serverReceiveAt?: number; serverSendAt?: number };
        const clientReceiveAt = Date.now();
        if (response.ok && Number.isFinite(body.serverReceiveAt) && Number.isFinite(body.serverSendAt)) {
          samples.push(estimateClock({
            clientSendAt,
            serverReceiveAt: Number(body.serverReceiveAt),
            serverSendAt: Number(body.serverSendAt),
            clientReceiveAt,
          }));
        }
      } catch {
      } finally {
        window.clearTimeout(timeout);
      }
    }
    const best = selectBestClockEstimate(samples);
    if (!best) return null;
    clockEstimateRef.current = best;
    setClockEstimate(best);
    debugMultiplayer('clock-synchronized', {
      clientId,
      offsetMs: Math.round(best.offsetMs * 100) / 100,
      roundTripMs: Math.round(best.roundTripMs * 100) / 100,
      sampleCount: samples.length,
    });
    return best;
  }, [clientId, debugMultiplayer]);

  const acknowledgeCommand = useCallback(async (commandId: string) => {
    if (role === 'coordinator') {
      await ipcClient.ackMultiplayerCommand({ clientId: 'client-a', commandId });
      return;
    }
    const base = coordinatorUrl.replace(/\/+$/, '');
    const response = await fetch(`${base}/api/commands/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId, commandId }),
    });
    if (!response.ok) throw new Error(`ack failed (${response.status})`);
  }, [role, coordinatorUrl, clientId]);

  const executeCommand = useCallback(async (command: MultiplayerCommand) => {
    if (executedCommandsRef.current.has(command.id)) {
      // ACK 可能在网络中丢失；重复投递时仍要重发 ACK，但绝不能重复执行。
      try {
        await acknowledgeCommand(command.id);
      } catch {
      }
      return;
    }
    // prepare 可能持续数秒；执行过程中收到的重投递不能提前 ACK。
    if (executingCommandsRef.current.has(command.id)) return;
    const currentRuntime = runtimeRef.current;
    if ((command.type === 'start' || command.type === 'prepare') && !currentRuntime.localStatus.recordingEligible) {
      currentRuntime.onNotify(currentRuntime.localStatus.recordingEligibilityReason || '当前客户端模式不支持多人录制');
      return;
    }
    executingCommandsRef.current.add(command.id);
    debugMultiplayer('command-received', {
      commandId: command.id,
      sessionId: command.sessionId,
      type: command.type,
      executeAt: command.executeAt,
      localNow: Date.now(),
      clockOffsetMs: clockEstimateRef.current?.offsetMs,
    });

    if (command.type === 'prepare') {
      try {
        // 重新载入已同步素材，让磁盘读取、状态更新在预约开始之前完成。
        await runtimeRef.current.onPackageSynced();
        await runtimeRef.current.onPrepareLocalRecording();
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        const readyAt = Date.now() + (clockEstimateRef.current?.offsetMs || 0);
        setPreparedSessionId(command.sessionId);
        setPreparedAt(readyAt);
        setScheduledSessionId('');
        debugMultiplayer('client-prepared', { sessionId: command.sessionId, preparedAt: readyAt });
        executingCommandsRef.current.delete(command.id);
        executedCommandsRef.current.add(command.id);
        await acknowledgeCommand(command.id);
      } catch (error) {
        executingCommandsRef.current.delete(command.id);
        executedCommandsRef.current.delete(command.id);
        const message = error instanceof Error ? error.message : String(error);
        debugMultiplayer('prepare-failed', {
          sessionId: command.sessionId,
          message,
        });
        runtimeRef.current.onNotify(`多人采集准备失败：${message}`);
      }
      return;
    }

    if (command.type === 'start' && role === 'client' && !clockEstimateRef.current) {
      executingCommandsRef.current.delete(command.id);
      executedCommandsRef.current.delete(command.id);
      runtimeRef.current.onNotify('主控时钟尚未校准，已拒绝执行开始命令并等待重试');
      debugMultiplayer('command-waiting-for-clock', { commandId: command.id, sessionId: command.sessionId });
      return;
    }

    const run = () => {
      if (command.type === 'start') {
        const actualAt = Date.now() + (clockEstimateRef.current?.offsetMs || 0);
        const deviationMs = actualAt - Number(command.executeAt || actualAt);
        setRecordingStartedAt(actualAt);
        setStartDeviationMs(deviationMs);
        setScheduledSessionId('');
        setCompletedCurrentRun(false);
        debugMultiplayer('start-invoked', {
          sessionId: command.sessionId,
          plannedAt: command.executeAt,
          actualAt,
          deviationMs,
          monotonicNow: performance.now(),
        });
        runtimeRef.current.onStartLocalRecording();
      }
      if (command.type === 'stop') {
        setScheduledSessionId('');
        setCompletedCurrentRun(true);
        debugMultiplayer('stop-invoked', { sessionId: command.sessionId });
        runtimeRef.current.onStopLocalRecording();
      }
    };
    const delay = scheduledDelayMs(
      Number(command.executeAt || Date.now()),
      Date.now(),
      clockEstimateRef.current?.offsetMs || 0,
    );
    setScheduledSessionId(command.sessionId);
    debugMultiplayer('command-scheduled', {
      commandId: command.id,
      type: command.type,
      delayMs: delay,
      monotonicDeadline: performance.now() + delay,
    });
    timersRef.current.push(window.setTimeout(run, delay));
    executingCommandsRef.current.delete(command.id);
    executedCommandsRef.current.add(command.id);
    try {
      await acknowledgeCommand(command.id);
    } catch (error) {
      debugMultiplayer('command-ack-failed', {
        commandId: command.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [
    acknowledgeCommand,
    debugMultiplayer,
    role,
  ]);

  const localReportedStatus = localStatus.finalizing
    ? 'finalizing'
    : localStatus.recording
      ? 'recording'
      : !localStatus.recordingEligible
        ? 'error'
        : localStatus.deviceConnected
        ? scheduledSessionId
          ? 'armed'
          : completedCurrentRun
            ? 'completed'
            : 'ready'
        : 'connected';

  const refreshCoordinator = useCallback(async () => {
    const result = await ipcClient.getMultiplayerSnapshot();
    if (result.ok) setSnapshot(result.snapshot);
  }, []);

  useEffect(() => {
    if (role !== 'coordinator' || !snapshot.running || !localParticipation) return;
    void ipcClient.updateMultiplayerLocalClient({
      id: 'client-a',
      name: '主控本机',
      included: true,
      deviceConnected: localStatus.deviceConnected,
      recordingEligible: localStatus.recordingEligible,
      recordingEligibilityReason: localStatus.recordingEligibilityReason || '',
      status: localReportedStatus,
      packageVersion: snapshot.packageInfo?.version || '',
      packageProgress: snapshot.packageInfo ? 100 : 0,
      clockOffsetMs: 0,
      roundTripMs: 0,
      preparedSessionId,
      preparedAt,
      recordingStartedAt,
      startDeviationMs,
    }).then((result) => {
      if (result.ok) setSnapshot(result.snapshot);
    });
  }, [
    role,
    localParticipation,
    snapshot.running,
    localStatus.deviceConnected,
    localStatus.recordingEligible,
    localStatus.recordingEligibilityReason,
    localReportedStatus,
    completedCurrentRun,
    snapshot.packageInfo?.version,
    preparedSessionId,
    preparedAt,
    recordingStartedAt,
    startDeviationMs,
    scheduledSessionId,
  ]);

  useEffect(() => {
    if (role !== 'coordinator') return;
    void ipcClient.removeMultiplayerClient({ clientId }).then((result) => {
      if (result.ok) setSnapshot(result.snapshot);
    });
  }, [role, clientId]);

  useEffect(() => {
    if (role === 'coordinator' && localParticipation) return;
    if (!snapshot.clients.some((client) => client.id === 'client-a')) return;
    void ipcClient.removeMultiplayerClient({ clientId: 'client-a' }).then((result) => {
      if (result.ok) setSnapshot(result.snapshot);
    });
  }, [role, localParticipation, snapshot.clients]);

  useEffect(() => {
    if (role !== 'coordinator' || !snapshot.running) return;
    const timer = window.setInterval(() => void refreshCoordinator(), 1500);
    return () => window.clearInterval(timer);
  }, [role, snapshot.running, refreshCoordinator]);

  useEffect(() => {
    if (role !== 'client') {
      clockEstimateRef.current = role === 'coordinator' ? { offsetMs: 0, roundTripMs: 0 } : null;
      setClockEstimate(role === 'coordinator' ? { offsetMs: 0, roundTripMs: 0 } : null);
      return;
    }
    const base = coordinatorUrl.replace(/\/+$/, '');
    void synchronizeClock(base);
    const timer = window.setInterval(() => void synchronizeClock(base), 30000);
    return () => window.clearInterval(timer);
  }, [role, coordinatorUrl, synchronizeClock]);

  useEffect(() => {
    if (role !== 'client') {
      setConnected(false);
      return;
    }
    let active = true;
    const generation = ++clientPollGenerationRef.current;
    const base = coordinatorUrl.replace(/\/+$/, '');
    const tick = async () => {
      if (clientPollInFlightRef.current) return;
      clientPollInFlightRef.current = true;
      const registerController = new AbortController();
      const registerTimeout = window.setTimeout(() => registerController.abort(), 3000);
      try {
        const register = await fetch(`${base}/api/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: registerController.signal,
          body: JSON.stringify({
            clientId,
            clientName,
            deviceConnected: localStatus.deviceConnected,
            recordingEligible: localStatus.recordingEligible,
            recordingEligibilityReason: localStatus.recordingEligibilityReason || '',
            status: localReportedStatus,
            packageVersion,
            packageProgress: packageVersion ? 100 : 0,
            clockOffsetMs: clockEstimateRef.current?.offsetMs,
            roundTripMs: clockEstimateRef.current?.roundTripMs,
            preparedSessionId,
            preparedAt,
            recordingStartedAt,
            startDeviationMs,
          }),
        });
        if (!register.ok) throw new Error('register failed');
        const registerBody = await register.json() as { snapshot?: MultiplayerSnapshot };
        if (active && generation === clientPollGenerationRef.current) {
          if (registerBody.snapshot) setSnapshot(registerBody.snapshot);
          clientPollFailuresRef.current = 0;
          setConnected(true);
        }
        const commandController = new AbortController();
        const commandTimeout = window.setTimeout(() => commandController.abort(), 2500);
        try {
          const commandsResponse = await fetch(`${base}/api/commands?clientId=${encodeURIComponent(clientId)}`, {
            signal: commandController.signal,
            cache: 'no-store',
          });
          if (commandsResponse.ok) {
            const commandBody = await commandsResponse.json() as { commands?: MultiplayerCommand[] };
            for (const command of commandBody.commands || []) void executeCommand(command);
          }
        } catch (error) {
          if (!(error instanceof DOMException && error.name === 'AbortError')) {
            console.warn('[MultiplayerPage] command polling failed:', error);
          }
        } finally {
          window.clearTimeout(commandTimeout);
        }
      } catch {
        if (active && generation === clientPollGenerationRef.current) {
          clientPollFailuresRef.current += 1;
          if (clientPollFailuresRef.current >= 3) setConnected(false);
        }
      } finally {
        window.clearTimeout(registerTimeout);
        clientPollInFlightRef.current = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 500);
    return () => {
      active = false;
      clientPollGenerationRef.current += 1;
      window.clearInterval(timer);
    };
  }, [
    role,
    coordinatorUrl,
    clientId,
    clientName,
    localStatus.deviceConnected,
    localStatus.recordingEligible,
    localStatus.recordingEligibilityReason,
    localReportedStatus,
    packageVersion,
    clockEstimate?.offsetMs,
    clockEstimate?.roundTripMs,
    preparedSessionId,
    preparedAt,
    recordingStartedAt,
    startDeviationMs,
    executeCommand,
  ]);

  useEffect(() => () => clearCommandTimers(), [clearCommandTimers]);

  const startCoordinator = async () => {
    setBusy('server');
    const result = await ipcClient.startMultiplayerCoordinator({ port });
    setBusy('');
    if (!result.ok) return onNotify(`启动主控失败：${'message' in result ? result.message || '未知错误' : '未知错误'}`);
    setSnapshot(result.snapshot);
    setRole('coordinator');
    setConnected(true);
  };

  const stopCoordinator = async () => {
    const result = await ipcClient.stopMultiplayerCoordinator();
    if (result.ok) {
      setSnapshot(result.snapshot);
      setConnected(false);
      setRole('coordinator');
    }
  };

  const publishPackage = async () => {
    if (!localStatus.experimentDir) return onNotify('当前实验目录不可用');
    setBusy('package');
    const result = await ipcClient.publishMultiplayerPackage({ experimentDir: localStatus.experimentDir });
    setBusy('');
    if (!result.ok) return onNotify(`发布素材失败：${'message' in result ? result.message || '未知错误' : '未知错误'}`);
    setSnapshot(result.snapshot);
    onNotify('实验素材包已发布，客户端现在可以同步');
  };

  const syncPackage = async () => {
    if (!localStatus.experimentDir) return onNotify('当前实验目录不可用');
    setBusy('sync');
    const result = await ipcClient.syncMultiplayerPackage({
      coordinatorUrl: coordinatorUrl.replace(/\/+$/, ''),
      experimentDir: localStatus.experimentDir,
    });
    setBusy('');
    if (!result.ok) return onNotify(`素材同步失败：${'message' in result ? result.message || '未知错误' : '未知错误'}`);
    setPackageVersion(result.version);
    await onPackageSynced();
    onNotify(`素材同步完成：${result.fileCount} 个文件`);
  };

  const createRound = async () => {
    const result = await ipcClient.createMultiplayerSession({
      name: `${projectName || '当前工程'} / ${experimentName || '当前实验'}`,
    });
    if (!result.ok) {
      onNotify(`开始本轮采集失败：${'message' in result ? result.message || '未知错误' : '未知错误'}`);
      return null;
    }
    setSnapshot(result.snapshot);
    return result.snapshot;
  };

  const issue = async (type: 'prepare' | 'start' | 'stop', requestedDelayMs?: number) => {
    const delayMs = requestedDelayMs ?? (type === 'start' || type === 'stop' ? 5000 : 0);
    const result = await ipcClient.issueMultiplayerCommand({ type, delayMs });
    if (!result.ok) {
      onNotify(('message' in result && result.message) || '发送命令失败');
      return null;
    }
    setSnapshot(result.snapshot);
    const local = result.snapshot.clients.find((client) => client.id === 'client-a' && client.included);
    if (local) await executeCommand(result.command);
    return result;
  };

  const startRound = async () => {
    setBusy('round');
    setPreparedSessionId('');
    setPreparedAt(undefined);
    setRecordingStartedAt(undefined);
    setStartDeviationMs(undefined);
    const created = await createRound();
    if (!created?.session) {
      setBusy('');
      return;
    }
    const sessionId = created.session.id;
    debugMultiplayer('prepare-barrier-started', { sessionId });
    const prepareResult = await issue('prepare');
    if (!prepareResult) {
      setBusy('');
      return;
    }

    const deadline = performance.now() + 60000;
    let readySnapshot = prepareResult.snapshot;
    while (performance.now() < deadline) {
      const refreshed = await ipcClient.getMultiplayerSnapshot();
      if (refreshed.ok) {
        readySnapshot = refreshed.snapshot;
        setSnapshot(refreshed.snapshot);
        const participants = refreshed.snapshot.clients.filter((client) => client.included);
        if (participants.length > 0 && participants.every((client) => client.preparedSessionId === sessionId)) break;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
    }

    const participants = readySnapshot.clients.filter((client) => client.included);
    const notPrepared = participants.filter((client) => client.preparedSessionId !== sessionId);
    if (notPrepared.length > 0) {
      debugMultiplayer('prepare-barrier-timeout', {
        sessionId,
        clients: notPrepared.map((client) => client.name),
      });
      onNotify(`未开始录制：等待准备超时（${notPrepared.map((client) => client.name).join('、')}）`);
      setBusy('');
      return;
    }

    const leadMs = adaptiveCommandLeadMs(participants.map((client) => Number(client.roundTripMs || 0)));
    debugMultiplayer('prepare-barrier-completed', { sessionId, leadMs, clientCount: participants.length });
    await issue('start', leadMs);
    setBusy('');
  };

  const includedClients = snapshot.clients.filter((client) => client.included);
  const allReady = includedClients.length > 0 && includedClients.every((client) =>
    client.deviceConnected &&
    client.recordingEligible &&
    client.packageVersion === snapshot.packageInfo?.version &&
    Number.isFinite(client.clockOffsetMs) &&
    Number.isFinite(client.roundTripMs),
  );

  return (
    <div className={embedded ? '' : 'h-full overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-5'}>
      <div className={`mx-auto max-w-7xl ${embedded ? 'space-y-3' : 'space-y-4'}`}>
        <div className={`flex flex-wrap items-center justify-between rounded-lg border border-slate-200 bg-white ${embedded ? 'gap-2 p-3' : 'gap-4 p-5'}`}>
          <div>
            <div className={`flex items-center gap-2 font-black text-slate-800 ${embedded ? 'text-sm' : 'text-xl'}`}>
              <Users className="text-sky-500" size={embedded ? 16 : 22} /> 多人采集
            </div>
            <p className={`mt-1 text-slate-500 ${embedded ? 'text-[11px]' : 'text-sm'}`}>素材提前同步、统一预约开始、数据保存在各电脑本地。</p>
          </div>
          <div className={`flex rounded-lg bg-slate-100 p-1 font-bold ${embedded ? 'text-xs' : 'text-sm'}`}>
            {([
              ['coordinator', '主控端'],
              ['client', '采集客户端'],
            ] as Array<[MultiplayerRole, string]>).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={role === value}
                onClick={() => setRole(value)}
                className={`rounded-md px-3 ${embedded ? 'py-1.5' : 'py-2'} ${role === value ? 'bg-white text-sky-600 shadow-sm' : 'text-slate-500'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {role === 'client' && (
          <div className="grid gap-4 lg:grid-cols-2">
            <section className={`rounded-lg border border-slate-200 bg-white ${embedded ? 'p-3' : 'p-5'}`}>
              <h3 className="flex items-center gap-2 text-sm font-black text-slate-700"><Link2 size={16} /> 连接主控</h3>
              <label className="mt-3 block text-xs font-bold text-slate-500">客户端名称</label>
              <input value={clientName} onChange={(event) => setClientName(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs" />
              <label className="mt-3 block text-xs font-bold text-slate-500">主控地址</label>
              <input value={coordinatorUrl} onChange={(event) => setCoordinatorUrl(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs" />
              <div className={`mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-bold ${connected ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                <Radio size={16} /> {connected ? '已连接主控，正在等待命令' : '未连接主控，正在自动重试'}
              </div>
              {clockEstimate && (
                <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                  {isEn ? 'Clock offset' : '校时偏差'} {Math.round(clockEstimate.offsetMs)} ms · {isEn ? 'Network RTT' : '网络 RTT'} {Math.round(clockEstimate.roundTripMs)} ms
                </div>
              )}
            </section>
            <section className={`rounded-lg border border-slate-200 bg-white ${embedded ? 'p-3' : 'p-5'}`}>
              <h3 className="flex items-center gap-2 text-sm font-black text-slate-700"><Download size={16} /> 素材与连接状态</h3>
              <div className="mt-3 space-y-2 text-xs">
                <StatusRow label="眼动仪" ok={localStatus.deviceConnected} text={localStatus.deviceConnected ? '已启动' : '未启动'} />
                <StatusRow label="素材版本" ok={Boolean(packageVersion)} text={packageVersion || '尚未同步'} />
                <StatusRow
                  label="多人录制"
                  ok={localStatus.recordingEligible}
                  text={tr(localStatus.recordingEligible ? '可参与' : (localStatus.recordingEligibilityReason || '当前模式不支持'))}
                />
              </div>
              <button onClick={syncPackage} disabled={!connected || busy === 'sync'} className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-sky-500 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">
                <RefreshCw className={busy === 'sync' ? 'animate-spin' : ''} size={16} /> {busy === 'sync' ? '同步并校验中…' : '同步主控素材到本机'}
              </button>
              <p className="mt-2 text-xs text-slate-400">素材同步独立进行，不要求先启动眼动仪。</p>
            </section>
          </div>
        )}

        {role === 'coordinator' && (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
              <section className={`rounded-lg border border-slate-200 bg-white ${embedded ? 'p-3' : 'p-5'}`}>
                <h3 className="flex items-center gap-2 text-sm font-black text-slate-700"><Server size={16} /> 主控服务</h3>
                <div className="mt-3 flex gap-2">
                  <input type="number" value={port} onChange={(event) => setPort(Number(event.target.value))} className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs" />
                  {snapshot.running ? (
                    <button onClick={stopCoordinator} className="rounded-lg bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-600">停止</button>
                  ) : (
                    <button onClick={startCoordinator} disabled={busy === 'server'} className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-bold text-white">启动</button>
                  )}
                </div>
                <div className="mt-3 text-xs text-slate-500">客户端地址：http://{snapshot.host}:{snapshot.port}</div>
                <label className="mt-3 flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs font-bold text-slate-600">
                  <span>主控本机参与采集</span>
                  <input
                    type="checkbox"
                    checked={localParticipation}
                    onChange={(event) => setLocalParticipation(event.target.checked)}
                    className="h-4 w-4 accent-sky-500"
                  />
                </label>
              </section>

              <section className={`rounded-lg border border-slate-200 bg-white ${embedded ? 'p-3' : 'p-5'}`}>
                <h3 className="flex items-center gap-2 text-sm font-black text-slate-700"><UploadCloud size={16} /> 实验素材</h3>
                <div className="mt-3 text-sm text-slate-500">
                  {snapshot.packageInfo
                    ? `版本 ${snapshot.packageInfo.version} · ${snapshot.packageInfo.fileCount} 个文件 · ${formatBytes(snapshot.packageInfo.totalBytes)}`
                    : '尚未发布当前实验素材'}
                </div>
                <button onClick={publishPackage} disabled={!snapshot.running || busy === 'package'} className="mt-3 w-full rounded-lg bg-sky-50 px-3 py-2 text-xs font-bold text-sky-600 disabled:opacity-50">
                  {busy === 'package' ? '生成清单和校验值…' : '发布当前实验素材'}
                </button>
              </section>

            </div>

            <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              <div className={`flex items-center justify-between border-b border-slate-100 ${embedded ? 'px-3 py-2.5' : 'px-5 py-4'}`}>
                <h3 className="text-sm font-black text-slate-700">采集客户端</h3>
                <span className="text-xs text-slate-500">{includedClients.length} 台参与</span>
              </div>
              {embedded ? (
                <div className="space-y-2 p-3">
                  {snapshot.clients.map((client) => (
                    <div key={client.id} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <label className="flex min-w-0 items-center gap-2">
                          <input
                            type="checkbox"
                            checked={client.included}
                            onChange={(event) => void ipcClient.updateMultiplayerClient({
                              clientId: client.id,
                              patch: { included: event.target.checked },
                            }).then((result) => result.ok && setSnapshot(result.snapshot))}
                          />
                          <span className="truncate text-sm font-bold text-slate-700">
                            {client.name}{client.id === 'client-a' ? '（本机）' : ''}
                          </span>
                        </label>
                        <span className={`shrink-0 rounded-full px-2 py-1 text-xs font-bold ${clientStatusClass(client)}`}>
                          {tr(statusLabel[client.status] || client.status)}
                        </span>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                        <div className="rounded-md bg-white px-2.5 py-2 text-slate-500">
                          设备：<span className="font-bold text-slate-700">{client.deviceConnected ? '已启动' : '未启动'}</span>
                        </div>
                        <div className="rounded-md bg-white px-2.5 py-2 text-slate-500">
                          素材：<span className="font-bold text-slate-700">{client.packageVersion === snapshot.packageInfo?.version ? '已同步' : '待同步'}</span>
                        </div>
                        <div className="col-span-2 rounded-md bg-white px-2.5 py-2 text-slate-500">
                          {isEn ? 'Clock: ' : '校时：'}<span className="font-bold text-slate-700">{Number.isFinite(client.roundTripMs)
                            ? `RTT ${Math.round(client.roundTripMs || 0)} ms / ${isEn ? 'offset' : '偏差'} ${Math.round(client.clockOffsetMs || 0)} ms`
                            : (isEn ? 'Calibrating' : '校准中')}</span>
                        </div>
                      </div>
                      {!client.recordingEligible && (
                        <div className="mt-2 rounded-md bg-rose-50 px-2.5 py-2 text-xs font-bold text-rose-600">
                          {tr(client.recordingEligibilityReason || '当前客户端模式不支持多人录制')}
                        </div>
                      )}
                    </div>
                  ))}
                  {snapshot.clients.length === 0 && (
                    <div className="px-4 py-8 text-center text-sm text-slate-400">启动主控后，等待客户端连接</div>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-500">
                    <tr>
                      <th className="px-4 py-3">参与</th><th className="px-4 py-3">电脑</th>
                      <th className="px-4 py-3">设备</th><th className="px-4 py-3">素材</th><th className="px-4 py-3">网络/校时</th><th className="px-4 py-3">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.clients.map((client) => (
                      <tr key={client.id} className="border-t border-slate-100">
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={client.included}
                            onChange={(event) => void ipcClient.updateMultiplayerClient({ clientId: client.id, patch: { included: event.target.checked } }).then((result) => result.ok && setSnapshot(result.snapshot))}
                          />
                        </td>
                        <td className="px-4 py-3 font-bold text-slate-700">
                          <div>{client.name}{client.id === 'client-a' ? '（本机）' : ''}</div>
                          {!client.recordingEligible && (
                            <div className="mt-1 text-xs font-medium text-rose-600">
                              {tr(client.recordingEligibilityReason || '当前客户端模式不支持多人录制')}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">{client.deviceConnected ? '已启动' : '未启动'}</td>
                        <td className="px-4 py-3">{client.packageVersion === snapshot.packageInfo?.version ? '已同步' : '待同步'}</td>
                        <td className="px-4 py-3 text-xs">{Number.isFinite(client.roundTripMs) ? `${Math.round(client.roundTripMs || 0)} ms / ${Math.round(client.clockOffsetMs || 0)} ms` : '校准中'}</td>
                        <td className="px-4 py-3"><span className={`rounded-full px-2 py-1 text-xs font-bold ${clientStatusClass(client)}`}>{tr(statusLabel[client.status] || client.status)}</span></td>
                      </tr>
                    ))}
                    {snapshot.clients.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400">启动主控后，等待客户端连接</td></tr>}
                  </tbody>
                </table>
                </div>
              )}
            </section>

            <div className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white ${embedded ? 'p-3' : 'p-4'}`}>
              <div className={`flex items-center gap-2 text-sm font-bold ${allReady ? 'text-emerald-600' : 'text-amber-600'}`}>
                {allReady ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}
                {allReady ? '设备、素材与时钟均已就绪' : '开始前需确保客户端设备、素材与时钟校准完成'}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => void startRound()}
                  disabled={busy === 'round' || !snapshot.running || !snapshot.packageInfo || !allReady || snapshot.session?.state === 'recording' || snapshot.session?.state === 'armed'}
                  className="flex items-center gap-2 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-bold text-white disabled:opacity-40"
                >
                  <Play size={16} /> {busy === 'round' ? '正在预加载并等待客户端…' : '开始同步采集'}
                </button>
                <button
                  onClick={() => void issue('stop')}
                  disabled={!snapshot.session || !['armed', 'recording'].includes(snapshot.session.state)}
                  className="flex items-center gap-2 rounded-lg bg-rose-500 px-3 py-2 text-xs font-bold text-white disabled:opacity-40"
                >
                  <Square size={15} /> 结束本轮采集
                </button>
              </div>
            </div>
          </>
        )}

        <div className={`flex items-center gap-2 rounded-lg bg-slate-100 text-xs text-slate-500 ${embedded ? 'px-3 py-2' : 'px-4 py-3'}`}>
          <HardDrive size={15} /> 原始视频、眼动 CSV 和元数据始终保存在各采集电脑本地；主控只保存任务与状态摘要。
        </div>
      </div>
    </div>
  );
};

const StatusRow: React.FC<{ label: string; ok: boolean; text: string }> = ({ label, ok, text }) => (
  <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
    <span className="text-slate-500">{label}</span>
    <span className={`font-bold ${ok ? 'text-emerald-600' : 'text-amber-600'}`}>{text}</span>
  </div>
);

export default MultiplayerPage;
