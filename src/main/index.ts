/**
 * PLANO main entry — app lifecycle, single-instance lock, service wiring, security.
 */

import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createMainWindow } from './windows/mainWindow'
import { registerIpc, type Services } from './ipc/registerIpc'
import { PtyManager } from './services/PtyManager'
import { WorkspaceService } from './services/WorkspaceService'
import { FileSystemService } from './services/FileSystemService'
import { AgentDetectionService } from './services/AgentDetectionService'
import { TimeTrackingService } from './services/TimeTrackingService'

let mainWindow: BrowserWindow | null = null
let services: Services | null = null

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('dev.plano.app')
    app.on('browser-window-created', (_e, window) => optimizer.watchWindowShortcuts(window))

    mainWindow = createMainWindow()

    // Wire services. `post` streams main → renderer events to the live window.
    const post = (channel: string, payload: unknown): void => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload)
      }
    }

    const detection = new AgentDetectionService()
    services = {
      pty: new PtyManager({ post, detection }),
      workspace: new WorkspaceService(),
      fs: new FileSystemService(),
      time: new TimeTrackingService(),
    }
    registerIpc(services)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    services?.pty.disposeAll()
    void services?.time.flush()
  })
}
