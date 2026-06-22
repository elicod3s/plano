import { create } from 'zustand'
import {
  clampZoom,
  screenToWorld,
  boundingBox,
  type Transform,
  type Rect,
  type Size,
} from '@shared/domain/geometry'

interface ViewportState extends Transform {
  isPanning: boolean
  /** True while a wheel-zoom or drag-pan gesture is active. PanelLayer reads it to promote the
   *  world layer to a cached GPU texture during the gesture (cheap composited scale) and drops the
   *  hint on settle (one sharp re-raster), so scaling a canvas full of DOM terminals stays smooth. */
  interacting: boolean
  setTransform: (t: Partial<Transform>) => void
  panBy: (dx: number, dy: number) => void
  /** Zoom by a factor keeping the world point under `anchor` (screen px) fixed. */
  zoomAt: (anchor: { x: number; y: number }, factor: number) => void
  zoomTo: (zoom: number, viewport: Size) => void
  zoomToFit: (rects: Rect[], viewport: Size, padding?: number) => void
  /** Center a single rect in the viewport at a comfortable zoom (jump-to-panel). */
  focusRect: (rect: Rect, viewport: Size, padding?: number) => void
  reset: () => void
  setPanning: (panning: boolean) => void
  setInteracting: (interacting: boolean) => void
}

export const useViewportStore = create<ViewportState>((set, get) => ({
  x: 0,
  y: 0,
  zoom: 1,
  isPanning: false,
  interacting: false,

  setTransform: (t) => set((s) => ({ ...s, ...t })),

  panBy: (dx, dy) => set((s) => ({ x: s.x + dx, y: s.y + dy })),

  zoomAt: (anchor, factor) => {
    const { x, y, zoom } = get()
    const next = clampZoom(zoom * factor)
    if (next === zoom) return
    const world = screenToWorld(anchor, { x, y, zoom })
    // Keep `world` under the same screen anchor after zooming.
    set({ zoom: next, x: anchor.x - world.x * next, y: anchor.y - world.y * next })
  },

  zoomTo: (zoom, viewport) => {
    const { x, y, zoom: cur } = get()
    const anchor = { x: viewport.width / 2, y: viewport.height / 2 }
    const next = clampZoom(zoom)
    const world = screenToWorld(anchor, { x, y, zoom: cur })
    set({ zoom: next, x: anchor.x - world.x * next, y: anchor.y - world.y * next })
  },

  zoomToFit: (rects, viewport, padding = 96) => {
    const box = boundingBox(rects)
    if (!box || box.width === 0 || box.height === 0) {
      set({ x: viewport.width / 2, y: viewport.height / 2, zoom: 1 })
      return
    }
    const zoom = clampZoom(
      Math.min(
        (viewport.width - padding * 2) / box.width,
        (viewport.height - padding * 2) / box.height,
        1.5,
      ),
    )
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    set({ zoom, x: viewport.width / 2 - cx * zoom, y: viewport.height / 2 - cy * zoom })
  },

  focusRect: (rect, viewport, padding = 160) => {
    // Frame this one panel: never blow it up past ~1.1× (calm, not a slam-zoom), and let
    // clampZoom pull back for an oversized rect (e.g. a dock group). Then center it.
    const zoom = clampZoom(
      Math.min(
        (viewport.width - padding * 2) / rect.width,
        (viewport.height - padding * 2) / rect.height,
        1.1,
      ),
    )
    const cx = rect.x + rect.width / 2
    const cy = rect.y + rect.height / 2
    set({ zoom, x: viewport.width / 2 - cx * zoom, y: viewport.height / 2 - cy * zoom })
  },

  reset: () => set({ x: 0, y: 0, zoom: 1 }),
  setPanning: (panning) => set({ isPanning: panning }),
  // Guarded so re-arming the flag during a wheel burst (same value) doesn't churn subscribers.
  setInteracting: (interacting) => {
    if (get().interacting !== interacting) set({ interacting })
  },
}))
