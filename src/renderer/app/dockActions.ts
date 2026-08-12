/**
 * Dock operations — merge panels into split "groups", undock them back to floating, and reconcile
 * groups after a workspace load. Member panels STAY in usePanelStore (so their props + terminal PTY
 * survive); docking only sets `dockedIn` + edits the group's split tree. A group with one pane left
 * dissolves back to a single floating panel.
 */

import { pointInRect, type Point, type Rect } from '@shared/domain/geometry'
import type { GroupProps } from '@shared/domain/panel'
import {
  DOCK_GUTTER,
  insertPane,
  layoutRects,
  makePane,
  paneAtPoint,
  paneIds,
  previewRect,
  pruneMissing,
  removePane,
  sideForPoint,
  type DockNode,
  type DockSide,
} from '@shared/domain/dock'
import { usePanelStore } from '@/stores/usePanelStore'
import { killTerminalSession } from '@/app/terminalSessions'

const MIN_FLOAT_W = 200
const MIN_FLOAT_H = 120

function groupLayout(id: string): DockNode | null {
  const p = usePanelStore.getState().panels[id]
  return p && p.type === 'group' ? (p.props as GroupProps).layout : null
}

/** The WORLD rect each pane currently occupies inside `groupRect` — so detaching keeps each pane's
 *  own size/place instead of inheriting the whole group's size. */
function paneWorldRects(layout: DockNode, groupRect: Rect): Record<string, Rect> {
  const out: Record<string, Rect> = {}
  for (const pane of layoutRects(layout, groupRect, DOCK_GUTTER).panes) out[pane.panelId] = pane.rect
  return out
}

/** Round + enforce the floating-panel minimum size. */
function floatRect(r: Rect): Rect {
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.max(MIN_FLOAT_W, Math.round(r.width)),
    height: Math.max(MIN_FLOAT_H, Math.round(r.height)),
  }
}

export interface DockTarget {
  /** The pane/panel to dock beside. */
  targetId: string
  side: DockSide
  /** Where the dropped pane would land, in WORLD coords (for the drop preview). */
  previewWorld: Rect
}

/**
 * Which dock target the world `cursor` is over while dragging panel `selfId` — the topmost window
 * (group or floating panel) under the cursor, drilled into the specific pane + nearest edge.
 * Null over empty canvas. Used by PanelFrame to show the "Drop to place" preview and to dock on drop.
 */
export function computeDockTarget(selfId: string, cursor: Point): DockTarget | null {
  const panels = usePanelStore.getState().panels
  const self = panels[selfId]
  const dragSize = self ? { width: self.rect.width, height: self.rect.height } : undefined
  let top: (typeof panels)[string] | null = null
  for (const p of Object.values(panels)) {
    if (p.id === selfId || p.dockedIn || p.type === 'region' || p.type === 'label') continue
    if (!pointInRect(cursor, p.rect)) continue
    if (!top || p.z > top.z) top = p
  }
  if (!top) return null

  if (top.type === 'group') {
    const local = { x: cursor.x - top.rect.x, y: cursor.y - top.rect.y }
    const innerArea: Rect = { x: 0, y: 0, width: top.rect.width, height: top.rect.height }
    const pane = paneAtPoint((top.props as GroupProps).layout, innerArea, DOCK_GUTTER, local)
    if (!pane) return null
    const side = sideForPoint(local, pane.rect)
    const paneWorld: Rect = {
      x: top.rect.x + pane.rect.x,
      y: top.rect.y + pane.rect.y,
      width: pane.rect.width,
      height: pane.rect.height,
    }
    return { targetId: pane.panelId, side, previewWorld: previewRect(paneWorld, side, dragSize) }
  }

  const side = sideForPoint(cursor, top.rect)
  return { targetId: top.id, side, previewWorld: previewRect(top.rect, side, dragSize) }
}

/**
 * Dock `dragId` next to `targetId` on `side`. If the target is already in a group, the dragged pane
 * is inserted beside it; otherwise a fresh group is created sized to hold both panels at ~their
 * current sizes (so neither is squished), with the split ratio preserving those sizes.
 */
export function dockPanel(dragId: string, targetId: string, side: DockSide): void {
  if (dragId === targetId) return
  const { panels, createGroup, setGroupLayout, setDocked, bringToFront } = usePanelStore.getState()
  const drag = panels[dragId]
  const target = panels[targetId]
  if (!drag || !target || drag.type === 'group') return

  // Target already docked → insert beside its pane in the existing group.
  if (target.dockedIn) {
    const gid = target.dockedIn
    const layout = groupLayout(gid)
    if (!layout) return
    setGroupLayout(gid, insertPane(layout, targetId, dragId, side))
    setDocked(dragId, gid)
    bringToFront(gid)
    return
  }

  // Target floating → build a new group sized to fit both panels.
  const dir = side === 'left' || side === 'right' ? 'row' : 'col'
  const firstIsDrag = side === 'left' || side === 'top'
  let rect: Rect
  let ratio: number
  if (dir === 'row') {
    const width = target.rect.width + drag.rect.width
    const height = Math.max(target.rect.height, drag.rect.height)
    const x = side === 'left' ? target.rect.x - drag.rect.width : target.rect.x
    rect = { x, y: target.rect.y, width, height }
    ratio = firstIsDrag ? drag.rect.width / width : target.rect.width / width
  } else {
    const height = target.rect.height + drag.rect.height
    const width = Math.max(target.rect.width, drag.rect.width)
    const y = side === 'top' ? target.rect.y - drag.rect.height : target.rect.y
    rect = { x: target.rect.x, y, width, height }
    ratio = firstIsDrag ? drag.rect.height / height : target.rect.height / height
  }
  const layout: DockNode = {
    kind: 'split',
    dir,
    a: makePane(firstIsDrag ? dragId : targetId),
    b: makePane(firstIsDrag ? targetId : dragId),
    ratio,
  }
  const gid = createGroup(rect, layout)
  setDocked(targetId, gid)
  setDocked(dragId, gid)
}

/**
 * Pull a pane out to a floating panel. It pops out at the SIZE/PLACE it had inside the group (not
 * the whole group's size), and if only one pane is left the group dissolves with that survivor
 * likewise keeping its own pane size — so detaching just "splits the two apart" cleanly.
 */
export function undockPanel(panelId: string): void {
  const { panels, setDocked, resizePanel, bringToFront } = usePanelStore.getState()
  const p = panels[panelId]
  if (!p || !p.dockedIn) return
  const gid = p.dockedIn
  const group = panels[gid]
  const layout = groupLayout(gid)
  if (!group || !layout) {
    setDocked(panelId, undefined)
    return
  }
  const worldByPane = paneWorldRects(layout, group.rect)
  const next = removePane(layout, panelId)
  setDocked(panelId, undefined)
  resizePanel(panelId, floatRect(worldByPane[panelId] ?? group.rect))
  bringToFront(panelId)
  dissolveOrKeep(gid, next, worldByPane, group.rect)
}

/** Close a docked pane: end its terminal, drop it, dissolve the group if only one pane remains. */
export function closeDockedPanel(panelId: string): void {
  const { panels, removePanel } = usePanelStore.getState()
  const p = panels[panelId]
  if (!p || !p.dockedIn) return
  const gid = p.dockedIn
  const group = panels[gid]
  const layout = groupLayout(gid)
  const worldByPane = layout && group ? paneWorldRects(layout, group.rect) : {}
  const next = layout ? removePane(layout, panelId) : null
  // Dissolve/keep the group BEFORE removing the panel: after removePanel the group would briefly
  // hold a single pane and render a hollow shell until React re-renders — the gray rectangle.
  if (group) dissolveOrKeep(gid, next, worldByPane, group.rect)
  killTerminalSession(panelId)
  removePanel(panelId)
}

/** Keep the group with the new layout, or dissolve it — the last survivor floats at its OWN pane
 *  size/place (from `worldByPane`), never the whole group's size. */
function dissolveOrKeep(gid: string, next: DockNode | null, worldByPane: Record<string, Rect>, fallback: Rect): void {
  const { setGroupLayout, setDocked, resizePanel, removePanel, bringToFront } = usePanelStore.getState()
  if (next && next.kind === 'split') {
    setGroupLayout(gid, next)
    return
  }
  if (next && next.kind === 'pane') {
    const survivor = next.panelId
    setDocked(survivor, undefined)
    resizePanel(survivor, floatRect(worldByPane[survivor] ?? fallback))
    bringToFront(survivor)
  }
  removePanel(gid)
}

/**
 * Repair dock state after a workspace load (defensive against corrupt/edited docs): prune panes
 * whose panel no longer exists, dissolve groups left with <2 panes, and make every panel's
 * `dockedIn` agree with the group that actually references it.
 */
export function reconcileDocks(): void {
  const store = usePanelStore.getState()
  const ids = new Set(Object.keys(store.panels))
  const membership = new Map<string, string>()

  for (const g of Object.values(store.panels)) {
    if (g.type !== 'group') continue
    const original = (g.props as GroupProps).layout
    const worldByPane = paneWorldRects(original, g.rect)
    const pruned = pruneMissing(original, (id) => ids.has(id) && id !== g.id)
    if (pruned && pruned.kind === 'split') {
      store.setGroupLayout(g.id, pruned)
      for (const pid of paneIds(pruned)) membership.set(pid, g.id)
      continue
    }
    // dissolve — survivor keeps its own pane size, not the whole group's.
    if (pruned && pruned.kind === 'pane' && store.panels[pruned.panelId]) {
      store.setDocked(pruned.panelId, undefined)
      store.resizePanel(pruned.panelId, floatRect(worldByPane[pruned.panelId] ?? g.rect))
    }
    store.removePanel(g.id)
  }

  for (const p of Object.values(usePanelStore.getState().panels)) {
    if (p.type === 'group') continue
    const should = membership.get(p.id)
    if (p.dockedIn !== should) store.setDocked(p.id, should)
  }
}
