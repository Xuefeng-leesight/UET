import React, { useState } from 'react';
import { Layers3 } from 'lucide-react';
import CustomSelect from '@/shared/ui/CustomSelect';
import { Modal } from '@/shared/ui/Modal';
import AutoResizeTextarea from '@/shared/ui/AutoResizeTextarea';
import { btnPrimary, btnSecondary } from '@/shared/ui/buttonClasses';
import { triggerService } from '@/features/recording/TriggerService';
import ComboStimulusEditor from '@/features/stimuli/ComboStimulusEditor';
import type { ComboStimulusItem } from '@/shared/types/mrt';
import { useLanguage } from '@/app/i18n/useLanguage';

interface EditStimulusModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: () => void | Promise<void>;
  editStimulusName: string;
  setEditStimulusName: React.Dispatch<React.SetStateAction<string>>;
  stimulusNameLocked?: boolean;
  editStimulusFixedTimeSec: string;
  setEditStimulusFixedTimeSec: React.Dispatch<React.SetStateAction<string>>;
  editStimulusActive: boolean;
  setEditStimulusActive: React.Dispatch<React.SetStateAction<boolean>>;
  bgColor: string;
  setBgColor: React.Dispatch<React.SetStateAction<string>>;
  externalMarker: boolean;
  setExternalMarker: React.Dispatch<React.SetStateAction<boolean>>;
  endOnClick: boolean;
  setEndOnClick: React.Dispatch<React.SetStateAction<boolean>>;
  endOnKey: boolean;
  setEndOnKey: React.Dispatch<React.SetStateAction<boolean>>;
  group?: string;
  setGroup?: React.Dispatch<React.SetStateAction<string>>;
  fontSize?: number;
  setFontSize?: React.Dispatch<React.SetStateAction<number>>;
  fontColor?: string;
  setFontColor?: React.Dispatch<React.SetStateAction<string>>;
  stimulusType?: string;
  textValue?: string;
  setTextValue?: React.Dispatch<React.SetStateAction<string>>;
  webUrl?: string;
  setWebUrl?: React.Dispatch<React.SetStateAction<string>>;
  
  // 新增字段
  randomPlay?: boolean;
  setRandomPlay?: React.Dispatch<React.SetStateAction<boolean>>;
  triggerEnabled?: boolean;
  setTriggerEnabled?: React.Dispatch<React.SetStateAction<boolean>>;
  triggerMark?: number | null;
  setTriggerMark?: React.Dispatch<React.SetStateAction<number | null>>;
  groupPlayMode?: 'all-sequential' | 'all-random' | 'random-sample' | 'repeat';
  setGroupPlayMode?: React.Dispatch<React.SetStateAction<string>>;
  groupRandomCount?: number;
  setGroupRandomCount?: React.Dispatch<React.SetStateAction<number>>;
  groupRepeatCount?: number;
  setGroupRepeatCount?: React.Dispatch<React.SetStateAction<number>>;
  editStimulusPlayToEnd?: boolean;
  setEditStimulusPlayToEnd?: React.Dispatch<React.SetStateAction<boolean>>;
  comboItems?: ComboStimulusItem[];
  setComboItems?: React.Dispatch<React.SetStateAction<ComboStimulusItem[]>>;
  comboCanvasStyle?: 'fullscreen' | 'landscape' | 'classic' | 'square' | 'portrait';
  setComboCanvasStyle?: React.Dispatch<React.SetStateAction<'fullscreen' | 'landscape' | 'classic' | 'square' | 'portrait'>>;
  onUploadComboFiles?: (event: React.ChangeEvent<HTMLInputElement>) => void | Promise<void>;
  onStartComboScreenRecording?: (name: string) => Promise<{ ok: true; sessionId: string } | { ok: false; message?: string }>;
  onStopComboScreenRecording?: (sessionId: string) => Promise<{ ok: true; asset?: unknown } | { ok: false; message?: string }>;
}

const EditStimulusModal: React.FC<EditStimulusModalProps> = ({
  isOpen,
  onClose,
  onSave,
  editStimulusName,
  setEditStimulusName,
  stimulusNameLocked = false,
  editStimulusFixedTimeSec,
  setEditStimulusFixedTimeSec,
  editStimulusActive,
  setEditStimulusActive,
  bgColor,
  setBgColor,
  externalMarker,
  setExternalMarker,
  endOnClick,
  setEndOnClick,
  endOnKey,
  setEndOnKey,
  group: _group,
  setGroup: _setGroup,
  fontSize = 48,
  setFontSize,
  fontColor = '#ffffff',
  setFontColor,
  stimulusType,
  textValue,
  setTextValue,
  webUrl = '',
  setWebUrl,
  randomPlay = false,
  setRandomPlay,
  triggerEnabled = false,
  setTriggerEnabled,
  triggerMark = null,
  setTriggerMark,
  groupPlayMode = 'all-sequential',
  setGroupPlayMode,
  groupRandomCount = 1,
  setGroupRandomCount,
  groupRepeatCount = 1,
  setGroupRepeatCount,
  editStimulusPlayToEnd = false,
  setEditStimulusPlayToEnd,
  comboItems = [],
  setComboItems,
  comboCanvasStyle = 'landscape',
  setComboCanvasStyle,
  onUploadComboFiles,
  onStartComboScreenRecording,
  onStopComboScreenRecording,
}) => {
  const { language } = useLanguage();
  const isEn = language === 'en-US';
  const t = {
    name: isEn ? 'Name' : '名称',
    namePlaceholder: isEn ? 'Please enter stimulus name' : '请输入刺激物名称',
    textContent: isEn ? 'Text content' : '文字内容',
    textPlaceholder: isEn ? 'Please enter display text' : '请输入要展示的文字',
    bgOrFont: isEn ? 'Background/Font' : '背景/字体',
    bgColor: isEn ? 'Background color' : '背景颜色',
    fontSize: isEn ? 'Text size' : '文字大小',
    playMode: isEn ? 'Play mode' : '播放方式',
    playToEndVideo: isEn ? 'Switch after video finishes' : '视频播放完成后再切换',
    playToEndAudio: isEn ? 'Switch after audio finishes' : '音频播放完成后再切换',
    fixedDuration: isEn ? 'Fixed duration (s)' : '固定时间(秒)',
    fixedDurationPlaceholder: isEn ? '0 means use default' : '0 表示使用默认',
    fixedDurationDisabledHint: isEn
      ? 'Play done then switch is enabled; fixed duration is disabled.'
      : '已启用“播放完成后切换”，固定时间输入已禁用。',
    groupPlaySettings: isEn ? 'Group playback settings' : 'Group播放设置',
    groupPlayMode: isEn ? 'Play mode' : '播放模式',
    groupPlayAllSequential: isEn ? 'All sequential' : '全部展示-顺序',
    groupPlayAllRandom: isEn ? 'All random' : '全部展示-随机',
    groupPlayRandomSample: isEn ? 'Random sample' : '随机播放',
    groupPlayRepeat: isEn ? 'Repeat' : '重复播放',
    sampleCount: isEn ? 'Sample count' : '抽样数量',
    repeatCount: isEn ? 'Repeat count' : '重复次数',
    triggerSettings: isEn ? 'Trigger settings' : '触发设置',
    trigger: isEn ? 'Trigger' : '触发',
    enableTrigger: isEn ? 'Enable trigger marker output' : '启用触发外发标记',
    triggerMarker: isEn ? 'Trigger marker' : '触发标记',
    triggerMarkerPlaceholder: isEn ? 'Enter a number between 0 and 65535' : '输入0-65535之间的数字',
    groupTriggerHint: isEn
      ? 'The group trigger marker is sent before the first group item plays.'
      : '分组的触发标记会在播放第一个组成员前发送',
    comboLayers: isEn ? 'Combo layers' : 'Combo 图层',
  } as const;
  const [triggerMarkInput, setTriggerMarkInput] = useState(triggerMark?.toString() || '');
  const [triggerMarkError, setTriggerMarkError] = useState<string | null>(null);
  const [isComboEditorOpen, setIsComboEditorOpen] = useState(false);

  // 同步triggerMark prop到本地状态
  React.useEffect(() => {
    setTriggerMarkInput(triggerMark?.toString() || '');
    setTriggerMarkError(null);
  }, [triggerMark, isOpen]);

  const handleTriggerMarkChange = (value: string) => {
    setTriggerMarkInput(value);
    
    if (!value.trim()) {
      setTriggerMarkError(null);
      setTriggerMark?.(null);
      return;
    }
    
    const error = triggerService.validateTriggerMark(value);
    if (error) {
      setTriggerMarkError(error.message);
    } else {
      setTriggerMarkError(null);
      setTriggerMark?.(Number(value));
    }
  };

  const isGroupType = stimulusType === 'group';
  const isVideoType = stimulusType === 'video' || stimulusType === 'audio';
  const playToEndLabel = stimulusType === 'audio' ? t.playToEndAudio : t.playToEndVideo;
  const isComboType = stimulusType === 'combo';
  const fixedTimeDisabled = isVideoType && editStimulusPlayToEnd;
  return (
    <>
    <Modal
      isOpen={isOpen && !isComboEditorOpen}
      onClose={onClose}
      title={isEn ? 'Edit stimulus' : '编辑刺激物'}
      maxWidthClassName={isComboType ? 'max-w-4xl' : undefined}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <button
            onClick={onClose}
            className={btnSecondary}
          >
            {isEn ? 'Cancel' : '取消'}
          </button>
          <button
            onClick={() => void onSave()}
            className={btnPrimary}
          >
            {isEn ? 'Save' : '保存'}
          </button>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
          <label className="text-sm font-bold text-slate-600">{t.name}</label>
          <input
            type="text"
            placeholder={t.namePlaceholder}
            value={editStimulusName}
            onChange={(e) => setEditStimulusName(e.target.value)}
            disabled={stimulusNameLocked}
            title={stimulusNameLocked ? (isEn ? 'This stimulus is used by recorded data and cannot be renamed.' : '该素材已在记录中使用，不能修改名称。') : undefined}
            className={`px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none transition-all ${
              stimulusNameLocked
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                : 'bg-slate-50 focus:ring-4 focus:ring-sky-500/10 focus:border-sky-500'
            }`}
          />
          {stimulusNameLocked && (
            <div className="col-start-2 -mt-4 text-xs text-amber-600">
              {isEn ? 'The name is locked because this stimulus is already used by recorded data.' : '该素材已在记录中使用，名称不可修改。'}
            </div>
          )}
        </div>

        {stimulusType === 'text' && setTextValue && (
          <div className="grid grid-cols-[100px_minmax(0,1fr)] items-start gap-4">
            <label className="text-sm font-bold text-slate-600 pt-2">{t.textContent}</label>
            <AutoResizeTextarea
              rows={5}
              value={textValue || ''}
              onChange={(e) => setTextValue(e.target.value)}
              placeholder={t.textPlaceholder}
              className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-4 focus:ring-sky-500/10 focus:border-sky-500 outline-none transition-all resize-none"
            />
          </div>
        )}

        {stimulusType === 'web' && setWebUrl && (
          <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
            <label className="text-sm font-bold text-slate-600">{isEn ? 'URL' : '网址'}</label>
            <input
              type="text"
              value={webUrl}
              onChange={(event) => setWebUrl(event.target.value)}
              placeholder="https://example.com"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm outline-none transition-all focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10"
            />
          </div>
        )}

        {isComboType && setComboItems && (
          <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
            <label className="text-sm font-bold text-slate-600">{t.comboLayers}</label>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => setIsComboEditorOpen(true)}
                className={btnSecondary}
              >
                <Layers3 size={16} />
                {isEn ? 'Edit Combo layers' : '编辑 Combo 图层'}
              </button>
              <span className="text-sm text-slate-500">{comboItems.length} {isEn ? 'layers' : '个图层'}</span>
            </div>
          </div>
        )}

        {/* 移除分组字段 */}
        
        {/* 背景颜色 - 只对非Group类型显示 */}
        {!isGroupType && (
          <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
            <label className="text-sm font-bold text-slate-600">
              {stimulusType === 'text' ? t.bgOrFont : t.bgColor}
            </label>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={bgColor}
                  onChange={(e) => setBgColor(e.target.value)}
                  className="h-10 w-20 cursor-pointer rounded border border-slate-200"
                />
                <span className="text-sm text-slate-500">{bgColor}</span>
              </div>
              {stimulusType === 'text' && setFontColor && (
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={fontColor}
                    onChange={(e) => setFontColor(e.target.value)}
                    className="h-10 w-20 cursor-pointer rounded border border-slate-200"
                  />
                  <span className="text-sm text-slate-500">{fontColor}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {stimulusType === 'text' && setFontSize && (
          <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
            <label className="text-sm font-bold text-slate-600">{t.fontSize}</label>
            <input
              type="number"
              min="12"
              max="200"
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
              className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-4 focus:ring-sky-500/10 focus:border-sky-500 outline-none transition-all"
            />
          </div>
        )}
        
        {/* 固定时间 - 只对非Group类型显示 */}
        {!isGroupType && (
          <>
            {isVideoType && setEditStimulusPlayToEnd && (
              <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
                <label className="text-sm font-bold text-slate-600">{t.playMode}</label>
                <label className="inline-flex items-center gap-2 text-sm text-slate-700 select-none">
                  <input
                    type="checkbox"
                    checked={editStimulusPlayToEnd}
                    onChange={(e) => setEditStimulusPlayToEnd(e.target.checked)}
                    className="accent-sky-500"
                  />
                  {playToEndLabel}
                </label>
              </div>
            )}
            <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
              <label className="text-sm font-bold text-slate-600">{t.fixedDuration}</label>
              <div>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  placeholder={t.fixedDurationPlaceholder}
                  value={editStimulusFixedTimeSec}
                  onChange={(e) => setEditStimulusFixedTimeSec(e.target.value)}
                  disabled={fixedTimeDisabled}
                  className={`w-full px-4 py-2.5 rounded-xl text-sm outline-none transition-all ${
                    fixedTimeDisabled
                      ? 'bg-slate-100 border border-slate-200 text-slate-400 cursor-not-allowed'
                      : 'bg-slate-50 border border-slate-200 focus:ring-4 focus:ring-sky-500/10 focus:border-sky-500'
                  }`}
                />
                {fixedTimeDisabled && (
                  <p className="text-xs text-slate-500 mt-1">{t.fixedDurationDisabledHint}</p>
                )}
              </div>
            </div>
          </>
        )}
        
        {/* Group播放模式配置 */}
        {isGroupType && setGroupPlayMode && (
          <>
            <div className="border-t border-slate-200 pt-5">
              <h3 className="text-sm font-bold text-slate-700 mb-4">{t.groupPlaySettings}</h3>
            </div>
            
            <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
              <label className="text-sm font-bold text-slate-600">{t.groupPlayMode}</label>
              <CustomSelect
                value={groupPlayMode}
                onChange={(e) => setGroupPlayMode(e.target.value)}
                className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-4 focus:ring-sky-500/10 focus:border-sky-500 outline-none transition-all"
              >
                <option value="all-sequential">{t.groupPlayAllSequential}</option>
                <option value="all-random">{t.groupPlayAllRandom}</option>
                <option value="random-sample">{t.groupPlayRandomSample}</option>
                <option value="repeat">{t.groupPlayRepeat}</option>
              </CustomSelect>
            </div>
            
            {groupPlayMode === 'random-sample' && setGroupRandomCount && (
              <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
                <label className="text-sm font-bold text-slate-600">{t.sampleCount}</label>
                <input
                  type="number"
                  min="1"
                  value={groupRandomCount}
                  onChange={(e) => setGroupRandomCount(Number(e.target.value))}
                  className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-4 focus:ring-sky-500/10 focus:border-sky-500 outline-none transition-all"
                />
              </div>
            )}
            
            {groupPlayMode === 'repeat' && setGroupRepeatCount && (
              <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
                <label className="text-sm font-bold text-slate-600">{t.repeatCount}</label>
                <input
                  type="number"
                  min="1"
                  value={groupRepeatCount}
                  onChange={(e) => setGroupRepeatCount(Number(e.target.value))}
                  className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-4 focus:ring-sky-500/10 focus:border-sky-500 outline-none transition-all"
                />
              </div>
            )}
          </>
        )}
        
        {/* 触发配置 */}
        <div className="border-t border-slate-200 pt-5">
          <h3 className="text-sm font-bold text-slate-700 mb-4">{t.triggerSettings}</h3>
        </div>
        
        <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
          <label className="text-sm font-bold text-slate-600">{t.trigger}</label>
          <label className="inline-flex items-center gap-2 text-sm text-slate-700 select-none">
            <input
              type="checkbox"
              checked={triggerEnabled}
              onChange={(e) => setTriggerEnabled?.(e.target.checked)}
              className="accent-sky-500"
            />
            {t.enableTrigger}
          </label>
        </div>
        
        {triggerEnabled && setTriggerMark && (
          <div className="grid grid-cols-[100px_minmax(0,1fr)] items-start gap-4">
            <label className="text-sm font-bold text-slate-600 pt-2">{t.triggerMarker}</label>
            <div className="flex-1">
              <input
                type="text"
                placeholder={t.triggerMarkerPlaceholder}
                value={triggerMarkInput}
                onChange={(e) => handleTriggerMarkChange(e.target.value)}
                className={`w-full px-4 py-2.5 bg-slate-50 border rounded-xl text-sm focus:ring-4 focus:ring-sky-500/10 outline-none transition-all ${
                  triggerMarkError ? 'border-rose-500' : 'border-slate-200 focus:border-sky-500'
                }`}
              />
              {triggerMarkError && (
                <p className="text-xs text-rose-500 mt-1">{triggerMarkError}</p>
              )}
              {isGroupType && (
                <p className="text-xs text-slate-500 mt-1">{t.groupTriggerHint}</p>
              )}
            </div>
          </div>
        )}
        
        <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-4">
          <label className="text-sm font-bold text-slate-600">{isEn ? 'Options' : '选项'}</label>
          <div className="flex flex-col gap-2">
            <label className="inline-flex items-center gap-2 text-sm text-slate-700 select-none">
              <input
                type="checkbox"
                checked={editStimulusActive}
                onChange={(e) => setEditStimulusActive(e.target.checked)}
                className="accent-sky-500"
              />
              {isEn ? 'Active' : '激活'}
            </label>
            {!isGroupType && setRandomPlay && (
              <label className="inline-flex items-center gap-2 text-sm text-slate-700 select-none">
                <input
                  type="checkbox"
                  checked={randomPlay}
                onChange={(e) => setRandomPlay(e.target.checked)}
                className="accent-sky-500"
              />
                {isEn ? 'Random play' : '随机播放'}
              </label>
            )}
            <label className="inline-flex items-center gap-2 text-sm text-slate-700 select-none">
              <input
                type="checkbox"
                checked={endOnClick}
                onChange={(e) => setEndOnClick(e.target.checked)}
                className="accent-sky-500"
              />
              {isEn ? 'Click to play next asset' : '点击播放下一个素材'}
            </label>
            <label className="inline-flex items-center gap-2 text-sm text-slate-700 select-none">
              <input
                type="checkbox"
                checked={endOnKey}
                onChange={(e) => setEndOnKey(e.target.checked)}
                className="accent-sky-500"
              />
              {isEn ? 'Press ESC to finish' : '按键ESC结束'}
            </label>
          </div>
        </div>
        <div className="text-[11px] text-slate-500">
          {isEn
            ? 'Fixed duration controls automatic switching during recording; video and audio can switch after playback finishes.'
            : '固定时间用于录制时刺激物自动切换；视频和音频可改为“播放完成后切换”。'}
        </div>
      </div>
    </Modal>
    {isComboType && setComboItems && setComboCanvasStyle && (
      <ComboStimulusEditor
        isOpen={isOpen && isComboEditorOpen}
        isEn={isEn}
        items={comboItems}
        setItems={setComboItems}
        bgColor={bgColor}
        canvasStyle={comboCanvasStyle}
        setCanvasStyle={setComboCanvasStyle}
        onClose={() => setIsComboEditorOpen(false)}
        onUploadFiles={onUploadComboFiles}
        onStartScreenRecording={onStartComboScreenRecording}
        onStopScreenRecording={onStopComboScreenRecording}
      />
    )}
    </>
  );
};

export default EditStimulusModal;
