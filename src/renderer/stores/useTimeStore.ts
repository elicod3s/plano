import { create } from 'zustand'
import type { TimeStats } from '@shared/ipc/contracts'

/**
 * Live usage-time state for the top-bar chip.
 *
 * `base` is the last snapshot persisted by main. `pending` is active seconds accumulated
 * locally since the last successful flush (added on top of `base` for display, then folded
 * into `base` when main confirms the write). `session` is total active seconds this session,
 * never reset. The ticking + flushing lifecycle lives in `useTimeTracker`.
 */

const EMPTY_STATS: TimeStats = { today: 0, week: 0, weekDays: [] }

interface TimeState {
  ready: boolean
  base: TimeStats
  pending: number
  session: number

  /** Replace the persisted snapshot (initial load / day-rollover resync). */
  setBase: (stats: TimeStats) => void
  /** Record `seconds` of active time (one tick). */
  accumulate: (seconds: number) => void
  /** A flush of `flushed` seconds was confirmed by main; adopt its fresh snapshot. */
  commitFlush: (base: TimeStats, flushed: number) => void
}

export const useTimeStore = create<TimeState>((set) => ({
  ready: false,
  base: EMPTY_STATS,
  pending: 0,
  session: 0,

  setBase: (stats) => set({ base: stats, ready: true }),
  accumulate: (seconds) =>
    set((s) => ({ pending: s.pending + seconds, session: s.session + seconds })),
  commitFlush: (base, flushed) =>
    set((s) => ({ base, pending: Math.max(0, s.pending - flushed) })),
}))
