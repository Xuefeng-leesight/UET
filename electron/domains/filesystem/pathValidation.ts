import * as fs from 'node:fs'
import path from 'node:path'

export async function validateUtf8Path(filePath: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const normalized = path.normalize(filePath)
    if (!normalized || normalized.includes('\0')) return { ok: false, error: '路径无效' }
    try {
      await fs.promises.access(normalized, fs.constants.F_OK)
    } catch {
      const parentDir = path.dirname(normalized)
      try {
        await fs.promises.access(parentDir, fs.constants.F_OK)
      } catch {
        return { ok: false, error: '父目录不存在或无法访问' }
      }
    }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: `路径验证失败：${error instanceof Error ? error.message : '未知错误'}`,
    }
  }
}

export function validateUtf8EncodingOnly(filePath: string): { ok: boolean; error?: string } {
  try {
    if (!filePath || typeof filePath !== 'string') return { ok: false, error: '路径不能为空' }
    if (filePath.includes('\0')) return { ok: false, error: '路径包含非法字符' }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: `路径校验失败：${error instanceof Error ? error.message : '未知错误'}`,
    }
  }
}
