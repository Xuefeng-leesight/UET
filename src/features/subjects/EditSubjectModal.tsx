import React from 'react';
import { Modal } from '@/shared/ui/Modal';
import { btnPrimary, btnSecondary } from '@/shared/ui/buttonClasses';
import type { SubjectFieldDef } from '@/shared/types/mrt';
import { useLanguage } from '@/app/i18n/useLanguage';
import type { SubjectDraft } from '@/app/workspace/useMrtEditorState';

interface EditSubjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: () => void;
  editSubjectData: SubjectDraft;
  setEditSubjectData: React.Dispatch<React.SetStateAction<SubjectDraft>>;
  subjectFields: SubjectFieldDef[];
}

const EditSubjectModal: React.FC<EditSubjectModalProps> = ({
  isOpen,
  onClose,
  onSave,
  editSubjectData,
  setEditSubjectData,
  subjectFields,
}) => {
  const { language } = useLanguage();
  const isEn = language === 'en-US';
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEn ? 'Edit subject' : '编辑受试者'}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <button
            onClick={onClose}
            className={btnSecondary}
          >
            {isEn ? 'Cancel' : '取消'}
          </button>
          <button
            onClick={onSave}
            className={btnPrimary}
          >
            {isEn ? 'Save changes' : '保存修改'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
          <label className="text-sm font-medium text-slate-700">{isEn ? 'Name' : '姓名'}</label>
          <input
            type="text"
            placeholder={isEn ? 'Please enter name' : '请输入姓名'}
            value={editSubjectData.name}
            onChange={(e) => setEditSubjectData({ ...editSubjectData, name: e.target.value })}
            className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 placeholder:text-slate-500 focus:ring-2 focus:ring-sky-500/15 focus:border-sky-500 outline-none transition-colors"
          />
        </div>
        <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
          <label className="text-sm font-medium text-slate-700">{isEn ? 'Gender' : '性别'}</label>
          <div className="flex gap-4">
            {['男', '女'].map((g) => (
              <label key={g} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="edit-gender"
                  checked={editSubjectData.gender === g}
                  onChange={() => setEditSubjectData({ ...editSubjectData, gender: g })}
                  className="accent-sky-500"
                />
                <span className="text-sm text-slate-700">
                  {isEn ? (g === '男' ? 'Male' : 'Female') : g}
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
          <label className="text-sm font-medium text-slate-700">{isEn ? 'Age' : '年龄'}</label>
          <input
            type="number"
            placeholder={isEn ? 'Please enter age' : '请输入年龄'}
            value={editSubjectData.age}
            onChange={(e) => setEditSubjectData({ ...editSubjectData, age: e.target.value })}
            className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 placeholder:text-slate-500 focus:ring-2 focus:ring-sky-500/15 focus:border-sky-500 outline-none transition-colors"
          />
        </div>
        {subjectFields
          .filter((f) => !f.builtin)
          .map((field) => (
            <div key={field.id} className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
              <label className="text-sm font-medium text-slate-700" data-i18n-skip="true">{field.label}</label>
              <input
                type="text"
                data-i18n-skip="true"
                placeholder={field.label}
                value={String(editSubjectData[field.label] ?? '')}
                onChange={(e) => setEditSubjectData({ ...editSubjectData, [field.label]: e.target.value })}
                className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 placeholder:text-slate-500 focus:ring-2 focus:ring-sky-500/15 focus:border-sky-500 outline-none transition-colors"
              />
            </div>
          ))}
      </div>
    </Modal>
  );
};

export default EditSubjectModal;
