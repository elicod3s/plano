/**
 * Auto-update state (mirror of main's UpdateService, kept in sync via `update:status`).
 * The banner renders only from `downloading` / `downloaded` / `error` phases.
 */
import { create } from 'zustand'
import type { UpdateState } from '@shared/ipc/contracts'

interface UpdateStore extends UpdateState {
  /** User dismissed the current banner — sticky until a NEW download starts. */
  dismissed: boolean
  /** Subscribe to status pushes + load the current snapshot (call once, on app start). */
  hydrate: () => void
  checkNow: () => Promise<void>
  installNow: () => Promise<void>
  dismiss: () => void
}

export const useUpdateStore = create<UpdateStore>((set) => ({
  phase: 'idle',
  canCheck: false,
  dismissed: false,

  hydrate: () => {
    void window.plano.update
      .getState()
      .catch(() => null)
      .then((state) => {
        if (state) set({ ...state })
      })
    window.plano.update.onStatus((next) => {
      set((s) => ({
        ...next,
        // Re-surface a dismissed banner only when a fresh download starts; staying dismissed
        // through 'up-to-date' / repeated 'error' pushes keeps the retry loop quiet.
        dismissed: next.phase === 'downloading' || next.phase === 'downloaded' ? false : s.dismissed,
      }))
    })
  },

  checkNow: async () => {
    const result = await window.plano.update.check().catch(() => null)
    if (result) set({ ...result.state, dismissed: false })
  },

  installNow: async () => {
    await window.plano.update.install().catch(() => undefined)
  },

  dismiss: () => set({ dismissed: true }),
}))
