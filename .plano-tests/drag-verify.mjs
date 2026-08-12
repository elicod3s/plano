// Verifica que arrastrar un panel MUEVE el panel en el DOM (y que nada queda invisible).
import { spawn } from 'node:child_process'
import http from 'node:http'
import WebSocket from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (p, port) =>
  new Promise((res, rej) => {
    http
      .get(`http://127.0.0.1:${port}${p}`, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => res(JSON.parse(d)))
      })
      .on('error', rej)
  })

const SETTINGS = {
  version: 11,
  general: { restoreLastWorkspace: true, restoreAgentSessions: false, showFilesOnLaunch: false, warnBeforeQuit: false, confirmClosePanelWithProcess: false, agentDoneSound: false },
  appearance: { theme: 'monolith', accent: '#FFFFFF', gridStyle: 'none', gridOpacity: 1, reduceMotion: false, canvasBackground: { kind: 'theme', colors: ['#141414', '#1d1d2b'], angle: 135 }, canvasGlow: 0, gridSize: 'standard' },
  editor: { fontSize: 13, tabSize: 2, wordWrap: true, lineNumbers: true },
  terminal: { shell: 'cmd' },
  canvas: { snapToGrid: true, showMinimap: false, zoomSensitivity: 1, autosave: false },
  browser: {}, privacy: { telemetry: false, saveTerminalHistory: false },
  advanced: { hardwareAcceleration: true }, agentMesh: {}, voice: {},
}

async function main() {
  const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const UD = path.join(os.tmpdir(), `dv-${run}`)
  const PRJ = path.join(os.tmpdir(), `dvp-${run}`)
  fs.mkdirSync(UD, { recursive: true })
  // Proyecto de prueba: 40 carpetas x 30 archivos (árbol grande de verdad)
  for (let d = 0; d < 40; d += 1) {
    const dir = path.join(PRJ, 'src', `mod${String(d).padStart(2, '0')}`)
    fs.mkdirSync(dir, { recursive: true })
    for (let f = 0; f < 30; f += 1) fs.writeFileSync(path.join(dir, `file${String(f).padStart(3, '0')}.ts`), `// ${d}-${f}\n`)
  }
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
  fs.writeFileSync(path.join(UD, 'workspaces.json'), JSON.stringify({
    schemaVersion: 1, savedAt: new Date().toISOString(), activeId: 's1',
    workspaces: [{
      id: 's1', name: 'S', folderPath: PRJ, viewport: { x: 0, y: 0, zoom: 1 }, regions: [],
      panels: [
        { id: 'e1', type: 'editor', rect: { x: 60, y: 60, width: 700, height: 520 }, z: 1, title: 'Files', props: { folderPath: PRJ, sidebarOpen: true } },
        { id: 'm1', type: 'markdown', rect: { x: 820, y: 80, width: 380, height: 300 }, z: 2, title: 'Note', props: { text: 'hola' } },
      ],
    }],
  }))
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))

  const port = 9780 + (Date.now() % 15)
  const app = spawn('D:/Tools/Plano/node_modules/electron/dist/electron.exe',
    ['.', `--remote-debugging-port=${port}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    { env: { ...process.env, PLANO_USER_DATA_DIR: UD }, stdio: 'ignore', windowsHide: true, cwd: 'D:/Tools/Plano' })

  let page
  for (let i = 0; i < 90 && !page; i++) {
    try {
      const t = await getJson('/json', port)
      page = t.find((x) => x.type === 'page' && x.url.includes('index.html'))
    } catch {}
    if (!page) await sleep(500)
  }
  if (!page) { console.log('NO_PAGE'); app.kill(); return }

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  let id = 0
  const pend = new Map()
  ws.on('message', (d) => {
    const m = JSON.parse(d)
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  })
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id
      const t = setTimeout(() => { pend.delete(i); rej(new Error('CDP_TIMEOUT ' + method)) }, 30000)
      pend.set(i, (m) => { clearTimeout(t); res(m) })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  // ev con el anidamiento CORRECTO: exceptionDetails vive en r.result, no en r.
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
    const ex = r.exceptionDetails ?? r.result?.exceptionDetails
    if (ex) return { __exc: (ex.exception?.description || ex.text || '').slice(0, 300) }
    return r.result?.result?.value
  }

  await send('Page.bringToFront', {}).catch(() => {})
  await sleep(4000)
  await ev(`(() => { Element.prototype.setPointerCapture = function () {}; Element.prototype.releasePointerCapture = function () {}; return 'ok' })()`)

  const out = {}

  // ── 1. Los paneles existen y se ven ───────────────────────────────────────
  out.mounted = await ev(`JSON.stringify((() => {
    const frames = [...document.querySelectorAll('[data-surface-layer="panel"]')]
    return frames.map(f => {
      const r = f.getBoundingClientRect()
      const cs = getComputedStyle(f)
      return { type: f.dataset.panelType, w: Math.round(r.width), h: Math.round(r.height),
               vis: cs.visibility, op: cs.opacity, cv: cs.contentVisibility, contain: cs.contain,
               text: f.innerText.slice(0,40) }
    })
  })())`)

  // ── 2. ARRASTRE REAL del panel markdown por su header ─────────────────────
  out.drag = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const frames = [...document.querySelectorAll('[data-surface-layer="panel"]')]
    const target = frames.find(f => f.dataset.panelType === 'markdown')
    if (!target) return { err: 'no markdown panel' }
    const anchor = target.parentElement            // el nodo que lleva el translate3d
    const header = target.querySelector('div[style*="--density-head"]') || target.firstElementChild
    const before = getComputedStyle(anchor).transform
    const beforeX = anchor.getBoundingClientRect().left
    const hr = header.getBoundingClientRect()
    const sx = Math.round(hr.left + hr.width / 2), sy = Math.round(hr.top + hr.height / 2)
    const pd = (type, x, y) => header.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true }))
    pd('pointerdown', sx, sy)
    const mid = []
    for (let i = 1; i <= 12; i++) {
      pd('pointermove', sx + i * 12, sy + i * 6)
      await sleep(24)
      if (i === 6) mid.push({ t: getComputedStyle(anchor).transform, left: Math.round(anchor.getBoundingClientRect().left),
                              vis: getComputedStyle(target).visibility, w: Math.round(target.getBoundingClientRect().width) })
    }
    pd('pointerup', sx + 144, sy + 72)
    await sleep(140)
    const after = getComputedStyle(anchor).transform
    const afterX = anchor.getBoundingClientRect().left
    return { before, after, moved: before !== after, dxScreen: Math.round(afterX - beforeX), mid: mid[0] }
  })()`)

  // ── 3. El árbol de Files pinta filas (virtualización viva) ────────────────
  out.tree = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const frames = [...document.querySelectorAll('[data-surface-layer="panel"]')]
    const files = frames.find(f => f.dataset.panelType === 'editor')
    if (!files) return { err: 'no files panel' }
    await sleep(600)
    const rows = files.querySelectorAll('button')
    const src = [...rows].find(b => b.textContent.trim() === 'src')
    if (src) { src.click(); await sleep(900) }
    return { rowsAfter: files.querySelectorAll('button').length, text: files.innerText.slice(0, 60).replace(/\\n/g,'|') }
  })()`)

  // ── 4. Zoom: el mundo escala y los paneles siguen visibles ────────────────
  out.zoom = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const world = document.querySelector('[data-world-layer]')
    const canvas = document.querySelector('[data-canvas-background]')
    const before = getComputedStyle(world).transform
    for (let i = 0; i < 8; i++) {
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, altKey: true, clientX: 700, clientY: 400, bubbles: true, cancelable: true }))
      await sleep(40)
    }
    await sleep(600)
    const after = getComputedStyle(world).transform
    const panels = [...document.querySelectorAll('[data-surface-layer="panel"]')].map(f => {
      const r = f.getBoundingClientRect()
      return { t: f.dataset.panelType, w: Math.round(r.width), vis: getComputedStyle(f).visibility }
    })
    return { before, after, zoomed: before !== after, panels }
  })()`)

  console.log('RESULT ' + JSON.stringify(out, null, 1))
  ws.close()
  app.kill()
}
main().catch((e) => { console.log('FATAL', e.message) })
