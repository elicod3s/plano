/**
 * PLANO main entry — app lifecycle, single-instance lock, service wiring, security.
 */

import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { execFile } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { deprovision } from './daemon/mesh/provision'
import { CH } from '@shared/ipc/channels'

// Plan F9: the uninstaller runs `PLANO.exe --mesh-deprovision` before removing files — strip
// the `plano` MCP key from every harness config, restore backups and delete the skill, so the
// machine is left exactly as it was before the mesh provisioned it.
if (process.argv.includes('--mesh-deprovision')) {
  try {
    deprovision()
  } catch (err) {
    console.error('mesh deprovision failed:', err)
  }
  app.exit(0)
}
import { createMainWindow } from './windows/mainWindow'
import { registerIpc, type Services } from './ipc/registerIpc'
import { PtyManager } from './services/PtyManager'
import { WorkspaceService } from './services/WorkspaceService'
import { WorkspaceStateService } from './services/WorkspaceStateService'
import { FileSystemService } from './services/FileSystemService'
import { FileWatcherService } from './services/FileWatcherService'
import { AgentDetectionService } from './services/AgentDetectionService'
import { AgentSessionService } from './services/AgentSessionService'
import { AgentContextService } from './services/AgentContextService'
import { ProcessTreeService } from './services/ProcessTreeService'
import { TerminalHistoryService } from './services/TerminalHistoryService'
import { DevUrlService } from './services/DevUrlService'
import { GitService } from './services/GitService'
import { TimeTrackingService } from './services/TimeTrackingService'
import { SettingsService } from './services/SettingsService'
import { SessionService } from './services/SessionService'
import { VoiceService } from './services/VoiceService'
import { MeshWorktreeService } from './services/MeshWorktreeService'
import { WebviewMotionService } from './services/WebviewMotionService'
import { UpdateService } from './services/UpdateService'
import { DiagnosticsService } from './services/DiagnosticsService'

// Isolated userData on demand (dev/testing): a dev run must never fight the installed app's
// single-instance lock (userData-derived, case-insensitive on Windows) or clobber its
// settings/recents. Must run before requestSingleInstanceLock().
if (process.env.PLANO_USER_DATA_DIR) app.setPath('userData', process.env.PLANO_USER_DATA_DIR)

const diagnostics = new DiagnosticsService(app.getPath('userData'))
diagnostics.log('app-start', {
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  platform: process.platform,
})


// Electron requires this decision before ready. The setting existed in the UI but was never applied.
try {
  const stored = JSON.parse(
    readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8'),
  ) as { advanced?: { hardwareAcceleration?: boolean } }
  if (stored.advanced?.hardwareAcceleration === false) app.disableHardwareAcceleration()
} catch {
  // Missing/corrupt settings use Electron's normal accelerated default.
}

process.on('uncaughtExceptionMonitor', (error, origin) =>
  diagnostics.log('uncaught-exception', { error: String(error), stack: error.stack, origin }),
)
process.on('unhandledRejection', (reason) =>
  diagnostics.log('unhandled-rejection', { reason: String(reason) }),
)
app.on('child-process-gone', (_event, details) => diagnostics.log('child-process-gone', details))

let mainWindow: BrowserWindow | null = null
let services: Services | null = null
/** Plan F8: pending mesh-writes consent prompt (resolved by the renderer's toast). */
let pendingMeshConsent: { spaceId: string; resolve: (ok: boolean) => void } | null = null
/** v4 B3: pending chain Fire/Cancel prompt (onFailure: ask-user). */
let pendingChainAsk: { chainId: string; resolve: (ok: boolean) => void } | null = null

// Plan F8: the renderer's one-click consent toast resolves the pending daemon prompt.
ipcMain.handle(CH.meshConsentResponse, (_event: IpcMainInvokeEvent, ok: unknown) => {
  const pending = pendingMeshConsent
  pendingMeshConsent = null
  if (pending) pending.resolve(ok === true)
  return { ok: true }
})
// v4 B3: the renderer's Fire/Cancel toast resolves the pending chain prompt.
ipcMain.handle(CH.chainAskResponse, (_event: IpcMainInvokeEvent, ok: unknown) => {
  const pending = pendingChainAsk
  pendingChainAsk = null
  if (pending) pending.resolve(ok === true)
  return { ok: true }
})
// Module-scope handle to the settings service so the (sync) quit decision can read it; assigned
// inside whenReady where the instance is created.
let settingsService: SettingsService | null = null

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
  diagnostics.log('second-instance-exit')
  app.quit()
} else {
  // A second launch (e.g. "Open in PLANO" while already running) focuses us and hands over its folder.
  app.on('second-instance', (_e, argv) => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    const folder = folderFromArgv(argv)
    if (folder && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send(CH.workspaceOpenFolder, { folderPath: folder })
      } catch (error) {
        diagnostics.log('renderer-send-failed', { channel: CH.workspaceOpenFolder, error: String(error) })
      }
    }
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('app.plano.desktop')
    app.on('browser-window-created', (_e, window) => optimizer.watchWindowShortcuts(window))

    mainWindow = createMainWindow((event, details) => diagnostics.log(event, details))

    // Wire services. `post` streams main → renderer events to the live window.
    let sendFailureLogged = false
    const post = (channel: string, payload: unknown): void => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
      try {
        mainWindow.webContents.send(channel, payload)
      } catch (error) {
        if (sendFailureLogged) return
        sendFailureLogged = true
        diagnostics.log('renderer-send-failed', { channel, error: String(error) })
      }
    }

    // One shared process-tree snapshot powers both agent detection AND session resolution.
    const processTree = new ProcessTreeService()
    // Pay the PowerShell worker's cold start HERE, at app startup, rather than at the first
    // AgentDetectionService.register(). register() fires when a terminal is created, which in
    // practice is the same second the user types `claude` — so the ~1.5s (up to ~5s on a busy
    // machine) runtime start-up landed exactly on the keystrokes that follow, and typing felt
    // stuck for a few seconds while the agent had already drawn its UI. Warming at boot moves
    // that cost into the window where nothing is waiting on it.
    processTree.warm()
    const detection = new AgentDetectionService(processTree)
    const agentSession = new AgentSessionService(detection, processTree)
    const terminalHistory = new TerminalHistoryService()
    const devUrls = new DevUrlService()
    const fileSystem = new FileSystemService()
    settingsService = new SettingsService()
    const workspaceState = new WorkspaceStateService()
    // The mobile web app is served by the Agent Host. Dev: <repo>/web-dist; packaged: resources/web.
    const webRoot = app.isPackaged
      ? join(process.resourcesPath, 'web')
      : join(app.getAppPath(), 'web-dist')
    const pty = new PtyManager(
      { post, detection, history: terminalHistory, devUrls, agentSession },
      app.getPath('userData'),
      (event, details) => diagnostics.log(event, details),
      webRoot,
    )
    // The host asks the app for data the MOBILE view needs (workspaces, folder→space resolution).
    pty.onHostRequest((method, params) => {
      if (method === 'getWorkspaces') {
        return workspaceState
          .get()
          .then(({ state }) =>
            (state?.workspaces ?? []).map((w) => ({
              id: w.id,
              name: w.name,
              folderPath: w.folderPath,
              terminalCount: w.panels.filter((p) => p.type === 'terminal').length,
              agentCount: 0,
              terminals: w.panels
                .filter((p) => p.type === 'terminal')
                .map((p) => {
                  const tab = (p.props as { tabs?: Array<{ id?: string; title?: string; cwd?: string }> } | undefined)?.tabs?.[0]
                  return {
                    panelId: p.id,
                    terminalId: tab?.id ?? '',
                    title: tab?.title ?? p.title ?? 'Terminal',
                    cwd: tab?.cwd ?? '',
                  }
                }),
            })),
          )
          .catch(() => [])
      }
      if (method === 'resolveSpace') {
        const folder = typeof params.folderPath === 'string' ? params.folderPath : null
        return workspaceState
          .get()
          .then(({ state }) => {
            if (!folder) return ''
            const hit = (state?.workspaces ?? []).find(
              (w) => w.folderPath && w.folderPath.toLowerCase() === folder.toLowerCase(),
            )
            return hit?.id ?? ''
          })
          .catch(() => '')
      }
      // Mesh plan F4: redacted tail of a PTY, requested by the daemon on behalf of an agent.
      // The transcript is ALWAYS redacted (contextRedaction) before leaving the process.
      if (method === 'agentContext') {
        const ptyId = typeof params.ptyId === 'string' ? params.ptyId : ''
        return agentContext.transcript(ptyId).text
      }
      // Mesh plan F8: ask the renderer to show a one-click consent toast; resolve true only
      // when the user enables mesh writes for this workspace.
      if (method === 'meshConsent') {
        const spaceId = typeof params.spaceId === 'string' ? params.spaceId : ''
        // Settings decide. With `allowAgentWrites` on (the default) the mesh just works and the
        // toast never appears: writes are loopback-only, attributed to a token-identified agent,
        // and land visibly in a terminal the user can watch. The prompt only exists for someone
        // who deliberately turns the setting off.
        return Promise.resolve(settingsService?.get()).then((s) => {
          if (s?.agentMesh.allowAgentWrites !== false) return true
          return new Promise<boolean>((resolve) => {
            pendingMeshConsent = { spaceId, resolve }
            post(CH.meshConsentRequest, { spaceId })
            setTimeout(() => {
              if (pendingMeshConsent?.spaceId === spaceId) {
                pendingMeshConsent = null
                resolve(false)
              }
            }, 90_000)
          })
        })
      }
      // v4 B3: onFailure 'ask-user' — Fire / Cancel toast for one chained task.
      if (method === 'chainAskUser') {
        const chainId = typeof params.chainId === 'string' ? params.chainId : ''
        return new Promise<boolean>((resolve) => {
          pendingChainAsk = { chainId, resolve }
          post(CH.chainAskRequest, { chainId, from: params.from ?? '', to: params.to ?? '' })
          setTimeout(() => {
            if (pendingChainAsk?.chainId === chainId) {
              pendingChainAsk = null
              resolve(false)
            }
          }, 90_000)
        })
      }
      return null
    })
    // A terminal/agent created from the phone while the app is running → materialize its panel.
    pty.onExternalTerminal((session) => {
      // Wire it in main FIRST so its output streams to the renderer + sniffers.
      pty.registerExternalSession(session as never)
      post(CH.terminalExternalCreated, session)
    })
    // Plan F7: mesh timeline events (agent-up/down, msg-*, spawn) → the renderer's link layer
    // and the AgentManager audit trail.
    pty.onMeshEvent((event) => {
      post(CH.meshEvent, event)
    })
    // Best-effort Windows Firewall rule so the phone can reach the Agent Host on ANY PC — runs
    // ONCE (checks first) and elevates via UAC the first time. If it fails, the user adds it
    // manually; local use on this machine is unaffected.
    ensureFirewallRuleForPlano()
    // The canonical agent/runtime context lives in main (see AgentContextService). It is
    // created AFTER PtyManager so it can hold a reference for runtime metadata lookups,
    // then wired INTO PtyManager's output pipeline below.
    const agentContext = new AgentContextService(pty, detection)
    pty.attachContext(agentContext)
    // Any mesh context change in main (runtime/verdict/prompt/url/exit) nudges the renderer's
    // Agent Control Center to refresh — debounced lightly since PTY output is high-frequency.
    let meshNotifyTimer: ReturnType<typeof setTimeout> | undefined
    agentContext.on('changed', () => {
      if (meshNotifyTimer) return
      meshNotifyTimer = setTimeout(() => {
        meshNotifyTimer = undefined
        post(CH.agentMeshChanged, {})
      }, 120)
    })
    // Browser-panel guests must animate like a normal browser (no OS/RDP reduced-motion leak,
    // no background throttling) — see WebviewMotionService.
    const webviewMotion = new WebviewMotionService(
      async () => (await settingsService!.get()).appearance.reduceMotion,
    )
    webviewMotion.watch(mainWindow)
    services = {
      diagnostics,
      pty,
      workspace: new WorkspaceService(),
      workspaceState,
      fs: fileSystem,
      // Shares the FileSystemService's allowed-roots guard so we never watch outside the workspace.
      fileWatcher: new FileWatcherService(post, (dir) => fileSystem.isAllowed(dir)),
      git: new GitService(),
      time: new TimeTrackingService(),
      settings: settingsService,
      session: new SessionService(),
      voice: new VoiceService(),
      agentSession,
      webviewMotion,
      agentContext,
      worktree: new MeshWorktreeService(),
      update: new UpdateService(diagnostics, post),
    }
    registerIpc(services, {
      takeLaunchFolder: () => {
        const f = launchFolder
        launchFolder = null // one-shot: a renderer reload must not reopen it
        return f
      },
    })
    // Auto-update from GitHub releases: first check shortly after launch, then every 4h.
    services.update.start()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow((event, details) => diagnostics.log(event, details))
        webviewMotion.watch(mainWindow)
      }
    })
  })

  app.on('window-all-closed', () => {
    diagnostics.log('window-all-closed')
    if (process.platform !== 'darwin') app.quit()
  })

  // `before-quit` fires BEFORE BrowserWindow closes, so disposing PTYs there races the renderer's
  // beforeunload session reconciliation/final save. `will-quit` runs after windows have closed.
function ensureFirewallRuleForPlano(): void {
  if (process.platform !== 'win32') return
  const exe = app.isPackaged ? process.execPath : join(app.getAppPath(), 'node_modules', 'electron', 'dist', 'electron.exe')
  const check = `netsh advfirewall firewall show rule name="PLANO Mobile" >nul 2>&1`
  execFile('cmd', ['/c', check], { windowsHide: true }, (err) => {
    if (!err) return // rule already exists
    // Elevate once (UAC prompt) to add the rule for this program.
    const rule = `netsh advfirewall firewall add rule name="PLANO Mobile" dir=in action=allow protocol=TCP program="${exe.replace(/"/g, '\\"')}"`
    execFile(
      'powershell',
      ['-NoProfile', '-Command', `Start-Process cmd -ArgumentList '/c', '${rule.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden`],
      { windowsHide: true },
      () => undefined,
    )
  })
}

  app.on('will-quit', () => {
    diagnostics.log('app-will-quit')
    // The herdr-style default: keep every terminal (and the agents inside it) running in the
    // detached Agent Host when the app quits, so reopening lands exactly where you left it. When
    // the setting is off, shut the host down (which kills all sessions — the old behaviour).
    const keepAgents = settingsService?.getSync().terminal.keepAgentsOnQuit ?? true
    diagnostics.log('app-quit-agents', { keepAgents })
    services?.pty.shutdown(keepAgents)
    services?.agentContext.dispose()
    services?.fileWatcher.disposeAll()
    void services?.time.flush()
    services?.update.dispose()
  })
}
