/**
 * MeshLinkLayer (plan F7 + v3 E): ONE <svg> inside the world layer, behind the panels,
 * drawing ONE bezier per PERSISTENT relation between a pair of agents:
 *   active   — collaborating (traffic < 60 s or ask open): line at ~0.35, slow pulse
 *   waiting  — asker waits: breathing dot at the receiver's end
 *   done     — resolved: fades out over ~2 s, then leaves
 *   failed   — timeout/error: short flash in --destructive, then leaves
 * Direction is visible: the pulse travels emitter → receiver. Relations are grouped per
 * pair (counter when > 1). Animation is pure CSS (offset-path) — React NEVER re-renders
 * per frame, and no inherited custom properties are written on any ancestor. The outer
 * shell subscribes ONLY to the link set; the inner layer reads live panel rects only
 * while links exist. Reduced motion → static lines.
 */

import { useEffect } from 'react'
import { usePanelStore } from '@/stores/usePanelStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useMeshLinks, ingestMeshEvent } from '@/stores/useMeshLinks'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where a link leaves one panel and meets the other, and the curve between them.
 *
 * This used to be hardcoded as "out of A's right edge, into B's left edge". On a canvas that is
 * two-dimensional that is wrong most of the time: a panel sitting BELOW another still had its
 * line exit sideways and loop back in, and a peer placed to the LEFT got a curve that ran
 * backwards straight through both windows. The relation looked like a glitch instead of a link.
 *
 * So the dominant axis between the two centres picks the faces: mostly-horizontal panels connect
 * side to side, mostly-vertical ones connect bottom to top (or top to bottom). Control points
 * extend along the direction the line LEAVES by, which is what gives a cable its natural ease-out
 * instead of a kink at the panel edge.
 */
function linkPath(a: Rect, b: Rect): { x1: number; y1: number; x2: number; y2: number; d: string } {
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 }
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  const dx = bc.x - ac.x
  const dy = bc.y - ac.y
  // Vertical whenever one panel sits CLEAR of the other vertically; horizontal only for panels
  // that share a horizontal band.
  //
  // The old rule compared centre distances, which reads a spawn tree backwards: a row of siblings
  // sits below its parent, but an outer sibling's centre is further away horizontally than
  // vertically, so its edge left the parent's SIDE and cut straight across the siblings in
  // between. "Is it below me" is the parent/child relation the layout draws, so it decides.
  const vGap = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height))
  const horizontal = vGap <= 0

  let x1: number, y1: number, x2: number, y2: number
  if (horizontal) {
    x1 = dx >= 0 ? a.x + a.width : a.x
    x2 = dx >= 0 ? b.x : b.x + b.width
    // Meet at the shared vertical span when the panels overlap, so a link between two panels of
    // very different heights doesn't sag across one of them.
    const top = Math.max(a.y, b.y)
    const bottom = Math.min(a.y + a.height, b.y + b.height)
    const shared = bottom > top ? (top + bottom) / 2 : null
    y1 = shared ?? ac.y
    y2 = shared ?? bc.y
  } else {
    y1 = dy >= 0 ? a.y + a.height : a.y
    y2 = dy >= 0 ? b.y : b.y + b.height
    const left = Math.max(a.x, b.x)
    const right = Math.min(a.x + a.width, b.x + b.width)
    const shared = right > left ? (left + right) / 2 : null
    x1 = shared ?? ac.x
    x2 = shared ?? bc.x
  }

  // Curvature scales with the gap, clamped so touching panels still get a readable bow and very
  // distant ones don't balloon into a semicircle.
  const gap = horizontal ? Math.abs(x2 - x1) : Math.abs(y2 - y1)
  const k = Math.max(28, Math.min(gap * 0.5, 160))
  const c1 = horizontal ? `${x1 + (dx >= 0 ? k : -k)} ${y1}` : `${x1} ${y1 + (dy >= 0 ? k : -k)}`
  const c2 = horizontal ? `${x2 - (dx >= 0 ? k : -k)} ${y2}` : `${x2} ${y2 - (dy >= 0 ? k : -k)}`
  return { x1, y1, x2, y2, d: `M ${x1} ${y1} C ${c1}, ${c2}, ${x2} ${y2}` }
}

/**
 * Outer shell: subscribes ONLY to the link set, which changes rarely. It deliberately does NOT
 * touch the panel registry — that reference changes on every pointer frame of every drag, and
 * subscribing here would re-render this component 60×/s just to draw nothing. The inner layer
 * (which genuinely needs live panel rects so a link follows a dragged panel) mounts only while
 * at least one link exists.
 */
export function MeshLinkLayer() {
  const links = useMeshLinks()
  useEffect(() => window.plano.agentMesh.onMeshEvent(ingestMeshEvent), [])
  if (links.length === 0) return null
  // v4 A1 made rest links PERSIST, which quietly broke the split above: once any two agents had
  // talked, `links` was never empty again, so the inner layer stayed mounted forever and
  // re-rendered on every pointer frame of every drag. A rest link is a faint hint, not live
  // feedback — it does not need to track a dragged panel frame by frame. So only subscribe to
  // the panel registry while something is actually happening; otherwise draw from a snapshot
  // that refreshes when the link set or the panel set changes. (Long-task counters do NOT catch
  // this: it is steady per-frame React work, the same class of cost that hid the 424 ms style
  // recalc earlier in this project.)
  const live = links.some((l) => l.state === 'active' || l.state === 'waiting')
  return live ? <MeshLinkPathsLive links={links} /> : <MeshLinkPathsRest links={links} />
}

/** Rest-only: no per-frame subscription. Rects are read once per render of the link set. */
function MeshLinkPathsRest({ links }: { links: ReturnType<typeof useMeshLinks> }) {
  const panels = usePanelStore.getState().panels
  return <MeshLinkSvg links={links} panels={panels} />
}

/** Something is in flight: follow the panels live so the line tracks a dragged agent. */
function MeshLinkPathsLive({ links }: { links: ReturnType<typeof useMeshLinks> }) {
  const panels = usePanelStore((s) => s.panels)
  return <MeshLinkSvg links={links} panels={panels} />
}

function MeshLinkSvg({
  links,
  panels,
}: {
  links: ReturnType<typeof useMeshLinks>
  panels: ReturnType<typeof usePanelStore.getState>['panels']
}) {
  // See linkPath below — anchors are chosen from the panels' real relative position.
  const reduced = useSettingsStore((s) => s.settings.appearance.reduceMotion)

  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute left-0 top-0 z-[2]"
      style={{ overflow: 'visible', width: 1, height: 1 }}
    >
      {links.map((link) => {
        const a = panels[link.fromPanel]?.rect
        const b = panels[link.toPanel]?.rect
        if (!a || !b) return null
        const { x1, y1, x2, y2, d } = linkPath(a, b)
        const failed = link.state === 'failed'
        const color = failed ? 'var(--destructive, #f87171)' : link.color
        const opacity = failed ? 0.9 : link.state === 'done' ? 0.15 : link.state === 'waiting' ? 0.5 : link.state === 'active' ? 0.35 : 0.1
        const width = link.state === 'idle' ? 1 : 1.5
        return (
          <g key={link.id}>
            <path
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={width}
              strokeLinecap="round"
              opacity={opacity}
              // v4 A4/B1: an armed chain is a dashed line until it fires.
              strokeDasharray={link.chained ? '4 3' : undefined}
              style={reduced ? undefined : { transition: 'opacity 600ms ease' }}
            />
            {link.state === 'active' && !reduced && (
              <circle
                r={2.5}
                fill={color}
                style={{ offsetPath: `path('${d}')`, offsetDistance: '0%', animation: 'mesh-pulse-loop 3s linear infinite' }}
              />
            )}
            {/* v4 A4: a resolving reply travels BACK (responder → asker) before resting. */}
            {link.state === 'done' && !reduced && (
              <circle r={2.5} fill={color} style={{ offsetPath: `path('${d}')`, offsetDistance: '0%', animation: 'mesh-pulse 1.8s cubic-bezier(0.22, 1, 0.36, 1) forwards' }} />
            )}
            {link.state === 'waiting' && !reduced && <circle r={2.5} fill={color} cx={x2} cy={y2} style={{ animation: 'mesh-breathe 1.4s ease-in-out infinite' }} />}
            {link.count > 1 && (
              <text
                x={(x1 + x2) / 2}
                y={(y1 + y2) / 2 - 6}
                textAnchor="middle"
                fontSize={9}
                fill={color}
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {link.count}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
