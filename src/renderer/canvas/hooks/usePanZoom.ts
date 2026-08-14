import { useEffect, type RefObject } from 'react'
import { useViewportStore } from '@/stores/useViewportStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { viewportController } from '@/canvas/ViewportController'

/**
 * Wheel-based zoom/pan on the canvas element.
 *  - Alt + wheel        → zoom at cursor.
 *  - Ctrl/⌘ + wheel      → pan horizontally (left/right only).
 *  - Shift + wheel       → pan vertically (up/down only).
 *  - Plain wheel / two-finger scroll → free pan (both axes).
 *
 * A held navigation modifier (Alt/Ctrl/⌘/Shift) ALWAYS drives the canvas — even when the
 * cursor sits over a terminal, editor, or any panel that owns its own scroll. We listen in
 * the CAPTURE phase and stopPropagation() on those gestures so the panel underneath never
 * also scrolls (no double action): the user can zoom/pan the whole canvas without first
 * moving the mouse off a large terminal. A PLAIN, unmodified wheel keeps the old behavior —
 * a [data-wheel-own] surface (xterm buffer, CodeMirror, file tree) scrolls its own content;
 * anything else free-pans. Wheel is bound non-passively so we can preventDefault and stop
 * the page from scrolling.
 *
 * All input goes through ViewportController: accumulated and applied at most ONCE per
 * animation frame (MotionComposite — one world layer, no store write per event). The
 * settled camera is committed to the store when the gesture ends.
 *
 * Note: with Alt owning zoom, trackpad pinch (which the OS reports as ctrl+wheel) pans
 * horizontally instead of zooming — use Alt+wheel or the Dock zoom controls on a trackpad.
 */
export function usePanZoom(ref: RefObject<HTMLElement>): void {
  const setInteracting = useViewportStore((s) => s.setInteracting)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    // Mark the camera "interacting" (world-layer promotion) for the duration of the wheel
    // burst; the controller owns the actual camera application. A trailing timeout
    // ends the gesture a beat after the last wheel notch. The trailing clear must NOT end a
    // still-live pointer-pan (a wheel-then-drag chain shares the motion flag): if it did,
    // the world transform would drop mid-pan. CanvasRoot's endPan does the authoritative
    // end when the pan ends; here we only end when no pan is in progress.
    let idle = 0
    const markInteracting = (): void => {
      setInteracting(true)
      if (idle) window.clearTimeout(idle)
      idle = window.setTimeout(() => {
        if (!useViewportStore.getState().isPanning) viewportController.end()
      }, 160)
    }

    const onWheel = (e: WheelEvent): void => {
      const navGesture = e.altKey || e.ctrlKey || e.metaKey || e.shiftKey

      // Plain wheel (no modifier): a surface that owns its own scrolling (xterm viewport,
      // CodeMirror, …) keeps it — let the event fall through to that surface untouched
      // instead of panning the world underneath. Everything else free-pans the canvas.
      if (!navGesture) {
        if ((e.target as HTMLElement | null)?.closest('[data-wheel-own]')) return
        e.preventDefault()
        viewportController.begin('wheel-pan')
        markInteracting()
        viewportController.enqueuePan(-e.deltaX, -e.deltaY)
        return
      }

      // A navigation gesture (zoom / locked-axis pan). Own it fully — the capture-phase bind
      // plus this stopPropagation keep the panel underneath from ALSO scrolling, so zoom/pan
      // works the same whether the cursor is over empty canvas or over a large terminal.
      e.preventDefault()
      e.stopPropagation()
      markInteracting()

      if (e.altKey) {
        const rect = el.getBoundingClientRect()
        const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top }
        const sens = useSettingsStore.getState().settings.canvas.zoomSensitivity
        viewportController.begin('wheel-zoom')
        // Wheel-zoom math: clamp a single notch to ±24 so one big
        // mouse-wheel notch can't jump the view, then a multiplicative exp curve (scale 0.01) so a
        // trackpad's small per-event deltas read as a smooth continuous zoom. Anchor-preserving
        // zoomAt (the panel under the cursor stays put) is unchanged — only the curve changed.
        const clampedDelta = Math.max(-24, Math.min(24, e.deltaY))
        viewportController.enqueueZoom(anchor, Math.exp(-clampedDelta * 0.01 * sens))
        return
      }

      // The browser swaps the wheel axis to deltaX while Shift is held, so pick the
      // larger-magnitude delta and route it to the locked axis ourselves.
      const primary = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      if (e.ctrlKey || e.metaKey) {
        viewportController.begin('wheel-pan')
        viewportController.enqueuePan(-primary, 0) // horizontal only
      } else {
        viewportController.begin('wheel-pan')
        viewportController.enqueuePan(0, -primary) // shift → vertical only
      }
    }

    // Capture phase so we intercept the wheel BEFORE a panel's own handler (xterm,
    // CodeMirror) whenever a navigation modifier is held; passive:false so preventDefault
    // can stop the page from scrolling. removeEventListener must pass the same options.
    const opts: AddEventListenerOptions = { passive: false, capture: true }
    el.addEventListener('wheel', onWheel, opts)
    return () => {
      el.removeEventListener('wheel', onWheel, opts)
      if (idle) window.clearTimeout(idle)
      // Teardown (unmount/HMR) — transfer the last valid frame and restore rest mode.
      viewportController.cancel()
    }
  }, [ref, setInteracting])
}
