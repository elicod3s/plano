/**
 * Pure geometry for panel snapping — Windows-style window joining + Aero-snap tiling. No DOM, no
 * node: usable on both sides and unit-testable. Three helpers:
 *   - computeMoveSnap   : magnetic EDGE snapping to ADJACENT panels (flush stick) + grid fallback
 *   - computeResizeSnap : snap the dragged edge to an adjacent panel's parallel edge (+ grid)
 *   - computeSnapZone   : Aero-style drop zones from the cursor near the viewport border
 *
 * Design (matches the user's "stick like Windows" mental model):
 *  - EDGES ONLY (left/right, top/bottom). No center anchors — center matches produce meaningless
 *    "edge lands on another panel's middle" snaps that never read as sticking.
 *  - ADJACENCY GATE: a panel is only a snap target on an axis when its span on the PERPENDICULAR
 *    axis is adjacent to the dragged panel (gap ≤ adjMargin), AND the two panels don't meaningfully
 *    overlap in 2D (you never snap to a panel you're dragging ON TOP OF). Far panels are excluded.
 *  - ABUTMENT (flush touching edges) snaps but draws NO line — the panels touching IS the feedback,
 *    like Windows. Only a CO-EDGE alignment (edges line up across a gap) draws a short guide, bounded
 *    to where the two panels overlap perpendicularly so it can never spill into the canvas.
 */

import { snap, screenToWorld, type Point, type Rect, type Size, type Transform } from './geometry'

/** A single alignment line to draw while snapping. World coordinates. */
export interface Guide {
  /** 'x' → a vertical line at world x = pos; 'y' → a horizontal line at world y = pos. */
  axis: 'x' | 'y'
  pos: number
  /** Segment extent (world coords) along the perpendicular axis — the panels' shared overlap. */
  start: number
  end: number
}

export interface MoveSnapOptions {
  /** Magnet radius in WORLD units (caller divides a screen-px threshold by zoom). */
  threshold: number
  grid: number
  gridSnap: boolean
  /** Max perpendicular gap (WORLD px, caller passes screen-px ÷ zoom) for panels to count adjacent. */
  adjMargin: number
  /** Min perpendicular overlap (WORLD px, screen-px ÷ zoom) before a ring/guide is shown. */
  minGuideOverlap: number
}

export interface MoveSnapResult {
  x: number
  y: number
  guides: Guide[]
  /** The panel rect(s) being joined against — for highlighting the target container(s). */
  targets: Rect[]
}

interface EdgeMatch {
  /** How far to move the dragged panel along the axis to land flush. */
  delta: number
  /** World line position of the snapped edge (for the guide). */
  pos: number
  other: Rect
  /** Perpendicular overlap of the two panels (world), for a tight guide. */
  ovStart: number
  ovEnd: number
  /** True when the matched edges are touching (abutment) rather than lined-up across a gap. */
  abut: boolean
}

/**
 * Best edge snap along one axis. Considers ONLY panels adjacent on the perpendicular axis
 * (perpGap ≤ adjMargin) that the dragged panel does NOT sit on top of (no meaningful 2D overlap),
 * and ONLY edge↔edge pairings (co-edge + abutment) — never centers. On an exact tie, prefers the
 * perpendicularly-closest panel so the guide/target is the real neighbour.
 */
function bestEdgeMatch(
  aLead: number,
  aTrail: number,
  aPerpLead: number,
  aPerpTrail: number,
  others: Rect[],
  axisSpan: (o: Rect) => readonly [number, number],
  perpSpan: (o: Rect) => readonly [number, number],
  threshold: number,
  adjMargin: number,
): EdgeMatch | null {
  let best: EdgeMatch | null = null
  let bestPerpGap = Infinity
  for (const o of others) {
    const [oLead, oTrail] = axisSpan(o)
    const [opLead, opTrail] = perpSpan(o)
    const perpGap = Math.max(0, Math.max(aPerpLead, opLead) - Math.min(aPerpTrail, opTrail))
    if (perpGap > adjMargin) continue
    // Skip panels we're dragging ON TOP OF: a real neighbour is laterally separated. A 2D
    // intersection means overlap on BOTH axes; allow ~0 on either (flush abutment / gap co-edge).
    const axisOv = Math.min(aTrail, oTrail) - Math.max(aLead, oLead)
    const perpOv = Math.min(aPerpTrail, opTrail) - Math.max(aPerpLead, opLead)
    if (axisOv > threshold && perpOv > threshold) continue
    const ovStart = Math.max(aPerpLead, opLead)
    const ovEnd = Math.min(aPerpTrail, opTrail)
    const pairs: ReadonlyArray<readonly [number, number, boolean]> = [
      [aLead, oLead, false], // co-edge: leading ↔ leading
      [aTrail, oTrail, false], // co-edge: trailing ↔ trailing
      [aLead, oTrail, true], // abutment: our leading edge meets their trailing edge
      [aTrail, oLead, true], // abutment: our trailing edge meets their leading edge
    ]
    for (const [anchor, line, abut] of pairs) {
      const d = line - anchor
      const ad = Math.abs(d)
      if (ad > threshold) continue
      const better =
        best === null ||
        ad < Math.abs(best.delta) - 1e-6 ||
        (Math.abs(ad - Math.abs(best.delta)) <= 1e-6 && perpGap < bestPerpGap)
      if (better) {
        best = { delta: d, pos: line, other: o, ovStart, ovEnd, abut }
        bestPerpGap = perpGap
      }
    }
  }
  return best
}

/**
 * Magnetic flush snap for a dragged panel: each axis independently snaps the panel's edge to an
 * adjacent panel's edge (co-edge or abutment). Falls back to the grid when nothing adjacent is in
 * range. A container is ringed only on a real join (overlap > minGuideOverlap); a guide LINE is
 * drawn only for co-edge alignments (abutments are flush — the touch is the feedback).
 */
export function computeMoveSnap(rect: Rect, others: Rect[], opts: MoveSnapOptions): MoveSnapResult {
  const aRight = rect.x + rect.width
  const aBottom = rect.y + rect.height
  const mx = bestEdgeMatch(
    rect.x,
    aRight,
    rect.y,
    aBottom,
    others,
    (o) => [o.x, o.x + o.width],
    (o) => [o.y, o.y + o.height],
    opts.threshold,
    opts.adjMargin,
  )
  const my = bestEdgeMatch(
    rect.y,
    aBottom,
    rect.x,
    aRight,
    others,
    (o) => [o.y, o.y + o.height],
    (o) => [o.x, o.x + o.width],
    opts.threshold,
    opts.adjMargin,
  )

  let x = mx ? rect.x + mx.delta : opts.gridSnap ? snap(rect.x, opts.grid) : rect.x
  let y = my ? rect.y + my.delta : opts.gridSnap ? snap(rect.y, opts.grid) : rect.y
  x = Math.round(x)
  y = Math.round(y)

  const guides: Guide[] = []
  const targets: Rect[] = []
  const consider = (m: EdgeMatch | null, axis: 'x' | 'y'): void => {
    if (!m || m.ovEnd - m.ovStart <= opts.minGuideOverlap) return
    if (!targets.includes(m.other)) targets.push(m.other)
    if (!m.abut) guides.push({ axis, pos: m.pos, start: m.ovStart, end: m.ovEnd })
  }
  consider(mx, 'x')
  consider(my, 'y')
  return { x, y, guides, targets }
}

export interface ResizeSnapOptions extends MoveSnapOptions {
  minW: number
  minH: number
}

export interface ResizeSnapResult {
  rect: Rect
  guides: Guide[]
  targets: Rect[]
}

export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

interface EdgeSnap {
  value: number
  ovStart: number
  ovEnd: number
  matched: boolean
  abut: boolean
  other: Rect | null
}

/**
 * Snap one moving edge to the nearest adjacent panel's parallel edge, else to the grid. `axisOther`
 * is the panel's opposite (fixed) edge on the snap axis; `leadingEdge` marks whether the moving edge
 * is the panel's leading edge (left/top → w/n) so abutment can be told from co-edge.
 */
function snapMovingEdge(
  edge: number,
  axisOther: number,
  perpLead: number,
  perpTrail: number,
  others: Rect[],
  axisSpan: (o: Rect) => readonly [number, number],
  perpSpan: (o: Rect) => readonly [number, number],
  opts: ResizeSnapOptions,
  leadingEdge: boolean,
): EdgeSnap {
  const aLo = Math.min(edge, axisOther)
  const aHi = Math.max(edge, axisOther)
  let best: { value: number; ovStart: number; ovEnd: number; gap: number; abut: boolean; other: Rect } | null = null
  for (const o of others) {
    const [oLead, oTrail] = axisSpan(o)
    const [opLead, opTrail] = perpSpan(o)
    const perpGap = Math.max(0, Math.max(perpLead, opLead) - Math.min(perpTrail, opTrail))
    if (perpGap > opts.adjMargin) continue
    const axisOv = Math.min(aHi, oTrail) - Math.max(aLo, oLead)
    const perpOv = Math.min(perpTrail, opTrail) - Math.max(perpLead, opLead)
    if (axisOv > opts.threshold && perpOv > opts.threshold) continue
    const ovStart = Math.max(perpLead, opLead)
    const ovEnd = Math.min(perpTrail, opTrail)
    for (const line of [oLead, oTrail]) {
      const ad = Math.abs(line - edge)
      if (ad > opts.threshold) continue
      const cur = best ? Math.abs(best.value - edge) : Infinity
      if (best === null || ad < cur - 1e-6 || (Math.abs(ad - cur) <= 1e-6 && perpGap < best.gap)) {
        const abut = leadingEdge ? line === oTrail : line === oLead
        best = { value: line, ovStart, ovEnd, gap: perpGap, abut, other: o }
      }
    }
  }
  if (best) {
    return { value: best.value, ovStart: best.ovStart, ovEnd: best.ovEnd, matched: true, abut: best.abut, other: best.other }
  }
  return { value: opts.gridSnap ? snap(edge, opts.grid) : edge, ovStart: 0, ovEnd: 0, matched: false, abut: false, other: null }
}

/**
 * Snap the moving edge(s) of a resize to an adjacent panel's parallel edge (and the grid),
 * preserving the opposite edge and the min-size floor. Same adjacency gate, abutment-quiet guide,
 * and target ring as the move snap.
 */
export function computeResizeSnap(
  rect: Rect,
  dir: ResizeDir,
  others: Rect[],
  opts: ResizeSnapOptions,
): ResizeSnapResult {
  let { x, y, width, height } = rect
  const right = x + width
  const bottom = y + height
  const guides: Guide[] = []
  const targets: Rect[] = []
  const vAxis = (o: Rect): readonly [number, number] => [o.x, o.x + o.width]
  const vPerp = (o: Rect): readonly [number, number] => [o.y, o.y + o.height]
  const hAxis = (o: Rect): readonly [number, number] => [o.y, o.y + o.height]
  const hPerp = (o: Rect): readonly [number, number] => [o.x, o.x + o.width]
  const pushSnap = (axis: 'x' | 'y', s: EdgeSnap, ok: boolean): void => {
    if (!s.matched || !ok || s.ovEnd - s.ovStart <= opts.minGuideOverlap) return
    if (s.other && !targets.includes(s.other)) targets.push(s.other)
    if (!s.abut) guides.push({ axis, pos: s.value, start: s.ovStart, end: s.ovEnd })
  }

  if (dir.includes('e')) {
    const s = snapMovingEdge(right, x, y, bottom, others, vAxis, vPerp, opts, false)
    width = Math.max(opts.minW, s.value - x)
    pushSnap('x', s, width > opts.minW)
  }
  if (dir.includes('w')) {
    const s = snapMovingEdge(x, right, y, bottom, others, vAxis, vPerp, opts, true)
    const w = Math.max(opts.minW, right - s.value)
    x = right - w
    width = w
    pushSnap('x', s, w > opts.minW)
  }
  // Use the panel's LIVE right edge (after any e/w snap) for the vertical edges' perpendicular span.
  const liveRight = x + width
  if (dir.includes('s')) {
    const s = snapMovingEdge(bottom, y, x, liveRight, others, hAxis, hPerp, opts, false)
    height = Math.max(opts.minH, s.value - y)
    pushSnap('y', s, height > opts.minH)
  }
  if (dir.includes('n')) {
    const s = snapMovingEdge(y, bottom, x, liveRight, others, hAxis, hPerp, opts, true)
    const h = Math.max(opts.minH, bottom - s.value)
    y = bottom - h
    height = h
    pushSnap('y', s, h > opts.minH)
  }

  return {
    rect: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) },
    guides,
    targets,
  }
}

// ── Aero-style snap zones ──

export type SnapZoneId = 'left' | 'right' | 'maximize' | 'tl' | 'tr' | 'bl' | 'br'

export interface SnapZone {
  id: SnapZoneId
  /** Target rect in canvas-local screen pixels. */
  rect: Rect
}

export interface SnapZoneOptions {
  /** Distance from the viewport border (px) that arms a zone. */
  edge: number
  /** How far along an edge (px) still counts as the corner (quadrant) zone. */
  corner: number
}

/**
 * Map a cursor near the viewport border to a tiling zone (cursor coords + size are canvas-local
 * screen px): corners → quadrants, left/right edges → halves, top edge → maximize. Null otherwise.
 */
export function computeSnapZone(pointer: Point, size: Size, opts: SnapZoneOptions): SnapZone | null {
  const { width: w, height: h } = size
  const { edge, corner } = opts
  const nearL = pointer.x <= edge
  const nearR = pointer.x >= w - edge
  const nearT = pointer.y <= edge
  const zone = (id: SnapZoneId, x: number, y: number, width: number, height: number): SnapZone => ({
    id,
    rect: { x, y, width, height },
  })

  if (nearL && pointer.y <= corner) return zone('tl', 0, 0, w / 2, h / 2)
  if (nearL && pointer.y >= h - corner) return zone('bl', 0, h / 2, w / 2, h / 2)
  if (nearR && pointer.y <= corner) return zone('tr', w / 2, 0, w / 2, h / 2)
  if (nearR && pointer.y >= h - corner) return zone('br', w / 2, h / 2, w / 2, h / 2)
  if (nearL) return zone('left', 0, 0, w / 2, h)
  if (nearR) return zone('right', w / 2, 0, w / 2, h)
  if (nearT) return zone('maximize', 0, 0, w, h)
  return null
}

/** Convert a canvas-local screen-px zone rect to a world rect under the given camera. */
export function zoneToWorldRect(zoneRect: Rect, t: Transform): Rect {
  const tl = screenToWorld({ x: zoneRect.x, y: zoneRect.y }, t)
  const br = screenToWorld({ x: zoneRect.x + zoneRect.width, y: zoneRect.y + zoneRect.height }, t)
  return {
    x: Math.round(tl.x),
    y: Math.round(tl.y),
    width: Math.round(br.x - tl.x),
    height: Math.round(br.y - tl.y),
  }
}
