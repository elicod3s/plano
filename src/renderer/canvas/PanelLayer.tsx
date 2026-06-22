import { useMemo } from 'react'
import { useViewportStore } from '@/stores/useViewportStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { PanelFrame } from '@/panels/_base/PanelFrame'
import { DockGroupFrame } from '@/canvas/DockGroupFrame'
import { RegionFrame } from '@/panels/region/RegionFrame'
import { TextLabelFrame } from '@/panels/label/TextLabelFrame'

/**
 * The transformed "world": a single layer that translate+scales with the camera, with
 * every panel positioned at its world coordinates inside it. Panels inherit the canvas
 * transform for free — including <webview> browser panels, which is why we use Electron.
 *
 * Ground annotations render first into a low z-index band so they always sit *behind* the
 * floating panels: regions at the very back, then text labels (chrome-less headings) above
 * the region fills but still under every real panel. Remaining panels keep their relative
 * stacking order on top.
 */
export function PanelLayer() {
  const x = useViewportStore((s) => s.x)
  const y = useViewportStore((s) => s.y)
  const zoom = useViewportStore((s) => s.zoom)
  // Promote the world layer to a cached GPU texture only WHILE zooming/panning, so the browser
  // composites the scale instead of re-rasterizing every DOM terminal cell each frame; dropped on
  // settle (see useViewportStore.interacting) so steady-state text stays sharp.
  const interacting = useViewportStore((s) => s.interacting)
  const panels = usePanelStore((s) => s.panels)

  // Categorize/sort only when the panel SET changes — not on every pan/zoom (this component
  // re-renders each camera frame just to restyle its transform; the filter+sort must not re-run then).
  const { regions, labels, windows, base } = useMemo(() => {
    const all = Object.values(panels)
    const regions = all.filter((p) => p.type === 'region').sort((a, b) => a.z - b.z)
    const labels = all.filter((p) => p.type === 'label').sort((a, b) => a.z - b.z)
    // Windows = floating panels + dock groups, stacked together by z. Panels DOCKED inside a group
    // (dockedIn set) are skipped here — they render inside their group's DockGroupFrame.
    const windows = all
      .filter((p) => p.type !== 'region' && p.type !== 'label' && !p.dockedIn)
      .sort((a, b) => a.z - b.z)
    return { regions, labels, windows, base: regions.length + labels.length + 1 }
  }, [panels])

  return (
    <div
      className="absolute left-0 top-0 h-0 w-0"
      style={{
        transform: `translate(${x}px, ${y}px) scale(${zoom})`,
        transformOrigin: '0 0',
        willChange: interacting ? 'transform' : undefined,
      }}
    >
      {regions.map((panel, i) => (
        <RegionFrame key={panel.id} panel={panel} zIndex={i + 1} />
      ))}
      {labels.map((panel, i) => (
        <TextLabelFrame key={panel.id} panel={panel} zIndex={regions.length + 1 + i} />
      ))}
      {windows.map((panel, i) =>
        panel.type === 'group' ? (
          <DockGroupFrame key={panel.id} panel={panel} zIndex={base + i} />
        ) : (
          <PanelFrame key={panel.id} panel={panel} zIndex={base + i} />
        ),
      )}
    </div>
  )
}
