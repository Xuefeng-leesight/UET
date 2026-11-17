# 华弘 SDK 目录

参照 `SDK/invensun_7` 的 bin / samples 分工，按型号隔离 Windows x64 运行库和开发参考：

```text
huahong/
├── et10/
│   ├── bin/windows/x64/   # 19 个 DLL + tracker.xml
│   └── samples/           # Python 绑定、examples、tests、scripts、说明及依赖
├── et28/
│   ├── bin/windows/x64/   # 旧版 DLL，供回退使用
│   └── samples/           # 旧版开发参考
├── et28-aiot/
│   └── bin/windows/x64/   # 新版 ET28 运行库，13 个 DLL
├── INTEGRATION_MANIFEST.json
└── README.md
```

- `HH_ET10C` 使用 et10，`HH_ET28` 使用 et28-aiot。完整保留各自 DLL 依赖，不能按 Python 未调用的接口删掉虹膜、人脸或其他原生依赖。
- 生产代码位于 `services/eye_tracking/adapters/huahong/`，不导入 samples。安装包只收录 bin 中白名单文件；两款设备在独立进程中加载，避免同名 DLL 冲突。
- samples 保留参考源码和诊断工具。旧版 ET28 示例只适用于 `et28/bin/windows/x64` 的旧库。新版产品由 `aiot_et28.py` 负责设备生命周期并使用厂商 `aiot_dll.py` 的绑定。
- 已直接清理缓存、`.DS_Store`、日志和样例 `cablic.dat`。新被试不得复用样例校准数据。
- 产品校准与录制均由本软件控制，校准复用已有 7invensun 共享界面；samples 中的独立 UI 仅供开发参考。

`INTEGRATION_MANIFEST.json` 记录当前路径、大小和 SHA-256。运行 `npm run check:huahong-sdk` 验证全部 33 个运行文件。新版 ET28 DLL 来自 2026-11-11 的 aiotGlass Python Demo v1.0.1。

自动检查不能替代 Windows 安装包和真机验收。接入流程与待测项见 [运行说明](../../services/eye_tracking/adapters/huahong/README.md)。SDK 资源按现有仓库规则不纳入 Git；复制交付时必须同时携带本目录运行库。

## Windows 开发版验证

在项目根运行 `npm run dev`，打开 `HH_ET28` 工程后连接设备。日志出现 `huahong.et28 runtime=aiot` 表示新版已经完成设备初始化。新版沿用 1920×1080 中心裁剪、平滑 12、HRT 卡片校准和现有录制格式。

连接前确认场景、左右眼三路 USB 都已接入。新版 DLL 曾在缺设备时枚举报内存访问错误，产品先检查三路 USB。真机验证三路画面、校准后直接录制及回放、取消后重新校准、拔线后重连。

## 旧版目录迁移

SDK 二进制和 samples 不在 Git 中，拉取代码不会移动 Windows 上的旧 SDK。已有 `et10/dll` / `et28/release/bin` 布局的机器，应在项目根执行：

```powershell
npm run migrate:huahong-sdk
npm run check:huahong-sdk
```

迁移脚本先验证全部运行文件的大小和 SHA-256、参考文件及目标冲突，再移动到新布局；不会覆盖不同文件，缺失或损坏时不开始迁移。重复执行新布局不产生变化。旧目录可能保留额外文件，不自动删除未知文件或现场产生的校准数据。已经整理为新布局的本机无需再次复制 DLL。

从 samples 运行 ET10C 示例时使用 `--dll-dir ../bin/windows/x64`（工作目录为 `et10/samples`）；ET28 demo 使用同一路径参数或 `ET28_DLL_DIR`。这些工具仍遵循厂商协议，不是产品校准入口。
