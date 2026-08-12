import { useMemo, useEffect, useRef, type CSSProperties } from 'react'
import { useViewportStore } from '@/stores/useViewportStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { viewportController } from './ViewportController'
import { PanelFrame } from '@/panels/_base/PanelFrame'
import { DockGroupFrame } from '@/canvas/DockGroupFrame'
import { RegionFrame } from '@/panels/region/RegionFrame'
import { TextLabelFrame } from '@/panels/label/TextLabelFrame'
import { MeshLinkLayer } from '@/canvas/MeshLinkLayer'

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
  // The canvas root shows the hand (grab) cursor for its left-drag pan. cursor is inherited,
  // so reset it here or every panel surface without an explicit cursor would show the hand
  // too. While a pan is live, show the closed hand even when the world slides a panel under
  // the pointer mid-drag.
  const isPanning = useViewportStore((s) => s.isPanning)
  const panels = usePanelStore((s) => s.panels)

  // Categorize/sort only when the panel SET materially changes — not on every pan/zoom and not
  // on a pure `move` (plan D2): the cheap signature (ids+z+type+dockedIn) is stable across a
  // drag, so the filter+sort below bails out even though the `panels` registry reference moved.
  //
  // CRITICAL: the memo may only cache IDS and the z-order map — never the panel OBJECTS. Caching
  // the objects froze them at the last signature change, so a drag (which changes only `rect`)
  // handed PanelFrame a stale panel and the window never moved on screen while the snap guides,
  // which read their own store, kept working. Panels are always read live from `panels` below.
  const panelSig = Object.values(panels)
    .map((p) => `${p.id}:${p.z}:${p.type}:${p.dockedIn ?? ''}`)
    .join('|')
  const { regionIds, labelIds, windowIds, windowZ } = useMemo(() => {
    const all = Object.values(panels)
    const regionIds = all.filter((p) => p.type === 'region').sort((a, b) => a.z - b.z).map((p) => p.id)
    const labelIds = all.filter((p) => p.type === 'label').sort((a, b) => a.z - b.z).map((p) => p.id)
    // Windows = floating panels + dock groups, stacked together by z. Panels DOCKED inside a group
    // (dockedIn set) are skipped here — they render inside their group's DockGroupFrame.
    // Stable DOM order is essential for editors. Reordering a live contenteditable on
    // pointerdown can reset its native selection and scroll. Only CSS z-index should change.
    const windows = all.filter((p) => p.type !== 'region' && p.type !== 'label' && !p.dockedIn)
    const base = regionIds.length + labelIds.length + 1
    const windowZ: Record<string, number> = {}
    ;[...windows]
      .sort((a, b) => a.z - b.z)
      .forEach((panel, index) => {
        windowZ[panel.id] = base + index
      })
    return { regionIds, labelIds, windowIds: windows.map((p) => p.id), windowZ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelSig])

  const worldRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    viewportController.attachWorld(worldRef.current)
    return () => viewportController.attachWorld(null)
  }, [])

  // No viewport culling of panel BODIES. It was tried (plan B2/B3 level 2) and reverted: the
  // cull set could only be recomputed on camera settle, so it lagged any panel the user moved
  // and showed an "off screen" placeholder over live content; unmounting a body also destroyed
  // state the user expects to survive a pan (CodeMirror undo history, the Files tree's expanded
  // dirs and scroll). The isolation win comes from `contain: layout paint style` per panel,
  // which is unconditional and has no lifecycle side effects.

  return (
    <div
      ref={worldRef}
      data-world-layer
      className="absolute left-0 top-0 h-0 w-0"
      style={
        {
          // ONE permanent camera owner: this world layer carries the camera at rest AND
          // during interaction. React renders it from the settled store; ViewportController
          // writes the SAME transform imperatively per frame while a gesture runs and never
          // moves it to another node. Panels keep only their static world position.
          transform: `translate3d(${x}px, ${y}px, 0) scale(${zoom})`,
          transformOrigin: '0 0',
          // Promote exactly ONE world layer during motion (never per-panel will-change).
          willChange: interacting ? 'transform' : undefined,
          cursor: isPanning ? 'grabbing' : 'default',
        } as CSSProperties
      }
    >
      {/* Plan F7: mesh message links — one svg behind the panels, pure CSS animation. */}
      <MeshLinkLayer />
      {/* Panels are read LIVE from the store record here — the memo above only supplies order.
          A `rect` change (drag/resize) must reach the frame on the very next render. */}
      {regionIds.map((id, i) =>
        panels[id] ? <RegionFrame key={id} panel={panels[id]} zIndex={i + 1} /> : null,
      )}
      {labelIds.map((id, i) =>
        panels[id] ? <TextLabelFrame key={id} panel={panels[id]} zIndex={regionIds.length + 1 + i} /> : null,
      )}
      {windowIds.map((id) => {
        const panel = panels[id]
        if (!panel) return null
        return panel.type === 'group' ? (
          <DockGroupFrame key={id} panel={panel} zIndex={windowZ[id]} />
        ) : (
          <PanelFrame key={id} panel={panel} zIndex={windowZ[id]} />
        )
      })}
    </div>
  )
}
