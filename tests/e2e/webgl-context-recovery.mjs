/**
 * WebGL context loss on spawn — the "characters go unreadable until I resize" bug.
 *
 * Chromium caps WebGL contexts per renderer process and evicts the OLDEST to make room. Opening a
 * batch of terminals (what `plano spawn … --count 3` does) therefore kills the context of a
 * terminal that was already on screen. xterm then falls back to its DOM renderer, which draws rows
 * as positioned spans — and this canvas SCALES its panels, so transformed spans shear and overlap.
 * That is the unreadable text; a resize only appears to fix it because it forces a fresh layout.
 *
 * The observable signature, with no guessing: a WebGL-rendered terminal owns a <canvas> inside
 * .xterm-screen. A DOM-rendered one owns .xterm-rows full of <span>. This probe counts both,
 * before and after a spawn burst, so "did it fall back" is a number.
 *
 * Usage: node tests/e2e/webgl-context-recovery.mjs [port] [terminals]
 */
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import WebSocket from 'ws'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.argv[2] || 9600)
const SEEDED = Number(process.argv[3] || 10)
const REPO = 'D:/Tools/Plano'
const EXE = join(REPO, 'node_modules/electron/dist/electron.exe')
const UD = join(tmpdir(), `plano-webgl-ud-${PORT}`)
const PROJECT = join(tmpdir(), `plano-webgl-prj-${PORT}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (p) =>
  new Promise((res, rej) => {
    http
      .get(`http://127.0.0.1:${PORT}${p}`, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => {
          try {
            res(JSON.parse(d))
          } catch (e) {
            rej(e)
          }
        })
      })
      .on('error', rej)
  })

async function main() {
  rmSync(UD, { recursive: true, force: true })
  mkdirSync(UD, { recursive: true })
  mkdirSync(PROJECT, { recursive: true })

  // A grid of terminals, all visible, at a fractional canvas zoom (the shape the bug shows up in).
  const panels = Array.from({ length: SEEDED }, (_, i) => ({
    id: `t${i}`,
    type: 'terminal',
    rect: { x: 60 + (i % 4) * 520, y: 60 + Math.floor(i / 4) * 380, width: 480, height: 340 },
    z: 1,
    title: `T${i}`,
    props: { tabs: [{ id: `t${i}-tab` }], activeTabId: `t${i}-tab`, folderPath: PROJECT },
  }))
  writeFileSync(
    join(UD, 'workspaces.json'),
    JSON.stringify({
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      activeId: 'sp1',
      workspaces: [{ id: 'sp1', name: 'W', folderPath: PROJECT, viewport: { x: 0, y: 0, zoom: 0.6 }, regions: [], panels }],
    }),
  )
  writeFileSync(join(UD, 'session.json'), JSON.stringify({ folderPath: PROJECT }))
  writeFileSync(
    join(UD, 'settings.json'),
    JSON.stringify({
      version: 9,
      general: { restoreLastWorkspace: true, restoreAgentSessions: false, showFilesOnLaunch: false, warnBeforeQuit: false, confirmClosePanelWithProcess: false, agentDoneSound: false },
      appearance: { theme: 'monolith', accent: '#FFFFFF', gridStyle: 'dots', gridOpacity: 1, grain: false, reduceMotion: true },
      editor: {},
      terminal: { shell: 'cmd', shellPath: '', fontFamily: '', fontSize: 13, lineHeight: 1.4, cursorStyle: 'bar', cursorBlink: false, scrollback: 1000, theme: 'campbell', copyOnSelect: false, autoSuspendIdle: false, keepAgentsOnQuit: false },
      canvas: { snapToGrid: true, showMinimap: false, zoomSensitivity: 1, autosave: false },
      browser: {},
      privacy: { telemetry: false, saveTerminalHistory: false },
      advanced: { hardwareAcceleration: true },
      agentMesh: { enabled: false },
      voice: { enabled: false },
    }),
  )

  const app = spawn(EXE, ['.', `--remote-debugging-port=${PORT}`, '--disable-background-timer-throttling'], {
    cwd: REPO,
    env: { ...process.env, PLANO_USER_DATA_DIR: UD },
    stdio: 'ignore',
    windowsHide: false,
  })
  app.unref()
  const kill = () => {
    try {
      spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
    } catch {}
  }

  let page
  for (let i = 0; i < 120 && !page; i += 1) {
    try {
      const t = await getJson('/json')
      page = t.find((x) => x.type === 'page' && x.url.includes('index.html'))
    } catch {}
    if (!page) await sleep(500)
  }
  if (!page) throw new Error('no CDP page')
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
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
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    return r.result?.result?.value
  }

  await send('Page.bringToFront')

  /** WebGL terminals own a <canvas>; DOM-renderer terminals own .xterm-rows with spans. */
  const census = `(() => {
    const terms = [...document.querySelectorAll('.xterm')]
    let webgl = 0, dom = 0
    for (const t of terms) {
      const screen = t.querySelector('.xterm-screen')
      const hasCanvas = !!(screen && screen.querySelector('canvas'))
      const rows = t.querySelector('.xterm-rows')
      const hasSpans = !!(rows && rows.querySelector('span'))
      if (hasCanvas) webgl++
      else if (hasSpans) dom++
    }
    return JSON.stringify({ terminals: terms.length, webgl, dom })
  })()`

  for (let i = 0; i < 60; i += 1) {
    const c = JSON.parse((await ev(census)) || '{}')
    if ((c.terminals ?? 0) >= SEEDED && (c.webgl ?? 0) + (c.dom ?? 0) >= SEEDED) break
    await sleep(1000)
  }
  await sleep(3000)
  const before = JSON.parse((await ev(census)) || '{}')

  // The spawn burst: three more terminals at once, exactly what `plano spawn --count 3` does.
  await ev(`(() => {
    for (let i = 0; i < 3; i += 1) window.plano.panels?.add?.('terminal')
    return true
  })()`)
  // Fall back to the app's own action if the bridge shape differs.
  await ev(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||b.title) === 'New Terminal')
    if (btn) { btn.click(); btn.click(); btn.click() }
    return !!btn
  })()`)
  // Sample the FIRST terminal's grid while the burst lands: a transient cols/rows change is the
  // other candidate cause — a SIGWINCH mid-frame makes a TUI interleave its old and new frame,
  // which is exactly "the bottom of the panel goes unreadable until I resize".
  const grid = `(() => {
    const t = document.querySelector('.xterm')
    const rows = t && t.querySelector('.xterm-rows')
    const r = t && t.getBoundingClientRect()
    return JSON.stringify({ rows: rows ? rows.children.length : null, w: r ? Math.round(r.width) : null, h: r ? Math.round(r.height) : null })
  })()`
  const samples = []
  for (let i = 0; i < 60; i += 1) {
    samples.push(JSON.parse((await ev(grid)) || '{}'))
    await sleep(100)
  }
  const uniq = [...new Set(samples.map((s) => JSON.stringify(s)))]
  console.log('GRID SAMPLES (unique):', JSON.stringify(uniq))
  const after = JSON.parse((await ev(census)) || '{}')
  // The recovery is on a rAF; give it room, then look again.
  await sleep(4000)
  const settled = JSON.parse((await ev(census)) || '{}')

  console.log('BEFORE :', JSON.stringify(before))
  console.log('AFTER  :', JSON.stringify(after))
  console.log('SETTLED:', JSON.stringify(settled))
  console.log(
    'RESULT:',
    JSON.stringify({
      ok: (settled.dom ?? 99) === 0,
      domFallbacks: settled.dom ?? null,
      recovered: (after.dom ?? 0) > 0 && (settled.dom ?? 0) === 0,
      terminals: settled.terminals ?? null,
    }),
  )
  ws.close()
  kill()
  process.exit(0)
}

main().catch((e) => {
  console.error('ERROR:', e && e.stack ? e.stack : String(e))
  process.exit(1)
})
