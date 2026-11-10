import type { ExtendedStimulus } from '@/shared/types/mrt';

/**
 * 播放引擎
 * 根据编号顺序和Group配置生成播放序列
 */
export class PlaybackEngine {
  private playbackSequence: string[] = [];
  private stimuliMap: Map<string, ExtendedStimulus> = new Map();

  /**
   * 生成播放序列
   * @param stimuli 刺激物列表
   * @param randomOrder 是否全局随机播放
   * @returns 播放序列（刺激物ID数组）
   */
  generatePlaybackSequence(
    stimuli: ExtendedStimulus[],
    randomOrder: boolean = false
  ): string[] {
    // 更新stimuli映射
    this.stimuliMap.clear();
    stimuli.forEach(s => this.stimuliMap.set(s.id, s));

    // 只包含激活的顶层刺激物（不属于任何Group的刺激物）
    // 注意：Group类型的刺激物也是顶层刺激物，但Group的成员不是
    const topLevelStimuli = stimuli.filter(s => 
      s.active !== false && !s.group
    );

    console.log('[PlaybackEngine] Top-level stimuli:', topLevelStimuli.map(s => ({
      name: s.name,
      type: s.stimulusType,
      order: s.order
    })));

    // 按编号排序
    const sorted = [...topLevelStimuli].sort((a, b) => (a.order || 0) - (b.order || 0));

    console.log('[PlaybackEngine] Sorted order:', sorted.map(s => `${s.order}. ${s.name} (${s.stimulusType})`));

    // 生成播放序列
    const sequence: string[] = [];

    for (const stimulus of sorted) {
      if (stimulus.stimulusType === 'group') {
        // 展开Group - 查找所有属于这个Group的成员
        const groupMembers = stimuli.filter(s => s.group === stimulus.name && s.active !== false);
        
        console.log(`[PlaybackEngine] Expanding group "${stimulus.name}" with ${groupMembers.length} members`);
        
        if (groupMembers.length === 0) {
          console.warn(`[PlaybackEngine] Group "${stimulus.name}" has no members, skipping`);
          continue;
        }
        
        const expanded = this.expandGroupSequence(stimulus, groupMembers, new Set([stimulus.id]));
        
        console.log(`[PlaybackEngine] Group "${stimulus.name}" expanded to:`, expanded.map(id => {
          const s = this.stimuliMap.get(id);
          return s ? s.name : id;
        }));
        
        if (expanded.length === 0) {
          console.warn(`[PlaybackEngine] Group "${stimulus.name}" expanded to empty sequence, skipping`);
          continue;
        }
        
        sequence.push(...expanded);
      } else {
        // 普通刺激物，直接添加
        sequence.push(stimulus.id);
      }
    }

    // 录制页开启“随机播放”时，才启用刺激物级 randomPlay 逻辑
    if (randomOrder) {
      sequence.splice(0, sequence.length, ...this.applyStimulusRandomPlay(sequence));
    }

    console.log('[PlaybackEngine] Final sequence:', sequence.map(id => {
      const s = this.stimuliMap.get(id);
      return s ? `${s.name} (${s.stimulusType})` : id;
    }));

    this.playbackSequence = sequence;
    return sequence;
  }

  /**
   * 展开Group为播放序列
   * @param group Group刺激物
   * @param groupMembers 组内成员列表
   * @returns 播放序列（刺激物ID数组）
   */
  expandGroupSequence(
    group: ExtendedStimulus,
    groupMembers: ExtendedStimulus[],
    seenGroups: Set<string> = new Set([group.id])
  ): string[] {
    if (groupMembers.length === 0) {
      return [];
    }

    const mode = group.groupPlayMode || 'all-sequential';

    let sequence: string[] = [];
    switch (mode) {
      case 'all-sequential':
        // 全部展示-顺序：按组内编号升序
        sequence = this.expandAllSequential(groupMembers, seenGroups);
        break;

      case 'all-random':
        // 全部展示-随机：包含所有素材但顺序随机
        sequence = this.expandAllRandom(groupMembers, seenGroups);
        break;

      case 'random-sample':
        // 随机播放：随机抽样指定数量
        sequence = this.expandRandomSample(groupMembers, group.groupRandomCount || 1, seenGroups);
        break;

      case 'repeat':
        // 重复播放：重复指定次数
        sequence = this.expandRepeat(groupMembers, group.groupRepeatCount || 1, seenGroups);
        break;

      default:
        sequence = this.expandAllSequential(groupMembers, seenGroups);
    }

    // 如果Group有trigger标记，在第一个成员前添加特殊标记
    // 使用特殊前缀 "GROUP_TRIGGER:" 来标识这是Group的trigger
    if (group.triggerEnabled && group.triggerMark !== undefined && sequence.length > 0) {
      // 在stimuliMap中存储Group的trigger信息，使用特殊ID
      const triggerMarkerId = `GROUP_TRIGGER:${group.id}`;
      this.stimuliMap.set(triggerMarkerId, group);
      sequence.unshift(triggerMarkerId);
    }

    return sequence;
  }

  /**
   * 全部展示-顺序模式
   */
  private expandStimulus(stimulus: ExtendedStimulus, seenGroups: Set<string>): string[] {
    if (stimulus.stimulusType !== 'group') return [stimulus.id];
    if (seenGroups.has(stimulus.id)) {
      console.warn(`[PlaybackEngine] Skipping recursive group "${stimulus.name}"`);
      return [];
    }
    const nestedMembers = Array.from(this.stimuliMap.values()).filter(s => s.group === stimulus.name && s.active !== false);
    if (nestedMembers.length === 0) return [];
    return this.expandGroupSequence(stimulus, nestedMembers, new Set([...seenGroups, stimulus.id]));
  }

  private expandMembers(members: ExtendedStimulus[], seenGroups: Set<string>): string[] {
    return members.flatMap(member => this.expandStimulus(member, seenGroups));
  }

  private expandAllSequential(members: ExtendedStimulus[], seenGroups: Set<string>): string[] {
    const sorted = [...members].sort((a, b) => (a.groupInternalOrder || 0) - (b.groupInternalOrder || 0));
    return this.expandMembers(sorted, seenGroups);
  }

  /**
   * 全部展示-随机模式
   */
  private expandAllRandom(members: ExtendedStimulus[], seenGroups: Set<string>): string[] {
    const shuffled = [...members];
    this.shuffleArray(shuffled);
    return this.expandMembers(shuffled, seenGroups);
  }

  /**
   * 随机抽样模式
   */
  private expandRandomSample(members: ExtendedStimulus[], count: number, seenGroups: Set<string>): string[] {
    const shuffled = [...members];
    this.shuffleArray(shuffled);
    return this.expandMembers(shuffled.slice(0, Math.min(count, shuffled.length)), seenGroups);
  }

  /**
   * 重复播放模式
   */
  private expandRepeat(members: ExtendedStimulus[], times: number, seenGroups: Set<string>): string[] {
    const sequential = this.expandAllSequential(members, seenGroups);
    const result: string[] = [];
    for (let i = 0; i < times; i++) {
      result.push(...sequential);
    }
    return result;
  }

  /**
   * 获取下一个播放项
   * @param currentIndex 当前播放索引
   * @returns 下一个刺激物ID或null
   */
  getNextPlaybackItem(currentIndex: number): string | null {
    if (currentIndex < 0 || currentIndex >= this.playbackSequence.length - 1) {
      return null;
    }
    return this.playbackSequence[currentIndex + 1];
  }

  /**
   * Fisher-Yates 洗牌算法
   */
  private shuffleArray<T>(array: T[]): void {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  /**
   * 仅随机刺激物级 randomPlay=true 的项目，其他项目保持原位置不变。
   */
  private applyStimulusRandomPlay(sequence: string[]): string[] {
    if (sequence.length <= 1) return [...sequence];

    const next = [...sequence];
    const positions: number[] = [];
    const randomIds: string[] = [];

    for (let i = 0; i < next.length; i += 1) {
      const id = next[i];
      if (typeof id !== 'string' || id.startsWith('GROUP_TRIGGER:')) continue;
      const stim = this.stimuliMap.get(id);
      if (!stim || stim.randomPlay !== true) continue;
      positions.push(i);
      randomIds.push(id);
    }

    if (randomIds.length <= 1) return next;

    this.shuffleArray(randomIds);
    positions.forEach((pos, idx) => {
      next[pos] = randomIds[idx];
    });
    return next;
  }

  /**
   * 获取当前播放序列
   */
  getPlaybackSequence(): string[] {
    return [...this.playbackSequence];
  }
}

// 导出单例实例
export const playbackEngine = new PlaybackEngine();
