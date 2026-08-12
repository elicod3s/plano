import { AgentLogo } from '@/panels/terminal/AgentLogo'
import type { ProviderUsage } from '@shared/domain/usage'
import { providerMeta, windowsOf, headlineWindow } from './providerMeta'
import { DANGER, formatTimeToReset, ringDash, riskLevel, roundPercent } from './usageFormat'
import { cn } from '@/lib/cn'

/** The red reserved for a budget ≥95% — the ONLY red in the bar. */
const DANGER_FOR_RING = DANGER

/** Gauge geometry — one source of truth for both the drawn circle and its dasharray. */
const RING_RADIUS = 9.6

/**
 * One provider quota chip: brand mark inside its own usage ring, then one number per window.
 * Monochrome until it matters. The panel (UsagePanel) is the ONLY popover — the chip never
 * opens anything; its `title` carries the provider's status/detail for a native tooltip.
 */
export function UsageChip({
  usage,
  now,
  compact = false,
  showReset = false,
}: {
  usage: ProviderUsage
  now: number
  compact?: boolean
  /** Append the time to reset — the island turns this on while the pointer is over it. */
  showReset?: boolean
}) {
  const meta = providerMeta(usage.provider)
  const wins = windowsOf(usage)
  const win = headlineWindow(usage)
  const pct = win ? roundPercent(win.usedPercent) : 0
  const accent = meta.accent
  const level = win ? riskLevel(win.usedPercent) : 'default'
  const color = level === 'danger' ? DANGER_FOR_RING : level === 'accent' ? accent : undefined
  // The radius MUST match the drawn circle (r=9.6 in the 22px gauge): a dasharray computed for a
  // different radius makes the arc show a percentage nobody asked for.
  const { circumference, dash } = win ? ringDash(pct, RING_RADIUS) : { circumference: 0, dash: 0 }

  return (
    // A SPAN, not a button: the chip has no action of its own (the island owns the click), and a
    // <button> inside the island's role="button" made every press fire twice and fight for focus.
    <span
      title={
        compact
          ? `${meta.label}${win ? ` ${pct}%` : ''}`
          : usage.detail || `${meta.label}${wins.length > 0 ? ` · source ${usage.source}` : ''}`
      }
      className={cn(
        'app-no-drag flex h-[26px] shrink-0 select-none items-center rounded-pill',
        compact ? 'justify-center px-0.5' : 'gap-1 pl-0.5 pr-1.5 hover:bg-glass',
        'motion-safe:transition-colors motion-safe:duration-300',
      )}
    >
      {/* The gauge IS the identity: the brand mark sits inside its own usage ring, so a glance
          reads "which model" and "how much is left" as one object instead of a text label. */}
      <span className="relative flex h-[22px] w-[22px] shrink-0 items-center justify-center">
        <svg width="22" height="22" viewBox="0 0 22 22" className="absolute inset-0" aria-hidden>
          <circle cx="11" cy="11" r={RING_RADIUS} fill="none" strokeWidth="1.7" className="stroke-[var(--border-subtle)]" />
          {win && (
            <circle
              cx="11"
              cy="11"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeDasharray={`${dash} ${Math.max(0, circumference - dash)}`}
              transform="rotate(-90 11 11)"
              stroke={color ?? 'var(--text-secondary)'}
            />
          )}
        </svg>
        {/* The brand mark carries its OWN colour — it is what makes a row identifiable at a
            glance, and it is the established accent precedent (launcher chips, panel tint).
            It only greys out when the provider has nothing to report. */}
        <AgentLogo kind={meta.kind} size={11} color={accent} className={win ? undefined : 'opacity-45'} />
      </span>
      {/* Every window this provider bills separately gets its own number — Claude alone has
          three (5h, 7d, Fable) and showing only one would misreport what is left. */}
      {!compact &&
        (wins.length > 0 ? (
          wins.map((entry, i) => {
            const p = roundPercent(entry.w.usedPercent)
            const lvl = riskLevel(p)
            const c = lvl === 'danger' ? DANGER_FOR_RING : lvl === 'accent' ? accent : undefined
            return (
              <span key={entry.key} className="flex items-baseline gap-1">
                {i > 0 && <span className="text-[10px] text-text-quaternary">·</span>}
                <span
                  className="font-mono text-[11px] tabular-nums text-text-secondary"
                  style={c ? { color: c } : undefined}
                  title={entry.label}
                >
                  {p}%
                </span>
                {showReset && entry.w.resetsAt && (
                  <span className="font-mono text-[10px] tabular-nums text-text-quaternary">
                    {formatTimeToReset(entry.w.resetsAt - now)}
                  </span>
                )}
              </span>
            )
          })
        ) : (
          <span className="font-mono text-[11px] tabular-nums text-text-quaternary">—</span>
        ))}
    </span>
  )
}
