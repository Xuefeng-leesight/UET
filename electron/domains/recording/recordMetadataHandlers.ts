import { ipcMain } from 'electron'
import * as fs from 'node:fs'
import path from 'node:path'
import { validateUtf8Path } from '../filesystem/pathValidation'
import { et28CalibrationQualityScores, parseEt28CalibrationQuality } from '../../../shared/domain/calibrationScores'

export type RecordMetadataDependencies = {
  normalizeDataSamplingRateHz: (value: unknown) => number
}

export function isPathInsideDirectory(directory: string, targetPath: string): boolean {
  const resolvedDirectory = path.resolve(directory) + path.sep
  const resolvedTarget = path.resolve(targetPath)
  const directoryCompare = process.platform === 'win32' ? resolvedDirectory.toLowerCase() : resolvedDirectory
  const targetCompare = process.platform === 'win32' ? resolvedTarget.toLowerCase() : resolvedTarget
  return targetCompare.startsWith(directoryCompare)
}

export function registerRecordMetadataHandlers(dependencies: RecordMetadataDependencies): void {
  const { normalizeDataSamplingRateHz } = dependencies
  ipcMain.handle('delete-recording', async (_event, input: unknown) => {
    const payload = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    const { projectDir, recordName, recordPaths } = payload
    if (
      !projectDir ||
      typeof projectDir !== 'string' ||
      !recordName ||
      typeof recordName !== 'string'
    ) {
      return { ok: false, message: '参数错误', deleted: [], missing: [] }
    }
  
    const recordingsDir = path.join(projectDir, 'recordings')
    const facialRoot = path.join(projectDir, 'facial-analysis')
    const baseName = path.basename(String(recordName || '').trim())
    if (!baseName) {
      return { ok: false, message: '记录名无效', deleted: [], missing: [] }
    }
  
    const candidates = new Set<string>()
    const directoryCandidates = new Set<string>()
    const addCandidate = (targetPath: string) => {
      if (!targetPath || typeof targetPath !== 'string') return
      const resolved = path.resolve(targetPath)
      if (!isPathInsideDirectory(recordingsDir, resolved)) return
      candidates.add(resolved)
    }
    const facialRecordDir = path.resolve(path.join(facialRoot, baseName))
    if (isPathInsideDirectory(facialRoot, facialRecordDir)) directoryCandidates.add(facialRecordDir)
    // Pupil raw data belongs to this one recording, never to the vendor SDK.
    try {
      const pupilMeta = JSON.parse(await fs.promises.readFile(path.join(recordingsDir, `${baseName}.meta.json`), 'utf8'))
      const sidecar = path.resolve(recordingsDir, `${baseName}.pupil`)
      if (pupilMeta?.deviceModel === 'PupilCore' && isPathInsideDirectory(recordingsDir, sidecar)) {
        const stat = await fs.promises.lstat(sidecar)
        if (stat.isDirectory() && !stat.isSymbolicLink()) directoryCandidates.add(sidecar)
      }
    } catch {
      // Older records have no Pupil sidecar.
    }
  
    const suffixes = [
      '.mp4',
      '.bak.mp4',
      '.csv',
      '.eye_samples.csv',
      '.meta.json',
      '.points.index.json',
      '.analysis-events.csv',
      '.fixation.events.jsonl',
      '.gaze.blocks.jsonl',
    ]
    for (const suffix of suffixes) {
      addCandidate(path.join(recordingsDir, `${baseName}${suffix}`))
    }
  
    if (Array.isArray(recordPaths)) {
      for (const maybePath of recordPaths) {
        if (typeof maybePath === 'string' && maybePath.trim().length > 0) {
          const trimmed = maybePath.trim()
          addCandidate(trimmed)
          if (/\.mp4$/i.test(trimmed)) {
            addCandidate(trimmed.replace(/\.mp4$/i, '.bak.mp4'))
          }
        }
      }
    }
  
    if (candidates.size === 0 && directoryCandidates.size === 0) {
      return { ok: false, message: '未找到可删除文件', deleted: [], missing: [] }
    }
  
    const deleted: string[] = []
    const missing: string[] = []
  
    for (const fp of candidates) {
      try {
        const stat = await fs.promises.stat(fp)
        if (!stat.isFile()) {
          missing.push(fp)
          continue
        }
        await fs.promises.unlink(fp)
        deleted.push(fp)
      } catch {
        missing.push(fp)
      }
    }
    for (const dirPath of directoryCandidates) {
      try {
        const stat = await fs.promises.stat(dirPath)
        if (!stat.isDirectory()) {
          missing.push(dirPath)
          continue
        }
        await fs.promises.rm(dirPath, { recursive: true, force: false })
        deleted.push(dirPath)
      } catch {
        missing.push(dirPath)
      }
    }
  
    return { ok: true, deleted, missing }
  })
  
  
  ipcMain.handle('save-record-meta', async (_event, input: unknown) => {
    const payload = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    const { projectDir, recordName, meta } = payload
    if (!projectDir || typeof projectDir !== 'string' || !recordName || typeof recordName !== 'string') {
      return { ok: false, message: '参数错误' }
    }
  
    // Validate UTF-8 path encoding
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, message: `路径验证失败：${pathValidation.error}` }
    }
  
    const recordingsDir = path.join(projectDir, 'recordings')
    const outPath = path.join(recordingsDir, `${recordName}.meta.json`)
    if (!isPathInsideDirectory(recordingsDir, outPath)) {
      return { ok: false, message: '非法路径' }
    }
  
    let existingMeta: Record<string, unknown> = {}
    try {
      const raw = await fs.promises.readFile(outPath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        existingMeta = parsed as Record<string, unknown>
      }
    } catch {
    }
  
    const incomingMeta = meta && typeof meta === 'object' ? { ...(meta as Record<string, unknown>) } : {}
    const et28Quality = existingMeta.deviceModel === 'HH_ET28'
      && existingMeta.calibrationProvider === 'HH_ET28'
      && existingMeta.calibrationVerified === true
      ? parseEt28CalibrationQuality(existingMeta.calibrationQuality) : null
    if (et28Quality) {
      const scores = et28CalibrationQualityScores(et28Quality)
      // The recorder captured this calibration before acquisition. A later
      // monitor session (or its empty fields) cannot replace that evidence.
      Object.assign(incomingMeta, {
        deviceModel: existingMeta.deviceModel,
        calibrationProvider: existingMeta.calibrationProvider,
        calibrationVerified: true,
        calibrationQuality: existingMeta.calibrationQuality,
        calibrationLeftScore: scores.left,
        calibrationRightScore: scores.right,
      })
      delete incomingMeta.calibrationScores
    }
    const huahong = existingMeta.deviceModel === 'HH_ET28' || existingMeta.deviceModel === 'HH_ET10C'
    const measuredRate = huahong && typeof existingMeta.gazeRows === 'number' && Number.isFinite(existingMeta.gazeRows)
      && existingMeta.gazeRows >= 0 && typeof existingMeta.durationSeconds === 'number'
      && Number.isFinite(existingMeta.durationSeconds) && existingMeta.durationSeconds > 0
      ? existingMeta.gazeRows / existingMeta.durationSeconds
      : existingMeta.gazeMessageRateHz ?? existingMeta.samplingRateHz
    if ((existingMeta.deviceModel === 'PupilCore' || huahong) && typeof measuredRate === 'number' && Number.isFinite(measuredRate) && measuredRate > 0) {
      // The finalized recorder owns measured rates; renderer settings and
      // rounded list values must not replace that measurement.
      incomingMeta.samplingRateHz = measuredRate
    } else if (Object.prototype.hasOwnProperty.call(incomingMeta, 'samplingRateHz')) {
      incomingMeta.samplingRateHz = normalizeDataSamplingRateHz(incomingMeta.samplingRateHz)
    }
    if (Object.prototype.hasOwnProperty.call(incomingMeta, 'configuredSamplingRateHz')) {
      incomingMeta.configuredSamplingRateHz = normalizeDataSamplingRateHz(incomingMeta.configuredSamplingRateHz)
    }
    const store = {
      ...existingMeta,
      ...incomingMeta,
      version: 1,
      updatedAt: new Date().toISOString(),
    } as Record<string, unknown>
  
    try {
      await fs.promises.mkdir(recordingsDir, { recursive: true })
      await fs.promises.writeFile(outPath, JSON.stringify(store, null, 2), 'utf-8')
  
      return { ok: true, path: outPath }
    } catch (error: unknown) {
      return { ok: false, message: `写入记录 meta 失败：${error instanceof Error ? error.message : '未知错误'}` }
    }
  })
  
}
