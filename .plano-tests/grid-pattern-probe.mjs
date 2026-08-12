// Verify the grid dot pattern: ONE uniform layer, grid strength drives opacity,
// zoom keeps grid + spotlight aligned via shared host vars.
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
  appearance: { theme: 'monolith', accent: '#FFFFFF', gridStyle: 'dots', gridOpacity: 0.5, reduceMotion: false, canvasBackground: { kind: 'theme', colors: ['#141414', '#1d1d2b'], angle: 135 }, canvasGlow: 0, gridSize: 'standard' },
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
  const UD = path.join(os.tmpdir(), `grid-${run}`)
  const PRJ = path.join(os.tmpdir(), `gridp-${run}`)
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
  const port = 9800 + (Date.now() % 15)
  const app = spawn('D:/Tools/Plano/node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${port}`, '--force-frame-rate=60'], {
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
  await sleep(3500)

  const results = {}
  // 1. dot pattern: single radial layer, opacity honors strength
  const at1 = await ev(`(() => {
    const grid = [...document.querySelectorAll('[aria-hidden]')].find(d => (d.style.backgroundImage||'').includes('radial-gradient') && (d.style.backgroundSize||'').includes('var(--grid-minor'))
    const host = document.querySelector('[data-canvas-background]')
    const layers = (grid?.style.backgroundImage||'').split('radial-gradient').length - 1
    return {
      layers,
      opacity: grid ? getComputedStyle(grid).opacity : null,
      size: grid ? grid.style.backgroundSize.slice(0, 60) : null,
      hostMinor: host ? host.style.getPropertyValue('--grid-minor') : null,
    }
  })()`).catch(() => null)
  results.atZoom1 = at1

  // 2. zoom in via wheel (ctrl)
  const cr = await ev(`(() => { const r=document.querySelector('[data-canvas-background]').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } })()`)
  for (let i = 0; i < 3; i += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(cr.left + cr.width / 2), y: Math.round(cr.top + cr.height / 2), deltaX: 0, deltaY: -100, modifiers: 1 })
    await sleep(250)
  }
  await sleep(800)
  const at125 = await ev(`(() => {
    const grid = [...document.querySelectorAll('[aria-hidden]')].find(d => (d.style.backgroundImage||'').includes('radial-gradient') && (d.style.backgroundSize||'').includes('var(--grid-minor)'))
    const host = document.querySelector('[data-canvas-background]')
    const zoomText = document.querySelector('[title="Reset zoom"]')?.textContent?.trim()
    return {
      zoomText,
      hostMinor: host ? host.style.getPropertyValue('--grid-minor') : null,
      size: grid ? grid.style.backgroundSize.slice(0, 60) : null,
      computedSize: grid ? getComputedStyle(grid).backgroundSize.slice(0, 60) : null,
      spotSize: (() => { const spot=[...document.querySelectorAll('[aria-hidden]')].find(d=>d.style.maskImage || d.style.WebkitMaskImage); return spot ? getComputedStyle(spot).backgroundSize.slice(0,40) : null })(),
      opacity: grid ? getComputedStyle(grid).opacity : null,
    }
  })()`).catch(() => null)
  results.afterZoom = at125

  // 3. strength up → opacity changes
  await ev(`(() => {
    const modal = document.querySelector('[data-surface-layer="modal"]')
    if (!modal) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))
      return false
    }
    return true
  })()`).catch(() => {})
  await sleep(900)
  await ev(`(() => { const rail=[...document.querySelectorAll('[data-surface-layer="modal"] button')]; const b=rail.find(x=>(x.textContent||'').includes('Appearance')); b?.click(); return !!b })()`).catch(() => {})
  await sleep(400)
  await ev(`(() => {
    const modal = document.querySelector('[data-surface-layer="modal"]')
    const label=[...modal.querySelectorAll('*')].find(el=>(el.textContent||'').trim()==='Grid strength')
    const row = label?.closest('[class*="flex"]') || label?.parentElement
    const range = row?.querySelector('input[type="range"]') || modal.querySelector('input[type="range"]')
    if (range) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(range, '1')
      range.dispatchEvent(new InputEvent('input', { bubbles: true }))
      range.dispatchEvent(new Event('change', { bubbles: true }))
    }
    return !!range
  })()`).catch(() => false)
  await sleep(500)
  const strengthUp = await ev(`(() => {
    const grid = [...document.querySelectorAll('[aria-hidden]')].find(d => (d.style.backgroundImage||'').includes('radial-gradient') && (d.style.backgroundSize||'').includes('var(--grid-minor)'))
    return grid ? getComputedStyle(grid).opacity : null
  })()`).catch(() => null)
  results.strengthUpOpacity = strengthUp

  console.log('RESULT:', JSON.stringify(results))
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
