# 华弘 SDK 目录

参照 `SDK/invensun_7` 的 bin / samples 分工，按型号隔离 Windows x64 运行库和开发参考：

```text
huahong/
├── et10/
│   ├── bin/windows/x64/   # 19 个 DLL + tracker.xml
│   └── samples/           # Python 绑定、examples、tests、scripts、说明及依赖
├── et28/
│   ├── bin/windows/x64/   # 12 个 DLL
│   └── samples/           # Python 绑定、demo、自检、说明及依赖
├── INTEGRATION_MANIFEST.json
└── README.md
```

- `HH_ET10C` 使用 et10，`HH_ET28` 使用 et28。完整保留各自 DLL 依赖，不能按 Python 未调用的接口删掉虹膜、人脸或其他原生依赖。
- 生产代码位于 `services/eye_tracking/adapters/huahong/`，不导入 samples。安装包只收录 bin 中白名单文件；两款设备在独立进程中加载，避免同名 DLL 冲突。
- samples 保留参考源码和诊断工具；运行示例时显式传入 `--dll-dir` 指向对应型号的 `bin/windows/x64`，或设置 `ET10C_DLL_DIR` / `ET28_DLL_DIR`。厂商说明中的旧目录为原始发布布局；不再运行 setup_dlls.py 复制依赖。
- 已直接清理缓存、`.DS_Store`、日志和样例 `cablic.dat`。新被试不得复用样例校准数据。
- 产品校准与录制均由本软件控制，校准复用已有 7invensun 共享界面；samples 中的独立 UI 仅供开发参考。

`INTEGRATION_MANIFEST.json` 记录当前路径、大小和 SHA-256；运行 `npm run check:huahong-sdk` 验证全部 32 个运行文件。目录整理不改变二进制内容。

自动检查不能替代 Windows 安装包和真机验收。接入流程与待测项见 [运行说明](../../services/eye_tracking/adapters/huahong/README.md)。SDK 资源按现有仓库规则不纳入 Git；复制交付时必须同时携带本目录运行库。

## 已有 Windows 工作区升级

SDK 二进制和 samples 不在 Git 中，拉取代码不会移动 Windows 上的旧 SDK。已有 `et10/dll` / `et28/release/bin` 布局的机器，应在项目根执行：

```powershell
npm run migrate:huahong-sdk
npm run check:huahong-sdk
```

迁移脚本先验证全部运行文件的大小和 SHA-256、参考文件及目标冲突，再移动到新布局；不会覆盖不同文件，缺失或损坏时不开始迁移。重复执行新布局不产生变化。旧目录可能保留额外文件，不自动删除未知文件或现场产生的校准数据。已经整理为新布局的本机无需再次复制 DLL。

从 samples 运行 ET10C 示例时使用 `--dll-dir ../bin/windows/x64`（工作目录为 `et10/samples`）；ET28 demo 使用同一路径参数或 `ET28_DLL_DIR`。这些工具仍遵循厂商协议，不是产品校准入口。
