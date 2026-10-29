import React, { useEffect, useState } from 'react';
import { Check, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import CustomSelect from '@/shared/ui/CustomSelect';
import { Modal } from '@/shared/ui/Modal';
import { btnDanger, btnPrimary, btnSecondary } from '@/shared/ui/buttonClasses';
import { THEME_LABELS, THEME_PREVIEWS, type ThemeName } from '@/app/theme/theme';
import { DEFAULT_SAMPLING_RATE_HZ, DEFAULT_VIDEO_SAMPLING_RATE_HZ, VIDEO_SAMPLING_RATE_OPTIONS } from '@/features/recording/sampling-rate/samplingRate';
import { useSamplingRateHz, useVideoSamplingRateHz } from '@/features/recording/sampling-rate/useSamplingRate';
import type { TriggerConfig } from '@/shared/types/mrt';
import { triggerService } from '@/features/recording/TriggerService';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import { useSimulateMode } from '@/features/recording/simulate/useSimulateMode';
import { isSimulateModeAvailable } from '@/features/recording/simulate/simulateMode';
import { GAZE_DISPLAY_PATH_OPTIONS, useGazeDisplayPath } from '@/features/recording/domain/gazeDisplayPath';
import ScreenConfigModal from '@/features/recording/ScreenConfigModal';
import { LANGUAGE_OPTIONS, type LanguageCode } from '@/app/i18n/i18nConfig';
import { useLanguage } from '@/app/i18n/useLanguage';
import {
  listAudioInputDevices,
  loadAudioInputSetting,
  saveAudioInputSetting,
  type AudioInputDevice,
  type AudioInputSetting,
} from '@/features/recording/domain/audioRecording';
import MultiplayerPage, { type MultiplayerPageProps } from '@/features/multiplayer/MultiplayerPage';
import LicenseSettingsPanel from '@/features/licensing/LicenseSettingsPanel';
import { useLicenseManagement } from '@/features/licensing/licenseContext';
import { ENABLE_LICENSE_AUTHORIZATION } from '@/app/config';
import { TriggerSerialSettings } from '@/app/settings/TriggerSerialSettings';
import { LiquidGlassLens } from '@/app/layout/LiquidGlassLens';

interface ThemeSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  theme: ThemeName;
  onChangeTheme: (next: ThemeName) => void;
  projectDir?: string;  // 新增：用于保存/加载Trigger配置
  multiplayerProps?: Omit<MultiplayerPageProps, 'embedded'>;
}

const ThemeSettingsModal: React.FC<ThemeSettingsModalProps> = ({
  isOpen,
  onClose,
  theme,
  onChangeTheme,
  projectDir,
  multiplayerProps,
}) => {
  const options: ThemeName[] = ['modern-light', 'dark', 'glass'];
  const { samplingRateHz, setSamplingRateHz } = useSamplingRateHz();
  const { videoSamplingRateHz, setVideoSamplingRateHz } = useVideoSamplingRateHz();
  const { simulateMode, setSimulateMode } = useSimulateMode();
  const { gazeDisplayPath, setGazeDisplayPath } = useGazeDisplayPath();
  const { language, setLanguage } = useLanguage();
  const simulateModeAvailable = isSimulateModeAvailable();
  const [active, setActive] = React.useState<'language' | 'license' | 'theme' | 'sampling' | 'audio' | 'trigger' | 'screen' | 'simulate' | 'ai' | 'multiplayer'>('language');
  const navListRef = React.useRef<HTMLDivElement>(null);
  const licenseManagement = useLicenseManagement();
  const licenseSettingsAvailable = ENABLE_LICENSE_AUTHORIZATION && Boolean(licenseManagement?.state.canUseApp);
  const [languageDraft, setLanguageDraft] = React.useState<LanguageCode>(language);
  const [audioSetting, setAudioSetting] = useState<AudioInputSetting>(() => loadAudioInputSetting());
  const [audioDevices, setAudioDevices] = useState<AudioInputDevice[]>([]);
  const [audioDetecting, setAudioDetecting] = useState(false);
  const [audioStatus, setAudioStatus] = useState<string | null>(null);

  const [aiSettingsLoaded, setAiSettingsLoaded] = useState(false);
  const [aiHasApiKey, setAiHasApiKey] = useState(false);
  const [aiApiKeyMasked, setAiApiKeyMasked] = useState('');
  const [aiSecurityMode, setAiSecurityMode] = useState<'encrypted' | 'plain'>('plain');
  const [aiForm, setAiForm] = useState({
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    apiKey: '',
    temperature: 0.3,
    maxTokens: 1400,
    timeoutMs: 60000,
  });
  const [aiChanged, setAiChanged] = useState(false);
  const [aiSaving, setAiSaving] = useState(false);
  const [aiTesting, setAiTesting] = useState(false);
  const [aiStatus, setAiStatus] = useState<string | null>(null);

  // Trigger配置状态
  const [triggerConfig, setTriggerConfig] = useState<TriggerConfig>({
    enabled: false,
    udpSendPort: 8888,
    udpReceivePort: 8889,
    targetIp: '127.0.0.1',
    tcpStreamingEnabled: false,
    tcpListenIp: '0.0.0.0',
    tcpListenPort: 7979,
  });
  const [triggerConfigLoaded, setTriggerConfigLoaded] = useState(false);
  const [triggerConfigChanged, setTriggerConfigChanged] = useState(false);
  const [triggerSaveStatus, setTriggerSaveStatus] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [tcpStatus, setTcpStatus] = useState<{ listening: boolean; clientCount: number; address: string; port: number } | null>(null);

  // 加载Trigger配置
  useEffect(() => {
    if (isOpen && projectDir && !triggerConfigLoaded && ipcClient.isAvailable()) {
      loadTriggerConfig();
    }
  }, [isOpen, projectDir, triggerConfigLoaded]);

  useEffect(() => {
    if (!isOpen || active !== 'trigger' || !ipcClient.isAvailable()) return;
    let cancelled = false;
    const refresh = async () => {
      const result = await ipcClient.getTcpStreamingStatus();
      if (!cancelled && result.ok) {
        setTcpStatus({
          listening: result.listening,
          clientCount: result.clientCount,
          address: result.address,
          port: result.port,
        });
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, isOpen]);

  useEffect(() => {
    if (isOpen && !aiSettingsLoaded && ipcClient.isAvailable()) {
      void loadAiSettings();
    } else if (isOpen && !aiSettingsLoaded && !ipcClient.isAvailable()) {
      setAiSettingsLoaded(true);
    }
  }, [isOpen, aiSettingsLoaded]);

  useEffect(() => {
    if (isOpen) {
      setLanguageDraft(language);
      setAudioSetting(loadAudioInputSetting());
      void refreshAudioDevices(false);
    }
  }, [isOpen, language]);

  // 重置加载状态当模态框关闭时
  useEffect(() => {
    if (!isOpen) {
      setTriggerConfigLoaded(false);
      setTriggerConfigChanged(false);
      setTriggerSaveStatus(null);
      setValidationErrors([]);
      setTcpStatus(null);
      setAiSettingsLoaded(false);
      setAiStatus(null);
      setAiChanged(false);
      setAiForm((prev) => ({ ...prev, apiKey: '' }));
      setAudioStatus(null);
    }
  }, [isOpen]);

  const refreshAudioDevices = async (requestPermission: boolean) => {
    setAudioDetecting(true);
    setAudioStatus(null);
    try {
      const devices = await listAudioInputDevices(requestPermission);
      setAudioDevices(devices);
      setAudioStatus(
        devices.length > 0
          ? language === 'en-US'
            ? `${devices.length} microphone(s) detected`
            : `检测到 ${devices.length} 个麦克风`
          : language === 'en-US'
            ? 'No microphones detected'
            : '未检测到麦克风',
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : (language === 'en-US' ? 'Unknown error' : '未知错误');
      setAudioStatus(
        language === 'en-US'
          ? `Microphone detection failed: ${message}`
          : `麦克风检测失败：${message}`,
      );
    } finally {
      setAudioDetecting(false);
    }
  };

  const handleAudioInputChange = (deviceId: string) => {
    const selected = audioDevices.find((device) => device.deviceId === deviceId);
    const next = {
      deviceId,
      label: selected?.label || '',
    };
    setAudioSetting(next);
    saveAudioInputSetting(next);
    setAudioStatus(
      deviceId
        ? language === 'en-US'
          ? 'Microphone selection saved'
          : '麦克风选择已保存'
        : language === 'en-US'
          ? 'Audio recording disabled'
          : '已关闭音频录制',
    );
  };

  const loadAiSettings = async () => {
    try {
      const res = await ipcClient.loadAiSettings();
      if (res.ok && res.settings) {
        setAiForm({
          baseUrl: res.settings.baseUrl || 'https://api.openai.com/v1',
          model: res.settings.model || 'gpt-4.1-mini',
          apiKey: '',
          temperature: res.settings.temperature,
          maxTokens: res.settings.maxTokens,
          timeoutMs: res.settings.timeoutMs || 60000,
        });
        setAiHasApiKey(!!res.settings.hasApiKey);
        setAiApiKeyMasked(res.settings.apiKeyMasked || '');
        setAiSecurityMode(res.settings.securityMode || 'plain');
      } else {
        const message = 'message' in res ? res.message : '';
        setAiStatus(message || '加载 AI 设置失败');
      }
    } catch (error) {
      console.error('加载AI设置失败:', error);
      setAiStatus('加载 AI 设置失败');
    } finally {
      setAiSettingsLoaded(true);
    }
  };

  const handleAiFieldChange = (field: 'baseUrl' | 'model' | 'apiKey' | 'temperature' | 'maxTokens' | 'timeoutMs', value: string | number) => {
    setAiForm((prev) => ({ ...prev, [field]: value }));
    setAiChanged(true);
    setAiStatus(null);
  };

  const handleSaveAiSettings = async (clearApiKey = false) => {
    setAiSaving(true);
    setAiStatus(null);
    try {
      const res = await ipcClient.saveAiSettings({
        settings: {
          baseUrl: String(aiForm.baseUrl || '').trim(),
          model: String(aiForm.model || '').trim(),
          apiKey: clearApiKey ? '' : String(aiForm.apiKey || ''),
          clearApiKey,
          temperature: Number(aiForm.temperature),
          maxTokens: Number(aiForm.maxTokens),
          timeoutMs: Number(aiForm.timeoutMs),
        },
      });
      if (res.ok && res.settings) {
        setAiHasApiKey(!!res.settings.hasApiKey);
        setAiApiKeyMasked(res.settings.apiKeyMasked || '');
        setAiSecurityMode(res.settings.securityMode || 'plain');
        setAiForm((prev) => ({
          ...prev,
          baseUrl: res.settings.baseUrl || prev.baseUrl,
          model: res.settings.model || prev.model,
          temperature: res.settings.temperature,
          maxTokens: res.settings.maxTokens,
          timeoutMs: res.settings.timeoutMs,
          apiKey: '',
        }));
        setAiChanged(false);
        setAiStatus(clearApiKey ? 'API Key 已清空' : 'AI 设置保存成功');
      } else {
        const message = 'message' in res ? res.message : '';
        setAiStatus(message || '保存失败');
      }
    } catch (error) {
      console.error('保存AI设置失败:', error);
      setAiStatus('保存失败');
    } finally {
      setAiSaving(false);
    }
  };

  const handleTestAiConnection = async () => {
    setAiTesting(true);
    setAiStatus(null);
    try {
      const res = await ipcClient.testAiConnection();
      if (res.ok) {
        setAiStatus(`连接成功 · ${res.model} · ${res.latencyMs}ms`);
      } else {
        const message = 'message' in res ? res.message : '';
        setAiStatus(message || '连接失败');
      }
    } catch (error) {
      console.error('测试AI连接失败:', error);
      setAiStatus('连接失败');
    } finally {
      setAiTesting(false);
    }
  };

  const loadTriggerConfig = async () => {
    if (!projectDir) return;
    
    try {
      const result = await ipcClient.loadTriggerConfig({ projectDir });
      if (result.ok && result.config) {
        setTriggerConfig(result.config);
      }
      setTriggerConfigLoaded(true);
    } catch (error) {
      console.error('加载Trigger配置失败:', error);
      setTriggerConfigLoaded(true);
    }
  };

  const handleTriggerConfigChange = <K extends keyof TriggerConfig>(field: K, value: TriggerConfig[K]) => {
    setTriggerConfig(prev => ({ ...prev, [field]: value }));
    setTriggerConfigChanged(true);
    setTriggerSaveStatus(null);
    
    // 实时验证
    const newConfig = { ...triggerConfig, [field]: value };
    const validation = triggerService.validateConfig(newConfig);
    setValidationErrors(validation.errors);
  };

  const handleSaveTriggerConfig = async () => {
    if (!projectDir) {
      setTriggerSaveStatus('未选择工程');
      return;
    }
    
    // 验证配置
    const validation = triggerService.validateConfig(triggerConfig);
    if (!validation.valid) {
      setValidationErrors(validation.errors);
      setTriggerSaveStatus('验证失败');
      return;
    }
    
    try {
      const result = await ipcClient.saveTriggerConfig({ projectDir, config: triggerConfig });
      if (result.ok) {
        window.dispatchEvent(new CustomEvent('mrt-trigger-config-updated', { detail: triggerConfig }));
        setTriggerConfigChanged(false);
        setTriggerSaveStatus('保存成功');
        setTimeout(() => setTriggerSaveStatus(null), 3000);
      } else {
        setTriggerSaveStatus(('message' in result ? result.message : '') || '保存失败');
      }
    } catch (error) {
      console.error('保存Trigger配置失败:', error);
      setTriggerSaveStatus('保存失败');
    }
  };

  const handleApplyLanguage = () => {
    if (languageDraft === language) {
      return;
    }
    setLanguage(languageDraft);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="系统设置"
      footer={null}
      maxWidthClassName="max-w-3xl"
      keepMounted
    >
      <div className="flex h-[520px] max-h-[60vh] min-h-0 gap-0">
        <div className="mrt-navigation h-full w-44 shrink-0 border-r border-slate-100 pr-4">
          <div ref={navListRef} className="relative flex flex-col gap-1">
            {theme === 'glass' && (
              <LiquidGlassLens containerRef={navListRef} activeKey={active} onSelect={(id) => setActive(id as typeof active)} />
            )}
            <button
              data-nav-id="language"

              onClick={() => setActive('language')}
              aria-current={active === 'language' ? 'page' : undefined}
              className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition-colors ${
                active === 'language' ? 'bg-sky-100 text-sky-600' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              语言设置
            </button>
            {licenseSettingsAvailable && (
              <button
                data-nav-id="license"

                onClick={() => setActive('license')}
                aria-current={active === 'license' ? 'page' : undefined}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition-colors ${
                  active === 'license' ? 'bg-sky-100 text-sky-600' : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                {language === 'en-US' ? 'License' : '授权信息'}
              </button>
            )}
            <button
              data-nav-id="theme"

              onClick={() => setActive('theme')}
              aria-current={active === 'theme' ? 'page' : undefined}
              className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition-colors ${
                active === 'theme' ? 'bg-sky-100 text-sky-600' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              系统风格
            </button>
            <button
              data-nav-id="sampling"

              onClick={() => setActive('sampling')}
              aria-current={active === 'sampling' ? 'page' : undefined}
              className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition-colors ${
                active === 'sampling' ? 'bg-sky-100 text-sky-600' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              采样率设置
            </button>
            <button
              data-nav-id="audio"

              onClick={() => setActive('audio')}
              aria-current={active === 'audio' ? 'page' : undefined}
              className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition-colors ${
                active === 'audio' ? 'bg-sky-100 text-sky-600' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              音频录制
            </button>
            <button
              data-nav-id="ai"

              onClick={() => setActive('ai')}
              aria-current={active === 'ai' ? 'page' : undefined}
              className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition-colors ${
                active === 'ai' ? 'bg-sky-100 text-sky-600' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              AI 分析
            </button>
            <button
              data-nav-id="trigger"

              onClick={() => setActive('trigger')}
              aria-current={active === 'trigger' ? 'page' : undefined}
              className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition-colors ${
                active === 'trigger' ? 'bg-sky-100 text-sky-600' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              通讯配置
            </button>
            <button
              data-nav-id="screen"

              onClick={() => setActive('screen')}
              aria-current={active === 'screen' ? 'page' : undefined}
              className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition-colors ${
                active === 'screen' ? 'bg-sky-100 text-sky-600' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              屏幕配置
            </button>
            {simulateModeAvailable && (
              <button
                data-nav-id="simulate"

                onClick={() => setActive('simulate')}
                aria-current={active === 'simulate' ? 'page' : undefined}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition-colors ${
                  active === 'simulate' ? 'bg-sky-100 text-sky-600' : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                模拟模式
              </button>
            )}
            {multiplayerProps && (
              <button
                data-nav-id="multiplayer"

                onClick={() => setActive('multiplayer')}
                aria-current={active === 'multiplayer' ? 'page' : undefined}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition-colors ${
                  active === 'multiplayer' ? 'bg-sky-100 text-sky-600' : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                多人采集
              </button>
            )}
          </div>
        </div>

        <div className="h-full min-h-0 flex-1 overflow-y-auto pl-6 pr-1">
          {active === 'language' ? (
            <div className="space-y-4">
              <div className="text-xs text-slate-500">语言切换会立即生效。</div>
              <div className="flex items-center gap-3">
                <div className="text-sm font-bold text-slate-800">界面语言</div>
                <CustomSelect
                  value={languageDraft}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setLanguageDraft(e.target.value as LanguageCode)}
                  className="min-w-24 px-3 py-2 bg-white border border-slate-200 rounded text-xs outline-none"
                  dataI18nSkip
                >
                  {LANGUAGE_OPTIONS.map((item) => (
                    <option key={item.code} value={item.code}>
                      {item.label}
                    </option>
                  ))}
                </CustomSelect>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={handleApplyLanguage}
                  className={`px-3 py-2 rounded-lg text-xs font-bold transition-colors ${
                    languageDraft === language
                      ? 'bg-slate-200 text-slate-500'
                      : 'bg-sky-500 text-white hover:bg-sky-600'
                  }`}
                >
                  保存
                </button>
              </div>
            </div>
          ) : active === 'license' && licenseSettingsAvailable ? (
            <LicenseSettingsPanel />
          ) : active === 'theme' ? (
            <div className="space-y-4">
              <div className="text-xs text-slate-500">
                {language === 'en-US' ? 'Choose an appearance. Changes apply immediately.' : '选择界面外观，切换后立即生效。'}
              </div>
              <div className="grid grid-cols-2 gap-3">
                {options.map((key) => {
                  const p = THEME_PREVIEWS[key];
                  const selected = theme === key;
                  return (
                    <button
                      key={key}
                      onClick={() => onChangeTheme(key)}
                      aria-pressed={selected}
                      className={`rounded-xl p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40 ${
                        selected ? 'bg-sky-50' : 'bg-slate-50 hover:bg-slate-100'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-semibold text-slate-800">
                                                   {language === 'en-US' ? (key === 'modern-light' ? 'Light' : key === 'glass' ? 'Glass' : 'Dark') : THEME_LABELS[key]}
                        </div>
                        <span className="flex h-4 w-4 items-center justify-center text-sky-600" aria-hidden="true">
                          {selected ? <Check size={14} strokeWidth={2} /> : null}
                        </span>
                      </div>
                      <div className="mt-3 grid grid-cols-[28px_1fr] gap-2 rounded-lg p-2" style={{ background: p.bg }} aria-hidden="true">
                        <div className="rounded p-1" style={{ background: p.surface }}>
                          <div className="mt-1 h-1 rounded" style={{ background: p.control }} />
                          <div className="mt-2 h-1 rounded" style={{ background: p.text, opacity: 0.2 }} />
                          <div className="mt-2 h-1 rounded" style={{ background: p.text, opacity: 0.2 }} />
                        </div>
                        <div className="min-w-0 rounded p-2" style={{ background: p.surface }}>
                          <div className="h-1.5 w-12 rounded" style={{ background: p.text, opacity: 0.7 }} />
                          <div className="mt-2 h-1 w-full rounded" style={{ background: p.text, opacity: 0.16 }} />
                          <div className="mt-1.5 h-1 w-3/4 rounded" style={{ background: p.text, opacity: 0.16 }} />
                          <div className="mt-3 h-2 w-8 rounded-sm" style={{ background: p.control }} />
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : active === 'sampling' ? (
            <div className="space-y-3">
              <div className="text-xs text-slate-500">
                {language === 'en-US'
                  ? 'Data sampling rate defaults to Auto and uses the detected device rate. Video sampling rate controls recording FPS.'
                  : '数据采样率默认自动，使用检测到的设备采样率；视频采样率用于控制录制视频帧率。'}
              </div>
              <div className="flex items-center gap-3">
                <div className="text-sm font-bold text-slate-800">数据采样率</div>
                <CustomSelect
                  value={samplingRateHz}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSamplingRateHz(Number(e.target.value))}
                  className="min-w-24 px-3 py-2 bg-white border border-slate-200 rounded text-xs outline-none"
                >
                  <option value={0}>自动</option>
                  <option value={30}>30 Hz</option>
                  <option value={60}>60 Hz</option>
                  <option value={90}>90 Hz</option>
                  <option value={120}>120 Hz</option>
                  <option value={140}>140 Hz</option>
                  <option value={240}>240 Hz</option>
                </CustomSelect>
                <div className="text-[11px] text-slate-500 font-mono">
                  {language === 'en-US'
                    ? `Current: ${samplingRateHz > 0 ? `${samplingRateHz} Hz` : 'Auto'}`
                    : `当前：${samplingRateHz > 0 ? `${samplingRateHz}Hz` : '自动'}`}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-sm font-bold text-slate-800">视频采样率</div>
                <CustomSelect
                  value={videoSamplingRateHz}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setVideoSamplingRateHz(Number(e.target.value))}
                  className="min-w-24 px-3 py-2 bg-white border border-slate-200 rounded text-xs outline-none"
                >
                  {VIDEO_SAMPLING_RATE_OPTIONS.map((hz) => (
                    <option key={hz} value={hz}>{hz} FPS</option>
                  ))}
                </CustomSelect>
                <div className="text-[11px] text-slate-500 font-mono">
                  {language === 'en-US' ? `Current: ${videoSamplingRateHz} FPS` : `当前：${videoSamplingRateHz}FPS`}
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={() => {
                    setSamplingRateHz(DEFAULT_SAMPLING_RATE_HZ);
                    setVideoSamplingRateHz(DEFAULT_VIDEO_SAMPLING_RATE_HZ);
                  }}
                  className="text-[10px] font-bold text-slate-500 hover:text-slate-700"
                >
                  重置
                </button>
              </div>
            </div>
          ) : active === 'audio' ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-bold text-slate-700">
                  {language === 'en-US' ? 'Audio input' : '音频输入'}
                </label>
                <CustomSelect
                  value={audioSetting.deviceId}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => handleAudioInputChange(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs outline-none"
                  dataI18nSkip
                >
                  <option value="">{language === 'en-US' ? 'None' : '无'}</option>
                  {audioSetting.deviceId && !audioDevices.some((device) => device.deviceId === audioSetting.deviceId) ? (
                    <option value={audioSetting.deviceId}>
                      {language === 'en-US'
                        ? `Disconnected: ${audioSetting.label || 'Selected microphone'}`
                        : `已断开：${audioSetting.label || '所选麦克风'}`}
                    </option>
                  ) : null}
                  {audioDevices.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </CustomSelect>
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={() => { void refreshAudioDevices(true); }}
                  disabled={audioDetecting}
                  className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-bold transition-colors ${
                    audioDetecting
                      ? 'cursor-not-allowed bg-slate-200 text-slate-400'
                      : 'bg-sky-500 text-white hover:bg-sky-600'
                  }`}
                >
                  <RefreshCw size={14} className={audioDetecting ? 'animate-spin' : ''} />
                  {audioDetecting
                    ? language === 'en-US'
                      ? 'Detecting...'
                      : '检测中...'
                    : language === 'en-US'
                      ? 'Detect microphones'
                      : '检测麦克风'}
                </button>
                {audioStatus ? <span className="text-xs text-slate-500">{audioStatus}</span> : null}
              </div>

              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-700">
                {language === 'en-US'
                  ? 'Default is None. Recordings are still saved without a microphone; microphone audio is recorded only after selecting an input.'
                  : '默认无麦克风。未选择或未检测到麦克风时仍会保存录制；选择输入后才录制麦克风音频。'}
              </div>
            </div>
          ) : active === 'ai' ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-xs text-slate-500">OpenAI 兼容接口配置（本地保存，手动触发）</div>
                <div className={`text-xs font-bold ${aiHasApiKey ? 'text-emerald-600' : 'text-slate-400'}`}>
                  {aiHasApiKey
                    ? language === 'en-US'
                      ? `Configured ${aiApiKeyMasked}`
                      : `已配置 ${aiApiKeyMasked}`
                    : language === 'en-US'
                      ? 'Not configured'
                      : '未配置'}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-600">接口地址</label>
                  <input
                    type="text"
                    value={aiForm.baseUrl}
                    onChange={(e) => handleAiFieldChange('baseUrl', e.target.value)}
                    placeholder="https://api.openai.com/v1"
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-600">模型名称</label>
                  <input
                    type="text"
                    value={aiForm.model}
                    onChange={(e) => handleAiFieldChange('model', e.target.value)}
                    placeholder="gpt-4.1-mini"
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-600">接口密钥</label>
                  <input
                    type="password"
                    value={aiForm.apiKey}
                    onChange={(e) => handleAiFieldChange('apiKey', e.target.value)}
                    placeholder={
                      aiHasApiKey
                        ? language === 'en-US'
                          ? `Saved: ${aiApiKeyMasked} (leave empty to keep unchanged)`
                          : `已保存：${aiApiKeyMasked}（留空不修改）`
                        : 'sk-...'
                    }
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 outline-none"
                  />
                  <div className="text-[11px] text-slate-500">
                    {language === 'en-US'
                      ? `Security mode: ${
                          aiSecurityMode === 'encrypted' ? 'System encrypted storage' : 'Plaintext fallback storage'
                        } (current environment)`
                      : `安全模式：${aiSecurityMode === 'encrypted' ? '系统加密存储' : '明文降级存储'}（当前环境）`}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-600">温度系数</label>
                    <input
                      type="number"
                      min="0"
                      max="2"
                      step="0.1"
                      value={aiForm.temperature}
                      onChange={(e) => handleAiFieldChange('temperature', Number(e.target.value))}
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 outline-none"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-600">最大令牌数</label>
                    <input
                      type="number"
                      min="200"
                      max="8000"
                      step="100"
                      value={aiForm.maxTokens}
                      onChange={(e) => handleAiFieldChange('maxTokens', Number(e.target.value))}
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 outline-none"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-600">超时时间(ms)</label>
                    <input
                      type="number"
                      min="5000"
                      max="180000"
                      step="1000"
                      value={aiForm.timeoutMs}
                      onChange={(e) => handleAiFieldChange('timeoutMs', Number(e.target.value))}
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 outline-none"
                    />
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => { void handleSaveAiSettings(false); }}
                  disabled={aiSaving || (!aiChanged && !aiForm.apiKey.trim())}
                  className={btnPrimary}
                >
                  {aiSaving ? '保存中...' : '保存配置'}
                </button>

                <button
                  onClick={() => { void handleTestAiConnection(); }}
                  disabled={aiTesting || aiSaving}
                  className={btnSecondary}
                >
                  {aiTesting ? '测试中...' : '测试连接'}
                </button>

                <button
                  onClick={() => { void handleSaveAiSettings(true); }}
                  disabled={aiSaving || !aiHasApiKey}
                  className={btnDanger}
                >
                  清空 Key
                </button>
              </div>

              {aiStatus ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  {aiStatus}
                </div>
              ) : null}
            </div>
          ) : null}
          {simulateModeAvailable && active === 'simulate' && (
            <div className="space-y-4">
              <div className="text-xs text-slate-500 mb-4">
                {language === 'en-US'
                  ? 'Used for testing and demos when no physical eye tracker is available.'
                  : '用于在没有真实眼动仪设备时进行测试和演示'}
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="mb-3">
                  <div className="text-sm font-bold text-slate-800">
                    {language === 'en-US' ? 'Frontend gaze display path' : '前端注视点显示链路'}
                  </div>
                  <div className="mt-1 text-xs leading-relaxed text-slate-600">
                    {language === 'en-US'
                      ? 'Applies to desktop and glasses live preview, calibration test, participant window, and playback point loading.'
                      : '同时作用于桌面式和眼镜式的实时预览、校准测试、被试窗口和回放点加载。'}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {GAZE_DISPLAY_PATH_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={gazeDisplayPath === option.value}
                      onClick={() => setGazeDisplayPath(option.value)}
                      className={`rounded-md border px-3 py-2 text-xs font-semibold transition-colors ${
                        gazeDisplayPath === option.value
                          ? 'border-sky-500 bg-sky-50 text-sky-700'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                      }`}
                    >
                      {language === 'en-US' ? option.labelEn : option.label}
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-start gap-4 p-4 rounded-lg border-2 border-slate-200 bg-white cursor-pointer hover:border-sky-300 transition-colors">
                <div className="flex items-center h-6">
                  <input
                    type="checkbox"
                    checked={simulateMode}
                    onChange={(e) => setSimulateMode(e.target.checked)}
                    className="w-5 h-5 rounded bg-white border-slate-300 text-sky-500 focus:ring-sky-500 accent-sky-500 cursor-pointer"
                  />
                </div>
                <div className="flex-1">
                  <div className="text-sm font-bold text-slate-800 mb-1">
                    {language === 'en-US' ? 'Enable simulation mode' : '启用模拟模式'}
                  </div>
                  <div className="text-xs text-slate-600 leading-relaxed">
                    {language === 'en-US'
                      ? 'Skips WebSocket connections and eye tracker communication, enabling stimulus playback testing without real hardware.'
                      : '启用后将跳过WebSocket连接和眼动仪通讯，允许在没有真实设备的情况下测试刺激物播放功能。'}
                  </div>
                </div>
              </label>

              {simulateMode && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                  <div className="flex items-start gap-2">
                    <div className="flex items-center h-5">
                      <span className="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span>
                    </div>
                    <div className="flex-1">
                      <div className="text-xs font-bold text-amber-800 mb-1">
                        {language === 'en-US' ? 'Simulation mode enabled' : '模拟模式已启用'}
                      </div>
                      <div className="text-xs text-amber-700 leading-relaxed">
                        {language === 'en-US'
                          ? 'The system will not connect to a physical eye tracker; recording runs in a simulated environment. Suitable for:'
                          : '当前不会连接真实眼动仪设备，录制功能将在模拟环境下运行。适用于：'}
                      </div>
                      <ul className="mt-2 text-xs text-amber-700 space-y-1 ml-4">
                        <li>• {language === 'en-US' ? 'Development and testing' : '开发调试和功能测试'}</li>
                        <li>• {language === 'en-US' ? 'Demo and training' : '演示和培训场景'}</li>
                        <li>• {language === 'en-US' ? 'Stimulus playback verification' : '刺激物播放流程验证'}</li>
                      </ul>
                    </div>
                  </div>
                </div>
              )}

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <p className="text-xs text-blue-700">
                  {language === 'en-US' ? (
                    <>
                      <strong>Note:</strong> In simulation mode, the system skips all WebSocket connections (image stream, eye data,
                      command control), but still runs the stimulus playback sequence. Trigger sending is not affected; if trigger config is
                      enabled, UDP markers will still be sent.
                    </>
                  ) : (
                    <>
                      <strong>说明：</strong>模拟模式下，系统会跳过所有WebSocket连接（图像流、眼动数据、命令控制），但仍会执行刺激物播放序列。触发发送功能不受模拟模式影响，如果启用触发配置，仍会正常发送UDP标记。
                    </>
                  )}
                </p>
              </div>
            </div>
          )}
          {active === 'screen' && (
            <div className="space-y-4">
              <ScreenConfigModal
                isOpen={isOpen}
                onClose={onClose}
                projectDir={projectDir}
                embedded
              />
            </div>
          )}
          {active === 'trigger' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  {triggerConfig.enabled ? (
                    <Wifi size={16} className="text-green-500" />
                  ) : (
                    <WifiOff size={16} className="text-slate-400" />
                  )}
                  <div className="text-xs text-slate-500">
                    {language === 'en-US'
                      ? 'Send trigger markers via UDP to external devices during recording.'
                      : '录制时通过UDP发送触发标记到外部设备'}
                  </div>
                </div>
                {triggerSaveStatus && (
                  <span className={`text-xs font-bold ${
                    triggerSaveStatus === '保存成功' ? 'text-green-600' : 'text-rose-600'
                  }`}>
                    {triggerSaveStatus}
                  </span>
                )}
              </div>

              {!projectDir && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <p className="text-xs text-amber-700">
                    {language === 'en-US'
                      ? 'Open a project before configuring Trigger settings.'
                      : '请先打开一个工程，才能配置触发设置'}
                  </p>
                </div>
              )}

              <div className="space-y-4">
                <label className="flex items-center justify-between gap-4 p-3 rounded-lg border border-slate-200 bg-white cursor-pointer">
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-slate-800">
                      {language === 'en-US' ? 'Enable trigger' : '启用触发功能'}
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500">
                      {triggerConfig.enabled
                        ? language === 'en-US'
                          ? 'UDP enabled'
                          : '已启用UDP通讯'
                        : language === 'en-US'
                          ? 'Disabled'
                          : '已禁用'}
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={triggerConfig.enabled}
                    disabled={!projectDir}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleTriggerConfigChange('enabled', e.target.checked)}
                    className="w-4 h-4 rounded bg-white border-slate-300 text-sky-500 focus:ring-sky-500 accent-sky-500 disabled:opacity-50"
                  />
                </label>

                {triggerConfig.enabled && projectDir && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-xs font-bold text-slate-600">目标IP地址</label>
                        <input
                          type="text"
                          value={triggerConfig.targetIp}
                          onChange={(e) => handleTriggerConfigChange('targetIp', e.target.value)}
                          placeholder="例如: 192.168.1.100"
                          className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 outline-none transition-all"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-bold text-slate-600">UDP发送端口</label>
                        <input
                          type="number"
                          min="1"
                          max="65535"
                          value={triggerConfig.udpSendPort}
                          onChange={(e) => handleTriggerConfigChange('udpSendPort', Number(e.target.value))}
                          className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 outline-none transition-all"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-xs font-bold text-slate-600">UDP接收端口</label>
                        <input
                          type="number"
                          min="1"
                          max="65535"
                          value={triggerConfig.udpReceivePort}
                          onChange={(e) => handleTriggerConfigChange('udpReceivePort', Number(e.target.value))}
                          className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 outline-none transition-all"
                        />
                      </div>
                    </div>

                    {validationErrors.length > 0 && (
                      <div className="bg-rose-50 border border-rose-200 rounded-lg p-3">
                        <p className="text-xs font-bold text-rose-700 mb-1">
                          {language === 'en-US' ? 'Configuration errors:' : '配置错误：'}
                        </p>
                        <ul className="text-xs text-rose-600 space-y-0.5">
                          {validationErrors.map((error, index) => (
                            <li key={index}>• {error}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                      <p className="text-xs text-blue-700">
                        {language === 'en-US' ? (
                          <>
                            <strong>Note:</strong> When trigger is enabled, the system sends UDP trigger markers to the configured IP and
                            ports during stimulus playback in Recording, for syncing with external devices.
                          </>
                        ) : (
                          <>
                            <strong>说明：</strong>启用触发功能后，在录制播放刺激物时，系统会通过UDP协议向指定的IP地址和端口发送触发标记数据，用于与外部设备同步。
                          </>
                        )}
                      </p>
                    </div>
                  </>
                )}

                {projectDir && <TriggerSerialSettings config={triggerConfig} onChange={handleTriggerConfigChange} isEn={language === 'en-US'} />}

                {projectDir && (
                  <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-3">
                    <label className="flex items-center justify-between gap-4 cursor-pointer">
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-slate-800">
                          启用眼动数据 TCP 转发（6位包体长度 + UTF-8 JSON 字符串协议）
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={triggerConfig.tcpStreamingEnabled}
                        onChange={(e) => handleTriggerConfigChange('tcpStreamingEnabled', e.target.checked)}
                        className="w-4 h-4 rounded bg-white border-slate-300 text-sky-500 focus:ring-sky-500 accent-sky-500"
                      />
                    </label>

                    {triggerConfig.tcpStreamingEnabled && (
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <label className="text-xs font-bold text-slate-600">TCP监听地址</label>
                          <input
                            type="text"
                            value={triggerConfig.tcpListenIp}
                            onChange={(e) => handleTriggerConfigChange('tcpListenIp', e.target.value)}
                            placeholder="0.0.0.0"
                            className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 outline-none"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-xs font-bold text-slate-600">TCP监听端口</label>
                          <input
                            type="number"
                            min="1"
                            max="65535"
                            value={triggerConfig.tcpListenPort}
                            onChange={(e) => handleTriggerConfigChange('tcpListenPort', Number(e.target.value))}
                            className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 outline-none"
                          />
                        </div>
                      </div>
                    )}

                    <div className="text-[11px] text-slate-500">
                      {tcpStatus?.listening
                        ? `监听中：${tcpStatus.address}:${tcpStatus.port} · 客户端 ${tcpStatus.clientCount}`
                        : 'TCP服务未监听'}
                    </div>
                  </div>
                )}

                {projectDir && (
                  <button
                    onClick={handleSaveTriggerConfig}
                    disabled={!triggerConfigChanged || validationErrors.length > 0}
                    className={`w-full px-3 py-2 rounded-lg text-xs font-bold transition-all ${
                      triggerConfigChanged && validationErrors.length === 0
                        ? 'bg-sky-500 text-white hover:bg-sky-600'
                        : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                    }`}
                  >
                    保存配置
                  </button>
                )}

                {!triggerConfig.enabled && validationErrors.length > 0 && (
                  <div className="bg-rose-50 border border-rose-200 rounded-lg p-3">
                    {validationErrors.map((error, index) => (
                      <div key={index} className="text-xs text-rose-700">• {error}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          {multiplayerProps && (
            <div className={active === 'multiplayer' ? '' : 'hidden'}>
              <MultiplayerPage {...multiplayerProps} embedded />
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default ThemeSettingsModal;
