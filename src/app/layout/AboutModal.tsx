import React from 'react';
import { Modal } from '@/shared/ui/Modal';
import { useLanguage } from '@/app/i18n/useLanguage';

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** “关于我们”弹窗：底栏和授权页共用，联系方式只在这里维护。 */
const AboutModal: React.FC<AboutModalProps> = ({ isOpen, onClose }) => {
  const { language } = useLanguage();
  const appVersion = __APP_VERSION__;
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={language === 'en-US' ? 'About' : '关于我们'}
      maxWidthClassName="max-w-md"
    >
      <div className="space-y-4 text-sm text-slate-700">
        <div className="grid grid-cols-[88px_1fr] gap-3">
          <span className="font-bold text-slate-500">{language === 'en-US' ? 'Phone' : '联系电话'}</span>
          <span className="font-mono tabular-nums">15921347392</span>
        </div>
        <div className="grid grid-cols-[88px_1fr] gap-3">
          <span className="font-bold text-slate-500">{language === 'en-US' ? 'Email' : '电子邮件'}</span>
          <span>info@leesight.com</span>
        </div>
        <div className="grid grid-cols-[88px_1fr] gap-3">
          <span className="font-bold text-slate-500">{language === 'en-US' ? 'Version' : '软件版本'}</span>
          <span className="font-mono tabular-nums">{appVersion}</span>
        </div>
      </div>
    </Modal>
  );
};

export default AboutModal;
