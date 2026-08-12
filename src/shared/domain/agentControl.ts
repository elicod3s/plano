/**
 * agentControl (plan v3 D2): the ONLY legitimate ways to drive another agent's CLI —
 * the slash commands and keypresses each harness actually offers. Anything not in this
 * table is explicitly unsupported: inventing syntax for another CLI is how sessions
 * break (and how commands get injected). Writing to a PTY is executing code on the
 * user's machine, so model ids are additionally validated in the bus (see validateModel).
 */

import type { AgentKind } from './agent'

export interface HarnessControl {
  /** Slash command template to switch models ('{model}' is substituted), or null. */
  setModel: string | null
  /** Bytes to interrupt the current turn (Esc / Ctrl-C, per harness). */
  interrupt: string[] | null
  /** Slash command to compact the session, or null. */
  compact: string | null
}

export const HARNESS_CONTROL: Record<AgentKind, HarnessControl> = {
  'claude-code': { setModel: '/model {model}', interrupt: ['\x1b'], compact: '/compact' },
  codex: { setModel: '/model {model}', interrupt: ['\x03'], compact: null },
  'gemini-cli': { setModel: '/model {model}', interrupt: ['\x03'], compact: null },
  opencode: { setModel: null, interrupt: ['\x03'], compact: null },
  aider: { setModel: null, interrupt: ['\x03'], compact: null },
  cursor: { setModel: null, interrupt: ['\x03'], compact: null },
  'kiro-cli': { setModel: null, interrupt: ['\x03'], compact: null },
  // Grok Build CLI — the slash-mru shows a `model` command; interrupt key is unverified so
  // it stays unsupported (never invent control syntax for another CLI).
  grok: { setModel: '/model {model}', interrupt: null, compact: null },
  omp: { setModel: null, interrupt: ['\x03'], compact: null },
  pi: { setModel: null, interrupt: ['\x03'], compact: null },
  hermes: { setModel: null, interrupt: ['\x03'], compact: null },
  'generic-agent': { setModel: null, interrupt: ['\x03'], compact: null },
}

/** Strict model-id syntax: letters, digits, `.` `_` `:` `/` `-` only. Anything else
 *  (spaces, `;`, `&&`, `|`, `$`, backticks, newlines) is rejected as injection. */
export const MODEL_SYNTAX_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:\/-]{0,127}$/

/** Per-harness model families for the "known model" check (kept loose on purpose —
 *  families, not a frozen snapshot of ids, so new models don't break the tool). */
export const MODEL_FAMILIES: Partial<Record<AgentKind, RegExp>> = {
  'claude-code': /^(sonnet|opus|haiku|claude-(sonnet|opus|haiku)-\d[\w.-]*)/i,
  codex: /^(gpt-\d[\w.-]*|o\d[\w.-]*)/i,
  'gemini-cli': /^gemini-\d+(\.\d+)?-[\w-]+/i,
}
