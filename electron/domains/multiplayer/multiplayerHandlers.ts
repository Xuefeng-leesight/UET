import { ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import path from 'node:path'
import type { MultiplayerCoordinator } from './MultiplayerCoordinator'

type UnknownRecord = Record<string, unknown>
type LocalClientUpdate = Parameters<MultiplayerCoordinator['upsertLocal']>[0]
type ClientUpdate = Parameters<MultiplayerCoordinator['updateClient']>[1]

type PackageManifest = {
  version: string
  files: Array<{ relativePath: string; size: number; sha256: string }>
  totalBytes: number
}

async function collectFilesRecursively(root: string): Promise<string[]> {
  const files: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return files
    throw error
  }
  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...await collectFilesRecursively(absolutePath))
    else if (entry.isFile()) files.push(absolutePath)
  }
  return files
}

async function removeEmptyDirectories(root: string): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const child = path.join(root, entry.name)
    await removeEmptyDirectories(child)
    const remaining = await fs.promises.readdir(child)
    if (remaining.length === 0) await fs.promises.rmdir(child)
  }
}

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' ? value as UnknownRecord : {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resolvePackageRoot(experimentDir: string, versionValue: unknown): string {
  const version = String(versionValue || '').trim()
  if (!version || version === '.' || version === '..' || !/^[a-zA-Z0-9._-]{1,80}$/.test(version)) {
    throw new Error('素材包版本无效')
  }
  const packagesRoot = path.resolve(experimentDir, '.multiplayer', 'packages')
  const packageRoot = path.resolve(packagesRoot, version)
  const safeRoot = `${packagesRoot}${path.sep}`
  if (!packageRoot.startsWith(safeRoot)) throw new Error('素材包版本路径越界')
  return packageRoot
}

export function registerMultiplayerHandlers(multiplayerCoordinator: MultiplayerCoordinator): void {
  ipcMain.handle('multiplayer-start-coordinator', async (_event, payload: unknown) => {
    const input = asRecord(payload)
    try {
      return { ok: true, snapshot: await multiplayerCoordinator.start(Number(input.port || 17860)) }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })

  ipcMain.handle('multiplayer-stop-coordinator', async () => {
    try {
      return { ok: true, snapshot: await multiplayerCoordinator.stop() }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })

  ipcMain.handle('multiplayer-get-snapshot', async () => {
    return { ok: true, snapshot: multiplayerCoordinator.snapshot() }
  })

  ipcMain.handle('multiplayer-update-local-client', async (_event, payload: unknown) => {
    try {
      return { ok: true, snapshot: multiplayerCoordinator.upsertLocal(asRecord(payload) as LocalClientUpdate) }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })

  ipcMain.handle('multiplayer-update-client', async (_event, payload: unknown) => {
    const input = asRecord(payload)
    try {
      return {
        ok: true,
        snapshot: multiplayerCoordinator.updateClient(
          String(input.clientId || ''),
          asRecord(input.patch) as ClientUpdate,
        ),
      }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })

  ipcMain.handle('multiplayer-remove-client', async (_event, payload: unknown) => {
    const input = asRecord(payload)
    try {
      return {
        ok: true,
        snapshot: multiplayerCoordinator.removeClient(String(input.clientId || '')),
      }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })

  ipcMain.handle('multiplayer-publish-package', async (_event, payload: unknown) => {
    const input = asRecord(payload)
    try {
      return {
        ok: true,
        snapshot: await multiplayerCoordinator.publishPackage(String(input.experimentDir || '')),
      }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })

  ipcMain.handle('multiplayer-create-session', async (_event, payload: unknown) => {
    const input = asRecord(payload)
    try {
      return {
        ok: true,
        snapshot: multiplayerCoordinator.createSession(String(input.name || '多人采集任务')),
      }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })

  ipcMain.handle('multiplayer-ack-command', async (_event, payload: unknown) => {
    const input = asRecord(payload)
    try {
      return {
        ok: true,
        snapshot: multiplayerCoordinator.ackCommand(
          String(input.clientId || ''),
          String(input.commandId || ''),
        ),
      }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })

  ipcMain.handle('multiplayer-issue-command', async (_event, payload: unknown) => {
    const input = asRecord(payload)
    try {
      const type = String(input.type || '')
      if (type !== 'prepare' && type !== 'start' && type !== 'stop') {
        return { ok: false, message: '不支持的多人命令' }
      }
      return {
        ok: true,
        ...multiplayerCoordinator.issue(type, Number(input.delayMs || 0)),
      }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })

  ipcMain.handle('multiplayer-sync-package', async (_event, payload: unknown) => {
    const input = asRecord(payload)
    const coordinatorUrl = String(input.coordinatorUrl || '').replace(/\/+$/, '')
    const experimentDir = path.resolve(String(input.experimentDir || ''))
    if (!/^https?:\/\/[^/]+$/i.test(coordinatorUrl) || !experimentDir) {
      return { ok: false, message: '主控地址或本地实验目录无效' }
    }
    try {
      const manifestResponse = await fetch(`${coordinatorUrl}/api/package/manifest`)
      if (!manifestResponse.ok) throw new Error(`读取素材清单失败（${manifestResponse.status}）`)
      const manifest = await manifestResponse.json() as PackageManifest
      const packageRoot = resolvePackageRoot(experimentDir, manifest.version)
      if (!Array.isArray(manifest.files)) throw new Error('素材清单格式无效')
      await fs.promises.mkdir(packageRoot, { recursive: true })
      const stimuliRoot = path.resolve(experimentDir, 'stimuli')
      const safeStimuliRoot = `${stimuliRoot}${path.sep}`
      const expectedPaths = new Set<string>()
      let completedBytes = 0
      for (const file of manifest.files) {
        const relativePath = String(file.relativePath || '')
        const outputPath = path.resolve(experimentDir, relativePath)
        if (!outputPath.startsWith(safeStimuliRoot)) throw new Error(`素材路径越界：${relativePath}`)
        if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/i.test(String(file.sha256 || ''))) {
          throw new Error(`素材清单条目无效：${relativePath}`)
        }
        if (expectedPaths.has(outputPath)) throw new Error(`素材清单包含重复路径：${relativePath}`)
        expectedPaths.add(outputPath)
        let reuse = false
        try {
          const existing = await fs.promises.readFile(outputPath)
          reuse = existing.length === Number(file.size)
            && createHash('sha256').update(existing).digest('hex') === String(file.sha256)
        } catch {
        }
        if (!reuse) {
          const response = await fetch(`${coordinatorUrl}/api/package/file?path=${encodeURIComponent(relativePath)}`)
          if (!response.ok) throw new Error(`下载素材失败：${relativePath}`)
          const bytes = Buffer.from(await response.arrayBuffer())
          const hash = createHash('sha256').update(bytes).digest('hex')
          if (hash !== String(file.sha256)) throw new Error(`素材校验失败：${relativePath}`)
          await fs.promises.mkdir(path.dirname(outputPath), { recursive: true })
          await fs.promises.writeFile(outputPath, bytes)
        }
        completedBytes += Number(file.size || 0)
      }
      // The host manifest is authoritative. Cleanup happens only after every
      // desired file has downloaded and passed its hash check, so a partial
      // sync can never remove the client's last usable asset set.
      const localStimulusFiles = await collectFilesRecursively(stimuliRoot)
      const staleFiles = localStimulusFiles.filter((localPath) => !expectedPaths.has(localPath))
      if (staleFiles.length > 0) {
        const quarantineRoot = path.join(experimentDir, '.multiplayer', 'removed-assets', String(Date.now()))
        for (const localPath of staleFiles) {
          const quarantinePath = path.join(quarantineRoot, path.relative(stimuliRoot, localPath))
          await fs.promises.mkdir(path.dirname(quarantinePath), { recursive: true })
          await fs.promises.rename(localPath, quarantinePath)
        }
      }
      await removeEmptyDirectories(stimuliRoot)
      const installedManifestPath = path.join(packageRoot, 'multiplayer-package.json')
      await fs.promises.writeFile(installedManifestPath, JSON.stringify({
        ...manifest,
        coordinatorUrl,
        installedAt: new Date().toISOString(),
      }, null, 2), 'utf-8')
      return {
        ok: true,
        version: manifest.version,
        packageRoot,
        fileCount: manifest.files?.length || 0,
        totalBytes: manifest.totalBytes || completedBytes,
      }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  })
}
