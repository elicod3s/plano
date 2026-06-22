import { useEffect, type RefObject } from 'react'
import { terminalEngine } from './engine'

/**
 * React seam for a terminal. All the heavy lifting — the xterm `Terminal` instance, its addons, the
 * PTY stream, agent detection, render-scale/zoom math and option subscriptions — lives in the
 * renderer-side `terminalEngine`, OUTSIDE React, keyed by `termId`. This hook only:
 *   • `getOrCreate`s the session on mount (idempotent → StrictMode-safe, never respawns), and
 *   • `attach`es the DOM (re-parents the existing `term.element` into the freshly-mounted render box).
 * On unmount it `detach`es the DOM only — the session, its PTY and its scrollback stay alive in the
 * registry, so returning from another space / switching back to this tab is a pure DOM re-parent with
 * NO buffered replay (no flicker, no scroll jump). The session is destroyed only by an explicit
 * teardown (`terminalEngine.dispose`, driven from app/terminalSessions when a tab/panel is closed).
 *
 * `containerRef` is the padded/clipped outer box (owns paste + context-menu + wheel); `renderBoxRef`
 * is the counter-scaled box xterm is opened into.
 */
export function useXterm(
  termId: string,
  panelId: string,
  renderBoxRef: RefObject<HTMLDivElement>,
  containerRef: RefObject<HTMLDivElement>,
): void {
  useEffect(() => {
    const renderBox = renderBoxRef.current
    const container = containerRef.current
    if (!renderBox || !container) return

    terminalEngine.getOrCreate(termId, panelId)
    terminalEngine.attach(termId, container, renderBox)

    return () => {
      terminalEngine.detach(termId)
    }
  }, [termId, panelId, renderBoxRef, containerRef])
}
