import React, { useState } from 'react';
import { Plus, Trash2, Edit2 } from 'lucide-react';
import CustomSelect from '@/shared/ui/CustomSelect';
import { Modal } from '@/shared/ui/Modal';
import { btnPrimary, btnSecondary } from '@/shared/ui/buttonClasses';
import AutoResizeTextarea from '@/shared/ui/AutoResizeTextarea';
import type { CustomMarker } from '@/shared/types/mrt';
import { useLanguage } from '@/app/i18n/useLanguage';

interface CustomMarkersModalProps {
  isOpen: boolean;
  onClose: () => void;
  markers: CustomMarker[];
  onSave: (markers: CustomMarker[]) => void;
}

const CustomMarkersModal: React.FC<CustomMarkersModalProps> = ({ isOpen, onClose, markers, onSave }) => {
  const { language } = useLanguage();
  const isEn = language === 'en-US';
  const [localMarkers, setLocalMarkers] = useState<CustomMarker[]>(markers);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [formData, setFormData] = useState<Partial<CustomMarker>>({
    name: '',
    description: '',
    color: '#3b82f6',
    active: true,
    type: 'instant',
    key: '',
  });
  const [keyCapture, setKeyCapture] = useState(false);
  const t = isEn
    ? {
        title: 'Custom marker management',
        cancel: 'Cancel',
        saveAll: 'Save all',
        markerList: 'Marker list',
        newMarker: 'New marker',
        emptyList: 'No custom markers yet. Click "New marker" to add one.',
        instantTag: 'Instant',
        holdTag: 'Hold',
        inactive: 'Inactive',
        editMarker: 'Edit marker',
        name: 'Name',
        namePlaceholder: 'For example: Start fixation',
        description: 'Description',
        descriptionPlaceholder: 'Description of marker usage',
        color: 'Color',
        type: 'Type',
        instantOption: 'Instant (record on key press)',
        holdOption: 'Hold (record while pressed)',
        key: 'Key',
        keyPlaceholder: 'Click the button below to capture key',
        captureAnyKey: 'Press any key...',
        captureKey: 'Capture key',
        activateMarker: 'Activate this marker',
        add: 'Add',
        save: 'Save',
        selectTip: 'Select a marker to edit, or click "New marker".',
        fillNameAndKey: 'Please fill in name and key',
      }
    : {
        title: '自定义标记管理',
        cancel: '取消',
        saveAll: '保存全部',
        markerList: '标记列表',
        newMarker: '新建标记',
        emptyList: '暂无自定义标记，点击"新建标记"添加',
        instantTag: '瞬时',
        holdTag: '持续',
        inactive: '未激活',
        editMarker: '编辑标记',
        name: '名称',
        namePlaceholder: '例如：开始注视',
        description: '描述',
        descriptionPlaceholder: '标记的用途说明',
        color: '颜色',
        type: '类型',
        instantOption: '瞬时（按下即记录）',
        holdOption: '持续（按住期间持续记录）',
        key: '按键',
        keyPlaceholder: '点击下方按钮捕获按键',
        captureAnyKey: '请按下任意键...',
        captureKey: '捕获按键',
        activateMarker: '激活此标记',
        add: '添加',
        save: '保存',
        selectTip: '选择一个标记进行编辑，或点击"新建标记"',
        fillNameAndKey: '请填写名称和按键',
      };

  const handleAddNew = () => {
    setIsAddingNew(true);
    setEditingId(null);
    setFormData({
      name: '',
      description: '',
      color: '#3b82f6',
      active: true,
      type: 'instant',
      key: '',
    });
  };

  const handleEdit = (marker: CustomMarker) => {
    setIsAddingNew(false);
    setEditingId(marker.id);
    setFormData(marker);
  };

  const handleDelete = (id: string) => {
    setLocalMarkers(prev => prev.filter(m => m.id !== id));
  };

  const handleSaveMarker = () => {
    if (!formData.name || !formData.key) {
      alert(t.fillNameAndKey);
      return;
    }

    if (isAddingNew) {
      const newMarker: CustomMarker = {
        id: `marker_${Date.now()}`,
        name: formData.name!,
        description: formData.description || '',
        color: formData.color || '#3b82f6',
        active: formData.active !== false,
        type: formData.type || 'instant',
        key: formData.key!,
        createdAt: new Date().toISOString(),
      };
      setLocalMarkers(prev => [...prev, newMarker]);
    } else if (editingId) {
      setLocalMarkers(prev =>
        prev.map(m =>
          m.id === editingId
            ? { ...m, ...formData as CustomMarker }
            : m
        )
      );
    }

    setIsAddingNew(false);
    setEditingId(null);
    setFormData({
      name: '',
      description: '',
      color: '#3b82f6',
      active: true,
      type: 'instant',
      key: '',
    });
  };

  const handleCancel = () => {
    setIsAddingNew(false);
    setEditingId(null);
    setFormData({
      name: '',
      description: '',
      color: '#3b82f6',
      active: true,
      type: 'instant',
      key: '',
    });
  };

  const handleKeyCapture = (e: React.KeyboardEvent) => {
    e.preventDefault();
    setFormData(prev => ({ ...prev, key: e.key }));
    setKeyCapture(false);
  };

  const handleSaveAll = () => {
    onSave(localMarkers);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t.title}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <button
            onClick={onClose}
            className={btnSecondary}
          >
            {t.cancel}
          </button>
          <button
            onClick={handleSaveAll}
            className={btnPrimary}
          >
            {t.saveAll}
          </button>
        </div>
      }
      maxWidthClassName="max-w-4xl"
    >
      <div className="grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1fr)_20rem] md:min-h-[320px]">
        {/* 左侧：标记列表 */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h3 className="text-sm font-bold text-slate-700">{t.markerList}</h3>
            <button
              onClick={handleAddNew}
              className={btnPrimary}
            >
              <Plus size={14} />
              {t.newMarker}
            </button>
          </div>

          <div className="space-y-2 max-h-80 overflow-y-auto">
            {localMarkers.length === 0 ? (
              <div className="text-center py-8 text-slate-400 text-sm">
                {t.emptyList}
              </div>
            ) : (
              localMarkers.map(marker => (
                <div
                  key={marker.id}
                  className={`p-3 rounded-lg border transition-all ${
                    editingId === marker.id
                      ? 'border-sky-500 bg-sky-50'
                      : 'border-slate-200 hover:border-slate-300 bg-white'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <div
                        className="w-4 h-4 rounded mt-0.5 flex-shrink-0"
                        style={{ backgroundColor: marker.color }}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-slate-800 truncate" data-i18n-skip="true">
                            {marker.name}
                          </span>
                          <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-mono">
                            {marker.key}
                          </span>
                          <span className={`text-xs px-1.5 py-0.5 rounded ${
                            marker.type === 'instant'
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-purple-100 text-purple-700'
                          }`}>
                            {marker.type === 'instant' ? t.instantTag : t.holdTag}
                          </span>
                          {!marker.active && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-slate-200 text-slate-500">
                              {t.inactive}
                            </span>
                          )}
                        </div>
                        {marker.description && (
                          <p className="text-xs text-slate-500 mt-1 truncate" data-i18n-skip="true">
                            {marker.description}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-1 flex-shrink-0">
                      <button
                        onClick={() => handleEdit(marker)}
                        className="p-1.5 text-slate-400 hover:text-sky-600 hover:bg-sky-50 rounded transition-colors"
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(marker.id)}
                        className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 右侧：编辑表单 */}
        <div className="min-w-0">
          {(isAddingNew || editingId) ? (
            <div className="space-y-4">
              <h3 className="text-sm font-bold text-slate-700">
                {isAddingNew ? t.newMarker : t.editMarker}
              </h3>

              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1.5">{t.name}</label>
                  <input
                    type="text"
                    value={formData.name || ''}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    placeholder={t.namePlaceholder}
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1.5">{t.description}</label>
                  <AutoResizeTextarea
                    value={formData.description || ''}
                    onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                    placeholder={t.descriptionPlaceholder}
                    rows={2}
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1.5">{t.color}</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={formData.color || '#3b82f6'}
                      onChange={(e) => setFormData(prev => ({ ...prev, color: e.target.value }))}
                      className="w-12 h-10 rounded border border-slate-200 cursor-pointer"
                    />
                    <input
                      type="text"
                      value={formData.color || '#3b82f6'}
                      onChange={(e) => setFormData(prev => ({ ...prev, color: e.target.value }))}
                      className="min-w-0 flex-1 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm font-mono focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1.5">{t.type}</label>
                  <CustomSelect
                    value={formData.type || 'instant'}
                    onChange={(e) => setFormData(prev => ({ ...prev, type: e.target.value as 'instant' | 'continuous' }))}
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 outline-none"
                  >
                    <option value="instant">{t.instantOption}</option>
                    <option value="continuous">{t.holdOption}</option>
                  </CustomSelect>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1.5">{t.key}</label>
                  <div className="relative">
                    <input
                      type="text"
                      value={formData.key || ''}
                      readOnly
                      placeholder={t.keyPlaceholder}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-mono text-center cursor-not-allowed"
                    />
                    <button
                      onClick={() => setKeyCapture(true)}
                      onKeyDown={keyCapture ? handleKeyCapture : undefined}
                      className={`mt-2 w-full px-3 py-2 text-xs font-bold rounded-lg transition-colors ${
                        keyCapture
                          ? 'bg-amber-500 text-white animate-pulse'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {keyCapture ? t.captureAnyKey : t.captureKey}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.active !== false}
                      onChange={(e) => setFormData(prev => ({ ...prev, active: e.target.checked }))}
                      className="w-4 h-4 rounded bg-white border-slate-300 text-sky-500 focus:ring-sky-500 accent-sky-500"
                    />
                    <span className="text-sm font-bold text-slate-700">{t.activateMarker}</span>
                  </label>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  onClick={handleCancel}
                  className={`${btnSecondary} flex-1`}
                >
                  {t.cancel}
                </button>
                <button
                  onClick={handleSaveMarker}
                  className={`${btnPrimary} flex-1`}
                >
                  {isAddingNew ? t.add : t.save}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex min-h-24 items-center justify-center h-full text-slate-400 text-sm">
              {t.selectTip}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default CustomMarkersModal;
