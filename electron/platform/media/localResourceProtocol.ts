import { app, protocol, session } from 'electron'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { logVideoDebugEvent } from '../logging/videoDebugLogger'
import type { AuthorizedPathRegistry } from '../security/authorizedPaths'

function getErrorDetails(error: unknown): { message: string; code: string; name: string; stack: string | null } {
  if (error instanceof Error) {
    return {
      message: error.message,
      code: typeof (error as Error & { code?: unknown }).code === 'string' ? (error as Error & { code: string }).code : '',
      name: error.name,
      stack: error.stack || null,
    }
  }
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    const value = error as { message: string; code?: unknown; name?: unknown; stack?: unknown }
    return {
      message: value.message,
      code: typeof value.code === 'string' ? value.code : '',
      name: typeof value.name === 'string' ? value.name : '',
      stack: typeof value.stack === 'string' ? value.stack : null,
    }
  }
  return { message: '', code: '', name: '', stack: null }
}

export function configurePermissions() {
  const s = session.defaultSession
  s.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true)
      return
    }
    callback(false)
  })
  s.setPermissionCheckHandler((_webContents, permission) => {
    if (permission === 'media') {
      return true
    }
    return false
  })
}

export function hasNonAsciiPath(value: string): boolean {
  return /[^\x00-\x7F]/.test(String(value || ''))
}

export const STIMULUS_VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi', '.wmv', '.flv', '.3gp']
export const STIMULUS_BROWSER_PLAYABLE_VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v']
export const STIMULUS_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']
export const STIMULUS_AUDIO_EXTENSIONS = ['.mp3', '.wav']

export function isStimulusVideoExtension(ext: string): boolean {
  return STIMULUS_VIDEO_EXTENSIONS.includes(String(ext || '').toLowerCase())
}

export function isStimulusAudioExtension(ext: string): boolean {
  return STIMULUS_AUDIO_EXTENSIONS.includes(String(ext || '').toLowerCase())
}

// The local-resource protocol exists to serve project media and data files.
// Serving any other extension would turn it into a generic file-read surface.
export const LOCAL_RESOURCE_ALLOWED_EXTENSIONS: ReadonlyArray<string> = [
  ...STIMULUS_VIDEO_EXTENSIONS,
  ...STIMULUS_AUDIO_EXTENSIONS,
  ...STIMULUS_IMAGE_EXTENSIONS,
  '.json',
  '.csv',
  '.txt',
]

export function isLocalResourceAllowedExtension(filePath: string): boolean {
  const ext = path.extname(String(filePath || '')).toLowerCase()
  return LOCAL_RESOURCE_ALLOWED_EXTENSIONS.includes(ext)
}

export function shouldTranscodeStimulusVideo(ext: string): boolean {
  return isStimulusVideoExtension(ext) && !STIMULUS_BROWSER_PLAYABLE_VIDEO_EXTENSIONS.includes(String(ext || '').toLowerCase())
}

export function inferStimulusMediaTypeFromPath(value: string): 'image' | 'video' | 'audio' {
  const ext = path.extname(String(value || '')).toLowerCase()
  if (isStimulusVideoExtension(ext)) return 'video'
  if (isStimulusAudioExtension(ext)) return 'audio'
  return 'image'
}

function getLocalResourceMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mov') return 'video/quicktime'
  if (ext === '.mkv') return 'video/x-matroska'
  if (ext === '.avi') return 'video/x-msvideo'
  if (ext === '.wmv') return 'video/x-ms-wmv'
  if (ext === '.flv') return 'video/x-flv'
  if (ext === '.3gp') return 'video/3gpp'
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.wav') return 'audio/wav'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.bmp') return 'image/bmp'
  if (ext === '.json') return 'application/json'
  if (ext === '.csv') return 'text/csv'
  return 'application/octet-stream'
}

function isVideoMediaFilePath(filePath: string): boolean {
  const ext = path.extname(String(filePath || '')).toLowerCase()
  return isStimulusVideoExtension(ext)
}

function isVideoMediaRequestUrl(url: string): boolean {
  const lower = String(url || '').toLowerCase()
  return STIMULUS_VIDEO_EXTENSIONS.some((ext) => lower.includes(ext))
}

export function logMainVideoDebug(event: string, details?: unknown): void {
  logVideoDebugEvent({
    source: 'main',
    event,
    details,
  })
}

function getWindowsAsciiMediaCacheRoot(): string {
  const candidates: string[] = []
  const publicRoot = String(process.env.PUBLIC || '').trim()
  if (publicRoot) {
    candidates.push(path.join(publicRoot, 'Documents', 'MRT_Media_Cache'))
  }
  candidates.push(path.join('C:\\Users\\Public\\Documents', 'MRT_Media_Cache'))
  const windowsRoot = String(process.env.SystemRoot || 'C:\\Windows').trim() || 'C:\\Windows'
  candidates.push(path.join(windowsRoot, 'Temp', 'MRT_Media_Cache'))
  candidates.push(path.join(app.getPath('temp'), 'mrt-media-cache'))

  let fallback = path.resolve(path.join(app.getPath('temp'), 'mrt-media-cache'))
  for (const rawCandidate of candidates) {
    const candidate = path.resolve(rawCandidate)
    try {
      fs.mkdirSync(candidate, { recursive: true })
      fallback = candidate
      if (!hasNonAsciiPath(candidate)) {
        return candidate
      }
    } catch {
    }
  }
  return fallback
}

const MEDIA_CACHE_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB

// Keep the ASCII media cache bounded: evict oldest files (by mtime) when the
// cache root grows beyond the cap. Best-effort; failures are swallowed.
async function pruneMediaCache(cacheRoot: string): Promise<void> {
  try {
    const entries = await fs.promises.readdir(cacheRoot, { withFileTypes: true })
    const files: Array<{ name: string; size: number; mtimeMs: number }> = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      try {
        const stat = await fs.promises.stat(path.join(cacheRoot, entry.name))
        files.push({ name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs })
      } catch {
        // file disappeared — ignore
      }
    }
    let total = files.reduce((sum, file) => sum + file.size, 0)
    if (total <= MEDIA_CACHE_MAX_TOTAL_BYTES) return
    files.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const file of files) {
      if (total <= MEDIA_CACHE_MAX_TOTAL_BYTES) break
      try {
        await fs.promises.unlink(path.join(cacheRoot, file.name))
        total -= file.size
      } catch {
        // ignore individual unlink failures
      }
    }
  } catch {
    // cache root missing/unreadable — nothing to prune
  }
}

export async function ensureAsciiMediaCachePath(sourcePath: string): Promise<string> {
  const resolved = path.resolve(String(sourcePath || ''))
  if (!resolved) {
    logMainVideoDebug('ensure-ascii-cache-empty-source', { sourcePath })
    return resolved
  }
  const shouldHandle = process.platform === 'win32' && hasNonAsciiPath(resolved)
  logMainVideoDebug('ensure-ascii-cache-enter', {
    sourcePath,
    resolved,
    platform: process.platform,
    hasNonAscii: hasNonAsciiPath(resolved),
    shouldHandle,
  })
  if (!shouldHandle) {
    return resolved
  }

  try {
    const stat = await fs.promises.stat(resolved)
    if (!stat.isFile()) {
      logMainVideoDebug('ensure-ascii-cache-not-file', { resolved })
      return resolved
    }
    const sourceIsVideo = isVideoMediaFilePath(resolved)
    if (sourceIsVideo) {
      // Avoid caching a file that is still being written (recording in progress),
      // otherwise we may preserve an unstable/corrupted early segment for playback.
      const waitMs = 220
      await new Promise<void>((resolveWait) => {
        setTimeout(() => resolveWait(), waitMs)
      })
      try {
        const statAfter = await fs.promises.stat(resolved)
        const changed =
          Number(statAfter.size || 0) !== Number(stat.size || 0) ||
          Math.floor(Number(statAfter.mtimeMs || 0)) !== Math.floor(Number(stat.mtimeMs || 0))
        if (changed) {
          logMainVideoDebug('ensure-ascii-cache-skip-hot-video', {
            resolved,
            waitMs,
            sizeBefore: stat.size,
            sizeAfter: statAfter.size,
            mtimeBefore: Math.floor(stat.mtimeMs),
            mtimeAfter: Math.floor(statAfter.mtimeMs),
          })
          return resolved
        }
      } catch {
      }
    }

    const cacheRoot = process.platform === 'win32'
      ? getWindowsAsciiMediaCacheRoot()
      : path.join(app.getPath('temp'), 'mrt-media-cache')
    await fs.promises.mkdir(cacheRoot, { recursive: true })
    const ext = path.extname(resolved) || '.mp4'
    const hash = createHash('sha1').update(resolved).digest('hex').slice(0, 16)
    const version = `${stat.size}_${Math.floor(stat.mtimeMs)}`
    const cachePath = path.join(cacheRoot, `${hash}_${version}${ext}`)
    logMainVideoDebug('ensure-ascii-cache-resolved', {
      resolved,
      cacheRoot,
      cachePath,
      ext,
      size: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
      version,
    })

    try {
      await fs.promises.access(cachePath, fs.constants.F_OK)
      logMainVideoDebug('ensure-ascii-cache-hit', {
        resolved,
        cachePath,
      })
      return cachePath
    } catch {
    }

    await fs.promises.copyFile(resolved, cachePath)
    console.log('[media-cache] copied non-ascii media path', { source: resolved, cachePath })
    logMainVideoDebug('ensure-ascii-cache-copy', {
      resolved,
      cacheRoot,
      cachePath,
    })
    void pruneMediaCache(cacheRoot)
    return cachePath
  } catch (error: unknown) {
    const details = getErrorDetails(error)
    console.warn('[media-cache] fallback to source path', { source: resolved, error: details.message || String(error) })
    logMainVideoDebug('ensure-ascii-cache-fallback-source', {
      resolved,
      error: details.message || String(error),
    })
    return resolved
  }
}

export async function buildLocalResourceUrl(filePath: string): Promise<string> {
  const servingPath = await ensureAsciiMediaCachePath(filePath)
  const baseUrl = pathToFileURL(servingPath).toString().replace('file:', 'local-resource:')
  try {
    const stat = await fs.promises.stat(servingPath)
    if (stat.isFile()) {
      const version = `${stat.size}_${Math.floor(stat.mtimeMs)}`
      const sep = baseUrl.includes('?') ? '&' : '?'
      const finalUrl = `${baseUrl}${sep}v=${encodeURIComponent(version)}`
      if (isVideoMediaFilePath(filePath) || isVideoMediaFilePath(servingPath)) {
        logMainVideoDebug('build-local-resource-url', {
          filePath,
          servingPath,
          baseUrl,
          finalUrl,
          size: stat.size,
          mtimeMs: Math.floor(stat.mtimeMs),
          version,
          sourceHasNonAscii: hasNonAsciiPath(filePath),
          servingHasNonAscii: hasNonAsciiPath(servingPath),
        })
      }
      return finalUrl
    }
  } catch {
  }
  if (isVideoMediaFilePath(filePath) || isVideoMediaFilePath(servingPath)) {
    logMainVideoDebug('build-local-resource-url-no-stat-version', {
      filePath,
      servingPath,
      baseUrl,
      sourceHasNonAscii: hasNonAsciiPath(filePath),
      servingHasNonAscii: hasNonAsciiPath(servingPath),
    })
  }
  return baseUrl
}

export async function registerLocalFileProtocol(authorizedPaths: AuthorizedPathRegistry) {
  const mediaCacheRoot = process.platform === 'win32'
    ? getWindowsAsciiMediaCacheRoot()
    : path.join(app.getPath('temp'), 'mrt-media-cache')
  await fs.promises.mkdir(mediaCacheRoot, { recursive: true })
  await authorizedPaths.authorizeRoot(mediaCacheRoot)
  protocol.handle('local-resource', async (request) => {
    console.log(`[Local Protocol] Raw URL: ${request.url}`)
    const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const shouldDebugByUrl = isVideoMediaRequestUrl(request.url)
    if (shouldDebugByUrl) {
      logMainVideoDebug('local-resource-request', {
        requestId,
        method: request.method,
        url: request.url,
        range: request.headers.get('range'),
      })
    }

    const baseHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Accept-Ranges': 'bytes',
    }

    if (request.method === 'OPTIONS') {
      if (shouldDebugByUrl) {
        logMainVideoDebug('local-resource-options-response', {
          requestId,
          url: request.url,
        })
      }
      return new Response(null, { status: 204, headers: baseHeaders })
    }

    let filePath = ''
    try {
      const u = new URL(request.url)
      if (process.platform === 'win32') {
        const asFileUrl = request.url.replace(/^local-resource:/i, 'file:')
        try {
          filePath = path.resolve(fileURLToPath(asFileUrl))
          const host = String(u.hostname || '')
          if (/^[a-zA-Z]$/.test(host) && !/^[a-zA-Z]:[\\/]/.test(filePath)) {
            const pathname = decodeURIComponent(String(u.pathname || ''))
            filePath = `${host.toUpperCase()}:${pathname.replace(/\//g, '\\')}`
          }
        } catch {
          const host = String(u.hostname || '')
          const pathname = decodeURIComponent(String(u.pathname || ''))

          if (/^[a-zA-Z]$/.test(host)) {
            filePath = `${host.toUpperCase()}:${pathname.replace(/\//g, '\\')}`
          } else if (/^\/[a-zA-Z]:\//.test(pathname)) {
            filePath = pathname.slice(1).replace(/\//g, '\\')
          } else if (host) {
            filePath = `\\\\${host}${pathname.replace(/\//g, '\\')}`
          } else {
            filePath = pathname.replace(/\//g, '\\')
          }
        }
      } else {
        const host = decodeURIComponent(String(u.hostname || ''))
        const pathname = decodeURIComponent(String(u.pathname || ''))

        if (!host || host.toLowerCase() === 'localhost') {
          const asFileUrl = request.url.replace(/^local-resource:/i, 'file:')
          filePath = fileURLToPath(asFileUrl)
        } else {
          const normalizedPathname = pathname.startsWith('/') ? pathname : `/${pathname}`
          filePath = `/${host}${normalizedPathname}`
        }

        if (process.platform === 'darwin' && /^\/users(\/|$)/i.test(filePath)) {
          filePath = `/Users${filePath.slice('/users'.length)}`
        }
      }
    } catch {
      try {
        const fallback = request.url.replace(/^local-resource:\/\//i, '')
        const decoded = decodeURIComponent(fallback)
        if (process.platform === 'win32') {
          filePath = decoded
        } else {
          filePath = decoded.startsWith('/') ? decoded : `/${decoded}`
          if (process.platform === 'darwin' && /^\/users(\/|$)/i.test(filePath)) {
            filePath = `/Users${filePath.slice('/users'.length)}`
          }
        }
      } catch {
        const fallback = request.url.replace(/^local-resource:\/\//i, '')
        filePath = process.platform === 'win32' ? fallback : (fallback.startsWith('/') ? fallback : `/${fallback}`)
      }
    }

    console.log(`[Local Protocol] Resolved file path: ${filePath}`)
    const shouldDebug = shouldDebugByUrl || isVideoMediaFilePath(filePath)
    if (shouldDebug) {
      logMainVideoDebug('local-resource-path-resolved', {
        requestId,
        url: request.url,
        filePath,
        hasNonAsciiPath: hasNonAsciiPath(filePath),
      })
    }

    // Security gate: only project media/data files may be served, and never
    // anything inside protected system locations.
    const pathAuthorized = await authorizedPaths.isAuthorized(filePath)
    if (!isLocalResourceAllowedExtension(filePath) || !pathAuthorized) {
      logMainVideoDebug('local-resource-denied', {
        requestId,
        url: request.url,
        filePath,
        deniedReason: isLocalResourceAllowedExtension(filePath) ? 'unauthorized-path' : 'extension',
      })
      return new Response('Forbidden', {
        status: 403,
        headers: {
          ...baseHeaders,
          'Content-Type': 'text/plain; charset=utf-8',
        },
      })
    }

    try {
      const stat = await fs.promises.stat(filePath)
      const totalSize = stat.size
      const range = request.headers.get('range')
      const ext = path.extname(filePath).toLowerCase()
      const mimeType = getLocalResourceMimeType(filePath)
      if (shouldDebug) {
        logMainVideoDebug('local-resource-stat', {
          requestId,
          filePath,
          ext,
          totalSize,
          mimeType,
          range,
          mtimeMs: Math.floor(stat.mtimeMs),
        })
      }

      if (range) {
        const match = /bytes=(\d+)-(\d*)/.exec(range)
        if (match) {
          const start = Number.parseInt(match[1], 10)
          const requestedEnd = match[2] ? Number.parseInt(match[2], 10) : totalSize - 1
          if (!Number.isFinite(start) || start < 0 || start >= totalSize) {
            if (shouldDebug) {
              logMainVideoDebug('local-resource-range-invalid', {
                requestId,
                filePath,
                range,
                start,
                requestedEnd,
                totalSize,
              })
            }
            return new Response(null, {
              status: 416,
              headers: {
                ...baseHeaders,
                'Content-Range': `bytes */${totalSize}`,
              },
            })
          }
          const safeEnd = Math.max(start, Math.min(requestedEnd, totalSize - 1))
          const requestedChunkSize = safeEnd - start + 1
          const chunkSize = safeEnd - start + 1
          console.log(`[Local Protocol] Range ${start}-${safeEnd}/${totalSize}`)
          if (shouldDebug) {
            logMainVideoDebug('local-resource-range-response', {
              requestId,
              filePath,
              start,
              requestedEnd,
              safeEnd,
              totalSize,
              chunkSize,
              requestedChunkSize,
            })
          }
          const responseHeaders = {
            ...baseHeaders,
            'Content-Type': mimeType,
            'Content-Length': String(chunkSize),
            'Content-Range': `bytes ${start}-${safeEnd}/${totalSize}`,
          }
          if (request.method === 'HEAD') {
            return new Response(null, {
              status: 206,
              headers: responseHeaders,
            })
          }
          const stream = fs.createReadStream(filePath, { start, end: safeEnd })
          const body = Readable.toWeb(stream) as unknown as ReadableStream
          return new Response(body, {
            status: 206,
            headers: responseHeaders,
          })
        }
      }

      if (request.method === 'HEAD') {
        return new Response(null, {
          headers: {
            ...baseHeaders,
            'Content-Type': mimeType,
            'Content-Length': String(totalSize),
          },
        })
      }

      const stream = fs.createReadStream(filePath)
      const body = Readable.toWeb(stream) as unknown as ReadableStream
      if (shouldDebug) {
        logMainVideoDebug('local-resource-full-response', {
          requestId,
          filePath,
          totalSize,
          mimeType,
        })
      }
      return new Response(body, {
        headers: {
          ...baseHeaders,
          'Content-Type': mimeType,
          'Content-Length': String(totalSize),
        },
      })
    } catch (error) {
      console.error(`[Local Protocol] Error loading: ${filePath}`, error)
      if (shouldDebugByUrl || isVideoMediaFilePath(filePath)) {
        const err = getErrorDetails(error)
        logMainVideoDebug('local-resource-error', {
          requestId,
          url: request.url,
          filePath,
          message: err.message || String(error),
          code: err.code || null,
          name: err.name || null,
          stack: err.stack,
        })
      }
      return new Response('Internal Server Error', {
        status: 500,
        headers: {
          ...baseHeaders,
          'Content-Type': 'text/plain; charset=utf-8',
        },
      })
    }
  })
}
