import { create } from 'zustand'

/** Options for a single confirmation prompt. */
export interface ConfirmOptions {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** Render the confirm button in the destructive (red) style. */
  danger?: boolean
}

interface ConfirmState {
  open: boolean
  options: ConfirmOptions | null
  _resolve: ((ok: boolean) => void) | null
  /** Open the dialog and resolve true (confirm) / false (cancel). */
  confirm: (options: ConfirmOptions) => Promise<boolean>
  respond: (ok: boolean) => void
}

/**
 * App-styled replacement for the native `window.confirm`. A single dialog instance is
 * mounted (ConfirmDialog) and driven imperatively via the `confirm()` helper, which returns
 * a promise so callers read like the native API: `if (await confirm({...})) …`.
 */
export const useConfirmStore = create<ConfirmState>((set, get) => ({
  open: false,
  options: null,
  _resolve: null,
  confirm: (options) =>
    new Promise<boolean>((resolve) => {
      // If one is somehow already open, resolve it as cancelled before replacing.
      get()._resolve?.(false)
      set({ open: true, options, _resolve: resolve })
    }),
  respond: (ok) => {
    const resolve = get()._resolve
    set({ open: false, options: null, _resolve: null })
    resolve?.(ok)
  },
}))

/** Imperative helper: `if (await confirm({ message: '…' })) { … }`. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().confirm(options)
}
