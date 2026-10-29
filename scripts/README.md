# 清理脚本说明

## cleanup-server.js

**备份清理脚本** - 仅在异常终止时作为安全网运行。

### 角色定位

这个脚本现在是**备份保险机制**，不是主要清理方式。

主要清理机制：
- ✅ Python服务器正确处理SIGTERM信号
- ✅ Electron等待进程完全退出
- ✅ 端口在进程内正确释放

备份清理机制（本脚本）：
- 🛡️ 只在主要机制失败时运行
- 🛡️ 处理异常情况（崩溃、强制终止等）
- 🛡️ 作为最后一道防线

### 何时会运行

1. **应用崩溃** - 主进程异常退出
2. **强制终止** - 用户使用任务管理器结束进程
3. **进程卡死** - Python进程无法响应信号
4. **系统异常** - 其他不可预见的情况

### 正常情况

在正常关闭时，这个脚本应该：
- 找不到任何需要清理的进程
- 日志显示 "No orphaned processes found (good!)"
- 快速退出

### 工作原理

1. 应用关闭时启动（后台独立进程）
2. 等待1秒确保主进程已退出
3. 检查是否有残留的进程
4. 如果有，清理它们
5. 记录日志并退出

### 调试日志

**Windows**: `%TEMP%\mrt-cleanup.log`

正常情况的日志示例：
```
[2024-03-24T10:30:45.123Z] [cleanup-backup] === Backup cleanup script started ===
[2024-03-24T10:30:46.124Z] [cleanup-backup] Backup cleanup started (only runs if main cleanup failed)
[2024-03-24T10:30:46.234Z] [cleanup-backup] No orphaned mrt-ws-server.exe found (good!)
[2024-03-24T10:30:46.345Z] [cleanup-backup] No orphaned Python processes found (good!)
[2024-03-24T10:30:46.346Z] [cleanup-backup] Backup cleanup completed
[2024-03-24T10:30:46.347Z] [cleanup-backup] === Backup cleanup script exiting ===
```

异常情况的日志示例：
```
[2024-03-24T10:30:45.123Z] [cleanup-backup] === Backup cleanup script started ===
[2024-03-24T10:30:46.124Z] [cleanup-backup] Backup cleanup started (only runs if main cleanup failed)
[2024-03-24T10:30:46.234Z] [cleanup-backup] Found orphaned mrt-ws-server.exe, killing...
[2024-03-24T10:30:46.456Z] [cleanup-backup] Killed orphaned mrt-ws-server.exe
[2024-03-24T10:30:46.567Z] [cleanup-backup] Cleaned up 1 orphaned Python process(es)
[2024-03-24T10:30:46.568Z] [cleanup-backup] Backup cleanup completed
[2024-03-24T10:30:46.569Z] [cleanup-backup] === Backup cleanup script exiting ===
```

### 手动测试

```bash
node scripts/cleanup-server.js
```

然后检查日志文件：
```cmd
type %TEMP%\mrt-cleanup.log
```

### 是否可以删除？

**建议保留**，理由：
- ✅ 零成本 - 不影响正常流程
- ✅ 安全网 - 处理极端异常情况
- ✅ 用户体验 - 即使崩溃也能自动恢复

如果你确定要删除：
1. 从 `electron/main.ts` 中移除 `startCleanupScript()` 调用
2. 从 `package.json` 的 `extraResources` 中移除 scripts 配置
3. 删除 `scripts/cleanup-server.js` 文件

但我强烈建议保留它作为保险。

---

## 其他脚本

- `check-architecture.mjs`：执行目录、依赖方向和 IPC 边界门禁，由 `npm run check:architecture` 调用。
- `migrate-record-points-index.mjs`：重建/迁移记录点索引。运行前必须备份目标项目，并先阅读脚本参数。
- `check-repository-hygiene.mjs`：检查禁止跟踪的缓存/构建文件和稳定交付必需文档。
- `check-python-sources.mjs`：在临时缓存目录编译 Python 源码，不扫描或污染 `.venv`。
- `validate-sdk.mjs`：校验三个设备 SDK 的关键发布文件，并可生成带 SHA-256 的 SDK 清单。
- `installer.nsh`：Electron Builder 使用的 Windows NSIS 安装扩展，不应直接执行。

曾经文档中提到的 `test-port-check.cjs` 当前仓库不存在，因此不再作为可用维护命令。若重新引入端口诊断工具，应放在 `tools` 或提供对应 npm script 和验证流程。
