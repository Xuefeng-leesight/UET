# Pupil Labs 数据核查、修正与完成统计

> 后续口径修订：用户已明确只使用原 133 列，本文中的可选扩展列方案已取消。当前映射和完成统计见 [133 列整改报告](pupil-standard-133-2026-10-24.md)。


日期：2026-10-24。适用：本项目 Pupil **Core** 原生后端与 Capture 兼容路径，涵盖采集、CSV、索引、瞳孔/事件统计、AOI、报告、预览和实际导出。以现有 7invensun 字段布局和共享操作流程为兼容标准，不假设厂商的测量物理量和事件算法等价。

本轮已实际阅读官网及 GitHub 固定提交源码，并修改软件。此报告更新 [10 月 23 日快照](pupil-data-2026-10-23-status.md)，保留原 A01—C03 编号，新增 A13—A17 五项深度修正。附件 Excel 是比较材料，其中的建议没有被当成可以伪造数据的指令。原始实验文件与 Excel 保持原样。

## 1. 当前统计

| 状态 | 项数 | 判定 |
| --- | ---: | --- |
| 代码与自动化验证已完成 | **17** | A01—A17；下表列出已实现行为及证据 |
| 尚未完整实现/仍有能力边界 | **5** | B01—B05；B02 的时间区间部分已完成，空间归属仍未完成 |
| 等待原始数据、真机或目标包验收 | **3** | C01—C03；不将合成测试视为硬件精度证明 |
| 清单合计 | **25** | 是整改工作项数量，不是填值率、功能覆盖率或硬件准确率 |

完整 Python 回归 **313 项：308 通过、5 跳过、0 失败**。类型、架构、Python 语法、生产构建和数据链路专项通过；证据及命令见第 6 节。跳过项需要目标平台打包程序。共享校准界面及其他设备既有流程保留，校准成功仍以真实结果为准。

## 2. 已完成的 17 项

| 编号 | 项目 | 已处理的具体行为 | 主要实现/回归证据 |
| --- | --- | --- | --- |
| A01 | 瞳孔几何真实性 | 二维椭圆轴长无效时不把占位 `(0,0)` 当作真实瞳孔中心；二维失败不连带删除独立合格的三维毫米直径 | `data_normalizer.py`；`test_data_accuracy.py` |
| A02 | 瞳孔质量与缺失值 | raw 诊断值与分析值分开；保留置信度、模型质量、各眼源时间及有效标志；排除非正/非有限、明确 bad、左右眼显式无效和该眼眨眼。兼容旧 `pupil_valid=0` 的拒绝规则；未知质量不伪称已验证 | `pupil_csv.py`、`recordCsvParser.ts`；Python/JS 新准确性回归 |
| A03 | 有效单眼保留 | 一只眼不合格时使用另一只眼已校准模型和真实时间；双眼求解退化时仍保留可算出的独立单眼结果，推荐点留空，不任选/平均一眼伪融合 | `gazer.py`、`pupil_protocol.py`；`test_monocular_fallback.py` |
| A04 | 坐标与单位 | 区分场景归一化二维、眼图像像素、三维几何和模型毫米；旧 `Gaze velocity ms` 保留原值但纠正单位说明；像素注视中心缺失时不以归一化值冒充 | `pupil_csv.py`、`eyeExportData.ts`、导出字段说明 |
| A05 | 连续性边界 | 来源眼切换、非递增时间、无效样本及断档不跨段计算速度/事件；纯 Marker/Trigger 行保留但不切断真实采样段；带标记的真实采样仍正常参与 | `source.py`、`saccades.py`、`pupil_csv.py`、`eyeExportData.ts` |
| A06 | 注视完成状态 | Native 在线窗口不直接算完整事件；有效离开候选才完成，断档/无效/来源切换/录制末尾/视频裁切保持不完整；前后注视幅度只关联完整注视 | `events.py`、`pupil_events.py`；算法完成语义版本 `3` |
| A07 | 可追溯事件与能力说明 | 事件带算法、版本、参数、源时间/序号、原始区间、裁切与完成状态；录制元数据 `pupilDataSchemaVersion=3` 和能力缺失原因；端点位移与前后注视幅度分列 | `samples.py`、`pupil_recorder.py`、`pupil_events.py` |
| A08 | 全记录瞳孔统计 | 从完整合格瞳孔采样读取均值/曲线，不再只读没有瞳孔值的事件行；允许瞳孔合格但 gaze 无效的样本；每行先取有效双眼均值或有效单眼值，再等权平均 | `recordPointsIndex.ts`、`recordPointHandlers.ts`、`ChartPage.tsx`、`compareEngine.ts` |
| A09 | AOI 瞳孔与时间轴 | 按每个真实采样的位置和时间判断动态 AOI/时间段；无 gaze 的瞳孔可用于全记录而不进入 AOI；缺时标不变成 0；明确视频毫秒不再平移/拉伸且不修改源数组 | `aoiReport.ts`、`aoiAnalysisModel.ts`、`AoiPage.tsx` |
| A10 | 眼跳单位与统计缺失 | Pupil 的 px/px·ms⁻¹ 不再重复乘视频宽；混合单位不直接合算；缺失幅度/速度/峰值保持缺失；均速按有效事件数平均，纠正此前幅度加权；不用事件数推算 Hz | `recordCsvParser.ts`、`aoiReport.ts`、`compareEngine.ts` |
| A11 | 预览与实际导出一致 | 共享解析/派生规则，空串不当 0、事件不当采样；纯标注不生成派生值；截断预览不冒充完整段结束；真实 IPC 导出与真实预览回调做一致性回归 | `eyeExportData.ts`、`recordExportHandlers.ts`、`check_eye_data_accuracy.mjs` |
| A12 | 字段兼容与持续回归 | 默认保持原 133 列及顺序，新增 74 个可选列（70 来源/质量 + 4 单位/归一化），总可选 207（不含自定义属性）；解析缓存版本升级，新专项接入 CI | `eyeExportMetadata.ts`、`ExportPage.tsx`、`recordPoints.ts`、`pupil-adapter-tests.yml` |
| A13 | 独立二维与三维质量 | 保存真实 `confidence_2d`；二维像素中心/轴/直径与三维毫米质量独立判定，3D 恢复置信度不放行坏 2D；区分真实轮廓、模型投影和未知历史来源；投影直径不重复乘二 | `worker.py`、`data_normalizer.py`、`pupil_csv.py`、`pupil_protocol.py`；`test_pupil_pixel_provenance.py` |
| A14 | 完整注视中心 | Native v3 完整事件按整个事件的唯一真实样本计算中心、置信度和平均方向，不再沿用最后 300 ms 窗口；离群终止点不计入，打断后清空累加；窗口/完整结果都有显式语义 | `events.py`、`pupil_events.py`；`test_fixation_interval_accuracy.py`，包含长区间非线性轨迹和中断后新事件 |
| A15 | 双眼异步晚到样本 | 保留晚到样本的源时间、来源和真实测量，标 `late_source_time`，不降低水位、不喂入在线事件；原生 CSV 和导出速度断开因果基线，最终 CSV 仍按源时间排序 | `source.py`、`pupil_csv.py`、`eyeExportData.ts`；单眼降级、排序 CSV 与实际导出回归 |
| A16 | 导出元数据与时钟 | 缺失/非有限值不输出假 0；118.73 Hz 不四舍五入成 119；可读民用时间必须有可靠锚点；Pupil 任意起点秒时间不当 epoch，空视频时间不借其他时钟；预览与实际输出同规则 | `eyeExportData.ts`、`ExportPage.tsx`、`recordExportHandlers.ts`；`check_eye_data_accuracy.mjs` |
| A17 | 完整眨眼的时间统计 | 显式配对区间独立进入统计 IPC、Chart、Compare、CSV/HTML；半开窗口计 onset，交集时长与完整源均值分开；左右眼分别计数，未知眼别不补造；缺配对不假零，AOI 明示未分配 | `recordBlinkIntervals.ts`、`blinkIntervals.ts`、报告/AOI 现有组件；`check_blink_intervals.mjs` |

A08 的统计单位是 CSV 中真实关联到 gaze 的合格瞳孔采样行，按行等权；不是底层全部眼相机帧去重后的平均，也不是按时间积分。Capture 的匹配复用与 Native 配对可能不同，不能据此宣称统一采样机制。A17 的按眼时长相加也不等于双眼闭合的墙钟时长。

A15 另验证了到达顺序 `normal 6 → late 0 → normal 20 → normal 30`：排序成 `0/6/20/30 ms` 后，20 ms 行的速度仍保持缺失，30 ms 才恢复合法差分。导出不利用排序邻接重新填入采集阶段明确缺失的源速度，真实零速度仍保留。

## 3. 尚未完整实现的 5 项

| 编号 | 项目 | 已到达的状态 | 完成条件/缺口 |
| --- | --- | --- | --- |
| B01 | 独立平滑数据 | Native smooth 留空；Capture 历史别名明确不是独立滤波 | 选定独立滤波算法、参数、坐标/单位、延迟和重置规则；保留原始轨迹并验证真实数据，不能复制 raw 冒充 |
| B02 | AOI 完整眨眼空间归属 | **部分完成**：时间区间及报表统计为 A17；AOI 缺位置时三项指标为缺失并解释原因 | 源 onset/offset 不带可靠 gaze 坐标。需取得可验证定位依据并明确分析约定；不能用前一注视、最近点或插值推定闭眼期间看向哪里 |
| B03 | 历史/Capture 注视完整性 | 保持兼容并标 `legacy_completion_unknown`；历史中心不伪改为全区间均值 | 需要原始 gaze/事件及算法版本，才能独立重判；旧 CSV 的 state=4 本身不能证明完整性或重建独立二维置信度 |
| B04 | 超大记录精确统计 | 单次超过 100 万事件/合格瞳孔采样或 10 万眨眼配对键明确失败，不静默抽样 | 实现分块流式精确聚合、分页曲线及真实有效计数，再做大数据验收 |
| B05 | 与 7invensun 的科学等价对照 | 保留原厂算法，明确 MRT 算法、单位、质量和来源；保留原 133 默认列及顺序 | 统一刺激物、时间/坐标基准、筛选和指标定义后做独立对照。旧 7invensun 无视频时间列的未标单位 timestamp 仍存在历史歧义，未凭数值猜测后改写 |

以上缺失不是“补 0”或扩大有效阈值即可解决。代码能证明输出的处理口径，真机精度和跨厂商可比性仍须独立验证。

## 4. 待验收的 3 项

| 编号 | 验收项目 | 现有证据边界 | 下一步所需材料/动作 |
| --- | --- | --- | --- |
| C01 | Excel 对应两份原始 CSV | 已读取比较表；没有取得其中对应的完整两份原始记录，不能重报真实空值率 | 对应 CSV、record 元数据及源附档；用副本核查缺失率、有效率、单位、瞳孔及事件统计，保留原件 |
| C02 | Pupil 真机与页面全流程 | 数值、真实记录函数产物、索引、IPC、JSX/HTML 已自动化验证；未采集新真机记录 | 在本软件内校准、独立验证、录制、回放、AOI、报告、导出，检查遮挡一眼、眨眼、失焦、断连、重新校准、视频边界和相机身份/内参；核实独立角度误差与实际有效率 |
| C03 | 目标平台安装包 | 本地生产构建通过；5 项外部目标程序测试跳过 | 在实际 Windows/macOS 打包程序验证独立算法、离线映射、录制/关闭及依赖；确认打包包含本轮变更，不能用前端构建替代发行验收 |

## 5. 官网与 GitHub 源码核查

### 固定版本与可追溯性

查询时 Pupil 和 pye3d 的上游 master 与本地固定版本相同，本轮未更新依赖。

| 官方仓库 | 实际核查提交 | 作用 |
| --- | --- | --- |
| [pupil-labs/pupil](https://github.com/pupil-labs/pupil/tree/7a3cd9e8d2e54ac123ab0ed292d741732db899a2) | `7a3cd9e8d2e54ac123ab0ed292d741732db899a2` | 2025-05-30 提交；gaze 匹配、导出、注视、眨眼、UVC 时间 |
| [pupil-labs/pye3d-detector](https://github.com/pupil-labs/pye3d-detector/tree/eb50e384ce131e2a27e0de058c25fa16254c63ed) | `eb50e384ce131e2a27e0de058c25fa16254c63ed` | 2025-07-08 提交；三维置信度、模型质量、投影与真实毫米直径 |
| [pupil-labs/pupil-detectors](https://github.com/pupil-labs/pupil-detectors/tree/cd297a0bca5a8dd7ca306f7dee1c50dcc667f1b8) | `cd297a0bca5a8dd7ca306f7dee1c50dcc667f1b8` | 2022-10-06 提交；二维检测依赖来源 |

本地安装 `pye3d/detector_3d.py` 与下载的固定提交原文件 SHA256 相同：`71eb14f03b4d7369263cb9c65cf5560b9089bb245bf40f8e5b43701e6d753322`。核查的官方 `raw_data_exporter.py` 为 `20b68c31bd08322a8d75d52d7e015365c4df19da1f80bf67c1c8e177b92b4980`；`blink_detection.py` 为 `61fe90bf98f505fc3665492d02c3013801469a841e412f8682bc9e9cae0639f8`。

### 关键依据及本软件差异

1. [官网 Core 数据与时间](https://docs.pupil-labs.com/core/developer/)及[术语](https://docs.pupil-labs.com/core/terminology/)：设备流异步，Pupil 秒时间可有任意起点；二维归一化、眼图像像素和三维量不能互换。本软件保留源时间、base_data 对应关系和坐标语义。
2. [pye3d 置信度更新 L352–375](https://github.com/pupil-labs/pye3d-detector/blob/eb50e384ce131e2a27e0de058c25fa16254c63ed/pye3d/detector_3d.py#L352-L375)、[投影/毫米直径 L537–558](https://github.com/pupil-labs/pye3d-detector/blob/eb50e384ce131e2a27e0de058c25fa16254c63ed/pye3d/detector_3d.py#L537-L558)：三维恢复会更新 confidence，投影椭圆与直接二维检测不同。故增加独立二维置信度和像素来源，而非一份置信度放行所有量。
3. [官方模型范围 L589–600](https://github.com/pupil-labs/pye3d-detector/blob/eb50e384ce131e2a27e0de058c25fa16254c63ed/pye3d/detector_3d.py#L589-L600)：源码眼球中心范围为 x ±15、y ±10、z 15–75。**MRT 原有额外收紧为 x/y ±10、z 20–75，并有直径 1–9 mm 规则**；现标 `mrt_pupil_model_bounds_v1`，不冒称官方标准，也未为提高有效率扩大范围。此前历史完整性记录将 20 mm 描述为“官方”的说法应以本次固定源码核查为准。
4. [官方 fixation_from_data L77–92](https://github.com/pupil-labs/pupil/blob/7a3cd9e8d2e54ac123ab0ed292d741732db899a2/pupil_src/shared_modules/fixation_detector.py#L77-L92)：事件中心来自其 base_data 均值。本轮修正本软件完整事件中心，但 **MRT 仍为自身在线分类器**：1.5°、至少 100 ms、300 ms 滚动窗口、最大采样间隔 100 ms；不是官方离线算法。上游该提交离线默认最短/最长 80/220 ms，在线默认 3°/300 ms；官方三维离散度采用相机原点 gaze 向量，MRT 使用本项目眼中心方向。阈值、方向基准及滚动策略都必须写明，不宣称结果完全一致。
5. [官方 gaze 来源与双眼时间 L403–450](https://github.com/pupil-labs/pupil/blob/7a3cd9e8d2e54ac123ab0ed292d741732db899a2/pupil_src/shared_modules/gaze_mapping/gazer_3d/gazer_headset.py#L403-L450)：单眼/双眼 topic 与贡献源有区别，双眼时间使用贡献时间平均。本软件现在保留跨流晚到样本；不把跨眼混合消息时间回退等同于单个相机时钟回退。
6. [官方眨眼起止](https://github.com/pupil-labs/pupil/blob/7a3cd9e8d2e54ac123ab0ed292d741732db899a2/pupil_src/shared_modules/blink_detection.py#L140-L160)及[区间时长 L393–415](https://github.com/pupil-labs/pupil/blob/7a3cd9e8d2e54ac123ab0ed292d741732db899a2/pupil_src/shared_modules/blink_detection.py#L393-L415)：时间区间不自带有效空间位置。MRT 原生检测为注明参数的逐眼适配，本轮补齐配对区间的统计接入，不认定与 Capture 的未指定眼别事件天然等价。
7. [官方 UVC 时间修正 L273–286](https://github.com/pupil-labs/pupil/blob/7a3cd9e8d2e54ac123ab0ed292d741732db899a2/pupil_src/shared_modules/video_capture/uvc_backend.py#L273-L286)：本地沿用对应平台策略，Windows 眼/场景估计偏移分别为 -15/-70 ms，macOS/Linux 使用硬件时间；这些是策略值，不是本机实测延迟证明。真正单相机时间回退的保护保留。

### 原表 31 个空白/稀疏字段

原 Excel 描述为 **25 个全空列 + 6 个稀疏注视列**，没有原始 CSV 时不重新宣称其缺失率。

| 字段组 | 列数 | 正确处理与剩余 |
| --- | ---: | --- |
| IMU 五列 | 5 | Core 不借用 Invisible 的 IMU 能力；不支持则空 |
| 左右 openness、上下眼睑 | 6 | 没有与 7invensun 同义的连续量，blink 分类不能代替 |
| 左/右/推荐 smooth 三轴 | 9 | 独立滤波未实现，见 B01；不能复制 raw/gaze |
| Recommend 与左右 pupil bit mask | 3 | 厂商专属编码无可信同义源；用真实 gaze、MRT 有效性和质量来源解释，不编造厂商码 |
| 左右 pupil minor axis mm | 2 | 眼图像短轴 px 不能由三维圆直径 mm 替代 |
| fixation 六列 | 6 | 独立事件本应稀疏；已修完整性、中心、单位和读取，真实事件覆盖率待 C01/C02 |
| 合计 | 31 | 16 列无可信同义来源、9 列独立平滑待做、6 列事件稀疏/完成性；不是 31 个待填满的普通数据列 |

[官网 pupillometry](https://docs.pupil-labs.com/core/best-practices/#pupillometry)支持区分像素与模型毫米并独立验证；[Player IMU 说明](https://docs.pupil-labs.com/core/software/pupil-player/#imu-timeline)不能作为 Core 具备 Invisible 传感器的依据。

## 6. 验证证据

完整回归使用项目隔离的原生环境及本机 ZMQ/WebSocket 回环：

```sh
services/eye_tracking/adapters/pupil_native/.venv/bin/python -m unittest discover -s tests/eye_tracking -t . -v
```

结果 **313 项，308 通过，5 跳过，0 失败**。5 个跳过项分别要求 Huahong/7invensun/Pupil 打包映射程序、Pupil 无 Python 环境算法程序、Pupil 打包状态程序。测试数据为临时合成样本、真实数值实现及真实录制函数产物，不是本次真机采集。

```sh
node tests/export/check_eye_data_accuracy.mjs
node tests/export/check_export_feedback.mjs
node tests/analysis/check_pupil_sample_metrics.mjs
node tests/analysis/check_blink_intervals.mjs
node tests/analysis/check_analysis_access.mjs
node tests/mapping/check_fixation_pipeline.mjs
node tests/mapping/check_mapping_display.mjs
node tests/recording/check_huahong_recordings.mjs
node tests/recording/check_calibration_scores.mjs
node tests/recording/check_recorded_calibration_scores.mjs
node tests/recording/check_device_stream_lifecycle.mjs
node tests/eye_tracking/pupil_core/check_product_contracts.mjs
node scripts/check-aoi-playback-boundaries.mjs
npm run check:architecture
npm run typecheck:all
npm run check:python
npm run build
git diff --check
```

上述专项包含实际预览回调与 CSV IPC、原 133 列顺序快照、全部 74 扩展字段选择、长注视中心、二维/三维质量隔离、异步晚到、真实 Python 事件 CSV 到报告、半开时间窗、缺失不假零和中英文 JSX/HTML。静态渲染回归不等于真机 GUI 全流程。生产构建存在非阻塞 chunk 体积提示，未据此作性能保证。

维护入口：[导出字段说明](../说明文档/导出字段说明.md)、[眼动数据与 AOI 说明](../说明文档/眼动数据与AOI说明.md)、[维护手册](../维护/维护手册.md)。本次改动尚未作为目标平台安装包发布；以源码与可复现测试作为当前交付证据。
