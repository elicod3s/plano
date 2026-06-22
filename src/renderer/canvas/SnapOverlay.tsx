import { type CSSProperties } from 'react'
import { useViewportStore } from '@/stores/useViewportStore'
import { useSnapStore } from '@/stores/useSnapStore'
import { Icon } from '@/design-system/Icon'

/** lucide icon depicting a panel docked to each side — our own affordance, not a borrowed string. */
const SIDE_ICON = { left: 'PanelLeft', right: 'PanelRight', top: 'PanelTop', bottom: 'PanelBottom' } as const

/**
 * Screen-space feedback for an in-progress snap. Sits inset-0 over the canvas, sharing the canvas's
 * local origin — so worldToScreen here yields overlay-local pixels directly (the world layer is
 * pinned at canvas-local 0,0). Pointer-inert. Draws three things:
 *   - alignment guides (crisp accent hairlines where edges/centers line up),
 *   - target-container highlights (an accent ring on the panel being joined — the "lego" feedback),
 *   - the Windows-style zone preview (a soft accent fill where the panel will tile on drop).
 * Everything is accent/white + token-driven, so it follows the user's theme and reduced-motion.
 */
const PANEL_RADIUS = 16 // matches PanelFrame's rounded-lg, scaled by zoom so corners line up
const GUIDE_PAD = 6 // px the hairline overshoots the shared edge, for a measured look (kept small so it never spills)

export function SnapOverlay() {
  const vx = useViewportStore((s) => s.x)
  const vy = useViewportStore((s) => s.y)
  const zoom = useViewportStore((s) => s.zoom)
  const active = useSnapStore((s) => s.active)
  const guides = useSnapStore((s) => s.guides)
  const targets = useSnapStore((s) => s.targets)
  const zone = useSnapStore((s) => s.zone)
  const dock = useSnapStore((s) => s.dock)

  if (!active) return null

  const accent = 'var(--accent-primary)'

  return (
    <div className="pointer-events-none absolute inset-0 z-[15] overflow-hidden">
      {/* dock-merge preview — the region a dragged panel will merge into, with our own side cue */}
      {dock && (
        <div
          className="animate-menu-in absolute flex items-center justify-center"
          style={{
            left: dock.rect.x,
            top: dock.rect.y,
            width: dock.rect.width,
            height: dock.rect.height,
            borderRadius: PANEL_RADIUS,
            border: `1.5px solid color-mix(in srgb, ${accent} 60%, transparent)`,
            background: `color-mix(in srgb, ${accent} 14%, transparent)`,
            boxShadow: `inset 0 0 30px -8px color-mix(in srgb, ${accent} 35%, transparent)`,
          }}
        >
          <span
            className="flex items-center gap-1.5 rounded-pill px-2.5 py-1"
            style={{
              background: 'color-mix(in srgb, var(--bg-base) 72%, transparent)',
              border: `1px solid color-mix(in srgb, ${accent} 30%, transparent)`,
            }}
          >
            <Icon name={SIDE_ICON[dock.side]} size={13} className="text-text-primary" />
            <span className="label-caps text-text-secondary">Merge {dock.side}</span>
          </span>
        </div>
      )}

      {/* target containers — an accent ring around the panel(s) being joined */}
      {targets.map((r, i) => {
        const style: CSSProperties = {
          left: r.x * zoom + vx,
          top: r.y * zoom + vy,
          width: r.width * zoom,
          height: r.height * zoom,
          borderRadius: PANEL_RADIUS * zoom,
          border: `1.5px solid color-mix(in srgb, ${accent} 55%, transparent)`,
          background: `color-mix(in srgb, ${accent} 6%, transparent)`,
          boxShadow: `0 0 0 1px color-mix(in srgb, ${accent} 12%, transparent)`,
        }
        return <div key={`t${i}`} className="animate-menu-in absolute" style={style} />
      })}

      {/* alignment guides */}
      {guides.map((g, i) => {
        const common: CSSProperties = {
          background: accent,
          opacity: 0.95,
          borderRadius: 9999,
          boxShadow: `0 0 8px 0 color-mix(in srgb, ${accent} 45%, transparent)`,
        }
        if (g.axis === 'x') {
          const sx = g.pos * zoom + vx
          const y1 = g.start * zoom + vy
          const y2 = g.end * zoom + vy
          const len = Math.abs(y2 - y1)
          // Cap overshoot at ≤50% of the on-screen overlap (so it never dominates a short guide),
          // and clamp total length to the viewport so it can never paint a runaway line.
          const pad = Math.min(GUIDE_PAD, len * 0.5)
          const height = Math.min(len + pad * 2, window.innerHeight)
          return (
            <div
              key={`g${i}`}
              className="absolute"
              style={{ ...common, left: sx - 1, top: Math.min(y1, y2) - pad, width: 1.5, height }}
            />
          )
        }
        const sy = g.pos * zoom + vy
        const x1 = g.start * zoom + vx
        const x2 = g.end * zoom + vx
        const len = Math.abs(x2 - x1)
        const pad = Math.min(GUIDE_PAD, len * 0.5)
        const width = Math.min(len + pad * 2, window.innerWidth)
        return (
          <div
            key={`g${i}`}
            className="absolute"
            style={{ ...common, top: sy - 1, left: Math.min(x1, x2) - pad, height: 1.5, width }}
          />
        )
      })}

      {/* Windows-style zone preview (already in canvas-local screen px) */}
      {zone && (
        <div
          className="animate-menu-in absolute"
          style={{
            left: zone.rect.x,
            top: zone.rect.y,
            width: zone.rect.width,
            height: zone.rect.height,
            borderRadius: PANEL_RADIUS,
            border: `1.5px solid color-mix(in srgb, ${accent} 50%, transparent)`,
            background: `color-mix(in srgb, ${accent} 12%, transparent)`,
            boxShadow: `inset 0 0 24px -6px color-mix(in srgb, ${accent} 30%, transparent)`,
          }}
        />
      )}
    </div>
  )
}
