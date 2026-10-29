import { dialog, ipcMain } from 'electron'
import * as fs from 'node:fs'
import * as readline from 'node:readline'
import path from 'node:path'
import { parseCsvLineFast } from './recordPointsModel'
import { isStandardEyeExportKey } from '../../../shared/constants/eyeExportColumns'
import { AOI_EXPORT_KEYS, createRecordAoiExportDeriver } from './recordAoiExport'
import { createExportMotionDeriver, createExportSmoothingDeriver, createExportSegmentScanner, createExportSegmentReader, finiteCsvNumber, buildNumericExportMetadata, formatExportVideoTime, resolveExportTimeOfDay, resolveExportMeasurement, type ExportSegments } from '../../../shared/domain/eyeExportData'

export type RecordExportDependencies = {
  trimFixedDecimal: (value: number, digits: number) => string
}

export function registerRecordExportHandlers(_dependencies: RecordExportDependencies): void {
  ipcMain.handle('export-records-csv', async (_event, input: unknown) => {
    const payload = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    const records = Array.isArray(payload?.records) ? payload.records : []
    const columns = Array.isArray(payload?.columns) ? payload.columns : []
    const headerMap = payload?.headerMap && typeof payload.headerMap === 'object' ? payload.headerMap : {}
    const columnSourceMap = payload?.columnSourceMap && typeof payload.columnSourceMap === 'object' ? payload.columnSourceMap : {}
    const columnJoinSourceMap =
      payload?.columnJoinSourceMap && typeof payload.columnJoinSourceMap === 'object' ? payload.columnJoinSourceMap : {}
  
    if (records.length === 0) {
      return { ok: false, message: '没有可导出的记录' }
    }
    if (columns.length === 0) {
      return { ok: false, message: '请在导出参数中至少选择一个标准字段' }
    }
    if (columns.some((key) => !isStandardEyeExportKey(key))) {
      return { ok: false, message: '导出字段不在原有 133 列或受试者属性范围内，请重新选择导出参数' }
    }
    // Prepare authoritative AOI definitions/events before creating output files.
    const aoiDerivers = new Map<unknown, Awaited<ReturnType<typeof createRecordAoiExportDeriver>>>()
    if (columns.some((key) => AOI_EXPORT_KEYS.has(key))) {
      try {
        for (const record of records) {
          if (typeof record?.csvPath !== 'string') continue
          aoiDerivers.set(record, await createRecordAoiExportDeriver(record.csvPath, {
            projectDir: record.projectDir, recordId: record.id, deviceType: record.deviceType,
            videoWidth: record.videoWidth, videoHeight: record.videoHeight, coordinateSpace: 'original-video',
          }))
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'AOI 导出准备失败' }
      }
    }
  
    const dialogRes = await dialog.showOpenDialog({
      title: '选择导出文件夹',
      properties: ['openDirectory', 'createDirectory'],
    })
  
    if (dialogRes.canceled || !dialogRes.filePaths?.[0]) {
      return { ok: false, message: '已取消导出' }
    }
  
    const exportDir = dialogRes.filePaths[0]
  
    const sanitizeFileName = (name: string) => {
      const cleaned = String(name || 'export')
        .replace(/[\/\\:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
      return cleaned.length > 0 ? cleaned : 'export'
    }
  
    const parseHeader = (headerLine: string) =>
      parseCsvLineFast(headerLine)
        .map((h) => h.trim())
  
    const normalizeHeader = (v: unknown): string => String(v || '').trim().toLowerCase()
    const getColumnSources = (key: string): string[] => {
      const sources = (columnSourceMap as Record<string, unknown>)[key]
      if (Array.isArray(sources)) {
        const normalized = sources.map((item) => String(item || '').trim()).filter(Boolean)
        if (normalized.length > 0) return normalized
      }
      return [key]
    }
  
    const csvEscape = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v)
      if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
      return s
    }
    const shouldForceSpreadsheetText = (key: string): boolean =>
      key === 'time_of_day' || key === 'video_time_ms' || key.toLowerCase().includes('timestamp')
    const forceSpreadsheetText = (value: unknown): string => {
      const s = value === null || value === undefined ? '' : String(value)
      if (!s) return ''
      // Prefix a tab so spreadsheet apps keep the exact textual value and do not coerce time/timestamp cells.
      return `\t${s}`
    }
    const scanDerivedExportSegments = async (csvPath: string): Promise<ExportSegments> => {
      const rs = fs.createReadStream(csvPath, { encoding: 'utf-8' })
      const rl = readline.createInterface({ input: rs, crlfDelay: Infinity })
      let scanner: ReturnType<typeof createExportSegmentScanner> | null = null
      let rowIndex = 0
      try {
        for await (const line of rl) {
          if (!scanner) {
            const headers = new Map(parseHeader(line).map((header, index) => [normalizeHeader(header), index]))
            scanner = createExportSegmentScanner(headers)
          } else if (line) scanner.add(parseCsvLineFast(line), rowIndex++)
        }
        return scanner?.finish() ?? { invalidGaze: [], blinks: [] }
      } finally {
        rl.close()
        rs.close()
      }
    }

    const outputFiles: string[] = []
  
    for (const r of records) {
      const name = sanitizeFileName(r?.name || r?.id || 'record')
      const csvPath = r?.csvPath
      if (!csvPath || typeof csvPath !== 'string') {
        continue
      }
      let fileName = `${name}.csv`
      let outPath = path.join(exportDir, fileName)
      let suffix = 1
      while (true) {
        try {
          await fs.promises.access(outPath, fs.constants.F_OK)
          suffix += 1
          fileName = `${name}_${suffix}.csv`
          outPath = path.join(exportDir, fileName)
        } catch {
          break
        }
      }
  
      try {
        const needsInvalidGaze = columns.includes('invalid_gaze_index') || columns.includes('invalid_gaze_duration_ms')
        const needsBlinkEvents =
          columns.includes('blink_index') || columns.includes('blink_duration_ms') || columns.includes('blink_marker')
        const derivedSegments =
          needsInvalidGaze || needsBlinkEvents
            ? await scanDerivedExportSegments(csvPath)
            : { invalidGaze: [], blinks: [] }
        const rs = fs.createReadStream(csvPath, { encoding: 'utf-8' })
        const rl = readline.createInterface({ input: rs, crlfDelay: Infinity })
        const outStream = fs.createWriteStream(outPath, { encoding: 'utf-8' })
        const writeLine = async (line: string) => {
          if (!outStream.write(line)) {
            await new Promise<void>((resolve) => outStream.once('drain', resolve))
          }
        }
        let headerParsed = false
        let exportColumnDefs: Array<{ key: string; indexes: number[]; joinIndexes?: number[] }> = []
        let deriveMotionValues = (_parts: string[]): Record<string, string> => ({})
        let deriveSmoothingValues = (_parts: string[]): Record<string, string> => ({})
        let deriveSegmentValues = (_parts: string[], _index: number): Record<string, string> => ({})
        let headerIndexMap = new Map<string, number>()
        let dataRowIndex = 0
        const metadataValues =
          r?.metadataValues && typeof r.metadataValues === 'object'
            ? r.metadataValues as Record<string, unknown>
            : {}
        const numericMetadata = buildNumericExportMetadata(r)
        const resolveVirtualValue = (key: string, rawValue: string, row: string[]): string => {
          if (Object.prototype.hasOwnProperty.call(metadataValues, key)) {
            const value = metadataValues[key]
            if (Object.prototype.hasOwnProperty.call(numericMetadata, key) && finiteCsvNumber(value) === null) return ''
            return value === null || typeof value === 'undefined' ? '' : String(value)
          }
          if (key.startsWith('subject_info::')) {
            const encodedLabel = key.slice('subject_info::'.length)
            let label = encodedLabel
            try {
              label = decodeURIComponent(encodedLabel)
            } catch {}
            const subjectInfo = r?.subjectInfo && typeof r.subjectInfo === 'object' ? r.subjectInfo : {}
            const value = subjectInfo && typeof subjectInfo === 'object'
              ? (subjectInfo as Record<string, unknown>)[label]
              : undefined
            return value === null || typeof value === 'undefined' ? '' : String(value)
          }
          if (key === 'record_name') return String(r?.name || '')
          if (key === 'user') return String(r?.subjectName || '')
          if (key === 'eye_data_record') return String(r?.id || '')
          if (Object.prototype.hasOwnProperty.call(numericMetadata, key)) return numericMetadata[key]
          if (key === 'time_of_day') return resolveExportTimeOfDay(r?.timestamp, row, headerIndexMap)
          if (key === 'recording_timestamp_ms') {
            return rawValue || String(r?.timestamp || '')
          }
          return ''
        }
  
        await writeLine('\uFEFF')
        for await (const line of rl) {
          if (!headerParsed) {
            headerParsed = true
            const headers = parseHeader(line)
            headerIndexMap = new Map<string, number>()
            headers.forEach((h, idx) => headerIndexMap.set(normalizeHeader(h), idx))
            deriveMotionValues = createExportMotionDeriver(headerIndexMap)
            deriveSmoothingValues = createExportSmoothingDeriver(headerIndexMap, r)
            deriveSegmentValues = createExportSegmentReader(headerIndexMap, derivedSegments)
            const exportColumns = columns
            exportColumnDefs = exportColumns.map((key) => {
              const joinSourceGroups = (columnJoinSourceMap as Record<string, unknown>)[key]
              const joinIndexes = Array.isArray(joinSourceGroups)
                ? joinSourceGroups.map((sources) => {
                    if (!Array.isArray(sources)) return -1
                    for (const source of sources) {
                      const index = headerIndexMap.get(normalizeHeader(source))
                      if (index !== undefined) return index
                    }
                    return -1
                  })
                : undefined
              return {
                key,
                indexes: getColumnSources(key)
                  .map((source) => headerIndexMap.get(normalizeHeader(source)) ?? -1)
                  .filter((index) => index >= 0),
                joinIndexes,
              }
            })
            if (exportColumnDefs.length === 0) break
            const outHeaders = exportColumnDefs.map(({ key }) => headerMap[key] || key)
            await writeLine(outHeaders.map(csvEscape).join(',') + '\n')
            continue
          }
          if (!line || exportColumnDefs.length === 0) continue
          const parts = parseCsvLineFast(line)
          const derivedValues = { ...deriveMotionValues(parts), ...deriveSegmentValues(parts, dataRowIndex), ...deriveSmoothingValues(parts) }
          const measurementContext = { ...r, derivedValues }
          const aoiValues = aoiDerivers.get(r)?.(parts)
          const picked = exportColumnDefs.map(({ key, indexes, joinIndexes }) => {
            const hasJoinedSource = Array.isArray(joinIndexes) && joinIndexes.some((index) => index >= 0)
            const rawValue = hasJoinedSource
              ? joinIndexes.map((index) => (index >= 0 && index < parts.length ? parts[index] || '' : '')).join(',')
              : indexes.reduce<string>((found, index) => {
                  if (found) return found
                  return index >= 0 && index < parts.length ? parts[index] : ''
                }, '')
            let value = resolveExportMeasurement(key, rawValue || derivedValues[key] || '', parts, headerIndexMap, measurementContext)
            if (aoiValues && AOI_EXPORT_KEYS.has(key)) value = aoiValues[key as keyof typeof aoiValues]
            if (
              key.startsWith('subject_info::') ||
              key === 'record_name' ||
              key === 'user' ||
              key === 'eye_data_record' ||
              key === 'tracking_ratio_pct' ||
              key === 'sampling_rate_hz' ||
              key === 'configured_sampling_rate_hz' ||
              key === 'record_duration_s' ||
              key === 'time_of_day' ||
              key === 'recording_timestamp_ms'
            ) {
              value = resolveVirtualValue(key, rawValue, parts)
            } else if (key === 'video_time_ms') {
              value = formatExportVideoTime(rawValue)
            }
            if (shouldForceSpreadsheetText(key)) {
              return forceSpreadsheetText(value)
            }
            return value
          })
          // Keep the same source precision and textual values shown by the preview.
          await writeLine(picked.map(csvEscape).join(',') + '\n')
          dataRowIndex += 1
        }
        rl.close()
        rs.close()
        await new Promise<void>((resolve, reject) => {
          outStream.end(() => resolve())
          outStream.once('error', reject)
        })
        outputFiles.push(outPath)
      } catch {
        try {
          await fs.promises.rm(outPath, { force: true })
        } catch {
        }
      }
    }
  
    if (outputFiles.length === 0) {
      return { ok: false, message: '没有导出任何文件（可能缺少 CSV 或字段）', exportDir }
    }
  
    return { ok: true, exportDir, files: outputFiles }
  })
  
}
