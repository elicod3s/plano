/**
 * Harness launch commands (promoted from AgentLauncher.tsx — plan F6): the mesh's
 * `plano_spawn_agent` uses this table to boot a harness in a fresh terminal. Shared so the
 * renderer launcher and the daemon agree on one command per harness.
 */

import type { AgentKind } from './agent'

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

/**
 * The AgentKind a spawn REQUEST is for, so the roster can report what the user launched rather
 * than the engine it turned out to wrap.
 *
 * `plano spawn omp` opens an omp window, but omp boots the `codex` engine as its brain, and the
 * omp launcher process then exits — leaving only a codex process in the tree. Process-tree
 * detection can therefore only ever see `codex`, so the roster reported `codex` for a worker the
 * user deliberately created as `omp`. That is only cosmetic until a coordinator routes work by
 * capability, at which point it is a lie. The spawn label is the ground truth for what a session
 * IS; detection is the fallback for terminals PLANO did not launch.
 *
 * Only the harness NAMES differ from AgentKind (claude → claude-code, kiro → kiro-cli, …); the
 * command table above is the single list of spawnable names, so this maps that list to kinds.
 */
const HARNESS_KIND: Record<string, AgentKind> = {
  claude: 'claude-code',
  codex: 'codex',
  pi: 'pi',
  omp: 'omp',
  kiro: 'kiro-cli',
  opencode: 'opencode',
  aider: 'aider',
  gemini: 'gemini-cli',
  cursor: 'cursor',
  grok: 'grok',
}

/** The AgentKind that `plano spawn <harness>` creates, or null for a harness we cannot name. */
export function kindForHarness(harness: string): AgentKind | null {
  return HARNESS_KIND[harness.trim().toLowerCase()] ?? null
}
