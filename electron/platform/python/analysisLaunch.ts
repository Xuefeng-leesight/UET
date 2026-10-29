import * as fs from 'node:fs'
import path from 'node:path'

export type AnalysisCommand = {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

/** Offline analysis depends on Python/OpenCV, never the selected device SDK. */
export function buildGazeMappingCommand(options: {
  appDir: string
  resourcesPath: string
  packaged: boolean
  platform: string
  env: NodeJS.ProcessEnv
}, jobPath: string): AnalysisCommand | null {
  const repo = path.resolve(options.appDir, '..')
  const env: NodeJS.ProcessEnv = { ...options.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  for (const key of Object.keys(env)) {
    if (/^MRT_(SDK_|TYPES_|SOFTDOG_|PUPIL_|HUAHONG_|WS_)/.test(key) || /^(ET10C|ET28)_DLL_DIR$/.test(key)) delete env[key]
  }
  const isFile = (file: string) => {
    try { return fs.statSync(file).isFile() } catch { return false }
  }
  if (options.packaged) {
    // Existing bundles expose the same offline CLI. Choose an installed binary
    // by availability; a recording's brand does not select or validate an SDK.
    const suffix = options.platform === 'win32' ? '.exe' : ''
    const candidates = [
      path.join(options.resourcesPath, 'py', `mrt-ws-server${suffix}`),
      path.join(options.resourcesPath, 'py', `mrt-huahong-server${suffix}`),
      path.join(options.resourcesPath, 'py', 'pupil-backend', options.platform === 'darwin'
        ? 'PupilBackend.app/Contents/MacOS/mrt-pupil-server' : `mrt-pupil-server${suffix}`),
    ]
    const command = candidates.find(isFile)
    return command ? { command, args: ['--gaze-map-job', jobPath], cwd: path.dirname(command), env } : null
  }

  if (!isFile(path.join(repo, 'services/eye_tracking/analysis/gaze_mapper.py'))) return null
  const pythonName = options.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
  const candidates = [
    'services/eye_tracking/.venv',
    'services/eye_tracking/venv',
    'services/eye_tracking/adapters/pupil_native/.venv',
    'services/eye_tracking/adapters/huahong/.venv',
    'services/eye_tracking/adapters/pupil_core/.venv',
  ].map((directory) => path.join(repo, directory, pythonName))
  const command = options.env.MRT_ANALYSIS_PYTHON_BIN?.trim() || options.env.MRT_PYTHON_BIN?.trim()
    || candidates.find(isFile) || (options.platform === 'win32' ? 'py' : 'python3')
  return {
    command,
    args: [...(command === 'py' ? ['-3'] : []), '-m', 'services.eye_tracking.analysis.gaze_mapper', '--job', jobPath],
    cwd: repo,
    env,
  }
}
