import { create } from 'zustand'
import type { TimeStats } from '@shared/ipc/contracts'

/**
 * Live usage-time state for the top-bar chip.
 *
 * `base` is the last snapshot persisted by main (includes per-agent breakdown). `pending` is
 * active seconds accumulated locally since the last successful flush (added on top of `base`
 * for display, then folded into `base` when main confirms the write). `session` is total
 * active seconds this session, never reset. `agentPending` mirrors `pending` per agent kind,
 * so the chip can show live per-agent totals before the next flush. The ticking + flushing
 * lifecycle lives in `useTimeTracker`.
 */

const EMPTY_STATS: TimeStats = { today: 0, week: 0, weekDays: [], agentsToday: [], agentsWeek: [] }

interface TimeState {
  ready: boolean
  base: TimeStats
  pending: number
  session: number
  /** Unflushed per-agent seconds (kind → seconds), shown live on top of `base.agentsToday`. */
  agentPending: Record<string, number>

  /** Replace the persisted snapshot (initial load / day-rollover resync). */
  setBase: (stats: TimeStats) => void
  /** Record `seconds` of active time (one tick). */
  accumulate: (seconds: number) => void
  /** Attribute `seconds` of the active tick to an agent kind. */
  accumulateAgent: (kind: string, seconds: number) => void
  /** A flush of `flushed` seconds was confirmed by main; adopt its fresh snapshot. */
  commitFlush: (base: TimeStats, flushed: number) => void
}

export const useTimeStore = create<TimeState>((set) => ({
  ready: false,
  base: EMPTY_STATS,
  pending: 0,
  session: 0,
  agentPending: {},

  setBase: (stats) =>
    set((s) => ({
      base: stats,
      ready: true,
      // Keep unflushed agent seconds on top of the fresh snapshot (they're part of it).
      agentPending: s.agentPending,
    })),
  accumulate: (seconds) =>
    set((s) => ({ pending: s.pending + seconds, session: s.session + seconds })),
  accumulateAgent: (kind, seconds) =>
    set((s) => ({ agentPending: { ...s.agentPending, [kind]: (s.agentPending[kind] ?? 0) + seconds } })),
  commitFlush: (base, flushed) =>
    set((s) => ({ base, pending: Math.max(0, s.pending - flushed), agentPending: {} })),
}))
