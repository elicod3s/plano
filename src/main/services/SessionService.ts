/**
 * SessionService — the live "which project is open right now" pointer, so a relaunch can restore
 * the project the user left open, or start blank when they deliberately closed everything.
 *
 * Deliberately separate from the recents *history* (WorkspaceService): closing a project clears
 * this pointer but leaves the folder in recents, so it's still one click away. App-global, stored
 * next to settings/recents in <userData>/session.json (atomic temp+rename).
 */

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionState, SessionSetRequest } from '@shared/ipc/contracts'

const SESSION_FILE = 'session.json'

export class SessionService {
  private filePath(): string {
    return join(app.getPath('userData'), SESSION_FILE)
  }

  /**
   * The project open at last quit. `initialized` is false only on a fresh install (no file yet),
   * which lets the renderer fall back to the most-recent folder that one time — so upgrading users
   * who never explicitly closed a project still get their last workspace reopened.
   */
  async get(): Promise<SessionState> {
    try {
      const raw = await fs.readFile(this.filePath(), 'utf8')
      const doc = JSON.parse(raw) as Partial<SessionState>
      const folderPath = typeof doc.folderPath === 'string' && doc.folderPath ? doc.folderPath : null
      return { folderPath, initialized: true }
    } catch {
      // Missing/unreadable → treat as "never recorded" so launch restore can fall back to recents.
      return { folderPath: null, initialized: false }
    }
  }

  /** Record the open project, or null to mark "no project open". Best-effort; non-fatal on failure. */
  async set(req: SessionSetRequest): Promise<{ ok: true }> {
    const folderPath = typeof req?.folderPath === 'string' && req.folderPath ? req.folderPath : null
    try {
      await this.atomicWrite(this.filePath(), JSON.stringify({ folderPath }, null, 2))
    } catch {
      /* the session pointer is best-effort — a write failure must never crash a project switch */
    }
    return { ok: true }
  }

  private async atomicWrite(file: string, content: string): Promise<void> {
    const tmp = `${file}.${randomUUID()}.tmp`
    await fs.writeFile(tmp, content, 'utf8')
    await fs.rename(tmp, file)
  }
}
