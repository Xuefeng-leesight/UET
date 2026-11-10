import { ipcMain } from 'electron'
import * as fs from 'node:fs'
import path from 'node:path'
import { validateUtf8Path } from '../filesystem/pathValidation'

type StimulusRecord = Record<string, unknown>

function asRecord(value: unknown): StimulusRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as StimulusRecord : {}
}

type StimulusImportDependencies = {
  buildLocalResourceUrl: (filePath: string) => Promise<string>
  hydrateStimuliFromDisk: (items: unknown[], stimuliDir: string) => Promise<StimulusRecord[]>
  inferStimulusMediaTypeFromPath: (value: string) => 'image' | 'video' | 'audio'
  isStimulusAudioExtension: (ext: string) => boolean
  isStimulusVideoExtension: (ext: string) => boolean
  normalizeStimulusToggle: (value: unknown) => boolean
  shouldTranscodeStimulusVideo: (ext: string) => boolean
  transcodeStimulusVideoToMp4: (sourcePath: string, destPath: string) => Promise<{ ok: true; message?: never } | { ok: false; message: string }>
  writeStimuliJson: (listPath: string, items: unknown[]) => Promise<void>
}

export function registerStimulusImportHandlers(dependencies: StimulusImportDependencies): void {
  const {
    buildLocalResourceUrl,
    hydrateStimuliFromDisk,
    inferStimulusMediaTypeFromPath,
    isStimulusAudioExtension,
    isStimulusVideoExtension,
    normalizeStimulusToggle,
    shouldTranscodeStimulusVideo,
    transcodeStimulusVideoToMp4,
    writeStimuliJson,
  } = dependencies
  ipcMain.handle('import-stimuli', async (_event, input: unknown) => {
    const { projectDir, files, group } = asRecord(input)
    if (typeof projectDir !== 'string' || !projectDir || !Array.isArray(files)) {
      return { ok: false, stimuli: [], error: '参数错误' }
    }
  
    // Validate UTF-8 path encoding
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, stimuli: [], error: `路径验证失败：${pathValidation.error}` }
    }
  
    const stimuliDir = path.join(projectDir, 'stimuli')
    await fs.promises.mkdir(stimuliDir, { recursive: true })
  
    const listPath = path.join(stimuliDir, 'stimuli.json')
  
    let existing: StimulusRecord[] = []
    try {
      const raw = await fs.promises.readFile(listPath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        existing = parsed
      }
    } catch {
    }
    existing = await hydrateStimuliFromDisk(existing, stimuliDir)
  
    const seenSource = new Set<string>()
    for (const item of existing) {
      if (item && typeof item.sourcePath === 'string') {
        seenSource.add(item.sourcePath)
      }
    }
  
    const now = new Date()
    let maxOrder = 0
    for (const item of existing) {
      const o = typeof item?.order === 'number' && Number.isFinite(item.order) ? item.order : 0
      if (o > maxOrder) maxOrder = o
    }
    const initialExistingCount = existing.length
    const failedMessages: string[] = []
  
    for (const file of files) {
      if (!file || typeof file.path !== 'string') {
        continue
      }
      const srcPath = file.path as string
      if (seenSource.has(srcPath)) {
        continue
      }
  
      let stat: fs.Stats | null = null
      try {
        stat = await fs.promises.stat(srcPath)
      } catch {
        continue
      }
  
      const originalExt = path.extname(srcPath) || '.img'
      const sourceExt = originalExt.toLowerCase()
      const ext = shouldTranscodeStimulusVideo(sourceExt) ? '.mp4' : sourceExt
      const baseName = path.basename(srcPath, originalExt)
      const stimulusType = isStimulusVideoExtension(sourceExt) ? 'video' : isStimulusAudioExtension(sourceExt) ? 'audio' : 'image'
      const id = `stim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const destName = `${id}${ext}`
      const destPath = path.join(stimuliDir, destName)
  
      try {
        if (shouldTranscodeStimulusVideo(sourceExt)) {
          const converted = await transcodeStimulusVideoToMp4(srcPath, destPath)
          if (!converted.ok) {
            console.warn('[import-stimuli] video transcode failed:', converted.message)
            failedMessages.push(`${baseName}: ${converted.message}`)
            continue
          }
        } else {
          await fs.promises.copyFile(srcPath, destPath)
        }
      } catch (error: unknown) {
        failedMessages.push(`${baseName}: ${error instanceof Error ? error.message : '复制素材文件失败'}`)
        continue
      }
  
      let sizeLabel = ''
      if (stat && typeof stat.size === 'number') {
        const kb = stat.size / 1024
        if (kb < 1024) {
          sizeLabel = `${kb.toFixed(1)} KB`
        } else {
          sizeLabel = `${(kb / 1024).toFixed(1)} MB`
        }
      }
  
      const dateLabel = now.toISOString().slice(0, 10)
      const fileUrl = await buildLocalResourceUrl(destPath)
  
      existing.push({
        id,
        name: baseName,
        url: fileUrl,
        fileName: destName,
        size: sizeLabel,
        date: dateLabel,
        sourcePath: srcPath,
        order: maxOrder + 1,
        active: true,
        stimulusType,
        group: group || '',
        randomPlay: false,
        endOnClick: false,
        endOnKey: false,
      })
      maxOrder += 1
      seenSource.add(srcPath)
    }
  
    existing.sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0))
    existing = existing.map((s, idx) => ({
      ...s,
      order: idx + 1,
      active: s && typeof s.active === 'boolean' ? s.active : true,
      randomPlay: normalizeStimulusToggle(s?.randomPlay),
      endOnClick: normalizeStimulusToggle(s?.endOnClick),
      endOnKey: normalizeStimulusToggle(s?.endOnKey),
      stimulusType:
        s && typeof s.stimulusType === 'string'
          ? s.stimulusType
          : inferStimulusMediaTypeFromPath(String(s?.url || '')),
    }))
    await writeStimuliJson(listPath, existing)
  
    if (failedMessages.length > 0 && existing.length === initialExistingCount) {
      return {
        ok: false,
        stimuli: existing,
        message: `刺激物上传失败：${failedMessages.slice(0, 3).join('；')}`,
      }
    }
  
    return {
      ok: true,
      stimuli: existing,
      message: failedMessages.length > 0 ? `部分刺激物上传失败：${failedMessages.slice(0, 3).join('；')}` : undefined,
    }
  })
  
  ipcMain.handle('import-stimuli-buffer', async (_event, input: unknown) => {
    const { projectDir, files, group, forceTranscodeVideo, sourceKind } = asRecord(input)
    if (typeof projectDir !== 'string' || !projectDir || !Array.isArray(files)) {
      return { ok: false, stimuli: [] }
    }
  
    const stimuliDir = path.join(projectDir, 'stimuli')
    await fs.promises.mkdir(stimuliDir, { recursive: true })
  
    const listPath = path.join(stimuliDir, 'stimuli.json')
  
    let existing: StimulusRecord[] = []
    try {
      const raw = await fs.promises.readFile(listPath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        existing = parsed
      }
    } catch {
    }
    existing = await hydrateStimuliFromDisk(existing, stimuliDir)
  
    const now = new Date()
    let maxOrder = 0
    for (const item of existing) {
      const o = typeof item?.order === 'number' && Number.isFinite(item.order) ? item.order : 0
      if (o > maxOrder) maxOrder = o
    }
    const initialExistingCount = existing.length
    const failedMessages: string[] = []
  
    for (const file of files) {
      if (!file || typeof file.name !== 'string' || !file.data) {
        continue
      }
  
      const name = file.name as string
      const data = file.data as Uint8Array | number[] | ArrayBuffer
  
      let buffer: Buffer
      if (data instanceof Uint8Array) {
        buffer = Buffer.from(data)
      } else if (Array.isArray(data)) {
        buffer = Buffer.from(data)
      } else {
        buffer = Buffer.from(data as ArrayBuffer)
      }
  
      const originalExt = path.extname(name) || '.img'
      const sourceExt = originalExt.toLowerCase()
      const shouldConvertVideo = isStimulusVideoExtension(sourceExt) && (shouldTranscodeStimulusVideo(sourceExt) || forceTranscodeVideo === true)
      const ext = shouldConvertVideo ? '.mp4' : sourceExt
      const baseName = path.basename(name, originalExt)
      const stimulusType = isStimulusVideoExtension(sourceExt) ? 'video' : isStimulusAudioExtension(sourceExt) ? 'audio' : 'image'
      const id = `stim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const destName = `${id}${ext}`
      const destPath = path.join(stimuliDir, destName)
  
      try {
        if (shouldConvertVideo) {
          const tempSourcePath = path.join(stimuliDir, `${id}.source${sourceExt}`)
          try {
            await fs.promises.writeFile(tempSourcePath, buffer)
            const converted = await transcodeStimulusVideoToMp4(tempSourcePath, destPath)
            if (!converted.ok) {
              console.warn('[import-stimuli-buffer] video transcode failed:', converted.message)
              failedMessages.push(`${baseName}: ${converted.message}`)
              continue
            }
          } finally {
            try {
              await fs.promises.unlink(tempSourcePath)
            } catch {
            }
          }
        } else {
          await fs.promises.writeFile(destPath, buffer)
        }
      } catch (error: unknown) {
        failedMessages.push(`${baseName}: ${error instanceof Error ? error.message : '写入素材文件失败'}`)
        continue
      }
  
      const sizeBytes = buffer.byteLength
      let sizeLabel = ''
      const kb = sizeBytes / 1024
      if (kb < 1024) {
        sizeLabel = `${kb.toFixed(1)} KB`
      } else {
        sizeLabel = `${(kb / 1024).toFixed(1)} MB`
      }
  
      const dateLabel = now.toISOString().slice(0, 10)
      const fileUrl = await buildLocalResourceUrl(destPath)
  
      existing.push({
        id,
        name: baseName,
        url: fileUrl,
        fileName: destName,
        size: sizeLabel,
        date: dateLabel,
        order: maxOrder + 1,
        active: true,
        stimulusType,
        screenRecording: sourceKind === 'screen-recording' || undefined,
        group: group || '',
        randomPlay: false,
        endOnClick: false,
        endOnKey: false,
      })
      maxOrder += 1
    }
  
    existing.sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0))
    existing = existing.map((s, idx) => ({
      ...s,
      order: idx + 1,
      active: s && typeof s.active === 'boolean' ? s.active : true,
      randomPlay: normalizeStimulusToggle(s?.randomPlay),
      endOnClick: normalizeStimulusToggle(s?.endOnClick),
      endOnKey: normalizeStimulusToggle(s?.endOnKey),
      stimulusType:
        s && typeof s.stimulusType === 'string'
          ? s.stimulusType
          : inferStimulusMediaTypeFromPath(String(s?.url || '')),
    }))
    await writeStimuliJson(listPath, existing)
  
    if (failedMessages.length > 0 && existing.length === initialExistingCount) {
      return {
        ok: false,
        stimuli: existing,
        message: `刺激物上传失败：${failedMessages.slice(0, 3).join('；')}`,
      }
    }
  
    return {
      ok: true,
      stimuli: existing,
      message: failedMessages.length > 0 ? `部分刺激物上传失败：${failedMessages.slice(0, 3).join('；')}` : undefined,
    }
  })
  
  ipcMain.handle('import-combo-assets', async (_event, input: unknown) => {
    const { projectDir, files } = asRecord(input)
    if (typeof projectDir !== 'string' || !projectDir || !Array.isArray(files)) {
      return { ok: false, assets: [], message: '参数错误' }
    }
  
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, assets: [], message: `路径验证失败：${pathValidation.error}` }
    }
  
    const stimuliDir = path.join(projectDir, 'stimuli')
    await fs.promises.mkdir(stimuliDir, { recursive: true })
  
    const assets: StimulusRecord[] = []
    for (const file of files) {
      if (!file || typeof file.name !== 'string') continue
  
      const originalExt = path.extname(file.name) || '.asset'
      const sourceExt = originalExt.toLowerCase()
      const ext = shouldTranscodeStimulusVideo(sourceExt) ? '.mp4' : sourceExt
      const baseName = path.basename(file.name, originalExt)
      const type = isStimulusVideoExtension(sourceExt) ? 'video' : isStimulusAudioExtension(sourceExt) ? 'audio' : 'image'
      const id = `combo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const destPath = path.join(stimuliDir, `${id}${ext}`)
  
      let sizeBytes = 0
      try {
        if (typeof file.path === 'string' && file.path) {
          const stat = await fs.promises.stat(file.path)
          sizeBytes = stat.size
          if (shouldTranscodeStimulusVideo(sourceExt)) {
            const converted = await transcodeStimulusVideoToMp4(file.path, destPath)
            if (!converted.ok) {
              console.warn('[import-combo-assets] video transcode failed:', converted.message)
              continue
            }
          } else {
            await fs.promises.copyFile(file.path, destPath)
          }
        } else if (file.data) {
          const data = file.data as Uint8Array | number[] | ArrayBuffer
          const buffer = data instanceof Uint8Array
            ? Buffer.from(data)
            : Array.isArray(data)
              ? Buffer.from(data)
              : Buffer.from(data as ArrayBuffer)
          sizeBytes = buffer.byteLength
          if (shouldTranscodeStimulusVideo(sourceExt)) {
            const tempSourcePath = path.join(stimuliDir, `${id}.source${sourceExt}`)
            try {
              await fs.promises.writeFile(tempSourcePath, buffer)
              const converted = await transcodeStimulusVideoToMp4(tempSourcePath, destPath)
              if (!converted.ok) {
                console.warn('[import-combo-assets] buffer video transcode failed:', converted.message)
                continue
              }
            } finally {
              try {
                await fs.promises.unlink(tempSourcePath)
              } catch {
              }
            }
          } else {
            await fs.promises.writeFile(destPath, buffer)
          }
        } else {
          continue
        }
      } catch {
        continue
      }
  
      const kb = sizeBytes / 1024
      const size = kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`
      const fileUrl = await buildLocalResourceUrl(destPath)
      assets.push({
        id,
        name: baseName,
        type,
        url: fileUrl,
        fileName: path.basename(destPath),
        size,
      })
    }
  
    return { ok: true, assets }
  })
  
}
