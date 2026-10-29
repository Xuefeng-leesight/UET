import React from 'react';
import { Modal } from '@/shared/ui/Modal';
import { btnDanger, btnPrimary, btnSecondary } from '@/shared/ui/buttonClasses';
import type { ConfirmState } from '@/shared/types/mrt';

interface ConfirmModalProps {
  confirmState: ConfirmState;
  setConfirmState: React.Dispatch<React.SetStateAction<ConfirmState>>;
}

const ConfirmModal: React.FC<ConfirmModalProps> = ({ confirmState, setConfirmState }) => {
  const showCancel = confirmState.showCancel !== false;
  const cancelText = confirmState.cancelText || '取消';
  const confirmText = confirmState.confirmText || '确定';
  const variant = confirmState.confirmVariant || (showCancel ? 'danger' : 'primary');
  const confirmBtnClass =
    variant === 'danger'
      ? btnDanger
      : btnPrimary;

  const closeOnly = () => {
    const closeFn = confirmState.onClose;
    setConfirmState((prev) => ({ ...prev, open: false }));
    if (closeFn) {
      closeFn();
    }
  };

  const confirmAndClose = () => {
    const fn = confirmState.onConfirm;
    setConfirmState((prev) => ({ ...prev, open: false }));
    if (fn) {
      fn();
    }
  };

  const cancelAndClose = () => {
    const fn = confirmState.onCancel;
    setConfirmState((prev) => ({ ...prev, open: false }));
    if (fn) {
      fn();
    }
  };

  return (
    <Modal
      isOpen={confirmState.open}
      onClose={() => {
        if (!showCancel && confirmState.onConfirm) {
          confirmAndClose();
          return;
        }
        closeOnly();
      }}
      title={confirmState.title || '确认操作'}
      maxWidthClassName="max-w-md"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          {showCancel && (
            <button
              onClick={cancelAndClose}
              className={btnSecondary}
            >
              {cancelText}
            </button>
          )}
          <button onClick={confirmAndClose} className={confirmBtnClass}>
            {confirmText}
          </button>
        </div>
      }
    >
      <div className="text-sm leading-relaxed text-slate-600 whitespace-pre-line break-words">{confirmState.message}</div>
    </Modal>
  );
};

export default ConfirmModal;
