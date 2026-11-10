import type { ExtendedStimulus } from '@/shared/types/mrt';

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | null => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
};

const COMBO_CANVAS_STYLES = new Set<NonNullable<ExtendedStimulus['comboCanvasStyle']>>([
  'fullscreen',
  'landscape',
  'classic',
  'square',
  'portrait',
]);

const normalizeComboCanvasStyle = (value: unknown): ExtendedStimulus['comboCanvasStyle'] => {
  return typeof value === 'string'
    && COMBO_CANVAS_STYLES.has(value as NonNullable<ExtendedStimulus['comboCanvasStyle']>)
    ? value as NonNullable<ExtendedStimulus['comboCanvasStyle']>
    : undefined;
};

/**
 * 数据迁移服务
 * 处理旧版本数据到新版本的迁移
 */
export class DataMigration {
  /**
   * 迁移刺激物数据到新版本
   * @param oldData 旧版本数据
   * @returns 迁移后的刺激物列表
   */
  migrateStimuli(oldData: unknown): ExtendedStimulus[] {
    const data = asRecord(oldData);
    if (!data || !Array.isArray(data.stimuli)) {
      return [];
    }

    const version = this.checkVersion(data);
    
    if (version === '2.0') {
      // 2.0 数据已经过当前版本保存，保持原对象与扩展字段不变。
      return data.stimuli as ExtendedStimulus[];
    }

    // 迁移旧版本数据
    return data.stimuli.map((stimulus, index) => {
      const record = asRecord(stimulus);
      return this.applyDefaults(record ?? {}, index);
    });
  }

  /**
   * 检查数据版本
   * @param data 数据对象
   * @returns 版本号
   */
  checkVersion(data: unknown): string {
    const version = asRecord(data)?.version;
    return typeof version === 'string' && version ? version : '1.0';
  }

  /**
   * 应用默认值
   * @param stimulus 部分刺激物数据
   * @param index 索引（用于分配默认编号）
   * @returns 完整的刺激物数据
   */
  applyDefaults(stimulus: Partial<ExtendedStimulus>, index: number): ExtendedStimulus {
    const legacyStimulus = stimulus as unknown as UnknownRecord;
    const stimulusType = stimulus.stimulusType || 'image';
    let playToEnd = false;
    if (stimulusType === 'video' || stimulusType === 'audio') {
      const raw = legacyStimulus.playToEnd;
      if (raw == null) {
        playToEnd = true;
      } else if (typeof raw === 'boolean') {
        playToEnd = raw;
      } else if (typeof raw === 'number') {
        playToEnd = raw === 1;
      } else if (typeof raw === 'string') {
        const v = raw.trim().toLowerCase();
        playToEnd = v === 'true' || v === '1' || v === 'yes' || v === 'on';
      } else {
        playToEnd = true;
      }
    }

    return {
      // 必需字段
      id: stimulus.id || `stim_${Date.now()}_${index}`,
      name: stimulus.name || `刺激物${index + 1}`,
      url: stimulus.url || '',
      size: stimulus.size || '0 KB',
      date: stimulus.date || new Date().toISOString().slice(0, 10),
      
      // 编号字段（新增）
      order: stimulus.order !== undefined ? stimulus.order : index + 1,
      
      // 可选字段
      active: stimulus.active !== undefined ? stimulus.active : true,
      stimulusType,
      fixedTimeMs: stimulus.fixedTimeMs,
      playToEnd,
      text: stimulus.text,
      bgColor: stimulus.bgColor,
      fontSize: stimulus.fontSize,
      fontColor: stimulus.fontColor,
      externalMarker: stimulus.externalMarker,
      endOnClick: stimulus.endOnClick,
      endOnKey: stimulus.endOnKey,
      
      // 保留旧的group字段但不在UI中显示
      group: stimulus.group,
      
      // 新增字段的默认值
      randomPlay: stimulus.randomPlay || false,
      triggerEnabled: stimulus.triggerEnabled || false,
      triggerMark: stimulus.triggerMark,
      groupPlayMode: stimulus.groupPlayMode || 'all-sequential',
      groupRandomCount: stimulus.groupRandomCount || 1,
      groupRepeatCount: stimulus.groupRepeatCount || 1,
      groupInternalOrder: stimulus.groupInternalOrder,
      comboItems: Array.isArray(stimulus.comboItems) ? stimulus.comboItems : undefined,
      comboCanvasStyle: normalizeComboCanvasStyle(stimulus.comboCanvasStyle),
    };
  }

  /**
   * 准备保存数据（添加版本号）
   * @param stimuli 刺激物列表
   * @returns 包含版本号的数据对象
   */
  prepareSaveData(stimuli: ExtendedStimulus[]): { version: string; stimuli: ExtendedStimulus[] } {
    return {
      version: '2.0',
      stimuli,
    };
  }
}

// 导出单例实例
export const dataMigration = new DataMigration();
