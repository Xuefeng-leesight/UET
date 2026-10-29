import { BrowserWindow, dialog, ipcMain } from 'electron'
import * as fs from 'node:fs'
import path from 'node:path'
import { validateUtf8Path } from '../filesystem/pathValidation'
import { migrateProject } from '../../../shared/domain/projectModalities'
import type { Project } from '../../../shared/contracts/domain/models'
import type { AuthorizedPathRegistry } from '../../platform/security/authorizedPaths'

const EXPERIMENT_MODULE_DIRS = [
  'subjects',
  'stimuli',
  'recordings',
  'monitor',
  'visualization',
  'reports',
  'exports',
  'facial-analysis',
]

type UnknownRecord = Record<string, unknown>

type ProjectMeta = {
  id: string
  name: string
  code: string
  manager: string
  deviceType: string
  deviceModel: string
  updatedAt: string
  notes: string
  schemaVersion?: 2
  modalities?: Project['modalities']
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {}
}

function asRecordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((entry) => Object.keys(entry).length > 0) : []
}

function errorMessage(error: unknown, fallback = '未知错误'): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code || '') : ''
}

export function resolveExperimentDirectory(projectDir: string, dirName: string): string | null {
  const experimentsRoot = path.resolve(path.join(projectDir, 'experiments'))
  const experimentDir = path.resolve(path.join(experimentsRoot, dirName))
  if (experimentDir === experimentsRoot || !experimentDir.startsWith(`${experimentsRoot}${path.sep}`)) {
    return null
  }
  return experimentDir
}

export async function authorizeProjectDirectory(
  projectDir: string,
  authorizedPaths: AuthorizedPathRegistry,
): Promise<string> {
  const resolved = path.resolve(projectDir)
  const meta = await fs.promises.stat(path.join(resolved, 'project.json'))
  if (!meta.isFile()) throw new Error('项目元数据不是文件')
  return authorizedPaths.authorizeRoot(resolved)
}

export type ProjectDomainDependencies = {
  authorizedPaths: AuthorizedPathRegistry
  applyPreferredSdkModelForProject: (deviceType: unknown, requestedModel?: unknown) => void
  getMainWindow: () => BrowserWindow | null
  normalizeProjectDeviceModel: (value: unknown, deviceType?: unknown) => string
  normalizeProjectDeviceType: (value: unknown) => '桌面式' | '眼镜式'
  restartPyServerForSdkModelChange: (previousModel: string, nextModel: string) => void
}

function sanitizePathSegment(raw: unknown, fallback: string): string {
  let value = String(raw ?? '').trim()
  if (!value) return fallback
  value = value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
  value = value.replace(/\s+/g, ' ')
  if (process.platform === 'win32') {
    value = value.replace(/[. ]+$/g, '')
    const reserved = new Set([
      'CON', 'PRN', 'AUX', 'NUL',
      'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
      'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
    ])
    if (reserved.has(value.toUpperCase())) value = `_${value}`
  }
  return value || fallback
}

async function uniqueDirPath(baseDir: string): Promise<string> {
  let candidate = baseDir
  let index = 2
  while (true) {
    try {
      await fs.promises.access(candidate)
      candidate = `${baseDir}_${index}`
      index += 1
    } catch {
      return candidate
    }
  }
}

export function registerProjectHandlers(dependencies: ProjectDomainDependencies): void {
  const {
    authorizedPaths,
    applyPreferredSdkModelForProject,
    getMainWindow,
    normalizeProjectDeviceModel,
    normalizeProjectDeviceType,
    restartPyServerForSdkModelChange,
  } = dependencies
  const DEFAULT_SDK_MODEL = 'Pro'
  const normalizeLoadedProject = (parsed: UnknownRecord, fallbackName: string): Project => migrateProject({
    id: String(parsed.id ?? fallbackName),
    name: String(parsed.name ?? fallbackName),
    code: String(parsed.code ?? ''),
    manager: String(parsed.manager ?? ''),
    deviceType: parsed.deviceType === '眼镜式' ? '眼镜式' : parsed.deviceType === '桌面式' ? '桌面式' : undefined,
    deviceModel: typeof parsed.deviceModel === 'string'
      ? normalizeProjectDeviceModel(parsed.deviceModel, parsed.deviceType) as Project['deviceModel']
      : undefined,
    updatedAt: String(parsed.updatedAt ?? ''),
    notes: String(parsed.notes ?? ''),
    schemaVersion: parsed.schemaVersion === 2 ? 2 : undefined,
    modalities: Array.isArray(parsed.modalities) ? parsed.modalities as Project['modalities'] : undefined,
  })

  ipcMain.handle('select-project-root', async () => {
    const win = getMainWindow()
    if (!win) {
      return { canceled: true }
    }
  
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
    })
  
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true }
    }
  
    const rootPath = result.filePaths[0]
    await authorizedPaths.authorizeRoot(rootPath)
  
    return {
      canceled: false,
      rootPath,
    }
  })
  
  ipcMain.handle('init-project-structure', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const rootPath = typeof payload.rootPath === 'string' ? payload.rootPath : ''
    const project = asRecord(payload.project)
    if (!rootPath || Object.keys(project).length === 0) {
      return { ok: false, error: '缺少必要参数' }
    }
  
    // Validate UTF-8 path encoding
    const pathValidation = await validateUtf8Path(rootPath)
    if (!pathValidation.ok) {
      return { ok: false, error: pathValidation.error }
    }
  
    const projectDirName = sanitizePathSegment(project.name, 'project')
    const projectDir = path.join(rootPath, projectDirName)
  
    // Validate the constructed project directory path
    const projectDirValidation = await validateUtf8Path(path.dirname(projectDir))
    if (!projectDirValidation.ok) {
      return { ok: false, error: `项目目录路径验证失败：${projectDirValidation.error}` }
    }
  
    try {
      await fs.promises.mkdir(projectDir, { recursive: false })
    } catch (error: unknown) {
      if (errorCode(error) === 'EEXIST') {
        return {
          ok: false,
          message: `已存在名为“${projectDirName}”的工程文件夹，请修改工程名称`,
        }
      }
      return {
        ok: false,
        message: `创建工程文件夹失败：${errorMessage(error)}`,
      }
    }
    await fs.promises.mkdir(path.join(projectDir, '.config'), { recursive: true })
    const experimentsRoot = path.join(projectDir, 'experiments')
    await fs.promises.mkdir(experimentsRoot, { recursive: true })
  
    const metaPath = path.join(projectDir, 'project.json')
    const meta = migrateProject({
      id: project.id,
      name: project.name,
      code: project.code,
      manager: project.manager,
      deviceType: typeof project.deviceType === 'string' ? project.deviceType as Project['deviceType'] : undefined,
      deviceModel: typeof project.deviceModel === 'string' ? normalizeProjectDeviceModel(project.deviceModel, project.deviceType) as Project['deviceModel'] : undefined,
      updatedAt: project.updatedAt,
      notes: project.notes,
      schemaVersion: project.schemaVersion === 2 ? 2 : undefined,
      modalities: Array.isArray(project.modalities) ? project.modalities as Project['modalities'] : undefined,
    } as Project)
    await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
    await authorizeProjectDirectory(projectDir, authorizedPaths)
    if (meta.modalities?.some((item) => item.id === 'eye-tracking')) {
      applyPreferredSdkModelForProject(meta.deviceType, meta.deviceModel)
    }
  
    return {
      ok: true,
      projectDir,
      createdDirs: ['experiments'],
    }
  })
  
  ipcMain.handle('load-projects', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const rootPath = typeof payload.rootPath === 'string' ? payload.rootPath : ''
    if (!rootPath) {
      return { ok: false, projects: [], projectDirs: {} }
    }
  
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(rootPath, { withFileTypes: true })
    } catch {
      return { ok: false, projects: [] }
    }
  
    const projects: ProjectMeta[] = []
    const projectDirs: Record<string, string> = {}
  
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
  
      const dir = path.join(rootPath, entry.name)
      const metaPath = path.join(dir, 'project.json')
  
      let project
      try {
        const raw = await fs.promises.readFile(metaPath, 'utf-8')
        const parsed = asRecord(JSON.parse(raw))
        project = normalizeLoadedProject(parsed, entry.name)
      } catch {
        let stat
        try {
          stat = await fs.promises.stat(dir)
        } catch {
          continue
        }
        project = migrateProject({
          id: entry.name,
          name: entry.name,
          code: entry.name,
          manager: '',
          deviceType: '桌面式',
          deviceModel: 'Pro',
          updatedAt: stat.mtime.toISOString(),
          notes: '',
        } as Project)
      }
  
      projects.push(project)
      projectDirs[project.id] = dir
    }
  
    return {
      ok: true,
      projects,
      projectDirs,
    }
  })
  
  ipcMain.handle('save-project-meta', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const projectDir = typeof payload.projectDir === 'string' ? payload.projectDir : ''
    const project = asRecord(payload.project)
    if (!projectDir || Object.keys(project).length === 0) {
      return { ok: false, message: '参数错误' }
    }
  
    // Validate UTF-8 path encoding
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, message: `路径验证失败：${pathValidation.error}` }
    }
  
    const metaPath = path.join(projectDir, 'project.json')
    const updatedAt = typeof project.updatedAt === 'string' ? project.updatedAt : new Date().toLocaleString()
    const meta = migrateProject({
      id: String(project.id ?? ''),
      name: String(project.name ?? ''),
      code: String(project.code ?? ''),
      manager: String(project.manager ?? ''),
      deviceType: project.deviceType === '眼镜式' ? '眼镜式' : project.deviceType === '桌面式' ? '桌面式' : undefined,
      deviceModel: typeof project.deviceModel === 'string' ? normalizeProjectDeviceModel(project.deviceModel, project.deviceType) as Project['deviceModel'] : undefined,
      updatedAt,
      notes: String(project.notes ?? ''),
      schemaVersion: project.schemaVersion === 2 ? 2 : undefined,
      modalities: Array.isArray(project.modalities) ? project.modalities as Project['modalities'] : undefined,
    } as Project)
    try {
      await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
      if (meta.modalities?.some((item) => item.id === 'eye-tracking')) {
        applyPreferredSdkModelForProject(meta.deviceType, meta.deviceModel)
      }
      return { ok: true, path: metaPath }
    } catch (error: unknown) {
      return { ok: false, message: `写入 project.json 失败：${errorMessage(error)}` }
    }
  })
  
  
  ipcMain.handle('delete-project', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const projectDir = typeof payload.projectDir === 'string' ? payload.projectDir : ''
    if (!projectDir) {
      return { ok: false, message: '缺少 projectDir' }
    }
  
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, message: `路径验证失败：${pathValidation.error}` }
    }
  
    const resolvedDir = path.resolve(projectDir)
    const fsRoot = path.parse(resolvedDir).root
    if (!resolvedDir || resolvedDir === fsRoot) {
      return { ok: false, message: '工程目录无效' }
    }
  
    try {
      const stat = await fs.promises.stat(resolvedDir)
      if (!stat.isDirectory()) {
        return { ok: false, message: '工程目录不存在或不是文件夹' }
      }
    } catch {
      return { ok: false, message: '工程目录不存在' }
    }
  
    const metaPath = path.join(resolvedDir, 'project.json')
    try {
      await fs.promises.access(metaPath)
    } catch {
      return { ok: false, message: '目标目录不是有效工程（缺少 project.json）' }
    }

    // Defense-in-depth: only allow deleting directories the user has explicitly
    // authorized (selected/created/loaded) in this session, closing arbitrary-delete.
    const allowed = await authorizedPaths.isAuthorized(resolvedDir)
    if (!allowed) {
      return { ok: false, message: '拒绝删除未授权的工程目录' }
    }

    try {
      await fs.promises.rm(resolvedDir, { recursive: true, force: false })
      return { ok: true, deletedDir: resolvedDir }
    } catch (error: unknown) {
      return { ok: false, message: `删除工程失败：${errorMessage(error)}` }
    }
  })
  
  ipcMain.handle('select-existing-project', async () => {
    const win = getMainWindow()
    if (!win) {
      return { ok: false, message: '窗口不可用' }
    }
    const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, message: '已取消' }
    }
    const projectDir = picked.filePaths[0]
    const metaPath = path.join(projectDir, 'project.json')
    try {
      const raw = await fs.promises.readFile(metaPath, 'utf-8')
      const parsed = asRecord(JSON.parse(raw))
      const project = normalizeLoadedProject(parsed, path.basename(projectDir))
      await authorizeProjectDirectory(projectDir, authorizedPaths)
      if (project.modalities?.some((item) => item.id === 'eye-tracking')) applyPreferredSdkModelForProject(project.deviceType, project.deviceModel)
      return { ok: true, projectDir, project }
    } catch {
      return { ok: false, message: '未找到有效的 project.json' }
    }
  })
  
  ipcMain.handle('load-project-meta', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const projectDir = typeof payload.projectDir === 'string' ? payload.projectDir : ''
    if (!projectDir) {
      return { ok: false, message: '缺少 projectDir' }
    }
  
    // Validate UTF-8 path encoding
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, message: `路径验证失败：${pathValidation.error}` }
    }
  
    const metaPath = path.join(projectDir, 'project.json')
    try {
      const raw = await fs.promises.readFile(metaPath, 'utf-8')
      const parsed = asRecord(JSON.parse(raw))
      const project = normalizeLoadedProject(parsed, path.basename(projectDir))
      await authorizeProjectDirectory(projectDir, authorizedPaths)
      if (project.modalities?.some((item) => item.id === 'eye-tracking')) applyPreferredSdkModelForProject(project.deviceType, project.deviceModel)
      return { ok: true, projectDir, project }
    } catch (error: unknown) {
      return { ok: false, message: `读取 project.json 失败：${errorMessage(error)}` }
    }
  })
  
  ipcMain.handle('set-active-project-device-type', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const deviceType = payload.deviceType
    const deviceModel = payload.deviceModel
    const previousModel = String(process.env.MRT_SDK_MODEL || DEFAULT_SDK_MODEL).trim() || DEFAULT_SDK_MODEL
    const isolatedModel = normalizeProjectDeviceModel(deviceModel, deviceType)
    if (['PupilCore', 'HH_ET10C', 'HH_ET28'].includes(isolatedModel)) {
      const projectDir = typeof payload.projectDir === 'string' ? payload.projectDir : ''
      if (!projectDir || !(await authorizedPaths.isAuthorized(projectDir))) {
        return { ok: false, message: '请先打开已授权的 PupilCore 工程' }
      }
      const canonical = await fs.promises.realpath(projectDir)
      const metadata = normalizeLoadedProject(asRecord(JSON.parse(await fs.promises.readFile(path.join(canonical, 'project.json'), 'utf8'))), path.basename(canonical))
      if (metadata.deviceModel !== isolatedModel) return { ok: false, message: '工程型号不匹配' }
      if (isolatedModel === 'PupilCore') {
        process.env.MRT_PUPIL_PROJECT_ROOT = canonical
        delete process.env.MRT_HUAHONG_PROJECT_ROOT
      } else {
        process.env.MRT_HUAHONG_PROJECT_ROOT = canonical
        delete process.env.MRT_PUPIL_PROJECT_ROOT
      }
    } else {
      delete process.env.MRT_HUAHONG_PROJECT_ROOT
      delete process.env.MRT_PUPIL_PROJECT_ROOT
    }
    applyPreferredSdkModelForProject(deviceType, deviceModel)
    const nextModel = String(process.env.MRT_SDK_MODEL || DEFAULT_SDK_MODEL).trim() || DEFAULT_SDK_MODEL
    restartPyServerForSdkModelChange(previousModel, nextModel)
    return {
      ok: true,
      deviceType: normalizeProjectDeviceType(deviceType),
      model: nextModel,
    }
  })
  
  ipcMain.handle('list-experiments', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const projectDir = typeof payload.projectDir === 'string' ? payload.projectDir : ''
    if (!projectDir) {
      return { ok: false, message: '缺少 projectDir', experiments: [] }
    }
    // Opening a project's experiment list means the user is actively working
    // with this project; authorize its directory so subsequent operations
    // (e.g. delete-project) pass the authorization gate.
    await authorizedPaths.authorizeRoot(path.resolve(projectDir))
    const configDir = path.join(projectDir, '.config')
    const indexPath = path.join(configDir, 'experiments.json')
    const migratedFlagPath = path.join(configDir, 'migrated_experiment_structure.json')
    const experimentsRoot = path.join(projectDir, 'experiments')
    await fs.promises.mkdir(configDir, { recursive: true })
    await fs.promises.mkdir(experimentsRoot, { recursive: true })
  
    let entries: UnknownRecord[] = []
    try {
      const raw = await fs.promises.readFile(indexPath, 'utf-8')
      const parsed = JSON.parse(raw)
      entries = asRecordArray(parsed)
    } catch {
      entries = []
    }
  
    const dirHasAnyEntries = async (dirPath: string): Promise<boolean> => {
      try {
        const list = await fs.promises.readdir(dirPath)
        return Array.isArray(list) && list.length > 0
      } catch {
        return false
      }
    }
  
    const needsRootMigration = async (): Promise<boolean> => {
      for (const d of EXPERIMENT_MODULE_DIRS) {
        const p = path.join(projectDir, d)
        if (await dirHasAnyEntries(p)) return true
      }
      return false
    }
  
    const safeMoveDirContents = async (srcDir: string, destDir: string): Promise<void> => {
      await fs.promises.mkdir(destDir, { recursive: true })
      let items: fs.Dirent[] = []
      try {
        items = await fs.promises.readdir(srcDir, { withFileTypes: true })
      } catch {
        return
      }
      for (const it of items) {
        const from = path.join(srcDir, it.name)
        const baseTo = path.join(destDir, it.name)
        let to = baseTo
        let suffix = 2
        while (true) {
          try {
            await fs.promises.access(to)
            to = `${baseTo}_${suffix}`
            suffix += 1
          } catch {
            break
          }
        }
        try {
          await fs.promises.rename(from, to)
        } catch {
          try {
            await fs.promises.cp(from, to, { recursive: true })
            await fs.promises.rm(from, { recursive: true, force: true })
          } catch {
          }
        }
      }
      try {
        await fs.promises.rm(srcDir, { recursive: true, force: true })
      } catch {
      }
    }
  
    const createExperimentEntry = async (name: string, migrateFromRoot: boolean): Promise<UnknownRecord> => {
      const expName = name.trim().length > 0 ? name.trim() : '新实验'
      const id = Date.now().toString()
      const safeBase = sanitizePathSegment(expName, '新实验')
      const destBase = path.join(experimentsRoot, `${safeBase}_${id}`)
      const experimentDir = await uniqueDirPath(destBase)
      const dirName = path.basename(experimentDir)
      await fs.promises.mkdir(experimentDir, { recursive: true })
      await fs.promises.mkdir(path.join(experimentDir, '.config'), { recursive: true })
      for (const dir of EXPERIMENT_MODULE_DIRS) {
        await fs.promises.mkdir(path.join(experimentDir, dir), { recursive: true })
      }
      const nowIso = new Date().toISOString()
      await fs.promises.writeFile(
        path.join(experimentDir, 'experiment.json'),
        JSON.stringify({ id, name: expName, createdAt: nowIso, updatedAt: nowIso }, null, 2),
        'utf-8',
      )
      if (migrateFromRoot) {
        for (const d of EXPERIMENT_MODULE_DIRS) {
          const src = path.join(projectDir, d)
          if (!(await dirHasAnyEntries(src))) continue
          await safeMoveDirContents(src, path.join(experimentDir, d))
        }
      }
      return { id, name: expName, dirName, createdAt: nowIso, updatedAt: nowIso }
    }
  
    let migrated = false
    try {
      await fs.promises.access(migratedFlagPath, fs.constants.F_OK)
      migrated = true
    } catch {
      migrated = false
    }
  
    if (!migrated && (await needsRootMigration())) {
      const entry = await createExperimentEntry('实验_迁移', true)
      entries = [entry, ...entries.filter((e) => e && typeof e === 'object')]
      await fs.promises.writeFile(indexPath, JSON.stringify(entries, null, 2), 'utf-8')
      await fs.promises.writeFile(migratedFlagPath, JSON.stringify({ migratedAt: new Date().toISOString(), from: 'project_root' }, null, 2), 'utf-8')
    }
  
    const experiments: Array<{ id: string; name: string; dir: string; createdAt: unknown; updatedAt: unknown }> = []
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue
      const id = String(e.id ?? '')
      const name = String(e.name ?? '')
      const dirName = String(e.dirName ?? '')
      if (!id || !dirName) continue
      experiments.push({
        id,
        name: name || dirName,
        dir: path.join(projectDir, 'experiments', dirName),
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      })
    }
    return { ok: true, experiments }
  })
  
  ipcMain.handle('create-experiment', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const projectDir = typeof payload.projectDir === 'string' ? payload.projectDir : ''
    const name = payload.name
    if (!projectDir) {
      return { ok: false, message: '缺少 projectDir' }
    }
  
    // Validate UTF-8 path encoding
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, message: `路径验证失败：${pathValidation.error}` }
    }
  
    const expName = typeof name === 'string' && name.trim().length > 0 ? name.trim() : '新实验'
    const normalizeExperimentName = (value: unknown) =>
      String(value ?? '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLocaleLowerCase()
  
    const configDir = path.join(projectDir, '.config')
    await fs.promises.mkdir(configDir, { recursive: true })
    const indexPath = path.join(configDir, 'experiments.json')
    let entries: UnknownRecord[] = []
    try {
      const raw = await fs.promises.readFile(indexPath, 'utf-8')
      const parsed = JSON.parse(raw)
      entries = asRecordArray(parsed)
    } catch {
      entries = []
    }
  
    const normalizedExpName = normalizeExperimentName(expName)
    const hasDuplicateName = entries.some((entry) => normalizeExperimentName(entry.name) === normalizedExpName)
    if (hasDuplicateName) {
      return { ok: false, message: `实验名称「${expName}」已存在，请使用其他名称` }
    }
  
    const id = Date.now().toString()
    const safeBase = sanitizePathSegment(expName, '新实验')
    const experimentsRoot = path.join(projectDir, 'experiments')
    await fs.promises.mkdir(experimentsRoot, { recursive: true })
    const destBase = path.join(experimentsRoot, `${safeBase}_${id}`)
    const experimentDir = await uniqueDirPath(destBase)
    const dirName = path.basename(experimentDir)
    await fs.promises.mkdir(experimentDir, { recursive: true })
    await fs.promises.mkdir(path.join(experimentDir, '.config'), { recursive: true })
    for (const dir of EXPERIMENT_MODULE_DIRS) {
      await fs.promises.mkdir(path.join(experimentDir, dir), { recursive: true })
    }
    const nowIso = new Date().toISOString()
    await fs.promises.writeFile(
      path.join(experimentDir, 'experiment.json'),
      JSON.stringify({ id, name: expName, createdAt: nowIso, updatedAt: nowIso }, null, 2),
      'utf-8',
    )
    const nextEntry = { id, name: expName, dirName, createdAt: nowIso, updatedAt: nowIso }
    const filtered = entries.filter((entry) => String(entry.id ?? '') !== id)
    filtered.unshift(nextEntry)
    await fs.promises.writeFile(indexPath, JSON.stringify(filtered, null, 2), 'utf-8')
    return { ok: true, experiment: { id, name: expName, dir: experimentDir, createdAt: nowIso, updatedAt: nowIso } }
  })
  
  ipcMain.handle('delete-experiment', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const projectDir = typeof payload.projectDir === 'string' ? payload.projectDir : ''
    const experimentId = typeof payload.experimentId === 'string' ? payload.experimentId : ''
    if (!projectDir) {
      return { ok: false, message: '缺少 projectDir' }
    }
    if (!experimentId) {
      return { ok: false, message: '缺少 experimentId' }
    }
  
    const resolvedProjectDir = path.resolve(projectDir)
    const metaPath = path.join(resolvedProjectDir, 'project.json')
    try {
      await fs.promises.access(metaPath)
    } catch {
      return { ok: false, message: '目标目录不是有效工程（缺少 project.json）' }
    }
  
    const configDir = path.join(resolvedProjectDir, '.config')
    const indexPath = path.join(configDir, 'experiments.json')
    let entries: UnknownRecord[] = []
    try {
      const raw = await fs.promises.readFile(indexPath, 'utf-8')
      const parsed = JSON.parse(raw)
      entries = asRecordArray(parsed)
    } catch {
      entries = []
    }
  
    const target = entries.find((entry) => String(entry.id ?? '') === experimentId)
    if (!target) {
      return { ok: false, message: '未找到要删除的实验' }
    }
  
    const dirName = String(target.dirName ?? '')
    if (!dirName) {
      return { ok: false, message: '实验目录信息无效' }
    }
  
    const resolvedExperimentDir = resolveExperimentDirectory(resolvedProjectDir, dirName)
    if (!resolvedExperimentDir) {
      return { ok: false, message: '实验目录非法，拒绝删除' }
    }
  
    try {
      const stat = await fs.promises.stat(resolvedExperimentDir)
      if (!stat.isDirectory()) {
        return { ok: false, message: '实验目录不存在或不是文件夹' }
      }
    } catch {
      return { ok: false, message: '实验目录不存在' }
    }
  
    try {
      await fs.promises.rm(resolvedExperimentDir, { recursive: true, force: false })
      const nextEntries = entries.filter((entry) => String(entry.id ?? '') !== experimentId)
      await fs.promises.mkdir(configDir, { recursive: true })
      await fs.promises.writeFile(indexPath, JSON.stringify(nextEntries, null, 2), 'utf-8')
      return { ok: true, deletedDir: resolvedExperimentDir, deletedId: experimentId }
    } catch (error: unknown) {
      return { ok: false, message: `删除实验失败：${errorMessage(error)}` }
    }
  })
  
  ipcMain.handle('save-subject-fields', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const projectDir = typeof payload.projectDir === 'string' ? payload.projectDir : ''
    const fields = payload.fields
    if (!projectDir || !Array.isArray(fields)) {
      return { ok: false }
    }
  
    const configDir = path.join(projectDir, '.config')
    await fs.promises.mkdir(configDir, { recursive: true })
  
    const filePath = path.join(configDir, 'subject-fields.json')
    await fs.promises.writeFile(filePath, JSON.stringify(fields, null, 2), 'utf-8')
  
    return { ok: true }
  })
  
  ipcMain.handle('load-subject-fields', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const projectDir = typeof payload.projectDir === 'string' ? payload.projectDir : ''
    if (!projectDir) {
      return { ok: false, fields: [] }
    }
  
    const filePath = path.join(projectDir, '.config', 'subject-fields.json')
  
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return { ok: true, fields: parsed }
      }
      return { ok: true, fields: [] }
    } catch {
      return { ok: true, fields: [] }
    }
  })
  
  ipcMain.handle('save-subjects', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const projectDir = typeof payload.projectDir === 'string' ? payload.projectDir : ''
    const subjects = payload.subjects
    if (!projectDir || !Array.isArray(subjects)) {
      return { ok: false, error: '参数错误' }
    }
  
    // Validate UTF-8 path encoding
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, error: `路径验证失败：${pathValidation.error}` }
    }
  
    const subjectsDir = path.join(projectDir, 'subjects')
    await fs.promises.mkdir(subjectsDir, { recursive: true })
  
    const filePath = path.join(subjectsDir, 'subjects.json')
    try {
      await fs.promises.writeFile(filePath, JSON.stringify(subjects, null, 2), 'utf-8')
      return { ok: true }
    } catch (error: unknown) {
      return { ok: false, error: `保存失败：${errorMessage(error)}` }
    }
  })
  
  ipcMain.handle('load-subjects', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const projectDir = typeof payload.projectDir === 'string' ? payload.projectDir : ''
    if (!projectDir) {
      return { ok: false, subjects: [], error: '缺少 projectDir' }
    }
  
    // Validate UTF-8 path encoding
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, subjects: [], error: `路径验证失败：${pathValidation.error}` }
    }
  
    const filePath = path.join(projectDir, 'subjects', 'subjects.json')
  
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return { ok: true, subjects: parsed }
      }
      return { ok: true, subjects: [] }
    } catch (error: unknown) {
      return { ok: true, subjects: [], error: errorCode(error) === 'ENOENT' ? undefined : `读取失败：${errorMessage(error)}` }
    }
  })
  
}
