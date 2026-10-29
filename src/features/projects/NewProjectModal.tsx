import { SwitchVisual } from '@/shared/ui/Switch';
import React from 'react';
import { ChevronDown } from 'lucide-react';
import DeviceModelSelect from './DeviceModelSelect';
import { Modal } from '@/shared/ui/Modal';
import { btnPrimary, btnSecondary } from '@/shared/ui/buttonClasses';
import { deviceTypeFromModel } from '@/features/recording/device/deviceProfile';
import type { ModalityId } from '@shared/contracts/domain/models';
import { MODALITY_REGISTRY, formatModalitySummary } from '@/modalities/registry';
import { useLanguage } from '@/app/i18n/useLanguage';
import type { NewProjectData } from './domain/projectDraft';
import { isLicenseModuleAuthorized, moduleForModality, useLicenseState } from '@/features/licensing/licenseContext';


interface NewProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  newProjectData: NewProjectData;
  setNewProjectData: React.Dispatch<React.SetStateAction<NewProjectData>>;
  onCreate: () => void;
}

const NewProjectModal: React.FC<NewProjectModalProps> = ({ isOpen, onClose, newProjectData, setNewProjectData, onCreate }) => {
  const { language } = useLanguage();
  const licenseState = useLicenseState();
  const [modalityDropdownOpen, setModalityDropdownOpen] = React.useState(false);
  const modalityDropdownRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!isOpen) setModalityDropdownOpen(false);
  }, [isOpen]);

  React.useEffect(() => {
    if (!isOpen || !licenseState) return;
    const allowed = newProjectData.selectedModalities.filter((id) => {
      const required = moduleForModality(id);
      return !required || isLicenseModuleAuthorized(licenseState, required);
    });
    if (allowed.length !== newProjectData.selectedModalities.length) {
      setNewProjectData((current) => ({ ...current, selectedModalities: allowed }));
    }
  }, [isOpen, licenseState, newProjectData.selectedModalities, setNewProjectData]);

  React.useEffect(() => {
    if (!modalityDropdownOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!modalityDropdownRef.current?.contains(event.target as Node)) setModalityDropdownOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [modalityDropdownOpen]);

  const toggleModality = (id: ModalityId) => {
    const selected = newProjectData.selectedModalities.includes(id);
    setNewProjectData({
      ...newProjectData,
      selectedModalities: selected
        ? newProjectData.selectedModalities.filter((item) => item !== id)
        : [...newProjectData.selectedModalities, id],
    });
  };
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="新建工程"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <button
            onClick={onClose}
            className={btnSecondary}
          >
            取消
          </button>
          <button
            onClick={onCreate}
            className={btnPrimary}
          >
            确认创建
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div ref={modalityDropdownRef} className="relative grid grid-cols-[100px_minmax(0,1fr)] items-start gap-4">
          <label className="pt-2 text-sm font-medium text-slate-700">工程模态</label>
          <div className="relative">
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={modalityDropdownOpen}
              onClick={() => setModalityDropdownOpen((open) => !open)}
              className={`flex w-full items-center justify-between gap-2 rounded-lg border bg-slate-50 px-3 py-2 text-left text-sm outline-none transition-colors ${modalityDropdownOpen ? 'border-sky-500 ring-2 ring-sky-500/15' : 'border-slate-200 hover:border-slate-300'}`}
            >
              <span className={`truncate ${newProjectData.selectedModalities.length > 0 ? 'font-medium text-slate-700' : 'text-slate-500'}`}>
                {newProjectData.selectedModalities.length > 0
                  ? formatModalitySummary(newProjectData.selectedModalities, language)
                  : '请选择工程模态'}
              </span>
              <ChevronDown size={17} className={`shrink-0 text-slate-400 transition-transform duration-200 ${modalityDropdownOpen ? 'rotate-180' : ''}`} />
            </button>

            {modalityDropdownOpen && (
              <div role="listbox" aria-multiselectable="true" className="mrt-dropdown-panel absolute left-0 right-0 top-full z-50 overflow-hidden bg-white p-1 shadow-lg shadow-slate-900/10">
                {(Object.keys(MODALITY_REGISTRY) as ModalityId[]).map((id) => {
                  const item = MODALITY_REGISTRY[id];
                  const checked = newProjectData.selectedModalities.includes(id);
                  const requiredModule = moduleForModality(id);
                  const authorized = !requiredModule || isLicenseModuleAuthorized(licenseState, requiredModule);
                  return (
                    <button
                      key={id}
                      type="button"
                      role="option"
                      aria-selected={checked}
                      // Pointer clicks toggle only on the switch; keyboard (detail 0) works anywhere.
                      onClick={(event) => {
                        if (!authorized) return;
                        if (event.detail === 0 || (event.target as Element).closest('[data-switch-track]')) toggleModality(id);
                      }}
                      disabled={!authorized}
                      className="mrt-dropdown-option flex w-full cursor-default items-center gap-3 px-2 py-2 text-left transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-slate-700">{item.label}</span>
                        <span className="mt-0.5 block truncate text-xs text-slate-500">{authorized ? item.description : `${item.description}（License 未授权）`}</span>
                      </span>
                      <SwitchVisual checked={checked} disabled={!authorized} inactiveClass="bg-slate-200" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {newProjectData.selectedModalities.length === 0 && <div className="col-start-2 text-xs text-rose-500">至少选择一种模态</div>}
        </div>
        <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
          <label className="text-sm font-medium text-slate-700">工程名称</label>
          <input
            type="text"
            placeholder="请输入工程名称"
            value={newProjectData.name}
            onChange={(e) => setNewProjectData({ ...newProjectData, name: e.target.value })}
            className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 placeholder:text-slate-500 focus:ring-2 focus:ring-sky-500/15 focus:border-sky-500 outline-none transition-colors"
          />
        </div>
        <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
          <label className="text-sm font-medium text-slate-700">工程代号</label>
          <input
            type="text"
            placeholder="请输入代号"
            value={newProjectData.code}
            onChange={(e) => setNewProjectData({ ...newProjectData, code: e.target.value })}
            className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 placeholder:text-slate-500 focus:ring-2 focus:ring-sky-500/15 focus:border-sky-500 outline-none transition-colors"
          />
        </div>
        <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
          <label className="text-sm font-medium text-slate-700">负责人</label>
          <input
            type="text"
            placeholder="请输入负责人姓名"
            value={newProjectData.manager}
            onChange={(e) => setNewProjectData({ ...newProjectData, manager: e.target.value })}
            className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 placeholder:text-slate-500 focus:ring-2 focus:ring-sky-500/15 focus:border-sky-500 outline-none transition-colors"
          />
        </div>
        {newProjectData.selectedModalities.includes('eye-tracking') && <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
          <label className="text-sm font-medium text-slate-700">眼动仪</label>
          <DeviceModelSelect
            value={newProjectData.deviceModel}
            deviceType={newProjectData.deviceType}
            onChange={(deviceModel) => setNewProjectData((current) => ({ ...current, deviceModel, deviceType: deviceTypeFromModel(deviceModel) }))}
            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 placeholder:text-slate-500 focus:ring-2 focus:ring-sky-500/15 focus:border-sky-500 outline-none transition-colors"
          />
        </div>}
      </div>
    </Modal>
  );
};

export default NewProjectModal;
