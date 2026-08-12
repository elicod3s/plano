/**
 * useFileTreeStore — shared per-directory cache for the Files panel(s).
 *
 * Data identity is the NORMALIZED ABSOLUTE directory path, never a panel id: several Files
 * panels rooted at the same folder share entries, status and in-flight reads. Expansion,
 * selection, scroll, drafts and rename state stay per panel (in FileTree), not here.
 *
 * Mini-store (getState/subscribe + useSyncExternalStore) — same spirit as usePanelStore,
 * hand-rolled so a component can subscribe to ONE directory and bail out everywhere else.
 */

import { useSyncExternalStore } from 'react'
import type { FsDirEntry } from '@shared/ipc/contracts'

export type DirStatus = 'idle' | 'loading' | 'ready' | 'error'

/** Directory snapshot exposed to components. Identity is STABLE until the dir changes, so
 *  useSyncExternalStore bails out for every row except the ones whose directory moved. */
export interface DirectorySnapshot {
  entries: FsDirEntry[] | null
  status: DirStatus
  generation: number
}

interface DirRecord {
  /** The live snapshot object — REPLACED (new identity) on every change to this dir. */
  snapshot: DirectorySnapshot
  /** Monotonic access clock for LRU eviction. */
  lastAccess: number
}

/** Soft cap on cached directories (entries survive collapse; eviction is last-access LRU). */
const MAX_DIRS = 256
/** The store never clears a directory that is mid-read (a flight re-inserts on completion). */
const EVICTABLE_STATUS: ReadonlySet<DirStatus> = new Set(['idle', 'ready', 'error'])

/** Windows paths compare case-insensitively; the main process single-flight keys by
 *  lowercased paths on win32. Mirror that so renderer-side identity matches. */
const NAVIGATOR = typeof navigator !== 'undefined' ? navigator : null
// `userAgentData` is a well-known DOM shape the base lib types don't declare — named cast.
const uaData = (NAVIGATOR as { userAgentData?: { platform?: string } } | null)?.userAgentData
const IS_WIN32 =
  NAVIGATOR !== null &&
  Boolean(
    uaData?.platform?.toLowerCase().includes('win') ||
      NAVIGATOR.platform?.toLowerCase().includes('win') ||
      NAVIGATOR.userAgent.includes('Windows'),
  )

/** Normalize an absolute path into the store key: forward slashes, no trailing slash. */
function normalizeDir(path: string): string {
  const norm = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return IS_WIN32 ? norm.toLowerCase() : norm
}

/** Directories first, then files; alphabetical within each group (mirrors main's sort). */
export function sortDirEntries(entries: FsDirEntry[]): FsDirEntry[] {
  return entries
    .slice()
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

const records = new Map<string, DirRecord>()
/** Renderer-side single-flight: one in-flight read per directory, shared across panels. */
const flights = new Map<string, Promise<void>>()
// Per-directory listeners (plan C4): a change in ONE directory notifies only the rows of that
// directory — thousands of mounted rows no longer walk a global listener set on every emit.
const listeners = new Map<string, Set<() => void>>()
/** Global listeners (mini-store contract compatibility, e.g. workspace-level consumers). */
const globalListeners = new Set<() => void>()
/** Bumped on every emit — lets the virtualized flat list re-derive itself cheaply. */
let version = 0
let accessClock = 0

const IDLE_SNAPSHOT: DirectorySnapshot = Object.freeze({ entries: null, status: 'idle', generation: 0 })

function emit(key: string): void {
  version += 1
  const set = listeners.get(key)
  if (set) for (const listener of set) listener()
  for (const listener of globalListeners) listener()
}

/** Monotonic change counter — the flat-list re-derivation key. */
export function getVersion(): number {
  return version
}

function subscribeDirectory(key: string, listener: () => void): () => void {
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(listener)
  return () => {
    set!.delete(listener)
    if (set!.size === 0) listeners.delete(key)
  }
}

function evictIfNeeded(): void {
  if (records.size <= MAX_DIRS) return
  let oldestKey: string | null = null
  let oldest = Infinity
  for (const [key, record] of records) {
    if (!EVICTABLE_STATUS.has(record.snapshot.status)) continue
    if (record.lastAccess < oldest) {
      oldest = record.lastAccess
      oldestKey = key
    }
  }
  if (oldestKey !== null) records.delete(oldestKey)
}

/** Set `snapshot` to a fresh object (new identity) so subscribers re-render. */
function setSnapshot(key: string, patch: Partial<DirectorySnapshot>): void {
  const record = records.get(key)
  if (!record) return
  record.snapshot = { ...record.snapshot, ...patch }
  emit(key)
}

/**
 * Read one directory and write the result into `records`, looping while the generation keeps
 * moving (a structural invalidate during the read supersedes it and triggers a fresh read).
 */
async function runLoad(key: string, path: string, generation: number): Promise<void> {
  try {
    for (;;) {
      let result: { ok: boolean; entries: FsDirEntry[] }
      try {
        result = await window.plano.fs.readDirectory({ dir: path })
      } catch {
        result = { ok: false, entries: [] }
      }
      const current = records.get(key)
      if (!current) return // evicted mid-flight (loading records are never evicted, so defensive)
      if (current.snapshot.generation !== generation) {
        // A structural event invalidated this dir while we were reading — re-read once.
        generation = current.snapshot.generation
        continue
      }
      setSnapshot(key, result.ok ? { entries: result.entries, status: 'ready' } : { entries: null, status: 'error' })
      // A burst of concurrent loads can push the map past the cap while every record is
      // 'loading' (unevictable); once they settle, restore the bound.
      evictIfNeeded()
      return
    }
  } finally {
    flights.delete(key)
  }
}

// ── Bounded concurrency queue (plan C1) ─────────────────────────────────────────
// A watcher burst (or a filter query) can invalidate/request MANY directories at once; firing
// one IPC read per directory would saturate the main process that also serves PTYs, agent
// detection and git. At most MAX_INFLIGHT reads run at once; the rest wait in a priority queue.
const MAX_INFLIGHT = 4
interface QueueItem {
  key: string
  path: string
  generation: number
  /** 0 = user-initiated (expansions, the root) — higher priority; 1 = watcher revalidations. */
  priority: number
}
const queue: QueueItem[] = []
let inflight = 0

function pump(): void {
  while (inflight < MAX_INFLIGHT && queue.length > 0) {
    let best = 0
    for (let i = 1; i < queue.length; i += 1) {
      if (queue[i].priority < queue[best].priority) best = i
    }
    const [item] = queue.splice(best, 1)
    const flight = runLoad(item.key, item.path, item.generation)
    flights.set(item.key, flight)
    inflight += 1
    void flight.finally(() => {
      inflight -= 1
      pump()
    })
  }
}

function dropQueued(key: string): void {
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (queue[i].key === key) queue.splice(i, 1)
  }
}

/**
 * Kick off (or join) a read for one directory, through the bounded queue. Single-flight per
 * path: concurrent callers share the same read. A directory that is already `ready` keeps its
 * cached entries visible while revalidating in the background — never a flash of empty.
 */
export function loadDirectory(path: string): void {
  const key = normalizeDir(path)
  if (flights.has(key)) return
  dropQueued(key)
  const existing = records.get(key)
  const generation = existing?.snapshot.generation ?? 0
  if (!existing) {
    records.set(key, { snapshot: { entries: null, status: 'loading', generation }, lastAccess: ++accessClock })
    evictIfNeeded()
  } else {
    if (existing.snapshot.status === 'loading') return
    setSnapshot(key, { status: 'loading' })
  }
  queue.push({ key, path, generation, priority: 0 })
  pump()
}

/**
 * A structural change happened under `path` (watcher event or a tree mutation): bump the
 * generation (stale completions are discarded) and re-read in the background, keeping the
 * cached rows visible. No-op for directories the store has never seen. Queue with LOWER
 * priority than user-initiated loads, so an interactive expansion is never starved by a
 * watcher burst.
 */
export function invalidateDirectory(path: string): void {
  const key = normalizeDir(path)
  const existing = records.get(key)
  if (!existing) return
  const generation = existing.snapshot.generation + 1
  setSnapshot(key, { generation })
  if (existing.snapshot.status === 'loading') {
    // The in-flight read will observe the new generation and re-read in its loop.
    return
  }
  existing.lastAccess = ++accessClock
  setSnapshot(key, { status: 'loading' })
  if (!flights.has(key)) {
    dropQueued(key)
    queue.push({ key, path, generation, priority: 1 })
    pump()
  }
}

/**
 * Apply a local tree mutation (create/rename/delete) to one cached directory so the change
 * is visible immediately; the caller then calls `invalidateDirectory` to revalidate from disk.
 */
export function optimisticPatch(parentPath: string, entries: FsDirEntry[]): void {
  const key = normalizeDir(parentPath)
  const existing = records.get(key)
  const generation = existing?.snapshot.generation ?? 0
  records.set(key, {
    snapshot: { entries: sortDirEntries(entries), status: 'ready', generation },
    lastAccess: ++accessClock,
  })
  emit(key)
}

/** Synchronous narrow read of one directory. Pure — no side effects (plan C4: LRU touches
 *  happen on real events like load/invalidate, never on render-path reads). */
export function getDirectory(path: string): DirectorySnapshot {
  const key = normalizeDir(path)
  const record = records.get(key)
  if (!record) return IDLE_SNAPSHOT
  return record.snapshot
}

/** Subscribe to ALL directory changes (mini-store contract; row-level code uses the hook). */
export function subscribe(listener: () => void): () => void {
  globalListeners.add(listener)
  return () => {
    globalListeners.delete(listener)
  }
}

/** Full state snapshot (the mini-store contract's `getState`). */
export function getState(): {
  entriesByDirectory: Record<string, FsDirEntry[]>
  statusByDirectory: Record<string, DirStatus>
  generation: Record<string, number>
} {
  const entriesByDirectory: Record<string, FsDirEntry[]> = {}
  const statusByDirectory: Record<string, DirStatus> = {}
  const generation: Record<string, number> = {}
  for (const [key, record] of records) {
    if (record.snapshot.entries) entriesByDirectory[key] = record.snapshot.entries
    statusByDirectory[key] = record.snapshot.status
    generation[key] = record.snapshot.generation
  }
  return { entriesByDirectory, statusByDirectory, generation }
}

/** Subscribe to ONE directory by path — used by rows AND the virtualized flat list. */
export function subscribeDirectoryPath(path: string, listener: () => void): () => void {
  return subscribeDirectory(normalizeDir(path), listener)
}

/**
 * React hook: subscribe to ONE directory. The snapshot identity is stable until that
 * directory's entries/status/generation change, so a component using this re-renders only
 * when ITS directory moves — the per-row granularity the lazy tree relies on.
 */
export function useFileTreeDirectory(path: string): DirectorySnapshot {
  const key = normalizeDir(path)
  return useSyncExternalStore(
    (listener) => subscribeDirectory(key, listener),
    () => {
      const record = records.get(key)
      return record ? record.snapshot : IDLE_SNAPSHOT
    },
    () => IDLE_SNAPSHOT,
  )
}
