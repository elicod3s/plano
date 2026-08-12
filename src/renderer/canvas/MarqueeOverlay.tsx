import { useSelectionStore } from '@/stores/useSelectionStore'

/**
 * The rubber-band rectangle drawn while a left-drag sweeps the empty canvas.
 *
 * Screen-space and pointer-inert, exactly like SnapOverlay: it shares the canvas's local origin,
 * so the rect the gesture measures in client pixels can be drawn as-is. Living in its own overlay
 * (fed by useSelectionStore) is what keeps panels memoized during the sweep — the panels below
 * never re-render while the band moves.
 */
export function MarqueeOverlay() {
  const marquee = useSelectionStore((s) => s.marquee)
  if (!marquee || marquee.width < 2 || marquee.height < 2) return null

  return (
    <div
      className="pointer-events-none absolute z-[16] rounded-[6px] border border-strong"
      style={{
        left: marquee.x,
        top: marquee.y,
        width: marquee.width,
        height: marquee.height,
        background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)',
        borderColor: 'color-mix(in srgb, var(--accent-primary) 65%, transparent)',
      }}
    />
  )
}
