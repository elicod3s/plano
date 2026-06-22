import { create } from 'zustand'
import type { GitStatusResult } from '@shared/ipc/contracts'

interface GitEntry {
  status: GitStatusResult | null
  fetchedAt: number
  loading: boolean
}

interface GitState {
  /** Cache keyed by absolute cwd. Many terminals in the same repo share ONE entry + one request. */
  byCwd: Record<string, GitEntry | undefined>
  /**
   * Fetch git status for a cwd into the cache. Deduped (one in-flight request per cwd) and
   * throttled (skips a refetch within MIN_INTERVAL unless `force`), so several terminals polling
   * the same repo — or a burst of cd's — never hammer git.
   */
  refresh: (cwd: string, force?: boolean) => void
}

const MIN_INTERVAL = 1500 // ms

export const useGitStore = create<GitState>((set, get) => ({
  byCwd: {},
  refresh: (cwd, force = false) => {
    if (!cwd) return
    const entry = get().byCwd[cwd]
    const now = Date.now()
    if (entry?.loading) return
    if (!force && entry && now - entry.fetchedAt < MIN_INTERVAL) return
    set((s) => ({
      byCwd: {
        ...s.byCwd,
        [cwd]: { status: entry?.status ?? null, fetchedAt: entry?.fetchedAt ?? 0, loading: true },
      },
    }))
    void window.plano.git
      .status({ cwd })
      .then((status) => {
        set((s) => ({ byCwd: { ...s.byCwd, [cwd]: { status, fetchedAt: Date.now(), loading: false } } }))
      })
      .catch(() => {
        set((s) => ({ byCwd: { ...s.byCwd, [cwd]: { status: null, fetchedAt: Date.now(), loading: false } } }))
      })
  },
}))
