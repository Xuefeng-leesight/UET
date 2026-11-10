# Pupil Windows 启动失败：未收到 World 视频

诊断编号：PUPIL-20261008-01。状态：已整理证据，根因待现场验证。

## 原始数据

- 输入：仓库根目录 `mrt-video-debug-2026-10-08.log`，原件未修改，共 183 条 JSON 日志。
- SHA-256：`f89aee0da8e18a6bc7bed1199c325b172ccb45b763ce29ebb2e7d6a8687f8699`。
- 日志覆盖北京时间 2026-10-08 11:02:04.589—11:04:13.091；截图为 11:06:39，晚于本次日志，不能把截图配置视为失败当时配置的完整证明。
- 环境：Windows x64、软件 1.0.0、Electron 39.3.0、开发模式（isPackaged=false）。截图显示 Pupil Service 3.5.1；日志未记录实际连接的 Capture 版本。
- 原始日志含本机账户及实验路径，本报告不复述这些信息。

## 已确认的时间线（北京时间）

| 时间 | 原日志行 | 事件与含义 |
| --- | --- | --- |
| 11:02:17.704—17.705 | 25—28 | 本软件 Pupil 后端成功监听 9001/9002/9003，未发生依赖导入或监听失败 |
| 11:02:18.117—18.134 | 31—36 | WebSocket 连接建立，图像通道打开；通道打开不等于已有视频帧 |
| 11:02:20.057 | 43 | 发送 start，前端命令等待上限 30 秒 |
| 11:02:21.622 | 47 | 约 1.565 秒后返回 error=-1：No world video |
| 11:02:21.623 | 48—50 | 前端发送 stop，后端正常回复，清理本次启动 |

本次失败发生在采集连接/首帧阶段，未进入校准或录制。按当前源码，No world video 出现在 Remote 版本及 SUB_PORT 查询通过之后、等待 World 首帧超时之时；它不证明连接对象一定是 Capture。

## 优先假设及验证

1. **连到了 Pupil Service 的 Remote，而不是 Capture。** 截图同时出现两者，Service 的 Remote 地址为 127.0.0.1:50020，Capture 的 Remote 页面也显示端口 50020。本软件默认连接 127.0.0.1:50020。官方说明 Service 没有 World 视频，因此可出现接口能连接但无 World 帧。截图不足以证明端口的实际进程归属，不把此假设标为已确认。
2. **首帧等待过短。** 当前生产 PupilRuntime 设置首帧等待 1.5 秒，与日志耗时一致；订阅建立或高负载延迟可能导致失败。仅凭本日志不能认定这是根因，也不能靠延长等待解决连错服务的问题。
3. **Capture 发布/订阅链路未实际输出 World 帧。** 截图显示 BGR，但没有实际订阅 endpoint、主题计数或首包信息，不能排除发布链路问题。

现场先退出本软件与 Pupil Service，仅启动 Pupil Capture，确认 World 及眼相机有实时画面、Network API/Frame Publisher 为 BGR、Remote 端口 50020，再启动本软件重试。退出 Service 后若眼相机无法打开，应重启 Capture 释放并重新获取设备。

若仍失败，在 Windows PowerShell 执行以下只读命令，记录 50020 的监听地址、PID 和进程名：

```powershell
Get-NetTCPConnection -LocalPort 50020 -State Listen | ForEach-Object {
  [pscustomobject]@{
    Address = $_.LocalAddress
    Port = $_.LocalPort
    PID = $_.OwningProcess
    Process = (Get-Process -Id $_.OwningProcess).ProcessName
  }
}
```

下一份日志需要增加或提供：Remote endpoint、版本、SUB_PORT/订阅 endpoint、接收 topic 计数、首个 World 帧时间和格式。当前日志未包含这些信息，不能确认进程归属或具体丢失位置。

依据：[Pupil Service 官方说明](https://docs.pupil-labs.com/core/software/pupil-service/)、[Network API](https://docs.pupil-labs.com/core/developer/network-api/)。
