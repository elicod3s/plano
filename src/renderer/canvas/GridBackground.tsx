import { useEffect, useLayoutEffect, useRef } from 'react'
import { useViewportStore } from '@/stores/useViewportStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { viewportController } from './ViewportController'

/** Minor/major drafting-grid spacing per gridSize preset. */
const GRID_SPACING: Record<'fine' | 'standard' | 'coarse', { minor: number; major: number }> = {
  fine: { minor: 16, major: 64 },
  standard: { minor: 24, major: 96 },
  coarse: { minor: 36, major: 144 },
}

const SPOT_RADIUS = 165 // px (screen space) of the cursor illumination

/**
 * The blueprint substrate: a faint draftsman grid (dots @ minor spacing, major hairlines
 * @96px) drawn in screen space but offset + scaled by the camera, so it reads as
 * plan-paper the panels are pinned to. The grid is the one thing that scales with zoom.
 *
 * A second, identically-aligned dot layer (brighter) is masked by a radial gradient that
 * follows the cursor — the "illuminate the grid" spotlight. The mask centre is driven by
 * CSS variables written straight to the DOM on a rAF-throttled pointermove, so cursor
 * motion never re-renders React. It scales with grid strength like the grid itself.
 */
export function GridBackground() {
  const x = useViewportStore((s) => s.x)
  const y = useViewportStore((s) => s.y)
  const zoom = useViewportStore((s) => s.zoom)
  const gridStyle = useSettingsStore((s) => s.settings.appearance.gridStyle)
  const gridOpacity = useSettingsStore((s) => s.settings.appearance.gridOpacity)
  const gridSize = useSettingsStore((s) => s.settings.appearance.gridSize)

  const gridRef = useRef<HTMLDivElement>(null)
  const spotRef = useRef<HTMLDivElement>(null)

  const { minor: MINOR, major: MAJOR } = GRID_SPACING[gridSize] ?? GRID_SPACING.standard
  const minor = MINOR * zoom
  const major = MAJOR * zoom

  // Fade the spotlight out as the camera zooms out: dense dots lit by a bright disc read as
  // a weird blob from far away, so taper it off below ~0.9 zoom and kill it by 0.5.
  const spotAlpha = 0.24 * Math.max(0, Math.min(1, (zoom - 0.5) / 0.4))

  // Keep hook order stable when the grid is toggled to/from "none". The ref is null while hidden,
  // which cleanly detaches the imperative camera updater.
  useEffect(() => {
    viewportController.attachGrid(gridRef.current, spotRef.current)
    return () => viewportController.attachGrid(null, null)
  }, [gridStyle])

  // Publish the resting camera + spacing on the TWO GRID LAYERS THEMSELVES — never on their
  // shared parent. `--grid-*` are inherited custom properties: writing them on the canvas
  // background (an ancestor of the world layer and therefore of every panel) invalidated the
  // style of the whole canvas subtree on EVERY pan frame. Measured: the same 62 style recalcs
  // during a pan cost 425 ms with a Files panel open vs 97 ms without it — the panel with the
  // most nodes simply paid the bill for an invalidation it never caused. These two divs are
  // leaves with no descendants, so writing here costs nothing beyond themselves.
  useLayoutEffect(() => {
    for (const el of [gridRef.current, spotRef.current]) {
      if (!el) continue
      el.style.setProperty('--grid-minor', `${minor}px`)
      el.style.setProperty('--grid-major', `${major}px`)
      el.style.setProperty('--grid-x', `${x}px`)
      el.style.setProperty('--grid-y', `${y}px`)
    }
  }, [gridSize, minor, major, x, y])

  // Cursor spotlight: track the pointer on a rAF-throttled mask so the illuminated dots follow
  // the cursor without re-rendering React. Re-binds across grid-style changes ('none' unmounts
  // and remounts the layer).
  useEffect(() => {
    const el = spotRef.current
    if (!el) return

    let originX = 0
    let originY = 0
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      originX = r.left
      originY = r.top
    }
    measure()

    let raf = 0
    let px = 0
    let py = 0
    let shown = false
    const flush = (): void => {
      raf = 0
      // Move the spotlight with TWO transforms, never by re-centring a mask.
      //
      // This used to animate `mask-image` on a viewport-sized element (with will-change:
      // mask-image), so every mouse move repainted a full-screen masked layer. On an integrated
      // GPU that repaint competes with the terminals' WebGL canvases and makes their content
      // visibly flicker while the pointer moves. Transforms are compositor-only: the outer box
      // (small, statically masked) translates to the cursor, and the inner dot plane
      // counter-translates by the same amount so the dots stay locked to the grid.
      const ox = Math.round(px - SPOT_RADIUS)
      const oy = Math.round(py - SPOT_RADIUS)
      el.style.transform = `translate3d(${ox}px, ${oy}px, 0)`
      const inner = el.firstElementChild as HTMLElement | null
      if (inner) inner.style.transform = `translate3d(${-ox}px, ${-oy}px, 0)`
      if (!shown) {
        shown = true
        el.style.setProperty('--spot-o', '1')
      }
    }
    const onMove = (e: PointerEvent): void => {
      px = e.clientX - originX
      py = e.clientY - originY
      if (!raf) raf = requestAnimationFrame(flush)
    }
    const onLeave = (): void => {
      shown = false
      el.style.setProperty('--spot-o', '0')
    }

    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('resize', measure)
    document.addEventListener('mouseleave', onLeave)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('resize', measure)
      document.removeEventListener('mouseleave', onLeave)
    }
  }, [gridStyle])

  // Static mask, centred on the (small) spotlight box — it never moves, the box does.
  const spotMask = `radial-gradient(circle ${SPOT_RADIUS}px at 50% 50%, #000 0%, transparent 76%)`

  // 'none' kills the grid entirely (the cursor spotlight goes with it).
  if (gridStyle === 'none') return null

  // Dots → ONE uniform dot layer (strong theme-colored --grid-dot, no stacked major dots);
  // Lines → ONE uniform minor grid (no stacked major hairlines — two differently-colored
  // layers at 24/96px read as DOUBLED lines the instant they fall a frame out of sync, so the
  // whole grid stays a single uniform pattern that can only move, never double).
  // The user-chosen strength multiplies the zoom-based fade so it never becomes noise.
  // Grid geometry comes from --grid-* CSS variables: React supplies them at rest (fallbacks
  // below), the ViewportController overrides them imperatively every frame during motion.
  const layers =
    gridStyle === 'lines'
      ? {
          backgroundImage: [
            'linear-gradient(var(--border-grid-minor) 1px, transparent 1px)',
            'linear-gradient(90deg, var(--border-grid-minor) 1px, transparent 1px)',
          ].join(','),
          backgroundSize: `var(--grid-minor, ${minor}px) var(--grid-minor, ${minor}px), var(--grid-minor, ${minor}px) var(--grid-minor, ${minor}px)`,
        }
      : {
          backgroundImage: ['radial-gradient(var(--grid-dot) 1.3px, transparent 1.3px)'].join(','),
          backgroundSize: `var(--grid-minor, ${minor}px) var(--grid-minor, ${minor}px)`,
        }

  return (
    <>
      <div
        ref={gridRef}
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: layers.backgroundImage,
          backgroundSize: layers.backgroundSize,
          backgroundPosition: `var(--grid-x, ${x}px) var(--grid-y, ${y}px)`,
          // Fade the grid out when zoomed far out, then scale by the user's strength setting.
          opacity: (zoom < 0.4 ? 0.5 : 1) * gridOpacity,
        }}
      />
      {/* Cursor spotlight — brighter dots under the pointer.
          The OUTER box is small (2×radius) and carries a STATIC mask centred on itself; it is
          moved with `transform` alone. The INNER plane holds the dots at the grid's own
          background-position and counter-translates by the same amount, so the pattern stays
          locked to the grid while nothing repaints. Both writes are compositor-only — the
          previous version re-centred a mask on a viewport-sized layer every frame, which
          repainted the whole screen on mouse move and made the terminals flicker. */}
      <div
        ref={spotRef}
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 overflow-hidden"
        style={{
          width: SPOT_RADIUS * 2,
          height: SPOT_RADIUS * 2,
          transform: 'translate3d(-9999px, -9999px, 0)',
          opacity: 'var(--spot-o, 0)',
          transition: 'opacity 240ms var(--ease-settle)',
          maskImage: spotMask,
          WebkitMaskImage: spotMask,
          willChange: 'transform',
        }}
      >
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: '100vw',
            height: '100vh',
            backgroundImage: `radial-gradient(rgba(255,255,255,${spotAlpha * gridOpacity}) 1.3px, transparent 1.3px)`,
            backgroundSize: `var(--grid-minor, ${minor}px) var(--grid-minor, ${minor}px)`,
            backgroundPosition: `var(--grid-x, ${x}px) var(--grid-y, ${y}px)`,
            willChange: 'transform',
          }}
        />
      </div>
    </>
  )
}
