import { ipcMain } from 'electron'
import * as fs from 'node:fs'
import path from 'node:path'
import { validateUtf8Path } from '../filesystem/pathValidation'

export type CalibrationDataDependencies = {
  formatExportCsvCell: (value: unknown) => unknown
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function registerCalibrationDataHandlers(dependencies: CalibrationDataDependencies): void {
  const { formatExportCsvCell } = dependencies
  ipcMain.handle('save-eye-data-csv', async (_event, input: unknown) => {
    const { projectDir, recordName, rows } = asRecord(input)
    if (!projectDir || typeof projectDir !== 'string' || !recordName || typeof recordName !== 'string' || !Array.isArray(rows)) {
      return { ok: false, message: '参数错误' }
    }
  
    // Validate UTF-8 path encoding
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, message: `路径验证失败：${pathValidation.error}` }
    }
  
    const recordingsDir = path.join(projectDir, 'recordings')
    const safeDir = path.resolve(recordingsDir) + path.sep
    const outPath = path.join(recordingsDir, `${recordName}.eye_samples.csv`)
    const safePath = path.resolve(outPath)
    if (!safePath.startsWith(safeDir)) {
      return { ok: false, message: '非法路径' }
    }
  
    const columns = [
      'timestamp',
      'recomGazeX',
      'recomGazeY',
      'leftGazeX',
      'leftGazeY',
      'rightGazeX',
      'rightGazeY',
      'leftPupilCenterX',
      'leftPupilCenterY',
      'leftPupilDiameter',
      'leftPupilDiameterMm',
      'rightPupilCenterX',
      'rightPupilCenterY',
      'rightPupilDiameter',
      'rightPupilDiameterMm',
      'leftBlink',
      'leftOpenness',
      'leftEyelidUp',
      'leftEyelidDown',
      'rightBlink',
      'rightOpenness',
      'rightEyelidUp',
      'rightEyelidDown',
      'fixationTimestampMs',
      'fixationDurationMs',
      'fixationTimestampUs',
      'fixationDurationUs',
      'fixationCount',
      'fixationState',
      'fixationCenterX',
      'fixationCenterY',
      'gazeVelocityMs',
      'saccadeAmplitude',
      'saccadeDurationMs',
      'saccadeVelocity',
      'saccadePeakVelocity',
      'stimulus',
      'triggerMark',
      'customMarker',
    ]
  
    const csvEscape = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v)
      if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
      return s
    }
  
    try {
      await fs.promises.mkdir(recordingsDir, { recursive: true })
      const outStream = fs.createWriteStream(outPath, { encoding: 'utf-8' })
      const writeLine = async (line: string) => {
        if (!outStream.write(line)) {
          await new Promise<void>((resolve) => outStream.once('drain', resolve))
        }
      }
      await writeLine('\uFEFF')
      await writeLine(columns.join(',') + '\n')
      for (const r of rows) {
        const rowObj = asRecord(r)
        await writeLine(columns.map((c) => csvEscape(formatExportCsvCell(rowObj[c]))).join(',') + '\n')
      }
      await new Promise<void>((resolve, reject) => {
        outStream.end(() => resolve())
        outStream.once('error', reject)
      })
      return { ok: true, path: outPath }
    } catch (error: unknown) {
      return { ok: false, message: `写入 CSV 失败：${error instanceof Error ? error.message : '未知错误'}` }
    }
  })
  
  const CALIBRATION_DEFAULT_SUBJECT_KEY = '__default__'
  
  const asCalibrationObject = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
  }
  
  const normalizeCalibrationSubjectId = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : ''
  
  const toCalibrationSubjectKey = (subjectId: string): string =>
    subjectId || CALIBRATION_DEFAULT_SUBJECT_KEY
  
  const extractCalibrationBySubject = (raw: unknown, subjectIdRaw: unknown): Record<string, unknown> | null => {
    const parsed = asCalibrationObject(raw)
    if (!parsed) return null

    const requestedSubjectId = normalizeCalibrationSubjectId(subjectIdRaw)
    const bySubject = asCalibrationObject(parsed.bySubject)
    if (!bySubject) return null
    const key = toCalibrationSubjectKey(requestedSubjectId)
    const direct = asCalibrationObject(bySubject[key])
    if (direct) return direct
    if (requestedSubjectId) return null

    const latest = asCalibrationObject(parsed.latest)
    if (latest) return latest
    return null
  }

  // Huahong/Pupil calibrations are device specific; older entries did not record
  // the device, so they are never offered to these models.
  const DEVICE_SPECIFIC_CALIBRATION_MODELS = new Set(['PupilCore', 'HH_ET10C', 'HH_ET28'])

  /** The subject's calibration for one device: its own slot, else a legacy entry for other devices. */
  const selectCalibrationForDevice = (entry: Record<string, unknown> | null, deviceModelRaw: unknown): Record<string, unknown> | null => {
    const deviceModel = typeof deviceModelRaw === 'string' ? deviceModelRaw.trim() : ''
    if (!entry || !deviceModel) return entry
    const byDevice = asCalibrationObject(entry.byDevice)
    const own = byDevice ? asCalibrationObject(byDevice[deviceModel]) : null
    if (own) return own
    if (entry.deviceModel === deviceModel) return entry
    if (typeof entry.deviceModel === 'string' && entry.deviceModel) return null
    if (!DEVICE_SPECIFIC_CALIBRATION_MODELS.has(deviceModel)) return entry
    // Huahong tokens saved before the device was recorded name their model.
    try {
      const token = typeof entry.coe === 'string' ? JSON.parse(entry.coe) : null
      if (token && typeof token === 'object' && token.model === deviceModel) return entry
    } catch {
    }
    return null
  }
  
  ipcMain.handle('save-calibration-result', async (_event, input: unknown) => {
    const { experimentDir, subjectId, result } = asRecord(input)
    const incomingResult = asCalibrationObject(result)
    if (!experimentDir || typeof experimentDir !== 'string' || !incomingResult) {
      return { ok: false, message: '参数错误' }
    }
    const monitorDir = path.join(experimentDir, 'monitor')
    const safeDir = path.resolve(monitorDir) + path.sep
    const outPath = path.join(monitorDir, 'calibration_result.json')
    const safePath = path.resolve(outPath)
    if (!safePath.startsWith(safeDir)) {
      return { ok: false, message: '非法路径' }
    }
  
    try {
      const normalizedPayloadSubjectId = normalizeCalibrationSubjectId(subjectId)
      const normalizedResultSubjectId = normalizeCalibrationSubjectId(incomingResult.subjectId)
      const resolvedSubjectId = normalizedPayloadSubjectId || normalizedResultSubjectId
      const subjectKey = toCalibrationSubjectKey(resolvedSubjectId)
      const now = new Date().toISOString()
  
      const deviceModel = typeof incomingResult.deviceModel === 'string' ? incomingResult.deviceModel.trim() : ''
      const bySubject: Record<string, Record<string, unknown>> = {}
      try {
        const existingRaw = await fs.promises.readFile(outPath, 'utf-8')
        const existingParsed = asCalibrationObject(JSON.parse(existingRaw))
        if (existingParsed) {
          const existingBySubject = asCalibrationObject(existingParsed.bySubject)
          if (existingBySubject) {
            for (const [key, value] of Object.entries(existingBySubject)) {
              const obj = asCalibrationObject(value)
              if (obj) bySubject[key] = obj
            }
          }
        }
      } catch {
      }
  
      const nextEntry: Record<string, unknown> = {
        ...incomingResult,
        updatedAt: now,
      }
      if (!nextEntry.savedAt) {
        nextEntry.savedAt = now
      }
      if (resolvedSubjectId) {
        nextEntry.subjectId = resolvedSubjectId
      } else {
        delete nextEntry.subjectId
      }
      // The subject entry stays the latest calibration (older readers use it);
      // byDevice keeps each device's own, so switching devices finds the right one.
      delete nextEntry.byDevice
      const previousByDevice = asCalibrationObject(bySubject[subjectKey]?.byDevice) || {}
      if (deviceModel) {
        nextEntry.byDevice = { ...previousByDevice, [deviceModel]: { ...nextEntry } }
      } else if (Object.keys(previousByDevice).length > 0) {
        nextEntry.byDevice = previousByDevice
      }
      bySubject[subjectKey] = nextEntry
  
      const store = {
        version: 2,
        updatedAt: now,
        latest: nextEntry,
        bySubject,
      }
  
      await fs.promises.mkdir(monitorDir, { recursive: true })
      await fs.promises.writeFile(outPath, JSON.stringify(store, null, 2), 'utf-8')
      return { ok: true, path: outPath }
    } catch {
      return { ok: false, message: '写入校准结果失败' }
    }
  })
  
  ipcMain.handle('load-calibration-result', async (_event, input: unknown) => {
    const { experimentDir, subjectId, deviceModel } = asRecord(input)
    if (!experimentDir || typeof experimentDir !== 'string') {
      return { ok: false, result: null, message: '参数错误' }
    }
    const monitorDir = path.join(experimentDir, 'monitor')
    const safeDir = path.resolve(monitorDir) + path.sep
    const inPath = path.join(monitorDir, 'calibration_result.json')
    const safePath = path.resolve(inPath)
    if (!safePath.startsWith(safeDir)) {
      return { ok: false, result: null, message: '非法路径' }
    }
  
    try {
      const raw = await fs.promises.readFile(inPath, 'utf-8')
      const parsed = JSON.parse(raw)
      const selected = selectCalibrationForDevice(extractCalibrationBySubject(parsed, subjectId), deviceModel)
      return { ok: true, result: selected }
    } catch (error: unknown) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code || '') : ''
      if (code === 'ENOENT') {
        return { ok: true, result: null }
      }
      return { ok: false, result: null, message: '读取校准结果失败' }
    }
  })
  
}
