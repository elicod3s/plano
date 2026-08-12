import { create } from 'zustand'
import type { AgentVerdict } from '@shared/domain/agent'
import { NO_AGENT } from '@shared/domain/agent'

interface AgentState {
  /** detection verdict keyed by ptyId */
  byPty: Record<string, AgentVerdict>
  /** the first prompt the user submitted to the detected agent, keyed by ptyId */
  promptByPty: Record<string, string>
  /**
   * the MOST RECENT prompt the user submitted to the detected agent, keyed by ptyId. Unlike
   * `promptByPty` (frozen at the first prompt for the header identity strip) this keeps updating
   * on every submission, so the "last prompt" peek can recall what was last asked without the
   * user scrolling back through a wall of agent output.
   */
  lastPromptByPty: Record<string, string>
  setVerdict: (ptyId: string, verdict: AgentVerdict) => void
  /** Record the first prompt for this terminal's agent (best-effort, captured in useXterm). */
  setPrompt: (ptyId: string, prompt: string) => void
  /** Record the latest prompt for this terminal's agent (best-effort, captured in useXterm). */
  setLastPrompt: (ptyId: string, prompt: string) => void
  clear: (ptyId: string) => void
}

export const useAgentStore = create<AgentState>((set) => ({
  byPty: {},
  promptByPty: {},
  lastPromptByPty: {},
  setVerdict: (ptyId, verdict) =>
    set((s) => {
      // When an agent leaves, drop its captured prompts so a freshly detected agent in the
      // same terminal starts clean (and the header returns to a plain terminal title).
      if (!verdict.active && (s.promptByPty[ptyId] || s.lastPromptByPty[ptyId])) {
        const prompts = { ...s.promptByPty }
        const lastPrompts = { ...s.lastPromptByPty }
        delete prompts[ptyId]
        delete lastPrompts[ptyId]
        return { byPty: { ...s.byPty, [ptyId]: verdict }, promptByPty: prompts, lastPromptByPty: lastPrompts }
      }
      return { byPty: { ...s.byPty, [ptyId]: verdict } }
    }),
  setPrompt: (ptyId, prompt) =>
    set((s) => ({ promptByPty: { ...s.promptByPty, [ptyId]: prompt } })),
  setLastPrompt: (ptyId, prompt) =>
    set((s) => ({ lastPromptByPty: { ...s.lastPromptByPty, [ptyId]: prompt } })),
  clear: (ptyId) =>
    set((s) => {
      const next = { ...s.byPty }
      delete next[ptyId]
      const prompts = { ...s.promptByPty }
      delete prompts[ptyId]
      const lastPrompts = { ...s.lastPromptByPty }
      delete lastPrompts[ptyId]
      return { byPty: next, promptByPty: prompts, lastPromptByPty: lastPrompts }
    }),
}))

export const selectVerdict = (ptyId: string | null) => (s: AgentState): AgentVerdict =>
  (ptyId && s.byPty[ptyId]) || NO_AGENT

export const selectPrompt = (ptyId: string | null) => (s: AgentState): string =>
  (ptyId && s.promptByPty[ptyId]) || ''

export const selectLastPrompt = (ptyId: string | null) => (s: AgentState): string =>
  (ptyId && s.lastPromptByPty[ptyId]) || ''

/** Count of terminals with an active agent — drives the TopBar running-agents pill. */
export const selectActiveAgentCount = (s: AgentState): number => {
  let n = 0
  for (const v of Object.values(s.byPty)) if (v.active) n++
  return n
}
