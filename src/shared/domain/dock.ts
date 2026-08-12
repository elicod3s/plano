/**
 * Pure model + geometry for panel docking (VS Code–style split groups). No DOM, no node, no ids
 * minted here (the renderer passes panel ids) — fully unit-testable. A dock "group" is a panel of
 * type 'group' whose `props.layout` is a binary split tree of member panels. Splits are addressed
 * by PATH (a string of 'a'/'b' steps) so no per-node ids are needed and serialization stays minimal.
 */

import { clamp, pointInRect, type Point, type Rect } from './geometry'

export type DockSide = 'left' | 'right' | 'top' | 'bottom'

export type DockNode =
  | { kind: 'pane'; panelId: string }
  | { kind: 'split'; dir: 'row' | 'col'; a: DockNode; b: DockNode; ratio: number }

/** Fraction of a split that child `a` gets is clamped to this range so no pane vanishes. */
export const RATIO_MIN = 0.08
export const RATIO_MAX = 0.92
/** Gutter (px) between panes — the draggable divider band. Shared by render + drop hit-testing. */
export const DOCK_GUTTER = 6

export function makePane(panelId: string): DockNode {
  return { kind: 'pane', panelId }
}

/** All panel ids referenced by the tree, left-to-right / top-to-bottom. */
export function paneIds(node: DockNode): string[] {
  return node.kind === 'pane' ? [node.panelId] : [...paneIds(node.a), ...paneIds(node.b)]
}

/** Join an existing subtree with a new pane on `side` (50/50). */
export function splitWith(existing: DockNode, newPanelId: string, side: DockSide): DockNode {
  const dir = side === 'left' || side === 'right' ? 'row' : 'col'
  const fresh = makePane(newPanelId)
  const newFirst = side === 'left' || side === 'top'
  return { kind: 'split', dir, a: newFirst ? fresh : existing, b: newFirst ? existing : fresh, ratio: 0.5 }
}

/** Insert `newPanelId` beside the pane `targetPaneId`, on `side`. No-op if the target isn't found. */
export function insertPane(node: DockNode, targetPaneId: string, newPanelId: string, side: DockSide): DockNode {
  if (node.kind === 'pane') {
    return node.panelId === targetPaneId ? splitWith(node, newPanelId, side) : node
  }
  return {
    ...node,
    a: insertPane(node.a, targetPaneId, newPanelId, side),
    b: insertPane(node.b, targetPaneId, newPanelId, side),
  }
}

/** Remove a pane, collapsing its parent split into the surviving sibling. Null if the tree is empty. */
export function removePane(node: DockNode, panelId: string): DockNode | null {
  if (node.kind === 'pane') return node.panelId === panelId ? null : node
  const a = removePane(node.a, panelId)
  const b = removePane(node.b, panelId)
  if (a === null) return b
  if (b === null) return a
  return { ...node, a, b }
}

/** Drop panes whose id no longer exists (corrupt/edited doc), collapsing as needed. Null if empty. */
export function pruneMissing(node: DockNode, exists: (id: string) => boolean): DockNode | null {
  if (node.kind === 'pane') return exists(node.panelId) ? node : null
  const a = pruneMissing(node.a, exists)
  const b = pruneMissing(node.b, exists)
  if (a === null) return b
  if (b === null) return a
  return { ...node, a, b }
}

export interface PaneRect {
  panelId: string
  rect: Rect
}
export interface DividerRect {
  /** Path of the split this divider controls (''=root, then 'a'/'b' steps). */
  path: string
  dir: 'row' | 'col'
  /** The slim draggable bar's rect. */
  rect: Rect
  /** The full area of the split, so a drag can convert a cursor position back to a ratio. */
  area: Rect
}
export interface DockLayout {
  panes: PaneRect[]
  dividers: DividerRect[]
}

/** Lay the tree out inside `area` (group-local px), reserving `gutter` px between siblings. */
export function layoutRects(node: DockNode, area: Rect, gutter: number, path = ''): DockLayout {
  if (node.kind === 'pane') {
    return { panes: [{ panelId: node.panelId, rect: area }], dividers: [] }
  }
  const r = clamp(node.ratio, RATIO_MIN, RATIO_MAX)
  let aArea: Rect
  let bArea: Rect
  let dRect: Rect
  if (node.dir === 'row') {
    const aw = Math.max(0, area.width * r - gutter / 2)
    const bw = Math.max(0, area.width - aw - gutter)
    aArea = { x: area.x, y: area.y, width: aw, height: area.height }
    bArea = { x: area.x + aw + gutter, y: area.y, width: bw, height: area.height }
    dRect = { x: area.x + aw, y: area.y, width: gutter, height: area.height }
  } else {
    const ah = Math.max(0, area.height * r - gutter / 2)
    const bh = Math.max(0, area.height - ah - gutter)
    aArea = { x: area.x, y: area.y, width: area.width, height: ah }
    bArea = { x: area.x, y: area.y + ah + gutter, width: area.width, height: bh }
    dRect = { x: area.x, y: area.y + ah, width: area.width, height: gutter }
  }
  const A = layoutRects(node.a, aArea, gutter, path + 'a')
  const B = layoutRects(node.b, bArea, gutter, path + 'b')
  return {
    panes: [...A.panes, ...B.panes],
    dividers: [{ path, dir: node.dir, rect: dRect, area }, ...A.dividers, ...B.dividers],
  }
}

/** Set the ratio of the split addressed by `path`. Clamped; no-op if the path isn't a split. */
export function setRatioAt(node: DockNode, path: string, ratio: number): DockNode {
  if (node.kind !== 'split') return node
  if (path === '') return { ...node, ratio: clamp(ratio, RATIO_MIN, RATIO_MAX) }
  return path[0] === 'a'
    ? { ...node, a: setRatioAt(node.a, path.slice(1), ratio) }
    : { ...node, b: setRatioAt(node.b, path.slice(1), ratio) }
}

/** Which pane (with its rect) sits under a group-local point, or null. */
export function paneAtPoint(node: DockNode, area: Rect, gutter: number, p: Point): PaneRect | null {
  for (const pane of layoutRects(node, area, gutter).panes) {
    if (pointInRect(p, pane.rect)) return pane
  }
  return null
}

/** Nearest edge of `rect` to point `p` → the side the dropped pane should take. */
export function sideForPoint(p: Point, rect: Rect): DockSide {
  const fx = rect.width ? (p.x - rect.x) / rect.width : 0.5
  const fy = rect.height ? (p.y - rect.y) / rect.height : 0.5
  const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy }
  let side: DockSide = 'right'
  let best = Infinity
  for (const s of ['left', 'right', 'top', 'bottom'] as DockSide[]) {
    if (d[s] < best) {
      best = d[s]
      side = s
    }
  }
  return side
}

/** The screen/world rect the dropped pane would occupy within `rect`, for the drop preview.
 *  Uses the DRAG panel's own size (like dockPanel does when it builds the group) instead of a
 *  naive 50/50 split — the preview must match the drop result exactly, or it reads as a lie. */
export function previewRect(rect: Rect, side: DockSide, dragSize?: { width: number; height: number }): Rect {
  // Row split: the dragged pane keeps its own width; the group width = target + drag.
  // Col split: the dragged pane keeps its own height; the group height = target + drag.
  const dw = dragSize?.width ?? rect.width * 0.5
  const dh = dragSize?.height ?? rect.height * 0.5
  switch (side) {
    case 'left':
      return { x: rect.x - dw, y: rect.y, width: dw, height: Math.max(rect.height, dh) }
    case 'right':
      return { x: rect.x + rect.width, y: rect.y, width: dw, height: Math.max(rect.height, dh) }
    case 'top':
      return { x: rect.x, y: rect.y - dh, width: Math.max(rect.width, dw), height: dh }
    case 'bottom':
      return { x: rect.x, y: rect.y + rect.height, width: Math.max(rect.width, dw), height: dh }
  }
}
