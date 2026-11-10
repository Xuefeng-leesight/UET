import { ipcMain, shell } from 'electron'
import * as fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateUtf8Path } from '../filesystem/pathValidation'

type NormalizeRecordVideoResult = {
  path: string
  status: 'compatible' | 'transcoded' | 'failed'
  codecBefore: string | null
  codecAfter: string | null
  message?: string
}

type NormalizeProgress = {
  phase: 'preparing' | 'transcoding'
  progress: number
  label: string
  currentFile?: string
  total: number
  completed: number
  compatible: number
  transcoded: number
  failed: number
}

type NormalizeProjectResult = {
  ok: boolean
  message?: string
  scanned: number
  compatible: number
  transcoded: number
  failed: number
  results: NormalizeRecordVideoResult[]
}

export type RecordMediaDependencies = {
  buildLocalResourceUrl: (filePath: string) => Promise<string>
  hasNonAsciiPath: (value: string) => boolean
  logVideoDebug: (event: string, details?: unknown) => void
  normalizeProjectDeviceType: (value: unknown) => '桌面式' | '眼镜式'
  normalizeProjectRecordVideos: (
    projectDir: string,
    deviceType: '桌面式' | '眼镜式',
    onProgress: (payload: NormalizeProgress) => void,
  ) => Promise<NormalizeProjectResult>
  repairVideoToH264: (sourcePath: string) => Promise<{ ok: true } | { ok: false; message: string }>
  stimulusImageExtensions: string[]
  stimulusVideoExtensions: string[]
}

const PROJECT_IMPORT_PROGRESS_CHANNEL = 'project-import-progress'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误'
}

function getErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error ? String(error.code || '') || null : null
}

export function registerRecordMediaHandlers(dependencies: RecordMediaDependencies): void {
  const {
    buildLocalResourceUrl,
    hasNonAsciiPath,
    logVideoDebug: logMainVideoDebug,
    normalizeProjectDeviceType,
    normalizeProjectRecordVideos,
    repairVideoToH264,
    stimulusImageExtensions: STIMULUS_IMAGE_EXTENSIONS,
    stimulusVideoExtensions: STIMULUS_VIDEO_EXTENSIONS,
  } = dependencies
  ipcMain.handle('get-stimulus-media-url', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const projectDir = typeof payload?.projectDir === 'string' ? payload.projectDir.trim() : ''
    const stimulusId = typeof payload?.stimulusId === 'string' ? payload.stimulusId.trim() : ''
    const sourceUrl = typeof payload?.url === 'string' ? payload.url.trim() : ''
    const mediaType = typeof payload?.mediaType === 'string' ? payload.mediaType.trim().toLowerCase() : 'unknown'
  
    if (!projectDir) {
      return { ok: false, url: null }
    }
  
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, url: null }
    }
  
    if (sourceUrl && /^(https?:|data:|blob:|local-resource:)/i.test(sourceUrl)) {
      return { ok: true, url: sourceUrl }
    }
  
    const stimuliDir = path.join(projectDir, 'stimuli')
    const safeDir = path.resolve(stimuliDir) + path.sep
    const safeDirCompare = process.platform === 'win32' ? safeDir.toLowerCase() : safeDir
  
    const toResolved = (p: string): string => path.resolve(p)
    const isInsideStimuliDir = (resolvedPath: string): boolean => {
      const compare = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath
      return compare.startsWith(safeDirCompare)
    }
  
    const candidatePaths: string[] = []
  
    if (sourceUrl) {
      if (/^file:/i.test(sourceUrl)) {
        try {
          const fp = fileURLToPath(sourceUrl)
          if (fp) candidatePaths.push(fp)
        } catch {
        }
      } else if (path.isAbsolute(sourceUrl)) {
        candidatePaths.push(sourceUrl)
      }
  
      try {
        let baseName = ''
        if (/^file:/i.test(sourceUrl)) {
          baseName = path.basename(fileURLToPath(sourceUrl))
        } else {
          const u = new URL(sourceUrl)
          baseName = path.basename(decodeURIComponent(String(u.pathname || '')))
        }
        if (baseName) {
          candidatePaths.push(path.join(stimuliDir, baseName))
        }
      } catch {
      }
    }
  
    if (stimulusId) {
      const videoExts = STIMULUS_VIDEO_EXTENSIONS
      const imageExts = STIMULUS_IMAGE_EXTENSIONS
      const allowedExts =
        mediaType === 'video'
          ? videoExts
          : mediaType === 'image'
            ? imageExts
            : [...videoExts, ...imageExts]
      for (const ext of allowedExts) {
        candidatePaths.push(path.join(stimuliDir, `${stimulusId}${ext}`))
      }
    }
  
    const deduped = Array.from(new Set(candidatePaths.map((p) => toResolved(p))))
    for (const candidate of deduped) {
      if (!isInsideStimuliDir(candidate)) continue
      try {
        const stat = await fs.promises.stat(candidate)
        if (!stat.isFile()) continue
        const url = await buildLocalResourceUrl(candidate)
        return { ok: true, url }
      } catch {
      }
    }
  
    return { ok: false, url: null }
  })
  
  ipcMain.handle('get-record-video-url', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const { projectDir, name, recordPath } = payload || {}
    if (!projectDir || typeof projectDir !== 'string') {
      console.log('[main] get-record-video-url invalid payload', payload)
      logMainVideoDebug('get-record-video-url-invalid-project', { payload })
      return { ok: false, url: null }
    }
  
    const recordingsDir = path.join(projectDir, 'recordings')
    const safeDir = path.resolve(recordingsDir) + path.sep
    const safeDirCompare = process.platform === 'win32' ? safeDir.toLowerCase() : safeDir
    const trimmedRecordPath = typeof recordPath === 'string' ? recordPath.trim() : ''
    const resolvedRecordPath = trimmedRecordPath ? path.resolve(trimmedRecordPath) : ''
    const resolvedRecordPathCompare =
      process.platform === 'win32' ? resolvedRecordPath.toLowerCase() : resolvedRecordPath
    const candidateEntries: Array<{ path: string; byRecordPath: boolean; source: 'recordPath' | 'recordings-name' }> = []
  
    // #region debug-point get-record-video-url-paths
    logMainVideoDebug('get-record-video-url-paths', {
      projectDir,
      name,
      recordPath,
      recordingsDir,
      safeDir,
      resolvedRecordPath,
      resolvedRecordPathInsideRecordings: Boolean(
        resolvedRecordPath && resolvedRecordPathCompare.startsWith(safeDirCompare),
      ),
    })
    // #endregion
  
    if (resolvedRecordPath) {
      candidateEntries.push({
        path: resolvedRecordPath,
        byRecordPath: true,
        source: 'recordPath',
      })
    }
  
    if (name && typeof name === 'string') {
      candidateEntries.push({
        path: path.join(recordingsDir, `${name}.mp4`),
        byRecordPath: false,
        source: 'recordings-name',
      })
    }
  
    if (candidateEntries.length === 0) {
      console.log('[main] get-record-video-url invalid fallback payload', payload)
      logMainVideoDebug('get-record-video-url-invalid-fallback', {
        payload,
        projectDir,
        recordingsDir,
      })
      return { ok: false, url: null }
    }
  
    logMainVideoDebug('get-record-video-url-candidates', {
      projectDir,
      name,
      recordPath,
      recordingsDir,
      safeDir,
      candidates: candidateEntries.map((entry) => ({
        candidate: entry.path,
        source: entry.source,
        candidateByRecordPath: entry.byRecordPath,
        insideRecordings: entry.byRecordPath
          ? resolvedRecordPathCompare.startsWith(safeDirCompare)
          : true,
        hasNonAsciiCandidate: hasNonAsciiPath(entry.path),
      })),
    })
  
    const failures: Array<Record<string, unknown>> = []
    // Containment: renderer-supplied recordPath must stay inside the project
    // directory; the recording-name fallback is constructed server-side.
    const projectDirResolved = path.resolve(projectDir)
    const projectDirCompare = process.platform === 'win32' ? projectDirResolved.toLowerCase() : projectDirResolved
    const isInsideProjectDir = (candidate: string): boolean => {
      const candidateResolved = path.resolve(candidate)
      const compare = process.platform === 'win32' ? candidateResolved.toLowerCase() : candidateResolved
      return compare === projectDirCompare || compare.startsWith(projectDirCompare + path.sep)
    }
    for (const entry of candidateEntries) {
      if (entry.byRecordPath && !isInsideProjectDir(entry.path)) {
        failures.push({
          candidate: entry.path,
          source: entry.source,
          candidateByRecordPath: entry.byRecordPath,
          message: '录制文件路径不在项目目录内，已拒绝',
          code: 'EPATH',
        })
        continue
      }
      try {
        await fs.promises.access(entry.path, fs.constants.F_OK)
        const stat = await fs.promises.stat(entry.path).catch(() => null)
        const url = await buildLocalResourceUrl(entry.path)
        console.log('[main] get-record-video-url success', { name, candidate: entry.path, url })
        logMainVideoDebug('get-record-video-url-success', {
          projectDir,
          name,
          recordPath,
          candidate: entry.path,
          source: entry.source,
          candidateByRecordPath: entry.byRecordPath,
          url,
          size: stat?.size ?? null,
          mtimeMs: stat ? Math.floor(stat.mtimeMs) : null,
          hasNonAsciiCandidate: hasNonAsciiPath(entry.path),
        })
        return { ok: true, url }
      } catch (error: unknown) {
        failures.push({
          candidate: entry.path,
          source: entry.source,
          candidateByRecordPath: entry.byRecordPath,
          message: getErrorMessage(error),
          code: getErrorCode(error),
        })
      }
    }
  
    console.log('[main] get-record-video-url not found', { name, candidateEntries })
    logMainVideoDebug('get-record-video-url-failed', {
      projectDir,
      name,
      recordPath,
      failures,
    })
    return { ok: false, url: null }
  })
  
  ipcMain.handle('repair-record-video', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const mp4Path = typeof payload?.mp4Path === 'string' ? payload.mp4Path.trim() : ''
    if (!mp4Path) {
      logMainVideoDebug('repair-record-video-invalid', { payload })
      return { ok: false, url: null, message: '参数错误：缺少 mp4Path' }
    }
  
    const resolved = path.resolve(mp4Path)
    logMainVideoDebug('repair-record-video-start', {
      mp4Path,
      resolved,
      hasNonAsciiPath: hasNonAsciiPath(resolved),
    })
    const repaired = await repairVideoToH264(resolved)
    if (!repaired.ok) {
      const errorMessage = 'message' in repaired ? repaired.message : '未知错误'
      console.warn('[main] repair-record-video failed', { resolved, message: errorMessage })
      logMainVideoDebug('repair-record-video-failed', {
        resolved,
        message: errorMessage,
      })
      return { ok: false, url: null, message: errorMessage }
    }
  
    try {
      const url = await buildLocalResourceUrl(resolved)
      console.log('[main] repair-record-video success', { resolved, url })
      logMainVideoDebug('repair-record-video-success', {
        resolved,
        url,
      })
      return { ok: true, url }
    } catch (error: unknown) {
      logMainVideoDebug('repair-record-video-url-failed', {
        resolved,
        message: getErrorMessage(error),
      })
      return { ok: false, url: null, message: `视频修复成功但生成 URL 失败：${getErrorMessage(error)}` }
    }
  })
  
  ipcMain.handle('normalize-project-record-videos', async (event, input: unknown) => {
    const payload = asRecord(input)
    const projectDir = typeof payload?.projectDir === 'string' ? payload.projectDir.trim() : ''
    const taskId = typeof payload?.taskId === 'string' ? payload.taskId.trim() : ''
    const deviceType = normalizeProjectDeviceType(payload?.deviceType)
    if (!projectDir) {
      return { ok: false, message: '参数错误：缺少 projectDir', scanned: 0, compatible: 0, transcoded: 0, failed: 0, results: [] }
    }
  
    const result = await normalizeProjectRecordVideos(projectDir, deviceType, (progressPayload) => {
      event.sender.send(PROJECT_IMPORT_PROGRESS_CHANNEL, {
        taskId,
        projectDir,
        ...progressPayload,
        updatedAt: Date.now(),
      })
    })
    if (!result.ok) {
      return result
    }
  
    return result
  })
  
  ipcMain.handle('show-in-finder', async (_event, input: unknown) => {
    const { path: targetPath } = asRecord(input)
    if (!targetPath || typeof targetPath !== 'string') {
      return { ok: false, message: '参数错误' }
    }
    const resolved = path.resolve(targetPath)
    try {
      const stat = await fs.promises.stat(resolved)
      if (stat.isDirectory()) {
        const err = await shell.openPath(resolved)
        if (err) return { ok: false, message: err }
        return { ok: true }
      }
      shell.showItemInFolder(resolved)
      return { ok: true }
    } catch {
      return { ok: false, message: '路径不存在' }
    }
  })
  
}
