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

export class WorkspaceService {
  private recentsPath(): string {
    return join(app.getPath('userData'), RECENTS_FILE)
  }

  private workspacePath(folderPath: string): string {
    return join(folderPath, PLANO_DIR, WORKSPACE_FILE)
  }

  async open(req: WorkspaceOpenRequest): Promise<WorkspaceOpenResult> {
    const { folderPath } = req
    const file = this.workspacePath(folderPath)
    let workspace: WorkspaceDoc
    try {
      const raw = await fs.readFile(file, 'utf8')
      workspace = this.normalize(JSON.parse(raw), folderPath)
    } catch {
      workspace = emptyWorkspace(basename(folderPath) || 'Workspace', randomUUID())
    }
    await this.addRecent(folderPath, workspace.meta.name)
    return { folderPath, workspace }
  }

  async save(req: WorkspaceSaveRequest): Promise<WorkspaceSaveResult> {
    const { folderPath, workspace } = req
    const file = this.workspacePath(folderPath)
    const savedAt = new Date().toISOString()
    const doc: WorkspaceDoc = { ...workspace, schemaVersion: SCHEMA_VERSION, savedAt }
    await fs.mkdir(dirname(file), { recursive: true })
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

    // v2+ : already a list of spaces.
    if (Array.isArray(doc.spaces) && doc.spaces.length > 0) {
      const spaces: Space[] = doc.spaces.map((s: any, i: number) => ({
        id: typeof s?.id === 'string' && s.id ? s.id : randomUUID(),
        name: typeof s?.name === 'string' && s.name ? s.name : `Workspace ${i + 1}`,
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
