import os from 'node:os';
import type {
  LicenseActionResult,
  LicenseEnvelope,
  LicenseModuleGrant,
  LicenseStateSummary,
  TestToolListResult,
  UpdateCheckResult,
} from '../../../shared/contracts/licensing';
import { LicenseApiError, activateOnline, checkLatestRelease, checkLicenseStatus, deactivateOnline, fetchSoftdogPassword as fetchSoftdogPasswordApi, listTestTools, refreshOnline } from './licenseApi';
import { evaluateEnvelope, hashMachineCode, verifyEnvelopeSignature } from './licenseCrypto';
import { buildMachineCode, rotateMachineSeed } from './licenseMachine';
import { createLicenseStorage, type NegativeMarker, type StoredLicenseContainer } from './licenseStorage';

const LOCKING_CODES = new Set([
  'LICENSE_REVOKED', 'LICENSE_INACTIVE', 'CUSTOMER_INACTIVE',
  'LICENSE_EXPIRED', 'DEVICE_INACTIVE', 'DEVICE_REVOKED',
  'LICENSE_NOT_FOUND', 'DEVICE_NOT_ACTIVATED',
]);

function maskLicenseKey(value = ''): string {
  if (!value) return '';
  const normalized = value.trim().toUpperCase();
  return normalized.length <= 8 ? '••••••••' : `${normalized.slice(0, 4)}-••••-••••-${normalized.slice(-4)}`;
}

function isEnvelope(value: unknown): value is LicenseEnvelope {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<LicenseEnvelope>;
  return item.schema_version === 1
    && item.algorithm === 'Ed25519'
    && typeof item.key_id === 'string'
    && typeof item.signature === 'string'
    && !!item.payload
    && typeof item.payload === 'object'
    && typeof item.payload.license_id === 'string'
    && typeof item.payload.device_id === 'string'
    && Array.isArray(item.payload.modules);
}

export function createLicenseService(deps: {
  apiOrigin: string;
  trustedSigningKeys: Record<string, string>;
  userDataPath: string;
  clientVersion: string;
  onModulesChanged?: (modules: LicenseModuleGrant[]) => Promise<void> | void;
}) {
  const storage = createLicenseStorage(deps.userDataPath);
  let machineCode = buildMachineCode(deps.userDataPath);
  let container: StoredLicenseContainer | null = null;
  let state: LicenseStateSummary = emptyState('loading', '正在读取本地 License…');

  function emptyState(code: LicenseStateSummary['state'], message: string, lastErrorCode = ''): LicenseStateSummary {
    return {
      state: code,
      canUseApp: false,
      message,
      customerName: '',
      maskedLicenseKey: '',
      activationMode: null,
      expiresAt: null,
      offlineValidUntil: null,
      modules: [],
      lastErrorCode,
    };
  }

  function summaryFromContainer(current: StoredLicenseContainer): LicenseStateSummary {
    const envelope = current.envelope;
    const marker = current.negativeMarker;
    if (
      marker
      && marker.licenseId === envelope.payload.license_id
      && marker.deviceId === envelope.payload.device_id
      && Date.parse(envelope.payload.issued_at) <= Date.parse(marker.observedAt)
    ) {
      return {
        ...emptyState('locked', '后台已确认本机授权状态不可用，请重新联网激活或联系运营人员。', marker.code),
        customerName: envelope.payload.customer.name,
        maskedLicenseKey: maskLicenseKey(current.licenseKey),
        activationMode: envelope.payload.activation_mode,
        expiresAt: envelope.payload.expires_at,
        offlineValidUntil: envelope.payload.offline_valid_until,
      };
    }
    const evaluated = evaluateEnvelope({
      envelope,
      trustedSigningKeys: deps.trustedSigningKeys,
      machineCode,
      maxTrustedTime: current.maxTrustedTime,
    });
    return {
      state: evaluated.state,
      canUseApp: evaluated.state === 'valid',
      message: evaluated.message,
      customerName: envelope.payload.customer.name,
      maskedLicenseKey: maskLicenseKey(current.licenseKey),
      activationMode: envelope.payload.activation_mode,
      expiresAt: envelope.payload.expires_at,
      offlineValidUntil: envelope.payload.offline_valid_until,
      modules: evaluated.state === 'valid' ? evaluated.modules : [],
      lastErrorCode: marker?.code || '',
    };
  }

  async function publishState(): Promise<void> {
    await deps.onModulesChanged?.(state.canUseApp ? state.modules : []);
  }

  function getState(): LicenseStateSummary {
    if (container) {
      const previous = state;
      state = summaryFromContainer(container);
      if (previous.state !== state.state || JSON.stringify(previous.modules) !== JSON.stringify(state.modules)) {
        void publishState().catch(() => {});
      }
    }
    return state;
  }

  function maxIso(...values: Array<string | undefined>): string {
    const valid = values
      .filter((value): value is string => Boolean(value && Number.isFinite(Date.parse(value))))
      .sort((a, b) => Date.parse(b) - Date.parse(a));
    return valid[0] || new Date().toISOString();
  }

  async function initialize(): Promise<LicenseStateSummary> {
    if (!deps.apiOrigin) {
      state = emptyState('configuration-error', '正式软件尚未配置后台 API 地址。', 'API_ORIGIN_NOT_CONFIGURED');
      return state;
    }
    if (Object.keys(deps.trustedSigningKeys).length === 0) {
      state = emptyState('configuration-error', '正式软件尚未配置 License 验签公钥。', 'SIGNING_KEY_NOT_CONFIGURED');
      return state;
    }
    try {
      container = storage.load();
      state = container ? summaryFromContainer(container) : emptyState('unactivated', '请输入 License key 激活软件。');
    } catch (error) {
      state = emptyState(
        'configuration-error',
        error instanceof Error ? error.message : '系统安全存储不可用。',
        'SECURE_STORAGE_UNAVAILABLE',
      );
    }
    await publishState();

    // 联网自检：能联网的机器启动后校验后台状态，后台删除/解绑/吊销 License 时立即锁定。
    // 纯离线机器会 NETWORK_ERROR，静默跳过，不影响离线使用（仍受 offline_valid_until 约束）。
    if (container && state.state === 'valid') {
      void selfCheck();
    }
    return state;
  }

  async function selfCheck(): Promise<void> {
    if (!container || state.state !== 'valid') return;
    try {
      const response = await checkLicenseStatus(deps.apiOrigin, {
        license_id: container.envelope.payload.license_id,
        machine_code: machineCode,
      });
      if (!response.data.valid) {
        const error = new LicenseApiError(
          response.data.code || 'LICENSE_REVOKED',
          '后台已撤销本机授权，请重新联网激活或联系运营人员。',
          403,
          '',
          response.serverDate,
        );
        try {
          persistNegativeMarker(error);
          await publishState();
        } catch {}
      }
    } catch {
      // NETWORK_ERROR 等静默忽略：离线场景不误伤。
    }
  }

  function errorResult(error: unknown): LicenseActionResult {
    if (error instanceof LicenseApiError) {
      return { ok: false, state, code: error.code, message: error.message, requestId: error.requestId };
    }
    const message = error instanceof Error ? error.message : 'License 操作失败。';
    return { ok: false, state, code: 'CLIENT_ERROR', message };
  }

  function persistNegativeMarker(error: LicenseApiError): void {
    if (!container || !LOCKING_CODES.has(error.code)) return;
    const observedAt = Number.isFinite(Date.parse(error.serverDate))
      ? error.serverDate
      : container.maxTrustedTime || new Date().toISOString();
    const marker: NegativeMarker = {
      licenseId: container.envelope.payload.license_id,
      deviceId: container.envelope.payload.device_id,
      code: error.code,
      observedAt,
      envelopeIssuedAt: container.envelope.payload.issued_at,
    };
    container = { ...container, negativeMarker: marker, maxTrustedTime: maxIso(container.maxTrustedTime, observedAt) };
    storage.save(container);
    state = summaryFromContainer(container);
  }

  async function activate(licenseKey: string): Promise<LicenseActionResult> {
    try {
      const normalizedKey = licenseKey.trim().toUpperCase();
      const response = await activateOnline(deps.apiOrigin, {
        license_key: normalizedKey,
        machine_code: machineCode,
        device_name: os.hostname().slice(0, 120),
        client_version: deps.clientVersion,
        platform: 'pc',
      });
      const envelope = response.data.license;
      const evaluated = evaluateEnvelope({ envelope, trustedSigningKeys: deps.trustedSigningKeys, machineCode });
      if (evaluated.state !== 'valid') throw new Error(evaluated.message || '后台返回的 License 无效。');
      container = {
        schemaVersion: 1,
        licenseKey: normalizedKey,
        envelope,
        maxTrustedTime: maxIso(envelope.payload.issued_at, response.serverDate),
      };
      storage.save(container);
      state = summaryFromContainer(container);
      await publishState();
      return { ok: true, state };
    } catch (error) {
      return errorResult(error);
    }
  }

  async function refresh(): Promise<LicenseActionResult> {
    if (!container?.licenseKey) {
      return { ok: false, state, code: 'LICENSE_KEY_REQUIRED', message: '离线 License 没有在线刷新凭证，请输入 License key 转为在线激活。' };
    }
    try {
      const response = await refreshOnline(deps.apiOrigin, {
        license_key: container.licenseKey,
        machine_code: machineCode,
        device_name: os.hostname().slice(0, 120),
        client_version: deps.clientVersion,
        platform: 'pc',
      });
      const envelope = response.data.license;
      const evaluated = evaluateEnvelope({ envelope, trustedSigningKeys: deps.trustedSigningKeys, machineCode });
      if (evaluated.state !== 'valid') throw new Error(evaluated.message || '后台返回的 License 无效。');
      container = {
        schemaVersion: 1,
        licenseKey: container.licenseKey,
        envelope,
        maxTrustedTime: maxIso(container.maxTrustedTime, envelope.payload.issued_at, response.serverDate),
      };
      storage.save(container);
      state = summaryFromContainer(container);
      await publishState();
      return { ok: true, state };
    } catch (error) {
      if (error instanceof LicenseApiError) {
        try { persistNegativeMarker(error); await publishState(); } catch {}
      }
      return errorResult(error);
    }
  }

  async function importOffline(content: string): Promise<LicenseActionResult> {
    try {
      if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) throw new Error('离线 License 文件不能超过 1 MB。');
      const parsed = JSON.parse(content) as unknown;
      if (!isEnvelope(parsed)) throw new Error('离线 License 文件结构无效。');
      if (!verifyEnvelopeSignature(parsed, deps.trustedSigningKeys)) throw new Error('离线 License 签名无效或公钥不受信任。');
      if (
        container?.negativeMarker
        && container.negativeMarker.licenseId === parsed.payload.license_id
        && container.negativeMarker.deviceId === parsed.payload.device_id
        && Date.parse(parsed.payload.issued_at) <= Date.parse(container.negativeMarker.observedAt)
      ) {
        throw new Error('该离线 License 早于后台锁定时间，不能用于恢复授权。');
      }
      const evaluated = evaluateEnvelope({ envelope: parsed, trustedSigningKeys: deps.trustedSigningKeys, machineCode });
      if (evaluated.state !== 'valid') throw new Error(evaluated.message || '离线 License 无效。');
      container = {
        schemaVersion: 1,
        envelope: parsed,
        maxTrustedTime: maxIso(parsed.payload.issued_at),
      };
      storage.save(container);
      state = summaryFromContainer(container);
      await publishState();
      return { ok: true, state };
    } catch (error) {
      return errorResult(error);
    }
  }

  async function deactivate(): Promise<LicenseActionResult> {
    if (!container) {
      return { ok: false, state, code: 'LICENSE_KEY_REQUIRED', message: '本机没有可解绑的 License。' };
    }

    // 本机解绑不依赖联网：无论后台额度是否释放，本机都立即清除本地 License。
    // 有 licenseKey（在线激活）时尝试通知后台释放设备额度；离线 License 无 licenseKey，
    // 后台额度由运营在「激活设备」列表手动解绑兜底。
    let remoteReleased = false;
    if (container.licenseKey) {
      try {
        await deactivateOnline(deps.apiOrigin, { license_key: container.licenseKey, machine_code: machineCode });
        remoteReleased = true;
      } catch {
        remoteReleased = false;
      }
    }

    // 解绑后轮换机器码：旧的离线 License 内嵌的是旧 device_hash，机器码改变后
    // 无法再导入本机，防止同一份 .lic 反复解绑-重新激活。
    try {
      rotateMachineSeed(deps.userDataPath);
      machineCode = buildMachineCode(deps.userDataPath);
    } catch {
      // 轮换失败不阻塞解绑（机器码保持不变，仅失去「防旧 .lic 复用」的额外保护）。
    }

    storage.clear();
    container = null;
    state = emptyState(
      'unactivated',
      remoteReleased
        ? '本机已解绑，后台设备额度已释放。'
        : '本机已解绑。因无法联网或为离线 License，后台设备额度未自动释放，请由运营人员在后台「激活设备」中手动解绑该设备以释放额度。',
    );
    await publishState();
    return { ok: true, state };
  }

  async function checkUpdate(channel: 'stable' | 'beta' = 'stable'): Promise<UpdateCheckResult> {
    try {
      const response = await checkLatestRelease(deps.apiOrigin, {
        currentVersion: deps.clientVersion,
        machineHash: hashMachineCode(machineCode),
        channel,
        architecture: process.arch === 'arm64' ? 'arm64' : 'x64',
      });
      return {
        ok: true,
        updateAvailable: response.data.update_available,
        forceUpdate: Boolean(response.data.force_update),
        release: response.data.release,
      };
    } catch (error) {
      const apiError = error instanceof LicenseApiError ? error : null;
      return { ok: false, code: apiError?.code || 'CLIENT_ERROR', message: apiError?.message || '检查更新失败。', requestId: apiError?.requestId };
    }
  }

  async function getTestTools(): Promise<TestToolListResult> {
    try {
      const response = await listTestTools(deps.apiOrigin);
      return { ok: true, tools: response.data };
    } catch (error) {
      const apiError = error instanceof LicenseApiError ? error : null;
      return { ok: false, code: apiError?.code || 'CLIENT_ERROR', message: apiError?.message || '获取测试工具失败。', requestId: apiError?.requestId };
    }
  }

  async function fetchSoftdogPassword(deviceModel: string): Promise<{
    ok: boolean;
    configured?: boolean;
    password?: string;
  }> {
    if (!deps.apiOrigin || !container?.licenseKey) {
      return { ok: false };
    }
    try {
      const response = await fetchSoftdogPasswordApi(deps.apiOrigin, {
        license_key: container.licenseKey,
        machine_code: machineCode,
        device_model: deviceModel,
      });
      return {
        ok: true,
        configured: response.data.configured,
        password: response.data.password ?? undefined,
      };
    } catch {
      return { ok: false };
    }
  }

  return {
    initialize,
    getState,
    getMachineCode: () => machineCode,
    getMachineHash: () => hashMachineCode(machineCode),
    hasModule: (code: string) => {
      const current = getState();
      return current.canUseApp && current.modules.some((module) => module.code === code);
    },
    activate,
    refresh,
    importOffline,
    deactivate,
    checkUpdate,
    getTestTools,
    fetchSoftdogPassword,
  };
}

export type LicenseService = ReturnType<typeof createLicenseService>;
