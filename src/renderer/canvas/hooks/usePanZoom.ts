import { useEffect, type RefObject } from 'react'
import { useViewportStore } from '@/stores/useViewportStore'

/**
 * Wheel-based zoom/pan on the canvas element.
 *  - Alt + wheel        → zoom at cursor.
 *  - Ctrl/⌘ + wheel      → pan horizontally (left/right only).
 *  - Shift + wheel       → pan vertically (up/down only).
 *  - Plain wheel / two-finger scroll → free pan (both axes).
 * Wheel is bound non-passively so we can preventDefault and stop the page from scrolling.
 *
 * Note: with Alt now owning zoom, trackpad pinch (which the OS reports as ctrl+wheel) pans
 * horizontally instead of zooming — use Alt+wheel or the Dock zoom controls on a trackpad.
 */
export function usePanZoom(ref: RefObject<HTMLElement>): void {
  const panBy = useViewportStore((s) => s.panBy)
  const zoomAt = useViewportStore((s) => s.zoomAt)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()

      if (e.altKey) {
        const rect = el.getBoundingClientRect()
        const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top }
        zoomAt(anchor, Math.exp(-e.deltaY * 0.0015))
        return
      }

      // The browser swaps the wheel axis to deltaX while Shift is held, so pick the
      // larger-magnitude delta and route it to the locked axis ourselves.
      const primary = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY

      if (e.ctrlKey || e.metaKey) {
        panBy(-primary, 0) // horizontal only
        return
      }
      if (e.shiftKey) {
        panBy(0, -primary) // vertical only
        return
      }

      panBy(-e.deltaX, -e.deltaY) // free pan
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [ref, panBy, zoomAt])
}
