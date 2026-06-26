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

export function createMainWindow(): BrowserWindow {
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

  // Dev diagnostics: surface renderer console + crashes in the dev terminal.
  if (is.dev) {
    win.webContents.on('console-message', (...args: unknown[]) => {
      // Electron <=34: (event, level, message, line, sourceId). Electron >=35: (event{message,level}).
      const second = args[1] as { message?: string; level?: number } | number
      if (second && typeof second === 'object' && 'message' in second) {
        console.log('[renderer]', second.message)
      } else {
        console.log('[renderer]', args[2])
      }
    })
    win.webContents.on('render-process-gone', (_e, details) =>
      console.log('[render-process-gone]', JSON.stringify(details)),
    )
    win.webContents.on('did-fail-load', (_e, code, desc, url) =>
      console.log('[did-fail-load]', code, desc, url),
    )
    win.webContents.on('did-finish-load', () => console.log('[renderer] loaded', win.webContents.getURL()))
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
