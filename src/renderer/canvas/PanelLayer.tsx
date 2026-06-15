import { useViewportStore } from '@/stores/useViewportStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { PanelFrame } from '@/panels/_base/PanelFrame'
import { RegionFrame } from '@/panels/region/RegionFrame'

/**
 * The transformed "world": a single layer that translate+scales with the camera, with
 * every panel positioned at its world coordinates inside it. Panels inherit the canvas
 * transform for free — including <webview> browser panels, which is why we use Electron.
 *
 * Regions are rendered first and assigned a low z-index band so they always sit *behind*
 * the panels they group; remaining panels keep their relative stacking order on top.
 */
export function PanelLayer() {
  const x = useViewportStore((s) => s.x)
  const y = useViewportStore((s) => s.y)
  const zoom = useViewportStore((s) => s.zoom)
  const panels = usePanelStore((s) => s.panels)

  const all = Object.values(panels)
  const regions = all.filter((p) => p.type === 'region').sort((a, b) => a.z - b.z)
  const others = all.filter((p) => p.type !== 'region').sort((a, b) => a.z - b.z)

  return (
    <div
      className="absolute left-0 top-0 h-0 w-0"
      style={{ transform: `translate(${x}px, ${y}px) scale(${zoom})`, transformOrigin: '0 0' }}
    >
      {regions.map((panel, i) => (
        <RegionFrame key={panel.id} panel={panel} zoom={zoom} zIndex={i + 1} />
      ))}
      {others.map((panel, i) => (
        <PanelFrame key={panel.id} panel={panel} zoom={zoom} zIndex={regions.length + 1 + i} />
      ))}
    </div>
  )
}
