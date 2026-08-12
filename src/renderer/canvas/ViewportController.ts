/**
 * ViewportController — the canvas's LIVE camera (PLAN_UNIFIED_MOTION_AND_OCCLUSION_HIERARCHY).
 *
 * ONE permanent camera owner: the world layer (data-world-layer) carries
 * `translate3d(camX, camY, 0) scale(camZoom)` at rest AND during interaction. React
 * renders it from the settled store; this controller writes the SAME transform
 * imperatively at most once per rAF while a gesture runs, then commits the same values to
 * the store at gesture end. Panels/groups/regions/labels never incorporate camera
 * variables — they keep only their static world position.
 *
 * Input (pointer pan + wheel) is accumulated and flushed at most once per animation
 * frame. `end()` consumes the last pending delta synchronously (no lost frame), snaps x/y
 * to physical pixels, writes the final transform, and drops `interacting`/`will-change`
 * two frames later. There is never an instant where the camera applies twice or nowhere.
 */

import { clampZoom, screenToWorld } from '@shared/domain/geometry'
import { useViewportStore } from '@/stores/useViewportStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

export type MotionKind = 'pointer-pan' | 'wheel-pan' | 'wheel-zoom'

export interface LiveViewport {
  x: number
  y: number
  zoom: number
}

/** Grid spacing per gridSize preset (mirrored from GridBackground — kept in one place). */
const GRID_SPACING: Record<'fine' | 'standard' | 'coarse', { minor: number; major: number }> = {
  fine: { minor: 16, major: 64 },
  standard: { minor: 24, major: 96 },
  coarse: { minor: 36, major: 144 },
}

/** Live spacing for the current Appearance → Grid size setting. */
function gridSpacing(): { minor: number; major: number } {
  return GRID_SPACING[useSettingsStore.getState().settings.appearance.gridSize] ?? GRID_SPACING.standard
}

/** How often (ms) a low-frequency settled snapshot is published during a gesture — enough
 *  for informational consumers (minimap, zoom %), never per pointer event. */
const PUBLISH_MS = 66

class ViewportController {
  private worldEl: HTMLElement | null = null
  /** The grid layer + its cursor-spot sibling. Live camera vars are written on THESE nodes
   *  only — never on a shared ancestor, which would restyle every panel each frame. */
  private gridEls: HTMLElement[] = []

  /** Mutable camera reflecting the most recent applied frame while in motion. */
  private live: LiveViewport = { x: 0, y: 0, zoom: 1 }
  private motion = false

  private raf = 0
  private panX = 0
  private panY = 0
  private zoomFactor = 1
  private anchor: { x: number; y: number } | null = null

  private pubTimer: ReturnType<typeof setTimeout> | null = null
  private settleListeners = new Set<(v: LiveViewport) => void>()
  /** 15 Hz live-camera listeners — INFORMATIONAL ONLY (chrome overlays outside the world).
   *  Never React store subscriptions; the world transform has exactly one writer (this
   *  controller during motion, the store at rest). */
  private liveListeners = new Set<(v: LiveViewport) => void>()
  /** rAF handle of an in-flight button/command zoom animation (see animateZoomTo). */
  private zoomAnim = 0
  /** Invalidates a pending two-frame settle when a new gesture starts immediately. */
  private settleVersion = 0

  /** Register the world container (called by PanelLayer on mount). */
  attachWorld(worldEl: HTMLElement | null): void {
    this.worldEl = worldEl
    if (this.motion && worldEl) this.applyMotionTransform()
  }

  /** Register the grid + its cursor-spot sibling (called by GridBackground on mount). */
  attachGrid(gridEl: HTMLElement | null, spotEl: HTMLElement | null): void {
    // The grid vars are written on THESE TWO LAYERS, never on their shared ancestor. They are
    // inherited custom properties, so putting them on the canvas background restyled the whole
    // world subtree — every panel — on every pan frame (see GridBackground for the measurement).
    // Both layers get the same values in the same frame, so grid and spotlight never disagree.
    this.gridEls = [gridEl, spotEl].filter((el): el is HTMLElement => el !== null)
    if (this.motion && this.gridEls.length > 0) this.applyMotionTransform()
  }

  /** Live camera for interactive geometry — the store snapshot when settled. */
  getLive(): LiveViewport {
    return this.motion ? this.live : useViewportStore.getState()
  }

  /** Start a gesture: sync the live camera from the store and take over the world
   *  transform imperatively from the next rAF. The world ALREADY carries the settled
   *  camera, so no mode transfer or identity vars are needed. */
  begin(_kind: MotionKind): void {
    if (this.motion) return
    this.settleVersion += 1
    const s = useViewportStore.getState()
    this.live = { x: s.x, y: s.y, zoom: s.zoom }
    this.motion = true
    this.panX = 0
    this.panY = 0
    this.zoomFactor = 1
    this.anchor = null
  }

  enqueuePan(dx: number, dy: number): void {
    if (!this.motion) return
    this.panX += dx
    this.panY += dy
    this.schedule()
  }

  /** Anchor-preserving zoom: the world point under `anchor` (screen px) stays fixed. */
  enqueueZoom(anchor: { x: number; y: number }, factor: number): void {
    if (!this.motion) return
    this.zoomFactor *= factor
    this.anchor = anchor
    this.schedule()
  }

  /** Finish the gesture: consume the last delta, snap to physical pixels, commit the same
   *  values React will render, and drop the interaction hint two frames later. The world
   *  transform never changes owner and is never reset to none. */
  end(): void {
    if (!this.motion) return
    if (this.raf) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
    if (this.pubTimer) {
      clearTimeout(this.pubTimer)
      this.pubTimer = null
    }

    // A pointer-up can arrive before the rAF scheduled by the final pointermove. Apply those
    // pending deltas synchronously instead of cancelling and losing them (the old behavior caused
    // a small backward jump at the end of fast pans and made the camera feel unreliable).
    this.applyPendingCamera()
    const dpr = window.devicePixelRatio || 1
    const settled = {
      ...this.live,
      x: Math.round(this.live.x * dpr) / dpr,
      y: Math.round(this.live.y * dpr) / dpr,
    }
    this.live = settled
    this.motion = false

    // Commit to the settled store AND write the same transform imperatively in the same
    // task — React re-renders the identical matrix, so there is no visual change of owner.
    useViewportStore.setState({ x: settled.x, y: settled.y, zoom: settled.zoom })
    const el = this.worldEl
    if (el) el.style.transform = `translate3d(${settled.x}px, ${settled.y}px, 0) scale(${settled.zoom})`

    // Drop the interaction hint (will-change) two stable frames later, so the content
    // rasterizes before the layer hint is removed. A new gesture invalidates this.
    const settleVersion = ++this.settleVersion
    let frames = 0
    const settle = (): void => {
      if (settleVersion !== this.settleVersion) return
      frames += 1
      if (frames < 2) {
        requestAnimationFrame(settle)
        return
      }
      useViewportStore.getState().setInteracting(false)
      for (const l of this.settleListeners) l(settled)
    }
    requestAnimationFrame(settle)
  }

  /** pointercancel / lost capture / workspace switch / HMR — transfer the last valid frame. */
  cancel(): void {
    this.end()
  }

  subscribeSettled(fn: (v: LiveViewport) => void): () => void {
    this.settleListeners.add(fn)
    return () => this.settleListeners.delete(fn)
  }

  private schedule(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.flush)
  }

  private flush = (): void => {
    this.raf = 0
    if (!this.motion) return

    this.applyPendingCamera()
    this.applyMotionTransform()
    this.publishLowFreq()
  }

  /** Consume all input accumulated since the previous animation frame. */
  private applyPendingCamera(): void {
    if (this.zoomFactor !== 1 && this.anchor) {
      const next = clampZoom(this.live.zoom * this.zoomFactor)
      if (next !== this.live.zoom) {
        const world = screenToWorld(this.anchor, {
          x: this.live.x,
          y: this.live.y,
          zoom: this.live.zoom,
        })
        this.live = { zoom: next, x: this.anchor.x - world.x * next, y: this.anchor.y - world.y * next }
      }
      this.zoomFactor = 1
    }
    if (this.panX !== 0 || this.panY !== 0) {
      this.live = { ...this.live, x: this.live.x + this.panX, y: this.live.y + this.panY }
      this.panX = 0
      this.panY = 0
    }
  }

  /** Write the camera transform + grid vars imperatively (no React, no cam vars). The grid vars
   *  go on the grid layers THEMSELVES — writing an inherited custom property on their shared
   *  ancestor restyled every panel in the world on each frame. */
  private applyMotionTransform(): void {
    const el = this.worldEl
    if (el) el.style.transform = `translate3d(${this.live.x}px, ${this.live.y}px, 0) scale(${this.live.zoom})`
    if (this.gridEls.length === 0) return
    const { minor, major } = gridSpacing()
    const gx = `${this.live.x}px`
    const gy = `${this.live.y}px`
    const gm = `${minor * this.live.zoom}px`
    const gM = `${major * this.live.zoom}px`
    for (const node of this.gridEls) {
      node.style.setProperty('--grid-x', gx)
      node.style.setProperty('--grid-y', gy)
      node.style.setProperty('--grid-minor', gm)
      node.style.setProperty('--grid-major', gM)
    }
  }

  /** Subscribe to the 15 Hz live camera (informational chrome only). */
  subscribeLive(fn: (v: LiveViewport) => void): () => void {
    this.liveListeners.add(fn)
    return () => this.liveListeners.delete(fn)
  }

  /**
   * Ease the camera to a target zoom around `anchor` (screen px) over `ms`.
   *
   * The +/− buttons used to call `zoomTo(zoom * 1.25)`, which is a 25 % JUMP written straight to
   * the store: the world snapped from one scale to another with nothing in between, which is the
   * "por tirones" the user sees. Animating through the same live path a gesture uses makes the
   * step continuous and compositor-smooth, and `end()` still commits exactly once at the finish,
   * so the single-camera-owner invariant is untouched.
   */
  animateZoomTo(target: number, anchor: { x: number; y: number }, ms = 220): void {
    const from = this.getLive().zoom
    const to = clampZoom(target)
    if (Math.abs(to - from) < 0.0005) return
    if (this.zoomAnim) cancelAnimationFrame(this.zoomAnim)
    this.begin('wheel-zoom')
    const start = performance.now()
    let applied = from
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / ms)
      // Ease-out cubic: fast off the mark, settles softly — same feel as the panel settle.
      const eased = 1 - (1 - t) ** 3
      // Interpolate in LOG space so each frame is a constant proportional change; linear
      // interpolation of a scale reads as accelerating at one end and crawling at the other.
      const next = from * (to / from) ** eased
      this.enqueueZoom(anchor, next / applied)
      applied = next
      if (t < 1) {
        this.zoomAnim = requestAnimationFrame(step)
        return
      }
      this.zoomAnim = 0
      this.end()
    }
    this.zoomAnim = requestAnimationFrame(step)
  }

  /** 15 Hz snapshot for informational consumers — never per event, never on panels.
   *  Goes ONLY to the live channel: the React store is written exclusively by end(),
   *  so PanelLayer never re-renders mid-gesture and the world transform has one writer. */
  private publishLowFreq(): void {
    if (this.pubTimer) return
    this.pubTimer = setTimeout(() => {
      this.pubTimer = null
      if (!this.motion) return
      for (const l of this.liveListeners) l(this.live)
    }, PUBLISH_MS)
  }
}

export const viewportController = new ViewportController()
