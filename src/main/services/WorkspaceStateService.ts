/**
 * WorkspaceStateService — the app-global store of every OPEN workspace.
 *
 * Each workspace now carries its OWN project folder (or none), so a single per-folder file can no
 * longer hold them all. The live truth lives in <userData>/workspaces.json (atomic temp+rename,
 * single-flight save, last-good .bak). This mirrors the resilience of WorkspaceService:
 *  - a failed/garbled read returns `null` (the renderer then migrates / keeps memory) — it NEVER
 *    fabricates a blank doc that could be autosaved over good state;
 *  - only one write runs at a time so concurrent saves can't race on the rename.
 * Folder-bound workspaces are ALSO mirrored to their own <folder>/.plano/workspace.json by the
 * renderer (via WorkspaceService) for portability + importing an existing project's layout.
 */

import { app } from 'electron'
import { promises as fs, copyFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { STATE_SCHEMA_VERSION, type Space, type Viewport, type WorkspaceStateDoc } from '@shared/domain/workspace'
import type { WorkspaceStateResult, WorkspaceStateSaveRequest, WorkspaceSaveResult } from '@shared/ipc/contracts'

const STATE_FILE = 'workspaces.json'

/** Transient Windows FS errors worth a brief retry (AV/indexer/our own rename holding the file). */
const TRANSIENT_FS_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class WorkspaceStateService {
  /** One in-flight save at a time — concurrent saves used to race on the rename and drop edits. */
  private saveChain: Promise<WorkspaceSaveResult> = Promise.resolve({ ok: true, savedAt: '' })

  private filePath(): string {
    return join(app.getPath('userData'), STATE_FILE)
  }
  private backupPath(): string {
    return `${this.filePath()}.bak`
  }

  /**
   * Read the app-global state. Returns `{ state: null }` when there's no usable file yet (fresh
   * install / first run on the new build) so the renderer migrates from the legacy per-folder
   * session instead of being handed a blank doc. A garbled main file falls back to the .bak.
   */
  async get(): Promise<WorkspaceStateResult> {
    const state = (await this.read(this.filePath())) ?? (await this.read(this.backupPath()))
    return { state }
  }

  private async read(file: string): Promise<WorkspaceStateDoc | null> {
    // Retry briefly on a transient lock so our own atomic rename / AV doesn't look like corruption
    // (which would wrongly trigger a migrate-and-overwrite of a perfectly good file at launch).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const raw = await fs.readFile(file, 'utf8')
        return this.normalize(JSON.parse(raw))
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (!TRANSIENT_FS_CODES.has(code ?? '')) return null
        await delay(40 * (attempt + 1))
      }
    }
    return null
  }

  save(req: WorkspaceStateSaveRequest): Promise<WorkspaceSaveResult> {
    // Chain so only one write runs at a time; a failed write doesn't poison the chain.
    const next = this.saveChain.catch(() => undefined).then(() => this.doSave(req))
    this.saveChain = next.catch(() => ({ ok: false, savedAt: '' }) as WorkspaceSaveResult)
    return next
  }

  private async doSave(req: WorkspaceStateSaveRequest): Promise<WorkspaceSaveResult> {
    const savedAt = new Date().toISOString()
    const doc: WorkspaceStateDoc = {
      schemaVersion: STATE_SCHEMA_VERSION,
      savedAt,
      activeId: req.activeId,
      workspaces: req.workspaces,
    }
    const file = this.filePath()
    // Keep the last good copy as a recovery point before overwriting (best-effort).
    await fs.copyFile(file, this.backupPath()).catch(() => undefined)
    await this.atomicWrite(file, JSON.stringify(doc, null, 2))
    return { ok: true, savedAt }
  }

  /**
   * Synchronous flush for the close/quit path. The renderer's `beforeunload` can't await the async
   * `save` before it's torn down, so the final flush must hit disk inline. Mirrors `doSave` (last-good
   * `.bak` + atomic temp+rename) with sync FS calls; never throws (returns `ok:false` instead) so a
   * close is never blocked by a write error. The unique tmp name keeps it safe against any async save
   * still in flight — both rename atomically onto the target, and this one carries the freshest state.
   */
  saveSync(req: WorkspaceStateSaveRequest): WorkspaceSaveResult {
    try {
      const savedAt = new Date().toISOString()
      const doc: WorkspaceStateDoc = {
        schemaVersion: STATE_SCHEMA_VERSION,
        savedAt,
        activeId: req.activeId,
        workspaces: req.workspaces,
      }
      const file = this.filePath()
      try {
        copyFileSync(file, this.backupPath())
      } catch {
        /* best-effort backup */
      }
      const tmp = `${file}.${randomUUID()}.tmp`
      writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
      renameSync(tmp, file)
      return { ok: true, savedAt }
    } catch {
      return { ok: false, savedAt: '' }
    }
  }

  // ── internals ──

  /** Coerce any on-disk doc into a valid state, or null if it has no usable workspaces. */
  private normalize(raw: unknown): WorkspaceStateDoc | null {
    const doc = (raw ?? {}) as Record<string, any>
    if (!Array.isArray(doc.workspaces) || doc.workspaces.length === 0) return null
    const workspaces: Space[] = doc.workspaces.map((s: any, i: number) => ({
      id: typeof s?.id === 'string' && s.id ? s.id : randomUUID(),
      name: typeof s?.name === 'string' && s.name ? s.name : `Workspace ${i + 1}`,
      folderPath: typeof s?.folderPath === 'string' && s.folderPath ? s.folderPath : null,
      viewport: this.normViewport(s?.viewport),
      panels: Array.isArray(s?.panels) ? s.panels : [],
      regions: Array.isArray(s?.regions) ? s.regions : [],
    }))
    const activeId =
      typeof doc.activeId === 'string' && workspaces.some((w) => w.id === doc.activeId)
        ? doc.activeId
        : workspaces[0].id
    const savedAt = typeof doc.savedAt === 'string' ? doc.savedAt : new Date(0).toISOString()
    return { schemaVersion: STATE_SCHEMA_VERSION, savedAt, activeId, workspaces }
  }

  private normViewport(v: any): Viewport {
    return v && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.zoom === 'number'
      ? { x: v.x, y: v.y, zoom: v.zoom }
      : { x: 0, y: 0, zoom: 1 }
  }

  private async atomicWrite(file: string, content: string): Promise<void> {
    const tmp = `${file}.${randomUUID()}.tmp`
    await fs.writeFile(tmp, content, 'utf8')
    await fs.rename(tmp, file)
  }
}
