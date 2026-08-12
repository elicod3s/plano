// Measure the Files panel against a REAL large folder (the PLANO repo itself, read-only):
// tree mount time, opening a file, frame cost while the tree renders, and row counts.
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import WebSocket from 'ws'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXE = 'D:/Tools/Plano/node_modules/electron/dist/electron.exe'
const FOLDER = 'D:/Tools/Plano'
const OPEN_FILE = join(FOLDER, 'README.md')
const port = 9940
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (p, port) =>
  new Promise((res, rej) => {
    http
      .get('http://127.0.0.1:' + port + p, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
  })

async function main() {
  const RUN = Date.now() + Math.random().toString(36).slice(2)
  const UD = join(tmpdir(), 'filesreal-' + RUN)
  rmSync(UD, { recursive: true, force: true })
  mkdirSync(UD, { recursive: true })
  writeFileSync(
    join(UD, 'workspaces.json'),
    JSON.stringify({
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      activeId: 's1',
      workspaces: [
        {
          id: 's1',
          name: 'F',
          folderPath: FOLDER,
          viewport: { x: 0, y: 0, zoom: 1 },
          regions: [],
          panels: [{ id: 'e1', type: 'editor', rect: { x: 60, y: 60, width: 900, height: 560 }, z: 1, title: 'Files', props: { folderPath: FOLDER, filePath: undefined, sidebarOpen: true } }],
        },
      ],
    }),
  )
  writeFileSync(join(UD, 'session.json'), JSON.stringify({ folderPath: FOLDER }))
  writeFileSync(
    join(UD, 'settings.json'),
    JSON.stringify({
      version: 9,
      general: { restoreLastWorkspace: true, restoreAgentSessions: false, showFilesOnLaunch: false, warnBeforeQuit: false, confirmClosePanelWithProcess: false, agentDoneSound: false },
      appearance: { theme: 'monolith', accent: '#FFFFFF', gridStyle: 'dots', gridOpacity: 1, grain: false, reduceMotion: false },
      editor: { fontSize: 13, tabSize: 2, wordWrap: true, lineNumbers: true },
      terminal: { shell: 'cmd', shellPath: '', fontFamily: '', fontSize: 0, lineHeight: 1.4, cursorStyle: 'bar', cursorBlink: false, scrollback: 5000, theme: 'campbell', copyOnSelect: false, predictiveHistory: false, smartActions: false, autoSuspendIdle: true, keepAgentsOnQuit: true },
      canvas: { snapToGrid: true, showMinimap: false, zoomSensitivity: 1, autosave: true },
      browser: {},
      privacy: { telemetry: false, saveTerminalHistory: true },
      advanced: { hardwareAcceleration: true },
      agentMesh: {},
      voice: {},
    }),
  )
  const app = spawn(EXE, ['.', '--remote-debugging-port=' + port], {
    env: { ...process.env, PLANO_USER_DATA_DIR: UD },
    stdio: 'ignore',
    windowsHide: true,
  })
  app.unref()
  let page
  for (let i = 0; i < 120 && !page; i += 1) {
    try {
      const t = await getJson('/json', port)
      page = t.find((x) => x.type === 'page' && x.url.includes('index.html'))
    } catch {}
    await sleep(500)
  }
  if (!page) {
    console.log('NO PAGE')
    process.exit(1)
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.once('open', res)
    ws.once('error', rej)
  })
  let id = 0
  const pend = new Map()
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString())
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m)
      pend.delete(m.id)
    }
  })
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id
      pend.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (e) =>
    (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value
  await send('Page.bringToFront', {}).catch(() => {})
  const t0 = Date.now()
  // Wait for the file tree to render rows.
  let treeMs = null
  let rows = null
  for (let i = 0; i < 120; i += 1) {
    rows = await ev(`(() => {
      const panel = document.querySelector('[data-panel-type="editor"]')
      if (!panel) return null
      // count tree rows: elements with a row-ish class inside the tree region
      const rows = panel.querySelectorAll('[class*="h-7"]').length
      return rows > 0 ? rows : null
    })()`).catch(() => null)
    if (rows != null && rows > 0) {
      treeMs = Date.now() - t0
      break
    }
    await sleep(250)
  }
  console.log('RESULT:', JSON.stringify(result))
  await ev('window.plano.window.close()').catch(() => {})
  await sleep(800)
  try {
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}
  process.exit(0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
