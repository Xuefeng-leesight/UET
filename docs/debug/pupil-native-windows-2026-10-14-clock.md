# Windows初始化与相机时间戳修复（2026-10-14）

## 最新日志结论

输入为项目根目录 `mrt-video-debug-2026-10-14.log`（当前内容截至11:53:28），及11:56截图的ID1时间戳错误；不能断言日志与截图来自同一次开启。

- 11:52:51.435启动 `pupil-native-v2-bootstrap`，NumPy加载0.547秒、OpenCV0.094秒、SciPy2.265秒，11:52:54.678全部依赖导入完毕。自后端日志起约3.24秒，早先NumPy管道互锁已不再出现；此区间不含Electron及进程创建时间。
- 首个start请求11:52:53.672到达，尚差约1秒依赖就绪，旧实现立即要求重连。第二次请求直到11:53:11.761才到达，11:53:12.739成功（约0.98秒）。用户感受到的额外等待包含手动重试间隔，不能全归因于算法加载。
- 开启后约60ms发生时间戳错误；后一次同时出现眼相机时间戳异常，随后的管道写入错误发生在关闭期间。

## 时间戳原因和修复

当前Windows运行Python3.12，其[CPython实现](https://github.com/python/cpython/blob/3.12/Python/pytime.c)用GetTickCount64实现monotonic，精度较粗。旧软件接收时间戳直接取monotonic，而眼相机最高120Hz；相邻帧可能取得同一时间值，被严格递增校验拒绝。旧错误没有记录数值，所以不能仅凭这份日志还原每次异常的具体值，但该时钟选择本身不满足高帧率采集需求。

Windows相机接收时间改用perf_counter/QPC（支持的Python3.11–3.13跨进程一致），仍减眼15ms/场景70ms参考延迟。NativeSource.source_time、双眼配对等待及拟合结果时间也使用该时基，避免只改相机造成不同时间原点混用。接收诊断和服务超时仍独立使用monotonic。相机元数据新增实现及分辨率；错误补充source/received/previous/mapped值。保留重复、倒退、无效和过期检查，不使用人为递增或每帧重置偏移。

这仍是软件接收时间及参考延迟估计，不是曝光时间或硬件同步。非Windows的UVC映射、其他厂商采集入口与前端保持不变。

## 开启体验

start在准备期间可异步等待最多4秒，准备完成自动开始连接；连接仍等真实数据后返回成功。同一个WebSocket可以在等待期间发送状态和stop；断开时按原请求身份撤销未完成start，不影响后续新请求。撤销不依赖普通命令队列的剩余容量，队列满时也能取消。取消、超时、依赖失败和断开之后的迟到准备不得启动相机。该等待机制减少手动重试，不等于声明完整USB连接已经在4秒内验收。

新版日志和状态标识 `pupil-native-v3-clock`。Windows更新后需完全退出旧进程再测：首次点击开启、预览持续运行、停止/重开、校准、录制/回放/导出；若再报错，新日志将包含具体时钟值和时钟实现。无需重装依赖。

## 自动化与限制

回归覆盖粗粒度monotonic保持不变时QPC仍产生递增帧时间、源时钟与单眼配对同一原点、严格拒绝重复/倒退/NaN/Inf；准备期间开启、取消、超时、失败和同WebSocket断开清理。真实Windows USB与高帧率运行仍需用户机器复测，macOS或模拟测试不能代替该验收。

最终本机验证（macOS arm64，Python3.13.7）：

- 全量眼动回归155项：153通过、2项按环境跳过；启用 `MRT_REQUIRE_MEDIA_TESTS=1` 和 `MRT_REQUIRE_CONSUMER_TESTS=1`，包含真实媒体录制及消费者验证。日志：`services/build/pupil-validation/windows-clock-regression.log`。
- 打包程序专项3项全部通过：无Python环境的真实拟合、状态/缺相机拒绝/退出、父进程管道关闭退出。日志：`services/build/pupil-validation/windows-clock-frozen.log`。
- 最终构建后首次进程启动测量：命令端口就绪1.214秒、算法依赖全部就绪1.737秒，4秒预算通过。结果：`services/build/pupil-validation/windows-clock-packaged.json`。此值不含Electron启动、真实USB打开和眼模型预热，也不是操作系统重启后的冷缓存测试。
- `npm run release:check`、`git diff --check`通过，`src`无改动。
