# HRT通讯工具

独立的 UDP 收发和 TCP 眼动数据接收调试工具，只使用 Python 标准库。

## 运行

```bash
cd tools/communication-debugger
python main.py
```

## 与 HRT 主程序联调

1. 在 HRT 的“通讯配置”中启用眼动数据 TCP 转发，监听地址使用 `0.0.0.0`，端口使用 `7979`。
2. 打开本工具，在“TCP 客户端”中填写服务端 IP：
   - 同一台电脑：`127.0.0.1`
   - 不同电脑：运行 HRT 主程序电脑的局域网 IP
3. 端口填写 `7979`，点击“连接服务端”。
4. 进入实验录制页面并启动设备后，工具会逐条显示眼动数据。

`0.0.0.0` 仅用于服务端监听，不能作为客户端的目标 IP。

## 功能

| 模块 | 功能 |
|---|---|
| UDP 发送 | 指定目标 IP/端口发送 UTF-8 Trigger 文本，不添加换行符 |
| UDP 接收 | 监听指定端口，显示 UTF-8、HEX、来源地址和字节数 |
| TCP 客户端 | 连接 HRT TCP 服务端并实时接收眼动数据 |
| TCP 协议解析 | 支持 `<|` + 6位包体字节数 + UTF-8 JSON |
| 数据流处理 | 正确处理 TCP 半包、粘包、中文 AOI 和异常前缀 |

## Windows EXE 打包

双击 `build_windows.bat`，或者执行：

```bat
py -3 -m pip install pyinstaller
py -3 -m PyInstaller --clean --noconfirm --onefile --windowed --name "HRT通讯工具" main.py
```

生成文件位于：

```text
dist\HRT通讯工具.exe
```
