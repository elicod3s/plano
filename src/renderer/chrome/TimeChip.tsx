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
  const agentsWeek = base.agentsWeek
  const agentsTotal = mergeAgentStats(base.agentsWeek, {}, 0) // union for the section header
  const agentsTodayMax = Math.max(1, ...agentsToday.map((a) => a.seconds))

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
            <div className="px-4 pb-1 pt-4">
              <div className="mb-3 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-label text-text-3">
                <Icon name="Clock" size={11} />
                Time tracked
              </div>

              <div className="space-y-2">
                <StatRow label="This session" value={formatDuration(session)} emphasize />
                <StatRow label="Today" value={formatDuration(today)} />
                <StatRow label="This week" value={formatDuration(week)} />
              </div>

              {weekReady && (
                <div className="mt-4 border-t border-glass pt-3.5">
                  <div className="flex items-end gap-1.5" style={{ height: CHART_MAX_PX + 16 }}>
                    {base.weekDays.map((day, i) => {
                      const seconds = secondsFor(day)
                      const isToday = day.key === todayKey
                      const barPx = Math.max(2, Math.round((seconds / maxDay) * CHART_MAX_PX))
                      return (
                        <div
                          key={day.key}
                          className="flex flex-1 flex-col items-center justify-end gap-1.5"
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

            {/* per-agent breakdown */}
            <div className="border-t border-glass px-4 pb-4 pt-3.5">
              <div className="mb-2.5 flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-label text-text-3">
                  <Icon name="Sparkles" size={11} />
                  Time by agent
                </span>
                <span className="flex items-center gap-3 font-mono text-[9px] uppercase tracking-label text-text-4">
                  <span>Today</span>
                  <span>Week</span>
                </span>
              </div>

              {agentsTotal.length === 0 && agentsToday.length === 0 ? (
                <div className="py-1.5 text-[12px] leading-relaxed text-text-4">
                  Agents you run (Claude, Pi, Codex…) are counted here.
                </div>
              ) : (
                <div className="space-y-1">
                  {agentsToday.map((a) => {
                    const info = AGENTS[a.kind as keyof typeof AGENTS]
                    const display = info?.displayName ?? a.kind
                    const accent = info?.accent ?? '#ffffff'
                    const weekEntry = agentsWeek.find((w) => w.kind === a.kind)
                    const weekSecs = weekEntry?.seconds ?? 0
                    const pct = Math.round((a.seconds / agentsTodayMax) * 100)
                    return (
                      <div key={a.kind} className="rounded-[10px] px-1.5 py-1.5 transition-colors hover:bg-glass">
                        <div className="flex items-center gap-2.5">
                          <AgentLogo kind={a.kind as never} size={15} color={accent} className="shrink-0" />
                          <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-1">{display}</span>
                          <span className="w-14 text-right font-mono text-[12px] tabular-nums text-text-1">
                            {formatDuration(a.seconds)}
                          </span>
                          <span className="w-14 text-right font-mono text-[11px] tabular-nums text-text-4">
                            {weekSecs > 0 ? formatDuration(weekSecs) : '—'}
                          </span>
                        </div>
                        {/* proportion bar of today's share */}
                        <div className="ml-[22px] mt-1.5 h-[3px] overflow-hidden rounded-pill bg-glass">
                          <div
                            className="h-full rounded-pill transition-[width] duration-300"
                            style={{ width: `${pct}%`, background: accent }}
                          />
                        </div>
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
