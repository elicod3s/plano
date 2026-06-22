/**
 * AI coding CLIs that a terminal can auto-detect. Pure data shared by the detection
 * engine (main) and the agent-mode chrome (renderer). Icon names map to lucide-react.
 */

export type AgentKind =
  | 'claude-code'
  | 'codex'
  | 'opencode'
  | 'aider'
  | 'gemini-cli'
  | 'cursor'
  | 'kiro-cli'
  | 'generic-agent'

export interface AgentInfo {
  id: AgentKind
  displayName: string
  /** lucide-react icon name used by the renderer's agent chrome. */
  icon: string
  /**
   * Brand accent applied to the DETECTED agent's panel chrome (border + header accent
   * + glow). The one deliberate exception to PLANO's monochrome rule — scoped to the
   * agent panel so the rest of the UI stays monochrome.
   */
  accent: string
}

export const AGENTS: Record<AgentKind, AgentInfo> = {
  'claude-code': { id: 'claude-code', displayName: 'Claude Code', icon: 'Sparkles', accent: '#d97757' },
  codex: { id: 'codex', displayName: 'OpenAI Codex', icon: 'Braces', accent: '#4f8cf7' },
  opencode: { id: 'opencode', displayName: 'opencode', icon: 'TerminalSquare', accent: '#14b8a6' },
  aider: { id: 'aider', displayName: 'Aider', icon: 'Bot', accent: '#22c55e' },
  'gemini-cli': { id: 'gemini-cli', displayName: 'Gemini CLI', icon: 'Stars', accent: '#a855f7' },
  cursor: { id: 'cursor', displayName: 'Cursor', icon: 'MousePointer2', accent: '#4f7cff' },
  'kiro-cli': { id: 'kiro-cli', displayName: 'Kiro CLI', icon: 'Ghost', accent: '#8b5cf6' },
  'generic-agent': { id: 'generic-agent', displayName: 'AI Agent', icon: 'Bot', accent: '#ffffff' },
}

/**
 * The normalized "resume target" for a detected agent — the subset of CLIs whose
 * conversations can be reopened (`RESUMABLE_AGENTS` maps the detected `AgentKind` to it).
 * `aider`/`generic-agent` are intentionally absent (no stable resume CLI).
 */
export type ResumableAgent = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode' | 'kiro'

export const RESUMABLE_AGENTS: Partial<Record<AgentKind, ResumableAgent>> = {
  'claude-code': 'claude',
  codex: 'codex',
  'gemini-cli': 'gemini',
  cursor: 'cursor',
  opencode: 'opencode',
  'kiro-cli': 'kiro',
}

/**
 * A persisted, resumable reference to the agent conversation that was running in a terminal.
 * Captured live (main resolves the on-disk session id), stored on the terminal panel, and
 * used to reopen the conversation when a workspace reopens. `cwd` is the agent's working
 * directory at capture time — resume is project-dir-scoped, so restore only fires when the
 * respawned shell lands in the same directory.
 */
export interface AgentSessionRef {
  agent: ResumableAgent
  sessionId?: string
  cwd: string
}

/**
 * Session ids are uuid-shaped (Codex uses a uuidv7-style id, hence the loose form). Anything
 * else is rejected so a tampered/corrupt session store can never smuggle shell syntax into a
 * resume command. This is the load-bearing injection guard — apply it before interpolation.
 */
export const SESSION_ID_RE = /^[0-9a-fA-F-]{8,64}$/

/**
 * The shell command that reopens an agent conversation, or `null` when it can't be resumed
 * safely. Agents with no id-less fallback (claude/codex/gemini) return `null` without a valid
 * id so we never resume the wrong conversation; cursor/opencode/kiro fall back to their
 * "continue/previous" form. Pure (no node/dom) — callable from both main and renderer.
 */
export function buildAgentResumeCommand(ref: AgentSessionRef): string | null {
  const id = ref.sessionId && SESSION_ID_RE.test(ref.sessionId) ? ref.sessionId : null
  switch (ref.agent) {
    case 'claude':
      return id ? `claude --resume ${id}` : null
    case 'codex':
      return id ? `codex resume ${id}` : null
    case 'gemini':
      return id ? `gemini --resume ${id}` : null
    case 'cursor':
      return id ? `cursor-agent --resume ${id}` : 'cursor-agent --continue'
    case 'opencode':
      return id ? `opencode --session ${id}` : 'opencode --continue'
    case 'kiro':
      return id ? `kiro-cli chat --resume-id ${id}` : 'kiro-cli chat --resume'
    default:
      return null
  }
}

/**
 * Live activity of a detected agent, derived from PTY output cadence:
 *  - `working` — output flowed recently (the agent is generating / running tools)
 *  - `idle`    — output went quiet, i.e. the turn finished and it awaits the next prompt
 * Only meaningful while `active` is true. Drives the Working…/Done chip in the panel header.
 */
export type AgentPhase = 'working' | 'idle'

/** A detection verdict for a single terminal, emitted only when it changes. */
export interface AgentVerdict {
  active: boolean
  kind: AgentKind | null
  displayName?: string
  /** 0..1 — process-tree match ~0.8, fused with output banner up to 0.95. */
  confidence: number
  source?: 'process-tree' | 'output-heuristic' | 'fused'
  /** Live activity while active — emitted on change so the header chip flips. */
  phase?: AgentPhase
}

export const NO_AGENT: AgentVerdict = { active: false, kind: null, confidence: 0 }
