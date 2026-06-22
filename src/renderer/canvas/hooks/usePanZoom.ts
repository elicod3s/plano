import { useEffect, type RefObject } from 'react'
import { useViewportStore } from '@/stores/useViewportStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

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
 * Note: with Alt owning zoom, trackpad pinch (which the OS reports as ctrl+wheel) pans
 * horizontally instead of zooming — use Alt+wheel or the Dock zoom controls on a trackpad.
 */
export function usePanZoom(ref: RefObject<HTMLElement>): void {
  const panBy = useViewportStore((s) => s.panBy)
  const zoomAt = useViewportStore((s) => s.zoomAt)
  const setInteracting = useViewportStore((s) => s.setInteracting)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    // rAF-COALESCE the camera. A precision/inertial wheel emits many events per frame; committing
    // each one to the store separately fires a full PanelLayer + grid restyle every time. We instead
    // accumulate the pending zoom factor (product) and pan delta (sum) and apply ONE store commit per
    // animation frame, capping camera churn to ~60/s under any flood. The store stays the source of
    // truth (autosave + canvasZoomMouse read the live value), so nothing downstream changes.
    let raf = 0
    let zoomFactor = 1
    let anchor = { x: 0, y: 0 }
    let panX = 0
    let panY = 0
    const flush = (): void => {
      raf = 0
      if (zoomFactor !== 1) {
        zoomAt(anchor, zoomFactor) // zoomAt re-reads live x/y/zoom, so the anchor stays correct
        zoomFactor = 1
      }
      if (panX !== 0 || panY !== 0) {
        panBy(panX, panY)
        panX = 0
        panY = 0
      }
    }
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(flush)
    }

    // Mark the camera "interacting" so PanelLayer promotes the world to a cached GPU layer during
    // the gesture (composited scale, no per-frame re-raster of DOM terminals) and drops the hint a
    // beat after the last wheel notch (one sharp re-raster on settle). A trailing timeout keeps it
    // promoted through a wheel BURST rather than flickering between notches.
    let idle = 0
    const markInteracting = (): void => {
      setInteracting(true)
      if (idle) window.clearTimeout(idle)
      // The trailing clear must NOT demote while a pointer-pan still owns the flag (a wheel-then-drag
      // chain shares this one boolean): if it did, willChange would drop mid-pan and the per-frame
      // re-raster would return for the rest of that drag. CanvasRoot's endPan does the authoritative
      // clear when the pan ends; here we only clear when no pan is in progress.
      idle = window.setTimeout(() => {
        if (!useViewportStore.getState().isPanning) setInteracting(false)
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
        panX += -e.deltaX
        panY += -e.deltaY
        markInteracting()
        schedule()
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
        anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top }
        const sens = useSettingsStore.getState().settings.canvas.zoomSensitivity
        // Deska's wheel-zoom math (copied verbatim): clamp a single notch to ±24 so one big
        // mouse-wheel notch can't jump the view, then a multiplicative exp curve (scale 0.01) so a
        // trackpad's small per-event deltas read as a smooth continuous zoom. Anchor-preserving
        // zoomAt (the panel under the cursor stays put) is unchanged — only the curve changed.
        const clampedDelta = Math.max(-24, Math.min(24, e.deltaY))
        zoomFactor *= Math.exp(-clampedDelta * 0.01 * sens)
        schedule()
        return
      }

      // The browser swaps the wheel axis to deltaX while Shift is held, so pick the
      // larger-magnitude delta and route it to the locked axis ourselves.
      const primary = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      if (e.ctrlKey || e.metaKey) {
        panX += -primary // horizontal only
      } else {
        panY += -primary // shift → vertical only
      }
      schedule()
    }

    // Capture phase so we intercept the wheel BEFORE a panel's own handler (xterm,
    // CodeMirror) whenever a navigation modifier is held; passive:false so preventDefault
    // can stop the page from scrolling. removeEventListener must pass the same options.
    const opts: AddEventListenerOptions = { passive: false, capture: true }
    el.addEventListener('wheel', onWheel, opts)
    return () => {
      el.removeEventListener('wheel', onWheel, opts)
      if (raf) cancelAnimationFrame(raf)
      if (idle) window.clearTimeout(idle)
      // Never leave the world layer promoted if we unmount mid-gesture (e.g. dev HMR) — the pending
      // trailing clear is gone, so demote here. Guarded setter makes this a no-op when already false.
      setInteracting(false)
    }
  }, [ref, panBy, zoomAt, setInteracting])
}
