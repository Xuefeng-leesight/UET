import React from 'react';
import { Download, Loader2, RefreshCw, Unplug } from 'lucide-react';
import { useLanguage } from '@/app/i18n/useLanguage';
import { useLicenseManagement } from '@/features/licensing/licenseContext';

function formatDate(value: string | null, locale: string): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(locale);
}

function moduleLabel(code: string, english: boolean): string {
  if (code === 'eye_tracking') return english ? 'Eye tracking' : '眼动模块';
  if (code === 'facial_analysis') return english ? 'Facial analysis' : '表情模块';
  return code;
}

const LicenseSettingsPanel: React.FC = () => {
  const { language } = useLanguage();
  const english = language === 'en-US';
  const management = useLicenseManagement();
  if (!management) {
    return <p className="text-xs text-slate-500">{english ? 'License status is unavailable.' : '授权状态暂不可用。'}</p>;
  }

  const { state, busy, feedback, update, updateBusy } = management;
  const availableUpdate = update?.ok && update.updateAvailable && update.release ? update : null;

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-sky-600">
          {english ? 'License active' : '授权有效'}
        </p>
        <p className="mt-2 text-xs leading-6 text-slate-500">
          {english
            ? 'This device is licensed. Review validity, refresh the license, or deactivate this device here.'
            : '当前设备授权有效，可在这里查看有效期、刷新授权或解除本机激活。'}
        </p>
      </div>

      <div className="grid gap-3">
        <div className="rounded-xl bg-slate-50 p-4">
          <p className="text-xs text-slate-500">{english ? 'License expires' : '授权到期'}</p>
          <p className="mt-1 text-sm font-semibold text-slate-800">{formatDate(state.expiresAt, language)}</p>
        </div>
      </div>

      <div>
        <p className="mb-2 text-xs font-bold text-slate-600">{english ? 'Licensed modules' : '已授权模块'}</p>
        <div className="flex flex-wrap gap-2">
          {state.modules.map((module) => (
            <span key={module.code} className="rounded-full bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700">
              {moduleLabel(module.code, english)}
            </span>
          ))}
        </div>
      </div>

      {availableUpdate && (
        <div
          className="rounded-xl border p-4"
          style={{ borderColor: 'var(--app-primary)', backgroundColor: 'var(--app-primary-soft-50)' }}
        >
          <p className="text-sm font-semibold text-slate-800">
            {english ? 'New version' : '新版本'} {availableUpdate.release.version}
          </p>
          <p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-slate-600">
            {availableUpdate.release.changelog || (english ? 'No release notes' : '暂无更新说明')}
          </p>
          <button
            type="button"
            onClick={management.installUpdate}
            disabled={updateBusy}
            className="mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-50"
            style={{ backgroundColor: 'var(--app-primary)', color: 'var(--app-primary-foreground)' }}
          >
            {updateBusy ? <Loader2 className="animate-spin" size={14} /> : <Download size={14} />}
            {updateBusy
              ? english ? 'Downloading and verifying' : '正在下载和校验'
              : english ? 'Download and install' : '下载并安装'}
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-5">
        <button
          type="button"
          onClick={management.refresh}
          disabled={busy}
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-50"
          style={{ backgroundColor: 'var(--app-primary)', color: 'var(--app-primary-foreground)' }}
        >
          <RefreshCw size={14} />{english ? 'Refresh license' : '刷新授权'}
        </button>
        <button
          type="button"
          onClick={management.checkUpdate}
          className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold hover:bg-slate-50"
        >
          {english ? 'Check for updates' : '检查更新'}
        </button>
        <button
          type="button"
          onClick={management.deactivate}
          disabled={busy}
          className="ml-auto flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold disabled:opacity-50"
          style={{
            borderColor: 'color-mix(in srgb, var(--app-danger) 35%, var(--app-border))',
            color: 'var(--app-danger)',
            backgroundColor: 'var(--app-danger-soft-50)',
          }}
        >
          <Unplug size={14} />{english ? 'Deactivate this device' : '解除本机激活'}
        </button>
      </div>

      {feedback && <p className="text-sm text-rose-600">{feedback}</p>}
    </div>
  );
};

export default LicenseSettingsPanel;
