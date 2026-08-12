// Mide long tasks durante zoom/pan CON el árbol de Files expandido (el escenario que el usuario reporta).
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
  const UD = path.join(os.tmpdir(), `pv-${run}`)
  const PRJ = path.join(os.tmpdir(), `pvp-${run}`)
  fs.mkdirSync(UD, { recursive: true })
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
        { id: 'e1', type: 'editor', rect: { x: 60, y: 60, width: 700, height: 640 }, z: 1, title: 'Files', props: { folderPath: PRJ, sidebarOpen: true } },
        { id: 'm1', type: 'markdown', rect: { x: 820, y: 80, width: 380, height: 300 }, z: 2, title: 'Note', props: { text: 'hola' } },
        { id: 'm2', type: 'markdown', rect: { x: 820, y: 420, width: 380, height: 260 }, z: 3, title: 'Note2', props: { text: 'b' } },
      ],
    }],
  }))
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))

  const port = 9800 + (Date.now() % 15)
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
  await sleep(4000)
  const out = {}

  // Expandir src + varias carpetas → árbol grande de verdad
  out.expand = await ev(`(async () => {
    const s = (ms) => new Promise(r => setTimeout(r, ms))
    const files = [...document.querySelectorAll('[data-surface-layer="panel"]')].find(f => f.dataset.panelType === 'editor')
    const click = async (label) => {
      const b = [...files.querySelectorAll('button')].find(x => x.textContent.trim() === label)
      if (b) { b.click(); await s(500) }
    }
    await s(500); await click('src')
    for (let i = 0; i < 6; i++) await click('mod0' + i)
    return { rows: files.querySelectorAll('button').length }
  })()`)

  // Long tasks + duración media de tarea durante una ráfaga de zoom
  out.zoomPerf = await ev(`(async () => {
    const s = (ms) => new Promise(r => setTimeout(r, ms))
    const canvas = document.querySelector('[data-canvas-background]')
    const tasks = []
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) tasks.push(Math.round(e.duration)) })
    try { po.observe({ entryTypes: ['longtask'] }) } catch (e) { return { err: 'no longtask support' } }
    const t0 = performance.now()
    for (let i = 0; i < 40; i++) {
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: i % 2 ? -100 : 100, altKey: true, clientX: 700, clientY: 400, bubbles: true, cancelable: true }))
      await s(16)
    }
    await s(800)
    po.disconnect()
    return { wallMs: Math.round(performance.now() - t0), longTasks: tasks.length, worstMs: tasks.length ? Math.max(...tasks) : 0, tasks: tasks.slice(0, 8) }
  })()`)

  // Long tasks durante un arrastre largo del panel
  out.dragPerf = await ev(`(async () => {
    const s = (ms) => new Promise(r => setTimeout(r, ms))
    const target = [...document.querySelectorAll('[data-surface-layer="panel"]')].find(f => f.dataset.panelType === 'markdown')
    const header = target.querySelector('div[style*="--density-head"]') || target.firstElementChild
    Element.prototype.setPointerCapture = function () {}
    Element.prototype.releasePointerCapture = function () {}
    const tasks = []
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) tasks.push(Math.round(e.duration)) })
    try { po.observe({ entryTypes: ['longtask'] }) } catch (e) { return { err: 'no longtask' } }
    const hr = header.getBoundingClientRect()
    const sx = Math.round(hr.left + hr.width/2), sy = Math.round(hr.top + hr.height/2)
    const pd = (t, x, y) => header.dispatchEvent(new PointerEvent(t, { pointerId: 1, isPrimary: true, button: 0, buttons: t === 'pointerup' ? 0 : 1, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true }))
    const t0 = performance.now()
    pd('pointerdown', sx, sy)
    for (let i = 1; i <= 60; i++) { pd('pointermove', sx + Math.round(Math.sin(i/6)*140), sy + i); await s(16) }
    pd('pointerup', sx, sy + 60)
    await s(600)
    po.disconnect()
    return { wallMs: Math.round(performance.now() - t0), longTasks: tasks.length, worstMs: tasks.length ? Math.max(...tasks) : 0 }
  })()`)

  console.log('PERF ' + JSON.stringify(out, null, 1))
  ws.close()
  app.kill()
}
main().catch((e) => console.log('FATAL', e.message))
