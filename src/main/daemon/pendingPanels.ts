/**
 * pendingPanels — terminals/agents created from the MOBILE web app while PLANO is CLOSED.
 *
 * The desktop renderer is the owner of workspace layout (panels are persisted JSON). When a phone
 * creates a terminal while the app is running, the host broadcasts `external-terminal` and the
 * renderer materializes the panel live. When the app is CLOSED there is no renderer, so the host
 * records the request here; on the next launch the renderer reads + clears this list and adds the
 * panels to their workspaces BEFORE restoring sessions (so the new terminalId is in the kept set
 * and its live session reattaches instead of being orphan-killed).
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface PendingPanel {
  ptyId: string
  panelId: string
  terminalId: string
  spaceId: string
  folderPath: string | null
  name: string
  cwd: string
  shellName: string
  bootCommand?: string
  autoApprove?: boolean
  cols: number
  rows: number
  /** Mesh spawn placement hints — the panel that asked, and this one's slot in the batch. The
   *  requester may be gone by the next launch; the renderer falls back to the centred grid. */
  originPanelId?: string
  groupIndex?: number
  groupCount?: number
  createdAt: number
}

const MAX_PENDING = 50

export class PendingPanelsStore {
  private file: string
  private list: PendingPanel[] = []

  constructor(userDataPath: string) {
    this.file = join(userDataPath, 'pending-panels.json')
    try {
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as PendingPanel[]
      if (Array.isArray(parsed)) this.list = parsed.slice(-MAX_PENDING)
    } catch {
      this.list = []
    }
  }

  add(panel: Omit<PendingPanel, 'createdAt'>): PendingPanel {
    const entry: PendingPanel = { ...panel, createdAt: Date.now() }
    this.list.push(entry)
    if (this.list.length > MAX_PENDING) this.list = this.list.slice(-MAX_PENDING)
    this.persist()
    return entry
  }

  all(): PendingPanel[] {
    return [...this.list]
  }

  clear(): void {
    this.list = []
    this.persist()
  }

  private persist(): void {
    try {
      mkdirSync(join(this.file, '..'), { recursive: true })
      const tmp = `${this.file}.${randomUUID()}.tmp`
      writeFileSync(tmp, JSON.stringify(this.list, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch {
      /* best effort */
    }
  }
}

export { existsSync }
