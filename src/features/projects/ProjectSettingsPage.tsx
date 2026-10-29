import { SwitchVisual } from '@/shared/ui/Switch';
import React from 'react';
import { ChevronDown, Download, FileText, Save, Trash2 } from 'lucide-react';
import type { Experiment, ModalityId, Project } from '@shared/contracts/domain/models';
import CustomSelect from '@/shared/ui/CustomSelect';
import AutoResizeTextarea from '@/shared/ui/AutoResizeTextarea';
import { btnDanger, btnPrimary, btnSecondary } from '@/shared/ui/buttonClasses';
import DeviceModelSelect from './DeviceModelSelect';
import { normalizeProjectModalities } from '@shared/domain/projectModalities';
import { MODALITY_REGISTRY, formatModalitySummary } from '@/modalities/registry';
import { useLanguage } from '@/app/i18n/useLanguage';

interface ProjectSettingsPageProps {
  editedProject: Project | null;
  hasProjectChanges: boolean;
  onChange: (field: keyof Project, value: string) => void;
  onModalitiesChange: (modalities: ModalityId[]) => void;
  onSave: () => void;
  onBackup: () => void;
  onExport: () => void;
  onDeleteExperiment: () => void;
  onDeleteProject: () => void;
  experiments: Experiment[];
  activeExperimentId: string;
  onChangeExperiment: (experimentId: string) => void;
  onCreateExperiment: () => void;
}

const fieldLabelClass = 'block text-xs font-medium text-slate-600';
const fieldControlClass = 'h-9 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition-colors placeholder:text-slate-400 hover:border-slate-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15';

const ProjectSettingsPage: React.FC<ProjectSettingsPageProps> = ({
  editedProject,
  hasProjectChanges,
  onChange,
  onModalitiesChange,
  onSave,
  onBackup,
  onExport,
  onDeleteExperiment,
  onDeleteProject,
  experiments,
  activeExperimentId,
  onChangeExperiment,
  onCreateExperiment,
}) => {
  const { language } = useLanguage();
  const [modalityDropdownOpen, setModalityDropdownOpen] = React.useState(false);
  const modalityDropdownRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!modalityDropdownOpen) return;
    const close = (event: MouseEvent) => {
      if (!modalityDropdownRef.current?.contains(event.target as Node)) setModalityDropdownOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [modalityDropdownOpen]);
  if (!editedProject) return <div className="p-10 text-center text-sm text-slate-600">正在加载工程信息...</div>;
  const modalities = normalizeProjectModalities(editedProject);
  const modalityIds = modalities.map((item) => item.id);
  const hasEyeTracking = modalities.some((item) => item.id === 'eye-tracking');

  return (
    <div className="h-full overflow-hidden flex flex-col">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden flex flex-col h-full">
        <div className="grid flex-1 grid-cols-2 content-start gap-x-6 gap-y-4 overflow-y-auto p-5">
          <div ref={modalityDropdownRef} className="relative min-w-0 space-y-1.5">
            <label className={fieldLabelClass}>当前工程模态</label>
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={modalityDropdownOpen}
              onClick={() => setModalityDropdownOpen((open) => !open)}
              className={`${fieldControlClass} flex items-center justify-between gap-2 text-left ${modalityDropdownOpen ? '!border-sky-500 ring-2 ring-sky-500/15' : ''}`}
            >
              <span className="truncate">{formatModalitySummary(modalityIds, language)}</span>
              <ChevronDown size={16} className={`shrink-0 text-slate-500 transition-transform ${modalityDropdownOpen ? 'rotate-180' : ''}`} />
            </button>
            {modalityDropdownOpen && (
              <div role="listbox" aria-multiselectable="true" className="mrt-dropdown-panel absolute left-0 right-0 top-full z-50 overflow-hidden bg-white p-1 shadow-lg">
                {(Object.keys(MODALITY_REGISTRY) as ModalityId[]).map((id) => {
                  const definition = MODALITY_REGISTRY[id];
                  const checked = modalityIds.includes(id);
                  const lastSelected = checked && modalityIds.length === 1;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="option"
                      aria-selected={checked}
                      disabled={lastSelected}
                      // Pointer clicks toggle only on the switch; keyboard (detail 0) works anywhere.
                      onClick={(event) => {
                        if (event.detail !== 0 && !(event.target as Element).closest('[data-switch-track]')) return;
                        onModalitiesChange(checked ? modalityIds.filter((item) => item !== id) : [...modalityIds, id]);
                      }}
                      className="mrt-dropdown-option flex w-full cursor-default items-center gap-3 px-2 py-2 text-left transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-slate-800">{definition.label}</span>
                        <span className="mt-0.5 block truncate text-xs text-slate-500">{definition.description}</span>
                      </span>
                      <SwitchVisual checked={checked} disabled={lastSelected} inactiveClass="bg-slate-200" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
            <div className="min-w-0 space-y-1.5">
              <label className={fieldLabelClass}>工程名称</label>
              <input
                type="text"
                value={editedProject.name}
                onChange={(e) => onChange('name', e.target.value)}
                className={fieldControlClass}
              />
            </div>
            <div className="min-w-0 space-y-1.5">
              <label className={fieldLabelClass}>工程代号</label>
              <input
                type="text"
                value={editedProject.code}
                onChange={(e) => onChange('code', e.target.value)}
                className={fieldControlClass}
              />
            </div>
            <div className="min-w-0 space-y-1.5">
              <label className={fieldLabelClass}>负责人</label>
              <input
                type="text"
                value={editedProject.manager}
                onChange={(e) => onChange('manager', e.target.value)}
                className={fieldControlClass}
              />
            </div>
            {hasEyeTracking && <div className="min-w-0 self-end space-y-1.5">
              <label className={fieldLabelClass}>眼动仪</label>
              <DeviceModelSelect
                value={editedProject.deviceModel}
                deviceType={editedProject.deviceType}
                onChange={(deviceModel) => onChange('deviceModel', deviceModel)}
                className={`${fieldControlClass} !rounded-lg`}
              />
            </div>}
            <div className={hasEyeTracking ? 'min-w-0 self-end space-y-1.5' : 'min-w-0 space-y-1.5'}>
              <label className={fieldLabelClass}>当前实验</label>
              <CustomSelect
                value={activeExperimentId}
                onChange={(e) => onChangeExperiment(e.target.value)}
                className={`${fieldControlClass} !rounded-lg`}
              >
                {experiments.length === 0 ? (
                  <option value="" disabled>
                    暂无实验
                  </option>
                ) : (
                  experiments.map((e) => (
                    <option key={e.id} value={e.id} data-i18n-skip="true">
                      {e.name}
                    </option>
                  ))
                )}
              </CustomSelect>
            </div>
            <div className="min-w-0 space-y-1.5">
              <label className={fieldLabelClass}>实验管理</label>
              <button
                onClick={onCreateExperiment}
                className={`${btnSecondary} !h-9 w-full justify-center`}
              >
                新建实验
              </button>
            </div>
            <div className={hasEyeTracking ? 'min-w-0 space-y-1.5' : 'col-span-2 min-w-0 space-y-1.5'}>
              <label className={fieldLabelClass}>最后更新</label>
              <div className="mrt-input-display flex h-9 w-full items-center truncate rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-mono text-slate-600">
                {editedProject.updatedAt}
              </div>
            </div>

          <div className="col-span-2 space-y-1.5 border-t border-slate-200 pt-4">
            <label className={fieldLabelClass}>工程备注 / 描述</label>
            <AutoResizeTextarea
              rows={8}
              value={editedProject.notes}
              onChange={(e) => onChange('notes', e.target.value)}
              placeholder="在此输入工程的背景说明或实验注意事项..."
              className={`${fieldControlClass} min-h-24 leading-relaxed`}
            />
          </div>
        </div>

        <div className="mt-auto grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-t border-slate-200 bg-slate-50 px-5 py-3 xl:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
          <div className="flex min-w-0 max-w-52 items-center gap-1.5 text-[11px] text-slate-500" title={`工程 ID: ${editedProject.id}`}>
            <FileText size={14} className="shrink-0" />
            <span className="truncate">工程 ID: {editedProject.id}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onBackup}
              className={btnSecondary}
            >
              <Save size={14} /> 工程备份
            </button>
            <button
              onClick={onExport}
              className={btnSecondary}
            >
              <Download size={14} /> 导出压缩工程
            </button>
          </div>
          <div className="flex items-center gap-2 xl:border-l xl:border-slate-200 xl:pl-3">
            <button
              onClick={onDeleteExperiment}
              className={btnDanger}
            >
              <Trash2 size={14} /> 删除实验
            </button>
            <button
              onClick={onDeleteProject}
              className={btnDanger}
            >
              <Trash2 size={14} /> 删除工程
            </button>
          </div>

          <button
            onClick={onSave}
            className={`${btnPrimary} justify-self-end ${
              hasProjectChanges
                ? ''
                : 'mrt-button-muted cursor-not-allowed'
            }`}
          >
            <Save size={16} /> 保存工程信息
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProjectSettingsPage;
