import React, { useEffect, useRef, useState } from 'react';
import { Modal } from '@/shared/ui/Modal';
import { btnDanger, btnPrimary } from '@/shared/ui/buttonClasses';
import type { SubjectFieldDef } from '@/shared/types/mrt';
import { addSubjectField, removeSubjectField } from '@/features/subjects/domain/subjectFieldsModule';

interface SubjectFieldsManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  subjectFields: SubjectFieldDef[];
  setSubjectFields: React.Dispatch<React.SetStateAction<SubjectFieldDef[]>>;
}

const SubjectFieldsManagerModal: React.FC<SubjectFieldsManagerModalProps> = ({
  isOpen,
  onClose,
  subjectFields,
  setSubjectFields,
}) => {
  const [newFieldLabel, setNewFieldLabel] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setErrorMessage(null);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  const handleAdd = () => {
    const res = addSubjectField(subjectFields, newFieldLabel);
    if (!res.ok) {
      setErrorMessage(res.error || '新增字段失败');
      return;
    }
    setSubjectFields(res.next);
    setNewFieldLabel('');
    setErrorMessage(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="受试者字段管理" footer={null}>
      <div className="space-y-4">
        <div className="text-xs text-slate-500">管理受试者的字段。内置字段不可删除，自定义字段可删除。</div>
        <div className="border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 text-[11px] text-slate-500 tracking-widest font-bold border-b border-slate-100">
                <th className="px-4 py-2.5">字段名称</th>
                <th className="px-4 py-2.5 w-24 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 text-sm">
              {subjectFields.map((field) => (
                <tr key={field.id}>
                  <td className="px-4 py-2.5 text-slate-700" data-i18n-skip={field.builtin ? undefined : 'true'}>
                    {field.label}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {field.builtin ? (
                      <span className="text-[11px] text-slate-400">内置</span>
                    ) : (
                      <button
                        onClick={() => setSubjectFields(removeSubjectField(subjectFields, field.id))}
                        className={btnDanger}
                      >
                        删除
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="pt-2 border-t border-slate-100 space-y-3">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 items-center">
            <input
              ref={inputRef}
              type="text"
              placeholder="字段名称，例如 联系电话"
              className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-sky-500/10 focus:border-sky-500 outline-none"
              value={newFieldLabel}
              onChange={(e) => {
                setNewFieldLabel(e.target.value);
                if (errorMessage) setErrorMessage(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAdd();
                }
              }}
            />
            <button
              onClick={handleAdd}
              className={btnPrimary}
            >
              新增字段
            </button>
          </div>
          {errorMessage && <div className="text-xs font-bold text-rose-600">{errorMessage}</div>}
        </div>
      </div>
    </Modal>
  );
};

export default SubjectFieldsManagerModal;
