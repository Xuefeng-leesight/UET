import { ipcMain } from 'electron'
import * as fs from 'node:fs'
import path from 'node:path'
import { logVideoDebugEvent } from '../../platform/logging/videoDebugLogger'
import { validateUtf8Path } from '../filesystem/pathValidation'

type StimulusRecord = Record<string, unknown>

function asRecord(value: unknown): StimulusRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as StimulusRecord : {}
}

type StimulusLoadDependencies = {
  buildLocalResourceUrl: (filePath: string) => Promise<string>
  hydrateStimuliFromDisk: (items: unknown[], stimuliDir: string) => Promise<StimulusRecord[]>
  normalizeStimulusToggle: (value: unknown) => boolean
  serializeStimuliForDisk: (items: unknown[]) => StimulusRecord[]
  shouldTranscodeStimulusVideo: (ext: string) => boolean
  stimulusAudioExtensions: string[]
  stimulusImageExtensions: string[]
  stimulusVideoExtensions: string[]
  transcodeStimulusVideoToMp4: (sourcePath: string, destPath: string) => Promise<{ ok: true; message?: never } | { ok: false; message: string }>
  writeStimuliJson: (listPath: string, items: unknown[]) => Promise<void>
}

export function registerStimulusLoadHandlers(dependencies: StimulusLoadDependencies): void {
  const {
    buildLocalResourceUrl,
    hydrateStimuliFromDisk,
    normalizeStimulusToggle,
    serializeStimuliForDisk,
    shouldTranscodeStimulusVideo,
    stimulusAudioExtensions: STIMULUS_AUDIO_EXTENSIONS,
    stimulusImageExtensions: STIMULUS_IMAGE_EXTENSIONS,
    stimulusVideoExtensions: STIMULUS_VIDEO_EXTENSIONS,
    transcodeStimulusVideoToMp4,
    writeStimuliJson,
  } = dependencies
  ipcMain.handle('load-stimuli', async (_event, input: unknown) => {
    const { projectDir } = asRecord(input)
    if (typeof projectDir !== 'string' || !projectDir) {
      return { ok: false, stimuli: [], error: '缺少 projectDir' }
    }
  
    // Validate UTF-8 path encoding
    const pathValidation = await validateUtf8Path(projectDir)
    if (!pathValidation.ok) {
      return { ok: false, stimuli: [], error: `路径验证失败：${pathValidation.error}` }
    }
  
    const stimuliDir = path.join(projectDir, 'stimuli')
    const listPath = path.join(stimuliDir, 'stimuli.json')
  
    const mediaExtList = [...STIMULUS_IMAGE_EXTENSIONS, ...STIMULUS_VIDEO_EXTENSIONS, ...STIMULUS_AUDIO_EXTENSIONS]
    const mediaExtSet = new Set(mediaExtList)
    const idLikeNamePattern = /^(?:stim|combo)_\d+_[a-z0-9]+$/i
    const isHttpUrl = (value: string): boolean => value.startsWith('http://') || value.startsWith('https://')
    const inferStimulusTypeFromUrl = (url: string): 'image' | 'video' | 'audio' => {
      const lower = String(url || '').toLowerCase().split('?')[0].split('#')[0]
      if (STIMULUS_VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'video'
      if (STIMULUS_AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'audio'
      return 'image'
    }
    const extractMediaFileNameFromUrl = (rawUrl: string): string | null => {
      const value = String(rawUrl || '').trim()
      if (!value) return null
      const clean = value.split('?')[0].split('#')[0]
      try {
        const parsed = new URL(clean)
        if (parsed.protocol === 'file:') {
          const base = path.basename(decodeURIComponent(parsed.pathname || ''))
          if (base) return base
        }
      } catch {
      }
      const normalized = clean.replace(/\\/g, '/')
      const base = path.basename(decodeURIComponent(normalized))
      return base || null
    }
    const normalizeLocalMediaUrlForKey = (rawUrl: unknown): string => {
      const value = typeof rawUrl === 'string' ? rawUrl.trim() : ''
      if (!value) return ''
      return value.replace(/^local-resource:/i, 'file:').split('?')[0].split('#')[0]
    }
    const buildFileIdentityKeys = (rawValue: unknown): string[] => {
      const value = typeof rawValue === 'string' ? rawValue.trim() : ''
      if (!value) return []
      const base = path.basename(value).toLowerCase()
      if (!base) return []
      const ext = path.extname(base)
      const stem = ext ? base.slice(0, -ext.length) : base
      const keys = [`file:${base}`]
      if (stem) keys.push(`stem:${stem}`)
      return keys
    }
    const canonicalLocalMediaKeys = (rawUrl: unknown): string[] => {
      const fileName = extractMediaFileNameFromUrl(normalizeLocalMediaUrlForKey(rawUrl))
      return buildFileIdentityKeys(fileName)
    }
    const collectStimulusMediaKeys = (itemInput: unknown): string[] => {
      const item = asRecord(itemInput)
      const keys = new Set<string>()
      const urls = [
        typeof item?.url === 'string' ? item.url : '',
        typeof item?.sourcePath === 'string' ? item.sourcePath : '',
        ...(Array.isArray(item.comboItems) ? item.comboItems.map((comboItem) => asRecord(comboItem).url) : []),
      ]
      for (const value of urls) {
        for (const key of canonicalLocalMediaKeys(value)) keys.add(key)
      }
      const itemId = typeof item?.id === 'string' ? item.id.trim().toLowerCase() : ''
      if (itemId) keys.add(`stem:${itemId}`)
      return Array.from(keys)
    }
    const collectDiskMediaKeys = (media: { fileName: string; sourceFileName?: string; fileUrl: string }): string[] => {
      const keys = new Set<string>()
      for (const key of buildFileIdentityKeys(media.fileName)) keys.add(key)
      for (const key of buildFileIdentityKeys(media.sourceFileName)) keys.add(key)
      for (const key of canonicalLocalMediaKeys(media.fileUrl)) keys.add(key)
      return Array.from(keys)
    }
    const normalizeStimulusReferenceForRepeatDetection = (rawValue: unknown): string => {
      const value = typeof rawValue === 'string' ? rawValue.trim() : ''
      if (!value) return ''
      if (isHttpUrl(value)) return value
      const localKeys = canonicalLocalMediaKeys(value)
      if (localKeys.length > 0) return localKeys.join('|')
      return normalizeLocalMediaUrlForKey(value)
    }
    const buildStimulusRepeatFingerprint = (itemInput: unknown): string => {
      const item = asRecord(itemInput)
      const comboItems = Array.isArray(item.comboItems)
        ? item.comboItems.map((comboItemInput) => {
            const comboItem = asRecord(comboItemInput)
            return ({
            kind: String(comboItem.kind ?? ''),
            type: String(comboItem.type ?? ''),
            label: String(comboItem.label ?? '').trim(),
            text: String(comboItem.text ?? ''),
            url: normalizeStimulusReferenceForRepeatDetection(comboItem.url),
            width: comboItem.width ?? null,
            height: comboItem.height ?? null,
            x: comboItem.x ?? null,
            y: comboItem.y ?? null,
            zIndex: comboItem.zIndex ?? null,
          })})
        : []
      return JSON.stringify({
        name: String(item?.name ?? '').trim(),
        stimulusType: String(item?.stimulusType ?? ''),
        url: normalizeStimulusReferenceForRepeatDetection(item?.url),
        text: String(item?.text ?? ''),
        bgColor: String(item?.bgColor ?? ''),
        fontSize: item?.fontSize ?? null,
        fontColor: String(item?.fontColor ?? ''),
        group: String(item?.group ?? '').trim(),
        fixedTimeMs: item?.fixedTimeMs ?? null,
        active: item?.active !== false,
        randomPlay: normalizeStimulusToggle(item?.randomPlay),
        endOnClick: normalizeStimulusToggle(item?.endOnClick),
        endOnKey: normalizeStimulusToggle(item?.endOnKey),
        playToEnd: item?.playToEnd !== false,
        triggerEnabled: normalizeStimulusToggle(item?.triggerEnabled),
        triggerMark: item?.triggerMark ?? null,
        groupPlayMode: item?.groupPlayMode ?? null,
        groupRandomCount: item?.groupRandomCount ?? null,
        groupRepeatCount: item?.groupRepeatCount ?? null,
        groupInternalOrder: item?.groupInternalOrder ?? null,
        externalMarker: item?.externalMarker ?? null,
        comboCanvasStyle: item?.comboCanvasStyle ?? null,
        comboItems,
      })
    }
    const collapseRepeatedStimulusBlocks = (items: StimulusRecord[]): StimulusRecord[] => {
      if (items.length < 2) return items
      let current = items.slice()
      let changed = false
      while (true) {
        const fingerprints = current.map((item) => buildStimulusRepeatFingerprint(item))
        let nextItems: StimulusRecord[] | null = null
        outer: for (let start = 0; start < current.length - 1; start += 1) {
          const maxBlockSize = Math.floor((current.length - start) / 2)
          for (let blockSize = 1; blockSize <= maxBlockSize; blockSize += 1) {
            let repeatCount = 1
            while (start + (repeatCount + 1) * blockSize <= current.length) {
              let blockMatches = true
              for (let offset = 0; offset < blockSize; offset += 1) {
                const baseIndex = start + offset
                const compareIndex = start + repeatCount * blockSize + offset
                if (fingerprints[baseIndex] !== fingerprints[compareIndex]) {
                  blockMatches = false
                  break
                }
              }
              if (!blockMatches) break
              repeatCount += 1
            }
            if (repeatCount > 1) {
              nextItems = [
                ...current.slice(0, start),
                ...current.slice(start, start + blockSize),
                ...current.slice(start + repeatCount * blockSize),
              ]
              changed = true
              break outer
            }
          }
        }
        if (!nextItems) break
        current = nextItems
      }
      return changed ? current : items
    }
    const isComboInternalFileName = (fileName: unknown): boolean => {
      const value = typeof fileName === 'string' ? fileName.trim() : ''
      if (!value) return false
      const base = path.basename(value, path.extname(value)).toLowerCase()
      return /^combo_\d+_[a-z0-9]+$/i.test(base)
    }
  
    let existing: StimulusRecord[] = []
    try {
      const raw = await fs.promises.readFile(listPath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        existing = parsed
      }
    } catch {
    }
    const requiresPortableRewrite = JSON.stringify(existing) !== JSON.stringify(serializeStimuliForDisk(existing))
    // #region debug-point A:load-stimuli-raw-file
    logVideoDebugEvent({
      source: 'main',
      event: 'stimuli-duplicate:load-stimuli-raw-file',
      details: {
        projectDir,
        listPath,
        rawCount: Array.isArray(existing) ? existing.length : -1,
        rawNames: existing.slice(0, 20).map((item) => String(item.name ?? '')),
      },
    })
    // #endregion
  
    let diskMediaEntries: Array<{ fileName: string; fileUrl: string; ext: string; sizeLabel: string; sourceFileName?: string }> = []
    try {
      const entries = await fs.promises.readdir(stimuliDir, { withFileTypes: true })
      diskMediaEntries = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name !== 'stimuli.json')
          .map(async (entry) => {
            const ext = path.extname(entry.name).toLowerCase()
            if (!mediaExtSet.has(ext)) {
              return null
            }
            const sourceFileName = entry.name
            let fileName = entry.name
            let filePath = path.join(stimuliDir, entry.name)
            let mediaExt = ext
            if (shouldTranscodeStimulusVideo(ext)) {
              const baseName = path.basename(entry.name, path.extname(entry.name))
              const playableFileName = `${baseName}.mp4`
              const playablePath = path.join(stimuliDir, playableFileName)
              try {
                if (!fs.existsSync(playablePath)) {
                  const converted = await transcodeStimulusVideoToMp4(filePath, playablePath)
                  if (!converted.ok) {
                    console.warn('[load-stimuli] video transcode failed:', converted.message)
                  }
                }
                if (fs.existsSync(playablePath)) {
                  fileName = playableFileName
                  filePath = playablePath
                  mediaExt = '.mp4'
                }
              } catch (error) {
                console.warn('[load-stimuli] video transcode error:', error)
              }
            }
            let sizeLabel = ''
            try {
              const stat = await fs.promises.stat(filePath)
              if (stat && typeof stat.size === 'number') {
                const kb = stat.size / 1024
                sizeLabel = kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`
              }
            } catch {
            }
            const fileUrl = await buildLocalResourceUrl(filePath)
            return {
              fileName,
              fileUrl,
              ext: mediaExt,
              sizeLabel,
              sourceFileName: sourceFileName !== fileName ? sourceFileName : undefined,
            }
          }),
      ).then((arr) => arr.filter((item): item is NonNullable<typeof item> => item !== null))
      const uniqueDiskMedia = new Map<string, (typeof diskMediaEntries)[number]>()
      for (const media of diskMediaEntries) {
        if (!uniqueDiskMedia.has(media.fileUrl)) {
          uniqueDiskMedia.set(media.fileUrl, media)
        }
      }
      diskMediaEntries = Array.from(uniqueDiskMedia.values())
    } catch {
      diskMediaEntries = []
    }
    // #region debug-point B:load-stimuli-disk-scan
    logVideoDebugEvent({
      source: 'main',
      event: 'stimuli-duplicate:load-stimuli-disk-scan',
      details: {
        projectDir,
        stimuliDir,
        diskCount: diskMediaEntries.length,
        diskFiles: diskMediaEntries.slice(0, 20).map((item) => item.fileName),
      },
    })
    // #endregion
  
    const mediaUrlByFileName = new Map<string, string>()
    const mediaUrlByKey = new Map<string, string>()
    for (const media of diskMediaEntries) {
      mediaUrlByFileName.set(media.fileName, media.fileUrl)
      if (media.sourceFileName) {
        mediaUrlByFileName.set(media.sourceFileName, media.fileUrl)
      }
      for (const key of collectDiskMediaKeys(media)) {
        if (!mediaUrlByKey.has(key)) {
          mediaUrlByKey.set(key, media.fileUrl)
        }
      }
    }
  
    let metadataChanged = requiresPortableRewrite
    existing = await hydrateStimuliFromDisk(existing, stimuliDir)
    existing = existing.map((s, idx) => ({
      ...s,
      url: (() => {
        const rawUrl = typeof s?.url === 'string' ? s.url : ''
        if (!rawUrl || isHttpUrl(rawUrl)) return rawUrl
        let localUrl = ''
        const mediaFileName = extractMediaFileNameFromUrl(rawUrl)
        if (mediaFileName) {
          localUrl = mediaUrlByFileName.get(mediaFileName) || ''
        }
        if (!localUrl) {
          for (const key of collectStimulusMediaKeys(s)) {
            const hit = mediaUrlByKey.get(key)
            if (hit) {
              localUrl = hit
              break
            }
          }
        }
        if (!localUrl) return rawUrl
        if (localUrl !== rawUrl) metadataChanged = true
        return localUrl
      })(),
      order: typeof s?.order === 'number' ? s.order : idx + 1,
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
              : inferStimulusTypeFromUrl(String(s?.url || '')),
    }))
    existing.sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0))
    existing = existing.map((s, idx) => ({ ...s, order: idx + 1 }))
    const collapsedExisting = collapseRepeatedStimulusBlocks(existing)
    if (collapsedExisting.length !== existing.length) {
      existing = collapsedExisting.map((item, idx) => ({ ...item, order: idx + 1 }))
      metadataChanged = true
    }
  
    // 转码前后的文件扩展名可能不同；按文件名和文件主干合并，优先保留用户命名的素材。
    const groupedByMediaKey = new Map<string, StimulusRecord[]>()
    for (const item of existing) {
      for (const key of collectStimulusMediaKeys(item)) {
        const list = groupedByMediaKey.get(key) || []
        list.push(item)
        groupedByMediaKey.set(key, list)
      }
    }
    const duplicateIdSet = new Set<string>()
    for (const list of groupedByMediaKey.values()) {
      if (list.length <= 1) continue
      const idLikeItems = list.filter((item) => idLikeNamePattern.test(String(item?.name || '').trim()))
      const namedItems = list.filter((item) => !idLikeNamePattern.test(String(item?.name || '').trim()))
      if (idLikeItems.length > 0 && namedItems.length > 0) {
        for (const item of idLikeItems) {
          if (typeof item?.id === 'string' && item.id.trim()) {
            duplicateIdSet.add(item.id)
          }
        }
      }
    }
    if (duplicateIdSet.size > 0) {
      existing = existing.filter((item) => !(typeof item?.id === 'string' && duplicateIdSet.has(item.id)))
      metadataChanged = true
    }
    const beforeComboInternalFilterCount = existing.length
    existing = existing.filter((item) => {
      if (item?.stimulusType === 'combo') return true
      return !isComboInternalFileName(extractMediaFileNameFromUrl(typeof item?.url === 'string' ? item.url : ''))
    })
    if (existing.length !== beforeComboInternalFilterCount) {
      metadataChanged = true
    }
    const added = false
  
    if (added || metadataChanged) {
      // #region debug-point B:load-stimuli-rewrite
      logVideoDebugEvent({
        source: 'main',
        event: 'stimuli-duplicate:load-stimuli-rewrite',
        details: {
          projectDir,
          added,
          metadataChanged,
          finalCountBeforeWrite: existing.length,
          finalNamesBeforeWrite: existing.slice(0, 20).map((item) => String(item?.name ?? '')),
        },
      })
      // #endregion
      try {
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
                  : inferStimulusTypeFromUrl(String(s?.url || '')),
        }))
        await writeStimuliJson(listPath, existing)
      } catch {
      }
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
          : s && typeof s.text === 'string' && s.text.trim().length > 0
            ? 'text'
            : s && typeof s.url === 'string' && (s.url.startsWith('http://') || s.url.startsWith('https://'))
              ? 'web'
              : inferStimulusTypeFromUrl(String(s?.url || '')),
    }))
    // #region debug-point B:load-stimuli-return
    logVideoDebugEvent({
      source: 'main',
      event: 'stimuli-duplicate:load-stimuli-return',
      details: {
        projectDir,
        returnCount: existing.length,
        returnNames: existing.slice(0, 20).map((item) => String(item?.name ?? '')),
        added,
        metadataChanged,
      },
    })
    // #endregion
    return { ok: true, stimuli: existing }
  })
  
}
