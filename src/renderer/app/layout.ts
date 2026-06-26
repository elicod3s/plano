/**
 * Auto-organize the canvas into a DESIGNED layout (not just alignment). Odla uses this so the panels
 * it opens — and "organiza todo" — land as a tidy dashboard:
 *   • grouped by type (terminals together, then files, browsers, agents, …),
 *   • each panel normalized to its type's tasteful default size, so a group reads as a clean uniform
 *     set instead of ragged boxes,
 *   • laid out in a balanced grid per group, every row centered, groups stacked with breathing room,
 *   • the whole block centered in view and framed at a readable zoom.
 * The move/resize animates because we raise `useUiStore.arranging` for the duration.
 */
import { PANEL_META, type Panel, type PanelType } from '@shared/domain/panel'
import { screenToWorld, snap } from '@shared/domain/geometry'
import { usePanelStore } from '@/stores/usePanelStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { useUiStore } from '@/stores/useUiStore'

const GRID = 8
const GAP = 28
const GROUP_GAP = 56

/** Display order for type groups (most work-central first). Unknown types fall to the end. */
const TYPE_ORDER: PanelType[] = ['terminal', 'editor', 'files', 'browser', 'agent', 'git', 'markdown', 'todo', 'pomodoro', 'sticky', 'group']
const orderIndex = (t: PanelType): number => {
  const i = TYPE_ORDER.indexOf(t)
  return i === -1 ? 99 : i
}

/** Windows the layout owns: real floating panels + dock groups (ground annotations are skipped). */
function floatingPanels(): Panel[] {
  return Object.values(usePanelStore.getState().panels)
    .filter((p) => !p.dockedIn && p.type !== 'region' && p.type !== 'label')
    .sort((a, b) => a.z - b.z)
}

type Placed = { id: string; x: number; y: number; w: number; h: number }

/**
 * Organize every floating panel. `opts.fit` (default true) frames the result. No-op when empty.
 */
export function arrangeFloating(opts: { fit?: boolean } = {}): void {
  const all = floatingPanels()
  if (all.length === 0) return

  const view = useViewportStore.getState()
  const vw = window.innerWidth
  const vh = window.innerHeight
  const worldWidth = (vw * 0.88) / view.zoom // width budget for one row, in world units

  // Group by type, ordered.
  const byType = new Map<PanelType, Panel[]>()
  for (const p of all) {
    const a = byType.get(p.type) ?? []
    a.push(p)
    byType.set(p.type, a)
  }
  const groups = [...byType.entries()].sort((a, b) => orderIndex(a[0]) - orderIndex(b[0]))

  const placed: Placed[] = []
  let y = 0
  let blockW = 0
  for (const [type, panels] of groups) {
    // Uniform cell size per type → the group looks intentional, not ragged.
    const { width: cw, height: ch } = PANEL_META[type].defaultSize
    const n = panels.length
    const maxCols = Math.max(1, Math.floor((worldWidth + GAP) / (cw + GAP)))
    // Balanced (~√n) columns, but never wider than fits on screen.
    const cols = Math.max(1, Math.min(n, maxCols, Math.ceil(Math.sqrt(n))))
    const rows = Math.ceil(n / cols)
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols)
      const c = i % cols
      placed.push({ id: panels[i].id, x: c * (cw + GAP), y: y + r * (ch + GAP), w: cw, h: ch })
    }
    blockW = Math.max(blockW, cols * cw + (cols - 1) * GAP)
    y += rows * ch + (rows - 1) * GAP + GROUP_GAP
  }
  const blockH = Math.max(0, y - GROUP_GAP)

  // Center every row within the overall block (balances partial rows + narrower groups).
  const rowMap = new Map<number, Placed[]>()
  for (const p of placed) {
    const a = rowMap.get(p.y) ?? []
    a.push(p)
    rowMap.set(p.y, a)
  }
  for (const row of rowMap.values()) {
    const right = Math.max(...row.map((p) => p.x + p.w))
    const off = (blockW - right) / 2
    if (off > 0) for (const p of row) p.x += off
  }

  // Center the block on the current view center (world space), snapped to the grid.
  const center = screenToWorld({ x: vw / 2, y: vh / 2 }, view)
  const originX = snap(center.x - blockW / 2, GRID)
  const originY = snap(center.y - blockH / 2, GRID)

  const ui = useUiStore.getState()
  const resize = usePanelStore.getState().resizePanel
  ui.setArranging(true)
  for (const p of placed) {
    resize(p.id, { x: snap(originX + p.x, GRID), y: snap(originY + p.y, GRID), width: p.w, height: p.h })
  }

  // Frame the tidy block at a READABLE zoom, centered (clamped so it never becomes a tiny speck).
  if (opts.fit !== false) {
    const margin = 90
    const cx = originX + blockW / 2
    const cy = originY + blockH / 2
    const fit = Math.min((vw - margin * 2) / blockW, (vh - margin * 2) / blockH, 1.1)
    const zoom = Math.max(0.45, Math.min(1.1, fit || 1))
    useViewportStore.getState().setTransform({ zoom, x: vw / 2 - cx * zoom, y: vh / 2 - cy * zoom })
  }

  window.setTimeout(() => ui.setArranging(false), 380)
}
