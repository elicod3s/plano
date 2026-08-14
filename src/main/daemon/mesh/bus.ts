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
import { OrchestrationStore, MAX_TASK_FAILURES, type WorkerOutcome } from './orchestration'
import { resolveAgent, meshUrl, newMeshId } from './identity'
import { normalizeTerminalText } from '../../services/terminalText'
import { inputPromptRowIndex } from '../agentLight'
import type {
  AgentReadiness,
  MeshAgent,
  MeshEvent,
  MeshMessage,
  MeshToolResult,
  AgentState,
  MeshLink,
  MeshChain,
  ChainWhen,
  ChainFailure,
  PtyWriteReceipt,
} from './types'

const MAX_TIMELINE = 200
const MAX_BROADCAST_TARGETS = 12
const MAX_HOPS = 4
/**
 * v6 A4: a single message's cap. Raised from 4000 now that delivery is bursted (12k is ~6 s of
 * typing, not ~4 minutes) — a handoff contract that lost its tail at 4000 lost exactly the part
 * that specified the work. Anything past this still truncates, but the sender is TOLD.
 */
const MAX_MESSAGE_LEN = 12000
/**
 * v3 A3: mailbox drains on a timer too, never only on idle transitions. This is a RETRY net, not
 * the delivery path — a message to a free agent is typed into its terminal immediately, and a
 * queued one drains the instant its target reports idle. The tick only catches a target that
 * missed both, so it can be short: the work is a loop over the roster.
 */
const DRAIN_POLL_MS = 750
/** v3 A3: a queued message that cannot be delivered within this TTL expires. */
const DEFAULT_TTL_MS = 10 * 60_000
/**
 * v6 A3: absolute lifetime of a queued message. Expiry now measures how long the target has been
 * UNREACHABLE rather than how long the message has existed, so this is a staleness backstop —
 * not the deadline that used to kill mail one tick before it could finally be delivered.
 */
const MAX_QUEUE_LIFE_MS = 60 * 60_000
/** v6 B1: `plano watch <messageId>` default budget and cap. */
const WATCH_DEFAULT_TIMEOUT_MS = 5 * 60_000
const WATCH_MAX_TIMEOUT_MS = 60 * 60_000
/** v7 B3: coordinator rolling wait — generous, because supervised work runs for tens of minutes. */
const CHECK_DEFAULT_TIMEOUT_MS = 15 * 60_000
const CHECK_MAX_TIMEOUT_MS = 60 * 60_000
/** One Delivery hands out at most this many messages. */
const CHECK_BATCH_MAX = 50
const BRACKETED_PASTE_BEGIN = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
/** ConPTY can accept a paste write before the TUI has rendered its paste-end marker. */
const POST_PASTE_SUBMIT_MS = process.platform === 'win32' ? 1500 : 500
/** Bounded recovery/verification timings; none can turn a mesh call into an open-ended wait. */
const EDIT_RECOVERY_ATTEMPTS = 3
const ACCEPTANCE_VERIFY_ATTEMPTS = 3
const ACCEPTANCE_VERIFY_MS = 320
/** v6 C3: how long a peer may sit on a permission prompt before its senders are told. */
const BLOCKED_NOTICE_MS = 10 * 60_000
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
/**
 * v3 C: inferred reply tail cap. Raised because the cap decides how much of a peer's ANSWER the
 * asker gets to read — a thorough reply was being cut mid-sentence at 2 KiB, which is exactly the
 * case where the answer matters. Reads are cheap; the wait delta keeps its own, larger cap.
 */
const ASK_REPLY_MAX_CHARS = 8000
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

interface PromptDeliveryReceipt extends PtyWriteReceipt {
  submitted: boolean
  reason?: AgentReadiness['state'] | 'input-editing' | 'input-still-parked' | 'write-failed'
  recoveredEditing?: boolean
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
  /** v7: Run / Task / Dispatch — the layer above the wire (see orchestration.ts). */
  readonly orch: OrchestrationStore
  /** Provider-level PTY write — returns accepted bytes, never a screen-derived inference. */
  onDeliver: ((ptyId: string, text: string) => PtyWriteReceipt) | null = null
  /** Guard sampled immediately before every mesh write; daemon-owned so the app may be closed. */
  onReadinessRequest: ((ptyId: string) => AgentReadiness) | null = null
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
  /**
   * Close a terminal. `panel` closes every terminal in the target's panel, not
   * just the one session. Returns the pty ids that were actually torn down.
   */
  onClose: ((req: { ptyId: string; panel: boolean }) => { ok: boolean; error?: string; closed?: string[] }) | null = null
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
  /**
   * v6 B1: callers blocked on `plano watch <messageId>`. Keyed by message id; resolved from every
   * point that gives a message a terminal status, so "did my handoff land?" is a question with an
   * answer instead of a guess built from echo tricks.
   */
  private watchers = new Map<string, Array<(result: MeshToolResult) => void>>()
  /** Recent terminal outcomes keep `watch` factual even when it starts after fast delivery. */
  private messageOutcomes = new Map<string, MeshMessage>()

  /** One asynchronous mailbox drain per receiver; paste + delayed Enter is a transaction. */
  private drainingMailboxes = new Set<string>()

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
    this.orch = new OrchestrationStore(userData)
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
      this.resolveWatchers(message.id, message)
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
        // v6 B3: how much mail is waiting on this agent, and how long the oldest has waited.
        // Saturation was invisible: an orchestrator could not see that a worker's inbox was
        // backing up until its own messages started dying.
        pending: this.mailboxes.load(a.id).filter((m) => !m.acked).length,
        oldestPendingMs: this.oldestPendingAge(a.id),
        // Parked in `plano check --wait` right now: a message to this peer is handed over in
        // milliseconds, guaranteed. Worth seeing — it is the difference between "it will get
        // there" and "it is already there", and it tells a coordinator which peers are actually
        // holding the contract rather than merely sitting at a prompt.
        listening: this.isListening(a.id),
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
    const target = this.findAgent(targetId)
    if (!target) return { ok: false, error: 'not-found', detail: `no agent with id ${targetId}` }
    // A prefix resolved to a real agent — every later lookup must use its FULL id.
    targetId = target.id
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
      // Where the agent lives. Both were already on the record and neither was ever reported, so
      // "which workspace is this one in" had no answer from the CLI.
      workspace: target.workspace,
      cwd: target.cwd,
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
    if (this.drainingMailboxes.has(agentId)) return
    this.drainingMailboxes.add(agentId)
    void this.drainMailboxNow(agentId).finally(() => this.drainingMailboxes.delete(agentId))
  }

  private async drainMailboxNow(agentId: string): Promise<void> {
    const now = Date.now()
    // Hands off: the agent is inside `plano check --wait` and will consume its own mailbox. Typing
    // now would push the line into the CLI process the agent is blocked on instead of into the
    // agent, and the message would be gone with nothing to replay.
    if (this.isListening(agentId)) return
    const target = this.agents.get(agentId)
    // v6 C3: a peer parked on a permission prompt is not going to read anything until a human
    // answers it. Tell the senders once, instead of letting them wait on a wall.
    if (target?.state === 'awaiting-input' && now - target.stateSince > BLOCKED_NOTICE_MS) {
      for (const message of this.mailboxes.load(agentId)) {
        if (message.acked || message.notified) continue
        this.notifySender(
          message,
          'is still WAITING to be delivered',
          `${this.displayName(agentId)} is blocked on a permission prompt — a human has to answer it, or \`plano interrupt\` them.`,
          'blocked',
        )
      }
    }
    const messages = this.mailboxes.load(agentId)
    // Readiness is an explicit step, not an inference from `busy`. Permission wins and causes no
    // PTY bytes at all; every sender is told immediately that only a human can unblock delivery.
    const readiness = this.agentReadiness(agentId)
    if (readiness.state === 'permission-prompt') {
      for (const message of messages) {
        if (message.acked) continue
        this.notifySender(
          message,
          'is WAITING to be delivered',
          `${this.displayName(agentId)} is on a permission prompt — a human must clear it before PLANO will write anything.`,
          'blocked',
        )
      }
      return
    }
    // Busy/not-yet-rendered/no-agent are retryable readiness states. The timer or next state
    // transition calls us again; they never consume a delivery attempt because no write occurred.
    if (readiness.state !== 'sendable') return
    // The daemon's explicit TUI probe can prove the composer reopened before the coarse process
    // poll updates the roster. Record that boundary now so waits and the next queued turn share
    // the same truth as guarded delivery.
    // Only when the composer proves the TURN ended — not merely that it can accept input. Since a
    // live composer now makes a mid-turn agent sendable, flipping to idle here would have reported
    // every working agent as finished the moment it could receive mail.
    if (target?.state === 'working' && !readiness.midTurn) this.setState(agentId, 'idle')
    for (const message of messages) {
      if (message.acked) continue
      // v6 A3: expiry measures REACHABLE time, not wall-clock. The old rule (10 min since the
      // message was written) killed queued mail at the worst possible instant: this loop only
      // runs when the target is free, and the check ran BEFORE the delivery attempt — so a
      // message that patiently waited out an 11-minute turn was expired one tick before it
      // would finally have landed. That is the exact way an orchestrator's verdicts vanished
      // while both sides sat waiting for each other.
      //
      // Now only an absolutely stale message is reaped: an hour old, which means the target has
      // been unreachable for an hour, not merely busy for a while.
      const born = message.bornAt ?? message.at
      if (now - born > MAX_QUEUE_LIFE_MS) {
        message.status = 'expired'
        message.acked = true
        this.mailboxes.remove(agentId, message.id)
        this.pushEvent({ at: now, kind: 'msg-expired', from: message.from, to: message.to, detail: 'ttl-expired' })
        this.notifySender(
          message,
          'EXPIRED undelivered',
          'it sat in their mailbox for an hour without them ever becoming free — re-send it, or `plano interrupt` them.',
        )
        this.resolveWatchers(message.id, message)
        continue
      }
      // Baseline BEFORE the write: the anchor below marks where this turn starts, and a tail read
      // taken after the echo landed would already contain the message itself.
      const preBaseline = this.cleanTail(message.to)
      const delivered = await this.deliverPrompt(message.to, this.messageLine(message), readiness)
      message.accepted = delivered.accepted
      message.bytesWritten = delivered.bytesWritten
      if (delivered.accepted && delivered.submitted) {
        // Accepted paste + accepted Enter is a factual turn start. A sub-poll response can finish
        // before activity detection ever samples it; without this transition, send --wait waits
        // for a future turn even though the answer is already on screen.
        this.setState(agentId, 'working')
        message.status = 'delivered'
        message.acked = true
        this.mailboxes.remove(agentId, message.id)
        this.pushEvent({
          at: Date.now(),
          kind: 'msg-delivered',
          from: message.from,
          to: message.to,
          detail: `accepted bytes=${delivered.bytesWritten} #${message.id}`,
        })
        // v6 B2: the queued line just started a turn in the target — anchor it, so a `wait` that
        // the sender fires now reports THAT turn instead of the peer's next unrelated one.
        this.spawnPrompts.set(message.to, { at: Date.now(), baseline: preBaseline })
        this.resolveWatchers(message.id, message)
        // v3 A4: the write succeeded — whether the receiver produced output beyond the
        // typed echo is observed in the background (the sender of a queued message isn't
        // blocked waiting; the timeline carries the final word).
        void this.confirmAsync(message)
        return // one at a time; re-drain on next idle transition or timer tick
      }
      // A paste was accepted but its separate Enter could not be proven. Never paste it again —
      // that would duplicate the handoff. End with an explicit partial failure instead.
      if (delivered.bytesWritten > 0) {
        message.status = 'undeliverable'
        message.reason = delivered.reason ?? 'partial-submit-failed'
        message.acked = true
        this.mailboxes.remove(agentId, message.id)
        this.pushEvent({
          at: Date.now(),
          kind: 'msg-undeliverable',
          from: message.from,
          to: message.to,
          detail: `${message.reason} #${message.id}`,
        })
        this.notifySender(
          message,
          'could NOT be submitted',
          `the PTY accepted ${delivered.bytesWritten} bytes but the prompt did not leave the input box; PLANO did not paste it twice.`,
        )
        this.resolveWatchers(message.id, message)
        return
      }
      if (
        delivered.reason === 'busy' ||
        delivered.reason === 'permission-prompt' ||
        delivered.reason === 'not-an-agent' ||
        delivered.reason === 'unknown'
      ) {
        return
      }
      // v3 A3: retry with backoff (next tick), cap → undeliverable with a reason.
      message.attempts = (message.attempts ?? 0) + 1
      if (message.attempts >= MAX_DELIVERY_ATTEMPTS) {
        message.status = 'undeliverable'
        message.reason = 'write-failed-after-retries'
        message.acked = true
        this.mailboxes.remove(agentId, message.id)
        this.pushEvent({ at: Date.now(), kind: 'msg-undeliverable', from: message.from, to: message.to, detail: message.reason })
        this.notifySender(message, 'could NOT be delivered', `writing to their terminal failed ${MAX_DELIVERY_ATTEMPTS} times — check they are still alive with \`plano roster\`.`)
        this.resolveWatchers(message.id, message)
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

  /** Age of the longest-waiting undelivered message in an agent's box (0 when the box is clear). */
  private oldestPendingAge(agentId: string): number {
    const pending = this.mailboxes.load(agentId).filter((m) => !m.acked)
    if (pending.length === 0) return 0
    const oldest = Math.min(...pending.map((m) => m.bornAt ?? m.at))
    return Math.max(0, Date.now() - oldest)
  }

  /**
   * v7 B3: wake every coordinator blocked on `plano check --wait`.
   *
   * The alternative is what agents do today: sleep, poll `roster`, guess. A rolling long-poll that
   * only wakes on the message types you asked for replaces the whole polling loop with one call.
   */
  /**
   * Each waiter carries the filter it is waiting on, because waking is only useful when there is
   * something that waiter would actually accept. A wake with nothing to hand over returns
   * `count: 0`, which the agent correctly reads as a checkpoint — and in the gap between that
   * return and its next call there is no waiter for a message to land in. A spurious wake is
   * therefore not merely wasteful, it is a hole in the delivery guarantee.
   */
  private checkWaiters = new Map<string, Array<{ wake: () => void; matches: () => boolean }>>()

  /**
   * Is this agent parked inside `plano check --wait` right now?
   *
   * This is the one state in which delivery is guaranteed rather than attempted, so it outranks
   * every other route. It is also why the typed path must stand down: an agent inside a long-poll
   * is running a command, and typing at a running command feeds the child process, not the agent.
   */
  private isListening(agentId: string): boolean {
    return (this.checkWaiters.get(agentId)?.length ?? 0) > 0
  }

  private resolveCheckWaiters(agentId: string): void {
    const waiting = this.checkWaiters.get(agentId)
    if (!waiting || waiting.length === 0) return
    const ready = waiting.filter((w) => w.matches())
    if (ready.length === 0) return
    const rest = waiting.filter((w) => !ready.includes(w))
    if (rest.length > 0) this.checkWaiters.set(agentId, rest)
    else this.checkWaiters.delete(agentId)
    for (const w of ready) w.wake()
  }

  /**
   * The coordinator's inbox, as a batch that REPLAYS until acknowledged.
   *
   * Delivery is at-least-once on purpose: a coordinator that dies mid-batch has lost nothing,
   * because the same batch comes back until it says `--ack <deliveryId>`. Today a message typed
   * into a terminal that then crashed was simply gone.
   *
   * A timeout is a CHECKPOINT, not a verdict — long tasks run for tens of minutes, and reading a
   * timeout as death is exactly how a session declares a healthy worker dead.
   */
  async check(
    agentId: string,
    opts: { types?: string[]; wait?: boolean; timeoutMs?: number; ack?: string } = {},
  ): Promise<MeshToolResult> {
    if (!this.agents.has(agentId)) return { ok: false, error: 'not-registered' }
    if (opts.ack) {
      // Acknowledging retires exactly the batch that was handed out.
      for (const message of this.mailboxes.load(agentId)) {
        if (message.deliveryId === opts.ack) this.mailboxes.remove(agentId, message.id)
      }
    }
    const wanted = (opts.types ?? []).filter(Boolean)
    const matches = (): MeshMessage[] => {
      const box = this.mailboxes.load(agentId).filter((m) => !m.acked)
      return wanted.length > 0 ? box.filter((m) => wanted.includes(m.kind ?? 'message')) : box
    }
    let batch = matches()
    if (batch.length === 0 && opts.wait) {
      const ms = Math.max(1000, Math.min(opts.timeoutMs ?? CHECK_DEFAULT_TIMEOUT_MS, CHECK_MAX_TIMEOUT_MS))
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          const list = (this.checkWaiters.get(agentId) ?? []).filter((w) => w !== waiter)
          if (list.length > 0) this.checkWaiters.set(agentId, list)
          else this.checkWaiters.delete(agentId)
          resolve()
        }, ms)
        const waiter = {
          wake: (): void => {
            clearTimeout(timer)
            resolve()
          },
          matches: (): boolean => matches().length > 0,
        }
        const list = this.checkWaiters.get(agentId) ?? []
        list.push(waiter)
        this.checkWaiters.set(agentId, list)
      })
      batch = matches()
    }
    if (batch.length === 0) {
      // Say what to do next, in the reply itself. An agent that reads "timeout" with no next step
      // concludes the mesh is dead and stops listening — which is precisely how a worker told to
      // "wait for messages" went quiet forever.
      const again = `plano check --wait --timeout-ms ${Math.min(opts.timeoutMs ?? 90_000, 90_000)} --json`
      return {
        ok: true,
        count: 0,
        checkpoint: true,
        detail: `nothing arrived in that window — a checkpoint, NOT a failure and NOT silence. Still waiting? run it again: ${again}`,
      }
    }
    const deliveryId = `dlv_${Math.random().toString(36).slice(2, 10)}`
    const capped = batch.slice(0, CHECK_BATCH_MAX)
    for (const m of capped) m.deliveryId = deliveryId
    return {
      ok: true,
      deliveryId,
      count: capped.length,
      messages: capped.map((m) => ({ id: m.id, from: m.from, kind: m.kind ?? 'message', at: m.at, text: m.text })),
      detail: `ack with: plano check --ack ${deliveryId}`,
    }
  }

  /**
   * Park a message in an agent's mailbox WITHOUT the harness check — for the spawn prompt.
   *
   * A newborn can spend minutes booting (MCP servers, model handshakes) and its harness stays
   * `unknown` until detection catches up. `send` rightly refuses an unknown target, so the spawn
   * prompt was refused and dropped with nothing but a log line: the user asked for an agent that
   * greets them and got one that sat there, its transcript showing only boot noise. The task must
   * outlive the boot — the ordinary drain delivers it the moment the composer opens.
   */
  queueForAgent(from: string, to: string, text: string): MeshToolResult {
    const target = this.agents.get(to)
    if (!target) return { ok: false, error: 'not-found' }
    const id = newMeshId()
    this.mailboxes.push(to, {
      id,
      at: Date.now(),
      bornAt: Date.now(),
      from,
      to,
      text,
      mode: 'queue',
      ttl: DEFAULT_TTL_MS,
      hops: 0,
      status: 'queued',
      acked: false,
    })
    target.currentTask = shortTask(text)
    this.pushEvent({ at: Date.now(), kind: 'msg-queued', from, to, detail: 'spawn prompt parked until the newborn can receive it' })
    this.resolveCheckWaiters(to)
    this.drainMailbox(to)
    return { ok: true, status: 'queued', id }
  }

  /** v6 B1: hand every waiter on this message its final answer. */
  private resolveWatchers(messageId: string, message: MeshMessage): void {
    this.messageOutcomes.delete(messageId)
    this.messageOutcomes.set(messageId, { ...message })
    while (this.messageOutcomes.size > 500) {
      const oldest = this.messageOutcomes.keys().next().value as string | undefined
      if (!oldest) break
      this.messageOutcomes.delete(oldest)
    }
    const waiting = this.watchers.get(messageId)
    if (!waiting || waiting.length === 0) return
    this.watchers.delete(messageId)
    const result: MeshToolResult = {
      ok: true,
      id: messageId,
      status: message.status,
      confirmed: message.confirmed ?? false,
      accepted: message.accepted ?? false,
      bytesWritten: message.bytesWritten ?? 0,
      reason: message.reason ?? null,
      to: message.to,
      at: Date.now(),
    }
    for (const resolve of waiting) resolve(result)
  }

  /**
   * v6 B1: block until a specific message reaches a terminal status.
   *
   * `wait` answers "is the peer done with its turn"; that is not the same question as "did my
   * message arrive", and conflating them is why agents resorted to echoing sentinels into their
   * own transcripts to fake an acknowledgement. A message that already finished answers instantly.
   */
  async watchMessage(agentId: string, messageId: string, timeoutMs = WATCH_DEFAULT_TIMEOUT_MS): Promise<MeshToolResult> {
    if (!this.agents.has(agentId)) return { ok: false, error: 'not-registered' }
    if (!messageId) return { ok: false, error: 'missing-id' }
    const recorded = this.messageOutcomes.get(messageId)
    if (recorded) {
      return {
        ok: true,
        id: messageId,
        status: recorded.status,
        confirmed: recorded.confirmed ?? false,
        accepted: recorded.accepted ?? false,
        bytesWritten: recorded.bytesWritten ?? 0,
        reason: recorded.reason ?? null,
        to: recorded.to,
        already: true,
      }
    }
    // Compatibility for outcomes written by an older daemon before the receipt registry existed.
    const done = [...this.timeline]
      .reverse()
      .find((e) => e.detail?.includes(`#${messageId}`) && (e.kind === 'msg-delivered' || e.kind === 'msg-undeliverable' || e.kind === 'msg-expired'))
    if (done) {
      return {
        ok: true,
        id: messageId,
        status: done.kind === 'msg-delivered' ? 'delivered' : done.kind === 'msg-expired' ? 'expired' : 'undeliverable',
        confirmed: done.detail?.includes('confirmed') ?? false,
        already: true,
      }
    }
    const ms = Math.max(1000, Math.min(timeoutMs || WATCH_DEFAULT_TIMEOUT_MS, WATCH_MAX_TIMEOUT_MS))
    return new Promise<MeshToolResult>((resolve) => {
      const timer = setTimeout(() => {
        const list = this.watchers.get(messageId) ?? []
        const next = list.filter((fn) => fn !== onDone)
        if (next.length > 0) this.watchers.set(messageId, next)
        else this.watchers.delete(messageId)
        // A timeout still ANSWERS (v5 A3): the message is simply still queued.
        resolve({ ok: true, id: messageId, status: 'queued', timedOut: true, detail: 'still queued — the target has not been free yet' })
      }, ms)
      const onDone = (result: MeshToolResult): void => {
        clearTimeout(timer)
        resolve(result)
      }
      const list = this.watchers.get(messageId) ?? []
      list.push(onDone)
      this.watchers.set(messageId, list)
    })
  }

  /**
   * v6 A2: tell the SENDER how their message ended. The timeline recorded every outcome and no
   * participant was ever told, so a queued message that expired left both sides waiting on each
   * other — the orchestrator believed it had delegated, the worker never heard anything. A
   * timeline entry is only found by someone who already suspects a loss; a mailbox notice arrives.
   *
   * Notices are system mail: the existing drain types them into the sender's terminal as soon as
   * it is idle, and `plano inbox` lists them until then. Never notify about a notice (they carry
   * no `from` agent), and never notify twice for one message.
   */
  private notifySender(message: MeshMessage, outcome: string, hint: string, kind: 'outcome' | 'blocked' = 'outcome'): void {
    const sender = message.from
    if (!sender || sender === 'plano') return
    // Two independent one-shots: a "still blocked" heads-up must not consume the slot reserved
    // for the message's real ending, or a message that warns and then expires would report only
    // the warning.
    if (kind === 'outcome' ? message.notified : message.blockedNotified) return
    if (!this.agents.has(sender)) return // the sender is gone too; the timeline keeps the record
    if (kind === 'outcome') message.notified = true
    else message.blockedNotified = true
    const peer = this.displayName(message.to)
    const excerpt = message.text.length > 90 ? `${message.text.slice(0, 90)}…` : message.text
    this.mailboxes.push(sender, {
      id: `sysx-${message.id}`,
      at: Date.now(),
      from: 'plano',
      to: sender,
      text: `your message to ${peer} ${outcome}. ${hint} (message: "${excerpt}")`,
      mode: 'queue',
      ttl: DEFAULT_TTL_MS,
      hops: 0,
      status: 'queued',
      acked: false,
    })
    this.drainMailbox(sender)
  }

  /** Background confirmation for queued deliveries (never throws — v3 §3). */
  private async confirmAsync(message: MeshMessage): Promise<void> {
    try {
      if (!this.onTailRequest || !message.to) return
      const baseline = this.cleanTail(message.to)
      const confirmed = await this.observeTailChange(message.to, baseline, message.text.length)
      message.confirmed = confirmed
      this.resolveWatchers(message.id, message)
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

  private agentReadiness(ptyId: string): AgentReadiness {
    try {
      return (
        this.onReadinessRequest?.(ptyId) ?? {
          state: 'unknown',
          inputMode: 'clean',
          pasteMode: 'plain',
          detail: 'readiness probe unavailable',
        }
      )
    } catch {
      return { state: 'unknown', inputMode: 'clean', pasteMode: 'plain', detail: 'readiness probe failed' }
    }
  }

  private writePty(ptyId: string, text: string): PtyWriteReceipt {
    if (!this.onDeliver) return { accepted: false, bytesWritten: 0 }
    try {
      return this.onDeliver(ptyId, text)
    } catch {
      return { accepted: false, bytesWritten: 0 }
    }
  }

  /** A prompt must not be able to smuggle its own paste-end or another terminal control sequence. */
  private sanitizePasteText(text: string): string {
    return text.replace(/\x1b/g, '<ESC>')
  }

  /** Escape a known edit-previous-message state, checking the guard again after every byte. */
  private async recoverEditingState(
    ptyId: string,
    initial: AgentReadiness,
  ): Promise<{ readiness: AgentReadiness; recovered: boolean }> {
    let readiness = initial
    let recovered = false
    for (let attempt = 0; attempt < EDIT_RECOVERY_ATTEMPTS && readiness.inputMode === 'editing'; attempt += 1) {
      if (readiness.state !== 'sendable') return { readiness, recovered }
      const escaped = this.writePty(ptyId, '\x1b')
      if (!escaped.accepted) {
        return {
          readiness: { ...readiness, state: 'unknown', detail: 'could not leave the input editing state' },
          recovered,
        }
      }
      recovered = true
      await sleep(180)
      readiness = this.agentReadiness(ptyId)
    }
    return { readiness, recovered }
  }

  /**
   * Guarded prompt transaction: explicit readiness → atomic paste → delayed, separately guarded
   * Enter → rendered-input safety check. `accepted/bytesWritten` come only from the PTY provider;
   * screen inspection can downgrade a stuck submit but can never manufacture acceptance.
   */
  private async deliverPrompt(
    ptyId: string,
    text: string,
    sampled?: AgentReadiness,
  ): Promise<PromptDeliveryReceipt> {
    let readiness = sampled ?? this.agentReadiness(ptyId)
    if (readiness.state !== 'sendable') {
      return { accepted: false, bytesWritten: 0, submitted: false, reason: readiness.state }
    }

    let recoveredEditing = false
    if (readiness.inputMode === 'editing') {
      const recovered = await this.recoverEditingState(ptyId, readiness)
      readiness = recovered.readiness
      recoveredEditing = recovered.recovered
      if (readiness.state !== 'sendable' || readiness.inputMode === 'editing') {
        return {
          accepted: false,
          bytesWritten: 0,
          submitted: false,
          reason: readiness.inputMode === 'editing' ? 'input-editing' : readiness.state,
          recoveredEditing,
        }
      }
    }

    // Re-sample immediately before the write. This closes the race where a permission prompt
    // appears after the earlier idle observation but before node-pty receives the first byte.
    readiness = this.agentReadiness(ptyId)
    if (readiness.state !== 'sendable') {
      return { accepted: false, bytesWritten: 0, submitted: false, reason: readiness.state, recoveredEditing }
    }
    const clean = this.sanitizePasteText(text)
    const payload =
      readiness.pasteMode === 'bracketed'
        ? `${BRACKETED_PASTE_BEGIN}${clean}${BRACKETED_PASTE_END}`
        : clean
    const paste = this.writePty(ptyId, payload)
    if (!paste.accepted) {
      return { accepted: false, bytesWritten: 0, submitted: false, reason: 'write-failed', recoveredEditing }
    }

    // Why: paste-end and Enter in one PTY write is the concrete failure. ConPTY in particular can
    // acknowledge the payload while the TUI is still repainting its composer.
    await sleep(POST_PASTE_SUBMIT_MS)
    let bytesWritten = paste.bytesWritten
    for (let attempt = 0; attempt < ACCEPTANCE_VERIFY_ATTEMPTS; attempt += 1) {
      const submitGuard = this.agentReadiness(ptyId)
      // The paste echo can make heuristic activity look busy; only permission/no-agent/unknown
      // invalidates phase two. The agent was proven idle immediately before phase one.
      if (
        submitGuard.state === 'permission-prompt' ||
        submitGuard.state === 'not-an-agent' ||
        submitGuard.state === 'unknown'
      ) {
        await this.clearParkedInput(ptyId, text)
        return {
          accepted: true,
          bytesWritten,
          submitted: false,
          reason: submitGuard.state,
          recoveredEditing,
        }
      }
      if (submitGuard.inputMode === 'editing') {
        const recovered = await this.recoverEditingState(ptyId, { ...submitGuard, state: 'sendable' })
        recoveredEditing = recoveredEditing || recovered.recovered
      }
      const submit = this.writePty(ptyId, '\r')
      if (!submit.accepted) {
        await this.clearParkedInput(ptyId, text)
        return { accepted: true, bytesWritten, submitted: false, reason: 'write-failed', recoveredEditing }
      }
      bytesWritten += submit.bytesWritten
      await sleep(ACCEPTANCE_VERIFY_MS)
      if (!this.stillInInputBox(ptyId, text)) {
        return { accepted: true, bytesWritten, submitted: true, recoveredEditing }
      }
      if (attempt + 1 < ACCEPTANCE_VERIFY_ATTEMPTS) await sleep(180)
    }

    await this.clearParkedInput(ptyId, text)
    return { accepted: true, bytesWritten, submitted: false, reason: 'input-still-parked', recoveredEditing }
  }

  /**
   * Never strand a failed handoff in the composer. Escape exits modal/edit state; Ctrl+U clears
   * the editable line in the supported TUIs without sending Ctrl+C (which could kill a harness).
   */
  private async clearParkedInput(ptyId: string, text: string): Promise<void> {
    const guard = this.agentReadiness(ptyId)
    if (guard.state === 'permission-prompt' || guard.state === 'not-an-agent' || guard.state === 'unknown') return
    this.writePty(ptyId, '\x1b')
    await sleep(120)
    this.writePty(ptyId, '\x15')
    await sleep(180)
    // A second Escape is bounded and harmless at an empty prompt; it closes editors that require
    // the observed "esc again" sequence before Ctrl+U reaches the composer.
    if (this.stillInInputBox(ptyId, text)) this.writePty(ptyId, '\x1b')
  }

  /** Public guarded delivery retained for callers outside the message bus. */
  async deliverText(ptyId: string, text: string): Promise<boolean> {
    let normalized = String(text).replace(/[\r\n]+/g, ' ').trim()
    if (!normalized) return false
    if (normalized.length > MAX_MESSAGE_LEN) normalized = `${normalized.slice(0, MAX_MESSAGE_LEN - 3)}…`
    const deadline = Date.now() + 25_000
    let readiness = this.agentReadiness(ptyId)
    // Explicit TUI-ready wait: useful for a booting harness, bounded so a missing signal answers.
    while (readiness.state !== 'sendable' && Date.now() < deadline) {
      if (readiness.state === 'permission-prompt') return false
      await sleep(150)
      readiness = this.agentReadiness(ptyId)
    }
    if (readiness.state !== 'sendable') return false
    this.spawnPrompts.set(ptyId, { at: Date.now(), baseline: this.cleanTail(ptyId) })
    const delivered = await this.deliverPrompt(ptyId, normalized, readiness)
    return delivered.accepted && delivered.submitted
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
    /** v6 A1: refuse a mid-turn target instead of queuing (the pre-v6 contract). */
    direct = false,
  ): Promise<MeshToolResult> {
    const resolved = this.resolveTarget(agentId, to)
    if (!resolved.ok) return resolved.result
    const target = resolved.agent
    to = target.id
    // v8 — mail is DURABLE first and typed second.
    //
    // `send` used to refuse outright when the target's harness was still `unknown` ("target is a
    // plain terminal"). A booting agent IS that for its first minutes, so a message to a newborn
    // was rejected rather than kept. A send is never refused: the message is recorded and the
    // peer's own `check` consumes it — typing into the TUI is a WAKE-UP for an idle agent, not the
    // delivery channel. A message therefore cannot be lost by a screen that was not ready.
    // v6 A1: a busy target QUEUES instead of refusing. Refusing made "mid-turn" the caller's
    // problem: every agent had to recognise the error, remember `--queue`, and retry — and the
    // ones that didn't simply stopped talking. The message is never lost either way, so the
    // useful answer is "it will land when they are free", not "no". `direct` keeps the old
    // refusal for the rare caller that genuinely wants type-or-nothing.
    const readiness = this.agentReadiness(to)
    const permissionQueued = readiness.state === 'permission-prompt'
    const retryableNotReady =
      readiness.state === 'busy' || readiness.state === 'unknown' || readiness.state === 'not-an-agent'
    const autoQueued = mode === 'type' && (permissionQueued || (retryableNotReady && !direct))
    if (autoQueued) mode = 'queue'
    if (mode === 'type' && readiness.state === 'busy') {
      return { ok: false, error: 'working', detail: 'target is mid-turn — use queue mode or ask the user to interrupt' }
    }
    if (mode === 'type' && readiness.state !== 'sendable') {
      return { ok: false, error: 'not-ready', readiness: readiness.state, detail: readiness.detail }
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
      bornAt: Date.now(), // v6 A3: never slides — the staleness backstop measures from here
      hops,
      status: 'queued',
      acked: false,
    }
    // Plan v3 A1: ONE logical line, ONE real submit. A bare '\n' moves the cursor down without
    // executing — terminals submit with '\r'. The banner lives ON the same logical line (an
    // intermediate newline splits the receiver's prompt and some CLIs send it half-formed).
    // Internal newlines are normalized to spaces; oversized lines truncate with a visible mark.
    let normalized = String(text).replace(/[\r\n]+/g, ' ').trim()
    // v6 A4: truncation is a fact the sender needs, not a silent edit.
    const truncated = normalized.length > MAX_MESSAGE_LEN
    if (truncated) normalized = `${normalized.slice(0, MAX_MESSAGE_LEN - 3)}\u2026`
    const line = `[plano \u2190 ${this.displayName(agentId)}] ${normalized}`

    // The peer is BLOCKED INSIDE `plano check --wait`. That is the reliable channel and it beats
    // every TUI heuristic: the message comes back as the output of the command the peer is already
    // running, so there is no composer to detect, no paste to confirm, no Enter to prove. Note it
    // also reads as "busy" to every screen-based measure — a command IS running — which is exactly
    // why this decision has to come first, before readiness is consulted at all.
    if (this.isListening(to)) {
      this.mailboxes.push(to, message)
      message.status = 'delivered'
      target.currentTask = shortTask(text)
      this.touchLink(agentId, to, 'active')
      this.pushEvent({ at: Date.now(), kind: 'msg-delivered', from: agentId, to, detail: `check-wait #${id}` })
      this.resolveCheckWaiters(to)
      this.resolveWatchers(id, message)
      return {
        ok: true,
        status: 'delivered',
        channel: 'check',
        id,
        truncated,
        detail: `${this.displayName(to)} is listening on \`plano check --wait\` — it woke with your message.`,
      }
    }
    if (mode === 'queue' && readiness.state !== 'sendable') {
      this.mailboxes.push(to, message)
      // Wake a peer that is blocked in `check --wait` but had not registered when we looked (it
      // starts waiting between our two statements). Without this the mailbox filled while the peer
      // sat inside a long-poll that nothing ever resolved — the exact "it just stays there" the
      // whole mesh was accused of.
      this.resolveCheckWaiters(to)
      target.currentTask = shortTask(text) // v3 B: the target has work coming
      this.touchLink(agentId, to, 'active')
      this.pushEvent({ at: Date.now(), kind: 'msg-queued', from: agentId, to, detail: readiness.state })
      if (permissionQueued) {
        this.notifySender(
          message,
          'is WAITING to be delivered',
          `${this.displayName(to)} is on a permission prompt — a human must clear it before PLANO writes anything.`,
          'blocked',
        )
      }
      return {
        ok: true,
        status: 'queued',
        id,
        autoQueued,
        truncated,
        accepted: false,
        bytesWritten: 0,
        readiness: readiness.state,
        humanActionRequired: permissionQueued,
        detail: permissionQueued
          ? `${this.displayName(to)} is on a permission prompt — a human must clear it. Your message is saved and lands the moment they do.`
          : `saved to ${this.displayName(to)}'s mailbox (they are ${readiness.state}). They get it on their next \`plano check\`, or it is typed in when their composer opens. Nothing to retry.`,
      }
    }
    const baseline = this.cleanTail(to) // v3 A4: before the echo lands
    // Anchor the turn this message is about to start, exactly as a spawn prompt does. Without it,
    // `send` followed by `wait` on a peer that answers immediately took the "already idle" path
    // and reported an EMPTY delta — the answer was sitting in `tail` and the caller had no reason
    // to look there. Bursted delivery made that the common case rather than the rare one, because
    // the exchange now finishes faster than the caller can ask about it.
    this.spawnPrompts.set(to, { at: Date.now(), baseline })
    const delivered = await this.deliverPrompt(to, line, readiness)
    message.accepted = delivered.accepted
    message.bytesWritten = delivered.bytesWritten
    if (!delivered.accepted || !delivered.submitted) {
      // A readiness race before the first byte is safe to queue. A partial paste is not: pasting
      // it twice would duplicate work, so answer with the exact partial-submit failure instead.
      if (delivered.bytesWritten > 0) {
        message.status = 'undeliverable'
        message.reason = delivered.reason ?? 'partial-submit-failed'
        this.pushEvent({
          at: Date.now(),
          kind: 'msg-undeliverable',
          from: agentId,
          to,
          detail: `${message.reason} #${id}`,
        })
        this.resolveWatchers(id, message)
        return {
          ok: false,
          error: 'partial-submit-failed',
          status: message.status,
          reason: message.reason,
          id,
          accepted: true,
          bytesWritten: delivered.bytesWritten,
          truncated,
        }
      }
      message.attempts = 1
      this.mailboxes.push(to, message)
      target.currentTask = shortTask(text)
      this.pushEvent({ at: Date.now(), kind: 'msg-queued', from: agentId, to, detail: `${delivered.reason ?? 'write failed'}, queued` })
      return {
        ok: true,
        status: 'queued',
        id,
        accepted: false,
        bytesWritten: 0,
        readiness: delivered.reason,
      }
    }
    // Provider acceptance plus the separate submitted Enter is the turn-start edge. Recording it
    // closes the fast-agent race where an entire answer lands between two process-tree polls.
    this.setState(to, 'working')
    target.currentTask = shortTask(text) // v3 B: the target's task is this message
    // v3 E: the relation is live (grouped counter, pulse direction emitter → receiver).
    this.touchLink(agentId, to, 'active')
    // v3 A4: distinguish written (bytes in the PTY) from accepted (receiver output beyond
    // the typed echo). The sender gets the honest status either way.
    const confirmed = await this.observeTailChange(to, baseline, normalized.length)
    // If the TUI has already reopened its bracketed-paste composer, record the matching turn-end
    // edge before returning. Otherwise the regular detector/harness hook owns completion.
    if (this.agentReadiness(to).state === 'sendable') this.setState(to, 'idle')
    message.confirmed = confirmed
    message.status = confirmed ? 'delivered' : 'written-but-unconfirmed'
    this.pushEvent({ at: Date.now(), kind: 'msg-delivered', from: agentId, to, detail: `${confirmed ? 'confirmed' : 'written-but-unconfirmed'} #${id}` })
    this.resolveWatchers(id, message)
    // v6 A4: truncation is REPORTED. A 4000-char cut used to happen silently, losing exactly the
    // tail of a long contract where the specifics live; the sender can now split and re-send.
    return {
      ok: true,
      status: message.status,
      confirmed,
      id,
      truncated,
      accepted: true,
      bytesWritten: delivered.bytesWritten,
      recoveredEditing: delivered.recoveredEditing ?? false,
    }
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

  /**
   * Resolve any user-supplied agent id: exact, else a unique prefix.
   *
   * `send`/`ask` accepted the short ids the roster prints while `wait`, `status`, `context`,
   * `close` and `interrupt` did a raw map lookup and answered `not-found` for the very id they
   * had just been shown. An agent copying an id out of the roster got "works / not-found /
   * works" depending on the verb, concluded the peer had vanished, and gave up. One resolver,
   * one answer, every command.
   *
   * Unlike resolveTarget this does NOT exclude the caller: reading or closing yourself is legal,
   * only messaging yourself is not.
   */
  private findAgent(raw: string): MeshAgent | null {
    if (!raw) return null
    const exact = this.agents.get(raw)
    if (exact) return exact
    if (raw.length < 4) return null
    const matches = [...this.agents.values()].filter((a) => a.id.startsWith(raw))
    return matches.length === 1 ? matches[0] : null
  }

  /**
   * Is our line still sitting in the peer's INPUT BOX rather than sent?
   *
   * After a real submit these TUIs re-render the message as a transcript entry, so "the text is on
   * screen" proves nothing. The input box does: it is the line carrying the prompt marker. If our
   * text is still on that line, the Enter did not take — the harness was in an editing/paste state
   * ("esc again to edit previous message"), swallowed it, and both sides then waited forever.
   */
  private stillInInputBox(ptyId: string, line: string): boolean {
    const probe = line.slice(-45).trim()
    if (probe.length < 8) return false
    const screen = this.cleanTail(ptyId)
    if (!screen) return false
    const rows = screen.split('\n').slice(-14)
    const kind = this.agents.get(ptyId)?.kind ?? 'unknown'
    const promptRow = inputPromptRowIndex(rows, kind)
    if (promptRow < 0) return false
    const inputRegion = rows.slice(promptRow).join('\n')
    return inputRegion.includes(probe) || /\[Pasted Content\s+\d+\s+chars?\]/i.test(inputRegion)
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
    const target = this.findAgent(targetId)
    if (!target) return { ok: false, error: 'not-found' }
    // A prefix resolved to a real agent — every later lookup must use its FULL id.
    targetId = target.id
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
    const target = this.findAgent(targetId)
    if (!target) return { ok: false, error: 'not-found', detail: `no agent with id ${targetId}` }
    // A prefix resolved to a real agent — every later lookup must use its FULL id.
    targetId = target.id
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
    const delivered = await this.deliverPrompt(targetId, command)
    if (!delivered.accepted || !delivered.submitted) {
      return { ok: false, error: delivered.reason ?? 'write-failed', detail: `could not submit into ${targetId}` }
    }
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
    const target = this.findAgent(targetId)
    if (!target) return { ok: false, error: 'not-found', detail: `no agent with id ${targetId}` }
    // A prefix resolved to a real agent — every later lookup must use its FULL id.
    targetId = target.id
    if (target.kind === 'unknown') return { ok: false, error: 'not-agent', detail: 'target is a plain terminal, no harness detected' }
    const control = HARNESS_CONTROL[target.kind as AgentKind] ?? null
    if (!control?.interrupt?.length) {
      return { ok: false, error: 'unsupported-harness', detail: `no interrupt sequence known for ${target.kind}` }
    }
    const consent = await this.ensureConsent(agentId)
    if (!consent.ok) return consent
    let ok = true
    for (const key of control.interrupt) {
      if (!this.writePty(targetId, key).accepted) ok = false
    }
    this.pushEvent({ at: Date.now(), kind: 'control', from: agentId, to: targetId, detail: 'interrupt' })
    return ok ? { ok: true, status: 'interrupt-sent' } : { ok: false, error: 'write-failed' }
  }

  /** plano_compact: run the harness's compaction command, verified by tail. */
  async compact(agentId: string, targetId: string): Promise<MeshToolResult> {
    const caller = this.agents.get(agentId)
    if (!caller) return { ok: false, error: 'not-registered' }
    const target = this.findAgent(targetId)
    if (!target) return { ok: false, error: 'not-found', detail: `no agent with id ${targetId}` }
    // A prefix resolved to a real agent — every later lookup must use its FULL id.
    targetId = target.id
    if (target.kind === 'unknown') return { ok: false, error: 'not-agent', detail: 'target is a plain terminal, no harness detected' }
    const control = HARNESS_CONTROL[target.kind as AgentKind] ?? null
    if (!control?.compact) {
      return { ok: false, error: 'unsupported-harness', detail: `${target.kind} has no compaction command` }
    }
    if (target.state !== 'idle') return { ok: false, error: 'not-idle', detail: `state is '${target.state}'` }
    const consent = await this.ensureConsent(agentId)
    if (!consent.ok) return consent
    const baseline = this.cleanTail(targetId)
    const delivered = await this.deliverPrompt(targetId, control.compact)
    if (!delivered.accepted || !delivered.submitted) {
      return { ok: false, error: delivered.reason ?? 'write-failed', detail: `could not submit into ${targetId}` }
    }
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
    // No `not-agent` refusal here either: `send` below decides the route, and a peer that is
    // booting — or one parked in `plano check --wait`, which is where a well-behaved worker spends
    // its idle time — must still be askable. Refusing here made the question the caller's problem.
    if (typeof text !== 'string' || text.length === 0) return { ok: false, error: 'empty' }
    if (text.length > MAX_MESSAGE_LEN) return { ok: false, error: 'too-large' }
    const corr = Math.random().toString(16).slice(2, 7)
    const ms = Math.max(1000, Math.min(timeoutMs || ASK_DEFAULT_TIMEOUT_MS, ASK_MAX_TIMEOUT_MS))
    const baseline = this.cleanTail(to)
    // Ask is a send plus an obligation, not a second terminal transport. Routing it through send
    // guarantees the same readiness/permission/paste contract and preserves the correlation while
    // a busy or blocked peer keeps the question queued.
    const sent = await this.send(
      agentId,
      to,
      `${text} [reply with: plano reply ${corr} <summary>]`,
      'type',
    )
    if (!sent.ok) return sent
    target.currentTask = shortTask(text)
    this.pushEvent({
      at: Date.now(),
      kind: 'ask',
      from: agentId,
      to,
      detail: `${sent.status === 'queued' ? 'queued' : 'sent'} #${corr}`,
    })
    // v3 E: the asker waits → the relation is 'waiting' (breathing dot at B). v4 A4:
    // an ask OPENS the relation (counts toward the grouping counter).
    this.touchLink(agentId, to, 'waiting', corr, true)

    // A question that could not even be TYPED yet must not burn the caller's whole budget on
    // keepalives. A freshly spawned agent can spend minutes booting MCP servers; blocking on it
    // gave `{"_keepalive":true} [Timeout: 180s]` and no information, which is indistinguishable
    // from the mesh being broken. Answer immediately with the correlation and the message id: the
    // question stays queued and lands the moment its composer opens, and the caller decides
    // whether to wait (`plano watch <id>`) or get on with something else.
    if (sent.status === 'queued') {
      return {
        ok: true,
        status: 'queued',
        correlationId: corr,
        id: sent.id ?? null,
        to,
        detail:
          `${this.displayName(to)} cannot take input yet (${String(sent.readiness ?? 'not ready')}) — your question is queued and will be typed in the moment its composer opens. ` +
          `Follow it with: plano watch ${String(sent.id ?? '')} · then read the answer with: plano context ${to.slice(0, 8)}`,
      }
    }
    return this.awaitAskReply(agentId, to, corr, baseline, ms, undefined)
  }

  /**
   * The waiting half of an ask, shared by the direct and the queued paths: register the
   * correlation and block until the peer answers with `plano reply`, or until the timeout infers
   * one from its transcript. Keeping this in one place is what lets a question asked of a busy
   * peer behave exactly like one asked of a free peer.
   */
  private awaitAskReply(
    agentId: string,
    to: string,
    corr: string,
    baseline: string,
    ms: number,
    messageId?: string,
  ): Promise<MeshToolResult> {
    return new Promise<MeshToolResult>((resolve) => {
      const timer = setTimeout(() => {
        const ask = this.pendingAsks.get(corr)
        if (!ask || ask.settled) return
        ask.settled = true
        this.pendingAsks.delete(corr)
        // NEVER manufacture an answer. This used to return the transcript delta as `reply`, so a
        // peer that was still booting handed the asker its MCP connection errors dressed up as the
        // answer to "hola" — worse than no answer, because it looks like one. A timeout means the
        // question is still PENDING: say that, hand back the correlation so it can be resumed, and
        // offer the transcript separately and clearly labelled as context, not as a reply.
        const tail = this.cleanTail(to)
        resolve({
          ok: true,
          correlationId: corr,
          status: 'pending',
          timeout: true,
          answered: false,
          contextTail: this.tailDelta(ask.baseline, tail).slice(-800),
          detail:
            `${this.displayName(to)} has not answered yet — the question is still pending, not lost. ` +
            `Read what they are doing with: plano context ${to.slice(0, 8)} · or wait again for the same question.`,
          ...(messageId ? { id: messageId, queued: true } : null),
        })
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
    // A tail is now the RENDERED SCREEN (daemon/screen.ts), and a screen is not append-only: it
    // scrolls, repaints, and — crucially — an agent TUI writes its output ABOVE a fixed input box
    // that stays byte-identical. Anchoring on the baseline's last lines therefore matched the
    // bottom of the new screen and reported nothing at all.
    //
    // So diff by LINE against a multiset of what was already showing: walk the current screen and
    // keep the lines the baseline cannot account for, in order. Content inserted above a stable
    // box is kept (the box's own lines are consumed by their baseline copies), scrolled-off lines
    // simply never appear, and repeated blanks stay balanced because the count is consumed.
    const remaining = new Map<string, number>()
    for (const line of baseline.split('\n')) remaining.set(line, (remaining.get(line) ?? 0) + 1)
    const fresh: string[] = []
    for (const line of tail.split('\n')) {
      const left = remaining.get(line) ?? 0
      if (left > 0) {
        remaining.set(line, left - 1)
        continue
      }
      fresh.push(line)
    }
    // Nothing the baseline can't explain means nothing happened — say so, rather than handing back
    // a whole screen the caller has already seen.
    return fresh.join('\n').trim().slice(0, maxChars)
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
    const target = this.findAgent(targetId)
    if (!target) return { ok: false, error: 'not-found', detail: `no agent with id ${targetId}` }
    // A prefix resolved to a real agent — every later lookup must use its FULL id.
    targetId = target.id
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
    // A newborn can be detected as a harness before its TUI has rendered. Its spawn prompt is
    // then intentionally queued by guarded send. That terminal may look idle, but its requested
    // turn has not even started; returning alreadyIdle here is the same silent-loss bug in a
    // different costume. Stay attached until the queued prompt is accepted and the turn ends.
    const pendingAtStart = this.mailboxes.load(targetId).some((message) => !message.acked)
    if (target.state === 'exited') {
      return { ok: true, id: targetId, state: 'exited', exitCode: target.exitCode ?? null, delta: '', durationMs: 0 }
    }
    // v5 A1: a turn that ENDED after `since` counts as done even if we never saw it busy —
    // the send → wait race with a fast peer. It must still have been quiet for quietMs: a
    // booting harness goes briefly idle between its own paint bursts, and that gap is not a
    // finished turn. When it is too fresh, the waiter below confirms the rest of the window.
    const doneBefore = !pendingAtStart && target.state === 'idle' && target.stateSince >= since
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
    if (!anchored && !pendingAtStart && !opts.nextTurn && target.state === 'idle' && Date.now() - target.stateSince >= quietMs) {
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
    // A chain is not a privileged PTY shortcut. Send it through the same readiness gate and
    // atomic-paste transaction; a busy/permission target queues it and the arming agent receives
    // the normal tracked outcome instead of a silent failed Enter.
    const delivered = await this.send(chain.from, chain.to, `[chain ${chain.id.slice(0, 8)}] ${payload.text}`, 'type')
    if (!delivered.ok) {
      chain.status = 'failed'
      chain.failReason = String(delivered.error ?? 'write-failed')
      this.persistChains()
      this.pushEvent({ at: Date.now(), kind: 'chain', from: chain.from, to: chain.to, detail: `failed ${chain.failReason} #${chain.id.slice(0, 8)}` })
      return
    }
    // v4 A4: the fired chain pulses solid then rests (chained flag already cleared).
    this.touchLink(chain.from, chain.to, 'active')
    this.pushEvent({
      at: Date.now(),
      kind: 'chain',
      from: chain.from,
      to: chain.to,
      detail: `${delivered.status === 'queued' ? 'queued' : 'fired'} #${chain.id.slice(0, 8)} (${chain.payload.source})`,
    })
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

  /**
   * Close a terminal — the counterpart to spawnAgent, which agents had no way to undo: they could
   * create workers all day and never tidy up after one.
   *
   * Shaped after the terminal close contract: closing ONE session is the default, and `--panel` (its
   * `--tab`) takes the whole panel down. Closing yourself is allowed, because "I am done, clean me
   * up" is a legitimate last act — but the answer is sent BEFORE the kill, since the CLI making
   * this call is a child of the very PTY being torn down and would otherwise die mid-sentence.
   */
  async closeAgent(agentId: string, targetId: string, opts: { panel?: boolean } = {}): Promise<MeshToolResult> {
    if (!this.onClose) return { ok: false, error: 'close-unavailable', detail: 'no close hook (daemon not wired)' }
    const caller = this.agents.get(agentId)
    if (!caller) return { ok: false, error: 'not-registered', detail: 'your agent is not on the roster' }
    const target = this.findAgent(targetId)
    if (!target) return { ok: false, error: 'not-found', detail: `no agent with id ${targetId}` }
    // A prefix resolved to a real agent — every later lookup must use its FULL id.
    targetId = target.id
    // Closing a peer is a WRITE to someone's canvas — same consent gate as sending or spawning.
    const consent = await this.ensureConsent(agentId)
    if (!consent.ok) return consent
    if (!this.rateOk(agentId)) return { ok: false, error: 'rate-limited' }

    const panel = opts.panel === true
    const detail = `${this.displayName(targetId)}${panel ? ' (whole panel)' : ''}`
    this.pushEvent({ at: Date.now(), kind: 'close', from: agentId, to: targetId, detail })

    if (targetId === agentId) {
      // Answer first, then die: the reply has to be written to a PTY that is about to stop existing.
      setTimeout(() => this.onClose?.({ ptyId: targetId, panel }), 150)
      return { ok: true, closed: [targetId], self: true, panel, detail: 'closing this terminal' }
    }
    const result = this.onClose({ ptyId: targetId, panel })
    if (!result.ok) return { ok: false, error: result.error ?? 'close-failed' }
    return { ok: true, closed: result.closed ?? [targetId], panel }
  }

  // ── orchestration (v7): Run / Task / Dispatch ─────────────────────────────────

  /**
   * Create (or reuse) the coordinator's Run. A Run is a namespace and an inbox, never a scheduler:
   * it decides nothing about placement, it only makes the work addressable and durable.
   */
  runCreate(agentId: string, objective: string): MeshToolResult {
    if (!this.agents.has(agentId)) return { ok: false, error: 'not-registered' }
    const run = this.orch.createRun(agentId, String(objective || 'unnamed run'))
    this.pushEvent({ at: Date.now(), kind: 'chain', from: agentId, detail: `run ${run.id}: ${run.objective}` })
    return { ok: true, runId: run.id, objective: run.objective }
  }

  /** Add a work item. `deps` makes it a DAG: the task stays `pending` until every dep completes. */
  taskCreate(agentId: string, spec: string, deps: string[], parent?: string): MeshToolResult {
    if (!this.agents.has(agentId)) return { ok: false, error: 'not-registered' }
    if (!spec.trim()) return { ok: false, error: 'empty-spec' }
    const run = this.orch.runFor(agentId) ?? this.orch.createRun(agentId, 'unnamed run')
    const task = this.orch.createTask(run.id, spec, deps, parent)
    return { ok: true, taskId: task.id, runId: run.id, status: task.status, deps: task.deps }
  }

  taskList(agentId: string, opts: { ready?: boolean } = {}): MeshToolResult {
    const run = this.orch.runFor(agentId)
    const tasks = opts.ready ? this.orch.readyTasks(run?.id) : this.orch.tasks(run?.id)
    return {
      ok: true,
      runId: run?.id ?? null,
      tasks: tasks.map((t) => ({
        id: t.id,
        spec: t.spec.slice(0, 160),
        status: t.status,
        deps: t.deps,
        failures: t.failures,
        dispatches: this.orch.dispatchesFor(t.id).map((d) => ({ id: d.id, agent: d.agentId, state: d.state, outcome: d.outcome ?? null })),
      })),
    }
  }

  /**
   * Assign one attempt of a task to an agent and TELL that agent what it owes.
   *
   * The preamble is the contract: without it a worker has no idea it is being supervised, and the
   * coordinator ends up polling a roster to guess. It is delivered through the ordinary guarded
   * send, so it inherits readiness, paste and the sender-outcome machinery.
   */
  async dispatchTask(agentId: string, taskId: string, to: string, retryOf?: string): Promise<MeshToolResult> {
    if (!this.agents.has(agentId)) return { ok: false, error: 'not-registered' }
    const target = this.findAgent(to)
    if (!target) return { ok: false, error: 'not-found', detail: `no agent with id ${to}` }
    const task = this.orch.task(taskId)
    if (!task) return { ok: false, error: 'not-found', detail: `no task ${taskId}` }
    const created = this.orch.createDispatch(taskId, target.id, retryOf)
    if ('error' in created) return { ok: false, error: 'dispatch-refused', detail: created.error }
    const preamble =
      `[plano dispatch] You are working task ${task.id} (dispatch ${created.id}). TASK: ${task.spec} ` +
      `When you finish you MUST report exactly once: ` +
      `plano worker-done ${created.id} --outcome succeeded|failed --summary "<what changed>" ` +
      `Use --outcome failed if it did not work; never report failure only in prose. ` +
      `If you are blocked and need the coordinator, use: plano ask ${agentId} "<question>"`
    // A bare shell has no harness to read a preamble, and that is NOT a failed attempt: the
    // dispatch still exists for tracking and the coordinator sends the prompt itself. Settling it
    // as failed (the first cut) burned an attempt against the circuit breaker for a target that
    // had not even been asked yet.
    if (target.kind === 'unknown') {
      this.pushEvent({ at: Date.now(), kind: 'chain', from: agentId, to: target.id, detail: `dispatch ${created.id} (tracking only)` })
      return {
        ok: true,
        dispatchId: created.id,
        taskId: task.id,
        to: target.id,
        injected: false,
        detail: 'target is a plain shell — dispatch created for tracking; send the prompt yourself, then it reports with plano worker-done',
      }
    }
    const sent = await this.send(agentId, target.id, preamble, 'type')
    if (!sent.ok) {
      this.orch.settle(created.id, 'failed', 'preamble could not be delivered')
      return { ok: false, error: 'undeliverable', detail: String(sent.error ?? 'send failed') }
    }
    this.pushEvent({ at: Date.now(), kind: 'chain', from: agentId, to: target.id, detail: `dispatch ${created.id} → ${task.id}` })
    return { ok: true, dispatchId: created.id, taskId: task.id, to: target.id, status: sent.status ?? 'delivered' }
  }

  /**
   * A worker settles its own attempt. This is the ONLY self-service completion path in the mesh:
   * an outcome, stated once, by the agent that did the work. Everything else — idle TUIs, quiet
   * terminals, heartbeats — proves the worker is alive, never that it is done.
   */
  workerDone(agentId: string, dispatchId: string | undefined, outcome: WorkerOutcome, summary?: string, files?: string[]): MeshToolResult {
    const dispatch = dispatchId ? this.orch.dispatch(dispatchId) : this.orch.activeDispatchFor(agentId)
    if (!dispatch) return { ok: false, error: 'no-dispatch', detail: 'you have no active dispatch — nothing to report' }
    if (dispatch.agentId !== agentId) {
      return { ok: false, error: 'not-yours', detail: 'a dispatch can only be settled by the agent executing it' }
    }
    const settled = this.orch.settle(dispatch.id, outcome, summary, files)
    if (!settled.ok) return { ok: false, error: 'settle-failed', detail: settled.error }
    const task = settled.task
    // Tell the coordinator in its own mailbox, typed, so a rolling `check --wait` wakes on it.
    const run = this.orch.run(dispatch.runId)
    if (run && run.coordinator !== agentId) {
      this.mailboxes.push(run.coordinator, {
        id: `wdone-${dispatch.id}`,
        at: Date.now(),
        from: agentId,
        to: run.coordinator,
        text: `[worker_done ${outcome}] task ${dispatch.taskId}: ${summary ?? '(no summary)'}${files?.length ? ` · files: ${files.join(', ')}` : ''}`,
        mode: 'queue',
        ttl: DEFAULT_TTL_MS,
        bornAt: Date.now(),
        hops: 0,
        status: 'queued',
        acked: false,
        kind: 'worker_done',
      })
      this.drainMailbox(run.coordinator)
      this.resolveCheckWaiters(run.coordinator)
    }
    this.pushEvent({ at: Date.now(), kind: 'chain', from: agentId, detail: `worker_done ${outcome} ${dispatch.id}` })
    return {
      ok: true,
      dispatchId: dispatch.id,
      taskId: dispatch.taskId,
      outcome,
      taskStatus: task?.status ?? 'unknown',
      attempts: task?.failures ?? 0,
      circuitBroken: (task?.failures ?? 0) >= MAX_TASK_FAILURES,
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
