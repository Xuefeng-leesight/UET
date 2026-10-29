import type React from 'react';
import { getDeviceProfile, normalizeDeviceModel, normalizeSdkResolution, type DeviceModel } from '@/features/recording/device/deviceProfile';
import { sendCmdWithResponse, startDeviceCommand, stopDeviceCommand } from '@/features/recording/domain/recordingWsModule';

type WsCmdRef = { current: WebSocket | null };
type DeviceType = '桌面式' | '眼镜式';
type GlassesEnvironment = 301 | 302 | 303;

export type CameraCommandResult = {
  ok: boolean;
  error?: string;
  trackingError?: string;
};

const parseGlassesEnvironment = (value: unknown): GlassesEnvironment => {
  const n = Number(value);
  if (n === 302 || n === 303) return n;
  return 301;
};

const buildStartArgs = (
  deviceType?: DeviceType,
  deviceModel?: DeviceModel,
  options?: {
    sdkEnvironment?: unknown;
    sdkResolution?: unknown;
  },
) => {
  // window.screen.width 返回 CSS 像素（DIP），其定义即 1 CSS 像素 = 1/96 英寸。
  // 物理尺寸(mm) = CSS 像素 ÷ 96 × 25.4，与 devicePixelRatio 无关：dpr 在
  // 「CSS像素→物理像素」与「逻辑DPI→物理DPI」两步中相互抵消，不应参与换算。
  // 此前除以 dpr 两次导致结果缩小 dpr² 倍（150% 缩放下 2560px 屏被算成 ~200mm）。
  const viewportWidth = (window.screen.width / 96) * 25.4;
  const viewportHeight = (window.screen.height / 96) * 25.4;
  const isGlasses = deviceType === '眼镜式';
  const sdkEnvironment = isGlasses ? parseGlassesEnvironment(options?.sdkEnvironment) : 301;
  const profile = getDeviceProfile(deviceType, deviceModel);
  const sdkResolution = profile.fixedSdkResolution
    ?? (isGlasses ? normalizeSdkResolution(options?.sdkResolution, profile) : 201);
  return {
    viewport_width: viewportWidth,
    viewport_height: viewportHeight,
    check_calib: 1,
    detect_eyelid: 0,
    smooth_way: 0,
    device_type: deviceType || '桌面式',
    sdk_model: normalizeDeviceModel(deviceModel, deviceType),
    sdk_environment: sdkEnvironment,
    sdk_resolution: sdkResolution,
    sdk_gyroscope: isGlasses ? 1 : 0,
  };
};

const expectedModelByDeviceType = (deviceType?: DeviceType, deviceModel?: DeviceModel): DeviceModel =>
  normalizeDeviceModel(deviceModel, deviceType);

export async function stopCamera(params: {
  wsCmdRef: WsCmdRef;
  setIsCameraOn: React.Dispatch<React.SetStateAction<boolean>>;
  timeoutMs?: number;
}): Promise<CameraCommandResult> {
  const { wsCmdRef, setIsCameraOn, timeoutMs = 3000 } = params;
  const stopRsp = await stopDeviceCommand({ wsCmdRef, timeoutMs });
  if (!stopRsp.ok) {
    return { ok: false, error: stopRsp.error || '停止设备失败' };
  }
  setIsCameraOn(false);
  return { ok: true };
}

export async function startCamera(params: {
  wsCmdRef: WsCmdRef;
  setIsCameraOn: React.Dispatch<React.SetStateAction<boolean>>;
  deviceType?: DeviceType;
  deviceModel?: DeviceModel;
  sdkEnvironment?: unknown;
  sdkResolution?: unknown;
  calibrationCoe?: string | null;
  timeoutMs?: number;
  trackingTimeoutMs?: number;
}): Promise<CameraCommandResult> {
  const {
    wsCmdRef,
    setIsCameraOn,
    deviceType,
    deviceModel,
    sdkEnvironment,
    sdkResolution,
    calibrationCoe,
    timeoutMs = 3000,
    trackingTimeoutMs = 2000,
  } = params;
  const isGlasses = deviceType === '眼镜式';

  // UI state can be reset by project/experiment switches while the SDK process is
  // still finishing a previous start/recording command. Clear any stale backend
  // session before issuing a fresh start so the next start does not hang behind it.
  try {
    await stopDeviceCommand({ wsCmdRef, timeoutMs: isGlasses ? 5000 : 1200 });
  } catch {
  }

  const startArgs = buildStartArgs(deviceType, deviceModel, { sdkEnvironment, sdkResolution });
  console.log('[cameraModule] start args', startArgs);
  const startRsp = await startDeviceCommand({ wsCmdRef, args: startArgs, timeoutMs });
  console.log('[cameraModule] start rsp', startRsp.response || startRsp);
  if (!startRsp.ok) {
    try {
      await stopDeviceCommand({ wsCmdRef, timeoutMs: 1500 });
    } catch {
    }
    setIsCameraOn(false);
    return { ok: false, error: startRsp.error || '启动设备失败' };
  }
  try {
    const expectedModel = expectedModelByDeviceType(deviceType, deviceModel);
    const resolvedModel = String(startRsp?.response?.model || '').trim();
    if (resolvedModel && resolvedModel !== expectedModel) {
      try {
        await stopDeviceCommand({ wsCmdRef, timeoutMs: 3000 });
      } catch {
      }
      setIsCameraOn(false);
      return {
        ok: false,
        error: `设备类型与SDK型号不一致：期望 ${expectedModel}，实际 ${resolvedModel}`,
      };
    }
  } catch {
  }

  setIsCameraOn(true);
  // Capture calibration receipts are scoped to the current connection only.
  if (['PupilCore', 'HH_ET10C', 'HH_ET28'].includes(deviceModel || '')) return { ok: true };
  const coe = typeof calibrationCoe === 'string' ? calibrationCoe.trim() : '';
  if (!coe) {
    return { ok: true };
  }

  console.log('[cameraModule] restore tracking', { deviceType, coeLen: coe.length });
  const trackingRsp = await sendCmdWithResponse({
    wsCmdRef,
    id: 'start_tracking',
    args: { coe },
    timeoutMs: trackingTimeoutMs,
  });
  console.log('[cameraModule] restore tracking rsp', trackingRsp.response || trackingRsp);
  if (!trackingRsp.ok) {
    if (deviceType === '眼镜式') {
      try {
        await stopDeviceCommand({ wsCmdRef, timeoutMs: 3000 });
      } catch {
      }
      setIsCameraOn(false);
      return { ok: false, error: trackingRsp.error || '启动眼镜式追踪失败' };
    }
    return { ok: true, trackingError: trackingRsp.error || '恢复校准结果失败' };
  }
  return { ok: true };
}

export async function toggleCamera(params: {
  isCameraOn: boolean;
  wsCmdRef: WsCmdRef;
  setIsCameraOn: React.Dispatch<React.SetStateAction<boolean>>;
  deviceType?: DeviceType;
  deviceModel?: DeviceModel;
  sdkEnvironment?: unknown;
  sdkResolution?: unknown;
  calibrationCoe?: string | null;
  timeoutMs?: number;
  trackingTimeoutMs?: number;
}): Promise<CameraCommandResult> {
  const { isCameraOn, wsCmdRef, setIsCameraOn, deviceType, deviceModel, sdkEnvironment, sdkResolution, calibrationCoe, timeoutMs, trackingTimeoutMs } = params;
  if (isCameraOn) {
    return stopCamera({ wsCmdRef, setIsCameraOn, timeoutMs });
  }
  return startCamera({ wsCmdRef, setIsCameraOn, deviceType, deviceModel, sdkEnvironment, sdkResolution, calibrationCoe, timeoutMs, trackingTimeoutMs });
}
