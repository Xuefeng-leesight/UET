import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'

export type AuthorizedPathRegistry = {
  authorizeRoot: (rootPath: string) => Promise<string>
  isAuthorized: (targetPath: string) => Promise<boolean>
  roots: () => readonly string[]
}

function comparable(value: string): string {
  const normalized = path.resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isWithin(target: string, root: string): boolean {
  const targetValue = comparable(target)
  const rootValue = comparable(root)
  return targetValue === rootValue || targetValue.startsWith(`${rootValue}${path.sep}`)
}

async function canonicalizeExisting(value: string): Promise<string> {
  return fs.promises.realpath(path.resolve(value))
}

async function canonicalizeForWrite(value: string): Promise<string> {
  const resolved = path.resolve(value)
  let current = resolved
  const suffix: string[] = []
  while (true) {
    try {
      const realParent = await fs.promises.realpath(current)
      return path.join(realParent, ...suffix.reverse())
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      suffix.push(path.basename(current))
      current = parent
    }
  }
}

export function createAuthorizedPathRegistry(appTempRoot: string = path.join(os.tmpdir(), 'mrt-manager')): AuthorizedPathRegistry {
  const authorizedRoots = new Set<string>()
  let tempRootPromise: Promise<string> | null = null

  const ensureTempRoot = async (): Promise<string> => {
    if (!tempRootPromise) {
      tempRootPromise = fs.promises.mkdir(appTempRoot, { recursive: true })
        .then(() => canonicalizeExisting(appTempRoot))
    }
    return tempRootPromise
  }

  return {
    async authorizeRoot(rootPath: string): Promise<string> {
      const canonical = await canonicalizeExisting(rootPath)
      authorizedRoots.add(comparable(canonical))
      return canonical
    },
    async isAuthorized(targetPath: string): Promise<boolean> {
      if (!targetPath) return false
      const canonical = await canonicalizeForWrite(targetPath).catch(() => '')
      if (!canonical) return false
      const tempRoot = await ensureTempRoot().catch(() => '')
      if (tempRoot && isWithin(canonical, tempRoot)) return true
      return Array.from(authorizedRoots).some((root) => isWithin(canonical, root))
    },
    roots(): readonly string[] {
      return Array.from(authorizedRoots)
    },
  }
}
