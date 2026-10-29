import * as fs from 'node:fs'
import path from 'node:path'

type StimulusRecord = Record<string, unknown>

function asRecord(value: unknown): StimulusRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as StimulusRecord : {}
}

export function createStimulusRepository(buildLocalResourceUrl: (filePath: string) => Promise<string>) {
  const isExternalStimulusUrl = (value: string): boolean => /^(?:https?|data|blob):/i.test(value)
  
  const stimulusMediaFileName = (rawValue: unknown): string | null => {
    const value = typeof rawValue === 'string' ? rawValue.trim() : ''
    if (!value || isExternalStimulusUrl(value)) return null
    const clean = value.split('?')[0].split('#')[0]
    try {
      const parsed = new URL(clean.replace(/^local-resource:/i, 'file:'))
      if (parsed.protocol === 'file:') {
        return path.basename(decodeURIComponent(parsed.pathname || '')) || null
      }
    } catch {
    }
    try {
      return path.basename(decodeURIComponent(clean.replace(/\\/g, '/'))) || null
    } catch {
      return null
    }
  }
  
  const serializeStimuliForDisk = (items: unknown[]): StimulusRecord[] => items.map((item) => {
    const next = { ...asRecord(item) }
    const fileName = stimulusMediaFileName(next.fileName) || stimulusMediaFileName(next.url)
    if (fileName) {
      next.fileName = fileName
      next.url = `./${fileName}`
    }
    delete next.sourcePath
    if (Array.isArray(next.comboItems)) {
      next.comboItems = next.comboItems.map((comboItem: unknown) => {
        const nextComboItem = { ...asRecord(comboItem) }
        const comboFileName = stimulusMediaFileName(nextComboItem.fileName) || stimulusMediaFileName(nextComboItem.url)
        if (comboFileName) {
          nextComboItem.fileName = comboFileName
          nextComboItem.url = `./${comboFileName}`
        }
        delete nextComboItem.sourcePath
        return nextComboItem
      })
    }
    return next
  })
  
  const hydrateStimuliFromDisk = async (items: unknown[], stimuliDir: string): Promise<StimulusRecord[]> => {
    const directoryEntries = await fs.promises.readdir(stimuliDir, { withFileTypes: true }).catch(() => [])
    const mediaFileNames = directoryEntries.filter((entry) => entry.isFile()).map((entry) => entry.name)
    return Promise.all(items.map(async (item) => {
      const next = { ...asRecord(item) }
      const resolveFileName = (rawUrl: unknown, explicitFileName?: unknown, id?: unknown, name?: unknown): string | null => {
        const candidates = [
          stimulusMediaFileName(explicitFileName),
          stimulusMediaFileName(rawUrl),
        ].filter((value): value is string => Boolean(value))
        for (const candidate of candidates) {
          const match = mediaFileNames.find((fileName) => fileName.toLowerCase() === candidate.toLowerCase())
          if (match) return match
        }
        const stems = [String(id || '').trim(), String(name || '').trim()].filter(Boolean)
        for (const stem of stems) {
          const match = mediaFileNames.find((fileName) => path.basename(fileName, path.extname(fileName)).toLowerCase() === stem.toLowerCase())
          if (match) return match
        }
        return null
      }
      const hydrateUrl = async (rawUrl: unknown, explicitFileName?: unknown, id?: unknown, name?: unknown): Promise<{ url: unknown; fileName?: string }> => {
        const value = typeof rawUrl === 'string' ? rawUrl.trim() : ''
        if (value && isExternalStimulusUrl(value)) return { url: rawUrl }
        const fileName = resolveFileName(rawUrl, explicitFileName, id, name)
        if (!fileName) return { url: rawUrl }
        const currentProjectPath = path.join(stimuliDir, fileName)
        try {
          const stat = await fs.promises.stat(currentProjectPath)
          return stat.isFile() ? { url: await buildLocalResourceUrl(currentProjectPath), fileName } : { url: rawUrl }
        } catch {
          return { url: rawUrl }
        }
      }
      const hydrated = await hydrateUrl(next.url, next.fileName, next.id, next.name)
      next.url = hydrated.url
      if (hydrated.fileName) next.fileName = hydrated.fileName
      delete next.sourcePath
      if (Array.isArray(next.comboItems)) {
        next.comboItems = await Promise.all(next.comboItems.map(async (comboItemInput: unknown) => {
          const comboItem = asRecord(comboItemInput)
          const hydratedCombo = await hydrateUrl(comboItem.url, comboItem.fileName, comboItem.id, comboItem.name)
          return {
            ...comboItem,
            url: hydratedCombo.url,
            fileName: hydratedCombo.fileName || comboItem.fileName,
            sourcePath: undefined,
          }
        }))
      }
      return next
    }))
  }
  
  const writeStimuliJson = async (listPath: string, items: unknown[]): Promise<void> => {
    const serialized = serializeStimuliForDisk(items)
    const tempPath = `${listPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await fs.promises.writeFile(tempPath, JSON.stringify(serialized, null, 2), 'utf-8')
    try {
      const verified = JSON.parse(await fs.promises.readFile(tempPath, 'utf-8'))
      if (!Array.isArray(verified) || verified.length !== serialized.length) {
        throw new Error('素材清单写入校验失败')
      }
      await fs.promises.rename(tempPath, listPath)
    } catch (error) {
      await fs.promises.unlink(tempPath).catch(() => {})
      throw error
    }
  }
  
  const collectManagedStimulusFileNames = (items: unknown[]): Set<string> => {
    const fileNames = new Set<string>()
    for (const itemInput of items) {
      const item = asRecord(itemInput)
      const fileName = stimulusMediaFileName(item.fileName)
      if (fileName) fileNames.add(fileName.toLowerCase())
      if (Array.isArray(item?.comboItems)) {
        for (const comboItem of item.comboItems) {
          const comboFileName = stimulusMediaFileName(asRecord(comboItem).fileName)
          if (comboFileName) fileNames.add(comboFileName.toLowerCase())
        }
      }
    }
    return fileNames
  }
  
  const deleteUnreferencedStimulusFiles = async (
    stimuliDir: string,
    beforeItems: unknown[],
    afterItems: unknown[],
  ): Promise<{ deletedFiles: string[]; fileDeleteErrors: string[]; removedFileNames: string[]; remainingFileNames: string[] }> => {
    const removedFileNames = collectManagedStimulusFileNames(beforeItems)
    const remainingFileNames = collectManagedStimulusFileNames(afterItems)
    const actualNamesByLowerCase = new Map<string, string>()
    for (const itemInput of beforeItems) {
      const item = asRecord(itemInput)
      for (const candidate of [item, ...(Array.isArray(item.comboItems) ? item.comboItems : [])]) {
        const fileName = stimulusMediaFileName(asRecord(candidate).fileName)
        if (fileName) actualNamesByLowerCase.set(fileName.toLowerCase(), fileName)
      }
    }
  
    const deletedFiles: string[] = []
    const fileDeleteErrors: string[] = []
    for (const removedFileName of removedFileNames) {
      if (remainingFileNames.has(removedFileName)) continue
      const actualFileName = actualNamesByLowerCase.get(removedFileName)
      if (!actualFileName || path.basename(actualFileName) !== actualFileName) continue
      const targetPath = path.join(stimuliDir, actualFileName)
      if (path.dirname(path.resolve(targetPath)) !== path.resolve(stimuliDir)) continue
      try {
        await fs.promises.unlink(targetPath)
        deletedFiles.push(actualFileName)
      } catch (error: unknown) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code || '') : ''
        if (code !== 'ENOENT') {
          fileDeleteErrors.push(`${actualFileName}: ${error instanceof Error ? error.message : '删除失败'}`)
        }
      }
    }
    return {
      deletedFiles,
      fileDeleteErrors,
      removedFileNames: Array.from(removedFileNames),
      remainingFileNames: Array.from(remainingFileNames),
    }
  }
  
  return {
    deleteUnreferencedStimulusFiles,
    hydrateStimuliFromDisk,
    serializeStimuliForDisk,
    stimulusMediaFileName,
    writeStimuliJson,
  }
}
