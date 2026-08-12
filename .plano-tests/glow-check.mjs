// Focused checks: accent swatch count + ambient glow slider wiring.
import { spawn, spawnSync } from 'node:child_process'
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
  appearance: { theme: 'monolith', accent: '#FFFFFF', gridStyle: 'none', gridOpacity: 1, grain: false, reduceMotion: false, density: 'standard', canvasBackground: { kind: 'theme', colors: ['#141414', '#1d1d2b'], angle: 135 }, canvasGlow: 0, gridSize: 'standard' },
  editor: { fontSize: 13, tabSize: 2, wordWrap: true, lineNumbers: true },
  terminal: { shell: 'cmd' },
  canvas: { snapToGrid: true, showMinimap: false, zoomSensitivity: 1, autosave: true },
  browser: {},
  privacy: { telemetry: false, saveTerminalHistory: true },
  advanced: { hardwareAcceleration: true },
  agentMesh: {},
  voice: {},
}
async function main() {
  const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const UD = path.join(os.tmpdir(), `glow-${run}`)
  const PRJ = path.join(os.tmpdir(), `glowp-${run}`)
  fs.mkdirSync(UD, { recursive: true })
  fs.mkdirSync(PRJ, { recursive: true })
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')
  fs.writeFileSync(
    path.join(UD, 'workspaces.json'),
    JSON.stringify({
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      activeId: 's1',
      workspaces: [
        {
          id: 's1',
          name: 'S',
          folderPath: PRJ,
          viewport: { x: 0, y: 0, zoom: 1 },
          regions: [],
          panels: [{ id: 't1', type: 'terminal', rect: { x: 60, y: 60, width: 520, height: 340 }, z: 1, title: 'T', props: { folderPath: PRJ, command: '' } }],
        },
      ],
    }),
  )
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))
  const port = 9870 + (Date.now() % 20)
  const app = spawn('D:/Tools/Plano/node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`], {
    env: { ...process.env, PLANO_USER_DATA_DIR: UD },
    stdio: 'ignore',
    windowsHide: true,
  })
  app.unref()
  let page
  for (let i = 0; i < 100 && !page; i++) {
    try {
      const t = await getJson('/json', port)
      page = t.find((x) => x.type === 'page' && x.url.includes('index.html'))
    } catch {}
    await sleep(500)
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.once('open', res)
    ws.once('error', rej)
  })
  let id = 0
  const pend = new Map()
  ws.on('message', (d) => {
    const m = JSON.parse(d)
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
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value
  await send('Page.bringToFront', {}).catch(() => {})
  await sleep(3000)
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true })); 'ok'`).catch(() => {})
  await sleep(1000)
  await ev(`(() => { const rail=[...document.querySelectorAll('[data-surface-layer="modal"] button')]; const b=rail.find(x=>(x.textContent||'').includes('Appearance')); b?.click(); return !!b })()`).catch(() => {})
  await sleep(500)
  const accents = await ev(`(() => {
    const modal = document.querySelector('[data-surface-layer="modal"]')
    const dots = [...modal.querySelectorAll('button')].filter(b => (b.className||'').toString().includes('w-[30px]'))
    return dots.length
  })()`).catch(() => null)
  const ranges = await ev(`(() => {
    const modal = document.querySelector('[data-surface-layer="modal"]')
    const rs = [...modal.querySelectorAll('input[type="range"]')]
    return rs.map(r => ({ val: r.value, min: r.min, max: r.max }))
  })()`).catch(() => null)
  const glowSet = await ev(`(() => {
    const modal = document.querySelector('[data-surface-layer="modal"]')
    const range = modal.querySelector('input[type="range"]')
    if (!range) return 'no range'
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(range, '18')
    range.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '18' }))
    range.dispatchEvent(new Event('change', { bubbles: true }))
    return { val: range.value }
  })()`).catch(() => null)
  await sleep(600)
  const glowLayer = await ev(`(() => { const el=[...document.querySelectorAll('[data-canvas-background] > div')][0]; return el ? getComputedStyle(el).backgroundImage.slice(0, 110) : 'no-layer' })()`).catch(() => null)
  console.log('RESULT:', JSON.stringify({ accents, ranges, glowSet, glowLayer }))
  await ev('window.plano.window.close()').catch(() => {})
  await sleep(700)
  try {
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}
  process.exit(0)
}
main().catch((e) => {
  console.error('ERR', e)
  process.exit(1)
})
