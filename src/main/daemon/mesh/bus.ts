/**
 * MeshBus (plan F1): the daemon-side single source of truth for the agent roster, mailboxes,
 * active links and the message timeline. The desktop app (and later the renderer) only mirrors
 * it. Identity comes from the token (plan F2) — agents never present their own `from`.
 */

import type { AgentKind } from '@shared/domain/agent'
import { HARNESS_CAPABILITIES, type AgentCapabilities } from '@shared/domain/agent'
import { HARNESS_CONTROL, MODEL_FAMILIES, MODEL_SYNTAX_RE } from '@shared/domain/agentControl'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MailboxStore } from './mailbox'
import { resolveAgent, meshUrl, newMeshId } from './identity'
import { normalizeTerminalText } from '../../services/terminalText'
import type { MeshAgent, MeshEvent, MeshMessage, MeshToolResult, AgentState, MeshLink, MeshChain, ChainWhen, ChainFailure } from './types'

const MAX_TIMELINE = 200
const MAX_BROADCAST_TARGETS = 12
const MAX_HOPS = 4
const MAX_MESSAGE_LEN = 4000
/**
 * v3 A3: mailbox drains on a timer too, never only on idle transitions. This is a RETRY net, not
 * the delivery path — a message to a free agent is typed into its terminal immediately, and a
 * queued one drains the instant its target reports idle. The tick only catches a target that
 * missed both, so it can be short: the work is a loop over the roster.
 */
const DRAIN_POLL_MS = 750
/** v3 A3: a queued message that cannot be delivered within this TTL expires. */
const DEFAULT_TTL_MS = 10 * 60_000
/** v3 A3: delivery attempts before a message becomes undeliverable. */
const MAX_DELIVERY_ATTEMPTS = 5
/**
 * v3 A4: window to observe receiver output beyond the typed echo. Paid on EVERY send, so it is the
 * single biggest tax on an agent-to-agent exchange; a peer that reacts at all reacts well inside
 * this, and one that doesn't is reported as unconfirmed rather than waited on.
 */
const CONFIRM_WINDOW_MS = 1200
/** v3 C: ask default timeout and hard cap (10 min). */
const ASK_DEFAULT_TIMEOUT_MS = 60_000
const ASK_MAX_TIMEOUT_MS = 10 * 60_000
/** v3 C: inferred reply tail cap. */
const ASK_REPLY_MAX_CHARS = 2000
/** v5 A1: wait-for-idle default timeout (5 min — every outcome answers, see A3) and cap (4 h). */
const WAIT_DEFAULT_TIMEOUT_MS = 3 * 60_000
const WAIT_MAX_TIMEOUT_MS = 4 * 60 * 60_000
/**
 * v5 A1: a wait resolves only after the target stays non-working this long (mid-turn blips).
 * Kept short because turn boundaries now come from the harness HOOKS (turn-start/turn-end), which
 * are authoritative — this window only has to outlast the gap between two tool calls, not stand in
 * for the turn signal itself. Raise it only if a harness without hooks starts reporting early.
 */
const WAIT_DEFAULT_QUIET_MS = 800
/** v5 A1: wait output delta cap (bigger than an ask reply — the CLI returns the whole turn). */
const WAIT_DELTA_MAX_CHARS = 64_000
/** v5 A1: how long a spawn prompt stays the anchor for the first wait on that newborn. */
const SPAWN_PROMPT_ANCHOR_TTL_MS = 10 * 60_000
/** v5 A3: a peer stuck on a permission prompt this long ends the wait as `blocked`, not a timeout. */
const WAIT_BLOCKED_STABLE_MS = 3500
/** v4 B3: an agent is "finished" only after this much stable idle content. */
const CHAIN_IDLE_STABLE_MS = 1800
/** v4 B1: chain default timeout (30 min) and hard cap (4 h). */
const CHAIN_DEFAULT_TIMEOUT_MS = 15 * 60_000
const CHAIN_MAX_TIMEOUT_MS = 4 * 60 * 60_000
/** v4 B4: loop protection + limits. */
const CHAIN_MAX_HOPS = 4
const CHAIN_MAX_PER_AGENT = 8
const CHAIN_MAX_PER_WORKSPACE = 24

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** v3 C: one in-flight ask, keyed by its short correlation id (#a3f2b). */
interface PendingAsk {
  corr: string
  from: string
  to: string
  at: number
  /** Cleaned tail of the target at send time — the inferred reply is the delta. */
  baseline: string
  timer: ReturnType<typeof setTimeout>
  settled: boolean
  resolve: (result: MeshToolResult) => void
}

/** v5 A1: one in-flight wait-for-idle, keyed by the target agent's id. */
interface IdleWaiter {
  resolve: (result: MeshToolResult) => void
  /** Stable-idle confirm timer; cleared the moment the target turns working again. */
  confirmTimer: ReturnType<typeof setTimeout> | null
  /** How long the target must stay non-working before the wait resolves. */
  quietMs: number
  startedAt: number
  /** Cleaned tail at wait start — the returned delta is what happened since. */
  baseline: string
}

/** v3 B: currentTask snapshot — single line, bounded. */
function shortTask(text: string): string {
  const t = String(text).replace(/[\r\n]+/g, ' ').trim()
  return t.length > 120 ? `${t.slice(0, 117)}\u2026` : t
}

/** v3 D1: strict shape enforcement for plano_declare input (surfaced to peers — no garbage). */
function sanitizeCapabilities(caps: unknown): AgentCapabilities | null {
  if (!caps || typeof caps !== 'object') return null
  const raw = caps as Record<string, unknown>
  if (typeof raw.vision !== 'boolean' || typeof raw.canSpawn !== 'boolean') return null
  if (typeof raw.contextTokens !== 'number' || !Number.isFinite(raw.contextTokens)) return null
  const contextTokens = Math.max(1000, Math.min(10_000_000, Math.floor(raw.contextTokens)))
  const model = typeof raw.model === 'string' ? raw.model.replace(/[\r\n]+/g, ' ').trim().slice(0, 128) : ''
  const tools: string[] = []
  if (Array.isArray(raw.tools)) {
    for (const t of raw.tools.slice(0, 50)) {
      if (typeof t !== 'string') continue
      const clean = t.replace(/[\r\n]+/g, ' ').trim().slice(0, 128)
      if (clean) tools.push(clean)
    }
  }
  return { vision: raw.vision, contextTokens, model: model || undefined, tools, canSpawn: raw.canSpawn }
}

/** v3 D2: model-id validation — writing to a PTY is executing code. Syntax first
 *  (command-injection guard), then the harness's known model families. */
function validateModelId(kind: AgentKind | 'unknown', modelId: string): MeshToolResult {
  if (!modelId || modelId.length === 0) return { ok: false, error: 'empty-model' }
  if (!MODEL_SYNTAX_RE.test(modelId)) {
    return {
      ok: false,
      error: 'invalid-model',
      detail: "model ids may contain letters, digits, '.', '_', ':', '/', '-' only (no spaces, ';', '&&', newlines)",
    }
  }
  const family = kind !== 'unknown' ? MODEL_FAMILIES[kind] : undefined
  if (family && !family.test(modelId)) {
    return { ok: false, error: 'unknown-model', detail: `no ${kind} model family matches '${modelId}'` }
  }
  return { ok: true }
}

export class MeshBus {
  private agents = new Map<string, MeshAgent>()
  private timeline: MeshEvent[] = []
  readonly mailboxes: MailboxStore
  /** Delivery hook for visible typing (plan F5) — wired by the daemon to writeSession. */
  onDeliver: ((ptyId: string, text: string) => boolean) | null = null
  /** v3 A4: raw tail hook — wired by the daemon to the session buffer, for delivery confirmation. */
  onTailRequest: ((ptyId: string) => string) | null = null
  /** Redacted context hook (plan F4) — wired by the daemon to the app's AgentContextService. */
  onContextRequest: ((ptyId: string) => Promise<string>) | null = null
  /** Spawn hook (plan F6) — wired by the daemon to spawn a PTY + materialize a panel.
   *  `ptyIds` = the exact ids created, so the caller can prompt or wait on them. */
  onSpawn:
    | ((req: {
        harness: string
        cwd: string
        prompt?: string
        count: number
        /** The agent that ASKED. The canvas places the newcomers beside its panel, at its size. */
        from: string
      }) => { ok: boolean; error?: string; ptyIds?: string[] })
    | null = null
  /** Event fan-out to the desktop app (mesh-link / mesh-msg frames). */
  onEvent: ((event: MeshEvent) => void) | null = null
  /** Consent prompt (plan F8): the daemon asks the app whether writes are allowed for a
   *  workspace. Returns true once the user enables it; the answer is remembered. */
  onConsentRequest: ((spaceId: string) => Promise<boolean>) | null = null

  /** Workspaces the user has enabled mesh WRITES for (plan F8 — zero-config read stays open). */
  private consented = new Set<string>()

  /** Per-agent send rate limit (messages per sliding window). */
  private sendCounts = new Map<string, { count: number; start: number }>()

  /** v3 C: in-flight asks keyed by short correlation id. */
  private pendingAsks = new Map<string, PendingAsk>()

  /** v5 A1: in-flight waits keyed by the TARGET agent's id. */
  private idleWaiters = new Map<string, Set<IdleWaiter>>()

  /**
   * v5 A1: the moment a spawn prompt was typed into a newborn, plus its transcript at that
   * instant. The FIRST wait on that agent adopts both, so `spawn --prompt --wait` reports the
   * turn its own prompt triggered even when the agent answers before the wait arrives (the
   * caller has to see the newborn become an agent first — that gap used to swallow the whole
   * turn and return an empty delta). One-shot, and ignored once stale.
   */
  private spawnPrompts = new Map<string, { at: number; baseline: string }>()

  /** v3 E: persistent relations between pairs, keyed by ordered pair. */
  private links = new Map<string, MeshLink>()

  /** v4 B1: armed chains, keyed by chain id. */
  private chains = new Map<string, MeshChain>()
  /** v4 B3: ask-user prompt (fire / cancel) — wired by the daemon to the app's toast. */
  onChainAskUser: ((chainId: string, from: string, to: string) => Promise<boolean>) | null = null

  /** v3 E: a relation stays 'active' while traffic flowed < 60 s or an ask is open. */
  private linkKey(a: string, b: string): string {
    return a < b ? `${a}\u2192${b}` : `${b}\u2192${a}`
  }

  /**
   * v3 E: touch the relation between `from` and `to` and push a link event. Active/waiting
   * increments the grouping counter ONLY for open relations (asks — `open: true`); a bare
   * send is a pulse that doesn't count. done/failed decrements; at zero the relation
   * returns to REST (idle, v4 A1) instead of disappearing. No loose timers in the daemon.
   */
  private touchLink(from: string, to: string, state: MeshLink['state'], corr?: string, open?: boolean): void {
    const key = this.linkKey(from, to)
    const now = Date.now()
    const prev = this.links.get(key)
    let count = prev?.count ?? 0
    if (open && (state === 'active' || state === 'waiting')) count += 1
    else if (!open && (state === 'done' || state === 'failed')) count = Math.max(0, count - 1)
    const link: MeshLink = {
      a: from < to ? from : to,
      b: from < to ? to : from,
      state,
      since: prev?.since ?? now,
      lastTraffic: now,
      count,
      from,
      to,
      kind: this.agents.get(from)?.kind ?? 'unknown',
      corr,
      // v4 A4/B1: an armed chain keeps the pair dashed across traffic.
      chained: prev?.chained,
    }
    if (count === 0 && state !== 'active') {
      // v4 A1: after a resolved/failed exchange the relation RETURNS TO REST (idle) —
      // the mesh line persists until a panel closes, never disappears mid-session.
      const rested: MeshLink = { ...link, state: 'idle' }
      this.links.set(key, rested)
    } else {
      this.links.set(key, link)
    }
    // The event carries the LIVE state (done/failed → renderer flashes) while the map
    // already holds the resting line.
    this.pushEvent({ at: now, kind: 'link', from, to, link })
  }

  /**
   * v3 E: snapshot for the renderer. v4 A1: a stale active (no ask, quiet > 60 s) DEGRADES
   * to 'idle' — the at-rest mesh line — instead of disappearing. The relation only leaves
   * on panel close or daemon restart (unregisterAgent), never silently.
   */
  linksView(): MeshLink[] {
    const now = Date.now()
    const out: MeshLink[] = []
    for (const link of this.links.values()) {
      if (link.state === 'active' && !link.corr && now - link.lastTraffic > 60_000) {
        const rested: MeshLink = { ...link, state: 'idle', count: 0 }
        this.links.set(this.linkKey(link.a, link.b), rested)
        this.pushEvent({ at: now, kind: 'link', from: link.from, to: link.to, link: rested })
        continue
      }
      out.push(link)
    }
    return out
  }

  constructor(userData: string) {
    this.userData = userData
    this.mailboxes = new MailboxStore(userData)
    this.loadConsent(userData)
    this.loadChains() // v4 B4: chains survive daemon restarts
    // v3 A3: drain on a timer too — a mailbox must never hang just because the target
    // never flips idle (repainting CLIs used to stay "busy" forever).
    this.drainTimer = setInterval(() => this.drainAll(), DRAIN_POLL_MS)
    this.drainTimer.unref?.()
  }

  private userData = ''
  private drainTimer: ReturnType<typeof setInterval> | null = null
  private startedAt = Date.now()

  private consentFile(userData: string): string {
    return join(userData, 'mesh', 'consent.json')
  }

  private loadConsent(userData: string): void {
    try {
      if (existsSync(this.consentFile(userData))) {
        const parsed = JSON.parse(readFileSync(this.consentFile(userData), 'utf8'))
        if (Array.isArray(parsed)) for (const id of parsed) if (typeof id === 'string') this.consented.add(id)
      }
    } catch {
      /* start empty */
    }
  }

  private persistConsent(): void {
    try {
      const file = this.consentFile(this.userData)
      mkdirSync(join(file, '..'), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify([...this.consented]), 'utf8')
      renameSync(tmp, file)
    } catch {
      /* best effort */
    }
  }

  /** Whether writes are allowed for the workspace; prompts once when unknown (plan F8). */
  private async ensureConsent(agentId: string): Promise<{ ok: boolean; error?: string }> {
    const agent = this.agents.get(agentId)
    const spaceId = agent?.workspace ?? ''
    if (this.consented.has(spaceId)) return { ok: true }
    if (!this.onConsentRequest) return { ok: false, error: 'consent-unavailable' }
    const granted = await this.onConsentRequest(spaceId)
    if (!granted) {
      this.pushEvent({ at: Date.now(), kind: 'consent', from: agentId, detail: 'consent-denied' })
      return { ok: false, error: 'consent-denied' }
    }
    this.consented.add(spaceId)
    this.persistConsent()
    this.pushEvent({ at: Date.now(), kind: 'consent', from: agentId, detail: 'consent-granted' })
    return { ok: true }
  }

  /** Anti-abuse: max sends per agent per window (plan F8). */
  private rateOk(agentId: string): boolean {
    const now = Date.now()
    const entry = this.sendCounts.get(agentId)
    if (!entry || now - entry.start > 10_000) {
      this.sendCounts.set(agentId, { count: 1, start: now })
      return true
    }
    entry.count += 1
    return entry.count <= 30
  }

  // ── roster ────────────────────────────────────────────────────────────────────

  registerAgent(agent: MeshAgent): void {
    this.agents.set(agent.id, agent)
    this.pushEvent({ at: Date.now(), kind: 'agent-up', from: agent.id, detail: agent.kind, panelId: agent.panelId })
  }

  unregisterAgent(ptyId: string): void {
    this.agents.delete(ptyId)
    // v3 E §3.5: a dead panel takes its relations with it — no ghost lines.
    for (const [key, link] of this.links) {
      if (link.a === ptyId || link.b === ptyId) this.links.delete(key)
    }
    // v3 §3.5: asks waiting on a dead peer fail with peer-exited (the onExit setState
    // path can't fire — the agent left the roster before the exit callback ran).
    this.resolvePendingFor(ptyId, 'exited', null)
    // v5 A1: waits on a dead peer resolve the same way — fail fast, never hang.
    this.resolveIdleWaiters(ptyId, 'exited', null)
    this.spawnPrompts.delete(ptyId)
    // v3 §3.5/3.6: pending messages to a dead peer are resolved with a REASON on the
    // timeline (never lost silently), then the box dies with the agent.
    const box = this.mailboxes.load(ptyId)
    const notified = new Set<string>()
    for (const message of box) {
      if (message.acked) continue
      message.status = 'undeliverable'
      message.reason = 'peer-exited'
      this.pushEvent({ at: Date.now(), kind: 'msg-undeliverable', from: message.from, to: ptyId, detail: 'peer-exited' })
      // Tell the SENDER, don't just log it. A timeline entry is only found by an agent that
      // already suspects something went wrong — the one in the field ran `plano inbox` (its own,
      // empty) and `plano status <dead id>` (not-found) and concluded its work had vanished. The
      // notice goes into the sender's own mailbox, so the existing drain types it into their
      // terminal the moment they are idle and `plano inbox` lists it until then.
      if (message.from && message.from !== ptyId && !notified.has(message.from) && this.agents.has(message.from)) {
        notified.add(message.from)
        this.mailboxes.push(message.from, {
          id: `sysx-${message.id}`,
          at: Date.now(),
          from: 'plano',
          to: message.from,
          text: `your queued message to ${this.displayName(ptyId)} was NOT delivered — that agent exited before consuming it. Re-send it to a live agent (plano roster).`,
          mode: 'queue',
          ttl: DEFAULT_TTL_MS,
          hops: 0,
          status: 'queued',
          acked: false,
        })
      }
    }
    this.mailboxes.clear(ptyId)
    for (const sender of notified) this.drainMailbox(sender)
    // v4 B4: a dead endpoint fails every chain it armed, watches, or targets.
    for (const chain of this.chains.values()) {
      if (chain.status !== 'armed') continue
      if (chain.from === ptyId || chain.to === ptyId || chain.watch === ptyId) {
        this.finishChain(chain, 'failed', 'peer-exited')
      }
    }
    this.pushEvent({ at: Date.now(), kind: 'agent-down', from: ptyId })
  }

  /**
   * v3 B: the single state transition point. busy is DERIVED (state === 'working') —
   * callers never set it directly. An idle transition drains the mailbox.
   */
  setState(ptyId: string, state: AgentState, exitCode?: number | null): void {
    const agent = this.agents.get(ptyId)
    if (!agent) return
    if (agent.state === state) return
    agent.state = state
    agent.stateSince = Date.now()
    agent.busy = state === 'working'
    if (state !== 'working') agent.manual = false
    if (exitCode !== undefined) agent.exitCode = exitCode
    agent.lastSeen = Date.now()
    this.pushEvent({ at: Date.now(), kind: 'state', from: ptyId, detail: state })
    // A busy agent that just went idle can receive queued messages (plan F5).
    if (state === 'idle' || state === 'awaiting-input') this.drainMailbox(ptyId)
    // v3 C: an ask against this agent resolves implicitly when it goes idle (inferred
    // reply from its tail) or dies (peer-exited). A still-working agent keeps waiting.
    if (state === 'idle') this.resolvePendingFor(ptyId, 'idle')
    else if (state === 'exited') this.resolvePendingFor(ptyId, 'exited', exitCode)
    // v5 A1: waiters resolve on the same transitions (exited now, idle after a quiet confirm).
    this.resolveIdleWaiters(ptyId, state, exitCode)
  }

  /** v3 B compat: busy is derived; keep the method for the transition window. */
  setBusy(ptyId: string, busy: boolean): void {
    const agent = this.agents.get(ptyId)
    if (!agent) return
    if (busy) this.setState(ptyId, agent.state === 'idle' ? 'working' : agent.state)
    else if (agent.state === 'working') this.setState(ptyId, 'idle')
  }

  setKind(ptyId: string, kind: AgentKind): void {
    const agent = this.agents.get(ptyId)
    if (!agent) return
    agent.kind = kind
    agent.lastSeen = Date.now()
  }

  agent(ptyId: string): MeshAgent | undefined {
    return this.agents.get(ptyId)
  }

  roster(): MeshAgent[] {
    return [...this.agents.values()].sort((a, b) => a.lastSeen - b.lastSeen)
  }

  // ── identity ──────────────────────────────────────────────────────────────────

  /** Resolve a presented token to its agent, or null when unknown/revoked. */
  resolveToken(token: string): string | null {
    return resolveAgent(token)
  }

  // ── tools (F1: whoami + roster; more added in F4-F6) ─────────────────────────

  whoami(agentId: string): MeshToolResult {
    const agent = this.agents.get(agentId)
    return {
      ok: true,
      id: agentId,
      workspace: agent?.workspace ?? '',
      cwd: agent?.cwd ?? '',
      kind: agent?.kind ?? 'unknown',
      meshUrl: meshUrl(),
      // v3 D1: what YOU can do (declared or harness default), plus the mesh tools available.
      capabilities: agent ? this.capabilitiesFor(agent) : null,
      capsSource: agent?.capsSource ?? (agent ? 'default' : 'unknown'),
      meshTools: ['roster', 'whoami', 'status', 'inbox', 'send', 'ask', 'reply', 'cancel', 'context', 'timeline', 'spawn_agent', 'wait', 'claim', 'handoff', 'declare', 'find', 'set_model', 'interrupt', 'compact'],
    }
  }

  rosterView(): MeshToolResult {
    return {
      ok: true,
      agents: this.roster().map((a) => ({
        id: a.id,
        kind: a.kind,
        cwd: a.cwd,
        workspace: a.workspace,
        // v3 B: state is the truth; busy stays as the derived compat field.
        state: a.state,
        busy: a.busy,
        currentTask: a.currentTask ?? null,
        since: a.stateSince,
        exitCode: a.exitCode ?? null,
        // v3 D1: capabilities (declared or harness default) for delegation.
        capsSource: a.capsSource ?? (a.capabilities ? 'default' : 'unknown'),
        capabilities: this.capabilitiesFor(a),
        title: a.panelTitle,
      })),
    }
  }

  /**
   * v3 B: plano_status — the "how's it going?" query. Target's state, current task,
   * timings, redacted output tail, pending mailbox depth and exit code.
   */
  async status(agentId: string, targetId: string): Promise<MeshToolResult> {
    const caller = this.agents.get(agentId)
    if (!caller) return { ok: false, error: 'not-registered', detail: 'your agent is not on the roster' }
    const target = this.agents.get(targetId)
    if (!target) return { ok: false, error: 'not-found', detail: `no agent with id ${targetId}` }
    const pendingMessages = this.mailboxes.load(targetId).filter((m) => !m.acked).length
    let lastOutput = ''
    if (this.onContextRequest) {
      try {
        lastOutput = (await this.onContextRequest(targetId)) ?? ''
      } catch {
        lastOutput = ''
      }
    }
    return {
      ok: true,
      id: targetId,
      kind: target.kind,
      state: target.state,
      currentTask: target.currentTask ?? null,
      since: target.stateSince,
      lastActivity: target.lastSeen,
      // Redaction is the app context hook's job — the bus never sees raw output.
      lastOutput: lastOutput.slice(-400),
      pendingMessages,
      exitCode: target.exitCode ?? null,
    }
  }

  // ── mailbox ───────────────────────────────────────────────────────────────────

  inbox(agentId: string): MeshToolResult {
    const messages = this.mailboxes.prune(agentId, Date.now())
    return {
      ok: true,
      messages: messages.map((m) => ({ id: m.id, from: m.from, at: m.at, text: m.text, mode: m.mode })),
    }
  }

  ack(agentId: string, messageId: string): MeshToolResult {
    const removed = this.mailboxes.remove(agentId, messageId)
    return { ok: true, acked: removed }
  }

  private drainMailbox(agentId: string): void {
    const now = Date.now()
    const target = this.agents.get(agentId)
    // Queue mode means "deliver when idle" — never type into a mid-turn agent. The
    // timer drain retries on the next tick; the idle transition drains immediately.
    if (target?.busy) return
    const messages = this.mailboxes.load(agentId)
    for (const message of messages) {
      if (message.acked) continue
      // v3 A3: real TTL — a message that can't be delivered expires and the sender is told
      // (timeline event; the sender sees it via timeline or the ask correlation in block C).
      if (message.ttl > 0 && now - message.at > message.ttl) {
        message.status = 'expired'
        message.acked = true
        this.mailboxes.remove(agentId, message.id)
        this.pushEvent({ at: now, kind: 'msg-expired', from: message.from, to: message.to, detail: 'ttl-expired' })
        continue
      }
      const delivered = this.onDeliver && this.onDeliver(message.to, this.messageLine(message)) && this.onDeliver(message.to, '\r')
      if (delivered) {
        message.status = 'delivered'
        message.acked = true
        this.mailboxes.remove(agentId, message.id)
        this.pushEvent({ at: Date.now(), kind: 'msg-delivered', from: message.from, to: message.to })
        // v3 A4: the write succeeded — whether the receiver produced output beyond the
        // typed echo is observed in the background (the sender of a queued message isn't
        // blocked waiting; the timeline carries the final word).
        void this.confirmAsync(message)
        return // one at a time; re-drain on next idle transition or timer tick
      }
      // v3 A3: retry with backoff (next tick), cap → undeliverable with a reason.
      message.attempts = (message.attempts ?? 0) + 1
      if (message.attempts >= MAX_DELIVERY_ATTEMPTS) {
        message.status = 'undeliverable'
        message.reason = 'write-failed-after-retries'
        message.acked = true
        this.mailboxes.remove(agentId, message.id)
        this.pushEvent({ at: Date.now(), kind: 'msg-undeliverable', from: message.from, to: message.to, detail: message.reason })
      } else {
        this.mailboxes.remove(agentId, message.id)
        this.mailboxes.push(agentId, message) // persist the attempt count
      }
      return
    }
  }

  /** v3 A3: timer-driven drain for every registered agent. v4 A1: also ages links
   *  (active → idle rest) so the mesh line persists without timers. v4 B4: chains
   *  whose endpoints are gone expire with a reason. */
  private drainAll(): void {
    for (const agent of this.agents.values()) this.drainMailbox(agent.id)
    this.linksView()
    // v4 B4: revalidate persisted chains, but only after a grace period — right after a
    // daemon restart the roster is still filling up and a premature check would expire
    // every surviving chain as peer-gone.
    if (Date.now() - this.startedAt > 10_000 && this.agents.size > 0) {
      for (const chain of this.chains.values()) {
        if (chain.status !== 'armed') continue
        if (!this.agents.has(chain.from) || !this.agents.has(chain.to) || (chain.watch && !this.agents.has(chain.watch))) {
          this.finishChain(chain, 'expired', 'peer-gone')
        }
      }
    }
  }

  // ── delivery confirmation (v3 A4) ────────────────────────────────────────────

  private cleanTail(ptyId: string): string {
    if (!this.onTailRequest) return ''
    return normalizeTerminalText(this.onTailRequest(ptyId) ?? '')
  }

  /**
   * Wait up to CONFIRM_WINDOW_MS for the receiver's cleaned tail to grow beyond the typed
   * echo (echo ≈ submitted length; anything past 1.2× is real receiver output). Written ≠
   * sent ≠ accepted: a quiet receiver yields 'written-but-unconfirmed'.
   */
  private async observeTailChange(ptyId: string, baseline: string, submittedLen: number): Promise<boolean> {
    if (!this.onTailRequest) return true
    const minGain = Math.max(40, Math.floor(submittedLen * 1.2))
    const deadline = Date.now() + CONFIRM_WINDOW_MS
    while (Date.now() < deadline) {
      await sleep(200)
      // Measure the DELTA, not the raw length. A tail is a rendered screen now, and a screen that
      // scrolls can gain content without gaining characters — comparing lengths would then read a
      // busy receiver as silent.
      if (this.tailDelta(baseline, this.cleanTail(ptyId), WAIT_DELTA_MAX_CHARS).length >= minGain) return true
    }
    return false
  }

  /** Background confirmation for queued deliveries (never throws — v3 §3). */
  private async confirmAsync(message: MeshMessage): Promise<void> {
    try {
      if (!this.onTailRequest || !message.to) return
      const baseline = this.cleanTail(message.to)
      const confirmed = await this.observeTailChange(message.to, baseline, message.text.length)
      message.confirmed = confirmed
      this.pushEvent({
        at: Date.now(),
        kind: 'msg-delivered',
        from: message.from,
        to: message.to,
        detail: confirmed ? 'confirmed' : 'written-but-unconfirmed',
      })
    } catch {
      /* v3 §3: never throw out of the daemon */
    }
  }

  // ── messaging (F4/F5) ─────────────────────────────────────────────────────────

  private displayName(agentId: string): string {
    const agent = this.agents.get(agentId)
    if (!agent) return 'agent'
    const kind = agent.kind === 'unknown' ? 'terminal' : agent.kind
    return kind.charAt(0).toUpperCase() + kind.slice(1)
  }

  /** Deliver text into a target PTY VISIBLY — char-by-char with jitter (~40-80 chars/s). */
  private async deliverTyped(ptyId: string, text: string): Promise<boolean> {
    if (!this.onDeliver) return false
    for (const char of text) {
      if (!this.onDeliver(ptyId, char)) return false
      await sleep(13 + Math.random() * 11)
    }
    return true
  }

  /** Public visible delivery (used by the daemon for spawn prompts, plan F6). */
  /**
   * Type a line into an agent and SUBMIT it — same contract as `send` (plan v3 A1), because the
   * spawn-with-prompt path (`plano_spawn_agent(prompt)`) goes through here. It used to type the
   * text with a bare '\n' and never submit, so a freshly created agent got its task written into
   * its input box and just sat there — the exact bug A1 fixed for `send`, still alive on the path
   * that matters most for "open two Codex and tell them to do X".
   */
  async deliverText(ptyId: string, text: string): Promise<boolean> {
    let normalized = String(text).replace(/[\r\n]+/g, ' ').trim()
    if (!normalized) return false
    if (normalized.length > MAX_MESSAGE_LEN) normalized = `${normalized.slice(0, MAX_MESSAGE_LEN - 3)}…`
    // Mark where this turn begins so a wait that arrives late still reports it (see spawnPrompts).
    this.spawnPrompts.set(ptyId, { at: Date.now(), baseline: this.cleanTail(ptyId) })
    if (!(await this.deliverTyped(ptyId, normalized))) return false
    return this.submitLine(ptyId)
  }

  /** Send a message to another agent (plan F5). mode 'type' types it into their terminal
   *  visibly (refused while they are mid-turn); 'queue' waits in their mailbox until idle.
   *  v3 §3.4: an optional messageId makes delivery idempotent — replaying the same id
   *  never duplicates (already queued or already delivered → reported, not re-sent). */
  async send(
    agentId: string,
    to: string,
    text: string,
    mode: 'type' | 'queue' = 'type',
    hops = 0,
    messageId?: string,
  ): Promise<MeshToolResult> {
    const resolved = this.resolveTarget(agentId, to)
    if (!resolved.ok) return resolved.result
    const target = resolved.agent
    to = target.id
    if (target.kind === 'unknown') return { ok: false, error: 'not-agent', detail: 'target is a plain terminal, no harness detected' }
    if (mode === 'type' && target.busy) {
      return { ok: false, error: 'working', detail: 'target is mid-turn — use queue mode or ask the user to interrupt' }
    }
    if (typeof text !== 'string' || text.length === 0) return { ok: false, error: 'empty' }
    if (text.length > MAX_MESSAGE_LEN) return { ok: false, error: 'too-large' }
    if (hops > MAX_HOPS) return { ok: false, error: 'too-many-hops', detail: `reply chain capped at ${MAX_HOPS}` }
    if (!this.rateOk(agentId)) return { ok: false, error: 'rate-limited', detail: 'too many messages in a short window' }
    // v3 §3.4: replaying a messageId is a no-op, never a duplicate delivery.
    if (messageId) {
      if (this.mailboxes.load(to).some((m) => m.id === messageId)) {
        return { ok: true, status: 'already-queued', id: messageId }
      }
      if (this.timeline.some((e) => e.kind === 'msg-delivered' && e.from === agentId && e.to === to && e.detail?.includes(`#${messageId}`))) {
        return { ok: true, status: 'already-delivered', id: messageId }
      }
    }
    const consent = await this.ensureConsent(agentId)
    if (!consent.ok) return consent

    const id = messageId ?? newMeshId()
    const message: MeshMessage = {
      id,
      at: Date.now(),
      from: agentId,
      to,
      text,
      mode,
      ttl: DEFAULT_TTL_MS, // v3 A3: queued messages expire instead of hanging forever
      hops,
      status: 'queued',
      acked: false,
    }
    // Plan v3 A1: ONE logical line, ONE real submit. A bare '\n' moves the cursor down without
    // executing — terminals submit with '\r'. The banner lives ON the same logical line (an
    // intermediate newline splits the receiver's prompt and some CLIs send it half-formed).
    // Internal newlines are normalized to spaces; oversized lines truncate with a visible mark.
    let normalized = String(text).replace(/[\r\n]+/g, ' ').trim()
    if (normalized.length > MAX_MESSAGE_LEN) normalized = `${normalized.slice(0, MAX_MESSAGE_LEN - 3)}\u2026`
    const line = `[plano \u2190 ${this.displayName(agentId)}] ${normalized}`

    if (mode === 'queue' && target.busy) {
      this.mailboxes.push(to, message)
      target.currentTask = shortTask(text) // v3 B: the target has work coming
      this.touchLink(agentId, to, 'active')
      this.pushEvent({ at: Date.now(), kind: 'msg-queued', from: agentId, to })
      return { ok: true, status: 'queued', id }
    }
    const baseline = this.cleanTail(to) // v3 A4: before the echo lands
    const delivered = (await this.deliverTyped(to, line)) && (await this.submitLine(to))
    if (!delivered) {
      message.attempts = 1
      this.mailboxes.push(to, message)
      target.currentTask = shortTask(text)
      this.pushEvent({ at: Date.now(), kind: 'msg-queued', from: agentId, to, detail: 'write failed, queued' })
      return { ok: true, status: 'queued', id }
    }
    target.currentTask = shortTask(text) // v3 B: the target's task is this message
    // v3 E: the relation is live (grouped counter, pulse direction emitter → receiver).
    this.touchLink(agentId, to, 'active')
    // v3 A4: distinguish written (bytes in the PTY) from accepted (receiver output beyond
    // the typed echo). The sender gets the honest status either way.
    const confirmed = await this.observeTailChange(to, baseline, normalized.length)
    message.confirmed = confirmed
    message.status = confirmed ? 'delivered' : 'written-but-unconfirmed'
    this.pushEvent({ at: Date.now(), kind: 'msg-delivered', from: agentId, to, detail: `${confirmed ? 'confirmed' : 'written-but-unconfirmed'} #${id}` })
    return { ok: true, status: message.status, confirmed, id }
  }

  /**
   * Resolve a `to` argument to a real peer, or explain precisely why it can't be.
   *
   * Two hard-won rules:
   *  - **Never self.** A message addressed to the caller would be typed into the very terminal
   *    that asked, which is what the user saw ("tell the Codex hola" → hola appeared in their own
   *    agent). Writing to yourself is never a legitimate mesh operation, so it is refused loudly
   *    instead of silently doing the confusing thing.
   *  - **A unique id prefix is accepted.** The roster shows shortened ids, and models pass those
   *    back; exact-match-only answered `not-found` for an id the agent had just been shown. A
   *    prefix must match exactly ONE peer — ambiguity is an error, never a guess.
   */
  private resolveTarget(
    from: string,
    to: string,
  ): { ok: true; agent: MeshAgent } | { ok: false; result: MeshToolResult } {
    const raw = typeof to === 'string' ? to.trim() : ''
    if (!raw) return { ok: false, result: { ok: false, error: 'missing-target' } }
    if (raw === from) {
      return {
        ok: false,
        result: { ok: false, error: 'self-target', detail: 'an agent cannot message itself — pick another id from plano_roster' },
      }
    }
    const exact = this.agents.get(raw)
    if (exact) return { ok: true, agent: exact }
    if (raw.length >= 4) {
      const matches = [...this.agents.values()].filter((a) => a.id !== from && a.id.startsWith(raw))
      if (matches.length === 1) return { ok: true, agent: matches[0] }
      if (matches.length > 1) {
        return {
          ok: false,
          result: { ok: false, error: 'ambiguous-target', detail: `"${raw}" matches ${matches.length} agents — use the full id` },
        }
      }
    }
    return { ok: false, result: { ok: false, error: 'not-found', detail: `no agent with id "${raw}" — call plano_roster` } }
  }

  /** Write a single Enter ('\r') to submit the typed line — exactly once per message. */
  private async submitLine(ptyId: string): Promise<boolean> {
    if (!this.onDeliver) return false
    return this.onDeliver(ptyId, '\r')
  }

  /** Normalized one-line form of a queued message (banner + text, same as live delivery). */
  private messageLine(message: MeshMessage): string {
    let normalized = String(message.text).replace(/[\r\n]+/g, ' ').trim()
    if (normalized.length > MAX_MESSAGE_LEN) normalized = `${normalized.slice(0, MAX_MESSAGE_LEN - 3)}\u2026`
    return `[plano \u2190 ${this.displayName(message.from)}] ${normalized}`
  }

  /** Send to every agent matching a filter (harness/cwd/workspace substring), capped. */
  async broadcast(agentId: string, filter: string, text: string): Promise<MeshToolResult> {
    const consent = await this.ensureConsent(agentId)
    if (!consent.ok) return consent
    if (!this.rateOk(agentId)) return { ok: false, error: 'rate-limited' }
    const query = (filter ?? '').toLowerCase()
    const targets = this.roster().filter((a) => {
      if (a.id === agentId) return false
      if (!query) return true
      return a.kind.toLowerCase().includes(query) || a.cwd.toLowerCase().includes(query) || a.workspace.toLowerCase().includes(query)
    })
    if (targets.length > MAX_BROADCAST_TARGETS) {
      return { ok: false, error: 'too-many-targets', detail: `matched ${targets.length} agents (cap ${MAX_BROADCAST_TARGETS}) — narrow the filter` }
    }
    const results: Array<{ to: string; status: string }> = []
    for (const target of targets) {
      const result = await this.send(agentId, target.id, text, 'queue')
      results.push({ to: target.id, status: result.ok ? String(result.status) : String(result.error) })
    }
    return { ok: true, sent: results }
  }

  /** Redacted tail of another agent (plan F4 — always through the redaction hook). */
  async context(_agentId: string, targetId: string): Promise<MeshToolResult> {
    const target = this.agents.get(targetId)
    if (!target) return { ok: false, error: 'not-found' }
    if (!this.onContextRequest) return { ok: false, error: 'context-unavailable' }
    const tail = await this.onContextRequest(targetId)
    return { ok: true, agent: targetId, tail }
  }

  /**
   * v3 D1: plano_declare — publish what you can do (authoritative). Validated hard:
   * a capabilities object is later surfaced to other agents, so shapes are enforced
   * and every string is normalized/bounded (command-injection hygiene).
   */
  declareCapabilities(agentId: string, caps: unknown): MeshToolResult {
    const agent = this.agents.get(agentId)
    if (!agent) return { ok: false, error: 'not-registered' }
    const clean = sanitizeCapabilities(caps)
    if (!clean) return { ok: false, error: 'invalid-capabilities', detail: 'expected { vision: boolean, contextTokens: number, model?, tools: string[], canSpawn: boolean }' }
    agent.capabilities = clean
    agent.capsSource = 'declared'
    this.pushEvent({ at: Date.now(), kind: 'consent', from: agentId, detail: `capabilities declared (vision=${clean.vision}, tokens=${clean.contextTokens})` })
    return { ok: true, capabilities: clean }
  }

  /** v3 D1: plano_find — who can do X? Declared beats harness default beats unknown. */
  find(agentId: string, capability: string): MeshToolResult {
    const caller = this.agents.get(agentId)
    if (!caller) return { ok: false, error: 'not-registered' }
    const query = String(capability ?? '').trim()
    if (!query) return { ok: false, error: 'unknown-capability', detail: 'supported: vision, canSpawn, contextTokens:<n>, model:<id>, tool:<name>' }
    const candidates = this.roster().filter((a) => a.id !== agentId && this.capabilityMatches(this.capabilitiesFor(a), query))
    return {
      ok: true,
      capability: query,
      candidates: candidates.map((a) => ({
        id: a.id,
        kind: a.kind,
        cwd: a.cwd,
        workspace: a.workspace,
        state: a.state,
        capsSource: a.capsSource ?? (a.capabilities ? 'default' : 'unknown'),
        capabilities: this.capabilitiesFor(a),
      })),
    }
  }

  /** Declared → harness default → null (unknown). */
  private capabilitiesFor(agent: MeshAgent): import('@shared/domain/agent').AgentCapabilities | null {
    if (agent.capabilities) return agent.capabilities
    if (agent.kind !== 'unknown') return HARNESS_CAPABILITIES[agent.kind] ?? null
    return null
  }

  private capabilityMatches(caps: import('@shared/domain/agent').AgentCapabilities | null, query: string): boolean {
    if (!caps) return false
    if (query === 'vision') return caps.vision
    if (query === 'canSpawn') return caps.canSpawn
    if (query.startsWith('contextTokens:')) {
      const n = Number(query.slice('contextTokens:'.length))
      return Number.isFinite(n) && caps.contextTokens >= n
    }
    if (query.startsWith('model:')) return !!caps.model && caps.model.toLowerCase().includes(query.slice(6).toLowerCase())
    if (query.startsWith('tool:')) return caps.tools.includes(query.slice(5))
    return false
  }

  // ── agent control (v3 D2): the harness's own commands only ────────────────────

  /**
   * plano_set_model: switch another agent's model via ITS OWN slash command. Fails with
   * unsupported-harness when the harness has none; refuses mid-turn; validates the id
   * (syntax + per-harness family — writing to a PTY is executing code); verifies by
   * reading the tail, never an optimistic ok.
   */
  async setModel(agentId: string, targetId: string, model: unknown): Promise<MeshToolResult> {
    const caller = this.agents.get(agentId)
    if (!caller) return { ok: false, error: 'not-registered' }
    const target = this.agents.get(targetId)
    if (!target) return { ok: false, error: 'not-found', detail: `no agent with id ${targetId}` }
    if (target.kind === 'unknown') return { ok: false, error: 'not-agent', detail: 'target is a plain terminal, no harness detected' }
    const control = HARNESS_CONTROL[target.kind as AgentKind] ?? null
    if (!control?.setModel) {
      return { ok: false, error: 'unsupported-harness', detail: `${target.kind} has no /model command — refusing to invent one` }
    }
    if (target.state !== 'idle') {
      return { ok: false, error: 'not-idle', detail: `state is '${target.state}' — changing the model mid-turn breaks the session` }
    }
    const modelId = String(model ?? '').trim()
    const validation = validateModelId(target.kind, modelId)
    if (!validation.ok) return validation
    const consent = await this.ensureConsent(agentId)
    if (!consent.ok) return consent
    const command = control.setModel.replace('{model}', modelId)
    const baseline = this.cleanTail(targetId)
    const delivered = (await this.deliverTyped(targetId, command)) && (await this.submitLine(targetId))
    if (!delivered) return { ok: false, error: 'write-failed', detail: `could not type into ${targetId}` }
    this.pushEvent({ at: Date.now(), kind: 'control', from: agentId, to: targetId, detail: `set_model ${modelId}` })
    // Verify by tail: the harness echoes the active model after /model.
    const found = await this.waitForTailContains(targetId, modelId, 4000, baseline)
    if (!found) {
      return { ok: false, error: 'verification-failed', detail: `'${modelId}' not visible in the target's output after /model` }
    }
    return { ok: true, model: modelId, status: 'verified' }
  }

  /** plano_interrupt: send the harness's interrupt key (Esc / Ctrl-C per table). */
  async interrupt(agentId: string, targetId: string): Promise<MeshToolResult> {
    const caller = this.agents.get(agentId)
    if (!caller) return { ok: false, error: 'not-registered' }
    const target = this.agents.get(targetId)
    if (!target) return { ok: false, error: 'not-found', detail: `no agent with id ${targetId}` }
    if (target.kind === 'unknown') return { ok: false, error: 'not-agent', detail: 'target is a plain terminal, no harness detected' }
    const control = HARNESS_CONTROL[target.kind as AgentKind] ?? null
    if (!control?.interrupt?.length) {
      return { ok: false, error: 'unsupported-harness', detail: `no interrupt sequence known for ${target.kind}` }
    }
    const consent = await this.ensureConsent(agentId)
    if (!consent.ok) return consent
    let ok = true
    for (const key of control.interrupt) {
      if (!this.onDeliver?.(targetId, key)) ok = false
    }
    this.pushEvent({ at: Date.now(), kind: 'control', from: agentId, to: targetId, detail: 'interrupt' })
    return ok ? { ok: true, status: 'interrupt-sent' } : { ok: false, error: 'write-failed' }
  }

  /** plano_compact: run the harness's compaction command, verified by tail. */
  async compact(agentId: string, targetId: string): Promise<MeshToolResult> {
    const caller = this.agents.get(agentId)
    if (!caller) return { ok: false, error: 'not-registered' }
    const target = this.agents.get(targetId)
    if (!target) return { ok: false, error: 'not-found', detail: `no agent with id ${targetId}` }
    if (target.kind === 'unknown') return { ok: false, error: 'not-agent', detail: 'target is a plain terminal, no harness detected' }
    const control = HARNESS_CONTROL[target.kind as AgentKind] ?? null
    if (!control?.compact) {
      return { ok: false, error: 'unsupported-harness', detail: `${target.kind} has no compaction command` }
    }
    if (target.state !== 'idle') return { ok: false, error: 'not-idle', detail: `state is '${target.state}'` }
    const consent = await this.ensureConsent(agentId)
    if (!consent.ok) return consent
    const baseline = this.cleanTail(targetId)
    const delivered = (await this.deliverTyped(targetId, control.compact)) && (await this.submitLine(targetId))
    if (!delivered) return { ok: false, error: 'write-failed', detail: `could not type into ${targetId}` }
    this.pushEvent({ at: Date.now(), kind: 'control', from: agentId, to: targetId, detail: 'compact' })
    const found = await this.waitForTailContains(targetId, 'compact', 4000, baseline)
    return found ? { ok: true, status: 'verified' } : { ok: false, error: 'verification-failed', detail: 'no compaction evidence in the target output' }
  }

  /** Poll the cleaned tail for `needle` after a baseline (≤ timeoutMs). */
  private async waitForTailContains(ptyId: string, needle: string, timeoutMs: number, baseline: string): Promise<boolean> {
    if (!this.onTailRequest) return true
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(300)
      const tail = this.cleanTail(ptyId)
      if (tail.length > baseline.length + needle.length && tail.slice(baseline.length).toLowerCase().includes(needle.toLowerCase())) return true
    }
    return false
  }

  /**
   * Record what an agent is working on, without touching its state. The harness lifecycle hook
   * uses this: `UserPromptSubmit` carries the user's real prompt, which is what the roster and
   * the "finished" notification quote — far better than the tail-scraped guess.
   */
  setCurrentTask(agentId: string, task: string): void {
    const agent = this.agents.get(agentId)
    if (!agent || !task.trim()) return
    agent.currentTask = shortTask(task)
  }

  /** Claim a task — mark working so peers see it and avoid stepping on you. */
  claim(agentId: string, task: string): MeshToolResult {
    const agent = this.agents.get(agentId)
    if (!agent) return { ok: false, error: 'not-registered' }
    agent.currentTask = shortTask(task)
    agent.manual = true // v3 B: a human/manual claim — the detect loop must preserve it
    this.setState(agentId, 'working')
    this.pushEvent({ at: Date.now(), kind: 'consent', from: agentId, detail: `claim: ${shortTask(task)}` })
    return { ok: true, busy: true, task }
  }

  // ── ask/reply (v3 C): a real conversation, never a bus lock ───────────────────

  /**
   * plano_ask: send AND wait for the answer. The delivered line carries a short
   * correlation id (#a3f2b) the receiver echoes back with plano_reply. If the receiver
   * never calls plano_reply, the ask resolves with an INFERRED reply (its cleaned tail
   * since send) when it goes idle, or fails on timeout/cancel/death. The wait is by
   * correlation only — other mesh traffic keeps flowing.
   */
  async ask(agentId: string, to: string, text: string, timeoutMs = ASK_DEFAULT_TIMEOUT_MS): Promise<MeshToolResult> {
    const resolved = this.resolveTarget(agentId, to)
    if (!resolved.ok) return resolved.result
    const target = resolved.agent
    to = target.id
    if (target.kind === 'unknown') {
      return { ok: false, error: 'not-agent', detail: 'target is a plain terminal, no harness detected' }
    }
    if (typeof text !== 'string' || text.length === 0) return { ok: false, error: 'empty' }
    if (text.length > MAX_MESSAGE_LEN) return { ok: false, error: 'too-large' }
    if (!this.rateOk(agentId)) return { ok: false, error: 'rate-limited', detail: 'too many messages in a short window' }
    const consent = await this.ensureConsent(agentId)
    if (!consent.ok) return consent

    const corr = Math.random().toString(16).slice(2, 7)
    const ms = Math.max(1000, Math.min(timeoutMs || ASK_DEFAULT_TIMEOUT_MS, ASK_MAX_TIMEOUT_MS))
    const baseline = this.cleanTail(to)
    let normalized = String(text).replace(/[\r\n]+/g, ' ').trim()
    if (normalized.length > MAX_MESSAGE_LEN) normalized = `${normalized.slice(0, MAX_MESSAGE_LEN - 3)}\u2026`
    const line = `[plano \u2190 ${this.displayName(agentId)} #${corr}] ${normalized}`

    const delivered = (await this.deliverTyped(to, line)) && (await this.submitLine(to))
    if (!delivered) {
      return { ok: false, error: 'write-failed', detail: `could not type into ${to}` }
    }
    target.currentTask = shortTask(text)
    this.pushEvent({ at: Date.now(), kind: 'msg-sent', from: agentId, to, detail: `ask #${corr}` })
    // v3 E: the asker waits → the relation is 'waiting' (breathing dot at B). v4 A4:
    // an ask OPENS the relation (counts toward the grouping counter).
    this.touchLink(agentId, to, 'waiting', corr, true)

    return new Promise<MeshToolResult>((resolve) => {
      const timer = setTimeout(() => {
        const ask = this.pendingAsks.get(corr)
        if (!ask || ask.settled) return
        ask.settled = true
        this.pendingAsks.delete(corr)
        const tail = this.cleanTail(to)
        resolve({ ok: true, correlationId: corr, reply: this.tailDelta(ask.baseline, tail), inferred: true, timeout: true })
        // v3 E: timed out → the relation flashes failed and leaves.
        this.touchLink(agentId, to, 'failed')
        this.pushEvent({ at: Date.now(), kind: 'ask', from: agentId, to, detail: `timeout #${corr}` })
      }, ms)
      timer.unref?.()
      this.pendingAsks.set(corr, { corr, from: agentId, to, at: Date.now(), baseline, timer, settled: false, resolve })
      this.pushEvent({ at: Date.now(), kind: 'ask', from: agentId, to, detail: `pending #${corr}` })
    })
  }

  /** plano_reply: the receiver answers an ask; closes the correlation. */
  reply(agentId: string, correlationId: string, summary: string): MeshToolResult {
    const ask = this.pendingAsks.get(correlationId)
    if (!ask || ask.settled) return { ok: false, error: 'no-pending-ask', detail: `no open ask with id #${correlationId}` }
    if (ask.to !== agentId) return { ok: false, error: 'not-addressed', detail: `ask #${correlationId} is addressed to another agent` }
    ask.settled = true
    this.pendingAsks.delete(correlationId)
    clearTimeout(ask.timer)
    const reply = String(summary ?? '').slice(0, ASK_REPLY_MAX_CHARS)
    ask.resolve({ ok: true, correlationId, reply, inferred: false })
    // v4 A4: the reply pulse travels BACK (responder → asker) before the line rests.
    this.touchLink(agentId, ask.from, 'done')
    this.pushEvent({ at: Date.now(), kind: 'ask', from: ask.from, to: agentId, detail: `answered #${correlationId}` })
    return { ok: true, correlationId, acked: true }
  }

  /** plano_cancel: the asker gives up; frees the correlation immediately. */
  cancel(agentId: string, correlationId: string): MeshToolResult {
    const ask = this.pendingAsks.get(correlationId)
    if (!ask || ask.settled) return { ok: false, error: 'no-pending-ask', detail: `no open ask with id #${correlationId}` }
    if (ask.from !== agentId) return { ok: false, error: 'not-yours', detail: `ask #${correlationId} belongs to another agent` }
    ask.settled = true
    this.pendingAsks.delete(correlationId)
    clearTimeout(ask.timer)
    ask.resolve({ ok: false, error: 'cancelled', correlationId })
    // v3 E: cancelled by the asker → resolves cleanly.
    this.touchLink(agentId, ask.to, 'done')
    this.pushEvent({ at: Date.now(), kind: 'ask', from: agentId, to: ask.to, detail: `cancelled #${correlationId}` })
    return { ok: true, correlationId, cancelled: true }
  }

  /** Resolve every ask addressed to a target when it goes idle (inferred) or dies. */
  private resolvePendingFor(targetId: string, reason: 'idle' | 'exited', exitCode?: number | null): void {
    for (const [corr, ask] of this.pendingAsks) {
      if (ask.to !== targetId || ask.settled) continue
      ask.settled = true
      this.pendingAsks.delete(corr)
      clearTimeout(ask.timer)
      if (reason === 'exited') {
        ask.resolve({ ok: false, error: 'peer-exited', detail: `target died (exit ${exitCode ?? '?'})`, correlationId: corr })
        // v3 E: death of an endpoint resolves its relations (no ghost lines).
        this.touchLink(ask.from, targetId, 'failed')
        this.pushEvent({ at: Date.now(), kind: 'ask', from: ask.from, to: targetId, detail: `peer-exited #${corr}` })
      } else {
        const tail = this.cleanTail(targetId)
        ask.resolve({ ok: true, correlationId: corr, reply: this.tailDelta(ask.baseline, tail), inferred: true })
        this.pushEvent({ at: Date.now(), kind: 'ask', from: ask.from, to: targetId, detail: `inferred #${corr}` })
      }
    }
  }

  /** Cleaned tail delta since the ask was sent (bounded). Nothing new → empty. */
  private tailDelta(baseline: string, tail: string, maxChars = ASK_REPLY_MAX_CHARS): string {
    if (!tail) return ''
    if (!baseline) return tail.slice(-maxChars)
    // Fast path: the session only appended since the baseline.
    if (tail.startsWith(baseline)) return tail.slice(baseline.length).slice(0, maxChars)
    // A tail is now the RENDERED SCREEN (daemon/screen.ts), and a screen is not append-only — it
    // scrolls and repaints, so the baseline stops being a prefix the moment a line leaves the top.
    // Re-anchor on the last few non-empty lines of the baseline: whatever follows their last
    // occurrence is what happened since. Three lines, because a TUI repeats single ones (prompt
    // markers, box borders) and a one-line anchor would match the wrong place.
    const anchor = baseline
      .split('\n')
      .filter((line) => line.trim() !== '')
      .slice(-3)
      .join('\n')
    if (anchor) {
      const at = tail.lastIndexOf(anchor)
      if (at !== -1) return tail.slice(at + anchor.length).replace(/^\n+/, '').slice(0, maxChars)
    }
    // Scrolled clean past the baseline: everything visible is new to the caller. Keep the END —
    // the most recent output is the answer, the top of the screen is history.
    return tail.slice(-maxChars)
  }

  // ── wait (v5 A1): block until a target finishes its turn or exits ────────────

  /**
   * plano_wait: the orchestration primitive behind "send the plan, then wait for it".
   * Resolves when the target transitions INTO idle (held stable for quietMs) or exits.
   * A target that was already idle when the wait started keeps waiting for its NEXT turn,
   * so "send → wait" can never race the message. awaiting-input (a blocked permission
   * prompt) never counts as finished — same rule as the chain engine (v4 B3). Event-driven
   * (state transitions), never a poll; other mesh traffic keeps flowing. Returns the output
   * delta since the wait started, bounded at WAIT_DELTA_MAX_CHARS.
   */
  async waitForIdle(
    agentId: string,
    targetId: string,
    opts: { timeoutMs?: number; quietMs?: number; since?: number; nextTurn?: boolean } = {},
  ): Promise<MeshToolResult> {
    const caller = this.agents.get(agentId)
    if (!caller) return { ok: false, error: 'not-registered', detail: 'your agent is not on the roster' }
    const target = this.agents.get(targetId)
    if (!target) return { ok: false, error: 'not-found', detail: `no agent with id ${targetId}` }
    if (target.kind === 'unknown') {
      return { ok: false, error: 'not-agent', detail: 'target is a plain terminal, no harness detected' }
    }
    const timeoutMs = Math.max(1000, Math.min(opts.timeoutMs ?? WAIT_DEFAULT_TIMEOUT_MS, WAIT_MAX_TIMEOUT_MS))
    const quietMs = Math.max(0, Math.min(opts.quietMs ?? WAIT_DEFAULT_QUIET_MS, 60_000))
    // `since` lets a caller resolve "the turn that started before my send" — a fast target may
    // finish the whole turn between the send returning and the wait arriving (one poll gap).
    // Without it, send → wait on a quick target would hang until timeout.
    // A spawn prompt sets the same two anchors for the caller: `spawn --prompt --wait` cannot
    // pass them itself (it only learns the newborn exists after the daemon typed into it).
    const spawned = this.spawnPrompts.get(targetId)
    this.spawnPrompts.delete(targetId)
    const fresh = spawned && Date.now() - spawned.at < SPAWN_PROMPT_ANCHOR_TTL_MS ? spawned : null
    const since = typeof opts.since === 'number' && opts.since > 0 ? opts.since : (fresh?.at ?? Date.now())
    const baseline = typeof opts.since === 'number' && opts.since > 0 ? this.cleanTail(targetId) : (fresh?.baseline ?? this.cleanTail(targetId))
    const startedAt = Date.now()
    if (target.state === 'exited') {
      return { ok: true, id: targetId, state: 'exited', exitCode: target.exitCode ?? null, delta: '', durationMs: 0 }
    }
    // v5 A1: a turn that ENDED after `since` counts as done even if we never saw it busy —
    // the send → wait race with a fast peer. It must still have been quiet for quietMs: a
    // booting harness goes briefly idle between its own paint bursts, and that gap is not a
    // finished turn. When it is too fresh, the waiter below confirms the rest of the window.
    const doneBefore = target.state === 'idle' && target.stateSince >= since
    if (doneBefore && Date.now() - target.stateSince >= quietMs) {
      return {
        ok: true,
        id: targetId,
        state: 'idle',
        exitCode: null,
        delta: this.tailDelta(baseline, this.cleanTail(targetId), WAIT_DELTA_MAX_CHARS),
        durationMs: 0,
        immediate: true,
      }
    }
    // A bare `plano wait <id>` on a peer that ALREADY finished used to block for the whole
    // timeout: with no anchor the wait targets the peer's NEXT turn, and a peer sitting at its
    // prompt never transitions again. That is the "it hung on keepalives and the answer was
    // already in the transcript" case. Answer it straight away, with the transcript, unless the
    // caller explicitly asked for the next turn (`nextTurn`) or anchored the wait itself.
    const anchored = (typeof opts.since === 'number' && opts.since > 0) || !!fresh
    if (!anchored && !opts.nextTurn && target.state === 'idle' && Date.now() - target.stateSince >= quietMs) {
      return {
        ok: true,
        id: targetId,
        state: 'idle',
        exitCode: null,
        delta: '',
        tail: this.cleanTail(targetId).slice(-WAIT_DELTA_MAX_CHARS),
        idleFor: Date.now() - target.stateSince,
        durationMs: 0,
        alreadyIdle: true,
      }
    }
    // Blocked on a permission prompt is not "finished", but it is not worth waiting out either:
    // nobody is coming unless a human answers. Report it as soon as it is stable so the caller
    // can act, instead of burning the timeout on a peer that cannot progress.
    const blockedMs = Math.max(quietMs, WAIT_BLOCKED_STABLE_MS)
    if (target.state === 'awaiting-input' && Date.now() - target.stateSince >= blockedMs) {
      return {
        ok: true,
        id: targetId,
        state: 'awaiting-input',
        exitCode: null,
        delta: this.tailDelta(baseline, this.cleanTail(targetId), WAIT_DELTA_MAX_CHARS),
        tail: this.cleanTail(targetId).slice(-2000),
        durationMs: 0,
        blocked: true,
        detail: 'target is waiting for input (permission prompt) — it cannot finish on its own',
      }
    }
    return new Promise<MeshToolResult>((resolve) => {
      let settled = false
      const finish = (result: MeshToolResult): void => {
        if (settled) return
        settled = true
        const box = this.idleWaiters.get(targetId)
        if (box) {
          box.delete(waiter)
          if (box.size === 0) this.idleWaiters.delete(targetId)
        }
        if (waiter.confirmTimer) {
          clearTimeout(waiter.confirmTimer)
          waiter.confirmTimer = null
        }
        resolve(result)
      }
      const waiter: IdleWaiter = { resolve: finish, confirmTimer: null, quietMs, startedAt, baseline }
      const box = this.idleWaiters.get(targetId) ?? new Set<IdleWaiter>()
      box.add(waiter)
      this.idleWaiters.set(targetId, box)
      // Already blocked, just not long enough to call it yet — and no further transition is
      // coming while it sits on the prompt, so finish the stability window here.
      if (target.state === 'awaiting-input') {
        waiter.confirmTimer = setTimeout(
          () => {
            waiter.confirmTimer = null
            finish({
              ok: true,
              id: targetId,
              state: 'awaiting-input',
              exitCode: null,
              delta: this.tailDelta(baseline, this.cleanTail(targetId), WAIT_DELTA_MAX_CHARS),
              tail: this.cleanTail(targetId).slice(-2000),
              durationMs: Date.now() - startedAt,
              blocked: true,
              detail: 'target is waiting for input (permission prompt) — it cannot finish on its own',
            })
          },
          Math.max(0, blockedMs - (Date.now() - target.stateSince)),
        )
        waiter.confirmTimer.unref?.()
      }
      // Already idle since `since`, just not long enough yet: no further transition is coming,
      // so confirm the remainder of the quiet window here (working again cancels it, as usual).
      if (doneBefore) {
        waiter.confirmTimer = setTimeout(
          () => {
            waiter.confirmTimer = null
            finish({
              ok: true,
              id: targetId,
              state: 'idle',
              exitCode: null,
              delta: this.tailDelta(baseline, this.cleanTail(targetId), WAIT_DELTA_MAX_CHARS),
              durationMs: Date.now() - startedAt,
            })
          },
          Math.max(0, quietMs - (Date.now() - target.stateSince)),
        )
        waiter.confirmTimer.unref?.()
      }
      const timer = setTimeout(() => {
        const current = this.agents.get(targetId)
        finish({
          ok: true,
          id: targetId,
          state: current?.state ?? 'exited',
          exitCode: current?.exitCode ?? null,
          delta: this.tailDelta(baseline, this.cleanTail(targetId), WAIT_DELTA_MAX_CHARS),
          durationMs: Date.now() - startedAt,
          timedOut: true,
          detail: `target still ${current?.state ?? 'gone'} after ${timeoutMs} ms`,
        })
      }, timeoutMs)
      timer.unref?.()
    })
  }

  /** v5 A1: transition feed for waiters — called from setState and unregisterAgent. */
  private resolveIdleWaiters(ptyId: string, state: AgentState, exitCode?: number | null): void {
    const box = this.idleWaiters.get(ptyId)
    if (!box || box.size === 0) return
    const now = Date.now()
    for (const waiter of [...box]) {
      if (state === 'exited') {
        waiter.resolve({
          ok: true,
          id: ptyId,
          state: 'exited',
          exitCode: exitCode ?? null,
          delta: this.tailDelta(waiter.baseline, this.cleanTail(ptyId), WAIT_DELTA_MAX_CHARS),
          durationMs: now - waiter.startedAt,
        })
        continue
      }
      if (state === 'working') {
        // Busy again — cancel any pending confirm; the turn is still running.
        if (waiter.confirmTimer) {
          clearTimeout(waiter.confirmTimer)
          waiter.confirmTimer = null
        }
        continue
      }
      if (state === 'awaiting-input') {
        // Blocked mid-wait: hold it briefly (a prompt the peer answers itself, or a human
        // clicking, is not a block) and then report instead of waiting out the timeout.
        if (waiter.confirmTimer) {
          clearTimeout(waiter.confirmTimer)
          waiter.confirmTimer = null
        }
        waiter.confirmTimer = setTimeout(
          () => {
            waiter.confirmTimer = null
            waiter.resolve({
              ok: true,
              id: ptyId,
              state: 'awaiting-input',
              exitCode: null,
              delta: this.tailDelta(waiter.baseline, this.cleanTail(ptyId), WAIT_DELTA_MAX_CHARS),
              tail: this.cleanTail(ptyId).slice(-2000),
              durationMs: Date.now() - waiter.startedAt,
              blocked: true,
              detail: 'target is waiting for input (permission prompt) — it cannot finish on its own',
            })
          },
          Math.max(waiter.quietMs, WAIT_BLOCKED_STABLE_MS),
        )
        waiter.confirmTimer.unref?.()
        continue
      }
      if (state === 'idle' && !waiter.confirmTimer) {
        // Candidate: resolve only if it STAYS idle through the quiet window.
        waiter.confirmTimer = setTimeout(() => {
          waiter.confirmTimer = null
          waiter.resolve({
            ok: true,
            id: ptyId,
            state: 'idle',
            exitCode: null,
            delta: this.tailDelta(waiter.baseline, this.cleanTail(ptyId), WAIT_DELTA_MAX_CHARS),
            durationMs: Date.now() - waiter.startedAt,
          })
        }, waiter.quietMs)
        waiter.confirmTimer.unref?.()
      }
      // awaiting-input is handled above: never "finished" (chain rule v4 B3), but reported as
      // blocked so an interactive wait ends with an answer instead of a timeout.
    }
  }

  // ── chaining (v4 B1-B4): work that fires itself ───────────────────────────────

  private chainsFile(): string {
    return join(this.userData, 'mesh', 'chains.json')
  }

  private loadChains(): void {
    try {
      if (existsSync(this.chainsFile())) {
        const parsed = JSON.parse(readFileSync(this.chainsFile(), 'utf8'))
        if (Array.isArray(parsed)) {
          for (const c of parsed) {
            if (c && typeof c.id === 'string' && typeof c.from === 'string' && typeof c.to === 'string') {
              this.chains.set(c.id, c as MeshChain)
            }
          }
        }
      }
    } catch {
      /* start empty */
    }
  }

  private persistChains(): void {
    try {
      const file = this.chainsFile()
      mkdirSync(join(file, '..'), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify([...this.chains.values()]), 'utf8')
      renameSync(tmp, file)
    } catch {
      /* best effort — an armed chain that isn't persisted is the only loss mode */
    }
  }

  /** v4 A4/B1: an armed chain dashes the pair's line until it fires/cancels. */
  private setLinkChained(a: string, b: string, chained: boolean): void {
    const key = this.linkKey(a, b)
    const link = this.links.get(key)
    if (!link) {
      if (!chained) return
      const now = Date.now()
      const rest: MeshLink = {
        a: a < b ? a : b,
        b: a < b ? b : a,
        state: 'idle',
        since: now,
        lastTraffic: now,
        count: 0,
        from: a,
        to: b,
        kind: this.agents.get(a)?.kind ?? 'unknown',
        chained: true,
      }
      this.links.set(key, rest)
      this.pushEvent({ at: now, kind: 'link', from: a, to: b, link: rest })
      return
    }
    if (link.chained === chained) return
    link.chained = chained
    this.pushEvent({ at: Date.now(), kind: 'link', from: link.from, to: link.to, link: { ...link } })
  }

  /**
   * v4 B1: arm a chain. Semantics are a TRIGGER (i-finish / agent-finishes / i-reply),
   * never a timer. The chain is harmless until it fires — firing is a WRITE and goes
   * through workspace consent like every other write.
   */
  chain(
    agentId: string,
    args: { to: string; payload?: unknown; when?: string; watch?: string; timeoutMs?: number; onFailure?: string; hops?: number },
  ): MeshToolResult {
    const caller = this.agents.get(agentId)
    if (!caller) return { ok: false, error: 'not-registered' }
    const to = String(args.to ?? '')
    const target = this.agents.get(to)
    if (!target) return { ok: false, error: 'not-found', detail: `no agent with id ${to}` }
    if (target.kind === 'unknown') return { ok: false, error: 'not-agent', detail: 'target is a plain terminal, no harness detected' }
    if (to === agentId) return { ok: false, error: 'self-chain', detail: 'chaining to yourself is a no-op' }
    const when: ChainWhen = args.when === 'agent-finishes' ? 'agent-finishes' : args.when === 'i-reply' ? 'i-reply' : 'i-finish'
    if (when === 'agent-finishes') {
      const watch = this.agents.get(String(args.watch ?? ''))
      if (!watch) return { ok: false, error: 'watch-not-found', detail: `no agent with id ${args.watch}` }
      if (watch.kind === 'unknown') return { ok: false, error: 'watch-not-agent' }
    }
    const hops = Number(args.hops ?? 0) || 0
    if (hops >= CHAIN_MAX_HOPS) return { ok: false, error: 'too-many-hops', detail: `chain depth capped at ${CHAIN_MAX_HOPS}` }
    const timeoutMs = Math.max(5000, Math.min(args.timeoutMs ?? CHAIN_DEFAULT_TIMEOUT_MS, CHAIN_MAX_TIMEOUT_MS))
    const onFailure: ChainFailure = args.onFailure === 'fire-anyway' ? 'fire-anyway' : args.onFailure === 'ask-user' ? 'ask-user' : 'notify'
    // v4 B4: limits.
    const armed = [...this.chains.values()].filter((c) => c.status === 'armed')
    if (armed.filter((c) => c.from === agentId).length >= CHAIN_MAX_PER_AGENT) {
      return { ok: false, error: 'limit-reached', detail: `max ${CHAIN_MAX_PER_AGENT} armed chains per agent` }
    }
    const spaceId = caller.workspace
    if (armed.filter((c) => this.agents.get(c.from)?.workspace === spaceId).length >= CHAIN_MAX_PER_WORKSPACE) {
      return { ok: false, error: 'limit-reached', detail: `max ${CHAIN_MAX_PER_WORKSPACE} armed chains per workspace` }
    }
    // Payload: explicit text (reliable) > file path (recommended for real plans) > inferred tail.
    let payload: MeshChain['payload'] = { source: 'inferred' }
    if (typeof args.payload === 'string' && args.payload.trim()) {
      payload = { source: 'explicit', text: args.payload.trim().slice(0, MAX_MESSAGE_LEN) }
    } else if (args.payload && typeof args.payload === 'object') {
      const p = args.payload as { file?: unknown }
      if (typeof p.file === 'string' && p.file.trim()) {
        payload = { source: 'file', file: p.file.trim().slice(0, 2048) }
      }
    }
    const id = newMeshId()
    const chain: MeshChain = {
      id,
      from: agentId,
      to,
      when,
      watch: when === 'agent-finishes' ? String(args.watch ?? '') : undefined,
      payload,
      onFailure,
      timeoutMs,
      hops,
      status: 'armed',
      armedAt: Date.now(),
      baseline: this.cleanTail(agentId),
    }
    this.chains.set(id, chain)
    this.persistChains()
    this.setLinkChained(agentId, to, true)
    this.pushEvent({ at: Date.now(), kind: 'chain', from: agentId, to, detail: `armed #${id.slice(0, 8)} ${when}` })
    return { ok: true, chainId: id, status: 'armed' }
  }

  /** v4 B2: set the explicit payload before finishing (the reliable path the skill teaches). */
  chainPayload(agentId: string, chainId: string, text: string): MeshToolResult {
    const chain = this.chains.get(chainId)
    if (!chain) return { ok: false, error: 'no-such-chain', detail: `no chain with id ${chainId}` }
    if (chain.from !== agentId) return { ok: false, error: 'not-yours', detail: 'only the arming agent sets its payload' }
    if (chain.status !== 'armed') return { ok: false, error: 'chain-not-armed', detail: `chain is ${chain.status}` }
    const clean = String(text ?? '').replace(/[\r\n]+/g, ' ').trim()
    if (!clean) return { ok: false, error: 'empty-payload', detail: 'an empty payload never fires' }
    chain.payload = { source: 'explicit', text: clean.slice(0, MAX_MESSAGE_LEN) }
    this.persistChains()
    this.pushEvent({ at: Date.now(), kind: 'chain', from: agentId, to: chain.to, detail: `payload set #${chainId.slice(0, 8)}` })
    return { ok: true, chainId, payload: chain.payload }
  }

  /** v4 B1: list chains (the Mesh view renders them; probes assert on them). */
  chainsView(): MeshToolResult {
    return {
      ok: true,
      chains: [...this.chains.values()]
        .sort((a, b) => a.armedAt - b.armedAt)
        .map((c) => ({
          id: c.id,
          from: c.from,
          to: c.to,
          when: c.when,
          watch: c.watch ?? null,
          payloadSource: c.payload.source,
          onFailure: c.onFailure,
          status: c.status,
          armedAt: c.armedAt,
          firedAt: c.firedAt ?? null,
          failReason: c.failReason ?? null,
          hops: c.hops,
        })),
    }
  }

  /** v4 B1: cancel an armed chain; it never fires afterwards. */
  cancelChain(agentId: string, chainId: string): MeshToolResult {
    const chain = this.chains.get(chainId)
    if (!chain) return { ok: false, error: 'no-such-chain', detail: `no chain with id ${chainId}` }
    if (chain.status !== 'armed') return { ok: false, error: 'chain-not-armed', detail: `chain is ${chain.status}` }
    chain.status = 'cancelled'
    chain.failReason = 'cancelled-by-agent'
    this.persistChains()
    this.setLinkChained(chain.from, chain.to, false)
    this.pushEvent({ at: Date.now(), kind: 'chain', from: agentId, to: chain.to, detail: `cancelled #${chainId.slice(0, 8)}` })
    return { ok: true, chainId, status: 'cancelled' }
  }

  /**
   * v4 B3: the daemon detect loop calls this every poll with the watched agent's state.
   * Fires only on STABLE idle (~4 s of quiet content); awaiting-input NEVER counts as
   * finished; error/exited/timeout apply onFailure. Exactly-once via the armed→fired
   * atomic transition.
   */
  checkChains(ptyId: string, info: { state: AgentState; contentQuietMs: number }): void {
    const now = Date.now()
    for (const chain of this.chains.values()) {
      if (chain.status !== 'armed') continue
      if (now - chain.armedAt > chain.timeoutMs) {
        this.finishChain(chain, 'expired', 'timeout')
        continue
      }
      const watched = chain.when === 'agent-finishes' ? chain.watch : chain.from
      if (watched !== ptyId) continue
      if (info.state === 'awaiting-input') continue // blocked on permission ≠ done
      if (info.state === 'error' || info.state === 'exited') {
        void this.onChainFailure(chain, `peer-${info.state}`)
        continue
      }
      if (info.state === 'idle' && info.contentQuietMs >= CHAIN_IDLE_STABLE_MS) {
        void this.fireChain(chain)
      }
    }
  }

  private async fireChain(chain: MeshChain): Promise<void> {
    // Exactly-once: claim the fired transition synchronously before any await.
    if (chain.status !== 'armed') return
    chain.status = 'fired'
    chain.firedAt = Date.now()
    this.persistChains()
    this.setLinkChained(chain.from, chain.to, false)
    const payload = await this.resolveChainPayload(chain)
    if (!payload.ok) {
      chain.status = 'failed'
      chain.failReason = payload.reason
      this.persistChains()
      this.pushEvent({ at: Date.now(), kind: 'chain', from: chain.from, to: chain.to, detail: `failed ${payload.reason} #${chain.id.slice(0, 8)}` })
      return
    }
    // Firing is a WRITE — workspace consent applies (waits for the toast, never fails silently).
    const consent = await this.ensureConsent(chain.from)
    if (!consent.ok) {
      chain.status = 'failed'
      chain.failReason = consent.error === 'consent-denied' ? 'consent-denied' : 'consent-unavailable'
      this.persistChains()
      this.pushEvent({ at: Date.now(), kind: 'chain', from: chain.from, to: chain.to, detail: `failed ${chain.failReason} #${chain.id.slice(0, 8)}` })
      return
    }
    const line = `[plano \u2192 ${this.displayName(chain.to)} \u26d3] ${payload.text}`
    const delivered = (await this.deliverTyped(chain.to, line)) && (await this.submitLine(chain.to))
    if (!delivered) {
      chain.status = 'failed'
      chain.failReason = 'write-failed'
      this.persistChains()
      this.pushEvent({ at: Date.now(), kind: 'chain', from: chain.from, to: chain.to, detail: `failed write-failed #${chain.id.slice(0, 8)}` })
      return
    }
    // v4 A4: the fired chain pulses solid then rests (chained flag already cleared).
    this.touchLink(chain.from, chain.to, 'active')
    this.pushEvent({ at: Date.now(), kind: 'chain', from: chain.from, to: chain.to, detail: `fired #${chain.id.slice(0, 8)} (${chain.payload.source})` })
  }

  /** Resolve the exact bytes to deliver. Empty/whitespace payload NEVER fires. */
  private async resolveChainPayload(chain: MeshChain): Promise<{ ok: boolean; text?: string; reason?: string }> {
    if (chain.payload.source === 'explicit' && chain.payload.text) {
      return { ok: true, text: chain.payload.text }
    }
    if (chain.payload.source === 'file') {
      const file = chain.payload.file ?? ''
      if (!existsSync(file)) return { ok: false, reason: 'file-missing' }
      return { ok: true, text: file }
    }
    // Inferred: cleaned, REDACTED tail delta since arming — always marked as inferred.
    let tail = this.cleanTail(chain.from)
    if (this.onContextRequest) {
      try {
        const redacted = await this.onContextRequest(chain.from)
        if (typeof redacted === 'string' && redacted) tail = redacted
      } catch {
        /* fall back to the local clean tail */
      }
    }
    const delta = this.tailDelta(chain.baseline, tail).trim()
    if (!delta) return { ok: false, reason: 'empty-payload' }
    return { ok: true, text: `(inferred from terminal) ${delta.slice(0, MAX_MESSAGE_LEN)}` }
  }

  private async onChainFailure(chain: MeshChain, reason: string): Promise<void> {
    if (chain.status !== 'armed') return
    if (chain.onFailure === 'fire-anyway') {
      const note = `[fired anyway: ${reason}] `
      if (chain.payload.source === 'explicit' && chain.payload.text) chain.payload.text = note + chain.payload.text
      await this.fireChain(chain)
      return
    }
    if (chain.onFailure === 'ask-user' && this.onChainAskUser) {
      let ok = false
      try {
        ok = await this.onChainAskUser(chain.id, chain.from, chain.to)
      } catch {
        ok = false
      }
      if (ok) {
        await this.fireChain(chain)
        return
      }
      this.finishChain(chain, 'failed', 'declined-by-user')
      return
    }
    this.finishChain(chain, 'failed', reason)
  }

  private finishChain(chain: MeshChain, status: 'fired' | 'cancelled' | 'expired' | 'failed', reason?: string): void {
    if (chain.status !== 'armed') return
    chain.status = status
    if (reason) chain.failReason = reason
    this.persistChains()
    this.setLinkChained(chain.from, chain.to, false)
    this.pushEvent({ at: Date.now(), kind: 'chain', from: chain.from, to: chain.to, detail: `${status}${reason ? ` ${reason}` : ''} #${chain.id.slice(0, 8)}` })
  }

  /** Hand a task to another agent and go idle. */
  async handoff(agentId: string, to: string, task: string): Promise<MeshToolResult> {
    const sent = await this.send(agentId, to, task, 'type')
    const agent = this.agents.get(agentId)
    if (agent) {
      agent.busy = false
      this.pushEvent({ at: Date.now(), kind: 'consent', from: agentId, detail: 'handoff released' })
    }
    return sent
  }

  /** Create new agents (plan F6): N fresh terminals booting the requested harness. */
  async spawnAgent(agentId: string, req: { harness: string; cwd: string; prompt?: string; count: number }): Promise<MeshToolResult> {
    if (!this.onSpawn) return { ok: false, error: 'spawn-unavailable', detail: 'no spawn hook (daemon not wired)' }
    if (!req.harness) return { ok: false, error: 'missing-harness' }
    if (req.count > 6) return { ok: false, error: 'too-many', detail: 'cap is 6 agents per spawn' }
    const consent = await this.ensureConsent(agentId)
    if (!consent.ok) return consent
    if (!this.rateOk(agentId)) return { ok: false, error: 'rate-limited' }
    const result = this.onSpawn({ harness: req.harness, cwd: req.cwd, prompt: req.prompt, count: req.count, from: agentId })
    if (!result.ok) return { ok: false, error: result.error ?? 'spawn-failed' }
    this.pushEvent({ at: Date.now(), kind: 'spawn', from: agentId, detail: `${req.count}x ${req.harness} @ ${req.cwd || 'cwd'}` })
    return {
      ok: true,
      spawned: req.count,
      harness: req.harness,
      cwd: req.cwd,
      // v5 A1: the exact ptyIds created — the caller can prompt them or wait on them.
      ptyIds: Array.isArray(result.ptyIds) ? result.ptyIds.map(String) : [],
    }
  }

  // ── timeline / audit ──────────────────────────────────────────────────────────

  timelineView(): MeshToolResult {
    return {
      ok: true,
      events: this.timeline.slice(-50).map((e) => ({ at: e.at, kind: e.kind, from: e.from, to: e.to, detail: e.detail })),
    }
  }

  pushEvent(event: MeshEvent): void {
    this.timeline.push(event)
    if (this.timeline.length > MAX_TIMELINE) this.timeline.splice(0, this.timeline.length - MAX_TIMELINE)
    this.onEvent?.(event)
  }

  readonly maxHops = MAX_HOPS
  readonly maxBroadcastTargets = MAX_BROADCAST_TARGETS
}
