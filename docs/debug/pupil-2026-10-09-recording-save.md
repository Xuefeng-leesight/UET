# Pupil 录制收尾失败（2026-10-09）

## 证据

输入原始日志 `mrt-video-debug-2026-10-09.log`，1820 条 JSON。SHA-256：`695b738f36cd6f33e8e8089aa5c9599e7f7bf55a6661b1c1c2bf597fd40bfe6b`。原始日志不提交。

北京时间 10:42:50.147，停止录制返回 finalizing；10:42:50.252，收尾结果报 `[WinError 2] 系统找不到指定的文件。`。结果已记录视频大小 9,482,675 字节，随后主进程成功读取并复制该视频到媒体缓存。因此不是目标视频从未生成，也没有证据表明这是权限或中文路径错误。

## 定位与修复

开发启动原先将校验工具设为裸命令 `ffprobe`，而编码器由 Electron 独立定位。FFmpeg 可用不代表 ffprobe 在 PATH 中。视频编码完成后的第一步是执行 ffprobe，此处缺失会产生同类错误；原日志缺少 Python 异常阶段堆栈，不能仅凭 WinError 2 排除所有其他文件操作异常。回归已复现缺少 ffprobe 时录制收尾失败的路径。

开发启动现在优先使用显式 MRT_FFPROBE_PATH，再查资源目录、services/dist、FFmpeg 同目录和 PATH。正常录制若 ffprobe 不存在，使用已经可用的 FFmpeg FrameMD5 完整解码，核验实际帧数、尺寸、时间戳和时长，再完成 CSV 收尾；不会因视频文件存在就判成功。已有 ffprobe 返回错误时不绕过错误。安装包仍要求携带 ffprobe，中断记录恢复继续使用 ffprobe。

新增 videoVerificationMethod 元数据与 recording.worker_failed 阶段/堆栈日志，区分编码、视频校验、CSV 收尾失败。已有失败记录不自动覆写，保留 mp4 与 .pupil 附档。

## 验证

实际 fragmented MP4 在 ffprobe 缺失时可完成录制和 CSV 保存。验证损坏视频、错误帧数/尺寸/时长仍拒绝成功，已有工具执行失败不降级绕过。检查 Windows 带空格工具路径及显式覆盖路径。Windows 真机保存仍需复测。

## 10:56 复测：旧版 FFmpeg 参数兼容

截图显示失败阶段为 verify-video，执行的是项目 @ffmpeg-installer 二进制，命令含 -fps_mode passthrough。上一版回退使用了新版本参数，未覆盖项目自带的旧版二进制，是实现兼容性遗漏。使用本机项目自带 FFmpeg 4.4 已复现 Unrecognized option fps_mode，改用旧版和新版都支持的 -vsync 0。增加项目安装器实际二进制的编码及收尾回归；校验失败提示现在包含 stderr 尾部，而非只有命令和退出码。Windows 对应二进制仍需真机复测。
