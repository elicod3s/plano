/**
 * PtyManager — the main-process owner of terminal lifecycle + the renderer bridge.
 *
 * The actual PTY processes live in the detached Agent Host (see AgentHostClient + daemon/index.ts),
 * so they survive the app quitting — this is the herdr-style guarantee that agents never close. This
 * class: creates sessions via the host, forwards write/resize/kill, bridges host events (data/exit)
 * to the renderer, and re-registers agent detection / history / dev-url / agent-session wiring
 * whenever a session (re)appears — both on create and on restore (an app relaunch re-attaching to
 * the still-running host).
 *
 * Streaming semantics mirror the old in-process design exactly: the host streams output ONLY for
 * sessions the renderer has `attach`ed (it buffers otherwise, up to a bounded ring), and replays the
 * buffer on attach. Exit events are delivered even for detached sessions so the renderer's status
 * stays truthful.
 */

import { randomUUID } from 'node:crypto'
import { CH } from '@shared/ipc/channels'
import type {
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalAttachResult,
  TerminalProcessInfo,
} from '@shared/ipc/contracts'
import type { AgentDetectionService } from './AgentDetectionService'
import type { AgentSessionService } from './AgentSessionService'
import type { TerminalHistoryService } from './TerminalHistoryService'
import type { DevUrlService } from './DevUrlService'
import type { AgentContextService } from './AgentContextService'
import { AgentHostClient, type HostCreateRequest } from './AgentHostClient'

type Post = (channel: string, payload: unknown) => void

interface PtyDeps {
  post: Post
  detection: AgentDetectionService
  history: TerminalHistoryService
  devUrls: DevUrlService
  agentSession: AgentSessionService
}

/** Stable identity + live metadata for one PTY — what the agent mesh resolves against. */
interface PtyMeta {
  ptyId: string
  terminalId: string
  panelId: string
  spaceId: string
  cwd: string
  title: string
  shellName: string
  pid: number
  exited: boolean
  attached: boolean
}

/** Message streamed when the Agent Host can't be reached (degraded, never crashes). */
const AGENT_HOST_UNAVAILABLE_MESSAGE =
  '\r\n\x1b[2m  PLANO — the background Agent Host could not be started.\r\n' +
  '  Terminals can\u2019t spawn right now; check the log at <userData>/logs/agent-host.log\r\n' +
  '  and reopen this terminal.\x1b[0m\r\n'

export class PtyManager {
  private readonly host: AgentHostClient
  private readonly meta = new Map<string, PtyMeta>()
  /** Canonical context sink (AgentContextService) — attached after construction in main. */
  private context: AgentContextService | null = null

  constructor(
    private readonly deps: PtyDeps,
    userDataPath: string,
    log: (event: string, details?: unknown) => void,
    webRoot?: string,
  ) {
    this.host = new AgentHostClient(userDataPath, log, webRoot)
    // Bridge host events to the renderer + the sniffers. The host streams ONLY attached sessions;
    // exit arrives for every session.
    this.host.onEvent((frame) => {
      if (frame.event === 'data') {
        this.onHostData(String(frame.ptyId ?? ''), String(frame.data ?? ''))
      } else if (frame.event === 'exit') {
        this.onHostExit(
          String(frame.ptyId ?? ''),
          typeof frame.exitCode === 'number' ? frame.exitCode : 0,
          typeof frame.signal === 'number' ? frame.signal : undefined,
        )
      } else if (frame.event === 'session-removed') {
        // A terminal was closed (e.g. from the phone) — the renderer must drop its canvas panel.
        this.deps.post(CH.terminalSessionRemoved, {
          ptyId: String(frame.ptyId ?? ''),
          panelId: String(frame.panelId ?? ''),
          terminalId: String(frame.terminalId ?? ''),
        })
        this.meta.delete(String(frame.ptyId ?? ''))
      } else if (frame.event === 'usage') {
        // Status bar (plan PLAN_STATUS_BAR_LIVE_USAGE): the host's collector pushed a snapshot.
        this.deps.post(CH.usageChanged, frame.usage)
      } else if (frame.event === 'statusbar-aux') {
        // Ports + resources re-scanned by the host.
        this.deps.post(CH.statusbarAuxChanged, frame.aux)
      }
    })
  }

  /** Wire the canonical context service into the PTY lifecycle (register/feed/verdict/exit). */
  attachContext(context: AgentContextService): void {
    this.context = context
  }

  /** v4 A5: fire one raw host RPC (e.g. chainCancel from the Mesh view). */
  hostRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.host.request(method, params)
  }

  // ── host event plumbing ───────────────────────────────────────────────────

  private onHostData(ptyId: string, data: string): void {
    if (!ptyId || !data) return
    const entry = this.meta.get(ptyId)
    if (!entry || !entry.attached) return
    this.deps.post(CH.terminalData, { ptyId, data })
    this.deps.detection.feed(ptyId, data)
    this.deps.history.feed(ptyId, data)
    this.deps.devUrls.feed(ptyId, data)
    this.context?.feed(ptyId, data)
  }

  private onHostExit(ptyId: string, exitCode: number, signal?: number): void {
    const entry = this.meta.get(ptyId)
    if (entry) {
      entry.exited = true
      entry.attached = false
    }
    // Always post exit — a detached (hibernated) terminal's shell finishing in the background must
    // still be reflected in the renderer (the supervisor marks its runtime exited + clears the
    // stale verdict). The `terminal:data` stream stays gated to `attached`, but exit is a one-shot
    // event, not a stream, so it's cheap to always deliver.
    this.deps.post(CH.terminalExit, { ptyId, exitCode, signal })
    this.context?.markExited(ptyId)
    // The live process is gone, so stop tracking it — but KEEP the meta entry (so a panel that
    // reattaches still sees the exited flag + replay buffer from the host). Cleared by kill().
    this.deps.detection.unregister(ptyId)
    this.deps.agentSession.unregister(ptyId)
    this.deps.history.unregister(ptyId)
    this.deps.devUrls.unregister(ptyId)
  }

  // ── session create / restore ──────────────────────────────────────────────

  /** Wire detection/history/dev-url/agent-session/context for a live shell (create OR restore). */
  private registerWiring(
    ptyId: string,
    pid: number,
    shellName: string,
    predictive: boolean,
    spaceId: string,
    panelId: string,
    terminalId: string,
    cwd: string,
  ): void {
    // Preserve a live entry's state: restoreSessions can re-register a session that is ALREADY
    // attached/streaming (renderer reload, repeated restore calls) — clobbering `attached` back
    // to false would make main drop its data until the next attach.
    const existing = this.meta.get(ptyId)
    this.meta.set(ptyId, {
      ptyId,
      terminalId,
      panelId,
      spaceId,
      cwd,
      title: existing?.title ?? '',
      shellName,
      pid,
      exited: existing?.exited ?? false,
      attached: existing?.attached ?? false,
    })
    this.deps.detection.register(ptyId, pid, (verdict) => {
      this.deps.post(CH.agentSignal, { ptyId, verdict })
      this.context?.updateVerdict(ptyId, verdict)
      // Keep the mobile view truthful: push the rich verdict to the host, which relays it to
      // phone WebSocket clients (fallback: the host's own light detection when the app is closed).
      void this.host.reportVerdict(ptyId, verdict).catch(() => undefined)
    })
    this.deps.agentSession.register(ptyId, pid)
    this.deps.history.register(ptyId, shellName, pid, predictive)
    this.context?.register(ptyId)
    this.deps.devUrls.register(ptyId, (url) => {
      if (this.meta.get(ptyId)?.attached) {
        this.deps.post(CH.terminalUrlDetected, { ptyId, panelId: this.meta.get(ptyId)?.panelId ?? '', url })
      }
    })
  }

  private unregisterWiring(ptyId: string): void {
    this.meta.delete(ptyId)
    this.deps.detection.unregister(ptyId)
    this.deps.agentSession.unregister(ptyId)
    this.deps.history.unregister(ptyId)
    this.deps.devUrls.unregister(ptyId)
    this.context?.unregister(ptyId)
  }

  async create(req: TerminalCreateRequest): Promise<TerminalCreateResult> {
    const ptyId = randomUUID()
    try {
      await this.host.ensureHost()
    } catch {
      // Host down (rare — it's detached, so normally it's up): degrade like the node-pty-missing
      // path — stream a guidance message, then report exit.
      queueMicrotask(() => {
        this.deps.post(CH.terminalData, { ptyId, data: AGENT_HOST_UNAVAILABLE_MESSAGE })
        this.deps.post(CH.terminalExit, { ptyId, exitCode: 1 })
      })
      return { ptyId, pid: -1, shellName: 'unavailable', cwd: '' }
    }

    const hostReq: HostCreateRequest = {
      ptyId,
      panelId: req.panelId,
      terminalId: req.terminalId,
      spaceId: req.spaceId,
      cwd: req.cwd,
      shell: req.shell,
      cols: req.cols,
      rows: req.rows,
      predictiveHistory: req.predictiveHistory,
      bootCommand: req.bootCommand,
      autoDetectRoot: req.autoDetectRoot,
    }
    let result
    try {
      result = await this.host.create(hostReq)
    } catch {
      result = { ok: false, error: 'host-error' }
    }
    if (!result.ok || typeof result.pid !== 'number') {
      // The host already streamed the failure message + exit event (it owns the ptyId) — the
      // renderer will show the explanation + "[process exited]" exactly like the old flow.
      return { ptyId, pid: -1, shellName: 'unavailable', cwd: '' }
    }

    const cwd = result.cwd ?? req.cwd ?? ''
    this.registerWiring(
      ptyId,
      result.pid,
      result.shellName ?? '',
      req.predictiveHistory ?? true,
      req.spaceId,
      req.panelId,
      req.terminalId,
      cwd,
    )
    const entry = this.meta.get(ptyId)
    if (entry) entry.attached = true // freshly spawned sessions stream immediately
    return { ptyId, pid: result.pid, shellName: result.shellName ?? '', cwd }
  }

  /**
   * Re-discover the host's live sessions on app launch (or renderer reload). Re-registers the
   * sniffers for each surviving session and returns them so the renderer can seed its terminal
   * registry BEFORE panels mount — those terminals then reattach (replay buffer) instead of
   * respawning. Sessions whose terminalId no longer exists in any workspace are orphan cleanup:
   * killed so they can't pin the host (and an agent) alive forever.
   */
  async restoreSessions(keptTerminalIds?: string[]): Promise<RestoredTerminalSession[]> {
    try {
      await this.host.ensureHost()
    } catch {
      return [] // host unreachable → terminals spawn fresh (current behavior)
    }
    const kept = new Set(keptTerminalIds ?? [])
    const out: RestoredTerminalSession[] = []
    let sessions
    try {
      sessions = await this.host.sessions()
    } catch {
      return []
    }
    // Phone-created (pending) sessions must NEVER be orphan-killed, whatever the renderer passed:
    // union their terminal ids into the kept set unconditionally.
    try {
      const pending = await this.host.pendingPanels()
      for (const p of pending) {
        if (typeof p.terminalId === 'string' && p.terminalId) kept.add(p.terminalId)
      }
    } catch {
      /* best effort */
    }
    for (const s of sessions) {
      if (kept.size > 0 && !kept.has(s.terminalId)) {
        try {
          await this.host.kill(s.ptyId)
        } catch {
          /* best effort */
        }
        continue
      }
      if (this.meta.has(s.ptyId)) {
        // Already wired (a create raced the restore, or a previous restore ran — e.g. renderer
        // reload or repeated calls). NEVER clobber the live attached/exited state: doing so made
        // main drop a streaming session's data until the next attach.
        out.push({
          ptyId: s.ptyId,
          panelId: s.panelId,
          terminalId: s.terminalId,
          spaceId: s.spaceId,
          pid: s.pid,
          shellName: s.shellName,
          cwd: s.cwd,
          exited: s.exited,
        })
        continue
      }
      this.registerWiring(s.ptyId, s.pid, s.shellName, true, s.spaceId, s.panelId, s.terminalId, s.cwd)
      const meta = this.meta.get(s.ptyId)
      if (meta) {
        meta.exited = s.exited
        meta.attached = false // streams resume when the renderer attaches (panel mount)
      }
      out.push({
        ptyId: s.ptyId,
        panelId: s.panelId,
        terminalId: s.terminalId,
        spaceId: s.spaceId,
        pid: s.pid,
        shellName: s.shellName,
        cwd: s.cwd,
        exited: s.exited,
      })
    }
    return out
  }

  // ── renderer bridge ───────────────────────────────────────────────────────

  /**
   * Re-bind to a session that kept running in the host (panel remount after hibernation, renderer
   * HMR reload, or an app relaunch). The host replays its bounded buffer once; we also replay it
   * through the sniffers (they saw nothing while detached) and re-post the current agent verdict.
   */
  async attach(ptyId: string): Promise<TerminalAttachResult> {
    // Sessions created from the MOBILE web app (or a renderer reload racing restore) may not be
    // wired yet — pull the daemon's session info and register so data streams + sniffers run.
    if (!this.meta.has(ptyId)) {
      try {
        const sessions = await this.host.sessions()
        const s = sessions.find((x) => x.ptyId === ptyId)
        if (s) {
          this.registerWiring(ptyId, s.pid, s.shellName, true, s.spaceId, s.panelId, s.terminalId, s.cwd)
        }
      } catch {
        /* attach below will surface the failure */
      }
    }
    // Mark attached OPTIMISTICALLY: the host streams immediately on its side, so the first data
    // batch can arrive at main BEFORE this RPC resolves — if we waited, main would drop it as
    // "detached" (the race that killed the reattached stream). Reset on failure.
    const meta = this.meta.get(ptyId)
    if (meta) meta.attached = true
    let result
    try {
      result = await this.host.attach(ptyId)
    } catch {
      if (meta) meta.attached = false
      return { ok: false, exited: true, buffer: '' }
    }
    if (meta) {
      meta.attached = result.ok
      meta.exited = result.exited
    }
    if (result.ok && result.buffer) {
      this.deps.detection.feed(ptyId, result.buffer)
      this.deps.history.feed(ptyId, result.buffer)
      this.deps.devUrls.feed(ptyId, result.buffer)
      this.context?.feed(ptyId, result.buffer)
    }
    // Verdict changes were suppressed while detached — push the current one so the panel morphs.
    this.deps.post(CH.agentSignal, { ptyId, verdict: this.deps.detection.currentVerdict(ptyId) })
    return { ok: result.ok, exited: result.exited, buffer: result.ok ? result.buffer : '' }
  }

  /** Stop streaming to the renderer while keeping the shell running (hibernation / app quit). */
  async detach(ptyId: string): Promise<void> {
    const meta = this.meta.get(ptyId)
    if (meta) meta.attached = false
    try {
      await this.host.detach(ptyId)
    } catch {
      /* host may be mid-teardown */
    }
  }

  async write(ptyId: string, data: string): Promise<void> {
    try {
      await this.host.write(ptyId, data)
    } catch {
      /* pty died between frames; ignore */
    }
  }

  async resize(ptyId: string, cols: number, rows: number): Promise<void> {
    try {
      await this.host.resize(ptyId, cols, rows)
    } catch {
      /* pty died between frames; ignore */
    }
    this.deps.detection.ping(ptyId)
  }

  ping(ptyId: string): void {
    this.deps.detection.ping(ptyId)
  }

  /**
   * The AI-agent CLI process(es) running in this terminal — delegated to agent detection so
   * it's matched with the same signatures (no raw OS process tree, no unrelated noise).
   */
  listProcesses(ptyId: string): Promise<TerminalProcessInfo[]> {
    if (!this.meta.has(ptyId)) return Promise.resolve([])
    return this.deps.detection.listAgentProcesses(ptyId)
  }

  async kill(ptyId: string): Promise<{ ok: boolean }> {
    let ok = false
    try {
      ok = await this.host.kill(ptyId)
    } catch {
      /* host may be gone */
    }
    this.unregisterWiring(ptyId)
    return { ok }
  }

  /** Handle data requests the host makes of the app (getWorkspaces / resolveSpace). */
  onHostRequest(handler: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>): void {
    this.host.onRequest(handler)
  }

  /** A terminal/agent was created from the mobile web app while PLANO is running. */
  onExternalTerminal(handler: (session: Record<string, unknown>) => void): void {
    this.host.onExternalTerminal(handler)
  }

  /** Plan F7: mesh timeline events → renderer link layer / audit trail. */
  onMeshEvent(handler: (event: Record<string, unknown>) => void): void {
    this.host.onMeshEvent(handler)
  }

  /**
   * Register a session created from the MOBILE web app so main streams its data + runs the
   * sniffers. The daemon created the PTY directly (not via `create`), so main never wired it.
   */
  registerExternalSession(session: {
    ptyId: string
    panelId: string
    terminalId: string
    spaceId: string
    pid: number
    shellName: string
    cwd: string
  }): void {
    if (this.meta.has(session.ptyId)) return
    this.registerWiring(
      session.ptyId,
      session.pid,
      session.shellName || 'shell',
      true,
      session.spaceId || '',
      session.panelId,
      session.terminalId,
      session.cwd || '',
    )
  }

  /** Phone-created terminals recorded while the app was closed (materialize at launch). */
  async pendingPanels(): Promise<Array<Record<string, unknown>>> {
    return this.host.pendingPanels()
  }

  async clearPendingPanels(): Promise<void> {
    await this.host.clearPendingPanels()
  }

  /** Number of connected phone WebSocket clients (TopBar badge). */
  async phoneClients(): Promise<number> {
    return this.host.phoneClients()
  }


  /**
   * The stable identity + live metadata of one PTY, for the agent-mesh runtime registry.
   * Returns null when the pty is unknown/killed.
   */
  runtimeMeta(ptyId: string): {
    ptyId: string
    terminalId: string
    panelId: string
    spaceId: string
    cwd: string
    title: string
    shellName: string
    pid: number
    exited: boolean
    attached: boolean
  } | null {
    const entry = this.meta.get(ptyId)
    if (!entry) return null
    return {
      ptyId,
      terminalId: entry.terminalId,
      panelId: entry.panelId,
      spaceId: entry.spaceId,
      cwd: entry.cwd,
      title: entry.title,
      shellName: entry.shellName,
      pid: entry.pid,
      exited: entry.exited,
      attached: entry.attached,
    }
  }

  /**
   * Push an updated working directory + title for a PTY (OSC-7/OSC-0 from the shell).
   * Called from the mesh context wiring when the shell reports a live `cd`.
   */
  updateRuntimeMeta(ptyId: string, patch: { cwd?: string; title?: string }): void {
    const entry = this.meta.get(ptyId)
    if (!entry) return
    if (patch.cwd) entry.cwd = patch.cwd
    if (patch.title) entry.title = patch.title
  }

  /**
   * App teardown. With "keep agents running" (the default) the host connection drops and every
   * session keeps running in the background — exactly like herdr detach. With it off, the host is
   * told to kill everything (the old behavior).
   */
  shutdown(keepAgents: boolean): void {
    if (keepAgents) {
      this.host.disconnect()
    } else {
      this.host.shutdownSync()
    }
    // Also tear down agent detection so its shared process-enumeration worker (a long-lived
    // powershell.exe on Windows) is killed rather than orphaned when the app quits.
    this.deps.detection.disposeAll()
  }
}

/** A session rediscovered on the host at app launch, for the renderer's restore. */
export interface RestoredTerminalSession {
  ptyId: string
  panelId: string
  terminalId: string
  spaceId: string
  pid: number
  shellName: string
  cwd: string
  exited: boolean
}
