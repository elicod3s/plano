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
        const x1 = a.x + a.width
        const y1 = a.y + a.height / 2
        const x2 = b.x
        const y2 = b.y + b.height / 2
        const mid = (x1 + x2) / 2
        const d = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`
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
