/**
 * PLANO main entry — app lifecycle, single-instance lock, service wiring, security.
 */

import { app, BrowserWindow } from 'electron'
import { statSync } from 'node:fs'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { CH } from '@shared/ipc/channels'
import { createMainWindow } from './windows/mainWindow'
import { registerIpc, type Services } from './ipc/registerIpc'
import { PtyManager } from './services/PtyManager'
import { WorkspaceService } from './services/WorkspaceService'
import { WorkspaceStateService } from './services/WorkspaceStateService'
import { FileSystemService } from './services/FileSystemService'
import { FileWatcherService } from './services/FileWatcherService'
import { AgentDetectionService } from './services/AgentDetectionService'
import { AgentSessionService } from './services/AgentSessionService'
import { ProcessTreeService } from './services/ProcessTreeService'
import { TerminalHistoryService } from './services/TerminalHistoryService'
import { DevUrlService } from './services/DevUrlService'
import { GitService } from './services/GitService'
import { TimeTrackingService } from './services/TimeTrackingService'
import { SettingsService } from './services/SettingsService'
import { SessionService } from './services/SessionService'

let mainWindow: BrowserWindow | null = null
let services: Services | null = null

/**
 * Extract a folder path from process arguments — how Explorer's "Open in PLANO" hands us the
 * target ("PLANO.exe" "C:\some\folder"). Scan from the end for the first existing directory,
 * skipping Chromium/Electron switches. Returns null when launched normally.
 */
function folderFromArgv(argv: string[]): string | null {
  for (let i = argv.length - 1; i >= 1; i--) {
    const a = argv[i]
    if (!a || a.startsWith('-')) continue
    try {
      if (statSync(a).isDirectory()) return a
    } catch {
      // not a path / doesn't exist — keep scanning
    }
  }
  return null
}

// Honor the launch folder only when packaged; in dev, argv carries tooling paths we must ignore.
let launchFolder: string | null = app.isPackaged ? folderFromArgv(process.argv) : null

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // A second launch (e.g. "Open in PLANO" while already running) focuses us and hands over its folder.
  app.on('second-instance', (_e, argv) => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    const folder = folderFromArgv(argv)
    if (folder && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(CH.workspaceOpenFolder, { folderPath: folder })
    }
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('app.plano.desktop')
    app.on('browser-window-created', (_e, window) => optimizer.watchWindowShortcuts(window))

    mainWindow = createMainWindow()

    // Wire services. `post` streams main → renderer events to the live window.
    const post = (channel: string, payload: unknown): void => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload)
      }
    }

    // One shared process-tree snapshot powers both agent detection AND session resolution.
    const processTree = new ProcessTreeService()
    const detection = new AgentDetectionService(processTree)
    const agentSession = new AgentSessionService(detection, processTree)
    const terminalHistory = new TerminalHistoryService()
    const devUrls = new DevUrlService()
    const fileSystem = new FileSystemService()
    services = {
      pty: new PtyManager({ post, detection, history: terminalHistory, devUrls, agentSession }),
      workspace: new WorkspaceService(),
      workspaceState: new WorkspaceStateService(),
      fs: fileSystem,
      // Shares the FileSystemService's allowed-roots guard so we never watch outside the workspace.
      fileWatcher: new FileWatcherService(post, (dir) => fileSystem.isAllowed(dir)),
      git: new GitService(),
      time: new TimeTrackingService(),
      settings: new SettingsService(),
      session: new SessionService(),
      agentSession,
    }
    registerIpc(services, {
      takeLaunchFolder: () => {
        const f = launchFolder
        launchFolder = null // one-shot: a renderer reload must not reopen it
        return f
      },
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    services?.pty.disposeAll()
    services?.fileWatcher.disposeAll()
    void services?.time.flush()
  })
}
