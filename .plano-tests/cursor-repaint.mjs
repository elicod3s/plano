// Mover el ratón NO debe repintar la pantalla. Mide el coste del movimiento del cursor
// (el foco del grid) con Performance.getMetrics, que es donde se ve el repintado real.
import { spawn } from 'node:child_process'
import http from 'node:http'
import WebSocket from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (p, port) =>
  new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${port}${p}`, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => res(JSON.parse(d)))
    }).on('error', rej)
  })

const SETTINGS = {
  version: 11,
  general: { restoreLastWorkspace: true, restoreAgentSessions: false, showFilesOnLaunch: false, warnBeforeQuit: false, confirmClosePanelWithProcess: false, agentDoneSound: false },
  appearance: { theme: 'monolith', accent: '#FFFFFF', gridStyle: 'dots', gridOpacity: 1, reduceMotion: false, canvasBackground: { kind: 'theme', colors: ['#141414', '#1d1d2b'], angle: 135 }, canvasGlow: 0, gridSize: 'standard' },
  editor: { fontSize: 13, tabSize: 2, wordWrap: true, lineNumbers: true },
  terminal: { shell: 'cmd' },
  canvas: { snapToGrid: true, showMinimap: false, zoomSensitivity: 1, autosave: false },
  browser: {}, privacy: { telemetry: false, saveTerminalHistory: false },
  advanced: { hardwareAcceleration: true }, agentMesh: {}, voice: {},
}

async function main() {
  const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const UD = path.join(os.tmpdir(), `cur-${run}`)
  const PRJ = path.join(os.tmpdir(), `curp-${run}`)
  fs.mkdirSync(UD, { recursive: true }); fs.mkdirSync(PRJ, { recursive: true })
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
  fs.writeFileSync(path.join(UD, 'workspaces.json'), JSON.stringify({
    schemaVersion: 1, savedAt: new Date().toISOString(), activeId: 's1',
    workspaces: [{ id: 's1', name: 'S', folderPath: PRJ, viewport: { x: 0, y: 0, zoom: 1 }, regions: [],
      panels: [
        { id: 't1', type: 'terminal', rect: { x: 60, y: 60, width: 700, height: 460 }, z: 1, title: 'T', props: { folderPath: PRJ, tabs: [{ id: 'tab1' }], activeTabId: 'tab1' } },
        { id: 't2', type: 'terminal', rect: { x: 800, y: 60, width: 700, height: 460 }, z: 2, title: 'T2', props: { folderPath: PRJ, tabs: [{ id: 'tab2' }], activeTabId: 'tab2' } },
      ] }],
  }))
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))

  const port = 9940 + (Date.now() % 15)
  const app = spawn('D:/Tools/Plano/node_modules/electron/dist/electron.exe',
    ['.', `--remote-debugging-port=${port}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    { env: { ...process.env, PLANO_USER_DATA_DIR: UD }, stdio: 'ignore', windowsHide: true, cwd: 'D:/Tools/Plano' })

  let page
  for (let i = 0; i < 90 && !page; i++) {
    try { const t = await getJson('/json', port); page = t.find((x) => x.type === 'page' && x.url.includes('index.html')) } catch {}
    if (!page) await sleep(500)
  }
  if (!page) { console.log('NO_PAGE'); app.kill(); return }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  let id = 0
  const pend = new Map()
  ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id
      const t = setTimeout(() => { pend.delete(i); rej(new Error('CDP_TIMEOUT ' + method)) }, 30000)
      pend.set(i, (m) => { clearTimeout(t); res(m) })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
    const ex = r.exceptionDetails ?? r.result?.exceptionDetails
    if (ex) return { __exc: (ex.exception?.description || ex.text || '').slice(0, 300) }
    return r.result?.result?.value
  }

  await send('Page.bringToFront', {}).catch(() => {})
  await send('Performance.enable', {})
  await sleep(5000)

  const metrics = async () => {
    const r = await send('Performance.getMetrics', {})
    const m = {}
    for (const e of r.result.metrics) m[e.name] = e.value
    return m
  }

  // 200 movimientos de ratón sobre el canvas, como un usuario moviéndolo.
  const MOVE = `(async () => {
    const s = (ms) => new Promise(r => setTimeout(r, ms))
    for (let i = 0; i < 200; i++) {
      const x = 300 + Math.round(Math.sin(i / 9) * 500)
      const y = 300 + Math.round(Math.cos(i / 7) * 250)
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }))
      await s(8)
    }
    await s(500)
    return 'done'
  })()`

  await sleep(600)
  const a = await metrics()
  await ev(MOVE)
  const b = await metrics()

  const spot = await ev(`(() => {
    const host = document.querySelector('[data-canvas-background]')
    const kids = [...host.children].filter((c) => c.getAttribute('aria-hidden') === 'true')
    const box = kids.find((c) => c.style.maskImage && c.firstElementChild)
    if (!box) return { found: false }
    const r = box.getBoundingClientRect()
    return {
      found: true,
      w: Math.round(r.width), h: Math.round(r.height),
      willChange: getComputedStyle(box).willChange,
      movesByTransform: /translate3d/.test(box.style.transform || ''),
      innerCounter: /translate3d/.test(box.firstElementChild.style.transform || ''),
    }
  })()`)

  console.log('RESULT: ' + JSON.stringify({
    paintMs: +((b.LayoutDuration - a.LayoutDuration) * 1000).toFixed(1),
    recalcStyleMs: +((b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000).toFixed(1),
    scriptMs: +((b.ScriptDuration - a.ScriptDuration) * 1000).toFixed(1),
    taskMs: +((b.TaskDuration - a.TaskDuration) * 1000).toFixed(1),
    recalcCount: b.RecalcStyleCount - a.RecalcStyleCount,
    layoutCount: b.LayoutCount - a.LayoutCount,
    spot,
  }))
  ws.close(); app.kill()
}
main().catch((e) => console.log('FATAL', e.message))
