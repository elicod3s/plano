/**
 * Agent Mesh domain — the shared contracts between main (the canonical context) and the
 * renderer's Agent Control Center / mesh UI. Provider-neutral: everything here describes
 * ANY detected agent (Claude, Codex, Pi, Hermes, …), never a specific vendor.
 */

import type { AgentKind, AgentVerdict } from './agent'

/** What the mesh can do to a given agent terminal (capabilities are per-runtime, main decides). */
export type AgentControlCapability =
  | 'prompt'
  | 'interrupt'
  | 'resume'
  | 'model-switch'
  | 'sessions'
  | 'tools'
  | 'mcp'
  | 'api'
  | 'acp'

/**
 * A live, mesh-resolvable agent runtime. Assembled in MAIN from PtyManager's stable
 * identity + AgentContextService's live feed — never fabricated in the renderer.
 */
export interface AgentRuntimeDescriptor {
  ptyId: string
  terminalId: string
  panelId: string
  spaceId: string
  spaceName: string
  terminalNumber: number
  terminalTitle: string
  tabTitle: string
  cwd: string
  pid: number
  shell: string
  status: 'starting' | 'ready' | 'exited'
  verdict: AgentVerdict
  firstPrompt: string
  lastPrompt: string
  modelLabel?: string
  providerLabel?: string
  capabilities: AgentControlCapability[]
  lastOutputAt: number
  updatedAt: number
}

/** The full mesh snapshot (all agents across all workspaces), serialisable over IPC. */
export interface AgentMeshSnapshot {
  agents: AgentRuntimeDescriptor[]
  workspaceNames: Record<string, string>
  /** Total clean-context bytes held in main (drives the UI usage readout). */
  usageBytes: number
  takenAt: number
}

export interface MeshDispatchRequest {
  /** Deduplicated internally; capped at MESH_LIMITS.maxDispatchTargets. */
  targetPtyIds: string[]
  /** The user's message to send (after the shared-context block). */
  message: string
  /** Prepend the [PLANO SHARED CONTEXT] block (default true). */
  includeContext: boolean
  /** Only dispatch to agents that are currently idle. */
  onlyWhenIdle: boolean
}

export type MeshDispatchError =
  | 'not-found'
  | 'not-agent'
  | 'working'
  | 'exited'
  | 'write-failed'
  | 'too-large'

export interface MeshDispatchTargetResult {
  ptyId: string
  ok: boolean
  error?: MeshDispatchError
  /** True when the write actually reached the PTY. */
  delivered?: boolean
  /** Bytes written. */
  bytes?: number
}

export interface MeshDispatchResult {
  results: MeshDispatchTargetResult[]
  /** Overall success = at least one delivered, none failed with a fatal error. */
  ok: boolean
  /** Serialised shared-context block (for the UI to show what was sent). */
  context?: string
  /** True when the message was truncated to fit the per-message cap. */
  truncated?: boolean
}

/** A provider-neutral saved prompt ("snippet"). */
export interface AgentSnippet {
  id: string
  name: string
  body: string
  /** ISO timestamp of last use (drives sort-by-use). */
  lastUsed?: string
  createdAt: string
}

export type MeshTimelineKind =
  | 'agent-started'
  | 'phase-changed'
  | 'prompt-sent'
  | 'url-detected'
  | 'process-exited'
  | 'dispatch'

/** Plan F7: a mesh timeline event forwarded from the daemon to the renderer (link layer). */
export interface MeshUiEvent {
  at: number
  kind: string
  from: string
  to?: string
  detail?: string
  /** Canvas panel id of the `from` agent. */
  panelId?: string
  /** v3 E: full relation snapshot when kind === 'link'. */
  link?: {
    a: string
    b: string
    state: 'idle' | 'active' | 'waiting' | 'done' | 'failed'
    since: number
    lastTraffic: number
    count: number
    from: string
    to: string
    kind: string
    corr?: string
    chained?: boolean
  }
}
export interface ContextTimelineEvent {
  id: string
  at: number
  kind: MeshTimelineKind
  ptyId: string
  summary: string
  agent?: AgentKind | null
}

/** A prompt captured in a terminal (keyboard/mesh/voice) and forwarded to main. */
export interface AgentPromptEvent {
  ptyId: string
  text: string
  first: boolean
  source: 'keyboard' | 'mesh' | 'voice'
  at: number
}

/** One fan-out worktree (git worktree with its own branch). */
export interface WorktreeInfo {
  path: string
  branch: string
  /** Working tree has uncommitted/untracked changes. */
  dirty: boolean
  ahead: number
  behind: number
}

/** Live runtime metadata patch for a PTY (OSC-7 cwd, OSC-0/2 title, workspace, numbering). */
export interface AgentRuntimeMetaPatch {
  ptyId: string
  cwd?: string
  terminalTitle?: string
  tabTitle?: string
  terminalNumber?: number
  spaceName?: string
}
