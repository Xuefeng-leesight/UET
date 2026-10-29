import React from 'react';
import { MonitorUp, Square } from 'lucide-react';
import { Modal } from '@/shared/ui/Modal';
import AutoResizeTextarea from '@/shared/ui/AutoResizeTextarea';
import { btnDanger, btnPrimary, btnSecondary } from '@/shared/ui/buttonClasses';
import { useLanguage } from '@/app/i18n/useLanguage';
import { STIMULUS_AUDIO_ACCEPT, STIMULUS_IMAGE_ACCEPT, STIMULUS_VIDEO_ACCEPT } from '@/features/stimuli/domain/mediaTypes';

type StimulusKind = 'image' | 'video' | 'audio' | 'screen' | 'text' | 'web' | 'group' | 'combo';

interface AddStimulusModalProps {
  isOpen: boolean;
  onClose: () => void;
  kind: StimulusKind;
  setKind: React.Dispatch<React.SetStateAction<StimulusKind>>;
  name: string;
  setName: React.Dispatch<React.SetStateAction<string>>;
  textValue: string;
  setTextValue: React.Dispatch<React.SetStateAction<string>>;
  webUrl: string;
  setWebUrl: React.Dispatch<React.SetStateAction<string>>;
  onUploadFiles: (event: React.ChangeEvent<HTMLInputElement>) => void | Promise<void>;
  onStartScreenRecording?: (name: string) => Promise<{ ok: true; sessionId: string } | { ok: false; message?: string }>;
  onStopScreenRecording?: (sessionId: string) => Promise<{ ok: true } | { ok: false; message?: string }>;
  onAddText: () => void | Promise<void>;
  onAddWeb: () => void | Promise<void>;
  onAddGroup?: () => void | Promise<void>;
  onAddCombo?: () => void | Promise<void>;
}

const AddStimulusModal: React.FC<AddStimulusModalProps> = ({
  isOpen,
  onClose,
  kind,
  setKind,
  name,
  setName,
  textValue,
  setTextValue,
  webUrl,
  setWebUrl,
  onUploadFiles,
  onStartScreenRecording,
  onStopScreenRecording,
  onAddText,
  onAddWeb,
  onAddGroup,
  onAddCombo,
}) => {
  const { language } = useLanguage();
  const isEn = language === 'en-US';
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const screenSessionIdRef = React.useRef<string | null>(null);
  const [isScreenRecording, setIsScreenRecording] = React.useState(false);
  const [screenRecordStatus, setScreenRecordStatus] = React.useState('');
  const noFileText = isEn ? 'No file selected' : '未选择任何文件';
  const selectedFilesText = React.useCallback(
    (count: number) => (isEn ? `${count} files selected` : `已选择 ${count} 个文件`),
    [isEn],
  );
  const [selectedFileText, setSelectedFileText] = React.useState(noFileText);

  const uploadHint =
    kind === 'video'
      ? isEn
        ? 'Select video files to upload (multi-select supported).'
        : '选择视频文件上传（支持多选）。'
      : kind === 'audio'
        ? isEn
          ? 'Select MP3 or WAV audio files to upload (multi-select supported).'
          : '选择 MP3 或 WAV 音频文件上传（支持多选）。'
      : isEn
        ? 'Select image files to upload (multi-select supported).'
        : '选择图片文件上传（支持多选）。';

  React.useEffect(() => {
    if (isOpen) {
      setSelectedFileText(noFileText);
      setScreenRecordStatus('');
    } else if (screenSessionIdRef.current) {
      const sessionId = screenSessionIdRef.current;
      screenSessionIdRef.current = null;
      setIsScreenRecording(false);
      void onStopScreenRecording?.(sessionId).catch(() => {});
    }
  }, [isOpen, kind, noFileText, onStopScreenRecording]);

  const handleUploadChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) {
      setSelectedFileText(noFileText);
    } else if (files.length === 1) {
      setSelectedFileText(files[0]?.name || noFileText);
    } else {
      setSelectedFileText(selectedFilesText(files.length));
    }
    void onUploadFiles(event);
  };

  const tabBtn = (k: StimulusKind) =>
    `mrt-button-tab min-h-8 border-b-2 px-3 py-1.5 text-xs font-medium transition-colors ${
      kind === k ? 'border-sky-500 text-slate-800' : 'border-transparent text-slate-500 hover:text-slate-800'
    }`;

  const accept = kind === 'video' ? STIMULUS_VIDEO_ACCEPT : kind === 'audio' ? STIMULUS_AUDIO_ACCEPT : STIMULUS_IMAGE_ACCEPT;

  const startScreenRecording = async () => {
    if (!onStartScreenRecording) return;
    if (isScreenRecording) return;
    try {
      setScreenRecordStatus(isEn ? 'Starting screen recording...' : '正在启动录屏...');
      const result = await onStartScreenRecording((name || '').trim());
      if (!result.ok) {
        setScreenRecordStatus(isEn ? result.message || 'Failed to start screen recording.' : result.message || '录屏启动失败。');
        return;
      }
      screenSessionIdRef.current = result.sessionId;
      setIsScreenRecording(true);
      setScreenRecordStatus(isEn ? 'Recording screen. The app can be minimized now.' : '正在录制屏幕，软件可最小化后继续录制。');
    } catch (error) {
      console.error('[stimulus-screen-recording] start failed', error);
      setIsScreenRecording(false);
      setScreenRecordStatus(isEn ? 'Screen recording was canceled or failed.' : '录屏已取消或启动失败。');
    }
  };

  const stopScreenRecording = async () => {
    const sessionId = screenSessionIdRef.current;
    if (!sessionId || !onStopScreenRecording) {
      return;
    }
    screenSessionIdRef.current = null;
    setScreenRecordStatus(isEn ? 'Stopping and saving recording...' : '正在停止并保存录屏...');
    try {
      const result = await onStopScreenRecording(sessionId);
      setIsScreenRecording(false);
      if (!result.ok) {
        setScreenRecordStatus(isEn ? result.message || 'Failed to save screen recording.' : result.message || '录屏保存失败。');
        return;
      }
      setScreenRecordStatus(isEn ? 'Screen recording saved.' : '录屏已保存为刺激物。');
    } catch (error) {
      console.error('[stimulus-screen-recording] stop failed', error);
      setIsScreenRecording(false);
      setScreenRecordStatus(isEn ? 'Failed to save screen recording.' : '录屏保存失败。');
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEn ? 'Add stimulus' : '添加刺激物'}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <button
            onClick={onClose}
            className={btnSecondary}
          >
            {isEn ? 'Cancel' : '取消'}
          </button>
          {kind === 'text' ? (
            <button
              onClick={() => void onAddText()}
              className={btnPrimary}
            >
              {isEn ? 'Add' : '添加'}
            </button>
          ) : kind === 'web' ? (
            <button
              onClick={() => void onAddWeb()}
              className={btnPrimary}
            >
              {isEn ? 'Add' : '添加'}
            </button>
          ) : kind === 'group' && onAddGroup ? (
            <button
              onClick={() => void onAddGroup()}
              className={btnPrimary}
            >
              {isEn ? 'Add' : '添加'}
            </button>
          ) : kind === 'combo' && onAddCombo ? (
            <button
              onClick={() => void onAddCombo()}
              className={btnPrimary}
            >
              {isEn ? 'Add' : '添加'}
            </button>
          ) : null}
        </div>
      }
      maxWidthClassName="max-w-2xl"
    >
      <div className="space-y-5">
        <div className="flex gap-2 flex-wrap">
          <button type="button" aria-pressed={kind === 'image'} onClick={() => setKind('image')} className={tabBtn('image')}>
            {isEn ? 'Image' : '图片'}
          </button>
          <button type="button" aria-pressed={kind === 'video'} onClick={() => setKind('video')} className={tabBtn('video')}>
            {isEn ? 'Video' : '视频'}
          </button>
          <button type="button" aria-pressed={kind === 'audio'} onClick={() => setKind('audio')} className={tabBtn('audio')}>
            {isEn ? 'Audio' : '音频'}
          </button>
          <button type="button" aria-pressed={kind === 'screen'} onClick={() => setKind('screen')} className={tabBtn('screen')}>
            {isEn ? 'Standalone screen recording' : '独立录屏素材'}
          </button>
          <button type="button" aria-pressed={kind === 'text'} onClick={() => setKind('text')} className={tabBtn('text')}>
            {isEn ? 'Text' : '文字'}
          </button>
          <button type="button" aria-pressed={kind === 'web'} onClick={() => setKind('web')} className={tabBtn('web')}>
            {isEn ? 'Web URL' : 'Web 网址'}
          </button>
          <button type="button" aria-pressed={kind === 'group'} onClick={() => setKind('group')} className={tabBtn('group')}>
            {isEn ? 'Group' : '组合'}
          </button>
          <button type="button" aria-pressed={kind === 'combo'} onClick={() => setKind('combo')} className={tabBtn('combo')}>
            Combo
          </button>
        </div>

        {(kind === 'image' || kind === 'video' || kind === 'audio') && (
          <div className="space-y-3">
            <div className="text-sm text-slate-600">{uploadHint}</div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={accept}
              onChange={handleUploadChange}
              className="hidden"
            />
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className={`${btnSecondary} shrink-0`}
              >
                {isEn ? 'Select file' : '选择文件'}
              </button>
              <span className="min-w-0 text-sm text-slate-500 truncate" title={selectedFileText}>{selectedFileText}</span>
            </div>
          </div>
        )}

        {kind === 'screen' && (
          <div className="space-y-4">
            <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
              <label className="text-sm font-bold text-slate-600">{isEn ? 'Name (optional)' : '名称(可选)'}</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={isEn ? 'Auto-generate if empty' : '不填则自动生成'}
                className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-4 focus:ring-sky-500/10 focus:border-sky-500 outline-none transition-all"
              />
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-10 w-10 rounded-lg bg-slate-900 text-white flex items-center justify-center shrink-0">
                    {isScreenRecording ? <Square size={18} /> : <MonitorUp size={18} />}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-slate-800">{isEn ? 'Standalone screen recording stimulus' : '独立录屏素材'}</div>
                    <div className="text-xs text-slate-500 mt-1">{isEn ? 'Record the computer screen and save it as an MP4 stimulus.' : '录制电脑屏幕并保存为 MP4 视频刺激物。'}</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void (isScreenRecording ? stopScreenRecording() : startScreenRecording())}
                  className={isScreenRecording ? btnDanger : btnPrimary}
                >
                  {isScreenRecording ? (isEn ? 'Stop' : '停止录制') : (isEn ? 'Start' : '开始录屏')}
                </button>
              </div>
              {screenRecordStatus && (
                <div className="mt-3 text-xs text-slate-500" data-i18n-skip="true">{screenRecordStatus}</div>
              )}
            </div>
          </div>
        )}

        {kind === 'text' && (
          <div className="space-y-4">
            <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
              <label className="text-sm font-bold text-slate-600">{isEn ? 'Name (optional)' : '名称(可选)'}</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={isEn ? 'Auto-generate if empty' : '不填则自动生成'}
                className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-4 focus:ring-sky-500/10 focus:border-sky-500 outline-none transition-all"
              />
            </div>
            <div className="grid grid-cols-[100px_minmax(0,1fr)] items-start gap-4">
              <label className="text-sm font-bold text-slate-600 mt-2">{isEn ? 'Text content' : '文字内容'}</label>
              <AutoResizeTextarea
                rows={5}
                value={textValue}
                onChange={(e) => setTextValue(e.target.value)}
                placeholder={isEn ? 'Please enter display text' : '请输入要展示的文字'}
                className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-4 focus:ring-sky-500/10 focus:border-sky-500 outline-none transition-all resize-none"
              />
            </div>
          </div>
        )}

        {kind === 'web' && (
          <div className="space-y-4">
            <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
              <label className="text-sm font-bold text-slate-600">{isEn ? 'Name (optional)' : '名称(可选)'}</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={isEn ? 'Auto-generate if empty' : '不填则自动生成'}
                className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-4 focus:ring-sky-500/10 focus:border-sky-500 outline-none transition-all"
              />
            </div>
            <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
              <label className="text-sm font-bold text-slate-600">{isEn ? 'URL' : '网址'}</label>
              <input
                type="text"
                value={webUrl}
                onChange={(e) => setWebUrl(e.target.value)}
                placeholder="https://example.com"
                className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-4 focus:ring-sky-500/10 focus:border-sky-500 outline-none transition-all"
              />
            </div>
            <div className="text-[11px] text-slate-500">
              {isEn
                ? 'Note: Some websites may block embedding (X-Frame-Options).'
                : '注意：部分网站可能禁止被嵌入（X-Frame-Options）。'}
            </div>
          </div>
        )}

        {kind === 'group' && (
          <div className="space-y-4">
            <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
              <label className="text-sm font-bold text-slate-600">{isEn ? 'Group name' : '组合名称'}</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={isEn ? 'Please enter group name' : '请输入组合名称'}
                className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-4 focus:ring-sky-500/10 focus:border-sky-500 outline-none transition-all"
              />
            </div>
          </div>
        )}

        {kind === 'combo' && (
          <div className="space-y-4">
            <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
              <label className="text-sm font-bold text-slate-600">{isEn ? 'Combo name' : 'Combo 名称'}</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={isEn ? 'Auto-generate if empty' : '不填则自动生成'}
                className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-4 focus:ring-sky-500/10 focus:border-sky-500 outline-none transition-all"
              />
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              {isEn
                ? 'After adding, edit the Combo card to upload images/videos/text and set each layer size and center position.'
                : '添加后点击 Combo 卡片编辑，可上传图片/视频/文字，并设置每个图层的大小和中心位置。'}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
};

export default AddStimulusModal;
