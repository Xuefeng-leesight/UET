import * as fs from 'node:fs'
import path from 'node:path'
import { execSync, spawn, spawnSync } from 'node:child_process'
import { writeTextFileAtomic } from '../fs/atomicWrite'
import { ensureAsciiMediaCachePath, hasNonAsciiPath, logMainVideoDebug } from './localResourceProtocol'

type NormalizeProjectDeviceType = (value: unknown) => '桌面式' | '眼镜式'

function getErrorDetails(error: unknown): { message: string } {
  if (error instanceof Error) return { message: error.message }
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return { message: (error as { message: string }).message }
  }
  return { message: '' }
}

export function createMediaToolkit(deps: {
  appDir: string
  requireModule: NodeRequire
  normalizeProjectDeviceType: NormalizeProjectDeviceType
  getSdkContainerPath: () => string
  getSdkRootPath: () => string
}) {
  const normalizeProjectDeviceType = deps.normalizeProjectDeviceType
  const getSdkContainerPath = deps.getSdkContainerPath
  const getSdkRootPath = deps.getSdkRootPath

function safeTimestampForPath(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function sanitizePathSegment(raw: unknown, fallback: string): string {
  let value = String(raw ?? '').trim()
  if (!value) return fallback

  // Keep Chinese/Unicode chars, only replace filesystem-invalid characters.
  value = value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
  value = value.replace(/\s+/g, ' ')

  if (process.platform === 'win32') {
    value = value.replace(/[. ]+$/g, '')
    const reserved = new Set([
      'CON', 'PRN', 'AUX', 'NUL',
      'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
      'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
    ])
    if (reserved.has(value.toUpperCase())) {
      value = `_${value}`
    }
  }

  return value || fallback
}

async function uniqueDirPath(baseDir: string): Promise<string> {
  let candidate = baseDir
  let i = 2
  while (true) {
    try {
      await fs.promises.access(candidate)
      candidate = `${baseDir}_${i}`
      i += 1
    } catch {
      return candidate
    }
  }
}

async function uniqueFilePath(basePath: string): Promise<string> {
  const ext = path.extname(basePath)
  const stem = ext ? basePath.slice(0, -ext.length) : basePath
  let candidate = basePath
  let i = 2
  while (true) {
    try {
      await fs.promises.access(candidate)
      candidate = `${stem}_${i}${ext}`
      i += 1
    } catch {
      return candidate
    }
  }
}

function isSubPath(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

async function runCommand(command: string, args: string[], cwd?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: 'ignore',
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${command} exited with code ${code}`))
      }
    })
  })
}

async function runCommandCapture(command: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise<string>((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
      }
    }, Math.max(1000, timeoutMs))
    child.stdout?.on('data', (chunk) => {
      output += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      output += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk)
    })
    child.once('error', () => {
      clearTimeout(timer)
      resolve(output)
    })
    child.once('close', () => {
      clearTimeout(timer)
      resolve(output)
    })
  })
}

async function probeMediaDurationSeconds(sourcePath: string): Promise<number | undefined> {
  const ffmpeg = findFfmpegBinary()
  if (!ffmpeg || !isExistingFile(sourcePath)) return undefined
  const output = await runCommandCapture(ffmpeg, ['-hide_banner', '-i', sourcePath], 8000)
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/i.exec(output)
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const duration = hours * 3600 + minutes * 60 + seconds
  return Number.isFinite(duration) && duration > 0 ? duration : undefined
}

function escapePowerShellSingleQuoted(value: string): string {
  return String(value || '').replace(/'/g, "''")
}

async function createZipArchive(sourceDir: string, targetZipPath: string): Promise<void> {
  if (process.platform === 'win32') {
    const src = escapePowerShellSingleQuoted(sourceDir)
    const dst = escapePowerShellSingleQuoted(targetZipPath)
    const script = `Compress-Archive -LiteralPath '${src}' -DestinationPath '${dst}' -Force`
    await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    return
  }

  if (process.platform === 'darwin') {
    await runCommand('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', sourceDir, targetZipPath])
    return
  }

  const parentDir = path.dirname(sourceDir)
  const baseName = path.basename(sourceDir)
  await runCommand('zip', ['-r', targetZipPath, baseName], parentDir)
}

function isExistingFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath)
    return stat.isFile()
  } catch {
    return false
  }
}

function expandAsarExecutableCandidates(filePath: string): string[] {
  const normalized = path.resolve(String(filePath || ''))
  if (!normalized) return []
  const out = [normalized]
  if (normalized.includes('app.asar')) {
    out.push(normalized.replace('app.asar', 'app.asar.unpacked'))
  }
  return out
}

function canRunCommand(command: string): boolean {
  if (failedProbeCache.has(command)) return false
  try {
    const res = spawnSync(command, ['-version'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    const ok = res.status === 0
    if (!ok) failedProbeCache.add(command)
    return ok
  } catch {
    failedProbeCache.add(command)
    return false
  }
}

let ffmpegBinaryCache: string | undefined
let ffmpegLookupLogged = false
// Remember paths we already probed and rejected so cold lookups don't
// re-spawn `ffmpeg -version` for the same dead candidate repeatedly.
const failedProbeCache = new Set<string>()

function findFfmpegInDirectoryTree(params: {
  roots: string[]
  binaryName: string
  maxDepth?: number
  maxDirs?: number
}): string | null {
  const { roots, binaryName, maxDepth = 4, maxDirs = 600 } = params
  const queue: Array<{ dir: string; depth: number }> = []
  const seenDirs = new Set<string>()
  for (const root of roots) {
    const next = path.resolve(String(root || ''))
    if (!next || seenDirs.has(next)) continue
    seenDirs.add(next)
    queue.push({ dir: next, depth: 0 })
  }

  let scannedDirs = 0
  while (queue.length > 0 && scannedDirs < maxDirs) {
    const current = queue.shift()
    if (!current) break
    scannedDirs += 1
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const full = path.join(current.dir, entry.name)
      if (entry.isFile()) {
        if (entry.name.toLowerCase() === binaryName.toLowerCase() && isExistingFile(full) && canRunCommand(full)) {
          return full
        }
        continue
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        const normalized = path.resolve(full)
        if (!seenDirs.has(normalized)) {
          seenDirs.add(normalized)
          queue.push({ dir: normalized, depth: current.depth + 1 })
        }
      }
    }
  }

  return null
}

function findFfmpegBinary(): string | null {
  if (ffmpegBinaryCache) {
    if (ffmpegBinaryCache === 'ffmpeg') {
      if (canRunCommand('ffmpeg')) return ffmpegBinaryCache
      ffmpegBinaryCache = undefined
    } else if (isExistingFile(ffmpegBinaryCache) && canRunCommand(ffmpegBinaryCache)) {
      return ffmpegBinaryCache
    } else {
      ffmpegBinaryCache = undefined
    }
  }

  const ext = process.platform === 'win32' ? '.exe' : ''
  const binaryName = `ffmpeg${ext}`
  const resourceRoot = process.resourcesPath || ''
  const exeDir = path.dirname(process.execPath || '')
  const cwdDir = process.cwd()
  const sdkContainer = getSdkContainerPath()
  const sdkRoot = getSdkRootPath()
  const envSdkRoot = String(process.env.MRT_SDK_ROOT || '').trim()
  const envTypesDir = String(process.env.MRT_TYPES_DIR || '').trim()
  const localSdkRoot = path.resolve(deps.appDir, '../SDK')
  const installerRoot = resourceRoot ? path.join(resourceRoot, 'ffmpeg-installer') : ''
  const inspectedCandidates: string[] = []
  const appendInspect = (candidate: string) => {
    const next = String(candidate || '').trim()
    if (!next) return
    if (!inspectedCandidates.includes(next)) inspectedCandidates.push(next)
  }
  const tryReturnCandidate = (candidate: string): string | null => {
    const expanded = expandAsarExecutableCandidates(candidate)
    for (const p of expanded) {
      appendInspect(p)
      if (isExistingFile(p) && canRunCommand(p)) {
        ffmpegBinaryCache = p
        return p
      }
    }
    return null
  }

  const envCandidates = [
    process.env.MRT_FFMPEG_PATH,
    process.env.MRT_FFMPEG,
    process.env.FFMPEG_PATH,
    resourceRoot ? path.join(resourceRoot, 'ffmpeg', binaryName) : '',
    resourceRoot ? path.join(resourceRoot, 'ffmpeg', 'bin', binaryName) : '',
    resourceRoot ? path.join(resourceRoot, 'ffmpeg-installer', binaryName) : '',
    resourceRoot ? path.join(resourceRoot, 'ffmpeg-installer', 'bin', binaryName) : '',
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean)

  for (const candidate of envCandidates) {
    const resolved = tryReturnCandidate(candidate)
    if (resolved) return resolved
  }

  const directSdkToolCandidates = [
    path.join(sdkContainer, 'Tool', 'FFmpeg', 'bin', binaryName),
    path.join(sdkContainer, 'Tool', 'FFmpeg', binaryName),
    path.join(sdkContainer, 'Tool', 'ffmpeg', 'bin', binaryName),
    path.join(sdkContainer, 'Tool', 'ffmpeg', binaryName),
    path.join(sdkContainer, 'tool', 'FFmpeg', 'bin', binaryName),
    path.join(sdkContainer, 'tool', 'FFmpeg', binaryName),
    path.join(sdkContainer, 'tool', 'ffmpeg', 'bin', binaryName),
    path.join(sdkContainer, 'tool', 'ffmpeg', binaryName),
    path.join(path.resolve(sdkRoot, '../../../../..'), 'Tool', 'FFmpeg', 'bin', binaryName),
    path.join(path.resolve(sdkRoot, '../../../../..'), 'tool', 'FFmpeg', 'bin', binaryName),
    path.join(path.resolve(sdkRoot, '../../../../..'), 'Tool', 'ffmpeg', 'bin', binaryName),
    path.join(path.resolve(sdkRoot, '../../../../..'), 'tool', 'ffmpeg', 'bin', binaryName),
  ]
  for (const candidate of directSdkToolCandidates) {
    const resolved = tryReturnCandidate(candidate)
    if (resolved) return resolved
  }

  try {
    const installer = deps.requireModule('@ffmpeg-installer/ffmpeg')
    const fromInstaller = String(installer?.path || '').trim()
    if (fromInstaller) {
      const resolved = tryReturnCandidate(fromInstaller)
      if (resolved) return resolved
    }
  } catch {
  }

  const bases = new Set<string>([
    sdkContainer,
    path.join(sdkContainer, 'Tool', 'FFmpeg'),
    path.join(sdkContainer, 'Tool'),
    path.join(sdkContainer, 'tool', 'FFmpeg'),
    path.join(sdkContainer, 'tool'),
    exeDir,
    path.resolve(exeDir, 'resources'),
    path.resolve(exeDir, '../resources'),
    cwdDir,
    deps.appDir,
    path.resolve(deps.appDir, '..'),
    sdkRoot,
    path.dirname(sdkRoot),
    path.resolve(sdkRoot, '..'),
    path.resolve(sdkRoot, '../..'),
    path.resolve(sdkRoot, '../../..'),
    path.resolve(sdkRoot, '../../../..'),
    path.resolve(sdkRoot, '../../../../..'),
    envSdkRoot,
    path.dirname(envSdkRoot),
    envTypesDir,
    path.dirname(envTypesDir),
    localSdkRoot,
    path.resolve(localSdkRoot, 'Tool'),
    path.resolve(localSdkRoot, 'tool'),
  ])
  if (resourceRoot) {
    bases.add(resourceRoot)
    bases.add(path.join(resourceRoot, 'SDK'))
    bases.add(installerRoot)
  }

  const scannedCandidates: string[] = []
  for (const base of bases) {
    const root = path.resolve(base)
    scannedCandidates.push(path.join(root, binaryName))
    scannedCandidates.push(path.join(root, 'bin', binaryName))
    scannedCandidates.push(path.join(root, 'ffbuild', binaryName))
    scannedCandidates.push(path.join(root, 'Tool', binaryName))
    scannedCandidates.push(path.join(root, 'Tool', 'bin', binaryName))
    scannedCandidates.push(path.join(root, 'tool', binaryName))
    scannedCandidates.push(path.join(root, 'tool', 'bin', binaryName))
    scannedCandidates.push(path.join(root, 'ffmpeg-installer', binaryName))
    scannedCandidates.push(path.join(root, 'ffmpeg-installer', 'bin', binaryName))
    scannedCandidates.push(path.join(root, 'ffmpeg-installer', 'win32-x64', binaryName))
    scannedCandidates.push(path.join(root, 'ffmpeg-installer', 'win32-ia32', binaryName))

    const toolDirs = [path.join(root, 'Tool'), path.join(root, 'tool')]
    for (const toolDir of toolDirs) {
      try {
        const entries = fs.readdirSync(toolDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          if (!entry.name.toLowerCase().startsWith('ffmpeg')) continue
          const ffmpegDir = path.join(toolDir, entry.name)
          scannedCandidates.push(path.join(ffmpegDir, binaryName))
          scannedCandidates.push(path.join(ffmpegDir, 'bin', binaryName))
          scannedCandidates.push(path.join(ffmpegDir, 'ffbuild', binaryName))
        }
      } catch {
      }
    }

    const installerDirs = [path.join(root, 'ffmpeg-installer'), installerRoot].filter(Boolean)
    for (const dir of installerDirs) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const ffRoot = path.join(dir, entry.name)
          scannedCandidates.push(path.join(ffRoot, binaryName))
          scannedCandidates.push(path.join(ffRoot, 'bin', binaryName))
          scannedCandidates.push(path.join(ffRoot, 'ffbuild', binaryName))
        }
      } catch {
      }
    }
  }

  for (const candidate of scannedCandidates) {
    const resolved = tryReturnCandidate(candidate)
    if (resolved) return resolved
  }

  if (process.platform === 'win32') {
    const programFilesRoots = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA,
    ]
      .map((v) => String(v || '').trim())
      .filter(Boolean)

    const winCommonCandidates: string[] = []
    for (const root of programFilesRoots) {
      winCommonCandidates.push(path.join(root, 'ffmpeg', 'bin', 'ffmpeg.exe'))
      winCommonCandidates.push(path.join(root, 'FFmpeg', 'bin', 'ffmpeg.exe'))
      winCommonCandidates.push(path.join(root, 'ffmpeg.exe'))
    }
    winCommonCandidates.push('C:\\ffmpeg\\bin\\ffmpeg.exe')
    winCommonCandidates.push('C:\\ffmpeg\\ffmpeg.exe')

    for (const candidate of winCommonCandidates) {
      const resolved = tryReturnCandidate(candidate)
      if (resolved) return resolved
    }

    const recursiveSearchRoots = [
      exeDir,
      path.resolve(exeDir, 'resources'),
      resourceRoot,
      cwdDir,
      path.resolve(deps.appDir, '..'),
    ].filter(Boolean)
    const treeMatch = findFfmpegInDirectoryTree({
      roots: recursiveSearchRoots,
      binaryName,
      maxDepth: 5,
      maxDirs: 2600,
    })
    if (treeMatch) {
      ffmpegBinaryCache = treeMatch
      return treeMatch
    }
  }

  if (canRunCommand('ffmpeg')) {
    ffmpegBinaryCache = 'ffmpeg'
    return 'ffmpeg'
  }

  if (!ffmpegLookupLogged) {
    ffmpegLookupLogged = true
    console.warn('[ffmpeg] binary not found after lookup', {
      processExecPath: process.execPath,
      processCwd: cwdDir,
      resourcesPath: resourceRoot || null,
      inspectedSample: inspectedCandidates.slice(0, 40),
      inspectedCount: inspectedCandidates.length,
    })
  }
  return null
}

function toFfmpegSeconds(value: number): string {
  return Math.max(0, value).toFixed(3)
}

function buildAtempoFilterForSlowdown(slowDownFactor: number): string {
  const factor = Number.isFinite(slowDownFactor) && slowDownFactor > 0 ? slowDownFactor : 1
  let target = 1 / factor
  const chain: string[] = []

  while (target < 0.5) {
    chain.push('atempo=0.5')
    target /= 0.5
  }
  while (target > 2) {
    chain.push('atempo=2.0')
    target /= 2
  }
  chain.push(`atempo=${target.toFixed(6)}`)
  return chain.join(',')
}

async function repairVideoToH264(sourcePath: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const ffmpegBin = findFfmpegBinary()
  if (!ffmpegBin) {
    return { ok: false, message: '未找到 ffmpeg，无法修复视频编码' }
  }

  const resolvedSourcePath = path.resolve(sourcePath)
  const useAsciiStaging = process.platform === 'win32' && hasNonAsciiPath(resolvedSourcePath)
  const ffmpegInputPath = useAsciiStaging ? await ensureAsciiMediaCachePath(resolvedSourcePath) : resolvedSourcePath
  try {
    const stat = await fs.promises.stat(resolvedSourcePath)
    if (!stat.isFile()) {
      return { ok: false, message: '视频文件不存在或不可读' }
    }
  } catch {
    return { ok: false, message: '视频文件不存在或不可读' }
  }

  const ext = path.extname(resolvedSourcePath).toLowerCase()
  if (ext !== '.mp4') {
    return { ok: false, message: '当前仅支持修复 MP4 视频' }
  }

  const dir = path.dirname(resolvedSourcePath)
  const base = path.basename(resolvedSourcePath, ext)
  const ffmpegTempDir = useAsciiStaging ? path.dirname(ffmpegInputPath) : dir
  const tempOut = path.join(ffmpegTempDir, `${base}.repair_${Date.now()}.tmp.mp4`)
  const replaceOut = path.join(dir, `${base}.repair_apply_${Date.now()}.tmp.mp4`)

  const args: string[] = [
    '-y',
    '-i',
    ffmpegInputPath,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    tempOut,
  ]

  try {
    await runCommand(ffmpegBin, args)
    const outStat = await fs.promises.stat(tempOut)
    if (!outStat.isFile() || outStat.size <= 0) {
      try {
        await fs.promises.unlink(tempOut)
      } catch {
      }
      return { ok: false, message: '修复后的视频为空文件' }
    }
    if (path.resolve(tempOut) === path.resolve(resolvedSourcePath)) {
      return { ok: true }
    }
    await fs.promises.copyFile(tempOut, replaceOut)
    await fs.promises.rename(replaceOut, resolvedSourcePath)
    try {
      await fs.promises.unlink(tempOut)
    } catch {
    }
    return { ok: true }
  } catch (error: unknown) {
    try {
      await fs.promises.unlink(tempOut)
    } catch {
    }
    try {
      await fs.promises.unlink(replaceOut)
    } catch {
    }
    return { ok: false, message: `ffmpeg 修复失败：${getErrorDetails(error).message || '未知错误'}` }
  }
}

type DesktopVideoCompatibilityProbe = {
  compatible: boolean
  codec: string | null
  pixelFormat: string | null
  detail: string
}

async function probeDesktopVideoCompatibility(sourcePath: string): Promise<DesktopVideoCompatibilityProbe> {
  const ffmpegBin = findFfmpegBinary()
  if (!ffmpegBin) {
    return {
      compatible: false,
      codec: null,
      pixelFormat: null,
      detail: '未找到 ffmpeg，无法探测视频编码',
    }
  }

  const resolvedSourcePath = path.resolve(sourcePath)
  const probeInputPath =
    process.platform === 'win32' && hasNonAsciiPath(resolvedSourcePath)
      ? await ensureAsciiMediaCachePath(resolvedSourcePath)
      : resolvedSourcePath
  const output = await runCommandCapture(ffmpegBin, ['-hide_banner', '-i', probeInputPath], 5000)
  const lines = output.split(/\r?\n/)
  const videoLine = lines.find((line) => /Video:/i.test(line)) || ''
  if (!videoLine) {
    return {
      compatible: false,
      codec: null,
      pixelFormat: null,
      detail: '未识别到视频流信息',
    }
  }

  const match = videoLine.match(/Video:\s*([^,\s]+)[^,]*,\s*([a-zA-Z0-9_]+)/i)
  const codec = match?.[1]?.toLowerCase() || null
  const pixelFormat = match?.[2]?.toLowerCase() || null
  const compatible =
    codec === 'h264' &&
    typeof pixelFormat === 'string' &&
    (pixelFormat.startsWith('yuv420p') || pixelFormat.startsWith('yuvj420p'))
  return {
    compatible,
    codec,
    pixelFormat,
    detail: videoLine.trim(),
  }
}

function getRecordMetaPathForMp4Path(mp4Path: string): string {
  const resolved = path.resolve(mp4Path)
  const ext = path.extname(resolved)
  return path.join(path.dirname(resolved), `${path.basename(resolved, ext)}.meta.json`)
}

async function updateDesktopTranscodeMeta(
  mp4Path: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const metaPath = getRecordMetaPathForMp4Path(mp4Path)
  try {
    const raw = await fs.promises.readFile(metaPath, 'utf-8')
    const parsed = JSON.parse(raw)
    const next = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    Object.assign(next, patch, { updatedAt: new Date().toISOString() })
    await writeTextFileAtomic(metaPath, `${JSON.stringify(next, null, 2)}\n`)
  } catch {
  }
}

type NormalizeRecordVideoResult = {
  path: string
  status: 'compatible' | 'transcoded' | 'failed'
  codecBefore: string | null
  codecAfter: string | null
  message?: string
}

async function normalizeRecordVideoForDesktop(mp4Path: string): Promise<NormalizeRecordVideoResult> {
  const before = await probeDesktopVideoCompatibility(mp4Path)
  logMainVideoDebug('project-import-probe-before', {
    mp4Path,
    hasNonAsciiPath: hasNonAsciiPath(mp4Path),
    compatible: before.compatible,
    codec: before.codec,
    pixelFormat: before.pixelFormat,
    detail: before.detail,
  })
  if (before.compatible) {
    await updateDesktopTranscodeMeta(mp4Path, {
      videoCodec: before.codec,
      desktopVideoCodec: before.codec,
      desktopVideoPixelFormat: before.pixelFormat,
      desktopTranscodeRequired: false,
      desktopTranscodeSucceeded: true,
      desktopTranscodeCheckedAt: new Date().toISOString(),
    })
    return {
      path: mp4Path,
      status: 'compatible',
      codecBefore: before.codec,
      codecAfter: before.codec,
      message: before.detail,
    }
  }

  const repaired = await repairVideoToH264(mp4Path)
  if (!repaired.ok) {
    const message = 'message' in repaired ? repaired.message : '未知错误'
    logMainVideoDebug('project-import-repair-failed', {
      mp4Path,
      hasNonAsciiPath: hasNonAsciiPath(mp4Path),
      codecBefore: before.codec,
      pixelFormatBefore: before.pixelFormat,
      message,
    })
    await updateDesktopTranscodeMeta(mp4Path, {
      desktopVideoCodec: before.codec,
      desktopVideoPixelFormat: before.pixelFormat,
      desktopTranscodeRequired: true,
      desktopTranscodeSucceeded: false,
      desktopTranscodeCheckedAt: new Date().toISOString(),
      desktopTranscodeError: message,
    })
    return {
      path: mp4Path,
      status: 'failed',
      codecBefore: before.codec,
      codecAfter: before.codec,
      message,
    }
  }

  const after = await probeDesktopVideoCompatibility(mp4Path)
  logMainVideoDebug('project-import-probe-after', {
    mp4Path,
    hasNonAsciiPath: hasNonAsciiPath(mp4Path),
    compatible: after.compatible,
    codec: after.codec,
    pixelFormat: after.pixelFormat,
    detail: after.detail,
  })
  if (!after.compatible) {
    const message = `转码已执行，但结果仍非桌面兼容格式：${after.detail || '未知视频流'}`
    await updateDesktopTranscodeMeta(mp4Path, {
      videoCodec: after.codec ?? before.codec,
      desktopVideoCodec: after.codec ?? before.codec,
      desktopVideoPixelFormat: after.pixelFormat,
      desktopTranscodeRequired: true,
      desktopTranscodeSucceeded: false,
      desktopTranscodeCheckedAt: new Date().toISOString(),
      desktopTranscodeAt: new Date().toISOString(),
      desktopTranscodeError: message,
    })
    return {
      path: mp4Path,
      status: 'failed',
      codecBefore: before.codec,
      codecAfter: after.codec,
      message,
    }
  }

  await updateDesktopTranscodeMeta(mp4Path, {
    videoCodec: after.codec ?? before.codec,
    transcodeSucceeded: true,
    sourceVideoKind: 'transcoded',
    desktopVideoCodec: after.codec ?? before.codec,
    desktopVideoPixelFormat: after.pixelFormat,
    desktopTranscodeRequired: true,
    desktopTranscodeSucceeded: true,
    desktopTranscodeCheckedAt: new Date().toISOString(),
    desktopTranscodeAt: new Date().toISOString(),
    desktopTranscodeError: '',
    videoPipeline: 'desktop-h264-transcode',
  })
  return {
    path: mp4Path,
    status: 'transcoded',
    codecBefore: before.codec,
    codecAfter: after.codec,
    message: `${before.codec || 'unknown'} -> ${after.codec || 'unknown'}`,
  }
}

async function normalizeProjectRecordVideos(
  projectDir: string,
  deviceType: '桌面式' | '眼镜式' = '桌面式',
  onProgress?: (payload: {
    phase: 'preparing' | 'transcoding'
    progress: number
    label: string
    currentFile?: string
    total: number
    completed: number
    compatible: number
    transcoded: number
    failed: number
  }) => void,
): Promise<{
  ok: true
  scanned: number
  compatible: number
  transcoded: number
  failed: number
  results: NormalizeRecordVideoResult[]
} | {
  ok: false
  message: string
  scanned: number
  compatible: number
  transcoded: number
  failed: number
  results: NormalizeRecordVideoResult[]
}> {
  const resolvedProjectDir = path.resolve(projectDir)
  const normalizedDeviceType = normalizeProjectDeviceType(deviceType)
  if (normalizedDeviceType !== '眼镜式') {
    logMainVideoDebug('project-import-skip-normalize-non-glasses', {
      projectDir: resolvedProjectDir,
      deviceType: normalizedDeviceType,
    })
    return {
      ok: true,
      scanned: 0,
      compatible: 0,
      transcoded: 0,
      failed: 0,
      results: [],
    }
  }
  const resolveRecordingsDirs = async (): Promise<string[]> => {
    const candidates: string[] = []
    const seen = new Set<string>()
    const addDir = (dirPath: string) => {
      const resolved = path.resolve(dirPath)
      if (seen.has(resolved)) return
      seen.add(resolved)
      candidates.push(resolved)
    }

    addDir(path.join(resolvedProjectDir, 'recordings'))

    const experimentsRoot = path.join(resolvedProjectDir, 'experiments')
    try {
      const experimentEntries = await fs.promises.readdir(experimentsRoot, { withFileTypes: true })
      for (const entry of experimentEntries) {
        if (!entry.isDirectory()) continue
        addDir(path.join(experimentsRoot, entry.name, 'recordings'))
      }
    } catch {
    }

    const existing: string[] = []
    for (const candidate of candidates) {
      try {
        const stat = await fs.promises.stat(candidate)
        if (stat.isDirectory()) existing.push(candidate)
      } catch {
      }
    }
    return existing
  }

  onProgress?.({
    phase: 'preparing',
    progress: 0.08,
    label: '正在扫描录制视频',
    total: 0,
    completed: 0,
    compatible: 0,
    transcoded: 0,
    failed: 0,
  })
  const recordingsDirs = await resolveRecordingsDirs()
  logMainVideoDebug('project-import-scan-dirs', {
    projectDir: resolvedProjectDir,
    recordingsDirs,
  })
  const targets: string[] = []
  for (const recordingsDir of recordingsDirs) {
    let entries: fs.Dirent[] = []
    try {
      entries = await fs.promises.readdir(recordingsDir, { withFileTypes: true })
    } catch {
      continue
    }
    const dirTargets = entries
      .filter((entry) => entry.isFile() && /\.mp4$/i.test(entry.name) && !/\.bak\.mp4$/i.test(entry.name) && !/\.tmp\.mp4$/i.test(entry.name))
      .map((entry) => path.join(recordingsDir, entry.name))
    targets.push(...dirTargets)
  }

  const results: NormalizeRecordVideoResult[] = []
  let compatible = 0
  let transcoded = 0
  let failed = 0
  const total = targets.length
  logMainVideoDebug('project-import-scan-targets', {
    projectDir: resolvedProjectDir,
    total,
    targets,
  })
  onProgress?.({
    phase: 'transcoding',
    progress: total > 0 ? 0.14 : 0.82,
    label: total > 0 ? '正在进行桌面端转码检查' : '未发现需要检查的录制视频',
    total,
    completed: 0,
    compatible: 0,
    transcoded: 0,
    failed: 0,
  })
  for (let index = 0; index < targets.length; index += 1) {
    const mp4Path = targets[index]
    const currentFile = path.relative(resolvedProjectDir, mp4Path).replace(/\\/g, '/')
    const progressBase = 0.14
    const progressSpan = 0.72
    const beforeProgress = progressBase + (index / Math.max(total, 1)) * progressSpan
    onProgress?.({
      phase: 'transcoding',
      progress: beforeProgress,
      label: `正在检查 ${currentFile}`,
      currentFile,
      total,
      completed: index,
      compatible,
      transcoded,
      failed,
    })
    const result = await normalizeRecordVideoForDesktop(mp4Path)
    results.push(result)
    if (result.status === 'compatible') compatible += 1
    if (result.status === 'transcoded') transcoded += 1
    if (result.status === 'failed') failed += 1
    const afterProgress = progressBase + ((index + 1) / Math.max(total, 1)) * progressSpan
    onProgress?.({
      phase: 'transcoding',
      progress: afterProgress,
      label:
        result.status === 'failed'
          ? `${currentFile} 转码失败`
          : result.status === 'transcoded'
            ? `${currentFile} 已完成转码`
            : `${currentFile} 已确认兼容`,
      currentFile,
      total,
      completed: index + 1,
      compatible,
      transcoded,
      failed,
    })
  }
  return {
    ok: true,
    scanned: results.length,
    compatible,
    transcoded,
    failed,
    results,
  }
}

  return {
    safeTimestampForPath,
    sanitizePathSegment,
    uniqueDirPath,
    uniqueFilePath,
    isSubPath,
    runCommand,
    runCommandCapture,
    probeMediaDurationSeconds,
    createZipArchive,
    findFfmpegBinary,
    // Resolve ffmpeg eagerly at app boot so the (synchronous, probing) lookup
    // does not block user-triggered recording/export on the hot path.
    prewarmFfmpegBinary: () => {
      try {
        findFfmpegBinary()
      } catch (error) {
        console.error('[mediaToolkit] ffmpeg prewarm failed', error)
      }
    },
    toFfmpegSeconds,
    buildAtempoFilterForSlowdown,
    repairVideoToH264,
    normalizeProjectRecordVideos,
  }
}
