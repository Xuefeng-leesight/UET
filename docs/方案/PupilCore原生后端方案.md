# Pupil Core 原生后端与导出字段方案

日期：2026-10-13。状态：原生实现和本机验证已落地；Windows 安装、真实设备与科学精度尚待验收。构建与回归证据见 [本机验证记录](../debug/pupil-native-2026-10-13-validation.md)。

## 目标与边界

- MRT 直接打开 Pupil Core 双眼及场景 USB 相机，内置瞳孔检测、3D 眼模型、校准和注视映射；正常使用不安装、不启动 Pupil Capture，不调用其 Remote API。
- 前端文件、页面、交互和校准入口不改动；继续使用已有共享卡片校准及独立验证流程。
- Electron 管理唯一后端进程；保持现有 WebSocket、录制目录、记录/分析/导出协议。其他厂商保持原路径。
- 旧 Capture 接入保留为显式诊断/对照后端，不自动回退或静默启动外部软件。
- 不能用模拟数据宣称硬件可用、算法同等精度或科学验收通过。

## 实施顺序

1. 核对官方源码与版本、许可证、相机型号识别、内参、检测与映射接口；建立固定版本组件清单。
2. 实现原生相机资源 owner、时间戳和双眼检测。队列有界，设备异常显式报错，退出释放设备。
3. 在设备适配层运行开源 3D 校准与映射；复用现有校准采样、质量门禁、取消/超时/断连/迟到结果隔离。耗时拟合不阻塞采集或取消。
4. 接入原生启动参数、独立环境及安装包；开发和发行均默认为原生后端。
5. 扩展标准样本与 CSV，按现有导出页面的字段逐项映射，保留旧记录兼容。坐标、单位、质量及缺失原因可追溯。
6. 完成自动化回归、真实算法数值验证、打包检查和项目门禁；更新维护文档与验收记录。

## 导出字段落实情况

逐项对照现有 `ExportPage.tsx` 的字段与 `recordExportHandlers.ts` 的导出来源，不修改前端。原始 CSV 加入兼容列，最终导出沿用现有表头；无法测得的值为空，不以零冒充测量。旧 Capture 记录的归一化兼容别名继续保留，原生记录用 `source_backend=native`、`geometry_space=world_camera_mm` 明确区别。

| 字段族 | 数据来源/处理原则 |
| --- | --- |
| 时间、刺激物、标记、记录信息 | 延用现有时间线及记录上下文；相机源时间与本机单调时钟关系归档 |
| 双眼瞳孔中心、直径、短轴 | 检测器真实椭圆；中心坐标明确坐标系，像素与毫米不混用 |
| 瞳孔毫米直径、模型质量 | pye3d 模型估计，质量不合格留空并保留原值和原因；不声称物理标定测量 |
| 推荐/单眼注视 | 来自对应校准模型；不把双眼结果复制成两个单眼结果 |
| 3D 注视点、射线起点/方向 | 校准后的场景相机坐标系，点为毫米、方向为单位向量；不把归一化图像点写为 3D 点 |
| 原始/平滑 | 已有兼容别名须标明；无实际滤波不伪造独立平滑结果 |
| 注视、眨眼、扫视、速度 | 优先复用可验证的现有计算链路；注明算法、单位、阈值和数据缺口，失效/跨断流不计算速度 |
| 眼睑等无可靠来源字段 | 保留表头并留空，文档说明硬件/算法不提供 |

### 已接入现有表头

| 表头对应字段 | 原生数据含义、单位及限制 |
| --- | --- |
| `left/right_pupil_center_x/y` | 2D检测椭圆中心，眼相机左上原点，px |
| `left/right_pupil_minor_axis`、`pupil_diameter` | 2D椭圆短轴、长轴直径，px；额外保留 `pupil_diameter_px` |
| `left/right_pupil_diameter_mm` | pye3d折射模型估计，mm；不合格模型的值只保存在 `pupil_raw_diameter_mm` 供诊断 |
| `left/right_pupil_distance` | 瞳孔圆中心在各自眼相机中的Z深度估计，mm；不是到世界目标的距离 |
| `recom_gaze_x/y` | 推荐映射投影到场景图像，左上原点、0..1，越界样本无效 |
| `left/right_gaze_x/y` | 对应单眼独立拟合模型的投影，不复制双眼结果；模型深度是估计值 |
| `*_gaze_point_xyz`、`*_raw_point_xyz` | 经校准的3D点，场景相机坐标系、mm；raw表示未额外滤波的映射点，不表示未校准传感器坐标 |
| `*_origin_xyz`、`*_direction_xyz` | 同一个对应模型的射线起点与单位方向；推荐射线从贡献眼中心的平均值指向推荐3D点 |
| `recom_re`、`left/right_re` | 0..1的输入瞳孔检测置信度（推荐为平均值），不解释成独立精度、拟合误差或其他厂商SDK的re |
| `*_gaze_bit_mask` | MRT显示兼容有效位；不是其他厂商的原生SDK位掩码。原生CSV平滑列不提供值 |
| Fixation Timestamp/Duration/Index/Status | MRT角度离散度算法：1.5°、至少100ms、300ms滑窗；合并重叠同ID窗口，中心为最后窗口均值 |
| Fixation Point X/Y [px] | 场景实际尺寸换算的像素点；额外保留归一化 `fixation_center_x/y` 给既有回放 |
| Saccade Index/Duration | MRT I-VT：30°/s、8..100ms、至少2个高速间隔；无效数据或>50ms断流丢弃未完成事件 |
| Saccade Amplitude [px]/Distance [deg] | 检测事件前后100ms内存在完整相邻注视时，用注视中心/平均视线求距离；缺任意一侧留空。I-VT端点位移另存 `saccade_endpoint_distance_*` |
| Average/Peak Saccade Velocity | 完整I-VT期间的时长加权平均速度/峰值，分别为px/ms和deg/ms |
| Gaze Velocity [px/ms]/[deg/ms] | 连续有效样本间的像素/角度变化率；跨连接、变尺寸、无效点、>100ms间隔不计算 |
| 历史 `gaze_velocity_ms` | 维持旧导出器归一化距离/ms的含义；做像素速度分析时选显式 `gaze_velocity_px_ms` |
| Blink Index/Duration/Marker、Left/Right Blink | 按眼分别进行置信度差分检测（200ms、0.5阈值），完整onset/offset配对；1左眼、2右眼，不把两个事件猜成同步双眼事件；断流会重置配对会话 |
| Invalid Gaze Index/Duration | 现有导出器根据连续无效段派生，不把眼动事件行当成普通采样 |
| 记录、受试、刺激物、时间、标记、采样率 | 继续由录制上下文和现有导出器提供；实际Hz按样本数/录制时长计算 |

### 保留空值的字段

`*_pupil_bit_mask`（厂商专用定义）、`*_pupil_minor_axis_mm`（无可靠投影到物理短轴）、`recommend`（无对应选择状态）、全部 `*_smooth_point_xyz`（未实施独立平滑）、`*_openness`、上下眼睑、全部陀螺仪/姿态/加速度/磁场列。不能从瞳孔置信度推造睁眼程度，也不能从场景相机运动推造陀螺仪测量。上述栏目仍可在原导出界面选择，缺失项输出为空。

### 可追溯性

录制附档保存相机UID、实际分辨率/Hz、内参及其默认或个体来源、时钟转换、算法版本、训练参考/瞳孔/拟合参数、独立验证结果和原始消息。3D映射采用官方500mm初始深度与默认眼位置参数，不能声称测得绝对目标深度。角度速度和事件是MRT明确参数的算法输出，不声称与Pupil Capture的所有在线/离线插件结果完全相同。

## 验证与交付

- 自动化：相机识别歧义、缺设备/缺依赖、时钟异常、队列溢出、重复启动和退出；真实检测/拟合数值；校准取消、超时、断连、迟到结果；导出列、单位、无效值与旧记录重建；原三类设备回归。
- 项目门禁：架构、全量 TypeScript、Python 编译、构建、diff 检查。
- 发行验证：依赖及许可证随包交付、无 Capture 可启动服务、未连接硬件不会伪造成功。
- 真机验收：目标 Windows 上在 Capture 关闭时完成双眼/场景预览、校准与独立验证、录制导出、重连和长时间采集；比较精度、有效率和延迟。无目标硬件时必须明确记录为待验收。

## 官方依据

- https://github.com/pupil-labs/pupil
- https://github.com/pupil-labs/pupil-detectors
- https://github.com/pupil-labs/pye3d-detector
- https://github.com/pupil-labs/pyuvc

各组件按实际版本归档许可证与来源。复用 LGPL 代码及修改必须保留版权声明和对应源码，不能把独立进程当成自动免除许可义务的依据。

固定Gazer3D与相机内参来源为 `pupil` 提交 `7a3cd9e8d2e54ac123ab0ed292d741732db899a2`。PyPI `pye3d 0.3.2` 的归档许可证为 All Rights Reserved，因此改用官方 LGPL 提交 `eb50e384ce131e2a27e0de058c25fa16254c63ed`，安装时校验源码SHA-256并保留对应源码。此处根据具体文件核验，不依据可能过时的PyPI分类器推断许可证。安装与重建见 [原生后端说明](../../services/eye_tracking/adapters/pupil_native/README.md)。
