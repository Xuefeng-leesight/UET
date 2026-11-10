import { ipcMain } from 'electron'
import * as fs from 'node:fs'
import path from 'node:path'
import { validateUtf8EncodingOnly } from './pathValidation'
import type { AuthorizedPathRegistry } from '../../platform/security/authorizedPaths'

type UnknownRecord = Record<string, unknown>
type NodeError = Error & { code?: string }

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' ? value as UnknownRecord : {}
}

function toEncoding(value: unknown): BufferEncoding {
  return typeof value === 'string' && value.trim().length > 0 ? value as BufferEncoding : 'utf-8'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误'
}

export function registerFileHandlers(authorizedPaths: AuthorizedPathRegistry): void {
  ipcMain.handle('save-file', async (_event, payload: unknown) => {
    const input = asRecord(payload)
    const filePath = typeof input.filePath === 'string' ? input.filePath : ''
    const encoding = toEncoding(input.encoding)
    const ensureDir = input.ensureDir !== false
    if (!filePath) return { ok: false, error: '缺少 filePath' }
    const normalizedPath = path.normalize(filePath)
    const utf8Validation = validateUtf8EncodingOnly(normalizedPath)
    if (!utf8Validation.ok) return { ok: false, error: utf8Validation.error }
    if (!await authorizedPaths.isAuthorized(normalizedPath)) return { ok: false, error: '路径未经用户授权' }
    try {
      if (ensureDir) await fs.promises.mkdir(path.dirname(normalizedPath), { recursive: true })
      const content = input.content
      if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
        await fs.promises.writeFile(normalizedPath, Buffer.from(content))
      } else if (typeof content === 'string') {
        await fs.promises.writeFile(normalizedPath, content, encoding)
      } else if (content === null || content === undefined) {
        await fs.promises.writeFile(normalizedPath, '', encoding)
      } else {
        await fs.promises.writeFile(normalizedPath, JSON.stringify(content, null, 2), encoding)
      }
      return { ok: true, path: normalizedPath }
    } catch (error) {
      return { ok: false, error: `写入文件失败：${errorMessage(error)}` }
    }
  })

  ipcMain.handle('append-file', async (_event, payload: unknown) => {
    const input = asRecord(payload)
    const filePath = typeof input.filePath === 'string' ? input.filePath : ''
    if (!filePath) return { ok: false, error: '缺少 filePath' }
    const normalizedPath = path.normalize(filePath)
    const utf8Validation = validateUtf8EncodingOnly(normalizedPath)
    if (!utf8Validation.ok) return { ok: false, error: utf8Validation.error }
    if (!await authorizedPaths.isAuthorized(normalizedPath)) return { ok: false, error: '路径未经用户授权' }
    try {
      const content = input.content
      const buffer = Buffer.isBuffer(content)
        ? content
        : content instanceof Uint8Array
          ? Buffer.from(content)
          : content instanceof ArrayBuffer
            ? Buffer.from(content)
            : null
      if (!buffer) return { ok: false, error: '追加文件只支持二进制分片' }
      await fs.promises.mkdir(path.dirname(normalizedPath), { recursive: true })
      await fs.promises.appendFile(normalizedPath, buffer)
      return { ok: true, path: normalizedPath, bytesWritten: buffer.length }
    } catch (error) {
      return { ok: false, error: `追加文件失败：${errorMessage(error)}` }
    }
  })

  ipcMain.handle('load-file', async (_event, payload: unknown) => {
    const input = asRecord(payload)
    const filePath = typeof input.filePath === 'string' ? input.filePath : ''
    const encoding = toEncoding(input.encoding)
    const asBuffer = input.asBuffer === true
    if (!filePath) return { ok: false, error: '缺少 filePath' }
    const normalizedPath = path.normalize(filePath)
    const utf8Validation = validateUtf8EncodingOnly(normalizedPath)
    if (!utf8Validation.ok) return { ok: false, error: utf8Validation.error }
    if (!await authorizedPaths.isAuthorized(normalizedPath)) return { ok: false, error: '路径未经用户授权' }
    try {
      await fs.promises.access(normalizedPath, fs.constants.F_OK | fs.constants.R_OK)
      if (asBuffer) {
        const raw = await fs.promises.readFile(normalizedPath)
        return { ok: true, path: normalizedPath, contentBase64: raw.toString('base64') }
      }
      const raw = await fs.promises.readFile(normalizedPath, encoding)
      return { ok: true, path: normalizedPath, content: raw }
    } catch (error) {
      const code = (error as NodeError)?.code
      if (code === 'ENOENT') return { ok: false, error: '文件不存在' }
      if (code === 'EACCES') return { ok: false, error: '文件不可读取（权限不足）' }
      return { ok: false, error: `读取文件失败：${errorMessage(error)}` }
    }
  })

  ipcMain.handle('create-directory', async (_event, payload: unknown) => {
    const input = asRecord(payload)
    const dirPath = typeof input.dirPath === 'string' ? input.dirPath : ''
    const recursive = input.recursive !== false
    if (!dirPath) return { ok: false, error: '缺少 dirPath' }
    const normalizedPath = path.normalize(dirPath)
    const utf8Validation = validateUtf8EncodingOnly(normalizedPath)
    if (!utf8Validation.ok) return { ok: false, error: utf8Validation.error }
    if (!await authorizedPaths.isAuthorized(normalizedPath)) return { ok: false, error: '路径未经用户授权' }
    try {
      await fs.promises.mkdir(normalizedPath, { recursive })
      return { ok: true, path: normalizedPath }
    } catch (error) {
      if ((error as NodeError)?.code === 'EACCES') return { ok: false, error: '目录创建失败：权限不足' }
      return { ok: false, error: `目录创建失败：${errorMessage(error)}` }
    }
  })
}
