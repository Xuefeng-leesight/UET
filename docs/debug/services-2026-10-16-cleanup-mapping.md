# 服务目录整理与 Pupil 映射检查

检查日期：2026-10-16。原始录制使用 `pupil_719d5a05babf_20261015_155426`。工程原件没有修改，验证产物写入独立的 `pupil-derived/` 目录。

## 服务文件整理

逐目录及子文件的职责、保留依据和清理命令见 [services/README.md](../../services/README.md)。清理前本机目录约 1.7 GiB，Git 跟踪的 113 个文件内容约 4.72 MiB；其余主要为开发环境和构建产物。

已移除的源码/资源：

- `facial_analysis/application/camera_session.py`：629 行旧采集实现，无生产导入、动态加载、测试引用或 CLI 入口。现有摄像头采集由浏览器负责，Python 接收帧并执行推理。
- `facial_analysis/application/face_detection_short_range.tflite`：与保留的 `.task` 模型内部检测器字节一致，没有独立运行加载路径；同步移除表情 spec 中对应资源项。

已通过受限清理脚本删除 26 个历史产物/缓存路径，合计 **843.12 MiB**，本机目录约降至 **931 MiB**。主要是旧 app 打包实验、旧 Pupil 单文件程序、两个试验 OpenCV wheel、PyInstaller 中间目录和缓存，以及源码区 bytecode。脚本默认只预览，`--apply` 才执行；`--build-cache` 明确选择可再生构建缓存。清单拒绝 Git 跟踪文件和重定向路径，不遍历符号链接。

保留三套现有 Python 环境、全部设备适配器、当前完整 Pupil 后端、ffprobe、主表情模型、第三方许可证、固定源码归档和历史验收日志。删除迁移后只剩缓存的旧测试目录空壳，正式测试仍位于根 `tests/`。本机占用会随后续测试和构建变化，数字不是发行包体积。

## 映射入口的确定缺陷

开发版 Electron 原来只从 Python 命令中识别 `eye_tracking/server.py`，而 Pupil 使用 `python -m services.eye_tracking.pupil_server`，导致映射进程在启动前被拒绝。打包版则缺少 `--gaze-map-job` 分派，会进入设备服务而无法完成离线任务。

现在保留解释器/模块前缀、移除采集参数，并在 Pupil 导入采集运行时之前分派到共用 `gaze_mapper.py`；打包显式包含映射模块。离线映射只依赖 OpenCV/NumPy，不打开相机、不校准、不启动 WebSocket。错误返回结构化消息，沿用现有前端提示链。

运行命令会随当前选择的设备改变，因此同时为华弘增加等价的前置分派；华弘独立依赖清单补入固定的 headless OpenCV，构建预检 SIFT。已有华弘开发环境需要更新该专属 requirements，不能混装两种 OpenCV wheel。源入口已验证不导入华弘 DLL/采集模块，Windows 华弘冻结包仍须在目标平台构建验收。

## 原数据与显示核对

- 最新视频为 H264、1280×720、30 fps、29.2 秒。
- 原 CSV、事件索引和生产解析器均能提供 83 个有效的二维 fixation；没有把 native 毫米 3D 坐标当屏幕归一化坐标读取。
- 使用视频首帧作为参考图，经修复后的真实 Pupil 模块运行 SIFT 映射：输入 83 点，得到 62 点，50 个关键帧中 47 个直接匹配、3 个继承前一矩阵。这个结果是链路可用性验证，不是映射准确度验收。
- 62 点的匹配置信度范围为 0.1908–0.7311；旧页面默认 80% 筛选使 **0 点可见**，因此“映射完成 62 点”也可能呈现空白轨迹。
- 历史映射列表为了减少传输量，仅返回摘要及空的 `gazeData`；映射页面此前直接把摘要当作完整结果，遗漏调用已有的 `load-gaze-mapping-record`。这会使历史记录有视频而没有映射点，列表导出也会输出空轨迹。现已在打开/导出时先取得完整结果，丢弃切换记录、切换工程或卸载后迟到的响应；无法找到来源视频时清除上一条视频。
- 实际 Chrome 检查中，原视频的注视圈能够显示，容器尺寸和二维定位正常。当前这份录制没有复现“原视频叠点完全消失”，不能把离线入口缺陷当作所有叠点问题的解释。

真实验证产物位于 `pupil-derived/20261016-mapping-entry-4352lchv/`；输入 CSV/MP4 的 SHA-256 前后不变。参考图和映射结果没有写回录制工程。

显示筛选现在默认 0%，保留原有手动滑块，不改变 SIFT 的匹配门槛或已保存置信度。当前 62/62 个结果默认可见；主动设为 80% 时显示 0/62 及全部隐藏的原因。页面沿用现有布局，在已有说明位置显示加载/失败消息及可见数量。

## 验证与限制

已完成：清理脚本的预览/保护/幂等测试、表情录制契约、主 `.task` 模型真实初始化及空帧推理、映射开发入口和冻结入口测试。最终眼动套件 181 项中 180 项通过，1 项因没有华弘 Windows 冻结包而跳过；实际 Pupil 冻结测试通过。`npm run release:check`、代码图重新生成及源码路径验证、`git diff --check` 均通过。本机 macOS 重建 Pupil 包后首次算法就绪 1.338 秒，通过 2 秒预算。

前端专项 `node tests/mapping/check_mapping_display.mjs` 覆盖摘要加载、实际点导出、迟到结果、二维/毫米边界、时间单位及中英文筛选提示。附加本地映射 JSON 参数验证本次真实 62 点默认全部可见、80% 全隐藏；原实验数据不进入提交测试夹具。

浏览器实测只完成原视频注视圈显示；后续历史记录交互验证期间测试标签被用户关闭，随即停止浏览器操作。历史加载、导出和筛选以生产回调、纯逻辑及 JSX 渲染测试为证据，不记作完整浏览器端到端验收。

Windows 安装包、真实摄像头及用户现场环境未在本机验收。SIFT 置信度用于匹配筛选，不等于校准角度误差评分，也不代表某个点有对应百分比的准确概率。剩余未映射点不能通过补零或复制相邻结果伪造。

构建、清理及回归日志保存在 `services/build/pupil-validation/` 的 `mapping-*`、`services-mapping-*` 和 `services-cleanup-applied.log`，不纳入 Git。

## 同日追加：眼动根目录文件归类

根据目录截图继续将根部散落文件实际迁移，`services/eye_tracking/` 仅保留 `__init__.py` 包标记及子目录：

- `entrypoints/`：`server.py`、`pupil_server.py`、`huahong_server.py`。
- `analysis/`：`gaze_mapper.py`、`eye_event_postprocess.py`。
- `requirements/`：`pupil-native.txt`、`pupil-capture.txt`、`pupil-build.txt`。
- `adapters/invensun_7/sdk_driver.py`：驱动兼容别名归入所属设备适配器。

Electron、Pupil 子进程、启动基准工具、3 份打包 spec、依赖递归引用、安装脚本、CI、代码图配置及当前使用文档已同步。原设备工作目录与 `.venv` 查找仍使用 `eye_tracking/`，不会误查 `entrypoints/.venv`；表情服务继承 Python 启动参数时保留 Windows `py -3` 前缀。源代码旧命令迁移表见 [服务目录说明](../../services/README.md)，根部没有重复转发脚本。

目录迁移后的完整眼动回归 **184 项：183 通过、1 项华弘 Windows 冻结包测试跳过**；其中新构建的 Pupil 冻结映射、实际子进程及退出验证通过。原设备入口从仓库外 `/private/tmp` 执行 `--help` 正常。依赖目录递归检查、映射与表情启动参数、映射展示、产品契约、`npm run release:check`、代码图与源码路径校验均通过。

新布局重建的 macOS Pupil 包第一次启动至算法就绪 **1.721 秒**（命令服务 1.217 秒），通过 2 秒预算；仅代表本机这次构建，不能替代 Windows 实机结果。日志保存在 `services/build/pupil-validation/layout-*.log` 和 `layout-first-after-build.json`。
