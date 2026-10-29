import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import type { LicenseEnvelope, LicenseModuleGrant, LicenseStateCode } from '../../../shared/contracts/licensing';

function b64urlDecode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('License payload contains an unsupported JSON value.');
}

export function normalizeMachineCode(value: string): string {
  return value.trim().toUpperCase().split(/\s+/).join(' ');
}

export function hashMachineCode(value: string): string {
  return createHash('sha256').update(normalizeMachineCode(value), 'utf8').digest('hex');
}

export function verifyEnvelopeSignature(
  envelope: LicenseEnvelope,
  trustedSigningKeys: Record<string, string>,
): boolean {
  if (envelope.schema_version !== 1 || envelope.algorithm !== 'Ed25519') return false;
  const publicKey = trustedSigningKeys[envelope.key_id];
  if (!publicKey) return false;
  try {
    const rawKey = b64urlDecode(publicKey);
    if (rawKey.length !== 32) return false;
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const key = createPublicKey({ key: Buffer.concat([spkiPrefix, rawKey]), format: 'der', type: 'spki' });
    return verify(
      null,
      Buffer.from(canonicalJson(envelope.payload), 'utf8'),
      key,
      b64urlDecode(envelope.signature),
    );
  } catch {
    return false;
  }
}

export function constantTimeHexEqual(left: string, right: string): boolean {
  try {
    const a = Buffer.from(left, 'hex');
    const b = Buffer.from(right, 'hex');
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function evaluateEnvelope(params: {
  envelope: LicenseEnvelope;
  trustedSigningKeys: Record<string, string>;
  machineCode: string;
  maxTrustedTime?: string;
  now?: Date;
}): {
  state: LicenseStateCode;
  message: string;
  modules: LicenseModuleGrant[];
} {
  const { envelope } = params;
  if (!verifyEnvelopeSignature(envelope, params.trustedSigningKeys)) {
    return { state: 'invalid-signature', message: 'License 签名无效或签名公钥不受信任。', modules: [] };
  }
  if (!constantTimeHexEqual(envelope.payload.device_hash, hashMachineCode(params.machineCode))) {
    return { state: 'device-mismatch', message: '此 License 不属于当前电脑。', modules: [] };
  }
  const now = params.now || new Date();
  const nowMs = now.getTime();
  const maxTrustedMs = params.maxTrustedTime ? Date.parse(params.maxTrustedTime) : Number.NaN;
  if (Number.isFinite(maxTrustedMs) && nowMs + 5 * 60_000 < maxTrustedMs) {
    return { state: 'clock-rollback', message: '检测到系统时间明显回拨，请联网刷新授权。', modules: [] };
  }
  const notBefore = Date.parse(envelope.payload.not_before);
  const expiresAt = Date.parse(envelope.payload.expires_at);
  const offlineUntil = Date.parse(envelope.payload.offline_valid_until);
  if (![notBefore, expiresAt, offlineUntil].every(Number.isFinite)) {
    return { state: 'invalid-signature', message: 'License 时间字段无效。', modules: [] };
  }
  if (nowMs < notBefore) return { state: 'not-started', message: 'License 尚未生效。', modules: [] };
  if (nowMs >= expiresAt) return { state: 'expired', message: 'License 已过期。', modules: [] };
  if (nowMs >= offlineUntil) {
    return { state: 'offline-expired', message: '离线使用期限已到，请联网刷新授权。', modules: [] };
  }
  const modules = envelope.payload.modules.filter((item) => Date.parse(item.expires_at) > nowMs);
  if (modules.length === 0) return { state: 'locked', message: 'License 没有可用的产品模块。', modules: [] };
  return { state: 'valid', message: '', modules };
}
