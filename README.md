# MRT Project Manager

UET-SA 视线交互采集分析系统的桌面应用仓库，包含 React renderer、Electron 主进程、眼动/表情 Python 服务及厂商 SDK 资源。

## 开发文档入口

- [系统架构与 UI 规范](docs/架构/系统架构.md)：运行时、目录、依赖、多模态、UI 设计和技术债务。
- [维护、验证与发布手册](docs/维护/维护手册.md)：修改方法、测试、回归、稳定交付和发布检查。
- [Python 服务目录与清理边界](services/README.md)：各子目录职责、开发依赖、发行资源及旧命令迁移。
- [Code Graph](docs/code-graph/README.md)：代码调用图、跨进程关系和重新生成命令。

## 本地开发

### 前置环境
- Node.js 18+
- Python 3.10+（用于本地调试 Python WS 服务）

### 启动步骤
1. 安装依赖
   ```bash
   npm install
   ```
2. 安装 Python 依赖
   ```bash
   python -m pip install -r services/requirements.txt
   ```
3. 运行
   ```bash
   npm run dev
   ```

默认会自动尝试启动 `services/eye_tracking/entrypoints/server.py`。如果本机 Python 可执行文件不在 PATH，可设置环境变量 `MRT_PYTHON_BIN` 指向 Python 路径。

Pupil 与华弘按工程型号使用独立后端和环境，分别见 [Pupil 原生环境](services/eye_tracking/adapters/pupil_native/README.md)及[华弘环境](services/eye_tracking/adapters/huahong/README.md)。Pupil 依赖清单位于 `services/eye_tracking/requirements/`；不要只安装上面的原设备依赖后直接启动 Pupil。2026-10-16 已将三个眼动入口集中至 `entrypoints/`，离线分析集中至 `analysis/`；旧命令迁移见服务目录说明。

## Windows 打包（Python 服务随 App 自动启动）

目标：生成 Windows 安装包，安装后自动启动内置 Python 服务，不依赖用户机器预装 Python。

### 一次性准备
1. 安装 Node 依赖
   ```bash
   npm install
   ```
2. 安装 Python 依赖和 PyInstaller
   ```bash
   python -m pip install -r services/requirements.txt
   python -m pip install pyinstaller
   ```

完整安装包还需要准备上述 Pupil、华弘独立环境。Pupil 构建依赖为 `services/eye_tracking/requirements/pupil-build.txt`，先在 native 环境完成 `scripts/install-pupil-native.py`，再安装构建依赖。详细配置见[维护手册](docs/维护/维护手册.md)。

### 执行打包
在项目根目录运行：

```bash
npm run dist:win
```

该命令会依次执行：
1. `npm run build` 构建前端与 Electron 主进程
2. `npm run build:py-server:win` 使用 `services/*/packaging` 中的 spec 构建 7invensun、Pupil、华弘三个眼动后端及表情后端到 `services/dist/`
3. `electron-builder --win nsis` 生成 Windows 安装包

### 产物位置
- 安装包输出目录：`release/`
- Python 服务在安装包中位于 `resources/py/`；包含 `mrt-ws-server.exe`、`mrt-huahong-server.exe`、`facial-ws-server.exe` 及完整 `pupil-backend/`，Pupil 对应第三方声明一起分发。
- 完整 SDK 目录会打进安装包：`resources/SDK/`

### 安装流程
- 安装包使用简体中文的标准安装向导。
- 默认安装目录：`C:\UET-SA`
- 用户可在安装过程中点击“浏览”修改安装目录。
- 安装需要管理员权限，并会创建桌面快捷方式和开始菜单快捷方式。
- 安装完成后可选择立即启动软件；卸载入口位于 Windows“设置 → 应用 → 已安装的应用”。

### 启动机制
- 开发态：自动启动 `services/eye_tracking/entrypoints/server.py`
- 打包后：自动启动 `resources/py/mrt-ws-server.exe`
- 打包后 Python 服务会优先从 `MRT_SDK_ROOT` / `MRT_TYPES_DIR` 读取 `resources/SDK` 内的 DLL 与类型文件
- 退出 App 时会自动停止 Python 服务进程

### 端口配置（可选）
可通过环境变量覆盖默认端口：
- `MRT_WS_IMAGE_PORT`（默认 9001）
- `MRT_WS_EYE_PORT`（默认 9002）
- `MRT_WS_CMD_PORT`（默认 9003）
