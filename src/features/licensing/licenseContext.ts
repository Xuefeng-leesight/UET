import React from 'react';
import type { LicenseStateSummary, UpdateCheckResult } from '@shared/contracts/licensing';
import { ENABLE_LICENSE_AUTHORIZATION } from '@/app/config';

export const LicenseStateContext = React.createContext<LicenseStateSummary | null>(null);

export type LicenseManagementContextValue = {
  state: LicenseStateSummary;
  busy: boolean;
  feedback: string;
  update: UpdateCheckResult | null;
  updateBusy: boolean;
  refresh: () => void;
  deactivate: () => void;
  checkUpdate: () => void;
  installUpdate: () => void;
};

export const LicenseManagementContext = React.createContext<LicenseManagementContextValue | null>(null);

export function useLicenseState(): LicenseStateSummary | null {
  return React.useContext(LicenseStateContext);
}

export function useLicenseManagement(): LicenseManagementContextValue | null {
  return React.useContext(LicenseManagementContext);
}

export function isLicenseModuleAuthorized(
  state: LicenseStateSummary | null,
  moduleCode: string,
): boolean {
  return !ENABLE_LICENSE_AUTHORIZATION
    || Boolean(state?.canUseApp && state.modules.some((module) => module.code === moduleCode));
}

/**
 * 模块对应的 License 授权码；返回 null 表示不校验授权。
 * 行为、脑电、生理、近红外、手指轨迹尚未约定授权码，开放前须在此补上，否则开放后无需授权即可使用。
 */
export function moduleForModality(modality: string): 'eye_tracking' | 'facial_analysis' | null {
  if (modality === 'eye-tracking') return 'eye_tracking';
  if (modality === 'facial-expression') return 'facial_analysis';
  return null;
}
