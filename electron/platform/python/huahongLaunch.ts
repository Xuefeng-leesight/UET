import fs from 'node:fs'
import path from 'node:path'

export const isHuahongModel = (model: unknown): boolean => model === 'HH_ET10C' || model === 'HH_ET28'

/** One vendor runtime per process; no aSee password or DLL path discovery. */
export function buildHuahongCommand(options: {
  appDir: string; resourcesPath: string; packaged: boolean; platform: string;
  env: NodeJS.ProcessEnv; ffmpeg: string | null; rendererUrl: string;
}) {
  if (options.platform !== 'win32') throw new Error('华弘设备仅支持 Windows x64')
  if (!isHuahongModel(options.env.MRT_SDK_MODEL)) throw new Error('必须指定华弘设备型号')
  const env: NodeJS.ProcessEnv = { ...options.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1', PYTHONFAULTHANDLER: '1' }
  for (const key of ['MRT_SDK_ROOT', 'MRT_TYPES_DIR', 'MRT_SOFTDOG_PWD', 'MRT_SOFTDOG_INI_PATH', 'ET10C_DLL_DIR', 'ET28_DLL_DIR']) delete env[key]
  const repo = path.resolve(options.appDir, '..')
  const sdk = path.join(options.packaged ? options.resourcesPath : repo, 'SDK/huahong')
  const dll = path.join(sdk, options.env.MRT_SDK_MODEL === 'HH_ET10C' ? 'et10/bin/windows/x64/et10c_interface.dll' : 'et28/bin/windows/x64/et28_interface.dll')
  if (!fs.existsSync(dll)) throw new Error(`华弘运行库缺失: ${dll}`)
  if (!env.MRT_HUAHONG_PROJECT_ROOT) throw new Error('请先打开已授权的华弘工程')
  const args = ['--model', String(env.MRT_SDK_MODEL), '--sdk-root', sdk,
    '--image-port', env.MRT_WS_IMAGE_PORT || '9001', '--eye-port', env.MRT_WS_EYE_PORT || '9002',
    '--command-port', env.MRT_WS_CMD_PORT || '9003', '--control-stdin', '--project-root', env.MRT_HUAHONG_PROJECT_ROOT,
    '--origin', options.packaged || options.rendererUrl.startsWith('file:') ? 'null' : new URL(options.rendererUrl || 'http://localhost:31873').origin]
  if (options.ffmpeg) args.push('--ffmpeg', options.ffmpeg)
  args.push('--ffprobe', env.MRT_FFPROBE_PATH || (options.packaged ? path.join(options.resourcesPath, 'py/ffprobe.exe') : 'ffprobe'))
  if (options.packaged) {
    const exe = path.join(options.resourcesPath, 'py/mrt-huahong-server.exe')
    if (!fs.existsSync(exe)) throw new Error('缺少华弘后端程序，请安装完整版本')
    return { command: exe, args, cwd: path.dirname(exe), env }
  }
  const venv = path.join(repo, 'services/eye_tracking/adapters/huahong/.venv/Scripts/python.exe')
  const interpreter = env.MRT_HUAHONG_PYTHON_BIN || (fs.existsSync(venv) ? venv : 'py')
  return { command: interpreter, args: [...(interpreter === 'py' ? ['-3'] : []), '-m', 'services.eye_tracking.entrypoints.huahong_server', ...args], cwd: repo, env }
}
