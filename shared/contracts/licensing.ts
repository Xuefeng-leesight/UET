export type LicenseModuleCode = 'eye_tracking' | 'facial_analysis' | string;

export type LicenseModuleGrant = {
  code: LicenseModuleCode;
  name: string;
  expires_at: string;
};

export type LicenseEnvelope = {
  schema_version: 1;
  algorithm: 'Ed25519';
  key_id: string;
  payload: {
    license_id: string;
    customer: { id: string; name: string };
    device_id: string;
    device_hash: string;
    activation_mode: 'online' | 'offline';
    issued_at: string;
    not_before: string;
    expires_at: string;
    offline_grace_days: number;
    offline_valid_until: string;
    modules: LicenseModuleGrant[];
  };
  signature: string;
};

export type LicenseStateCode =
  | 'loading'
  | 'unactivated'
  | 'valid'
  | 'not-started'
  | 'offline-expired'
  | 'expired'
  | 'device-mismatch'
  | 'invalid-signature'
  | 'clock-rollback'
  | 'locked'
  | 'configuration-error';

export type LicenseStateSummary = {
  state: LicenseStateCode;
  canUseApp: boolean;
  message: string;
  customerName: string;
  maskedLicenseKey: string;
  activationMode: 'online' | 'offline' | null;
  expiresAt: string | null;
  offlineValidUntil: string | null;
  modules: LicenseModuleGrant[];
  lastErrorCode: string;
};

export type LicenseActionResult =
  | { ok: true; state: LicenseStateSummary }
  | { ok: false; state: LicenseStateSummary; code: string; message: string; requestId?: string };

export type ReleaseInfo = {
  version: string;
  product_type: 'pc' | 'android';
  platform: string;
  architecture: string;
  channel: 'stable' | 'beta';
  changelog: string;
  published_at: string;
  file_sha256: string;
  file_size: number;
  download_url: string;
};

export type UpdateCheckResult =
  | { ok: true; updateAvailable: boolean; forceUpdate: boolean; release: ReleaseInfo | null }
  | { ok: false; code: string; message: string; requestId?: string };

export type TestToolInfo = {
  id: string;
  name: string;
  version: string;
  platform: string;
  description: string;
  file_sha256: string;
  file_size: number;
  download_url: string;
  updated_at: string;
};

export type TestToolListResult =
  | { ok: true; tools: TestToolInfo[] }
  | { ok: false; code: string; message: string; requestId?: string };
