# 眼镜启动卡顿现场排查

诊断标识：`diagnosticVersion: 1`。本次只增加观测，不调整解码策略或启动等待。

## 现场操作

1. 用包含本次改动的代码重新构建 Windows 安装包并安装；彻底退出旧应用后启动新版本。开发环境则更新代码后重新启动整个应用。
2. 打开眼镜式设备，保持预览至少 40 秒，覆盖“开始卡顿”和“逐渐恢复”两个阶段。先不录制，不校准。
3. 停止设备，再启动一次，继续预览 40 秒，用于比较首次启动与再次启动。
4. 用现有视频调试日志导出功能导出当天的 `mrt-video-debug-*.log`。记录每次大约卡了多久，以及卡的是场景画面、注视点还是整个窗口。
5. 如有条件，在正常电脑上用同一版本重复步骤，分别注明日志对应哪台电脑。

日志中应出现 `startup:gpu-diagnostics` 和 `webcodecs:preview-created`，否则需确认运行的版本。

后端（眼动服务）埋点走 `eye-server:stdout-line`，依赖 `MRT_DEBUG_TESTING=1` 环境变量才会输出。现场请确认该开关已开启，否则只能看到前端埋点、看不到 `glasses-startup:*`。

## 日志含义

前端（渲染进程）：

- `startup:gpu-diagnostics`：显卡清单、驱动相关属性、Chromium GPU 功能状态、Electron/Chrome 版本。采集失败单独记录错误。
- `webcodecs:webgl-device`：当前画面绘制使用的 WebGL 设备。此信息不等于视频解码设备。
- `preview:connect-request`：连接发起原因、是否已有预览；`device-start-completed` 标识启动成功后的重连。
- `webcodecs:decoder-reconfigure` / `decoder-configured`：尺寸切换、配置耗时、请求的硬解偏好。WebCodecs 不公开实际解码后端，因此不能把支持探测成功当作确认使用 RTX 3060。
- `webcodecs:pipeline-metrics`：每两秒汇总包数量、输出帧数、接收最大间隔、包处理等待、队列峰值、解码提交到输出的最大耗时、关键帧等待。没有新帧时仍然输出。
- `webcodecs:first-render-submitted`：从预览创建到第一帧绘制提交的时间，包含等待设备开始出流的时间。
- `webcodecs:render-metrics`：实际窗口长度、提交帧数、最大提交间隔、Worker 到页面的传递耗时、绘制提交耗时、页面是否在前台。这里测量 CPU 提交，不能证明 GPU 完成时间或显示器实际呈现时间；连续没有帧时需结合 pipeline-metrics 和页面心跳判断。
- `webcodecs:preview-closed`：关闭原因。`previewId` 用于区分重连前后不同预览实例。

后端（眼动服务，`eye-server:stdout-line`）：

- `glasses-startup:start-device-timing`：start_device 三段耗时——`prepare_ms`（DLL 加载/环境准备）、`connect_ms`（设备连接）、`start_ms`（SDK 启动）。定位 SDK 启动慢。
- `glasses-startup:first-scene-frame`：第一个场景帧到达时间，`delay_ms_since_device_start` 为相对 start_device 成功的延迟。首帧越晚，说明眼镜场景摄像头出流越慢。
- `glasses-startup:scene-frame-metrics`：每 2 秒汇总场景帧到达速率 `fps`、`max_gap_ms`（窗口内最大帧间隔）、`total`（累计帧数）、`since_start_s`（相对启动秒数）。启动阶段 fps 低或 max_gap_ms 大 = 眼镜出流不稳定，是“卡一会”的直接证据；随时间 fps 回升 = “逐渐好转”。
- `glasses-startup:h265-init`：后端软件 H265 解码器初始化耗时（首次场景帧到达时触发）。
- `glasses-startup:h265-decode-metrics`：后端 `_7i_h265_decode` 软件解码单帧耗时 `avg_ms`/`max_ms`。若 avg_ms 接近或超过 16.7ms（60fps 帧间隔），软件解码就是瓶颈。

排查思路：

- 前端 `webcodecs:pipeline-metrics` 的 `maxArrivalGapMs` 大，同时后端 `scene-frame-metrics` 的 `max_gap_ms` 也大 → 眼镜场景摄像头本身出流不稳（硬件/连接问题）。
- 后端 `scene-frame-metrics` 的 fps 稳定在 60 附近、`max_gap_ms` 小，但前端 `maxArrivalGapMs` 大 → 网络/WebSocket 传输或前端处理瓶颈。
- 后端 `h265-decode-metrics` 的 `avg_ms` 高 → 后端软件解码 CPU 瓶颈（注意：WebCodecs 预览与后端软件解码可能同时吃 CPU）。
- 前端 `waitForKeyframe=true` 持续一段时间 → 前端解码器在等关键帧，画面冻结属预期，关键帧到达后恢复。

接收间隔异常优先查出流/传输；包处理等待或解码队列增长优先查解码；解码正常但传递/绘制间隔异常优先查页面和显示路径。最大值用于定位短暂停顿，不能单独视为平均延迟。设备时间戳与本机时钟未校准，日志不计算两者相减的“端到端延迟”。

## 本地验证

- `node scripts/check-webcodecs-diagnostics.mjs`
- `npm run check:architecture`
- `npm run build`
- `python -m py_compile services/eye_tracking/application/sdk_service.py services/eye_tracking/sdk_driver.py`

Windows 实机和眼镜设备验证需在现场完成。
