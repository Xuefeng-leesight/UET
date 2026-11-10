import React from 'react';
import { Modal } from '@/shared/ui/Modal';
import { btnPrimary, btnSecondary } from '@/shared/ui/buttonClasses';

interface NewExperimentModalProps {
  isOpen: boolean;
  onClose: () => void;
  name: string;
  setName: React.Dispatch<React.SetStateAction<string>>;
  onCreate: () => void;
}

const NewExperimentModal: React.FC<NewExperimentModalProps> = ({ isOpen, onClose, name, setName, onCreate }) => {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="新建实验"
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
        <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
          <label className="text-sm font-medium text-slate-700">实验名称</label>
          <input
            type="text"
            placeholder="请输入实验名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 placeholder:text-slate-500 focus:ring-2 focus:ring-sky-500/15 focus:border-sky-500 outline-none transition-colors"
          />
        </div>
      </div>
    </Modal>
  );
};

export default NewExperimentModal;
