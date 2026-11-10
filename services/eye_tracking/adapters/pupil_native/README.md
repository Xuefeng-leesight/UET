# Pupil Core 内置采集后端

MRT 默认直接使用 USB 相机和本地检测/映射算法，不连接 Pupil Capture Remote API，不需要打开 Capture。入口仍为 `services.eye_tracking.entrypoints.pupil_server`；Electron 随设备启停管理该进程。前端录制、共享卡片校准和独立验证入口保持原样。

## 运行方式

开发环境使用独立 Python 3.11–3.13 环境，不能与旧厂商 SDK 或 `opencv-python-headless` 环境混装。

```sh
python3 -m venv services/eye_tracking/adapters/pupil_native/.venv
services/eye_tracking/adapters/pupil_native/.venv/bin/python scripts/install-pupil-native.py
```

Windows 对应解释器为 `.venv/Scripts/python.exe`。安装包内置解释器及算法依赖，正常运行不需要用户安装 Python。开发/构建解释器可由 `MRT_PUPIL_PYTHON_BIN` 指定。视频编码仍使用项目现有 FFmpeg，Windows 打包默认使用项目内 `SDK/Tool/ffmpeg/bin/ffprobe.exe`，可直接执行 `npm run dist:win`；其他平台或自定义位置通过 `MRT_FFPROBE_PATH` 指定目标平台 ffprobe 的绝对路径（优先于默认路径）。

构建机需要 C++ 工具链和 Eigen3（macOS 可使用 `brew install eigen`；Windows 使用 Visual Studio 2022 C++ 与 `vcpkg install eigen3:x64-windows`，将其安装目录加入 `CMAKE_PREFIX_PATH`）。安装脚本从 `vendor/dependencies.json` 的固定地址下载、校验 SHA-256、编译 LGPL 版本 pye3d，源码归档保留在 `services/build/pupil-sources` 并随构建交付。不要直接使用 PyPI `pye3d==0.3.2`：该发布包的许可证文件是 All Rights Reserved，与后续官方 LGPL 源码不一致。

硬件识别要求唯一的 ID0（右眼）、ID1（左眼）、ID2（场景）相机；不把普通摄像头猜测成眼动仪。支持识别 Pupil Cam1/2/3，默认内参实际覆盖 Cam1 场景和 Cam1/2/3 眼相机；无已知内参的型号会拒绝启动。多套设备连接时，可同时设置 `MRT_PUPIL_RIGHT_UID`、`MRT_PUPIL_LEFT_UID`、`MRT_PUPIL_WORLD_UID`。UID 只用于选择设备，不代表身份或内参已经校准。

默认场景 1280×720、30Hz；Cam1 眼相机 320×240，Cam2/3 眼相机 192×192，眼采样不高于120Hz。实际帧率从相机支持列表选择并归档。默认内参来自固定版本官方表，属于型号默认值；个体实测内参可通过 `MRT_PUPIL_INTRINSICS` 指向 JSON 提供，结构为相机名称 → 分辨率字符串（如 `"(1280, 720)"`）→ `camera_matrix`、`dist_coefs`、`cam_type`（radial/fisheye）。

Windows USB 访问需要正确的 libUSBk 驱动，参见 [官方 pyuvc 安装说明](https://github.com/pupil-labs/pyuvc/blob/master/WINDOWS_USER.md)。本变更没有自动替换 USB 驱动；应由部署人员核对目标设备后安装，不能选择其他 USB 设备。macOS 也需核对相机访问权限及当前 libusb 支持情况。**无需 Capture，不等于无需操作系统驱动。**

开发诊断回退：显式设置 `MRT_PUPIL_BACKEND=capture`，按 [旧 Capture 后端说明](../pupil_core/README.md)运行。不会自动回退，不会自动启动外部 Capture，也不复用历史校准凭据。

## 资源与校准边界

每个相机由一个子进程持有；2D 检测、pye3d 模型更新在对应眼相机进程执行。三维拟合使用另外的可取消子进程。父子通过有长度上限的 msgpack 管道交换数据，标准输出只承载协议；EOF、超时、断连、队列溢出均有释放或明确失败路径。

停止时先关闭父控制输入，输出读取线程持续排空并丢弃迟到帧，直到子进程释放相机、关闭输出；超时仍按既有上限终止子进程。不能在设置 `closed` 后提前关闭相机输出管道，否则 Windows 正常停止也会触发 `OSError: [Errno 22] Invalid argument`。2026-10-14 日志中的该错误出现在录制成功收尾及停止设备命令之后；真实管道回归已复现旧竞态并验证新退出顺序，Windows 相机释放仍须复测。

后端启动后先用独立子进程加载算法依赖，不枚举或打开相机。启动性能目标及CI预算为2秒；180秒仅为异常环境下的清理上限，不是验收标准。开启请求到达时若正在准备，最多异步等待4秒，准备完成后自动进入相机连接；只有真实首帧及眼数据到达才返回开启成功。等待期间同一命令连接可查询状态或停止；连接关闭会撤销该连接尚未完成的开启请求，迟到准备不得恢复。相机连接另有20秒上限，等待超时或依赖错误明确返回。退出会终止准备子进程。状态附加 `algorithm_ready` / `algorithm_error`，各库加载耗时写入诊断日志，不改变现有前端界面。

`start` 等待真实双眼数据及场景帧，期间可以停止。状态查询不打开相机。校准继续走共享三/五/九点实体卡片流程，训练前检查质量、时间配对和目标分布；实际拟合结果匹配当前请求，并且恢复了源时间晚于拟合结果的场景帧，才生成本会话凭据。取消、超时、断连使结果失效，迟到子进程不能恢复凭据。独立验证不重新拟合。

非 Windows 将 UVC 单调时钟映射到主机；Windows 使用跨进程一致的 `perf_counter()` / QPC接收时间减去官方参考延迟估计（眼15ms、场景70ms），避开Python 3.11/3.12粗粒度monotonic导致相邻帧重时。NativeSource源时钟、拟合结果时间及单眼等待配对采用相同时基；服务超时和接收诊断保留主机monotonic，两种时基不得混用。时钟实现/精度归档到相机元数据，重复、倒退和过期值仍拒绝。该估计不是硬件同步或实测延迟。双眼按25ms窗口一一配对，50ms后未配对样本按单眼映射，不反复复用同一个瞳孔样本。

## 数据与验收

`pupil-native-v4-quality` 将单眼预测保持在该单眼模型拟合的深度尺度（当前500mm），不再套用双眼三角化的深度。单眼仍是模型估计，不能视为独立距离测量。实时协议在现有字段中提供实际单眼注视和瞳孔中心；没有有效测量时保留空值，不复制融合点充当单眼数据。

校准完成的左右眼数值是训练平均重投影误差（源图像像素，越小越好），不是厂商得分、置信度或独立精度。只有本次拟合结果匹配且新场景帧恢复后才返回；完整训练统计写入校准附档。原有0.15归一化均值拒绝门限现在也检查左右眼，不能只检查融合点。此门限只拦截明显退化，不是科学精度验收标准。实际精度仍需共享“校准测试”的独立目标采样。

只读历史复算：`python -m tools.pupil.audit_native_calibration <calibration.msgpack> --output <新报告.json>`。该工具固定已存姿态与相同输入对，只比较深度政策，不修改或重新拟合原始实验数据。

输出仍为 MP4、CSV、meta.json 和 `.pupil` 原始/标准化消息、校准及诊断附档。完整字段含义及空值原因见 [方案与导出字段说明](../../../../docs/方案/PupilCore原生后端方案.md)。模型毫米值与3D深度均为估计，不能当作独立物理测量；事件阈值和算法版本随记录归档。

```sh
# 从仓库根目录执行；-t . 保证测试子进程使用完整包路径。
services/eye_tracking/adapters/pupil_native/.venv/bin/python -m unittest discover -s tests/eye_tracking -t . -v
npm run release:check
# Windows 默认使用 SDK/Tool/ffmpeg/bin/ffprobe.exe；其他平台或自定义位置设置 MRT_FFPROBE_PATH 绝对路径
npm run build:pupil-server
```

构建前在 native 环境安装 `services/eye_tracking/requirements/pupil-build.txt`。Windows/Linux 输出 `services/dist/pupil-backend/mrt-pupil-server[.exe]` 和 `_internal/`；macOS 输出标准应用包 `services/dist/pupil-backend/PupilBackend.app`，入口为其 `Contents/MacOS/mrt-pupil-server`，不显示额外界面。macOS 构建默认采用临时签名，可通过 `MRT_PUPIL_CODESIGN_IDENTITY` 指定发行签名身份，公证和干净机器验收仍须单独完成。Electron 安装包完整复制 `pupil-backend/`，不能只取其中的可执行文件；固定目录避免每次启动重新解包算法库。

`services/dist/pupil-third-party/` 包含许可证、来源、实际依赖版本、MRT 后端对应源码/重建脚本及自动生成的 `pupil-backend-sha256.json` 文件/符号链接清单。必须在目标系统构建；macOS 的构建结果不能替代 Windows 安装包验收。对外分发前需核对所有内嵌库及其二进制依赖的许可证和对应源码交付，不能只凭包元数据判断。

`pupil-native-v7-score` 在现有校准完成/测试完成提示中显示角度误差及自定义 1–10 分，保留像素数据。用户确认的公式为 `clamp(10−2×pupilCoreAccuracyDeg,1,10)`，保留一位小数，越高越好；不是厂商评分，不判定精度达标。训练和独立验证分开记录，官方公式对照同时记录 5° 排除阈值与样本数量，角度缺失或全部剔除时不给分。独立验证复用共享卡片测试，采样三个与训练不同的分散位置；结果随后续录制附档保存。计算口径、评分政策、配对差异及验收见[角度误差与独立验证](../../../../docs/debug/pupil-native-2026-10-16-angular-validation.md)。

在构建后首次运行任何冻结程序测试**之前**执行启动验收（Windows 替换解释器及可执行文件路径）：

```sh
services/eye_tracking/adapters/pupil_native/.venv/bin/python -m tools.pupil.benchmark_startup \
  services/dist/pupil-backend/PupilBackend.app/Contents/MacOS/mrt-pupil-server \
  --label first-after-build --budget 2 --output services/build/pupil-validation/startup-service-first.json
```

计时覆盖进程创建、服务端口及全部算法依赖就绪，以 `algorithm_ready=true` 为终点；仅端口可连不算通过。失败、超过2秒或退出异常返回非零。重复测量必须用 `--label repeat`，`--mode worker` 仅供依赖诊断。CI 已加入 macOS/Windows 预算检查及报告归档；CI 构建机和本机都可能已有系统缓存，正式首次安装验收须使用干净目标系统，不能把重复结果称为冷启动。旧版本机重建后首次全流程为3.02秒，重复为0.55/0.54秒，详见[验证记录](../../../../docs/debug/pupil-native-2026-10-13-validation.md)。这不包含相机首帧或眼模型稳定时间。

冻结程序专项验证：将 `MRT_PUPIL_EXECUTABLE` 设为上述可执行文件的绝对路径，运行 `python -m unittest tests.eye_tracking.pupil_core.test_native_boundaries.NativeBoundaryTests.test_packaged_native_fit_without_python_environment tests.eye_tracking.pupil_core.test_native_export.NativeExportTests.test_packaged_native_status_missing_camera_and_shutdown tests.eye_tracking.pupil_core.test_runtime.ProductionRuntimeTests.test_production_entrypoint_parent_pipe_shutdown -v`。分别验证真实数值拟合、默认原生状态/缺相机拒绝、显式 Capture 诊断与父进程退出；不要求外部 Python 或 Capture 参与冻结程序执行。

真机验收仍须在 Capture 关闭时完成：相机预览 → 共享校准 → 三点独立验证 → 录制 → 回放/分析/导出 → 取消与拔插重连 → 长时间采集。无硬件时的自动化不能证明精度、有效率、持续吞吐或 Windows 驱动兼容。

Windows若长时间显示初始化、且停止后才出现NumPy加载完成日志，参见[Windows初始化排查](../../../../docs/debug/pupil-native-windows-2026-10-13-initialization.md)。父管道监测使用Windows原生读取，避免标准输入阻塞与DLL加载互锁。源码启动基准可传入专用Python路径并添加 `--source`；服务/worker两种模式都保持父管道打开直至算法就绪，复测以2秒预算验收。

当前 `pupil-native-v5-startup` 使用独立PKG归档与精简启动包，交付必须包含 `mrt-pupil-server.pkg`。最新首次启动测量仍有1.72–2.94秒波动，尚未稳定达到2秒；分段数据与Windows原始日志区分见[启动优化记录](../../../../docs/debug/pupil-native-2026-10-14-startup.md)。
