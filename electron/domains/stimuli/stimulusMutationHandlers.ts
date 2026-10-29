import { ipcMain } from 'electron'
import * as fs from 'node:fs'
import * as readline from 'node:readline'
import path from 'node:path'
import { logVideoDebugEvent } from '../../platform/logging/videoDebugLogger'
import { validateUtf8Path } from '../filesystem/pathValidation'
import { parseCsvLineFast } from '../recording/recordPointsModel'

type StimulusRecord = Record<string, unknown>

function asRecord(value: unknown): StimulusRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as StimulusRecord : {}
}

function errorMessage(error: unknown, fallback = '未知错误'): string {
  return error instanceof Error && error.message ? error.message : fallback
}

type StimulusMutationDependencies = {
  buildLocalResourceUrl: (filePath: string) => Promise<string>
  deleteUnreferencedStimulusFiles: (
    stimuliDir: string,
    beforeItems: unknown[],
    afterItems: unknown[],
  ) => Promise<{ deletedFiles: string[]; fileDeleteErrors: string[]; removedFileNames: string[]; remainingFileNames: string[] }>
  hydrateStimuliFromDisk: (items: unknown[], stimuliDir: string) => Promise<StimulusRecord[]>
  inferStimulusMediaTypeFromPath: (value: string) => 'image' | 'video' | 'audio'
  normalizeStimulusToggle: (value: unknown) => boolean
  stimulusMediaFileName: (rawValue: unknown) => string | null
  writeStimuliJson: (listPath: string, items: unknown[]) => Promise<void>
}

export function registerStimulusMutationHandlers(dependencies: StimulusMutationDependencies): void {
  const {
    buildLocalResourceUrl,
    deleteUnreferencedStimulusFiles,
    hydrateStimuliFromDisk,
    inferStimulusMediaTypeFromPath,
    normalizeStimulusToggle,
    stimulusMediaFileName,
    writeStimuliJson,
  } = dependencies
  ipcMain.handle('save-stimuli', async (_event, input: unknown) => {
    const { projectDir, stimuli } = asRecord(input)
    if (typeof projectDir !== 'string' || !projectDir || !Array.isArray(stimuli)) {
      return { ok: false, error: '参数错误' }
    }
  
    // Validate UTF-8 path encoding
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, error: `路径验证失败：${pathValidation.error}` }
    }
  
    const stimuliDir = path.join(projectDir, 'stimuli')
    await fs.promises.mkdir(stimuliDir, { recursive: true })
  
    const listPath = path.join(stimuliDir, 'stimuli.json')
    let previous: StimulusRecord[] = []
    try {
      const parsed = JSON.parse(await fs.promises.readFile(listPath, 'utf-8'))
      if (Array.isArray(parsed)) previous = await hydrateStimuliFromDisk(parsed, stimuliDir)
    } catch {
    }
    let next: StimulusRecord[] = stimuli.map((stimulus: unknown, idx: number): StimulusRecord => {
      const s = asRecord(stimulus)
      return {
        ...s,
        order: typeof s.order === 'number' && Number.isFinite(s.order) ? s.order : idx + 1,
        randomPlay: normalizeStimulusToggle(s.randomPlay),
        endOnClick: normalizeStimulusToggle(s.endOnClick),
        endOnKey: normalizeStimulusToggle(s.endOnKey),
      }
    })
    next.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
    next = next.map((s, idx): StimulusRecord => ({ ...s, order: idx + 1 }))
  
    const previousById = new Map(previous.map((item) => [String(item.id || ''), item]))
    for (const item of next) {
      const oldItem = previousById.get(String(item?.id || ''))
      if (!oldItem || String(oldItem?.name || '').trim() === String(item?.name || '').trim()) continue
      try {
        const usage = await findStimulusRecordingUsage(projectDir, [oldItem])
        if (usage.records.length > 0) {
          return {
            ok: false,
            code: 'STIMULUS_NAME_LOCKED',
            message: `该素材已在录制记录（${usage.records.join('、')}）中使用，不能修改名称。`,
            records: usage.records,
          }
        }
      } catch (error: unknown) {
        return { ok: false, message: `检查录制记录失败：${errorMessage(error)}` }
      }
    }
    // #region debug-point D:save-stimuli
    logVideoDebugEvent({
      source: 'main',
      event: 'stimuli-duplicate:save-stimuli',
      details: {
        projectDir,
        listPath,
        count: next.length,
        names: next.slice(0, 20).map((item) => String(item.name ?? '')),
      },
    })
    // #endregion
  
    try {
      await writeStimuliJson(listPath, next)
      const cleanup = await deleteUnreferencedStimulusFiles(stimuliDir, previous, next)
      logVideoDebugEvent({
        source: 'main',
        event: 'stimuli-save:file-cleanup',
        details: { projectDir, beforeCount: previous.length, afterCount: next.length, ...cleanup },
      })
      return { ok: true, path: listPath, count: next.length }
    } catch (error: unknown) {
      return { ok: false, error: `保存失败：${errorMessage(error)}` }
    }
  })
  
  ipcMain.handle('copy-stimulus', async (_event, input: unknown) => {
    const { projectDir, stimulusId } = asRecord(input)
    if (!projectDir || typeof projectDir !== 'string' || !stimulusId || typeof stimulusId !== 'string') {
      return { ok: false, message: '参数错误' }
    }
  
    const stimuliDir = path.join(projectDir, 'stimuli')
    const listPath = path.join(stimuliDir, 'stimuli.json')
  
    // Load existing stimuli
    let existing: StimulusRecord[] = []
    try {
      const raw = await fs.promises.readFile(listPath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        existing = parsed
      }
    } catch {
      return { ok: false, message: '读取 stimuli.json 失败' }
    }
    existing = await hydrateStimuliFromDisk(existing, stimuliDir)
  
    // Find the stimulus to copy
    const original = existing.find((s) => s && s.id === stimulusId)
    if (!original) {
      return { ok: false, message: '未找到原素材' }
    }
  
    // Calculate max order
    let maxOrder = 0
    for (const item of existing) {
      const o = typeof item?.order === 'number' && Number.isFinite(item.order) ? item.order : 0
      if (o > maxOrder) maxOrder = o
    }
  
    const existingNames = new Set(
      existing
        .map((s) => (typeof s?.name === 'string' ? s.name : ''))
        .filter((name) => name.length > 0),
    )
    const occupiedGroupNames = new Set(
      existing.flatMap((s) => {
        const names: string[] = []
        const n = typeof s?.name === 'string' ? s.name.trim() : ''
        if (n && s?.stimulusType === 'group') names.push(n)
        const g = typeof s?.group === 'string' ? s.group.trim() : ''
        if (g) names.push(g)
        return names
      }),
    )
    const createdFiles: string[] = []
  
    const generateUniqueName = (
      baseNameRaw: string,
      options?: { avoidGroupCollision?: boolean },
    ): string => {
      const baseName = String(baseNameRaw || '').trim() || 'stimulus'
      let candidate = `${baseName}_copy`
      let counter = 1
      while (
        existingNames.has(candidate) ||
        (options?.avoidGroupCollision && occupiedGroupNames.has(candidate))
      ) {
        counter += 1
        candidate = `${baseName}_copy${counter}`
      }
      existingNames.add(candidate)
      if (options?.avoidGroupCollision) {
        occupiedGroupNames.add(candidate)
      }
      return candidate
    }
  
    const generateId = (): string => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  
    const copyUrlIfNeeded = async (sourceUrl: unknown, sourceFileName: unknown, newId: string): Promise<{ url: unknown; fileName?: string }> => {
      const fileName = stimulusMediaFileName(sourceFileName) || stimulusMediaFileName(sourceUrl)
      if (!fileName) return { url: sourceUrl }
      const originalPath = path.join(stimuliDir, fileName)
      const stat = await fs.promises.stat(originalPath)
      if (!stat.isFile()) return { url: sourceUrl }
      const ext = path.extname(originalPath)
      const newFileName = `${newId}${ext}`
      const newPath = path.join(stimuliDir, newFileName)
      await fs.promises.copyFile(originalPath, newPath)
      createdFiles.push(newPath)
      return { url: await buildLocalResourceUrl(newPath), fileName: newFileName }
    }
  
    const copiedItems: StimulusRecord[] = []
    let primaryCopiedItem: StimulusRecord | null = null
  
    try {
      if (original.stimulusType === 'group') {
        const copiedGroupName = generateUniqueName(String(original.name || 'group'), { avoidGroupCollision: true })
        const copiedGroupId = generateId()
        const copiedGroupMedia = await copyUrlIfNeeded(original.url, original.fileName, copiedGroupId)
        const copiedGroup = {
          ...original,
          id: copiedGroupId,
          name: copiedGroupName,
          group: '',
          url: copiedGroupMedia.url,
          fileName: copiedGroupMedia.fileName,
          order: ++maxOrder,
        }
        copiedItems.push(copiedGroup)
        primaryCopiedItem = copiedGroup
  
        const groupMembers = existing
          .filter((s) => s && s.id !== original.id && s.group === original.name && s.stimulusType !== 'group')
          .sort((a, b) => {
            const ao = typeof a?.groupInternalOrder === 'number' && Number.isFinite(a.groupInternalOrder)
              ? a.groupInternalOrder
              : Number.MAX_SAFE_INTEGER
            const bo = typeof b?.groupInternalOrder === 'number' && Number.isFinite(b.groupInternalOrder)
              ? b.groupInternalOrder
              : Number.MAX_SAFE_INTEGER
            if (ao !== bo) return ao - bo
            return (Number(a?.order) || 0) - (Number(b?.order) || 0)
          })
  
        for (const member of groupMembers) {
          const copiedMemberId = generateId()
          const copiedMemberMedia = await copyUrlIfNeeded(member.url, member.fileName, copiedMemberId)
          const copiedMember = {
            ...member,
            id: copiedMemberId,
            name: generateUniqueName(String(member.name || 'stimulus')),
            group: copiedGroupName,
            url: copiedMemberMedia.url,
            fileName: copiedMemberMedia.fileName,
            order: ++maxOrder,
          }
          copiedItems.push(copiedMember)
        }
      } else {
        const copiedId = generateId()
        const copiedMedia = await copyUrlIfNeeded(original.url, original.fileName, copiedId)
        const copiedStimulus = {
          ...original,
          id: copiedId,
          name: generateUniqueName(String(original.name || 'stimulus')),
          url: copiedMedia.url,
          fileName: copiedMedia.fileName,
          order: ++maxOrder,
        }
        copiedItems.push(copiedStimulus)
        primaryCopiedItem = copiedStimulus
      }
    } catch (error) {
      console.error('[copy-stimulus] File copy failed:', error)
      for (const fp of createdFiles) {
        try {
          await fs.promises.unlink(fp)
        } catch {
        }
      }
      return { ok: false, message: '复制素材文件失败' }
    }
  
    existing.push(...copiedItems)
  
    // Sort and normalize
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
          : s && typeof s.text === 'string' && s.text.trim().length > 0
            ? 'text'
            : s && typeof s.url === 'string' && (s.url.startsWith('http://') || s.url.startsWith('https://'))
              ? 'web'
              : inferStimulusMediaTypeFromPath(String(s?.url || '')),
    }))
  
    // Save updated list
    try {
      await writeStimuliJson(listPath, existing)
    } catch {
      return { ok: false, message: '写入 stimuli.json 失败' }
    }
  
    return {
      ok: true,
      stimulus: primaryCopiedItem,
      copiedCount: copiedItems.length,
      stimuli: existing,
    }
  })
  
  const loadStimuliForDeletion = async (projectDir: string): Promise<StimulusRecord[]> => {
    const stimuliDir = path.join(projectDir, 'stimuli')
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
    return hydrateStimuliFromDisk(existing, stimuliDir)
  }
  
  const resolveStimuliRemovedById = (existing: StimulusRecord[], id: string): StimulusRecord[] => {
    const removedRoot = existing.find((s) => s && s.id === id)
    return (
      removedRoot && removedRoot.stimulusType === 'group'
        ? existing.filter((s) => s && (s.id === id || (s.group === removedRoot.name && s.stimulusType !== 'group')))
        : existing.filter((s) => s && s.id === id)
    )
  }
  
  const findStimulusRecordingUsage = async (
    projectDir: string,
    targetStimuli: StimulusRecord[],
  ): Promise<{ records: string[]; stimuli: string[] }> => {
    const targetIds = new Set(
      targetStimuli.map((stimulus) => String(stimulus?.id || '').trim()).filter(Boolean),
    )
    const targetNames = new Set(
      targetStimuli.map((stimulus) => String(stimulus?.name || '').trim()).filter(Boolean),
    )
    if (targetIds.size === 0 && targetNames.size === 0) {
      return { records: [], stimuli: [] }
    }
  
    const matchesReference = (rawValue: unknown): boolean => {
      if (rawValue && typeof rawValue === 'object') {
        const value = rawValue as Record<string, unknown>
        const id = String(value.id ?? '').trim()
        const name = String(value.name ?? '').trim()
        return (id !== '' && targetIds.has(id)) || (name !== '' && targetNames.has(name))
      }
      const raw = String(rawValue ?? '').trim()
      return raw !== '' && targetNames.has(raw)
    }
  
    const recordingsDir = path.join(projectDir, 'recordings')
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(recordingsDir, { withFileTypes: true })
    } catch (error: unknown) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code || '') : ''
      if (code === 'ENOENT') return { records: [], stimuli: [] }
      throw error
    }
  
    const usedRecordNames = new Set<string>()
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.meta.json')) continue
      const filePath = path.join(recordingsDir, entry.name)
      const raw = await fs.promises.readFile(filePath, 'utf-8')
      let meta: StimulusRecord
      try {
        meta = asRecord(JSON.parse(raw))
      } catch {
        continue
      }
      const references = [
        ...(Array.isArray(meta?.stimuli) ? meta.stimuli : []),
      ]
      if (references.some(matchesReference)) {
        usedRecordNames.add(entry.name.slice(0, -'.meta.json'.length))
      }
    }
  
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.csv') continue
      const filePath = path.join(recordingsDir, entry.name)
      const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
      let stimulusIndex = -1
      let isHeader = true
      let matched = false
      try {
        for await (const line of lines) {
          const cells = parseCsvLineFast(line)
          if (isHeader) {
            isHeader = false
            const headers = cells.map((header) => String(header || '').replace(/^\uFEFF/, '').trim().toLowerCase())
            stimulusIndex = headers.findIndex((header) => header === 'stimulus')
            if (stimulusIndex < 0) break
            continue
          }
          if (stimulusIndex < cells.length && matchesReference(cells[stimulusIndex])) {
            matched = true
            break
          }
        }
      } finally {
        lines.close()
        stream.destroy()
      }
      if (matched) {
        const recordName = entry.name.replace(/\.csv$/i, '')
        usedRecordNames.add(recordName)
      }
    }
  
    return {
      records: Array.from(usedRecordNames).sort(),
      stimuli: Array.from(targetNames).sort(),
    }
  }
  
  ipcMain.handle('check-stimulus-usage', async (_event, input: unknown) => {
    const { projectDir, id } = asRecord(input)
    if (!projectDir || typeof projectDir !== 'string' || !id || typeof id !== 'string') {
      return { ok: false, message: '参数错误' }
    }
    try {
      const existing = await loadStimuliForDeletion(projectDir)
      const removedItems = resolveStimuliRemovedById(existing, id)
      const usage = await findStimulusRecordingUsage(projectDir, removedItems)
      return { ok: true, inUse: usage.records.length > 0, ...usage }
    } catch (error: unknown) {
      return { ok: false, message: `检查录制记录失败：${errorMessage(error)}` }
    }
  })
  
  ipcMain.handle('delete-stimulus', async (_event, input: unknown) => {
    const { projectDir, id } = asRecord(input)
    if (!projectDir || typeof projectDir !== 'string' || !id || typeof id !== 'string') {
      return { ok: false, message: '参数错误' }
    }
  
    const stimuliDir = path.join(projectDir, 'stimuli')
    const listPath = path.join(stimuliDir, 'stimuli.json')
    const existing = await loadStimuliForDeletion(projectDir)
    const removedItems = resolveStimuliRemovedById(existing, id)
    if (removedItems.length === 0) {
      return { ok: false, message: '未找到要删除的刺激物，清单未修改' }
    }
    try {
      const usage = await findStimulusRecordingUsage(projectDir, removedItems)
      if (usage.records.length > 0) {
        return {
          ok: false,
          code: 'STIMULUS_IN_USE',
          message: `该刺激物已在录制记录（${usage.records.join('、')}）中使用，不能删除。`,
          ...usage,
        }
      }
    } catch (error: unknown) {
      return { ok: false, message: `检查录制记录失败：${errorMessage(error)}` }
    }
  
    const removedIdSet = new Set(removedItems.map((s) => s.id))
  
    const next = existing.filter((s) => s && !removedIdSet.has(s.id))
    const preservedIds = existing
      .filter((item) => item && !removedIdSet.has(item.id))
      .map((item) => String(item.id || ''))
      .filter(Boolean)
    const nextIds = new Set(next.map((item) => String(item?.id || '')).filter(Boolean))
    if (next.length !== existing.length - removedItems.length || preservedIds.some((preservedId) => !nextIds.has(preservedId))) {
      return { ok: false, message: '删除完整性校验失败，素材清单未修改' }
    }
    next.sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0))
    const normalized = next.map((s, idx) => ({
      ...s,
      order: idx + 1,
      randomPlay: normalizeStimulusToggle(s.randomPlay),
      endOnClick: normalizeStimulusToggle(s.endOnClick),
      endOnKey: normalizeStimulusToggle(s.endOnKey),
    }))
  
    try {
      await fs.promises.mkdir(stimuliDir, { recursive: true })
      await writeStimuliJson(listPath, normalized)
    } catch {
      return { ok: false, message: '写入 stimuli.json 失败' }
    }
  
    const cleanup = await deleteUnreferencedStimulusFiles(stimuliDir, removedItems, normalized)
  
    logVideoDebugEvent({
      source: 'main',
      event: 'stimuli-delete:completed',
      details: {
        projectDir,
        id,
        beforeCount: existing.length,
        afterCount: normalized.length,
        removedIds: removedItems.map((item) => String(item?.id || '')),
        preservedIds,
        ...cleanup,
      },
    })
  
    return {
      ok: true,
      stimuli: normalized,
      removedCount: removedItems.length,
      deletedFiles: cleanup.deletedFiles,
      fileDeleteErrors: cleanup.fileDeleteErrors,
    }
  })
  
}
