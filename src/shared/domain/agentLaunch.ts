/**
 * Harness launch commands (promoted from AgentLauncher.tsx — plan F6): the mesh's
 * `plano_spawn_agent` uses this table to boot a harness in a fresh terminal. Shared so the
 * renderer launcher and the daemon agree on one command per harness.
 */

export const AGENT_LAUNCH_COMMANDS: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  pi: 'pi',
  // Oh My Pi — the community fork of Pi, its own CLI (`omp`, @oh-my-pi/pi-coding-agent).
  omp: 'omp',
  kiro: 'kiro-cli chat',
  opencode: 'opencode',
  aider: 'aider',
  gemini: 'gemini',
  cursor: 'cursor-agent',
  // Grok Build (x.ai) — a native Rust TUI at ~/.grok/bin/grok.exe, which its installer puts
  // on PATH. Everything else about grok was already wired (kind, capabilities, control,
  // resume, brand mark); only this row was missing, so `plano spawn grok` failed with
  // "unknown harness" while the UI happily showed Grok panels.
  grok: 'grok',
}

/** The shell command that boots `harness`, or null when the harness is unknown. */
export function launchCommandFor(harness: string): string | null {
  const key = harness.trim().toLowerCase()
  return AGENT_LAUNCH_COMMANDS[key] ?? null
}
