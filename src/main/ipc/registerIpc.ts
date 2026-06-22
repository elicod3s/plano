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
  FsWatchRequest,
  FsUnwatchRequest,
  TimeAddActiveRequest,
  GitStatusRequest,
  AppInfo,
  SessionSetRequest,
  WorkspaceStateSaveRequest,
} from '@shared/ipc/contracts'
import type { AgentSessionRef, ResumableAgent } from '@shared/domain/agent'
import { RESUMABLE_AGENTS, SESSION_ID_RE } from '@shared/domain/agent'
import type { PtyManager } from '../services/PtyManager'
import type { WorkspaceService } from '../services/WorkspaceService'
import type { WorkspaceStateService } from '../services/WorkspaceStateService'
import type { FileSystemService } from '../services/FileSystemService'
import type { FileWatcherService } from '../services/FileWatcherService'
import type { GitService } from '../services/GitService'
import type { TimeTrackingService } from '../services/TimeTrackingService'
import type { SettingsService } from '../services/SettingsService'
import type { SessionService } from '../services/SessionService'
import type { AgentSessionService } from '../services/AgentSessionService'

export interface Services {
  pty: PtyManager
  workspace: WorkspaceService
  workspaceState: WorkspaceStateService
  fs: FileSystemService
  fileWatcher: FileWatcherService
  git: GitService
  time: TimeTrackingService
  settings: SettingsService
  session: SessionService
  agentSession: AgentSessionService
}

/** Cross-cutting bits the handlers need that aren't a service (e.g. launch arguments). */
export interface IpcEnv {
  /** Returns the folder PLANO was launched with ("Open in PLANO"), clearing it so a reload won't reopen. */
  takeLaunchFolder: () => string | null
}

/** Valid resume targets (the values of RESUMABLE_AGENTS) — the trust boundary's allow-list. */
const RESUMABLE_SET = new Set<ResumableAgent>(Object.values(RESUMABLE_AGENTS) as ResumableAgent[])

/** Validate an AgentSessionRef arriving over IPC; null if malformed (rejected). */
function sanitizeRef(raw: unknown): AgentSessionRef | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { agent?: unknown; sessionId?: unknown; cwd?: unknown }
  if (typeof r.agent !== 'string' || !RESUMABLE_SET.has(r.agent as ResumableAgent)) return null
  if (typeof r.cwd !== 'string') return null
  if (r.sessionId !== undefined && (typeof r.sessionId !== 'string' || !SESSION_ID_RE.test(r.sessionId)))
    return null
  return { agent: r.agent as ResumableAgent, sessionId: r.sessionId as string | undefined, cwd: r.cwd }
}

export function registerIpc(services: Services, env: IpcEnv): void {
  const { pty, workspace, workspaceState, fs, fileWatcher, git, time, settings, session, agentSession } = services

  // ── terminal ──
  ipcMain.handle(CH.terminalCreate, (_e, req: TerminalCreateRequest) => pty.create(req))
  ipcMain.on(CH.terminalWrite, (_e, p: { ptyId: string; data: string }) => pty.write(p.ptyId, p.data))
  ipcMain.on(CH.terminalResize, (_e, p: { ptyId: string; cols: number; rows: number }) =>
    pty.resize(p.ptyId, p.cols, p.rows),
  )
  ipcMain.handle(CH.terminalKill, (_e, p: { ptyId: string }) => pty.kill(p.ptyId))
  ipcMain.handle(CH.terminalAttach, (_e, p: { ptyId: string }) => pty.attach(p.ptyId))
  ipcMain.on(CH.terminalDetach, (_e, p: { ptyId: string }) => pty.detach(p.ptyId))
  ipcMain.handle(CH.terminalListProcesses, async (_e, p: { ptyId: string }) => ({
    processes: await pty.listProcesses(p.ptyId),
  }))

  // ── agent detection ──
  ipcMain.on(CH.agentPing, (_e, p: { ptyId: string }) => pty.ping(p.ptyId))
  ipcMain.handle(CH.agentResolveSession, (_e, p: { ptyId: string; cwd: string }) => {
    if (!p || typeof p.ptyId !== 'string' || !/^[\w-]+$/.test(p.ptyId)) return null
    if (typeof p.cwd !== 'string') return null
    return agentSession.resolve(p.ptyId, p.cwd)
  })
  ipcMain.handle(CH.agentValidateSession, (_e, p: { ref: unknown; cwd: string }) => {
    const ref = sanitizeRef(p?.ref)
    if (!ref || typeof p?.cwd !== 'string') return null
    return agentSession.validate(ref, p.cwd)
  })
  ipcMain.on(CH.agentReportSession, (_e, p: { ptyId: string; ref: unknown }) => {
    const ref = sanitizeRef(p?.ref)
    if (!ref || typeof p?.ptyId !== 'string' || !/^[\w-]+$/.test(p.ptyId)) return
    agentSession.report(p.ptyId, ref)
  })

  // ── git (read-only) ──
  ipcMain.handle(CH.gitStatus, (_e, req: GitStatusRequest) => git.status(req))

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

  // App-global open-workspaces state (the single source of truth, hydrated on launch).
  ipcMain.handle(CH.workspacesGet, async () => {
    const result = await workspaceState.get()
    // Re-grant read access to every workspace's own folder + any editor/files panel root, so file
    // trees load on launch without re-picking (mirrors the per-folder workspace.open grant above).
    for (const ws of result.state?.workspaces ?? []) {
      if (ws.folderPath) fs.setAllowedRoot(ws.folderPath)
      for (const p of ws.panels) {
        if (p.type === 'editor' && p.props.folderPath) fs.setAllowedRoot(p.props.folderPath)
        else if (p.type === 'files' && p.props.rootPath) fs.setAllowedRoot(p.props.rootPath)
      }
    }
    return result
  })
  ipcMain.handle(CH.workspacesSave, (_e, req: WorkspaceStateSaveRequest) => workspaceState.save(req))
  // Blocking final flush for the renderer's `beforeunload` (window close / quit) — guarantees the
  // last note/todo edit hits disk before the renderer is torn down (the async save can't finish in time).
  ipcMain.on(CH.workspacesSaveSync, (e, req: WorkspaceStateSaveRequest) => {
    e.returnValue = workspaceState.saveSync(req)
  })

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
  // Live folder watching for the Files panel. The service self-guards on allowed roots.
  ipcMain.handle(CH.fsWatch, (_e, req: FsWatchRequest) => fileWatcher.watch(req.dir))
  ipcMain.handle(CH.fsUnwatch, (_e, req: FsUnwatchRequest) => fileWatcher.unwatch(req.dir))

  // ── OS integration ──
  ipcMain.handle(CH.clipboardWriteText, (_e, text: string) => {
    clipboard.writeText(typeof text === 'string' ? text : String(text))
  })
  ipcMain.handle(CH.clipboardReadText, () => clipboard.readText())
  ipcMain.handle(CH.shellRevealPath, (_e, path: string) => {
    // Only reveal paths inside an opened workspace/editor root.
    if (typeof path === 'string' && fs.isAllowed(path)) shell.showItemInFolder(path)
  })
  ipcMain.handle(CH.shellOpenExternal, (_e, url: string) => {
    // Only ever hand http(s) URLs to the OS — never file:// or custom schemes.
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url)
    return undefined
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

  // ── settings ──
  ipcMain.handle(CH.settingsGet, () => settings.get())
  ipcMain.handle(CH.settingsSave, (_e, doc: unknown) => settings.save(doc))

  // ── session (open-project pointer for launch restore) ──
  ipcMain.handle(CH.sessionGet, () => session.get())
  ipcMain.handle(CH.sessionSet, (_e, req: SessionSetRequest) => session.set(req))

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
  ipcMain.handle(CH.appGetLaunchFolder, () => ({ folderPath: env.takeLaunchFolder() }))
}
