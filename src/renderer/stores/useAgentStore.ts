import { create } from 'zustand'
import type { AgentVerdict } from '@shared/domain/agent'
import { NO_AGENT } from '@shared/domain/agent'

interface AgentState {
  /** detection verdict keyed by ptyId */
  byPty: Record<string, AgentVerdict>
  setVerdict: (ptyId: string, verdict: AgentVerdict) => void
  clear: (ptyId: string) => void
}

export const useAgentStore = create<AgentState>((set) => ({
  byPty: {},
  setVerdict: (ptyId, verdict) =>
    set((s) => ({ byPty: { ...s.byPty, [ptyId]: verdict } })),
  clear: (ptyId) =>
    set((s) => {
      const next = { ...s.byPty }
      delete next[ptyId]
      return { byPty: next }
    }),
}))

export const selectVerdict = (ptyId: string | null) => (s: AgentState): AgentVerdict =>
  (ptyId && s.byPty[ptyId]) || NO_AGENT
