/**
 * Registers every ipcMain handler in one place and routes it to a service.
 * Renderer → main is `handle` (request/response) or `on` (fire-and-forget).
 * Each handler is the trust boundary: validate inputs before touching a service.
 */

import { ipcMain, app, BrowserWindow, shell, clipboard } from 'electron'
import { CH } from '@shared/ipc/channels'
import type {
  TerminalCreateRequest,
  WorkspaceOpenRequest,
  WorkspaceSaveRequest,
  FsReadTreeRequest,
  FsReadFileRequest,
  FsWriteFileRequest,
  FsReadBinaryFileRequest,
  TimeAddActiveRequest,
  AppInfo,
} from '@shared/ipc/contracts'
import type { PtyManager } from '../services/PtyManager'
import type { WorkspaceService } from '../services/WorkspaceService'
import type { FileSystemService } from '../services/FileSystemService'
import type { TimeTrackingService } from '../services/TimeTrackingService'

export interface Services {
  pty: PtyManager
  workspace: WorkspaceService
  fs: FileSystemService
  time: TimeTrackingService
}

export function registerIpc(services: Services): void {
  const { pty, workspace, fs, time } = services

  // ── terminal ──
  ipcMain.handle(CH.terminalCreate, (_e, req: TerminalCreateRequest) => pty.create(req))
  ipcMain.on(CH.terminalWrite, (_e, p: { ptyId: string; data: string }) => pty.write(p.ptyId, p.data))
  ipcMain.on(CH.terminalResize, (_e, p: { ptyId: string; cols: number; rows: number }) =>
    pty.resize(p.ptyId, p.cols, p.rows),
  )
  ipcMain.handle(CH.terminalKill, (_e, p: { ptyId: string }) => pty.kill(p.ptyId))

  // ── agent detection ──
  ipcMain.on(CH.agentPing, (_e, p: { ptyId: string }) => pty.ping(p.ptyId))

  // ── workspace ──
  ipcMain.handle(CH.workspaceOpen, async (_e, req: WorkspaceOpenRequest) => {
    const result = await workspace.open(req)
    fs.setAllowedRoot(result.folderPath)
    // Re-grant read access to folders that editor panels opened in a previous session,
    // so their file trees load on reload without forcing the user to re-pick.
    for (const space of result.workspace.spaces) {
      for (const p of space.panels) {
        if (p.type === 'editor' && p.props.folderPath) fs.setAllowedRoot(p.props.folderPath)
        // Legacy File Explorer panels (pre-merge) carry the folder in `rootPath`;
        // grant it too so the migrated Files panel can read its tree on first load.
        else if (p.type === 'files' && p.props.rootPath) fs.setAllowedRoot(p.props.rootPath)
      }
    }
    return result
  })
  ipcMain.handle(CH.workspaceSave, (_e, req: WorkspaceSaveRequest) => workspace.save(req))
  ipcMain.handle(CH.workspaceListRecent, () => workspace.listRecent())
  ipcMain.handle(CH.workspacePickFolder, () => workspace.pickFolder())

  // ── filesystem ──
  ipcMain.handle(CH.fsReadTree, (_e, req: FsReadTreeRequest) => fs.readTree(req))
  ipcMain.handle(CH.fsReadFile, (_e, req: FsReadFileRequest) => fs.readFile(req))
  ipcMain.handle(CH.fsWriteFile, (_e, req: FsWriteFileRequest) => fs.writeFile(req))
  // The native dialog is an explicit user gesture, so the chosen folder is trusted:
  // grant it as an allowed root before returning so the editor can read its tree.
  ipcMain.handle(CH.fsPickFolder, async () => {
    const { folderPath } = await workspace.pickFolder()
    if (folderPath) fs.setAllowedRoot(folderPath)
    return { folderPath }
  })
  ipcMain.handle(CH.fsReadBinaryFile, (_e, req: FsReadBinaryFileRequest) => fs.readBinaryFile(req))

  // ── OS integration ──
  ipcMain.handle(CH.clipboardWriteText, (_e, text: string) => {
    clipboard.writeText(typeof text === 'string' ? text : String(text))
  })
  ipcMain.handle(CH.shellRevealPath, (_e, path: string) => {
    // Only reveal paths inside an opened workspace/editor root.
    if (typeof path === 'string' && fs.isAllowed(path)) shell.showItemInFolder(path)
  })

  // ── window controls ──
  ipcMain.on(CH.windowMinimize, (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on(CH.windowToggleMaximize, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    win.isMaximized() ? win.unmaximize() : win.maximize()
  })
  ipcMain.on(CH.windowClose, (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.handle(CH.windowIsMaximized, (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false)

  // ── time tracking ──
  ipcMain.handle(CH.timeGetStats, () => time.getStats())
  ipcMain.handle(CH.timeAddActive, (_e, req: TimeAddActiveRequest) => time.addActive(req))

  // ── app ──
  ipcMain.handle(CH.appGetInfo, (): AppInfo => {
    return {
      versions: {
        app: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
      platform: process.platform,
      isPackaged: app.isPackaged,
      homeDir: app.getPath('home'),
    }
  })
}
