import React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useMainWindowOverlayMask } from '@/infrastructure/electron/useMainWindowOverlayMask';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidthClassName?: string;
  contentClassName?: string;
  onBackdropClick?: () => void;
  keepMounted?: boolean;
}

export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, description, children, footer, maxWidthClassName, contentClassName = '', onBackdropClick, keepMounted = false }) => {
  useMainWindowOverlayMask(isOpen);

  if (!isOpen && !keepMounted) return null;

  const maxWidth = maxWidthClassName || 'max-w-lg';
  const modal = (
    <div
      className="fixed inset-0 flex items-center justify-center p-4 bg-black/40"
      onClick={(event) => {
        if (event.target === event.currentTarget) onBackdropClick?.();
      }}
      style={{
        ...(isOpen ? undefined : { display: 'none' }),
        // Recording/calibration surfaces use high z-index values of their own.
        // Keep confirmations above every monitor card and fullscreen overlay.
        zIndex: 2_147_483_647,
      }}
      aria-hidden={!isOpen}
      role="presentation"
    >
      <div
        className={`mrt-dialog mrt-modal mrt-stagger bg-white w-full ${maxWidth} overflow-hidden flex flex-col`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="mrt-modal-header mrt-enter flex shrink-0 items-start justify-between gap-3">
          <div className="min-w-0 py-0.5">
            <h3 className="text-base font-semibold text-slate-800">{title}</h3>
            {description && <div className="mt-1 text-xs leading-relaxed text-slate-500 break-words">{description}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="关闭" className="mrt-button-row flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors">
            <X size={18} className="text-slate-500" />
          </button>
        </div>
        <div className={`mrt-modal-content mrt-enter min-h-0 flex-auto overflow-y-auto ${contentClassName}`}>{children}</div>
        {footer && (
          <div className="mrt-modal-footer mrt-enter flex shrink-0 flex-wrap justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
};
