import { useState } from 'react'
import { Icon } from '@/design-system/Icon'
import { useTimeStore } from '@/stores/useTimeStore'
import { dayKey } from '@shared/domain/time'
import { cn } from '@/lib/cn'

/** Monday → Sunday, matching the order main returns `weekDays` in. */
const WEEKDAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const CHART_MAX_PX = 34

/** "2h 5m" / "12m" / "8s" — seconds only shown under a minute so a fresh counter visibly ticks. */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}

/**
 * Top-bar usage clock. The chip shows today's tracked time (and ticks live while you're
 * active); hovering reveals session / today / this-week totals plus a weekly breakdown.
 */
export function TimeChip() {
  const [open, setOpen] = useState(false)
  const base = useTimeStore((s) => s.base)
  const pending = useTimeStore((s) => s.pending)
  const session = useTimeStore((s) => s.session)

  const todayKey = dayKey(new Date())
  // `pending` is active time not yet folded into `base`; overlay it for a live display.
  const today = base.today + pending
  const week = base.week + pending
  const secondsFor = (day: { key: string; seconds: number }): number =>
    day.key === todayKey ? day.seconds + pending : day.seconds

  const weekReady = base.weekDays.length === 7
  const maxDay = Math.max(1, ...base.weekDays.map(secondsFor))

  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-label="Time tracked"
        className={cn(
          'flex items-center gap-1.5 rounded-pill border border-subtle px-2.5 py-1',
          'font-mono text-[11px] tabular-nums text-text-secondary transition-colors',
          'hover:border-strong hover:text-text-primary',
        )}
      >
        <Icon name="Clock" size={12} className="text-text-tertiary" />
        {formatDuration(today)} today
      </button>

      {open && (
        // `top-full` + inner `pt-2`: the gap is part of this element, so moving from the
        // chip into the popover never triggers the wrapper's mouseleave (no flicker).
        <div className="absolute right-0 top-full z-50 pt-2">
          <div className="animate-menu-in w-64 origin-top-right rounded-lg border bg-surface-3 p-3 shadow-popover">
            <div className="mb-2.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-label text-text-tertiary">
              <Icon name="Clock" size={11} />
              Time tracked
            </div>

            <div className="space-y-1.5">
              <StatRow label="This session" value={formatDuration(session)} emphasize />
              <StatRow label="Today" value={formatDuration(today)} />
              <StatRow label="This week" value={formatDuration(week)} />
            </div>

            {weekReady && (
              <div className="mt-3 border-t border-subtle pt-3">
                <div className="flex items-end gap-1.5" style={{ height: CHART_MAX_PX + 16 }}>
                  {base.weekDays.map((day, i) => {
                    const seconds = secondsFor(day)
                    const isToday = day.key === todayKey
                    const barPx = Math.max(2, Math.round((seconds / maxDay) * CHART_MAX_PX))
                    return (
                      <div
                        key={day.key}
                        className="flex flex-1 flex-col items-center justify-end gap-1"
                        title={`${formatDuration(seconds)}`}
                      >
                        <div
                          className={cn('w-full rounded-xs', isToday ? 'bg-text-primary' : 'bg-text-quaternary')}
                          style={{ height: barPx }}
                        />
                        <span
                          className={cn(
                            'text-[9px] leading-none',
                            isToday ? 'text-text-secondary' : 'text-text-quaternary',
                          )}
                        >
                          {WEEKDAY_LABELS[i]}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function StatRow({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12px] text-text-secondary">{label}</span>
      <span
        className={cn(
          'font-mono text-[12px] tabular-nums',
          emphasize ? 'text-text-primary' : 'text-text-secondary',
        )}
      >
        {value}
      </span>
    </div>
  )
}
