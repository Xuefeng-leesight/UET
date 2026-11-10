# Pupil Labs 按原 133 列整改与完成统计

首次整理：2026-10-24；本轮复核与更新：2026-10-25。范围：Pupil Core 原生后端与 Capture 兼容路径，以及本软件的录制、数据预览和 CSV 导出。本文取代此前“133 默认列 + 74 可选扩展列”的方案。原始实验文件与用户提供的 Excel 未修改。

## 1. 本次交付

导出参数、默认勾选、全选、预览和 CSV 导出均恢复为**原 133 列，保留原顺序和表头**。已移除 70 个来源/质量选项和 4 个额外单位/归一化选项。内部质量、坐标系、原始像素和源时间继续用于验证数据，不作为新增用户导出列。原有受试者自定义属性功能保持原样，默认不选，不计入这 133 列。

这次同时修改了字段内容和计算路径：按原有单位转换瞳孔中心与长短轴，按标准成员含义生成有效位，转换眨眼状态和可确认的推荐眼枚举，使用真实视频尺寸写入注视像素中心，并接通 Capture 的可信三维量和连续采样速度。缺失值保持空白，不能用不相同的物理量替代。

## 2. 133 列的完成统计

| 当前状态 | 列数 | 判定 |
| --- | ---: | --- |
| 直接映射已实现 | **52** | 有真实源量或录制元数据，已写入对应标准列；仍须满足该眼、该模式及有效性要求 |
| 条件计算/转换已实现 | **57** | 已接通实现；须具备真实尺寸、可靠时钟、连续采样、完整事件、已保存AOI或已发生真实通信等条件 |
| 软件功能尚未接通 | **0** | 原 AOI 7 列及通信 4 列已接通，按真实发生条件写值 |
| 当前没有同义可信数据 | **24** | 现有 Core 数据缺少原字段对应的测量，或无法确认参考点及物理含义等价，保留列并留空 |
| 合计 | **133** | 与原字段清单逐项同序核对 |

**109 列有映射或计算路径，不代表任意记录都有 109 列非空，也不代表完成真机精度验收。** 本轮把原剩余 33 列中的 9 个平滑坐标列接通为条件计算；其余 24 列的具体证据与不能补齐的原因如下。事件列本来就是稀疏的，单眼模式、无效采样和缺少可信尺寸时也应有空值；不以填满率评判数据正确性。

可筛选附表：[Pupil Labs 133 列映射与完成统计](Pupil_Labs_133列映射与完成统计_20261024.xlsx)。逐列说明同时见本文第 7 节。

## 3. 原列中具体如何写入

| 原字段 | 当前写入规则 | 明确边界 |
| --- | --- | --- |
| 瞳孔中心 X / Y | 眼图坐标分别除以该眼真实图像宽度/高度，输出左上原点归一化坐标 | Capture 可使用同一真实二维检测的 norm_pos 并翻转 Y；不拿场景视频尺寸代替眼图尺寸 |
| 瞳孔直径 / 短轴 | 实际二维椭圆长轴 / 短轴像素均除以真实眼图宽度 | 不用投影轮廓冒充独立二维检测，不将毫米直径填入像素轴列 |
| 瞳孔直径 mm | 合格 pye3d 三维折射模型估计 | 与二维检测分别验证；二维失败不自动删除独立合格的毫米值；毫米值并非尺量真值 |
| 瞳孔 BitMask | 按最终输出的中心、距离、归一化直径、毫米直径、归一化短轴、毫米短轴分别设置 bit 0—5 | 当前距离与毫米短轴不填值，也不设置其有效位；不直接复制单一 valid 布尔 |
| 注视 X / Y | 真实场景归一化坐标，左上原点 | 无效推荐结果不能被残留坐标重新置为有效；独立合格单眼仍保留 |
| gaze / raw point XYZ | 真实的 Pupil 世界相机坐标系三维映射点；raw 指未额外平滑的校准点 | 历史 Capture 二维兼容别名不进入三维列；单眼深度可为模型估计，不能称实测深度 |
| direction XYZ / re | 真实方向向量及源置信度 | Pupil 坐标系没有自动注册到 7invensun 坐标系；置信度不能解释成校准精度 |
| 注视 BitMask | bit 0—5 分别对应 point、raw、smooth、origin、direction、re | 仅对实际合格成员置位；不把内部三位显示掩码直接当六位导出掩码 |
| Recommend | 仅在明确有效单眼映射时写 1 左 / 2 右；明确无效写 0 | Pupil 双眼融合没有对应枚举，留空；事件和纯标记不生成推荐眼 |
| 左 / 右 blink | Pupil 内部 0 / 1 显式转为原字段 0 睁眼 / 3 闭眼 | 不把未知眼别当双眼。全局完整配对事件可写编号、时长，眼别列仍留空 |
| Fixation point X / Y [px] | 优先真实像素值，否则归一化中心 × 可靠场景视频尺寸 | 零坐标有效；没有尺寸时留空，禁止默认分辨率和把归一化数值直接当像素 |
| Gaze velocity [px/ms] / [deg/ms] | 连续同来源有效样本，使用实际场景尺寸或真实视线夹角 / 源时间差 | 断流、换眼、映射变化、尺寸变化、逆序和迟到都切断差分；不跨空段补算 |
| 旧 Gaze velocity ms | 保留原有来源坐标每毫秒含义；Pupil 为归一化坐标/ms | 表头保持兼容，定义在说明文档中固定；不能当统一 px/ms 或 deg/ms 合并统计 |
| 时间、事件、元数据 | 视频时间为权威时间轴；真实民用时钟锚点才生成可读钟表时间；保留小数 Hz 与完整事件状态 | 空串不转 0；Pupil 任意起点秒时间不能当 Unix 时间；标记不当采样 |

Capture 实时显示已移除 `smooth=raw` 的旧复制逻辑，缺平滑时沿用已有推荐/raw 回退显示。本轮 9 列平滑是预览与 CSV 导出的三维后处理，不修改实时二维显示协议，也不改写既有原始点、注视事件、眼跳与速度指标。

原生采集现在逐帧核对实际灰度图和预览/世界 BGR 图的形状与配置内参尺寸。失配时在检测或数据发布前报错并关闭相机；核对通过后，归一化分母与写入的宽高均取实际图像形状。不能仅设置相机分辨率后就假定每帧尺寸正确。

新录制元数据的数据语义版本为 `pupilDataSchemaVersion=4`；原生注视算法完成语义版本仍为 `3`。历史文件不覆盖：仅在原文件具有足够单位、尺寸、来源和质量证据时转换，无法恢复的值保持空白。

旧 7invensun 文件若没有 `video_time_ms`，且 `timestamp` 未注明单位，当前保留兼容原值。这类历史单位歧义尚待原始元数据确认，不能宣称所有历史设备时间已完全统一。

## 4. 原 33 列的再次复核与剩余边界

| 类型 | 列数 | 当前缺口 / 补齐条件 |
| --- | ---: | --- |
| AOI 原列导出整合 | 7 | 已实现。预览与CSV共同读取保存的AOI定义，支持动态/重叠AOI；单个为标量，多个各列为同序JSON数组，未知分量null。只有可信连续采样才计算命中与访问；段尾/断档不虚构离开。完整注视次数须有可靠事件依据 |
| UDP / 串口发送与接收 | 4 | 已实现。共享通信服务以实际发送成功或收到字节为独立事件，保留可逆UTF-8/base64单行JSON载荷，并对齐视频时钟；双日志持久化、去重与恢复。异常或未正常关闭保留文件并标partial |
| 独立 smooth XYZ | 9 | 本轮已接通：推荐/左/右各三轴，世界相机 mm，独立因果低通 v1、时间常数 25 ms、连续间隔上限 100 ms。第二个连续合格样本起输出；预览与完整导出共用，不复制旧 raw 别名 |
| 角膜曲率中心 origin XYZ | 9 | 保留空。Core 输出眼球球心及瞳孔圆；pye3d 折射修正不等于输出该受试者角膜曲率中心。无受验证的角膜几何偏移和转换依据，不能给球心加一个任意固定距离；推荐球心均值也不等价 |
| 左右瞳孔到镜头距离 | 2 | 保留空。Pupil 瞳孔圆中心可计算相机模型原点的欧氏距离或 Z 深度，但原字段未说明镜头参考点、距离方向及折射口径；当前不能证明其中任何一个就是标准距离 |
| 左右毫米短轴 | 2 | 保留空。Pupil 的三维 pupil 是圆模型，只有半径/直径；二维椭圆轴受透视、倾斜和折射影响。不能把圆直径同时当成独立长/短轴，也不能用二维轴比乘毫米直径恢复真实短轴 |
| 连续睁眼程度 / 眼睑位置 | 6 | 保留空。Core 不输出连续眼睑几何；眨眼检测利用瞳孔置信度变化，不能变成 0..100 睁眼程度或眼睑纵坐标。本软件历史附档没有保存可重新分割的完整眼图像素 |
| IMU | 5 | 保留空。Core 无板载 IMU，本软件无惯性样本流；gaze/video 时间不能伪造 gyro 时间。官方 Player 的 IMU 插件仅对 Invisible 录制启用，不证明 Core 有这些量 |
| 历次缺口合计 | **44** | 上轮 AOI/通信 11 列已接通，本轮平滑 9 列已接通；剩余 24 列缺乏等价测量依据，保持空白 |

### 9 个平滑列的具体计算

本软件对推荐、左眼、右眼分别维护状态，输入必须是合格的 `world_camera_mm` 三维 raw 点。算法 `mrt_causal_3d_lowpass` v1：`α = 1 − exp(−Δt / 25 ms)`，`s(t) = (1−α) × s(t−1) + α × raw(t)`。初始点仅建立基线，第二个连续有效点开始写入三轴；第一行没有伪装成已滤波结果。输入不变时输出可与 raw 相等，是否真实计算由算法与状态证据判定。

推荐使用 gaze 源时间，单眼优先使用对应 pupil 源时间；不把同一底层眼帧重复当作新测量。非递增/缺失时间、无效或不完整三轴、迟到样本、超过 100 ms 的间隔及可识别的来源/映射/尺寸变化会重置对应状态。存在接收序号时保持因果高水位，排序不能把已迟到的数据重新串入平滑；独立事件和纯标记不喂给滤波器。单眼质量单独判定，推荐失败不自动抹掉独立合格单眼。

单眼时间与 gaze 源时间还须满足既有配对规则：明确 `base_data` 可位于平均 gaze 时间前后 100 ms 内，历史缓存只允许过去 0—100 ms；不能把相机源秒时间与相对视频毫秒直接比较。已知眨眼采样会按质量规则断开，独立眨眼事件行不参与滤波，因此本实现不等同于按完整眨眼事件区间屏蔽所有采样。

这是一套公开参数的软件后处理，不是 Pupil 官方独立 smooth 输出，也不宣称数值复现 7invensun 平滑。滤波引入响应滞后，不代表精度提高；原始点的深度估计局限、世界相机随头部运动的坐标系以及跨设备未配准问题均仍存在。仅三轴完整时才设置原 gaze mask 的 smooth 位 bit 2。原始 CSV/视频不改写，仍使用原 133 列及表头。

新录制内部增加实际 `world_image_width`、`world_image_height` 与 `world_resolution_epoch`，保存场景尺寸变化证据；它们不出现在导出参数中。历史未保存的分辨率/标定变化不能事后恢复，不把这类缺证据记录标为完整硬件验收。

历史文件若没有接收序号，也无法从排序后的行重新证明原采集顺序；其平滑只能依据已保存的时间、质量和坐标证据。不会补造这些连续性元数据。

### 24 列保留空值的范围

上述 24 列并非统称为“软件未做完”。其中 13 列欠缺原字段的几何/参考点等价证据，6 列欠缺连续眼睑测量与可追溯眼图，5 列欠缺真实惯性传感器数据。若未来要支持，分别需要经过验证的同义几何模型、完整眼图及经验证的眼睑算法、真实 IMU 采集与同步契约；不能只增加映射公式。

Neon 与 Invisible 是不同产品。Neon 的眼睑角度（rad）和孔径（mm）也不能直接换名成标准的图像纵坐标（0..1）与睁眼程度（0..100）。本轮同时封堵 Core 历史文件中 6 个眼睑/睁眼和 5 个 IMU 列的无依据残留值透传，其他厂商原有数据保持原解释。

AOI停留时长是本次连续visit已观测inside首末时间跨度，离开行截止lastInside；注视计数只纳入本次visit中、onset在有效范围且中心命中当时AOI、截至当前行已经完成的去重事件。缺可靠尺寸时可基于可信归一化坐标计算命中/停留，无法确认事件依据时注视次数留空。通信空包也保留载荷，triggerMark始终独立于真实收发。发送日志表示本机UDP发送回调成功或串口write/drain完成，不表示外设已经确认执行。

软件实现与验证分开统计：上述11列已有实现路径及针对性自动化验证；真实串口/UDP外设、目标安装包和设备录制验收尚未完成。

通信时钟通过源时钟与主进程单调时钟的往返测量对齐，保留半程往返延迟合成的不确定度诊断。这是软件时钟对齐估计，不是物理硬件同步精度保证。停止/连接代次变化会切断会话；旧录制信息不能与新连接时钟组合。

仍需真实原始记录与设备验收：对应用户 Excel 的两份完整原始数据缺失率、软件内校准后的真机录制、目标 Windows/macOS 安装包、跨厂商独立精度与指标对照。已有合成样本、真实录制函数及代码测试不能代替这些验收。

## 5. 官方与源代码依据

标准字段含义以项目历史原厂头文件 `git show db0ac9b:SDK/aSeeGlassesPlus/include/_7i_types.h` 核对：102—111 行的 gaze / 角膜曲率中心，122—127 行的瞳孔单位，139 行的 0/3 眨眼值，211 行推荐眼枚举，290—309 及 341—344 行的成员有效位。原 133 列还包括本软件事件和元数据字段，不能把整套软件列名等同于原厂所有算法。

- [Pupil Core 官方开发说明](https://docs.pupil-labs.com/core/developer/)与[术语](https://docs.pupil-labs.com/core/terminology/)用于核对时间、坐标和数据来源。
- [Pupil 固定版本源码](https://github.com/pupil-labs/pupil/tree/7a3cd9e8d2e54ac123ab0ed292d741732db899a2)：[gaze 映射](https://github.com/pupil-labs/pupil/blob/7a3cd9e8d2e54ac123ab0ed292d741732db899a2/pupil_src/shared_modules/gaze_mapping/gazer_3d/gazer_headset.py#L403-L450)、[检测插件](https://github.com/pupil-labs/pupil/blob/7a3cd9e8d2e54ac123ab0ed292d741732db899a2/pupil_src/shared_modules/pupil_detector_plugins/pye3d_plugin.py#L124-L137)、[眨眼起止](https://github.com/pupil-labs/pupil/blob/7a3cd9e8d2e54ac123ab0ed292d741732db899a2/pupil_src/shared_modules/blink_detection.py#L140-L160)。
- [pye3d 固定源码的投影和毫米量](https://github.com/pupil-labs/pye3d-detector/blob/eb50e384ce131e2a27e0de058c25fa16254c63ed/pye3d/detector_3d.py#L537-L558)。二维与三维置信度分别处理，不用一项置信度放行所有量。
- 本轮进一步检查 [pye3d 折射修正输出](https://github.com/pupil-labs/pye3d-detector/blob/eb50e384ce131e2a27e0de058c25fa16254c63ed/pye3d/eye_model/base.py#L258-L279)和[合成真值脚本](https://github.com/pupil-labs/pye3d-detector/blob/eb50e384ce131e2a27e0de058c25fa16254c63ed/scripts/generate_ground_truth.py#L109-L148)。[原始论文 §3.2/Table 1](https://www.collaborative-ai.org/publications/dierkes19_etra.pdf)有统一的两球眼模型假设，但不是逐受试者角膜参数测量；不能据此把任意固定偏移后的球心当标准 origin。[Core 官方 2024-07-29 答复](https://chat-archive.pupil-labs.com/logs/core/2024/07/)也明确标准软件不输出角膜信息。眼坐标到世界坐标的已有变换不能补出缺失物理点。
- [pupil-detectors 固定版本](https://github.com/pupil-labs/pupil-detectors/tree/cd297a0bca5a8dd7ca306f7dee1c50dcc667f1b8)。本轮没有为填满列而扩大模型范围或更换依赖。
- [Core 官方关于连续睁眼程度的答复（2025-06-10）](https://chat-archive.pupil-labs.com/logs/core/2025/06/)，结合 [Core 原始 pupil 导出字段](https://github.com/pupil-labs/pupil/blob/7a3cd9e8d2e54ac123ab0ed292d741732db899a2/pupil_src/shared_modules/raw_data_exporter.py#L284-L329)，确认当前 Core 无对应连续眼睑量。Neon 的不同物理口径见其 [Eye Openness 数据流](https://docs.pupil-labs.com/neon/data-collection/data-streams/#eye-openness)。
- [Core 官方关于无板载 IMU 的答复（2021-01-27）](https://chat-archive.pupil-labs.com/logs/core/2021/01/)，结合 [Player IMU 文档](https://docs.pupil-labs.com/core/software/pupil-player/#imu-timeline)和[固定源码中的 Invisible 条件](https://github.com/pupil-labs/pupil/blob/7a3cd9e8d2e54ac123ab0ed292d741732db899a2/pupil_src/shared_modules/imu_timeline.py#L312-L330)，核实不能因 Core 仓库中存在 IMU 插件就认定 Core 有惯性测量。
- [官方单眼映射计算](https://github.com/pupil-labs/pupil/blob/7a3cd9e8d2e54ac123ab0ed292d741732db899a2/pupil_src/shared_modules/gaze_mapping/gazer_3d/gazer_headset.py#L150-L182)及[双眼计算](https://github.com/pupil-labs/pupil/blob/7a3cd9e8d2e54ac123ab0ed292d741732db899a2/pupil_src/shared_modules/gaze_mapping/gazer_3d/gazer_headset.py#L280-L325)提供本轮三维输入依据，未提供独立时间平滑输出。本轮低通算法与参数为本软件定义。

本软件保留注明版本和参数的原生事件算法；统一列名和单位不表示其检测阈值、统计窗口或精度与 7invensun 科学等价。

## 6. 验证与实现入口

### 2026-10-25 本轮真实历史记录重导出

对同一 5 份历史文件再次调用真实 CSV 导出 IPC，共 28,554 行；原 133 列及表头逐项匹配，原文件 SHA256 全部保持一致。每份取前 2,000 行，共 10,000 行，把预览共用的派生计算与完整 CSV 的 9 个平滑值及 3 个 gaze mask 逐格比对，一致。另有自动化专项运行真实 ExportPage 预览回调和真实预览/导出 IPC，覆盖界面接入。

下表计数是一组三轴均完整的行数，不是精度分数。两份旧 Capture 只有二维兼容值，没有可确认的三维点，9 列继续留空。

| 记录 | 总行数 | 推荐平滑 XYZ | 左眼平滑 XYZ | 右眼平滑 XYZ |
| --- | ---: | ---: | ---: | ---: |
| `pupil_4735536a0830_20261016_173029.csv` | 4,730 | 3,816 | 3,818 | 3,818 |
| `pupil_4ed294a2cd7c_20261010_160900.csv` | 9,935 | 0 | 0 | 0 |
| `pupil_5f258bd5d532_20261014_121919.csv` | 3,846 | 3,491 | 1,632 | 1,841 |
| `pupil_719d5a05babf_20261015_155426.csv` | 3,848 | 3,472 | 3,473 | 3,472 |
| `pupil_adba0ac09ce7_20261010_095149.csv` | 6,195 | 0 | 0 | 0 |

全部 5 份导出的剩余 24 列均为空。平滑可用行设置 smooth 位 bit 2，初始化、无效和断段行不设置；原始值未被覆盖。左/右数量不同来自各眼独立质量与时钟配对，不能复制另一眼补齐。

### 真实历史录制的只读导出

另对截图中 `/Users/logan/Desktop/pupil` 工程的 5 份历史录制运行了真实 CSV IPC 导出，共 **28,554 行**。每份输出均为 133 列且保持原行数，导出前后原 CSV 的 SHA256 一致。没有将这些记录认定为 Excel 中两份比较样本，也没有据此替代新版本真机采集验收。

| 记录文件 | 总行数 | 保留有效二维推荐点 | 保留真实三维点 | 旧瞳孔中心 X 缺少真实眼图尺寸（左 / 右） |
| --- | ---: | ---: | ---: | --- |
| `pupil_4735536a0830_20261016_173029.csv` | 4,730 | 3,903 | 3,903 | 4,248 / 4,245 行转为空白 |
| `pupil_4ed294a2cd7c_20261010_160900.csv` | 9,935 | 5,882 | 0 | 原文件无中心列 |
| `pupil_5f258bd5d532_20261014_121919.csv` | 3,846 | 3,520 | 3,520 | 3,569 / 3,625 行转为空白 |
| `pupil_719d5a05babf_20261015_155426.csv` | 3,848 | 3,517 | 3,517 | 3,559 / 3,550 行转为空白 |
| `pupil_adba0ac09ce7_20261010_095149.csv` | 6,195 | 4,374 | 0 | 原文件无中心列 |

5 份均明确标记 `source_model=PupilCore`，未出现身份识别绕过。两份历史 Capture 的二维别名不再被写入三维/raw/smooth 列；三份原生记录保留真实三维/raw 点并将合格 gaze 成员掩码转换为 51。全部 origin 由于与角膜曲率中心不等价而留空。此处掩码 51 是前轮未接入平滑时的结果；本轮的实际重导出统计另列，不沿用旧值。

三份原生记录的旧元数据仅记载标定内参分辨率 192×192；没有逐帧眼图尺寸证据。配置或标定尺寸不能独自证明历史实际图像尺寸，因此没有据此猜测回填中心或轴长。这一限制不影响合格毫米直径的独立保留。

### 自动化与界面验证

2026-10-25 重新运行完整 Python 回归 **342 项：337 通过、5 跳过、0 失败**，覆盖新增场景尺寸/变化代次的内部落盘证据。平滑专项检验解析阶跃响应、浮点稳定性、三轴与各眼质量、源时间配对、重复/迟到与排序边界、事件/标记隔离、旧设备兼容、11 列无源值屏蔽及真实预览/导出一致性，已通过。原133列、数据准确性、AOI和导出反馈专项亦通过。5 项 Python 跳过需要目标平台打包的映射、算法或状态程序。完整类型检查、架构检查、135 个 Python 文件语法检查和生产构建通过，构建仍有非阻塞的 chunk 体积提示。本次未制作或发布目标安装包。

```sh
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost services/eye_tracking/adapters/pupil_native/.venv/bin/python -m unittest discover -s tests/eye_tracking -t . -q
node tests/export/check_gaze_smoothing.mjs
node tests/export/check_eye_data_accuracy.mjs
node tests/export/check_pupil_standard_columns.mjs
node tests/export/check_export_feedback.mjs
node tests/export/check_aoi_export.mjs
node tests/export/check_aoi_export_ipc.mjs
node tests/recording/check_communication_bridge.mjs
node tests/analysis/check_pupil_sample_metrics.mjs
node tests/analysis/check_blink_intervals.mjs
node tests/analysis/check_analysis_access.mjs
node tests/mapping/check_fixation_pipeline.mjs
node tests/mapping/check_mapping_display.mjs
node tests/recording/check_huahong_recordings.mjs
node tests/recording/check_calibration_scores.mjs
node tests/recording/check_device_stream_lifecycle.mjs
node tests/eye_tracking/pupil_core/check_product_contracts.mjs
npm run check:architecture
npm run typecheck:all
npm run check:python
npm run build
git diff --check
```

新增专项：AOI纯逻辑和真实预览/完整导出IPC已通过；通信后端真实FFmpeg录制、CSV、恢复和本机WebSocket已通过，覆盖四方向、空/二进制/最大UDP载荷、会话和generation错配、停止后拒收、异常/未关闭状态、双日志去重与冲突拒绝。实际外设验收未替代。

通信桥、实际录制启动模块与 WebSocket 停止入口、启动后续步骤均通过回归。启动中取消会先关闭通信再停止后端；关闭失败保留会话供重试，停止过程不会回退到未记录的旧发送路径。原133列标准映射、数据准确性、采样统计和眨眼专项也通过。

专项覆盖：原 133 列 key、顺序和原表头精确快照；默认/全选和旧选择过滤；实际预览回调与真实 CSV IPC 一致；空选择及扩展字段在文件对话框前被拒绝；原始 CSV 不变；归一化单位、成员有效位、质量独立性、历史转换、尺寸缺失、真实零值、迟到断段、未知眼别和其他设备兼容。

浏览器使用真实 ExportPage、Modal、共享 CSS 的隔离渲染：8 组浅/深色 × macOS/Windows 样式标记 × 中文/英文，以及 4 组窄窗口通过打开、全不选、全选 133、分组折叠、键盘关闭、预览和模拟导出检查，未出现页面错误。Windows 为平台样式模拟；没有宣称 Windows 系统或完整桌面真机流程验收。仅提示文本的后续精简由导出专项再次验证。

新增串口设置使用真实组件、Modal 和共享 CSS 验证：8 组浅/深色 × macOS/Windows 样式标记 × 中文/英文均通过串口配置、端口选择、错误/重试、窄屏边界、焦点和状态保留检查。该结果证明组件与交互行为，不代替 Windows/macOS 实际系统串口、外设和安装包验收。

主要实现：`shared/constants/eyeExportColumns.ts`、`shared/domain/eyeExportData.ts`、`src/features/export/ExportPage.tsx`、`electron/domains/recording/recordExportHandlers.ts`，以及 `services/eye_tracking` 下的 Pupil worker、normalizer、service、CSV/event mapper、recorder 和 protocol。共享校准界面没有新增厂商分支页面。

专项测试：`tests/export/check_gaze_smoothing.mjs`、`tests/export/check_eye_data_accuracy.mjs`、`tests/export/check_pupil_standard_columns.mjs`、`tests/eye_tracking/pupil_core/test_standard_pupil_columns.py`、`test_capture_geometry.py`、`test_native_gaze_availability.py`、`test_native_frame_dimensions.py` 等。新增标准列专项已纳入 Pupil CI。

## 7. 原顺序逐列清单

下表的“直接实现”和“条件实现”均指软件映射状态。源量有效性、单眼/双眼模式和事件状态仍决定每个单元格是否有值。完整来源与代码证据见 Excel 对应行。

| 序号 | 原字段键 | 中文名 | 状态 | 单位 / 写入条件 | 未完成或使用边界 |
| ---: | --- | --- | --- | --- | --- |
| 1 | `record_name` | 记录名称 | 直接实现 | 文本；当前导出记录名称 | 按真实来源及有效性写入 |
| 2 | `user` | 受试者 | 直接实现 | 文本；受试者名称 | 未录入时为空，不从设备猜测 |
| 3 | `eye_data_record` | 眼动数据记录 | 直接实现 | 文本；记录ID | 按真实来源及有效性写入 |
| 4 | `time_of_day` | 可读时间（时:分:秒.毫秒） | 条件实现 | 本地民用时钟 HH:mm:ss.ms；非Pupil任意起点秒时钟 | 不能将Pupil源秒时间或相对毫秒时间当Unix时间 |
| 5 | `video_time_ms` | 视频时间轴（可读时间） | 直接实现 | HH:mm:ss.ms；列key含ms但标准导出为可读视频时间 | 缺失值不回退其他时钟 |
| 6 | `timestamp` | 时间戳(ms) | 直接实现 | ms；视频当前时间；不同于原始Pupil秒时间戳 | Pupil显式视频时间缺失不得回退epoch或设备时钟；旧7invensun无video_time_ms的未标单位timestamp沿用兼容原值，单位歧义待原始元数据确认 |
| 7 | `tracking_ratio_pct` | 跟踪有效率(%) | 条件实现 | % = 有效gaze采样行 / 实际gaze采样行 ×100 | 不是校准精度或瞳孔有效率；无依据留空 |
| 8 | `sampling_rate_hz` | 实际采样率(Hz) | 条件实现 | Hz = gaze采样消息数 / 录制时长 | 不是USB眼相机帧率；不以fixation事件频率替代 |
| 9 | `configured_sampling_rate_hz` | 数据采样率(Hz) | 直接实现 | Hz；设备配置或自动模式下的软件数据采样设置 | 不得声称由此测得相机硬件帧率 |
| 10 | `record_duration_s` | 时长(s) | 直接实现 | s；实际录制/媒体时长 | 不从最后一条眼动样本补造完整视频时长 |
| 11 | `left_pupil_bit_mask` | 左眼瞳孔BitMask | 条件实现 | 6位标准成员有效掩码：bit0中心，1距离，2归一化直径，3毫米直径，4归一化短轴，5毫米短轴 | 不能将pupil_valid布尔当完整mask；空distance/minor_mm对应位必须为0 |
| 12 | `left_pupil_center_x` | 左眼瞳孔中心X | 条件实现 | 无量纲归一化眼图坐标；x_px / eye_image_width | 历史文件缺眼图尺寸不可把px直接填入标准归一化列；已归一化新schema不得二次相除 |
| 13 | `left_pupil_center_y` | 左眼瞳孔中心Y | 条件实现 | 无量纲归一化眼图坐标；y_px / eye_image_height | 历史文件缺眼图尺寸不可把px直接填入标准归一化列；已归一化新schema不得二次相除 |
| 14 | `left_pupil_minor_axis` | 左眼瞳孔短轴 | 条件实现 | 无量纲；2D椭圆minor_axis_px / 眼图width | 短轴也除宽度而非高度；缺真实宽度留空；未知/低质量像素拟合不得伪称有效 |
| 15 | `left_pupil_minor_axis_mm` | 左眼瞳孔短轴(mm) | 无同义真实源 | mm；标准瞳孔物理短轴 | 标准列留空；真实直径与归一化图像短轴分别保留。未有独立物理短轴；2D短长轴比乘3D直径混淆投影／折射；不复制圆直径填充 |
| 16 | `right_pupil_bit_mask` | 右眼瞳孔BitMask | 条件实现 | 6位标准成员有效掩码：bit0中心，1距离，2归一化直径，3毫米直径，4归一化短轴，5毫米短轴 | 不能将pupil_valid布尔当完整mask；空distance/minor_mm对应位必须为0 |
| 17 | `right_pupil_center_x` | 右眼瞳孔中心X | 条件实现 | 无量纲归一化眼图坐标；x_px / eye_image_width | 历史文件缺眼图尺寸不可把px直接填入标准归一化列；已归一化新schema不得二次相除 |
| 18 | `right_pupil_center_y` | 右眼瞳孔中心Y | 条件实现 | 无量纲归一化眼图坐标；y_px / eye_image_height | 历史文件缺眼图尺寸不可把px直接填入标准归一化列；已归一化新schema不得二次相除 |
| 19 | `right_pupil_minor_axis` | 右眼瞳孔短轴 | 条件实现 | 无量纲；2D椭圆minor_axis_px / 眼图width | 短轴也除宽度而非高度；缺真实宽度留空；未知/低质量像素拟合不得伪称有效 |
| 20 | `right_pupil_minor_axis_mm` | 右眼瞳孔短轴(mm) | 无同义真实源 | mm；标准瞳孔物理短轴 | 标准列留空；真实直径与归一化图像短轴分别保留。未有独立物理短轴；2D短长轴比乘3D直径混淆投影／折射；不复制圆直径填充 |
| 21 | `left_pupil_diameter` | 左眼瞳孔直径 | 条件实现 | 无量纲；2D椭圆长轴直径px / 眼图width | 无眼图宽度留空；不得把毫米值、低置信度raw像素或不明单位值塞入；detected2D有效与3D坏模型需分开判断 |
| 22 | `right_pupil_diameter` | 右眼瞳孔直径 | 条件实现 | 无量纲；2D椭圆长轴直径px / 眼图width | 无眼图宽度留空；不得把毫米值、低置信度raw像素或不明单位值塞入；detected2D有效与3D坏模型需分开判断 |
| 23 | `left_pupil_diameter_mm` | 左眼瞳孔直径(mm) | 直接实现 | mm；pye3d折射眼模型估计的瞳孔直径 | 需要合格3D模型/该眼有效；分析统计再按该眼已知眨眼筛选；模型估计不等于独立物理标定测量 |
| 24 | `right_pupil_diameter_mm` | 右眼瞳孔直径(mm) | 直接实现 | mm；pye3d折射眼模型估计的瞳孔直径 | 需要合格3D模型/该眼有效；分析统计再按该眼已知眨眼筛选；模型估计不等于独立物理标定测量 |
| 25 | `left_pupil_distance` | 左眼瞳孔距离 | 无同义真实源 | mm；标准 pupil-to-lens distance，尚缺参考点与几何定义 | 新writer不把Z深度写距离；标准导出屏蔽历史Z残留，留空。SDK未说明镜头参考点及Z／欧氏定义；需先确认契约，不能换用范数宣称等价 |
| 26 | `right_pupil_distance` | 右眼瞳孔距离 | 无同义真实源 | mm；标准 pupil-to-lens distance，尚缺参考点与几何定义 | 新writer不把Z深度写距离；标准导出屏蔽历史Z残留，留空。SDK未说明镜头参考点及Z／欧氏定义；需先确认契约，不能换用范数宣称等价 |
| 27 | `recommend` | 推荐注视 | 条件实现 | 枚举0无/1推荐左眼/2推荐右眼；不是布尔 | 双眼融合无对应SDK枚举；不得将双眼融合有效写1/2或猜眼别 |
| 28 | `recom_gaze_x` | 推荐注视X | 直接实现 | 场景图像归一化坐标0..1，左上原点；Pupil原norm_pos的y须翻转 | 推荐融合的真实校准结果可有值，不要求独立单眼映射；无可靠推荐映射时留空；跨厂商比较需对齐坐标空间 |
| 29 | `recom_gaze_y` | 推荐注视Y | 直接实现 | 场景图像归一化坐标0..1，左上原点；Pupil原norm_pos的y须翻转 | 推荐融合的真实校准结果可有值，不要求独立单眼映射；无可靠推荐映射时留空；跨厂商比较需对齐坐标空间 |
| 30 | `recom_gaze_bit_mask` | 推荐注视BitMask | 条件实现 | 6位标准成员mask：bit0 gaze_point_xyz，1 raw_xyz，2 smooth_xyz，3 corneal_origin_xyz，4 direction_xyz，5 re | bit0不是独立gaze_x/y；不能把MRT内部三位当厂商六位；屏蔽origin/smooth后对应位为0 |
| 31 | `recom_gaze_point_x` | 推荐注视点X | 直接实现 | Pupil世界相机3D点分量，mm；单眼深度可为模型估计，非实测深度 | Capture若无已知真实3D/空间证据则留空，禁止将normalized xy放入3D列或补造z；跨厂商需明确坐标空间 |
| 32 | `recom_gaze_point_y` | 推荐注视点Y | 直接实现 | Pupil世界相机3D点分量，mm；单眼深度可为模型估计，非实测深度 | Capture若无已知真实3D/空间证据则留空，禁止将normalized xy放入3D列或补造z；跨厂商需明确坐标空间 |
| 33 | `recom_gaze_point_z` | 推荐注视点Z | 直接实现 | Pupil世界相机3D点分量，mm；单眼深度可为模型估计，非实测深度 | Capture若无已知真实3D/空间证据则留空，禁止将normalized xy放入3D列或补造z；跨厂商需明确坐标空间 |
| 34 | `recom_raw_point_x` | 推荐原始点X | 直接实现 | Pupil世界相机3D点分量，mm；raw为未额外平滑的校准映射点，不是未校准传感器原值 | Capture若无已知真实3D/空间证据则留空，禁止将normalized xy放入3D列或补造z；跨厂商需明确坐标空间 |
| 35 | `recom_raw_point_y` | 推荐原始点Y | 直接实现 | Pupil世界相机3D点分量，mm；raw为未额外平滑的校准映射点，不是未校准传感器原值 | Capture若无已知真实3D/空间证据则留空，禁止将normalized xy放入3D列或补造z；跨厂商需明确坐标空间 |
| 36 | `recom_raw_point_z` | 推荐原始点Z | 直接实现 | Pupil世界相机3D点分量，mm；raw为未额外平滑的校准映射点，不是未校准传感器原值 | Capture若无已知真实3D/空间证据则留空，禁止将normalized xy放入3D列或补造z；跨厂商需明确坐标空间 |
| 37 | `recom_smooth_point_x` | 推荐平滑点X | 条件实现 | 世界相机坐标，mm；本软件独立平滑，非厂商官方滤波 | 导出／预览因果低通 v1：τ=25ms；α=-expm1(-dt/25)；第二连续有效点起输出。缺失／重复／逆序／迟到／来源变化或间隔>100ms重置；不回写原件，真机验收未完成 |
| 38 | `recom_smooth_point_y` | 推荐平滑点Y | 条件实现 | 世界相机坐标，mm；本软件独立平滑，非厂商官方滤波 | 导出／预览因果低通 v1：τ=25ms；α=-expm1(-dt/25)；第二连续有效点起输出。缺失／重复／逆序／迟到／来源变化或间隔>100ms重置；不回写原件，真机验收未完成 |
| 39 | `recom_smooth_point_z` | 推荐平滑点Z | 条件实现 | 世界相机坐标，mm；本软件独立平滑，非厂商官方滤波 | 导出／预览因果低通 v1：τ=25ms；α=-expm1(-dt/25)；第二连续有效点起输出。缺失／重复／逆序／迟到／来源变化或间隔>100ms重置；不回写原件，真机验收未完成 |
| 40 | `recom_origin_x` | 推荐射线起点X | 无同义真实源 | 标准要求角膜曲率中心；不能以眼球中心替代 | 内部眼球几何保留；133标准导出拒绝旧眼球／虚拟中心别名，留空。Le Grand统一参数可建理想模型；现无个体角膜参数与同义验证，不能冒充角膜测量 |
| 41 | `recom_origin_y` | 推荐射线起点Y | 无同义真实源 | 标准要求角膜曲率中心；不能以眼球中心替代 | 内部眼球几何保留；133标准导出拒绝旧眼球／虚拟中心别名，留空。Le Grand统一参数可建理想模型；现无个体角膜参数与同义验证，不能冒充角膜测量 |
| 42 | `recom_origin_z` | 推荐射线起点Z | 无同义真实源 | 标准要求角膜曲率中心；不能以眼球中心替代 | 内部眼球几何保留；133标准导出拒绝旧眼球／虚拟中心别名，留空。Le Grand统一参数可建理想模型；现无个体角膜参数与同义验证，不能冒充角膜测量 |
| 43 | `recom_direction_x` | 推荐射线方向X | 直接实现 | 无量纲视线单位向量分量；Pupil世界相机坐标系 | 只能用于明确相同坐标系的运算；没有真实方向时不能从2D xy猜3D方向 |
| 44 | `recom_direction_y` | 推荐射线方向Y | 直接实现 | 无量纲视线单位向量分量；Pupil世界相机坐标系 | 只能用于明确相同坐标系的运算；没有真实方向时不能从2D xy猜3D方向 |
| 45 | `recom_direction_z` | 推荐射线方向Z | 直接实现 | 无量纲视线单位向量分量；Pupil世界相机坐标系 | 只能用于明确相同坐标系的运算；没有真实方向时不能从2D xy猜3D方向 |
| 46 | `recom_re` | 推荐注视置信度 | 直接实现 | 0..1 源gaze/贡献瞳孔置信度；非校准精度或独立拟合误差 | 不等于独立像素/角度精度；Capture双眼源没有独立左右映射时不复制re到两眼 |
| 47 | `left_gaze_x` | 左眼注视X | 直接实现 | 场景图像归一化坐标0..1，左上原点；Pupil原norm_pos的y须翻转 | Capture无独立单眼映射时为空，不能把双眼结果复制到两眼；与其他设备坐标系比较需明确各自空间 |
| 48 | `left_gaze_y` | 左眼注视Y | 直接实现 | 场景图像归一化坐标0..1，左上原点；Pupil原norm_pos的y须翻转 | Capture无独立单眼映射时为空，不能把双眼结果复制到两眼；与其他设备坐标系比较需明确各自空间 |
| 49 | `left_gaze_bit_mask` | 左眼注视BitMask | 条件实现 | 6位标准成员mask：bit0 gaze_point_xyz，1 raw_xyz，2 smooth_xyz，3 corneal_origin_xyz，4 direction_xyz，5 re | bit0不是独立gaze_x/y；不能把MRT内部三位当厂商六位；屏蔽origin/smooth后对应位为0 |
| 50 | `left_gaze_point_x` | 左眼注视点X | 直接实现 | Pupil世界相机3D点分量，mm；单眼深度可为模型估计，非实测深度 | Capture若无已知真实3D/空间证据则留空，禁止将normalized xy放入3D列或补造z；跨厂商需明确坐标空间 |
| 51 | `left_gaze_point_y` | 左眼注视点Y | 直接实现 | Pupil世界相机3D点分量，mm；单眼深度可为模型估计，非实测深度 | Capture若无已知真实3D/空间证据则留空，禁止将normalized xy放入3D列或补造z；跨厂商需明确坐标空间 |
| 52 | `left_gaze_point_z` | 左眼注视点Z | 直接实现 | Pupil世界相机3D点分量，mm；单眼深度可为模型估计，非实测深度 | Capture若无已知真实3D/空间证据则留空，禁止将normalized xy放入3D列或补造z；跨厂商需明确坐标空间 |
| 53 | `left_raw_point_x` | 左眼原始点X | 直接实现 | Pupil世界相机3D点分量，mm；raw为未额外平滑的校准映射点，不是未校准传感器原值 | Capture若无已知真实3D/空间证据则留空，禁止将normalized xy放入3D列或补造z；跨厂商需明确坐标空间 |
| 54 | `left_raw_point_y` | 左眼原始点Y | 直接实现 | Pupil世界相机3D点分量，mm；raw为未额外平滑的校准映射点，不是未校准传感器原值 | Capture若无已知真实3D/空间证据则留空，禁止将normalized xy放入3D列或补造z；跨厂商需明确坐标空间 |
| 55 | `left_raw_point_z` | 左眼原始点Z | 直接实现 | Pupil世界相机3D点分量，mm；raw为未额外平滑的校准映射点，不是未校准传感器原值 | Capture若无已知真实3D/空间证据则留空，禁止将normalized xy放入3D列或补造z；跨厂商需明确坐标空间 |
| 56 | `left_smooth_point_x` | 左眼平滑点X | 条件实现 | 世界相机坐标，mm；本软件独立平滑，非厂商官方滤波 | 导出／预览因果低通 v1：τ=25ms；α=-expm1(-dt/25)；第二连续有效点起输出。缺失／重复／逆序／迟到／来源变化或间隔>100ms重置；不回写原件，真机验收未完成 |
| 57 | `left_smooth_point_y` | 左眼平滑点Y | 条件实现 | 世界相机坐标，mm；本软件独立平滑，非厂商官方滤波 | 导出／预览因果低通 v1：τ=25ms；α=-expm1(-dt/25)；第二连续有效点起输出。缺失／重复／逆序／迟到／来源变化或间隔>100ms重置；不回写原件，真机验收未完成 |
| 58 | `left_smooth_point_z` | 左眼平滑点Z | 条件实现 | 世界相机坐标，mm；本软件独立平滑，非厂商官方滤波 | 导出／预览因果低通 v1：τ=25ms；α=-expm1(-dt/25)；第二连续有效点起输出。缺失／重复／逆序／迟到／来源变化或间隔>100ms重置；不回写原件，真机验收未完成 |
| 59 | `left_origin_x` | 左眼射线起点X | 无同义真实源 | 标准要求角膜曲率中心；不能以眼球中心替代 | 内部眼球几何保留；133标准导出拒绝旧眼球／虚拟中心别名，留空。Le Grand统一参数可建理想模型；现无个体角膜参数与同义验证，不能冒充角膜测量 |
| 60 | `left_origin_y` | 左眼射线起点Y | 无同义真实源 | 标准要求角膜曲率中心；不能以眼球中心替代 | 内部眼球几何保留；133标准导出拒绝旧眼球／虚拟中心别名，留空。Le Grand统一参数可建理想模型；现无个体角膜参数与同义验证，不能冒充角膜测量 |
| 61 | `left_origin_z` | 左眼射线起点Z | 无同义真实源 | 标准要求角膜曲率中心；不能以眼球中心替代 | 内部眼球几何保留；133标准导出拒绝旧眼球／虚拟中心别名，留空。Le Grand统一参数可建理想模型；现无个体角膜参数与同义验证，不能冒充角膜测量 |
| 62 | `left_direction_x` | 左眼射线方向X | 直接实现 | 无量纲视线单位向量分量；Pupil世界相机坐标系 | 只能用于明确相同坐标系的运算；没有真实方向时不能从2D xy猜3D方向 |
| 63 | `left_direction_y` | 左眼射线方向Y | 直接实现 | 无量纲视线单位向量分量；Pupil世界相机坐标系 | 只能用于明确相同坐标系的运算；没有真实方向时不能从2D xy猜3D方向 |
| 64 | `left_direction_z` | 左眼射线方向Z | 直接实现 | 无量纲视线单位向量分量；Pupil世界相机坐标系 | 只能用于明确相同坐标系的运算；没有真实方向时不能从2D xy猜3D方向 |
| 65 | `left_re` | 左眼注视置信度 | 直接实现 | 0..1 源gaze/贡献瞳孔置信度；非校准精度或独立拟合误差 | 不等于独立像素/角度精度；Capture双眼源没有独立左右映射时不复制re到两眼 |
| 66 | `right_gaze_x` | 右眼注视X | 直接实现 | 场景图像归一化坐标0..1，左上原点；Pupil原norm_pos的y须翻转 | Capture无独立单眼映射时为空，不能把双眼结果复制到两眼；与其他设备坐标系比较需明确各自空间 |
| 67 | `right_gaze_y` | 右眼注视Y | 直接实现 | 场景图像归一化坐标0..1，左上原点；Pupil原norm_pos的y须翻转 | Capture无独立单眼映射时为空，不能把双眼结果复制到两眼；与其他设备坐标系比较需明确各自空间 |
| 68 | `right_gaze_bit_mask` | 右眼注视BitMask | 条件实现 | 6位标准成员mask：bit0 gaze_point_xyz，1 raw_xyz，2 smooth_xyz，3 corneal_origin_xyz，4 direction_xyz，5 re | bit0不是独立gaze_x/y；不能把MRT内部三位当厂商六位；屏蔽origin/smooth后对应位为0 |
| 69 | `right_gaze_point_x` | 右眼注视点X | 直接实现 | Pupil世界相机3D点分量，mm；单眼深度可为模型估计，非实测深度 | Capture若无已知真实3D/空间证据则留空，禁止将normalized xy放入3D列或补造z；跨厂商需明确坐标空间 |
| 70 | `right_gaze_point_y` | 右眼注视点Y | 直接实现 | Pupil世界相机3D点分量，mm；单眼深度可为模型估计，非实测深度 | Capture若无已知真实3D/空间证据则留空，禁止将normalized xy放入3D列或补造z；跨厂商需明确坐标空间 |
| 71 | `right_gaze_point_z` | 右眼注视点Z | 直接实现 | Pupil世界相机3D点分量，mm；单眼深度可为模型估计，非实测深度 | Capture若无已知真实3D/空间证据则留空，禁止将normalized xy放入3D列或补造z；跨厂商需明确坐标空间 |
| 72 | `right_raw_point_x` | 右眼原始点X | 直接实现 | Pupil世界相机3D点分量，mm；raw为未额外平滑的校准映射点，不是未校准传感器原值 | Capture若无已知真实3D/空间证据则留空，禁止将normalized xy放入3D列或补造z；跨厂商需明确坐标空间 |
| 73 | `right_raw_point_y` | 右眼原始点Y | 直接实现 | Pupil世界相机3D点分量，mm；raw为未额外平滑的校准映射点，不是未校准传感器原值 | Capture若无已知真实3D/空间证据则留空，禁止将normalized xy放入3D列或补造z；跨厂商需明确坐标空间 |
| 74 | `right_raw_point_z` | 右眼原始点Z | 直接实现 | Pupil世界相机3D点分量，mm；raw为未额外平滑的校准映射点，不是未校准传感器原值 | Capture若无已知真实3D/空间证据则留空，禁止将normalized xy放入3D列或补造z；跨厂商需明确坐标空间 |
| 75 | `right_smooth_point_x` | 右眼平滑点X | 条件实现 | 世界相机坐标，mm；本软件独立平滑，非厂商官方滤波 | 导出／预览因果低通 v1：τ=25ms；α=-expm1(-dt/25)；第二连续有效点起输出。缺失／重复／逆序／迟到／来源变化或间隔>100ms重置；不回写原件，真机验收未完成 |
| 76 | `right_smooth_point_y` | 右眼平滑点Y | 条件实现 | 世界相机坐标，mm；本软件独立平滑，非厂商官方滤波 | 导出／预览因果低通 v1：τ=25ms；α=-expm1(-dt/25)；第二连续有效点起输出。缺失／重复／逆序／迟到／来源变化或间隔>100ms重置；不回写原件，真机验收未完成 |
| 77 | `right_smooth_point_z` | 右眼平滑点Z | 条件实现 | 世界相机坐标，mm；本软件独立平滑，非厂商官方滤波 | 导出／预览因果低通 v1：τ=25ms；α=-expm1(-dt/25)；第二连续有效点起输出。缺失／重复／逆序／迟到／来源变化或间隔>100ms重置；不回写原件，真机验收未完成 |
| 78 | `right_origin_x` | 右眼射线起点X | 无同义真实源 | 标准要求角膜曲率中心；不能以眼球中心替代 | 内部眼球几何保留；133标准导出拒绝旧眼球／虚拟中心别名，留空。Le Grand统一参数可建理想模型；现无个体角膜参数与同义验证，不能冒充角膜测量 |
| 79 | `right_origin_y` | 右眼射线起点Y | 无同义真实源 | 标准要求角膜曲率中心；不能以眼球中心替代 | 内部眼球几何保留；133标准导出拒绝旧眼球／虚拟中心别名，留空。Le Grand统一参数可建理想模型；现无个体角膜参数与同义验证，不能冒充角膜测量 |
| 80 | `right_origin_z` | 右眼射线起点Z | 无同义真实源 | 标准要求角膜曲率中心；不能以眼球中心替代 | 内部眼球几何保留；133标准导出拒绝旧眼球／虚拟中心别名，留空。Le Grand统一参数可建理想模型；现无个体角膜参数与同义验证，不能冒充角膜测量 |
| 81 | `right_direction_x` | 右眼射线方向X | 直接实现 | 无量纲视线单位向量分量；Pupil世界相机坐标系 | 只能用于明确相同坐标系的运算；没有真实方向时不能从2D xy猜3D方向 |
| 82 | `right_direction_y` | 右眼射线方向Y | 直接实现 | 无量纲视线单位向量分量；Pupil世界相机坐标系 | 只能用于明确相同坐标系的运算；没有真实方向时不能从2D xy猜3D方向 |
| 83 | `right_direction_z` | 右眼射线方向Z | 直接实现 | 无量纲视线单位向量分量；Pupil世界相机坐标系 | 只能用于明确相同坐标系的运算；没有真实方向时不能从2D xy猜3D方向 |
| 84 | `right_re` | 右眼注视置信度 | 直接实现 | 0..1 源gaze/贡献瞳孔置信度；非校准精度或独立拟合误差 | 不等于独立像素/角度精度；Capture双眼源没有独立左右映射时不复制re到两眼 |
| 85 | `fixation_timestamp` | 注视时间戳(ms) | 直接实现 | ms；注视源区间开始的视频时间 | 缺可靠视频时间不借其他时钟 |
| 86 | `fixation_duration` | 注视持续时长 | 直接实现 | ms；必须结合state区分完整事件与进行中/不完整区间 | state3不得当完整结束事件；Capture旧在线窗口非全段无重叠均值 |
| 87 | `fixation_count` | 注视序号 | 直接实现 | 从1开始的软件注视事件序号；不是SDK原stats.count样本数 | 重叠同ID窗口只算同一事件；不得用gaze行号当事件序号 |
| 88 | `fixation_state` | 注视状态 | 直接实现 | 0无效/1眼跳中/2眼跳结束/3注视中或不完整/4注视结束 | 算法事件状态不表示与7invensun检测阈值同等 |
| 89 | `fixation_center_x` | 注视中心X | 条件实现 | px；场景图像左上坐标X | 缺真实world/video尺寸留空；不使用默认分辨率；进行中中心仍需结合fixation_state解读 |
| 90 | `fixation_center_y` | 注视中心Y | 条件实现 | px；场景图像左上坐标Y | 缺真实world/video尺寸留空；不使用默认分辨率；进行中中心仍需结合fixation_state解读 |
| 91 | `invalid_gaze_index` | 无效眼动序号 | 条件实现 | 连续可观测无效采样段序号 | 未知有效性不能当false；不得跨断档/重连/刺激物拼段 |
| 92 | `invalid_gaze_duration_ms` | 无效眼动时长(ms) | 条件实现 | ms；可观测无效采样段时长 | 最后未知间隙不可补齐到下一个远处样本 |
| 93 | `saccade_index` | 眼跳序号 | 条件实现 | 从1开始的完整算法眼跳序号 | 不是Pupil Capture自带或7invensun SDK等效事件 |
| 94 | `saccade_duration_ms` | 眼跳持续时长 | 条件实现 | ms；完整I-VT眼跳区间时长 | 无效/断档/末尾未结束候选不补造事件 |
| 95 | `saccade_amplitude_px` | 眼跳幅度(px) | 条件实现 | px；相邻完整注视中心间距离 | 缺前后任一注视留空；不可用眼跳自身端点位移替代 |
| 96 | `average_saccade_velocity_px_ms` | 平均眼跳速度 | 条件实现 | px/ms；眼跳内逐间隔像素速度按时间加权平均 | 不是相邻注视幅度/持续时间，更不是角速度换名 |
| 97 | `peak_saccade_velocity_px_ms` | 最大眼跳速度(px/ms) | 条件实现 | px/ms；完整眼跳内观测到的逐间隔最大像素速度 | 缺采样时不从均值推峰值 |
| 98 | `gaze_velocity_px_ms` | 注视速度(px/ms) | 条件实现 | px/ms；相邻合格场景点像素位移/源时间差 | 缺真实场景尺寸留空；改变贡献眼/模型、尺寸（包括A→B→A）、无效/迟到/断流不跨段；不得以normalized速度充当px速度 |
| 99 | `gaze_velocity_deg_ms` | 注视角速度(deg/ms) | 条件实现 | deg/ms；相邻真实视线单位向量夹角/源时间差 | 当前mapper还要求可信场景尺寸及连续同上下文采样；不能从2D像素直接猜视角；deg/ms不等于deg/s |
| 100 | `saccade_distance_deg` | 眼跳角距离 | 条件实现 | deg；相邻完整注视平均视线夹角 | 不可用眼跳端点角位移代替相邻注视方向距离 |
| 101 | `average_saccade_velocity_deg_ms` | 平均眼跳角速度 | 条件实现 | deg/ms；眼跳内逐间隔角速度的时间加权平均 | 需保持deg/ms，不混淆deg/s；不能从二维速度推造 |
| 102 | `peak_saccade_velocity_deg_ms` | 眼跳峰值角速度 | 条件实现 | deg/ms；眼跳内观测到的最大逐间隔角速度 | 缺真实逐采样角速度不计算峰值 |
| 103 | `gaze_velocity_ms` | 眼动速度（原坐标/ms） | 条件实现 | Pupil为normalized/ms；旧列保留来源坐标/ms语义，不能称px/ms | 133不新增单位列时必须在字段说明中明确Pupil单位；不可跨单位直接平均 |
| 104 | `blink_index` | 眨眼序号 | 条件实现 | 序号；按眼配对后，完整配对按 onset 时间统一编号 | phase消息不是次数；Capture未提供眼别仍可保留未知眼别配对 |
| 105 | `blink_duration_ms` | 眨眼时长(ms) | 条件实现 | ms；offset-onset完整源区间时长 | 未配对/缺offset不补齐到录制结束；不等同AOI内时长 |
| 106 | `blink_marker` | 眨眼标记 | 条件实现 | 标准1左/2右/3双眼 | 不同眼事件同时发生不能自动合并成marker3；未知眼别不能猜双眼 |
| 107 | `left_blink` | 左眼眨眼 | 条件实现 | 7invensun眼镜标准状态0睁眼/3闭眼；Pupil内部0/1需明确转换 | 未知眼别保持空；未配对 phase 只保留已知眼别的即时状态，不延展后续采样、不生成完整次数或时长 |
| 108 | `left_openness` | 左眼睁眼程度 | 无同义真实源 | 0..100 睁眼程度 | 标准导出留空并拒绝非空残留；真实blink仍单独输出。无0..100百分比测量及基线；不可用confidence、眨眼布尔替代 |
| 109 | `left_eyelid_up` | 左上眼睑 | 无同义真实源 | 0..1 眼图垂直眼睑位置 | 标准导出留空并拒绝非空残留；真实blink仍单独输出。无眼睑分割结果；现有附档未保存眼图，不能从pupil ellipse反推眼睑 |
| 110 | `left_eyelid_down` | 左下眼睑 | 无同义真实源 | 0..1 眼图垂直眼睑位置 | 标准导出留空并拒绝非空残留；真实blink仍单独输出。无眼睑分割结果；现有附档未保存眼图，不能从pupil ellipse反推眼睑 |
| 111 | `right_blink` | 右眼眨眼 | 条件实现 | 7invensun眼镜标准状态0睁眼/3闭眼；Pupil内部0/1需明确转换 | 未知眼别保持空；未配对 phase 只保留已知眼别的即时状态，不延展后续采样、不生成完整次数或时长 |
| 112 | `right_openness` | 右眼睁眼程度 | 无同义真实源 | 0..100 睁眼程度 | 标准导出留空并拒绝非空残留；真实blink仍单独输出。无0..100百分比测量及基线；不可用confidence、眨眼布尔替代 |
| 113 | `right_eyelid_up` | 右上眼睑 | 无同义真实源 | 0..1 眼图垂直眼睑位置 | 标准导出留空并拒绝非空残留；真实blink仍单独输出。无眼睑分割结果；现有附档未保存眼图，不能从pupil ellipse反推眼睑 |
| 114 | `right_eyelid_down` | 右下眼睑 | 无同义真实源 | 0..1 眼图垂直眼睑位置 | 标准导出留空并拒绝非空残留；真实blink仍单独输出。无眼睑分割结果；现有附档未保存眼图，不能从pupil ellipse反推眼睑 |
| 115 | `gyro_timestamp` | 陀螺仪时间戳 | 无同义真实源 | IMU源时间戳；需真实传感器时钟定义 | 标准导出留空并拒绝历史／外部CSV残留；不借Invisible／Neon数据。没有真实Core IMU样本；不得套用gaze／video时间伪造惯性采样时标 |
| 116 | `gyro_quaternion` | 四元数 | 无同义真实源 | 四元数4分量；需真实姿态坐标与顺序定义 | 标准导出留空并拒绝历史／外部CSV残留；不借Invisible／Neon数据。缺惯性源与已定义姿态融合；眼球朝向／视觉头姿不能作为IMU四元数 |
| 117 | `gyroscope` | 角速度 | 无同义真实源 | 真实IMU角速度三分量；单位依来源定义 | 标准导出留空并拒绝历史／外部CSV残留；不借Invisible／Neon数据。缺真实陀螺仪；视线差分不是头戴设备惯性角速度 |
| 118 | `acceleration` | 加速度 | 无同义真实源 | 真实IMU加速度三分量；单位依来源定义 | 标准导出留空并拒绝历史／外部CSV残留；不借Invisible／Neon数据。缺加速度计及单位／轴向契约；场景运动不能替代传感器测量 |
| 119 | `magnetometer` | 磁强度 | 无同义真实源 | 真实磁场三分量；单位依来源定义 | 标准导出留空并拒绝历史／外部CSV残留；不借Invisible／Neon数据。缺磁力计；视频、gaze、瞳孔数据不能测得环境磁场 |
| 120 | `aoi_id` | AOI编号 | 条件实现 | AOI标识；单个为文本，多个为同序JSON数组 | 读取当前记录已保存AOI定义，按定义存储顺序输出标识。需保存AOI及有效位置/时间。多AOI各列同序数组，未知null；无定位不借附近点。注视次数另需可靠事件依据；真机验收待完成。 |
| 121 | `aoi_name` | AOI名称 | 条件实现 | AOI名称；单个为文本，多个为同序JSON数组 | 读取与编号对应的已保存AOI名称，预览与正式导出共享上下文。需保存AOI及有效位置/时间。多AOI各列同序数组，未知null；无定位不借附近点。注视次数另需可靠事件依据；真机验收待完成。 |
| 122 | `aoi_hit` | AOI命中 | 条件实现 | 已知有效位置：区域内1、区域外0；未知为空/null | 按视频时间计算静态/动态AOI，重叠AOI逐项输出命中。需保存AOI及有效位置/时间。多AOI各列同序数组，未知null；无定位不借附近点。注视次数另需可靠事件依据；真机验收待完成。 |
| 123 | `aoi_enter_time_ms` | AOI进入时间(ms) | 条件实现 | ms；当前连续访问首个可信inside采样时间 | 每次连续进入时建立visit；无效/断档/来源变化不跨段续接。需保存AOI及有效位置/时间。多AOI各列同序数组，未知null；无定位不借附近点。注视次数另需可靠事件依据；真机验收待完成。 |
| 124 | `aoi_exit_time_ms` | AOI离开时间(ms) | 条件实现 | ms；连续可信outside采样时间，仅该离开行写值 | 只在观测到真实离开时输出；段尾与缺样不虚构exit。需保存AOI及有效位置/时间。多AOI各列同序数组，未知null；无定位不借附近点。注视次数另需可靠事件依据；真机验收待完成。 |
| 125 | `aoi_dwell_time_ms` | AOI停留时长(ms) | 条件实现 | ms；当前visit已观测inside首末时间跨度 | 逐采样累计已观测停留；离开行截止lastInside，断档不累计。需保存AOI及有效位置/时间。多AOI各列同序数组，未知null；无定位不借附近点。注视次数另需可靠事件依据；真机验收待完成。 |
| 126 | `aoi_fixation_count` | AOI注视次数 | 条件实现 | 当前visit内、截至该行已完成注视事件的去重次数 | onset在visit/有效范围且中心命中onset动态AOI；完整事件end不晚于当前行。需保存AOI及有效位置/时间。多AOI各列同序数组，未知null；无定位不借附近点。注视次数另需可靠事件依据；真机验收待完成。 |
| 127 | `stimulus` | 刺激物 | 直接实现 | 文本；当前刺激物/整段录制视频名称 | 事件onset标签不等同整个区间的精确刺激物边界 |
| 128 | `triggerMark` | 触发标记 | 直接实现 | 原始标记名称或触发值；关联可靠视频时间 | 不是传感器采样；不得参与有效率/速度/无效段计数 |
| 129 | `customMarker` | 自定义标记 | 直接实现 | 原始标记名称或触发值；关联可靠视频时间 | 不是传感器采样；不得参与有效率/速度/无效段计数 |
| 130 | `udp_send` | UDP发送 | 条件实现 | 可逆单行JSON：encoding=utf-8/base64，data=原始文本/字节编码 | 真实I/O独立事件，源时钟对齐视频；双日志fsync持久化，按event_id去重，断链可恢复。需启用并发生真实I/O；空包保留。发送成功仅指本机I/O完成，非外设确认。异常/未关闭标partial；实体设备验收待完成。 |
| 131 | `udp_receive` | UDP接收 | 条件实现 | 可逆单行JSON：encoding=utf-8/base64，data=原始文本/字节编码 | 真实I/O独立事件，源时钟对齐视频；双日志fsync持久化，按event_id去重，断链可恢复。需启用并发生真实I/O；空包保留。发送成功仅指本机I/O完成，非外设确认。异常/未关闭标partial；实体设备验收待完成。 |
| 132 | `trigger_send` | 触发发送 | 条件实现 | 可逆单行JSON：encoding=utf-8/base64，data=原始文本/字节编码 | 真实I/O独立事件，源时钟对齐视频；双日志fsync持久化，按event_id去重，断链可恢复。需启用并发生真实I/O；空包保留。发送成功仅指本机I/O完成，非外设确认。异常/未关闭标partial；实体设备验收待完成。 |
| 133 | `trigger_receive` | 触发接收 | 条件实现 | 可逆单行JSON：encoding=utf-8/base64，data=原始文本/字节编码 | 真实I/O独立事件，源时钟对齐视频；双日志fsync持久化，按event_id去重，断链可恢复。需启用并发生真实I/O；空包保留。发送成功仅指本机I/O完成，非外设确认。异常/未关闭标partial；实体设备验收待完成。 |

维护入口：[导出字段说明](../说明文档/导出字段说明.md)、[眼动数据与 AOI 说明](../说明文档/眼动数据与AOI说明.md)、[维护手册](../维护/维护手册.md)。
