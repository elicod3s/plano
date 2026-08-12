/**
 * TerminalHistoryService — remembers the "resume" command an AI CLI prints when it exits
 * (e.g. Claude Code's `claude --resume <id>`) so the predictive-history feature can suggest
 * it later, exactly like a command the user typed.
 *
 * Those lines are program OUTPUT, not user input, so the shell never records them in its own
 * history — predictions would never surface them. We sniff the same PTY byte stream the
 * renderer receives and, on a match, remember the command two ways:
 *   1. append it to PSReadLine's history file → predicted in any NEW terminal + persisted to
 *      disk (PSReadLine loads that file at startup);
 *   2. drop it into a per-session "pending" file that the shell's OnIdle handler drains into
 *      the LIVE session's in-memory history → predicted in the SAME terminal, instantly
 *      (the handler is registered by PS_PREDICTIVE_INIT in PtyManager).
 *
 * Gated by the `predictiveHistory` setting and only active for PowerShell-family shells
 * (the only ones with a PSReadLine history file + the OnIdle drain).
 */

import { appendFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

interface HistEntry {
  /** Rolling, ANSI-stripped, whitespace-collapsed window of recent output. */
  buf: string
  /** PSReadLine history file for this shell's host (null = unknown host). */
  histPath: string
  /** Per-session handoff file the OnIdle drain reads (keyed by the shell PID). */
  pendingPath: string
}

// e.g.  Resume this session with:  claude --resume b122d6d9-e738-4322-b87e-95731ed0ecaf
const RESUME_RE =
  /\bclaude\s+--resume\s+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/g

// Hermes prints its own resume hint on exit. Only SAFE forms are captured: the bare
// `hermes --continue` (no interpolation at all), and `hermes --resume <id>` where the id
// is strictly bounded ASCII (letters, digits, hyphens, underscores, ≤64 chars) — never
// free-form titles with spaces.
const HERMES_RESUME_RE =
  /\bhermes(?:\s+--continue|\s+--resume\s+([A-Za-z0-9_-]{1,64}))\b/g

// SGR/CSI sequences and OSC strings the shell paints around the text.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[\]P][^\x07\x1b]*(?:\x07|\x1b\\)?/g

/** PSReadLine's per-host history file — where a new terminal loads predictions from. */
function historyFileFor(shellName: string): string | null {
  const appData = process.env.APPDATA
  if (!appData) return null
  switch (shellName.toLowerCase()) {
    case 'pwsh':
      return join(appData, 'Microsoft', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt')
    case 'powershell':
      return join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt')
    default:
      return null
  }
}

export class TerminalHistoryService {
  private readonly entries = new Map<string, HistEntry>()
  /** Commands already captured this app session — never remember the same one twice. */
  private readonly seen = new Set<string>()

  register(ptyId: string, shellName: string, shellPid: number, enabled: boolean): void {
    if (!enabled) return
    const histPath = historyFileFor(shellName)
    if (!histPath) return // non-PowerShell shells have no PSReadLine history / OnIdle drain
    this.entries.set(ptyId, {
      buf: '',
      histPath,
      pendingPath: join(tmpdir(), `plano_pending_history_${shellPid}.txt`),
    })
  }

  feed(ptyId: string, data: string): void {
    const e = this.entries.get(ptyId)
    if (!e) return
    // Normalise so a match survives chunk boundaries and the "Resume this session with:\n…"
    // line break, then keep only a small trailing window.
    e.buf = (e.buf + data.replace(ANSI_RE, '')).replace(/\s+/g, ' ').slice(-4096)
    RESUME_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = RESUME_RE.exec(e.buf)) !== null) {
      const cmd = `claude --resume ${m[1]}`
      if (this.seen.has(cmd)) continue
      this.seen.add(cmd)
      void this.remember(e, cmd)
    }
    HERMES_RESUME_RE.lastIndex = 0
    while ((m = HERMES_RESUME_RE.exec(e.buf)) !== null) {
      const cmd = m[1] ? `hermes --resume ${m[1]}` : 'hermes --continue'
      if (this.seen.has(cmd)) continue
      this.seen.add(cmd)
      void this.remember(e, cmd)
    }
  }

  private async remember(e: HistEntry, cmd: string): Promise<void> {
    try {
      await mkdir(dirname(e.histPath), { recursive: true })
      await appendFile(e.histPath, cmd + '\n', 'utf8') // future terminals + persistence
    } catch {
      /* history file unwritable — non-fatal */
    }
    try {
      await appendFile(e.pendingPath, cmd + '\n', 'utf8') // live session's OnIdle drain
    } catch {
      /* pending file unwritable — same-session injection just won't fire */
    }
  }

  unregister(ptyId: string): void {
    const e = this.entries.get(ptyId)
    if (!e) return
    this.entries.delete(ptyId)
    void rm(e.pendingPath, { force: true }).catch(() => undefined) // don't litter %TEMP%
  }
}
