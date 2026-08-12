import { useSelectionStore } from '@/stores/useSelectionStore'

/**
 * The rubber-band rectangle drawn while a left-drag sweeps the empty canvas.
 *
 * Screen-space and pointer-inert, exactly like SnapOverlay: it shares the canvas's local origin,
 * so the rect the gesture measures in client pixels can be drawn as-is. Living in its own overlay
 * (fed by useSelectionStore) is what keeps panels memoized during the sweep — the panels below
 * never re-render while the band moves.
 *
 * Drawn as PLANO's own mark rather than the stock selection box: a barely-there wash, a hairline
 * edge, and four CORNER BRACKETS echoing BrandMark's bracket geometry. A filled translucent
 * rectangle is the selection box of every file manager ever shipped; brackets read as an
 * instrument framing a target, which is what this canvas is. Colour is `--selection` (the
 * reserved gold), never the accent — the default accent is white, which is exactly the generic
 * look this replaces.
 */

/** Bracket arm length / thickness, in screen px (the overlay is screen-space, so these are literal). */
const ARM = 11
const THICK = 1.5

export function MarqueeOverlay() {
  const marquee = useSelectionStore((s) => s.marquee)
  if (!marquee || marquee.width < 2 || marquee.height < 2) return null

  // Below this the brackets would overlap into a solid blob — draw the band alone until the
  // sweep is big enough to hold them.
  const showBrackets = marquee.width > ARM * 3 && marquee.height > ARM * 3
  const corners = [
    { top: -THICK, left: -THICK, borderTop: true, borderLeft: true, radius: '5px 0 0 0' },
    { top: -THICK, right: -THICK, borderTop: true, borderRight: true, radius: '0 5px 0 0' },
    { bottom: -THICK, left: -THICK, borderBottom: true, borderLeft: true, radius: '0 0 0 5px' },
    { bottom: -THICK, right: -THICK, borderBottom: true, borderRight: true, radius: '0 0 5px 0' },
  ]

  return (
    <div
      className="pointer-events-none absolute z-[16] rounded-[6px]"
      style={{
        left: marquee.x,
        top: marquee.y,
        width: marquee.width,
        height: marquee.height,
        background: 'color-mix(in srgb, var(--selection) 7%, transparent)',
        border: '1px solid color-mix(in srgb, var(--selection) 26%, transparent)',
      }}
    >
      {showBrackets &&
        corners.map((c, i) => (
          <span
            key={i}
            className="absolute"
            style={{
              top: c.top,
              left: c.left,
              right: c.right,
              bottom: c.bottom,
              width: ARM,
              height: ARM,
              borderTopWidth: c.borderTop ? THICK : 0,
              borderBottomWidth: c.borderBottom ? THICK : 0,
              borderLeftWidth: c.borderLeft ? THICK : 0,
              borderRightWidth: c.borderRight ? THICK : 0,
              borderStyle: 'solid',
              borderColor: 'color-mix(in srgb, var(--selection) 82%, transparent)',
              borderRadius: c.radius,
            }}
          />
        ))}
    </div>
  )
}
