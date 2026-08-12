import { create } from 'zustand'
import type { UsageSnapshot, StatusbarAux } from '@shared/domain/usage'

/**
 * Live status-bar state. `snapshot` (provider quotas) and `aux` (ports + resources) are both
 * collected by the Agent Host and relayed through main; the store is hydrated once and updated
 * by host pushes. The reset-time TICKER lives in the StatusBar component — one 30 s interval
 * for the whole bar, never one timer per chip.
 */

const EMPTY_AUX: StatusbarAux = { ports: [], resources: { agentRssBytes: 0, appRssBytes: 0, at: 0 } }

interface UsageState {
  snapshot: UsageSnapshot
  aux: StatusbarAux
  ready: boolean
  hydrate: () => Promise<void>
  setSnapshot: (snapshot: UsageSnapshot) => void
  setAux: (aux: StatusbarAux) => void
}

export const useUsageStore = create<UsageState>((set) => ({
  snapshot: { providers: [], at: 0 },
  aux: EMPTY_AUX,
  ready: false,

  hydrate: async () => {
    try {
      const [snapshot, aux] = await Promise.all([
        window.plano.usage.get().catch(() => ({ providers: [], at: Date.now() }) as UsageSnapshot),
        window.plano.statusbar.getAux().catch(() => EMPTY_AUX),
      ])
      set({ snapshot, aux, ready: true })
      // Nudge the host: file/network providers re-read now so the cached snapshot goes live fast.
      void window.plano.usage.refresh().catch(() => undefined)
    } catch {
      set({ ready: true })
    }
  },

  setSnapshot: (snapshot) => set({ snapshot, ready: true }),
  setAux: (aux) => set({ aux, ready: true }),
}))
