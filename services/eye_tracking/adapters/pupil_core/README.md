# Pupil Core 旧 Capture 后端

> 当前默认使用 [内置原生后端](../pupil_native/README.md)，不需要启动 Capture。本文保留为显式 `MRT_PUPIL_BACKEND=capture` / `--backend capture` 的诊断、历史数据及兼容路径说明；以下 Capture 操作不适用于默认后端。

Pupil Capture 负责采集，MRT 独立服务负责接收、视频推送和 MP4/CSV 保存。正式入口为 `services.eye_tracking.entrypoints.pupil_server`，不启动模拟器、不提供联调网页、不加载 7invensun SDK。

已接入 MRT 新建工程型号选择、型号持久化、Electron 独立进程路由、现有视频/眼动预览、Capture 校准结果、实验目录 MP4/CSV 保存、标记及原记录列表。Windows 打包脚本和资源配置已接入，尚未在 Windows 构建验收。没有真机，不能把软件回归通过等同于硬件验收。旧 Pro、A8、aSeeGlassesPlus 保留原 SDK、校准和录制路径。

操作顺序：新建工程选择 **Pupil Core** → 创建/选择实验和被试 → 打开 Capture、启用 Pupil Remote 和 Frame Publisher → 在 MRT 启动设备 → 选择三/五/九点，在共享场景页面完成实体卡片采样 → 点击「校准测试」采样三个独立目标 → MRT 录制、停止、查看记录。所有操作从 MRT 发起；Capture 在后台拟合，不需要切换到 Capture 操作校准。

## 工程职责

```text
services/eye_tracking/
  entrypoints/pupil_server.py       正式进程入口、参数、信号退出
  requirements/pupil-capture.txt    隔离运行依赖
  application/pupil_runtime.py      连接、采集、录制状态及异步收尾
  domain/                          样本、能力、契约、源时间线
  adapters/pupil_core/              Capture 协议及数据标准化
  transport/pupil_protocol.py       现有 MRT 消息格式转换
  transport/pupil_runtime.py        命令、图像、眼动 WebSocket
  infrastructure/recording_paths.py 项目写入授权
  infrastructure/pupil_recorder.py  编码、文件保存和结果校验
  infrastructure/pupil_csv.py       CSV 字段映射
  infrastructure/pupil_events.py    注视/眨眼事件归并、CSV 按时间排序
  infrastructure/pupil_recovery.py  独占锁、中断录制恢复及原件保留
  packaging/mrt-pupil-server.spec   独立打包定义
tests/eye_tracking/pupil_core/      自动化回归（不随产品打包）
  tools/                           历史探针、模拟器及联调页
```

Pupil 不加载旧 SDK，不让新运行依赖进入旧设备环境。旧驱动及 `sdk_driver.py` 兼容别名均归入 `adapters/invensun_7/`。自动化回归仍保留，但不是用户使用入口，也不是生产依赖。2026-10-16 入口和依赖清单改为上述目录；旧命令见[服务目录迁移说明](../../../README.md)。

## 安装与启动

在仓库根目录创建独立 Python 3.11+ 环境。Electron 优先使用 `MRT_PUPIL_PYTHON_BIN`，否则查找下列专属 `.venv`，不使用旧设备的 `MRT_PYTHON_BIN`。

```bash
# macOS
python3 -m venv services/eye_tracking/adapters/pupil_core/.venv
services/eye_tracking/adapters/pupil_core/.venv/bin/python -m pip install -r services/eye_tracking/requirements/pupil-capture.txt
```

```powershell
# Windows PowerShell
py -3.11 -m venv services/eye_tracking/adapters/pupil_core/.venv
services/eye_tracking/adapters/pupil_core/.venv/Scripts/python.exe -m pip install -r services/eye_tracking/requirements/pupil-capture.txt
```

安装 FFmpeg（含 libx264）与 ffprobe。开发时优先使用 `MRT_FFPROBE_PATH`、资源目录、`services/dist` 或 FFmpeg 同目录的 ffprobe，再尝试 PATH；若 ffprobe 缺失，正常录制收尾使用 FFmpeg FrameMD5 完整解码核验帧数、尺寸和时长（不会跳过校验）。中断记录恢复仍需要 ffprobe。FFmpeg 由现有 Electron 查找器提供。正常使用由 MRT 自动启动服务，不需要另开命令行进程。单独诊断可用该解释器运行 `-m services.eye_tracking.entrypoints.pupil_server --help`。

默认仅监听 127.0.0.1：图像9001、眼动9002、命令9003；Capture Remote 为50020。若现有 MRT 服务占用端口，新服务明确启动失败，不抢占、不终止旧服务。可用 `--image-port`、`--eye-port`、`--command-port` 配置互不相同的端口。

只启动服务不要求连接硬件或启动 Capture，不自动录制。允许无 Origin 的原生客户端；浏览器必须以 `--origin` 显式配置准确来源，不支持通配符。Electron 启动器自动传递开发页面来源或打包后文件页面的 null Origin。

录像通过 `--ffmpeg`、`--ffprobe` 指定可执行路径。录制及启动后的中断记录恢复会调用编码工具；缺失会报错并保留诊断。连接/状态查询只使用 v/SUB_PORT/t 和 IPC 订阅；用户启动/取消校准时才发送 C/c。从不发送 R/r 或 T，不修改 Capture 配置、不关闭 Capture。

## 无设备时的状态

命令消息沿用 MRT 格式，例如：

```json
{"type":"req_cmd","id":"get_device_status","args":{}}
```

- 服务可启动：WebSocket 可用，不代表相机可用。
- Capture 可连接：`capture_connected=true`，可以获取版本。
- 世界相机有合法首帧：`acquisition_ready=true`。
- Capture 打开但没有硬件：状态查询正常；`start` 等待首帧超时后返回 error=-1；`start_recording` 拒绝保存，不产生假视频。
- 断流：停止本次采集，已开始的录像进行异常收尾；需显式重新 start，不把不同连接的数据拼接。
- 支持现有刺激物、软件标记和外发 trigger 的记录；分屏仍显示刺激物，保存源始终是世界相机，不是屏幕截图。

校准和录制均从 MRT 录制页面操作。当前生产入口提供「卡片式三点/五点/九点校准」，默认仍为九点，复用 ASeeGlass 的场景预览、卡片中心检测、点击采样和进度。实体卡片必须由场景摄像头拍到：软件不绘制卡片，不显示屏幕圆环，也不新开校准页面。注视实体卡片中心，由自动检测提供中心，点击画面下方「校准」按钮确认；点击视频不会提交参考点或添加点击红点。点击后保持头部和卡片稳定约1秒，完成当前点后移动卡片至不同视野位置再采下一点。

`start_calibration` 按所选3/5/9点创建本连接的采样会话，未传点数默认9（底层保留1点协议兼容）；`start_calibration_point` 使用场景图像左上原点的归一化坐标，转换为 Pupil 左下原点的 `norm_pos`，保留世界相机像素 `screen_pos` 和源时间。点击需要新鲜场景帧，每点至少10帧参考和每眼10条有效3D瞳孔样本；不足时返回错误并重试同一点。采样期间必须保持头部、卡片稳定，适配器在独立进程逐帧追踪实际卡片中心。双眼 3D 模型质量、目标稳定性和所选点数的覆盖也必须合格；完整规则见末节。

所有点完成后，沿用共享流程3秒收尾等待，`complete_calibration` 通过 `start_plugin/Gazer3D` 的 `calib_data={ref_list,pupil_list}` 交给 Capture 拟合。不发送 C/c，不调用屏幕标记或 Single Marker 自动采样。通知 ACK 和命令返回 `result_pending` 都不是成功。只有与提交数据匹配的 `calibration.setup.v2`、本次源时间之后的 `calibration.successful` 和 `calibration.result.v2` 才返回连接内凭据。采样会话最多300秒，拟合等待15秒；取消、超时、断流和迟到结果均不能恢复旧授权。

凭据沿用 MRT 的 coe 字段，但不是旧 SDK 系数，不能跨连接恢复。不要同时在 Capture 手动发起另一轮校准。校准点数只代表采样位置数量，不保证精度；以 Capture 的真实结果为准，不提供虚构的左右眼评分。Windows 真机精度、视野覆盖、3D眼模型与目标 Capture 版本仍须验收。分屏设置继续用于录制刺激物，Pupil 校准只操作主软件的场景视频。

官方拟合契约见 [GazerBase](https://github.com/pupil-labs/pupil/blob/master/pupil_src/shared_modules/gaze_mapping/gazer_base.py)。

## 命令与数据

| 命令 | 行为 |
| --- | --- |
| get_device_status | 查询 Capture 连通性、版本及采集就绪状态 |
| start | 仅接受 PupilCore；等待世界相机首帧 |
| stop | 停止采集；录制或收尾中拒绝停止 |
| start_tracking / stop_tracking | 开关 gaze 转发 |
| start_calibration / cancel_calibration | 本软件发起卡片逐点采样/取消并丢弃结果 |
| start_calibration_point | 共享页面提交自动识别的实体卡片中心，异步采样当前点 |
| complete_calibration / finish_calibration | 所有点完成后提交拟合，异步等待真实结果 |
| set_stimulus | 保存当前刺激物名称及切换源时间 |
| add_custom_marker / add_trigger_marker | 用 Capture 源时间映射到视频时间，保存元数据和 CSV |
| get_recording_markers | 查询当前/最后一条记录的标记 |
| start_recording | 校验项目授权、真实型号、最新世界帧及本连接校准后开始保存 |
| stop_recording | 返回 finalizing，异步完成编码与校验 |
| get_recording_status | 查询 recording/finalizing/finalized/idle 及真实结果 |
| get_source_clock | 返回 Capture 源时间、连接代次、录制 ID 与视频时间原点，供 Pupil 音频对齐 |

响应沿用 `rsp_cmd/id/error/msg`。收尾事件为 `notify_recording_finalized`，含 recording_id、视频/CSV路径、error/msg；断开后用 get_recording_status 取回最后结果。命令队列有界，慢预览客户端只保留最新批次；保存队列超限则失败，不静默丢数据。状态仅保存在当前服务进程内，进程重启后的记录需读取磁盘元数据。

图像沿用 `image_frame` JPEG/base64 消息；支持 scene/left_eye/right_eye。Capture 发布格式可为 BGR 或 JPEG，接收后统一为 BGR。拒绝尺寸不符、损坏图像及超限解码。`?stream=encoded` 明确关闭，调用方应使用 image 模式。

gaze 转换为世界图像左上角归一化坐标，不当作屏幕坐标。只输出实际融合 gaze，不伪造单眼 gaze 或眼睑指标。CSV 的 source_model 与实时消息的 source 标识启用 Pupil 专属边角坐标处理，合法 (0,0) 可显示/回放，旧设备零值过滤不变。瞳孔 px 与 mm 分列，mm 缺失时留空，不用 px 冒充；匹配同连接、过去100ms内最近收到的有效瞳孔样本，保留其源时间。完整原始数据另存附档。

## 录制目录与文件

必须通过 `--project-root <已有PupilCore工程根目录>` 授权；默认空授权，只可预览。Electron 从当前已授权工程自动传递。支持根目录或其 `experiments/<实验ID>` 下保存，不接受任意子目录或工程父目录。start_recording 参数包括 project_path、subject_name 和 video_sampling_rate_hz（整数1–120，默认30）。

工程根目录 project.json 的 deviceModel 必须为 PupilCore，眼动 modality 身份不得冲突。禁止借用旧设备工程、越界或通过 recordings 符号链接重定向。使用 MRT 新建工程，不手工修改旧工程型号。

自动生成 `pupil_<随机ID>_YYYYMMDD_HHMMSS` 名称（本地时间），兼容既有列表识别，真实被试名保存在 meta。拒绝覆盖。产物：

- recordings/<名称>.mp4：MRT 编码的场景视频。
- recordings/<名称>.csv：源时间对齐的 gaze；raw/smooth 为明确记录的兼容别名。
- recordings/<名称>.meta.json：complete/partial/failed、时间轴、来源和校验结果。
- recordings/<名称>.pupil/：实际收到的原始 gaze/pupil、标准样本、帧映射、暂存及编码诊断。

视频短间隔按源时间保持前一帧并计数，默认超过0.5秒的源间隔拒绝继续。视频校验（ffprobe，或工具缺失时 FFmpeg 完整解码）且文件收尾成功才为 complete。partial/failed 不是完整实验记录。正常退出用父子进程管道等待收尾，Windows 不依赖 SIGTERM。删除 Pupil 记录时关联删除其 .pupil 附档，旧记录不受影响。ZeroMQ 不保证无损；高负载、长时录制、硬件音频延迟与全套分析结果仍须真机验证。

### 异常中断恢复

新录制采用 fragmented MP4，约一秒一个片段；每秒刷新并同步 gaze/event/raw/frame-map 日志。标记/刺激物上下文另行原子保存。下次启动 Pupil 服务时，只扫描已授权 Pupil 工程及其实验目录的未收尾记录，使用跨平台文件锁跳过仍在录制的实例。恢复需要可用的 FFmpeg/ffprobe，并可能延长服务首次响应时间。

可解码片段重新封装、校验后，按恢复视频时长重建 CSV；原 MP4/CSV 保存在 `.pupil/interrupted.mp4`、`interrupted.csv`。恢复结果始终为 `partial`，元数据包含 `recoveredAfterInterruption`，状态查询的 `recovered_recordings` 可查看结果。不能恢复时为 `failed`，保留文件及 `recoveryError`；不修改旧设备或已完成记录，不通过符号链接处理外部文件。碎片尚未写出、断电未落盘、旧版缺失 moov 的 MP4 不保证能恢复，不能声称零丢失。

### 注视、眨眼与分析导出

如需源事件，用户在 Capture 启用 **Fixation Detector**、**Blink Detector**。MRT 不自动更改 Capture 插件配置，独立订阅 `fixations` / `blinks`；未收到事件的录制在元数据 `eventAvailability` 中明确说明，不以零事件冒充检测结果。

在线注视同一 ID 的重叠窗口归并为一次事件，裁剪到视频范围，以最后一个窗口的真实中心为位置（不是整个合并区间重新计算的中心）；原始窗口仍保留在附档。CSV 注视索引转为 MRT 的正整数，源 ID 单列保留。眨眼 onset/offset 去除连续同相消息，真实 gaze 行携带源眨眼状态；不虚构左右眼归属或无 gaze 时的坐标。未配对 onset 不导出为完整眨眼时长。AOI 内眨眼统计仍受无有效 gaze 时无法定位的限制。

CSV 使用磁盘排序归并 gaze、事件、标记，避免长时数据全放内存及破坏原有时间索引。已覆盖原 MRT 注视/gaze 解析和实际 CSV 导出处理器；事件行不计为 gaze。`recommended/raw/smooth` 仍是显式兼容别名，并非三套测量或新滤波算法。Pupil 未提供的扫视角度/眼睑等指标仍缺失，不能宣称全部旧厂商指标等价。

### 音频同步

仅 Pupil 录制启用额外时钟采样：开始和停止时对 Capture `t` 各采样三次，选最小往返时间；关联录制 ID/连接代次，用浏览器单调时钟与 AudioContext 时长估计偏移及线性速率。合并时补静音或裁剪起点，`atempo` 修正估计速率并补齐视频长度；元数据保存 `audioSynchronization`、时钟往返误差估计，明确 `hardwareLatencyMeasured=false`。

连接变化、时钟跳变、往返超过200ms或速率偏差超过1%时拒绝自动合并。视频必须有已校验的 complete/partial 元数据，不能仅因 MP4 文件出现就开始合并。合并失败保留原音频临时文件，原有提示框给出路径，避免删除唯一副本；临时文件可能被系统清理，需及时归档。软件对齐不代表声卡/麦克风物理延迟已校准，仍需目标机器声画同步实测。旧三型号不要求 Pupil 时钟信息。

## 打包与验证边界

发行后端统一从 native 专属环境构建，同时保留显式 Capture 模式。先按[原生后端安装说明](../pupil_native/README.md)准备环境，再安装构建依赖并指定同平台 ffprobe；不要把 native 构建清单装入上文使用 headless OpenCV 的 Capture 对照环境：

```powershell
services/eye_tracking/adapters/pupil_native/.venv/Scripts/python.exe -m pip install -r services/eye_tracking/requirements/pupil-build.txt
$env:MRT_FFPROBE_PATH = 'C:\tools\ffmpeg\bin\ffprobe.exe'
npm run build:pupil-server
# 完整安装包（仍需准备原三型号和表情服务的构建依赖）
npm run dist:win
```

独立 spec 排除 tests 和旧 SDK。安装包复制完整 `services/dist/pupil-backend/`、对应第三方声明及 ffprobe；不能只取 `mrt-pupil-server.exe`。FFmpeg 沿用现有资源。构建脚本不自动向旧 Python 环境安装依赖。Windows 构建、升级/卸载、Pupil 真机和旧三型号真机仍为发布验收关口。

工程回归位于 tests/eye_tracking/pupil_core，CI 使用 Windows/macOS 矩阵，覆盖协议、正式命令、路径授权、实际编码、异常恢复、音频及事件导出；增加 PyInstaller 构建和打包后进程连接/父管道退出检查。2026-09-27 已在本机构建 macOS arm64 独立程序；这不是签名/公证的完整 macOS 安装包，Homebrew FFmpeg/ffprobe 也不是可移植发行资产。Windows CI 尚未在远端执行，完整 Windows 安装、升级/卸载仍须目标机器验收。没有硬件时不能证明真机帧率、精度、校准或三旧型号无回归。

协议依据：[Pupil Core Network API](https://docs.pupil-labs.com/core/developer/network-api/)。完整历史方案见 [接入方案](../../../../docs/方案/PupilCore接入方案.md)。

### 场景比例与校准坐标（2026-10-09）

场景预览使用 object-contain：点击、卡片位置和注视叠加均按实际源图宽高计算内容区域，黑边不参与坐标归一化。图片加载或分辨率变化后更新内容区域，未加载图片不能提交点击。全屏眼镜像素坐标按源图尺寸归一化，再映射到显示区域。

共享页面提交左上原点的 `(x, y)`，Pupil 适配器转换为左下原点的 `norm_pos=[x, 1-y]`；`screen_pos=[x*源图宽, y*源图高]`。例如 1280×720 的画面中心是 `[0.5, 0.5]`，对应 `(640, 360)`，不能以窗口尺寸或含黑边的尺寸代替源图。采样期间源图分辨率变化则拒绝当前点，不推进点号，重新点击采样。

这项修正处理显示和坐标转换，不代表精度已验收。已启用 Natural Feature 逐帧追踪；独立精度验证仍需真机完成，不能把拟合成功等同于注视准确。

### Natural Feature + 场景实体卡片

继续使用录制页原共享卡片校准入口。被试注视场景中的实体卡片中心，自动识别卡片中心，主试点击校准按钮启动当前点；Pupil 适配器对发布的 BGR/JPEG 场景帧做光流追踪，将每一帧实际中心坐标与该帧 Pupil timestamp 写入 ref_list，由 Capture Gazer3D 拟合。不会在屏幕上生成替代实体卡片的图案，也不需要安装 Capture 自定义插件。

追踪做前后向一致性、图像质量、像素残差、位移和时间间隔检查；目标丢失、跳变、超过 250 ms 帧间隔或源图分辨率变化时当前点失败，重新点击采样，不保留失效点的数据。瞳孔数据限于已追踪帧覆盖的源时间段前后 50 ms。三点模式要求水平/垂直跨度各至少 0.15、归一化三角形面积至少 0.01，避免重复或共线目标；这些是退化检查，不是精度保证。一点模式仍兼容，但不提供全视野覆盖保证。

录制附档 `<记录名>.pupil/calibration.msgpack` 保留本连接参考点、瞳孔、采样中心、拟合成功通知及 gazer 参数。`independentValidationPerformed` 由本连接实际完成的独立验证决定；`cameraIntrinsicsArchived=false` 表示尚无相机内参归档；该附档不是 Pupil Player 录制格式。

Windows 开发工作区拉取后，更新 Pupil 专用环境（不要安装到 7invensun/华弘环境）：

```powershell
services/eye_tracking/adapters/pupil_core/.venv/Scripts/python.exe -m pip install -r services/eye_tracking/requirements/pupil-capture.txt
```

新增 `numpy` 与 `opencv-python-headless` 仅用于 Pupil 场景特征追踪；PyInstaller spec 收录它们，发布安装包需重新构建 Pupil 后端。自动化包含真实光流的移动卡片 BGR/JPEG 测试、丢失重试、覆盖拒绝和正式命令/录制归档回归；仍需 Windows 真机独立验证精度、佩戴/眼模型和预览延迟的影响。

### 校准追踪进程隔离（2026-10-09）

Natural Feature 的依赖加载、解码和光流在独立显式子进程执行，不占用视频采集与命令线程。校准启动时预热，就绪后点击校准按钮立即确认进入采样；初始化最多 60 秒、单次计算最多 2 秒，超时终止追踪进程并拒绝当前点，视频和取消/停止命令继续响应。初始化后若采样参考帧已超过 250 ms，要求重新识别并提交当前目标，避免使用过期画面。取消、结束及断开连接都会清理追踪进程；任务按采样标识过滤，旧结果不能推进新采样。

光流内部等比缩放到最长边 640 像素，输出仍转换回原始场景像素坐标。队列有界，繁忙时跳过计算帧，不积压视频。子进程记录依赖版本、初始化耗时、慢计算及卡住时的调用栈；打包入口调用 freeze_support，Windows 安装包需要重建后端。真机确认仍需新一轮 debug，不能以模拟回归替代 Windows 硬件验收。

启动隔离补充：进程创建由专用启动线程执行，采集线程不等待子进程启动。启动中取消后，迟到启动的子进程立即销毁。debug 首行当前为 `pupil.backend revision=pupil-data-v4`（追踪仍为 pipe-v3），明确实际 Python/模块路径，命令阶段超过 3 秒输出调用栈；get_device_status 返回相同 revision 及追踪状态，避免仅根据 Git HEAD 推断运行中的后端版本。

### 自动中心与显式追踪入口（feature-pipe-v3）

Pupil 复用 ASeeGlass 的自动卡片中心识别及下方校准按钮，点击场景不提交参考点或新增点击红点。尚未识别中心、正在采样时禁止再次提交；追踪未 ready 时提示等待，不创建空采样。追踪进程失败会结束本次校准并清理，保留视频连接，普通目标丢失可重试当前点。进度仅在真实参考帧与双眼瞳孔检查通过后变绿。

当前实现替换历史 multiprocessing spawn/Queue：使用显式 `--feature-worker` 轻量入口与有界长度 msgpack 管道，避免回放完整服务主模块。启动与管道 I/O 在独立线程，stderr 显式汇入 debug；`feature-pipe-v3` 标记区分新后端。首行 bootstrap entered 先于 OpenCV/numpy 导入，能据此定位实际阶段。Windows 安装版需要重新构建后端；不能把 macOS 验证等同于 Windows 硬件或精度验收。

原生依赖冷启动在本机 macOS 冻结程序实测约 27 秒，初始化预算改为独立 60 秒；不计入约 1 秒的点采样窗口，点计算仍限制 2 秒。准备中按钮禁用并显示状态，只有当前 calibration_session 的 calibration_ready 通知才能启用；取消或旧会话的通知不生效。窗口可继续收视频、取消及停止，超时则明确失败。

### 瞳孔数据接收与校准诊断（pupil-data-v4）

只有发起校准时发送 `pupil_detector.set_enabled`，启用两眼已加载的检测器，保证 Pye3D 的 2D 输入；视频开启和查询没有此副作用，不重置眼模型或 ROI。ACK 不能替代真实 3D 数据。数据通道每轮最多非阻塞接收 64 条，校准通知/事件各 16 条，视频 1 条，避免高频瞳孔数据在处理视频时积压，又保证命令及时返回。

点结果包含 pupil_diagnostics：topic 数量、拒绝原因、置信度和源时间差、双眼有效/配对数量及参考窗口。前后端 debug 同时保存聚合诊断，get_device_status 可查询 received_by_topic。失败提示区分未收包、只有 2D、时间落后、低置信度、缺少眼模型与配对时间不匹配，失败不会推进点号。详细证据与同场景旧版/新版复现见 [10 月 10 日诊断](../../../../docs/debug/pupil-2026-10-10-zero-pupils.md)。


## 2026-10-10 数据质量与独立验证（当前规则）

后端诊断版本 `pupil-free-card-v7`（继承 `pupil-quality-v5` 质量规则）。本次修改仅改变 Pupil 的质量与校准策略，7invensun 与华弘沿用各自配置。原始测试数据不提交 Git。

- **配对**：预览和 CSV 均以 `gaze.base_data` 的真实贡献眼为准，允许瞳孔时间位于双眼平均 gaze 时间两侧（最多100 ms），不混入另一眼缓存、不跨连接。仅无 base_data 的历史兼容样本使用同代次、100 ms内的过去缓存。
- **模型**：检测 confidence 与 `model_confidence` 分开。校准样本要求检测 confidence≥0.6、模型 confidence=1、sphere中心 x/y在±10 mm、z在20–75 mm，直径1–9 mm。每点至少10帧、每眼10条合格数据且配对合格比例≥80%。目标源归一化坐标每轴范围≤0.025。失败点不推进；不会自动冻结/重置眼球模型。
- **点数与自由取点**：三/五/九点均由场景相机中的实体卡片实际中心提供参考，不指定方位或移动顺序，不显示目标框，也不强制覆盖九宫格及画面边缘。每点可自由选择双眼能舒适稳定注视的位置；各点应分散且不共线，拟合前只作整体退化检查：两轴跨度≥0.15、最大三角形面积≥0.01。该检查不指定任何点的位置，也不是官方精度达标阈值。1点仅保留底层协议兼容。点号只是进度，界面网格索引不作为实际参考坐标。
- **末点失败和诊断**：质量不足不推进点号，不丢弃已成功采样点；可移动卡片到其他位置重试当前点。失败提示给出已完成进度、双眼合格比例或样本数，并区分采样会话超时和 Capture 拟合超时。点结果继续保存 `tracked_center_top_left`，新增 `rejected_by_eye`；兼容字段 `target_region_required=false`、`target_region_ok=true`、`target_bounds_top_left=null`。主失败原因根据受影响眼的拒绝统计判断，避免另一眼少量模型异常掩盖本眼大量检测置信度不足。最新证据见 [末点失败与自由取点](../../../../docs/debug/pupil-2026-10-10-final-point-free-card.md)。
- **独立验证**：拟合成功后点击「校准测试」，在同一页面采样三个分散目标，不重新拟合。按源时间在相邻参考帧之间插值（间隔最多100 ms），只使用有效且模型合格的 gaze，每目标至少10对。输出平均/中位/P95源视频像素误差、有效比例和匹配明细；任务要求被试持续注视中心，软件不能独立观察其主观注视目标。三点三角形面积至少0.01；报告没有角度精度或达标分数（`accuracyAcceptance=not_configured`）。
- **状态**：验证必须使用当前连接已验证 token，验证期间禁止录制；取消验证保留原拟合及已完成报告，失败/超时/断连/外部新校准使 token 失效。迟到消息不能恢复已结束的任务。录制附档保留训练数据及最后一次完整验证，不保留半轮测量作为完整报告。
- **导出**：异常模型 gaze 不写主注视坐标；源坐标和原因保存在 `source_norm_pos_*` / `gaze_invalid_reason`，原始消息也仍保留。像素瞳孔直径按真实配对导出，异常3D模型毫米值只写 `*_pupil_raw_diameter_mm`，主毫米列留空；另记录每眼模型 confidence/quality。不存在的单眼注视、眼睑、扫视等量继续留空。
- **事件**：眨眼 confidence 是 Capture 事件量，不套用瞳孔0.6阈值；完整同代次 onset/offset 才计一次，孤立阶段显式标记且不向后污染 blink 状态。注视事件保留 Capture 在线窗口语义，不能作为独立精度真值。
- **统计**：`gazeMessageRateHz`、`validGazeRateHz`、`eyeSamplingRateHz`、`eyeModelValidPercent`、`gazeInvalidReasons` 分开归档，录制恢复也重算这些字段。列表/meta 不再将实测246.96 Hz套成240档位；gaze率不等于眼相机独立采样率。

现有数据可用 `tools/pupil/rebuild_recording.py <原CSV> --output <新的目录>` 生成独立派生CSV及报告。工具核对原始/标准日志逐条身份、前后SHA-256，拒绝覆盖，不修改视频或工程索引。它修复配对与质量标记，不能修复当时异常的眼球模型或重新生成准确 gaze。真机记录的审计及修复结果见 [完整性报告](../../../../docs/debug/pupil-2026-10-10-recording-integrity.md) 与 [修复验收](../../../../docs/debug/pupil-2026-10-10-quality-fixes.md)。

依据：[官方数据匹配](https://docs.pupil-labs.com/core/developer/#pupil-data-matching)、[3D模型生理范围与模型confidence](https://github.com/pupil-labs/pupil/releases/tag/v3.4)、[官方校准与验证](https://docs.pupil-labs.com/core/software/pupil-capture/#calibration)。缺少相机内参与独立真机目标实测时，不宣称角度精度已通过。
