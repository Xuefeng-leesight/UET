import { randomUUID } from 'node:crypto';
import type { LicenseEnvelope, ReleaseInfo, TestToolInfo } from '../../../shared/contracts/licensing';

export class LicenseApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly requestId = '',
    public readonly serverDate = '',
  ) {
    super(message);
    this.name = 'LicenseApiError';
  }
}

type ErrorBody = {
  error?: { code?: unknown; message?: unknown; request_id?: unknown };
};

async function requestJson<T>(
  apiOrigin: string,
  pathname: string,
  init: RequestInit = {},
): Promise<{ data: T; serverDate: string }> {
  if (!apiOrigin) {
    throw new LicenseApiError('CLIENT_NOT_CONFIGURED', '正式软件尚未配置后台服务地址。', 0);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const requestId = randomUUID();
  try {
    const response = await fetch(`${apiOrigin}${pathname}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'X-Request-ID': requestId,
        ...init.headers,
      },
    });
    const serverDate = response.headers.get('date') || '';
    const body = await response.json().catch(() => ({})) as T & ErrorBody;
    if (!response.ok) {
      const error = body.error || {};
      throw new LicenseApiError(
        typeof error.code === 'string' ? error.code : `HTTP_${response.status}`,
        typeof error.message === 'string' ? error.message : '后台请求失败。',
        response.status,
        typeof error.request_id === 'string' ? error.request_id : requestId,
        serverDate,
      );
    }
    return { data: body as T, serverDate };
  } catch (error) {
    if (error instanceof LicenseApiError) throw error;
    const message = error instanceof Error && error.name === 'AbortError'
      ? '连接后台超时。'
      : '无法连接后台服务。';
    throw new LicenseApiError('NETWORK_ERROR', message, 0, requestId);
  } finally {
    clearTimeout(timeout);
  }
}

export function activateOnline(apiOrigin: string, payload: {
  license_key: string;
  machine_code: string;
  device_name: string;
  client_version: string;
  platform?: string;
}) {
  return requestJson<{ activation_id: string; created: boolean; license: LicenseEnvelope }>(
    apiOrigin,
    '/api/v1/client/activations',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    },
  );
}

export function refreshOnline(apiOrigin: string, payload: {
  license_key: string;
  machine_code: string;
  device_name: string;
  client_version: string;
  platform?: string;
}) {
  return requestJson<{ valid: true; activation_id: string; license: LicenseEnvelope }>(
    apiOrigin,
    '/api/v1/client/licenses/verify',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    },
  );
}

export function deactivateOnline(apiOrigin: string, payload: {
  license_key: string;
  machine_code: string;
}) {
  return requestJson<{ deactivated: true; activation_id: string }>(
    apiOrigin,
    '/api/v1/client/activations/deactivate',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    },
  );
}

export function checkLicenseStatus(apiOrigin: string, payload: {
  license_id: string;
  machine_code: string;
}) {
  return requestJson<{ valid: boolean; code: string }>(
    apiOrigin,
    '/api/v1/client/licenses/check',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    },
  );
}

export async function checkLatestRelease(apiOrigin: string, query: {
  currentVersion: string;
  machineHash: string;
  channel: 'stable' | 'beta';
  architecture: string;
}) {
  const params = new URLSearchParams({
    product_type: 'pc',
    platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    architecture: query.architecture,
    channel: query.channel,
    current_version: query.currentVersion,
    machine_hash: query.machineHash,
  });
  return requestJson<{
    update_available: boolean;
    force_update?: boolean;
    release: ReleaseInfo | null;
  }>(apiOrigin, `/api/v1/client/releases/latest?${params}`);
}

export async function listTestTools(apiOrigin: string) {
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  return requestJson<TestToolInfo[]>(apiOrigin, `/api/v1/client/test-tools?platform=${platform}`);
}

export function fetchSoftdogPassword(apiOrigin: string, payload: {
  license_key: string;
  machine_code: string;
  device_model: string;
  serial_number?: string;
}) {
  return requestJson<{ configured: boolean; password: string | null }>(
    apiOrigin,
    '/api/v1/client/devices/softdog-password',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    },
  );
}
