import { BrowserWindow, dialog, ipcMain } from 'electron'
import * as fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateUtf8Path } from '../filesystem/pathValidation'

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误'
}

export type ReportDomainDependencies = {
  getMainWindow: () => BrowserWindow | null
  safeTimestampForPath: () => string
  sanitizePathSegment: (raw: unknown, fallback: string) => string
  uniqueDirPath: (baseDir: string) => Promise<string>
}

export function registerReportHandlers(dependencies: ReportDomainDependencies): void {
  const { getMainWindow, safeTimestampForPath, sanitizePathSegment, uniqueDirPath } = dependencies

  ipcMain.handle('load-aoi', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const projectDir = payload.projectDir
    if (!projectDir || typeof projectDir !== 'string') {
      return { ok: false, data: null, message: '缺少 projectDir' }
    }
    const aoiPath = path.join(projectDir, 'visualization', 'aoi.json')
    try {
      const raw = await fs.promises.readFile(aoiPath, 'utf-8')
      const parsed = JSON.parse(raw)
      return { ok: true, data: parsed }
    } catch {
      return { ok: true, data: { version: 3, byRecordId: {} } }
    }
  })
  
  ipcMain.handle('save-aoi', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const { projectDir, recordId, shapes } = payload
    if (!projectDir || typeof projectDir !== 'string' || !recordId || typeof recordId !== 'string' || !Array.isArray(shapes)) {
      return { ok: false, message: '参数错误' }
    }
  
    // Validate UTF-8 path encoding
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, message: `路径验证失败：${pathValidation.error}` }
    }
  
    const visDir = path.join(projectDir, 'visualization')
    const aoiPath = path.join(visDir, 'aoi.json')
  
    let store: { version: number; byRecordId: Record<string, unknown> } = { version: 3, byRecordId: {} }
    try {
      const raw = await fs.promises.readFile(aoiPath, 'utf-8')
      const parsed = asRecord(JSON.parse(raw))
      if (Number(parsed.version) === 2 || Number(parsed.version) === 3) {
        store = {
          version: Number(parsed.version),
          byRecordId: asRecord(parsed.byRecordId),
        }
      }
    } catch {
    }
  
    if (store.version !== 2 && store.version !== 3) store = { version: 3, byRecordId: {} }
    store.version = 3
    store.byRecordId[recordId] = shapes
  
    try {
      await fs.promises.mkdir(visDir, { recursive: true })
      await fs.promises.writeFile(aoiPath, JSON.stringify(store, null, 2), 'utf-8')
      return { ok: true, path: aoiPath }
    } catch {
      return { ok: false, message: '写入 aoi.json 失败' }
    }
  })
  
  function sanitizeReportFileStem(raw: unknown, fallback: string): string {
    const normalized = sanitizePathSegment(raw, fallback).trim()
    return normalized || fallback
  }
  
  async function pickLatestReportJson(reportDir: string): Promise<string | null> {
    try {
      const entries = await fs.promises.readdir(reportDir, { withFileTypes: true })
      const candidates = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json') && entry.name !== 'latest.json')
        .map((entry) => path.join(reportDir, entry.name))
  
      if (candidates.length === 0) return null
  
      let bestPath: string | null = null
      let bestMtime = -Infinity
      for (const candidate of candidates) {
        try {
          const stat = await fs.promises.stat(candidate)
          if (stat.mtimeMs > bestMtime) {
            bestMtime = stat.mtimeMs
            bestPath = candidate
          }
        } catch {
        }
      }
      return bestPath
    } catch {
      return null
    }
  }
  
  ipcMain.handle('save-compare-result', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const projectDir = typeof payload.projectDir === 'string' ? payload.projectDir.trim() : ''
    const compareResult = asRecord(payload.compareResult)
    if (!projectDir || Object.keys(compareResult).length === 0) {
      return { ok: false, message: '参数错误' }
    }
  
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, message: `路径验证失败：${pathValidation.error}` }
    }
  
    const compareId = sanitizeReportFileStem(compareResult.id || `cmp_${safeTimestampForPath()}`, 'compare_result')
    const reportDir = path.join(projectDir, 'reports', 'compare')
    const reportPath = path.join(reportDir, `${compareId}.json`)
    const latestPath = path.join(reportDir, 'latest.json')
  
    try {
      await fs.promises.mkdir(reportDir, { recursive: true })
      await fs.promises.writeFile(reportPath, JSON.stringify(compareResult, null, 2), 'utf-8')
      await fs.promises.writeFile(
        latestPath,
        JSON.stringify(
          {
            id: compareId,
            path: reportPath,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        'utf-8',
      )
      return { ok: true, path: reportPath, compareId }
    } catch (error: unknown) {
      return { ok: false, message: `保存对比结果失败：${errorMessage(error)}` }
    }
  })
  
  ipcMain.handle('load-compare-result', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const projectDir = typeof payload.projectDir === 'string' ? payload.projectDir.trim() : ''
    const compareId = typeof payload.compareId === 'string' ? payload.compareId.trim() : ''
    if (!projectDir) {
      return { ok: false, compareResult: null, message: '缺少 projectDir' }
    }
  
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, compareResult: null, message: `路径验证失败：${pathValidation.error}` }
    }
  
    const reportDir = path.join(projectDir, 'reports', 'compare')
    const latestPath = path.join(reportDir, 'latest.json')
    let targetPath: string | null = null
  
    if (compareId) {
      targetPath = path.join(reportDir, `${sanitizeReportFileStem(compareId, compareId)}.json`)
    } else {
      try {
        const latestRaw = await fs.promises.readFile(latestPath, 'utf-8')
      const latest = asRecord(JSON.parse(latestRaw))
      if (typeof latest.path === 'string') {
          targetPath = latest.path
        }
      } catch {
      }
      if (!targetPath) {
        targetPath = await pickLatestReportJson(reportDir)
      }
    }
  
    if (!targetPath) {
      return { ok: true, compareResult: null, path: null }
    }
  
    try {
      const raw = await fs.promises.readFile(targetPath, 'utf-8')
      const parsed = JSON.parse(raw)
      return { ok: true, compareResult: parsed, path: targetPath }
    } catch (error: unknown) {
      return { ok: false, compareResult: null, message: `读取对比结果失败：${errorMessage(error)}` }
    }
  })
  
  ipcMain.handle('save-insight-report', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const projectDir = typeof payload.projectDir === 'string' ? payload.projectDir.trim() : ''
    const report = asRecord(payload.report)
    if (!projectDir || Object.keys(report).length === 0) {
      return { ok: false, message: '参数错误' }
    }
  
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, message: `路径验证失败：${pathValidation.error}` }
    }
  
    const reportId = sanitizeReportFileStem(report.id || `ins_${safeTimestampForPath()}`, 'insight_report')
    const reportDir = path.join(projectDir, 'reports', 'insights')
    const reportPath = path.join(reportDir, `${reportId}.json`)
    const latestPath = path.join(reportDir, 'latest.json')
  
    try {
      await fs.promises.mkdir(reportDir, { recursive: true })
      await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8')
      await fs.promises.writeFile(
        latestPath,
        JSON.stringify(
          {
            id: reportId,
            path: reportPath,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        'utf-8',
      )
      return { ok: true, path: reportPath, reportId }
    } catch (error: unknown) {
      return { ok: false, message: `保存洞察报告失败：${errorMessage(error)}` }
    }
  })
  
  ipcMain.handle('load-insight-report', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const projectDir = typeof payload.projectDir === 'string' ? payload.projectDir.trim() : ''
    const reportId = typeof payload.reportId === 'string' ? payload.reportId.trim() : ''
    if (!projectDir) {
      return { ok: false, report: null, message: '缺少 projectDir' }
    }
  
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, report: null, message: `路径验证失败：${pathValidation.error}` }
    }
  
    const reportDir = path.join(projectDir, 'reports', 'insights')
    const latestPath = path.join(reportDir, 'latest.json')
    let targetPath: string | null = null
  
    if (reportId) {
      targetPath = path.join(reportDir, `${sanitizeReportFileStem(reportId, reportId)}.json`)
    } else {
      try {
        const latestRaw = await fs.promises.readFile(latestPath, 'utf-8')
      const latest = asRecord(JSON.parse(latestRaw))
      if (typeof latest.path === 'string') {
          targetPath = latest.path
        }
      } catch {
      }
      if (!targetPath) {
        targetPath = await pickLatestReportJson(reportDir)
      }
    }
  
    if (!targetPath) {
      return { ok: true, report: null, path: null }
    }
  
    try {
      const raw = await fs.promises.readFile(targetPath, 'utf-8')
      const parsed = JSON.parse(raw)
      return { ok: true, report: parsed, path: targetPath }
    } catch (error: unknown) {
      return { ok: false, report: null, message: `读取洞察报告失败：${errorMessage(error)}` }
    }
  })
  
  ipcMain.handle('export-insight-report-bundle', async (_event, input: unknown) => {
    const payload = asRecord(input)
    const projectDir = typeof payload.projectDir === 'string' ? payload.projectDir.trim() : ''
    const report = asRecord(payload.report)
    const compareResult = asRecord(payload.compareResult)
    const html = typeof payload.html === 'string' ? payload.html : ''
    const csv = typeof payload.csv === 'string' ? payload.csv : ''

    if (!projectDir || Object.keys(report).length === 0 || Object.keys(compareResult).length === 0 || !html) {
      return { ok: false, message: '参数错误' }
    }
    const win = getMainWindow()
    if (!win) {
      return { ok: false, message: '窗口不可用' }
    }
  
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, message: `路径验证失败：${pathValidation.error}` }
    }
  
    const picked = await dialog.showOpenDialog(win, {
      title: '选择导出目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (picked.canceled || !picked.filePaths?.[0]) {
      return { ok: false, message: '已取消' }
    }
  
    const selectedRoot = picked.filePaths[0]
    const folderStem = sanitizeReportFileStem(
      `${report.title || 'insight_report'}_${safeTimestampForPath()}`,
      `insight_report_${safeTimestampForPath()}`,
    )
    const bundleDir = await uniqueDirPath(path.join(selectedRoot, folderStem))
    const htmlPath = path.join(bundleDir, 'insight_report.html')
    const csvPath = path.join(bundleDir, 'compare_appendix.csv')
    const jsonPath = path.join(bundleDir, 'compare_result.json')
    const reportJsonPath = path.join(bundleDir, 'insight_report.json')
    const pdfPath = path.join(bundleDir, 'insight_report.pdf')
    const artifacts: Array<{ kind: 'html' | 'pdf' | 'csv'; path: string }> = []
  
    try {
      await fs.promises.mkdir(bundleDir, { recursive: true })
      await fs.promises.writeFile(htmlPath, html, 'utf-8')
      await fs.promises.writeFile(csvPath, `\uFEFF${csv}`, 'utf-8')
      await fs.promises.writeFile(jsonPath, JSON.stringify(compareResult, null, 2), 'utf-8')
      await fs.promises.writeFile(reportJsonPath, JSON.stringify(report, null, 2), 'utf-8')
      artifacts.push({ kind: 'html', path: htmlPath })
      artifacts.push({ kind: 'csv', path: csvPath })
  
      let pdfOk = false
      let pdfWindow: BrowserWindow | null = null
      try {
        pdfWindow = new BrowserWindow({
          show: false,
          width: 1280,
          height: 900,
          webPreferences: {
            // Explicit secure defaults: the window loads HTML containing user
            // data; never expose Node APIs to it. printToPDF is a main-process
            // webContents API and does not require renderer Node access.
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
          },
        })
        await pdfWindow.loadURL(pathToFileURL(htmlPath).toString())
        const pdfBuffer = await pdfWindow.webContents.printToPDF({
          printBackground: true,
          pageSize: 'A4',
          margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
        })
        await fs.promises.writeFile(pdfPath, pdfBuffer)
        artifacts.push({ kind: 'pdf', path: pdfPath })
        pdfOk = true
      } catch (error) {
        console.warn('[export-insight-report-bundle] PDF export failed:', error)
      } finally {
        if (pdfWindow && !pdfWindow.isDestroyed()) {
          pdfWindow.destroy()
        }
      }
  
      if (!pdfOk) {
        return {
          ok: true,
          exportDir: bundleDir,
          artifacts,
          message: 'HTML 与 CSV 已导出，PDF 导出失败',
        }
      }
  
      return { ok: true, exportDir: bundleDir, artifacts }
    } catch (error: unknown) {
      return { ok: false, message: `导出报告失败：${errorMessage(error)}` }
    }
  })
  
}
