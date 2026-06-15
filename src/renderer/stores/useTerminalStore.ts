import { create } from 'zustand'

export type TerminalStatus = 'starting' | 'ready' | 'exited'

export interface TerminalRuntime {
  ptyId: string
  pid: number
  shellName: string
  status: TerminalStatus
}

interface TerminalState {
  /** runtime PTY info keyed by panelId (not persisted — ptys re-spawn on open) */
  byPanel: Record<string, TerminalRuntime>
  attach: (panelId: string, runtime: TerminalRuntime) => void
  setStatus: (panelId: string, status: TerminalStatus) => void
  detach: (panelId: string) => void
}

export const useTerminalStore = create<TerminalState>((set) => ({
  byPanel: {},
  attach: (panelId, runtime) => set((s) => ({ byPanel: { ...s.byPanel, [panelId]: runtime } })),
  setStatus: (panelId, status) =>
    set((s) => {
      const cur = s.byPanel[panelId]
      if (!cur) return s
      return { byPanel: { ...s.byPanel, [panelId]: { ...cur, status } } }
    }),
  detach: (panelId) =>
    set((s) => {
      const next = { ...s.byPanel }
      delete next[panelId]
      return { byPanel: next }
    }),
}))
