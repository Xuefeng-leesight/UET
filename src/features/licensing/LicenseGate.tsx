import React from 'react';
import { AlertTriangle, Clipboard, Download, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import type { LicenseStateSummary, UpdateCheckResult } from '@shared/contracts/licensing';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import { LicenseManagementContext, LicenseStateContext } from '@/features/licensing/licenseContext';

const loadingState: LicenseStateSummary = {
  state: 'loading',
  canUseApp: false,
  message: '正在读取本地 License…',
  customerName: '',
  maskedLicenseKey: '',
  activationMode: null,
  expiresAt: null,
  offlineValidUntil: null,
  modules: [],
  lastErrorCode: '',
};

const LicenseGate: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [state, setState] = React.useState<LicenseStateSummary>(loadingState);
  const [licenseKey, setLicenseKey] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState('');
  const [machineCode, setMachineCode] = React.useState('');
  const [update, setUpdate] = React.useState<UpdateCheckResult | null>(null);
  const [updateBusy, setUpdateBusy] = React.useState(false);
  const updateChecked = React.useRef(false);
  const lastImmediateRefreshKey = React.useRef('');

  React.useEffect(() => {
    let active = true;
    const readLocalState = () => {
      void ipcClient.getLicenseState().then((current) => {
        if (active) setState(current);
      }).catch(() => {});
    };
    readLocalState();
    // 本地校验不请求网络；持续运行和休眠恢复后也检查总到期时间。
    const timer = window.setInterval(readLocalState, 1000);
    window.addEventListener('focus', readLocalState);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', readLocalState);
    };
  }, []);

  React.useEffect(() => {
    if (!state.canUseApp || updateChecked.current) return;
    updateChecked.current = true;
    void ipcClient.checkUpdate('stable').then(setUpdate);
  }, [state.canUseApp]);

  React.useEffect(() => {
    if (!state.canUseApp || state.activationMode !== 'online') return;
    const refreshCurrentLicense = () => {
      void ipcClient.refreshLicense().then((result) => {
        setState(result.state);
        if (result.ok === false && !result.state.canUseApp) setFeedback(result.message || '授权状态刷新失败。');
      });
    };
    const refreshKey = `${state.maskedLicenseKey}|${state.expiresAt || ''}`;
    if (lastImmediateRefreshKey.current !== refreshKey) {
      lastImmediateRefreshKey.current = refreshKey;
      refreshCurrentLicense();
    }
    const timer = window.setInterval(refreshCurrentLicense, 12 * 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [state.activationMode, state.canUseApp]);

  const runAction = React.useCallback(async (action: () => Promise<{
    ok: boolean;
    state: LicenseStateSummary;
    message?: string;
  }>) => {
    setBusy(true);
    setFeedback('');
    try {
      const result = await action();
      setState(result.state);
      if (!result.ok) setFeedback(result.message || '操作失败。');
    } finally {
      setBusy(false);
    }
  }, []);

  const activate = () => runAction(() => ipcClient.activateLicense(licenseKey));
  const importOffline = () => runAction(() => ipcClient.importOfflineLicense());
  const refresh = () => runAction(() => ipcClient.refreshLicense());
  const deactivate = () => runAction(() => ipcClient.deactivateLicense());

  const revealMachineCode = async () => {
    const result = await ipcClient.getMachineCode();
    if (!result.ok) return;
    setMachineCode(result.machineCode);
  };

  const copyMachineCode = async () => {
    const result = await ipcClient.copyMachineCode();
    setFeedback(result.ok ? '机器码已复制。' : '复制失败，请手动选择复制机器码。');
  };

  const installUpdate = async () => {
    setUpdateBusy(true);
    setFeedback('正在下载并校验安装包，请勿关闭软件…');
    try {
      const result = await ipcClient.downloadAndInstallUpdate('stable');
      if (!result.ok) setFeedback(result.message || '更新安装失败。');
      else setFeedback('安装器已经启动，软件即将退出。');
    } finally {
      setUpdateBusy(false);
    }
  };

  if (state.state === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-600">
        <div className="flex items-center gap-3 text-sm"><Loader2 className="animate-spin text-sky-600" size={20} />正在验证软件授权…</div>
      </div>
    );
  }

  if (!state.canUseApp) {
    const configurationError = state.state === 'configuration-error';
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-5 py-10">
        <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-600">
              <ShieldCheck size={26} />
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-800">软件授权</h1>
              <p className="mt-0.5 text-sm text-slate-500">输入后台签发的 License key 完成激活</p>
            </div>
          </div>

          <label className="mt-6 block text-xs font-medium text-slate-600" htmlFor="ust-license-key">License key</label>
          <input
            id="ust-license-key"
            value={licenseKey}
            onChange={(event) => setLicenseKey(event.target.value.toUpperCase())}
            onKeyDown={(event) => { if (event.key === 'Enter' && licenseKey.trim() && !busy) void activate(); }}
            placeholder="UST-ABCD-EFGH-JKLM-NPQR"
            autoComplete="off"
            spellCheck={false}
            disabled={busy || configurationError}
            className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 font-mono text-sm tracking-wide text-slate-800 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10 disabled:opacity-50"
          />

          <button
            type="button"
            onClick={() => void activate()}
            disabled={busy || !licenseKey.trim() || configurationError}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-sky-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Loader2 className="animate-spin" size={17} /> : <KeyRound size={17} />}
            在线激活
          </button>
          <button
            type="button"
            onClick={() => void importOffline()}
            disabled={busy || configurationError}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
          >
            <Download size={17} />导入离线 License
          </button>

          {(feedback || state.message) && (
            <div className="mt-4 flex gap-3 rounded-xl border border-amber-200 bg-amber-100 px-4 py-3 text-sm text-amber-700">
              <AlertTriangle className="mt-0.5 shrink-0" size={17} />
              <span>{feedback || state.message}</span>
            </div>
          )}

          <div className="mt-6 border-t border-slate-100 pt-4">
            {!machineCode ? (
              <button type="button" onClick={() => void revealMachineCode()} className="mrt-button-text text-xs font-medium text-sky-600 hover:text-sky-700">
                离线授权 · 显示机器码
              </button>
            ) : (
              <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <code className="min-w-0 flex-1 break-all text-xs leading-6 text-slate-700">{machineCode}</code>
                <button type="button" onClick={() => void copyMachineCode()} className="mrt-button-text flex shrink-0 items-center gap-1 text-xs font-medium text-sky-600 hover:text-sky-700"><Clipboard size={13} />复制</button>
              </div>
            )}
          </div>
        </section>
      </div>
    );
  }

  const availableUpdate = update?.ok && update.updateAvailable && update.release ? update : null;
  if (availableUpdate?.forceUpdate) {
    return (
      <LicenseStateContext.Provider value={state}>
        <div className="flex min-h-screen items-center justify-center bg-slate-50 px-5">
          <section className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-8 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-sky-50 text-sky-600"><Download size={28} /></div>
            <h1 className="mt-5 text-xl font-bold text-slate-800">必须更新到 {availableUpdate.release.version}</h1>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-500">{availableUpdate.release.changelog || '此版本包含必须安装的安全性或兼容性更新。'}</p>
            <button
              type="button"
              onClick={() => void installUpdate()}
              disabled={updateBusy}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-sky-500 px-4 py-3 text-sm font-semibold text-white hover:bg-sky-600 disabled:opacity-50"
            >
              {updateBusy ? <Loader2 className="animate-spin" size={17} /> : <Download size={17} />}
              {updateBusy ? '正在下载、校验安装包' : '下载并安装更新'}
            </button>
            {feedback && <p className="mt-4 text-sm text-rose-600">{feedback}</p>}
          </section>
        </div>
      </LicenseStateContext.Provider>
    );
  }
  const checkUpdate = () => {
    void ipcClient.checkUpdate('stable').then(setUpdate);
  };
  return (
    <LicenseManagementContext.Provider value={{
      state,
      busy,
      feedback,
      update,
      updateBusy,
      refresh: () => { void refresh(); },
      deactivate: () => { void deactivate(); },
      checkUpdate,
      installUpdate: () => { void installUpdate(); },
    }}>
      <LicenseStateContext.Provider value={state}>
        {children}

        {availableUpdate && (
          <div className="fixed bottom-5 left-1/2 z-[120] flex w-[min(92vw,720px)] -translate-x-1/2 items-center gap-4 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-lg">
            <Download className="shrink-0 text-sky-600" size={22} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-800">发现新版本 {availableUpdate.release.version}</p>
              <p className="mt-1 truncate text-xs text-slate-500">{availableUpdate.release.changelog || '包含稳定性和功能改进'}</p>
            </div>
            <button type="button" onClick={() => void installUpdate()} className="rounded-lg bg-sky-500 px-3 py-2 text-xs font-semibold text-white hover:bg-sky-600">立即更新</button>
          </div>
        )}
      </LicenseStateContext.Provider>
    </LicenseManagementContext.Provider>
  );
};

export default LicenseGate;
