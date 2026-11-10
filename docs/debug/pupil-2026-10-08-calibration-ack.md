# Pupil 校准通知回执兼容问题（2026-10-08）

## 实机证据与原因

Windows Capture 3.5.1 已有场景视频和双眼视频。点击本软件校准，提示 `Capture rejected marker calibration setup: Message forwarded.`。

Pupil Remote 多帧通知正常转发后返回 `Message forwarded.`。旧文档使用 `Notification received`；适配器原来只接受后者，导致在发送校准开始命令之前误判失败。官方实现见 [pupil_remote_controller.py](https://github.com/pupil-labs/pupil/blob/master/pupil_src/shared_modules/network_api/controller/pupil_remote_controller.py)。

## 修复与边界

仅 Pupil 适配器兼容上述两种精确回执，其他回执仍报错。回执只代表通知已转发，不代表插件启动成功或校准成功。保留 started、successful 和 result.v2 的结果校验、超时、取消及连接内授权规则；不修改 7invensun 或华弘校准协议。

真实 REP/PUB 模拟覆盖新旧回执、未知与空回执；端到端校准测试默认使用实机回执，仍须等待实际结果才能授权采集。自动化不能替代 Windows 真机验收。

## 原圆环方案复测记录（历史，已改为实体卡片流程）

1. 更新代码，完全退出并重新启动本软件，保持 Pupil Capture 后台运行。
2. 在本软件点击校准，使用共享校准界面中的圆环。该模式为 Single Marker / Physical Marker，由场景相机识别圆环参考位置；不要求切换到 Capture 操作。
3. 注视圆环中心，缓慢移动头部，使整个圆环持续留在场景画面内；不要同时摆放第二个校准标记。按照界面提示采样并点击结束采样。
4. 等待实际校准结果。若超时或失败，保留本轮 debug 数据及 Capture 日志，确认是否收到了 started、successful、result.v2，不能用通知回执判定成功。

屏幕圆环与手持卡片都是标记载体；当前本软件使用屏幕圆环，复用原 7invensun 校准页面。实机仍需验证识别范围、采样质量和最终 gaze 质量。

后续用户要求已将校准改为 ASeeGlass 实体卡片流程，当前复测步骤见 [适配器说明](../../services/eye_tracking/adapters/pupil_core/README.md)。两种通知回执仍兼容，但通知内容变为 Gazer3D 拟合提交。
