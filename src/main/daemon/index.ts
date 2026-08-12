/**
 * PLANO Agent Host — the detached background process that owns every PTY session.
 *
 * This is the herdr-style heart of "agents never close": the app's terminals are NOT children of
 * the UI. They are spawned by this standalone process, which the app launches as a detached child
 * (`ELECTRON_RUN_AS_NODE=1 <execPath> <app>/out/main/daemon.js --userData <dir> --webRoot <dir>`)
 * and unrefs, so it survives the app quitting. When the app closes, the host marks every session
 * detached and keeps buffering their output; when the app reopens it reconnects, re-attaches the
 * same sessions (replay buffer + live stream) and the user finds PLANO exactly where they left it.
 *
 * It also serves the PLANO Mobile web app: a LAN HTTP+WebSocket server (see webServer.ts) that lets
 * a phone on the same network view sessions/workspaces, talk to agents and CREATE new ones — even
 * while the desktop app is closed (phone-created terminals are recorded as pending panels and
 * materialize on the next app launch).
 *
 * Wire protocol (newline-delimited JSON over a loopback TCP socket):
 *   client → host : { id?, method, params? }
 *   host → client : { id, result } | { id, error:{ message } }   (RPC replies)
 *   host → client : { event, ... }                               (events: data / exit / sessions /
 *                                                               request / response / external-terminal)
 * The first client message must be `hello` with the token; a client without it is dropped.
 *
 * Streaming: a session streams while it has ANY viewer (desktop attach + phone WS attaches).
 */

import { createServer, type Server, type Socket } from 'node:net'
import { mkdirSync, writeFileSync, unlinkSync, renameSync, existsSync, openSync, writeSync, closeSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { IPty } from 'node-pty'
import { Bonjour } from 'bonjour-service'
import type { AgentKind, AgentPhase } from '@shared/domain/agent'
import { ProcessTreeService } from '../services/ProcessTreeService'
import { loadPty, ptyLoadErrorMessage, setUserDataDir, spawnShell, type SpawnShellResult } from './ptySpawn'
import { detectAgentKind, lightPhase, computeBusy, hasActiveWorkers, awaitingInput } from './agentLight'
import { normalizeTerminalText } from '../services/terminalText'
import { WebServer, type SessionView, type WorkspaceView, type WebCreateRequest } from './webServer'
import { PendingPanelsStore } from './pendingPanels'
import { initIdentity, revokeAgent, agentToken, setMeshPort } from './mesh/identity'
import type { AgentState, MeshAgent } from './mesh/types'
import { MeshBus } from './mesh/bus'
import { MeshEndpoint } from './mesh/endpoint'
import { cleanupMcpEntries, installAgentDocs } from './mesh/provision'
import { installCli } from './mesh/cli'
import { installAgentHooks, parseHookRequest } from './agentHooks'
import { UsageService } from './usage/service'
import { launchCommandFor } from '@shared/domain/agentLaunch'

/**
 * Type the spawn prompt into the agents we JUST created — addressed by their exact ptyIds.
 *
 * This used to search the roster for "the most recently seen agent with a detected harness",
 * assuming that had to be the newborn. It is the opposite: the REQUESTER is a detected agent
 * that just produced output (it called the tool), so its `lastSeen` is always fresher than a
 * harness still booting. The prompt therefore landed in the terminal that asked — the user saw
 * their own "hola" typed into their own agent instead of into the new Codex.
 *
 * Now each spawned ptyId gets its own prompt, and the requester is excluded outright.
 */
async function deliverPromptToSpawned(ptyIds: string[], prompt: string, requesterId: string): Promise<void> {
  await Promise.all(
    ptyIds.map(async (ptyId) => {
      if (ptyId === requesterId) return // never write the spawn prompt back to the caller
      const deadline = Date.now() + 25_000
      // Wait for THIS pty's harness to come up; fall through on timeout so a slow/undetected
      // CLI still receives the task rather than silently losing it.
      while (Date.now() < deadline) {
        const entry = sessions.get(ptyId)
        if (!entry || entry.exited) return
        if (mesh.roster().find((a) => a.id === ptyId && a.kind !== 'unknown')) break
        await new Promise((resolve) => setTimeout(resolve, 800))
      }
      const entry = sessions.get(ptyId)
      if (!entry || entry.exited) return
      // A beat so the harness has drawn its input box before we type into it.
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const ok = await mesh.deliverText(ptyId, prompt)
      if (!ok) log(`mesh spawn prompt not delivered to ${ptyId}`)
    }),
  )
}

// Fixed web port so a phone can reach PLANO without reading the random one (http://plano.local:PORT).
// Falls back to a random port when the fixed one is taken. Advertised over mDNS as plano.local.
const FIXED_WEB_PORT = 56780
let bonjour: Bonjour | null = null

function startMdns(webPort: number): void {
  try {
    bonjour = new Bonjour()
    bonjour.publish({ name: 'plano', type: 'http', port: webPort, probe: false })
    log(`mDNS advertised: plano.local:${webPort}`)
  } catch (err) {
    log(`mDNS unavailable: ${err instanceof Error ? err.message : String(err)}`)
    bonjour = null
  }
}

function stopMdns(): void {
  try {
    bonjour?.destroy()
  } catch {
    /* ignore */
  }
  bonjour = null
}

// ── args + logging ──────────────────────────────────────────────────────────

interface DaemonArgs {
  userData: string
  ptyPath?: string
  webRoot: string
}

function parseArgs(argv: string[]): DaemonArgs {
  const args: DaemonArgs = { userData: '', webRoot: '' }
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--userData' && argv[i + 1]) {
      args.userData = argv[i + 1]
      i += 1
    } else if (argv[i] === '--ptyPath' && argv[i + 1]) {
      args.ptyPath = argv[i + 1]
      i += 1
    } else if (argv[i] === '--webRoot' && argv[i + 1]) {
      args.webRoot = argv[i + 1]
      i += 1
    }
  }
  return args
}

const args = parseArgs(process.argv)
const userData = args.userData || process.env.PLANO_USER_DATA_DIR || ''
const HOST_FILE = join(userData, 'agent-host.json')
const HOST_LOG = join(userData, 'logs', 'agent-host.log')

// Mesh identity (plan F2): load/create the persistent master secret BEFORE any PTY spawns,
// so every shell gets a stable, revocable per-agent token.
initIdentity(userData)

// Mesh provisioning (plan v5 A1/A2): the `plano` CLI is installed into <userData>/bin and put on
// every agent's PATH by cleanEnv — which needs the resolved userData dir, since the app passes it
// as an argv flag and never exports PLANO_USER_DATA_DIR. installAgentDocs() then teaches EVERY
// installed harness about the mesh (Claude/Kiro skill + a briefing block in codex/gemini/opencode/
// cursor/pi global instructions): the CLI-first replacement for the MCP config entry that used to
// make agents mesh-aware the moment they booted. Stale `plano` MCP entries from previous versions
// are stripped (the `plano mcp` stdio server no longer exists).
// Belt and braces: none of this may ever prevent the Agent Host from starting. Without the
// daemon there are no terminals at all, so a failure here degrades the mesh, never the app.
setUserDataDir(userData)
try {
  installCli(userData)
  const docs = installAgentDocs()
  const hooks = installAgentHooks(userData)
  log(`agent hooks: ${hooks.installed.join(', ') || 'none'}${hooks.skipped.length ? ` (skipped: ${hooks.skipped.map((s) => `${s.harness}=${s.reason}`).join('; ')})` : ''}`)
  cleanupMcpEntries()
  log(`mesh provisioning: cli + docs for ${docs.provisioned.join(', ') || 'none'}`)
} catch (err) {
  log(`mesh provisioning skipped: ${String(err)}`)
}

// Mesh bus + CLI endpoint (plan v5 A1): the daemon owns roster/mailboxes/timeline, survives app
// closes, and answers agents on the fixed loopback endpoint (/cli, native JSON-RPC).
const mesh = new MeshBus(userData)
const meshEndpoint = new MeshEndpoint(mesh)
mesh.onDeliver = (ptyId, text) => {
  const entry = sessions.get(ptyId)
  if (!entry || entry.exited) return false
  try {
    entry.pty.write(text)
    return true
  } catch {
    return false
  }
}
mesh.onEvent = (event) => {
  broadcast({ event: 'mesh', meshEvent: event })
  web?.pushMeshEvent(event)
}
// v3 A4: raw session tail for delivery confirmation (written ≠ accepted).
mesh.onTailRequest = (ptyId) => {
  const entry = sessions.get(ptyId)
  if (!entry || entry.exited) return ''
  return entry.buffer.join('')
}
// Redacted context (plan F4): the daemon asks the connected app; empty while the app is closed.
mesh.onContextRequest = async (ptyId) => {
  try {
    const tail = await requestApp('agentContext', { ptyId })
    return typeof tail === 'string' ? tail : ''
  } catch {
    return ''
  }
}
// Mesh writes consent (plan F8): the daemon asks the app to show a one-click toast; the
// workspace is remembered afterwards. Denied while the app is closed (no way to ask).
mesh.onConsentRequest = async (spaceId) => {
  try {
    const granted = await requestApp('meshConsent', { spaceId })
    return granted === true
  } catch {
    return false
  }
}
// v4 B3: onFailure 'ask-user' — the app shows a Fire/Cancel toast.
mesh.onChainAskUser = async (chainId, from, to) => {
  try {
    const ok = await requestApp('chainAskUser', { chainId, from, to })
    return ok === true
  } catch {
    return false
  }
}
// Spawn agents (plan F6): a fresh PTY per requested agent, booting the harness command.
// handlePhoneCreate emits `external-terminal` (live panel when the app is running, pending
// panel otherwise) — the exact path mobile-created agents already take.
mesh.onSpawn = (req) => {
  const command = launchCommandFor(req.harness)
  if (!command) return { ok: false, error: `unknown harness: ${req.harness}` }
  const count = Math.max(1, Math.min(6, req.count || 1))
  // The requester's panel anchors the layout: the canvas puts the newcomers NEXT TO it at the
  // same size, instead of stacking them under the terminal that asked (which is what it did).
  const requester = sessions.get(req.from)
  const originPanelId = requester?.panelId
  // The newcomer belongs to the requester's CANVAS and, unless told otherwise, to its folder.
  // A model that guesses a cwd ("C:/tmp") must not exile the panel to another workspace.
  const originSpaceId = requester?.spaceId
  const cwd = req.cwd || requester?.cwd || undefined
  // Keep the EXACT ptyIds we create: the prompt is addressed to them, never guessed.
  const created: string[] = []
  for (let i = 0; i < count; i += 1) {
    try {
      const view = handlePhoneCreate({
        folderPath: cwd,
        bootCommand: command,
        name: req.harness,
        cols: 100,
        rows: 30,
        originPanelId,
        originSpaceId,
        groupIndex: i,
        groupCount: count,
      })
      if ('error' in view) return { ok: false, error: view.error }
      created.push(view.ptyId)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  if (req.prompt) {
    // Deliver the prompt visibly to the exact PTYs we just created, once each is up.
    void deliverPromptToSpawned(created, req.prompt, req.from)
  }
  // v5 A1: the exact ptyIds — the spawner waits on them or prompts them by id.
  return { ok: true, ptyIds: created }
}

function log(message: string): void {
  try {
    const line = `${new Date().toISOString()} ${message}\n`
    if (!existsSync(join(userData, 'logs'))) mkdirSync(join(userData, 'logs'), { recursive: true })
    const fd = openSync(HOST_LOG, 'a')
    writeSync(fd, line)
    closeSync(fd)
  } catch {
    /* logging must never crash the host */
  }
}

log(`agent-host starting pid=${process.pid} userData=${userData} webRoot=${args.webRoot}`)

// ── session model ───────────────────────────────────────────────────────────

interface Session {
  pty: IPty
  ptyId: string
  panelId: string
  terminalId: string
  spaceId: string
  cwd: string
  title: string
  shellName: string
  pid: number
  exited: boolean
  exitCode?: number
  exitSignal?: number
  /** Number of active viewers (desktop attach + phone WS attaches). Streams while > 0. */
  viewers: number
  /** Bounded ring buffer of recent raw output, replayed on attach. */
  buffer: string[]
  bufferLen: number
  pendingOutput: string
  outputTimer?: ReturnType<typeof setTimeout>
  purgeTimer?: ReturnType<typeof setTimeout>
  lastOutputAt: number
  /** Light detection (runs even with the app closed). */
  agentKind: AgentKind | null
  agentPid: number | null
  /** Plan v3 A2: honest-busy state threaded across polls. */
  activity?: import('./agentLight').ActivityState
  busyNow?: boolean
  /** Rich verdict reported by the desktop app while it's connected. */
  appKind: AgentKind | null
  appPhase: AgentPhase | null
  appDisplayName?: string
  appActive?: boolean
}

const sessions = new Map<string, Session>()
const clients = new Set<Socket>()
const pendingPanels = new PendingPanelsStore(userData)
const processTree = new ProcessTreeService()
// The first Win32_Process enumeration pays a cold PowerShell start (~5 s measured) — warm the
// worker at boot so the first detect tick (2.5 s later) already has a populated map. Without
// it, cold-start detection silently wedges and every session stays 'unknown'.
processTree.warm()

// Status bar usage feed (plan PLAN_STATUS_BAR_LIVE_USAGE): the collector lives in the HOST so
// it survives app closes and serves the phone. Started at boot after installCli (the Claude
// hook scripts go into <userData>/bin). claude is push-driven (statusLine hook POSTs to
// /usage/claude), codex polls its session rollouts, opencode-go reads the web quota; a provider
// without credentials stays ABSENT from the snapshot — never a zero.
const usageService = new UsageService({
  userData,
  log,
  broadcast,
  processTree,
  sessions: () => [...sessions.values()],
})
usageService.start()

const REPLAY_BUFFER_MAX = 512_000
const OUTPUT_BATCH_MAX = 256_000
const OUTPUT_BATCH_MS = 16
const EXITED_SESSION_GRACE_MS = 5 * 60 * 1000
const IDLE_EXIT_MS = 45 * 1000
const DETECT_POLL_MS = 2500

// ── broadcast (TCP app client + phone WebSocket) ────────────────────────────

let web: WebServer | null = null

function broadcast(frame: unknown): void {
  const line = JSON.stringify(frame) + '\n'
  for (const socket of clients) {
    try {
      socket.write(line)
    } catch {
      /* socket may be closing */
    }
  }
  web?.push(frame as Record<string, unknown>)
}

function appendBuffer(entry: Session, data: string): void {
  if (!data) return
  entry.buffer.push(data)
  entry.bufferLen += data.length
  while (entry.bufferLen > REPLAY_BUFFER_MAX && entry.buffer.length > 0) {
    const overflow = entry.bufferLen - REPLAY_BUFFER_MAX
    const head = entry.buffer[0]
    if (head.length <= overflow) {
      entry.buffer.shift()
      entry.bufferLen -= head.length
    } else {
      entry.buffer[0] = head.slice(overflow)
      entry.bufferLen -= overflow
    }
  }
}

function flushOutput(entry: Session): void {
  if (entry.outputTimer) {
    clearTimeout(entry.outputTimer)
    entry.outputTimer = undefined
  }
  const data = entry.pendingOutput
  entry.pendingOutput = ''
  if (entry.viewers <= 0 || !data) return
  broadcast({ event: 'data', ptyId: entry.ptyId, data })
}

function queueOutput(entry: Session): void {
  if (entry.viewers <= 0) return
  if (entry.pendingOutput.length >= OUTPUT_BATCH_MAX) {
    flushOutput(entry)
    return
  }
  if (entry.outputTimer) return
  entry.outputTimer = setTimeout(() => {
    entry.outputTimer = undefined
    flushOutput(entry)
  }, OUTPUT_BATCH_MS)
}

function removeSession(ptyId: string): void {
  const entry = sessions.get(ptyId)
  if (!entry) return
  log(`removeSession ptyId=${ptyId.slice(0, 8)} exited=${entry.exited}`)
  // The agent's mesh identity dies with its PTY (plan F2: revoke on exit).
  revokeAgent(ptyId)
  mesh.unregisterAgent(ptyId)

  if (entry.outputTimer) clearTimeout(entry.outputTimer)
  if (entry.purgeTimer) clearTimeout(entry.purgeTimer)
  try {
    entry.pty.kill()
  } catch {
    /* already gone */
  }
  sessions.delete(ptyId)
  broadcast({ event: 'sessions', sessions: sessionList() })
  broadcast({ event: 'session-removed', ptyId: entry.ptyId, panelId: entry.panelId, terminalId: entry.terminalId })
  maybeScheduleIdleExit()
}

// ── phone-facing view ───────────────────────────────────────────────────────

function sessionView(entry: Session): SessionView {
  const kind = entry.appKind ?? entry.agentKind
  const phase = entry.appActive ? (entry.appPhase ?? lightPhase(entry.lastOutputAt)) : entry.agentKind ? lightPhase(entry.lastOutputAt) : null
  return {
    ptyId: entry.ptyId,
    panelId: entry.panelId,
    terminalId: entry.terminalId,
    spaceId: entry.spaceId,
    cwd: entry.cwd,
    shellName: entry.shellName,
    pid: entry.pid,
    exited: entry.exited,
    exitCode: entry.exitCode,
    viewers: entry.viewers,
    agentKind: kind,
    agentPid: entry.agentPid,
    phase,
    title: entry.appDisplayName ?? entry.title,
    lastOutputAt: entry.lastOutputAt,
  }
}

function sessionList(): SessionView[] {
  return [...sessions.values()].map(sessionView)
}

// ── idle exit ───────────────────────────────────────────────────────────────

let idleTimer: ReturnType<typeof setTimeout> | null = null

function maybeScheduleIdleExit(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  // Never idle out while sessions live — that's the feature.
  if (sessions.size > 0 || clients.size > 0 || (web?.port ?? 0) > 0) return
  log('agent-host idle (no sessions, no clients) — exiting in 45s')
  idleTimer = setTimeout(() => {
    log('agent-host idle exit')
    shutdownAll()
  }, IDLE_EXIT_MS)
  idleTimer.unref()
}

// ── handlers ────────────────────────────────────────────────────────────────

function handleCreate(params: Record<string, unknown>): Record<string, unknown> {
  const ptyId = typeof params.ptyId === 'string' ? params.ptyId : ''
  if (!ptyId || sessions.has(ptyId)) return { ok: false, error: 'bad-or-duplicate-ptyId' }
  const panelId = typeof params.panelId === 'string' ? params.panelId : ''
  const terminalId = typeof params.terminalId === 'string' ? params.terminalId : ''
  const spaceId = typeof params.spaceId === 'string' ? params.spaceId : ''
  const cols = typeof params.cols === 'number' ? Math.max(2, Math.floor(params.cols)) : 80
  const rows = typeof params.rows === 'number' ? Math.max(1, Math.floor(params.rows)) : 24

  // Plan F2: mark this agent's token live before the shell spawns. Identity travels in the PTY
  // ENVIRONMENT (spawnShell derives the same deterministic token), never in a shared config file.
  agentToken(ptyId)

  const result = spawnShell(
    {
      ptyId,
      shell: typeof params.shell === 'string' ? params.shell : undefined,
      cwd: typeof params.cwd === 'string' ? params.cwd : undefined,
      cols,
      rows,
      predictiveHistory: params.predictiveHistory !== false,
      bootCommand: typeof params.bootCommand === 'string' ? params.bootCommand : undefined,
      autoDetectRoot: params.autoDetectRoot === true,
      spaceId,
    },
    args.ptyPath,
  )

  if (!result.ok) {
    queueMicrotask(() => {
      broadcast({ event: 'data', ptyId, data: result.message })
      broadcast({ event: 'exit', ptyId, exitCode: 1 })
    })
    return { ok: false, error: 'shell-failed' }
  }

  const entry = createEntry(result, { ptyId, panelId, terminalId, spaceId })
  sessions.set(ptyId, entry)
  // The desktop app created this terminal and streams it immediately — attach it (one viewer)
  // so output flows to the xterm. (Phone-created sessions start with 0 viewers until a viewer
  // attaches; reattach-path attach() adds further viewers.)
  entry.viewers = 1
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  // Mesh roster (plan F1): this PTY is now a live mesh agent with stable identity.
  mesh.registerAgent({
    id: ptyId,
    kind: 'unknown',
    cwd: result.cwd,
    workspace: spaceId,
    busy: false,
    state: 'idle',
    stateSince: Date.now(),
    panelId,
    terminalId,
    panelTitle: `Terminal ${terminalId.slice(-4)}`,
    lastSeen: Date.now(),
  } satisfies MeshAgent)
  broadcast({ event: 'sessions', sessions: sessionList() })
  return { ok: true, pid: result.pty.pid, shellName: result.shellName, cwd: result.cwd, notice: result.notice }
}

function createEntry(
  result: SpawnShellResult,
  ids: { ptyId: string; panelId: string; terminalId: string; spaceId: string },
): Session {
  const entry: Session = {
    pty: result.pty,
    ptyId: ids.ptyId,
    panelId: ids.panelId,
    terminalId: ids.terminalId,
    spaceId: ids.spaceId,
    cwd: result.cwd,
    title: '',
    shellName: result.shellName,
    pid: result.pty.pid,
    exited: false,
    viewers: 0,
    buffer: [],
    bufferLen: 0,
    pendingOutput: '',
    lastOutputAt: Date.now(),
    agentKind: null,
    agentPid: null,
    appKind: null,
    appPhase: null,
  }

  if (result.notice) {
    appendBuffer(entry, result.notice)
    entry.pendingOutput += result.notice
    queueOutput(entry)
  }

  result.pty.onData((data) => {
    entry.lastOutputAt = Date.now()
    appendBuffer(entry, data)
    entry.pendingOutput += data
    queueOutput(entry)
  })

  result.pty.onExit(({ exitCode, signal }) => {
    entry.exited = true
    log(`session exit ptyId=${entry.ptyId.slice(0, 8)} code=${exitCode}`)
    entry.exitCode = exitCode
    // Plan v3 B: the agent is still in the roster until the purge timer — peers see
    // state 'exited' with the exit code instead of a ghost 'working'.
    mesh.setState(entry.ptyId, 'exited', exitCode ?? null)
    entry.exitSignal = signal

    if (entry.outputTimer) clearTimeout(entry.outputTimer)
    entry.outputTimer = undefined
    flushOutput(entry)
    broadcast({ event: 'exit', ptyId: entry.ptyId, exitCode, signal })
    entry.purgeTimer = setTimeout(() => {
      removeSession(entry.ptyId)
    }, EXITED_SESSION_GRACE_MS)
    entry.purgeTimer.unref?.()
  })

  return entry
}

// ── light agent detection (works with the app closed) ───────────────────────

let detectTimer: ReturnType<typeof setInterval> | null = null
let lastVerdictEmit = new Map<string, string>()

function startDetection(): void {
  if (detectTimer) return
  detectTimer = setInterval(() => {
    void (async () => {
      if (sessions.size === 0) return
      const map = await processTree.ensureFresh(1500).catch(() => new Map<number, import('../services/ProcessTreeService').Proc>())
      for (const entry of sessions.values()) {
        if (entry.exited) continue
        const hit = detectAgentKind(entry.pid, map)
        const kindChanged = (hit?.kind ?? null) !== entry.agentKind
        entry.agentKind = hit?.kind ?? null
        entry.agentPid = hit?.pid ?? null
        // Plan v3 A2: busy = real work (worker processes + cleaned-content change with
        // hysteresis), NEVER "bytes flowed recently" — repainting CLIs pinned busy=true.
        const workers = entry.agentPid ? hasActiveWorkers(entry.pid, entry.agentPid, map) : false
        const activity = computeBusy(entry.buffer, workers, entry.activity ?? null)
        entry.activity = activity.state
        entry.busyNow = activity.busy
        // Plan v3 B: the mesh roster carries a MEANINGFUL state, not a busy byte-window.
        // awaiting-input (permission prompt in the cleaned tail) outranks working.
        // A harness hook just told us where its turn is — the detect loop must not argue with
        // it. Without this hold, the next poll flips a hook-driven `working` back to idle the
        // moment the terminal goes quiet (which is most of a turn: the model is thinking).
        const held = hookHeldUntil.get(entry.ptyId) ?? 0
        if (held > Date.now()) {
          if (entry.agentKind) mesh.setKind(entry.ptyId, entry.agentKind)
          continue
        }
        if (held) hookHeldUntil.delete(entry.ptyId)

        if (entry.agentKind) {
          mesh.setKind(entry.ptyId, entry.agentKind)
          const cleanTail = normalizeTerminalText(entry.buffer.slice(-6).join(''))
          const waiting = awaitingInput(cleanTail)
          // v4 A3/A4: a manual claim survives detect-loop activity states, but
          // awaiting-input (a blocked permission prompt) outranks EVERYTHING.
          if (!mesh.agent(entry.ptyId)?.manual || waiting) {
            const state: AgentState = waiting ? 'awaiting-input' : activity.busy ? 'working' : 'idle'
            mesh.setState(entry.ptyId, state)
          }
        } else {
          // Plain terminal: preserve only a MANUAL claim (v3 B); any detect-loop
          // 'working' must park back to idle so queued messages drain. awaiting-input
          // (a permission prompt) outranks even a manual claim (v4 A3).
          const agent = mesh.agent(entry.ptyId)
          if (agent?.manual) {
            const cleanTail = normalizeTerminalText(entry.buffer.slice(-6).join(''))
            if (awaitingInput(cleanTail)) mesh.setState(entry.ptyId, 'awaiting-input')
          } else {
            mesh.setState(entry.ptyId, 'idle')
          }
        }
        // v4 B3: the chain engine watches every agent's state + content quietness.
        const now = Date.now()
        mesh.checkChains(entry.ptyId, {
          state: mesh.agent(entry.ptyId)?.state ?? 'idle',
          contentQuietMs: Math.max(0, now - (entry.activity?.lastContentAt ?? now)),
        })
        const view = sessionView(entry)
        const sig = `${view.agentKind ?? ''}:${view.phase ?? ''}`
        if (kindChanged || lastVerdictEmit.get(entry.ptyId) !== sig) {
          lastVerdictEmit.set(entry.ptyId, sig)
          web?.push({ event: 'verdict', ptyId: entry.ptyId, kind: view.agentKind, phase: view.phase, active: !!view.agentKind })
        }
      }
    })()
  }, DETECT_POLL_MS)
}

// ── app request/response (host asks the connected desktop app for data) ─────

let appReqId = 1
const appRequests = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

function requestApp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (clients.size === 0) {
      reject(new Error('app-not-connected'))
      return
    }
    const id = appReqId++
    const timer = setTimeout(() => {
      appRequests.delete(id)
      reject(new Error('app-timeout'))
    }, 6000)
    appRequests.set(id, { resolve, reject, timer })
    broadcast({ event: 'request', id, method, params })
  })
}

/** Workspaces for the phone: live from the app when connected, else from the saved state file.
 *  `terminalCount` = the workspace's terminal PANELS (structure — idle ones included, so the phone
 *  always shows the user's real terminals), `agentCount` = LIVE agents running right now there. */
async function getWorkspaces(): Promise<WorkspaceView[]> {
  let list: WorkspaceView[] = []
  if (clients.size > 0) {
    try {
      const result = (await requestApp('getWorkspaces')) as WorkspaceView[] | undefined
      if (Array.isArray(result)) list = result
    } catch {
      /* fall through to file */
    }
  }
  if (list.length === 0) {
    try {
      const raw = readFileSync(join(userData, 'workspaces.json'), 'utf8')
      const doc = JSON.parse(raw) as { workspaces?: Array<{ id: string; name: string; folderPath: string | null; panels?: Array<{ id?: string; type: string; title?: string; props?: { tabs?: Array<{ id?: string; title?: string; cwd?: string }> } }> }> }
      list = (doc.workspaces ?? []).map((w) => ({
        id: w.id,
        name: w.name,
        folderPath: w.folderPath ?? null,
        terminalCount: (w.panels ?? []).filter((p) => p.type === 'terminal').length,
        agentCount: 0,
        terminals: (w.panels ?? [])
          .filter((p) => p.type === 'terminal')
          .map((p) => {
            const t = (p.props as { tabs?: Array<{ id?: string; title?: string; cwd?: string }> } | undefined)?.tabs?.[0]
            return {
              panelId: p.id ?? '',
              terminalId: t?.id ?? '',
              title: t?.title ?? p.title ?? 'Terminal',
              cwd: t?.cwd ?? '',
              live: false,
            }
          }),
      }))
    } catch {
      return []
    }
  }
  // Enrich: live agents per workspace + mark each terminal panel live/dead from the sessions.
  const live = sessionList()
  for (const w of list) {
    w.agentCount = live.filter((s) => s.spaceId === w.id && s.agentKind && !s.exited).length
    if (w.terminals) {
      for (const t of w.terminals) {
        t.live = t.terminalId ? live.some((s) => s.terminalId === t.terminalId && !s.exited) : false
      }
    }
  }
  return list
}

/** Resolve the space id for a folder (create-on-demand when the app is closed). */
async function resolveSpaceId(folderPath: string | null): Promise<string> {
  if (clients.size > 0) {
    try {
      const id = (await requestApp('resolveSpace', { folderPath })) as string | undefined
      if (typeof id === 'string' && id) return id
    } catch {
      /* fall through */
    }
  }
  try {
    const raw = readFileSync(join(userData, 'workspaces.json'), 'utf8')
    const doc = JSON.parse(raw) as { workspaces?: Array<{ id: string; folderPath: string | null }> }
    const hit = (doc.workspaces ?? []).find((w) => w.folderPath && folderPath && w.folderPath.toLowerCase() === folderPath.toLowerCase())
    if (hit) return hit.id
  } catch {
    /* ignore */
  }
  return randomUUID()
}

/** A terminal/agent created from the PHONE (REST or WS). */
function handlePhoneCreate(req: WebCreateRequest): SessionView | { error: string } {
  const folderPath = req.folderPath || null
  const ptyId = randomUUID()
  const terminalId = randomUUID()
  const panelId = randomUUID()
  // A MESH spawn belongs to the canvas the requester is on — always. `resolveSpaceId` matches a
  // workspace by FOLDER and, finding none, invents a `randomUUID()`: an agent asked to open in
  // some other cwd (say C:/tmp) ended up in a workspace that does not exist, so its panel was
  // never drawn and the agent looked "invisible" even though the process was alive. The phone
  // keeps the folder-based behaviour — it has no canvas to belong to.
  const spaceIdPromise = req.originSpaceId
    ? Promise.resolve(req.originSpaceId)
    : resolveSpaceId(folderPath)

  const boot = req.bootCommand?.trim() || undefined
  // Plan F2: mark this agent's token live before it spawns (identity rides the env, not a file).
  agentToken(ptyId)
  const result = spawnShell(
    {
      ptyId,
      shell: req.shell || undefined,
      cwd: folderPath || undefined,
      cols: Math.max(2, req.cols || 100),
      rows: Math.max(1, req.rows || 30),
      predictiveHistory: !boot,
      bootCommand: boot,
      autoDetectRoot: !folderPath,
    },
    args.ptyPath,
  )
  if (!result.ok) return { error: result.message }

  // A mesh spawn already KNOWS its workspace (the requester's), so seed it synchronously: the
  // `external-terminal` event is built from this entry a few lines below, and with an empty
  // spaceId the renderer fell back to its folder rule and materialized the panel on another
  // canvas. For the phone the resolution stays async and is patched in when it lands.
  const entry = createEntry(result, { ptyId, panelId, terminalId, spaceId: req.originSpaceId ?? '' })
  sessions.set(ptyId, entry)
  // Plan F1: bus/phone-created sessions are mesh agents too (this is also the F6 spawn path).
  mesh.registerAgent({
    id: ptyId,
    kind: 'unknown',
    cwd: result.cwd,
    workspace: '',
    busy: false,
    state: 'idle',
    stateSince: Date.now(),
    panelId,
    terminalId,
    panelTitle: req.name ?? 'Terminal',
    lastSeen: Date.now(),
  } satisfies MeshAgent)
  log(`phone-create ptyId=${ptyId.slice(0, 8)} clients=${clients.size} boot=${(req.bootCommand || '').slice(0, 30)}`)

  void spaceIdPromise.then((spaceId) => {
    if (entry && !entry.exited) entry.spaceId = spaceId
    const agent = mesh.agent(ptyId)
    if (agent) agent.workspace = spaceId
  })

  const view = sessionView(entry)
  const external = {
    ...view,
    folderPath,
    name: req.name ?? (boot ? 'Agent' : 'Terminal'),
    bootCommand: boot,
    autoApprove: req.autoApprove === true,
    cols: Math.max(2, req.cols || 100),
    rows: Math.max(1, req.rows || 30),
    // Placement hints (mesh spawn only; the phone sends none and keeps the centred grid).
    originPanelId: req.originPanelId,
    groupIndex: req.groupIndex,
    groupCount: req.groupCount,
  }

  if (clients.size > 0) {
    // Desktop app is running → it materializes the panel live.
    broadcast({ event: 'external-terminal', session: external })
  } else {
    // App is closed → record so the next launch materializes it.
    void spaceIdPromise.then((spaceId) => {
      pendingPanels.add({
        ptyId,
        panelId,
        terminalId,
        spaceId,
        folderPath,
        name: req.name ?? (boot ? 'Agent' : 'Terminal'),
        cwd: result.cwd,
        shellName: result.shellName,
        bootCommand: boot,
        autoApprove: req.autoApprove === true,
        cols: Math.max(2, req.cols || 100),
        rows: Math.max(1, req.rows || 30),
        originPanelId: req.originPanelId,
        groupIndex: req.groupIndex,
        groupCount: req.groupCount,
      })
    })
  }
  broadcast({ event: 'sessions', sessions: sessionList() })
  return view
}

// ── RPC dispatch ────────────────────────────────────────────────────────────

function dispatch(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case 'hello':
      return { ok: true, daemonPid: process.pid, ptyAvailable: true, sessions: sessionList(), webPort: web?.port ?? 0 }
    case 'create':
      return handleCreate(params)
    case 'write': {
      const entry = sessions.get(String(params.ptyId ?? ''))
      if (!entry || entry.exited) return { ok: false }
      try {
        entry.pty.write(String(params.data ?? ''))
        return { ok: true }
      } catch {
        return { ok: false }
      }
    }
    case 'resize': {
      const entry = sessions.get(String(params.ptyId ?? ''))
      if (!entry || entry.exited) return { ok: false }
      const cols = typeof params.cols === 'number' ? Math.max(2, Math.floor(params.cols)) : 80
      const rows = typeof params.rows === 'number' ? Math.max(1, Math.floor(params.rows)) : 24
      try {
        entry.pty.resize(cols, rows)
        return { ok: true }
      } catch {
        return { ok: false }
      }
    }
    case 'kill': {
      const ptyId = String(params.ptyId ?? '')
      if (sessions.has(ptyId)) removeSession(ptyId)
      return { ok: true }
    }
    case 'attach': {
      const entry = sessions.get(String(params.ptyId ?? ''))
      if (!entry) return { ok: false, exited: true, buffer: '' }
      entry.viewers += 1
      if (entry.outputTimer) clearTimeout(entry.outputTimer)
      entry.outputTimer = undefined
      entry.pendingOutput = ''
      return { ok: true, exited: entry.exited, exitCode: entry.exitCode, buffer: entry.buffer.join('') }
    }
    case 'detach': {
      const entry = sessions.get(String(params.ptyId ?? ''))
      if (entry) {
        entry.viewers = Math.max(0, entry.viewers - 1)
        if (entry.viewers <= 0) {
          if (entry.outputTimer) clearTimeout(entry.outputTimer)
          entry.outputTimer = undefined
          entry.pendingOutput = ''
        }
      }
      return { ok: true }
    }
    case 'sessions':
      return { sessions: sessionList() }
    case 'phoneClients':
      return { count: web?.clientCount() ?? 0 }
    case 'ping':
      return { pong: true, sessions: sessions.size }
    case 'pendingPanels':
      return { panels: pendingPanels.all() }
    case 'clearPendingPanels':
      pendingPanels.clear()
      return { ok: true }
    case 'reportVerdict': {
      const entry = sessions.get(String(params.ptyId ?? ''))
      if (entry && params.verdict && typeof params.verdict === 'object') {
        const v = params.verdict as { active?: unknown; kind?: unknown; phase?: unknown; displayName?: unknown }
        entry.appActive = v.active === true
        entry.appKind = typeof v.kind === 'string' && v.kind ? (v.kind as AgentKind) : null
        entry.appPhase = v.phase === 'working' || v.phase === 'idle' ? (v.phase as AgentPhase) : null
        entry.appDisplayName = typeof v.displayName === 'string' ? v.displayName : undefined
        // Kind mirrors into the roster; busy comes ONLY from the detect loop (v3 A2) —
        // the app verdict used the same lying byte-window and pinned busy=true.
        if (entry.appKind) mesh.setKind(entry.ptyId, entry.appKind)
        const view = sessionView(entry)
        web?.push({ event: 'verdict', ptyId: entry.ptyId, kind: view.agentKind, phase: view.phase, active: view.agentKind !== null })
      }
      return { ok: true }
    }
    case 'shutdown':
      log('agent-host shutdown requested')
      queueMicrotask(() => shutdownAll())
      return { ok: true }
    case 'chainCancel': {
      // v4 A5: the desktop UI cancels a chain on behalf of its arming agent.
      const chainId = String(params.chainId ?? '')
      const chains = mesh.chainsView().chains as Array<{ id: string; from: string }> | undefined
      const found = (chains ?? []).find((c) => c.id === chainId)
      if (!found) return { ok: false, error: 'no-such-chain' }
      return mesh.cancelChain(found.from, chainId)
    }
    case 'chainsView': {
      // v4 A5: the Mesh view lists chains.
      return mesh.chainsView()
    }
    case 'usage:get':
      // Status bar (plan PLAN_STATUS_BAR_LIVE_USAGE): cached snapshot, populated instantly.
      return usageService.snapshot()
    case 'usage:refresh':
      // Force an immediate refresh (file + network providers re-read now).
      void usageService.refresh('all')
      return { ok: true }
    case 'statusbar:aux':
      // Ports + resources for the bar's non-provider chips (async — dispatch resolves promises).
      return usageService.aux()
    case 'statusbar:killPid': {
      // Destructive, user-confirmed from the ports popover — only PIDs the bar surfaced.
      const pid = Number(params.pid)
      return { ok: usageService.killPid(Number.isFinite(pid) ? pid : -1) }
    }
    default:
      return { error: `unknown-method:${method}` }
  }
}

// ── web deps ────────────────────────────────────────────────────────────────

function webDeps() {
  return {
    token,
    log,
    webRoot: resolve(args.webRoot || ''),
    sessions: sessionList,
    createSession: handlePhoneCreate,
    writeSession: (ptyId: string, data: string) => {
      const entry = sessions.get(ptyId)
      if (!entry || entry.exited) return false
      try {
        entry.pty.write(data)
        return true
      } catch {
        return false
      }
    },
    resizeSession: (ptyId: string, cols: number, rows: number) => {
      const entry = sessions.get(ptyId)
      if (!entry || entry.exited) return false
      try {
        entry.pty.resize(Math.max(2, cols), Math.max(1, rows))
        return true
      } catch {
        return false
      }
    },
    interruptSession: (ptyId: string) => {
      const entry = sessions.get(ptyId)
      if (!entry || entry.exited) return false
      try {
        entry.pty.write('\x03')
        return true
      } catch {
        return false
      }
    },
    killSession: (ptyId: string) => {
      if (sessions.has(ptyId)) removeSession(ptyId)
    },
    attachViewer: (ptyId: string) => {
      const entry = sessions.get(ptyId)
      if (!entry) return { ok: false, exited: true, buffer: '' }
      entry.viewers += 1
      return { ok: true, exited: entry.exited, buffer: entry.buffer.join('') }
    },
    detachViewer: (ptyId: string) => {
      const entry = sessions.get(ptyId)
      if (entry) {
        entry.viewers = Math.max(0, entry.viewers - 1)
        if (entry.viewers <= 0) {
          if (entry.outputTimer) clearTimeout(entry.outputTimer)
          entry.outputTimer = undefined
          entry.pendingOutput = ''
        }
      }
    },
    getBuffer: (ptyId: string) => sessions.get(ptyId)?.buffer.join('') ?? '',
    getWorkspaces,
    removePanel: (panelId: string, terminalId: string) => {
      broadcast({ event: 'session-removed', ptyId: '', panelId, terminalId })
    },
    hasAppClient: () => clients.size > 0,
    onExternalTerminal: () => {
      /* handled via broadcast directly */
    },
    pendingPanels: () => pendingPanels.all(),
    clearPendingPanels: () => pendingPanels.clear(),
    meshEndpoint,
    usagePost: (body: unknown) => usageService.postClaude(body),
    agentHookPost: (event: string, agentId: string, body: string) => applyAgentHook(event, agentId, body),
  }
}

/**
 * A harness told us where its turn is. This OUTRANKS the poll-based busy detection: the CLI
 * knows, we were inferring. `hookHeldUntil` keeps the detect loop from overwriting the state it
 * just set — without it the next poll (≤2.5 s later) would flip a hook-driven `working` back to
 * idle because the terminal happens to be quiet while the model thinks.
 */
const hookHeldUntil = new Map<string, number>()
/**
 * How long a hook-driven state is protected from the detect loop.
 *
 * Deliberately SHORT. The first version held `working` for four minutes so a long turn could not
 * be flipped by a quiet poll — but that made the hook a single point of failure: if the harness's
 * end-of-turn hook never arrived, the agent stayed "working" forever and nothing ever finished
 * (no chime, no notification). The hold now only covers the next poll or two; after that the
 * detect loop is back in charge, so hooks make the signal PRECISE while the poll keeps it ALIVE.
 */
const HOOK_HOLD_MS = 6000

function applyAgentHook(event: string, agentId: string, body: string): void {
  const parsed = parseHookRequest(event, agentId, body)
  if (!parsed) return
  const entry = sessions.get(parsed.agentId)
  if (!entry || entry.exited) return
  const state: AgentState = parsed.event === 'turn-start' ? 'working' : parsed.event === 'awaiting-input' ? 'awaiting-input' : 'idle'
  // A turn-start carries what the user actually asked — the notification quotes it.
  if (parsed.prompt) mesh.setCurrentTask(parsed.agentId, parsed.prompt)
  // A settled state (idle / awaiting-input) needs no protection — the poll agreeing with it is
  // fine. Only `working` gets the brief hold, so the first quiet poll cannot undo it.
  if (state === 'working') hookHeldUntil.set(parsed.agentId, Date.now() + HOOK_HOLD_MS)
  else hookHeldUntil.delete(parsed.agentId)
  mesh.setState(parsed.agentId, state)
  log(`agent hook: ${parsed.agentId.slice(0, 8)} ${parsed.event}`)
}

// ── shutdown ────────────────────────────────────────────────────────────────

let shuttingDown = false

function removeHostFile(): void {
  try {
    if (existsSync(HOST_FILE)) unlinkSync(HOST_FILE)
  } catch {
    /* best effort */
  }
}

function shutdownAll(): void {
  if (shuttingDown) return
  shuttingDown = true
  log(`agent-host shutting down (${sessions.size} sessions)`)
  usageService.dispose()
  for (const id of [...sessions.keys()]) removeSession(id)
  removeHostFile()
  stopMdns()
  for (const socket of [...clients]) {
    try {
      socket.end()
    } catch {
      /* ignore */
    }
  }
  web?.close()
  for (const [, p] of appRequests) {
    clearTimeout(p.timer)
    p.reject(new Error('shutdown'))
  }
  try {
    server.close()
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 50).unref?.()
}

process.on('exit', () => {
  removeHostFile()
})
process.on('SIGTERM', () => {
  log('agent-host SIGTERM — shutting down')
  shutdownAll()
})
process.on('SIGINT', () => {
  log('agent-host SIGINT — shutting down')
  shutdownAll()
})

// ── socket handling ─────────────────────────────────────────────────────────

function handleSocket(socket: Socket): void {
  socket.setNoDelay(true)
  clients.add(socket)
  log(`client connected (${clients.size} total)`)

  let buffer = ''
  let authed = false
  let greeted = false

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (!line.trim()) continue
      let msg: { id?: number; method?: string; params?: Record<string, unknown>; event?: string }
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      // Replies to the host's requests to the app (getWorkspaces etc.).
      if (msg.event === 'response' && typeof msg.id === 'number') {
        const pending = appRequests.get(msg.id)
        if (pending) {
          appRequests.delete(msg.id)
          clearTimeout(pending.timer)
          pending.resolve(msg.params)
        }
        continue
      }
      if (!authed) {
        if (msg.method !== 'hello' || msg.params?.token !== token) {
          socket.end()
          return
        }
        authed = true
      }
      if (msg.method === 'hello') {
        if (greeted) continue
        greeted = true
      }
      let frame: unknown
      try {
        frame = dispatch(msg.method ?? '', msg.params ?? {})
      } catch (err) {
        frame = { error: { message: err instanceof Error ? err.message : String(err) } }
      }
      const reply = (value: unknown): void => {
        if (typeof msg.id === 'number') {
          try {
            socket.write(JSON.stringify({ id: msg.id, result: value }) + '\n')
          } catch {
            /* socket closing */
          }
        }
      }
      if (frame instanceof Promise) {
        void frame.then(reply).catch((err) =>
          reply({ error: { message: err instanceof Error ? err.message : String(err) } }),
        )
      } else {
        reply(frame)
      }
    }
  })

  socket.on('error', () => {
    /* ignore — close below handles cleanup */
  })

  socket.on('close', () => {
    clients.delete(socket)
    log(`client disconnected (${clients.size} total)`)
    for (const [, p] of appRequests) {
      clearTimeout(p.timer)
      p.reject(new Error('app-disconnected'))
    }
    appRequests.clear()
    maybeScheduleIdleExit()
  })
}

// ── boot ────────────────────────────────────────────────────────────────────

const token = randomUUID()
let server: Server

const ptyReady = loadPty(args.ptyPath) !== null

server = createServer(handleSocket)
server.on('error', (err) => {
  log(`server error: ${err.message}`)
})



server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  web = new WebServer(webDeps())
  const webPortPromise = web
    .listen(FIXED_WEB_PORT)
    .catch(() => web!.listen(0))
    .then((webPort) => {
      if (webPort !== FIXED_WEB_PORT) log(`fixed web port ${FIXED_WEB_PORT} busy — using ${webPort}`)
      // The mesh URL is DERIVED from the port we actually bound. A surviving daemon from a
      // previous version can hold 56780, and a hardcoded URL would silently aim every agent at
      // that stale process. Set it before any terminal spawns so the injected env is correct.
      setMeshPort(webPort)
      startMdns(webPort)
      const info = {
      pid: process.pid,
      port,
      token,
      webPort,
      mdns: 'plano.local',
      version: process.env.PLANO_APP_VERSION || '0',
      startedAt: Date.now(),
      ptyAvailable: ptyReady,
    }
    try {
      mkdirSync(userData, { recursive: true })
      const tmp = `${HOST_FILE}.${randomUUID()}.tmp`
      writeFileSync(tmp, JSON.stringify(info, null, 2), 'utf8')
      renameSync(tmp, HOST_FILE)
    } catch (err) {
      log(`failed to write host file: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!ptyReady) {
      log(`node-pty unavailable: ${ptyLoadErrorMessage() ?? 'unknown'}`)
    }
    log(`agent-host listening on 127.0.0.1:${port} web on 0.0.0.0:${webPort} token=${token.slice(0, 8)}…`)
    startDetection()
    maybeScheduleIdleExit()
    return webPort
  })
  void webPortPromise.catch((err) => {
    log(`web server failed: ${err instanceof Error ? err.message : String(err)}`)
  })
})
