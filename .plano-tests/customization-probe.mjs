// Dev verification for the Appearance customization work:
//   - 8 themes (Paper present), 13 accent swatches
//   - Canvas surface block: BackgroundPicker (Theme/Solid/Linear/Radial), Ambient glow, Grid size
//   - changing background updates the canvas substrate live
//   - theme switch applies data-theme
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
  terminal: { shell: 'cmd', shellPath: '', fontFamily: '', fontSize: 0, lineHeight: 1.4, cursorStyle: 'bar', cursorBlink: false, scrollback: 5000, theme: 'campbell', copyOnSelect: false, predictiveHistory: false, smartActions: false, autoSuspendIdle: true, keepAgentsOnQuit: true },
  canvas: { snapToGrid: true, showMinimap: false, zoomSensitivity: 1, autosave: true },
  browser: {},
  privacy: { telemetry: false, saveTerminalHistory: true },
  advanced: { hardwareAcceleration: true },
  agentMesh: {},
  voice: {},
}

async function main() {
  const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const UD = path.join(os.tmpdir(), `cust-${run}`)
  const PRJ = path.join(os.tmpdir(), `cust-prj-${run}`)
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
          panels: [{ id: 'e1', type: 'terminal', rect: { x: 60, y: 60, width: 520, height: 340 }, z: 1, title: 'T', props: { folderPath: PRJ, command: '' } }],
        },
      ],
    }),
  )
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))

  const port = 9850 + (Date.now() % 30)
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
  if (!page) throw new Error('no page')

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

  // 1. Open Settings → Appearance.
  await ev(`window.__openSettings?.('appearance') ?? (() => { const b=[...document.querySelectorAll('button')].find(b=>/settings|palette/i.test((b.title||'')+(b.getAttribute('aria-label')||''))); b?.click(); return 'clicked:'+(!!b) })()`).catch(() => {})
  await sleep(1200)
  // Fallback: keyboard shortcut if settings didn't open.
  const opened = await ev(`!!document.querySelector('[data-surface-layer="modal"]')`)
  if (!opened) {
    await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true })); 'ok'`).catch(() => {})
    await sleep(1200)
  }
  results.settingsOpen = await ev(`!!document.querySelector('[data-surface-layer="modal"]')`)

  // Navigate to Appearance via the rail.
  await ev(`(() => { const rail=[...document.querySelectorAll('[data-surface-layer="modal"] button')]; const b=rail.find(x=>(x.textContent||'').includes('Appearance')); b?.click(); return !!b })()`).catch(() => {})
  await sleep(600)

  // 2. Theme gallery: count theme cards + labels (Paper must exist).
  const themes = await ev(`(() => {
    const modal = document.querySelector('[data-surface-layer="modal"]')
    if (!modal) return null
    const labels = [...modal.querySelectorAll('button span')].map(s=>(s.textContent||'').trim()).filter(t=>['Monolith','Indigo','Orange','Tokyo','Sakura','Pearl','Mist','Paper'].includes(t))
    return [...new Set(labels)]
  })()`).catch(() => null)
  results.themes = themes

  // 3. Accent swatches: count the dots in the Accent row.
  const accentCount = await ev(`(() => {
    const modal = document.querySelector('[data-surface-layer="modal"]')
    if (!modal) return null
    const txt = [...modal.querySelectorAll('*')].find(el=>(el.textContent||'').trim()==='Accent')
    const row = txt?.closest('[class*="flex"]')
    const dots = row ? row.querySelectorAll('button') : []
    return dots.length
  })()`).catch(() => null)
  results.accentSwatches = accentCount

  // 4. Canvas surface block: Background tiles + glow slider + grid size.
  const surface = await ev(`(() => {
    const modal = document.querySelector('[data-surface-layer="modal"]')
    if (!modal) return null
    const text = modal.textContent || ''
    return {
      backgroundPicker: ['Theme','Solid','Linear','Radial'].filter(t => text.includes(t)),
      glow: text.includes('Ambient glow'),
      gridSize: text.includes('Grid size'),
      colorInputs: modal.querySelectorAll('input[type="color"]').length,
    }
  })()`).catch(() => null)
  results.surface = surface

  // 5. Live background change: click Linear tile → canvas substrate must change.
  const bgBefore = await ev(`getComputedStyle(document.querySelector('[data-canvas-background]')).backgroundImage`)
  await ev(`(() => {
    const modal = document.querySelector('[data-surface-layer="modal"]')
    const b=[...modal.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='Linear')
    b?.click()
    return !!b
  })()`).catch(() => {})
  await sleep(500)
  const bgAfterLinear = await ev(`(() => { const el=document.querySelector('[data-canvas-background]'); const s=getComputedStyle(el); return { image: s.backgroundImage.slice(0,90), style: el.style.background.slice(0,110) } })()`).catch(() => null)
  results.bgLinear = bgAfterLinear

  // 6. Ambient glow: set to 18 → a glow layer appears.
  const glowBefore = await ev(`(() => { const el=[...document.querySelectorAll('[data-canvas-background] > div')][0]; return el ? getComputedStyle(el).backgroundImage.slice(0,60) : 'no-layer' })()`).catch(() => null)
  // click the glow slider (input[type=range] near "Ambient glow")
  await ev(`(() => {
    const modal = document.querySelector('[data-surface-layer="modal"]')
    const label=[...modal.querySelectorAll('*')].find(el=>(el.textContent||'').trim()==='Ambient glow')
    const row = label?.closest('[class*="flex"]') || label?.parentElement?.parentElement
    const range = row?.querySelector('input[type="range"]') || modal.querySelector('input[type="range"]')
    if (range) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(range, '18')
      range.dispatchEvent(new Event('input', { bubbles: true }))
      range.dispatchEvent(new Event('change', { bubbles: true }))
    }
    return !!range
  })()`).catch(() => false)
  await sleep(500)
  const glowAfter = await ev(`(() => { const el=[...document.querySelectorAll('[data-canvas-background] > div')][0]; return el ? getComputedStyle(el).backgroundImage.slice(0,90) : 'no-layer' })()`).catch(() => null)
  results.glow = { before: glowBefore, after: glowAfter }

  // 7. Theme switch: click the Paper card → data-theme becomes paper.
  await ev(`(() => {
    const modal = document.querySelector('[data-surface-layer="modal"]')
    const b=[...modal.querySelectorAll('button')].find(x=>(x.textContent||'').includes('Paper'))
    b?.click()
    return !!b
  })()`).catch(() => {})
  await sleep(600)
  results.themeApplied = await ev(`document.documentElement.dataset.theme`)

  // 8. Solid color: click Solid + pick a color via the color input.
  await ev(`(() => {
    const modal = document.querySelector('[data-surface-layer="modal"]')
    const b=[...modal.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='Solid')
    b?.click()
    return !!b
  })()`).catch(() => {})
  await sleep(300)
  const solidInputs = await ev(`(() => { const modal = document.querySelector('[data-surface-layer="modal"]'); return modal.querySelectorAll('input[type="color"]').length })()`).catch(() => null)
  await ev(`(() => {
    const modal = document.querySelector('[data-surface-layer="modal"]')
    const input = modal.querySelector('input[type="color"]')
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, '#332244')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }
    return !!input
  })()`).catch(() => false)
  await sleep(500)
  const bgSolid = await ev(`(() => { const el=document.querySelector('[data-canvas-background]'); return { style: el.style.background.slice(0,60), computed: getComputedStyle(el).backgroundColor.slice(0,40) } })()`).catch(() => null)
  results.solid = { inputs: solidInputs, bg: bgSolid }

  console.log('RESULT:', JSON.stringify(results))
  await ev('window.plano.window.close()').catch(() => {})
  await sleep(800)
  try {
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
  } catch {}
  process.exit(0)
}

main().catch((e) => {
  console.error('ERR', e)
  process.exit(1)
})
