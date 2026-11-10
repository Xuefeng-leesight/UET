# Pupil 实验数据完整性与注视准确性诊断方案

日期：2026-10-09。输入为用户提供的 `pupil/` 工程及 `mrt-video-debug-2026-10-09.log`。仅只读分析，未修改实验原件、未重写 CSV、未提交用户实验数据。本报告保留原始诊断与分阶段方案；最新实施状态见下节，未完成项目不得视为已经修复。

## 当前实施状态（2026-10-09）

已修复保存工具链、源视频比例与黑边坐标转换；已完成 Natural Feature 场景逐帧追踪、追踪丢失/分辨率变化重试、源时间窗口筛选、三点退化覆盖检查和录制校准审计附档。授权开关与华弘 SDK 目录整理另有独立提交。

P0 中 gaze.base_data 瞳孔精确配对、采样率元数据覆盖、事件阈值和历史 CSV 派生恢复尚未实施；P1 独立精度验证及相机内参归档、P2 Player 导出、P3 Windows 真机对照也未完成。新的光流修复不能恢复历史缺失数据，也不能证明原始 Capture 偏差已经消失。

## 1. 实测数据

| 录制时间 | 时长 | 保存状态 | CSV 行数 | 原始 gaze 数 | 在场景内且 confidence≥0.6 |
|---|---:|---|---:|---:|---:|
| 10:42:24 | 25.433 秒 | failed：缺失校验工具 | 0 | 6272 | 4111（65.55%） |
| 10:56:23 | 21.067 秒 | failed：旧 FFmpeg 参数不兼容 | 0 | 5181 | 2554（49.30%） |
| 11:04:26 | 13 秒 | complete | 3204 | 3204 | 675（21.07%） |

前两次 CSV 为空发生在校验失败之后，附档 gaze-spool、normalized-samples 和原始 msgpack 均有数据。修复保存工具链不能自动修复这些历史 CSV，必须从保留附档生成派生恢复版本并保留原件；也不能恢复原始采集阶段已经丢失的数据。

最新录制 3204 条 gaze 的互斥分类：1531 条坐标超出 [0,1]（不再按低 confidence 重复计数），998 条在场景内但 confidence<0.6，675 条有效。视野外不必然代表错误，但结合用户报告，说明不能把 UI 平移/缩放作为唯一解释。

## 2. 空字段逐项归因

### gaze 坐标空

归一化层保留源坐标，但 CSV 对低置信度、视野外样本不输出可用 gaze 坐标。这是空值的一部分来源，不应靠降低置信度阈值或将坐标裁到画面边缘来掩盖。建议兼容字段继续表明不可用，同时增加 source_norm_pos、invalid_reason，明确区分低置信度、视野外、未提供。

### 瞳孔直径空：已确认配对缺陷

`pupil_recorder.py` 按收到消息的顺序，仅缓存左右眼最后一个 pupil；`pupil_csv.py` 只接受相对 gaze 时间 0–100 ms 的过去样本。Capture gaze 映射有延迟，独立 pupil 流往往已经比正在处理的 gaze 更新。最新记录左眼 3184/3204、右眼 3160/3204 次缓存时间在 gaze 之后，被拒绝。最终 CSV 只有左眼 10 行有直径，右眼 0 行。

原始 gaze.base_data 有 5086 个嵌入的 pupil datum，均提供 diameter 和 diameter_3d；其中左眼 2133、右眼 1955 个达到 confidence≥0.6。独立 pupil 流也有大量可用数据。故近乎全空不是设备没有输出直径。

方案：优先使用 gaze.base_data 中实际参与该 gaze 计算的 pupil，按 id、timestamp、generation、topic 校验，分别记录 px/mm、置信度及来源。未提供 base_data 时才使用按源时间排序的有界缓存。2D/3D 样本分开缓存，不能相互覆盖毫米值；不伪造单眼 gaze，不把 px 当 mm，不将 gaze 平均时间之前作为 binocular base_data 的强制条件。验证应覆盖异步到达、双眼时间分居 gaze 平均时间两侧、低置信度及重连。

### fixation / blink 空

最新附档收到 2 条 fixation，均位于场景外；2 条 blink 的 confidence 分别约 0.5796、0.5740，低于当前共用 0.6 阈值，因此未输出事件行。不是单纯未启动插件，也不是原始事件文件完全没数据。

方案：保留原始事件与被拒原因，检查不同事件的置信度语义和阈值，避免把 pupil 阈值机械用于所有事件；是否计入分析须显式配置。不能为了显示数字把无效事件强行算作有效，或用低质量 gaze 伪造 fixation。

### stimulus / triggerMark / customMarker 空

最新 context 为 markers=[]、stimuli=[[0.0, ""]]。没有记录到素材或标记，因此这些空值有数据依据。若实验实际操作了标记，则需查前端命令发送及 ACK，当前文件不足以证明丢失。

### 校准评分空、采样率为零

校准档 scores=null，仅保存 session 凭据，当前没有独立准确性评分。“calibrationVerified”表示本连接拟合通知匹配且视频恢复，不表示眼动精度验收。

最新 diagnostics 中 gaze 消息率为 246.4615 条/秒，公开 meta 却为 0；说明后续元数据合并存在覆盖或状态取值问题，并非没有数据。需沿 recording metadata 更新调用修复并区分 eye camera Hz、gaze 消息率、有效 gaze 率、video FPS。官方双眼匹配会重复使用 pupil，不能把 gaze 行数/时长直接解释为硬件采样率。

## 3. 注视偏差定位

### 已确认偏差至少部分在 Capture 原始输出中

最新第一条原始 gaze.norm_pos≈(0.666659,-0.087615)，confidence≈0.87546，在 MRT 坐标转换前已越界。当前 Pupil→MRT 使用 (x,1-y)，符合官方原点约定；这不能证明所有显示路径都无误，但排除了“只改一次 Y 翻转就能修好全部问题”。

最新 binocular gaze_point_3d 的 Z 四分位数约为 27.70、40.66、58.75 mm；第一段对应约 284.48、431.09、1077.81 mm。这提示 3D 映射几何明显变化，但没有目标真实距离和相机内参，不能据此给出角度误差或认定具体硬件损坏。

### 诊断时校准实现中的确定风险（历史状态，当前修复见实施状态）

1. 点击时只取一次卡片中心，之后 1 秒采样将同一个参考坐标复制到多帧。若头或卡片移动，参考点位置与 pupil 的源时间对应错误。
2. 当前只要求每点至少 10 个参考帧和每眼 10 个高置信 pupil，未检查目标稳定、左右眼有效比例、覆盖区域、点重复、几何退化或独立验证误差。
3. 现有日志一轮前两个点几乎重复，另一轮 y≈0.526/0.517/0.594，垂直覆盖窄。证明流程可能接受覆盖不足的数据，但该日志截止 10:43，不能据此推断 11:04 那轮的全部校准点。
4. 没有保存每次校准完整 ref_list、pupil_list、setup/result、相机内参和验证目标，无法离线重算最新坏校准，也不能给出可信角度精度。
5. 3D pupil 检测有效比例下降。最新右眼 1007/1603、左眼 1192/1603 条 3D pupil 有效，需检查佩戴、遮挡、眼模型稳定和视野覆盖；高 confidence 仅表示 pupil 检测质量，不等于 gaze 精度。

## 4. 分阶段方案

### P0：数据完整性与可解释性

- 保护实验原件，输出独立 derived/recovered 版本；对前两次视频校验后从附档重建 CSV，注明恢复性质及无法恢复的部分。
- gaze.base_data 精确配对左右瞳孔；保留原始坐标、无效原因和各流时间戳。
- 修复采样率元数据覆盖，显示实际消息率和有效率；保留拒绝事件，空值区分“不适用/未提供/低质量”。
- 验收：与原始 msgpack 逐条比对，来源、单位、左右眼及时间一致；原文件摘要不变。

### P1：在原共享卡片界面内修复校准

- 保持“场景相机拍摄实体卡片，点击卡片中心启动当前点”的原 ASeeGlass/7invensun 页面交互。
- 采样窗口逐帧检测/追踪目标中心，每个参考点绑定实际 world 帧 timestamp；追踪丢失、目标跳变或不稳定时暂停/重试，不延用旧坐标。
- 采样质量门槛增加每眼比例、稳定性、覆盖区域与点重复检查，扩展足够视野覆盖，具体点数/阈值由配置和真机验证决定，不能只靠三次点击次数判通过。
- 拟合后在不同于训练数据的目标上做独立验证，报告像素误差、有效率、精密度；获得实际 camera intrinsics 后再报告角度误差。未通过明确显示校准质量不足。
- 保存 ref/pupil、gazer 参数、版本、内参、覆盖及验证报告，保证可审计与重算。取消、切页、断连使当前会话失效。

### P2：确认是否需要 Capture 插件与官方录制格式

Network API 已提供 gaze.base_data、pupil、fixation、blink，修复这些空字段不必先安装自定义插件。若本软件侧无法可靠获取同一 world 帧中的目标与内参，可以使用最小 Capture 插件在 recent_events 中产生与 world 同时戳的 marker references；所有操作仍从本软件原页面发起，插件只作后台采样桥接，不新增校准窗口。

当前 .pupil 目录为 MRT 自有附档，不是官方 Pupil Player 录制。若需要 Player 回放/离线重算，应另做明确导出：info.player.json、world.mp4、逐帧 world_timestamps.npy、pupil/gaze.pldata 及 timestamps；眼视频目前没有归档，不能事后凭空生成。不要仅把文件改名就宣称兼容。

### P3：真机对照验收

同一佩戴、目标、分辨率和照明下，分别测试官方参考校准与修复后的本软件校准，并同步采集独立验证目标。比较有效率、左右眼检测质量、误差分布与源时间延迟。两边均差时查佩戴/眼模型/内参；官方良好而本软件差时继续排查参考采样与转换。记录精度阈值必须事先按实验需求确定。

## 5. 官方依据

- Plugin API：https://docs.pupil-labs.com/core/developer/plugin-api/#adding-a-plugin 。recent_events 可产生带 Pupil timestamp 的数据；插件不是缺失科学结果的自动补全器。
- Recording Format：https://docs.pupil-labs.com/core/developer/recording-format/ 。Player metadata、视频命名、timestamps.npy 与双层 msgpack 的 pldata 有独立规范。
- 数据匹配与 base_data：https://docs.pupil-labs.com/core/developer/ 。gaze timestamp 为参与 pupil 时间的平均，源流异步；复用匹配导致 gaze 消息率不能直接等同眼相机 Hz。
- 校准与准确性：https://docs.pupil-labs.com/core/software/pupil-capture/#calibration 。视野覆盖、检测稳定、独立 validation 均影响结果。
- 坐标与 confidence：https://docs.pupil-labs.com/core/terminology/ 。normalized origin 为左下，pupil confidence 不等于 gaze 准确度。
