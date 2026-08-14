/**
 * Renderer-side restore of surviving terminal sessions (the "agents never close"
 * feature). Terminals live in a detached Agent Host (main → daemon), so when PLANO closes they
 * keep running; on the next launch this module re-discovers them BEFORE workspace panels mount and
 * seeds the terminal store, so `TerminalEngine.getOrCreate` finds an existing runtime entry and
 * reattaches (replaying the host's buffered output) instead of respawning a fresh shell.
 *
 * Sessions whose terminalId no longer exists in ANY persisted workspace are orphans (their panel
 * was deleted, or the workspace file was removed while the app was closed) — they're passed as
 * "kept" exclusion: main tells the host to kill them so they can't pin an agent alive forever.
 */

import { useTerminalStore } from '@/stores/useTerminalStore'
import type { Space } from '@shared/domain/workspace'

/** Every terminal-tab id across all persisted workspaces — the "still wanted" set. */
/** Every terminal-tab id across all persisted workspaces — the "still wanted" set. */
function allTerminalIds(workspaces: Space[]): string[] {
  const out: string[] = []
  for (const space of workspaces) {
    for (const panel of space.panels) {
      if (panel.type !== 'terminal') continue
      const tabs = (panel.props as { tabs?: Array<{ id: string }> } | undefined)?.tabs
      if (!tabs) continue
      for (const tab of tabs) out.push(tab.id)
    }
  }
  return out
}

/**
 * Discover the Agent Host's live sessions and seed the terminal store with them. Idempotent:
 * called once at app startup (before panels mount) and safe to call again on a renderer reload —
 * main re-lists the host each time and re-registers its sniffers.
 * `extraKeptTerminalIds` = phone-created (pending) terminal ids that aren't in the persisted
 * workspaces yet — without them their live sessions would be orphan-killed.
 */
export async function restoreSurvivingTerminals(extraKeptTerminalIds?: string[]): Promise<void> {
  try {
    const { state } = await window.plano.workspaces.get()
    const kept = state ? allTerminalIds(state.workspaces) : []
    if (extraKeptTerminalIds?.length) kept.push(...extraKeptTerminalIds)
    const { sessions } = await window.plano.terminal.restore(kept)
    for (const s of sessions) {
      useTerminalStore.getState().attach(s.terminalId, {
        ptyId: s.ptyId,
        pid: s.pid,
        shellName: s.shellName,
        status: s.exited ? 'exited' : 'ready',
        cwd: s.cwd || undefined,
        panelId: s.panelId,
      })
    }
  } catch {
    // Host unreachable → terminals spawn fresh (the pre-restore behaviour); nothing to seed.
  }
}
