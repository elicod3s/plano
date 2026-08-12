/**
 * Auto-update via GitHub Releases (electron-updater).
 *
 * Flow: on launch (after a short grace period) and then every 4h, the service checks the public
 * `zqkra/plano-releases` repo (baked into `resources/app-update.yml` at pack time). A newer
 * version is downloaded in the background; the renderer shows progress and, once downloaded,
 * offers "Restart to update" (electron-updater also installs automatically on normal quit).
 *
 * Only active when packaged — in dev there is no app-update.yml and no update feed. Every state
 * change is pushed to the renderer over `update:status` and readable via `update:getState`.
 */

import { app } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { UpdateState } from '@shared/ipc/contracts'
import { CH } from '@shared/ipc/channels'
import type { DiagnosticsService } from './DiagnosticsService'

/** Wait this long after launch before the first check (don't compete with app boot). */
const INITIAL_CHECK_DELAY_MS = 15_000
/** Poll cadence while the app is running. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

export class UpdateService {
  private readonly diagnostics: DiagnosticsService
  private readonly post: (channel: string, payload: unknown) => void
  private state: UpdateState
  private timer: NodeJS.Timeout | null = null
  private inFlight = false
  private disposed = false

  constructor(
    diagnostics: DiagnosticsService,
    post: (channel: string, payload: unknown) => void,
  ) {
    this.diagnostics = diagnostics
    this.post = post
    this.state = {
      phase: 'idle',
      canCheck: app.isPackaged,
    }
  }

  getState(): UpdateState {
    return this.state
  }

  /** Wire updater events + schedule the launch check and the periodic poll. */
  start(): void {
    if (!app.isPackaged) {
      this.diagnostics.log('update-disabled', { reason: 'dev-run' })
      return
    }
    try {
      autoUpdater.autoDownload = true
      autoUpdater.autoInstallOnAppQuit = true
      this.wireEvents()
      this.timer = setTimeout(() => {
        void this.checkNow().catch(() => undefined)
        this.timer = setInterval(() => {
          void this.checkNow().catch(() => undefined)
        }, CHECK_INTERVAL_MS)
      }, INITIAL_CHECK_DELAY_MS)
      this.diagnostics.log('update-ready', { version: app.getVersion() })
    } catch (error) {
      this.diagnostics.log('update-init-error', { error: String(error) })
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Force a check (manual button, or the scheduled tick). Safe to call concurrently. */
  async checkNow(): Promise<UpdateState> {
    if (!app.isPackaged) {
      return this.set({ phase: 'error', message: 'Updates are only available in installed builds.' })
    }
    if (this.inFlight) return this.state
    this.inFlight = true
    this.set({ phase: 'checking' })
    try {
      const result = await autoUpdater.checkForUpdates()
      // checkForUpdates resolves BEFORE the download finishes — the download events take over
      // from here (autoDownload = true). Record the check timestamp for getState.
      this.state = { ...this.state, checkedAt: Date.now() }
      if (!result) this.set({ phase: 'up-to-date', checkedAt: Date.now() })
      return this.state
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.diagnostics.log('update-check-error', { error: message })
      return this.set({ phase: 'error', message, checkedAt: Date.now() })
    } finally {
      this.inFlight = false
    }
  }

  /** Quit and run the downloaded installer. No-op unless an update is ready. */
  installNow(): { ok: boolean } {
    if (this.state.phase !== 'downloaded') return { ok: false }
    try {
      this.diagnostics.log('update-install', { version: this.state.version ?? '' })
      autoUpdater.quitAndInstall()
      // quitAndInstall spawns the installer and then quits the app. If the renderer close ever
      // stalls (busy beforeunload, a hung panel), the installer would wait on our process forever
      // and the update would wedge. Force-exit as a failsafe — the Agent Host is detached, so
      // terminals survive this just like a normal quit.
      setTimeout(() => app.exit(0), 15_000)
      return { ok: true }
    } catch (error) {
      this.diagnostics.log('update-install-error', { error: String(error) })
      return { ok: false }
    }
  }

  private wireEvents(): void {
    autoUpdater.on('checking-for-update', () => {
      this.set({ phase: 'checking' })
    })
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.diagnostics.log('update-available', { version: info.version })
      // autoDownload kicks in right after this event — surface the target version + start progress.
      this.set({ phase: 'downloading', version: info.version, percent: 0 })
    })
    autoUpdater.on('update-not-available', () => {
      this.set({ phase: 'up-to-date', checkedAt: Date.now() })
    })
    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.set({
        phase: 'downloading',
        percent: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      })
    })
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.diagnostics.log('update-downloaded', { version: info.version })
      this.set({ phase: 'downloaded', version: info.version, checkedAt: Date.now() })
    })
    autoUpdater.on('error', (error: Error) => {
      this.diagnostics.log('update-error', { error: String(error) })
      this.set({ phase: 'error', message: error.message ?? String(error), checkedAt: Date.now() })
    })
  }

  private set(patch: Partial<UpdateState>): UpdateState {
    if (this.disposed) return this.state
    this.state = { ...this.state, ...patch }
    this.post(CH.updateStatus, this.state)
    return this.state
  }
}
