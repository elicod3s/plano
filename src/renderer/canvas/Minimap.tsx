import { useRef } from 'react'
import { usePanelStore } from '@/stores/usePanelStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { useUiStore } from '@/stores/useUiStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { boundingBox } from '@shared/domain/geometry'
import { Icon } from '@/design-system/Icon'

const W = 200
const H = 140
const PAD = 12

/**
 * Spatial overview: panels as filled rects + the current viewport rectangle. Hidden by default;
 * shown/hidden from the bottom-right ViewControls map toggle (it sits just left of that cluster).
 * Click or drag anywhere on it to fly the camera there.
 */
export function Minimap() {
  const visible = useUiStore((s) => s.minimapVisible)
  const panels = usePanelStore((s) => s.panels)
  const x = useViewportStore((s) => s.x)
  const y = useViewportStore((s) => s.y)
  const zoom = useViewportStore((s) => s.zoom)
  const setTransform = useViewportStore((s) => s.setTransform)
  // Mapping snapshot taken on press so click-drag panning doesn't rubber-band as the box
  // rescales when the viewport travels past the panels' bounds.
  const drag = useRef<{ left: number; top: number; boxX: number; boxY: number; scale: number } | null>(null)

  if (!visible) return null

  // Docked panels have a stale rect (their group holds the real one) — skip them.
  const rects = Object.values(panels)
    .filter((p) => !p.dockedIn)
    .map((p) => p.rect)
  // Viewport rectangle in world space.
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
      className="absolute bottom-6 right-16 z-30 overflow-hidden rounded-md border border-default shadow-popover"
      style={{ width: W, background: 'color-mix(in srgb, var(--surface-2) 85%, transparent)', backdropFilter: 'blur(12px)' }}
    >
      <div className="flex h-6 items-center justify-between px-2">
        <span className="label-caps">Map</span>
        <button type="button" onClick={hide} aria-label="Hide map" className="text-text-tertiary hover:text-text-primary">
          <Icon name="X" size={13} />
        </button>
      </div>
      <svg
        width={W}
        height={H}
        className="block cursor-grab touch-none active:cursor-grabbing"
        style={{ background: 'var(--surface-inset)' }}
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
  )
}
