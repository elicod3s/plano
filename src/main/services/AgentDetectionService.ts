/**
 * AgentDetectionService — the signature feature.
 *
 * For each terminal, fuse two signals and decide if an AI coding CLI is running:
 *   PRIMARY  (authoritative): the descendant process tree of OUR shell PID, matched on
 *            image name AND command line against a small signature table.
 *   SECONDARY (instant hint): a rolling tail of the PTY output, matched against banners.
 *
 * Hysteresis makes it feel solid: quick to ENTER (a process match enters on first hit),
 * sticky to LEAVE (matched PID gone + grace window) so an agent shelling out to `git`
 * doesn't flap the chrome. The renderer is notified ONLY when the verdict changes.
 */

import type { AgentKind, AgentPhase, AgentVerdict } from '@shared/domain/agent'
import { NO_AGENT } from '@shared/domain/agent'
import type { TerminalProcessInfo } from '@shared/ipc/contracts'
import { ProcessTreeService, type Proc } from './ProcessTreeService'

interface Signature {
  id: AgentKind
  displayName: string
  /** image base-name matcher (incl. the interpreter hosts the CLI may run under) */
  names: RegExp
  /** full command-line matcher — the load-bearing signal on Windows */
  cmd: RegExp
  /** output banner matcher (secondary hint) */
  banner: RegExp
}

const SIGS: Signature[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    names: /^(claude(-code)?(\.exe)?|node(\.exe)?)$/i,
    cmd: /(^|[\\/\s])claude(-code)?(\.exe)?\b|node_modules[\\/]@anthropic-ai[\\/]claude-code|claude-code[\\/].*cli\.js/i,
    banner: /Claude Code|@anthropic-ai\/claude-code|Welcome to Claude/i,
  },
  {
    id: 'codex',
    displayName: 'OpenAI Codex',
    names: /^(codex(\.exe)?|node(\.exe)?)$/i,
    cmd: /(^|[\\/\s])codex(\.exe)?\b|node_modules[\\/].*codex.*[\\/].*\.js/i,
    banner: /OpenAI Codex|Codex CLI/i,
  },
  {
    id: 'opencode',
    displayName: 'opencode',
    names: /^(opencode(\.exe)?|bun(\.exe)?|node(\.exe)?)$/i,
    cmd: /(^|[\\/\s])opencode(\.exe)?\b|node_modules[\\/]opencode-ai/i,
    banner: /\bopencode\b|sst\/opencode/i,
  },
  {
    id: 'aider',
    displayName: 'Aider',
    names: /^(aider(\.exe)?|python(3|w)?(\.exe)?)$/i,
    cmd: /(^|[\\/\s])aider(\.exe)?\b|-m\s+aider\b|[\\/]aider[\\/]/i,
    banner: /aider v\d|https:\/\/aider\.chat/i,
  },
  {
    id: 'gemini-cli',
    displayName: 'Gemini CLI',
    names: /^(gemini(\.exe)?|node(\.exe)?)$/i,
    cmd: /(^|[\\/\s])gemini(\.exe)?\b|node_modules[\\/]@google[\\/]gemini-cli/i,
    banner: /Gemini CLI|@google\/gemini-cli/i,
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    names: /^(cursor-agent(\.exe)?|node(\.exe)?)$/i,
    cmd: /(^|[\\/\s])cursor-agent(\.exe)?\b|[\\/]cursor-agent[\\/]/i,
    banner: /Cursor Agent|\bcursor-agent\b/i,
  },
  {
    // Kiro CLI is a bun TUI: `kiro-cli.exe` launches `bun` running `tui.js` from
    // …\AppData\Local\Kiro-Cli\. The cmd marker is the load-bearing Windows signal.
    id: 'kiro-cli',
    displayName: 'Kiro CLI',
    names: /^(kiro-cli(\.exe)?|bun(\.exe)?)$/i,
    cmd: /(^|[\\/\s])kiro-cli(\.exe)?\b|[\\/]Kiro-Cli[\\/]|[\\/]tui\.js\b/i,
    banner: /Kiro CLI|kiro\.dev|\bKiro\b/i,
  },
]

const SHELLS = /^(pwsh|powershell|cmd|conhost|bash|zsh|sh|fish|wsl|winpty-agent|node-pty)(\.exe)?$/i
const HOSTS = /^(node|python(3|w)?|bun|deno)(\.exe)?$/i
const TAIL_MAX = 4096
const EXIT_GRACE_MS = 2500
// Output seen within this window ⇒ the agent is "working"; quiet longer ⇒ "idle"/done.
// Kept below the active heartbeat (1500ms) so one heartbeat after output stops flips to idle.
const WORKING_WINDOW_MS = 900

const baseName = (p: string): string => (p || '').split(/[\\/]/).pop() || p

class TerminalDetector {
  private tail = ''
  private state: AgentVerdict = { ...NO_AGENT }
  private streak = 0
  private lastSeen = 0
  private lastOutputAt = 0
  private timer: NodeJS.Timeout | null = null
  private running = false
  private disposed = false

  constructor(
    private readonly rootPid: number,
    private readonly tree: ProcessTreeService,
    private readonly emit: (verdict: AgentVerdict) => void,
  ) {}

  onData(chunk: string): void {
    this.tail = (this.tail + chunk).slice(-TAIL_MAX)
    // Output just arrived — used to tell "working" (streaming) from "idle" (awaiting input).
    this.lastOutputAt = Date.now()
    // A newline usually means a command was just submitted — check sooner.
    this.schedule(/\r?\n/.test(chunk) ? 60 : 250)
  }

  ping(): void {
    this.schedule(120)
  }

  /** The latest verdict (used to re-sync a panel that reattaches after a space switch). */
  verdict(): AgentVerdict {
    return this.state
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(delay: number): void {
    if (this.disposed || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.evaluate()
    }, delay)
  }

  private bannerHit(): Signature | null {
    return SIGS.find((s) => s.banner.test(this.tail)) ?? null
  }

  private async processHit(): Promise<{ sig: Signature; pid: number; depth: number } | null> {
    const map = await this.tree.ensureFresh()
    const descendants = ProcessTreeService.descendants(this.rootPid, map)
    if (descendants.length === 0) return null

    let best: { sig: Signature; pid: number; depth: number } | null = null
    for (const proc of descendants) {
      const name = baseName(proc.name)
      if (SHELLS.test(name)) continue
      const hostOnly = HOSTS.test(name)
      for (const sig of SIGS) {
        const nameOk = sig.names.test(name)
        const cmdOk = !!proc.cmd && sig.cmd.test(proc.cmd)
        // A bare node/python host counts ONLY if its command line carries an agent
        // marker; a native exe (claude.exe/codex.exe) is trusted on the name alone.
        const hit = cmdOk || (nameOk && !hostOnly)
        if (!hit) continue
        const depth = ProcessTreeService.depth(proc.pid, this.rootPid, map)
        if (!best || depth < best.depth) best = { sig, pid: proc.pid, depth }
      }
    }
    return best
  }

  /**
   * The agent process(es) actually running under this shell — matched with the SAME
   * signature rules as detection, so the list shows exactly what turned the panel into
   * agent mode (the CLI), never the surrounding shell/OS noise that a raw descendant
   * walk would surface (cmd.exe wrappers, PID-reuse orphans, etc.).
   */
  async matchedProcesses(): Promise<TerminalProcessInfo[]> {
    const map = await this.tree.ensureFresh()
    const descendants = ProcessTreeService.descendants(this.rootPid, map)
    const out: TerminalProcessInfo[] = []
    for (const proc of descendants) {
      const name = baseName(proc.name)
      if (SHELLS.test(name)) continue
      const hostOnly = HOSTS.test(name)
      const hit = SIGS.some((sig) => {
        const cmdOk = !!proc.cmd && sig.cmd.test(proc.cmd)
        const nameOk = sig.names.test(name)
        return cmdOk || (nameOk && !hostOnly)
      })
      if (hit) out.push({ pid: proc.pid, name: proc.name, cmd: proc.cmd })
    }
    return out
  }

  /** The matched agent CLI process running under this shell (kind + pid), via the SAME
   *  signature rules as detection — so the session resolver reuses one table, never a copy. */
  async matchedAgent(): Promise<{ kind: AgentKind; pid: number } | null> {
    const hit = await this.processHit()
    return hit ? { kind: hit.sig.id, pid: hit.pid } : null
  }

  private async evaluate(): Promise<void> {
    if (this.disposed || this.running) return
    this.running = true
    try {
      const proc = await this.processHit()
      const banner = this.bannerHit()

      let score = 0
      let kind: AgentKind | undefined
      let displayName: string | undefined
      let source: AgentVerdict['source'] = 'process-tree'

      if (proc) {
        score = 0.8
        kind = proc.sig.id
        displayName = proc.sig.displayName
      }
      if (banner) {
        if (banner.id === kind) {
          score = 0.95
          source = 'fused'
        } else if (!proc) {
          score = Math.max(score, 0.4)
          kind = banner.id
          displayName = banner.displayName
          source = 'output-heuristic'
        }
      }

      const now = Date.now()
      if (!this.state.active) {
        this.streak = score >= 0.7 ? this.streak + 1 : 0
        const enter = (proc && score >= 0.8) || (score >= 0.7 && this.streak >= 2)
        if (enter && kind) {
          this.lastSeen = now
          this.setState({ active: true, kind, displayName, confidence: score, source, phase: this.phase(now) })
        }
      } else {
        const sameAgentAlive = proc && this.state.kind === proc.sig.id
        if (sameAgentAlive || banner) this.lastSeen = now

        if (proc && kind && kind !== this.state.kind && score >= 0.8) {
          // Switch agent (e.g. claude → aider) without dropping to "none".
          this.setState({ active: true, kind, displayName, confidence: score, source, phase: this.phase(now) })
        } else if (now - this.lastSeen > EXIT_GRACE_MS) {
          this.streak = 0
          this.setState({ ...NO_AGENT })
        } else {
          // Same agent still running — just refresh the working/idle phase (emits only on flip).
          this.setState({ ...this.state, phase: this.phase(now) })
        }
      }

      // Keep a slow heartbeat while interesting; idle terminals schedule nothing.
      if (this.state.active) this.schedule(1500)
      else if (score > 0) this.schedule(800)
    } finally {
      this.running = false
    }
  }

  /** working while output flowed recently; idle once the stream goes quiet (turn finished). */
  private phase(now: number): AgentPhase {
    return now - this.lastOutputAt < WORKING_WINDOW_MS ? 'working' : 'idle'
  }

  private setState(next: AgentVerdict): void {
    const changed =
      next.active !== this.state.active ||
      next.kind !== this.state.kind ||
      next.phase !== this.state.phase
    this.state = next
    if (changed) this.emit(next)
  }
}

export class AgentDetectionService {
  private readonly detectors = new Map<string, TerminalDetector>()

  // Share one snapshot provider with the rest of main (e.g. PtyManager.listProcesses)
  // so the cached process enumeration is reused instead of duplicated.
  constructor(private readonly tree: ProcessTreeService = new ProcessTreeService()) {}

  register(ptyId: string, pid: number, emit: (verdict: AgentVerdict) => void): void {
    // Pre-warm the (Windows) enumeration worker the moment a terminal exists, so its ~1.5s
    // PowerShell cold-start is paid in the background — not in the window where the user
    // launches an agent CLI and starts typing, where it used to stall both.
    this.tree.warm()
    this.detectors.set(ptyId, new TerminalDetector(pid, this.tree, emit))
  }

  /** Feed raw PTY output (the same bytes we forward to xterm) for banner sniffing. */
  feed(ptyId: string, data: string): void {
    this.detectors.get(ptyId)?.onData(data)
  }

  /** Nudge a re-check on focus / resize / visibility-gained. */
  ping(ptyId: string): void {
    this.detectors.get(ptyId)?.ping()
  }

  /** Current verdict for a terminal (NO_AGENT if unknown) — re-emitted on reattach. */
  currentVerdict(ptyId: string): AgentVerdict {
    return this.detectors.get(ptyId)?.verdict() ?? { ...NO_AGENT }
  }

  /** The agent CLI process(es) running under this terminal (for the close dialog). */
  listAgentProcesses(ptyId: string): Promise<TerminalProcessInfo[]> {
    return this.detectors.get(ptyId)?.matchedProcesses() ?? Promise.resolve([])
  }

  /** The single matched agent CLI (kind + pid) under this terminal — used by the session
   *  resolver to find the agent process whose conversation should be restored. */
  matchedAgentPid(ptyId: string): Promise<{ kind: AgentKind; pid: number } | null> {
    return this.detectors.get(ptyId)?.matchedAgent() ?? Promise.resolve(null)
  }

  unregister(ptyId: string): void {
    this.detectors.get(ptyId)?.dispose()
    this.detectors.delete(ptyId)
  }

  disposeAll(): void {
    for (const d of this.detectors.values()) d.dispose()
    this.detectors.clear()
    // Kill the shared enumeration worker so no PowerShell process is left orphaned on quit.
    this.tree.dispose()
  }
}

// (Proc is re-exported for tests/consumers that build snapshots directly.)
export type { Proc }
