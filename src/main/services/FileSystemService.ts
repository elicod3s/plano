/**
 * FileSystemService — read/write scoped to the open workspace root.
 *
 * Every path is resolved and checked to stay inside an allowed root (path-traversal
 * guard) before any disk access. The renderer is treated as untrusted.
 */

import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join, resolve, relative, isAbsolute, dirname } from 'node:path'
import type {
  FsReadDirectoryRequest,
  FsReadDirectoryResult,
  FsDirEntry,
  FsReadFileRequest,
  FsReadFileResult,
  FsWriteFileRequest,
  FsWriteFileResult,
  FsReadBinaryFileRequest,
  FsReadBinaryFileResult,
  FsDropPathRequest,
  FsDropPathResult,
  FsCreateEntryRequest,
  FsCreateEntryResult,
  FsRenameEntryRequest,
  FsRenameEntryResult,
} from '@shared/ipc/contracts'

const IGNORED = new Set(['node_modules', '.git', '.plano', '.DS_Store', 'out', 'dist', 'release'])
/** Path separators, Windows-reserved characters, and control chars — rejected in new names. */
// eslint-disable-next-line no-control-regex
const INVALID_NAME_CHARS = /[\\/:*?"<>|\x00-\x1f]/
/** Windows device names (CON, PRN, AUX, NUL, COM1…, LPT1…) are invalid file names. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_BINARY_BYTES = 24 * 1024 * 1024

/** Extension → MIME, for previewable binary assets (images today). */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
}

export class FileSystemService {
  /** Roots the renderer is allowed to touch (set when a workspace opens). */
  private allowedRoots: string[] = []

  setAllowedRoot(folderPath: string): void {
    const root = resolve(folderPath)
    if (!this.allowedRoots.includes(root)) this.allowedRoots.push(root)
  }

  /** Non-throwing variant of the path-traversal guard, for best-effort OS actions. */
  isAllowed(target: string): boolean {
    try {
      this.assertAllowed(target)
      return true
    } catch {
      return false
    }
  }

  private assertAllowed(target: string): string {
    const abs = resolve(target)
    const ok = this.allowedRoots.some((root) => {
      const rel = relative(root, abs)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    })
    if (!ok) throw new Error(`Path is outside the workspace: ${target}`)
    return abs
  }

  /** In-flight shallow listings keyed by normalized directory path: simultaneous requests
   *  for the same dir (two Files panels, or a burst of refreshes) share ONE readdir. */
  private dirFlights = new Map<string, Promise<FsReadDirectoryResult>>()

  /**
   * One-level directory listing — the ONLY call the Files panel makes on the folder-open
   * critical path (no recursion, no per-entry stat; Dirent supplies the type). Symlinks are
   * neither `isFile()` nor `isDirectory()`, so they are skipped exactly as in `buildNode`.
   * Never throws: an inaccessible/gone directory returns `{ ok: false, entries: [] }`.
   */
  async readDirectory(req: FsReadDirectoryRequest): Promise<FsReadDirectoryResult> {
    try {
      const dir = this.assertAllowed(req.dir)
      const key = process.platform === 'win32' ? dir.toLowerCase() : dir
      const existing = this.dirFlights.get(key)
      if (existing) {
        try {
          return await existing
        } catch {
          // The shared read failed — fall through and retry once with a fresh promise.
        }
      }
      const flight = this.readDirectoryOnce(dir)
      this.dirFlights.set(key, flight)
      try {
        return await flight
      } finally {
        this.dirFlights.delete(key)
      }
    } catch {
      // Outside an allowed root (or malformed input) — same shape as an unreadable dir.
      return { ok: false, entries: [] }
    }
  }

  private async readDirectoryOnce(dir: string): Promise<FsReadDirectoryResult> {
    let entries: Dirent<string>[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return { ok: false, entries: [] }
    }
    const children: FsDirEntry[] = []
    for (const entry of entries) {
      if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        children.push({ name: entry.name, path: join(dir, entry.name), type: 'directory' })
      } else if (entry.isFile()) {
        children.push({ name: entry.name, path: join(dir, entry.name), type: 'file' })
      }
    }
    // Directories first, then files; alphabetical within each group (same sort as buildNode).
    children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return { ok: true, entries: children }
  }

  async readFile(req: FsReadFileRequest): Promise<FsReadFileResult> {
    const path = this.assertAllowed(req.path)
    const stat = await fs.stat(path)
    if (stat.size > MAX_FILE_BYTES) throw new Error('File is too large to open in PLANO.')
    const content = await fs.readFile(path, 'utf8')
    return { content, encoding: 'utf8' }
  }

  async writeFile(req: FsWriteFileRequest): Promise<FsWriteFileResult> {
    const path = this.assertAllowed(req.path)
    await fs.writeFile(path, req.content, 'utf8')
    return { ok: true }
  }

  /** One valid path segment (no separators / reserved characters), or throws. */
  private validateName(name: unknown): string {
    const n = typeof name === 'string' ? name.trim() : ''
    if (!n || n === '.' || n === '..' || n.length > 255) throw new Error('That name is not valid.')
    if (INVALID_NAME_CHARS.test(n)) throw new Error('Names can’t contain \\ / : * ? " < > |')
    if (RESERVED_NAMES.test(n) || n.endsWith('.')) throw new Error('That name is reserved by the OS.')
    return n
  }

  /** Create an empty file / folder. Fails (never overwrites) when the name already exists. */
  async createEntry(req: FsCreateEntryRequest): Promise<FsCreateEntryResult> {
    const dir = this.assertAllowed(req.dir)
    const target = this.assertAllowed(join(dir, this.validateName(req.name)))
    try {
      if (req.type === 'directory') await fs.mkdir(target)
      else await fs.writeFile(target, '', { flag: 'wx' }) // 'wx' → EEXIST instead of clobbering
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('Something with that name already exists here.')
      throw err
    }
    return { ok: true, path: target }
  }

  /** Rename in place (same parent). Refuses to rename an allowed root or clobber an existing entry. */
  async renameEntry(req: FsRenameEntryRequest): Promise<FsRenameEntryResult> {
    const path = this.assertAllowed(req.path)
    if (this.allowedRoots.includes(path)) throw new Error('The root folder can’t be renamed here.')
    const target = this.assertAllowed(join(dirname(path), this.validateName(req.newName)))
    if (target === path) return { ok: true, path }
    // Allow case-only renames on case-insensitive filesystems (stat would report "exists").
    const caseOnly = target.toLowerCase() === path.toLowerCase()
    if (!caseOnly) {
      const exists = await fs
        .stat(target)
        .then(() => true)
        .catch(() => false)
      if (exists) throw new Error('Something with that name already exists here.')
    }
    await fs.rename(path, target)
    return { ok: true, path: target }
  }

  /** Guard + resolve a path for deletion; the actual (recoverable) trashing runs in the IPC layer. */
  resolveForDelete(path: string): string {
    const abs = this.assertAllowed(path)
    if (this.allowedRoots.includes(abs)) throw new Error('The root folder can’t be deleted here.')
    return abs
  }

  /**
   * Stat a path the user dropped onto the canvas and, when it exists, grant read access —
   * the drop is an explicit user gesture, same trust as the native folder picker. A file
   * grants its parent folder so the Files panel can show the surrounding tree.
   */
  async registerDroppedPath(req: FsDropPathRequest): Promise<FsDropPathResult> {
    if (!req || typeof req.path !== 'string' || !req.path) return { kind: null }
    try {
      const abs = resolve(req.path)
      const stat = await fs.stat(abs)
      if (stat.isDirectory()) {
        this.setAllowedRoot(abs)
        return { kind: 'directory' }
      }
      if (stat.isFile()) {
        this.setAllowedRoot(dirname(abs))
        return { kind: 'file' }
      }
      return { kind: null }
    } catch {
      return { kind: null }
    }
  }

  async readBinaryFile(req: FsReadBinaryFileRequest): Promise<FsReadBinaryFileResult> {
    const path = this.assertAllowed(req.path)
    const stat = await fs.stat(path)
    if (stat.size > MAX_BINARY_BYTES) throw new Error('File is too large to preview in PLANO.')
    const buffer = await fs.readFile(path)
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    return { base64: buffer.toString('base64'), mime: MIME_BY_EXT[ext] ?? 'application/octet-stream' }
  }
}
