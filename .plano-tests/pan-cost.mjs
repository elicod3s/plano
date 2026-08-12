// ¿Por qué panear es menos smooth con un panel Files? Mide el MISMO pan con Files y sin Files.
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
  const UD = path.join(os.tmpdir(), `pc-${run}`)
  const PRJ = path.join(os.tmpdir(), `pcp-${run}`)
  fs.mkdirSync(UD, { recursive: true })
  // Raíz ANCHA como la del usuario: ~50 carpetas + ~30 archivos en el nivel raíz
  for (let d = 0; d < 50; d += 1) fs.mkdirSync(path.join(PRJ, `_folder${String(d).padStart(2, '0')}`), { recursive: true })
  for (let f = 0; f < 30; f += 1) fs.writeFileSync(path.join(PRJ, `file${String(f).padStart(2, '0')}.ts`), '//\n')
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
  fs.writeFileSync(path.join(UD, 'workspaces.json'), JSON.stringify({
    schemaVersion: 1, savedAt: new Date().toISOString(), activeId: 's1',
    workspaces: [{
      id: 's1', name: 'S', folderPath: PRJ, viewport: { x: 0, y: 0, zoom: 1 }, regions: [],
      panels: [
        { id: 'e1', type: 'editor', rect: { x: 60, y: 60, width: 620, height: 900 }, z: 1, title: 'Files', props: { folderPath: PRJ, sidebarOpen: true } },
        { id: 'm1', type: 'markdown', rect: { x: 760, y: 60, width: 620, height: 900 }, z: 2, title: 'Note', props: { text: 'hola' } },
      ],
    }],
  }))
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))

  const port = 9820 + (Date.now() % 15)
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
      const t = setTimeout(() => { pend.delete(i); rej(new Error('CDP_TIMEOUT ' + method)) }, 40000)
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
  await sleep(4500)

  const metrics = async () => {
    const r = await send('Performance.getMetrics', {})
    const m = {}
    for (const e of r.result.metrics) m[e.name] = e.value
    return m
  }
  // Un pan idéntico y repetible (rueda sin modificador = free pan)
  const PAN = `(async () => {
    const s = (ms) => new Promise(r => setTimeout(r, ms))
    const canvas = document.querySelector('[data-canvas-background]')
    for (let i = 0; i < 60; i++) {
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaX: (i%2?18:-18), deltaY: 14, clientX: 900, clientY: 500, bubbles: true, cancelable: true }))
      await s(16)
    }
    await s(700)
    return 'done'
  })()`

  const measure = async (label) => {
    await sleep(700)
    const a = await metrics()
    const t0 = Date.now()
    await ev(PAN)
    const b = await metrics()
    return {
      label,
      wallMs: Date.now() - t0,
      layoutMs: +((b.LayoutDuration - a.LayoutDuration) * 1000).toFixed(1),
      recalcStyleMs: +((b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000).toFixed(1),
      scriptMs: +((b.ScriptDuration - a.ScriptDuration) * 1000).toFixed(1),
      taskMs: +((b.TaskDuration - a.TaskDuration) * 1000).toFixed(1),
      layoutCount: b.LayoutCount - a.LayoutCount,
      recalcCount: b.RecalcStyleCount - a.RecalcStyleCount,
      nodes: b.Nodes,
      layoutObjects: b.LayoutObjects,
    }
  }

  const out = {}
  out.domFiles = await ev(`(() => {
    const f = [...document.querySelectorAll('[data-surface-layer="panel"]')].find(p => p.dataset.panelType === 'editor')
    return f ? { nodes: f.querySelectorAll('*').length, svg: f.querySelectorAll('svg').length, rows: f.querySelectorAll('button').length } : null
  })()`)
  out.withFiles = await measure('CON panel Files')

  // Quitar SOLO el Files y repetir el mismo pan (mismo proceso, mismas condiciones)
  out.removed = await ev(`(async () => {
    const s = (ms) => new Promise(r => setTimeout(r, ms))
    const f = [...document.querySelectorAll('[data-surface-layer="panel"]')].find(p => p.dataset.panelType === 'editor')
    const close = [...f.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Close panel' || b.title === 'Close panel')
    if (!close) return 'no close button'
    close.click(); await s(900)
    return document.querySelectorAll('[data-surface-layer="panel"]').length
  })()`)
  out.withoutFiles = await measure('SIN panel Files')

  console.log('PANCOST ' + JSON.stringify(out, null, 1))
  ws.close()
  app.kill()
}
main().catch((e) => console.log('FATAL', e.message))
