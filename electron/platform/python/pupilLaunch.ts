import * as fs from 'node:fs'
import path from 'node:path'

/** Build an isolated command without touching vendor DLL/password discovery. */
export function buildPupilCommand(options: {
  appDir: string; resourcesPath: string; packaged: boolean; platform: string;
  env: NodeJS.ProcessEnv; ffmpeg: string | null; rendererUrl: string;
}) {
  const env: NodeJS.ProcessEnv = { ...options.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  for (const key of ['MRT_SDK_ROOT', 'MRT_TYPES_DIR', 'MRT_SOFTDOG_PWD', 'MRT_SOFTDOG_INI_PATH']) delete env[key]
  const repo = path.resolve(options.appDir, '..')
  const backend = env.MRT_PUPIL_BACKEND || 'native'
  if (!['native', 'capture'].includes(backend)) throw new Error('MRT_PUPIL_BACKEND 必须为 native 或 capture')
  const args = ['--image-port', env.MRT_WS_IMAGE_PORT || '9001', '--eye-port', env.MRT_WS_EYE_PORT || '9002',
    '--command-port', env.MRT_WS_CMD_PORT || '9003', '--capture-port', env.MRT_PUPIL_CAPTURE_PORT || '50020', '--control-stdin']
  args.push('--backend', backend)
  if (env.MRT_PUPIL_INTRINSICS) args.push('--intrinsics', env.MRT_PUPIL_INTRINSICS)
  const uids = [env.MRT_PUPIL_RIGHT_UID, env.MRT_PUPIL_LEFT_UID, env.MRT_PUPIL_WORLD_UID]
  if (uids.some(Boolean)) {
    if (!uids.every(Boolean)) throw new Error('Pupil 相机 UID 必须同时配置右眼、左眼和场景相机')
    for (const uid of uids) args.push('--camera-uid', uid!)
  }
  if (env.MRT_PUPIL_PROJECT_ROOT) args.push('--project-root', env.MRT_PUPIL_PROJECT_ROOT)
  const origin = options.packaged || options.rendererUrl.startsWith('file:') ? 'null'
    : new URL(options.rendererUrl || 'http://localhost:31873').origin
  args.push('--origin', origin)
  if (options.ffmpeg) args.push('--ffmpeg', options.ffmpeg)
  const probeName = options.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  const candidates = [
    path.join(options.resourcesPath, 'py', probeName),
    path.join(repo, 'services', 'dist', probeName),
    ...(options.ffmpeg ? [path.join(path.dirname(options.ffmpeg), probeName)] : []),
  ]
  const probe = env.MRT_FFPROBE_PATH || (options.packaged ? candidates[0]
    : candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || 'ffprobe')
  args.push('--ffprobe', probe)
  if (options.packaged) {
    if (!fs.existsSync(probe)) throw new Error('缺少 PupilCore 视频校验工具 ffprobe，请重新安装完整版本。')
    const exe = path.join(options.resourcesPath, 'py', 'pupil-backend',
      options.platform === 'darwin' ? 'PupilBackend.app/Contents/MacOS/mrt-pupil-server'
        : options.platform === 'win32' ? 'mrt-pupil-server.exe' : 'mrt-pupil-server')
    if (!fs.existsSync(exe)) throw new Error('缺少 PupilCore 后端程序，请重新安装包含 PupilCore 的版本。')
    return { command: exe, args, cwd: path.dirname(exe), env }
  }
  const venv = path.join(repo, `services/eye_tracking/adapters/${backend === 'native' ? 'pupil_native' : 'pupil_core'}/.venv`,
    options.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const interpreter = env.MRT_PUPIL_PYTHON_BIN || (fs.existsSync(venv) ? venv : options.platform === 'win32' ? 'py' : 'python3')
  return { command: interpreter, args: [...(interpreter === 'py' ? ['-3'] : []), '-m', 'services.eye_tracking.entrypoints.pupil_server', ...args], cwd: repo, env }
}
