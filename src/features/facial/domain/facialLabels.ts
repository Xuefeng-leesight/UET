const EXPRESSION_LABELS_EN: Record<string, string> = {
  左眉下压: 'Brow down left', 右眉下压: 'Brow down right', 眉心上扬: 'Inner brow raise',
  左眉外侧上扬: 'Outer brow raise left', 右眉外侧上扬: 'Outer brow raise right', 鼓腮: 'Cheek puff',
  左脸颊眯起: 'Cheek squint left', 右脸颊眯起: 'Cheek squint right', 左眼眨眼: 'Eye blink left',
  右眼眨眼: 'Eye blink right', 左眼向下看: 'Eye look down left', 右眼向下看: 'Eye look down right',
  左眼向内看: 'Eye look in left', 右眼向内看: 'Eye look in right', 左眼向外看: 'Eye look out left',
  右眼向外看: 'Eye look out right', 左眼向上看: 'Eye look up left', 右眼向上看: 'Eye look up right',
  左眼眯眼: 'Eye squint left', 右眼眯眼: 'Eye squint right', 左眼睁大: 'Eye wide left',
  右眼睁大: 'Eye wide right', 下巴前伸: 'Jaw forward', 下巴左移: 'Jaw left', 张嘴: 'Jaw open',
  下巴右移: 'Jaw right', 闭嘴: 'Mouth close', 左嘴角酒窝: 'Mouth dimple left',
  右嘴角酒窝: 'Mouth dimple right', 左嘴角下垂: 'Mouth frown left', 右嘴角下垂: 'Mouth frown right',
  嘴唇收拢: 'Mouth funnel', 嘴巴左移: 'Mouth left', 左下唇下压: 'Lower lip down left',
  右下唇下压: 'Lower lip down right', 左嘴唇紧压: 'Mouth press left', 右嘴唇紧压: 'Mouth press right',
  撅嘴: 'Mouth pucker', 嘴巴右移: 'Mouth right', 下唇内卷: 'Lower lip roll', 上唇内卷: 'Upper lip roll',
  下唇耸起: 'Lower lip shrug', 上唇耸起: 'Upper lip shrug', 左嘴角微笑: 'Mouth smile left',
  右嘴角微笑: 'Mouth smile right', 左嘴角拉伸: 'Mouth stretch left', 右嘴角拉伸: 'Mouth stretch right',
  左上唇上扬: 'Upper lip raise left', 右上唇上扬: 'Upper lip raise right', 左鼻翼皱起: 'Nose sneer left',
  右鼻翼皱起: 'Nose sneer right',
};

const BASIC_EMOTION_LABELS_EN: Record<string, string> = {
  中性: 'Neutral', 高兴: 'Happy', 悲伤: 'Sad', 愤怒: 'Angry',
  惊讶: 'Surprise', 恐惧: 'Fear', 厌恶: 'Disgust', 轻蔑: 'Contempt',
};

export function localizeFacialExpressionLabel(label: string, isEnglish: boolean): string {
  if (!isEnglish) return label;
  return EXPRESSION_LABELS_EN[label] || label;
}

export function localizeFacialAnalysisLabel(label: string, isEnglish: boolean): string {
  if (!isEnglish) return label;
  return BASIC_EMOTION_LABELS_EN[label] || EXPRESSION_LABELS_EN[label] || label;
}
