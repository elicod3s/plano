import { useEffect, useRef } from 'react'
import { useTimeStore } from '@/stores/useTimeStore'
import { dayKey } from '@shared/domain/time'

/**
 * Drives the top-bar usage clock. Once per second it counts a second of ACTIVE time —
 * window focused + page visible + not idle — into the store, and periodically flushes the
 * accumulated seconds to main for persistence. Mounted once (in App), independent of the chip.
 */

const TICK_MS = 1000
const FLUSH_MS = 15_000
const IDLE_MS = 5 * 60_000 // pause counting after 5 min with no input
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'pointerdown', 'touchstart'] as const

export function useTimeTracker(): void {
  // Refs survive re-renders; the effect runs once so these are effectively module-stable.
  const lastActivity = useRef(Date.now())
  const flushing = useRef(false)
  const currentDay = useRef(dayKey(new Date()))

  useEffect(() => {
    let disposed = false
    const { setBase, accumulate, commitFlush } = useTimeStore.getState()

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

    // Push accumulated seconds to main; fold the confirmed snapshot back into `base`.
    const flush = async (): Promise<void> => {
      if (flushing.current || disposed) return
      const amount = useTimeStore.getState().pending
      if (amount <= 0) return
      flushing.current = true
      try {
        const next = await window.plano.time.addActive({ seconds: amount })
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
      if (active) accumulate(1)

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
