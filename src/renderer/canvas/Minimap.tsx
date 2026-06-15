import { useState } from 'react'
import { usePanelStore } from '@/stores/usePanelStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { useUiStore } from '@/stores/useUiStore'
import { boundingBox } from '@shared/domain/geometry'
import { Icon } from '@/design-system/Icon'

const W = 200
const H = 140
const PAD = 12

/** Spatial overview: panels as filled rects + the current viewport rectangle. */
export function Minimap() {
  const visible = useUiStore((s) => s.minimapVisible)
  const panels = usePanelStore((s) => s.panels)
  const x = useViewportStore((s) => s.x)
  const y = useViewportStore((s) => s.y)
  const zoom = useViewportStore((s) => s.zoom)
  const [collapsed, setCollapsed] = useState(false)

  if (!visible) return null

  const rects = Object.values(panels).map((p) => p.rect)
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

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        aria-label="Show minimap"
        className="absolute bottom-6 left-4 z-30 flex h-9 w-9 items-center justify-center rounded-md border border-default shadow-popover"
        style={{ background: 'color-mix(in srgb, var(--surface-2) 85%, transparent)', backdropFilter: 'blur(12px)' }}
      >
        <Icon name="Map" size={16} className="text-text-secondary" />
      </button>
    )
  }

  return (
    <div
      className="absolute bottom-6 left-4 z-30 overflow-hidden rounded-md border border-default shadow-popover"
      style={{ width: W, background: 'color-mix(in srgb, var(--surface-2) 85%, transparent)', backdropFilter: 'blur(12px)' }}
    >
      <div className="flex h-6 items-center justify-between px-2">
        <span className="label-caps">Map</span>
        <button type="button" onClick={() => setCollapsed(true)} aria-label="Collapse minimap" className="text-text-tertiary hover:text-text-primary">
          <Icon name="ChevronDown" size={13} />
        </button>
      </div>
      <svg width={W} height={H} className="block" style={{ background: 'var(--surface-inset)' }}>
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
