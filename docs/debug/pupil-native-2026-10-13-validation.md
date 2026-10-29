# Pupil 原生后端本机验证（2026-10-13）

## 结论与范围

已实现并接入默认原生后端：本软件管理 Pupil Core 三个 USB 相机、2D 瞳孔检测、pye3d、Gazer3D 校准/注视映射和录制。默认路径不启动 Capture，也不使用 Capture Remote API。显式 `MRT_PUPIL_BACKEND=capture` 保留为诊断对照。共享校准入口与前端界面未改，`git diff -- src` 为空。

本记录证明本机代码、算法接口、协议、文件及打包链路；**不代表目标 Windows 安装、真机运行或科学精度验收通过**。本机 `uvc.device_list()` 返回空列表，没有可用于验收的 Pupil 相机。

## 环境与产物

- macOS arm64、Python 3.13.7；原生独立 `.venv`，不修改旧厂商环境。
- pupil-detectors 2.0.2、pupil-labs-uvc 1.0.7、pye3d `0.3.2+mrt.eb50e384ce13`；pye3d 从固定 LGPL 源码构建。
- PyInstaller 6.22.3、hooks-contrib 2026.7；实际全量版本记录在 `services/dist/pupil-third-party/installed-versions.txt`。
- 后端：macOS 为 `services/dist/pupil-backend/PupilBackend.app`，入口 `Contents/MacOS/mrt-pupil-server`；Electron 复制完整目录到 `py/pupil-backend/`。Windows/Linux 保持入口及 `_internal/`，Windows 必须在目标平台构建 `.exe`。
- 来源与许可证：`services/dist/pupil-third-party/`，含哈希校验过的原始算法/USB 库源码、版权文本、修改后的 MRT 后端源码及重建脚本。归档按构建替换，避免残留旧版本许可证。
- 测试与构建日志位于忽略目录 `services/build/pupil-validation/`，不提交生成文件、虚拟环境或测试录制。

## 已执行验证

| 验证 | 结果与边界 |
| --- | --- |
| `python -m unittest discover -s tests/eye_tracking -t . -v`，开启媒体/消费者必测开关 | 144 项：142 通过、2 项冻结程序测试按环境跳过；冻结程序另行执行 |
| 真正的 Detector2D 与 pye3d 接口 | 使用受控帧和替代 USB 输入，执行真实检测器；不能证明硬件图像质量 |
| 上游 Gazer3D 数值拟合 | 合成三维观测输入执行真实优化与双眼/单眼映射；不能解释为实测精度 |
| 生命周期 | 后台依赖准备不打开相机、不阻塞状态/停止命令，失败/超时/退出释放；采集启动取消、失败释放、迟到进程关闭、溢出、断连、拟合取消/超时及迟到结果隔离 |
| 录制/导出 | 真实编码、CSV/事件落盘、历史记录重建；通过实际 TypeScript 解析器及 IPC 导出处理器核对结果 |
| 冻结程序 3 项专项 | 原生数值拟合；默认原生状态、缺相机明确失败及退出；显式 Capture 测试服务、场景追踪子进程与父管道退出，均通过 |
| 冻结原生库路径审计 | 检查292个 `.so` / `.dylib`，未发现指向系统目录以外的绝对依赖路径；不替代干净机器验证 |
| `npm run release:check` | 仓库卫生、架构、全量类型检查、Python 编译、表情契约及生产构建通过 |
| `node tests/eye_tracking/pupil_core/check_product_contracts.mjs` | 设备隔离、共享校准异步结果、旧设备流程、实际采样率、原生/对照启动与完整目录资源契约通过 |
| `git diff --check` / `git diff -- src` | 无空白错误 / 无前端文件变化 |

冻结程序命令和环境准备见 [原生后端说明](../../services/eye_tracking/adapters/pupil_native/README.md)。

## 导出数据确认

现有表头保留；补齐可提供的瞳孔像素中心/直径/短轴、模型毫米直径、深度估计、独立单眼/推荐注视、3D 点与射线、注视/眨眼/扫视事件及速度。二维回放始终采用归一化场景坐标，不使用毫米 3D 点代替屏幕坐标；像素瞳孔值不能填充毫米列。

扫视幅度只用有效的前后相邻注视计算，缺少任一侧留空；端点位移独立保留。持续过长的高速运动整体舍弃，不能将后半段伪装为短扫视。眨眼按眼及检测会话配对，不能跨断流拼接。无效数据和跨时间缺口不计算速度。

眼睑、陀螺仪、物理短轴、厂商专用位掩码、独立平滑结果等没有可靠来源的字段保留空值。完整表头映射、坐标、单位和估计限制见 [原生方案](../方案/PupilCore原生后端方案.md)。

## 启动性能优化（2–4秒目标）

目录式打包实验中，同一产物的冻结拟合首次运行约105.7秒，重复运行约0.47秒。加入后台依赖准备后的最终产物，三项专项合计131.0秒：含首次准备的原生状态/缺相机/退出用例129.6秒，准备后的真实拟合0.44秒，Capture兼容/退出用例1.01秒。缺相机用例明确核对“相机数量为0”，不接受加载超时冒充缺设备结果。

上述为优化前历史结果，日志 `services/build/pupil-validation/packaged-final.log`。进一步独立测量旧目录式产物的准备子进程共117.93秒，其中OpenCV52.63秒、SciPy34.19秒；进程采样主要停留在macOS动态库加载/校验，日志 `startup-baseline.json`。这不是完整服务启动时间，不能直接与新服务计时作同口径比较。

macOS 改为包含全部动态库的标准 `PupilBackend.app` 应用包，使用 PyInstaller 签名流程和后台应用标记；Windows/Linux 维持完整目录。Electron 按平台定位入口，前端不变。默认临时签名，支持发行签名身份环境变量；本机 `codesign --verify --deep --strict` 通过。全部算法依赖保留，未把耗时转移到首次拟合或设备连接。

正式产物重建完成后，先执行完整服务计时，再运行其他冻结程序测试：

| 场景 | 进程启动到全部算法就绪 | 4秒预算 |
| --- | ---: | --- |
| 重建后首次运行 | 3.0246秒（命令端口可用2.5030秒） | 通过 |
| 同产物重复1 | 0.5501秒 | 通过 |
| 同产物重复2 | 0.5417秒 | 通过 |

报告位于 `services/build/pupil-validation/startup-service-first.json`、`startup-service-repeat1.json`、`startup-service-repeat2.json`；包含各库加载诊断。后续冻结程序3项测试全部通过，合计1.704秒，见 `startup-packaged-tests.log`。

补齐自动校验清单后再次重建，最终产物首次进程启动2.8594秒（`startup-service-final-first.json`）。完整732项文件/符号链接清单校验及应用包严格签名校验通过。入口SHA-256为 `97716afc8c9d19bcce5d672de8eead13be55b446676e03f5bdb8e9d0454e092f`，仅标识本次入口，不能替代完整包清单。完整回归重新执行144项：142通过、2项冻结测试按环境跳过；`release:check` 与产品契约检查通过，日志 `startup-regression.log`、`startup-release-check.log`。

新工具 `tools.pupil.benchmark_startup` 从进程创建开始计时，读取真实服务状态，确认默认原生后端、全部依赖就绪且采集未开启，然后经父管道正常退出；端口开放不算就绪。失败、超预算或异常退出返回非零。CI macOS/Windows 已配置在其他冻结程序测试前执行4秒门禁并归档报告；本次未运行远程CI。

**以上证明当前开发机重建后的首次进程启动达标，不证明干净机器的首次安装达标。** 本机先前加载过旧版本，系统可能缓存相同二进制/签名；不以重复运行冒充冷启动。仍需正式签名发行包在干净macOS和Windows运行相同基准。计时不含Electron界面、相机首帧、眼模型稳定及真实校准。

后台依赖准备保留180秒异常清理上限，性能预算独立为4秒。准备期间命令可响应，连接明确提示初始化；不枚举或打开相机。准备完成后相机连接进入独立20秒限时。原生拟合等待上限120秒，工作在可终止子进程执行，取消仍可发起。

## 未完成的目标环境验收

尚需目标环境：Windows 驱动与安装包；真实三相机预览、共享校准和独立验证；完整录制/回放/导出；拔插、重连、长采集吞吐；默认/个体内参对精度与延迟的影响。macOS 正式签名与干净机器首次启动，以及所有随包原生库和 FFmpeg/ffprobe 的分发依赖也属于发行验收。本机使用的 Homebrew ffprobe 不能被视为已经验证的可移植发行资产。

运行必须携带整个应用包；构建脚本自动生成文件SHA-256和符号链接清单，归档于 `services/dist/pupil-third-party/pupil-backend-sha256.json`，后续构建会更新，不沿用旧目录式产物的入口哈希。
