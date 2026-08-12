import { useEffect, useRef } from 'react'
import { useTimeStore } from '@/stores/useTimeStore'
import { useAgentStore } from '@/stores/useAgentStore'
import { usePanelStore } from '@/stores/usePanelStore'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { dayKey } from '@shared/domain/time'

/**
 * Drives the top-bar usage clock. Once per second it counts a second of ACTIVE time —
 * window focused + page visible + not idle — into the store, and periodically flushes the
 * accumulated seconds to main for persistence. When an agent (Claude, Pi, Codex, …) is
 * detected running, the tick is also attributed to that agent so the time chip can show
 * how long you've spent in each. Mounted once (in App), independent of the chip.
 */

const TICK_MS = 1000
const FLUSH_MS = 15_000
const IDLE_MS = 5 * 60_000 // pause counting after 5 min with no input
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'pointerdown', 'touchstart'] as const

/** The front-most terminal currently hosting a detected agent (highest panel z wins). */
function frontActiveAgent(): { kind: string } | null {
  const verdicts = useAgentStore.getState().byPty
  if (Object.keys(verdicts).length === 0) return null
  const panels = usePanelStore.getState().panels
  const byPanel = useTerminalStore.getState().byPanel
  let best: { z: number; kind: string } | null = null
  for (const p of Object.values(panels)) {
    if (p.type !== 'terminal') continue
    const props = p.props as { activeTabId?: string; tabs?: { id: string }[] }
    const tabId = props.activeTabId ?? props.tabs?.[0]?.id
    if (!tabId) continue
    const ptyId = byPanel[tabId]?.ptyId
    if (!ptyId) continue
    const v = verdicts[ptyId]
    if (v?.active && v.kind) {
      if (!best || p.z > best.z) best = { z: p.z, kind: v.kind }
    }
  }
  return best ? { kind: best.kind } : null
}

export function useTimeTracker(): void {
  // Refs survive re-renders; the effect runs once so these are effectively module-stable.
  const lastActivity = useRef(Date.now())
  const flushing = useRef(false)
  const currentDay = useRef(dayKey(new Date()))

  useEffect(() => {
    let disposed = false
    const { setBase, accumulate, accumulateAgent, commitFlush } = useTimeStore.getState()

    // Initial snapshot from disk.
    void window.plano.time
      .getStats()
      .then((stats) => {
        if (!disposed) setBase(stats)
      })
      .catch(() => undefined)

    const bumpActivity = (): void => {
      lastActivity.current = Date.now()
    }
    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, bumpActivity, { capture: true, passive: true })
    }

    // Push accumulated seconds (total + per-agent) to main; fold the confirmed snapshot back.
    const flush = async (): Promise<void> => {
      if (flushing.current || disposed) return
      const { pending: amount, agentPending } = useTimeStore.getState()
      if (amount <= 0) return
      flushing.current = true
      try {
        const agents = Object.entries(agentPending).map(([kind, seconds]) => ({ kind, seconds }))
        const next = await window.plano.time.addActive({ seconds: amount, agents })
        if (!disposed) commitFlush(next, amount)
      } catch {
        /* keep the pending seconds; the next flush retries */
      } finally {
        flushing.current = false
      }
    }

    // Re-read the persisted snapshot (e.g. after the local day rolls over at midnight).
    const resync = (): void => {
      void window.plano.time
        .getStats()
        .then((stats) => {
          if (!disposed) setBase(stats)
        })
        .catch(() => undefined)
    }

    const tick = window.setInterval(() => {
      const now = Date.now()
      const active =
        document.hasFocus() &&
        document.visibilityState === 'visible' &&
        now - lastActivity.current < IDLE_MS
      if (active) {
        accumulate(1)
        // Attribute the tick to the front-most terminal's running agent (if any) so the chip
        // can break down time per agent (Claude / Pi / Codex …).
        const agent = frontActiveAgent()
        if (agent) accumulateAgent(agent.kind, 1)
      }

      // On a day boundary, flush what we have, then pull a fresh snapshot so the chip's
      // "today"/"week"/breakdown reset cleanly.
      const today = dayKey(new Date())
      if (today !== currentDay.current) {
        currentDay.current = today
        void flush().then(resync)
      }
    }, TICK_MS)

    const flushTimer = window.setInterval(() => void flush(), FLUSH_MS)

    // Persist promptly when the user steps away or the window closes.
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') void flush()
    }
    const onBlurOrUnload = (): void => void flush()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', onBlurOrUnload)
    window.addEventListener('beforeunload', onBlurOrUnload)

    return () => {
      disposed = true
      window.clearInterval(tick)
      window.clearInterval(flushTimer)
      for (const ev of ACTIVITY_EVENTS) {
        window.removeEventListener(ev, bumpActivity, { capture: true })
      }
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', onBlurOrUnload)
      window.removeEventListener('beforeunload', onBlurOrUnload)
      void flush()
    }
  }, [])
}
