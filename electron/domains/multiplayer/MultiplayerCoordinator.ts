import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import path from 'node:path'

type ClientStatus = {
  id: string
  name: string
  included: boolean
  status: string
  deviceConnected: boolean
  recordingEligible: boolean
  recordingEligibilityReason?: string
  packageVersion: string
  packageProgress: number
  lastSeenAt: number
  clockOffsetMs?: number
  roundTripMs?: number
  preparedSessionId?: string
  preparedAt?: number
  recordingStartedAt?: number
  startDeviationMs?: number
  error?: string
}

type Command = {
  id: string
  sessionId: string
  type: 'prepare' | 'start' | 'stop'
  executeAt?: number
  createdAt: number
}

type PackageFile = { relativePath: string; size: number; sha256: string }
type JsonObject = Record<string, unknown>
type MultiplayerSession = {
  id: string
  name: string
  packageVersion: string
  state: 'draft' | 'preparing' | 'armed' | 'recording' | 'stopping' | 'completed'
  createdAt: number
  plannedStartAt?: number
  plannedStopAt?: number
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  })
  res.end(JSON.stringify(body))
}

const readJson = async (req: http.IncomingMessage): Promise<JsonObject> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  if (chunks.length === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as JsonObject
    : {}
}

const safeId = (value: unknown, fallback: string) => {
  const normalized = String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80)
  return normalized || fallback
}

async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve())
    stream.on('error', (err) => reject(err))
  })
  return hash.digest('hex')
}

const networkHost = () => {
  const interfaces = os.networkInterfaces()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return '127.0.0.1'
}

type PackageFileCandidate = { absolutePath: string; relativePath: string; size: number }

async function collectPackageFiles(root: string, current = root): Promise<PackageFileCandidate[]> {
  const result: PackageFileCandidate[] = []
  const entries = await fs.promises.readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'recordings' || entry.name === 'monitor' || entry.name === 'analysis') continue
    const absolute = path.join(current, entry.name)
    if (entry.isDirectory()) {
      result.push(...await collectPackageFiles(root, absolute))
    } else if (entry.isFile()) {
      const stat = await fs.promises.stat(absolute)
      result.push({
        absolutePath: absolute,
        relativePath: path.relative(root, absolute).split(path.sep).join('/'),
        size: stat.size,
      })
    }
  }
  return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

async function walkPackage(root: string, current = root): Promise<PackageFile[]> {
  const candidates = await collectPackageFiles(root, current)
  const result = new Array<PackageFile>(candidates.length)
  let cursor = 0
  const workerCount = Math.min(4, Math.max(1, candidates.length))
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < candidates.length) {
      const index = cursor
      cursor += 1
      const candidate = candidates[index]
      // A small bounded worker pool keeps the UI responsive while avoiding an
      // unbounded number of simultaneous reads on slower Windows disks.
      const sha256 = await hashFileSha256(candidate.absolutePath)
      result[index] = {
        relativePath: candidate.relativePath,
        size: candidate.size,
        sha256,
      }
    }
  }))
  return result
}

export class MultiplayerCoordinator {
  private server: http.Server | null = null
  private port = 17860
  private clients = new Map<string, ClientStatus>()
  private commands = new Map<string, Command[]>()
  private session: MultiplayerSession | null = null
  private packageRoot = ''
  private packageManifest: { version: string; files: PackageFile[]; totalBytes: number; publishedAt: number } | null = null

  private pruneStaleClients() {
    const staleBefore = Date.now() - 10000
    for (const [id, client] of this.clients) {
      if (id !== 'client-a' && client.lastSeenAt < staleBefore) {
        this.clients.delete(id)
        this.commands.delete(id)
      }
    }
  }

  private refreshSessionState() {
    if (!this.session) return
    const included = Array.from(this.clients.values()).filter((client) => client.included)
    if (included.some((client) => client.status === 'recording')) {
      this.session.state = 'recording'
      return
    }
    if (included.some((client) => client.status === 'finalizing')) {
      this.session.state = 'stopping'
      return
    }
    if (included.length > 0 && included.every((client) => client.status === 'completed')) {
      this.session.state = 'completed'
    }
  }

  snapshot() {
    this.pruneStaleClients()
    return {
      running: Boolean(this.server),
      role: this.server ? 'coordinator' : 'standalone',
      host: networkHost(),
      port: this.port,
      localClientId: 'client-a',
      localClientName: this.clients.get('client-a')?.name || 'A 主控机',
      session: this.session,
      packageInfo: this.packageManifest ? {
        experimentDir: this.packageRoot,
        version: this.packageManifest.version,
        fileCount: this.packageManifest.files.length,
        totalBytes: this.packageManifest.totalBytes,
        publishedAt: this.packageManifest.publishedAt,
      } : null,
      clients: Array.from(this.clients.values()),
    }
  }

  async start(port = 17860) {
    if (this.server) return this.snapshot()
    this.port = Number.isFinite(port) ? Math.max(1024, Math.min(65535, Math.round(port))) : 17860
    this.server = http.createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.port, '0.0.0.0', () => resolve())
    })
    // Runtime errors after bind (e.g. client resets) must not crash the process.
    this.server.on('error', (err) => console.error('[multiplayer] server runtime error', err))
    return this.snapshot()
  }

  async stop() {
    const current = this.server
    this.server = null
    if (current) await new Promise<void>((resolve) => current.close(() => resolve()))
    this.clients.clear()
    this.commands.clear()
    this.session = null
    return this.snapshot()
  }

  upsertLocal(input: Partial<ClientStatus>) {
    const id = safeId(input.id, 'client-a')
    const previous = this.clients.get(id)
    this.clients.set(id, {
      id,
      name: String(input.name || previous?.name || 'A 主控机'),
      included: input.included ?? previous?.included ?? true,
      status: String(input.status || previous?.status || 'connected'),
      deviceConnected: Boolean(input.deviceConnected ?? previous?.deviceConnected),
      recordingEligible: Boolean(input.recordingEligible ?? previous?.recordingEligible ?? true),
      recordingEligibilityReason: String(input.recordingEligibilityReason ?? previous?.recordingEligibilityReason ?? ''),
      packageVersion: String(input.packageVersion ?? previous?.packageVersion ?? ''),
      packageProgress: Number(input.packageProgress ?? previous?.packageProgress ?? 0),
      lastSeenAt: Date.now(),
      clockOffsetMs: input.clockOffsetMs ?? previous?.clockOffsetMs,
      roundTripMs: input.roundTripMs ?? previous?.roundTripMs,
      preparedSessionId: input.preparedSessionId ?? previous?.preparedSessionId,
      preparedAt: input.preparedAt ?? previous?.preparedAt,
      recordingStartedAt: input.recordingStartedAt ?? previous?.recordingStartedAt,
      startDeviationMs: input.startDeviationMs ?? previous?.startDeviationMs,
      error: input.error ?? previous?.error,
    })
    this.refreshSessionState()
    return this.snapshot()
  }

  updateClient(id: string, patch: Partial<ClientStatus>) {
    const previous = this.clients.get(id)
    if (!previous) throw new Error('客户端不存在')
    this.clients.set(id, { ...previous, ...patch, id, lastSeenAt: Date.now() })
    this.refreshSessionState()
    return this.snapshot()
  }

  removeClient(id: string) {
    this.clients.delete(id)
    this.commands.delete(id)
    this.refreshSessionState()
    return this.snapshot()
  }

  ackCommand(clientId: string, commandId: string) {
    const id = safeId(clientId, '')
    const normalizedCommandId = String(commandId || '').trim()
    if (!id || !normalizedCommandId) throw new Error('客户端或命令标识无效')
    this.commands.set(id, (this.commands.get(id) || []).filter((command) => command.id !== normalizedCommandId))
    return this.snapshot()
  }

  async publishPackage(experimentDir: string) {
    const root = path.resolve(String(experimentDir || ''))
    const stat = await fs.promises.stat(root)
    if (!stat.isDirectory()) throw new Error('实验目录不存在')
    const stimuliRoot = path.join(root, 'stimuli')
    const stimuliStat = await fs.promises.stat(stimuliRoot)
    if (!stimuliStat.isDirectory()) throw new Error('当前实验缺少 stimuli 素材目录')
    const files = await walkPackage(root, stimuliRoot)
    const version = createHash('sha256')
      .update(files.map((file) => `${file.relativePath}:${file.size}:${file.sha256}`).join('\n'))
      .digest('hex')
      .slice(0, 12)
    this.packageRoot = root
    this.packageManifest = {
      version,
      files,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      publishedAt: Date.now(),
    }
    return this.snapshot()
  }

  createSession(name: string) {
    this.session = {
      id: `session-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomUUID().slice(0, 6)}`,
      name: String(name || '多人采集任务').trim(),
      packageVersion: this.packageManifest?.version || '',
      state: 'draft',
      createdAt: Date.now(),
    }
    return this.snapshot()
  }

  issue(type: Command['type'], delayMs = 0) {
    if (!this.session) throw new Error('请先创建多人任务')
    const executeAt = type === 'start' || type === 'stop' ? Date.now() + Math.max(1500, delayMs) : undefined
    const command: Command = {
      id: randomUUID(),
      sessionId: this.session.id,
      type,
      executeAt,
      createdAt: Date.now(),
    }
    const commandExpiry = Date.now() - 120000
    for (const client of this.clients.values()) {
      if (!client.included) continue
      const active = (this.commands.get(client.id) || []).filter((pending) => pending.createdAt >= commandExpiry)
      this.commands.set(client.id, [...active, command])
    }
    if (type === 'prepare') this.session.state = 'preparing'
    if (type === 'start') {
      this.session.state = 'armed'
      this.session.plannedStartAt = executeAt
    }
    if (type === 'stop') {
      this.session.state = 'stopping'
      this.session.plannedStopAt = executeAt
    }
    return { command, snapshot: this.snapshot() }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type',
        })
        res.end()
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/snapshot') {
        json(res, 200, this.snapshot())
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/time') {
        const serverReceiveAt = Date.now()
        json(res, 200, { serverReceiveAt, serverSendAt: Date.now() })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/register') {
        const body = await readJson(req)
        const id = safeId(body.clientId, `client-${randomUUID().slice(0, 8)}`)
        const previous = this.clients.get(id)
        this.clients.set(id, {
          id,
          name: String(body.clientName || previous?.name || id),
          included: previous?.included ?? true,
          status: String(body.status || previous?.status || 'connected'),
          deviceConnected: Boolean(body.deviceConnected),
          recordingEligible: Boolean(body.recordingEligible ?? true),
          recordingEligibilityReason: String(body.recordingEligibilityReason || ''),
          packageVersion: String(body.packageVersion || previous?.packageVersion || ''),
          packageProgress: Number(body.packageProgress ?? previous?.packageProgress ?? 0),
          clockOffsetMs: typeof body.clockOffsetMs === 'number' ? body.clockOffsetMs : previous?.clockOffsetMs,
          roundTripMs: typeof body.roundTripMs === 'number' ? body.roundTripMs : previous?.roundTripMs,
          preparedSessionId: typeof body.preparedSessionId === 'string'
            ? body.preparedSessionId
            : previous?.preparedSessionId,
          preparedAt: typeof body.preparedAt === 'number' ? body.preparedAt : previous?.preparedAt,
          recordingStartedAt: typeof body.recordingStartedAt === 'number'
            ? body.recordingStartedAt
            : previous?.recordingStartedAt,
          startDeviationMs: typeof body.startDeviationMs === 'number'
            ? body.startDeviationMs
            : previous?.startDeviationMs,
          lastSeenAt: Date.now(),
        })
        json(res, 200, { ok: true, clientId: id, snapshot: this.snapshot() })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/status') {
        const body = await readJson(req)
        const id = safeId(body.clientId, '')
        const previous = this.clients.get(id)
        if (!previous) return json(res, 404, { ok: false, message: 'client not registered' })
        this.clients.set(id, {
          ...previous,
          name: typeof body.name === 'string' ? body.name : previous.name,
          included: typeof body.included === 'boolean' ? body.included : previous.included,
          status: typeof body.status === 'string' ? body.status : previous.status,
          deviceConnected: typeof body.deviceConnected === 'boolean' ? body.deviceConnected : previous.deviceConnected,
          recordingEligible: typeof body.recordingEligible === 'boolean' ? body.recordingEligible : previous.recordingEligible,
          recordingEligibilityReason: typeof body.recordingEligibilityReason === 'string'
            ? body.recordingEligibilityReason
            : previous.recordingEligibilityReason,
          packageVersion: typeof body.packageVersion === 'string' ? body.packageVersion : previous.packageVersion,
          packageProgress: typeof body.packageProgress === 'number' ? body.packageProgress : previous.packageProgress,
          clockOffsetMs: typeof body.clockOffsetMs === 'number' ? body.clockOffsetMs : previous.clockOffsetMs,
          roundTripMs: typeof body.roundTripMs === 'number' ? body.roundTripMs : previous.roundTripMs,
          preparedSessionId: typeof body.preparedSessionId === 'string'
            ? body.preparedSessionId
            : previous.preparedSessionId,
          preparedAt: typeof body.preparedAt === 'number' ? body.preparedAt : previous.preparedAt,
          recordingStartedAt: typeof body.recordingStartedAt === 'number'
            ? body.recordingStartedAt
            : previous.recordingStartedAt,
          startDeviationMs: typeof body.startDeviationMs === 'number' ? body.startDeviationMs : previous.startDeviationMs,
          error: typeof body.error === 'string' ? body.error : previous.error,
          id,
          lastSeenAt: Date.now(),
        })
        this.refreshSessionState()
        json(res, 200, { ok: true })
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/commands') {
        const id = safeId(url.searchParams.get('clientId'), '')
        const expiry = Date.now() - 120000
        const pending = (this.commands.get(id) || []).filter((command) => command.createdAt >= expiry)
        this.commands.set(id, pending)
        json(res, 200, { commands: pending })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/commands/ack') {
        const body = await readJson(req)
        const id = safeId(body.clientId, '')
        const commandId = String(body.commandId || '').trim()
        if (!id || !commandId) return json(res, 400, { ok: false, message: 'invalid ack' })
        this.commands.set(id, (this.commands.get(id) || []).filter((command) => command.id !== commandId))
        json(res, 200, { ok: true })
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/package/manifest') {
        if (!this.packageManifest) return json(res, 404, { ok: false, message: 'package not published' })
        json(res, 200, this.packageManifest)
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/package/file') {
        if (!this.packageManifest || !this.packageRoot) return json(res, 404, { ok: false })
        const relativePath = decodeURIComponent(url.searchParams.get('path') || '')
        const manifestFile = this.packageManifest.files.find((file) => file.relativePath === relativePath)
        if (!manifestFile) return json(res, 404, { ok: false })
        const absolute = path.resolve(this.packageRoot, relativePath)
        const safeRoot = this.packageRoot.endsWith(path.sep) ? this.packageRoot : `${this.packageRoot}${path.sep}`
        // Windows paths are case-insensitive; normalize both sides before the containment check.
        const toComparable = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value)
        if (!toComparable(absolute).startsWith(toComparable(safeRoot))) return json(res, 403, { ok: false })
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': manifestFile.size,
          'access-control-allow-origin': '*',
        })
        fs.createReadStream(absolute).pipe(res)
        return
      }
      json(res, 404, { ok: false, message: 'not found' })
    } catch (error) {
      json(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  }
}
