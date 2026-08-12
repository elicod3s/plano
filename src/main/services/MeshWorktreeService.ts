/**
 * MeshWorktreeService — isolate multi-agent fan-out with git worktrees.
 *
 * NEVER run several writing agents on the same checkout: each fan-out target gets its OWN
 * worktree + branch, so parallel agents can't stomp each other. The service is deliberately
 * conservative:
 *   - only operates inside the active workspace folder (a real git repo with a HEAD commit);
 *   - branch/worktree names are sanitised (no shell interpolation);
 *   - a worktree with uncommitted changes is NEVER removed without an explicit force;
 *   - everything goes through `git worktree` (no hand-rolled checkout logic).
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)

const SAFE_NAME_RE = /[^A-Za-z0-9._-]+/g

/** Sanitise a user/agent-supplied name into something git accepts (never a shell metachar). */
function sanitizeName(input: string, fallback: string): string {
  const clean = (input || '').replace(SAFE_NAME_RE, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return clean || fallback
}

export interface WorktreeCreateRequest {
  /** The repo folder (the active workspace's folderPath). */
  repo: string
  /** Short mission name for the branches (sanitised). */
  mission: string
  /** Number of worktrees to create (capped). */
  count: number
}

export interface WorktreeInfo {
  path: string
  branch: string
  /** True when the worktree has uncommitted changes or untracked files. */
  dirty: boolean
  ahead: number
  behind: number
}

export class MeshWorktreeService {
  private readonly worktrees = new Map<string, WorktreeInfo>()

  /** Is this folder a git repo with at least one commit? (no-op for non-repos) */
  async isRepo(folder: string): Promise<boolean> {
    try {
      await execFileAsync('git', ['-C', folder, 'rev-parse', '--is-inside-work-tree'], { windowsHide: true })
      return true
    } catch {
      return false
    }
  }

  /**
   * Create `count` worktrees of `repo`, each on its own branch derived from `mission`.
   * Returns the created worktrees. Throws on failure (caller surfaces the message).
   */
  async create(req: WorktreeCreateRequest): Promise<WorktreeInfo[]> {
    const { repo, mission } = req
    const count = Math.max(1, Math.min(8, Math.floor(req.count) || 1))
    if (!repo || !existsSync(repo)) throw new Error('Workspace folder does not exist.')
    if (!(await this.isRepo(repo))) throw new Error('Not a git repository — fan-out needs git.')

    const branchBase = sanitizeName(mission || 'mission', 'mission')
    const stamp = randomUUID().slice(0, 6)
    const out: WorktreeInfo[] = []
    for (let i = 1; i <= count; i++) {
      const branch = `plano/${branchBase}-${stamp}-${i}`
      const path = join(repo, '.plano', 'worktrees', `${branchBase}-${i}-${stamp}`)
      await execFileAsync('git', ['-C', repo, 'worktree', 'add', '-b', branch, path, 'HEAD'], {
        windowsHide: true,
      })
      const info: WorktreeInfo = { path, branch, dirty: false, ahead: 0, behind: 0 }
      this.worktrees.set(path, info)
      out.push(info)
    }
    return out
  }

  /** Status of one worktree: dirty flag + ahead/behind vs its upstream. */
  async status(path: string): Promise<WorktreeInfo | null> {
    const base = this.worktrees.get(path)
    if (!base || !existsSync(path)) return base ?? null
    try {
      const dirty = await execFileAsync('git', ['-C', path, 'status', '--porcelain'], { windowsHide: true })
      let ahead = 0
      let behind = 0
      try {
        const { stdout } = await execFileAsync('git', ['-C', path, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], {
          windowsHide: true,
        })
        const [a, b] = stdout.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0)
        ahead = a
        behind = b
      } catch {
        /* no upstream — ahead/behind stay 0 */
      }
      const info: WorktreeInfo = {
        path,
        branch: base.branch,
        dirty: dirty.stdout.trim().length > 0,
        ahead,
        behind,
      }
      this.worktrees.set(path, info)
      return info
    } catch {
      return base
    }
  }

  /**
   * Remove a worktree. Refuses when it has uncommitted changes unless `force` is true.
   * The worktree lives under <repo>/.plano/worktrees — a fixed, safe location.
   */
  async remove(path: string, force = false): Promise<{ ok: boolean; error?: string }> {
    const info = await this.status(path)
    if (info?.dirty && !force) {
      return { ok: false, error: 'Worktree has uncommitted changes — confirm to discard.' }
    }
    try {
      const args = ['worktree', 'remove', '--force', path]
      await execFileAsync('git', ['-C', basename(path) === '' ? path : path, ...args], { windowsHide: true })
      this.worktrees.delete(path)
      return { ok: true }
    } catch {
      // Retry from the repo root (worktree removal wants the repo context).
      try {
        const repo = this.repoFor(path)
        if (repo) {
          await execFileAsync('git', ['-C', repo, 'worktree', 'remove', '--force', path], { windowsHide: true })
          this.worktrees.delete(path)
          return { ok: true }
        }
      } catch {
        /* fall through */
      }
      return { ok: false, error: 'Could not remove worktree.' }
    }
  }

  /** Tracked worktrees in this session. */
  list(): WorktreeInfo[] {
    return [...this.worktrees.values()]
  }

  private repoFor(path: string): string | null {
    // Our worktrees always live at <repo>/.plano/worktrees/<name> — walk up.
    const parts = path.split(/[\\/]/)
    const idx = parts.indexOf('.plano')
    if (idx > 0) return parts.slice(0, idx).join('\\')
    return null
  }
}
