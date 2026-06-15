/**
 * Main window factory + renderer security hardening.
 *
 * The window is frameless (PLANO draws its own top bar) with a hardened renderer:
 * contextIsolation + sandbox, no node integration. `webviewTag` is enabled ONLY here so
 * browser panels can embed live pages, and every attached webview is stripped of
 * privilege via the will-attach-webview guard.
 */

import { BrowserWindow, shell, session } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'

const BROWSER_PARTITION = 'persist:plano-browser'

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

  hardenWebviews(win)

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
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

  const part = session.fromPartition(BROWSER_PARTITION)
  part.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
}
