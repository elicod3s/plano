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
  | 'grok'
  | 'omp'
  | 'pi'
  | 'hermes'
  | 'generic-agent'

/** v3 D1: what an agent can do. Sources, in order: plano_declare (authoritative) →
 *  HARNESS_CAPABILITIES (sane default) → unknown. */
export interface AgentCapabilities {
  /** Can this agent read images? */
  vision: boolean
  contextTokens: number
  /** Active model id, when knowable. */
  model?: string
  /** Tool/command names the agent can run (its MCP tools, skills…). */
  tools: string[]
  /** Whether this agent can spawn new agents by itself. */
  canSpawn: boolean
}

/** Per-harness default capabilities (v3 D1 — overridable by plano_declare). */
export const HARNESS_CAPABILITIES: Record<AgentKind, AgentCapabilities> = {
  'claude-code': { vision: true, contextTokens: 200_000, tools: [], canSpawn: false },
  codex: { vision: true, contextTokens: 128_000, tools: [], canSpawn: false },
  opencode: { vision: true, contextTokens: 200_000, tools: [], canSpawn: false },
  aider: { vision: true, contextTokens: 128_000, tools: [], canSpawn: false },
  'gemini-cli': { vision: true, contextTokens: 1_000_000, tools: [], canSpawn: false },
  cursor: { vision: true, contextTokens: 200_000, tools: [], canSpawn: false },
  'kiro-cli': { vision: false, contextTokens: 128_000, tools: [], canSpawn: false },
  // Grok Build CLI (x.ai) — a Rust TUI with terminal-based vision.
  grok: { vision: true, contextTokens: 131_072, tools: [], canSpawn: false },
  omp: { vision: true, contextTokens: 200_000, tools: [], canSpawn: false },
  pi: { vision: true, contextTokens: 200_000, tools: [], canSpawn: false },
  hermes: { vision: false, contextTokens: 128_000, tools: [], canSpawn: false },
  'generic-agent': { vision: false, contextTokens: 128_000, tools: [], canSpawn: false },
}

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
  // Grok Build (x.ai) — installed at ~/.grok/bin/grok.exe. The brand mark is monochrome
  // black/white, so the accent is a neutral gray that stays visible on both themes.
  grok: { id: 'grok', displayName: 'Grok', icon: 'Zap', accent: '#e5e7eb' },
  // Oh My Pi — a community fork of the Pi coding agent, shipped as its own CLI (`omp`,
  // package @oh-my-pi/pi-coding-agent). Detected BEFORE pi because both installs share the
  // `pi-coding-agent` path segment; the @oh-my-pi scope is the load-bearing marker. Brand
  // color is the official plugin-connector orange (#f97316 from assets/icon.svg).
  omp: { id: 'omp', displayName: 'Oh My Pi', icon: 'GitFork', accent: '#f97316' },
  // Pi's brand mark is monochrome by design; the accent is a warm golden sand so the panel
  // chrome still reads distinctly on both the dark and light themes.
  pi: { id: 'pi', displayName: 'Pi', icon: 'Pi', accent: '#d8a95c' },
  // Hermes Agent (Nous Research). Detected like any other CLI; the muted gold accent keeps
  // its panel chrome distinct on both themes without breaking the monochrome feel.
  hermes: { id: 'hermes', displayName: 'Hermes Agent', icon: 'Waypoints', accent: '#d6a85f' },
  'generic-agent': { id: 'generic-agent', displayName: 'AI Agent', icon: 'Bot', accent: '#ffffff' },
}

/**
 * The normalized "resume target" for a detected agent — the subset of CLIs whose
 * conversations can be reopened (`RESUMABLE_AGENTS` maps the detected `AgentKind` to it).
 * `aider`/`generic-agent` are intentionally absent (no stable resume CLI).
 */
export type ResumableAgent = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode' | 'kiro' | 'grok' | 'omp' | 'pi' | 'hermes'

export const RESUMABLE_AGENTS: Partial<Record<AgentKind, ResumableAgent>> = {
  'claude-code': 'claude',
  codex: 'codex',
  'gemini-cli': 'gemini',
  cursor: 'cursor',
  opencode: 'opencode',
  'kiro-cli': 'kiro',
  grok: 'grok',
  omp: 'omp',
  pi: 'pi',
  hermes: 'hermes',
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
      return id ? `codex resume ${id}` : 'codex resume --last'
    case 'gemini':
      return id ? `gemini --resume ${id}` : null
    case 'cursor':
      return id ? `cursor-agent --resume ${id}` : 'cursor-agent --continue'
    case 'opencode':
      return id ? `opencode --session ${id}` : 'opencode --continue'
    case 'kiro':
      return id ? `kiro-cli chat --resume-id ${id}` : 'kiro-cli chat --resume'
    case 'omp':
      // Oh My Pi is a fork of pi — same session flag, own binary.
      return id ? `omp --session ${id}` : 'omp -r'
    case 'pi':
      // pi resumes by session id (partial uuid ok) or opens the interactive picker.
      return id ? `pi --session ${id}` : 'pi -r'
    case 'hermes':
      // Hermes resumes the most recent conversation without an id; its ids are not
      // uuid-shaped, so we deliberately never interpolate one here.
      return 'hermes --continue'
    default:
      return null
  }
}

/** Recover an exact resumable reference from a command the user typed themselves. */
export function agentSessionFromCommand(command: string, cwd: string): AgentSessionRef | null {
  if (!cwd) return null
  if (/^\s*(?:&\s*)?codex(?:\.exe)?(?=\s|$)/i.test(command)) {
    const match = /(?:^|\s)resume\s+([0-9a-fA-F-]{8,64})(?=\s|$)/i.exec(command)
    if (match && SESSION_ID_RE.test(match[1])) return { agent: 'codex', sessionId: match[1], cwd }
  }
  if (/^\s*(?:&\s*)?claude(?:\.exe)?(?=\s|$)/i.test(command)) {
    const match = /(?:^|\s)--resume(?:=|\s+)([0-9a-fA-F-]{8,64})(?=\s|$)/i.exec(command)
    if (match && SESSION_ID_RE.test(match[1])) return { agent: 'claude', sessionId: match[1], cwd }
  }
  // Oh My Pi — fork of pi, same `--session` flag.
  if (/^\s*(?:&\s*)?omp(?:\.exe)?(?=\s|$)/i.test(command)) {
    const match = /(?:^|\s)--session\s+([0-9a-fA-F-]{36})(?=\s|$)/i.exec(command)
    if (match && SESSION_ID_RE.test(match[1])) return { agent: 'omp', sessionId: match[1], cwd }
  }
  if (/^\s*(?:&\s*)?pi(?:\.exe)?(?=\s|$)/i.test(command)) {
    const match = /(?:^|\s)--session\s+([0-9a-fA-F-]{36})(?=\s|$)/i.exec(command)
    if (match && SESSION_ID_RE.test(match[1])) return { agent: 'pi', sessionId: match[1], cwd }
  }
  // Hermes resumes id-less (--continue) — never capture a title/id into a resume ref.
  if (/^\s*(?:&\s*)?hermes(?:\.exe|\.cmd)?(?=\s|$)/i.test(command)) {
    return { agent: 'hermes', cwd }
  }
  return null
}

/**
 * Auto-approve was REMOVED (2026-08-12).
 *
 * It rewrote a harness's launch command with its bypass-everything flags
 * (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, `--approve`)
 * from a toggle in the panel header. A control that disarms an agent's own safety prompts does
 * not belong one click away in the chrome, and the toggle's state was easy to lose track of.
 * Agents now always launch with their own defaults; a user who wants those flags types them.
 */

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
