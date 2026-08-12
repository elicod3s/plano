// Abre Ajustes → Appearance y captura la sección Background para revisarla visualmente.
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

const KIND = process.argv[2] ?? 'linear'
const OUT = process.argv[3] ?? `D:/Tools/Plano/.plano-tests/settings-${KIND}.png`

const SETTINGS = {
  version: 11,
  general: { restoreLastWorkspace: true, restoreAgentSessions: false, showFilesOnLaunch: false, warnBeforeQuit: false, confirmClosePanelWithProcess: false, agentDoneSound: false },
  appearance: {
    theme: 'monolith', accent: '#FFFFFF', gridStyle: 'dots', gridOpacity: 1, reduceMotion: false,
    canvasBackground: { kind: KIND, colors: ['#0C0D20', '#090A19'], angle: 135 },
    canvasGlow: 12, gridSize: 'standard',
  },
  editor: { fontSize: 13, tabSize: 2, wordWrap: true, lineNumbers: true },
  terminal: { shell: 'cmd' },
  canvas: { snapToGrid: true, showMinimap: false, zoomSensitivity: 1, autosave: false },
  browser: {}, privacy: { telemetry: false, saveTerminalHistory: false },
  advanced: { hardwareAcceleration: true }, agentMesh: {}, voice: {},
}

async function main() {
  const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const UD = path.join(os.tmpdir(), `ss-${run}`)
  const PRJ = path.join(os.tmpdir(), `ssp-${run}`)
  fs.mkdirSync(UD, { recursive: true })
  fs.mkdirSync(PRJ, { recursive: true })
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
  fs.writeFileSync(path.join(UD, 'workspaces.json'), JSON.stringify({
    schemaVersion: 1, savedAt: new Date().toISOString(), activeId: 's1',
    workspaces: [{ id: 's1', name: 'S', folderPath: PRJ, viewport: { x: 0, y: 0, zoom: 1 }, regions: [], panels: [] }],
  }))
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))

  const port = 9860 + (Date.now() % 15)
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
  await sleep(4200)

  // Abrir Ajustes en Appearance a través del store expuesto en la ventana, o por atajo.
  const opened = await ev(`(async () => {
    const s = (ms) => new Promise(r => setTimeout(r, ms))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))
    await s(900)
    return !!document.querySelector('[data-surface-layer="modal"]')
  })()`)

  const nav = await ev(`(async () => {
    const s = (ms) => new Promise(r => setTimeout(r, ms))
    const modal = document.querySelector('[data-surface-layer="modal"]')
    if (!modal) return 'no modal'
    const tab = [...modal.querySelectorAll('button')].find(b => b.textContent.trim() === 'Appearance')
    if (tab) { tab.click(); await s(700) }
    const label = [...modal.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.trim() === 'Background')
    if (label) label.scrollIntoView({ block: 'center' })
    await s(600)
    const block = label ? label.closest('div').parentElement : null
    const r = (block ?? modal).getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
  })()`)

  const clip = nav && typeof nav === 'object' && !nav.__exc && nav.width
    ? { x: Math.max(0, nav.x - 12), y: Math.max(0, nav.y - 12), width: nav.width + 24, height: Math.min(560, nav.height + 340), scale: 2 }
    : undefined
  const shot = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' })
  fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'))
  console.log(JSON.stringify({ opened, nav, saved: OUT }))
  ws.close()
  app.kill()
}
main().catch((e) => console.log('FATAL', e.message))
