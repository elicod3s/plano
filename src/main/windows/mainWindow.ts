/**
 * Main window factory + renderer security hardening.
 *
 * The window is frameless (PLANO draws its own top bar) with a hardened renderer:
 * contextIsolation + sandbox, no node integration. `webviewTag` is enabled ONLY here so
 * browser panels can embed live pages, and every attached webview is stripped of
 * privilege via the will-attach-webview guard.
 */

import { BrowserWindow, shell, session } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'

const BROWSER_PARTITION = 'persist:plano-browser'

// Window/taskbar icon. In dev this PNG drives the taskbar; once packaged, Windows uses the
// .exe's embedded icon (from build/icon.ico) so this is a harmless no-op there.
const ICON_PATH = join(__dirname, '../../build/icon.png')
type DiagnosticSink = (event: string, details?: unknown) => void


export function createMainWindow(
  onDiagnostic: DiagnosticSink = () => undefined,
): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0E0E0D',
    ...(existsSync(ICON_PATH) ? { icon: ICON_PATH } : {}),
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  /**
   * PLANO has its own canvas zoom, so Chromium's PAGE zoom is never wanted here — and it has no way
   * back once it happens. An accidental Ctrl+wheel (or Ctrl+minus) shrank the entire UI, chrome and
   * all, and nothing in the app could undo it: there is no menu, so there is no Ctrl+0 either. The
   * level is also persisted per origin, so it survived restarts.
   *
   * Pinned rather than intercepted at the keyboard: the terminals bind Ctrl +/− themselves for
   * per-terminal font zoom, and swallowing those keys in main would break a feature to fix a bug.
   * Forcing the factor back covers every route in (wheel, pinch, shortcut) and leaves the keys
   * alone. Applied on each load as well, which repairs a window that is ALREADY stuck.
   */
  const pinZoom = (): void => {
    try {
      // setZoomLevel(0) is the canonical reset and CLEARS the level Chromium persisted for this
      // origin; setZoomFactor(1) alone would be overridden by that stored value on the next load.
      // Both are set so a window that is already stuck comes back on launch, without the user
      // needing a shortcut that does not exist here (there is no menu, so there is no Ctrl+0).
      win.webContents.setZoomLevel(0)
      win.webContents.setZoomFactor(1)
      win.webContents.setVisualZoomLevelLimits(1, 1)
    } catch {
      /* webContents gone mid-teardown */
    }
  }
  win.webContents.on('dom-ready', pinZoom)
  win.webContents.on('did-finish-load', pinZoom)
  win.webContents.on('zoom-changed', () => {
    pinZoom()
    onDiagnostic('page-zoom-blocked')
  })
  pinZoom()

  // Persist production failures as well as dev-console diagnostics. Electron exposes precise reasons
  // such as oom, crashed, killed, launch-failed and integrity-failure here.
  /**
   * A dead renderer used to take the whole app with it, silently.
   *
   * This handler only LOGGED, so the window then closed, `window-all-closed` fired, and the app
   * quit with no error and no dialog — PLANO "closed by itself", usually with many agents open
   * (20 `render-process-gone · crashed` entries in one user's log). The detached agent host kept
   * every PTY alive, which is why the agents survived while the window vanished.
   *
   * Reloading is safe precisely because of that split: terminals live in the daemon, and the
   * renderer reattaches to them on load and replays their buffers. So a crash becomes a flicker
   * instead of losing the session.
   *
   * Bounded on purpose: a renderer that dies three times inside a minute is failing at something
   * reload cannot fix, and an infinite reload loop is worse than stopping. After that it stays
   * down, and the log says why.
   */
  let crashTimes: number[] = []
  win.webContents.on('render-process-gone', (_event, details) => {
    onDiagnostic('render-process-gone', details)
    const now = Date.now()
    crashTimes = crashTimes.filter((t) => now - t < 60_000)
    crashTimes.push(now)
    if (crashTimes.length > 3) {
      onDiagnostic('render-process-gone-giving-up', { crashesInLastMinute: crashTimes.length })
      return
    }
    if (win.isDestroyed()) return
    onDiagnostic('render-process-reloading', { attempt: crashTimes.length })
    try {
      win.webContents.reload()
    } catch (err) {
      onDiagnostic('render-process-reload-failed', { error: String(err) })
    }
  })
  win.webContents.on('preload-error', (_event, preloadPath, error) =>
    onDiagnostic('preload-error', { preloadPath, error: String(error), stack: error.stack }),
  )
  win.on('unresponsive', () => onDiagnostic('window-unresponsive'))
  win.on('responsive', () => onDiagnostic('window-responsive'))
  win.on('close', () => onDiagnostic('window-close'))
  win.on('closed', () => onDiagnostic('window-closed'))

  // Dev diagnostics: surface renderer console + crashes in the dev terminal. Every log is wrapped
  // so a broken pipe (the renderer crashed / the dev terminal closed mid-teardown) can NEVER kill
  // the main process — an uncaught EPIPE from console.log did exactly that.
  const safeLog = (...args: unknown[]): void => {
    try {
      console.log(...args)
    } catch {
      /* pipe is gone — the renderer died before us; never throw */
    }
  }
  if (is.dev) {
    win.webContents.on('console-message', (...args: unknown[]) => {
      // Electron <=34: (event, level, message, line, sourceId). Electron >=35: (event{message,level}).
      const second = args[1] as { message?: string; level?: number } | number
      if (second && typeof second === 'object' && 'message' in second) {
        safeLog('[renderer]', second.message)
      } else {
        safeLog('[renderer]', args[2])
      }
    })
    win.webContents.on('render-process-gone', (_e, details) =>
      safeLog('[render-process-gone]', JSON.stringify(details)),
    )
    win.webContents.on('did-fail-load', (_e, code, desc, url) =>
      safeLog('[did-fail-load]', code, desc, url),
    )
    win.webContents.on('did-finish-load', () => safeLog('[renderer] loaded', win.webContents.getURL()))
    // DevTools available on demand (Ctrl+Shift+I / F12) rather than auto-opening.
  }

  // App frame can never be navigated away; external links open in the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    const isDev = devUrl && url.startsWith(devUrl)
    if (!isDev && !url.startsWith('file://')) event.preventDefault()
  })

  grantAppMediaPermission(win)
  hardenWebviews(win)

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    // electron-vite can launch Electron a beat before the Vite dev server is accepting connections, so
    // the first loadURL fails (ERR_CONNECTION_RESET/REFUSED/TIMED_OUT) and the window is left on a blank
    // error page. Retry the dev-server load (main frame only, ignoring ERR_ABORTED from a superseded
    // load) until Vite answers — capped so a genuinely wrong URL can't loop forever.
    let devLoadTries = 0
    const loadDev = (): void => {
      win.loadURL(devUrl).catch(() => {})
    }
    win.webContents.on('did-fail-load', (_e, code, _desc, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3 || win.isDestroyed() || !failedUrl?.startsWith(devUrl)) return
      if (devLoadTries++ >= 40) return
      setTimeout(() => {
        if (!win.isDestroyed()) loadDev()
      }, 350)
    })
    loadDev()
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

/**
 * Allow the microphone for the app's OWN renderer (the Odla voice assistant uses getUserMedia).
 * This is the default session, which only ever hosts PLANO's trusted, sandboxed, local content —
 * never remote pages (browser panels run in the separate, locked-down BROWSER_PARTITION). Media is
 * granted explicitly so the mic works on every machine regardless of Electron's version default;
 * other permissions on this session keep Electron's standard behavior.
 */
function grantAppMediaPermission(win: BrowserWindow): void {
  const ses = win.webContents.session
  // The app shell is fully trusted (sandboxed, local-only); allowing its permission requests
  // matches Electron's permissive default while GUARANTEEING the microphone (media) is granted for
  // Odla. Remote/web content never runs here — it lives in the locked-down BROWSER_PARTITION.
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(true))
  ses.setPermissionCheckHandler(() => true)
}

/**
 * Strip privilege from every <webview> a browser panel attaches, and isolate embedded
 * web content in its own session partition with permissions denied by default.
 */
function hardenWebviews(win: BrowserWindow): void {
  win.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    params.partition = BROWSER_PARTITION
  })

  // Links that try to open a new window (target="_blank", window.open) would otherwise either
  // spawn a detached popup or silently no-op. Keep navigation INSIDE the browser panel: deny the
  // popup and load the URL in the same guest instead (http/https only; other schemes are dropped).
  win.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      // Defer the in-place navigation so we don't re-enter while the popup request is being
      // resolved; deny the popup itself either way.
      if (/^https?:\/\//i.test(url)) setImmediate(() => guest.loadURL(url).catch(() => {}))
      return { action: 'deny' }
    })
  })

  const part = session.fromPartition(BROWSER_PARTITION)
  // Browser panels may read/write the clipboard (page "copy" buttons, paste fields) so
  // copy/paste flows between panels; everything else (camera, mic, geolocation,
  // notifications…) stays denied by default.
  const CLIPBOARD = new Set(['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'])
  part.setPermissionRequestHandler((_wc, permission, callback) => callback(CLIPBOARD.has(permission)))
  part.setPermissionCheckHandler((_wc, permission) => CLIPBOARD.has(permission))
}
