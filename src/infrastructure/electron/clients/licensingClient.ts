import { invokeSafe, invokeSafeNoPayload } from '@/infrastructure/electron/ipcCore';
import type {
  LicenseActionResult,
  LicenseStateSummary,
  TestToolListResult,
  UpdateCheckResult,
} from '@shared/contracts/licensing';

const unavailableState: LicenseStateSummary = {
  state: 'configuration-error',
  canUseApp: false,
  message: '无法连接软件主进程。',
  customerName: '',
  maskedLicenseKey: '',
  activationMode: null,
  expiresAt: null,
  offlineValidUntil: null,
  modules: [],
  lastErrorCode: 'IPC_UNAVAILABLE',
};

export const licensingIpcClient = {
  getLicenseState: () => invokeSafeNoPayload<LicenseStateSummary>('license-get-state', unavailableState),

  getMachineCode: () => invokeSafeNoPayload<{ ok: boolean; machineCode: string }>(
    'license-get-machine-code',
    { ok: false, machineCode: '' },
  ),

  copyMachineCode: () => invokeSafeNoPayload<{ ok: boolean }>(
    'license-copy-machine-code',
    { ok: false },
  ),

  activateLicense: (licenseKey: string) => invokeSafe<LicenseActionResult>(
    'license-activate-online',
    { licenseKey },
    { ok: false, state: unavailableState, code: 'IPC_UNAVAILABLE', message: unavailableState.message },
  ),

  refreshLicense: () => invokeSafeNoPayload<LicenseActionResult>(
    'license-refresh',
    { ok: false, state: unavailableState, code: 'IPC_UNAVAILABLE', message: unavailableState.message },
  ),

  requireLicenseModule: (code: string) => invokeSafe<{ ok: boolean; code?: string; message?: string }>(
    'license-require-module',
    { code },
    { ok: false, code: 'IPC_UNAVAILABLE', message: unavailableState.message },
  ),

  importOfflineLicense: () => invokeSafeNoPayload<LicenseActionResult>(
    'license-import-offline',
    { ok: false, state: unavailableState, code: 'IPC_UNAVAILABLE', message: unavailableState.message },
  ),

  deactivateLicense: () => invokeSafeNoPayload<LicenseActionResult>(
    'license-deactivate',
    { ok: false, state: unavailableState, code: 'IPC_UNAVAILABLE', message: unavailableState.message },
  ),

  checkUpdate: (channel: 'stable' | 'beta' = 'stable') => invokeSafe<UpdateCheckResult>(
    'update-check',
    { channel },
    { ok: false, code: 'IPC_UNAVAILABLE', message: unavailableState.message },
  ),

  downloadAndInstallUpdate: (channel: 'stable' | 'beta' = 'stable') => invokeSafe<{
    ok: boolean;
    code?: string;
    message?: string;
    version?: string;
  }>('update-download-install', { channel }, { ok: false, code: 'IPC_UNAVAILABLE', message: unavailableState.message }),

  listTestTools: () => invokeSafeNoPayload<TestToolListResult>(
    'test-tools-list',
    { ok: false, code: 'IPC_UNAVAILABLE', message: unavailableState.message },
  ),

  openTestToolDownload: (url: string) => invokeSafe<{ ok: boolean; message?: string }>(
    'test-tool-open-download',
    { url },
    { ok: false, message: unavailableState.message },
  ),
};
