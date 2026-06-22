/**
 * FileWatcherService — watches workspace folders and tells the renderer when their contents
 * change, so the Files panel tree (and an open file) refresh in real time as an agent edits.
 *
 * Uses native `fs.watch({ recursive: true })` — zero native deps. On Windows it's a single
 * ReadDirectoryChangesW handle and on macOS FSEvents, so watching a big tree (incl.
 * node_modules) is cheap; recursive watching isn't supported on Linux, where watch() throws
 * and we degrade to a silent no-op. Because the renderer re-reads the whole subtree on any
 * change, the classic fs.watch quirks (missed/duplicate events, missing filenames) are
 * self-correcting: one event ⇒ one refresh.
 *
 * Watches are ref-counted per directory, so several Files panels on the same folder share one
 * OS watcher. Events are debounced and coalesced per directory before posting.
 */

import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { CH } from '@shared/ipc/channels'
import type { FsChangedEvent } from '@shared/ipc/contracts'

const DEBOUNCE_MS = 150
// Mirror FileSystemService.IGNORED so churn in these (npm installs, git, our own .plano) never
// wakes the renderer. Hidden dotfolders are also skipped (the tree hides them anyway).
const IGNORED = new Set(['node_modules', '.git', '.plano', '.DS_Store', 'out', 'dist', 'release'])

interface Watch {
  watcher: FSWatcher
  refCount: number
  timer: NodeJS.Timeout | null
  /** Absolute paths changed since the last flush. */
  changed: Set<string>
}

export class FileWatcherService {
  private watches = new Map<string, Watch>()

  constructor(
    private readonly post: (channel: string, payload: unknown) => void,
    /** Guard: only ever watch directories the renderer is allowed to read. */
    private readonly isAllowed: (dir: string) => boolean,
  ) {}

  watch(dir: string): { ok: boolean } {
    if (!this.isAllowed(dir)) return { ok: false }

    const existing = this.watches.get(dir)
    if (existing) {
      existing.refCount += 1
      return { ok: true }
    }

    let watcher: FSWatcher
    try {
      watcher = watch(dir, { recursive: true, persistent: false })
    } catch {
      // Recursive watching unsupported on this platform (e.g. Linux) — degrade silently.
      return { ok: false }
    }

    const entry: Watch = { watcher, refCount: 1, timer: null, changed: new Set() }
    // A watcher error (folder deleted/unmounted) — tear it down rather than leak a dead handle.
    watcher.on('error', () => this.close(dir))
    watcher.on('change', (_type, filename) => {
      if (filename) {
        const rel = filename.toString()
        // Skip churn inside ignored folders (node_modules, .git, …) at any depth.
        if (rel.split(/[\\/]/).some((seg) => IGNORED.has(seg))) return
        entry.changed.add(join(dir, rel))
      }
      this.scheduleFlush(dir, entry)
    })

    this.watches.set(dir, entry)
    return { ok: true }
  }

  unwatch(dir: string): { ok: boolean } {
    const entry = this.watches.get(dir)
    if (!entry) return { ok: true }
    entry.refCount -= 1
    if (entry.refCount <= 0) this.close(dir)
    return { ok: true }
  }

  disposeAll(): void {
    for (const dir of [...this.watches.keys()]) this.close(dir)
  }

  private close(dir: string): void {
    const entry = this.watches.get(dir)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    try {
      entry.watcher.close()
    } catch {
      /* already closed */
    }
    this.watches.delete(dir)
  }

  private scheduleFlush(dir: string, entry: Watch): void {
    if (entry.timer) return // one flush per debounce window coalesces the burst
    entry.timer = setTimeout(() => {
      entry.timer = null
      const payload: FsChangedEvent = { dir, paths: [...entry.changed] }
      entry.changed.clear()
      this.post(CH.fsChanged, payload)
    }, DEBOUNCE_MS)
  }
}
