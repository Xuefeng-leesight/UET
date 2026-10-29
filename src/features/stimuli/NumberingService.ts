import type { ExtendedStimulus } from '@/shared/types/mrt';

/**
 * 编号管理服务
 * 负责刺激物编号的分配、更新和重新计算
 */
export class NumberingService {
  /**
   * 为新上传的刺激物分配编号
   * @param stimuli 当前刺激物列表
   * @param newItems 新上传的刺激物
   * @returns 更新后的刺激物列表
   */
  assignNumbers(
    stimuli: ExtendedStimulus[],
    newItems: ExtendedStimulus[]
  ): ExtendedStimulus[] {
    // 找到当前最大编号
    const maxOrder = stimuli.reduce((max, s) => Math.max(max, s.order || 0), 0);
    
    // 为新项分配编号
    const numberedNewItems = newItems.map((item, index) => ({
      ...item,
      order: maxOrder + index + 1,
    }));
    
    return [...stimuli, ...numberedNewItems];
  }

  /**
   * 删除后重新计算编号
   * @param stimuli 当前刺激物列表
   * @param deletedId 被删除的刺激物ID
   * @returns 更新后的刺激物列表
   */
  recalculateAfterDelete(
    stimuli: ExtendedStimulus[],
    deletedId: string
  ): ExtendedStimulus[] {
    // 过滤掉被删除的项
    const remaining = stimuli.filter(s => s.id !== deletedId);
    
    // 按当前order排序
    remaining.sort((a, b) => (a.order || 0) - (b.order || 0));
    
    // 重新分配编号（从1开始）
    return remaining.map((item, index) => ({
      ...item,
      order: index + 1,
    }));
  }

  /**
   * 交换两个刺激物的编号
   * @param stimuli 当前刺激物列表
   * @param id1 第一个刺激物ID
   * @param id2 第二个刺激物ID
   * @returns 更新后的刺激物列表
   */
  swapNumbers(
    stimuli: ExtendedStimulus[],
    id1: string,
    id2: string
  ): ExtendedStimulus[] {
    const item1 = stimuli.find(s => s.id === id1);
    const item2 = stimuli.find(s => s.id === id2);
    
    if (!item1 || !item2) {
      return stimuli;
    }
    
    const order1 = item1.order || 0;
    const order2 = item2.order || 0;
    
    // 交换编号
    return stimuli.map(item => {
      if (item.id === id1) {
        return { ...item, order: order2 };
      }
      if (item.id === id2) {
        return { ...item, order: order1 };
      }
      return item;
    });
  }

  /**
   * 为组内素材分配编号
   * @param stimuli 当前刺激物列表
   * @param groupName 组名
   * @returns 更新后的刺激物列表
   */
  assignGroupInternalNumbers(
    stimuli: ExtendedStimulus[],
    groupName: string
  ): ExtendedStimulus[] {
    // 找到该组的所有成员
    const groupMembers = stimuli.filter(s => s.group === groupName);
    
    // 按当前groupInternalOrder排序（如果有的话）
    groupMembers.sort((a, b) => (a.groupInternalOrder || 0) - (b.groupInternalOrder || 0));
    
    // 创建ID到新编号的映射
    const orderMap = new Map<string, number>();
    groupMembers.forEach((member, index) => {
      orderMap.set(member.id, index + 1);
    });
    
    // 更新刺激物列表
    return stimuli.map(item => {
      if (item.group === groupName && orderMap.has(item.id)) {
        return { ...item, groupInternalOrder: orderMap.get(item.id) };
      }
      return item;
    });
  }
}

// 导出单例实例
export const numberingService = new NumberingService();
