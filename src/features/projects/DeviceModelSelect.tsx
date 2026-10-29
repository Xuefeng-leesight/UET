import React from 'react';
import { useLanguage } from '@/app/i18n/useLanguage';
import { EN_TERM_MAP } from '@/app/i18n/i18nConfig';
import CustomSelect from '@/shared/ui/CustomSelect';
import { normalizeDeviceModel, type DeviceModel } from '@/features/recording/device/deviceProfile';

/** Every supported eye tracker in one list, regardless of manufacturer. */
const MODELS = [
  { id: 'Pro', label: 'Pro（桌面式）' },
  { id: 'A8', label: 'A8（桌面式）' },
  { id: 'aSeeGlassesPlus', label: 'aSeeGlassesPlus（眼镜式）' },
  { id: 'HH_ET10C', label: 'ET10C（桌面式）' },
  { id: 'HH_ET28', label: 'ET28（眼镜式）' },
  { id: 'PupilCore', label: 'Pupil Core' },
] satisfies Array<{ id: DeviceModel; label: string }>;

/** Only the model is persisted, so historical projects need no migration. */
export default function DeviceModelSelect({ value, deviceType, onChange, className, menuClassName }: {
  value: unknown;
  deviceType?: unknown;
  onChange: (model: DeviceModel) => void;
  className?: string;
  menuClassName?: string;
}) {
  const { language } = useLanguage();
  const text = (label: string) => language === 'en-US' ? EN_TERM_MAP[label] ?? label : label;
  const model = normalizeDeviceModel(value, deviceType);
  return (
    <div className="min-w-0" data-i18n-skip="true">
      <CustomSelect
        value={model}
        onChange={(event) => {
          const next = MODELS.find((item) => item.id === event.target.value);
          if (next) onChange(next.id);
        }}
        className={className}
        menuClassName={menuClassName}
        aria-label={text('眼动仪型号')}
        portalMenu
      >
        {MODELS.map((item) => <option key={item.id} value={item.id}>{text(item.label)}</option>)}
        <option value="asee-pro-plus" disabled>{text('aSee Pro plus（暂未接入）')}</option>
        <option value="pupil-neon" disabled>{text('Pupil Neon（暂未接入）')}</option>
        <option value="tobii" disabled>{text('Tobii（暂未接入）')}</option>
      </CustomSelect>
    </div>
  );
}
