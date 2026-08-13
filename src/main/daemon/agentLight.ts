/**
 * agentLight — lightweight agent detection for the Agent Host.
 *
 * When PLANO is CLOSED, the app's rich detector (AgentDetectionService, in the main process)
 * doesn't run — but the host still owns every session, so the mobile web app needs to know which
 * terminals are running an AI coding CLI. This is the same signature table + descendant-process
 * matching, minus the output-banner fusion and hysteresis: match the shell's process tree once
 * per poll and report kind + pid. Cheap (one shared snapshot per poll), never throws.
 */

import type { AgentKind, AgentPhase } from '@shared/domain/agent'
import { ProcessTreeService } from '../services/ProcessTreeService'
import { normalizeTerminalText } from '../services/terminalText'

interface Signature {
  id: AgentKind
  names: RegExp
  cmd: RegExp
}

/** Same table as AgentDetectionService (kept in sync by hand — the load-bearing names/cmd). */
const SIGS: Signature[] = [
  {
    id: 'claude-code',
    names: /^(claude(-code)?(\.exe)?|node(\.exe)?)$/i,
    cmd: /(^|[\\/\s])claude(-code)?(\.exe)?\b|node_modules[\\/]@anthropic-ai[\\/]claude-code|claude-code[\\/].*cli\.js/i,
  },
  {
    id: 'codex',
    // codex ≥ 0.147 runs its own renamed Node runtime (node_repl.exe) under
    // <…>\OpenAI\Codex\runtimes\ — without it, a live codex session stays undetected.
    names: /^(codex(\.exe)?|node(\.exe)?|node_repl(\.exe)?)$/i,
    cmd: /(^|[\\/\s])codex(\.exe)?\b|node_modules[\\/].*codex.*[\\/].*\.js|[\\/](OpenAI[\\/])?[Cc]odex[\\/]/i,
  },
  {
    id: 'opencode',
    names: /^(opencode(\.exe)?|bun(\.exe)?|node(\.exe)?)$/i,
    cmd: /(^|[\\/\s])opencode(\.exe)?\b|node_modules[\\/]opencode-ai/i,
  },
  {
    id: 'aider',
    names: /^(aider(\.exe)?|python(3|w)?(\.exe)?)$/i,
    cmd: /(^|[\\/\s])aider(\.exe)?\b|-m\s+aider\b|[\\/]aider[\\/]/i,
  },
  {
    id: 'gemini-cli',
    names: /^(gemini(\.exe)?|node(\.exe)?)$/i,
    cmd: /(^|[\\/\s])gemini(\.exe)?\b|node_modules[\\/]@google[\\/]gemini-cli/i,
  },
  {
    id: 'cursor',
    names: /^(cursor-agent(\.exe)?|node(\.exe)?)$/i,
    cmd: /(^|[\\/\s])cursor-agent(\.exe)?\b|[\\/]cursor-agent[\\/]/i,
  },
  {
    id: 'kiro-cli',
    names: /^(kiro-cli(\.exe)?|bun(\.exe)?)$/i,
    cmd: /(^|[\\/\s])kiro-cli(\.exe)?\b|[\\/]Kiro-Cli[\\/]|[\\/]tui\.js\b/i,
  },
  {
    // Oh My Pi — fork of Pi (omp → @oh-my-pi/pi-coding-agent). Before pi: both share the
    // pi-coding-agent path; the @oh-my-pi scope is the load-bearing disambiguator.
    id: 'omp',
    names: /^(omp(\.exe)?|node(\.exe)?|bun(\.exe)?)$/i,
    cmd: /(^|[\\/\s])omp(\.exe)?(\s|$)|@oh-my-pi[\\/]|[\\/]oh-my-pi[\\/]/i,
  },
  {
    id: 'pi',
    names: /^(pi(\.exe)?|node(\.exe)?|bun(\.exe)?)$/i,
    cmd: /(^|[\\/\s])pi(\.exe)?(\s|$)|@earendil-works[\\/]pi-coding-agent|[\\/]pi-coding-agent[\\/]/i,
  },
  {
    id: 'grok',
    names: /^(grok(\.exe)?)$/i,
    cmd: /(^|[\\/\s])grok(\.exe)?(\s|$)|[\\\/]\.grok[\\\/]bin[\\\/]grok(\.exe)?/i,
  },
  {
    id: 'hermes',
    names: /^(hermes(\.exe|\.cmd)?|python(3|w)?(\.exe)?|uv(\.exe)?)$/i,
    cmd: /(^|[\\/\s])hermes(\.exe|\.cmd)?(\s|$)|hermes_cli|(?:^|[\\/])hermes-agent[\\/]|python(?:3|w)?(?:[\\/]|\s+)-m\s+hermes_cli/i,
  },
]

export interface LightAgentResult {
  kind: AgentKind
  pid: number
  confidence: number
}

/**
 * Match the descendant processes of a shell against the signature table. Returns the first
 * (best) match or null. A shell that hosts the CLI is skipped by name (cmd.exe/powershell hosts
 * are never the match; the CLI's own process is).
 */
export function detectAgentKind(shellPid: number, procs: Map<number, import('../services/ProcessTreeService').Proc>): LightAgentResult | null {
  if (!shellPid || !procs || procs.size === 0) return null
  const descendants = ProcessTreeService.descendants(shellPid, procs)
  if (descendants.length === 0) return null
  for (const sig of SIGS) {
    for (const p of descendants) {
      const name = (p.name || '').split(/[\\/]/).pop() || p.name || ''
      if (!sig.names.test(name)) continue
      const cmd = p.cmd || ''
      if (!sig.cmd.test(cmd)) continue
      return { kind: sig.id, pid: p.pid, confidence: 0.8 }
    }
  }
  return null
}

/** Working while output flowed recently; idle once the stream goes quiet. */
export function lightPhase(lastOutputAt: number, now = Date.now()): AgentPhase {
  return now - lastOutputAt < 900 ? 'working' : 'idle'
}

// ── Plan v3 A2: honest busy detection ────────────────────────────────────────
// "Busy" is NOT "bytes flowed recently" — Claude Code and Codex repaint their UI
// (spinner, token counter, status bar) almost every frame while IDLE, which pinned
// busy=true and queued everything forever. Real signals, in order of reliability:
//   1. active worker processes under the agent CLI,
//   2. CONTENT change of the cleaned tail — a spinner repaints the SAME text, real
//      work changes it. normalizeTerminalText collapses \r redraws, so repaints of
//      the same line produce an identical fingerprint.
//   3. hysteresis: enter working instantly on change, leave after ~1.5 s of stable
//      content (same enter-fast/leave-slow pattern as AgentDetectionService).

export interface ActivityState {
  /** last time the cleaned tail fingerprint CHANGED */
  lastContentAt: number
  lastFingerprint: string
}

/** Leave working after this much stable content (hysteresis). */
export const ACTIVITY_LEAVE_MS = 1500

/**
 * v3 B: permission-prompt patterns in the CLEANED tail. When one matches, the agent is
 * blocked waiting for input — the most valuable state to expose. Conservative set: only
 * unambiguous permission/approval phrasings used by the harnesses.
 */
// eslint-disable-next-line no-control-regex
const AWAITING_INPUT_RE =
  /(do you want to (proceed|continue|allow|run|use|apply|write|edit)|allow\??\s*[(\[\uFF08]?\s*[yn]|approve\??|proceed\??|y\/n\??|permission (needed|required|denied)|needs (your )?(approval|permission)|press (enter|y|yes) to (continue|confirm|proceed))/i

/** True when the cleaned tail (last ~400 chars) shows an awaiting-input prompt. */
export function awaitingInput(tail: string): boolean {
  return AWAITING_INPUT_RE.test(tail.slice(-400))
}

/**
 * Composer states where Enter is not a trustworthy submit. Keep the harness wording in one
 * table: these are UI contracts, not generic terminal prose, and each entry needs evidence before
 * it is broadened. A match never authorizes typing; it only asks the guarded delivery path to
 * escape the state and re-check readiness first.
 */
const INPUT_EDIT_STATE_HINTS: ReadonlyArray<{
  kinds: ReadonlyArray<AgentKind>
  pattern: RegExp
  why: string
}> = [
  {
    kinds: ['codex'],
    // Codex after an interrupted/queued composer: the real incident left the mesh line here.
    pattern: /esc again to edit previous message/i,
    why: 'Codex edit-previous-message state',
  },
  {
    kinds: ['claude-code', 'pi', 'omp', 'gemini-cli', 'opencode', 'cursor', 'kiro-cli', 'aider', 'grok', 'hermes'],
    // Variants use the shorter form while a prior turn is available for editing.
    pattern: /esc(?:ape)?(?: again)? to (?:edit|revise)(?: the)? previous message/i,
    why: 'shared edit-previous-message hint',
  },
]

export interface InputEditState {
  editing: boolean
  reason?: string
}

/** Inspect only the rendered tail; raw repaint frames create false edit hints. */
export function inputEditState(tail: string, kind: AgentKind | 'unknown'): InputEditState {
  const recent = tail.slice(-1200)
  for (const hint of INPUT_EDIT_STATE_HINTS) {
    if (kind !== 'unknown' && !hint.kinds.includes(kind)) continue
    if (hint.pattern.test(recent)) return { editing: true, reason: hint.why }
  }
  return { editing: false }
}

/**
 * Live composer markers, by harness. Keep these narrow: arbitrary transcript text can start with
 * `>`, while a marker in the last rendered input region plus DECSET ?2004 is positive evidence
 * that the TUI has reopened its composer. This is shared by readiness and post-submit checking so
 * they cannot disagree about where the input box is.
 */
const INPUT_PROMPT_MARKERS: Partial<Record<AgentKind, RegExp>> = {
  'claude-code': /^[\s│┃╎┆┊┋╏╭╰┌└]*❯\s?/,
  codex: /^[\s│┃╎┆┊┋╏╭╰┌└]*›\s?/,
  pi: /^[\s│┃╎┆┊┋╏╭╰┌└]*[>›]\s?/,
  omp: /^[\s│┃╎┆┊┋╏╭╰┌└]*[>›]\s?/,
  'gemini-cli': /^[\s│┃╎┆┊┋╏╭╰┌└]*>\s?/,
  opencode: /^[\s│┃╎┆┊┋╏╭╰┌└]*>\s?/,
  cursor: /^[\s│┃╎┆┊┋╏╭╰┌└]*>\s?/,
  'kiro-cli': /^[\s│┃╎┆┊┋╏╭╰┌└]*>\s?/,
  aider: /^[\s│┃╎┆┊┋╏╭╰┌└]*>\s?/,
  grok: /^[\s│┃╎┆┊┋╏╭╰┌└]*>\s?/,
  hermes: /^[\s│┃╎┆┊┋╏╭╰┌└]*>\s?/,
}
const GENERIC_INPUT_PROMPT = /^[\s│┃╎┆┊┋╏╭╰┌└]*[›❯>]\s?/

/** Index of the last rendered composer row, or -1 when no supported prompt is visible. */
export function inputPromptRowIndex(rows: readonly string[], kind: AgentKind | 'unknown'): number {
  const marker = kind === 'unknown' ? GENERIC_INPUT_PROMPT : (INPUT_PROMPT_MARKERS[kind] ?? GENERIC_INPUT_PROMPT)
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (marker.test(rows[i])) return i
  }
  return -1
}

export function inputPromptVisible(tail: string, kind: AgentKind | 'unknown'): boolean {
  return inputPromptRowIndex(tail.split('\n').slice(-14), kind) >= 0
}

const HOST_SHELL_RE = /^(cmd|conhost|powershell|pwsh|windowsterminal|explorer)(\.exe)?$/i

/**
 * Cheap fingerprint of the CLEANED tail (≤ ~1200 chars, last chunks only). The cleaned
 * text of a repainting spinner is identical every poll; real output changes it.
 */
export function fingerprintTail(chunks: readonly string[]): string {
  let raw = ''
  for (const chunk of chunks.slice(-6)) raw += chunk
  raw = raw.slice(-1200)
  const clean = normalizeTerminalText(raw)
  let h = 0
  for (let i = 0; i < clean.length; i += 1) h = ((h << 5) - h + clean.charCodeAt(i)) | 0
  return String(h)
}

/** True when the agent CLI has active worker children (bash, node workers, git, rg…). */
export function hasActiveWorkers(shellPid: number, agentPid: number, procs: Map<number, import('../services/ProcessTreeService').Proc>): boolean {
  if (!shellPid || !agentPid || !procs || procs.size === 0) return false
  const descendants = ProcessTreeService.descendants(shellPid, procs)
  return descendants.some((p) => {
    if (p.pid === agentPid) return false
    const name = (p.name || '').split(/[\\/]/).pop() || p.name || ''
    return !HOST_SHELL_RE.test(name)
  })
}

/**
 * Compute the honest busy signal: content changed recently, or the agent has active
 * workers. State is threaded through (per-session) so the hysteresis window survives
 * across polls. Never throws; missing state starts fresh.
 */
export function computeBusy(
  buffer: readonly string[],
  workersActive: boolean,
  state: ActivityState | null,
  now = Date.now(),
): { busy: boolean; state: ActivityState } {
  const st = state ?? { lastContentAt: 0, lastFingerprint: '' }
  const fp = fingerprintTail(buffer)
  if (fp !== st.lastFingerprint) {
    st.lastFingerprint = fp
    st.lastContentAt = now
  }
  return { busy: workersActive || now - st.lastContentAt < ACTIVITY_LEAVE_MS, state: st }
}
