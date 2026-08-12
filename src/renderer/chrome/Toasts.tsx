/**
 * Toasts — the notification surface, docked TOP-RIGHT under the TopBar.
 *
 * Position is load-bearing: it used to sit top-CENTER, directly over the search field, so every
 * agent that finished covered the one control the user was reaching for. The TopBar is
 * `top-4 h-11` inset 24 px, so the stack starts at its bottom edge + 8 px and shares its right
 * margin — it can never overlap the bar or the canvas controls.
 *
 * Card anatomy (designed in `PLANO new UI.pen` → "Toast"): a 26 px brand mark in a circle tinted
 * with the agent's own accent, ONE title in Space Grotesk, a mono meta line only when it carries
 * information, a quiet dismiss, and a 2 px hairline that drains to show the auto-dismiss budget.
 *
 * Hierarchy by weight, not size:
 *  - "finished" is informational: it drains and leaves on its own.
 *  - "awaiting input" persists until attended and swaps the tint to amber — no drain bar, because
 *    nothing is going to take it away.
 *
 * Motion is Apple: enter fast (~180 ms), leave slow (~240 ms). Reduced motion → opacity only, and
 * the drain bar renders static rather than animating.
 */

import { useEffect, useRef, useState } from 'react'
import { useToastStore, type Toast } from '@/stores/useToastStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { AgentLogo } from '@/panels/terminal/AgentLogo'
import { Icon } from '@/design-system/Icon'
import { cn } from '@/lib/cn'

const MAX_VISIBLE = 3
/** TopBar: top-4 (16) + h-11 (44) = 60; the stack clears it by 8. */
const STACK_TOP = 68
const AWAITING_TINT = '#fbbf24'

export function Toasts() {
  const toasts = useToastStore((s) => s.toasts)
  const reduced = useSettingsStore((s) => s.settings.appearance.reduceMotion)

  const visible = toasts.slice(0, MAX_VISIBLE)
  const hidden = Math.max(0, toasts.length - MAX_VISIBLE)

  if (toasts.length === 0) return null

  return (
    <div
      className="pointer-events-none fixed right-6 z-[var(--z-toast)] flex w-[300px] max-w-[calc(100vw-48px)] flex-col items-stretch gap-2"
      style={{ top: STACK_TOP }}
    >
      {visible.map((t) => (
        <ToastCard key={t.id} toast={t} reduced={reduced} />
      ))}
      {hidden > 0 && (
        <div className="pointer-events-none flex justify-end pr-1">
          <span className="surface-layer surface-layer--popover rounded-pill px-2.5 py-1 font-mono text-[10.5px] tabular-nums text-text-3">
            +{hidden} more
          </span>
        </div>
      )}
    </div>
  )
}

function ToastCard({ toast, reduced }: { toast: Toast; reduced: boolean }) {
  const [leaving, setLeaving] = useState(false)
  const [gone, setGone] = useState(false)
  const [drained, setDrained] = useState(false)
  const touchStart = useRef<number | null>(null)

  const awaiting = toast.kind === 'awaiting'
  const accent = awaiting ? AWAITING_TINT : (toast.accent ?? 'var(--text-2)')
  const agentKind = toast.agentKind ?? 'generic-agent'
  // The bar drains over the toast's own TTL, so the countdown is visible instead of a card that
  // vanishes without warning. A persistent toast (ttl 0) has nothing to drain.
  const ttlMs = awaiting ? 0 : (toast.ttlMs ?? 0)

  useEffect(() => {
    if (ttlMs <= 0 || reduced) return
    // Next frame, so the transition has a start value to animate from.
    const raf = requestAnimationFrame(() => setDrained(true))
    return () => cancelAnimationFrame(raf)
  }, [ttlMs, reduced])

  const dismiss = (): void => {
    if (leaving || gone) return
    setLeaving(true)
    setTimeout(() => {
      useToastStore.getState().dismiss(toast.id)
      setGone(true)
    }, 240)
  }

  return (
    <div
      data-surface-layer="popover"
      role="status"
      aria-live="polite"
      onClick={() => {
        if (toast.onClick) {
          dismiss()
          toast.onClick()
        }
      }}
      onTouchStart={(e) => {
        touchStart.current = e.touches[0].clientY
      }}
      onTouchEnd={(e) => {
        const start = touchStart.current
        touchStart.current = null
        if (start === null) return
        const dy = e.changedTouches[0].clientY - start
        if (dy < -24) dismiss() // swipe up to dismiss
      }}
      className={cn(
        'app-no-drag surface-layer surface-layer--popover pointer-events-auto relative cursor-pointer overflow-hidden rounded-[16px]',
        !gone && 'animate-toast-in',
        leaving && 'animate-toast-out',
        gone && 'hidden',
      )}
    >
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        {/* Identity: the harness's own brand mark inside a circle tinted with its accent — never
            a system emoji, and never a generic dot that makes every agent look alike. */}
        <span
          className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full border"
          style={{
            color: accent,
            background: `color-mix(in srgb, ${accent} 8%, transparent)`,
            borderColor: `color-mix(in srgb, ${accent} 22%, transparent)`,
          }}
        >
          {toast.kind === 'info' ? <Icon name="Smartphone" size={13} /> : <AgentLogo kind={agentKind} size={14} color={accent} />}
        </span>

        <div className="min-w-0 flex-1">
          {/* Head: who finished, then how long it took — the two things read first. */}
          <div className="flex items-center gap-2">
            <span className="truncate text-[12.5px] font-medium leading-snug text-text-1">{toast.title}</span>
            {toast.count && toast.count > 1 && (
              <span className="shrink-0 rounded-pill bg-accent-soft px-1.5 font-mono text-[10px] tabular-nums text-text-2">{toast.count}</span>
            )}
            {awaiting && !reduced && (
              <span className="mesh-waiting-dot shrink-0 rounded-full" style={{ width: 5, height: 5, background: AWAITING_TINT }} />
            )}
            <span className="ml-auto shrink-0" />
            {toast.duration && (
              <span
                className="shrink-0 font-mono text-[10px] tabular-nums text-text-3"
                style={awaiting ? { color: AWAITING_TINT } : undefined}
              >
                {toast.duration}
              </span>
            )}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={(e) => {
                e.stopPropagation()
                dismiss()
              }}
              className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-text-quaternary transition-colors hover:bg-glass-hover hover:text-text-2"
            >
              <Icon name="X" size={11} />
            </button>
          </div>

          {/* What it was asked — the line that makes the notification worth reading at all. */}
          {toast.prompt && (
            <div className="mt-1 line-clamp-2 text-[11px] leading-[1.35] text-text-2">
              {toast.kind === 'finished' && toast.count && toast.count > 1 ? toast.prompt : `“${toast.prompt}”`}
            </div>
          )}

          {/* Where it lives: workspace · terminal. */}
          {(toast.context ?? toast.secondary) && (
            <div className="mt-1 truncate font-mono text-[10px] leading-snug text-text-3">{toast.context ?? toast.secondary}</div>
          )}
        </div>
      </div>

      {ttlMs > 0 && (
        <div className="h-[2px] w-full bg-[rgba(255,255,255,0.04)]">
          <div
            className="h-full"
            style={{
              width: reduced || !drained ? '100%' : '0%',
              background: 'var(--text-4)',
              transition: reduced ? undefined : `width ${ttlMs}ms linear`,
            }}
          />
        </div>
      )}
    </div>
  )
}
