# Pupil 角度误差与独立验证

角度误差及独立验证已接入。2026-10-16 用户进一步确认启用自定义 1–10 分换算：`max(1, min(10, 10−2×角度误差))`，保留一位小数；不预设精度合格门槛。当前后端版本为 `pupil-native-v7-score`。

## 功能与数据

- 用相机内参将参考位置和 gaze 去畸变、反投影成单位射线，再计算夹角；不用固定像素比例换算。
- 训练结果新增 `training_angular`，独立验证结果新增 `validation.angular`。分别记录左眼、右眼、融合结果。缺少单眼数据时返回不可用，不复制融合结果。
- 保留原像素误差及 CSV 139 列定义。在现有校准完成、测试完成提示中显示角度和分数，不增加界面或窗口。右侧结果框显示有明确来源的新分数，历史未带评分元数据的结果仍按像素训练误差读取。
- 共享“校准测试”继续采集三个实体卡片目标，不重新拟合。目标应分散，且与训练中心归一化距离须大于 0.025；这是本软件防止明显重复训练位置的规则，不是官方精度门槛。
- 每点保存参考序列、匹配样本、每眼角度误差和相机内参。整体报告关联校准 token 与验证 session，进入后续录制的校准附档和 metadata。取消不保存半成品；超时、断连及校准被替换继续遵循既有失效流程。
- 无内参、分辨率不匹配或无有效角度样本时，明确报告角度不可用。型号默认内参与逐台标定内参分开标注。
- 每眼角度指标新增 `qualityScore`、`scoringPolicy=mrt_angular_linear_v1`、`scoreInputMetric=pupilCoreAccuracyDeg`、公式、范围及 `scoreIsOfficial=false`。独立报告顶层 `qualityScore` 为融合独立验证分；`accuracyAcceptance=not_configured`，验证完成不代表精度达标。

## 自定义分数

评分输入使用未四舍五入的 `pupilCoreAccuracyDeg`，不是像素误差、算术平均角度或左右眼分数的平均。输出按四舍五入保留一位小数，限制 1–10 分，越高越好。0° 对应 10 分、0.5° 对应 9 分、1° 对应 8 分、2° 对应 6 分、4.5° 及以上对应 1 分。

这是用户确认的软件显示尺度，不是 Pupil 或其他厂商评分，也不定义合格线。训练和独立验证分别标注；缺少内参、没有有效角度或所有样本被 5° 阈值剔除时，分数为 null，界面显示不可用。剔除不惩罚评分，因此必须一起看 P95、使用数/总数和有效率，不能只看分数判断质量。默认内参的局限仍然存在。

原 `left_score/right_score` 仍保存像素误差，防止历史导出字段被静默改变单位；显示分数使用单独的可选元数据。新校准会清理旧验证分，取消验证不会把部分结果写成完整验证；其他设备保留原有分值语义。

现有结果框先显示“校准训练分”，成功测试后显示“独立验证分”；缺少某眼验证数据时显示 `---`，不会使用该眼训练分补位。悬停数值可查看角度、P95、剔除数量、验证目标覆盖和有效率。`scores.pupilScores.training/validation` 随原 `calibration_result.json` 保存和重载；启用“保存眼校准”时，成功的 Pupil 验证即使仍处于测试模式也会保存。旧文件没有这些元数据时，继续按像素读取。

## 官方口径的边界

依据 [Pupil Core Accuracy Visualizer 源码](https://github.com/pupil-labs/pupil/blob/master/pupil_src/shared_modules/accuracy_visualizer.py)（2026-10-15 核对）实现角度统计公式对照。官方默认只纳入误差严格小于 5° 的样本，使用：

```text
pupilCoreAccuracyDeg = degrees(acos(mean(cos(error_rad))))
```

它不等于逐样本角度的算术平均。因此同时保留未剔除的 `meanErrorDeg`、中位数、P95、最大值，以及官方公式使用数、排除数和阈值。全部被排除时官方公式值为 null，不能显示为 0。

**对齐的是角度变换和统计公式，未宣称完整流水线与官方输出逐值一致。** 官方使用 closest-match 关联，本软件独立验证保留参考源时间插值（间隔不超过 100 ms）及既有置信度/模型过滤。报告明确记录配对方法和 `officialPipelineEquivalent=false`。

本轮未实现 precision 的相邻样本 RMS 指标，P95 不称为 precision。独立验证必须重新采集不同于训练的目标，历史训练数据不能补算成独立测试。[官方验证建议](https://docs.pupil-labs.com/core/best-practices/)

## 最新实验的训练角度重算

使用 2026-10-15 15:54:26 录制保存的校准参数和 88 对匹配样本，没有重新拟合、修改模型或改动原件。

| 输出 | 未剔除角度算术均值 | P95 | 官方公式对照值 | 官方公式使用数 |
| --- | ---: | ---: | ---: | ---: |
| 左眼 | 0.593° | 1.061° | 0.663° | 88/88 |
| 右眼 | 0.845° | 2.673° | 1.184° | 88/88 |
| 融合 | 1.743° | 4.573° | 2.333° | 88/88 |

第一个目标的融合角度算术均值 3.865°、P95 4.730°，仍是主要偏差来源。全部是**训练数据误差**，`independentValidationPerformed=false`。型号默认内参和软件延迟估计也没有经过逐台硬件测量。

按已确认规则换算：左眼 **8.7/10**、右眼 **7.6/10**、融合 **5.3/10**。这些是校准训练分，不能作为独立验证分或精度合格结论。

证据：[校准统计](../../pupil-derived/20261015-155426-angular-final/calibration-summary.csv)、[逐样本误差](../../pupil-derived/20261015-155426-angular-final/calibration-samples.csv)、[完整审计](../../pupil-derived/20261015-155426-angular-final/summary.json)。源消息至 CSV 无转换差异，原始文件哈希不变；该录制未提供分析缓存和回放索引，这两项仍未核验。

## Windows 使用

1. 更新源码环境，或使用 Windows 构建的新后端包，完整重启；确认日志为 `pupil-native-v7-score`。macOS 包不能用于 Windows。
2. 在现有录制页完成校准，提示中查看校准训练分、训练角度误差及官方公式对照值。
3. 点击现有“校准测试”，持续注视实体卡片中心，采样三个不同于训练且分散的位置，每点保持稳定约一秒。
4. 查看完成提示中的融合及左右眼独立验证分、角度结果、P95、有效率和排除数。
5. 随后录制并保存新实验，使独立验证报告随录制附档保存。旧录制不会自动变成独立验证数据。

## 验证结果

- 新测试覆盖已知夹角、分辨率缩放、radial/fisheye 去畸变、官方余弦统计与算术均值的区别、5° 排除边界、全排除/空样本、缺少单眼和内参、三点验证不拟合、取消保留完整报告及重复训练位置重试。
- 2026-10-16 完整眼动测试 **169 项全部通过，无跳过**，包含实际冻结程序的拟合与角度指标检查。日志：`services/build/pupil-validation/angular-suite.log`。
- `release:check`、共享设备生命周期检查和 `git diff --check` 通过。构建日志：`services/build/pupil-validation/angular-release.log`。
- 本机 macOS 本次构建后首次算法就绪 **1.657 秒**，2 秒预算通过，见[启动报告](../../services/build/pupil-validation/angular-first-after-build.json)。不代表干净 Windows 安装的冷启动，也不包括真实相机首帧与眼模型稳定时间。

上述 169 项与启动时间是角度版本的基线证据。评分版本补充验证：

- 完整眼动测试 **171 项全部通过，无跳过**，日志：`services/build/pupil-validation/score-suite.log`。新增评分锚点、四舍五入、截断、非法输入、缺失角度/单眼、严格剔除边界和评分归档验证。
- 补充各眼覆盖目标数和有效率提示后，重新构建本机包，最终包实际拟合及角度专项 **9 项通过**，日志：`services/build/pupil-validation/score-final-package-tests.log`。
- 最终评分包构建后首次算法就绪 **1.376 秒**，见[启动报告](../../services/build/pupil-validation/score-final-first-after-build.json)。这仍是 macOS 本机证据，不是干净 Windows 或真实相机首帧验收。
- 前端评分测试、生产结果框 JSX 的中英文服务端渲染、实际保存 effect 与重载、WS 迟到/取消/失败/断连边界、产品契约和设备生命周期检查通过。命令：`node tests/recording/check_calibration_scores.mjs`、`node tests/eye_tracking/pupil_core/check_product_contracts.mjs`、`node tests/recording/check_device_stream_lifecycle.mjs`。
- 评分版本 `npm run release:check` 全部通过，含架构、类型、Python 静态检查及生产构建；日志：`services/build/pupil-validation/score-release.log`。`git diff --check` 通过。

尚未在 Windows 真机执行新版本独立验证，不能宣称实际精度达标；本次未提交或推送。
