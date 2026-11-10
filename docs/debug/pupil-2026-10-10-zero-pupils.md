# Pupil 校准首点始终失败：瞳孔样本为零（2026-10-10）

本次输入为最新 `mrt-video-debug-2026-10-10.log`，覆盖北京时间 09:28:42–09:29:55。原始 debug 不纳入 Git。

## 日志已确认的失败位置

运行后端为 feature-pipe-v3 源码。09:29:04 启动校准，追踪子进程约 0.65 秒就绪，OpenCV 4.13.0 / numpy 2.5.3；首点初始化最多 31 ms。十次尝试都停在 index=1，每次 refs=30–31、pupils=0、accepted=False。场景预览与主线程心跳继续更新，没有进入 Gazer3D 拟合阶段。

因此本次失败是双眼瞳孔数据未能进入参考帧的采样窗口，不能归因于卡片识别、子进程启动超时或拟合拒绝。旧日志没有接收 topic、筛选原因、置信度和源时间差，不能断言真机一定关闭了检测，或一定发生了积压。

## 已复现并修正的接收问题

旧 receive 每个通道每轮仅取一条；同一数据通道包含两眼 2D、3D 及 gaze，吞吐量远高于场景帧。消费有每轮处理耗时时，场景帧继续更新，而瞳孔 FIFO 积压，随后被 `timestamp <= 参考帧起点` 丢弃。

使用真实回环 ZeroMQ，模拟场景 30 Hz、双眼混合数据 120 Hz、每轮消费增加 15 ms 的相同场景：替换为旧 HEAD 的 receive 后，采样接收到的 41 个瞳孔包全部早于参考窗口，source_offset_s 约 -0.435 至 -0.341 秒，双眼配对都为零；新版同一测试通过。此复现证明旧逻辑具有该缺陷，不证明 Windows 当次故障只能由它造成。

改为有界非阻塞批次：每轮数据最多 64 条、校准通知及事件各最多 16 条、视频仍最多 1 条。保留收到的所有数据，避免无限 drain 阻塞视频或取消命令，不更改源时间、不放宽匹配窗口、不把 2D 数据作为 3D 拟合输入。

## 检测启动与诊断

校准 start 在本软件内发送一次 `pupil_detector.set_enabled`，value=true，启用两眼已加载的检测器，包括 Pye3D 所需的 2D 输入。它不会安装或加载缺失的插件、重置眼球模型或更改 ROI。开启设备、状态查询、取消和停止不发送这一控制；通知超时/拒绝后不保留运行中的校准状态。ACK 仍只表示送达。

接口依据：[官方 Network API 的 Pupil Detector Plugin Notifications](https://docs.pupil-labs.com/core/developer/network-api/#pupil-detector-plugin-notifications)；Pye3D 依赖 2D 输入见 [官方 Pye3DPlugin](https://github.com/pupil-labs/pupil/blob/master/pupil_src/shared_modules/pupil_detector_plugins/pye3d_plugin.py)。

每次点采样新增 `pupil_diagnostics`，同时写入后端 stderr 和前端 calibration:command-response：

- topics：两眼 2D/3D 收包数量，未知标识合并为 pupil.other，避免键无限增长。
- rejected：非法时间、参考起点之前的数据、非 3D、低置信度、缺少 3D 模型、非法眼号。
- eligible_by_eye / paired_by_eye：筛选前后双眼数量；右眼是 id=0，左眼是 id=1。
- confidence_range / source_offset_s：观测置信度范围、相对初始参考帧的源时间差。
- reference_window_s / outside_reference_window：实际追踪参考帧覆盖区间、最终配对剔除数量。

错误提示明确区分未收到瞳孔、只有 2D、数据落后、置信度不足、模型未就绪和时间不匹配，并显示双眼计数。成功仍要求参考帧至少 10、每眼有效 3D 至少 10；失败保持当前点，不生成凭据，不变绿。

新版后端标记为 `pupil-data-v4`，追踪执行仍为 pipe-v3。get_device_status 新增 received_by_topic；先确认 debug 的实际后端标记再对比。Windows 源码运行拉取后重启应用及后端；安装版需要重建 Pupil 后端。此修改不增加 Python 依赖。

## 验证与剩余限制

眼动完整 102 项回归通过，含检测关闭后由本软件启用、混合 2D/3D、实际回环高频采样、失败原因、取消/超时、录制和设备隔离。生产契约、架构、Python 编译、TypeScript 类型检查和应用构建通过。继续保持共享 ASeeGlass 卡片识别、采样按钮和校准界面；7invensun/华弘适配器未修改。

Windows 真机校准与独立精度仍需复测。若仍失败，新诊断可以判断到底未发布 3D、数据过期还是眼模型质量问题；不能将模拟采样通过或 Capture 拟合成功当作独立精度验收。
