# Python 服务目录说明与清理边界

本目录承载眼动和表情分析后端。目录、协议及兼容要求以[系统架构](../docs/架构/系统架构.md)和[维护手册](../docs/维护/维护手册.md)为准。本说明用于区分产品源码、开发环境、发行产物和可再生缓存，不改变设备流程。

2026-10-16 清理前只读盘点：Git 跟踪文件 113 个，文件内容合计约 4.72 MiB；本机目录占用约 1.7 GiB，主要来自虚拟环境和构建产物。体积是本机快照，不是安装包大小。后续新增文件及清理会改变这些数字。

## 1. 顶层目录

| 路径 | 用途 | 处理原则 |
| --- | --- | --- |
| `__init__.py` | 支持 `python -m services.…` 包入口 | 保留 |
| `requirements.txt` | 原眼动与表情环境依赖：OpenCV、NumPy、屏幕采集、WebSocket、MediaPipe | 保留；不合并 Pupil 专属依赖 |
| `eye_tracking/` | 7invensun、Pupil、华弘服务源码和独立构建定义 | 保留，子目录见下文 |
| `facial_analysis/` | 表情帧推理和视频分析服务 | 保留，子目录见下文 |
| `build/` | 中间产物、源码下载、构建缓存、验收证据 | 分类清理；不能整目录无差别删除 |
| `dist/` | 当前可分发后端、视频校验工具、第三方声明 | 当前产物保留；重建前可按构建脚本清理 |
| `**/__pycache__/`、`*.pyc`、`.DS_Store` | Python/操作系统缓存 | 可再生，不提交；清理跳过虚拟环境和发行包 |

`.gitignore` 已排除 `services/build/`、`services/dist/`、虚拟环境及缓存。源码检查依赖 Git 跟踪清单，不能以“被 Git 忽略”推断“运行不需要”。

## 2. 眼动服务 `eye_tracking/`

### 入口和依赖文件

2026-10-16 按职责整理目录，根部只保留包标记及子目录。入口、分析工具和依赖清单分别集中；不再保留根部同名启动脚本。

```text
eye_tracking/
  __init__.py
  entrypoints/           server.py、pupil_server.py、huahong_server.py
  analysis/              gaze_mapper.py、eye_event_postprocess.py
  requirements/          pupil-native.txt、pupil-capture.txt、pupil-build.txt
  adapters/              invensun_7、pupil_core、pupil_native、huahong
  application/           采集与录制生命周期
  domain/                样本与领域契约
  transport/             WebSocket 与消息协议
  infrastructure/        写盘、媒体核验与恢复
  packaging/             三个后端的 PyInstaller spec
  .venv/                 本机原设备开发环境（不提交）
```

| 文件 | 责任与调用方 |
| --- | --- |
| `entrypoints/server.py` | 7invensun 正式入口；`electron/platform/python/pythonRuntime.ts` 启动，采集转入 `transport/server_runtime.py`；`--gaze-map-job` 在导入采集/SDK 前处理 |
| `entrypoints/pupil_server.py` | Pupil 正式入口；`pupilLaunch.ts` 以包模块启动，处理参数、父进程管道、后台准备和退出；`--gaze-map-job` 在采集初始化前分派离线映射 |
| `entrypoints/huahong_server.py` | 华弘正式入口；`huahongLaunch.ts` 启动，隔离 Windows 厂商 DLL；离线映射在导入 SDK 前分派 |
| `adapters/invensun_7/sdk_driver.py` | 历史驱动符号的兼容别名，归入所属适配器；`application/sdk_service.py` 导入它，测试验证与 `driver.py` 同一模块身份，不是另一份实现 |
| `analysis/gaze_mapper.py` | 离线 gaze 到静态图像的 SIFT/单应映射；源码分析由 `analysisLaunch.ts` 直接以模块和 `--job` 启动；三个打包入口共用且 spec 均包含，通过 `--gaze-map-job` 分派；离线映射不启动设备、不验证厂商采集环境 |
| `analysis/eye_event_postprocess.py` | 原设备录制 CSV 事件后处理；`application/sdk_service.py` 导入，打包 spec 保留 |
| `requirements/pupil-native.txt` | 默认原生算法环境；包含 UVC、2D/3D 算法依赖，使用 `opencv-python` |
| `requirements/pupil-capture.txt` | 显式 Capture 对照环境；使用 `opencv-python-headless`，不等于 native 环境 |
| `requirements/pupil-build.txt` | 引用 native 依赖并固定 PyInstaller/钩子版本；仅构建使用 |

三种设备入口不是重复实现；厂商采集、进程隔离和依赖不同。不要将入口合并，也不要把 PyInstaller 构建依赖放进原设备运行清单。

### 手动命令迁移

日常启动仍使用 `npm run dev`；Electron 与打包 spec 已使用新路径。若维护了本地脚本，按以下表格修改。所有命令从仓库根执行，并使用对应适配器的 Python 环境。

| 2026-10-16 整理前 | 当前路径或命令 |
| --- | --- |
| `python services/eye_tracking/server.py` | `python services/eye_tracking/entrypoints/server.py` |
| `python -m services.eye_tracking.pupil_server` | `python -m services.eye_tracking.entrypoints.pupil_server` |
| `python -m services.eye_tracking.huahong_server` | `python -m services.eye_tracking.entrypoints.huahong_server` |
| `services/eye_tracking/requirements-pupil-native.txt` | `services/eye_tracking/requirements/pupil-native.txt` |
| `services/eye_tracking/requirements-pupil.txt` | `services/eye_tracking/requirements/pupil-capture.txt` |
| `services/eye_tracking/requirements-pupil-build.txt` | `services/eye_tracking/requirements/pupil-build.txt` |
| `services/eye_tracking/gaze_mapper.py` | `services/eye_tracking/analysis/gaze_mapper.py`；应用仍通过所选设备后端的 `--gaze-map-job` 调用 |
| `services/eye_tracking/eye_event_postprocess.py` | `services/eye_tracking/analysis/eye_event_postprocess.py` |
| 根部 `sdk_driver.py` 的 import | `services.eye_tracking.adapters.invensun_7.sdk_driver`；内部包路径随新布局调整 |

`scripts/install-pupil-native.py` 自动读取新的 native 清单。Capture 的 `adapters/pupil_core/requirements-session.txt` 仍可作为历史安装入口，但只转引新的 Capture 清单。`docs/debug/`、既往构建日志及带日期的历史审计可能保留当时路径；重放命令时使用本节迁移后的路径。

### 应用、领域、传输及基础设施

这些子目录中的源码均属于现有运行链路，不作为缓存清理对象。各级 `__init__.py` 保留包边界。

| 目录 | 子文件与职责 |
| --- | --- |
| `application/` | `sdk_service.py` 管理原设备；`sdk_policies.py` 处理型号/采集策略；`recording.py` 协调旧录制流程；`screen_capture.py` 封装屏幕采集；`pupil_runtime.py`、`huahong_runtime.py` 各自管理独立采集和录制生命周期 |
| `domain/` | `samples.py` 标准样本及来源；`contracts.py` 采集接口；`capabilities.py` 能力声明；`timeline.py` 源时间到视频时间线。禁止在这里导入设备 SDK |
| `transport/` | `protocol.py`、`server_runtime.py` 为旧设备命令/流；`pupil_protocol.py`、`pupil_runtime.py` 为 Pupil 消息及 WebSocket；`huahong_runtime.py` 为华弘 WebSocket。同名 runtime 分属传输与应用层，职责不同 |
| `infrastructure/` | `recording_paths.py` 校验项目写入边界；`pupil_recorder.py` 编码与附档；`pupil_csv.py` 字段映射；`pupil_events.py` 事件归并；`pupil_metrics.py` 统计；`pupil_recovery.py` 中断恢复；`pupil_video_verification.py` 核验视频；`pupil_parent_pipe.py` 管理父进程存活管道。部分组件也被华弘复用，不因 Pupil 前缀而删除 |
| `packaging/` | `mrt-ws-server.spec`、`mrt-pupil-server.spec`、`mrt-huahong-server.spec` 分别构建三个后端；由 `package.json` 和 `scripts/build-*-server.mjs` 引用 |

### 设备适配器 `adapters/`

| 目录 | 子文件与职责 | 保留范围 |
| --- | --- | --- |
| `invensun_7/` | `driver.py` 厂商调用；`sdk_driver.py` 历史符号兼容别名；`paths.py` 查找 SDK；`ctypes_types.py` 类型兼容；`data_normalizer.py` 坐标/有效位转换；`README.md` 接入说明 | 全部源码保留，真正厂商供应物在 `SDK/invensun_7/` |
| `huahong/` | `service.py` ET10C/ET28 生命周期；`data_normalizer.py` 标准化；`requirements.txt` 独立依赖；`README.md` 配置和验收 | 全部保留 |
| `huahong/vendor/et10c_gaze/` | `tracker.py` 追踪调用；`device.py` 枚举；`_loader.py` DLL/符号；`_ctypes_defs.py` ABI；`_constants.py` 枚举/常量；`_progress.py` 校准进度；`errors.py` 错误类型 | 从厂商 sample 精简并适配的生产绑定，不能因 SDK 中另有 sample 而去重 |
| `huahong/vendor/et28_dll.py` | ET28 ctypes 绑定 | 生产 service 依赖；保留 |
| `pupil_core/` | Native/Capture 共用的校准、标准化、质量与验证组件，以及显式 Capture 协议实现 | 默认 native 仍依赖此目录，不能整体删除 |
| `pupil_native/` | 相机、检测器、原生 Gazer3D、事件和子进程管理 | 默认 Pupil 运行链路，全部生产文件保留 |

`pupil_core/` 子文件：

- `calibration.py`：共享校准状态机；`natural_feature.py`、`feature_worker.py`：场景特征追踪及独立进程。
- `data_normalizer.py`：样本归一化；`pupil_quality.py`：检测/3D 模型质量；`validation.py`、`angular_metrics.py`：独立验证、角度统计及评分。
- `service.py`：采集适配器协调；`network.py`：消息类型及 Capture 连接；`frame_receiver.py`：场景帧格式核验。部分类型被 native 直接使用，不是纯历史残留。
- `requirements.txt`：最小协议依赖 `pyzmq/msgpack`，同时被 native 与 Capture 的依赖清单引用。
- `requirements-session.txt`：指向 `../../requirements/pupil-capture.txt` 的小型历史安装兼容入口。当前脚本不直接调用，暂保留，不能与主清单拼接成第二份依赖定义。
- `README.md`：Capture 对照与历史说明；默认 native 的安装/构建以相邻 `pupil_native/README.md` 为准。
- 若出现 `tests/__pycache__/`：这是测试迁移后残留的 bytecode，正式测试在仓库根 `tests/eye_tracking/pupil_core/`，可清理该缓存空壳。

`pupil_native/` 子文件：

- `camera.py`：相机身份及内参；`config.py`：配置；`source.py`：采集适配接口；`worker.py`：相机/拟合子进程入口。
- `process.py`：有界进程通信及退出；`preparation.py`：非阻塞依赖预热；`gazer.py`：原生拟合和预测。
- `geometry.py`：几何计算；`events.py`：注视/眨眼；`saccades.py`：眼跳；`README.md`：安装、构建、验收。
- `vendor/models.py`、`calibrate_3d.py`、`bundle_adjustment.py`、`utils.py`：固定上游数值算法；不能作为下载缓存删除。
- `vendor/camera_intrinsics.json`：运行使用的默认内参；`source-manifest.json`、`dependencies.json`：来源/哈希及固定依赖。
- `vendor/NOTICE.md`、`COPYING`、`COPYING.LESSER`：来源与许可文本；构建脚本复制到发行目录。必须随对应算法保留。

### 开发环境

| 路径 | 当前用途 | 清理边界 |
| --- | --- | --- |
| `eye_tracking/.venv/` | 原设备开发解释器候选，约 366 MiB；表情开发路径复用原 Python 命令选择 | 不是无用副本，自动清理排除 |
| `eye_tracking/adapters/pupil_native/.venv/` | 默认 Pupil 开发/测试/打包环境，约 310 MiB | 自动清理排除；重新安装需要编译和依赖下载 |
| `eye_tracking/adapters/pupil_core/.venv/` | 显式 Capture 对照环境，约 35 MiB | 按需保留；删除后对照启动需重新安装，不列为默认清理项 |
| `eye_tracking/adapters/huahong/.venv/` | Windows 华弘独立环境约定，本次 macOS 未发现该目录 | 启动器引用，今后创建后也不自动清理 |

依据是 `electron/platform/python/{pythonRuntime,pupilLaunch,huahongLaunch}.ts` 的解释器选择和 `scripts/build-pupil-server.mjs`。环境之间的相同包不代表可以直接合并，尤其不可混装两个 OpenCV wheel。

## 3. 表情服务 `facial_analysis/`

| 路径 | 用途 | 处理原则 |
| --- | --- | --- |
| `server.py` | 独立 WebSocket 入口；Electron `createFacialDomain` 启动，接收浏览器上传帧，执行显式视频分析 | 保留 |
| `application/frame_inference.py` | 浏览器实时帧推理 | 保留 |
| `application/service.py` | 模型定位、表情分类、视频分析和历史 CLI | 保留；不能只凭实时路径未调用某函数删除整个文件 |
| `application/process_output.py` | 进程输出解码 | 保留 |
| `application/face_landmarker_v2_with_blendshapes.task` | 实时和离线 MediaPipe 模型包，约 3.59 MiB | 必需资源，保留 |
| `transport/protocol.py` | 命令和端口解析 | 保留 |
| `packaging/facial-ws-server.spec` | 表情服务打包与模型资源清单 | 保留 |

本次移除了旧 `application/camera_session.py`：`server.py` 现只导入 `FrameInferenceSession`，`start_capture` 明确返回浏览器采集提示；运行源码、测试和构建配置无导入或动态加载该模块的路径，该文件也不提供 CLI 入口。旧生成代码图中的引用源于扫描文件自身。浏览器录制与当前推理入口保留，历史版本可通过 Git 恢复。

本次同时移除了独立 `application/face_detection_short_range.tflite` 和 spec 中对应的 `datas` 项。它没有运行加载代码，与主 `.task` 包内部 `face_detector.tflite` 的 SHA-256 均为 `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f`；主 `.task` 包保持不变。

删除后已通过表情录制契约、Python 编译及保留模型的实际 `FrameInferenceSession.start()` 和 64×64 空帧推理。该检查无需摄像头，确认模型仍能加载和处理帧；它不代表 Windows 安装包或有人脸场景的完整验收。首次推理在 macOS 沙箱中因图形服务不可用退出，获得执行许可后在沙箱外通过。

## 4. 构建、发行与历史产物

| 路径 | 本机盘点 | 结论 |
| --- | --- | --- |
| `build/pupil-core/` | 当前 PyInstaller 中间产物，约 22 MiB | 可再生；清理后下次构建重做 |
| `build/pupil-pyinstaller-cache/` | 当前构建器二进制缓存，约 199 MiB | 可再生；删除会增加下次构建时间 |
| `build/pupil-app-experiment/` | 10 月 13 日临时 app 方案中间产物，约 36 MiB | 当前构建/启动脚本无引用，可清理 |
| `build/pupil-app-output/` | 同一实验的两套输出，约 423 MiB | 当前发行使用 `dist/pupil-backend/`，可清理实验输出 |
| `build/pupil-sources/*.tar.gz` | 固定 pye3d、pupil-detectors、pyuvc、libusb、libuvc 源码，合计约 0.63 MiB | 保留；安装和第三方声明收集脚本验证这些包及哈希，不能当普通下载缓存删除 |
| `build/pupil-sources/opencv_python_headless-4.12.0.88-cp37-abi3-macosx_13_0_arm64.whl` | 旧对照 wheel，约 36 MiB | 安装/发行脚本不读取这个本地文件；安装按 requirements 获取对应平台依赖，可清理历史下载副本 |
| `build/pupil-sources/opencv_python_headless-4.13.0.92-cp37-abi3-macosx_13_0_arm64.whl` | 旧对照 wheel，约 44 MiB | 同上；这是下载文件，不是虚拟环境中安装的包 |
| `build/pupil-validation/` | 启动测量、测试、构建日志和历史临时 spec，约 1.2 MiB | 验收证据，默认保留；需要整理时单独归档，不能宣称日志可重新生成相同历史测量 |
| `dist/mrt-pupil-server` | 10 月 13 日旧 macOS 单文件构建，约 83 MiB | 当前 launcher、package.json 和构建脚本使用完整 `pupil-backend/`，此旧产物可清理 |
| `dist/pupil-backend/` | 当前完整 Pupil 后端，约 210 MiB | 保留；macOS 必须保留整包 `.app`，其他系统保留入口、PKG 和 `_internal/` |
| `dist/pupil-third-party/` | 当前后端许可证、对应源码、依赖版本和后端哈希清单，约 2.4 MiB | 与后端一起保留及发布；不能以“重复源码/许可证”为由删减 |
| `dist/ffprobe` 或 `dist/ffprobe.exe` | 录像校验工具 | 开发启动器和发行资源引用，保留 |
| `build/eye-tracking/`、`build/facial-analysis/`、`build/huahong/` | 其他平台/后端构建后出现的中间目录 | 可再生，本次未发现；由对应构建流程管理 |
| `dist/mrt-ws-server.exe`、`facial-ws-server.exe`、`mrt-huahong-server.exe` | Windows 发行入口 | 本次未发现；构建后属于有效发行资源，不按旧 Pupil 单文件规则删除 |

`dist/pupil-third-party/` 下每个依赖目录存放对应库声明；根目录的 `mrt-pupil-source.zip`、五个 `.tar.gz`、`installed-distributions.json`、`installed-versions.txt`、`pupil-backend-sha256.json`、来源清单和许可文本由 `scripts/collect-pupil-notices.py` 与 `scripts/build-pupil-server.mjs` 自动生成。更新算法后应重新生成整套产物，避免源码、版本和二进制不一致。

## 5. 清理方式与验证

优先使用 `scripts/clean-service-artifacts.mjs` 的受限清单，先运行默认 dry-run 查看计划，确认后显式 `--apply`。默认处理上述旧实验输出、旧单文件 Pupil 构建、两个 OpenCV 下载 wheel、源码区 Python 缓存和 `.DS_Store`。`--build-cache` 额外选择可再生构建中间目录及 PyInstaller 缓存。工具不接受任意删除路径；虚拟环境、当前发行包、第三方声明、固定源码包和验收日志始终保留。

```sh
node scripts/clean-service-artifacts.mjs
node scripts/clean-service-artifacts.mjs --apply
node scripts/clean-service-artifacts.mjs --build-cache
node scripts/clean-service-artifacts.mjs --build-cache --apply
```

运行前停止正在进行的 Python 构建或测试；清理结果应列出实际删除项与释放字节。清理后检查 `git diff --check` 和 Git 状态，确认产品源码未被连带删除。若修改了打包资源或旧实现，另外执行对应的表情/眼动契约测试与构建，不能仅靠目录不存在判断完成。

`scripts/clean-python-service-builds.mjs` 是 `prebuild:py-server:win` 的既有专用清理步骤，会删除待重建的发行文件和 `pupil-third-party/`，用途与日常清理不同；不要把它当通用释放磁盘空间命令。其后必须完成全部后端构建再制作安装包。
