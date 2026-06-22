import { create } from 'zustand'

export type TerminalStatus = 'starting' | 'ready' | 'exited'

export interface TerminalRuntime {
  ptyId: string
  pid: number
  shellName: string
  status: TerminalStatus
  /** Directory the shell is currently in: seeded from spawn, then updated live via OSC-7 on `cd`. */
  cwd?: string
  /** The panel that owns this terminal — lets teardown kill every terminal of a panel even though
   *  the store is keyed by terminal id (a panel can hold several terminals/tabs). */
  panelId: string
}

interface TerminalState {
  /**
   * Live PTY sessions keyed by TERMINAL id (a panel's tab id — a panel can host several). PERSISTS
   * across workspace ("space") switches: the shell keeps running in main while its tab is unmounted,
   * so returning reattaches (replaying buffered output) instead of respawning. An entry is removed
   * only when the terminal is truly ended — via `drop`, called from the explicit teardown paths
   * (tab/panel closed, space deleted, project switched). NOT persisted; ptys re-spawn on app launch.
   */
  byPanel: Record<string, TerminalRuntime>
  attach: (termId: string, runtime: TerminalRuntime) => void
  setStatus: (termId: string, status: TerminalStatus) => void
  /** Update a terminal's live working directory (from the shell's OSC-7 reports). */
  setCwd: (termId: string, cwd: string) => void
  /** Forget a session (after its PTY has actually been killed). */
  drop: (termId: string) => void
}

export const useTerminalStore = create<TerminalState>((set) => ({
  byPanel: {},
  attach: (termId, runtime) => set((s) => ({ byPanel: { ...s.byPanel, [termId]: runtime } })),
  setStatus: (termId, status) =>
    set((s) => {
      const cur = s.byPanel[termId]
      if (!cur) return s
      return { byPanel: { ...s.byPanel, [termId]: { ...cur, status } } }
    }),
  setCwd: (termId, cwd) =>
    set((s) => {
      const cur = s.byPanel[termId]
      if (!cur || cur.cwd === cwd) return s
      return { byPanel: { ...s.byPanel, [termId]: { ...cur, cwd } } }
    }),
  drop: (termId) =>
    set((s) => {
      const next = { ...s.byPanel }
      delete next[termId]
      return { byPanel: next }
    }),
}))
