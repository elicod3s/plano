import { useEffect, useRef } from 'react'
import { useCanvasFocusStore } from '@/stores/useCanvasFocusStore'
import { terminalEngine } from './engine'

/**
 * Narrow focus subscription for one terminal panel. Reacts ONLY when this panel is the
 * focused canvas member:
 *
 *   (a) its panel id becomes the focused member (`focusSurface(surfaceId, panelId)` — a shield
 *       click on a standalone panel or on this pane inside a dock group);
 *   (b) `focusEpoch` bumps while it remains the focused member (same-terminal refocus after an
 *       overlay / palette / browser control stole DOM focus);
 *   (c) its active terminal tab changes while it is the focused member (tab switch / remount).
 *
 * The store subscription is imperative — it triggers the engine's focus run directly and holds NO
 * React state, so focusing terminal A never re-renders terminal B's body. When focus moves away,
 * the in-flight engine run is cancelled so no stale retry timers keep polling a hidden terminal.
 *
 * The engine run itself never fits/resizes/reattaches/recreates the `Terminal` and never touches
 * PTY state: only the xterm helper textarea receives focus (with scroll preservation + bounded
 * retries while the DOM is still attaching).
 */
export function useTerminalFocus(panelId: string, activeTermId: string): void {
  // Keep the LATEST active tab out of the subscription closure so the subscription binds once per
  // panel; tab switches re-focus through the activeTermId effect below instead of rebinding.
  const activeTermIdRef = useRef(activeTermId)
  activeTermIdRef.current = activeTermId

  // (a) + (b) + focus-moved-elsewhere: imperative, zero-rerender subscription.
  useEffect(() => {
    const unsub = useCanvasFocusStore.subscribe((state, prev) => {
      const wasFocused = prev.focus?.panelId === panelId
      const isFocused = state.focus?.panelId === panelId
      if (isFocused && (!wasFocused || state.focusEpoch !== prev.focusEpoch)) {
        terminalEngine.focus(activeTermIdRef.current)
      } else if (wasFocused && !isFocused) {
        terminalEngine.cancelFocus(activeTermIdRef.current)
      }
    })
    return unsub
  }, [panelId])

  // (c) + mount case: the active tab changed (or the panel just (re)mounted, e.g. dock/undock /
  // workspace hydration) while the panel is the focused member. The cleanup cancels the PREVIOUS
  // tab's run so a tab switch leaves no stale focus timers behind.
  useEffect(() => {
    if (useCanvasFocusStore.getState().focus?.panelId !== panelId) return
    terminalEngine.focus(activeTermId)
    return () => terminalEngine.cancelFocus(activeTermId)
  }, [panelId, activeTermId])
}
