import { safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { LicenseEnvelope } from '../../../shared/contracts/licensing';

export type NegativeMarker = {
  licenseId: string;
  deviceId: string;
  code: string;
  observedAt: string;
  envelopeIssuedAt: string;
};

export type StoredLicenseContainer = {
  schemaVersion: 1;
  licenseKey?: string;
  envelope: LicenseEnvelope;
  maxTrustedTime: string;
  negativeMarker?: NegativeMarker;
};

export function createLicenseStorage(userDataPath: string) {
  const directory = path.join(userDataPath, 'licensing');
  const filePath = path.join(directory, 'license.bin');

  function ensureAvailable(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用，License 不会以明文保存。');
    }
  }

  function load(): StoredLicenseContainer | null {
    ensureAvailable();
    try {
      const parsed = JSON.parse(safeStorage.decryptString(fs.readFileSync(filePath))) as StoredLicenseContainer;
      return parsed?.schemaVersion === 1 && parsed.envelope ? parsed : null;
    } catch {
      return null;
    }
  }

  function save(container: StoredLicenseContainer): void {
    ensureAvailable();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    const encrypted = safeStorage.encryptString(JSON.stringify(container));
    fs.writeFileSync(temporaryPath, encrypted, { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  }

  function clear(): void {
    try { fs.unlinkSync(filePath); } catch {}
  }

  return { load, save, clear };
}
