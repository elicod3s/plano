/**
 * Mesh domain types (plan F1). The mesh lives in the DAEMON — the bus is the single source
 * of truth for roster, mailboxes, active links and the message timeline. The renderer only
 * reflects it; agents never fabricate their own `from` (identity comes from the token).
 */

import type { AgentKind } from '@shared/domain/agent'

/** v3 B: honest agent state — busy was a byte-window lie; state is meaningful. */
export type AgentState = 'idle' | 'working' | 'awaiting-input' | 'error' | 'exited'

/** Guard result sampled immediately before a mesh write. */
export type AgentReadinessState = 'sendable' | 'busy' | 'permission-prompt' | 'not-an-agent' | 'unknown'

export interface AgentReadiness {
  state: AgentReadinessState
  /** A known TUI composer mode that must be escaped before a prompt is pasted. */
  inputMode: 'clean' | 'editing'
  /**
   * Sendable BECAUSE the composer is live, while the agent is still mid-turn. Delivery is allowed
   * (the harness queues the input itself), but the caller must NOT read this as "the turn ended".
   */
  midTurn?: boolean
  /** Bracketed only after the PTY emitted DECSET ?2004h; plain is still one atomic write. */
  pasteMode: 'bracketed' | 'plain'
  detail?: string
}

/** A provider-level write receipt: accepted bytes, not a screen-derived guess. */
export interface PtyWriteReceipt {
  accepted: boolean
  bytesWritten: number
}

/** One live agent (a PTY that may or may not run a detected harness yet). */
export interface MeshAgent {
  /** Stable identity = ptyId (plan F2). */
  id: string
  /** Detected harness kind, or 'unknown' while none is detected. */
  kind: AgentKind | 'unknown'
  cwd: string
  /** Workspace the terminal belongs to (spaceId). */
  workspace: string
  /** Derived from state (v3 B): true only while state === 'working'. */
  busy: boolean
  /** v3 B: meaningful state (idle/working/awaiting-input/error/exited). */
  state: AgentState
  /** v3 B: when the agent entered the current state. */
  stateSince: number
  /** v3 B: last task from plano_send/plano_claim. */
  currentTask?: string
  /** v3 B: true only for a MANUAL claim — the detect loop preserves it. */
  manual?: boolean
  /** v3 B: set when state === 'exited'. */
  exitCode?: number | null
  /** v3 D1: last known capabilities — declared (authoritative) or harness default. */
  capabilities?: import('@shared/domain/agent').AgentCapabilities
  capsSource?: 'declared' | 'default'
  panelId: string
  terminalId: string
  /** Panel title shown in the roster ("Terminal #3"). */
  panelTitle: string
  /** Last time the bus saw the agent (roster freshness). */
  lastSeen: number
}

/** A message travelling between agents. */
export interface MeshMessage {
  id: string
  at: number
  from: string
  to: string
  text: string
  /** 'type' = type it visibly into the target PTY; 'queue' = deliver when idle. */
  mode: 'type' | 'queue'
  /** Milliseconds until the message expires (0 = never). v3 A3: real TTL, default set by bus. */
  ttl: number
  /** Anti-loop: each hop decrements; a message dies at 0. */
  hops: number
  /** v3 A3/A4: queued | delivered | failed | expired | undeliverable | written-but-unconfirmed.
   *  'delivered' additionally carries `confirmed` (receiver output beyond echo, v3 A4). */
  status: 'queued' | 'delivered' | 'failed' | 'expired' | 'undeliverable' | 'written-but-unconfirmed'
  /** Exactly-once: the receiver acks after processing; acked messages leave the mailbox. */
  acked: boolean
  /** v3 A3: delivery attempts so far (backoff + cap → undeliverable). */
  attempts?: number
  /** v3 A4: whether the receiver's tail changed beyond the typed echo. */
  confirmed?: boolean
  /** v3 A3: why delivery ultimately failed. */
  reason?: string
  /** v6 A2: a terminal-outcome notice was already sent to `from` — never notify twice. */
  notified?: boolean
  /** v6 C3: the "target is blocked" heads-up was sent — independent of the outcome notice. */
  blockedNotified?: boolean
  /** v6 A3: absolute creation time; `at` slides while the target is busy, this never does. */
  bornAt?: number
  /**
   * v7: what KIND of message this is, so a coordinator can wait for the two that matter
   * (`worker_done`, `escalation`) and ignore ordinary chatter. Untyped mail is `message`.
   */
  kind?: 'message' | 'status' | 'worker_done' | 'escalation' | 'question' | 'heartbeat'
  /** v7 B2: the batch this message was handed out in; cleared when that batch is acknowledged. */
  deliveryId?: string
  /** Guarded delivery receipt, persisted so `plano watch` can report the write as a fact. */
  accepted?: boolean
  bytesWritten?: number
}

/** Timeline event (auditable in the AgentManager). */
export interface MeshEvent {
  at: number
  kind:
    | 'agent-up'
    | 'agent-down'
    | 'msg-sent'
    | 'msg-delivered'
    | 'msg-queued'
    | 'msg-failed'
    | 'msg-expired'
    | 'msg-undeliverable'
    | 'state'
    | 'ask'
    | 'control'
    | 'link'
    | 'chain'
    | 'spawn'
    /** An agent closed a terminal (the counterpart of 'spawn'). */
    | 'close'
    | 'consent'
  from: string
  to?: string
  detail?: string
  /** Canvas panel id of the `from` agent (for the link layer). */
  panelId?: string
  /** v3 E: the full relation snapshot when kind === 'link'. */
  link?: MeshLink
}

/** v3 E: one persistent relation between a pair of agents — one line, never ten curves. */
export interface MeshLink {
  /** The two endpoints (ptyIds), ordered so the key is stable. */
  a: string
  b: string
  /** idle (at-rest mesh line, v4 A1) | active (collaborating) | waiting (ask open) |
   *  done (resolved, fading) | failed (timeout/error, flashing). */
  state: 'idle' | 'active' | 'waiting' | 'done' | 'failed'
  since: number
  lastTraffic: number
  /** Open messages/asks between the pair (grouping counter). */
  count: number
  /** Direction of the pulse: current emitter → current receiver. */
  from: string
  to: string
  /** Emitter's harness kind at event time (drives the link color). */
  kind: import('@shared/domain/agent').AgentKind | 'unknown'
  /** Open ask correlation id while waiting. */
  corr?: string
  /** v4 A4/B1: an armed chain exists between the pair — the line is dashed until fired. */
  chained?: boolean
}

/** v4 B1: trigger semantics, not a timer. */
export type ChainWhen = 'i-finish' | 'agent-finishes' | 'i-reply'
export type ChainFailure = 'notify' | 'fire-anyway' | 'ask-user'
export type ChainStatus = 'armed' | 'fired' | 'cancelled' | 'expired' | 'failed'

/** v4 B1: one chained task. Payload sources: explicit text, a file path, or an
 *  inferred (redacted) tail delta — the latter is always marked as such. */
export interface MeshChain {
  id: string
  /** The agent that armed it (fires when THIS one finishes, unless when = agent-finishes). */
  from: string
  /** The agent that executes. */
  to: string
  when: ChainWhen
  /** Target to watch when when = 'agent-finishes'. */
  watch?: string
  payload: {
    source: 'explicit' | 'file' | 'inferred'
    text?: string
    file?: string
  }
  onFailure: ChainFailure
  timeoutMs: number
  hops: number
  status: ChainStatus
  armedAt: number
  firedAt?: number
  failReason?: string
  /** Cleaned tail of `from` at arm time (inferred payload delta). */
  baseline: string
}

/** The mesh's answer to a CLI/RPC method call — a plain typed result object. */
export interface MeshToolResult {
  ok: boolean
  error?: string
  [key: string]: unknown
}
