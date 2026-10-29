# Pupil Core 接入 MRT 方案

更新：2026-10-10。状态：已落地型号选择、独立进程启动、现有页面预览、Capture 校准结果和 MRT 录制/列表链路；无真机，尚未完成 Windows 安装包与硬件验收。当前实现以第20节及运行说明为准，第13–15节保留历史阶段记录。

## 1. 目标与不可突破的边界

Pupil Core / Pupil Capture 负责设备采集、眼动计算和网络发布；MRT 接收视频和眼动数据，在现有页面实时预览，并由 MRT 自己保存视频、CSV、标记和记录元数据。正式保存不依赖 Pupil Capture 的录制目录，不以调用其 R/r 命令替代 MRT 录制。

本次优先保护七鑫易维（7invensun）现有 Pro、A8、aSeeGlassesPlus 三款设备。旧设备的连接、校准、追踪、录制、回放、分析、导出以及历史数据行为必须保持基线。

用户约束：MRT 现有前端页面、操作流程及业务语义保持不变。方案阶段只交付文档；用户已授权开始实施。Pupil 与 7invensun 适配器均按真实工程文件落地，不创建空实现目录。

“旧设备不能有 bug”的工程承诺是：不得发布本次引入的已知缺陷；旧三型号分别完成基线对照与正式安装包验收；未测或失败均阻断发布。无法仅凭设计或静态检查保证绝对零缺陷。基线已存在的问题单独登记，不掩盖、不归因于本次，也不顺便修复。

## 2. 目标目录架构与分期落地

### 2.1 目标结构

采用以下分层作为眼动仪服务的目标架构：application 负责业务编排，domain 定义统一契约，adapters 隔离厂商协议，transport 对接 MRT 通信，infrastructure 提供运行基础设施。这是目标结构，不表示以下目录已经存在，也不要求本次 Pupil 接入一次性迁移全部设备。

```text
services/eye_tracking/
├── application/
│   ├── recording.py                 # MRT 录制会话与保存流程编排
│   ├── sdk_service.py               # 现有实现保留；后续单独评估统一编排
│   └── ...
├── domain/
│   ├── contracts.py                 # 统一眼动仪接口与状态/错误约定
│   ├── capabilities.py              # 设备能力描述，不伪装不支持的能力
│   └── samples.py                   # 统一 gaze/pupil/frame 数据语义
├── adapters/
│   ├── pupil_core/
│   │   ├── network.py               # Remote 控制、发现与数据订阅
│   │   ├── frame_receiver.py        # 图像 multipart 接收、校验和分发
│   │   ├── data_normalizer.py       # Pupil 原始数据 → 统一样本
│   │   ├── calibration.py           # Pupil 校准桥接与真实结果
│   │   └── service.py               # 实现统一设备接口
│   ├── invensun_7/                  # Pro/A8/aSeeGlassesPlus 旧驱动归属
│   │   ├── driver.py
│   │   ├── ctypes_types.py
│   │   ├── paths.py
│   │   └── data_normalizer.py
│   └── huahong/                     # 独立设备接入范围，本期不实现
│       ├── et10c.py
│       ├── et28.py
│       ├── ctypes_types.py
│       ├── paths.py
│       └── data_normalizer.py
├── transport/
│   ├── protocol.py                 # 既有 MRT 消息契约
│   └── server_runtime.py           # 命令路由、连接与消息发送
└── infrastructure/
    ├── process_runtime.py          # 进程生命周期与资源清理
    └── sdk_loader.py               # 按选定厂商加载 SDK；Pupil 不加载 aSee DLL
```

目录采用 `invensun_7` 作为 Python 包名；`7invensun` 虽可作为文件夹名，但不适合常规 Python import。上图只列核心职责，包初始化、测试及构建文件按项目规范补充，不为凑齐树形图创建空实现。

### 2.2 分层职责与依赖约束

| 层 | 应负责 | 不应负责 |
| --- | --- | --- |
| domain | 设备接口、能力、样本、时间单位、坐标空间、有效性和状态语义 | 导入 ZeroMQ、厂商 SDK、WebSocket 或前端代码 |
| adapters | 控制设备/数据源、接收数据、标准化、报告真实能力与错误 | 决定项目目录、MRT CSV 列、前端消息封包或业务录制策略 |
| application | 按统一契约协调采集、录制、标记、收尾；调用保存实现 | 解析 Pupil topic、操作 aSee 指针或按厂商型号堆叠协议分支 |
| transport | 将现有 MRT 命令映射到应用服务，将结果转换为现有消息 | 打开相机、调用厂商 SDK 或承担编码/保存业务 |
| infrastructure | 进程管理、按需 SDK 加载；需要时承载编码器/文件写入实现 | 决定校准是否成功、伪造设备能力或眼动数据 |

目标依赖方向：transport → application → domain；adapters → domain；infrastructure 按需要实现上层声明的基础设施接口。启动组装处选择适配器并注入应用服务，禁止 domain 反向依赖实现，也禁止适配器相互导入。统一接口只覆盖设备生命周期、数据订阅、校准操作及其状态/结果；MRT 的 start_recording/stop_recording 属于应用层，不等于厂商自带录制命令。

contracts.py 应从现有命令和消费者要求中提炼，不重新设计一套前端协议。samples.py 至少明确设备来源、会话/连接代次、源时间及单位、坐标空间、有效性、左右眼和图像格式；保留厂商原始消息用于诊断，不把缺值补成有效零值。capabilities.py 描述实际支持的视频流、校准方式、瞳孔单位等；能力声明不能代替第4节的型号注册或校准验证，也不代表本期新增前端动态页面。公共契约只声明已验证的语义，不以任一厂商字段充当所有设备的强制事实。

### 2.3 本期落地：新增 Pupil，旧路径冻结

本次 Pupil 路径接收和标准化独立于旧设备。7invensun 驱动已迁移到 `adapters/invensun_7/`，旧 `sdk_driver.py` 保留兼容别名；`application/sdk_service.py` 只复用迁移后的 gaze 选择函数，不能复制第二份驱动实现。录制链路和默认启动入口保持原行为，不开发 huahong，不强制旧设备实现 Pupil domain 接口。

当前 application/sdk_service.py 和 transport/server_runtime.py 仍含 aSee 假设，不能仅凭目录命名视为已完成解耦。本期允许独立 Pupil 进程保留以下过渡模块，以避开旧路径；目标架构与临时模块的差异必须显式记录。

```text
adapters/pupil_core/
├── network.py                       # 控制/发现与 gaze/pupil 订阅；按需拆内部模块
├── frame_receiver.py                # 视频订阅，与数据通道分离
├── data_normalizer.py               # 输出 domain/samples.py 中的统一数据
├── calibration.py
├── service.py                       # 设备接口；不持有项目文件命名策略
├── server.py                        # 过渡：独立进程入口、组装与命令路由
├── clock.py                         # Pupil 源时钟映射
├── preview.py                       # 过渡：既有预览协议输出
├── recording.py                     # 过渡：MRT 专用保存实现，不是 Capture Recorder
├── compatibility.py                 # 过渡：现有消息/CSV 映射
├── packaging/                       # 独立依赖与打包配置
├── bridge_plugin/                   # 仅校准验证需要时提供
└── tests/                           # 协议样例、回放与故障测试
```

过渡模块由独立入口组装，service.py 不反向依赖过渡保存/协议模块。后续公共化时，录制编排归 application，编码/文件写入归 infrastructure，消息映射归 transport；domain/samples.py 是统一样本的唯一契约，不再创建一套同义的 Pupil 公共样本模型。Pupil 私有解包结构可保留在适配器内部。

### 2.4 后续迁移条件

7invensun 迁移保持独立兼容边界：旧导入入口、SDK/DLL 路径、ctypes ABI、回调生命周期、校准顺序和 H.265 解码行为必须保持。迁移后需重新执行三款旧设备全量回归；本机无真机时只能完成导入、路径、factory、类型别名和逻辑回归，不能宣称设备验收。huahong 按独立方案接入，本文件中的目录不代表其型号或 SDK 已验收。第10节旧三型号发布门槛始终有效。

## 3. 进程与依赖隔离

Windows x64 为首版交付目标，同时要求在 macOS 上开发与联调测试。Capture 和 MRT 同机运行，通过 localhost 通信。Capture 单独安装，负责打开相机；MRT 不同时打开同一个 USB 摄像头。macOS 模拟测试不能替代 Windows 真机验收；跨机器传输作为后续独立验收范围。

```text
Pupil Capture：相机、校准模型、gaze/pupil、Frame Publisher
    │ ZeroMQ：视频 / 数据 / 控制
MRT Pupil 专用 Python 进程
    ├── 视频接收 → 预览队列 → 原有图像 WebSocket
    ├── 视频接收 → 录制队列 → MRT 编码器 → MP4
    ├── gaze/pupil → 标准化 → MRT CSV / 原始数据附档
    └── 命令与状态 → 原有命令 WebSocket
    │
现有 MRT 前端、记录列表、回放、分析与导出
```

生产打包建议新增独立 `mrt-pupil-server.exe`，由 Electron 在明确选择 Pupil 数据源后启动。旧三型号继续启动原 `mrt-ws-server.exe`。两者不能同时绑定相同 MRT 端口。

- 默认功能关闭；旧模式不导入 Pupil 模块、不探测 Capture、不访问其端口。
- pyzmq、msgpack 及其原生依赖在 Pupil 专用环境锁定与打包，不升级旧 Python、OpenCV、FFmpeg 或既有依赖。
- Pupil 模式跳过 aSee SDK 路径解析、DLL/PATH 注入和 softdog 配置；MRT 自身软件许可证照常校验。
- 数据源切换只能在空闲且已收尾状态进行：停止服务、等待退出、确认端口释放、启动目标进程、协议握手。
- Capture 由用户启动时，MRT 断开只释放自身连接，不关闭 Capture。

## 4. 必须先解决的兼容关口

### 4.1 真实设备身份与“前端不变”

当前前端 DeviceModel、共享项目类型及项目归一化仅接受 Pro/A8/aSeeGlassesPlus；cameraModule 还校验 start 响应型号。直接返回 PupilCore 会被拒绝，返回 aSeeGlassesPlus 又会冒充设备并污染记录身份。

因此不能承诺“只加一个 Python 文件，前端零字节变动就完整接入”。本方案保留前端页面和业务流程不变，推荐允许最小的设备注册/配置适配：增加真实 PupilCore 身份，并关联既有眼镜页面。校准方式、预览编码不能仅由这个页面档案推断。所有身份读写、项目保存重开和记录导出必须往返保真。

此最小注册变动需要在实施范围中明确确认；当前文档不把它视为已授权修改。若坚持前端源码完全不变，可先在独立测试客户端验证后端采集和保存，但完整产品集成仍以身份关口为阻断项，不能将既有 aSee 项目暗中换成 Pupil 采集。

### 4.2 校准语义

Network API 的 C/c 是控制当前 Capture 校准流程，不能证明现有 MRT 的一点/三点、点击场景、卡片校准可直接沿用。此前“收到高 confidence gaze 即校准成功”的建议不成立：它既不证明新校准生效，也不证明准确性。

若要求原 MRT 校准页面和逐点操作保持原语义，必须先做 Pupil 侧校准桥接验证：把 MRT 点击位置关联到明确 world 帧时间，再收集相应 pupil 样本，调用目标版本支持的校准/拟合机制，返回真实结果与可恢复的校准模型标识。桥接实现需以固定 Capture 版本源码和真机验证为依据，当前不编造通用校准函数名。

需验证：一点/三点所需模型与样本条件、左右眼返回语义、卡片目标坐标、取消和超时、模型持久化、重启恢复与实际精度。旧前端若要求双眼回调，只有真实左右眼结果才能返回；不得复制成功事件凑回调数量。

将桥接能力作为完整接入的前置关口。仅在 Capture 中手动校准可用于采集探针，不算完成用户要求的原流程兼容。若桥接无法满足现有流程，保留禁用状态并报告冲突。

### 4.3 合法零坐标与旧消费者

实施中用实际 recordCsvParser 验证：现有消费者会丢弃 `(0,0)`，但这是 Pupil 转换到左上角归一化坐标后的合法边界点。当前开发 CSV 保留真实点，不能加微小偏移冒充兼容。本期不修改旧设备解析规则。正式接入必须制定按真实来源区分的消费者兼容方案并通过旧三型号对照；普通点解析测试通过不等于四角完整兼容。

## 5. Network API 连接契约

官方确认：Remote 默认 50020，提供版本查询与动态 SUB_PORT；实时消息使用 ZeroMQ + msgpack；PUB/SUB 不保证交付；控制通知的接收回复不等于操作完成。[Network API](https://docs.pupil-labs.com/core/developer/network-api/)

建议连接步骤：

1. 验证配置、Capture 版本与本地输出目录。
2. REQ 查询 v、SUB_PORT；只有实际需要直接发布时才查询 PUB_PORT。
3. 分开建立视频订阅与 gaze/pupil/状态订阅，避免高流量图像拖慢控制。
4. 启用并验证 Network API / Frame Publisher，首版固定 BGR；校准桥接按需握手。
5. 等待合法首帧、校验尺寸和格式；独立记录设备连通、视频可用、追踪可用、校准有效等状态。
6. 通过既有响应与通知返回实际结果，不能仅以 socket.connect 返回视为设备就绪。

每个 ZeroMQ socket 由单一线程/事件循环拥有；其他线程通过队列请求操作。REQ 发送与接收成对串行；接收超时后重建 socket，不能在等待回复的 REQ 上继续发送。开始校准等有副作用操作超时后先核实状态，不盲目重试。

Capture 重启后重新发现端口并递增 connection_generation。旧连接的帧和回调不能进入新会话。录制中断线进入异常收尾，不自动拼接重连后的帧到原录像。

## 6. 视频接收与预览

官方 helper 展示了 frame.world、frame.eye.0、frame.eye.1；消息由 topic、msgpack 元数据以及额外原始图像帧组成。因此不能照普通 gaze 示例写成只解包两个消息帧。BGR 设置通知为 frame_publishing.set_format，实际收到的 format 仍需逐帧验证。[官方接收示例](https://github.com/pupil-labs/pupil-helpers/blob/master/python/recv_world_video_frames.py)

首版必需 world；眼图按原页面实际需求订阅并验收。独立保留 stream、源 timestamp、源 index（如实际提供）、本地接收序号、连接代次、宽高、格式、接收单调时间与像素。本地序号只能统计已接收数据，不能证明网络无丢帧。

接收入口完成长度/尺寸/格式验证后分别投递：

- 预览：每路只保留最新帧，建议目标 15–30 FPS，允许降频。
- 保存：有界独立队列，由编码线程消费；满队列必须计数并进入告警/异常收尾策略，不能静默丢弃。

不得把收到的 BGR 字节当作原 aSee H.265 数据包。现有前端存在 WebCodecs encoded 优先路径，需在第一阶段确定：已有 image fallback 能否在既有逻辑下稳定工作；若不能，就在 Pupil 后端输出前端已接受的编码与封包协议。只发送 JPEG 不能作为前端必定能显示的保证。

预览输出必须与现有 image_frame 的 kind、eye、mime、width、height、timestamp、data 一致，尤其 kind 使用现有 scene/left_eye/right_eye。时间单位由兼容层转换，不把 Pupil 浮点秒直接填进既有整数时间字段。

预览叠点为可视化层；默认保存无叠点视频和独立 gaze 数据，避免重复叠加及无法重新分析。场景坐标不能直接当屏幕刺激坐标；屏幕映射属于后续单独能力。

## 7. 眼动数据与文件兼容

Pupil 原始数据由 data_normalizer.py 转换为 domain/samples.py 定义的统一样本，再由过渡 compatibility.py 输出 MRT 协议与 CSV。不得构造伪 aSee ctypes 指针调用旧 gaze_callback。

| 数据 | 转换要求 |
| --- | --- |
| gaze 点 | 明确 world 坐标空间、原点、Y 方向及分辨率；原始值另存 |
| 左右眼 | 根据 eye id 与 base_data 对应关系匹配；无单眼 gaze 时不复制融合点冒充 |
| confidence | 保存原值；有效标志是 MRT 明确记录阈值后的派生结果 |
| 瞳孔 | 区分像素值与毫米值；缺失毫米值不能拿像素填充毫米分析列 |
| raw/smooth | 按真实处理来源标记；若复用同一点作兼容输出，要记录未做独立平滑 |
| fixation/blink | 有真实事件才输出，派生算法明确来源，不伪造 aSee 事件统计 |
| timestamp | 源秒时间完整保留；展示字段按旧契约转换；CSV 使用明确 video_time_ms |
| 缺失/无效 | 按现有消费者能识别的空值和有效标志输出，验证不会被解析为有效零点 |

兼容验收覆盖 recordCsvParser、gazeDisplayPath、回放坐标转换、AOI、报告、导出。当前 CSV 解析存在毫米/基础瞳孔字段回退与 smooth 默认路径，需要用缺值、边界点、低置信度样例验证。若既有消费者无法表达某字段的缺失，必须先解决契约冲突，不伪造数值维持界面。

## 8. MRT 保存、时间线与收尾

保存仍由 MRT 发起。Pupil 侧不自动发送 R/r；用户在 Capture 另行录制与本任务无关，不被 MRT停止。

遵循当前扁平记录命名，避免另起目录导致旧列表找不到录像：

```text
recordings/
├── <record-name>.mp4
├── <record-name>.csv
├── <record-name>.meta.json
└── <record-name>.pupil/              # MRT 私有附档
    ├── source-messages.msgpack       # 实际收到的原始眼动消息
    ├── frame-map.csv                 # 输出帧、PTS、源时间/index映射
    ├── clock-map.json                # 时间基准及估计误差
    └── diagnostics.json              # 缺口、队列、补帧和中断记录
```

附档不是 Pupil Player recording。删除、复制、导出项目时要一并处理；只给 Pupil 记录添加这些规则，禁止改变旧记录清理范围。所有路径由 MRT 项目授权边界校验。

时间线原则：视频和 gaze 优先共用 Pupil 时间，选明确首个录制源帧为 t0。保留 pre-roll gaze 缓冲，录制开始后按源时间裁定是否纳入；结束同样采用明确 cutoff 与有限排空时间。MRT 标记/音频用主机单调时钟到 Pupil 时钟映射对齐，保存估计误差，不用 R 命令或网络接收时刻作为同步依据。

为兼容现有定帧率录像，首版建议按源 timestamp 重采样到选定输出帧率 F：输出帧 k 的 PTS=k/F，记录其实际采用的源帧和复用/缺口。CSV 的 video_time_ms 使用同一 t0。不能把所有到达帧简单按固定 F 顺序写入，否则掉帧后时长会缩短并使 gaze 漂移。附档本身不会自动修正旧播放器，必须保证 MP4 PTS 和 CSV 已对齐。

短缺口允许在明确阈值内重复画面维持时长，计数并标为派生补帧；不补造 gaze。超过阈值、时钟跳变、分辨率变化、编码器退出或磁盘满则异常收尾，不把静止画面作为持续正常采集。

录制状态：idle → preparing → recording → finalizing → complete/partial/failed。start 只有在输出文件、编码器和首帧就绪后成功；stop 接收确认与 finalized 完成事件分开。排空队列、flush CSV、编码器正常退出、校验可播放后才发送成功 finalized。异常保留已落盘文件，不删除故障证据；崩溃恢复检查不完整记录，不能把文件存在当作完成。

Pupil timestamp 与 gaze 可相关，但不代表物理硬件严格同步；官方说明相机独立运行，关联需要使用时间戳。[数据与时间约定](https://docs.pupil-labs.com/core/developer/)

## 9. 最小改动清单

| 位置 | 本次范围 |
| --- | --- |
| adapters/pupil_core/ | 新增采集适配与测试；独立协议/保存模块按第2节标记为过渡实现 |
| domain/contracts.py、capabilities.py、samples.py | 提炼并新增已验证的统一契约，先用于 Pupil；不强制改接旧三型号 |
| adapters/invensun_7/ | 已迁移 Pro/A8/aSeeGlassesPlus；旧 sdk_driver.py 为兼容别名 |
| adapters/huahong/ | 独立后续方案，当前不实现 |
| infrastructure/ | 目标基础设施边界；本期不重构旧 SDK 加载和进程管理实现 |
| Electron Python 启动层 | 显式选择独立 Pupil 进程；默认旧启动行为保持 |
| 设备身份注册/配置 | 第4节关口通过后才实施最小变动；不得冒充旧型号 |
| transport/protocol.py、application/recording.py | 优先复用纯契约；逐项证明兼容后调用 |
| transport/server_runtime.py | 原文件直接构造 SDKService 且含厂商假设；不要只替换 service 就宣称可复用 |
| 记录文件处理 | Pupil 附档关联与真实身份持久化，限定新来源分支 |
| 打包 | 新增独立可执行文件/依赖清单，不移除或重打包旧 SDK |
| 旧 sdk_driver.py / sdk_service.py | 本期原则上不改，不搬目录，不重写校准/编码路径 |

避免同时维护三套厂商专属业务流程。Pupil server 只承担当前隔离所必需的协议边界；用契约测试约束输出，未来公共服务抽取作为单独任务。

## 10. 旧三型号保护与验收

### 基线

从用户认可的可用工作区记录提交、未提交改动、依赖、SDK/安装包哈希、操作系统、固件、配置与测试数据副本。当前存在的方案文档和删除状态不由本任务恢复或覆盖。旧测试设备缺失不能用模拟器替代验收。

| 对象 | 修改前后同环境必测 |
| --- | --- |
| Pro | 连接、加密狗、屏幕参数、多屏、所有原校准方式、保存加载校准、追踪、完整录制回放导出 |
| A8 | 无 softdog 启动、物理尺寸、校准参数恢复、反复关开设备、追踪与完整录制回放导出 |
| aSeeGlassesPlus | 场景/眼图、H.265预览与保存、点击与卡片校准、开机首帧、长录像同步、拔插恢复 |
| 三型号分别 | 各20次启停、至少60分钟连续录制；资源无持续增长、数据有效率/延迟符合基线 |
| 历史记录 | 原文件不改写；打开、保存副本、回放、AOI、报表及导出结果与基线对照 |
| 新功能关闭 | Capture未安装、pyzmq缺失、Pupil进程缺失/损坏均不影响旧三型号 |
| 跨模式 | Pupil与旧设备至少10次切换，录制/收尾时拒绝切换，配置与校准不串用 |
| 共享能力 | 刺激、音频、标记/触发器、多人采集、表情组合、许可证、项目复制/删除 |

这些次数和时长是建议最低验收要求，尚未执行。三型号各自保存操作日志、示例录像与CSV，不能用其中一款通过代替其他型号。确定性字段精确对比，实时误差用预先冻结的容差。

### Pupil 专项

- 固定目标 Capture 版本、相机型号/固件，实测采样率/分辨率；不从官网示例推断目标性能。
- 视频四角与中心叠点、颜色、尺寸、镜像/翻转、缩放留黑；眼图左右映射。
- 同源样本回放验证 CSV 与视频 PTS；合成时间线误差不超过预先定义的输出帧容差；物理同步误差另用可观察事件实测。
- 独立验证新校准成功、失败、取消、过期回调、重启恢复；旧系数拒绝跨来源加载。
- 断流、队列满、REQ超时、Capture重启、时钟回跳、磁盘满、编码器崩溃、应用退出。
- gaze 没有可靠连续源序号时，只报告时间间隔异常/本地丢弃，不能声称测得精确网络丢样率。
- 同机建议720p/30FPS作为首轮测试配置（以设备实际支持为准）；预览延迟P95、CPU、内存、丢帧与同步阈值在测试前冻结，不事后降低。

### 自动检查与发布门槛

实施时执行现有 check:architecture、typecheck:all、check:python、check:facial-contracts、check:sdk 和 release:check；新建协议金样本对照、映射、时间线、错误状态与安装包测试。使用独立mock Capture发出变帧率/缺口/重连序列，断言最终录像时长、CSV时间和失败反馈；不能仅检查实现常量。

旧三型号任一必测失败或未执行、出现新增缺陷、数据丢失、假成功、时间/单位不明确，均禁止正式发布。静态检查通过不代表设备可用。新增接收器自动测试与Windows实机测试分别记录，不能互相替代。

## 11. 分期实施与回退

| 阶段 | 产物 | 进入下一阶段条件 |
| --- | --- | --- |
| P0 | 旧设备基线、版本锁定、完整命令/消息/CSV契约清单 | 基线明确，身份与校准兼容路线可行 |
| P1 | 独立Pupil采集探针、校准桥接验证、预览协议探针 | 真机帧/gaze、校准、原前端预览路径均有证据 |
| P2 | 独立MRT Pupil后端、MP4/CSV/时间映射 | 原前端操作闭环成立，故障收尾有效 |
| P3 | 数据源启动分流、身份注册、项目记录关联 | 关闭功能时旧路径对照通过 |
| P4 | 正式Windows安装包与全部回归报告 | 三旧型号及Pupil均验收；升级/回退演练通过 |

不能把“探针收到了画面”当作完成接入。每阶段独立提交，新增模块与共享改动分开审查。

回退：关闭Pupil功能、恢复旧进程选择；保留Pupil已保存记录与原始附档。若共享启动/文件处理出现回归，恢复基线安装包与配置备份，不删除用户数据或重写旧记录。安装包升级→新模式使用→退回旧版必须在数据副本上演练。

## 12. 实施前待确定事项

1. 接受设备注册/配置的最小变动，还是要求前端源码严格零变动；后者目前存在真实身份兼容阻断。
2. 目标Pupil设备、Capture版本、Windows测试机及三款旧设备基线机。
3. 原眼镜校准每种方式是否全部要求Pupil支持；当前按“原逻辑保持”作为完整验收要求。
4. 场景分辨率/帧率、眼图预览范围、预览延迟与同步阈值。

这些信息用于冻结实现契约；不影响当前方案评审，但没有确认与实测证据不能宣称正式兼容。

## 13. 首批实施记录（2026-09-22）

已新增 domain/contracts.py、capabilities.py、samples.py，以及 adapters/pupil_core/ 下的 network.py、frame_receiver.py、data_normalizer.py、calibration.py、service.py、probe.py、独立依赖清单与测试。运行步骤见 [接收器说明](../../services/eye_tracking/adapters/pupil_core/README.md)。

本批是 P1 的可自动验证部分，不表示 P0 旧三设备真机基线或整个 P1 已通过。不依赖产品启动入口，未触碰旧设备实现、前端型号注册、旧录制逻辑、共享依赖或生产打包配置。校准接口明确返回不支持；不能从实时 gaze 推断校准成功。BGR 发布由联调人员在 Capture 中设置，本批没有自动修改 Capture 配置。

验证范围：独立环境中进行协议单测及真实 localhost ZeroMQ 模拟 Capture 测试，覆盖缺失依赖、导入隔离、multipart/格式/尺寸/时间校验、像素与毫米分离、首帧就绪、断流、重连代次、REQ 超时恢复、跨线程拒绝和命令行探针。现有架构、类型、Python 源码、SDK 文件与表情契约检查另行执行；这些检查均不能证明三款旧硬件无回归。

尚未实现/验收：MRT 页面实时预览、MRT 视频/CSV 保存、时间线编码、逐点校准桥接、真实 PupilCore 型号持久化、Electron 进程选择和 Windows 安装包。下一步需要目标 Capture 版本与 Windows/Pupil 真机联调条件；未通过第4节兼容关口与第10节验收前，禁止正式启用或发布。

## 14. 第二批开发组件（2026-09-23）

在用户确认“Windows目标、macOS也要测试”后，新增以下隔离实现。第13节为首批时间点记录，本节补充当前状态；不代表正式阶段关口已通过。

- preview.py、viewer.html/js：独立本地联调页与原 image_frame 格式预览，使用9101端口；不修改现有 MRT 页面。页内区分模拟来源、超时、断开和重连；只能通过HTTP服务访问，不能直接打开文件。
- recording.py、timeline.py、compatibility.py：MRT 自有开发录制，按Pupil源时间写入定帧率MP4和gaze CSV；独立有界队列、源帧映射、短缺口重复计数、异常收尾、FFmpeg实际编码与ffprobe结果校验。只读Capture，不调用R/r。未接MRT项目路径授权、项目操作、正式命令集和音频/标记。
- session.py：命令行组装接收、预览与可选保存；既有SDKService与RecordingCoordinator均未替换。
- simulator.py：限时本机合成色条/gaze/pupil，用于无真机测试；预览及录像元数据明确标注模拟，不能当实验数据。
- Windows/macOS CI矩阵和新增单测/集成测试；使用固定隔离依赖，不改旧服务打包环境。

当前录制附档保留实际收到的原始gaze/pupil消息、标准样本、gaze暂存、编码器日志、帧映射及诊断；没有完整源图像归档、clock-map音频映射或Pupil Player兼容承诺。主CSV中的raw/smooth是已记录说明的兼容别名，pupil单位数据仅保存在独立附档，不能宣称完整旧分析功能已经兼容。

验证记录：macOS上已通过34项自动测试，含真实localhost网络、JPEG颜色/尺寸、HTTP预览页、WebSocket同源限制、MP4解码帧数/时长、CSV与视频时间、故障收尾以及模拟Capture→录像/CSV端到端。现有CSV消费者测试同时确认第4.3节阻断项。Windows CI尚未远程运行，Pupil实机、三旧型号及正式安装包未验收。

补充验证：本机Chrome/Playwright已验证模拟源实时预览、重新连接、390像素窄屏无横向溢出，浏览器无脚本错误；修正了测试脚本与CSP的冲突及预览容器的窄屏布局。仓库release:check（含完整构建）及check:sdk通过，构建仍提示Browserslist数据较旧和部分大体积chunk，本期未为消除提示升级共享依赖。对旧application、transport、sdk_driver、server入口、打包、Electron、src和shared执行git差异检查，无本期改动；只在.gitignore新增开发输出目录忽略项。测试服务均为限时模拟会话，未启动常驻真机采集。

## 15. 后端工程化与无硬件运行（2026-09-23）

用户明确当前没有设备，交付目标从独立演示收敛为正式工程代码。第13、14节仅为历史记录；当前目录和启动方式以 [后端运行说明](../../services/eye_tracking/adapters/pupil_core/README.md) 为准。

- 新增 pupil_server.py 正式入口，应用层 pupil_runtime.py 独占采集线程；transport/pupil_runtime.py 提供原 MRT 命令、图像和眼动三路 WebSocket。没有 HTTP 联调页面，不自动采集、模拟或保存。
- timeline.py 归入 domain；录制与 CSV 映射归入 infrastructure，新增 recording_paths.py 限制项目写入。需要明确授权项目根目录及真实 PupilCore 项目身份，禁止借用旧设备项目。
- 探针、模拟器、临时会话和 viewer 全部迁至 tests/eye_tracking/pupil_core/tools，自动化回归迁至 tests/eye_tracking/pupil_core，不属于生产包。
- 视频接入接受 BGR/JPEG，校验 JPEG 格式、尺寸及解码内存上限。原内部样本仍统一 BGR。
- 服务启动不依赖硬件；get_device_status 分开报告 Capture 连通与采集就绪。录制必须有新鲜世界帧，start/stop/异步收尾、结果查询复用现有消息格式。断流或队列溢出明确失败，结果保留 complete/partial/failed，不伪造成功。
- 新增独立 requirements/pupil-capture.txt 与 mrt-pupil-server.spec，不更改原服务依赖、入口及打包定义。新 spec 未完成目标 Windows 构建验收，FFmpeg/ffprobe 仍需作为交付资产集成。

本机只读实测：Capture 3.5.7 可连接，acquisition_ready=false；start 正确报告没有世界相机视频，录制状态保持 idle。未发送 Capture R/r、C/c、T，也未修改其配置或保存实验数据。临时验证服务已退出。

软件验证：39项自动回归通过，包含正式 WebSocket 命令/预览、无相机状态、项目目录授权、JPEG 解码、start_recording→MP4/CSV→收尾通知。release:check 与 check:sdk 通过。已有构建体积和 Browserslist 提示仍在；Windows CI、Pupil及三旧型号硬件均未验收。

剩余产品关口仍是：真实型号注册、Electron 按型号选择独立进程并传递目录授权、原校准流程桥接、Pupil 专属分析兼容、项目操作附档关联和安装包交付。没有改旧前端来绕过这些关口。后端具备标准入口不等于 MRT 全流程已经完成；若允许最小型号/启动兼容分支，应单独实施并保持旧三型号默认行为不变。

## 16. 2026-09-24 产品链路落地

本轮依据用户明确授权“创建工程可选择型号，其余沿用现有内容，继续完善后端”，补齐产品入口。此前有关未注册型号、未启动分流、合法 (0,0) 被过滤、标记未接入的描述均为历史状态。

- 新建工程可选择 Pupil Core；工程模态、顶层型号、重新打开工程、设备配置和记录身份均保留 PupilCore。旧 Pro/A8/aSeeGlassesPlus 默认值、校准选项与启动参数保留。
- Electron 按真实型号启动独立 Pupil 服务，传递授权工程根目录、Origin、端口和编码工具。Pupil 不进入旧 DLL/softdog 查找；同型号换工程时刷新写入授权。macOS 使用独立 .venv，Windows 安装包使用独立 EXE。正常退出经父进程管道收尾。
- 复用 MRT 原录制页面，Pupil 直接走现有 image_frame 预览通道，不走旧眼镜 H.265 解码。独立处理 Pupil 合法边角坐标与来源，不改变旧设备零值规则。
- 校准按钮仍在 MRT；用户在 Capture 完成所选校准。MRT 等待本轮 started/successful/result.v2，收到真实成功后才生成连接内凭据、启动追踪并允许录制。不构造旧逐点回调、左右眼评分或可跨连接复用的 SDK 系数。取消/超时/重连/断流使凭据失效。Capture 协议无请求 ID，禁止与 MRT 同时操作另一轮校准。
- MRT 在 `experiments/<实验ID>/recordings` 保存视频、CSV、meta 与 .pupil 附档。记录名兼容原列表，保留真实被试名、尺寸、时长、有效率、标记和来源。刺激物切换、软件标记和 trigger 使用 Capture 源时间映射到视频；分屏仍用于刺激物展示，视频源固定世界相机。
- Pupil 原始/平滑 gaze 列是已声明的兼容别名，不是新滤波结果；瞳孔 px/mm 独立保留，只将真实 mm 供毫米统计使用。未提供的单眼 gaze、眼睑及旧 SDK 统计保持缺失，不伪造数值。完整分析、音频同步和长时性能仍需后续验收。
- 原记录列表读取 Pupil 文件；删除 Pupil 记录时只关联其命名附档。打包脚本加入独立 Pupil EXE 和 ffprobe，未在 macOS 冒称 Windows 安装包已构建通过。

验证使用真实生产组件/解析器/进程入口：新建工程四型号选择，型号持久化与启动路由，旧系数恢复路径，源坐标，Capture 协议双端连接，校准取消/超时/失效，实验保存、实际 FFmpeg/ffprobe 校验、原记录列表、父管道退出以及旧适配器回归。自动化源明确是测试源，不是硬件精度或旧三机验收。正式入口不启动测试源或联调网页。

发布前仍须：Pupil 真机校准/佩戴/断流/长时录制，Windows 安装包构建与安装回归，旧三型号逐机基线对照，以及业务需要的回放/分析/导出/音频组合验收。不能承诺绝对零缺陷。

本轮本机结果：51项自动回归通过；生产新建工程组件的四型号浏览器检查通过；release:check、check:sdk 和独立环境 pip check 通过。保留既有 Browserslist 数据较旧、产物分块较大的构建提示。最后一次真实本地 Remote 50020 只读检查超时，capture_connected/acquisition_ready 均为 false，录制保持 idle；本次未向真实 Capture 发送校准、录制或时钟修改命令。本机正式 Pupil .venv 已安装，与旧环境隔离。

实际部署、命令与限制见 [运行说明](../../services/eye_tracking/adapters/pupil_core/README.md)。校准协议依据 [Network API](https://docs.pupil-labs.com/core/developer/network-api/) 和 [官方校准通知定义](https://github.com/pupil-labs/pupil/blob/master/pupil_src/shared_modules/gaze_mapping/notifications.py)。

## 17. 2026-09-27 未完成项补全

本轮继续遵循 `rigorous-engineering`：保留原型号分支，不用模拟设备通过代替硬件验收；先验证实际生产保存、解析、导出及音频处理器，再记录交付边界。

### 本轮已落地

- **异常录制恢复**：Pupil 使用 fragmented MP4、一秒日志检查点、跨平台独占锁和恢复清单。正式服务启动时仅处理授权 Pupil 工程及其实验目录的未收尾录制；可恢复片段通过实际 FFmpeg 重封装和 ffprobe 校验，按有效视频时长重建 CSV，保留中断原件。恢复永远标为 partial；不可恢复标为 failed，不再按“文件存在”误认完整记录。目录不可访问不应导致命令工作线程退出。
- **源事件与分析/导出**：独立接收 Capture `fixations` / `blinks`；归并同 ID 重叠注视窗口、保留源 ID，转换原 MRT 注视字段。眨眼按 onset/offset 去重、配对，未知左右眼保持缺失。真实消息与标准样本保留附档。CSV 用磁盘排序合并事件、标记和 gaze，旧时间索引可继续使用；事件行不重复计入 gaze。已验证原 MRT 的注视/gaze 解析器及用户 CSV 导出处理器。
- **音频软件时钟对齐**：`get_source_clock` 提供 Capture 源时间、录制 ID、代次、视频原点。录音首尾以三次最小 RTT 采样，结合浏览器单调时钟和 AudioContext 时长估计偏移/线性速率；主进程通过补静音、裁剪和音频速率修正完成合并，保存估计信息。时钟异常拒绝合并并保留原音频；必须等视频收尾校验完成，不再因 preparing 文件存在提前合并。修复停止录制后延迟响应重新启动音频、提前停止阶段错误未传到最终提示的时序问题。
- **打包检查**：Windows/macOS CI 除协议/媒体测试外，增加 PyInstaller 构建及打包进程连接、父管道退出测试。本机隔离临时环境已实际构建 macOS arm64 独立服务，并通过打包后的启动/连接/退出验证；未向旧三型号环境安装依赖。

重复构建还发现并修复了 ffprobe 继承源文件只读权限、第二次复制报 EACCES 的问题：仅对经校验的生成资产修正权限，临时复制后原子替换，拒绝替换符号链接目标。构建依赖版本已独立固定，CI 连续构建两次覆盖该问题。

### 本机证据与剩余关口

本轮自动回归 **61 项通过**，覆盖旧适配器、真实本地 ZeroMQ/WebSocket、MP4/CSV、强制终止进程和编码器后的恢复、活动录制锁保护、符号链接隔离、真实延迟 AAC 合并、音频停止竞争、源事件归并及实际 CSV 导出。`release:check`（含完整前后端构建）及 `check:sdk` 通过。另有 macOS 打包产物启动/退出单项通过。保留既有 Browserslist 较旧与大 chunk 构建提示。

仍不能标记完成的内容：

1. **全程在 MRT 内逐点校准**：本节记录当时状态；后续圆环校准交互见第 18 节。逐点桥接和真机精度仍未验收。
2. **Windows 发布验收**：新增 CI 配置不代表已在 Windows 执行；仍需完整安装包构建、安装、升级、卸载以及打包资产可用性验证。macOS 独立服务不是签名/公证安装包。
3. **Pupil 及旧三型号真机回归**：无真实硬件，校准精度、帧率、丢帧、热插拔、长时高负载及物理声画延迟尚无实测证据。
4. **全部旧指标等价与完整业务验收**：raw/smooth 仍是兼容别名，不是独立滤波；不存在的单眼、眼睑、扫视角度不伪造。合并注视位置取最后一个 Capture 窗口中心，未重算整段中心。无有效 gaze 的眨眼不能确定 AOI。已验证解析/CSV 导出不等于所有图表、AOI、叠加视频及报告组合完成验收。

恢复只能保全已写出的片段和日志，末尾可能丢失；音频同步是软件估计，不含麦克风硬件延迟校准。这些限制必须在验收时保留，不承诺“零 bug”或无损采集。源事件实现依据 [官方在线注视检测器](https://github.com/pupil-labs/pupil/blob/master/pupil_src/shared_modules/fixation_detector.py) 和 [官方眨眼检测器](https://github.com/pupil-labs/pupil/blob/master/pupil_src/shared_modules/blink_detection.py)。

## 18. 2026-10-08 本软件控制 Pupil 圆环校准（历史方案，已被第19节替代）

用户确认校准、录制均从本软件发起操作。本节替代第 16、17 节中需要切换 Capture 操作校准的旧交互描述。

- 录制页选择「Pupil 圆环校准」，点击校准后复用 7invensun 已有的 `FullscreenCalibrationOverlay`，在同一校准界面显示专用圆环和完成采样操作，不新增独立页面或校准窗口。被试注视中心，缓慢向上下左右转头，保持完整标记在世界相机视野内，覆盖不同视角后点击「完成采样」；也可取消或按 Esc 退出。建议采样约 20 秒或更久，计时不代表识别状态或精度评分。其他设备继续使用原目标样式和逐点交互。
- 后台通过 Remote `notify.start_plugin` 配置内置 `SingleMarkerChoreographyPlugin` / `Physical Marker`，无需新增 Capture 插件，也不打开 Capture 标记窗口。ACK 仅代表通知收到，工作线程继续收帧并在 0.5 秒后发送 C，必须收到真实开始通知；10 秒未开始、300 秒采样超时或完成后 15 秒无结果均失败。
- 点击完成发送独立 `finish_calibration` 命令及 Remote c，异步等待真实 successful/result.v2；取消先失效本轮状态再停止采样，迟到结果不能恢复凭据。开始、完成和取消 ACK 均不充当校准结果。准备阶段取消不会延迟发送 C。
- 圆环半径比例 60/38/19，采用不透明白底、黑白环和中心小点。参考位置由 Capture 识别世界相机画面得到，本软件屏幕坐标不冒充世界相机坐标；不复用其他设备逐点流程，不伪造左右眼评分。现阶段校准标记显示在主软件窗口，分屏设置仍用于刺激物播放。
- Capture 必须在后台运行并提供相机与 Frame Publisher 数据；本软件继续独立保存 MP4/CSV，不启动 Capture 录像。重连、断流、外部重新校准后凭据失效。Remote 没有校准请求 ID，测试时不要同时在 Capture 手动发起校准。
- 服务日志包含 `pupil.calibration` 的 preparing/started/finish requested/verified/canceled/failed 阶段；前端 debug 日志增加 finish_calibration 命令响应，便于按时间定位。测试 UI 位于 `tests/eye_tracking/pupil_core/calibration_ui.html`，挂载真实生产组件，支持失败重试、取消和等待结果验证。

实现依据：[官方 Network API](https://docs.pupil-labs.com/core/developer/network-api/)、[Single Marker 实现](https://github.com/pupil-labs/pupil/blob/master/pupil_src/shared_modules/calibration_choreography/single_marker_plugin.py)、[圆环绘制参数](https://github.com/pupil-labs/pupil/blob/master/pupil_src/shared_modules/calibration_choreography/controller/marker_window_controller.py)。真机识别、校准精度、目标 Capture 版本与 Windows 安装包仍需验收。


## 19. 2026-10-08 按 ASeeGlass 流程使用实体卡片（历史三点规则，当前见第20节）

用户要求从场景摄像头画面点击实体卡片中心，替代第18节屏幕圆环。Pupil 默认卡片式三点，可选卡片式一点，复用 `RecordingPage` 的实时视频、卡片中心检测 worker、含黑边排除的点击坐标映射、逐点进度及 `calibrationFlow`；其他设备原有交互不变。生产界面不创建卡片图像或新页面；测试 harness 的卡片仅为模拟相机输入。

每次点击后约1秒收集世界相机参考帧与双眼3D瞳孔数据。静止采样期间需保持头部与卡片稳定；没有对手选位置执行光流跟踪。世界参考坐标由左上原点点击值转换为 Pupil 左下原点归一化值，同时保留像素与源时间。每点至少10个场景参考帧、每眼10条有效3D瞳孔样本，不足时不前进、不累积失败样本，可重试同一点；拒绝越界/非有限坐标、错序和重复提交、陈旧场景帧。

全部点完成后，通过官方 `start_plugin` / `Gazer3D` / `calib_data` 拟合，不启动 Single Marker 插件、不发送 C/c。共享流程的 `complete_calibration` 返回 pending 期间保持校准状态，匹配本轮提交数据的 setup.v2 加新鲜 successful/result.v2 才启用追踪。匹配源数据防止旧拟合 setup 被当前会话接受；取消、采样300秒超时、拟合15秒超时、断流、外部校准均失效。本软件不把通知回执或点采样成功当作拟合成功。

回归覆盖实际 REP/PUB 卡片三点采样、坐标原点转换、双眼3D数据与旧设备契约，另验证 UI 场景点击与黑边不采样。真机算法质量和 Windows 精度仍需实测。官方依据：[GazerBase 拟合及通知实现](https://github.com/pupil-labs/pupil/blob/master/pupil_src/shared_modules/gaze_mapping/gazer_base.py)。

### 校准后视频恢复边界

Capture 拟合阶段采用有上限的等待；收到匹配拟合结果后还必须等到新的场景帧，才能报告成功。普通视频断流阈值不变。诊断证据和页面重载排查见 [校准后视频中断](../debug/pupil-2026-10-08-post-calibration-video.md)。


## 20. 2026-10-10 真实数据审计后的质量修复

当前 Pupil 生产入口使用共享场景页面的「卡片式三点/五点/九点校准」，默认仍为九点。自动识别实体卡片中心、按钮采样；三种点数均自由选择场景内位置，不显示目标框、不指定取点方位和顺序。各点应分散且不共线，拟合前只检查整体退化；双眼模型、配对比例和稳定性要求不降低。末点质量失败保留前面已通过的点，可自由移动卡片后重试。其他设备校准配置保持原样。独立「校准测试」在同一页面采样三个分散目标，仅测量实际源像素偏差，不重新拟合、不虚构角度分数或达标阈值。每眼3D模型及覆盖门槛、验证/取消/失效边界详见 [运行说明](../../services/eye_tracking/adapters/pupil_core/README.md#2026-10-10-数据质量与独立验证当前规则)。

预览/导出从真实 `gaze.base_data` 配对瞳孔，模型异常的数据显式剔除并保留源值。眨眼采用同连接完整阶段配对；统计区分 gaze、有效 gaze 和眼相机速率。通过独立重建工具可修复历史数据的配对与标记，不能追溯修复异常模型导致的 gaze。代码和报告有自动回归证据；最终角度准确性仍需目标 Windows 机器佩戴调整后进行独立实测。

[本轮数据审计](../debug/pupil-2026-10-10-recording-integrity.md) · [修复与验收记录](../debug/pupil-2026-10-10-quality-fixes.md)

第三点旧区域规则的历史诊断见 [第三点区域诊断](../debug/pupil-2026-10-10-third-point-region.md)。最新末点失败与自由取点修复见 [末点失败与自由取点](../debug/pupil-2026-10-10-final-point-free-card.md)，后端诊断版本为 `pupil-free-card-v7`。
