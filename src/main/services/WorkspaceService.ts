/**
 * WorkspaceService — open/save the per-project workspace document and track recents.
 *
 * Layout lives next to the project at <folder>/.plano/workspace.json (atomic writes,
 * pretty JSON, human-diffable). App-global recents live in userData, separate from any
 * project. Schema migrations will hang off `schemaVersion` as the shape evolves.
 */

import { app, dialog } from 'electron'
import { promises as fs } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  SCHEMA_VERSION,
  emptyWorkspace,
  type WorkspaceDoc,
  type Space,
  type Viewport,
  type RecentWorkspace,
} from '@shared/domain/workspace'
import type {
  WorkspaceOpenRequest,
  WorkspaceOpenResult,
  WorkspaceSaveRequest,
  WorkspaceSaveResult,
} from '@shared/ipc/contracts'

const PLANO_DIR = '.plano'
const WORKSPACE_FILE = 'workspace.json'
const RECENTS_FILE = 'recent-workspaces.json'
const MAX_RECENTS = 12

/** Transient Windows FS errors worth a brief retry (AV/indexer/another handle holding the file). */
const TRANSIENT_FS_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class WorkspaceService {
  /**
   * One in-flight save per folder. `saveCurrent()` is fired from many places (debounced autosave,
   * space switch, create/delete/rename, Ctrl+S); without serialization two saves race on the same
   * file's rename and the OLDER snapshot's rename can land last, dropping a just-created space.
   */
  private readonly saveChains = new Map<string, Promise<WorkspaceSaveResult>>()

  private recentsPath(): string {
    return join(app.getPath('userData'), RECENTS_FILE)
  }

  private workspacePath(folderPath: string): string {
    return join(folderPath, PLANO_DIR, WORKSPACE_FILE)
  }

  /** Last-good copy, written before each overwrite so a corrupted file can be recovered. */
  private backupPath(folderPath: string): string {
    return join(folderPath, PLANO_DIR, `${WORKSPACE_FILE}.bak`)
  }

  async open(req: WorkspaceOpenRequest): Promise<WorkspaceOpenResult> {
    const { folderPath } = req
    const file = this.workspacePath(folderPath)
    try {
      const raw = await this.readResilient(file)
      const workspace = this.normalize(JSON.parse(raw), folderPath)
      await this.addRecent(folderPath, workspace.meta.name)
      return { folderPath, workspace }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      // No file yet → a genuinely new project. A blank workspace is the correct, safe result.
      if (code === 'ENOENT') {
        const workspace = emptyWorkspace(basename(folderPath) || 'Workspace', randomUUID())
        await this.addRecent(folderPath, workspace.meta.name)
        return { folderPath, workspace, isNew: true }
      }
      // The file EXISTS but couldn't be read/parsed (lock, permissions, corruption). Try the
      // last-good backup before giving up — and NEVER fabricate a blank doc here, because the
      // renderer would autosave it straight over the user's real (still-on-disk) workspace.
      try {
        const rawBak = await fs.readFile(this.backupPath(folderPath), 'utf8')
        const workspace = this.normalize(JSON.parse(rawBak), folderPath)
        await this.addRecent(folderPath, workspace.meta.name)
        return { folderPath, workspace }
      } catch {
        /* no usable backup */
      }
      return {
        folderPath,
        // Placeholder only to satisfy the type; the renderer ignores `workspace` when `error` is set.
        workspace: emptyWorkspace(basename(folderPath) || 'Workspace', randomUUID()),
        error: { code: code ?? 'EUNKNOWN', message: err instanceof Error ? err.message : String(err) },
      }
    }
  }

  /** Read a file, retrying briefly on transient Windows locks so our own atomic rename / AV
   *  doesn't masquerade as a corrupt-workspace error. ENOENT and real errors propagate at once. */
  private async readResilient(file: string): Promise<string> {
    let lastErr: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await fs.readFile(file, 'utf8')
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'ENOENT' || !TRANSIENT_FS_CODES.has(code ?? '')) throw err
        lastErr = err
        await delay(40 * (attempt + 1))
      }
    }
    throw lastErr
  }

  save(req: WorkspaceSaveRequest): Promise<WorkspaceSaveResult> {
    const key = req.folderPath
    const prev = this.saveChains.get(key) ?? Promise.resolve<WorkspaceSaveResult>({ ok: true, savedAt: '' })
    // Chain so only one write per folder runs at a time; a failed write doesn't poison the chain.
    const next = prev.catch(() => undefined).then(() => this.doSave(req))
    this.saveChains.set(key, next)
    void next.catch(() => undefined).finally(() => {
      if (this.saveChains.get(key) === next) this.saveChains.delete(key)
    })
    return next
  }

  private async doSave(req: WorkspaceSaveRequest): Promise<WorkspaceSaveResult> {
    const { folderPath, workspace } = req
    const file = this.workspacePath(folderPath)
    const savedAt = new Date().toISOString()
    const doc: WorkspaceDoc = { ...workspace, schemaVersion: SCHEMA_VERSION, savedAt }
    await fs.mkdir(dirname(file), { recursive: true })
    // Preserve the last good copy as a recovery point before overwriting (best-effort; the very
    // first save has nothing to back up).
    await fs.copyFile(file, this.backupPath(folderPath)).catch(() => undefined)
    await this.atomicWrite(file, JSON.stringify(doc, null, 2))
    await this.addRecent(folderPath, doc.meta.name)
    return { ok: true, savedAt }
  }

  async listRecent(): Promise<{ recents: RecentWorkspace[] }> {
    return { recents: await this.readRecents() }
  }

  async pickFolder(): Promise<{ folderPath: string | null }> {
    const result = await dialog.showOpenDialog({
      title: 'Open project folder',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return { folderPath: null }
    return { folderPath: result.filePaths[0] }
  }

  // ── internals ──

  /**
   * Coerce any on-disk doc into the current v2 shape. v1 stored a single canvas at the
   * document root (`panels`/`viewport`); we wrap that into one space so old workspaces
   * keep working. Missing ids are minted so the renderer can always switch by id.
   */
  private normalize(raw: unknown, folderPath: string): WorkspaceDoc {
    const doc = (raw ?? {}) as Record<string, any>
    const name: string =
      typeof doc.meta?.name === 'string' && doc.meta.name ? doc.meta.name : basename(folderPath) || 'Workspace'
    const savedAt: string = typeof doc.savedAt === 'string' ? doc.savedAt : new Date(0).toISOString()

    // v2+ : already a list of spaces. Every space in a per-folder file belongs to that folder.
    if (Array.isArray(doc.spaces) && doc.spaces.length > 0) {
      const spaces: Space[] = doc.spaces.map((s: any, i: number) => ({
        id: typeof s?.id === 'string' && s.id ? s.id : randomUUID(),
        name: typeof s?.name === 'string' && s.name ? s.name : `Workspace ${i + 1}`,
        folderPath,
        viewport: this.normViewport(s?.viewport),
        panels: Array.isArray(s?.panels) ? s.panels : [],
        regions: Array.isArray(s?.regions) ? s.regions : [],
      }))
      const activeSpaceId =
        typeof doc.activeSpaceId === 'string' && spaces.some((s) => s.id === doc.activeSpaceId)
          ? doc.activeSpaceId
          : spaces[0].id
      return { schemaVersion: SCHEMA_VERSION, savedAt, meta: { name }, activeSpaceId, spaces }
    }

    // v1 : a single canvas at the root → migrate into one space.
    const space: Space = {
      id: randomUUID(),
      name: 'Workspace 1',
      folderPath,
      viewport: this.normViewport(doc.viewport),
      panels: Array.isArray(doc.panels) ? doc.panels : [],
      regions: Array.isArray(doc.regions) ? doc.regions : [],
    }
    return { schemaVersion: SCHEMA_VERSION, savedAt, meta: { name }, activeSpaceId: space.id, spaces: [space] }
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

  private async readRecents(): Promise<RecentWorkspace[]> {
    try {
      const raw = await fs.readFile(this.recentsPath(), 'utf8')
      const list = JSON.parse(raw) as RecentWorkspace[]
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  private async addRecent(path: string, name: string): Promise<void> {
    const recents = await this.readRecents()
    const next: RecentWorkspace[] = [
      { path, name, lastOpened: new Date().toISOString() },
      ...recents.filter((r) => r.path !== path),
    ].slice(0, MAX_RECENTS)
    try {
      await this.atomicWrite(this.recentsPath(), JSON.stringify(next, null, 2))
    } catch {
      /* recents are best-effort */
    }
  }
}
