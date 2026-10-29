# Windows 原生算法初始化阻塞排查（2026-10-13）

## 用户日志证据

来源为项目根目录的 `mrt-video-debug-2026-10-13.log`，截图时间16:38。以下时间为北京时间。

- 14:03、14:10两次旧尝试使用系统Python，缺少msgpack；不是最新尝试的运行环境。
- 16:36:34与16:37:58两次最新尝试已使用 `pupil_native/.venv/Scripts/python.exe`，`frozen=False`，是源码运行，不是macOS打包产物。
- 日志998行：NumPy加载71.297秒；1082行：NumPy加载21.015秒。两次加载完成都紧接停止操作、父管道关闭之后。
- 第二次NumPy之后，OpenCV0.016秒、SciPy0.234秒、UVC0秒、pupil_detectors0.016秒；退出前未记录pye3d完成。

Windows使用后台线程执行 `sys.stdin.buffer.read()` 监测父进程，同时主线程导入NumPy。该结构与[NumPy官方问题24290](https://github.com/numpy/numpy/issues/24290)的复现一致，日志强烈支持管道读取与DLL加载互锁，而非算法计算需要几十秒。尚未在用户Windows机器上运行修复版，因此不把推断或macOS测试写成Windows修复验收。

## 修复

1. Pupil父控制管道在Windows通过[ReadFile](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-readfile)读取，避免长时间占有CRT文件描述符读锁；服务和原生工作进程共用实现。其他平台沿用原有读取方式。
2. 保留父管道EOF、shutdown命令、相机取消/释放行为。未把库加载挪到相机连接或取消父进程监测。
3. 原生读取线程的解码/依赖异常传给owner，避免线程退出而界面继续等待；初始化增加每个库的开始日志及4秒时线程栈诊断。
4. 启动基准支持 `--source`，直接测量Windows正在使用的源码入口。worker模式必须等到prepared之后才关闭stdin，不能用提前EOF绕开本问题。
5. 增加新进程回归：父管道保持打开时真实依赖加载完成；shutdown/EOF后退出；缺msgpack错误传播；Windows API句柄宽度和断管映射。CI另加源码服务4秒门禁。

## Windows复测

### 17:07复测后的第二次修正

用户新日志已出现第一版的 `pupil_parent_pipe.py` 调用栈，确认旧修复确实部署。17:07:57的4秒诊断显示监测线程阻塞在ReadFile，而主线程仍停在NumPy原生模块create_module；到17:08:54仍未就绪。因此第一版仅绕开CRT读锁不足以解决该机器问题，不能把第一版本机通过等同于Windows已修复。

第二版将Windows监测改为PeekNamedPipe查询可用字节，只在有数据时读取，空管道每20ms检查一次；此控制管道只有一个读取者，避免同步读与其他读取者竞争。同时所有原生工作进程（prepare/camera/fit）先加载原生依赖，再启动父管道监测线程，从启动顺序消除导入与监测并发。加载期间主进程仍可经PipeWorker终止/强制结束子进程；导入完成后恢复父EOF监测。服务日志和状态版本更新为 `pupil-native-v2-bootstrap`。新增回归核对三个worker分支的加载顺序，及空管道不调用ReadFile、断管及时结束的边界。

Windows第二版效果仍须真机复测；不要重装依赖或继续等待旧进程。完全退出后重启，并核对上述revision及每个库的加载时间。

第二版本机验收：150项回归中148通过、2项环境跳过；冻结专项3项通过，发布检查通过。macOS重建后首次进程启动3.175秒；证据为 `services/build/pupil-validation/windows-bootstrap-*.log/json`，不代表Windows耗时。

本机macOS回归149项：147通过、2项冻结测试按环境跳过，冻结专项另测3项通过；`release:check`通过，前端无改动。父管道保持打开时源码服务0.453秒、独立工作进程0.342秒；重建后打包服务首次进程启动2.928秒。证据位于 `services/build/pupil-validation/windows-pipe-*.log/json`。这些是macOS结果；Windows原生API部分在本机仅做模拟边界测试，实际Windows耗时和完整生命周期须按以下步骤复测。

同步修复代码后，完全退出原来运行的MRT，从项目根目录PowerShell执行，不需要重装算法依赖：

```powershell
$pupilPython = Join-Path $PWD "services/eye_tracking/adapters/pupil_native/.venv/Scripts/python.exe"
& $pupilPython -m unittest tests.eye_tracking.pupil_core.test_parent_pipe -v
& $pupilPython -m tools.pupil.benchmark_startup $pupilPython --source --label repeat --budget 4 --output services/build/pupil-validation/startup-windows-source.json
```

基准失败返回非零；报告含elapsed_s、实际解释器、算法就绪和stderr。随后从同一窗口设置 `$env:MRT_PUPIL_PYTHON_BIN = $pupilPython` 并 `npm run dev` 验证设备。若仍超过4秒，提供新的debug和JSON，依据开始日志与线程栈继续定位。此复测不称为干净系统冷启动。
