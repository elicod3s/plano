// Verifica el cierre del selector de color: botón Done, Escape y clic fuera.
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
  appearance: {
    theme: 'monolith', accent: '#FFFFFF', gridStyle: 'dots', gridOpacity: 1, reduceMotion: false,
    canvasBackground: { kind: 'linear', colors: ['#0C0D20', '#090A19'], angle: 135 },
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
  const UD = path.join(os.tmpdir(), `pk-${run}`)
  const PRJ = path.join(os.tmpdir(), `pkp-${run}`)
  fs.mkdirSync(UD, { recursive: true }); fs.mkdirSync(PRJ, { recursive: true })
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
  fs.writeFileSync(path.join(UD, 'workspaces.json'), JSON.stringify({
    schemaVersion: 1, savedAt: new Date().toISOString(), activeId: 's1',
    workspaces: [{ id: 's1', name: 'S', folderPath: PRJ, viewport: { x: 0, y: 0, zoom: 1 }, regions: [], panels: [] }],
  }))
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))

  const port = 9880 + (Date.now() % 15)
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

  await ev(`(async () => {
    const s = ms => new Promise(r => setTimeout(r, ms))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))
    await s(900)
    const modal = document.querySelector('[data-surface-layer="modal"]')
    const tab = [...modal.querySelectorAll('button')].find(b => b.textContent.trim() === 'Appearance')
    if (tab) { tab.click(); await s(700) }
    return 'ok'
  })()`)

  const out = await ev(`(async () => {
    const s = ms => new Promise(r => setTimeout(r, ms))
    const modal = document.querySelector('[data-surface-layer="modal"]')
    const startBtn = () => [...modal.querySelectorAll('[data-picker-trigger]')].find(b => b.textContent.includes('Start'))
    const pickerOpen = () => !!modal.querySelector('input[placeholder="8EA2FF"]')
    const doneBtn = () => [...modal.querySelectorAll('button')].find(b => b.textContent.trim() === 'Done')
    const res = {}

    startBtn().click(); await s(500)
    res.opensOnClick = pickerOpen()
    res.hasDoneButton = !!doneBtn()

    // 1) Done cierra
    doneBtn()?.click(); await s(450)
    res.closedByDone = !pickerOpen()

    // 2) Escape cierra
    startBtn().click(); await s(450)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await s(450)
    res.closedByEscape = !pickerOpen()

    // 3) Clic fuera cierra (y el modal sigue abierto)
    startBtn().click(); await s(450)
    const heading = [...modal.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.trim() === 'Background')
    heading.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))
    await s(450)
    res.closedByOutside = !pickerOpen()
    res.modalStillOpen = !!document.querySelector('[data-surface-layer="modal"]')

    // 4) El color se aplica en vivo mientras se elige (sin confirmar)
    startBtn().click(); await s(450)
    const field = modal.querySelector('.cursor-crosshair')
    const r = field.getBoundingClientRect()
    field.dispatchEvent(new PointerEvent('pointerdown', { clientX: Math.round(r.left + r.width*0.8), clientY: Math.round(r.top + r.height*0.25), bubbles: true, composed: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1 }))
    await s(500)
    res.hexAfterPick = modal.querySelector('input[placeholder="8EA2FF"]').value
    res.canvasApplied = getComputedStyle(document.querySelector('[data-canvas-background]')).backgroundImage.slice(0, 60)
    doneBtn()?.click(); await s(300)
    res.finalClosed = !pickerOpen()
    return res
  })()`)

  console.log('PICKER ' + JSON.stringify(out, null, 1))
  ws.close(); app.kill()
}
main().catch((e) => console.log('FATAL', e.message))
