/**
 * Watches workspace folders and tells the renderer when their contents change.
 *
 * On Windows the cheap native recursive watcher (`fs.watch({ recursive: true })`, one
 * ReadDirectoryChangesW) is the primary backend — the pre-glass build that the user verified
 * as instant used exactly this. Chokidar remains only as a fallback where native recursive
 * watching is unavailable: on a large project chokidar must crawl the whole directory graph
 * to register watches (competing with the Files panel's own tree read at startup) and its
 * `awaitWriteFinish` polls every unstable path while agents write — that combination was the
 * Files-panel lag regression.
 *
 * Events are classified by kind: CONTENT changes (file edits) never need a tree rebuild;
 * STRUCTURAL ones (add/delete/rename/dir) do. Watches are ref-counted so several Files
 * panels rooted at the same folder share one OS watcher.
 */

import { watch as nativeWatch, type FSWatcher } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import chokidar from 'chokidar'
import { CH } from '@shared/ipc/channels'
import type { FsChangedEvent, FsChangeKind, FsPathChange } from '@shared/ipc/contracts'

const DEBOUNCE_MS = 75
/** Hard latency cap for a flush under a continuous write stream (plan C3). */
const MAX_FLUSH_WAIT_MS = 500
/** Batch cap: past this many changes in one quiet window, flush immediately. */
const MAX_BATCH = 500
// Mirror FileSystemService.IGNORED so dependency/build churn never wakes the renderer.
const IGNORED = new Set(['node_modules', '.git', '.plano', '.DS_Store', 'out', 'dist', 'release'])

interface Watch {
  /** Native or chokidar watcher handle. */
  watcher: FSWatcher | chokidar.FSWatcher
  refCount: number
  timer: NodeJS.Timeout | null
  /** Latency cap timer — forces a flush even when the quiet period never elapses. */
  maxWait: NodeJS.Timeout | null
  /** Absolute path → most significant kind since the last flush (structural wins). */
  changed: Map<string, FsChangeKind>
  /** Preserve the renderer's spelling/casing for event routing. */
  eventDir: string
  closed: boolean
}

/** Stable lookup key across separator/case variants on Windows. */
function watchKey(dir: string): string {
  const absolute = resolve(dir)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** True when a changed path should never wake the renderer (ignored/hidden segments). */
function isIgnored(root: string, candidate: string): boolean {
  const rel = relative(root, isAbsolute(candidate) ? candidate : resolve(candidate))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false
  return rel.split(/[\\/]/).some((segment) => segment.startsWith('.') || IGNORED.has(segment))
}

function mergeKind(entry: Watch, path: string, kind: FsChangeKind): void {
  const existing = entry.changed.get(path)
  // Structural is the most significant: a content edit of a just-created file must refresh
  // the tree; the reverse must not downgrade it.
  if (existing === 'structural' || kind === 'structural') entry.changed.set(path, 'structural')
  else if (!existing) entry.changed.set(path, kind)
}

export class FileWatcherService {
  private watches = new Map<string, Watch>()

  constructor(
    private readonly post: (channel: string, payload: unknown) => void,
    /** Guard: only ever watch directories the renderer is allowed to read. */
    private readonly isAllowed: (dir: string) => boolean,
    /** Optional diagnostic logger (DiagnosticsService.log) — used to surface inotify limits. */
    private readonly log?: (event: string, details?: Record<string, unknown>) => void,
  ) {}

  watch(dir: string): { ok: boolean } {
    const absoluteDir = resolve(dir)
    const key = watchKey(absoluteDir)
    const existing = this.watches.get(key)
    if (existing) {
      existing.refCount += 1
      return { ok: true }
    }
    if (!this.isAllowed(absoluteDir)) return { ok: false }

    const entry: Watch = {
      watcher: null as unknown as FSWatcher,
      refCount: 1,
      timer: null,
      maxWait: null,
      changed: new Map(),
      eventDir: dir,
      closed: false,
    }
    this.watches.set(key, entry)

    // Windows: one recursive native watcher — cheap to register, follows new dirs, no crawl.
    if (process.platform === 'win32') {
      try {
        const native = nativeWatch(absoluteDir, { recursive: true, persistent: false })
        // fs.FSWatcher emits a single 'change' event whose first arg is 'rename' | 'change'.
        native.on('change', (eventType, filename) =>
          this.onNativeEvent(entry, absoluteDir, eventType === 'change' ? 'content' : 'structural', filename),
        )
        native.on('error', () => this.close(key))
        entry.watcher = native
        return { ok: true }
      } catch {
        // Native recursive watch unavailable (rare on Windows) → chokidar fallback below.
      }
    }

    // Fallback: chokidar, with ignored pruning so its initialization never crawls heavy dirs.
    try {
      const ignored = (candidate: string): boolean => isIgnored(absoluteDir, candidate)
      const watcher = chokidar.watch(absoluteDir, {
        ignoreInitial: true,
        ignored,
        persistent: true,
        ignorePermissionErrors: true,
      })
      watcher.on('all', (event, changedPath) => {
        if (!changedPath || isIgnored(absoluteDir, changedPath)) return
        const kind: FsChangeKind =
          event === 'change' ? 'content' : 'add' === event || event.startsWith('unlink') ? 'structural' : 'structural'
        mergeKind(entry, resolve(changedPath), kind)
        this.scheduleFlush(key, entry)
      })
      watcher.on('error', (err) => {
        // Linux: ENOSPC means the inotify watch limit was hit (fs.inotify.max_user_watches).
        // Rather than silently closing and missing events, log through DiagnosticsService so the
        // user knows to raise the limit. The close still happens (the watcher is broken).
        if (err && (err as NodeJS.ErrnoException).code === 'ENOSPC') {
          this.log?.('file-watcher-inotify-limit', {
            dir: absoluteDir,
            hint: 'Run: sudo sysctl fs.inotify.max_user_watches=524288 && sudo sysctl -p',
          })
        }
        this.close(key)
      })
      entry.watcher = watcher
      return { ok: true }
    } catch {
      this.watches.delete(key)
      return { ok: false }
    }
  }

  private onNativeEvent(entry: Watch, root: string, kind: FsChangeKind, filename: string | Buffer | null): void {
    // Windows can omit the filename; an unnamed event is conservatively structural.
    const path = filename == null ? root : resolve(root, String(filename))
    if (!isIgnored(root, path)) mergeKind(entry, path, filename == null ? 'unknown' : kind)
    this.scheduleFlush(watchKey(root), entry)
  }

  unwatch(dir: string): { ok: boolean } {
    const key = watchKey(dir)
    const entry = this.watches.get(key)
    if (!entry) return { ok: true }
    entry.refCount -= 1
    if (entry.refCount <= 0) this.close(key)
    return { ok: true }
  }

  disposeAll(): void {
    for (const key of [...this.watches.keys()]) this.close(key)
  }

  private close(key: string): void {
    const entry = this.watches.get(key)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.maxWait) clearTimeout(entry.maxWait)
    entry.closed = true
    this.watches.delete(key)
    try {
      void (entry.watcher as { close?: () => unknown })?.close?.()
    } catch {
      /* already closed */
    }
  }

  private scheduleFlush(key: string, entry: Watch): void {
    if (entry.closed) return
    if (entry.timer) clearTimeout(entry.timer)
    // Bounded latency (plan C3): a continuous write stream never lets the quiet period elapse,
    // so the flush starves and then dumps one giant batch. Force a flush MAX_FLUSH_WAIT_MS after
    // the FIRST event of the batch — a steady trickle instead of starvation + avalanche.
    if (!entry.maxWait) {
      entry.maxWait = setTimeout(() => {
        entry.maxWait = null
        this.flush(key, entry)
      }, MAX_FLUSH_WAIT_MS)
    }
    // Batch cap: past MAX_BATCH changes, flush now instead of accumulating more.
    if (entry.changed.size >= MAX_BATCH) {
      if (entry.maxWait) {
        clearTimeout(entry.maxWait)
        entry.maxWait = null
      }
      this.flush(key, entry)
      return
    }
    // Wait for a short quiet period. This turns temp-file + rename atomic saves into one update.
    entry.timer = setTimeout(() => {
      entry.timer = null
      this.flush(key, entry)
    }, DEBOUNCE_MS)
  }

  private flush(key: string, entry: Watch): void {
    if (entry.closed || this.watches.get(key) !== entry) return
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    if (entry.maxWait) {
      clearTimeout(entry.maxWait)
      entry.maxWait = null
    }
    const changes: FsPathChange[] = [...entry.changed].map(([path, kind]) => ({ path, kind }))
    entry.changed.clear()
    const payload: FsChangedEvent = { dir: entry.eventDir, changes }
    this.post(CH.fsChanged, payload)
  }
}
