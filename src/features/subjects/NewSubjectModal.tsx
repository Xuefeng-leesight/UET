import React from 'react';
import { Modal } from '@/shared/ui/Modal';
import { btnPrimary, btnSecondary } from '@/shared/ui/buttonClasses';
import type { SubjectFieldDef } from '@/shared/types/mrt';
import type { SubjectDraft } from '@/app/workspace/useMrtEditorState';

interface NewSubjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: () => void;
  newSubjectData: SubjectDraft;
  setNewSubjectData: React.Dispatch<React.SetStateAction<SubjectDraft>>;
  subjectFields: SubjectFieldDef[];
}

const NewSubjectModal: React.FC<NewSubjectModalProps> = ({
  isOpen,
  onClose,
  onCreate,
  newSubjectData,
  setNewSubjectData,
  subjectFields,
}) => {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="新建受试者"
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
            保存受试者
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
          <label className="text-sm font-medium text-slate-700">姓名</label>
          <input
            type="text"
            placeholder="请输入姓名"
            value={newSubjectData.name}
            onChange={(e) => setNewSubjectData({ ...newSubjectData, name: e.target.value })}
            className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 placeholder:text-slate-500 focus:ring-2 focus:ring-sky-500/15 focus:border-sky-500 outline-none transition-colors"
          />
        </div>
        <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
          <label className="text-sm font-medium text-slate-700">性别</label>
          <div className="flex gap-4">
            {['男', '女'].map((g) => (
              <label key={g} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="gender"
                  checked={newSubjectData.gender === g}
                  onChange={() => setNewSubjectData({ ...newSubjectData, gender: g })}
                  className="accent-sky-500"
                />
                <span className="text-sm text-slate-700">{g}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
          <label className="text-sm font-medium text-slate-700">年龄</label>
          <input
            type="number"
            placeholder="请输入年龄"
            value={newSubjectData.age}
            onChange={(e) => setNewSubjectData({ ...newSubjectData, age: e.target.value })}
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
                value={String(newSubjectData[field.label] ?? '')}
                onChange={(e) => setNewSubjectData({ ...newSubjectData, [field.label]: e.target.value })}
                className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 placeholder:text-slate-500 focus:ring-2 focus:ring-sky-500/15 focus:border-sky-500 outline-none transition-colors"
              />
            </div>
          ))}
      </div>
    </Modal>
  );
};

export default NewSubjectModal;
