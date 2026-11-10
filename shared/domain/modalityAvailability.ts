import type { ModalityId } from '../contracts/domain/models';

/** 全部模块 id（含未开放的）。用 Record 写，ModalityId 新增 id 时漏写这里会报类型错误。 */
const MODALITY_ID_FLAGS: Record<ModalityId, true> = {
  'eye-tracking': true,
  'facial-expression': true,
  behavior: true,
  eeg: true,
  physiology: true,
  fnirs: true,
  'finger-trajectory': true,
};

export const ALL_MODALITY_IDS = Object.keys(MODALITY_ID_FLAGS) as ModalityId[];

/** 已开放的模块。接入新模块后，把它的 id 加进来，创建工程时就能勾选。 */
export const AVAILABLE_MODALITIES: ReadonlySet<ModalityId> = new Set<ModalityId>([
  'eye-tracking',
  'facial-expression',
]);

export const isModalityAvailable = (id: ModalityId): boolean => AVAILABLE_MODALITIES.has(id);
