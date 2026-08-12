// Verify the Appearance UI polish: no Film grain / Interface density rows, 8 themes,
// 13 accents, background previews derived from the ACTIVE theme (not blue on Monolith),
// background kind switch still live-updates the canvas.
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
  appearance: { theme: 'monolith', accent: '#FFFFFF', gridStyle: 'none', gridOpacity: 1, reduceMotion: false, canvasBackground: { kind: 'theme', colors: ['#141414', '#1d1d2b'], angle: 135 }, canvasGlow: 0, gridSize: 'standard' },
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
  const UD = path.join(os.tmpdir(), `pol-${run}`)
  const PRJ = path.join(os.tmpdir(), `polp-${run}`)
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
  const port = 9840 + (Date.now() % 30)
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

  const results = {}
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true })); 'ok'`).catch(() => {})
  await sleep(1000)
  await ev(`(() => { const rail=[...document.querySelectorAll('[data-surface-layer="modal"] button')]; const b=rail.find(x=>(x.textContent||'').includes('Appearance')); b?.click(); return !!b })()`).catch(() => {})
  await sleep(500)

  const state = await ev(`(() => {
    const modal = document.querySelector('[data-surface-layer="modal"]')
    const text = modal ? modal.textContent : ''
    const labels = [...modal.querySelectorAll('button span')].map(s=>(s.textContent||'').trim()).filter(t=>['Monolith','Indigo','Orange','Tokyo','Sakura','Pearl','Mist','Paper'].includes(t))
    return {
      rows: {
        filmGrain: /Film grain/i.test(text),
        interfaceDensity: /Interface density/i.test(text),
        reduceMotion: /Reduce motion/i.test(text),
        ambientGlow: /Ambient glow/i.test(text),
        gridSize: /Grid size/i.test(text),
        gridStrength: /Grid strength/i.test(text),
        showMinimap: /Show minimap/i.test(text),
      },
      themes: [...new Set(labels)],
      accentDots: [...modal.querySelectorAll('button')].filter(b => (b.className||'').toString().includes('w-[34px]') || (b.className||'').toString().includes('w-[30px]')).length,
      sectionOrder: [...modal.querySelectorAll('.label-caps')].map(e => (e.textContent||'').trim()),
    }
  })()`).catch(() => null)
  results.state = state

  // Background preview derivation on Monolith: tiles must NOT be blue-ish.
  const previews = await ev(`(() => {
    const modal = document.querySelector('[data-surface-layer="modal"]')
    const tiles = [...modal.querySelectorAll('button')].filter(b => {
      const s = b.querySelector('span[style*="gradient"], span[style*="rgb"], span[style*="#"]')
      return s && /Theme|Solid|Linear|Radial/.test((b.textContent||'').trim())
    })
    return tiles.slice(0, 4).map(b => {
      const s = b.querySelector('span')
      return { label: (b.textContent||'').trim(), bg: s ? s.style.background.slice(0, 90) : null }
    })
  })()`).catch(() => null)
  results.previews = previews

  // Live switch still works: click Linear → canvas gradient updates.
  await ev(`(() => {
    const modal = document.querySelector('[data-surface-layer="modal"]')
    const b=[...modal.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='Linear')
    b?.click(); return !!b
  })()`).catch(() => {})
  await sleep(400)
  const bgAfter = await ev(`(() => { const el=document.querySelector('[data-canvas-background]'); return el.style.background.slice(0, 90) })()`).catch(() => null)
  results.bgAfterLinear = bgAfter

  // Search: 'grain' must find nothing, 'background' must find the entry.
  await ev(`(() => { const i=document.querySelector('[data-surface-layer="modal"] input'); if (i) { const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(i,'grain'); i.dispatchEvent(new Event('input',{bubbles:true})) } return !!i })()`).catch(() => {})
  await sleep(400)
  const grainSearch = await ev(`(() => { const modal=document.querySelector('[data-surface-layer="modal"]'); return modal.textContent.includes('Film grain') })()`).catch(() => null)

  console.log('RESULT:', JSON.stringify({ ...results, grainSearch }))
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
