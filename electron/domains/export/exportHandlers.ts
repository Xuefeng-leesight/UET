import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import * as fs from 'node:fs'
import path from 'node:path'
import type { AuthorizedPathRegistry } from '../../platform/security/authorizedPaths'

export type ExportDomainDependencies = {
  authorizedPaths: AuthorizedPathRegistry
  buildAtempoFilterForSlowdown: (slowDownFactor: number) => string
  createZipArchive: (sourceDir: string, targetZipPath: string) => Promise<void>
  findFfmpegBinary: () => string | null
  getMainWindow: () => BrowserWindow | null
  isSubPath: (parent: string, child: string) => boolean
  runCommand: (command: string, args: string[], cwd?: string) => Promise<void>
  safeTimestampForPath: () => string
  sanitizePathSegment: (raw: unknown, fallback: string) => string
  toFfmpegSeconds: (value: number) => string
  uniqueDirPath: (baseDir: string) => Promise<string>
  uniqueFilePath: (basePath: string) => Promise<string>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误'
}

export function registerExportHandlers(dependencies: ExportDomainDependencies): void {
  const {
    authorizedPaths,
    buildAtempoFilterForSlowdown,
    createZipArchive,
    findFfmpegBinary,
    getMainWindow,
    isSubPath,
    runCommand,
    safeTimestampForPath,
    sanitizePathSegment,
    toFfmpegSeconds,
    uniqueDirPath,
    uniqueFilePath,
  } = dependencies
  ipcMain.handle('backup-project', async (_event, input: unknown) => {
    const win = getMainWindow()
    const { projectDir } = asRecord(input)
    if (!projectDir || typeof projectDir !== 'string') {
      return { ok: false, message: '缺少 projectDir' }
    }
    if (!win) {
      return { ok: false, message: '窗口不可用' }
    }
  
    const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, message: '已取消' }
    }
  
    const backupRoot = picked.filePaths[0]
    if (isSubPath(projectDir, backupRoot)) {
      return { ok: false, message: '备份目录不能位于工程目录内' }
    }
  
    try {
      const baseName = path.basename(projectDir)
      const destBase = path.join(backupRoot, `${baseName}_backup_${safeTimestampForPath()}`)
      const destDir = await uniqueDirPath(destBase)
      await fs.promises.cp(projectDir, destDir, { recursive: true })
      return { ok: true, destDir }
    } catch (error: unknown) {
      return { ok: false, message: `工程备份失败：${errorMessage(error)}` }
    }
  })
  
  ipcMain.handle('export-project', async (_event, input: unknown) => {
    const win = getMainWindow()
    const { projectDir } = asRecord(input)
    if (!projectDir || typeof projectDir !== 'string') {
      return { ok: false, message: '缺少 projectDir' }
    }
    if (!win) {
      return { ok: false, message: '窗口不可用' }
    }
    const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, message: '已取消' }
    }
    const exportRoot = picked.filePaths[0]
    if (isSubPath(projectDir, exportRoot)) {
      return { ok: false, message: '导出目录不能位于工程目录内' }
    }
  
    try {
      const baseName = path.basename(projectDir)
      const zipBase = path.join(exportRoot, `${baseName}_export_${safeTimestampForPath()}.zip`)
      const zipPath = await uniqueFilePath(zipBase)
      await createZipArchive(projectDir, zipPath)
      return { ok: true, destDir: zipPath }
    } catch (error: unknown) {
      return { ok: false, message: `导出压缩工程失败：${errorMessage(error)}` }
    }
  })
  
  ipcMain.handle('export-video-fast', async (_event, input: unknown) => {
    const win = getMainWindow()
    const payload = asRecord(input)
    const sourcePath = typeof payload?.sourcePath === 'string' ? payload.sourcePath.trim() : ''
    if (!sourcePath) {
      return { ok: false, message: '缺少 sourcePath' }
    }
    if (!win) {
      return { ok: false, message: '窗口不可用' }
    }
  
    const ffmpegBin = findFfmpegBinary()
    if (!ffmpegBin) {
      return { ok: false, reason: 'no_ffmpeg', message: '未找到 ffmpeg，无法执行快速导出' }
    }
  
    const resolvedSourcePath = path.resolve(sourcePath)
    const cleanupSource = payload?.cleanupSource === true
    const preserveAudio = payload?.preserveAudio !== false
    try {
      const sourceStat = await fs.promises.stat(resolvedSourcePath)
      if (!sourceStat.isFile()) {
        return { ok: false, reason: 'invalid_source', message: '源视频不存在或不可读' }
      }
    } catch {
      return { ok: false, reason: 'invalid_source', message: '源视频不存在或不可读' }
    }
  
    const startInput = Number(payload?.startTimeSec)
    const endInput = Number(payload?.endTimeSec)
    const hasStart = Number.isFinite(startInput) && startInput > 0
    const hasEnd = Number.isFinite(endInput) && endInput > 0
    const slowDownInput = Number(payload?.slowDownFactor)
    const slowDownFactor = Number.isFinite(slowDownInput) && slowDownInput > 1 ? slowDownInput : 1
    const outputFpsInput = Number(payload?.outputFps)
    const outputFps =
      Number.isFinite(outputFpsInput) && outputFpsInput > 0
        ? Math.min(120, Math.max(1, Number(outputFpsInput.toFixed(3))))
        : null
    const outputFpsText = outputFps !== null ? String(outputFps) : ''
    const startTimeSec = hasStart ? Math.max(0, startInput) : 0
    const endTimeSec = hasEnd ? Math.max(0, endInput) : 0
    const hasClip = hasStart || hasEnd
    let clipDurationSec = 0
    if (hasClip) {
      if (hasStart && hasEnd) {
        if (endTimeSec <= startTimeSec) {
          return { ok: false, reason: 'invalid_range', message: '导出时间范围无效' }
        }
        clipDurationSec = endTimeSec - startTimeSec
      } else if (hasEnd) {
        clipDurationSec = endTimeSec
      }
    }
  
    const sourceBaseName = path.basename(resolvedSourcePath, path.extname(resolvedSourcePath))
    const defaultNameRaw = sanitizePathSegment(
      payload?.defaultName || `${sourceBaseName}_${safeTimestampForPath()}`,
      `export_${safeTimestampForPath()}`,
    )
    const defaultName = defaultNameRaw.toLowerCase().endsWith('.mp4') ? defaultNameRaw : `${defaultNameRaw}.mp4`
    const saveRes = await dialog.showSaveDialog(win, {
      title: '导出视频',
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
    })
    if (saveRes.canceled || !saveRes.filePath) {
      if (cleanupSource && await authorizedPaths.isAuthorized(resolvedSourcePath)) {
        try {
          await fs.promises.unlink(resolvedSourcePath)
        } catch {
        }
      }
      return { ok: false, reason: 'canceled', message: '已取消' }
    }
  
    const outputPath = saveRes.filePath
    try {
      const needsReencode = hasClip || slowDownFactor > 1 || outputFps !== null
      const args: string[] = ['-y']
      if (hasStart) {
        args.push('-ss', toFfmpegSeconds(startTimeSec))
      }
      args.push('-i', resolvedSourcePath)
      if (hasClip) {
        args.push('-t', toFfmpegSeconds(clipDurationSec))
      }
      if (needsReencode) {
        const videoFilters: string[] = []
        if (slowDownFactor > 1) {
          videoFilters.push(`setpts=${slowDownFactor.toFixed(6)}*PTS`)
        }
        if (outputFps !== null) {
          videoFilters.push(`fps=${outputFpsText}`)
        }
        if (videoFilters.length > 0) {
          args.push('-vf', videoFilters.join(','))
        }
        args.push('-map', '0:v:0', '-map', '0:a?')
        args.push(
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '20',
          '-pix_fmt',
          'yuv420p',
        )
        if (outputFps !== null) {
          args.push('-vsync', 'cfr', '-r', outputFpsText)
        }
        if (preserveAudio) {
          if (slowDownFactor > 1) {
            args.push('-af', buildAtempoFilterForSlowdown(slowDownFactor))
          }
          args.push('-c:a', 'aac', '-b:a', '128k')
        } else {
          args.push('-an')
        }
      } else {
        args.push('-c', 'copy')
      }
      args.push('-movflags', '+faststart', outputPath)
  
      await runCommand(ffmpegBin, args)
      return { ok: true, path: outputPath }
    } catch (error: unknown) {
      return { ok: false, reason: 'command_failed', message: `快速导出失败：${errorMessage(error)}` }
    } finally {
      if (cleanupSource && await authorizedPaths.isAuthorized(resolvedSourcePath)) {
        try {
          await fs.promises.unlink(resolvedSourcePath)
        } catch {
        }
      }
    }
  })
  
  ipcMain.handle('export-image-fast', async (_event, input: unknown) => {
    const win = getMainWindow()
    const payload = asRecord(input)
    if (!win) {
      return { ok: false, message: '窗口不可用' }
    }
  
    const rawContent = payload?.content
    let imageBuffer: Buffer | null = null
    if (Buffer.isBuffer(rawContent) || rawContent instanceof Uint8Array) {
      imageBuffer = Buffer.from(rawContent)
    } else if (rawContent instanceof ArrayBuffer) {
      imageBuffer = Buffer.from(rawContent)
    } else if (ArrayBuffer.isView(rawContent)) {
      imageBuffer = Buffer.from(rawContent.buffer, rawContent.byteOffset, rawContent.byteLength)
    } else if (Array.isArray(rawContent)) {
      imageBuffer = Buffer.from(rawContent)
    } else if (typeof rawContent === 'string' && rawContent.trim().length > 0) {
      const normalized = rawContent.trim().replace(/^data:image\/png;base64,/, '')
      try {
        imageBuffer = Buffer.from(normalized, 'base64')
      } catch {
        imageBuffer = null
      }
    }
  
    if (!imageBuffer || imageBuffer.length === 0) {
      const rawRect = asRecord(payload.captureRect)
      const x = Number(rawRect.x)
      const y = Number(rawRect.y)
      const width = Number(rawRect.width)
      const height = Number(rawRect.height)
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height) && width > 1 && height > 1) {
        const captureRect = {
          x: Math.max(0, Math.floor(x)),
          y: Math.max(0, Math.floor(y)),
          width: Math.max(1, Math.ceil(width)),
          height: Math.max(1, Math.ceil(height)),
        }
        try {
          const captured = await win.webContents.capturePage(captureRect)
          const pngBuffer = captured.toPNG()
          if (pngBuffer && pngBuffer.length > 0) {
            imageBuffer = Buffer.from(pngBuffer)
          }
        } catch {
          imageBuffer = null
        }
      }
    }
  
    if (!imageBuffer || imageBuffer.length === 0) {
      return { ok: false, reason: 'invalid_content', message: '缺少图片数据' }
    }
  
    const defaultNameRaw = sanitizePathSegment(
      payload?.defaultName || `export_${safeTimestampForPath()}`,
      `export_${safeTimestampForPath()}`,
    )
    const defaultName = defaultNameRaw.toLowerCase().endsWith('.png') ? defaultNameRaw : `${defaultNameRaw}.png`
    const saveRes = await dialog.showSaveDialog(win, {
      title: '导出图片',
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    })
    if (saveRes.canceled || !saveRes.filePath) {
      return { ok: false, reason: 'canceled', message: '已取消' }
    }
  
    const outputPath = saveRes.filePath.toLowerCase().endsWith('.png') ? saveRes.filePath : `${saveRes.filePath}.png`
    try {
      await fs.promises.writeFile(outputPath, imageBuffer)
      return { ok: true, path: outputPath }
    } catch (error: unknown) {
      return { ok: false, reason: 'write_failed', message: `导出图片失败：${errorMessage(error)}` }
    }
  })
  
  ipcMain.handle('export-text-fast', async (_event, input: unknown) => {
    const win = getMainWindow()
    const payload = asRecord(input)
    if (!win) {
      return { ok: false, message: '窗口不可用' }
    }
  
    const content = typeof payload?.content === 'string' ? payload.content : String(payload?.content ?? '')
    if (!content.length) {
      return { ok: false, reason: 'invalid_content', message: '缺少文本内容' }
    }
  
    const requestedFilters = Array.isArray(payload?.filters) ? payload.filters : []
    const sanitizedFilters = requestedFilters
      .map((filterInput: unknown) => {
        const filter = asRecord(filterInput)
        const name = typeof filter.name === 'string' ? filter.name.trim() : ''
        const extensions = Array.isArray(filter.extensions)
          ? filter.extensions
              .map((extension: unknown) => String(extension || '').trim().replace(/^\./, '').toLowerCase())
              .filter(Boolean)
          : []
        if (!name || extensions.length === 0) return null
        return { name, extensions }
      })
      .filter((item: { name: string; extensions: string[] } | null): item is { name: string; extensions: string[] } => item !== null)
  
    const defaultNameRaw = sanitizePathSegment(
      payload?.defaultName || `export_${safeTimestampForPath()}`,
      `export_${safeTimestampForPath()}`,
    )
    const fallbackExt = sanitizedFilters[0]?.extensions?.[0] || 'txt'
    const defaultName = defaultNameRaw.toLowerCase().endsWith(`.${fallbackExt.toLowerCase()}`) ? defaultNameRaw : `${defaultNameRaw}.${fallbackExt}`
  
    const saveRes = await dialog.showSaveDialog(win, {
      title: typeof payload?.title === 'string' && payload.title.trim().length > 0 ? payload.title.trim() : '导出文件',
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      filters: sanitizedFilters.length > 0 ? sanitizedFilters : [{ name: '文本文件', extensions: ['txt'] }],
    })
    if (saveRes.canceled || !saveRes.filePath) {
      return { ok: false, reason: 'canceled', message: '已取消' }
    }
  
    const fallbackExtension = sanitizedFilters[0]?.extensions?.[0]
    let outputPath = saveRes.filePath
    if (fallbackExtension && !outputPath.toLowerCase().endsWith(`.${fallbackExtension.toLowerCase()}`)) {
      outputPath = `${outputPath}.${fallbackExtension}`
    }
    try {
      await fs.promises.writeFile(outputPath, content, 'utf-8')
      return { ok: true, path: outputPath }
    } catch (error: unknown) {
      return { ok: false, reason: 'write_failed', message: `导出失败：${errorMessage(error)}` }
    }
  })
  
  ipcMain.handle('export-chart-report-bundle', async (_event, input: unknown) => {
    const win = getMainWindow()
    const payload = asRecord(input)
    if (!win) {
      return { ok: false, message: '窗口不可用' }
    }
  
    const rawCharts = Array.isArray(payload?.charts) ? payload.charts : []
    const normalizedCharts = rawCharts
      .map((itemInput: unknown) => {
        const item = asRecord(itemInput)
        const fileName = sanitizePathSegment(String(item.fileName || '').trim(), '')
        const rect = asRecord(item.rect)
        const x = Number(rect.x)
        const y = Number(rect.y)
        const width = Number(rect.width)
        const height = Number(rect.height)
        if (!fileName || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
          return null
        }
        if (width < 2 || height < 2) return null
        return {
          fileName: fileName.toLowerCase().endsWith('.png') ? fileName : `${fileName}.png`,
          rect: {
            x: Math.max(0, Math.floor(x)),
            y: Math.max(0, Math.floor(y)),
            width: Math.max(1, Math.ceil(width)),
            height: Math.max(1, Math.ceil(height)),
          },
        }
      })
      .filter((item): item is { fileName: string; rect: { x: number; y: number; width: number; height: number } } => item !== null)
  
    const csvContent = typeof payload?.csvContent === 'string' ? payload.csvContent : String(payload?.csvContent ?? '')
    const hasCsv = csvContent.length > 0
    if (normalizedCharts.length === 0 && !hasCsv) {
      return { ok: false, reason: 'invalid_payload', message: '缺少可导出的图表或表格数据' }
    }
  
    const selectedDirRes = await dialog.showOpenDialog(win, {
      title: '选择导出目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (selectedDirRes.canceled || !selectedDirRes.filePaths?.[0]) {
      return { ok: false, reason: 'canceled', message: '已取消' }
    }
  
    const rootDir = selectedDirRes.filePaths[0]
    const baseName = sanitizePathSegment(
      String(payload?.baseName || `aoi_report_${safeTimestampForPath()}`).trim(),
      `aoi_report_${safeTimestampForPath()}`,
    )
    let exportDir = path.join(rootDir, baseName)
    let suffix = 1
    while (true) {
      try {
        await fs.promises.access(exportDir, fs.constants.F_OK)
        suffix += 1
        exportDir = path.join(rootDir, `${baseName}_${suffix}`)
      } catch {
        break
      }
    }
    await fs.promises.mkdir(exportDir, { recursive: true })
  
    const files: string[] = []
    const failed: string[] = []
  
    if (hasCsv) {
      const csvFileNameRaw = sanitizePathSegment(String(payload?.csvFileName || `${baseName}.csv`).trim(), `${baseName}.csv`)
      const csvFileName = csvFileNameRaw.toLowerCase().endsWith('.csv') ? csvFileNameRaw : `${csvFileNameRaw}.csv`
      const csvPath = path.join(exportDir, csvFileName)
      try {
        await fs.promises.writeFile(csvPath, csvContent, 'utf-8')
        files.push(csvPath)
      } catch (error: unknown) {
        failed.push(`${csvFileName}: ${error instanceof Error ? error.message : '写入失败'}`)
      }
    }
  
    for (const chart of normalizedCharts) {
      const outPath = path.join(exportDir, chart.fileName)
      try {
        const captured = await win.webContents.capturePage(chart.rect)
        const pngBuffer = captured.toPNG()
        if (!pngBuffer || pngBuffer.length === 0) {
          failed.push(`${chart.fileName}: 截图数据为空`)
          continue
        }
        await fs.promises.writeFile(outPath, pngBuffer)
        files.push(outPath)
      } catch (error: unknown) {
        failed.push(`${chart.fileName}: ${error instanceof Error ? error.message : '截图失败'}`)
      }
    }
  
    if (files.length === 0) {
      return {
        ok: false,
        reason: 'write_failed',
        message: '导出失败，未生成任何文件',
        exportDir,
        files,
        failed,
      }
    }
  
    return {
      ok: true,
      exportDir,
      files,
      failed,
    }
  })
  
}
