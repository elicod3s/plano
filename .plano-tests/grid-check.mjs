// El grid y su spotlight deben seguir la cámara tras mover las vars a las propias capas.
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
  const UD = path.join(os.tmpdir(), `gc-${run}`)
  const PRJ = path.join(os.tmpdir(), `gcp-${run}`)
  fs.mkdirSync(UD, { recursive: true })
  fs.mkdirSync(path.join(PRJ, 'src'), { recursive: true })
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
  fs.writeFileSync(path.join(UD, 'workspaces.json'), JSON.stringify({
    schemaVersion: 1, savedAt: new Date().toISOString(), activeId: 's1',
    workspaces: [{
      id: 's1', name: 'S', folderPath: PRJ, viewport: { x: 0, y: 0, zoom: 1 }, regions: [],
      panels: [{ id: 'm1', type: 'markdown', rect: { x: 200, y: 120, width: 400, height: 300 }, z: 1, title: 'N', props: { text: 'x' } }],
    }],
  }))
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))

  const port = 9840 + (Date.now() % 15)
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
  await sleep(4500)

  const out = await ev(`(async () => {
    const s = (ms) => new Promise(r => setTimeout(r, ms))
    const canvas = document.querySelector('[data-canvas-background]')
    const layers = [...canvas.children].filter(c => c.getAttribute('aria-hidden') === 'true' && getComputedStyle(c).backgroundImage.includes('gradient'))
    const read = (el) => ({
      x: getComputedStyle(el).getPropertyValue('--grid-x').trim(),
      minor: getComputedStyle(el).getPropertyValue('--grid-minor').trim(),
      pos: getComputedStyle(el).backgroundPosition,
      size: getComputedStyle(el).backgroundSize,
    })
    const before = layers.map(read)
    // pan
    for (let i = 0; i < 20; i++) { canvas.dispatchEvent(new WheelEvent('wheel', { deltaX: -25, deltaY: -15, clientX: 800, clientY: 450, bubbles: true, cancelable: true })); await s(16) }
    await s(500)
    const afterPan = layers.map(read)
    // zoom
    for (let i = 0; i < 6; i++) { canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -110, altKey: true, clientX: 800, clientY: 450, bubbles: true, cancelable: true })); await s(30) }
    await s(500)
    const afterZoom = layers.map(read)
    const world = getComputedStyle(document.querySelector('[data-world-layer]')).transform
    // el host ancestro NO debe llevar ninguna var de grid
    const hostVars = ['--grid-x','--grid-y','--grid-minor','--grid-major'].map(v => canvas.style.getPropertyValue(v)).filter(Boolean)
    return { layerCount: layers.length, before, afterPan, afterZoom, world,
             hostStillWritten: hostVars, layersAgree: JSON.stringify(afterZoom[0]) === JSON.stringify(afterZoom[1]) }
  })()`)

  console.log('GRID ' + JSON.stringify(out, null, 1))
  ws.close()
  app.kill()
}
main().catch((e) => console.log('FATAL', e.message))
