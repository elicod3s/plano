/**
 * agentHooks — turn boundaries straight from the harness, instead of guessed from the terminal.
 *
 * Every CLI that can run a command on its own lifecycle events is asked to tell us when a turn
 * STARTS, when it ENDS and when it is BLOCKED waiting for the user. That is the difference
 * between "the output went quiet for 4 seconds" (a guess that fires mid-turn on any CLI that
 * pauses for an API call) and "the agent said it finished". The same approach Orca takes with its
 * managed hooks — we have one advantage: every PTY already carries `PLANO_AGENT_ID`, so a hook
 * fired by a CLI inside a PLANO terminal attributes itself with no pane bookkeeping.
 *
 * Supported today:
 *   - Claude Code — `hooks` in ~/.claude/settings.json: UserPromptSubmit → working,
 *     Stop → idle, Notification → awaiting-input.
 *   - Codex — the `notify` program in config.toml, invoked with a JSON argument on turn end.
 * Anything else keeps the mesh's own busy detection, which stays the fallback for all of them.
 *
 * House rules, learned the hard way in this repo:
 *   - NEVER clobber a user's config. Hook arrays are APPENDED to (the user already has other
 *     tools' hooks in there); `notify` is only set when nothing owns it.
 *   - Scripts are ASCII + CRLF on Windows: cmd.exe re-seeks a .cmd by byte offset and LF-only
 *     endings make it resume mid-token.
 *   - A throwaway userData (probe/dev instance) never touches machine-wide config.
 *   - The script writes NOTHING to stdout: a Stop hook that prints can corrupt the CLI's own UI.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** Lifecycle moments we care about, normalized across harnesses. */
export type AgentHookEvent = 'turn-start' | 'turn-end' | 'awaiting-input'

export interface AgentHookPayload {
  event: AgentHookEvent
  /** The PLANO agent id (ptyId) the hook fired from, when the CLI passed our env through. */
  agentId: string
  /** The prompt the user submitted, on turn-start only. */
  prompt?: string
}

const HOOK_ENDPOINT = 'http://127.0.0.1:56780/agent/event'

/** True for a userData under the OS temp dir — a probe/dev instance, not the user's install. */
function isThrowaway(userData: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
  return norm(userData).startsWith(norm(tmpdir()))
}

/**
 * The Windows script. `%1` is the event name; the payload arrives on stdin (Claude) or as a
 * JSON argument (Codex, passed through as %2). Fire-and-forget: a hook that blocks would stall
 * the agent's own turn.
 */
const CMD_TEMPLATE = `@echo off
setlocal EnableExtensions
rem PLANO agent hook - reports turn boundaries to the Agent Host. Writes nothing to stdout.
if "%PLANO_AGENT_ID%"=="" goto :drain
set "PLANO_HOOK_PAYLOAD=%TEMP%\\plano-hook-%PLANO_AGENT_ID%.json"
if not "%~2"=="" (
  >"%PLANO_HOOK_PAYLOAD%" echo %~2
) else (
  findstr "^" > "%PLANO_HOOK_PAYLOAD%"
)
"%SystemRoot%\\System32\\curl.exe" -sS -m 3 -X POST "${HOOK_ENDPOINT}?event=%~1" -H "Content-Type: application/json" -H "X-Plano-Agent: %PLANO_AGENT_ID%" --data-binary "@%PLANO_HOOK_PAYLOAD%" >nul 2>&1
exit /b 0
:drain
if "%~2"=="" findstr "^" >nul 2>&1
exit /b 0
`

const SH_TEMPLATE = `#!/bin/sh
# PLANO agent hook - reports turn boundaries to the Agent Host. Writes nothing to stdout.
EVENT="$1"
if [ -z "$PLANO_AGENT_ID" ]; then [ -z "$2" ] && cat >/dev/null 2>&1; exit 0; fi
PAYLOAD="\${TMPDIR:-/tmp}/plano-hook-\${PLANO_AGENT_ID}.json"
if [ -n "$2" ]; then printf '%s' "$2" > "$PAYLOAD"; else cat > "$PAYLOAD"; fi
curl -sS -m 3 -X POST "${HOOK_ENDPOINT}?event=\${EVENT}" -H "Content-Type: application/json" -H "X-Plano-Agent: \${PLANO_AGENT_ID}" --data-binary "@\$PAYLOAD" >/dev/null 2>&1
exit 0
`

export interface AgentHookInstall {
  /** Harnesses whose config now points at our hook. */
  installed: string[]
  /** Harnesses we deliberately left alone, with the reason. */
  skipped: Array<{ harness: string; reason: string }>
}

function hookScriptPath(userData: string): string {
  return join(userData, 'bin', process.platform === 'win32' ? 'plano-agent-hook.cmd' : 'plano-agent-hook')
}

/**
 * The command a harness config invokes for `event`.
 *
 * Claude Code runs hooks through a POSIX shell — on Windows too (git-bash). `cmd /c "<path>"`
 * therefore does NOT reach cmd as written: the shell strips the quotes, cmd starts INTERACTIVE,
 * prints its banner and swallows the hook payload from stdin as if the user had typed it. The
 * fix is the shape Orca uses: invoke the script directly with forward slashes, guard on the file
 * existing, and drain stdin when it does not — a hook that leaves stdin unread can stall the CLI.
 */
function hookCommand(userData: string, event: AgentHookEvent): string {
  const script = hookScriptPath(userData).replace(/\\/g, '/')
  return `if [ -f '${script}' ]; then '${script}' ${event} >/dev/null 2>&1; else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi`
}

function writeScripts(userData: string): void {
  mkdirSync(join(userData, 'bin'), { recursive: true })
  const cmdPath = join(userData, 'bin', 'plano-agent-hook.cmd')
  const shPath = join(userData, 'bin', 'plano-agent-hook')
  writeFileSync(cmdPath, CMD_TEMPLATE.replace(/[^\x20-\x7E\n]/g, '').replace(/\n/g, '\r\n'), 'ascii')
  writeFileSync(shPath, SH_TEMPLATE, { encoding: 'utf8', mode: 0o755 })
}

/** Claude Code: append our command to the hook arrays we care about, never replacing theirs. */
function installClaude(userData: string): { ok: boolean; reason?: string } {
  const settingsPath = join(homedir(), '.claude', 'settings.json')
  if (!existsSync(join(homedir(), '.claude'))) return { ok: false, reason: 'not installed' }
  let doc: Record<string, unknown> = {}
  try {
    doc = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
  } catch {
    /* missing/corrupt — start from an empty document rather than throwing */
  }
  const hooks = (doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : {}) as Record<string, unknown>
  const wanted: Array<[string, AgentHookEvent]> = [
    ['UserPromptSubmit', 'turn-start'],
    ['Stop', 'turn-end'],
    ['Notification', 'awaiting-input'],
  ]
  let changed = false
  for (const [claudeEvent, ours] of wanted) {
    const command = hookCommand(userData, ours)
    const list = Array.isArray(hooks[claudeEvent]) ? ([...(hooks[claudeEvent] as unknown[])] as Record<string, unknown>[]) : []
    // Idempotent: our entry is recognised by the script path, so a re-install refreshes nothing.
    // Idempotent AND self-healing: an entry of ours whose command no longer matches the current
    // shape (an older, broken invocation) is rewritten rather than left behind.
    const ourEntries = list.filter((entry) =>
      (Array.isArray(entry?.hooks) ? (entry.hooks as Record<string, unknown>[]) : []).some(
        (h) => typeof h?.command === 'string' && h.command.includes('plano-agent-hook'),
      ),
    )
    if (ourEntries.length === 1 && JSON.stringify(ourEntries[0]) === JSON.stringify({ hooks: [{ type: 'command', command, timeout: 5 }] })) {
      continue
    }
    const others = list.filter((entry) => !ourEntries.includes(entry))
    others.push({ hooks: [{ type: 'command', command, timeout: 5 }] })
    hooks[claudeEvent] = others
    changed = true
  }
  if (!changed) return { ok: true }
  doc.hooks = hooks
  writeFileSync(settingsPath, JSON.stringify(doc, null, 2), 'utf8')
  return { ok: true }
}

/** Codex: `notify` runs a program with a JSON argument when a turn ends. One owner only. */
function installCodex(userData: string): { ok: boolean; reason?: string } {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex')
  const configPath = join(home, 'config.toml')
  if (!existsSync(home)) return { ok: false, reason: 'not installed' }
  let toml = ''
  try {
    toml = readFileSync(configPath, 'utf8')
  } catch {
    toml = ''
  }
  if (/plano-agent-hook/.test(toml)) return { ok: true }
  // Someone else already owns `notify` (this machine ships one) — leave it: overwriting would
  // silently break their tool. Codex keeps the mesh detector.
  if (/^\s*notify\s*=/m.test(toml)) return { ok: false, reason: 'another notify program is configured' }
  const script = hookScriptPath(userData).replace(/\\/g, '\\\\')
  const line = `notify = ["${process.platform === 'win32' ? 'cmd' : script}"${process.platform === 'win32' ? `, "/c", "${script}"` : ''}, "turn-end"]\n`
  writeFileSync(configPath, `${toml.replace(/\s*$/, '')}\n${line}`, 'utf8')
  return { ok: true }
}

/**
 * Gemini CLI: `~/.gemini/settings.json` carries a `hooks` map of event → command list, the same
 * shape Claude uses. Written only when the config dir exists, appended never replaced.
 */
function installGemini(userData: string): { ok: boolean; reason?: string } {
  const dir = join(homedir(), '.gemini')
  if (!existsSync(dir)) return { ok: false, reason: 'not installed' }
  const settingsPath = join(dir, 'settings.json')
  let doc: Record<string, unknown> = {}
  try {
    doc = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
  } catch {
    /* missing/corrupt — start from an empty document */
  }
  const hooks = (doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : {}) as Record<string, unknown>
  let changed = false
  for (const [event, ours] of [
    ['UserPromptSubmit', 'turn-start'],
    ['Stop', 'turn-end'],
    ['Notification', 'awaiting-input'],
  ] as Array<[string, AgentHookEvent]>) {
    const command = hookCommand(userData, ours)
    const list = Array.isArray(hooks[event]) ? ([...(hooks[event] as unknown[])] as Record<string, unknown>[]) : []
    const mine = list.filter((e) =>
      (Array.isArray(e?.hooks) ? (e.hooks as Record<string, unknown>[]) : []).some(
        (h) => typeof h?.command === 'string' && h.command.includes('plano-agent-hook'),
      ),
    )
    if (mine.length === 1 && JSON.stringify(mine[0]) === JSON.stringify({ hooks: [{ type: 'command', command }] })) continue
    const others = list.filter((e) => !mine.includes(e))
    others.push({ hooks: [{ type: 'command', command }] })
    hooks[event] = others
    changed = true
  }
  if (!changed) return { ok: true }
  doc.hooks = hooks
  writeFileSync(settingsPath, JSON.stringify(doc, null, 2), 'utf8')
  return { ok: true }
}

/**
 * OpenCode: `~/.config/opencode/opencode.json` supports `experimental.hook` with
 * `session_completed` / `session_idle` style entries ({ command: [...] }). Only the completion
 * hook is wired — a turn boundary is all we need — and only when nothing of ours is there yet.
 */
function installOpenCode(userData: string): { ok: boolean; reason?: string } {
  const dir = join(homedir(), '.config', 'opencode')
  if (!existsSync(dir)) return { ok: false, reason: 'not installed' }
  const configPath = join(dir, 'opencode.json')
  let doc: Record<string, unknown> = {}
  try {
    doc = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  } catch {
    /* missing/corrupt — start from an empty document */
  }
  const experimental = (doc.experimental && typeof doc.experimental === 'object' ? doc.experimental : {}) as Record<string, unknown>
  const hook = (experimental.hook && typeof experimental.hook === 'object' ? experimental.hook : {}) as Record<string, unknown>
  const script = hookScriptPath(userData)
  const entry = { command: [script, 'turn-end'] }
  const existing = Array.isArray(hook.session_completed) ? (hook.session_completed as Record<string, unknown>[]) : []
  if (existing.some((e) => JSON.stringify(e) === JSON.stringify(entry))) return { ok: true }
  hook.session_completed = [...existing.filter((e) => !JSON.stringify(e).includes('plano-agent-hook')), entry]
  experimental.hook = hook
  doc.experimental = experimental
  writeFileSync(configPath, JSON.stringify(doc, null, 2), 'utf8')
  return { ok: true }
}

/** Install the hook script + wire it into every harness that supports lifecycle commands. */
export function installAgentHooks(userData: string): AgentHookInstall {
  const installed: string[] = []
  const skipped: Array<{ harness: string; reason: string }> = []
  try {
    writeScripts(userData)
  } catch (err) {
    return { installed, skipped: [{ harness: 'all', reason: `script write failed: ${String(err)}` }] }
  }
  if (isThrowaway(userData)) {
    return { installed, skipped: [{ harness: 'all', reason: 'throwaway userData — machine config left untouched' }] }
  }
  for (const [harness, install] of [
    ['claude', installClaude],
    ['codex', installCodex],
    ['gemini', installGemini],
    ['opencode', installOpenCode],
  ] as const) {
    try {
      const r = install(userData)
      if (r.ok) installed.push(harness)
      else skipped.push({ harness, reason: r.reason ?? 'unavailable' })
    } catch (err) {
      skipped.push({ harness, reason: String(err) })
    }
  }
  return { installed, skipped }
}

/** Normalize an incoming hook request into the event we act on. Never throws. */
export function parseHookRequest(eventParam: string, agentId: string, body: string): AgentHookPayload | null {
  if (!agentId) return null
  const event: AgentHookEvent | null =
    eventParam === 'turn-start' || eventParam === 'turn-end' || eventParam === 'awaiting-input' ? eventParam : null
  if (!event) return null
  let prompt: string | undefined
  try {
    const doc = JSON.parse(body) as Record<string, unknown>
    const raw = doc.prompt ?? doc.message ?? doc.user_prompt
    if (typeof raw === 'string' && raw.trim()) prompt = raw.trim().slice(0, 400)
  } catch {
    /* a hook body we cannot parse still carries a valid event in its URL */
  }
  return { event, agentId, prompt }
}
