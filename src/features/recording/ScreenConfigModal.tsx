import React from 'react';
import { Monitor, MonitorSpeaker, Save } from 'lucide-react';
import CustomSelect from '@/shared/ui/CustomSelect';
import { Modal } from '@/shared/ui/Modal';
import { btnPrimary, btnSecondary } from '@/shared/ui/buttonClasses';
import { ipcClient, type ScreenConfig, type ScreenInfo } from '@/infrastructure/electron/ipcClient';
import { useLanguage } from '@/app/i18n/useLanguage';

interface ScreenConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectDir?: string;
  embedded?: boolean;
}

const DEFAULT_CONFIG: ScreenConfig = {
  enabled: false,
  experimenterDisplayId: null,
  participantDisplayId: null,
};

const ScreenConfigModal: React.FC<ScreenConfigModalProps> = ({ isOpen, onClose, projectDir, embedded = false }) => {
  const { language } = useLanguage();
  const isEn = language === 'en-US';
  const visible = embedded ? true : isOpen;
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [screens, setScreens] = React.useState<ScreenInfo[]>([]);
  const [config, setConfig] = React.useState<ScreenConfig>(DEFAULT_CONFIG);
  const [warnings, setWarnings] = React.useState<string[]>([]);
  const [status, setStatus] = React.useState<string>('');

  const localizeWarning = React.useCallback(
    (warning: string) => {
      if (!isEn) return warning;
      const map: Record<string, string> = {
        '未检测到可用显示器，已回退到单屏模式': 'No available display detected. Switched back to single-screen mode.',
        '主试屏配置无效，已回退到主显示器': 'Experimenter screen config is invalid. Switched back to the main display.',
        '被试屏配置无效，已自动选择可用显示器':
          'Participant screen config is invalid. Automatically selected an available display.',
        '仅检测到一个显示器，已回退到单屏模式': 'Only one display detected. Switched back to single-screen mode.',
        '主试屏与被试屏不能相同，已回退到单屏模式':
          'Experimenter and participant screens cannot be the same. Switched back to single-screen mode.',
      };
      return map[warning] || warning;
    },
    [isEn],
  );

  const getScreenLabel = React.useCallback(
    (screenInfo: ScreenInfo) => {
      const displayIndex = Math.max(1, screens.findIndex((item) => item.id === screenInfo.id) + 1);
      if (isEn) {
        return screenInfo.isPrimary ? `Main display (${displayIndex})` : `Display ${displayIndex}`;
      }
      return screenInfo.isPrimary ? `主显示器 (${displayIndex})` : `显示器 ${displayIndex}`;
    },
    [isEn, screens],
  );

  const loadData = React.useCallback(async () => {
    if (!visible) return;
    setLoading(true);
    setStatus('');
    try {
      const screenRes = await ipcClient.getScreens();
      if (screenRes.ok) {
        setScreens(screenRes.screens);
      } else {
        setScreens([]);
      }

      if (projectDir) {
        const configRes = await ipcClient.loadScreenConfig({ projectDir });
        if (configRes.ok) {
          setConfig(configRes.config);
          setWarnings(configRes.warnings || []);
        } else {
          setConfig(DEFAULT_CONFIG);
          setWarnings(configRes.warnings || []);
          if ('message' in configRes && configRes.message) setStatus(configRes.message);
        }
      } else {
        setConfig(DEFAULT_CONFIG);
        setWarnings([]);
      }
    } finally {
      setLoading(false);
    }
  }, [visible, projectDir]);

  React.useEffect(() => {
    void loadData();
  }, [loadData]);

  const validateAndNormalize = React.useCallback(async (nextConfig: ScreenConfig) => {
    const res = await ipcClient.validateScreenConfig({ config: nextConfig });
    if (res.ok) {
      setConfig(res.config);
      setWarnings(res.warnings || []);
      return res.config;
    }
    return nextConfig;
  }, []);

  const prepareConfigForSave = React.useCallback((base: ScreenConfig): ScreenConfig => {
    return {
      ...base,
      // 分屏是否启用由“是否选择了被试屏”决定；
      // 录制流程是否创建分屏窗口仍由录制页“分屏观察”开关控制。
      enabled: base.participantDisplayId !== null,
    };
  }, []);

  const updateConfigLocal = React.useCallback((patch: Partial<ScreenConfig>) => {
    setConfig((prev) => {
      const next: ScreenConfig = { ...prev, ...patch };
      if (
        next.experimenterDisplayId !== null &&
        next.participantDisplayId !== null &&
        next.experimenterDisplayId === next.participantDisplayId
      ) {
        next.participantDisplayId = null;
      }
      return next;
    });
    setStatus('');
    setWarnings([]);
  }, []);

  const handleSave = async () => {
    if (!projectDir) {
      setStatus(isEn ? 'Open a project before saving screen setup.' : '请先打开工程，再保存屏幕配置');
      return;
    }
    setSaving(true);
    setStatus('');
    try {
      const normalized = await validateAndNormalize(prepareConfigForSave(config));
      const res = await ipcClient.saveScreenConfig({ projectDir, config: normalized });
      if (res.ok) {
        if (res.config) {
          setConfig(res.config);
        }
        setWarnings(res.warnings || []);
        setStatus(isEn ? 'Saved successfully' : '保存成功');
      } else {
        const message = 'message' in res ? res.message : undefined;
        setStatus(message || (isEn ? 'Save failed' : '保存失败'));
      }
    } catch {
      setStatus(isEn ? 'Save failed' : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleApplyTest = async () => {
    if (!projectDir) {
      setStatus(isEn ? 'Open a project before applying screen setup.' : '请先打开工程，再应用屏幕配置');
      return;
    }
    setSaving(true);
    setStatus('');
    try {
      const normalized = await validateAndNormalize(prepareConfigForSave(config));
      const saveRes = await ipcClient.saveScreenConfig({ projectDir, config: normalized });
      if (!saveRes.ok) {
        const message = 'message' in saveRes ? saveRes.message : undefined;
        setStatus(message || (isEn ? 'Save failed, cannot apply' : '保存失败，无法应用'));
        return;
      }
      if (saveRes.config) {
        setConfig(saveRes.config);
      }
      const applyRes = await ipcClient.createRecordingWindow({ projectDir });
      if (applyRes.ok) {
        setWarnings(applyRes.warnings || []);
        setStatus(
          applyRes.hasParticipantWindow
            ? isEn
              ? 'Applied: participant window opened'
              : '已应用：被试屏窗口已打开'
            : isEn
              ? 'Applied: currently single-screen mode'
              : '已应用：当前为单屏模式',
        );
      } else {
        const message = 'message' in applyRes ? applyRes.message : undefined;
        setStatus(message || (isEn ? 'Apply failed' : '应用失败'));
      }
    } catch {
      setStatus(isEn ? 'Apply failed' : '应用失败');
    } finally {
      setSaving(false);
    }
  };

  const availableForParticipant = screens.filter((s) => s.id !== config.experimenterDisplayId);
  const actions = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <button
        onClick={handleApplyTest}
        disabled={!projectDir || saving}
        className={btnSecondary}
      >
        <MonitorSpeaker size={14} />
        应用并测试
      </button>
      <button
        onClick={handleSave}
        disabled={!projectDir || saving}
        className={btnPrimary}
      >
        <Save size={14} />
        保存配置
      </button>
    </div>
  );
  const content = (
    <div className="space-y-4">
        {!projectDir && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            请先打开工程，然后再进行多屏设置。
          </div>
        )}

        {loading ? (
          <div className="text-sm text-slate-500">正在检测显示器...</div>
        ) : (
          <>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2 text-xs font-bold text-slate-600">已检测到显示器</div>
              <div className="space-y-2">
                {screens.length === 0 ? (
                  <div className="text-xs text-slate-500">未检测到显示器信息</div>
                ) : (
                  screens.map((s) => (
                    <div key={s.id} className="flex items-center justify-between rounded border border-slate-200 bg-white px-3 py-2 text-xs">
                      <div className="flex items-center gap-2">
                        <Monitor size={14} className={s.isPrimary ? 'text-sky-500' : 'text-slate-400'} />
                        <span className="font-semibold text-slate-700">{getScreenLabel(s)}</span>
                        {s.isPrimary && (
                          <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-600">
                            {isEn ? 'Main screen' : '主屏'}
                          </span>
                        )}
                      </div>
                      <span className="font-mono text-slate-500">
                        {s.bounds.width}×{s.bounds.height} ({s.bounds.x},{s.bounds.y})
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              分屏是否生效由录制页面的“分屏观察”开关控制；此处仅配置主试屏/被试屏映射关系。
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <div className="text-xs font-bold text-slate-600">主试屏</div>
                <CustomSelect
                  value={config.experimenterDisplayId ?? ''}
                  onChange={(e) => {
                    const val = e.target.value ? Number(e.target.value) : null;
                    updateConfigLocal({ experimenterDisplayId: val });
                  }}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
                  disabled={screens.length === 0}
                >
                  {screens.map((s) => (
                    <option key={s.id} value={s.id}>
                      {getScreenLabel(s)}
                    </option>
                  ))}
                </CustomSelect>
              </div>

              <div className="space-y-1.5">
                <div className="text-xs font-bold text-slate-600">被试屏</div>
                <CustomSelect
                  value={config.participantDisplayId ?? ''}
                  onChange={(e) => {
                    const val = e.target.value ? Number(e.target.value) : null;
                    updateConfigLocal({ participantDisplayId: val });
                  }}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
                  disabled={availableForParticipant.length === 0}
                >
                  <option value="">{isEn ? 'None (single screen)' : '无（单屏）'}</option>
                  {availableForParticipant.map((s) => (
                    <option key={s.id} value={s.id}>
                      {getScreenLabel(s)}
                    </option>
                  ))}
                </CustomSelect>
              </div>
            </div>

            {warnings.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                {warnings.map((w, idx) => (
                  <div key={idx}>- {localizeWarning(w)}</div>
                ))}
              </div>
            )}

            {status && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">{status}</div>
            )}

            {embedded && actions}
          </>
        )}
      </div>
  );

  if (embedded) {
    return content;
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="屏幕配置" maxWidthClassName="max-w-2xl" footer={loading ? null : actions}>
      {content}
    </Modal>
  );
};

export default ScreenConfigModal;
