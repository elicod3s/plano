/**
 * PtyManager — owns every node-pty process and bridges it to the renderer.
 *
 * For each terminal it: spawns a ConPTY/PTY shell, streams output to the renderer AND
 * to AgentDetectionService (same bytes), forwards keystrokes/resizes, and tree-kills
 * cleanly on close. It is the source of each shell's PID (the root for agent detection).
 */

import { randomUUID } from 'node:crypto'
import type { IPty } from 'node-pty'
import { CH } from '@shared/ipc/channels'
import type { TerminalCreateRequest, TerminalCreateResult } from '@shared/ipc/contracts'
import type { AgentDetectionService } from './AgentDetectionService'

type Post = (channel: string, payload: unknown) => void

interface PtyDeps {
  post: Post
  detection: AgentDetectionService
}

interface PtyEntry {
  pty: IPty
  panelId: string
  shellName: string
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.PLANO_SHELL || 'powershell.exe'
  return process.env.SHELL || '/bin/bash'
}

/** node-pty wants a string→string env with no undefined values. */
function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') out[key] = value
  }
  out.TERM = 'xterm-256color'
  out.COLORTERM = 'truecolor'
  return out
}

/**
 * node-pty is a native module that must be built against Electron's ABI. We load it
 * lazily and tolerate failure so the whole app still launches if it hasn't been built
 * yet (e.g. `npm run rebuild` not run / no C++ build tools) — terminals then show guidance
 * instead of crashing the main process.
 */
type PtyModule = typeof import('node-pty')
let ptyModule: PtyModule | null = null
let ptyLoadError: string | null = null

function loadPty(): PtyModule | null {
  if (ptyModule) return ptyModule
  if (ptyLoadError) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ptyModule = require('node-pty') as PtyModule
    return ptyModule
  } catch (err) {
    ptyLoadError = err instanceof Error ? err.message : String(err)
    return null
  }
}

const PTY_UNAVAILABLE_MESSAGE =
  '\r\n\x1b[2m  PLANO — the terminal engine (node-pty) is not built for Electron yet.\r\n' +
  '  Run \x1b[0m\x1b[1mnpm run rebuild\x1b[0m\x1b[2m (requires the Visual Studio "Desktop development with C++" workload),\r\n' +
  '  then reopen this terminal.\x1b[0m\r\n'

export class PtyManager {
  private readonly entries = new Map<string, PtyEntry>()

  constructor(private readonly deps: PtyDeps) {}

  create(req: TerminalCreateRequest): TerminalCreateResult {
    const shell = req.shell || defaultShell()
    const shellName = (shell.split(/[\\/]/).pop() || shell).replace(/\.exe$/i, '')
    const ptyId = randomUUID()

    const mod = loadPty()
    if (!mod) {
      // Degrade gracefully: stream a guidance message, then report exit.
      queueMicrotask(() => {
        this.deps.post(CH.terminalData, { ptyId, data: PTY_UNAVAILABLE_MESSAGE })
        this.deps.post(CH.terminalExit, { ptyId, exitCode: 1 })
      })
      return { ptyId, pid: -1, shellName: 'unavailable' }
    }

    const pty = mod.spawn(shell, [], {
      name: 'xterm-256color',
      cols: Math.max(2, req.cols || 80),
      rows: Math.max(1, req.rows || 24),
      cwd: req.cwd || process.env.HOME || process.cwd(),
      env: cleanEnv(),
      // ConPTY on Windows 10 1809+; node-pty falls back automatically if unavailable.
      useConpty: process.platform === 'win32',
    })

    this.entries.set(ptyId, { pty, panelId: req.panelId, shellName })

    // Agent detection roots at this shell's PID; emit verdicts only on change.
    this.deps.detection.register(ptyId, pty.pid, (verdict) => {
      this.deps.post(CH.agentSignal, { ptyId, verdict })
    })

    pty.onData((data) => {
      this.deps.post(CH.terminalData, { ptyId, data })
      this.deps.detection.feed(ptyId, data)
    })

    pty.onExit(({ exitCode, signal }) => {
      this.deps.post(CH.terminalExit, { ptyId, exitCode, signal })
      this.deps.detection.unregister(ptyId)
      this.entries.delete(ptyId)
    })

    return { ptyId, pid: pty.pid, shellName }
  }

  write(ptyId: string, data: string): void {
    this.entries.get(ptyId)?.pty.write(data)
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const entry = this.entries.get(ptyId)
    if (!entry) return
    try {
      entry.pty.resize(Math.max(2, cols), Math.max(1, rows))
      this.deps.detection.ping(ptyId)
    } catch {
      /* resize can throw if the pty died between frames; ignore */
    }
  }

  ping(ptyId: string): void {
    this.deps.detection.ping(ptyId)
  }

  kill(ptyId: string): { ok: boolean } {
    const entry = this.entries.get(ptyId)
    if (!entry) return { ok: false }
    try {
      entry.pty.kill()
    } catch {
      /* already gone */
    }
    this.deps.detection.unregister(ptyId)
    this.entries.delete(ptyId)
    return { ok: true }
  }

  disposeAll(): void {
    for (const id of [...this.entries.keys()]) this.kill(id)
  }
}
