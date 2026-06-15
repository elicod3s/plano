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
  | 'generic-agent'

export interface AgentInfo {
  id: AgentKind
  displayName: string
  /** lucide-react icon name used by the renderer's agent chrome. */
  icon: string
}

export const AGENTS: Record<AgentKind, AgentInfo> = {
  'claude-code': { id: 'claude-code', displayName: 'Claude Code', icon: 'Sparkles' },
  codex: { id: 'codex', displayName: 'OpenAI Codex', icon: 'Braces' },
  opencode: { id: 'opencode', displayName: 'opencode', icon: 'TerminalSquare' },
  aider: { id: 'aider', displayName: 'Aider', icon: 'Bot' },
  'gemini-cli': { id: 'gemini-cli', displayName: 'Gemini CLI', icon: 'Stars' },
  'generic-agent': { id: 'generic-agent', displayName: 'AI Agent', icon: 'Bot' },
}

/** A detection verdict for a single terminal, emitted only when it changes. */
export interface AgentVerdict {
  active: boolean
  kind: AgentKind | null
  displayName?: string
  /** 0..1 — process-tree match ~0.8, fused with output banner up to 0.95. */
  confidence: number
  source?: 'process-tree' | 'output-heuristic' | 'fused'
}

export const NO_AGENT: AgentVerdict = { active: false, kind: null, confidence: 0 }
