import { useEffect, useRef, useState } from 'react'
import { useUsageStore } from '@/stores/useUsageStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { UsageChip } from './UsageChip'
import { UsagePanel } from './UsagePanel'

/**
 * The usage island — a floating glass pill in the bottom-LEFT corner, NOT a full-width bar.
 *
 * It steals no layout: the canvas keeps the whole window and the island floats over it, so the
 * workspace never shifts when it appears. Everything it knows is readable AT REST — every
 * provider with its percentage and time to reset — because a budget you have to hover to read
 * is a budget you never check.
 *
 * The island owns the ONE panel (UsagePanel): open on hover after a 120 ms intent delay, close
 * 180 ms after the pointer leaves both island and panel; clicking pins it (click again, Esc, or
 * an outside click closes). Hovering a chip never opens a second panel — the panel is the only
 * detail surface.
 */
export function StatusBar() {
  const usageSettings = useSettingsStore((s) => s.settings.usage)
  const ready = useUsageStore((s) => s.ready)
  const hydrate = useUsageStore((s) => s.hydrate)
  const providers = useUsageStore((s) => s.snapshot.providers)
  const [now, setNow] = useState(() => Date.now())
  /**
   * ONE state, not two booleans. With separate `pinned`/`hovering` flags, clicking a pinned
   * island unpinned it while the pointer was still on top — `hovering` kept the panel open and
   * the click looked broken. `armed` blocks hover from re-opening until the pointer leaves.
   */
  const [mode, setMode] = useState<'closed' | 'hover' | 'pinned'>('closed')
  const hoverBlocked = useRef(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Hydrate once, then live on host pushes; the single island-wide ticker refreshes reset times.
  useEffect(() => {
    if (!ready) void hydrate()
    const unsubUsage = window.plano.usage.onChanged((snapshot) => useUsageStore.getState().setSnapshot(snapshot))
    const unsubAux = window.plano.statusbar.onAuxChanged((aux) => useUsageStore.getState().setAux(aux))
    const ticker = setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      unsubUsage()
      unsubAux()
      clearInterval(ticker)
      if (openTimer.current) clearTimeout(openTimer.current)
      if (closeTimer.current) clearTimeout(closeTimer.current)
    }
  }, [hydrate, ready])

  // Pinned panel: an outside press closes it.
  useEffect(() => {
    if (mode !== 'pinned') return
    const onDown = (e: MouseEvent): void => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setMode('closed')
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [mode])

  if (!usageSettings.showStatusBar) return null

  const shown = providers.filter((p) => usageSettings.chips.providers[p.provider] !== false)
  if (shown.length === 0) return null

  const enter = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    if (openTimer.current) clearTimeout(openTimer.current)
    if (hoverBlocked.current) return // the user just clicked it shut; respect that until they leave
    openTimer.current = setTimeout(() => setMode((m) => (m === 'closed' ? 'hover' : m)), 120)
  }
  const leave = (): void => {
    if (openTimer.current) clearTimeout(openTimer.current)
    hoverBlocked.current = false // leaving re-arms hover for the next approach
    closeTimer.current = setTimeout(() => setMode((m) => (m === 'hover' ? 'closed' : m)), 180)
  }
  /** Click toggles: open → pinned, pinned → closed (and hover must not immediately reopen it). */
  const togglePinned = (): void => {
    if (openTimer.current) clearTimeout(openTimer.current)
    setMode((m) => {
      if (m === 'pinned') {
        hoverBlocked.current = true
        return 'closed'
      }
      return 'pinned'
    })
  }
  const show = mode !== 'closed'

  return (
    <div
      ref={wrapperRef}
      onMouseEnter={enter}
      onMouseLeave={leave}
      className="pointer-events-none absolute bottom-3 left-5 z-[var(--z-chrome)]"
    >
      {/* The island itself — pointer-events-auto so chips stay clickable inside the
          pointer-events-none positioning wrapper. */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Usage"
        aria-expanded={show}
        onClick={togglePinned}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            togglePinned()
          }
        }}
        className={[
          'app-no-drag pointer-events-auto surface-layer surface-layer--chrome focus-caliper',
          'flex h-8 items-center gap-0.5 rounded-pill px-1 outline-none',
          'motion-safe:transition-opacity motion-safe:duration-300 motion-safe:ease-out',
          show ? 'opacity-100' : 'opacity-90',
        ].join(' ')}
      >
        {/* Every model is legible at rest — its own brand mark in its own usage ring, with its own
            number. No aggregate: "62%" across different providers would mean nothing. */}
        {/* Fixed width, always: the island must NOT grow when the pointer arrives. It used to add
            every window's reset time on hover, so opening the panel resized the island underneath
            it and the whole corner jumped. Reset times live in the panel, which is what hovering
            opens anyway. A hairline separates providers so the numbers do not run together. */}
        {shown.map((p, i) => (
          <span key={p.provider} className="flex items-center">
            {i > 0 && <span className="mx-1 h-3.5 w-px shrink-0 bg-[var(--border-subtle)]" />}
            <UsageChip usage={p} now={now} />
          </span>
        ))}
      </div>

      {/* ONE panel for the whole island — anchored bottom-left above it. */}
      {show && (
        <div className="pointer-events-auto absolute bottom-[calc(100%+10px)] left-0">
          <UsagePanel now={now} onClose={() => setMode('closed')} />
        </div>
      )}
    </div>
  )
}
