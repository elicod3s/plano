/**
 * Launch screenshots for the README, taken from the real app with real Pi agents.
 *
 * Seeds one deliberately composed workspace over the demo project, boots Pi in the agent panels,
 * waits until detection has actually morphed them into agent mode, then captures:
 *   · hero-canvas.png — the whole canvas, zoom-to-fit (equal air on every side)
 *   · canvas.png      — the same canvas one step further out, so the spatial idea reads
 *   · agent-mode.png  — a clip around ONE agent panel, for the "terminal becomes an agent" section
 *
 * The orchestration-tree and mesh shots are deliberately NOT here: they need a live conversation
 * between agents, which is worth filming by hand rather than staging.
 *
 * Isolated userData, so the installed PLANO and its detached agents are never touched.
 *
 * Usage: node tests/e2e/demo-shots.mjs [port]
 */
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import WebSocket from 'ws'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.argv[2] || 9800)
const REPO = 'D:/Tools/Plano'
const EXE = join(REPO, 'node_modules/electron/dist/electron.exe')
const DEMO = 'C:/Users/Administrator/Desktop/plano-demo'
const OUT = join(DEMO, 'imgs')
const UD = join(tmpdir(), `plano-demoshots-${PORT}`)

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

// ── composition ─────────────────────────────────────────────────────────────────────────────────
// Authored, not dragged: a screenshot needs a deliberate arrangement and these numbers are it.
// Two agent terminals lead (they are the product), the editor anchors the right, and the reference
// panels sit below so the eye travels left→right, top→bottom without anything overlapping.
const GAP = 56
const term = (id, x, y, w, h, title) => ({
  id,
  type: 'terminal',
  rect: { x, y, width: w, height: h },
  z: 2,
  title,
  props: { tabs: [{ id: `${id}-t`, bootCommand: 'pi' }], activeTabId: `${id}-t`, folderPath: DEMO },
})

const panels = [
  term('a1', 0, 0, 860, 560, 'Agent'),
  term('a2', 860 + GAP, 0, 860, 560, 'Agent'),
  {
    id: 'files',
    type: 'editor',
    rect: { x: 2 * (860 + GAP), y: 0, width: 900, height: 560 },
    z: 1,
    title: 'Files',
    props: { folderPath: DEMO, filePath: join(DEMO, 'src/tasks.js').replace(/\\/g, '/'), sidebarOpen: true },
  },
  {
    id: 'doc',
    type: 'markdown',
    rect: { x: 0, y: 560 + GAP, width: 700, height: 460 },
    z: 1,
    title: 'NOTES.md',
    // Inline content, not filePath: the panel rendered an empty document from the path, and a blank
    // panel in a launch shot is worse than no panel.
    props: {
      content:
        '# Notes\n\n' +
        'One spatial screen per project.\n\n' +
        '- Panels keep their place — reopen and the layout is exactly as you left it\n' +
        '- Terminals detect the AI CLI running inside them and morph into agent mode\n' +
        '- Agents reach each other through the `plano` CLI\n',
    },
  },
  {
    id: 'web',
    type: 'browser',
    rect: { x: 700 + GAP, y: 560 + GAP, width: 1016, height: 460 },
    z: 1,
    title: 'Preview',
    props: { url: `file:///${join(DEMO, 'demo/demo-page.html').replace(/\\/g, '/')}` },
  },
  {
    id: 'note',
    type: 'sticky',
    rect: { x: 2 * (860 + GAP), y: 560 + GAP, width: 420, height: 240 },
    z: 1,
    title: '',
    props: { text: 'One canvas per project.\nPan, zoom, and it stays\nexactly where you left it.', tone: 'amber' },
  },
]

async function main() {
  if (!existsSync(DEMO)) throw new Error('demo folder missing: ' + DEMO)
  mkdirSync(OUT, { recursive: true })
  rmSync(UD, { recursive: true, force: true })
  mkdirSync(UD, { recursive: true })

  writeFileSync(
    join(UD, 'workspaces.json'),
    JSON.stringify({
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      activeId: 'demo',
      workspaces: [{ id: 'demo', name: 'plano-demo', folderPath: DEMO, viewport: { x: 0, y: 0, zoom: 1 }, regions: [], panels }],
    }),
  )
  writeFileSync(join(UD, 'session.json'), JSON.stringify({ folderPath: DEMO }))
  writeFileSync(
    join(UD, 'settings.json'),
    JSON.stringify({
      version: 9,
      general: { restoreLastWorkspace: true, restoreAgentSessions: false, showFilesOnLaunch: false, warnBeforeQuit: false, confirmClosePanelWithProcess: false, agentDoneSound: false, agentDoneNotify: false },
      appearance: { theme: 'monolith', accent: '#FFFFFF', gridStyle: 'dots', gridOpacity: 1, grain: false, reduceMotion: true },
      editor: {},
      terminal: { shell: 'auto', shellPath: '', fontFamily: '', fontSize: 13, lineHeight: 1.4, cursorStyle: 'bar', cursorBlink: false, scrollback: 2000, theme: 'monolith', copyOnSelect: false, autoSuspendIdle: false, keepAgentsOnQuit: false },
      canvas: { snapToGrid: true, showMinimap: false, zoomSensitivity: 1, autosave: false },
      browser: {},
      privacy: { telemetry: false, saveTerminalHistory: false },
      advanced: { hardwareAcceleration: true },
      agentMesh: { enabled: true },
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
  for (let i = 0; i < 180 && !page; i += 1) {
    try {
      const t = await getJson('/json')
      page = t.find((x) => x.type === 'page' && x.url.includes('index.html'))
    } catch {}
    if (!page) await sleep(500)
  }
  if (!page) throw new Error('no CDP page')
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 512 * 1024 * 1024 })
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
  // Full screen first, THEN emulate 2x over the real viewport size. Forcing a fixed viewport instead
  // would letterbox the shot; what makes these read as product shots is the app filling the display.
  const winInfo = await send('Browser.getWindowForTarget')
  const windowId = winInfo?.result?.windowId
  if (windowId) {
    await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } })
    await sleep(1800)
  }
  const vp = JSON.parse(
    (await ev(`JSON.stringify({ w: window.innerWidth, h: window.innerHeight })`)) || '{"w":1800,"h":1120}',
  )
  console.log('viewport en pantalla completa:', JSON.stringify(vp))
  await send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 2, mobile: false })
  await sleep(1200)

  // Wait for Pi to actually be DETECTED — an untinted panel is just a terminal, and the whole
  // point of these shots is agent mode.
  // Agent mode is marked by the --agent-accent custom property the frame sets once detection has a
  // verdict (PanelFrame), not by a data attribute — count panels that actually carry it.
  const detected = `(() => {
    const terms = [...document.querySelectorAll('[data-panel-type="terminal"]')]
    const tinted = terms.filter(el => (el.style.getPropertyValue('--agent-accent') || '').trim() !== '').length
    return JSON.stringify({ panels: terms.length, xterms: document.querySelectorAll('.xterm').length, tinted })
  })()`
  let state = {}
  for (let i = 0; i < 90; i += 1) {
    state = JSON.parse((await ev(detected)) || '{}')
    if ((state.tinted ?? 0) >= 2) break
    if (i % 10 === 0) console.log('  esperando a Pi…', JSON.stringify(state))
    await sleep(2000)
  }
  console.log('detección:', JSON.stringify(state))
  await sleep(6000) // let Pi finish drawing its frame

  const shoot = async (name, clip) => {
    const params = { format: 'png', captureBeyondViewport: false }
    if (clip) params.clip = { ...clip, scale: 1 }
    const r = await send('Page.captureScreenshot', params)
    const b64 = r.result?.data
    if (!b64) {
      console.log('  ✗ sin captura:', name)
      return
    }
    writeFileSync(join(OUT, name), Buffer.from(b64, 'base64'))
    console.log('  ✓', name, Math.round(Buffer.from(b64, 'base64').length / 1024) + ' KB')
  }

  const click = async (label) =>
    ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||x.title)===${JSON.stringify(label)}); b&&b.click(); return !!b })()`)

  /** Every panel's on-screen box, so framing can be VERIFIED instead of assumed. */
  const bounds = `(() => {
    const els = [...document.querySelectorAll('[data-surface-layer="panel"]')]
    if (!els.length) return null
    const r = els.map(e => e.getBoundingClientRect())
    return JSON.stringify({
      left: Math.round(Math.min(...r.map(b => b.left))), right: Math.round(Math.max(...r.map(b => b.right))),
      top: Math.round(Math.min(...r.map(b => b.top))), bottom: Math.round(Math.max(...r.map(b => b.bottom))),
      vw: window.innerWidth, vh: window.innerHeight, n: els.length,
    })
  })()`

  /**
   * Frame the canvas: zoom-to-fit, then keep stepping out until every panel sits inside the window
   * with real margin. Zoom-to-fit alone packs the content edge to edge — and the left dock and the
   * top bar are overlays, so "it fits" still came out clipped. The margin is what makes this read as
   * a product shot instead of a crop.
   */
  const fit = async () => {
    await click('Zoom to fit')
    await sleep(1800)
    const M = 96
    for (let i = 0; i < 5; i += 1) {
      const b = JSON.parse((await ev(bounds)) || 'null')
      if (!b) break
      if (b.left >= M && b.top >= M && b.right <= b.vw - M && b.bottom <= b.vh - M) break
      await click('Zoom out')
      await sleep(900)
    }
    await sleep(1200)
    console.log('  encuadre:', await ev(bounds))
  }
  const zoomOut = async (n) => {
    for (let i = 0; i < n; i += 1) {
      await click('Zoom out')
      await sleep(800)
    }
    await sleep(1200)
  }

  await fit()
  await shoot('hero-canvas.png')

  await zoomOut(2)
  await shoot('canvas.png')

  // Close-up on one agent panel: clip to its on-screen rect plus a small margin, so the shot is
  // about the morph and not the canvas around it.
  await fit()
  const rect = await ev(`(() => {
    const terms = [...document.querySelectorAll('[data-panel-type="terminal"]')]
    // Prefer a panel that really is in agent mode — that is what this shot is about.
    const el = terms.find(t => (t.style.getPropertyValue('--agent-accent') || '').trim() !== '') || terms[0]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height })
  })()`)
  if (rect) {
    const r = JSON.parse(rect)
    const m = 28
    await shoot('agent-mode.png', {
      x: Math.max(0, Math.floor(r.x - m)),
      y: Math.max(0, Math.floor(r.y - m)),
      width: Math.ceil(r.width + m * 2),
      height: Math.ceil(r.height + m * 2),
    })
  } else {
    console.log('  ✗ no encontré el panel para el primer plano')
  }

  console.log('RESULT:', JSON.stringify({ ok: true, out: OUT }))
  ws.close()
  kill()
  process.exit(0)
}

main().catch((e) => {
  console.error('ERROR:', e && e.stack ? e.stack : String(e))
  process.exit(1)
})
