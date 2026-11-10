import { RefreshCw } from 'lucide-react';
import CustomSelect from '@/shared/ui/CustomSelect';

import FacialSettingToggle from '@/features/recording/domain/FacialSettingToggle';
import type { FacialSessionStatus } from '@/features/recording/domain/recordingContracts';
import type { FacialRecordingSettings } from '@/features/recording/domain/recordingModules';

export type RecordingFacialCamera = {
  id: string;
  index: number;
  name: string;
  width: number;
  height: number;
};

type RecordingFacialPanelProps = {
  cameraId: string;
  cameras: RecordingFacialCamera[];
  isCapturing: boolean;
  captureNotice: string;
  sessionStatus: FacialSessionStatus | null;
  settings?: FacialRecordingSettings;
  onRefreshCameras?: () => void;
  onCameraChange?: (cameraId: string) => void;
  onSettingsChange?: (patch: Partial<FacialRecordingSettings>) => void;
};

const SETTING_TOGGLES: Array<{
  key: keyof Pick<FacialRecordingSettings, 'enabled' | 'showFaceBox' | 'showFaceMask' | 'showConfidence'>;
  label: string;
  hint: string;
}> = [
  { key: 'enabled', label: '参与同步录制', hint: '关闭后仅保留实时预览' },
  { key: 'showFaceBox', label: '显示 Box 框', hint: '标出当前检测到的人脸范围' },
  { key: 'showFaceMask', label: '显示人脸 Mask', hint: '用半透明轮廓覆盖人脸区域' },
  { key: 'showConfidence', label: '实时表情置信度', hint: '显示每类基础表情的实时分数' },
];

export function RecordingFacialPanel({
  cameraId,
  cameras,
  isCapturing,
  captureNotice,
  sessionStatus,
  settings,
  onRefreshCameras,
  onCameraChange,
  onSettingsChange,
}: RecordingFacialPanelProps) {
  const requestedWidth = settings?.width || 1280;
  const requestedHeight = settings?.height || 720;
  const actualSizeMatches = sessionStatus?.actual?.width === settings?.width
    && sessionStatus?.actual?.height === settings?.height;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="text-[10px] font-bold tracking-tighter text-slate-400">表情摄像头</div>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <CustomSelect
              aria-label="表情摄像头"
              portalMenu
              value={cameraId}
              onChange={(event) => onCameraChange?.(event.target.value)}
              className="rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 outline-none"
              disabled={cameras.length === 0 || isCapturing}
            >
              <option value="">{cameras.length === 0 ? '请刷新摄像头' : '选择摄像头'}</option>
              {cameras.map((camera) => (
                <option key={camera.id} value={camera.id}>
                  {camera.name} · {camera.width}×{camera.height}
                </option>
              ))}
            </CustomSelect>
          </div>
          <button
            type="button"
            onClick={onRefreshCameras}
            disabled={isCapturing}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-slate-200 text-slate-500 hover:bg-slate-50"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-[10px] font-bold tracking-tighter text-slate-400">采集状态</div>
        <div className={`flex items-center gap-2 rounded border p-2 ${isCapturing ? 'border-emerald-200 bg-emerald-50' : 'border-slate-100 bg-slate-50'}`}>
          <span className={`h-2 w-2 rounded-full ${isCapturing ? 'animate-pulse bg-emerald-500' : 'bg-slate-300'}`} />
          <span className="text-[11px] font-medium text-slate-600">{isCapturing ? '● 同步录制中' : '待机'}</span>
        </div>
      </div>

      <div className="space-y-2 border-t border-slate-100 pt-4">
        <div className="text-[10px] font-bold tracking-tighter text-slate-400">采集参数</div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-600">
          <div className="flex items-center justify-between"><span>录制分辨率</span><strong className="font-mono text-slate-800">{requestedWidth} × {requestedHeight}</strong></div>
          <div className="mt-2 flex items-center justify-between"><span>录制帧率</span><strong className="font-mono text-slate-800">{settings?.fps || 30} FPS</strong></div>
          <div className="mt-2 flex items-center justify-between"><span>实际画面</span><strong className={`font-mono ${actualSizeMatches ? 'text-emerald-700' : 'text-slate-900'}`}>{sessionStatus?.actual?.width ? `${sessionStatus.actual.width} × ${sessionStatus.actual.height}` : '等待设备'}</strong></div>
          <div className="mt-2 flex items-center justify-between"><span>实测帧率</span><strong className="font-mono text-slate-800">{sessionStatus?.actual?.fps ? `${Number(sessionStatus.actual.fps).toFixed(1)} FPS` : '—'}</strong></div>
          <div className="mt-2 flex items-center justify-between"><span>检测引擎</span><strong className={sessionStatus?.inferenceReady ? 'text-emerald-700' : 'text-slate-900'}>{sessionStatus?.inferenceReady ? '已就绪' : '等待中'}</strong></div>
        </div>
        {SETTING_TOGGLES.map(({ key, label, hint }) => (
          <FacialSettingToggle
            key={key}
            checked={Boolean(settings?.[key])}
            onChange={(checked) => onSettingsChange?.({ [key]: checked })}
            title={label}
            description={hint}
          />
        ))}
      </div>

      {captureNotice && (
        <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] leading-4 text-amber-700">{captureNotice}</div>
      )}
    </div>
  );
}
