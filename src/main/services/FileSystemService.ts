/**
 * FileSystemService — read/write scoped to the open workspace root.
 *
 * Every path is resolved and checked to stay inside an allowed root (path-traversal
 * guard) before any disk access. The renderer is treated as untrusted.
 */

import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join, resolve, relative, isAbsolute, basename } from 'node:path'
import type {
  FsReadTreeRequest,
  FsReadTreeResult,
  FsReadFileRequest,
  FsReadFileResult,
  FsWriteFileRequest,
  FsWriteFileResult,
  FsReadBinaryFileRequest,
  FsReadBinaryFileResult,
  FsNode,
} from '@shared/ipc/contracts'

const IGNORED = new Set(['node_modules', '.git', '.plano', '.DS_Store', 'out', 'dist', 'release'])
const MAX_DEPTH = 6
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

  async readTree(req: FsReadTreeRequest): Promise<FsReadTreeResult> {
    const dir = this.assertAllowed(req.dir)
    const depth = Math.min(req.depth ?? 2, MAX_DEPTH)
    const root = await this.buildNode(dir, depth)
    return { root }
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

  async readBinaryFile(req: FsReadBinaryFileRequest): Promise<FsReadBinaryFileResult> {
    const path = this.assertAllowed(req.path)
    const stat = await fs.stat(path)
    if (stat.size > MAX_BINARY_BYTES) throw new Error('File is too large to preview in PLANO.')
    const buffer = await fs.readFile(path)
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    return { base64: buffer.toString('base64'), mime: MIME_BY_EXT[ext] ?? 'application/octet-stream' }
  }

  private async buildNode(dir: string, depth: number): Promise<FsNode> {
    const node: FsNode = { name: basename(dir), path: dir, type: 'directory', children: [] }
    if (depth <= 0) return node
    let entries: Dirent<string>[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return node
    }
    const children: FsNode[] = []
    for (const entry of entries) {
      if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue
      const childPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        children.push(await this.buildNode(childPath, depth - 1))
      } else if (entry.isFile()) {
        children.push({ name: entry.name, path: childPath, type: 'file' })
      }
    }
    // Directories first, then files; alphabetical within each group.
    children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    node.children = children
    return node
  }
}
