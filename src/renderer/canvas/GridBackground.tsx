import { useEffect, useRef } from 'react'
import { useViewportStore } from '@/stores/useViewportStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

const MINOR = 24
const MAJOR = 96
const SPOT_RADIUS = 165 // px (screen space) of the cursor illumination

/**
 * The blueprint substrate: a faint draftsman grid (minor dots @24px, major hairlines
 * @96px) drawn in screen space but offset + scaled by the camera, so it reads as
 * plan-paper the panels are pinned to. The grid is the one thing that scales with zoom.
 *
 * A second, identically-aligned dot layer (brighter) is masked by a radial gradient that
 * follows the cursor — a subtle "illuminate the grid" spotlight. The mask centre is driven
 * by CSS variables written straight to the DOM on a rAF-throttled pointermove, so cursor
 * motion never re-renders React and the browser only repaints a small region: zero state,
 * negligible cost.
 */
export function GridBackground() {
  const x = useViewportStore((s) => s.x)
  const y = useViewportStore((s) => s.y)
  const zoom = useViewportStore((s) => s.zoom)
  const gridStyle = useSettingsStore((s) => s.settings.appearance.gridStyle)
  const gridOpacity = useSettingsStore((s) => s.settings.appearance.gridOpacity)

  const minor = MINOR * zoom
  const major = MAJOR * zoom

  // Fade the spotlight out as the camera zooms out: dense minor dots lit by a bright disc
  // read as a weird blob from far away, so taper it off below ~0.9 zoom and kill it by 0.5.
  const spotAlpha = 0.24 * Math.max(0, Math.min(1, (zoom - 0.5) / 0.4))

  const spotRef = useRef<HTMLDivElement>(null)

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
      el.style.setProperty('--spot-x', `${px}px`)
      el.style.setProperty('--spot-y', `${py}px`)
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
    // Re-bind across grid-style changes so the cursor spotlight re-attaches to the live
    // node after 'none' unmounts/remounts it (and detaches entirely while 'none').
  }, [gridStyle])

  const spotMask = `radial-gradient(circle ${SPOT_RADIUS}px at var(--spot-x, -1000px) var(--spot-y, -1000px), #000 0%, transparent 76%)`

  // 'none' kills the grid entirely (the cursor spotlight goes with it).
  if (gridStyle === 'none') return null

  // Dots → a pure dot grid at both scales; Lines → minor + major hairlines both ways.
  // The user-chosen strength multiplies the zoom-based fade so it never becomes noise.
  const layers =
    gridStyle === 'lines'
      ? {
          backgroundImage: [
            'linear-gradient(var(--border-grid-minor) 1px, transparent 1px)',
            'linear-gradient(90deg, var(--border-grid-minor) 1px, transparent 1px)',
            'linear-gradient(var(--border-grid-major) 1px, transparent 1px)',
            'linear-gradient(90deg, var(--border-grid-major) 1px, transparent 1px)',
          ].join(','),
          backgroundSize: `${minor}px ${minor}px, ${minor}px ${minor}px, ${major}px ${major}px, ${major}px ${major}px`,
        }
      : {
          backgroundImage: [
            'radial-gradient(var(--border-grid-minor) 1px, transparent 1px)',
            'radial-gradient(var(--border-grid-major) 1.3px, transparent 1.3px)',
          ].join(','),
          backgroundSize: `${minor}px ${minor}px, ${major}px ${major}px`,
        }

  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: layers.backgroundImage,
          backgroundSize: layers.backgroundSize,
          backgroundPosition: `${x}px ${y}px`,
          // Fade the grid out when zoomed far out, then scale by the user's strength setting.
          opacity: (zoom < 0.4 ? 0.5 : 1) * gridOpacity,
        }}
      />
      <div
        ref={spotRef}
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: `radial-gradient(rgba(255,255,255,${spotAlpha * gridOpacity}) 1px, transparent 1px)`,
          backgroundSize: `${minor}px ${minor}px`,
          backgroundPosition: `${x}px ${y}px`,
          opacity: 'var(--spot-o, 0)',
          transition: 'opacity 240ms var(--ease-settle)',
          maskImage: spotMask,
          WebkitMaskImage: spotMask,
          willChange: 'mask-image',
        }}
      />
    </>
  )
}
