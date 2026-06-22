import { create } from 'zustand'

/** Context for the rich "close agent terminal" confirmation. */
export interface TerminalClosePromptOptions {
  /** Detected agent's display name, e.g. "Claude Code". */
  agentName: string
  /** Detected agent's lucide icon name (brand glyph). */
  agentIcon?: string
  /** Live PTY id, used to list the agent process(es) running in this terminal. */
  ptyId: string | null
  /** The terminal's working directory, used for the git summary. */
  cwd?: string
}

interface TerminalClosePromptState {
  open: boolean
  options: TerminalClosePromptOptions | null
  _resolve: ((ok: boolean) => void) | null
  /** Open the dialog; resolves true (close the terminal) / false (cancel). */
  prompt: (options: TerminalClosePromptOptions) => Promise<boolean>
  respond: (ok: boolean) => void
}

/**
 * Drives the dedicated, app-styled confirmation shown when closing a terminal that has a
 * detected AI agent running. Mounted once as <TerminalCloseDialog/> and called imperatively
 * via promptTerminalClose(), mirroring the simpler useConfirmStore pattern.
 */
export const useTerminalClosePrompt = create<TerminalClosePromptState>((set, get) => ({
  open: false,
  options: null,
  _resolve: null,
  prompt: (options) =>
    new Promise<boolean>((resolve) => {
      get()._resolve?.(false)
      set({ open: true, options, _resolve: resolve })
    }),
  respond: (ok) => {
    const resolve = get()._resolve
    set({ open: false, options: null, _resolve: null })
    resolve?.(ok)
  },
}))

/** Imperative helper: `if (await promptTerminalClose({...})) { …close… }`. */
export function promptTerminalClose(options: TerminalClosePromptOptions): Promise<boolean> {
  return useTerminalClosePrompt.getState().prompt(options)
}
