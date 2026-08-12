/**
 * Terminal session teardown. PTYs persist across workspace ("space") switches — a terminal's
 * shell keeps running in main while its panel is unmounted in another space — so the ONLY way a
 * session ends is an explicit user action: closing the panel, deleting the space it lives in, or
 * opening a different project. These helpers are the single choke point for that: they kill the
 * PTY in main, forget its agent verdict, and drop it from the session registry. Merely switching
 * spaces must NEVER call these (the panel just detaches and reattaches later).
 */

import { useTerminalStore } from '@/stores/useTerminalStore'
import { useAgentStore } from '@/stores/useAgentStore'
import { useSpacesStore } from '@/stores/useSpacesStore'
import { terminalEngine } from '@/panels/terminal/engine'

/** End ONE terminal (by its terminal/tab id) — kill its PTY, forget its agent verdict + session, and
 *  destroy the renderer-side xterm instance the engine kept alive. Used to close a single tab inside
 *  a multi-terminal panel. Disposing the engine even when there's no live runtime entry (a tab closed
 *  mid-spawn) sets the session's disposed flag so its pending spawn kills the just-created PTY. */
export function killTerminalTab(termId: string): void {
  const rt = useTerminalStore.getState().byPanel[termId]
  if (rt) {
    void window.plano.terminal.kill(rt.ptyId)
    useAgentStore.getState().clear(rt.ptyId)
    useTerminalStore.getState().drop(termId)
  }
  terminalEngine.dispose(termId)
}

/** End EVERY terminal of a panel (a panel may host several tabs). No-op for non-terminal panels. */
export function killTerminalSession(panelId: string): void {
  for (const [termId, rt] of Object.entries(useTerminalStore.getState().byPanel)) {
    if (rt.panelId === panelId) killTerminalTab(termId)
  }
  // Safety net: catch any session for this panel that had no runtime entry yet (mid-spawn tab).
  terminalEngine.disposePanel(panelId)
}

/** End the sessions of a set of panels (e.g. every terminal in a deleted space). */
export function killTerminalSessions(panelIds: Iterable<string>): void {
  for (const id of panelIds) killTerminalSession(id)
}

/** End every live terminal session (e.g. when switching to a different project). */
export function killAllTerminalSessions(): void {
  for (const termId of Object.keys(useTerminalStore.getState().byPanel)) killTerminalTab(termId)
}

/**
 * After a workspace (re)hydrate, end any terminal whose panel no longer exists in ANY space — its
 * panel will never remount, so its PTY (still running in main) plus its registry + agent-verdict
 * entries would leak forever, unreachable by every other teardown path. Safe to call
 * unconditionally: when every panel still exists it's a no-op, and it never touches a terminal
 * that legitimately lives in another (currently-backgrounded) space.
 * `protectedTerminalIds` = terminals whose PANEL will be materialized shortly (phone-created,
 * pending) but isn't in the workspace store yet — they must not be killed here.
 */
export function reconcileTerminalSessions(protectedTerminalIds?: Iterable<string>): void {
  const live = new Set(useSpacesStore.getState().spaces.flatMap((s) => s.panels.map((p) => p.id)))
  const protectedSet = new Set(protectedTerminalIds ?? [])
  for (const [termId, rt] of Object.entries(useTerminalStore.getState().byPanel)) {
    if (protectedSet.has(termId)) continue
    if (!live.has(rt.panelId)) killTerminalTab(termId)
  }
}
