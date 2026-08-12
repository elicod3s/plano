/**
 * AgentHostClient — the main-process bridge to the detached Agent Host (see daemon/index.ts).
 *
 * Responsibilities:
 *   - Ensure the host is running: read <userData>/agent-host.json, verify the pid is alive and the
 *     port answers, otherwise spawn the host (a detached `ELECTRON_RUN_AS_NODE` child of THIS
 *     Electron binary — same ABI, so node-pty loads — that unrefs and survives app quit) and wait
 *     for its port file.
 *   - Speak the newline-delimited JSON protocol: request/response with a monotonic id + a timeout,
 *     and events (data / exit / sessions) dispatched to registered handlers.
 *   - On graceful disconnect (app quit with "keep agents" on): close the socket only — the host
 *     keeps every session running and buffering. On shutdown: tell the host to kill everything.
 *   - Survive host death: if the socket drops mid-session, the next request re-ensures a host.
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface HostSessionInfo {
  ptyId: string
  panelId: string
  terminalId: string
  spaceId: string
  cwd: string
  shellName: string
  pid: number
  exited: boolean
  exitCode?: number
  exitSignal?: number
  attached: boolean
}

export interface HostCreateRequest {
  ptyId: string
  panelId: string
  terminalId: string
  spaceId: string
  cwd?: string
  shell?: string
  cols: number
  rows: number
  predictiveHistory?: boolean
  bootCommand?: string
  autoDetectRoot?: boolean
}

export interface HostCreateResult {
  ok: boolean
  pid?: number
  shellName?: string
  cwd?: string
  notice?: string
  error?: string
}

export interface HostAttachResult {
  ok: boolean
  exited: boolean
  exitCode?: number
  buffer: string
}

interface HostFile {
  pid: number
  port: number
  token: string
  version?: string
  startedAt?: number
  ptyAvailable?: boolean
}

type EventHandler = (frame: Record<string, unknown>) => void
/** Handler for requests the HOST makes of the app (getWorkspaces / resolveSpace). */
type RequestHandler = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>

const HOST_FILE = 'agent-host.json'
const CONNECT_TIMEOUT_MS = 3000
const SPAWN_WAIT_MS = 12_000
const RPC_TIMEOUT_MS = 20_000

export class AgentHostClient {
  private socket: Socket | null = null
  private child: ChildProcess | null = null
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private nextId = 1
  private buffer = ''
  private eventHandlers = new Set<EventHandler>()
  private ensuring: Promise<void> | null = null
  private connectAttempts = 0
  private lastError: string | null = null

  constructor(
    private readonly userDataPath: string,
    private readonly log: (event: string, details?: unknown) => void,
    private readonly webRoot?: string,
  ) {}

  /** Register an event handler (data / exit / sessions frames). Returns an unsubscribe. */
  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  private requestHandler: RequestHandler | null = null
  private externalTerminalHandler: ((session: Record<string, unknown>) => void) | null = null
  private meshEventHandler: ((event: Record<string, unknown>) => void) | null = null

  /** Handle requests the host asks of the app (e.g. getWorkspaces for the mobile view). */
  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler
  }

  /** A terminal/agent was created from the MOBILE web app while PLANO is running. */
  onExternalTerminal(handler: (session: Record<string, unknown>) => void): void {
    this.externalTerminalHandler = handler
  }

  /** Plan F7: mesh timeline events (agent-up/down, msg-*) for the link layer + audit trail. */
  onMeshEvent(handler: (event: Record<string, unknown>) => void): void {
    this.meshEventHandler = handler
  }

  lastHostError(): string | null {
    return this.lastError
  }

  private hostFilePath(): string {
    return join(this.userDataPath, HOST_FILE)
  }

  private readHostFile(): HostFile | null {
    try {
      const raw = readFileSync(this.hostFilePath(), 'utf8')
      const parsed = JSON.parse(raw) as Partial<HostFile>
      if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string' || !parsed.token) {
        return null
      }
      return { pid: typeof parsed.pid === 'number' ? parsed.pid : -1, port: parsed.port, token: parsed.token }
    } catch {
      return null
    }
  }

  private pidAlive(pid: number): boolean {
    if (!pid || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private daemonScriptPath(): string {
    // Same layout in dev and packaged: <app>/out/main/daemon.js (inside app.asar when packaged).
    return join(app.getAppPath(), 'out', 'main', 'daemon.js')
  }

  private spawnDaemon(): void {
    const script = this.daemonScriptPath()
    const args = [script, '--userData', this.userDataPath]
    if (this.webRoot) args.push('--webRoot', this.webRoot)
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PLANO_APP_VERSION: app.getVersion(),
      },
    })
    this.child = child
    child.unref()
    child.on('error', (err) => {
      this.lastError = `agent-host spawn failed: ${err.message}`
      this.log('agent-host-spawn-error', { error: err.message, script })
    })
    this.log('agent-host-spawned', { script, pid: child.pid })
  }

  /** Spawn or reconnect to the host, waiting for its port file. */
  async ensureHost(): Promise<void> {
    if (this.ensuring) return this.ensuring
    this.ensuring = this.doEnsure().finally(() => {
      this.ensuring = null
    })
    return this.ensuring
  }

  private async doEnsure(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return

    // 1. A stale-but-alive host may still hold sessions: try its recorded port first.
    const existing = this.readHostFile()
    if (existing) {
      if (this.pidAlive(existing.pid)) {
        try {
          await this.connectTo(existing)
          // An update does NOT replace a running host — it survives app closes by design, so the
          // new build's daemon (mesh provisioning, CLI-on-PATH, protocol) would stay dormant until
          // the machine rebooted. Retire a host from another app version, but only while nothing
          // is running inside it: live sessions are the user's agents and outrank a version bump.
          const hostVersion = String(existing.version ?? '')
          if (hostVersion && hostVersion !== app.getVersion() && (await this.sessions().catch(() => [])).length === 0) {
            this.log('agent-host-version-restart', { from: hostVersion, to: app.getVersion(), hostPid: existing.pid })
            await this.shutdown()
            await new Promise((r) => setTimeout(r, 400))
          } else {
            return
          }
        } catch (err) {
          this.log('agent-host-connect-failed', { error: String(err) })
        }
      }
      // Port file is stale (daemon died while the app was closed). Sessions are lost — the
      // renderer will respawn terminals. A fresh host replaces the file.
      this.log('agent-host-stale-file', { pid: existing.pid })
    }

    // 2. Spawn a fresh host and wait for ITS port file.
    this.spawnDaemon()
    const deadline = Date.now() + SPAWN_WAIT_MS
    let last: HostFile | null = null
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250))
      const file = this.readHostFile()
      if (file && file.token && (this.child?.pid ?? -1) !== -1) {
        // The file could belong to an older host that just got replaced — accept only one whose
        // pid matches our child (or, if no child handle, any live one).
        if (!this.child || file.pid === this.child.pid || this.pidAlive(file.pid)) {
          last = file
          break
        }
      }
      if (this.connectAttempts++ > 8) break
    }
    if (!last) {
      this.lastError = 'agent-host did not come up in time'
      this.log('agent-host-spawn-timeout', { script: this.daemonScriptPath(), logPath: join(this.userDataPath, 'logs', 'agent-host.log') })
      throw new Error(this.lastError)
    }
    try {
      await this.connectTo(last)
    } catch (err) {
      this.lastError = `agent-host handshake failed: ${String(err)}`
      throw new Error(this.lastError)
    }
  }

  private connectTo(info: HostFile): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect({ port: info.port, host: '127.0.0.1' })
      const timeout = setTimeout(() => {
        socket.destroy()
        reject(new Error('connect timeout'))
      }, CONNECT_TIMEOUT_MS)

      socket.once('connect', () => {
        clearTimeout(timeout)
        this.attachSocket(socket, info)
        // Handshake: hello carries the token; the host answers with the live session list.
        void this.request('hello', { token: info.token })
          .then(() => {
            this.log('agent-host-connected', { port: info.port, hostPid: info.pid })
            resolve()
          })
          .catch((err) => {
            socket.destroy()
            reject(err)
          })
      })
      socket.once('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })
  }

  private attachSocket(socket: Socket, _info: HostFile): void {
    this.socket = socket
    this.buffer = ''
    this.pending.clear()

    socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8')
      let nl: number
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl)
        this.buffer = this.buffer.slice(nl + 1)
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; event?: string; method?: string; params?: Record<string, unknown>; session?: Record<string, unknown>; meshEvent?: Record<string, unknown> }
          if (msg.event === 'request' && typeof msg.id === 'number' && msg.method) {
            // The host asks the app for data (mobile view) — check BEFORE the generic RPC-reply
            // branch (requests carry an id too, so the id check alone would swallow them).
            const handler = this.requestHandler
            if (handler) {
              Promise.resolve(handler(msg.method, msg.params ?? {}))
                .then((result) => {
                  try {
                    socket.write(JSON.stringify({ event: 'response', id: msg.id, params: result }) + '\n')
                  } catch {
                    /* socket closing */
                  }
                })
                .catch(() => {
                  try {
                    socket.write(JSON.stringify({ event: 'response', id: msg.id, params: null }) + '\n')
                  } catch {
                    /* socket closing */
                  }
                })
            } else {
              try {
                socket.write(JSON.stringify({ event: 'response', id: msg.id, params: null }) + '\n')
              } catch {
                /* socket closing */
              }
            }
          } else if (typeof msg.id === 'number') {
            const pending = this.pending.get(msg.id)
            if (pending) {
              this.pending.delete(msg.id)
              clearTimeout(pending.timer)
              pending.resolve(msg.result)
            }
          } else if (msg.event === 'external-terminal' && msg.session) {
            this.externalTerminalHandler?.(msg.session as Record<string, unknown>)
          } else if (msg.event === 'mesh' && msg.meshEvent) {
            // Plan F7: mesh timeline events (agent-up/down, msg-*) — the renderer link layer
            // and the AgentManager audit trail subscribe to these.
            this.meshEventHandler?.(msg.meshEvent as Record<string, unknown>)
          } else if (msg.event) {
            for (const handler of this.eventHandlers) {
              try {
                handler(msg as unknown as Record<string, unknown>)
              } catch {
                /* handler errors must never break the host bridge */
              }
            }
          }
        } catch {
          /* malformed frame — skip */
        }
      }
    })

    socket.on('error', () => {
      /* handled by close */
    })

    socket.on('close', () => {
      this.log('agent-host-disconnected', { hadPending: this.pending.size })
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('agent-host disconnected'))
      }
      this.pending.clear()
      if (this.socket === socket) {
        this.socket = null
      }
    })
  }

  /** Fire a request; re-ensures the host on a dead connection, retrying once. */
  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.socket || this.socket.destroyed) {
      await this.ensureHost()
    }
    try {
      return await this.rawRequest(method, params)
    } catch (err) {
      // One retry through a fresh connection (host may have died underneath us).
      await this.ensureHost()
      return this.rawRequest(method, params)
    }
  }

  private rawRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket
    if (!socket) return Promise.reject(new Error('no agent-host connection'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`agent-host RPC timeout: ${method}`))
      }, RPC_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try {
        socket.write(JSON.stringify({ id, method, params }) + '\n')
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  // ── public host operations ────────────────────────────────────────────────

  async create(req: HostCreateRequest): Promise<HostCreateResult> {
    const result = (await this.request('create', req as unknown as Record<string, unknown>)) as HostCreateResult
    return result
  }

  async write(ptyId: string, data: string): Promise<void> {
    await this.request('write', { ptyId, data })
  }

  async resize(ptyId: string, cols: number, rows: number): Promise<void> {
    await this.request('resize', { ptyId, cols, rows })
  }

  async kill(ptyId: string): Promise<boolean> {
    const result = (await this.request('kill', { ptyId })) as { ok?: boolean }
    return result?.ok === true
  }

  async attach(ptyId: string): Promise<HostAttachResult> {
    return (await this.request('attach', { ptyId })) as HostAttachResult
  }

  async detach(ptyId: string): Promise<void> {
    await this.request('detach', { ptyId })
  }

  async sessions(): Promise<HostSessionInfo[]> {
    const result = (await this.request('sessions')) as { sessions?: HostSessionInfo[] }
    return result?.sessions ?? []
  }

  /** Push a rich detection verdict to the host (the mobile view sees it live). */
  async reportVerdict(ptyId: string, verdict: unknown): Promise<void> {
    try {
      await this.request('reportVerdict', { ptyId, verdict })
    } catch {
      /* best effort — the phone falls back to light detection */
    }
  }

  /** Number of connected phone WebSocket clients (TopBar badge). */
  async phoneClients(): Promise<number> {
    try {
      const result = (await this.request('phoneClients')) as { count?: number }
      return typeof result?.count === 'number' ? result.count : 0
    } catch {
      return 0
    }
  }

  /** Phone-created terminals recorded while the app was closed. */
  async pendingPanels(): Promise<Array<Record<string, unknown>>> {
    try {
      const result = (await this.request('pendingPanels')) as { panels?: Array<Record<string, unknown>> }
      return result?.panels ?? []
    } catch {
      return []
    }
  }

  async clearPendingPanels(): Promise<void> {
    try {
      await this.request('clearPendingPanels')
    } catch {
      /* best effort */
    }
  }

  async ping(): Promise<boolean> {
    try {
      const result = (await this.request('ping')) as { pong?: boolean }
      return result?.pong === true
    } catch {
      return false
    }
  }

  /**
   * Graceful quit: close the socket, leave every session running in the host. The host marks all
   * sessions detached on disconnect and keeps buffering until the app returns.
   */
  disconnect(): void {
    if (this.socket) {
      try {
        this.socket.end()
      } catch {
        /* ignore */
      }
      this.socket = null
    }
  }

  /** Kill every session and stop the host (the "keep agents on quit" setting is off). */
  async shutdown(): Promise<void> {
    try {
      await this.request('shutdown')
    } catch {
      /* host may already be gone */
    }
    this.disconnect()
  }

  /**
   * Synchronous teardown for `will-quit` (the app is exiting — async RPCs can't be trusted to
   * complete). Writes the shutdown frame straight to the socket and ends it (the daemon kills every
   * session + exits), and as a belt-and-braces guarantee force-kills the host process tree if the
   * port file still exists right after. Blocks the quit only as long as `taskkill` needs (ms).
   */
  shutdownSync(): void {
    const socket = this.socket
    if (socket && !socket.destroyed) {
      try {
        socket.write(JSON.stringify({ method: 'shutdown' }) + '\n')
      } catch {
        /* ignore */
      }
      try {
        socket.end()
      } catch {
        /* ignore */
      }
      this.socket = null
      this.buffer = ''
    }
    // The graceful frame may not flush before the app exits — fall back to killing the host tree.
    try {
      const file = this.readHostFile()
      if (file && this.pidAlive(file.pid)) {
        execFileSync('taskkill', ['/PID', String(file.pid), '/F', '/T'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      }
    } catch {
      /* taskkill fails only when the host already exited — that's the goal */
    }
  }
}
