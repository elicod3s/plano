import { useEffect, useMemo, useRef, useState } from 'react'
import { usePanelStore } from '@/stores/usePanelStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { useUiStore } from '@/stores/useUiStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { boundingBox } from '@shared/domain/geometry'
import { Icon } from '@/design-system/Icon'
import { viewportController } from './ViewportController'

const W = 200
const H = 140
const PAD = 12
/** Breathing room between the map surface and the card's rounded edge. */
const INSET = 8

/**
 * Spatial overview: panels as filled rects + the current viewport rectangle. Hidden by default;
 * shown/hidden from the bottom-right ViewControls map toggle (it sits just left of that cluster).
 * Click or drag anywhere on it to fly the camera there.
 *
 * The viewport rect subscribes to the camera's LIVE channel (not the React store), so a
 * pan/zoom gesture never re-renders the world via this overlay — the world transform keeps
 * exactly one writer (the controller during motion, the store at rest).
 */
export function Minimap() {
  const visible = useUiStore((s) => s.minimapVisible)
  const panels = usePanelStore((s) => s.panels)
  const setTransform = useViewportStore((s) => s.setTransform)
  const [cam, setCam] = useState(() => {
    const s = useViewportStore.getState()
    return { x: s.x, y: s.y, zoom: s.zoom }
  })
  // Mapping snapshot taken on press so click-drag panning doesn't rubber-band as the box
  // rescales when the viewport travels past the panels' bounds.
  const drag = useRef<{ left: number; top: number; boxX: number; boxY: number; scale: number } | null>(null)

  useEffect(() => {
    const unLive = viewportController.subscribeLive((v) => setCam(v))
    const unSettled = viewportController.subscribeSettled((v) => setCam(v))
    return () => {
      unLive()
      unSettled()
    }
  }, [])

  // Docked panels have a stale rect (their group holds the real one) — skip them. Memoized on
  // the registry reference (plan D3): a drag elsewhere changes the registry but bails out here.
  // MUST stay above the `visible` early return — hooks cannot be conditional (React #300).
  const rects = useMemo(
    () =>
      Object.values(panels)
        .filter((p) => !p.dockedIn)
        .map((p) => p.rect),
    [panels],
  )

  if (!visible) return null
  // Viewport rectangle in world space.
  const { x, y, zoom } = cam
  const view = {
    x: -x / zoom,
    y: -y / zoom,
    width: window.innerWidth / zoom,
    height: window.innerHeight / zoom,
  }
  const box = boundingBox([...rects, view]) ?? { x: 0, y: 0, width: 1, height: 1 }
  const scale = Math.min((W - PAD * 2) / box.width, (H - PAD * 2) / box.height)
  const tx = (wx: number): number => PAD + (wx - box.x) * scale
  const ty = (wy: number): number => PAD + (wy - box.y) * scale

  // Click/drag anywhere on the map to fly the camera there: the world point under the cursor
  // is recentered in the viewport. Inverse of tx/ty, using the press-time mapping snapshot.
  const panToEvent = (e: React.PointerEvent<SVGSVGElement>): void => {
    const d = drag.current
    if (!d) return
    const wx = d.boxX + (e.clientX - d.left - PAD) / d.scale
    const wy = d.boxY + (e.clientY - d.top - PAD) / d.scale
    setTransform({ x: window.innerWidth / 2 - wx * zoom, y: window.innerHeight / 2 - wy * zoom })
  }
  const startPan = (e: React.PointerEvent<SVGSVGElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    drag.current = { left: r.left, top: r.top, boxX: box.x, boxY: box.y, scale }
    e.currentTarget.setPointerCapture(e.pointerId)
    panToEvent(e)
  }
  const endPan = (e: React.PointerEvent<SVGSVGElement>): void => {
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  // Persisted hide (mirrors the ViewControls map toggle) so it stays hidden on next launch.
  const hide = (): void => useSettingsStore.getState().patch('canvas', { showMinimap: false })

  return (
    <div
      data-surface-layer="popover"
      className="surface-layer surface-layer--chrome absolute bottom-6 right-20 z-[var(--z-chrome)] overflow-hidden rounded-[26px]"
      style={{ width: W + INSET * 2 }}
    >
      {/* Header sits on the same gutter as the map below it, so the title, the close button and
          the map's left edge all line up on one vertical. */}
      <div className="flex h-7 items-center justify-between" style={{ paddingLeft: INSET + 2, paddingRight: INSET }}>
        {/* A floating card titles itself in the UI face, like the usage panel's own header.
            `label-caps` is the GROUP-label vocabulary ("Running agents", "Timeline") and forces
            the mono data face — as a card title it read as a stray terminal string. */}
        <span className="text-[10px] font-medium uppercase tracking-label text-text-3">Map</span>
        <button type="button" onClick={hide} aria-label="Hide map" className="text-text-tertiary hover:text-text-primary">
          <Icon name="X" size={13} />
        </button>
      </div>
      {/* The map is an INSET surface, not a full-bleed one: run it to the card's edge and the
          card's own 26px radius slices the map's corners off diagonally, cutting whatever panel
          happens to sit there. Its own smaller radius nests inside the card's, the way an inset
          always reads one step tighter than the shell holding it. */}
      <div
        className="overflow-hidden rounded-[14px]"
        style={{ margin: INSET, marginTop: 0, width: W, height: H, background: 'var(--surface-inset)' }}
      >
      <svg
        width={W}
        height={H}
        className="block cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={startPan}
        onPointerMove={panToEvent}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        {Object.values(panels).map((p) => (
          <rect
            key={p.id}
            x={tx(p.rect.x)}
            y={ty(p.rect.y)}
            width={Math.max(2, p.rect.width * scale)}
            height={Math.max(2, p.rect.height * scale)}
            rx={2}
            fill="var(--text-quaternary)"
          />
        ))}
        <rect
          x={tx(view.x)}
          y={ty(view.y)}
          width={view.width * scale}
          height={view.height * scale}
          rx={2}
          fill="rgba(255,255,255,0.08)"
          stroke="var(--accent-primary)"
          strokeWidth={1}
        />
      </svg>
      </div>
    </div>
  )
}
