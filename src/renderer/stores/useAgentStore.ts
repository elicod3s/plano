import { create } from 'zustand'
import type { AgentVerdict } from '@shared/domain/agent'
import { NO_AGENT } from '@shared/domain/agent'

interface AgentState {
  /** detection verdict keyed by ptyId */
  byPty: Record<string, AgentVerdict>
  /** the first prompt the user submitted to the detected agent, keyed by ptyId */
  promptByPty: Record<string, string>
  setVerdict: (ptyId: string, verdict: AgentVerdict) => void
  /** Record the first prompt for this terminal's agent (best-effort, captured in useXterm). */
  setPrompt: (ptyId: string, prompt: string) => void
  clear: (ptyId: string) => void
}

export const useAgentStore = create<AgentState>((set) => ({
  byPty: {},
  promptByPty: {},
  setVerdict: (ptyId, verdict) =>
    set((s) => {
      // When an agent leaves, drop its captured prompt so a freshly detected agent in the
      // same terminal starts clean (and the header returns to a plain terminal title).
      if (!verdict.active && s.promptByPty[ptyId]) {
        const prompts = { ...s.promptByPty }
        delete prompts[ptyId]
        return { byPty: { ...s.byPty, [ptyId]: verdict }, promptByPty: prompts }
      }
      return { byPty: { ...s.byPty, [ptyId]: verdict } }
    }),
  setPrompt: (ptyId, prompt) =>
    set((s) => ({ promptByPty: { ...s.promptByPty, [ptyId]: prompt } })),
  clear: (ptyId) =>
    set((s) => {
      const next = { ...s.byPty }
      delete next[ptyId]
      const prompts = { ...s.promptByPty }
      delete prompts[ptyId]
      return { byPty: next, promptByPty: prompts }
    }),
}))

export const selectVerdict = (ptyId: string | null) => (s: AgentState): AgentVerdict =>
  (ptyId && s.byPty[ptyId]) || NO_AGENT

export const selectPrompt = (ptyId: string | null) => (s: AgentState): string =>
  (ptyId && s.promptByPty[ptyId]) || ''

/** Count of terminals with an active agent — drives the TopBar running-agents pill. */
export const selectActiveAgentCount = (s: AgentState): number => {
  let n = 0
  for (const v of Object.values(s.byPty)) if (v.active) n++
  return n
}
