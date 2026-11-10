# Pupil Labs 数据处理整改与完成统计

> 后续口径修订：用户已明确只使用原 133 列，本文中的可选扩展列方案已取消。当前映射和完成统计见 [133 列整改报告](pupil-standard-133-2026-10-24.md)。


> 历史快照。后续修正、最新字段数量及当前状态见 [2026-10-24 复核报告](pupil-data-2026-10-24-status.md)。

日期：2026-10-23。范围：本软件的 Pupil Core 原生后端、Capture 兼容数据、CSV、分析索引、统计/比较/AOI 和导出。以现有 7invensun 的字段布局为兼容标准，但不同设备的物理量、坐标系、质量和算法不能仅靠列名认定等价。

## 1. 本轮统计结论

| 状态 | 项数 | 判定口径 |
| --- | ---: | --- |
| 代码与自动化验证已完成 | 12 | A01—A12，已落地到实际采集/分析/导出链路 |
| 尚未完整实现或仍有能力边界 | 5 | B01—B05，逐项列出原因与下一步 |
| 等待数据或现场验收 | 3 | C01—C03，不能用单元测试代替实测 |
| 合计 | 20 | 本轮整改清单，不等于设备全部功能或硬件准确率 |

代码完成不代表真机精度已经达标。此次未更换共享校准界面，未要求用户在厂商软件完成校准，未覆盖原始实验 CSV/视频或用户提供的 Excel。

## 2. 已完成的 12 项

| 编号 | 项目 | 已处理的具体行为 | 主要代码/回归证据 |
| --- | --- | --- | --- |
| A01 | 瞳孔几何真实性 | 二维椭圆轴长无效时不把占位 `(0,0)` 当作真实瞳孔中心；二维失败不连带删除独立合格的三维毫米直径 | `data_normalizer.py`；`test_data_accuracy.py` |
| A02 | 瞳孔质量与缺失值 | raw 诊断值与分析值分开；保留置信度、模型质量、各眼源时间及有效标志；排除非正/非有限、明确 bad、左右眼显式无效和该眼眨眼。兼容旧 `pupil_valid=0` 的拒绝规则；未知质量不伪称已验证 | `pupil_csv.py`、`recordCsvParser.ts`；Python/JS 新准确性回归 |
| A03 | 有效单眼保留 | 一只眼不合格时使用另一只眼已校准模型和真实时间；双眼求解退化时仍保留可算出的独立单眼结果，推荐点留空，不任选/平均一眼伪融合 | `gazer.py`、`pupil_protocol.py`；`test_monocular_fallback.py` |
| A04 | 坐标与单位 | 区分场景归一化二维、眼图像像素、三维几何和模型毫米；旧 `Gaze velocity ms` 保留原值但纠正单位说明；像素注视中心缺失时不以归一化值冒充 | `pupil_csv.py`、`eyeExportData.ts`、导出字段说明 |
| A05 | 连续性边界 | 来源眼切换、非递增时间、无效样本及断档不跨段计算速度/事件；纯 Marker/Trigger 行保留但不切断真实采样段；带标记的真实采样仍正常参与 | `source.py`、`saccades.py`、`pupil_csv.py`、`eyeExportData.ts` |
| A06 | 注视完成状态 | Native 在线窗口不直接算完整事件；有效离开候选才完成，断档/无效/来源切换/录制末尾/视频裁切保持不完整；前后注视幅度只关联完整注视 | `events.py`、`pupil_events.py`；算法完成语义版本 `2` |
| A07 | 可追溯事件与能力说明 | 事件带算法、版本、参数、源时间/序号、原始区间、裁切与完成状态；录制元数据 `pupilDataSchemaVersion=2` 和能力缺失原因；端点位移与前后注视幅度分列 | `samples.py`、`pupil_recorder.py`、`pupil_events.py` |
| A08 | 全记录瞳孔统计 | 从完整合格瞳孔采样读取均值/曲线，不再只读没有瞳孔值的事件行；允许瞳孔合格但 gaze 无效的样本；每行先取有效双眼均值或有效单眼值，再等权平均 | `recordPointsIndex.ts`、`recordPointHandlers.ts`、`ChartPage.tsx`、`compareEngine.ts` |
| A09 | AOI 瞳孔与时间轴 | 按每个真实采样的位置和时间判断动态 AOI/时间段；无 gaze 的瞳孔可用于全记录而不进入 AOI；缺时标不变成 0；明确视频毫秒不再平移/拉伸且不修改源数组 | `aoiReport.ts`、`aoiAnalysisModel.ts`、`AoiPage.tsx` |
| A10 | 眼跳单位与统计缺失 | Pupil 的 px/px·ms⁻¹ 不再重复乘视频宽；混合单位不直接合算；缺失幅度/速度/峰值保持缺失；均速按有效事件数平均，纠正此前幅度加权；不用事件数推算 Hz | `recordCsvParser.ts`、`aoiReport.ts`、`compareEngine.ts` |
| A11 | 预览与实际导出一致 | 共享解析/派生规则，空串不当 0、事件不当采样；纯标注不生成派生值；截断预览不冒充完整段结束；真实 IPC 导出与真实预览回调做一致性回归 | `eyeExportData.ts`、`recordExportHandlers.ts`、`check_eye_data_accuracy.mjs` |
| A12 | 字段兼容与持续回归 | 默认保持原 133 列及顺序，新增 62 个可选列（58 来源/质量 + 4 单位/归一化），总可选 195（不含自定义属性）；解析缓存版本升级，新专项接入 CI | `eyeExportMetadata.ts`、`ExportPage.tsx`、`recordPoints.ts`、`pupil-adapter-tests.yml` |

A08 的统计对象是录制 CSV 中真实关联到 gaze 的瞳孔采样行，不是对底层全部眼相机 pupil 帧重做一次去重统计。原生配对与 Capture 配对机制可以不同；本轮没有把它们伪装成统一采样率或按时间积分的均值。

## 3. 尚未完整实现的 5 项

| 编号 | 项目 | 当前状态 | 仍需完成 |
| --- | --- | --- | --- |
| B01 | 独立平滑数据 | Native smooth 留空，Capture 兼容别名明确标为无独立滤波 | 定义独立滤波算法、单位、参数、延迟与重置规则；保留原始轨迹；用真实数据验证后再开放为独立结果 |
| B02 | AOI 完整眨眼区间统计 | 采集/导出有眨眼配对，AOI 仍走现有事件级统计 | 把逐采样眨眼状态或已配对区间独立接入 AOI，定义无 gaze 时的归属、单眼/双眼计数与时间范围裁切；本次不宣称 AOI 眨眼统计已全部补齐 |
| B03 | 历史/Capture 注视完整性 | 无明确完成声明者维持历史兼容，并标 `legacy_completion_unknown` | 若要可靠重判，需原始 gaze/事件、算法版本和独立派生输出；不能凭旧 CSV 的 state=4 追认真实完整性 |
| B04 | 超大记录精确分析 | 单次事件或合格瞳孔采样超过 100 万点明确失败，不静默抽样 | 增加分块流式精确聚合和分页曲线，保留每项真实有效计数；现有限额不是完成海量数据验收 |
| B05 | 跨厂商事件科学等价 | 原生注视/眼跳/眨眼算法已标明来源与参数，7invensun 原算法保留 | 使用同刺激物、同坐标/时间基准、相同筛选和明确算法做独立对照。当前不宣称两个厂商的注视次数、幅度、质量分天然等价 |

## 4. 待验收的 3 项

| 编号 | 验收项目 | 当前证据边界 | 所需材料/动作 |
| --- | --- | --- | --- |
| C01 | 用户 Excel 对应的两份真实原始 CSV | 此次有 Excel 比较方案，未取得其中对应的完整原始记录；表内空值率仅作为原表描述，未冒充重新实测 | 提供对应 CSV、元数据和必要源附档，用副本重跑缺失率、质量分层、单位、事件与瞳孔统计；原件只读 |
| C02 | Pupil 真机与软件页面全流程 | 自动化覆盖数值、索引、IPC 和既有共享校准边界；未现场采集新数据，未做真实设备 GUI 全流程 | 本软件内校准/独立验证/录制/回放/AOI/报表/导出，包含遮挡一眼、眨眼、失焦、断连、重新校准和录像边界；核对相机身份/内参和独立角度误差 |
| C03 | 目标平台安装包 | 源码构建成功不等于冻结安装包通过；5 个目标程序相关测试因未提供程序跳过 | 在实际 Windows/macOS 目标包运行独立算法、离线映射、录制/关闭和依赖检查，确认本轮代码被打包后再验收 |

## 5. 原 Excel 的 31 个“空白/稀疏字段”如何判定

这是原表所列 **25 个全空列 + 6 个稀疏注视列** 的重新分类，不是把 31 个字段都当成缺陷，也不是本轮整改 20 项的另一种完成率。

| 原表字段组 | 列数 | 专业判定 | 本轮处理/剩余 |
| --- | ---: | --- | --- |
| IMU：timestamp、quaternion、gyro、accel、mag | 5 | Core 与 Invisible 的硬件能力不能混用；Player 的 IMU 功能明确适用于 Invisible 录制 | 标记 Core 不支持，留空；不作为待软件补数项 |
| 左右 openness、上/下眼睑 | 6 | Core 标准数据不提供与 7invensun 连续几何量同义的输出；blink 分类不能代替眼睑位置 | 标明不可用，留空；不伪造连续数值 |
| 左右/推荐 smooth 三轴 | 9 | 没有独立滤波结果；复制 raw/gaze 不等于完成 smooth | 已纠正语义和提示；独立平滑仍为 B01 |
| Recommend | 1 | 厂商专用选择标记与融合坐标不是同一物理量；此列空不等于没有推荐 gaze | 保留厂商列空；用真实推荐坐标、有效性和 mapping mode 说明实际状态 |
| 左右 pupil bit mask | 2 | 不同厂商掩码编码不能直接等价，confidence 也不能充当掩码 | 提供左右眼有效性/模型质量及明确 MRT gaze mask 定义，厂商瞳孔掩码不编造 |
| 左右 pupil minor axis mm | 2 | 二维椭圆短轴是眼图像 px，三维模型 diameter_mm 是另一量，不能直接代替 | 保持毫米短轴缺失，保留真实 px 短轴与模型毫米直径 |
| 六个 fixation 列 | 6 | 独立事件数据本来就稀疏，不能要求每条 gaze 行都有完整 fixation | 已修原生完成性、导出单位与统计读取；真实事件覆盖率仍需 C01/C02，历史完成性见 B03 |
| 合计 | 31 | 16 列属无可信同义来源；9 列需独立平滑；6 列属事件稀疏/完整性 | 不用插值、补 0 或复制其他物理量获得“填满率” |

## 6. 验证记录

完整 Python 回归使用隔离原生环境，测试涉及本机 ZMQ/WebSocket loopback，已允许本机测试端口：

```sh
services/eye_tracking/adapters/pupil_native/.venv/bin/python -m unittest discover -s tests/eye_tracking -t . -v
```

最终完整回归：**304 项，299 通过，5 跳过，0 失败**，包含新增双眼退化专项。跳过项均要求外部提供目标平台打包程序，不能计为发行包验收。

已执行通过的 JS 专项：

```sh
node tests/export/check_eye_data_accuracy.mjs
node tests/export/check_export_feedback.mjs
node tests/analysis/check_pupil_sample_metrics.mjs
node tests/analysis/check_analysis_access.mjs
node tests/mapping/check_fixation_pipeline.mjs
node tests/mapping/check_mapping_display.mjs
node tests/mapping/check_mapping_launch.mjs
node tests/recording/check_device_stream_lifecycle.mjs
node tests/recording/check_calibration_scores.mjs
node tests/recording/check_recorded_calibration_scores.mjs
node tests/eye_tracking/pupil_core/check_product_contracts.mjs
node scripts/check-aoi-playback-boundaries.mjs
node tests/recording/check_recording_video_ui.mjs
```

最终 `npm run check:architecture`、`npm run typecheck:all`、`npm run check:python`（134 个源码文件）、`npm run build` 和 `git diff --check` 均通过。构建存在非阻塞的大 chunk 体积提示；没有据此宣称打包性能或安装包已验收。测试用临时合成数据和真实数值实现，不把合成测试结果当作硬件实测。

## 7. 官方依据与适用边界

- [Pupil Core 数据格式与时间约定](https://docs.pupil-labs.com/core/developer/)：眼相机/场景相机独立采样；原时间、来源与贡献数据应保留，不能任意对齐/复制。
- [Pupillometry 与独立校准验证](https://docs.pupil-labs.com/core/best-practices/#pupillometry)：图像像素直径与模型毫米直径需区分；代码修复不替代独立验证。
- [在线/离线注视术语](https://docs.pupil-labs.com/core/terminology/#fixations)：在线重叠窗口与离线完整事件不可混为一谈。本软件 Native 的完成策略是明确版本的实现规则，不冒称官方离线算法。
- [Player IMU 的适用设备](https://docs.pupil-labs.com/core/software/pupil-player/#imu-timeline)：Invisible IMU 不能据此填到 Core 数据中。

字段详细规则见[导出字段说明](../说明文档/导出字段说明.md)，AOI/瞳孔统计规则见[眼动数据与 AOI 说明](../说明文档/眼动数据与AOI说明.md)，执行命令见[维护手册](../维护/维护手册.md)。
