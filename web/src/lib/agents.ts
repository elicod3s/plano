/** Agent CLI catalogue for the phone: launch commands + brand accents (mirrors the desktop). */

export interface AgentDef {
  id: string
  label: string
  /** Short monogram for the badge. */
  mark: string
  accent: string
  /** Base launch command (the daemon runs it inside the terminal shell). */
  command: string
  /** Add the no-approval flags when autoApprove is on. */
  autoApprove: (cmd: string) => string
}

const AA = (cmd: string): string => {
  const c = cmd.trim()
  if (/^claude(?:\s|$)/i.test(c)) return `${c} --dangerously-skip-permissions --permission-mode bypassPermissions`
  if (/^codex(?:\s|$)/i.test(c)) return `${c} --dangerously-bypass-approvals-and-sandbox`
  return c
}

export const AGENTS: AgentDef[] = [
  { id: 'claude-code', label: 'Claude Code', mark: 'C', accent: '#d97757', command: 'claude', autoApprove: AA },
  { id: 'codex', label: 'OpenAI Codex', mark: 'X', accent: '#4f8cf7', command: 'codex', autoApprove: AA },
  { id: 'gemini-cli', label: 'Gemini CLI', mark: 'G', accent: '#a855f7', command: 'gemini', autoApprove: AA },
  { id: 'kiro-cli', label: 'Kiro CLI', mark: 'K', accent: '#8b5cf6', command: 'kiro-cli chat', autoApprove: (c) => c },
  { id: 'pi', label: 'Pi', mark: 'π', accent: '#d8a95c', command: 'pi', autoApprove: (c) => c },
  { id: 'hermes', label: 'Hermes Agent', mark: 'H', accent: '#d6a85f', command: 'hermes --continue', autoApprove: (c) => c },
  { id: 'opencode', label: 'opencode', mark: 'o', accent: '#14b8a6', command: 'opencode', autoApprove: (c) => c },
  { id: 'aider', label: 'Aider', mark: 'A', accent: '#22c55e', command: 'aider', autoApprove: (c) => c },
  { id: 'cursor', label: 'Cursor', mark: 'Cu', accent: '#4f7cff', command: 'cursor-agent', autoApprove: (c) => c },
]

export function agentById(id: string | null): AgentDef | null {
  return AGENTS.find((a) => a.id === id) ?? null
}

/** Map a daemon-detected kind to a display row. */
export function agentRow(kind: string | null): { label: string; mark: string; accent: string } {
  if (!kind) return { label: 'Terminal', mark: '>', accent: '#9a9387' }
  const a = agentById(kind)
  return a ?? { label: kind, mark: 'AI', accent: '#ffffff' }
}
