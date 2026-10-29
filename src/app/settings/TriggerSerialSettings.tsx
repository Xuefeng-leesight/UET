import React, { useEffect, useRef, useState } from 'react';
import type { SerialPortDescription, SerialTriggerOptions } from '@shared/contracts/ipc/communication';
import type { TriggerConfig } from '@/shared/types/mrt';
import { ipcClient } from '@/infrastructure/electron/ipcClient';
import CustomSelect from '@/shared/ui/CustomSelect';
import { btnGhost } from '@/shared/ui/buttonClasses';

const inputClass = 'w-full min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs outline-none';

export function TriggerSerialSettings({ config, onChange, isEn }: {
  config: TriggerConfig;
  onChange: <K extends keyof TriggerConfig>(key: K, value: TriggerConfig[K]) => void;
  isEn: boolean;
}) {
  const [ports, setPorts] = useState<SerialPortDescription[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(0);
  const refresh = async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      const result = await ipcClient.listSerialPorts();
      if (id !== requestId.current) return;
      if (result.ok === false) throw new Error(result.message);
      setPorts(result.ports);
    } catch (failure) {
      if (id === requestId.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally { if (id === requestId.current) setLoading(false); }
  };
  useEffect(() => {
    if (config.serialEnabled) void refresh();
    return () => { requestId.current += 1; };
  }, [config.serialEnabled]);

  const label = (cn: string, en: string) => isEn ? en : cn;
  return <section className="space-y-3 rounded-lg bg-slate-50 p-3" aria-label={label('串口通信设置', 'Serial communication settings')}>
    <label className="flex items-center justify-between gap-4 text-sm font-bold text-slate-800">
      {label('启用串口收发', 'Enable serial communication')}
      <input type="checkbox" checked={config.serialEnabled === true} className="h-4 w-4 shrink-0"
        onChange={event => onChange('serialEnabled', event.target.checked)} />
    </label>
    <p className="text-xs leading-relaxed text-slate-500">
      {label('Pupil Core 录制期间保存实际串口收发。刺激物触发标记按 UTF-8 十进制文本发送，不附加换行；端口参数应与外部设备一致。',
        'Records actual serial I/O during Pupil Core recording. Stimulus triggers send decimal UTF-8 text without a line ending. Match the port settings to your external device.')}
    </p>
    {config.serialEnabled && <>
      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1 space-y-1.5 text-xs font-bold text-slate-600">
          <span>{label('已发现端口', 'Detected ports')}</span>
          <CustomSelect value={ports.some(port => port.path === config.serialPath) ? config.serialPath : ''}
            aria-label={label('选择串口', 'Select serial port')} className="w-full text-xs"
            onChange={event => { if (event.target.value) onChange('serialPath', event.target.value); }} disabled={loading}>
            <option value="">{loading ? label('正在读取…', 'Loading…') : label('选择端口或在下方填写', 'Select a port or enter it below')}</option>
            {ports.map(port => <option key={port.path} value={port.path}>{port.path}{port.manufacturer ? ` · ${port.manufacturer}` : ''}</option>)}
          </CustomSelect>
        </label>
        <button type="button" className={`${btnGhost} shrink-0 px-3 py-2 text-xs`} onClick={() => void refresh()} disabled={loading}>
          {label('刷新', 'Refresh')}
        </button>
      </div>
      {error && <p role="alert" className="break-words text-xs text-rose-600">{error}</p>}
      {!loading && !error && ports.length === 0 && <p className="text-xs text-slate-500">{label('未发现串口，可填写已知端口路径。', 'No ports detected. You can enter a known port path.')}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-xs font-bold text-slate-600">
          <span>{label('端口路径', 'Port path')}</span>
          <input className={inputClass} value={config.serialPath || ''} placeholder="COM3 / /dev/cu.usbserial"
            onChange={event => onChange('serialPath', event.target.value)} />
        </label>
        <label className="space-y-1.5 text-xs font-bold text-slate-600">
          <span>{label('波特率', 'Baud rate')}</span>
          <input type="number" min={1} max={4_000_000} step={1} className={`${inputClass} mrt-number`}
            value={config.serialBaudRate ?? 115200} onChange={event => onChange('serialBaudRate', Number(event.target.value))} />
        </label>
        <label className="space-y-1.5 text-xs font-bold text-slate-600">
          <span>{label('数据位', 'Data bits')}</span>
          <CustomSelect aria-label={label('数据位', 'Data bits')} value={config.serialDataBits ?? 8} className="text-xs"
            onChange={event => onChange('serialDataBits', Number(event.target.value) as SerialTriggerOptions['serialDataBits'])}>
            {[5, 6, 7, 8].map(value => <option key={value} value={value}>{value}</option>)}
          </CustomSelect>
        </label>
        <label className="space-y-1.5 text-xs font-bold text-slate-600">
          <span>{label('停止位', 'Stop bits')}</span>
          <CustomSelect aria-label={label('停止位', 'Stop bits')} value={config.serialStopBits ?? 1} className="text-xs"
            onChange={event => onChange('serialStopBits', Number(event.target.value) as SerialTriggerOptions['serialStopBits'])}>
            {[1, 1.5, 2].map(value => <option key={value} value={value}>{value}</option>)}
          </CustomSelect>
        </label>
        <label className="space-y-1.5 text-xs font-bold text-slate-600 sm:col-span-2">
          <span>{label('校验位', 'Parity')}</span>
          <CustomSelect aria-label={label('校验位', 'Parity')} value={config.serialParity ?? 'none'} className="text-xs"
            onChange={event => onChange('serialParity', event.target.value as SerialTriggerOptions['serialParity'])}>
            <option value="none">{label('无', 'None')}</option><option value="even">{label('偶校验', 'Even')}</option>
            <option value="odd">{label('奇校验', 'Odd')}</option><option value="mark">Mark</option><option value="space">Space</option>
          </CustomSelect>
        </label>
      </div>
    </>}
  </section>;
}
