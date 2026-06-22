/**
 * Restore an AI-agent conversation in a freshly-spawned terminal on workspace reopen.
 *
 * Mirrors the proven flow: build the resume command for the saved session, then GUARD it —
 * the shell must have actually landed in the saved cwd (resume is project-dir-scoped), and an
 * id-embedding command's conversation must still exist on disk — before writing it at the first
 * prompt. Any guard failing leaves a plain fresh shell (no error spam). Only ever runs in the
 * fresh-spawn path, never on a same-session reattach.
 */

import type { AgentSessionRef } from '@shared/domain/agent'
import { buildAgentResumeCommand } from '@shared/domain/agent'
import { usePanelStore } from '@/stores/usePanelStore'

const normCwd = (p: string): string => p.replace(/[/\\]+$/, '').replace(/\//g, '\\').toLowerCase()

interface ResumeArgs {
  ptyId: string
  panelId: string
  /** This terminal's tab id — where the (per-tab) agentSession lives. */
  termId: string
  saved: AgentSessionRef
  /** Directory the shell ACTUALLY spawned in (from the create result). */
  spawnCwd: string
  /** The terminal's live OSC-7 cwd, if known — preferred for the on-disk existence lookup. */
  liveCwd?: string
  /** Resolves once the shell is at its first prompt (so the command lands cleanly). */
  whenShellReady: () => Promise<void>
  isDisposed: () => boolean
}

export async function resumeAgentSession(args: ResumeArgs): Promise<void> {
  const { ptyId, panelId, termId, saved, spawnCwd, liveCwd, whenShellReady, isDisposed } = args

  const cmd = buildAgentResumeCommand(saved)
  if (!cmd) return

  // cwd guard — if the shell fell back from the saved dir (folder moved/untrusted), skip:
  // resuming from the wrong directory fails or reopens a different project's conversation.
  if (saved.cwd && spawnCwd && normCwd(saved.cwd) !== normCwd(spawnCwd)) return

  // existence guard — only for id-embedding commands. Resuming an id with no on-disk
  // conversation makes the CLI exit with an error, so verify first (in the dir it will run in).
  if (saved.sessionId && cmd.includes(saved.sessionId)) {
    const lookupCwd = liveCwd || spawnCwd || saved.cwd
    const exists = lookupCwd
      ? await window.plano.agent.validateSession(saved, lookupCwd).catch(() => null)
      : null
    if (exists === false) {
      // The conversation is gone (deleted, or the id was pre-assigned but never used). Drop the
      // stale ref so the next reopen doesn't retry a known-dead id; fall back to a plain shell.
      clearAgentSession(panelId, termId)
      return
    }
  }

  await whenShellReady()
  if (isDisposed()) return

  // Re-seed the sidecar so the resumed conversation keeps its id across the NEXT restart (its
  // on-disk file now has an old birthtime that file-matching alone would miss).
  window.plano.agent.reportSession(ptyId, saved)
  window.plano.terminal.write(ptyId, `${cmd}\r`)
}

function clearAgentSession(panelId: string, termId: string): void {
  usePanelStore.getState().updateTerminalTab(panelId, termId, { agentSession: undefined })
}
