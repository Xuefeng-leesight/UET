import Switch from '@/shared/ui/Switch';
import React from 'react';

interface FacialSettingToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  description: string;
  disabled?: boolean;
}

const FacialSettingToggle: React.FC<FacialSettingToggleProps> = ({
  checked,
  onChange,
  title,
  description,
  disabled = false,
}) => (
  <div className="flex items-center justify-between gap-3 py-2">
    <div className="min-w-0">
      <div className="text-[11px] font-bold text-slate-700">{title}</div>
      <div className="mt-0.5 text-[9px] leading-4 text-slate-400">{description}</div>
    </div>
    <Switch
      checked={checked}
      aria-label={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  </div>
);

export default FacialSettingToggle;
