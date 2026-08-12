// Los botones +/−/reset del control de zoom deben funcionar en clics REPETIDOS.
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
  appearance: { theme: 'monolith', accent: '#FFFFFF', gridStyle: 'dots', gridOpacity: 1, reduceMotion: false, canvasBackground: { kind: 'theme', colors: ['#0C0D20', '#090A19'], angle: 135 }, canvasGlow: 0, gridSize: 'standard' },
  editor: { fontSize: 13, tabSize: 2, wordWrap: true, lineNumbers: true },
  terminal: { shell: 'cmd' },
  canvas: { snapToGrid: true, showMinimap: true, zoomSensitivity: 1, autosave: false },
  browser: {}, privacy: { telemetry: false, saveTerminalHistory: false },
  advanced: { hardwareAcceleration: true }, agentMesh: {}, voice: {},
}

async function main() {
  const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const UD = path.join(os.tmpdir(), `zoom-${run}`)
  const PRJ = path.join(os.tmpdir(), `zoomp-${run}`)
  fs.mkdirSync(UD, { recursive: true }); fs.mkdirSync(PRJ, { recursive: true })
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
  fs.writeFileSync(path.join(UD, 'workspaces.json'), JSON.stringify({
    schemaVersion: 1, savedAt: new Date().toISOString(), activeId: 's1',
    workspaces: [{ id: 's1', name: 'S', folderPath: PRJ, viewport: { x: 0, y: 0, zoom: 1 }, regions: [],
      panels: [{ id: 'm1', type: 'markdown', rect: { x: 200, y: 150, width: 420, height: 300 }, z: 1, title: 'N', props: { text: 'x' } }] }],
  }))
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))

  const port = 9920 + (Date.now() % 15)
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
  await sleep(4200)

  const out = await ev(`(async () => {
    const s = (ms) => new Promise(r => setTimeout(r, ms))
    const label = () => document.querySelector('[title="Reset zoom"]')?.textContent?.trim()
    const btn = (aria) => [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || b.title || '') === aria)
    const worldScale = () => {
      const t = getComputedStyle(document.querySelector('[data-world-layer]')).transform
      const m = t.match(/matrix\\(([-\\d.]+)/)
      return m ? Number(m[1]) : null
    }
    const steps = []
    const record = (tag) => steps.push({ tag, label: label(), scale: worldScale() })
    record('inicio')
    // Tres clics en "+": cada uno debe SUBIR respecto al anterior.
    for (let i = 0; i < 3; i++) { btn('Zoom in')?.click(); await s(700); record('plus' + (i + 1)) }
    // Dos clics en "−".
    for (let i = 0; i < 2; i++) { btn('Zoom out')?.click(); await s(700); record('minus' + (i + 1)) }
    // Reset.
    document.querySelector('[title="Reset zoom"]')?.click(); await s(900); record('reset')
    return steps
  })()`)

  const scales = Array.isArray(out) ? out.map((s) => s.scale) : []
  const labels = Array.isArray(out) ? out.map((s) => s.label) : []
  const plusMonotonic = scales.length >= 4 && scales[1] > scales[0] && scales[2] > scales[1] && scales[3] > scales[2]
  const minusMonotonic = scales.length >= 6 && scales[4] < scales[3] && scales[5] < scales[4]
  const resetOk = labels[labels.length - 1] === '100%' && Math.abs((scales[scales.length - 1] ?? 0) - 1) < 0.001
  const labelTracksScale = Array.isArray(out) && out.every((s) => s.label === `${Math.round((s.scale ?? 0) * 100)}%`)

  console.log('RESULT: ' + JSON.stringify({ plusMonotonic, minusMonotonic, resetOk, labelTracksScale, steps: out }))
  ws.close(); app.kill()
}
main().catch((e) => console.log('FATAL', e.message))
