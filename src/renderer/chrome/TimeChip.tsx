import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/design-system/Icon'
import { useTimeStore } from '@/stores/useTimeStore'
import { AGENTS } from '@shared/domain/agent'
import { AgentLogo } from '@/panels/terminal/AgentLogo'
import { dayKey } from '@shared/domain/time'
import type { AgentTimeStat } from '@shared/ipc/contracts'
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

/** Merge the persisted per-agent snapshot with the live (unflushed) per-agent seconds. */
function mergeAgentStats(persisted: AgentTimeStat[], pending: Record<string, number>, liveSeconds: number): AgentTimeStat[] {
  const map = new Map<string, number>()
  for (const e of persisted) map.set(e.kind, e.seconds)
  for (const [kind, secs] of Object.entries(pending)) map.set(kind, (map.get(kind) ?? 0) + secs)
  // A running agent accumulates live ticks before the first flush — reflect it immediately.
  if (liveSeconds > 0 && map.size === 0) {
    // (no persisted agent yet — the pending map already carries it)
  }
  return [...map.entries()]
    .map(([kind, seconds]) => ({ kind, seconds }))
    .sort((a, b) => b.seconds - a.seconds)
}

/**
 * Top-bar usage clock. The chip shows today's tracked time (ticks live while active);
 * clicking reveals session / today / this-week totals, a weekly breakdown, and a per-AGENT
 * breakdown (how long you've spent in Claude, Pi, Codex, … today and this week).
 */
export function TimeChip() {
  const [open, setOpen] = useState(false)
  const [range, setRange] = useState<'today' | 'week'>('today')
  const [pos, setPos] = useState<{ right: number; top: number } | null>(null)
  const chipRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const base = useTimeStore((s) => s.base)
  const pending = useTimeStore((s) => s.pending)
  const session = useTimeStore((s) => s.session)
  const agentPending = useTimeStore((s) => s.agentPending)

  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const r = chipRef.current?.getBoundingClientRect()
      if (r) setPos({ right: window.innerWidth - r.right, top: r.bottom + 12 })
      else setPos(null)
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  // Persistent click-open popover: moving the pointer away never closes it. A second click
  // on the chip, an outside press, or Escape are the only dismissal paths.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target && (chipRef.current?.contains(target) || popoverRef.current?.contains(target))) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const todayKey = dayKey(new Date())
  // `pending` is active time not yet folded into `base`; overlay it for a live display.
  const today = base.today + pending
  const week = base.week + pending
  const secondsFor = (day: { key: string; seconds: number }): number =>
    day.key === todayKey ? day.seconds + pending : day.seconds

  const weekReady = base.weekDays.length === 7
  const maxDay = Math.max(1, ...base.weekDays.map(secondsFor))

  // Per-agent: merge today's persisted + live, keep the week's persisted snapshot.
  const agentsToday = mergeAgentStats(base.agentsToday, agentPending, pending)
  // The week snapshot already holds today's FLUSHED time; overlaying the same pending seconds the
  // week total uses keeps the list and the "This week" headline telling the same story.
  const agentsWeek = mergeAgentStats(base.agentsWeek, agentPending, pending)
  const rangeRows = range === 'today' ? agentsToday : agentsWeek
  const rangeMax = Math.max(1, ...rangeRows.map((a) => a.seconds))

  return (
    <div ref={chipRef} className="relative">
      <button
        type="button"
        aria-label="Time tracked"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'app-no-drag flex h-7 shrink-0 items-center gap-1.5 rounded-pill border border-glass px-2.5',
          'font-mono text-[11.5px] leading-none tabular-nums text-text-2 transition-colors',
          'hover:border-glass-hover hover:bg-glass hover:text-text-1',
        )}
        style={{ background: 'var(--glass)' }}
      >
        <Icon name="Clock" size={12} className="text-text-3" />
        {formatDuration(today)}
      </button>

      {open &&
        pos &&
        createPortal(
          // Portaled to <body> so the popover stays above every toolbar surface.
          <div
            ref={popoverRef}
            data-surface-layer="popover"
            className="animate-menu-in surface-layer surface-layer--popover fixed z-[var(--z-popover)] w-[300px] origin-top-right overflow-hidden rounded-[18px]"
            style={{ right: pos.right, top: pos.top }}
          >
            {/* One headline, not a list of three. Today is the number you actually came for, so it
                gets the size; the session ticks quietly beside the title and the week sits over its
                own chart, where it belongs. */}
            <div className="px-4 pb-3.5 pt-3.5">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-text-1">Time</span>
                <span className="font-mono text-[11px] tabular-nums text-text-3">
                  Session {formatDuration(session)}
                </span>
              </div>

              <div className="mt-2.5">
                <div className="font-mono text-[28px] font-medium leading-none tracking-[-0.02em] tabular-nums text-text-1">
                  {formatDuration(today)}
                </div>
                <div className="mt-1.5 text-[12px] text-text-3">Today</div>
              </div>

              {weekReady && (
                <>
                  <div className="mt-4 flex items-center justify-between">
                    <span className="text-[12px] text-text-3">This week</span>
                    <span className="font-mono text-[12px] tabular-nums text-text-2">{formatDuration(week)}</span>
                  </div>
                  {/* Every day carries a full-height TRACK and the bar grows from its floor. The old
                      chart drew a bare 2px stub for an empty day, which read as a broken dashed line
                      rather than "nothing tracked". */}
                  <div className="mt-2.5 flex items-end gap-1.5">
                    {base.weekDays.map((day, i) => {
                      const seconds = secondsFor(day)
                      const isToday = day.key === todayKey
                      const barPx = seconds > 0 ? Math.max(3, Math.round((seconds / maxDay) * CHART_MAX_PX)) : 0
                      return (
                        <div
                          key={day.key}
                          className="flex flex-1 flex-col items-center gap-1.5"
                          title={`${formatDuration(seconds)}`}
                        >
                          <div
                            className="flex w-full items-end overflow-hidden rounded-[4px] bg-[rgba(255,255,255,0.045)]"
                            style={{ height: CHART_MAX_PX }}
                          >
                            {barPx > 0 && (
                              <div
                                className={cn(
                                  'w-full rounded-[4px]',
                                  isToday ? 'bg-text-1' : 'bg-[rgba(255,255,255,0.22)]',
                                )}
                                style={{ height: barPx }}
                              />
                            )}
                          </div>
                          <span
                            className={cn('text-[10px] leading-none', isToday ? 'text-text-2' : 'text-text-3')}
                          >
                            {WEEKDAY_LABELS[i]}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </div>

            {/* per-agent breakdown */}
            <div className="border-t border-glass px-3 pb-3 pt-3">
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-[12px] text-text-3">By agent</span>
                {/* A range SWITCH, not two columns. Today and Week used to be printed side by side
                    under headers that sat over neither of them; one column of numbers and an
                    explicit toggle says the same thing without the reader decoding an alignment. */}
                <div className="flex items-center gap-0.5 rounded-pill bg-[rgba(255,255,255,0.045)] p-0.5">
                  {(['today', 'week'] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setRange(r)}
                      className={cn(
                        'rounded-pill px-2.5 py-[3px] text-[10.5px] capitalize transition-colors',
                        range === r ? 'bg-glass-active font-medium text-text-1' : 'text-text-3 hover:text-text-2',
                      )}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>

              {rangeRows.length === 0 ? (
                <div className="px-1 py-1.5 text-[12px] leading-relaxed text-text-4">
                  Agents you run (Claude, Pi, Codex…) are counted here.
                </div>
              ) : (
                <div className="space-y-0.5">
                  {rangeRows.map((a) => {
                    const info = AGENTS[a.kind as keyof typeof AGENTS]
                    const display = info?.displayName ?? a.kind
                    const accent = info?.accent ?? '#ffffff'
                    // A share this small still has to look like a bar and not like dust on the screen.
                    const pct = Math.max(6, Math.round((a.seconds / rangeMax) * 100))
                    return (
                      <div
                        key={a.kind}
                        className="flex items-center gap-2.5 rounded-[10px] px-1 py-1.5 transition-colors hover:bg-glass"
                      >
                        <AgentLogo kind={a.kind as never} size={15} color={accent} className="shrink-0" />
                        {/* Name AND bar share one column, so the bar can never run beneath the number
                            the way a full-width one did — that overlap is what made the list read as
                            a tangle of underlines. */}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12.5px] text-text-1">{display}</div>
                          <div className="mt-[7px] h-[3px] overflow-hidden rounded-pill bg-[rgba(255,255,255,0.055)]">
                            <div
                              className="h-full rounded-pill transition-[width] duration-300"
                              style={{ width: `${pct}%`, background: accent }}
                            />
                          </div>
                        </div>
                        <span className="shrink-0 font-mono text-[12px] tabular-nums text-text-1">
                          {formatDuration(a.seconds)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}

