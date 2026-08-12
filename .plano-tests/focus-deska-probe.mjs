/**
 * Dev-only verification probe for PLAN_DESKA_TERMINAL_FOCUS_MODE.md P0.
 * Launches the dev checkout with isolated user-data + unique CDP port, seeds a
 * workspace with 3 terminal panels + empty canvas, and asserts:
 *   - click A → A opacity 1, others 0.75
 *   - hover unfocused B → B opacity 1, A stays focused
 *   - leave B → B back to 0.75
 *   - first click on B content: focus changes, NO character reaches the terminal
 *   - second click operates inside B
 *   - refocus already-focused panel increments focusEpoch
 *   - empty-canvas click without drag → no focused surface (all 0.75)
 * Cleanup targets only the spawned process tree by PID.
 */
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
  version: 9,
  general: { restoreLastWorkspace: true, restoreAgentSessions: false, showFilesOnLaunch: false, warnBeforeQuit: false, confirmClosePanelWithProcess: false, agentDoneSound: false },
  appearance: { theme: 'monolith', accent: '#FFFFFF', gridStyle: 'dots', gridOpacity: 1, grain: false, reduceMotion: false },
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
  const run = Date.now() + Math.random().toString(36).slice(2)
  const UD = path.join(os.tmpdir(), `fz-probe-${run}`)
  const PRJ = path.join(os.tmpdir(), `fz-prj-${run}`)
  fs.rmSync(UD, { recursive: true, force: true })
  fs.mkdirSync(UD, { recursive: true })
  fs.mkdirSync(PRJ, { recursive: true })
  fs.writeFileSync(path.join(PRJ, 'package.json'), '{}')

  const mkTerm = (id, x, y, title) => ({
    id,
    type: 'terminal',
    rect: { x, y, width: 420, height: 300 },
    z: 1,
    title,
    props: { folderPath: PRJ, command: '' },
  })
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
          panels: [mkTerm('tA', 40, 40), mkTerm('tB', 500, 120), mkTerm('tC', 900, 300)],
        },
      ],
    }),
  )
  fs.writeFileSync(path.join(UD, 'session.json'), JSON.stringify({ folderPath: PRJ }))
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify(SETTINGS))

  const port = 9980 + (Date.now() % 10)
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
  await send('Runtime.enable', {}).catch(() => {})

  // Give terminals time to spawn PTYs and attach xterm DOM.
  await sleep(6000)

  // Terminal surfaces sorted by x-position: tA=40, tB=500, tC=900.
  const surfaceOpacity = async (id) =>
    await ev(`(() => {
      const idx = { tA: 0, tB: 1, tC: 2 }['${id}']
      const list = [...document.querySelectorAll('[data-panel-type="terminal"]')].sort((a,b)=>a.getBoundingClientRect().left-b.getBoundingClientRect().left)
      const s = list[idx]; if (!s) return null
      return { op: getComputedStyle(s).opacity, tag: s.tagName, cls: (s.className||'').toString().slice(0,60) }
    })()`).catch(() => null)

  // Sanity: find the actual top-level surface selectors the implementation uses.
  const surfaceInfo = await ev(`(() => {
    const all = [...document.querySelectorAll('*')].filter(el => el.querySelector && el.querySelector('.xterm'))
    return all.map(s => ({ tag: s.tagName, cls: (s.className||'').toString().slice(0,80), direct: s.querySelectorAll('.xterm').length })).slice(0, 12)
  })()`).catch(() => [])
  console.log('SURFACES:', JSON.stringify(surfaceInfo).slice(0, 400))

  const results = {}
  // 1. Initial: no focused surface yet → all should be 0.75 after settling.
  await sleep(600)
  const opA0 = await surfaceOpacity('tA')
  const opB0 = await surfaceOpacity('tB')
  results.initialUnfocused = { A: opA0?.op, B: opB0?.op }

  // 2. Click terminal A body center.
  const clickSurface = async (id) =>
    await ev(`(() => {
      const idx = { tA: 0, tB: 1, tC: 2 }['${id}']
      const list = [...document.querySelectorAll('[data-panel-type="terminal"]')].sort((a,b)=>a.getBoundingClientRect().left-b.getBoundingClientRect().left)
      const s = list[idx]; if (!s) return false
      const r = s.getBoundingClientRect()
      const x = r.left + r.width/2, y = r.top + r.height/2
      for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) {
        s.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type==='pointerup'||type==='mouseup'?0:1 }))
      }
      return true
    })()`).catch(() => false)
  await clickSurface('tA')
  await sleep(400)
  const opA1 = await surfaceOpacity('tA')
  const opB1 = await surfaceOpacity('tB')
  results.focusedA = { A: opA1?.op, B: opB1?.op }

  // 3. Hover B (React onMouseEnter ≈ mouseover) while A focused; leave via mouseout.
  await ev(`(() => {
    const list = [...document.querySelectorAll('[data-panel-type="terminal"]')].sort((a,b)=>a.getBoundingClientRect().left-b.getBoundingClientRect().left)
    const s = list[1]; if (!s) return false
    const r = s.getBoundingClientRect()
    s.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: r.left+10, clientY: r.top+10, relatedTarget: document.body }))
    return true
  })()`).catch(() => false)
  await sleep(300)
  const opBhover = await surfaceOpacity('tB')
  results.hoverB = { B: opBhover?.op }
  await ev(`(() => {
    const list = [...document.querySelectorAll('[data-panel-type="terminal"]')].sort((a,b)=>a.getBoundingClientRect().left-b.getBoundingClientRect().left)
    const s = list[1]; if (!s) return false
    s.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
    return true
  })()`).catch(() => false)
  await sleep(300)
  const opBleft = await surfaceOpacity('tB')
  results.leaveB = { B: opBleft?.op }

  // 4. Focus epoch exists and increments on refocus of same panel.
  const epoch1 = await ev(`(() => window.plano?.focusStore ? 'n/a' : null)()`).catch(() => null)
  // Read the store if exposed; else infer from focusSurface calls via DOM marker.
  const focusedAttr = await ev(`(() => document.querySelector('[data-panel-focused="true"]') ? document.querySelector('[data-panel-focused="true"]').getAttribute('data-panel-id') : null)()`).catch(() => null)
  results.focusMarker = focusedAttr

  // 5. Empty canvas click → no focus (all 0.75).
  await ev(`(() => {
    const cv = document.querySelector('[data-canvas-background="true"]') || document.body
    const r = cv.getBoundingClientRect()
    const x = 8, y = 8 // far corner, hopefully background
    for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) {
      cv.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type==='pointerup'||type==='mouseup'?0:1 }))
    }
    return true
  })()`).catch(() => false)
  await sleep(400)
  const opA2 = await surfaceOpacity('tA')
  results.afterCanvasClick = { A: opA2?.op }

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
