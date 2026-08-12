import { useEffect, useRef, useState } from 'react'
import { useViewportStore } from '@/stores/useViewportStore'
import { useCanvasFocusStore } from '@/stores/useCanvasFocusStore'
import { useUiStore } from '@/stores/useUiStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { useSelectionStore, type MarqueeRect } from '@/stores/useSelectionStore'
import { screenToWorld } from '@shared/domain/geometry'
import { canvasBackgroundCss, canvasGlowCss } from '@/theme/themes'
import { usePanZoom } from './hooks/usePanZoom'
import { useFileDrop } from './hooks/useFileDrop'
import { viewportController } from './ViewportController'
import { GridBackground } from './GridBackground'
import { PanelLayer } from './PanelLayer'
import { SnapOverlay } from './SnapOverlay'
import { MarqueeOverlay } from './MarqueeOverlay'

/** Movement below this (SCREEN px, same as the panel-drag §5.1 threshold) counts as a click, not
 *  a sweep — a plain empty-canvas click clears canvas focus and selection; a drag keeps it. */
const CLICK_THRESHOLD_PX = 5

/**
 * Panels touched by the marquee, in world space. Regions and text labels are ground annotations
 * (they sit behind everything and are dragged as scenery), so a sweep across the canvas picks up
 * the windows a user means — terminals, editors, browsers — and never the backdrop under them.
 * Docked children are represented by their group, which is what actually moves.
 */
function panelsIntersecting(band: MarqueeRect, additive: boolean): string[] {
  const { x, y, zoom } = viewportController.getLive()
  const topLeft = screenToWorld({ x: band.x, y: band.y }, { x, y, zoom })
  const bottomRight = screenToWorld({ x: band.x + band.width, y: band.y + band.height }, { x, y, zoom })
  const hits: string[] = []
  for (const panel of Object.values(usePanelStore.getState().panels)) {
    if (panel.type === 'region' || panel.type === 'label' || panel.dockedIn) continue
    const r = panel.rect
    if (r.x + r.width < topLeft.x || r.x > bottomRight.x) continue
    if (r.y + r.height < topLeft.y || r.y > bottomRight.y) continue
    hits.push(panel.id)
  }
  if (!additive) return hits
  const previous = useSelectionStore.getState().ids
  return [...previous, ...hits.filter((id) => !previous.includes(id))]
}

/**
 * Space arms the hand tool. Ignored while typing — a terminal, editor or input owns the space
 * bar, and stealing it there would type nothing and pan instead.
 */
function useSpaceHeld(): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    const typing = (target: EventTarget | null): boolean =>
      !!(target as HTMLElement | null)?.closest?.('input, textarea, [contenteditable="true"], .xterm')
    const down = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || e.repeat || typing(e.target)) return
      setHeld(true)
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Space') setHeld(false)
    }
    // Releasing outside the window (alt-tab mid-pan) must not leave the hand armed.
    const blur = (): void => setHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])
  return held
}

/**
 * The infinite-canvas surface. Owns selection (left-drag marquee), pan (right-drag, middle-drag
 * or space-drag), wheel zoom, the right-click context menu, click-to-dismiss for overlays, and OS
 * file drag-and-drop (drop a file/folder anywhere to open it as a Files panel at that spot).
 * Panels stop propagation on their own pointer events so dragging a panel never reaches here.
 *
 * The left button SELECTS, it does not pan: a plain arrow cursor on the canvas and a rubber band
 * that picks up every panel it touches, so several terminals can be grabbed and moved as one.
 * The hand moved to the RIGHT button (plus middle and space, unchanged). Right is armed, not
 * started: travel past the click threshold turns it into a pan and swallows the context menu on
 * release, while a right-click that does not move still opens the menu exactly as before.
 */
export function CanvasRoot() {
  const ref = useRef<HTMLDivElement>(null)
  usePanZoom(ref)
  const dropActive = useFileDrop(ref)

  const setPanning = useViewportStore((s) => s.setPanning)
  const setInteracting = useViewportStore((s) => s.setInteracting)
  const isPanning = useViewportStore((s) => s.isPanning)
  const openContextMenu = useUiStore((s) => s.openContextMenu)
  const closeContextMenu = useUiStore((s) => s.closeContextMenu)
  const canvasBackground = useSettingsStore((s) => s.settings.appearance.canvasBackground)
  const canvasGlow = useSettingsStore((s) => s.settings.appearance.canvasGlow)
  const spaceHeld = useSpaceHeld()

  const pan = useRef<{ sx: number; sy: number; lastX: number; lastY: number; button: number; armed: boolean } | null>(null)
  const marquee = useRef<{ sx: number; sy: number; additive: boolean; rect: DOMRect } | null>(null)
  /** Set when a right-drag actually panned, so the context menu it would otherwise open is skipped. */
  const rightPanned = useRef(false)

  const beginPan = (): void => {
    setPanning(true)
    setInteracting(true) // world-layer promotion for the duration of the pan
    viewportController.begin('pointer-pan')
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    // Only react to gestures that start on the empty canvas, not on a panel.
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.canvasBackground) {
      return
    }
    closeContextMenu()
    rightPanned.current = false
    // Right-drag is the hand (middle-drag and space-drag still are too). The right button is
    // ARMED rather than started, so a plain right-click — which must open the context menu —
    // never flashes the closed hand or promotes the world layer for nothing.
    const wantsPan = e.button === 1 || e.button === 2 || (e.button === 0 && spaceHeld)
    if (e.button !== 0 && !wantsPan) return
    if (e.button !== 2) e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    if (wantsPan) {
      const armed = e.button === 2
      pan.current = { sx: e.clientX, sy: e.clientY, lastX: e.clientX, lastY: e.clientY, button: e.button, armed }
      if (!armed) beginPan()
      return
    }
    // Left button on empty canvas: start a selection sweep. Shift/Ctrl keeps what is selected.
    marquee.current = {
      sx: e.clientX,
      sy: e.clientY,
      additive: e.shiftKey || e.ctrlKey || e.metaKey,
      rect: (e.currentTarget as HTMLElement).getBoundingClientRect(),
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (pan.current) {
      const p = pan.current
      if (p.armed) {
        // Still a click until the pointer travels: below the threshold this is a context-menu
        // right-click, above it the gesture becomes a pan and the menu is suppressed on release.
        if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) <= CLICK_THRESHOLD_PX) return
        p.armed = false
        rightPanned.current = true
        beginPan()
      }
      // rAF-coalesced: the controller applies AT MOST one camera write per frame.
      viewportController.enqueuePan(e.clientX - p.lastX, e.clientY - p.lastY)
      pan.current = { ...p, lastX: e.clientX, lastY: e.clientY }
      return
    }
    const m = marquee.current
    if (!m) return
    // Below the click threshold the sweep stays invisible, so a plain click never flashes a band.
    if (Math.hypot(e.clientX - m.sx, e.clientY - m.sy) <= CLICK_THRESHOLD_PX) return
    const band = {
      x: Math.min(m.sx, e.clientX) - m.rect.left,
      y: Math.min(m.sy, e.clientY) - m.rect.top,
      width: Math.abs(e.clientX - m.sx),
      height: Math.abs(e.clientY - m.sy),
    }
    useSelectionStore.getState().setMarquee(band)
    useSelectionStore.getState().select(panelsIntersecting(band, m.additive))
  }

  const endGesture = (e?: React.PointerEvent<HTMLDivElement>): void => {
    const m = marquee.current
    if (m) {
      marquee.current = null
      useSelectionStore.getState().setMarquee(null)
      // A click (no sweep) on the true background clears both focus and selection.
      if (e && Math.hypot(e.clientX - m.sx, e.clientY - m.sy) <= CLICK_THRESHOLD_PX) {
        useCanvasFocusStore.getState().clearFocus()
        if (!m.additive) useSelectionStore.getState().clear()
      }
      return
    }
    const p = pan.current
    if (!p) return
    pan.current = null
    // An armed right-click never started a pan, so there is nothing to settle.
    if (p.armed) return
    setPanning(false)
    // The controller transfers the live camera to the settled store, drops the world
    // transform, and clears `interacting` two frames later (after the settled content
    // rasterizes, so the glass re-applies to sharp pixels).
    viewportController.end()
  }

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.canvasBackground) return
    e.preventDefault()
    // The right button just dragged the world — that gesture was a pan, not a request for a menu.
    if (rightPanned.current) {
      rightPanned.current = false
      return
    }
    const rect = ref.current!.getBoundingClientRect()
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const { x, y, zoom } = viewportController.getLive()
    const world = screenToWorld(screen, { x, y, zoom })
    openContextMenu(screen, world)
  }

  return (
    <div
      ref={ref}
      data-canvas-background="true"
      className="absolute inset-0 overflow-hidden"
      style={{
        background: canvasBackgroundCss(canvasBackground),
        cursor: isPanning ? 'grabbing' : spaceHeld ? 'grab' : 'default',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endGesture(e)}
      onPointerCancel={endGesture}
      onLostPointerCapture={endGesture}
      onContextMenu={onContextMenu}
    >
      {/* ambient accent halo — a soft wash over the substrate, pointer-inert */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: canvasGlowCss('var(--accent-primary)', canvasGlow) }}
      />
      <GridBackground />
      <PanelLayer />
      <SnapOverlay />
      <MarqueeOverlay />
      {dropActive && (
        <div className="pointer-events-none absolute inset-3 z-50 flex items-center justify-center rounded-[20px] border-2 border-dashed border-strong">
          <span className="rounded-pill border border-subtle bg-surface-2 px-4 py-1.5 text-[13px] text-text-secondary">
            Drop to open
          </span>
        </div>
      )}
    </div>
  )
}
