import { create } from 'zustand'

/**
 * Imperative handles to a live xterm instance, registered by `useXterm` and consumed by the
 * panel chrome (PanelFrame header). This is what lets the terminal's toolbar buttons live
 * OUTSIDE the terminal body — on the panel border — yet still drive the xterm inside.
 * Runtime-only, keyed by TERMINAL id (a panel's tab; never persisted; re-registers on respawn).
 */
export interface TerminalControls {
  /** Clear the screen + scrollback, keeping the current prompt line. */
  clear: () => void
  /** Jump the viewport to the latest output. */
  scrollToBottom: () => void
}

interface TerminalControlState {
  byPanel: Record<string, TerminalControls>
  register: (termId: string, controls: TerminalControls) => void
  unregister: (termId: string) => void
}

export const useTerminalControlStore = create<TerminalControlState>((set) => ({
  byPanel: {},
  register: (termId, controls) =>
    set((s) => ({ byPanel: { ...s.byPanel, [termId]: controls } })),
  unregister: (termId) =>
    set((s) => {
      const next = { ...s.byPanel }
      delete next[termId]
      return { byPanel: next }
    }),
}))
