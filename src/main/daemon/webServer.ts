/**
 * webServer — the Agent Host's LAN-facing HTTP + WebSocket layer, the backbone of the PLANO
 * mobile web app.
 *
 * Serves:
 *   - the mobile web app itself (static files from --webRoot), so the phone just opens
 *     http://<PC-IP>:<webPort>/ — no external hosting needed, works on the LAN even with PLANO
 *     closed;
 *   - a small token-authenticated REST API (view sessions/workspaces, create terminals/agents,
 *     write/interrupt/kill) and a WebSocket channel for live updates (session data, exit, verdicts).
 *
 * Every endpoint requires the daemon token (?token= or Authorization: Bearer). The token is the
 * SAME one written to <userData>/agent-host.json — the desktop Settings → Mobile & Remote panel
 * shows it (and a QR code) for the phone.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AgentKind } from '@shared/domain/agent'
import type { PendingPanel } from './pendingPanels'
import type { MeshEndpoint } from './mesh/endpoint'
import type { MeshEvent } from './mesh/types'

/** The phone-facing view of one terminal session. */
export interface SessionView {
  ptyId: string
  panelId: string
  terminalId: string
  spaceId: string
  cwd: string
  shellName: string
  pid: number
  exited: boolean
  exitCode?: number
  viewers: number
  /** Kind of AI CLI detected in this session (rich verdict from the app when connected, else light). */
  agentKind: AgentKind | null
  agentPid: number | null
  phase: 'working' | 'idle' | null
  title: string
  lastOutputAt: number
}

export interface WorkspaceView {
  id: string
  name: string
  folderPath: string | null
  terminalCount: number
  agentCount: number
  /** Every terminal panel in this workspace (idle ones included) with its live status. */
  terminals?: Array<{
    panelId: string
    terminalId: string
    title: string
    cwd: string
    live: boolean
  }>
}

export interface WebCreateRequest {
  folderPath?: string
  name?: string
  shell?: string
  bootCommand?: string
  autoApprove?: boolean
  cols?: number
  rows?: number
  /** Mesh spawn only: the panel of the agent that ASKED for this one, so the canvas can place
   *  the newcomer beside it at the same size instead of dropping it at the viewport centre. */
  originPanelId?: string
  /** Mesh spawn only: the requester's workspace — the newcomer materializes on THAT canvas,
   *  never in a folder-derived (possibly invented) one. */
  originSpaceId?: string
  /** Position within a multi-agent spawn (`count: 2` → 0 and 1) so the batch lays out as a row. */
  groupIndex?: number
  groupCount?: number
}

export interface WebDeps {
  token: string
  log: (message: string) => void
  webRoot: string
  sessions: () => SessionView[]
  createSession: (req: WebCreateRequest) => SessionView | { error: string }
  writeSession: (ptyId: string, data: string) => boolean
  resizeSession: (ptyId: string, cols: number, rows: number) => boolean
  interruptSession: (ptyId: string) => boolean
  killSession: (ptyId: string) => void
  attachViewer: (ptyId: string) => { ok: boolean; exited: boolean; buffer: string }
  detachViewer: (ptyId: string) => void
  getBuffer: (ptyId: string) => string
  getWorkspaces: () => Promise<WorkspaceView[]>
  /** Ask the desktop app to remove a terminal's canvas panel (closed sessions have no pty). */
  removePanel: (panelId: string, terminalId: string) => void
  hasAppClient: () => boolean
  onExternalTerminal: (session: SessionView) => void
  pendingPanels: () => PendingPanel[]
  clearPendingPanels: () => void
  /** Mesh endpoint (plan v5 A1) — native JSON-RPC for the `plano` CLI, mounted on /cli
   *  (canonical) and /mesh (compat alias), loopback only. */
  meshEndpoint: MeshEndpoint
  /** Claude Code's statusLine hook POSTs its payload here (loopback only, plan
   *  PLAN_STATUS_BAR_LIVE_USAGE). The payload rides existing API responses — no polling. */
  usagePost: (body: unknown) => void
  /** A harness lifecycle hook fired (turn-start / turn-end / awaiting-input). */
  agentHookPost: (event: string, agentId: string, body: string) => void
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

/**
 * Same-subnet addresses are trusted WITHOUT a token: the phone on the same Wi-Fi auto-connects
 * (no token typing — the whole point of a local remote). Anything from outside the LAN still
 * requires the token. Subnets come from this machine's real interfaces at boot.
 */
const localSubnets = Object.values(networkInterfaces())
  .flatMap((list) => list ?? [])
  .filter((i) => i.family === 'IPv4' && !i.internal)
  .map((i) => ({ addr: i.address, mask: i.netmask }))

function inSameSubnet(ip: string, sub: { addr: string; mask: string }): boolean {
  const a = ip.split('.').map(Number)
  const b = sub.addr.split('.').map(Number)
  const m = sub.mask.split('.').map(Number)
  return m.every((mask, i) => (a[i] & mask) === (b[i] & mask))
}

function isLocalPeer(addr: string): boolean {
  const ip = (addr || '').replace(/^::ffff:/, '')
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true
  return localSubnets.some((sub) => inSameSubnet(ip, sub))
}

function authOk(req: IncomingMessage, token: string): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.searchParams.get('token') === token) return true
  const header = req.headers.authorization ?? ''
  if (header === `Bearer ${token}`) return true
  return isLocalPeer((req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''))
}

export class WebServer {
  private readonly http = createServer((req, res) => void this.route(req, res))
  private readonly wss = new WebSocketServer({ noServer: true })
  private sockets = new Set<WebSocket>()
  /** Live /cli/events SSE clients (plan F1) — mesh event stream for the UI and diagnostics. */
  private meshEventClients = new Set<ServerResponse>()
  port = 0

  constructor(private readonly deps: WebDeps) {
    this.wss.on('connection', (socket) => this.onSocket(socket))
    this.http.on('upgrade', (req, socket, head) => {
      if (!authOk(req, this.deps.token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req))
    })
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      // Reject on a bind error (e.g. the fixed port is taken) so the caller can fall back.
      this.http.once('error', reject)
      // v5 A1: `plano wait` / `plano ask` hold a request open for minutes. Node's default
      // requestTimeout (300 s) would kill the long-poll before the daemon answers — disable it.
      this.http.requestTimeout = 0
      this.http.headersTimeout = 60_000
      this.http.listen(port, '0.0.0.0', () => {
        const addr = this.http.address()
        this.port = typeof addr === 'object' && addr ? addr.port : 0
        this.deps.log(`web server listening on 0.0.0.0:${this.port}`)
        resolve(this.port)
      })
    })
  }

  /**
   * Push a frame to connected phones. Session-specific streams (data/exit/verdict) go ONLY to
   * sockets that attached that ptyId — a phone browsing the home screen must not receive every
   * agent's raw output (a fast TUI attached by the desktop app would otherwise drown it).
   * Structural frames (sessions/hello) go to everyone.
   */
  push(frame: Record<string, unknown>): void {
    const text = JSON.stringify(frame)
    const ptyId = frame.ptyId
    const targeted = typeof ptyId === 'string' && (frame.event === 'data' || frame.event === 'exit' || frame.event === 'verdict')
    for (const socket of this.sockets) {
      if (targeted && !(socket as unknown as { attached?: Set<string> }).attached?.has(ptyId)) continue
      try {
        if (socket.readyState === socket.OPEN) socket.send(text)
      } catch {
        /* socket may be closing */
      }
    }
  }

  /** Number of connected phone WebSocket clients (the TopBar badge lights up on this). */
  clientCount(): number {
    return this.sockets.size
  }

  close(): void {
    try {
      this.wss.close()
    } catch {
      /* ignore */
    }
    try {
      this.http.close()
    } catch {
      /* ignore */
    }
  }

  // ── WebSocket ────────────────────────────────────────────────────────────
  private onSocket(socket: WebSocket): void {
    this.sockets.add(socket)
    // ptyIds this phone has attached — released on close so its viewers don't leak. Stored on the
    // socket so push() can target session streams to exactly the sockets that want them.
    const attached = new Set<string>()
    ;(socket as unknown as { attached: Set<string> }).attached = attached
    socket.send(JSON.stringify({ event: 'hello', sessions: this.deps.sessions() }))
    socket.on('message', (raw: unknown) => {
      let msg: { method?: string; ptyId?: string; params?: Record<string, unknown> }
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      const method = msg.method ?? ''
      const ptyId = typeof msg.ptyId === 'string' ? msg.ptyId : ''
      if (method === 'attach' && ptyId) {
        const r = this.deps.attachViewer(ptyId)
        attached.add(ptyId)
        socket.send(JSON.stringify({ event: 'attach-result', ptyId, ...r }))
      } else if (method === 'detach' && ptyId) {
        this.deps.detachViewer(ptyId)
        attached.delete(ptyId)
      } else if (method === 'write' && ptyId && typeof msg.params?.data === 'string') {
        this.deps.writeSession(ptyId, msg.params.data)
      } else if (method === 'resize' && ptyId) {
        this.deps.resizeSession(ptyId, Number(msg.params?.cols) || 80, Number(msg.params?.rows) || 24)
      } else if (method === 'interrupt' && ptyId) {
        this.deps.interruptSession(ptyId)
      } else if (method === 'kill' && ptyId) {
        this.deps.killSession(ptyId)
      } else if (method === 'removePanel') {
        const panelId = typeof msg.params?.panelId === 'string' ? msg.params.panelId : ''
        const terminalId = typeof msg.params?.terminalId === 'string' ? msg.params.terminalId : ''
        if (panelId || terminalId) this.deps.removePanel(panelId, terminalId)
      }
    })
    socket.on('close', () => {
      this.sockets.delete(socket)
      for (const ptyId of attached) this.deps.detachViewer(ptyId)
      attached.clear()
    })
    socket.on('error', () => {
      /* close below handles cleanup */
    })
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────
  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
    })
    res.end(text)
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = decodeURIComponent(url.pathname)
    // Light request log so a phone that can't connect is diagnosable from the host log.
    if (path.startsWith('/api/') || path === '/') {
      const from = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
      this.deps.log(`web ${req.method} ${path} from ${from}`)
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
      })
      res.end()
      return
    }

    if (path.startsWith('/api/')) {
      // Unauthenticated liveness probe — the phone validates an address before asking for the token.
      if (path === '/api/ping') {
        this.sendJson(res, 200, { ok: true, name: 'plano' })
        return
      }
      if (!authOk(req, this.deps.token)) {
        this.sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      await this.routeApi(res, url, path, req)
      return
    }

    // Usage feed (plan PLAN_STATUS_BAR_LIVE_USAGE): Claude Code's statusLine hook POSTs its
    // rate_limits payload to /usage/claude. LOOPBACK ONLY — same guard style as the mesh
    // endpoint (a LAN client must never push usage into the collector).
    if (path === '/usage/claude') {
      const from = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
      if (from !== '127.0.0.1' && from !== '::1' && from !== 'localhost') {
        this.sendJson(res, 403, { error: 'usage is loopback-only' })
        return
      }
      if (req.method !== 'POST') {
        this.sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString('utf8')))
      req.on('end', () => {
        try {
          this.deps.usagePost(body ? (JSON.parse(body) as Record<string, unknown>) : {})
          this.sendJson(res, 200, { ok: true })
        } catch {
          this.sendJson(res, 400, { error: 'invalid JSON' })
        }
      })
      return
    }

    // Agent lifecycle hooks: the harness itself reports turn-start / turn-end / awaiting-input
    // (see daemon/agentHooks.ts). LOOPBACK ONLY, and attributed by the PLANO_AGENT_ID the PTY
    // already carries — a LAN client must never be able to fake an agent's state.
    if (path === '/agent/event') {
      const from = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
      if (from !== '127.0.0.1' && from !== '::1' && from !== 'localhost') {
        this.sendJson(res, 403, { error: 'agent events are loopback-only' })
        return
      }
      if (req.method !== 'POST') {
        this.sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString('utf8')))
      req.on('end', () => {
        const agentId = String(req.headers['x-plano-agent'] ?? '')
        this.deps.agentHookPost(url.searchParams.get('event') ?? '', agentId, body)
        this.sendJson(res, 200, { ok: true })
      })
      return
    }

    // Mesh endpoint (plan v5 A1): LOOPBACK ONLY — the mesh never leaves this machine even
    // though the phone client is LAN-exposed. POST /cli (and the legacy /mesh alias, so
    // terminals spawned by an older daemon keep working) speaks native JSON-RPC to the
    // `plano` CLI; GET /cli/events (alias /mesh/events) is SSE.
    if (path === '/cli' || path === '/mesh' || path.startsWith('/cli/') || path.startsWith('/mesh/')) {
      const from = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
      if (from !== '127.0.0.1' && from !== '::1' && from !== 'localhost') {
        this.sendJson(res, 403, { error: 'mesh is loopback-only' })
        return
      }
      if (req.method === 'POST' && (path === '/cli' || path === '/mesh')) {
        this.deps.meshEndpoint.handle(req, res)
        return
      }
      if (req.method === 'GET' && (path === '/cli/events' || path === '/mesh/events')) {
        this.openMeshEvents(req, res)
        return
      }
      this.sendJson(res, 405, { error: 'method not allowed' })
      return
    }

    // Static web app.
    this.serveStatic(res, path)
  }

  /** SSE stream of mesh events (roster/message/link changes) — for the UI and diagnostics. */
  private openMeshEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    this.meshEventClients.add(res)
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        clearInterval(ping)
      }
    }, 15000)
    req.on('close', () => {
      clearInterval(ping)
      this.meshEventClients.delete(res)
    })
  }

  /** Push one mesh event to every /cli/events SSE client. */
  pushMeshEvent(event: MeshEvent): void {
    const text = `data: ${JSON.stringify(event)}\n\n`
    for (const res of this.meshEventClients) {
      try {
        res.write(text)
      } catch {
        this.meshEventClients.delete(res)
      }
    }
  }

  private serveStatic(res: ServerResponse, path: string): void {
    const root = resolve(this.deps.webRoot)
    let file = path === '/' ? 'index.html' : path
    let full: string
    try {
      full = resolve(join(root, file))
      if (!full.startsWith(root)) throw new Error('bad path')
    } catch {
      this.sendJson(res, 404, { error: 'not found' })
      return
    }
    if (!existsSync(full) || statSync(full).isDirectory()) {
      // SPA fallback → index.html (so client-side routes work on refresh).
      full = join(root, 'index.html')
      if (!existsSync(full)) {
        this.sendJson(res, 404, { error: 'not found' })
        return
      }
    }
    const type = MIME[extname(full).toLowerCase()] ?? 'application/octet-stream'
    try {
      const data = readFileSync(full)
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': type.includes('javascript') || type.includes('css') ? 'no-cache' : 'public, max-age=3600' })
      res.end(data)
    } catch (err) {
      this.sendJson(res, 500, { error: String(err) })
    }
  }

  private async routeApi(
    res: ServerResponse,
    _url: URL,
    path: string,
    req: IncomingMessage,
  ): Promise<void> {
    const readBody = (): Promise<Record<string, unknown>> =>
      new Promise((resolve2) => {
        let data = ''
        req.on('data', (c: Buffer) => (data += c.toString('utf8')))
        req.on('end', () => {
          try {
            resolve2(data ? (JSON.parse(data) as Record<string, unknown>) : {})
          } catch {
            resolve2({})
          }
        })
      })

    const seg = path.replace(/^\/api\//, '').split('/').filter(Boolean)

    try {
      if (seg[0] === 'status' && seg.length === 1) {
        const sessions = this.deps.sessions()
        const workspaces = await this.deps.getWorkspaces()
        this.sendJson(res, 200, {
          version: process.env.PLANO_APP_VERSION || '0',
          appConnected: this.deps.hasAppClient(),
          webPort: this.port,
          sessions,
          workspaces,
          pending: this.deps.pendingPanels().length,
          now: Date.now(),
        })
        return
      }
      if (seg[0] === 'workspaces' && seg.length === 1) {
        this.sendJson(res, 200, { workspaces: await this.deps.getWorkspaces() })
        return
      }
      if (seg[0] === 'sessions' && seg.length === 1) {
        if (req.method === 'GET') {
          this.sendJson(res, 200, { sessions: this.deps.sessions() })
          return
        }
        if (req.method === 'POST') {
          const body = await readBody()
          const result = this.deps.createSession({
            folderPath: typeof body.folderPath === 'string' ? body.folderPath : undefined,
            name: typeof body.name === 'string' ? body.name : undefined,
            shell: typeof body.shell === 'string' ? body.shell : undefined,
            bootCommand: typeof body.bootCommand === 'string' ? body.bootCommand : undefined,
            autoApprove: body.autoApprove === true,
            cols: typeof body.cols === 'number' ? body.cols : undefined,
            rows: typeof body.rows === 'number' ? body.rows : undefined,
          })
          if ('error' in result) {
            this.sendJson(res, 400, { error: result.error })
          } else {
            this.sendJson(res, 200, { session: result })
          }
          return
        }
      }
      if (seg[0] === 'panels' && seg[1] === 'remove' && req.method === 'POST') {
        const body = await readBody()
        const panelId = typeof body.panelId === 'string' ? body.panelId : ''
        const terminalId = typeof body.terminalId === 'string' ? body.terminalId : ''
        if (panelId || terminalId) {
          this.deps.removePanel(panelId, terminalId)
          this.sendJson(res, 200, { ok: true })
        } else {
          this.sendJson(res, 400, { error: 'panelId or terminalId required' })
        }
        return
      }
      if (seg.length === 3 && seg[0] === 'sessions') {
        const ptyId = seg[1]
        const action = seg[2]
        if (req.method === 'POST' && action === 'write') {
          const body = await readBody()
          this.sendJson(res, 200, { ok: this.deps.writeSession(ptyId, String(body.data ?? '')) })
          return
        }
        if (req.method === 'POST' && action === 'resize') {
          const body = await readBody()
          this.sendJson(res, 200, {
            ok: this.deps.resizeSession(ptyId, Number(body.cols) || 80, Number(body.rows) || 24),
          })
          return
        }
        if (req.method === 'POST' && action === 'interrupt') {
          this.sendJson(res, 200, { ok: this.deps.interruptSession(ptyId) })
          return
        }
        if (req.method === 'POST' && action === 'kill') {
          this.deps.killSession(ptyId)
          this.sendJson(res, 200, { ok: true })
          return
        }
        if (req.method === 'GET' && action === 'buffer') {
          this.sendJson(res, 200, { ptyId, buffer: this.deps.getBuffer(ptyId) })
          return
        }
      }
      this.sendJson(res, 404, { error: 'not found' })
    } catch (err) {
      this.sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
  }
}

export function wsAcceptKey(key: string): string {
  return createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
}
