// Lanza PLANO CON NO_COLOR=1 en el entorno y comprueba que el shell del PTY NO lo hereda.
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
  terminal: { shell: 'cmd', keepAgentsOnQuit: false },
  canvas: { snapToGrid: true, showMinimap: false, zoomSensitivity: 1, autosave: false },
  browser: {}, privacy: { telemetry: false, saveTerminalHistory: false },
  advanced: { hardwareAcceleration: true }, agentMesh: {}, voice: {},
}

async function main() {
  const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const UD = path.join(os.tmpdir(), `nc-${run}`)
  const PRJ = path.join(os.tmpdir(), `ncp-${run}`)
  fs.mkdirSync(UD, { recursive: true }); fs.mkdirSync(PRJ, { recursive: true })
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
  fs.writeFileSync(path.join(UD, 'workspaces.json'), JSON.stringify({
    schemaVersion: 1, savedAt: new Date().toISOString(), activeId: 's1',
    workspaces: [{
      id: 's1', name: 'S', folderPath: PRJ, viewport: { x: 0, y: 0, zoom: 1 }, regions: [],
      panels: [{ id: 't1', type: 'terminal', rect: { x: 60, y: 60, width: 900, height: 500 }, z: 1, title: 'T', props: { folderPath: PRJ, tabs: [{ id: 'tab1' }], activeTabId: 'tab1' } }],
    }],
  }))
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))

  const port = 9900 + (Date.now() % 15)
  // NO_COLOR=1 DELIBERADAMENTE: reproduce el caso que rompía el color de Claude Code.
  const app = spawn('D:/Tools/Plano/node_modules/electron/dist/electron.exe',
    ['.', `--remote-debugging-port=${port}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    { env: { ...process.env, NO_COLOR: '1', PLANO_USER_DATA_DIR: UD }, stdio: 'ignore', windowsHide: true, cwd: 'D:/Tools/Plano' })

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
      const t = setTimeout(() => { pend.delete(i); rej(new Error('CDP_TIMEOUT ' + method)) }, 45000)
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
  await sleep(9000) // que el PTY arranque y pinte el prompt

  // El renderer usa WebGL: el texto vive en un canvas, no en el DOM. Así que el comando
  // ESCRIBE A UN ARCHIVO y el resultado se lee desde Node — sin depender del buffer.
  const REPORT = path.join(PRJ, 'env-report.txt').replace(/\\/g, '\\\\')
  const out = await ev(`(async () => {
    const s = ms => new Promise(r => setTimeout(r, ms))
    const screen = document.querySelector('.xterm-screen') || document.querySelector('.xterm')
    if (!screen) return { err: 'no xterm' }
    const r = screen.getBoundingClientRect()
    const click = () => {
      for (const type of ['pointerdown','pointerup','mousedown','mouseup','click']) {
        screen.dispatchEvent(new MouseEvent(type, { clientX: r.left + r.width/2, clientY: r.top + r.height/2, bubbles: true, composed: true, button: 0 }))
      }
    }
    click(); await s(400)   // 1º clic: el FocusShield lo consume (solo enfoca)
    click(); await s(400)   // 2º clic: ya llega a xterm
    const ta = document.querySelector('.xterm-helper-textarea')
    if (ta) ta.focus()
    return { focused: document.activeElement?.className || 'none' }
  })()`)

  const cmd = `echo NOCOLOR=[%NO_COLOR%] COLORTERM=[%COLORTERM%] TERM=[%TERM%] > "${REPORT}"`
  await send('Input.insertText', { text: cmd }).catch(() => {})
  await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', text: '\r' }).catch(() => {})
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter' }).catch(() => {})
  await sleep(3500)

  const reportPath = path.join(PRJ, 'env-report.txt')
  const report = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8').trim() : '(no se escribió el archivo)'
  console.log('PROBE ' + JSON.stringify(out))
  console.log('SHELL ENV >>> ' + report)
  ws.close(); app.kill()
}
main().catch((e) => console.log('FATAL', e.message))
